/**
 * The play-cursor step bound (capCursorStep) against the three pump shapes it must serve.
 *
 * - A chunked pump (SDL2's DirectSound backend: The Dark Eye - Chains of Satinav) Locks one
 *   fixed chunk each time the cursor enters a new one. A step of two chunks between two of
 *   its queries leaves a chunk unwritten for that lap: a click. It polls about once a
 *   millisecond while it waits, but after a host pause it is behind and queries back to
 *   back at its write cadence, which stretches the typical query gap the bound is floored
 *   at. The bound must stay at its chunk there.
 * - A delta pump (UE1 Galaxy: Harry Potter 1) Locks what the cursor advanced, from a
 *   jittered ~20 ms timer, and writes a fixed lead past it. The bound must leave the cursor
 *   room to win back a late tick, or it drifts behind the output and the writes land a lap
 *   late (see dsound-cursor-jittered-pump.test.ts).
 * - A delta pump on a 10 ms cadence (NFSU2) must stream at real time instead of ratcheting
 *   its Locks down (see dsound-cursor-step-cap.test.ts).
 *
 * Simulated end to end against the real methods: getApiCursors for each query,
 * trailRing + writeToLaps for each Unlock, and a worklet consuming the host ring in render
 * bursts. Each test has a negative control that breaks the property it guards.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { CTRL_BLOCK_BYTES, CTRL_PLAY_CURSOR } from "../../src/audio/audio-ring-buffer";

const RENDER_BURST_MS = 10;
const WARMUP_MS = 3000;
const LOCK_WINDOW = 8;
const PTR = 0x1000;

type Buf = Record<string, unknown> & { sab: SharedArrayBuffer; bytes: number };
type Ds = Record<string, (...a: unknown[]) => unknown> & { stepGapScratch: Float64Array };

let clock = 0;
const ownNow = Object.getOwnPropertyDescriptor(performance, "now");
beforeAll(() => {
    Object.defineProperty(performance, "now", { configurable: true, writable: true, value: () => clock });
});
afterAll(() => {
    if (ownNow) Object.defineProperty(performance, "now", ownNow);
    else delete (performance as unknown as Record<string, unknown>).now;
});

type Format = { rate: number; blockAlign: number };

/** A looping, playing buffer wired to a simulated worklet, as Unlock and GetCurrentPosition see it. */
function rig(fmt: Format, size: number) {
    const bytesPerMs = (fmt.rate * fmt.blockAlign) / 1000;
    const latency = Math.round((fmt.rate * 120) / 1000) * fmt.blockAlign;
    const RING = (Math.floor((size + latency) / size) + 1) * size;
    const mem = new Uint8Array(PTR + size);
    const ds = Object.create(DSound.prototype) as Ds;
    ds.getMemory = () => mem;
    ds.stepGapScratch = new Float64Array(16);
    const sab = new SharedArrayBuffer(CTRL_BLOCK_BYTES + RING);
    const ctrl = new Int32Array(sab, 0, 16);
    const ring = new Uint8Array(sab, CTRL_BLOCK_BYTES);
    const buffer: Buf = {
        id: 1, bytes: size, ringBytes: RING, ptr: PTR, sab, frequency: fmt.rate, flags: 0,
        isPlaying: true, isLooping: true, streamed: true, currentPosition: 0,
        format: { sampleRate: fmt.rate, blockAlign: fmt.blockAlign, channels: 2, bitsPerSample: 16 },
    };
    const call = (name: string, ...a: unknown[]) => ds[name].call(ds, buffer, ...a);
    const start = 1000;
    clock = start;
    let raw = 0;
    let playedZeros = 0;
    return {
        buffer, start, bytesPerMs, ring: RING,
        get raw() { return raw; },
        get playedZeros() { return playedZeros; },
        /** The worklet consumes the ring in render bursts up to `to`; zeros played after warm-up are dropouts. */
        advance(to: number) {
            const burst = Math.floor((to - start) / RENDER_BURST_MS) * RENDER_BURST_MS;
            let next = Math.floor(burst * bytesPerMs);
            next -= next % fmt.blockAlign;
            for (let at = raw; at < next; at++) {
                if (to - start >= WARMUP_MS && ring[at % RING] === 0) playedZeros++;
            }
            raw = next;
            Atomics.store(ctrl, CTRL_PLAY_CURSOR, raw % RING);
        },
        cursors: () => call("getApiCursors") as { playCursor: number; writeCursor: number },
        /** Lock + Unlock of `n` bytes at `offset` filled with `value`; `recorded` is the size Lock saw. */
        unlock(offset: number, n: number, value: number, recorded = n) {
            const first = Math.min(n, size - offset);
            mem.fill(value, PTR + offset, PTR + offset + first);
            if (n > first) mem.fill(value, PTR, PTR + n - first);
            const locks = (buffer.stepLockSizes as Float64Array | undefined)
                ?? (buffer.stepLockSizes = new Float64Array(LOCK_WINDOW));
            const count = (buffer.stepLockCount as number | undefined) ?? 0;
            locks[count % LOCK_WINDOW] = recorded;
            buffer.stepLockCount = count + 1;
            call("trailRing");
            call("writeToLaps", mem, offset, first);
            if (n > first) call("writeToLaps", mem, 0, n - first);
        },
    };
}

/**
 * SDL2's DirectSound pump: wait (polling every `pollMs`) until the write cursor enters a new
 * chunk, then Lock the chunk after it. Every `pauseEveryMs` the host stalls for `pauseMs`;
 * the pump then queries at `catchupGapMs` for `catchupQueries` queries (it is behind, so it
 * finds a new chunk on every query and never sleeps). Returns the chunks it never wrote.
 */
function chunkedPump(opts: {
    fmt: Format; chunk: number; chunks: number; pollMs: number; pauseMs: number;
    catchupGapMs: number; catchupQueries: number; durationMs?: number; jitterLocks?: boolean;
}) {
    const { fmt, chunk, chunks, pollMs, pauseMs, catchupGapMs, catchupQueries } = opts;
    const durationMs = opts.durationMs ?? 23_000;
    const size = chunk * chunks;
    const r = rig(fmt, size);
    let lastChunk: number | undefined;
    let skipped = 0;
    let maxStep = 0;
    let nextPauseAt = r.start + WARMUP_MS;
    let catchup = 0;
    let wake = 0;
    while (clock - r.start < durationMs) {
        if (pauseMs > 0 && clock >= nextPauseAt) {
            clock += pauseMs;
            nextPauseAt += 2000;
            catchup = catchupQueries;
        } else if (catchup > 0) {
            clock += catchupGapMs;
            catchup--;
        } else {
            clock += pollMs;
        }
        r.advance(clock);
        const idx = Math.floor(r.cursors().writeCursor / chunk) % chunks;
        if (lastChunk === undefined) { lastChunk = idx; continue; }
        if (idx === lastChunk) continue;
        const steps = (idx - lastChunk + chunks) % chunks;
        if (clock - r.start >= WARMUP_MS) {
            skipped += steps - 1;
            maxStep = Math.max(maxStep, steps);
        }
        lastChunk = idx;
        // The negative control records Lock sizes that vary as a delta pump's do.
        const recorded = opts.jitterLocks ? chunk + ((wake++ & 1) ? fmt.blockAlign : 0) : chunk;
        r.unlock(((idx + 1) % chunks) * chunk, chunk, 0x55, recorded);
    }
    return { skipped, maxStep };
}

/** Chains of Satinav: 48 kHz float stereo, 8 chunks of 256 frames (2048 bytes, 5.3 ms). */
const SATINAV = { fmt: { rate: 48000, blockAlign: 8 }, chunk: 2048, chunks: 8 };
/** A 10 ms chunk at 44.1 kHz stereo 16-bit, polled every 5 ms. */
const TEN_MS = { fmt: { rate: 44100, blockAlign: 4 }, chunk: 1764, chunks: 8 };

describe("dsound: a chunked pump catching up after a host pause", () => {
    for (const pauseMs of [50, 250]) {
        test(`Satinav-shaped pump never steps over a chunk after a ${pauseMs} ms pause`, () => {
            const r = chunkedPump({ ...SATINAV, pollMs: 1, pauseMs, catchupGapMs: 4, catchupQueries: 40 });
            expect(r.maxStep).toBe(1);
            expect(r.skipped).toBe(0);
        });
        test(`a 10 ms chunk polled every 5 ms never steps over a chunk after a ${pauseMs} ms pause`, () => {
            const r = chunkedPump({ ...TEN_MS, pollMs: 5, pauseMs, catchupGapMs: 5, catchupQueries: 40 });
            expect(r.maxStep).toBe(1);
            expect(r.skipped).toBe(0);
        });
    }

    test("negative control: the same pump with Lock sizes that vary is given catch-up headroom and skips", () => {
        const r = chunkedPump({ ...SATINAV, pollMs: 1, pauseMs: 50, catchupGapMs: 4, catchupQueries: 40, jitterLocks: true });
        expect(r.skipped).toBeGreaterThan(0);
    });
});

/** UE1 Galaxy: Locks the cursor delta twice per wake, zeros over the span just played and PCM one lead on. */
function galaxyPump(gaps: number[], durationMs: number, fixedLockRecord?: number) {
    const fmt = { rate: 22050, blockAlign: 4 };
    const size = fmt.rate * fmt.blockAlign;
    const lead = 7496;
    const r = rig(fmt, size);
    let prevPlay: number | undefined;
    let wake = 0;
    while (clock - r.start < durationMs) {
        clock += gaps[wake % gaps.length];
        wake++;
        r.advance(clock);
        const { playCursor } = r.cursors();
        if (prevPlay === undefined) { prevPlay = playCursor; continue; }
        const delta = (playCursor - prevPlay + size) % size;
        if (delta > 0) {
            r.unlock(prevPlay, delta, 0, fixedLockRecord ?? delta);
            r.unlock((prevPlay + lead) % size, delta, 0x55, fixedLockRecord ?? delta);
        }
        prevPlay = playCursor;
    }
    return { playedZeros: r.playedZeros };
}

describe("dsound: a delta pump with jittered wakes keeps its catch-up headroom", () => {
    test("a 20 ms timer with every fourth callback late plays no dropouts", () => {
        expect(galaxyPump([20, 20, 20, 42], 30_000).playedZeros).toBe(0);
    });

    test("negative control: the same pump seen as a fixed-Lock pump loses the stream", () => {
        // Recorded as one constant Lock size (the typical delta), the bound gets no
        // catch-up headroom: the cursor drifts behind and the writes land a lap late.
        expect(galaxyPump([20, 20, 20, 42], 30_000, 1764).playedZeros).toBeGreaterThan(0);
    });
});

describe("dsound: a delta pump on a 10 ms cadence streams at real time", () => {
    const RATE_BYTES_PER_MS = (44100 * 4) / 1000;
    const SIZE = 88192;
    const truePos = (ms: number) => { const b = Math.floor(ms * RATE_BYTES_PER_MS); return b - (b % 4); };
    /** Fraction of real time the reported cursor covers over 4 s, starting from the ratcheted state. */
    const streamed = (nominalBytesPerMs: number) => {
        const self = { stepGapScratch: new Float64Array(16), ringSize: (b: { bytes: number }) => b.bytes };
        const buffer: Record<string, unknown> = { bytes: SIZE, format: { blockAlign: 4, sampleRate: 44100 } };
        const cap = (cursor: number, now: number) =>
            (DSound.prototype as unknown as { capCursorStep(b: unknown, c: number, n: number, r: number): number })
                .capCursorStep.call(self, buffer, cursor, now, nominalBytesPerMs);
        const record = (n: number) => {
            const ring = (buffer.stepLockSizes as Float64Array | undefined)
                ?? (buffer.stepLockSizes = new Float64Array(LOCK_WINDOW));
            const count = (buffer.stepLockCount as number | undefined) ?? 0;
            ring[count % LOCK_WINDOW] = n;
            buffer.stepLockCount = count + 1;
        };
        for (let i = 0; i < LOCK_WINDOW; i++) record(448);
        let last = cap(0, 0);
        let total = 0;
        for (let q = 1; q <= 400; q++) {
            const reported = cap(truePos(q * 10) % SIZE, q * 10);
            const delta = (reported - last + SIZE) % SIZE;
            last = reported;
            total += delta;
            if (delta > 0) record(Math.ceil(delta / 64) * 64);
        }
        return total / truePos(4000);
    };

    test("the NFSU2 pump climbs out of 448-byte Locks to real time", () => {
        expect(streamed(RATE_BYTES_PER_MS)).toBeGreaterThan(0.95);
    });

    test("negative control: a bound floored far below the rate holds it at a fraction", () => {
        // Told an eighth of the rate, the floor (even with catch-up headroom) sits at a
        // quarter of it, and the Locks ratchet down to it as they did before 9ccd4c3e.
        expect(streamed(RATE_BYTES_PER_MS / 8)).toBeLessThan(0.5);
    });
});
