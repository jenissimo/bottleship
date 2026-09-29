/**
 * DirectSound play-cursor step cap — a bound on spikes, never on the rate.
 *
 * `capCursorStep` holds back how far the reported play cursor moves between two queries,
 * so a host pause (GC, GPU stall) cannot carry a chunked pump's cursor over a whole block.
 * Once the app's Lock size is known the bound is that size. A pump that sizes each Lock
 * from the cursor delta then feeds the bound its own output: a capped step makes the next
 * Lock smaller, which lowers the cap again, until the stream settles at a fraction of real
 * time and the output starves (NFSU2: 448-byte Locks per 10 ms at 44.1 kHz stereo — a
 * quarter rate, heard as crackle). Both pump shapes are simulated here against the real
 * method, exercised through the prototype with only the fields it reads.
 */

import { describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";

const BLOCK_ALIGN = 4;
const RATE_HZ = 44100;
const BYTES_PER_MS = (RATE_HZ * BLOCK_ALIGN) / 1000; // 176.4
const BUFFER_BYTES = 88192;
const LOCK_WINDOW = 8;

type StepBuffer = {
    bytes: number;
    format: { blockAlign: number; sampleRate: number };
    stepLastQueryAt?: number;
    stepLastCursor?: number;
    stepGaps?: Float64Array;
    stepGapCount?: number;
    stepTypicalGapMs?: number;
    stepLockSizes?: Float64Array;
    stepLockCount?: number;
    smoothFromCursor?: number;
    smoothRawAtMs?: number;
};

const self = {
    stepGapScratch: new Float64Array(16),
    ringSize: (b: StepBuffer) => b.bytes,
};

const cap = (buffer: StepBuffer, cursor: number, now: number): number =>
    (DSound.prototype as unknown as {
        capCursorStep(b: StepBuffer, cursor: number, now: number, nominalBytesPerMs: number): number;
    }).capCursorStep.call(self, buffer, cursor, now, BYTES_PER_MS);

function newBuffer(): StepBuffer {
    return { bytes: BUFFER_BYTES, format: { blockAlign: BLOCK_ALIGN, sampleRate: RATE_HZ } };
}

function recordLock(buffer: StepBuffer, bytes: number): void {
    const ring = buffer.stepLockSizes ?? (buffer.stepLockSizes = new Float64Array(LOCK_WINDOW));
    const count = buffer.stepLockCount ?? 0;
    ring[count % LOCK_WINDOW] = bytes;
    buffer.stepLockCount = count + 1;
}

/** The true (worklet) position after `ms` of real-time playback. */
const truePos = (ms: number) => Math.floor(ms * BYTES_PER_MS) - (Math.floor(ms * BYTES_PER_MS) % BLOCK_ALIGN);

describe("dsound capCursorStep", () => {
    test("a delta-sized pump streams at real time instead of ratcheting down", () => {
        const buffer = newBuffer();
        // Start from the degraded state the ratchet settles in: small Locks already recorded.
        for (let i = 0; i < LOCK_WINDOW; i++) recordLock(buffer, 448);
        let lastReported = cap(buffer, 0, 0);
        let reportedTotal = 0;
        const periodMs = 10;
        const queries = 400;
        for (let q = 1; q <= queries; q++) {
            const now = q * periodMs;
            const reported = cap(buffer, truePos(now) % BUFFER_BYTES, now);
            const delta = (reported - lastReported + BUFFER_BYTES) % BUFFER_BYTES;
            lastReported = reported;
            reportedTotal += delta;
            // The pump writes what the cursor advanced, rounded up to its 64-byte granule.
            if (delta > 0) recordLock(buffer, Math.ceil(delta / 64) * 64);
        }
        const realTotal = truePos(queries * periodMs);
        // Real time within one query's worth, not a quarter of it.
        expect(reportedTotal).toBeGreaterThan(realTotal - 2 * periodMs * BYTES_PER_MS);
        const lastLocks = Array.from(buffer.stepLockSizes!);
        for (const l of lastLocks) expect(l).toBeGreaterThanOrEqual(periodMs * BYTES_PER_MS);
    });

    test("a fixed-chunk pump polling faster than its chunk still never crosses two chunks in one step", () => {
        const buffer = newBuffer();
        const chunk = 882; // 5 ms at 44.1 kHz stereo 16-bit
        for (let i = 0; i < LOCK_WINDOW; i++) recordLock(buffer, chunk);
        let now = 0;
        let last = cap(buffer, 0, now);
        // Poll every 1 ms for a while to establish the cadence.
        for (let q = 1; q <= 40; q++) {
            now = q;
            last = cap(buffer, truePos(now) % BUFFER_BYTES, now);
        }
        // A 50 ms host pause: the true cursor leaps ~10 chunks.
        now += 50;
        const after = cap(buffer, truePos(now) % BUFFER_BYTES, now);
        const step = (after - last + BUFFER_BYTES) % BUFFER_BYTES;
        expect(step).toBeLessThan(chunk);
    });
});
