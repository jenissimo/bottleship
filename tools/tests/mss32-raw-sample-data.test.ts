/**
 * AIL_set_sample_address points a voice at a sound image. RIFF/MP3/OGG images name their own
 * format; anything else is raw PCM in the format AIL_set_sample_type declared (8/16-bit,
 * mono/stereo) at the voice's rate, and a later AIL_set_sample_type re-interprets it.
 */
import { describe, expect, test } from "bun:test";
import { createSampleExports } from "../../src/worker/modules/mss32/sample";
import { createSampleBufferExports } from "../../src/worker/modules/mss32/sample-buffers";
import type { MSSContext } from "../../src/worker/modules/mss32/context";
import type { MSSSample } from "../../src/worker/modules/mss32/types";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { rawSampleCacheStats, resetRawSampleCache } from "../../src/worker/modules/mss32/raw-sample-cache";

const HANDLE = 0x400, IMAGE = 0x800, DIG_F_MONO_8 = 0, DIG_F_STEREO_16 = 3;

function setup(image: Uint8Array) {
    resetRawSampleCache();
    const memory = new Uint8Array(0x4000);
    memory.set(image, IMAGE);
    Mem.bind(() => memory);
    const sample = {
        handle: HANDLE, fileData: null, decodedData: null, sampleRate: 11025, channels: 1, bitsPerSample: 8,
        formatTag: 1, blockAlign: 1, volume: 127, pan: 64, playbackRate: 1, loopCount: 1, isPlaying: false,
        isPaused: false, position: 0, pendingStart: false,
    } as unknown as MSSSample;
    const ctx = {
        process: { getCurrentMemory: () => memory, memory: { alloc: () => 0, free: () => {} } },
        memory, samples: new Map([[HANDLE, sample]]), streams: new Map(),
    } as unknown as MSSContext;
    const exports = { ...createSampleExports(ctx), ...createSampleBufferExports(ctx) };
    const call = (name: string, args: number[]) => exports[name]!({} as never, memory, args);
    return { memory, sample, call };
}

describe("MSS32 raw PCM sound images", () => {
    test("8-bit mono raw data decodes with the declared type and the voice rate", () => {
        const raw = new Uint8Array([0x80, 0xff, 0x00, 0x80, 0xc0, 0x40]);
        const { sample, call, memory } = setup(raw);
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_MONO_8, 0]);
        expect(call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length])).toBe(1);
        expect(sample.fileFormat).toBe("raw");
        expect(sample.sampleRate).toBe(11025);
        expect(sample.pcmBytes).toBe(6);
        expect(Array.from(sample.decodedData!)).toHaveLength(6);
        expect(sample.decodedData![0]).toBeCloseTo(0, 5);
        expect(sample.decodedData![1]).toBeGreaterThan(0.95);
        expect(sample.decodedData![2]).toBeLessThan(-0.95);
        expect(new DataView(memory.buffer).getUint32(HANDLE + 0x14, true)).toBe(6);
    });

    test("a later AIL_set_sample_type re-decodes the same image as 16-bit stereo", () => {
        const raw = new Uint8Array(new Int16Array([16384, -16384, 0, 32767, -32768, 0, 1, 2]).buffer);
        const { sample, call, memory } = setup(raw);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.decodedData).toHaveLength(16);
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_STEREO_16, 0]);
        expect(sample.channels).toBe(2);
        expect(sample.bitsPerSample).toBe(16);
        expect(sample.pcmBytes).toBe(16);
        expect(sample.decodedData).toHaveLength(8);
        expect(sample.decodedData![0]).toBeCloseTo(0.5, 5);
        expect(sample.decodedData![1]).toBeCloseTo(-0.5, 5);
        expect(new DataView(memory.buffer).getUint32(HANDLE + 0x14, true)).toBe(16);
    });

    test("an odd trailing byte is not counted as a 16-bit frame", () => {
        const raw = new Uint8Array([0, 0x40, 0, 0xc0, 0x11]);
        const { sample, call } = setup(raw);
        sample.channels = 1; sample.bitsPerSample = 16; sample.blockAlign = 2;
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.pcmBytes).toBe(4);
        expect(sample.decodedData).toHaveLength(2);
    });

    test("a RIFF image keeps the container decoder", () => {
        const pcm = new Uint8Array([0x80, 0x90, 0x70, 0x80]);
        const wav = new Uint8Array(44 + pcm.length);
        const v = new DataView(wav.buffer);
        const ascii = (o: number, s: string) => { for (let i = 0; i < 4; i++) wav[o + i] = s.charCodeAt(i); };
        ascii(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); ascii(8, "WAVE");
        ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
        ascii(36, "data"); v.setUint32(40, pcm.length, true); wav.set(pcm, 44);
        const { sample, call } = setup(wav);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, wav.length]);
        expect(sample.fileFormat).toBe("wav");
        expect(sample.sampleRate).toBe(8000);
        expect(sample.decodedData).toHaveLength(4);
    });

    test("an unchanged image is decoded once and shared across voices and replays", () => {
        const raw = new Uint8Array(4096).map((_, i) => (i * 7) & 0xff);
        const { sample, call, memory } = setup(raw);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        const first = sample.decodedData, firstData = sample.fileData;
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.decodedData).toBe(first);
        expect(sample.fileData).toBe(firstData);
        expect(rawSampleCacheStats()).toMatchObject({ hits: 1, misses: 1 });
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_STEREO_16, 0]);
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_STEREO_16, 0]);
        expect(rawSampleCacheStats()).toMatchObject({ hits: 2, misses: 2 });
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_MONO_8, 0]);
        expect(sample.decodedData).toBe(first);
        expect(memory[IMAGE]).toBe(0);
    });

    test("rewritten bytes at the same address are decoded again", () => {
        const raw = new Uint8Array(4096).fill(0x80);
        const { sample, call, memory } = setup(raw);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        const first = sample.decodedData!;
        expect(first[0]).toBeCloseTo(0, 5);
        memory.fill(0xc0, IMAGE, IMAGE + raw.length);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.decodedData).not.toBe(first);
        expect(sample.decodedData![0]).toBeCloseTo(0.5, 5);
        expect(first[0]).toBeCloseTo(0, 5);
    });
});

