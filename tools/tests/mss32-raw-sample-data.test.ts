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
import {
    RAW_SAMPLE_CACHE_LIMIT_BYTES, decodeRawSampleImage, rawSampleCacheHeldBytes, rawSampleCacheStats, resetRawSampleCache,
} from "../../src/worker/modules/mss32/raw-sample-cache";
import { isContainerImage } from "../../src/worker/modules/mss32/sample";

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

describe("MSS32 raw images: the declared sample type wins over sniffing", () => {
    test("16-bit raw data starting with sample -1 (FF FF) is not taken for MP3", () => {
        const raw = new Uint8Array(new Int16Array([-1, 1000, -1000, 2000, 0, 5, 6, 7]).buffer);
        const { sample, call } = setup(raw);
        call("_AIL_set_sample_type@12", [HANDLE, 1 /* DIG_F_MONO_16 */, 1 /* DIG_PCM_SIGN */]);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.fileFormat).toBe("raw");
        expect(sample.decodedData).toHaveLength(8);
        expect(sample.decodedData![1]).toBeCloseTo(1000 / 32768, 5);
    });

    test("8-bit raw data starting at full scale (FF F0) is not taken for MP3", () => {
        const raw = new Uint8Array([0xff, 0xf0, 0xe0, 0xc0, 0x80, 0x40, 0x20, 0x00]);
        const { sample, call } = setup(raw);
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_MONO_8, 0]);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.fileFormat).toBe("raw");
        expect(sample.decodedData).toHaveLength(8);
        expect(sample.decodedData![0]).toBeGreaterThan(0.95);
    });

    test("only unambiguous signatures count as containers once a type is declared", () => {
        const ascii = (s: string, n = 16) => { const d = new Uint8Array(n); for (let i = 0; i < s.length; i++) d[i] = s.charCodeAt(i); return d; };
        expect(isContainerImage(ascii("RIFF\0\0\0\0WAVE"))).toBe(true);
        expect(isContainerImage(ascii("RIFF\0\0\0\0AVI "))).toBe(false);
        expect(isContainerImage(ascii("OggS"))).toBe(true);
        expect(isContainerImage(ascii("ID3\u0003"))).toBe(true);
        expect(isContainerImage(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]))).toBe(false);
    });

    test("DIG_PCM_SIGN makes 8-bit data signed", () => {
        const raw = new Uint8Array([0x00, 0x7f, 0x80, 0xc0]);
        const { sample, call } = setup(raw);
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_MONO_8, 1 /* DIG_PCM_SIGN */]);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        const d = Array.from(sample.decodedData!);
        expect(d[0]).toBeCloseTo(0, 5);
        expect(d[1]).toBeGreaterThan(0.95);
        expect(d[2]).toBeLessThan(-0.95);
        expect(d[3]).toBeCloseTo(-0.5, 5);
        // Unsigned again after a re-type without the flag: same image, other decode.
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_MONO_8, 0]);
        expect(sample.decodedData![0]).toBeLessThan(-0.95);
        expect(sample.decodedData![2]).toBeCloseTo(0, 5);
    });

    test("a DIG_F_ADPCM image plays as silence, not as its nibbles read as PCM", () => {
        const raw = new Uint8Array(64).map((_, i) => (i * 37) & 0xff);
        const { sample, call } = setup(raw);
        call("_AIL_set_sample_type@12", [HANDLE, 5 /* DIG_F_ADPCM_MONO_16 */, 0]);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.fileFormat).toBe("raw");
        expect(sample.decodedData!.length).toBeGreaterThan(0);
        expect(Array.from(sample.decodedData!).every(v => v === 0)).toBe(true);
    });
});

describe("MSS32 raw image cache", () => {
    test("a rewrite between any two bytes is noticed (no sparse fingerprint)", () => {
        const raw = new Uint8Array(8192).fill(0x80);
        const { sample, call, memory } = setup(raw);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        const first = sample.decodedData!;
        memory.fill(0xff, IMAGE + 1, IMAGE + 8);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.decodedData).not.toBe(first);
        expect(sample.decodedData![1]).toBeGreaterThan(0.95);
        memory[IMAGE + 8191] = 0x00;
        const second = sample.decodedData;
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        expect(sample.decodedData).not.toBe(second);
        expect(sample.decodedData![8191]).toBeLessThan(-0.95);
    });

    test("a re-type re-reads the guest bytes the voice points at", () => {
        const raw = new Uint8Array(16).fill(0x80);
        const { sample, call, memory } = setup(raw);
        call("_AIL_set_sample_address@12", [HANDLE, IMAGE, raw.length]);
        memory.fill(0xc0, IMAGE, IMAGE + 16);
        call("_AIL_set_sample_type@12", [HANDLE, DIG_F_MONO_8, 0]);
        expect(sample.decodedData![0]).toBeCloseTo(0.5, 5);
    });

    test("raw copies and decodes count against one budget and leave together", () => {
        resetRawSampleCache();
        const len = 4 << 20; // 4 MiB of 8-bit PCM: 4 MiB raw + 16 MiB float per type
        const mem = new Uint8Array(len + 16);
        const mono8 = { channels: 1, bits: 8, signed8: false, adpcm: false };
        const stereo16 = { channels: 2, bits: 16, signed8: false, adpcm: false };
        for (let i = 0; i < 12; i++) {
            mem[0] = i; // distinct contents per address
            decodeRawSampleImage(0x10000 + i * 0x1000, mem, 0, len, mono8);
            decodeRawSampleImage(0x10000 + i * 0x1000, mem, 0, len, stereo16);
            const stats = rawSampleCacheStats();
            expect(stats.bytes).toBe(rawSampleCacheHeldBytes());
            expect(stats.bytes).toBeLessThanOrEqual(RAW_SAMPLE_CACHE_LIMIT_BYTES);
        }
        expect(rawSampleCacheStats().entries).toBeLessThan(12);
        resetRawSampleCache();
    });
});

