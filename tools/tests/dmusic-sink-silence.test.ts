/**
 * Silence tracking of the DirectMusic sink. (Model copied from dmusic-sink.test.ts.) The DirectMusic port's DirectSound sink, against a model buffer that records what was
 * locked and written: it must write a continuous stream just ahead of the write cursor,
 * across the ring's wrap, and pick up at the cursor again after a stall instead of
 * writing a stale span the play cursor has already passed.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import type { Process } from "../../src/worker/core/process";
import { createSinkBuffer, DirectSoundSink, sinkBufferBytes } from "../../src/worker/modules/dmusic-sink";

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

describe("DirectSoundSink silence", () => {
    const silence = (out: Int16Array, frames: number) => { out.fill(0, 0, frames * 2); };
    const tone = (out: Int16Array, frames: number) => { for (let i = 0; i < frames * 2; i++) out[i] = 1000; };
    const step = Math.floor(RATE * 0.01) * BLOCK;

    test("a fresh buffer counts as silent", () => {
        const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
        sink.start();
        expect(sink.isSilent()).toBe(true);
    });

    test("audible output clears it, a whole ring of silence afterwards restores it", () => {
        const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
        sink.start();
        for (let t = 0; t < 20; t++) { sink.pump(tone); play = (play + step) % SIZE; }
        expect(sink.isSilent()).toBe(false);
        let t = 0;
        while (!sink.isSilent() && t < 1000) { sink.pump(silence); play = (play + step) % SIZE; t++; }
        expect(sink.isSilent()).toBe(true);
        for (let o = 0; o < SIZE; o += 2) expect(view.getInt16(DATA + o, true)).toBe(0);
    });

    test("one audible block in between resets the count", () => {
        const sink = new DirectSoundSink(process, BUFFER, 2, RATE);
        sink.start();
        for (let t = 0; t < 50; t++) { sink.pump(silence); play = (play + step) % SIZE; }
        sink.pump(tone); play = (play + step) % SIZE;
        expect(sink.isSilent()).toBe(false);
    });
});

import { DMUS_SEGF_SECONDARY, PerfSegment, Performance } from "../../src/worker/core/audio/directmusic/performance";
import { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";

describe("a path is audible while a wave plays on it", () => {
    const rate = 22050;
    const wave = { left: new Float32Array(8).fill(0.5), right: new Float32Array(8).fill(0.5), rate, frames: 8 };

    test("hasWaveOn follows the state routed to the path until it ends", () => {
        const perf = new Performance(new DlsSynth(rate, 8));
        const path = {}, other = {};
        expect(perf.hasWaveOn(path)).toBe(false);
        const state = perf.playSegment(PerfSegment.fromWave(wave), DMUS_SEGF_SECONDARY);
        state.output = path;
        expect(perf.hasWaveOn(path)).toBe(true);
        expect(perf.hasWaveOn(other)).toBe(false);
        state.ended = true;
        expect(perf.hasWaveOn(path)).toBe(false);
    });
});
