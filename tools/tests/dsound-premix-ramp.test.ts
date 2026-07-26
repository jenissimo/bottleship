/**
 * DirectSound premix ramp — the write-cursor lead over play.
 *
 * On a LOCSOFTWARE buffer GetCurrentPosition derives the secondary's write cursor from
 * the distance between the primary's write cursor and the mixer's next-mix position, so
 * the reported lead IS the premixed region (nt5 dsound `CGrace::GetBytePosition`: "the
 * region from the write cursor to the mix cursor is the premixed region"). The mixer
 * thread ramps that region on a timer — `MIXER_MINPREMIX` (45 ms) after a remix, then
 * `premix += step; step += 2` per refresh up to `MIXER_MAXPREMIX` (200 ms), sleeping
 * min(premixed/2, nextNotify) clamped to [MIN/2, MAX/2] in between (nt5 dsound
 * `CNaGrace::MixThread`).
 *
 * These bounds are load-bearing and silent when wrong: a music pump slower than the
 * ceiling writes into already-consumed data and crackles, with nothing returning an
 * error. So the curve is pinned here against those two source constants.
 *
 * `advancePremix` reads and writes only the buffer's own premix fields, so it is
 * exercised through the prototype — no Process, no SAB, no v86.
 */

import { describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";

const PREMIX_MIN_MS = 45;
const PREMIX_MAX_MS = 200;

type PremixFields = {
    premixMs?: number;
    premixStepMs?: number;
    premixAdvancedAtMs?: number;
};

const advance = (buffer: PremixFields, now: number): number =>
    (DSound.prototype as unknown as {
        advancePremix(b: PremixFields, now: number): number;
    }).advancePremix.call({}, buffer, now);

/** Depth after `steps` refreshes: 45, 47, 51, 57, 65, 75, 87, 101, ... capped at 200. */
function expectedCurve(steps: number): number {
    let premix = PREMIX_MIN_MS;
    let step = 2;
    for (let i = 0; i < steps && premix < PREMIX_MAX_MS; i++) {
        premix = Math.min(PREMIX_MAX_MS, premix + step);
        step += 2;
    }
    return premix;
}

/** Run the ramp forward by feeding it its own refresh interval, one refresh at a time. */
function rampToCeiling(buffer: PremixFields, startAt = 0):
    { depths: number[]; refreshes: number; elapsedMs: number } {
    let now = startAt;
    advance(buffer, now); // seeds the clock without advancing
    const depths: number[] = [];
    for (let i = 0; i < 200; i++) {
        const interval = Math.min(PREMIX_MAX_MS / 2, Math.max(PREMIX_MIN_MS / 2, (buffer.premixMs ?? 0) / 2));
        now += interval;
        const depth = advance(buffer, now);
        depths.push(depth);
        if (depth >= PREMIX_MAX_MS) return { depths, refreshes: i + 1, elapsedMs: now - startAt };
    }
    throw new Error("ramp never reached the ceiling");
}

describe("dsound premix ramp", () => {
    test("a fresh buffer starts at MIXER_MINPREMIX and does not jump on first read", () => {
        const buffer: PremixFields = {};
        expect(advance(buffer, 1000)).toBe(PREMIX_MIN_MS);
        // Seeding must not consume elapsed time: a buffer first queried an hour into the
        // session would otherwise arrive at the ceiling before playing a single block.
        expect(advance(buffer, 1000)).toBe(PREMIX_MIN_MS);
    });

    test("depth follows the quadratic curve and stops at MIXER_MAXPREMIX", () => {
        const buffer: PremixFields = {};
        const { depths } = rampToCeiling(buffer);
        expect(depths.slice(0, 7)).toEqual([47, 51, 57, 65, 75, 87, 101]);
        for (let i = 0; i < depths.length; i++) {
            expect(depths[i]).toBe(expectedCurve(i + 1));
        }
        expect(depths[depths.length - 1]).toBe(PREMIX_MAX_MS);
    });

    test("the ceiling is reached in ~12 refreshes, well under a second of playback", () => {
        const buffer: PremixFields = {};
        const { refreshes, elapsedMs } = rampToCeiling(buffer);
        expect(refreshes).toBe(12);
        // A pump must not have to crackle for long before the lead is deep enough for it.
        expect(elapsedMs).toBeLessThan(700);
    });

    test("depth never exceeds the ceiling no matter how much time passes at once", () => {
        const buffer: PremixFields = {};
        advance(buffer, 0);
        expect(advance(buffer, 60_000)).toBe(PREMIX_MAX_MS);
        expect(advance(buffer, 3_600_000)).toBe(PREMIX_MAX_MS);
    });

    test("a partial interval does not advance the ramp", () => {
        const buffer: PremixFields = {};
        advance(buffer, 0);
        // Below MIN/2 = 22.5 ms nothing is due yet.
        expect(advance(buffer, 20)).toBe(PREMIX_MIN_MS);
        expect(advance(buffer, 22.5)).toBe(47);
    });

    test("signalRemix drops the depth back to MIXER_MINPREMIX and re-ramps", () => {
        const buffer: PremixFields & { isPlaying: boolean } = { isPlaying: true };
        rampToCeiling(buffer);
        expect(buffer.premixMs).toBe(PREMIX_MAX_MS);

        (DSound.prototype as unknown as {
            signalRemix(b: unknown): void;
        }).signalRemix.call({}, buffer);
        expect(buffer.premixMs).toBe(PREMIX_MIN_MS);
        expect(buffer.premixStepMs).toBe(2);
        // The anchor is cleared, not stamped: a remix must not pin the ramp to a clock
        // reading of its own, or the next advance measures against the wrong base.
        expect(buffer.premixAdvancedAtMs).toBeUndefined();

        // ...and the ramp climbs the same curve again from there, on whatever clock the
        // next advance happens to use.
        const { depths } = rampToCeiling(buffer, 5_000);
        expect(depths.slice(0, 3)).toEqual([47, 51, 57]);
    });

    test("signalRemix leaves a stopped buffer alone", () => {
        const buffer: PremixFields & { isPlaying: boolean } = { isPlaying: false };
        rampToCeiling(buffer);
        (DSound.prototype as unknown as {
            signalRemix(b: unknown): void;
        }).signalRemix.call({}, buffer);
        expect(buffer.premixMs).toBe(PREMIX_MAX_MS);
    });
});
