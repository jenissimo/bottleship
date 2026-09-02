/**
 * The two pieces of Bink state that decide what the player sees and how fast.
 *
 * `stepUploadLatch` suppresses our video overlay once the app is believed to publish the
 * movie's pixels itself. Its input (the D3D9 texture-upload counter) is PROCESS-WIDE, so
 * without a causal link to THIS session's copy any unrelated upload latches it — and a
 * latch with no way down turns one transient coincidence into a permanent decision.
 *
 * `rebaseBinkPacing` moves BinkWait's anchors when the timeline moves (a loop wrap or a
 * BinkGoto). Left stale, the target sits in the past and BinkWait answers "ready" for
 * every frame after the wrap.
 */
import { describe, expect, test } from "bun:test";
import {
    stepUploadLatch,
    rebaseBinkPacing,
    binkWaitTargetMs,
    type UploadLatchState,
    type BinkPacingState,
} from "../../src/worker/modules/binkw32";

const FRESH: UploadLatchState = { latched: false, inStep: 0, framesWithoutMatch: 0, lastUploadSeq: -1 };

/** Drive `frames` steps, each observing one upload with the given causal link. */
function run(from: UploadLatchState, frames: number, obs: { hasLockTarget: boolean; msSinceCopy: number; uploads?: boolean }) {
    let state = from;
    let seq = from.lastUploadSeq === -1 ? 0 : from.lastUploadSeq;
    for (let i = 0; i < frames; i++) {
        if (obs.uploads !== false) seq++;
        state = stepUploadLatch(state, { uploadSeq: seq, hasLockTarget: obs.hasLockTarget, msSinceCopy: obs.msSinceCopy });
    }
    return state;
}

describe("app-uploads-its-own-frames latch", () => {
    test("the first observation is only a baseline", () => {
        const after = stepUploadLatch(FRESH, { uploadSeq: 900, hasLockTarget: true, msSinceCopy: 0 });
        expect(after).toEqual({ latched: false, inStep: 0, framesWithoutMatch: 1, lastUploadSeq: 900 });
    });

    test("uploads with no lock target never latch, however long they keep coming", () => {
        const after = run(FRESH, 50, { hasLockTarget: false, msSinceCopy: 0 });
        expect(after.latched).toBe(false);
        expect(after.inStep).toBe(0);
    });

    test("a same-frame upload into this session's lock target latches after the cadence", () => {
        const two = run(FRESH, 3, { hasLockTarget: true, msSinceCopy: 4 });  // 1 baseline + 2 matches
        expect(two.latched).toBe(false);
        const three = run(two, 1, { hasLockTarget: true, msSinceCopy: 4 });
        expect(three.latched).toBe(true);
    });

    test("an upload a frame late is not evidence", () => {
        expect(run(FRESH, 20, { hasLockTarget: true, msSinceCopy: 200 }).latched).toBe(false);
    });

    test("the latch decays once the matching uploads stop", () => {
        const latched = run(FRESH, 8, { hasLockTarget: true, msSinceCopy: 4 });
        expect(latched.latched).toBe(true);
        // 29 quiet frames keep it; the 30th expires it.
        const nearly = run(latched, 29, { hasLockTarget: false, msSinceCopy: 4 });
        expect(nearly.latched).toBe(true);
        expect(run(nearly, 1, { hasLockTarget: false, msSinceCopy: 4 }).latched).toBe(false);
    });

    test("a frame with no upload at all breaks the cadence", () => {
        const two = run(FRESH, 3, { hasLockTarget: true, msSinceCopy: 4 });
        const idle = run(two, 1, { hasLockTarget: true, msSinceCopy: 4, uploads: false });
        expect(idle.inStep).toBe(0);
        expect(run(idle, 1, { hasLockTarget: true, msSinceCopy: 4 }).latched).toBe(false);
    });
});

describe("BinkWait pacing rebase", () => {
    const stale = (): BinkPacingState => ({
        audioBaselineMs: 120,
        frameDecodeCount: 900,
        lastPlayCursor: 65536,
        audioWrapCount: 7,
        lastFrameMs: 1234,
    });

    test("a wrap or seek puts every anchor back to its clip-start value", () => {
        const s = stale();
        rebaseBinkPacing(s);
        expect(s).toEqual({
            audioBaselineMs: -1,
            frameDecodeCount: 0,
            lastPlayCursor: 0,
            audioWrapCount: 0,
            lastFrameMs: 0,
        });
    });

    test("the stale anchors put BinkWait's target 30s into the pass it just left", () => {
        const s = stale();
        const msPerFrame = 1000 / 30;
        expect(binkWaitTargetMs(s, msPerFrame)).toBeCloseTo(120 + 30_000, 3);

        // After the rebase the next decode re-samples the baseline from the live clock;
        // frame 0 of the new pass is then paced against that, not against the old one.
        rebaseBinkPacing(s);
        s.audioBaselineMs = 31_500;  // what _decodeFrame samples on the first frame after
        expect(binkWaitTargetMs(s, msPerFrame)).toBe(31_500);
        s.frameDecodeCount = 1;
        expect(binkWaitTargetMs(s, msPerFrame)).toBeCloseTo(31_500 + msPerFrame, 6);
    });
});
