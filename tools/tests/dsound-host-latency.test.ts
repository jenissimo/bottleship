/**
 * DirectSound output latency on a looping buffer.
 *
 * The reported play cursor leads the worklet's read head by a host latency, queued in extra
 * laps of the host ring. An Unlocked span must land in the lap the app meant it for — placed
 * from the cursor the app was shown — and in every later lap already queued; the span the
 * worklet has just played must be refilled from the buffer. Silent when wrong: a span in the
 * wrong lap plays a lap early or late, a click nothing reports.
 *
 * Exercised through the prototype over a bare SharedArrayBuffer ring: no Process, no v86.
 */

import { describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { CTRL_BLOCK_BYTES, CTRL_FLAGS, CTRL_PLAY_CURSOR, CTRL_WRITE_CURSOR, FLAG_STREAMING } from "../../src/audio/audio-ring-buffer";

const SIZE = 16384;
const RING = 2 * SIZE;
const PTR = 0x1000;

function setup(opts: { looping?: boolean; playing?: boolean; laps?: number } = {}) {
    const RING = (opts.laps ?? 2) * SIZE;
    const mem = new Uint8Array(PTR + SIZE);
    const ds = Object.create(DSound.prototype) as Record<string, (...a: unknown[]) => unknown>;
    ds.getMemory = () => mem;
    const sab = new SharedArrayBuffer(CTRL_BLOCK_BYTES + RING);
    const ring = new Uint8Array(sab, CTRL_BLOCK_BYTES);
    ring.fill(0x11);
    const buffer: Record<string, unknown> = {
        bytes: SIZE, ringBytes: RING, ptr: PTR, sab, frequency: 48000,
        isPlaying: opts.playing ?? true, isLooping: opts.looping ?? true,
        format: { sampleRate: 48000, blockAlign: 8 },
    };
    const call = (name: string, ...a: unknown[]) => ds[name].call(ds, buffer, ...a);
    const setRaw = (raw: number) => Atomics.store(new Int32Array(sab, 0, 16), CTRL_PLAY_CURSOR, raw);
    const unlock = (pos: number, len: number, byte: number) => {
        mem.fill(byte, PTR + pos, PTR + pos + len);
        call("writeToLaps", mem, pos, len);
    };
    const span = (a: number, b: number) => new Set(ring.subarray(a, b));
    return { buffer, mem, ring, call, setRaw, unlock, span };
}

describe("dsound host output latency", () => {
    test("a looping buffer leads by the host latency; a one-shot never", () => {
        expect(setup().call("hostLatencyBytes")).toBe(RING - SIZE);
        expect(setup({ looping: false }).call("hostLatencyBytes")).toBe(0);
    });

    test("a span lands where the shown cursor puts it, and in every later queued lap", () => {
        const t = setup();
        t.setRaw(4096);
        t.buffer.stepLastCursor = 4096 + 6000;
        // Buffer offset 0 is 6288 past the shown cursor: 12288 past the worklet, ring 16384.
        t.unlock(0, 2048, 0xab);
        expect(t.span(16384, 18432)).toEqual(new Set([0xab]));
        // The lap after that wraps behind the head: ring 0, the farthest queued lap.
        expect(t.span(0, 2048)).toEqual(new Set([0xab]));
        // Everything the worklet still plays before them is left alone.
        expect(t.span(2048, 16384)).toEqual(new Set([0x11]));
        expect(t.span(18432, RING)).toEqual(new Set([0x11]));
    });

    test("a span between the worklet and the shown cursor is the next lap, not the one playing", () => {
        const t = setup();
        t.setRaw(4096);
        t.buffer.stepLastCursor = 4096 + 6000;
        // Offset 6000 is behind the shown cursor: the app is writing its next lap there.
        t.unlock(6000, 1024, 0xee);
        expect(t.span(6000, 7024)).toEqual(new Set([0x11]));
        expect(t.span(22384, 23408)).toEqual(new Set([0xee]));
    });

    test("a whole-buffer span is split at the shown cursor: ahead plays this lap, behind the next", () => {
        // Quake II locks and unlocks the entire buffer every frame. The bytes it just mixed sit
        // right after the shown cursor and are due now, not a lap later.
        const t = setup();
        t.setRaw(4096);
        t.buffer.stepLastCursor = 4096 + 6000; // buffer offset 10096, 6000 ahead of the worklet
        t.mem.fill(0xa1, PTR, PTR + 10096);
        t.mem.fill(0xb2, PTR + 10096, PTR + SIZE);
        t.call("writeToLaps", t.mem, 0, SIZE);
        // [10096, SIZE) follows the shown cursor in its own lap: ring 10096..16384.
        expect(t.span(10096, 16384)).toEqual(new Set([0xb2]));
        // [0, 10096) is behind the cursor: the next lap, ring 16384..26480.
        expect(t.span(16384, 26480)).toEqual(new Set([0xa1]));
        // ...and the cursor's lap continues into it a lap on: ring 26480..RING is [10096, 16384).
        expect(t.span(26480, RING)).toEqual(new Set([0xb2]));
        // The host-latency queue between the worklet and the shown cursor is not rewritten.
        expect(t.span(4096, 10096)).toEqual(new Set([0x11]));
    });

    test("a refill from behind the cursor is the next lap through the committed region, then this lap", () => {
        // NFS5's menu pump refills [lastEnd, play + ~10 ms). Shown play at offset 10096 with
        // a 2000-byte write lead: [8000, 12096) is the next lap, [12096, 13000) is past the
        // write cursor and plays in the cursor's own lap.
        const t = setup();
        t.setRaw(4096);
        t.buffer.stepLastCursor = 4096 + 6000;
        t.buffer.reportedLeadBytes = 2000;
        t.mem.fill(0xc3, PTR + 8000, PTR + 13000);
        t.call("writeSpanToLaps", t.mem, 8000, 5000, 0);
        expect(t.span(24384, 28480)).toEqual(new Set([0xc3]));
        expect(t.span(8000, 12096)).toEqual(new Set([0x11]));
        expect(t.span(12096, 13000)).toEqual(new Set([0xc3]));
        // Negative control: split at the play cursor, the bytes just past it play this lap.
        const u = setup();
        u.setRaw(4096);
        u.buffer.stepLastCursor = 4096 + 6000;
        u.buffer.reportedLeadBytes = 2000;
        u.mem.fill(0xc3, PTR + 8000, PTR + 13000);
        (globalThis as { __noCommittedSplit?: boolean }).__noCommittedSplit = true;
        try { u.call("writeSpanToLaps", u.mem, 8000, 5000, 0); } finally { delete (globalThis as { __noCommittedSplit?: boolean }).__noCommittedSplit; }
        expect(u.span(10096, 12096)).toEqual(new Set([0xc3]));
    });

    test("a refill Locked as two spans across the buffer end is one piece of stream", () => {
        // NFS5 Locks a wrapping refill as the buffer's tail, then its head, with no query in
        // between. Here the tail ends exactly at the shown cursor (offset 0): the head that
        // follows is in the committed region and is the next lap, like the tail.
        const run = (queryBetween: boolean) => {
            const t = setup();
            t.setRaw(12000);
            t.buffer.stepLastCursor = SIZE; // buffer offset 0, 4384 ahead of the worklet
            t.buffer.reportedLeadBytes = 2000;
            t.buffer.stepLastQueryAt = 1;
            t.mem.fill(0xd4, PTR + 14000, PTR + SIZE);
            t.mem.fill(0xd5, PTR, PTR + 600);
            t.call("writeSpanToLaps", t.mem, 14000, SIZE - 14000, 0);
            if (queryBetween) t.buffer.stepLastQueryAt = 2;
            t.call("writeSpanToLaps", t.mem, 0, 600, 0);
            return t;
        };
        const t = run(false);
        expect(t.span(30384, RING)).toEqual(new Set([0xd4]));
        expect(t.span(0, 600)).toEqual(new Set([0xd5]));
        expect(t.span(16384, 16984)).toEqual(new Set([0x11]));
        // Negative control: a cursor query between them ends the piece; the head is a new
        // write at the cursor and plays in its lap.
        expect(run(true).span(16384, 16984)).toEqual(new Set([0xd5]));
    });

    test("a whole-buffer span still splits at the play cursor through writeSpanToLaps", () => {
        const t = setup();
        t.setRaw(4096);
        t.buffer.stepLastCursor = 4096 + 6000;
        t.buffer.reportedLeadBytes = 2000;
        t.mem.fill(0xa1, PTR, PTR + 10096);
        t.mem.fill(0xb2, PTR + 10096, PTR + SIZE);
        t.call("writeSpanToLaps", t.mem, 0, SIZE, 0);
        expect(t.span(10096, 16384)).toEqual(new Set([0xb2]));
        expect(t.span(16384, 26480)).toEqual(new Set([0xa1]));
    });

    test("a span the worklet has already passed keeps only its part still ahead and its later laps", () => {
        const t = setup();
        t.setRaw(8000);
        t.buffer.stepLastCursor = 7000;
        t.unlock(7000, 2048, 0xcd);
        expect(t.span(8000, 9048)).toEqual(new Set([0xcd]));
        expect(t.span(23384, 25432)).toEqual(new Set([0xcd]));
        // ...up to the frames just behind the head, which the mixer's interpolator still reads.
        expect(t.span(7000, 8000 - 128)).toEqual(new Set([0xcd]));
        expect(t.span(8000 - 128, 8000)).toEqual(new Set([0x11]));
        expect(t.span(9048, 23384)).toEqual(new Set([0x11]));
    });

    test("a lead past half the ring is still a lead when the latency allows it", () => {
        // Three laps, 80ms of latency (30720 bytes): a lead of 25000 exceeds ring/2 (24576).
        const t = setup({ laps: 3 });
        t.setRaw(0);
        t.buffer.stepLastCursor = 25000;
        // Offset 26000 is 1000 past the shown cursor: 26000 past the worklet, not a lap behind.
        t.unlock(26000 % SIZE, 512, 0x5a);
        expect(t.span(26000, 26512)).toEqual(new Set([0x5a]));
    });

    test("a stopped buffer's write reaches every lap", () => {
        const t = setup({ playing: false });
        t.setRaw(0);
        t.unlock(100, 200, 0x42);
        expect(t.span(100, 300)).toEqual(new Set([0x42]));
        expect(t.span(SIZE + 100, SIZE + 300)).toEqual(new Set([0x42]));
    });

    test("the span the worklet vacates is refilled from the buffer", () => {
        const t = setup();
        t.setRaw(1000);
        t.call("trailRing");
        t.mem.fill(0x77, PTR, PTR + SIZE);
        t.setRaw(5000);
        t.call("trailRing");
        // Up to the frames the mixer's interpolator still reads behind its head (2 x 8 frames
        // of 8 bytes): those keep this lap's bytes until the head is past them.
        expect(t.span(1000 - 128, 5000 - 128)).toEqual(new Set([0x77]));
        expect(t.span(5000 - 128, RING)).toEqual(new Set([0x11]));
        t.setRaw(9000);
        t.call("trailRing");
        expect(t.span(5000 - 128, 9000 - 128)).toEqual(new Set([0x77]));
    });

    test("negative control: refilled right up to the head, the interpolator's history is overwritten", () => {
        const g = globalThis as { __noTrailKeep?: boolean };
        g.__noTrailKeep = true;
        try {
            const t = setup();
            t.setRaw(1000);
            t.call("trailRing");
            t.mem.fill(0x77, PTR, PTR + SIZE);
            t.setRaw(5000);
            t.call("trailRing");
            expect(t.span(5000 - 128, 5000)).toEqual(new Set([0x77]));
        } finally {
            delete g.__noTrailKeep;
        }
    });

    test("a diagnostic read of the cursors is not one of the app's queries", () => {
        const t = setup();
        t.buffer.stepLastCursor = 20000;
        t.buffer.stepLastQueryAt = 123;
        t.buffer.reportedLeadBytes = 8192;
        const before = JSON.stringify(t.buffer, (k, v) => (k === "sab" ? undefined : v));
        const peek = t.call("peekApiCursors") as { playCursor: number; writeCursor: number };
        expect(peek).toEqual({ playCursor: 20000 % SIZE, writeCursor: (20000 % SIZE + 8192) % SIZE });
        expect(JSON.stringify(t.buffer, (k, v) => (k === "sab" ? undefined : v))).toBe(before);
    });

    test("a stream's output holds at the furthest span the app wrote for its lap", () => {
        const t = setup();
        const ctrl = new Int32Array(t.buffer.sab as SharedArrayBuffer, 0, 16);
        t.buffer.streamed = true;
        t.setRaw(4096);
        t.call("syncFrontierHold");
        // Armed from a full ring: everything up to just behind the head counts as written.
        expect(Atomics.load(ctrl, CTRL_FLAGS) & FLAG_STREAMING).toBe(FLAG_STREAMING);
        expect(Atomics.load(ctrl, CTRL_WRITE_CURSOR)).toBe(4096 - 8);
        // The head plays on; a write for the current lap moves the frontier to its end...
        t.setRaw(8192);
        t.buffer.stepLastCursor = 8192;
        Atomics.store(ctrl, CTRL_WRITE_CURSOR, 8192);
        t.unlock(8192, 2048, 0xab);
        expect(Atomics.load(ctrl, CTRL_WRITE_CURSOR)).toBe(8192 + 2048);
        // ...and a write that ends short of it never moves it back.
        t.unlock(8192, 1024, 0xcd);
        expect(Atomics.load(ctrl, CTRL_WRITE_CURSOR)).toBe(8192 + 2048);
    });

    test("a static loop never holds", () => {
        const t = setup();
        const ctrl = new Int32Array(t.buffer.sab as SharedArrayBuffer, 0, 16);
        t.call("syncFrontierHold");
        expect(Atomics.load(ctrl, CTRL_FLAGS) & FLAG_STREAMING).toBe(0);
    });

    test("a restart makes every lap the buffer", () => {
        const t = setup();
        t.mem.fill(0x55, PTR, PTR + SIZE);
        t.call("resyncRing");
        expect(t.span(0, RING)).toEqual(new Set([0x55]));
    });
});
