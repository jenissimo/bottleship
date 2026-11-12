/**
 * The DirectMusic port's DirectSound sink, against a model buffer that records what was
 * locked and written: it must write a continuous stream just ahead of the write cursor,
 * across the ring's wrap, and pick up at the cursor again after a stall instead of
 * writing a stale span the play cursor has already passed.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import type { Process } from "../../src/worker/core/process";
import { createSinkBuffer, DirectSoundSink, sinkBufferBytes, soundReference } from "../../src/worker/modules/dmusic-sink";

const RATE = 22050;
const BLOCK = 4;                       // stereo 16-bit
const SIZE = RATE * BLOCK;             // a one-second ring
const BUFFER = 0x9000;                 // the IDirectSoundBuffer "pointer"
const DATA = 0x10000;                  // where its bytes live in guest memory
/** How far the write cursor leads the play cursor in this model: 20 ms. */
const WRITE_LEAD = Math.floor(RATE * 0.02) * BLOCK;

const mem = new Uint8Array(DATA + SIZE + 0x100);
const view = new DataView(mem.buffer);
let play = 0;
let playing = false;
let locks: Array<{ offset: number; bytes: number }>;
let nextAlloc: number;

const exports: Record<string, (ctx: unknown, m: Uint8Array, a: number[]) => number> = {
    idirectsoundbuffer8_getcaps: (_c, _m, a) => { view.setUint32(a[1]! + 8, SIZE, true); return 0; },
    idirectsoundbuffer8_play: () => { playing = true; return 0; },
    idirectsoundbuffer8_stop: () => { playing = false; return 0; },
    idirectsoundbuffer8_getcurrentposition: (_c, _m, a) => {
        view.setUint32(a[1]!, play, true);
        view.setUint32(a[2]!, (play + WRITE_LEAD) % SIZE, true);
        return 0;
    },
    idirectsoundbuffer8_lock: (_c, _m, a) => {
        const offset = a[1]!, bytes = a[2]!;
        locks.push({ offset, bytes });
        const first = Math.min(bytes, SIZE - offset);
        view.setUint32(a[3]!, DATA + offset, true);
        view.setUint32(a[4]!, first, true);
        view.setUint32(a[5]!, first < bytes ? DATA : 0, true);
        view.setUint32(a[6]!, bytes - first, true);
        return 0;
    },
    idirectsoundbuffer8_unlock: () => 0,
};

const process = {
    getModule: (name: string) => (name === "dsound" ? { exports } : undefined),
    memory: { alloc: (size: number) => { const p = nextAlloc; nextAlloc += size; return p; }, free: () => {} },
} as unknown as Process;

/** A render that numbers every frame it produces, so continuity can be read back. */
function counter(): { render: (out: Int16Array, frames: number) => void; produced: () => number } {
    let n = 0;
    return {
        render: (out, frames) => { for (let i = 0; i < frames; i++) { out[i * 2] = n & 0x7fff; out[i * 2 + 1] = n & 0x7fff; n++; } },
        produced: () => n,
    };
}

const frameAt = (offset: number): number => view.getInt16(DATA + (offset % SIZE), true);

beforeEach(() => {
    mem.fill(0);
    Mem.bind(() => mem);
    play = 0;
    playing = false;
    locks = [];
    nextAlloc = 0x100;
});

describe("DirectSoundSink", () => {
    test("a render failure unlocks the buffer and the next pump can retry", () => {
        const unlock = exports.idirectsoundbuffer8_unlock!;
        let unlocked = 0;
        exports.idirectsoundbuffer8_unlock = () => { unlocked++; return 0; };
        try {
            const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
            sink.start();
            expect(() => sink.pump(() => { throw new Error("render failed"); })).toThrow("render failed");
            expect(unlocked).toBe(1);
            sink.pump(counter().render);
            expect(unlocked).toBe(2);
            sink.release();
        } finally { exports.idirectsoundbuffer8_unlock = unlock; }
    });

    test("buffer creation reacquires memory after both allocations and hands its private device to the buffer", () => {
        let current = new Uint8Array(128), released = 0, freed = 0;
        const grow = () => {
            const old = current;
            current = new Uint8Array(Math.max(4096, old.length * 2)); current.set(old);
            structuredClone(old.buffer, {transfer: [old.buffer]});
        };
        Mem.bind(() => current);
        const dsExports = {
            directsoundcreate: (_c: unknown, m: Uint8Array, a: number[]) => {
                expect(m).toBe(current); grow(); Mem.writeUint32(a[1]!, 0x700); return 0;
            },
            idirectsound8_createsoundbuffer: (_c: unknown, m: Uint8Array, a: number[]) => {
                expect(m).toBe(current);
                expect(Mem.readUint32(a[1]!)).toBe(36);
                Mem.writeUint32(a[2]!, 0x710); return 0;
            },
            IDirectSound8_Release: () => { released++; return 0; },
            IDirectSoundBuffer8_Release: () => 0,
        };
        const model = {getModule: () => ({exports: dsExports}), memory: {
            alloc: () => { grow(); return 0x100; }, free: () => { freed++; },
        }} as unknown as Process;
        expect(createSinkBuffer(model, 0, 2, RATE)).toBe(0x710);
        // The device must outlive the buffer (its last Release destroys the buffers it made).
        expect(released).toBe(0); expect(freed).toBe(1);
        soundReference(model, 0x710, true, false);
        expect(released).toBe(1);
    });
    test("starts the buffer looping and reads its size", () => {
        const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
        expect(sink.start()).toBe(true);
        expect(playing).toBe(true);
        sink.stop();
        expect(playing).toBe(false);
    });

    test("the first write starts at the write cursor and covers the lead beyond it", () => {
        const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
        const source = counter();
        sink.start();
        sink.pump(source.render);
        expect(locks).toHaveLength(1);
        expect(locks[0]!.offset).toBe(WRITE_LEAD);
        expect(locks[0]!.bytes % BLOCK).toBe(0);
        expect(locks[0]!.bytes / BLOCK / RATE).toBeCloseTo(0.08, 2);
        // Nothing more is owed until the cursors move.
        sink.pump(source.render);
        expect(locks).toHaveLength(1);
    });

    test("successive writes are contiguous, through the wrap of the ring", () => {
        const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
        const source = counter();
        sink.start();
        const step = Math.floor(RATE * 0.01) * BLOCK;   // a pump every 10 ms
        for (let t = 0; t < 250; t++) {
            sink.pump(source.render);
            play = (play + step) % SIZE;
        }
        for (let i = 1; i < locks.length; i++) {
            expect(locks[i]!.offset).toBe((locks[i - 1]!.offset + locks[i - 1]!.bytes) % SIZE);
        }
        // 2.5 s through a 1 s ring: the stream wrapped, and what was produced is what the
        // cursors consumed plus the lead held ahead of them.
        expect(source.produced() / RATE).toBeGreaterThan(2.4);
        expect(source.produced() / RATE).toBeLessThan(2.7);
        // The frame under the play cursor is one written for this lap, a little before the newest.
        const newest = (source.produced() - 1) & 0x7fff;
        const behind = (newest - frameAt(play) + 0x8000) & 0x7fff;
        expect(behind).toBeGreaterThan(0);
        expect(behind / RATE).toBeLessThan(0.15);
    });

    test("after a stall the stream resumes at the write cursor, with a bounded catch-up", () => {
        const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
        const source = counter();
        sink.start();
        sink.pump(source.render);
        const before = source.produced();
        play = (play + Math.floor(RATE * 0.6) * BLOCK) % SIZE;   // 600 ms with no pump
        sink.pump(source.render);
        const resumed = locks[locks.length - 1]!;
        expect(resumed.offset).toBe((play + WRITE_LEAD) % SIZE);
        expect((source.produced() - before) / RATE).toBeLessThan(0.26);
    });

    test("a pointer that is not a DirectSound buffer is refused, not played", () => {
        const failing = {
            getModule: () => ({ exports: { ...exports, idirectsoundbuffer8_getcaps: () => -1 } }),
            memory: (process as unknown as { memory: unknown }).memory,
        } as unknown as Process;
        const sink = new DirectSoundSink(failing, BUFFER, 2, RATE);
        expect(sink.start()).toBe(false);
        expect(playing).toBe(false);
    });

    test("the buffer size offered to the application is two seconds of audio", () => {
        expect(sinkBufferBytes(2, 22050)).toBe(22050 * 4 * 2);
        expect(sinkBufferBytes(1, 44100)).toBe(44100 * 2 * 2);
    });
});
