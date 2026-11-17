import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MSS32 } from "../../src/worker/modules/mss32";
import { createMSSContext, type MSSContext } from "../../src/worker/modules/mss32/context";
import { createSampleExports } from "../../src/worker/modules/mss32/sample";
import { createSampleBufferExports } from "../../src/worker/modules/mss32/sample-buffers";
import { updateEmulatorState, resetMssRingBuffers } from "../../src/worker/modules/mss32/playback-engine";
import { captureMssSavestate, restoreMssSavestate } from "../../src/worker/modules/mss32/savestate";
import { mss32Module } from "../../src/worker/api/mss32.api";
import type { MSSSample } from "../../src/worker/modules/mss32/types";
import { CTRL_PLAY_CURSOR, CTRL_WRITE_CURSOR, CTRL_DATA_LENGTH, CTRL_STATE, CTRL_STOP_REQUESTED, CTRL_FLAGS,
    FLAG_STREAMING, STATE_PLAYING, STATE_STOPPED, getCtrl, setCtrl } from "../../src/audio/audio-ring-buffer";

const HANDLE = 0x400, DATA = 0x2000, CALLBACK = 0x401000;
let memory: Uint8Array, ctx: MSSContext, sample: MSSSample, module: MSS32;
let oldSelf: PropertyDescriptor | undefined;
let calls: Array<{ fn: number; args: number[]; cleanup: number }>;
let frame: number, savedCleanup: number, continuation: ((eax: number) => number | null) | undefined;
const rings = new Map<number, SharedArrayBuffer>();
const invoke = (name: string, args: number[]) => module.exports[name]!(null as any, memory, args);
function cursor(frameNumber: number): void { setCtrl(rings.get(1)!, CTRL_PLAY_CURSOR, frameNumber * 4); }
function load(slot: number, frames: number): unknown {
    return invoke("_AIL_load_sample_buffer@16", [HANDLE, slot, DATA, frames * 2]);
}
function complete(): number | null | undefined {
    const answer = continuation?.(0xDEADBEEF);
    frame = 0;
    return answer;
}

beforeEach(() => {
    oldSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
    Object.defineProperty(globalThis, "self", { configurable: true, value: {
        postMessage(m: { type: string; payload?: { id: number; sab: SharedArrayBuffer } }) {
            if (m.type === "audio_register") rings.set(m.payload!.id, m.payload!.sab);
            if (m.type === "audio_unregister") rings.delete(m.payload!.id);
        },
    } });
    resetMssRingBuffers();
    rings.clear();
    memory = new Uint8Array(0x10000);
    calls = []; frame = 0; savedCleanup = -1; continuation = undefined;
    ctx = createMSSContext({
        getCurrentMemory: () => memory,
        dispatcher: { callbackManager: {
            getActiveSuspendedFrameId: () => frame,
            saveSuspendedThunkContext: (_ctx: unknown, cleanup: number) => { savedCleanup = cleanup; frame = 1; return 1; },
            invokeCallback: (fn: number, args: number[], cleanup: number, done: typeof continuation) => {
                calls.push({ fn, args, cleanup }); continuation = done; return { callbackId: calls.length };
            },
            getPendingCallback: () => ({}),
            abandonSuspendedFrame: () => { frame = 0; },
        } },
    } as never);
    sample = { id: 1, handle: HANDLE, fileData: null, decodedData: null, sampleRate: 22050,
        channels: 1, bitsPerSample: 16, formatTag: 1, blockAlign: 2, volume: 127, pan: 64,
        playbackRate: 1, loopCount: 1, isPlaying: false, isStopped: false, position: 0,
        pendingStart: false, fileDataAllocated: false };
    ctx.samples.set(HANDLE, sample);
    ctx.samplesById.set(1, sample);
    module = new MSS32();
    // Use the real export registration and service wrapper without starting an OS timer.
    (module as any).ctx = ctx;
    Object.assign(module.exports, createSampleExports(ctx), createSampleBufferExports(ctx));
    (module as any).installStreamServicePoints();
    new DataView(memory.buffer).setInt16(DATA, 0x1000, true);
});
afterEach(() => {
    resetMssRingBuffers();
    if (oldSelf) Object.defineProperty(globalThis, "self", oldSelf);
    else Reflect.deleteProperty(globalThis, "self");
});

describe("Miles end-of-buffer callbacks", () => {
    test("the descriptor and registered export preserve stdcall arity and the previous callback", () => {
        const descriptor = mss32Module.functions.find(f => f.name === "_AIL_register_EOB_callback@8")!;
        expect(descriptor.params.length).toBe(2);
        expect(descriptor.callingConvention).toBe("stdcall");
        expect(typeof module.exports["_AIL_register_EOB_callback@8"]).toBe("function");
        expect(invoke("_AIL_register_EOB_callback@8", [HANDLE, CALLBACK])).toBe(0);
        expect(invoke("_AIL_register_EOB_callback@8", [HANDLE, CALLBACK + 16])).toBe(CALLBACK);
        expect(invoke("_AIL_register_EOB_callback@8", [HANDLE, 0])).toBe(CALLBACK + 16);
        expect(invoke("_AIL_register_EOB_callback@8", [0x8000, CALLBACK])).toBe(0);
    });

    test("copying/decoding a buffer is not EOB; only consumption queues one callback per buffer", () => {
        invoke("_AIL_register_EOB_callback@8", [HANDLE, CALLBACK]);
        expect(load(0, 4)).toBe(1);
        expect(load(1, 5)).toBe(1);
        expect(calls).toEqual([]);
        expect(invoke("_AIL_sample_buffer_ready@4", [HANDLE])).toBe(-1);
        expect(getCtrl(rings.get(1)!, CTRL_WRITE_CURSOR)).toBe(9 * 4);
        cursor(3);
        updateEmulatorState(ctx);
        expect(ctx.pendingEOBCallbacks.length).toBe(0);
        expect(sample.streamBuffers![0]!.inUse).toBe(true);
        cursor(4);
        updateEmulatorState(ctx);
        updateEmulatorState(ctx);
        expect(calls).toEqual([]);
        expect(ctx.pendingEOBCallbacks).toEqual([{ callback: CALLBACK, handle: HANDLE, id: 1 }]);
        expect(sample.streamBuffers![0]!.inUse).toBe(false);
        expect(sample.streamBuffers![1]!.inUse).toBe(true);
        const suspended = invoke("_AIL_sample_buffer_ready@4", [HANDLE]) as any;
        expect(suspended.suspendedForCallback).toBe(true);
        expect(calls).toEqual([{ fn: CALLBACK, args: [HANDLE], cleanup: 0 }]);
        expect(savedCleanup).toBe(4);
        expect(complete()).toBe(0); // ready buffer index, not callback EAX
        cursor(9);
        updateEmulatorState(ctx);
        expect(ctx.pendingEOBCallbacks.length).toBe(1);
        invoke("_AIL_sample_buffer_ready@4", [HANDLE]);
        expect(calls.length).toBe(2);
        expect(complete()).toBe(0);
        updateEmulatorState(ctx);
        expect(ctx.pendingEOBCallbacks).toEqual([]);
        expect(calls.length).toBe(2);
    });

    test("an active guest callback defers another EOB and preserves the service result", () => {
        invoke("_AIL_register_EOB_callback@8", [HANDLE, CALLBACK]);
        load(0, 4); load(1, 5);
        cursor(9); updateEmulatorState(ctx);
        const args = [HANDLE, 0, 0x100, 0x104, 0x108];
        expect((invoke("_AIL_sample_buffer_info@20", args) as any).suspendedForCallback).toBe(true);
        expect(savedCleanup).toBe(20);
        expect(invoke("_AIL_sample_buffer_ready@4", [HANDLE])).toBe(0);
        expect(calls.length).toBe(1);
        expect(ctx.pendingEOBCallbacks.length).toBe(1);
        expect(complete()).toBe(1); // AIL_sample_buffer_info's ordinary return
        invoke("_AIL_sample_buffer_ready@4", [HANDLE]);
        expect(calls.length).toBe(2);
        complete();
    });

    test("unregister and release cancel queued callbacks, including handle reuse", () => {
        invoke("_AIL_register_EOB_callback@8", [HANDLE, CALLBACK]);
        load(0, 4); cursor(4); updateEmulatorState(ctx);
        frame = 1;
        expect(invoke("_AIL_register_EOB_callback@8", [HANDLE, 0])).toBe(CALLBACK);
        frame = 0;
        invoke("_AIL_sample_buffer_ready@4", [HANDLE]);
        expect(calls).toEqual([]);
        sample.eobCallback = CALLBACK;
        ctx.pendingEOBCallbacks.push({ callback: CALLBACK, handle: HANDLE, id: 1 });
        ctx.samples.set(HANDLE, { ...sample, id: 2 });
        invoke("_AIL_sample_buffer_ready@4", [HANDLE]);
        expect(calls).toEqual([]);
        expect(ctx.pendingEOBCallbacks).toEqual([]);
    });

    test("a zero-length end marker fires EOS once after pending data, not when submitted", () => {
        invoke("_AIL_register_EOS_callback@8", [HANDLE, CALLBACK + 32]);
        load(0, 4);
        expect(load(1, 0)).toBe(1);
        updateEmulatorState(ctx);
        expect(sample.isPlaying).toBe(true);
        cursor(4);
        updateEmulatorState(ctx);
        expect(sample.isPlaying).toBe(false);
        updateEmulatorState(ctx);
        expect(ctx.pendingEOSCallbacks).toEqual([{ callback: CALLBACK + 32, handle: HANDLE, user: 0 }]);
        expect(calls).toEqual([]);
    });

    test("a bounded circular ring retains the tail and crosses wrap without early EOB", () => {
        const frames = 20000;
        expect(load(0, frames)).toBe(1);
        expect(load(1, frames)).toBe(1);
        const ring = rings.get(1)!;
        const capacity = getCtrl(ring, CTRL_DATA_LENGTH);
        expect(capacity).toBe((frames * 2 + 1) * 4);
        cursor(frames);
        updateEmulatorState(ctx);
        expect(sample.streamBuffers![0]!.inUse).toBe(false);
        expect(sample.streamBuffers![1]!.inUse).toBe(true);
        expect(load(0, frames)).toBe(1);
        cursor(frames * 2);
        updateEmulatorState(ctx);
        expect(sample.streamBuffers![1]!.inUse).toBe(false);
        // Mixer cursor wraps while absolute source-buffer boundaries keep increasing.
        setCtrl(ring, CTRL_PLAY_CURSOR, ((frames * 3 * 4) % capacity));
        updateEmulatorState(ctx);
        expect(sample.streamBuffers![0]!.inUse).toBe(false);
        expect(sample.position).toBe(frames * 3 * 2);
    });

    test("a larger pending tail stays owned until all of its actual ring frames drain", () => {
        expect(load(0, 4)).toBe(1);
        expect(load(1, 20000)).toBe(1);
        expect(sample.bufferPlayback!.pending.length).toBe(1);
        cursor(4); updateEmulatorState(ctx);
        expect(sample.streamBuffers![0]!.inUse).toBe(false);
        expect(sample.streamBuffers![1]!.inUse).toBe(true);
        cursor(10000); updateEmulatorState(ctx);
        expect(sample.bufferPlayback!.pending).toEqual([]);
        expect(sample.streamBuffers![1]!.inUse).toBe(true);
        const capacity = getCtrl(rings.get(1)!, CTRL_DATA_LENGTH);
        setCtrl(rings.get(1)!, CTRL_PLAY_CURSOR, (20004 * 4) % capacity);
        updateEmulatorState(ctx);
        expect(sample.streamBuffers![1]!.inUse).toBe(false);
        expect(sample.position).toBe(20004 * 2);
    });

    test("start rewinds only still-owned buffers and keeps a circular ring with rebased boundaries", () => {
        load(0, 8); load(1, 9);
        cursor(3); updateEmulatorState(ctx);
        const capacity = getCtrl(rings.get(1)!, CTRL_DATA_LENGTH);
        expect(invoke("_AIL_start_sample@4", [HANDLE])).toBe(1);
        expect(getCtrl(rings.get(1)!, CTRL_FLAGS) & FLAG_STREAMING).toBe(FLAG_STREAMING);
        expect(getCtrl(rings.get(1)!, CTRL_DATA_LENGTH)).toBe(capacity);
        expect(getCtrl(rings.get(1)!, CTRL_PLAY_CURSOR)).toBe(0);
        expect(sample.position).toBe(0);
        cursor(10); updateEmulatorState(ctx);
        expect(sample.streamBuffers![0]!.inUse).toBe(false);
        expect(sample.streamBuffers![1]!.inUse).toBe(true);
        expect(invoke("_AIL_start_sample@4", [HANDLE])).toBe(1);
        expect(sample.bufferPlayback!.submittedFrames).toBe(9);
        expect(sample.streamBuffers![0]!.inUse).toBe(false);
        expect(sample.streamBuffers![1]!.endFrame).toBe(9);
        cursor(8); updateEmulatorState(ctx);
        expect(sample.streamBuffers![1]!.inUse).toBe(true);
        cursor(9); updateEmulatorState(ctx);
        expect(sample.streamBuffers![1]!.inUse).toBe(false);
    });

    test("stop/resume preserves the mixer cursor and source ownership; start after stop rewinds", () => {
        load(0, 8); load(1, 9);
        cursor(3); updateEmulatorState(ctx);
        const ring = rings.get(1)!;
        expect(invoke("_AIL_stop_sample@4", [HANDLE])).toBe(0);
        expect(getCtrl(ring, CTRL_STATE)).toBe(STATE_STOPPED);
        expect(getCtrl(ring, CTRL_STOP_REQUESTED)).toBe(0);
        expect(getCtrl(ring, CTRL_PLAY_CURSOR)).toBe(12);
        updateEmulatorState(ctx);
        expect(sample.streamBuffers![0]!.inUse).toBe(true);
        expect(invoke("_AIL_resume_sample@4", [HANDLE])).toBe(1);
        expect(rings.get(1)).toBe(ring);
        expect(getCtrl(ring, CTRL_STATE)).toBe(STATE_PLAYING);
        expect(getCtrl(ring, CTRL_PLAY_CURSOR)).toBe(12);
        invoke("_AIL_stop_sample@4", [HANDLE]);
        expect(invoke("_AIL_start_sample@4", [HANDLE])).toBe(1);
        expect(getCtrl(rings.get(1)!, CTRL_PLAY_CURSOR)).toBe(0);
        expect(sample.position).toBe(0);
    });

    test("reinit and release dispose the buffered ring before an ordinary sample or handle reuse", () => {
        invoke("_AIL_register_EOB_callback@8", [HANDLE, CALLBACK]);
        load(0, 4);
        invoke("_AIL_init_sample@4", [HANDLE]);
        expect(rings.has(1)).toBe(false);
        expect(sample.bufferPlayback).toBeUndefined();
        expect(sample.streamBuffers).toBeUndefined();
        expect(sample.eobCallback).toBeUndefined();
        expect(invoke("_AIL_start_sample@4", [HANDLE])).toBe(1);
        expect(getCtrl(rings.get(1)!, CTRL_FLAGS) & FLAG_STREAMING).toBe(0);
        load(0, 4);
        expect(getCtrl(rings.get(1)!, CTRL_FLAGS) & FLAG_STREAMING).toBe(FLAG_STREAMING);
        invoke("_AIL_release_sample_handle@4", [HANDLE]);
        expect(rings.has(1)).toBe(false);
        expect(ctx.samples.has(HANDLE)).toBe(false);
    });

    test("savestate preserves an idle EOB callback and refuses live buffered input", async () => {
        invoke("_AIL_register_EOB_callback@8", [HANDLE, CALLBACK]);
        const saved = captureMssSavestate(ctx);
        sample.eobCallback = 0;
        await restoreMssSavestate(ctx, saved);
        expect(ctx.samples.get(HANDLE)!.eobCallback).toBe(CALLBACK);
        load(0, 4);
        expect(() => captureMssSavestate(ctx)).toThrow("live double-buffered input");
    });
});
