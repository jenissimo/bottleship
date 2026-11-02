import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    createAudioRingBuffer, setCtrl, getCtrl, writeRingData,
    CTRL_STATE, CTRL_LOOP_MODE, CTRL_PLAY_CURSOR, CTRL_WRITE_CURSOR, CTRL_DATA_LENGTH, STATE_PLAYING,
    CTRL_BLOCK_BYTES, CTRL_LOOP_START_FRAME, CTRL_LOOP_END_FRAME, CTRL_SLOTS,
} from "../../src/audio/audio-ring-buffer";
import {
    ensureStreamingRing, appendStreamingRing, startStreamingRing,
    incrementalStreamFinished, incrementalStreamPosition, finishIncrementalStream, resetMssRingBuffers,
    playStream,
} from "../../src/worker/modules/mss32/playback-engine";
import type { MSSStream, MSSStreamSource } from "../../src/worker/modules/mss32/types";
import type { MSSContext } from "../../src/worker/modules/mss32/context";

let Processor: any;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(key: string, value: unknown): void {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

beforeAll(async () => {
    installGlobal("AudioWorkletProcessor", class {
        port = { postMessage(_msg: unknown) {}, onmessage: null as any };
    });
    installGlobal("registerProcessor", (name: string, ctor: unknown) => {
        if (name === "bottleship-audio") Processor = ctor;
    });
    installGlobal("sampleRate", 48000);
    installGlobal("currentTime", 0);
    installGlobal("self", { postMessage(_msg: unknown) {} });
    await import("../../src/audio/bottleship-audio-worklet");
});

afterAll(() => {
    resetMssRingBuffers();
    for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function quantum(processor: any): Float32Array[] {
    const channels = [new Float32Array(128), new Float32Array(128)];
    processor.process([], [channels], {});
    return channels;
}

function streamFixture(rate = 44100, loopCount = 1) {
    const memory = new Uint8Array(4096);
    const ctx = {
        process: { getCurrentMemory: () => memory }, digitalDriverHandle: 0,
    } as unknown as MSSContext;
    const source = {
        framesDecoded: 0, totalFrames: 1017, exhausted: false, pending: null,
    } as MSSStreamSource;
    const stream = {
        id: 123, handle: 64, channels: 2, sampleRate: rate, playbackRate: 1, bitsPerSample: 16,
        volume: 127, pan: 64, loopCount, position: 0, source,
    } as MSSStream;
    const processor = new Processor();
    const sab = ensureStreamingRing(stream, 512 * 8);
    processor.port.onmessage({ data: { type: "register", id: stream.id, sab } });
    return { ctx, source, stream, processor, sab, memory };
}

describe("Miles streaming ring consumption", () => {
    for (const rate of [32000, 44100, 48000, 96000]) {
        test(`one-shot source drains through ring wraps at ${rate} Hz and reaches DONE`, () => {
            const t = streamFixture(rate);
            const pcm = new Float32Array(t.source.totalFrames * 2).fill(0.25);
            let at = 0;
            let heard = 0;
            startStreamingRing(t.ctx, t.stream);
            for (let block = 0; block < 100; block++) {
                const accepted = appendStreamingRing(t.stream, pcm, at);
                at += accepted;
                t.source.framesDecoded += accepted / 2;
                t.source.exhausted = at === pcm.length;
                const out = quantum(t.processor);
                heard += out[0].filter(value => value > 0.1).length;
                if (incrementalStreamFinished(t.stream)) break;
            }
            expect(at).toBe(pcm.length);
            expect(heard).toBeGreaterThan(0);
            expect(incrementalStreamFinished(t.stream)).toBe(true);
            expect(incrementalStreamPosition(t.stream)).toBe(t.source.totalFrames * 4);
            finishIncrementalStream(t.ctx, t.stream);
            expect(t.stream.isPlaying).toBe(false);
            expect(new DataView(t.memory.buffer).getUint32(t.stream.handle, true)).toBe(2);
            for (let i = 0; i < 10; i++) {
                expect(quantum(t.processor)[0].every(value => value === 0)).toBe(true);
            }
        });
    }

    test("a looping source waits for its producer and resumes when more PCM arrives", () => {
        const t = streamFixture(48000, 0);
        const pcm = new Float32Array(64 * 2).fill(0.25);
        t.source.framesDecoded += appendStreamingRing(t.stream, pcm) / 2;
        startStreamingRing(t.ctx, t.stream);
        quantum(t.processor);
        for (let i = 0; i < 10; i++) quantum(t.processor);
        const play = getCtrl(t.sab, CTRL_PLAY_CURSOR);
        expect(play).toBe(getCtrl(t.sab, CTRL_WRITE_CURSOR));
        expect(incrementalStreamFinished(t.stream)).toBe(false);
        expect(quantum(t.processor)[0].every(value => value === 0)).toBe(true);
        expect(getCtrl(t.sab, CTRL_PLAY_CURSOR)).toBe(play);
        t.source.framesDecoded += appendStreamingRing(t.stream, pcm) / 2;
        expect(quantum(t.processor)[0].some(value => value > 0.1)).toBe(true);
    });

    test("a looping DirectSound-style buffer keeps replaying without producer writes", () => {
        const processor = new Processor();
        const sab = createAudioRingBuffer(
            64 * 4, { channels: 1, sampleRate: 48000, bitsPerSample: 32 }, true,
        );
        writeRingData(sab, 0, new Uint8Array(new Float32Array(64).fill(0.25).buffer), 64 * 4);
        setCtrl(sab, CTRL_DATA_LENGTH, 64 * 4);
        setCtrl(sab, CTRL_LOOP_MODE, -1);
        setCtrl(sab, CTRL_STATE, STATE_PLAYING);
        processor.port.onmessage({ data: { type: "register", id: 456, sab } });
        for (let i = 0; i < 10; i++) {
            expect(quantum(processor)[0].every(value => value > 0.1)).toBe(true);
        }
    });
});

// The worklet module is cached per test run and registers its processor once, so the
// loop-block cases live beside the import that captures it.
const FRAMES = 100;
const BLOCK = 128;

function makeVoice(loopMode: number, loopStart: number, loopEnd: number) {
    const proc = new Processor();
    const ended: number[] = [];
    proc.port.postMessage = (m: any) => { if (m?.type === "ended") ended.push(m.id); };
    const sab = createAudioRingBuffer(FRAMES * 4, { channels: 1, sampleRate: 48000, bitsPerSample: 32 }, false);
    new Float32Array(sab, CTRL_BLOCK_BYTES, FRAMES).fill(0.5);
    const ctrl = new Int32Array(sab, 0, CTRL_SLOTS);
    ctrl[CTRL_DATA_LENGTH] = FRAMES * 4;
    ctrl[CTRL_LOOP_MODE] = loopMode;
    ctrl[CTRL_LOOP_START_FRAME] = loopStart;
    ctrl[CTRL_LOOP_END_FRAME] = loopEnd;
    ctrl[CTRL_STATE] = STATE_PLAYING;
    proc.port.onmessage({ data: { type: "register", id: 7, sab } });
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const step = () => proc.process([], [out]);
    return { proc, ctrl, ended, step, position: () => proc.ringBuffers.get(7).position as number };
}

describe("audio worklet loop block", () => {
    test("an infinite loop replays only the block after the first pass", () => {
        const v = makeVoice(-1, 40, 80);
        for (let i = 0; i < 50; i++) {
            v.step();
            expect(v.position()).toBeGreaterThanOrEqual(40);
            expect(v.position()).toBeLessThanOrEqual(80);
        }
        expect(v.ended).toEqual([]);
    });

    test("a loop block ending at the data end wraps to the block start", () => {
        const v = makeVoice(-1, 40, 0);
        for (let i = 0; i < 50; i++) {
            v.step();
            expect(v.position()).toBeGreaterThanOrEqual(40);
            expect(v.position()).toBeLessThanOrEqual(FRAMES);
        }
    });

    test("a counted loop plays the block N-1 more times, then to the end", () => {
        // 80 to the block end, 2 more passes of 40, then 20 to the data end = 180 frames.
        const v = makeVoice(3, 40, 80);
        v.step();
        expect(v.ended).toEqual([]);
        v.step();
        expect(v.ended).toEqual([7]);
        expect(v.ctrl[CTRL_STATE]).toBe(0);
    });

    test("no loop block keeps whole-buffer looping", () => {
        const v = makeVoice(-1, 0, 0);
        v.step();
        expect(v.position()).toBe(BLOCK - FRAMES);
    });
});

describe("Miles stream start position", () => {
    function capturePosts(run: () => void): any[] {
        const posted: any[] = [];
        const host = (globalThis as any).self;
        const saved = host.postMessage;
        host.postMessage = (msg: unknown) => { posted.push(msg); };
        try { run(); } finally { host.postMessage = saved; }
        return posted;
    }

    function encodedStream(position: number): { ctx: MSSContext; stream: MSSStream } {
        const memory = new Uint8Array(4096);
        const ctx = {
            process: { getCurrentMemory: () => memory }, digitalDriverHandle: 0,
        } as unknown as MSSContext;
        const stream = {
            id: 9, handle: 64, channels: 2, sampleRate: 44100, playbackRate: 1, bitsPerSample: 16,
            blockAlign: 4, volume: 127, pan: 64, loopCount: 1, position, fileFormat: "mp3",
            fileData: new Uint8Array(16), decodedData: null, encodedDurationMs: 200_000,
            isPlaying: false, isPaused: false, pendingStart: false,
        } as unknown as MSSStream;
        return { ctx, stream };
    }

    test("a stream seeked before its first start begins there", () => {
        const { ctx, stream } = encodedStream(44100 * 4 * 30);
        const posted = capturePosts(() => playStream(ctx, stream));
        const play = posted.find(m => m.type === "audio_play_encoded");
        expect(play.payload.startOffsetMs).toBeCloseTo(30_000, 3);
        expect(play.payload.loopRestartMs).toBe(0);
        expect(stream.position).toBe(44100 * 4 * 30);
    });

    test("a seeked stream retains its media offset at twice normal speed", () => {
        const { ctx, stream } = encodedStream(44100 * 4 * 30);
        stream.playbackRate = 2;
        const posted = capturePosts(() => playStream(ctx, stream));
        expect(posted.find(m => m.type === "audio_play_encoded").payload.startOffsetMs).toBeCloseTo(30_000, 3);
    });

    test("an unseeked stream begins at the top", () => {
        const { ctx, stream } = encodedStream(0);
        const posted = capturePosts(() => playStream(ctx, stream));
        const play = posted.find(m => m.type === "audio_play_encoded");
        expect(play.payload.startOffsetMs).toBe(0);
    });
});
