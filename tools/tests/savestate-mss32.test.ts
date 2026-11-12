import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encodeValue, decodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { System } from "../../src/worker/core/system";
import { createMSSContext, type MSSContext } from "../../src/worker/modules/mss32/context";
import type { MSSSample, MSSStream, MSSStreamSource } from "../../src/worker/modules/mss32/types";
import {
    captureMssSavestate, restoreMssSavestate, registerMssSavestate,
    MSS_CONTEXT_FIELDS, MSS_SAMPLE_FIELDS, MSS_STREAM_FIELDS, MSS_TIMER_FIELDS, type MssState,
} from "../../src/worker/modules/mss32/savestate";
import { decodeRawSampleData } from "../../src/worker/modules/mss32/sample";
import { convertToFloat } from "../../src/worker/modules/mss32/audio-decode";
import {
    playSample, stopRingBuffer, appendDecodedChunk, ensureStreamingRing, appendStreamingRing, startStreamingRing,
    incrementalStreamPosition, resetMssRingBuffers,
} from "../../src/worker/modules/mss32/playback-engine";
import { resetRawSampleCache } from "../../src/worker/modules/mss32/raw-sample-cache";
import {
    getCtrl, setCtrl, CTRL_PLAY_CURSOR, CTRL_WRITE_CURSOR, CTRL_BLOCK_ALIGN, CTRL_STATE, CTRL_DATA_LENGTH, CTRL_BLOCK_BYTES,
    CTRL_FREQUENCY, CTRL_RESERVED, STATE_PLAYING, STATE_STOPPED,
} from "../../src/audio/audio-ring-buffer";

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const rings = new Map<number, SharedArrayBuffer>();
const posted: Array<{ type: string; payload?: { id?: number } }> = [];
const system = System.getInstance();
const savedSystem = { fileSystem: system.fileSystem };

beforeAll(() => {
    savedGlobals.set("self", Object.getOwnPropertyDescriptor(globalThis, "self"));
    Object.defineProperty(globalThis, "self", {
        configurable: true, writable: true,
        value: {
            postMessage(msg: { type: string; payload?: { id?: number; sab?: SharedArrayBuffer } }) {
                posted.push(msg);
                if (msg.type === "audio_register") rings.set(msg.payload!.id!, msg.payload!.sab!);
                if (msg.type === "audio_unregister") rings.delete(msg.payload!.id!);
            },
        },
    });
});

afterAll(() => {
    resetMssRingBuffers();
    resetRawSampleCache();
    for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

beforeEach(() => { resetMssRingBuffers(); resetRawSampleCache(); rings.clear(); posted.length = 0; });
afterEach(() => Object.assign(system, savedSystem));

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};
const throughCodec = <T>(v: T): T => {
    const e = encodeValue(v as unknown as SaveValue);
    return decodeValue(e) as unknown as T;
};

const IMAGE_AT = 0x2000;
const IMAGE_LEN = 400;

function context(memory = new Uint8Array(0x10000)): MSSContext & { memory: Uint8Array } {
    const ctx = createMSSContext({ getCurrentMemory: () => memory } as never) as MSSContext & { memory: Uint8Array };
    ctx.memory = memory;
    return ctx;
}

function sample(ctx: MSSContext, id: number, over: Partial<MSSSample> = {}): MSSSample {
    const s: MSSSample = {
        id, handle: 0x400 + id * 0x284, fileData: null, decodedData: null, sampleRate: 22050, channels: 1, bitsPerSample: 16,
        formatTag: 1, blockAlign: 2, volume: 127, pan: 64, playbackRate: 1.0, playbackRateHz: 22050, loopCount: 1,
        isPlaying: false, isStopped: false, position: 0, pendingStart: false, fileDataAllocated: false, ...over,
    };
    ctx.samples.set(s.handle, s);
    ctx.samplesById.set(s.id, s);
    return s;
}

function rawSample(ctx: MSSContext & { memory: Uint8Array }, id: number): MSSSample {
    for (let i = 0; i < IMAGE_LEN; i++) ctx.memory[IMAGE_AT + i] = (i * 7) & 0xff;
    const s = sample(ctx, id, { bitsPerSample: 8, blockAlign: 1, sampleTypeFormat: 0, sampleTypeFlags: 0, fileDataAddress: IMAGE_AT });
    decodeRawSampleData(s, ctx.memory, IMAGE_AT, IMAGE_LEN);
    return s;
}

function stream(ctx: MSSContext, id: number, over: Partial<MSSStream> = {}): MSSStream {
    const s: MSSStream = {
        id, handle: 0x6000 + (id & 0xff) * 0x200, fileData: null, decodedData: null, filename: null, sampleRate: 22050, channels: 2,
        bitsPerSample: 16, formatTag: 1, blockAlign: 4, streamMemory: 0, volume: 127, pan: 64, playbackRate: 1.0, loopCount: 1,
        isPlaying: false, isPaused: false, position: 0, pendingStart: false, ...over,
    };
    ctx.streams.set(s.handle, s);
    ctx.streamsById.set(s.id, s);
    return s;
}

const WAV_INFO = { formatTag: 1, channels: 2, sampleRate: 22050, bitsPerSample: 16, blockAlign: 4, dataChunkOffset: 44, dataChunkSize: 40000 };

function incremental(ctx: MSSContext, id: number, over: Partial<MSSStream> = {}): { s: MSSStream; src: MSSStreamSource } {
    const src: MSSStreamSource = {
        kind: "vfs", fileHandle: 0, scratch: 0, vfsHandle: { kind: "file", path: "C:\\music\\track9.wav", position: 0, access: 0, source: "rom" },
        fileSize: 40044, info: { ...WAV_INFO }, blockBytes: 4, framesPerBlock: 1, dataStart: 44, dataEnd: 40044, totalFrames: 10000,
        readOffset: 44, cursor: 44, framesDecoded: 0, busy: false, exhausted: false, endReported: false, pending: null,
    };
    const s = stream(ctx, id, { filename: "..\\music\\track9.wav", fileFormat: "wav", pcmBytes: 40000, source: src, ...over });
    ensureStreamingRing(s, 2048 * 8);
    return { s, src };
}

function wavFile(frames: number): Uint8Array {
    const data = frames * 4;
    const out = new Uint8Array(44 + data);
    const v = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0); v.setUint32(4, 36 + data, true);
    out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 22050, true); v.setUint32(28, 88200, true);
    v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    out.set([0x64, 0x61, 0x74, 0x61], 36); v.setUint32(40, data, true);
    for (let i = 0; i < frames * 2; i++) v.setInt16(44 + i * 2, ((i * 37) % 2000) - 1000, true);
    return out;
}

function fileSystem(files: Record<string, Uint8Array>) {
    const opened: string[] = [];
    const fs = {
        opened,
        openSync: (path: string) => (path in files ? (opened.push(path), { kind: "file", path, position: 0, access: 0, source: "rom" }) : null),
        open: async (path: string) => fs.openSync(path),
        getFileSize: (path: string) => files[path]?.length ?? 0,
        setPosition: (h: { position: number }, at: number) => { h.position = at; },
        readSync: (h: { path: string; position: number }, n: number) => files[h.path]!.slice(h.position, h.position + n),
        read: async (h: { path: string; position: number }, n: number) => fs.readSync(h, n),
    };
    Object.assign(system, { fileSystem: fs });
    return fs;
}

function populated(): MSSContext & { memory: Uint8Array } {
    const ctx = context();
    Object.assign(ctx, {
        nextSampleId: 9, nextStreamId: 0x10005, nextWaveOutId: 3, nextFileHandleId: 0x50000010, nextTimerId: 4, nextRedbookId: 0x52420003,
        nextSequenceId: 2, initialized: true, digitalDriverHandle: 0, directSoundHwnd: 0x10010, driverDummyBuffer: 0x7100,
        driverWaveFormat: 0x7200, driverNoopStub: 0x7300, driverNoopTable: 0x7400, driverSampleArray: 0x400, driverMaxSamples: 24,
        driverOutputRate: 22050, driverTypeTag: 0x7500, sampleTypeTag: 0x7510, driverBuildBuffer: 0x7600, driverDecodeBuffer: 0x7700,
        driverAuxBuffer1: 0x7800, driverAuxBuffer2: 0x7900, driverAuxBuffer3: 0x7a00, speakerType3D: 2, roomType3D: 5,
        midiDriverHandle: 0x7b00, midiMasterVolume: 90, lastErrorPtr: 0x7c00, lastErrorStr: "Out of handles", distanceFactor3D: 0.5,
        updateInterval: 7, fileCallbacks: { open: 0x401000, close: 0x401010, seek: 0x401020, read: 0x401030 },
        memCallbacks: { malloc: 0x402000, free: 0x402010 }, provider3DNamePtrs: [0x7d00, 0x7d40],
    });
    ctx.preferences[1] = 24;
    ctx.listener3D = {
        handle: 0xDEAD3D11, posX: 1, posY: 2, posZ: 3, velX: 0, velY: 0, velZ: 0, frontX: 0, frontY: 0, frontZ: 1,
        topX: 0, topY: 1, topZ: 0, distanceFactor: 1, rolloffFactor: 2, dopplerFactor: 1,
    };
    rawSample(ctx, 1);
    sample(ctx, 2, { userData: [1, 2, 3], loopCount: 0, loopStartBytes: 16, loopEndBytes: -1, is3D: true, pos3D: { x: 1, y: 2, z: 3 }, minDist3D: 5 });
    stream(ctx, 0x10001, { streamMemory: 0x5000, streamDummyBuffer: 0x5200 });
    ctx.timers.set(1, { handle: 1, callback: 0x403000, user: 0x1234, freq: 100, period: 0, active: true, timerId: 11 });
    ctx.timers.set(2, { handle: 2, callback: 0x403100, user: 0, freq: 0, period: 20, active: false });
    ctx.sequences.set(0x8000, { handle: 0x8000, status: 4, volume: 100, loopCount: 0, tempo: 400000 });
    ctx.redbookHandles.set(0x52420001, { id: 0x52420001, volume: 80, playToken: 0 });
    ctx.waveOuts.set(1, { handle: 1, deviceId: 0xffffffff, preparedHeaders: new Map([[0x9000, { ptr: 0x9100, len: 512, flags: 2 }]]) });
    ctx.ribProviders.set(0x1000, { module: 0x10000000, interfaces: new Map([["ASI codec", { entryCount: 2, entries: [0x10001000, 0x10001010] }]]) });
    ctx.memAllocatedByMss.add(0xa000);
    ctx.wavFormatByDataPtr.set(0xb000, 17);
    ctx.streamUserData.set(0x6200, [0, 7]);
    ctx.streamCallbacks.set(0x6200, 0x404000);
    ctx.sequenceUserData.set(0x8000, [9]);
    ctx.sequenceCallbacks.set(0x8000, 0x405000);
    return ctx;
}

describe("mss32 participant", () => {
    test("every context field has a policy", () => {
        expect(Object.keys(createMSSContext({} as never)).sort()).toEqual(Object.keys(MSS_CONTEXT_FIELDS).sort());
    });

    test("a populated context comes back byte for byte in a fresh context", async () => {
        const first = captureMssSavestate(populated());
        const fresh = context(populated().memory);
        fresh.pendingEOSCallbacks.push({ callback: 1, handle: 2, user: 3 });
        fresh.insideAilServe = true;
        await restoreMssSavestate(fresh, throughCodec(first));
        expect(bytes(captureMssSavestate(fresh))).toBe(bytes(first));
        expect(fresh.samplesById.get(1)).toBe(fresh.samples.get(0x400 + 0x284)!);
        expect(fresh.streamsById.get(0x10001)).toBe([...fresh.streams.values()][0]);
        expect(fresh.listenerSab).not.toBeNull();
        expect(posted.some(m => m.type === "audio_listener_sab")).toBe(true);
    });

    test("every saved scalar reaches the capture and survives a restore", async () => {
        const base = captureMssSavestate(populated());
        for (const key of Object.keys(base.scalars) as Array<keyof MssState["scalars"]>) {
            const was = base.scalars[key];
            const value = typeof was === "boolean" ? !was : typeof was === "string" ? was + "!" : (was as number) + 3;
            const fresh = context(populated().memory);
            await restoreMssSavestate(fresh, { ...base, scalars: { ...base.scalars, [key]: value } });
            expect({ key, value: captureMssSavestate(fresh).scalars[key] }).toEqual({ key, value });
            expect({ key, live: fresh[key] }).toEqual({ key, live: value });
        }
    });

    test("every saved sample, stream and timer field survives a restore", async () => {
        const ctx = context();
        const s = sample(ctx, 3);
        const st = stream(ctx, 0x10002);
        ctx.timers.set(5, { handle: 5, callback: 0x403000, user: 1, freq: 50, period: 0, active: false });
        const base = captureMssSavestate(ctx);
        const sampleValues: Partial<MSSSample> = {
            id: 4, handle: 0x1234, streamBuffers: [{ ptr: 0x3000, size: 4096, inUse: false }], userData: [5, 6], totalBytes: 99,
            fileFormat: "wav", sampleTypeFormat: 3, sampleTypeFlags: 1, sampleRate: 11025, channels: 2, bitsPerSample: 8, formatTag: 17,
            blockAlign: 4, volume: 60, pan: 20, playbackRate: 1.5, playbackRateHz: 33075, loopCount: 4, loopStartBytes: 8, loopEndBytes: 64,
            pcmBytes: 4000, isPlaying: true, isStopped: true, position: 256, pendingStart: true, fileDataAllocated: true, fileDataAddress: 0x3000,
            encodedDurationMs: 1234, is3D: true, pos3D: { x: 1, y: 2, z: 3 }, vel3D: { x: 4, y: 5, z: 6 }, minDist3D: 2, maxDist3D: 80,
            mode3D: 1, cone3D: { inner: 30, outer: 90, oriX: 0, oriY: 0, oriZ: 1, outVolCb: -600 },
        };
        const saved = (policy: Record<string, string>) => Object.keys(policy).filter(k => policy[k] === "save").sort();
        expect(Object.keys(sampleValues).sort()).toEqual(saved(MSS_SAMPLE_FIELDS));
        for (const [field, value] of Object.entries(sampleValues)) {
            expect({ field, same: bytes(value) === bytes((s as unknown as Record<string, unknown>)[field] ?? null) }).toEqual({ field, same: false });
            const fresh = context();
            await restoreMssSavestate(fresh, { ...base, samples: [{ ...base.samples[0], fields: { ...base.samples[0].fields, [field]: value } }] });
            const live = [...fresh.samples.values()][0] as unknown as Record<string, unknown>;
            expect({ field, live: live[field] }).toEqual({ field, live: value });
            expect({ field, saved: (captureMssSavestate(fresh).samples[0].fields as Record<string, unknown>)[field] }).toEqual({ field, saved: value });
        }
        const streamValues: Partial<MSSStream> = {
            id: 0x10009, handle: 0x6a00, filename: "intro.wav", fileFormat: "wav", sampleRate: 44100, channels: 1, bitsPerSample: 8,
            formatTag: 2, blockAlign: 2, streamMemory: 0x5000, volume: 50, pan: 10, playbackRate: 0.5, playbackRateHz: 11025, loopCount: 0,
            pcmBytes: 8000, streamDummyBuffer: 0x5200, isPlaying: true, isPaused: true, position: 512, pendingStart: true, encodedDurationMs: 900,
        };
        expect(Object.keys(streamValues).sort()).toEqual(saved(MSS_STREAM_FIELDS));
        for (const [field, value] of Object.entries(streamValues)) {
            expect({ field, same: value === (st as unknown as Record<string, unknown>)[field] }).toEqual({ field, same: false });
            const fresh = context();
            await restoreMssSavestate(fresh, { ...base, streams: [{ ...base.streams[0], fields: { ...base.streams[0].fields, [field]: value } }] });
            const live = [...fresh.streams.values()][0] as unknown as Record<string, unknown>;
            expect({ field, live: live[field] }).toEqual({ field, live: value });
        }
        const timerValues = { handle: 6, callback: 0x403333, user: 9, freq: 60, period: 16, active: true, timerId: 21 };
        expect(Object.keys(timerValues).sort()).toEqual(saved(MSS_TIMER_FIELDS));
        for (const [field, value] of Object.entries(timerValues)) {
            const fresh = context();
            await restoreMssSavestate(fresh, { ...base, timers: [{ ...base.timers[0], [field]: value }] });
            const live = [...fresh.timers.values()][0] as unknown as Record<string, unknown>;
            expect({ field, live: live[field] }).toEqual({ field, live: value });
        }
    });

    test("a sound image still in guest memory is saved as its address; a changed one as its bytes", async () => {
        const ctx = populated();
        const unchanged = captureMssSavestate(ctx).samples[0];
        expect(unchanged.image).toEqual({ at: IMAGE_AT, length: IMAGE_LEN });
        expect(unchanged.decode).toBe("raw");
        expect(unchanged.decoded).toBeNull();

        const original = ctx.memory.slice(IMAGE_AT, IMAGE_AT + IMAGE_LEN);
        ctx.memory[IMAGE_AT + 5] ^= 0xff;
        const changed = captureMssSavestate(ctx);
        expect(changed.samples[0].image).toEqual({ bytes: original });
        const fresh = context(ctx.memory);
        await restoreMssSavestate(fresh, throughCodec(changed));
        expect([...fresh.samplesById.get(1)!.fileData!]).toEqual([...original]);
        expect([...fresh.samplesById.get(1)!.decodedData!]).toEqual([...ctx.samplesById.get(1)!.decodedData!]);
    });

    test("decoded data is derived when a decoder reproduces it and saved when none does", async () => {
        const ctx = context();
        const pcm = new Uint8Array(64).map((_, i) => i * 3);
        const viaInfo = sample(ctx, 1, { fileData: pcm, fileFormat: "wav", decodedData: convertToFloat(pcm, 1, 16, 1, 2) });
        const odd = sample(ctx, 2, { fileData: pcm, fileFormat: "wav", decodedData: new Float32Array([0.5, -0.25, 0.125]) });
        const state = captureMssSavestate(ctx);
        expect(state.samples.map(s => s.decode)).toEqual(["pcm", "saved"]);
        expect(state.samples[0].decoded).toBeNull();
        const fresh = context();
        await restoreMssSavestate(fresh, throughCodec(state));
        expect([...fresh.samplesById.get(1)!.decodedData!]).toEqual([...viaInfo.decodedData!]);
        expect([...fresh.samplesById.get(2)!.decodedData!]).toEqual([...odd.decodedData!]);
    });

    test("a playing sample gets its ring back at the saved frame; a stopped one gets it stopped at the start", async () => {
        const ctx = populated();
        const playing = ctx.samplesById.get(1)!;
        playSample(ctx, playing);
        const align = getCtrl(rings.get(1)!, CTRL_BLOCK_ALIGN);
        setCtrl(rings.get(1)!, CTRL_PLAY_CURSOR, 123 * align);
        const stopped = rawSample(ctx, 5);
        playSample(ctx, stopped);
        stopRingBuffer(5);
        stopped.isPlaying = false;
        stopped.isStopped = true;
        const state = captureMssSavestate(ctx);
        expect(state.samples.find(s => s.fields.id === 1)!.playFrame).toBe(123);

        const fresh = context(ctx.memory);
        await restoreMssSavestate(fresh, throughCodec(state));
        const ring = rings.get(1)!;
        expect(getCtrl(ring, CTRL_PLAY_CURSOR)).toBe(123 * align);
        expect(getCtrl(ring, CTRL_RESERVED)).toBe(1);
        expect(getCtrl(ring, CTRL_STATE)).toBe(STATE_PLAYING);
        expect(getCtrl(ring, CTRL_FREQUENCY)).toBe(22050);
        const decoded = fresh.samplesById.get(1)!.decodedData!;
        expect(getCtrl(ring, CTRL_DATA_LENGTH)).toBe(decoded.byteLength);
        expect([...new Float32Array(ring.slice(CTRL_BLOCK_BYTES, CTRL_BLOCK_BYTES + decoded.byteLength))]).toEqual([...decoded]);
        expect(fresh.samplesById.get(1)!.startTime).toBeDefined();
        expect(getCtrl(rings.get(5)!, CTRL_STATE)).toBe(STATE_STOPPED);
        expect(getCtrl(rings.get(5)!, CTRL_PLAY_CURSOR)).toBe(0);
        expect(rings.has(2)).toBe(false);
    });

    test("a one-shot voice the worklet already finished is restored stopped and still playing, so the heartbeat ends it once", async () => {
        const ctx = populated();
        const voice = ctx.samplesById.get(1)!;
        playSample(ctx, voice);
        setCtrl(rings.get(1)!, CTRL_STATE, STATE_STOPPED);
        setCtrl(rings.get(1)!, CTRL_PLAY_CURSOR, 0);
        const state = captureMssSavestate(ctx);
        const saved = state.samples.find(s => s.fields.id === 1)!;
        expect(saved.ended).toBe(true);
        expect(saved.playFrame).toBe(0);
        expect(saved.fields.isPlaying).toBe(true);

        const fresh = context(ctx.memory);
        await restoreMssSavestate(fresh, throughCodec(state));
        expect(getCtrl(rings.get(1)!, CTRL_STATE)).toBe(STATE_STOPPED);
        expect(getCtrl(rings.get(1)!, CTRL_PLAY_CURSOR)).toBe(0);
        expect(fresh.samplesById.get(1)!.isPlaying).toBe(true);
        expect(captureMssSavestate(fresh).samples.find(s => s.fields.id === 1)!.ended).toBe(true);
    });

    test("an incremental stream reopens its file and continues from the position that was audible", async () => {
        const ctx = context();
        const { s, src } = incremental(ctx, 0x10001, { loopCount: 0 });
        startStreamingRing(ctx, s);
        const fed = appendStreamingRing(s, new Float32Array(1500 * 2).fill(0.25));
        src.framesDecoded = 20000 + fed / 2;
        src.readOffset = 44 + 1500 * 4;
        setCtrl(rings.get(s.id)!, CTRL_PLAY_CURSOR, 1000 * 8);
        const audible = incrementalStreamPosition(s);
        expect(audible).toBe(1000 * 4);
        const state = captureMssSavestate(ctx);
        expect(state.streams[0].fields.position).toBe(audible);
        expect(state.streams[0].source).toMatchObject({ kind: "vfs", fileSize: 40044, totalFrames: 10000, endReported: false });

        const fs = fileSystem({ "..\\music\\track9.wav": new Uint8Array(40044) });
        const fresh = context();
        await restoreMssSavestate(fresh, throughCodec(state));
        const back = fresh.streamsById.get(s.id)!;
        expect(fs.opened).toEqual(["..\\music\\track9.wav"]);
        expect(back.source).toMatchObject({ readOffset: 44 + 1000 * 4, framesDecoded: 1000, cursor: -1, busy: false, exhausted: false, pending: null });
        expect(back.source!.vfsHandle!.path).toBe("..\\music\\track9.wav");
        const ring = rings.get(s.id)!;
        expect(getCtrl(ring, CTRL_STATE)).toBe(STATE_PLAYING);
        expect(getCtrl(ring, CTRL_WRITE_CURSOR)).toBe(0);
        expect(incrementalStreamPosition(back)).toBe(audible);
        expect(bytes(captureMssSavestate(fresh).streams)).toBe(bytes(state.streams));
    });

    test("a looping stream whose reader already passed the end does not report that end twice", () => {
        const ctx = context();
        const { s, src } = incremental(ctx, 0x10001, { loopCount: 0 });
        startStreamingRing(ctx, s);
        const fed = appendStreamingRing(s, new Float32Array(1500 * 2).fill(0.25));
        src.framesDecoded = 9000 + fed / 2;
        expect(captureMssSavestate(ctx).streams[0].source!.endReported).toBe(true);
        s.loopCount = 1;
        expect(captureMssSavestate(ctx).streams[0].source!.endReported).toBe(false);
    });

    test("a paused incremental stream gets a stopped ring; a changed or missing file fails the restore", async () => {
        const ctx = context();
        const { s } = incremental(ctx, 0x10001);
        s.isPlaying = true;
        s.isPaused = true;
        const state = captureMssSavestate(ctx);
        fileSystem({ "..\\music\\track9.wav": new Uint8Array(40044) });
        await restoreMssSavestate(context(), state);
        expect(getCtrl(rings.get(s.id)!, CTRL_STATE)).toBe(STATE_STOPPED);

        fileSystem({ "..\\music\\track9.wav": new Uint8Array(40000) });
        await expect(restoreMssSavestate(context(), state)).rejects.toThrow('mss32: stream file "..\\music\\track9.wav" is 40000 bytes, the snapshot expects 40044');
        fileSystem({});
        await expect(restoreMssSavestate(context(), state)).rejects.toThrow('mss32: stream file "..\\music\\track9.wav" cannot be opened again');
    });

    test("a whole-file stream is read and decoded again and plays on from the saved frame", async () => {
        const file = wavFile(600);
        const ctx = context();
        const s = stream(ctx, 0x10003, {
            filename: "speech.wav", fileData: file, fileFormat: "wav", pcmBytes: 2400, isPlaying: true, position: 400,
            volume: 70, decodedData: new Float32Array(1200),
        });
        const state = captureMssSavestate(ctx);
        state.streams[0].playFrame = 100;
        expect(state.streams[0].loaded).toBe(true);

        const fs = fileSystem({ "speech.wav": file });
        const fresh = context();
        await restoreMssSavestate(fresh, throughCodec(state));
        const back = fresh.streamsById.get(s.id)!;
        expect(fs.opened).toEqual(["speech.wav"]);
        expect(back.fileData!.length).toBe(file.length);
        expect(back.decodedData!.length).toBe(1200);
        expect(back).toMatchObject({ isPlaying: true, position: 400, volume: 70, pendingStart: false });
        const ring = rings.get(s.id)!;
        expect(getCtrl(ring, CTRL_PLAY_CURSOR)).toBe(100 * getCtrl(ring, CTRL_BLOCK_ALIGN));
        expect(getCtrl(ring, CTRL_STATE)).toBe(STATE_PLAYING);
    });

    test("a restored timer coalesces through a pump callback of its own; an idle one has none", async () => {
        const state = captureMssSavestate(populated());
        const fresh = context(populated().memory);
        await restoreMssSavestate(fresh, state);
        const running = fresh.timers.get(1)!;
        expect(running.inFlight).toBe(false);
        running.inFlight = true;
        running.pumpOnReturn!();
        expect(running.inFlight).toBe(false);
        expect(fresh.timers.get(2)!.pumpOnReturn).toBeUndefined();
        expect(fresh.updateInterval).toBe(7);
    });

    test("the Miles clock keeps its age across a restore", async () => {
        const ctx = context();
        ctx.startupTime = performance.now() - 5000;
        const state = captureMssSavestate(ctx);
        expect(state.startupAgeMs).toBeGreaterThanOrEqual(5000);
        const fresh = context();
        await restoreMssSavestate(fresh, { ...state, startupAgeMs: 5000 });
        expect(Math.abs(performance.now() - fresh.startupTime - 5000)).toBeLessThan(200);
        await restoreMssSavestate(fresh, { ...state, startupAgeMs: -1 });
        expect(fresh.startupTime).toBe(0);
    });

    test("refuses, by name, what a v1 snapshot does not hold", () => {
        const refusal = (prepare: (ctx: MSSContext & { memory: Uint8Array }) => void): string => {
            resetMssRingBuffers();
            const ctx = populated();
            prepare(ctx);
            try { captureMssSavestate(ctx); } catch (e) { return (e as Error).message; }
            return "";
        };
        expect(refusal(() => {})).toBe("");
        expect(refusal(c => { c.insideAilServe = true; })).toBe("mss32: AIL_serve is running; try saving again");
        expect(refusal(c => { c.pendingEOSCallbacks.push({ callback: 1, handle: 2, user: 3 }); c.pendingTimerCallbacks.push({ callback: 1, user: 2 }); }))
            .toBe("mss32: 2 Miles callback(s) are queued for AIL_serve; try saving again");
        expect(refusal(c => { c.fileHandles.set(0x50000000, { kind: "file", path: "C:\\data\\sfx.raw", position: 0, access: 0, source: "rom" }); }))
            .toBe("mss32: 1 file(s) open through AIL_file_open are not part of a v1 savestate: C:\\data\\sfx.raw");
        expect(refusal(c => { c.timers.get(1)!.inFlight = true; })).toBe("mss32: the callback of Miles timer 1 is queued or running; try saving again");
        expect(refusal(c => { Object.assign(c.samplesById.get(2)!, { isPlaying: true, fileFormat: "mp3", fileData: new Uint8Array(8) }); }))
            .toBe("mss32: sample 2 plays mp3 data through the host decoder, which is not part of a v1 savestate");
        expect(refusal(c => {
            const s = c.samplesById.get(1)!;
            playSample(c, s);
            appendDecodedChunk(c, s, new Float32Array(0));
            setCtrl(rings.get(1)!, CTRL_DATA_LENGTH, s.decodedData!.byteLength - 4);
        })).toBe("mss32: sample 1 is fed through AIL_load_sample_buffer, which is not part of a v1 savestate");
        expect(refusal(c => { incremental(c, 0x10004).src.busy = true; })).toBe('mss32: stream "..\\music\\track9.wav" is being refilled; try saving again');
        expect(refusal(c => { stream(c, 0x10005, { filename: "song.ogg", fileFormat: "ogg", fileData: new Uint8Array(8), isPlaying: true }); }))
            .toBe('mss32: stream "song.ogg" plays ogg data through the host decoder, which is not part of a v1 savestate');
        expect(refusal(c => { stream(c, 0x10006, { filename: "a.wav", fileFormat: "wav", fileData: new Uint8Array(8) }); }))
            .toBe('mss32: stream "a.wav" was read whole through the title\'s own file callbacks, which is not part of a v1 savestate');
    });

    test("registers as the participant that covers mss32 and wraps refusals", () => {
        const ctx = populated();
        const remove = registerMssSavestate(ctx);
        try {
            const p = savestateParticipants.all().find(x => x.id === "mss32")!;
            expect(p.covers).toEqual(["mss32"]);
            expect(savestateParticipants.coveredModules().has("mss32")).toBe(true);
            expect(savestateParticipants.schemas().mss32).toEqual({ version: 1, schemaHash: "567f198e080fc09e" });
            ctx.insideAilServe = true;
            expect(() => p.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            remove();
        }
        expect(savestateParticipants.all().some(x => x.id === "mss32")).toBe(false);
    });
});
