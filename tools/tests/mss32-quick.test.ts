import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MSS32 } from "../../src/worker/modules/mss32";
import { createMSSContext, SMP_FREE, type MSSContext } from "../../src/worker/modules/mss32/context";
import { createCoreExports } from "../../src/worker/modules/mss32/core";
import { createQuickExports } from "../../src/worker/modules/mss32/quick";
import { resetMssRingBuffers, updateEmulatorState } from "../../src/worker/modules/mss32/playback-engine";
import { captureMssSavestate, restoreMssSavestate } from "../../src/worker/modules/mss32/savestate";
import { mss32Module } from "../../src/worker/api/mss32.api";
import { encodeValue, decodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CTRL_BLOCK_BYTES, CTRL_DATA_LENGTH, CTRL_FREQUENCY, CTRL_LOOP_MODE, CTRL_PAN,
    CTRL_STATE, CTRL_VOLUME, STATE_PLAYING, getCtrl } from "../../src/audio/audio-ring-buffer";

const IMAGE = 0x18000, SAMPLE_ARRAY = 0x2000;
const saved = new Map<string, PropertyDescriptor | undefined>();
const rings = new Map<number, SharedArrayBuffer>();
let Processor: any, processor: any, module: MSS32, ctx: MSSContext, memory: Uint8Array;
let next: number, allocations: Set<number>, freed: number[];
function global(key: string, value: unknown): void {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const invoke = (name: string, args: number[]) => module.exports[name]!(null as any, memory, args);
function wave(frames = 64, channels = 1, bits = 16): number {
    const align = channels * bits / 8, length = 44 + frames * align;
    const v = new DataView(memory.buffer, IMAGE, length);
    memory.set(new TextEncoder().encode("RIFF"), IMAGE); v.setUint32(4, length - 8, true);
    memory.set(new TextEncoder().encode("WAVEfmt "), IMAGE + 8); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, 48000, true);
    v.setUint32(28, 48000 * align, true); v.setUint16(32, align, true); v.setUint16(34, bits, true);
    memory.set(new TextEncoder().encode("data"), IMAGE + 36); v.setUint32(40, frames * align, true);
    for (let i = 0; i < frames * channels; i++) {
        if (bits === 16) v.setInt16(44 + i * 2, i % 2 ? -8192 : 8192, true);
        else v.setUint8(44 + i, i % 2 ? 96 : 160);
    }
    return length;
}
function load(length = wave()): number {
    const handle = invoke("_AIL_quick_load_mem@8", [IMAGE, length]);
    expect(typeof handle).toBe("number"); expect(handle as number).toBeGreaterThan(0);
    return handle as number;
}
function quantum(): Float32Array[] {
    const out = [new Float32Array(128), new Float32Array(128)];
    processor.process([], [out], {});
    return out;
}
beforeAll(async () => {
    global("AudioWorkletProcessor", class { port = { postMessage(_m: unknown) {}, onmessage: null as any }; });
    global("registerProcessor", (name: string, ctor: unknown) => { if (name === "bottleship-audio") Processor = ctor; });
    global("sampleRate", 48000); global("currentTime", 0);
    global("self", { postMessage(m: any) {
        if (m.type === "audio_register") {
            rings.set(m.payload.id, m.payload.sab);
            processor?.port.onmessage({ data: { type: "register", ...m.payload } });
        }
        if (m.type === "audio_unregister") {
            rings.delete(m.payload.id);
            processor?.port.onmessage({ data: { type: "unregister", id: m.payload.id } });
        }
    } });
    await import("../../src/audio/bottleship-audio-worklet");
});
beforeEach(() => {
    resetMssRingBuffers(); rings.clear(); processor = new Processor();
    memory = new Uint8Array(0x40000); next = 0x8000; allocations = new Set(); freed = [];
    ctx = createMSSContext({
        getCurrentMemory: () => memory,
        memory: {
            alloc(length: number) { const at = next; next += (length + 15) & ~15; allocations.add(at); return at; },
            free(at: number) { allocations.delete(at); freed.push(at); },
        },
    } as never);
    ctx.digitalDriverHandle = 0x1000; ctx.driverSampleArray = SAMPLE_ARRAY;
    ctx.driverMaxSamples = 2;
    const view = new DataView(memory.buffer);
    view.setUint32(ctx.digitalDriverHandle + 0x10, 127, true); // real driver default master volume
    for (let i = 0; i < 2; i++) view.setUint32(SAMPLE_ARRAY + i * 0x284 + 8, SMP_FREE, true);
    module = new MSS32(); (module as any).ctx = ctx;
    Object.assign(module.exports, createCoreExports(ctx), createQuickExports(ctx));
    (module as any).installStreamServicePoints();
});
afterEach(() => { module.reset(); resetMssRingBuffers(); });
afterAll(() => {
    for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

describe("Miles quick audio", () => {
    test("all quick entry points have real stdcall descriptors and undecorated aliases", () => {
        for (const [name, count] of [["load_mem", 2], ["play", 2], ["status", 1], ["set_volume", 3], ["halt", 1], ["unload", 1]] as const) {
            const decorated = `_AIL_quick_${name}@${count * 4}`;
            const plain = `AIL_quick_${name}`;
            for (const name of [decorated, plain]) {
                const fn = mss32Module.functions.find(f => f.name === name)!;
                expect(fn.params.length).toBe(count); expect(fn.callingConvention).toBe("stdcall");
                expect(typeof module.exports[name]).toBe("function");
            }
        }
        expect(invoke("_AIL_quick_status@4", [0])).toBe(1); // native QSTAT_DONE
        expect(invoke("_AIL_quick_play@8", [0, 1])).toBe(0);
    });

    test("load does not allocate a voice; real decoded PCM reaches the mixer and only consumption ends playback", () => {
        const h = load();
        expect(invoke("_AIL_quick_status@4", [h])).toBe(2);
        expect(ctx.samples.size).toBe(0); expect(rings.size).toBe(0);
        expect(invoke("_AIL_quick_play@8", [h, 1])).toBe(1);
        expect(invoke("_AIL_quick_status@4", [h])).toBe(3);
        const q = ctx.quickAudio.get(h)!, sample = ctx.samples.get(q.sampleHandle)!;
        const sab = rings.get(sample.id)!;
        expect(getCtrl(sab, CTRL_FREQUENCY)).toBe(48000);
        expect(getCtrl(sab, CTRL_DATA_LENGTH)).toBe(64 * 4);
        expect([...new Float32Array(sab, CTRL_BLOCK_BYTES, 4)]).toEqual([0.25, -0.25, 0.25, -0.25]);
        expect(getCtrl(sab, CTRL_STATE)).toBe(STATE_PLAYING);
        const output = quantum();
        expect(output[0].some(v => Math.abs(v) > 0.1)).toBe(true);
        updateEmulatorState(ctx); // heartbeat also releases a finished quick voice, without polling.
        expect(ctx.samples.size).toBe(0); expect(rings.size).toBe(0);
        expect(invoke("_AIL_quick_status@4", [h])).toBe(1);
        expect(allocations.has(h)).toBe(true); // HAUDIO survives EOS for replay.
    });

    test("N loops and infinite loops use the mixer, and replay restarts rather than resuming", () => {
        const h = load(wave(256, 2, 8));
        expect(invoke("_AIL_quick_play@8", [h, 0])).toBe(1);
        let q = ctx.quickAudio.get(h)!, sample = ctx.samples.get(q.sampleHandle)!;
        expect(sample.channels).toBe(2); expect(sample.sampleRate).toBe(48000);
        expect(getCtrl(rings.get(sample.id)!, CTRL_LOOP_MODE)).toBe(-1);
        for (let i = 0; i < 10; i++) quantum();
        expect(invoke("_AIL_quick_status@4", [h])).toBe(3);
        const oldId = sample.id;
        expect(invoke("_AIL_quick_play@8", [h, 2])).toBe(1);
        q = ctx.quickAudio.get(h)!; sample = ctx.samples.get(q.sampleHandle)!;
        expect(sample.id).not.toBe(oldId); expect(rings.has(oldId)).toBe(false);
        expect(getCtrl(rings.get(sample.id)!, CTRL_LOOP_MODE)).toBe(2);
        for (let i = 0; i < 8; i++) { quantum(); updateEmulatorState(ctx); }
        expect(invoke("_AIL_quick_status@4", [h])).toBe(1);
        expect(ctx.samples.size).toBe(0);
    });

    test("legacy volume/pan updates apply before and during play, and -1 preserves each control", () => {
        const h = load(wave(1024));
        invoke("_AIL_quick_set_volume@12", [h, 32, 0]);
        invoke("_AIL_quick_play@8", [h, 1]);
        const q = ctx.quickAudio.get(h)!, sample = ctx.samples.get(q.sampleHandle)!;
        const sab = rings.get(sample.id)!;
        expect(sample.volume).toBe(32); expect(sample.pan).toBe(0);
        expect(getCtrl(sab, CTRL_VOLUME)).toBeLessThan(0); expect(getCtrl(sab, CTRL_PAN)).toBe(-10000);
        const volume = getCtrl(sab, CTRL_VOLUME);
        invoke("_AIL_quick_set_volume@12", [h, 0xFFFFFFFF, 127]);
        expect(getCtrl(sab, CTRL_VOLUME)).toBe(volume); expect(getCtrl(sab, CTRL_PAN)).toBe(10000);
        invoke("_AIL_quick_set_volume@12", [h, 0, 0xFFFFFFFF]);
        expect(sample.pan).toBe(127); expect(getCtrl(sab, CTRL_VOLUME)).toBe(-10000);
        invoke("_AIL_quick_play@8", [h, 1]);
        const replay = ctx.samples.get(q.sampleHandle)!;
        expect(replay.volume).toBe(0); expect(replay.pan).toBe(64); // stored -1 => fresh native default
    });

    test("loaded handles do not exhaust voices; natural EOS, halt, unload, shutdown and reset release owners", () => {
        const handles = Array.from({ length: 5 }, () => load(wave(512)));
        expect(ctx.samples.size).toBe(0);
        invoke("_AIL_quick_play@8", [handles[0]!, 1]);
        invoke("_AIL_quick_play@8", [handles[1]!, 1]);
        expect(invoke("_AIL_quick_play@8", [handles[2]!, 1])).toBe(0); // real two-voice pool
        expect(invoke("_AIL_quick_status@4", [handles[2]!])).toBe(1);
        invoke("_AIL_quick_halt@4", [handles[0]!]);
        expect(invoke("_AIL_quick_status@4", [handles[0]!])).toBe(1);
        expect(invoke("_AIL_quick_play@8", [handles[2]!, 1])).toBe(1);
        invoke("_AIL_quick_unload@4", [handles[1]!]);
        expect(freed.filter(v => v === handles[1]!).length).toBe(1);
        invoke("_AIL_quick_unload@4", [handles[1]!]);
        expect(freed.filter(v => v === handles[1]!).length).toBe(1);
        invoke("_AIL_quick_shutdown@0", []);
        expect(ctx.quickAudio.size).toBe(0); expect(rings.size).toBe(0); expect(allocations.size).toBe(0);
        expect(freed.includes(IMAGE)).toBe(false);
    });

    test("module reset releases loaded and playing quick owners without freeing borrowed images", () => {
        const playing = load(wave(1024)), idle = load(wave(1024));
        invoke("_AIL_quick_play@8", [playing, 0]);
        expect(ctx.quickAudio.size).toBe(2); expect(rings.size).toBe(1);
        module.reset();
        expect(ctx.quickAudio.size).toBe(0); expect(ctx.samples.size).toBe(0);
        expect(rings.size).toBe(0); expect(allocations.size).toBe(0);
        expect(freed.filter(v => v === playing).length).toBe(1);
        expect(freed.filter(v => v === idle).length).toBe(1);
        expect(freed.includes(IMAGE)).toBe(false);
    });

    test("invalid ranges, missing digital driver and unsupported images never report playing", () => {
        const size = wave();
        for (const args of [[0, size], [IMAGE, 0], [0xFFFFFFF0, 256], [memory.length - 4, 128]]) {
            expect(invoke("_AIL_quick_load_mem@8", args)).toBe(0);
        }
        memory.fill(0xFF, IMAGE, IMAGE + size);
        expect(invoke("_AIL_quick_load_mem@8", [IMAGE, size])).toBe(0);
        memory.set(new TextEncoder().encode("MThd"), IMAGE);
        expect(invoke("_AIL_quick_load_mem@8", [IMAGE, size])).toBe(0); // no fake MIDI synthesis
        wave(); ctx.digitalDriverHandle = 0;
        expect(invoke("_AIL_quick_load_mem@8", [IMAGE, size])).toBe(0);
        expect(allocations.size).toBe(0); expect(ctx.samples.size).toBe(0); expect(rings.size).toBe(0);
    });

    test("a borrowed image is read at play time and is never freed by unload", () => {
        const h = load();
        memory.fill(0, IMAGE, IMAGE + 44);
        expect(invoke("_AIL_quick_play@8", [h, 1])).toBe(0);
        expect(invoke("_AIL_quick_status@4", [h])).toBe(1);
        expect(ctx.samples.size).toBe(0); expect(rings.size).toBe(0);
        invoke("_AIL_quick_unload@4", [h]);
        expect(freed).toEqual([h]);
    });

    test("PCM quick handles, active cursor and loaded status survive a real state codec round trip", async () => {
        const h = load(wave(2048)), idle = load(wave(2048));
        invoke("_AIL_quick_play@8", [h, 1]); quantum(); updateEmulatorState(ctx);
        const before = ctx.quickAudio.get(h)!, beforeSample = ctx.samples.get(before.sampleHandle)!;
        const image = captureMssSavestate(ctx);
        const encoded = encodeValue(image as unknown as SaveValue);
        const decoded = decodeValue(encoded) as unknown as typeof image;
        expect(image.quickAudio.length).toBe(2);
        const oldId = beforeSample.id;
        await restoreMssSavestate(ctx, decoded);
        expect(invoke("_AIL_quick_status@4", [idle])).toBe(2);
        expect(invoke("_AIL_quick_status@4", [h])).toBe(3);
        expect(ctx.samplesById.has(oldId)).toBe(true);
        expect(quantum()[0].some(v => Math.abs(v) > 0.1)).toBe(true);
        invoke("_AIL_quick_unload@4", [h]); invoke("_AIL_quick_unload@4", [idle]);
        expect(rings.size).toBe(0); expect(allocations.size).toBe(0);
    });
});
