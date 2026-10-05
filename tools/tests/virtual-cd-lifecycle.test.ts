import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VirtualCdAudio, type CdTrack } from "../../src/worker/core/audio/virtual-cd";

const TRACK: CdTrack = {
    number: 1,
    isAudio: true,
    file: "C:\\music\\Track01.ogg",
    mimeType: "audio/ogg",
    startMs: 0,
    lengthMs: 60_000,
    lengthKnown: true,
};

let originalSelf: unknown;
let posted: any[];
let live: VirtualCdAudio[];

function makeCd(read: () => Promise<Uint8Array | null>, tracks: CdTrack[] = [{ ...TRACK }]): VirtualCdAudio {
    const cd = new VirtualCdAudio();
    const state = cd as any;
    state.scanned = true;
    state.trackTable = tracks;
    state.readTrackBytes = read;
    live.push(cd);
    return cd;
}

async function drainPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    originalSelf = (globalThis as any).self;
    posted = [];
    live = [];
    (globalThis as any).self = {
        postMessage(message: any) {
            posted.push(message);
        },
    };
});

afterEach(() => {
    // reset() -> finishActive() disarms the completion backstop; a leaked timer would
    // otherwise outlive the test that armed it.
    for (const cd of live) cd.reset();
    (globalThis as any).self = originalSelf;
});

describe("VirtualCdAudio host lifecycle", () => {
    test("pause during a cold read defers host playback until resume", async () => {
        let finishRead!: (data: Uint8Array) => void;
        const cd = makeCd(() => new Promise((resolve) => {
            finishRead = (data) => resolve(data);
        }));

        expect(cd.play(0, 10_000)).toBeGreaterThan(0);
        cd.pause();
        expect(cd.getMode()).toBe("paused");
        expect(posted.some((m) => m.type === "audio_play_encoded")).toBe(false);

        finishRead(new Uint8Array([1, 2, 3, 4]));
        await drainPromises();
        expect(posted.some((m) => m.type === "audio_play_encoded")).toBe(false);

        cd.resume();
        expect(cd.getMode()).toBe("playing");
        expect(posted.filter((m) => m.type === "audio_play_encoded")).toHaveLength(1);
        expect(posted.some((m) => m.type === "audio_resume")).toBe(false);
    });

    test("pause during async host setup is applied after audio_started", async () => {
        const cd = makeCd(async () => new Uint8Array([1, 2, 3, 4]));

        expect(cd.play(0, 10_000)).toBeGreaterThan(0);
        await drainPromises();
        const play = posted.find((m) => m.type === "audio_play_encoded");
        expect(play).toBeDefined();

        cd.pause();
        expect(posted.some((m) => m.type === "audio_pause")).toBe(false);

        expect(cd.handleAudioStarted(play.payload.id)).toBe(true);
        expect(posted.filter((m) => m.type === "audio_pause")).toEqual([
            { type: "audio_pause", payload: { id: play.payload.id } },
        ]);
        expect(cd.handleAudioStarted(play.payload.id + 1)).toBe(false);
    });

    test("a host playback error aborts the owned request and notifies listeners", async () => {
        const cd = makeCd(async () => new Uint8Array([1, 2, 3, 4]));
        const completions: Array<{ token: number; reason: string }> = [];
        cd.addCompletionListener((token, reason) => completions.push({ token, reason }));

        const token = cd.play(0, 10_000);
        await drainPromises();
        const play = posted.find((m) => m.type === "audio_play_encoded");
        expect(play).toBeDefined();

        expect(cd.handleAudioError(play.payload.id, "decode failed")).toBe(true);
        expect(cd.getMode()).toBe("stopped");
        expect(completions).toEqual([{ token, reason: "aborted" }]);
        expect(posted.some((m) => m.type === "audio_stop" && m.payload.id === play.payload.id)).toBe(true);
        expect(cd.handleAudioError(play.payload.id + 1, "foreign")).toBe(false);
    });

    // finishActive("finished") is otherwise reachable only from a host audio_ended, so a
    // container the browser accepts into a Blob but cannot decode leaves getMode() at
    // MCI_MODE_PLAY forever and MCI_NOTIFY never fires.
    test("a segment the host never ends completes on the transport clock", async () => {
        const cd = makeCd(async () => new Uint8Array([1, 2, 3, 4]), [{ ...TRACK, lengthMs: 40 }]);
        const completions: Array<{ token: number; reason: string }> = [];
        cd.addCompletionListener((token, reason) => completions.push({ token, reason }));

        const token = cd.play(0, 40);
        await drainPromises();
        expect(posted.some((m) => m.type === "audio_play_encoded")).toBe(true);

        // Still inside the segment: the backstop re-arms rather than cutting it short.
        (cd as any).runCompletionBackstop();
        expect(cd.getMode()).toBe("playing");
        expect(completions).toEqual([]);

        await new Promise((r) => setTimeout(r, 60));
        (cd as any).runCompletionBackstop();
        expect(cd.getMode()).toBe("stopped");
        expect(completions).toEqual([{ token, reason: "finished" }]);
    });

    // The mid-track start offset is best-effort on the host (the seek may land before a
    // seekable range exists). Without the report back, positionMs() claims the requested
    // offset while the audio plays from the top.
    test("a host position report retimes the transport onto the achieved offset", async () => {
        const cd = makeCd(async () => new Uint8Array([1, 2, 3, 4]));

        expect(cd.play(30_000, 40_000)).toBeGreaterThan(0);
        await drainPromises();
        const play = posted.find((m) => m.type === "audio_play_encoded");
        expect(play.payload.startOffsetMs).toBe(30_000);
        // Positions come back in ms, not sample frames — the drive never learns the
        // host's decoded sample rate.
        expect(play.payload.positionRateHz).toBe(1000);
        expect(cd.positionMs()).toBeGreaterThanOrEqual(30_000);

        expect(cd.handleAudioPosition(play.payload.id, 0)).toBe(true);
        expect(cd.positionMs()).toBeLessThan(1_000);
        expect(cd.currentTrackNumber()).toBe(1);
        expect(cd.handleAudioPosition(play.payload.id + 1, 0)).toBe(false);
    });
});

describe("VirtualCdAudio disc timeline", () => {
    const twoTracks = (): CdTrack[] => [
        { ...TRACK, number: 1, lengthMs: 300_000, lengthKnown: false },
        {
            ...TRACK, number: 2, file: "C:\\music\\Track02.ogg",
            startMs: 300_000, lengthMs: 200_000, lengthKnown: true,
        },
    ];

    // A refined length that does not move the start times leaves the ranges overlapping:
    // trackAt(track(N).startMs) then resolves to N-1 and every MCI/Miles position is
    // wrong for the rest of the session.
    test("a refined length recomputes starts and retimes the running segment", async () => {
        const tracks = twoTracks();
        const cd = makeCd(async () => new Uint8Array([1, 2, 3, 4]), tracks);
        (cd as any).refinePasses = 99; // no live VFS behind these tracks

        const token = cd.play(0, 500_000);
        expect(token).toBeGreaterThan(0);
        await drainPromises();

        // What the refine pass discovers: track 1 is really 400 s, not the 300 s fallback.
        tracks[0].lengthMs = 400_000;
        tracks[0].lengthKnown = true;
        (cd as any).recomputeStarts();
        (cd as any).retimeActiveSegment(tracks[0], 0, 300_000, 500_000);

        expect(cd.track(2)!.startMs).toBe(400_000);
        expect(cd.trackAt(400_000)!.number).toBe(2);
        expect(cd.trackAt(399_999)!.number).toBe(1);
        expect(cd.discLengthMs()).toBe(600_000);
        // The segment ran to the track's end, so it still does — at the NEW end.
        expect((cd as any).segEndDiscMs).toBe(400_000);
    });

    // The scan's sync probes are budgeted, so the refine pass is what turns fallback
    // lengths into real ones — it has to be reachable more than once, and has to stop.
    test("ensureDisc retries the refine pass while a length is unknown, then gives up", () => {
        const cd = makeCd(async () => null, [{ ...TRACK, lengthKnown: false }]);
        let calls = 0;
        (cd as any).refineDurations = async () => {
            calls++;
            (cd as any).refinePasses++;
        };
        for (let i = 0; i < 8; i++) cd.getMode();
        expect(calls).toBe(3);
    });

    test("a disc whose lengths are all known never re-probes", () => {
        const cd = makeCd(async () => null, [{ ...TRACK }]);
        let calls = 0;
        (cd as any).refineDurations = async () => { calls++; };
        for (let i = 0; i < 4; i++) cd.getMode();
        expect(calls).toBe(0);
    });
});
