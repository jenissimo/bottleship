/**
 * A delta-sized streaming pump woken with an irregular cadence must not lose the stream.
 *
 * UE1 Galaxy (Harry Potter 1, Unreal-engine titles) mixes into a looping buffer from a
 * ~20 ms timer: it reads the play cursor and, per wake, Locks what the cursor advanced
 * twice — zeros over the span just played and fresh PCM over the same span one fixed lead
 * (~85 ms) further on. Its Lock size therefore IS the cursor delta, and its wakes are not
 * evenly spaced: a host frame that runs long delays a timer callback by a whole tick.
 *
 * The reported play cursor is meant to lead the worklet by the host latency (see
 * hostLatencyBytes), which is the slack that keeps a write placed from it ahead of the
 * output. capCursorStep bounds how far the cursor may move between two queries; if that
 * bound is exactly the nominal rate over the typical gap, every longer-than-typical gap
 * loses ground that no later query can win back, the cursor drifts behind the worklet, and
 * once it sits about one Galaxy lead behind, writes alternate between landing ahead of the
 * output and a lap late: the output plays zeros and stale laps (robotic voice, dropouts).
 *
 * Simulated end to end against the real methods: getApiCursors for each query, trailRing +
 * writeToLaps for each Unlock (as Unlock does), and a worklet that consumes the host ring in
 * render bursts. Every PCM byte the pump writes is non-zero, so a zero the worklet plays is
 * a dropout.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { CTRL_BLOCK_BYTES, CTRL_PLAY_CURSOR } from "../../src/audio/audio-ring-buffer";

const RATE = 22050;
const BLOCK_ALIGN = 4;
const BYTES_PER_MS = (RATE * BLOCK_ALIGN) / 1000; // 88.2
const SIZE = RATE * BLOCK_ALIGN; // one second, as Harry Potter 1 creates it
const RING = 2 * SIZE;
const PTR = 0x1000;
const LOCK_WINDOW = 8;
/** Galaxy's write lead past the play cursor it reads (HP1: 7496 bytes). */
const PUMP_LEAD = 7496;
/** The worklet renders in bursts: Chrome on Windows runs several quanta every ~10 ms. */
const RENDER_BURST_MS = 10;
const WARMUP_MS = 3000;
const PCM = 0x55;

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

type Outcome = { playedZeros: number; minLeadMs: number; finalLeadMs: number };

/**
 * @param gaps the pump's wake gaps in ms, repeated
 * @param skipEvery drop the PCM write of every n-th wake (0 = never): a real hole in the stream
 */
function run(gaps: number[], durationMs: number, skipEvery = 0): Outcome {
    const mem = new Uint8Array(PTR + SIZE);
    const ds = Object.create(DSound.prototype) as Ds;
    ds.getMemory = () => mem;
    ds.stepGapScratch = new Float64Array(16);
    const sab = new SharedArrayBuffer(CTRL_BLOCK_BYTES + RING);
    const ctrl = new Int32Array(sab, 0, 16);
    const ring = new Uint8Array(sab, CTRL_BLOCK_BYTES);
    const buffer: Buf = {
        id: 1, bytes: SIZE, ringBytes: RING, ptr: PTR, sab, frequency: RATE, flags: 0,
        isPlaying: true, isLooping: true, streamed: true, currentPosition: 0,
        format: { sampleRate: RATE, blockAlign: BLOCK_ALIGN, channels: 2, bitsPerSample: 16 },
    };
    const call = (name: string, ...a: unknown[]) => ds[name].call(ds, buffer, ...a);

    const start = 1000;
    clock = start;
    let raw = 0;
    let playedZeros = 0;
    let minLead = Infinity;
    let lead = 0;
    const advanceWorklet = (to: number) => {
        const burst = Math.floor((to - start) / RENDER_BURST_MS) * RENDER_BURST_MS;
        let next = Math.floor(burst * BYTES_PER_MS);
        next -= next % BLOCK_ALIGN;
        for (let at = raw; at < next; at++) {
            if (to - start >= WARMUP_MS && ring[at % RING] === 0) playedZeros++;
        }
        raw = next;
        Atomics.store(ctrl, CTRL_PLAY_CURSOR, raw % RING);
    };
    const unlock = (offset: number, n: number, value: number) => {
        const first = Math.min(n, SIZE - offset);
        mem.fill(value, PTR + offset, PTR + offset + first);
        if (n > first) mem.fill(value, PTR, PTR + n - first);
        const locks = (buffer.stepLockSizes as Float64Array | undefined)
            ?? (buffer.stepLockSizes = new Float64Array(LOCK_WINDOW));
        const count = (buffer.stepLockCount as number | undefined) ?? 0;
        locks[count % LOCK_WINDOW] = n;
        buffer.stepLockCount = count + 1;
        call("trailRing");
        call("writeToLaps", mem, offset, first);
        if (n > first) call("writeToLaps", mem, 0, n - first);
    };

    let prevPlay: number | undefined;
    let wake = 0;
    while (clock - start < durationMs) {
        clock += gaps[wake % gaps.length];
        wake++;
        advanceWorklet(clock);
        const { playCursor } = call("getApiCursors") as { playCursor: number };
        const shown = Math.floor(buffer.stepLastCursor as number);
        lead = ((shown - (raw % RING) + RING + RING / 2) % RING) - RING / 2;
        if (clock - start >= WARMUP_MS) minLead = Math.min(minLead, lead);
        if (prevPlay === undefined) { prevPlay = playCursor; continue; }
        const delta = (playCursor - prevPlay + SIZE) % SIZE;
        if (delta > 0) {
            unlock(prevPlay, delta, 0);
            if (!(skipEvery > 0 && wake % skipEvery === 0)) unlock((prevPlay + PUMP_LEAD) % SIZE, delta, PCM);
        }
        prevPlay = playCursor;
    }
    return { playedZeros, minLeadMs: minLead / BYTES_PER_MS, finalLeadMs: lead / BYTES_PER_MS };
}

/** A 20 ms timer whose every fourth callback is a host frame late. */
const LATE_EVERY_FOURTH = [20, 20, 20, 42];

describe("dsound: a delta-sized pump with jittered wakes", () => {
    test("keeps the reported cursor ahead of the output and plays no dropouts", () => {
        const r = run(LATE_EVERY_FOURTH, 30_000);
        expect(r.playedZeros).toBe(0);
        expect(r.minLeadMs).toBeGreaterThan(0);
    });

    test("irregular cadences (seeded) keep the stream whole as well", () => {
        let s = 12345;
        const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
        const uniform = Array.from({ length: 997 }, () => 12 + Math.floor(next() * 22));
        const heavyTail = Array.from({ length: 997 }, () => (next() < 0.15 ? 35 + Math.floor(next() * 30) : 16 + Math.floor(next() * 6)));
        const even = run(uniform, 30_000);
        expect(even.playedZeros).toBe(0);
        expect(even.minLeadMs).toBeGreaterThan(0);
        // Runs of late callbacks may spend part of the latency; the stream must survive it.
        expect(run(heavyTail, 30_000).playedZeros).toBe(0);
    });

    test("an evenly spaced pump opens the host latency too", () => {
        const r = run([20], 30_000);
        expect(r.playedZeros).toBe(0);
        expect(r.finalLeadMs).toBeGreaterThan(60);
    });

    test("negative control: a hole in the pump's own stream is counted", () => {
        const r = run(LATE_EVERY_FOURTH, 30_000, 50);
        expect(r.playedZeros).toBeGreaterThan(0);
    });
});
