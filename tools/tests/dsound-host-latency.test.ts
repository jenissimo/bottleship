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

    test("a span the worklet has already passed keeps only its part still ahead and its later laps", () => {
        const t = setup();
        t.setRaw(8000);
        t.buffer.stepLastCursor = 7000;
        t.unlock(7000, 2048, 0xcd);
        expect(t.span(8000, 9048)).toEqual(new Set([0xcd]));
        expect(t.span(23384, 25432)).toEqual(new Set([0xcd]));
        expect(t.span(7000, 8000)).toEqual(new Set([0xcd]));
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
        expect(t.span(1000, 5000)).toEqual(new Set([0x77]));
        expect(t.span(5000, RING)).toEqual(new Set([0x11]));
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
