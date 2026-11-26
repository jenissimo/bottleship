/**
 * msacm32's ADPCM decoders, against an INDEPENDENT decode.
 *
 * Each fixture is a real ADPCM WAV (mono and stereo) and its `.ref` is an INDEPENDENT
 * decoder's output as raw s16le:
 *   - ms_*  : encoded AND decoded by ffmpeg's adpcm_ms.
 *   - ima_* : encoded and decoded by CPython's audioop, which implements the canonical
 *             IMA/DVI reference formula (diff = step>>3, then the code's bits) — the one
 *             imaadp32.acm uses. ffmpeg's IMA decoder uses the ((2*delta+1)*step)>>3
 *             form instead and lands 1-2 LSB away, so it is NOT ground truth here.
 * Both codecs are exactly specified, so a correct decoder is bit-identical to another
 * correct one — which makes this the one assertion worth making: a decoder that is
 * merely "plausible" produces audio, and audio nobody can tell is wrong is the failure
 * mode this whole area is about.
 *
 * The conversion is driven through the real acmStreamOpen/acmStreamSize/acmStreamConvert
 * exports, so the block arithmetic (cbSrcLengthUsed in whole blocks, cbDstLengthUsed in
 * frames) is under test alongside the sample math.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Msacm32, type Msacm32State } from "../../src/worker/modules/msacm32";
import { Gsm610Decoder } from "../../src/worker/core/audio/directmusic/gsm610";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const MMSYSERR_NOERROR = 0;
const ACMSTREAMHEADER_SIZE = 84;
const ACM_STREAMSIZEF_SOURCE = 0x00000000;
const ACMSTREAMHEADER_STATUSF_PREPARED = 0x00020000;
const FIXTURES = join(import.meta.dir, "fixtures", "adpcm");

const acm = new Msacm32();
acm.initialize({} as never);
const call = (name: string, ...args: number[]): number =>
    (acm.exports[name] as ThunkImplementation)({} as never, mem, args) as number;
/** Same call, but through a caller-supplied memory view (used by the Proxy test below). */
const callOn = (view8: Uint8Array, name: string, ...args: number[]): number =>
    (acm.exports[name] as ThunkImplementation)({} as never, view8, args) as number;

// One flat guest-memory stand-in; no AddressSpace is registered, so isValidAddress
// passes everything and the offsets below are the only layout that matters.
const mem = new Uint8Array(0x40000);
const view = new DataView(mem.buffer);
const SRC_FMT = 0x1000;      // source WAVEFORMATEX (+ its ADPCM extra bytes)
const DST_FMT = 0x1100;      // destination WAVEFORMATEX (PCM)
const HAS_PTR = 0x1200;      // HACMSTREAM out
const HDR = 0x1300;          // ACMSTREAMHEADER
const SIZE_OUT = 0x1400;
const SRC_DATA = 0x2000;
const DST_DATA = 0x12000;

interface WavFile { fmt: Uint8Array; data: Uint8Array; channels: number; rate: number; blockAlign: number }

function readWav(name: string): WavFile {
    const buf = new Uint8Array(readFileSync(join(FIXTURES, name)));
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = 12;
    let fmt: Uint8Array | null = null;
    let data: Uint8Array | null = null;
    while (p + 8 <= buf.length) {
        const id = String.fromCharCode(buf[p]!, buf[p + 1]!, buf[p + 2]!, buf[p + 3]!);
        const size = v.getUint32(p + 4, true);
        if (id === "fmt ") fmt = buf.subarray(p + 8, p + 8 + size);
        if (id === "data") data = buf.subarray(p + 8, p + 8 + size);
        p += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error(`${name}: missing fmt/data chunk`);
    const fv = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
    return {
        fmt, data,
        channels: fv.getUint16(2, true),
        rate: fv.getUint32(4, true),
        blockAlign: fv.getUint16(12, true),
    };
}

function writePcmFormat(at: number, channels: number, rate: number): void {
    mem.fill(0, at, at + 18);
    view.setUint16(at, 1, true);                       // WAVE_FORMAT_PCM
    view.setUint16(at + 2, channels, true);
    view.setUint32(at + 4, rate, true);
    view.setUint32(at + 8, rate * channels * 2, true);
    view.setUint16(at + 12, channels * 2, true);
    view.setUint16(at + 14, 16, true);
}

/** Decode a whole fixture through the ACM stream API. */
function decodeFixture(name: string): { pcm: Int16Array; srcUsed: number } {
    const wav = readWav(name);
    mem.set(wav.fmt, SRC_FMT);
    writePcmFormat(DST_FMT, wav.channels, wav.rate);
    mem.set(wav.data, SRC_DATA);

    expect(call("acmStreamOpen", HAS_PTR, 0, SRC_FMT, DST_FMT, 0, 0, 0, 0)).toBe(MMSYSERR_NOERROR);
    const has = view.getUint32(HAS_PTR, true);
    expect(has).not.toBe(0);

    expect(call("acmStreamSize", has, wav.data.length, SIZE_OUT, ACM_STREAMSIZEF_SOURCE))
        .toBe(MMSYSERR_NOERROR);
    const dstBytes = view.getUint32(SIZE_OUT, true);

    mem.fill(0, HDR, HDR + ACMSTREAMHEADER_SIZE);
    view.setUint32(HDR + 0, ACMSTREAMHEADER_SIZE, true);
    view.setUint32(HDR + 12, SRC_DATA, true);
    view.setUint32(HDR + 16, wav.data.length, true);
    view.setUint32(HDR + 28, DST_DATA, true);
    view.setUint32(HDR + 32, dstBytes, true);
    expect(call("acmStreamPrepareHeader", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
    expect(view.getUint32(HDR + 4, true) & ACMSTREAMHEADER_STATUSF_PREPARED)
        .toBe(ACMSTREAMHEADER_STATUSF_PREPARED);
    expect(call("acmStreamConvert", has, HDR, 0)).toBe(MMSYSERR_NOERROR);

    const used = view.getUint32(HDR + 36, true);
    const pcm = new Int16Array(used / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(DST_DATA + i * 2, true);
    expect(call("acmStreamClose", has, 0)).toBe(MMSYSERR_NOERROR);
    return { pcm, srcUsed: view.getUint32(HDR + 20, true) };
}

function reference(name: string): Int16Array {
    const buf = new Uint8Array(readFileSync(join(FIXTURES, name)));
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = new Int16Array(buf.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true);
    return out;
}

describe("msacm32 ADPCM decode", () => {
    for (const [wav, ref, label] of [
        ["ms_mono.wav", "ms_mono.ref", "MS-ADPCM mono"],
        ["ms_st.wav", "ms_st.ref", "MS-ADPCM stereo"],
        ["ima_mono.wav", "ima_mono.ref", "IMA-ADPCM mono"],
        ["ima_st.wav", "ima_st.ref", "IMA-ADPCM stereo"],
    ] as const) {
        test(`${label} matches the reference decoder sample for sample`, () => {
            const { pcm, srcUsed } = decodeFixture(wav);
            const expected = reference(ref);
            expect(pcm.length).toBe(expected.length);
            // Report the FIRST divergence rather than "arrays differ": a decoder that
            // drifts after N samples (adaptation state) and one with a wrong header
            // layout are different bugs, and the index is what tells them apart.
            let firstBad = -1;
            for (let i = 0; i < expected.length; i++) {
                if (pcm[i] !== expected[i]) { firstBad = i; break; }
            }
            expect({ index: firstBad }).toEqual({ index: -1 });
            // cbSrcLengthUsed is always a whole number of blocks.
            expect(srcUsed % readWav(wav).blockAlign).toBe(0);
        });
    }

    // Encoding is a driver half we do not have. Claiming it would produce a file of
    // noise the caller has no way to check.
    test("PCM -> ADPCM is refused, and the stream handle is NULLed", () => {
        const wav = readWav("ms_mono.wav");
        writePcmFormat(SRC_FMT, wav.channels, wav.rate);
        mem.set(wav.fmt, DST_FMT);
        view.setUint32(HAS_PTR, 0xdeadbeef, true);
        expect(call("acmStreamOpen", HAS_PTR, 0, SRC_FMT, DST_FMT, 0, 0, 0, 0)).not.toBe(MMSYSERR_NOERROR);
        expect(view.getUint32(HAS_PTR, true)).toBe(0);
    });
});

/**
 * The two defects roadmap 09.1 measured in the Far Cry trace: the decoder indexing v86's
 * guest-memory Proxy per nibble, and four fresh arrays per block landing in front of the
 * mixer on the audio deadline.
 *
 * The Proxy assertion is the exact one: a counting trap makes "does this leaf loop touch
 * the Proxy" a number rather than a claim, and it fails loudly if the borrow is ever
 * removed. The throughput bound is deliberately loose — a wall-clock threshold that is
 * tight enough to catch a 2x regression is also tight enough to fail on a shared CI box —
 * so it is sized to catch the shape of the defect (per-element trap, per-block garbage),
 * not to police a few percent.
 */
describe("msacm32 ADPCM decode does not pay per-nibble costs", () => {
    function armFixture(name: string): { has: number; wav: WavFile; dstBytes: number } {
        const wav = readWav(name);
        mem.set(wav.fmt, SRC_FMT);
        writePcmFormat(DST_FMT, wav.channels, wav.rate);
        mem.set(wav.data, SRC_DATA);
        expect(call("acmStreamOpen", HAS_PTR, 0, SRC_FMT, DST_FMT, 0, 0, 0, 0)).toBe(MMSYSERR_NOERROR);
        const has = view.getUint32(HAS_PTR, true);
        expect(call("acmStreamSize", has, wav.data.length, SIZE_OUT, ACM_STREAMSIZEF_SOURCE)).toBe(MMSYSERR_NOERROR);
        const dstBytes = view.getUint32(SIZE_OUT, true);
        mem.fill(0, HDR, HDR + ACMSTREAMHEADER_SIZE);
        view.setUint32(HDR + 0, ACMSTREAMHEADER_SIZE, true);
        view.setUint32(HDR + 12, SRC_DATA, true);
        view.setUint32(HDR + 16, wav.data.length, true);
        view.setUint32(HDR + 28, DST_DATA, true);
        view.setUint32(HDR + 32, dstBytes, true);
        expect(call("acmStreamPrepareHeader", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
        return { has, wav, dstBytes };
    }

    test("the decode loop does not index the guest-memory Proxy", () => {
        const { has, wav } = armFixture("ms_st.wav");
        const blocks = Math.floor(wav.data.length / wav.blockAlign);
        expect(blocks).toBeGreaterThanOrEqual(2);

        // Shaped exactly like v86's own guest-memory view (vendor/v86/src/lib.js): the
        // target is a bare object, and a function property comes back BOUND — which is
        // what makes `raw.constructor === Uint8Array` false and sends toPlainGuestMemory
        // down its unwrapping path. A transparent proxy over the array would return the
        // real constructor, take the "already canonical" fast path, and quietly test
        // nothing.
        let gets = 0;
        const proxied = new Proxy({}, {
            get(_t, k) {
                gets++;
                const x = (mem as unknown as Record<string | symbol, unknown>)[k];
                return typeof x === "function" ? (x as Function).bind(mem) : x;
            },
            set(_t, k, v) {
                gets++;
                (mem as unknown as Record<string | symbol, unknown>)[k] = v;
                return true;
            },
        }) as unknown as Uint8Array;

        expect(callOn(proxied, "acmStreamConvert", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
        const decodedSamples = view.getUint32(HDR + 36, true) / 2;
        expect(decodedSamples).toBeGreaterThan(500);

        // The handler legitimately touches the proxy a handful of times at its boundary
        // (buffer/byteOffset/byteLength for the header DataView, the validity checks).
        // What it must NOT do is reach through it per nibble and per output sample: that
        // is the ~25x path, and on this fixture it would be tens of thousands of traps.
        expect(gets).toBeLessThan(64);
        expect(gets * 10).toBeLessThan(decodedSamples);
        expect(call("acmStreamClose", has, 0)).toBe(MMSYSERR_NOERROR);
    });

    test("throughput stays in the shape of an allocation-free decoder", () => {
        const { has, wav } = armFixture("ms_st.wav");
        const blocksPerCall = Math.floor(wav.data.length / wav.blockAlign);
        const ITERATIONS = Math.max(1, Math.ceil(10_000 / blocksPerCall));

        for (let i = 0; i < 20; i++) call("acmStreamConvert", has, HDR, 0);   // warm the JIT
        const t0 = performance.now();
        for (let i = 0; i < ITERATIONS; i++) call("acmStreamConvert", has, HDR, 0);
        const nsPerBlock = ((performance.now() - t0) * 1e6) / (ITERATIONS * blocksPerCall);

        // Measured around 1-3 us/block for a 2-channel 1012-byte block on a laptop; the
        // per-nibble Proxy path and the four-arrays-per-block path each cost more than an
        // order of magnitude. 200 us/block is therefore a bound that only a defect of that
        // shape can cross, on any machine this suite runs on.
        expect(nsPerBlock).toBeLessThan(200_000);
        expect(call("acmStreamClose", has, 0)).toBe(MMSYSERR_NOERROR);
    });
});

describe("msacm32 GSM 6.10 decode", () => {
    const GSM_TAG = 0x31;
    const GSM_BLOCK_BYTES = 65;
    const GSM_BLOCK_SAMPLES = 320;
    const PCM_BLOCK_BYTES = GSM_BLOCK_SAMPLES * 2;
    const ACMERR_NOTPOSSIBLE = 512;
    const DETAILS = 0x1500;

    function writeGsmFormat(): void {
        view.setUint16(SRC_FMT, GSM_TAG, true);
        view.setUint16(SRC_FMT + 2, 1, true);
        view.setUint32(SRC_FMT + 4, 8000, true);
        view.setUint32(SRC_FMT + 8, 1625, true);
        view.setUint16(SRC_FMT + 12, GSM_BLOCK_BYTES, true);
        view.setUint16(SRC_FMT + 14, 0, true);
        view.setUint16(SRC_FMT + 16, 2, true);
        view.setUint16(SRC_FMT + 18, GSM_BLOCK_SAMPLES, true);
    }

    test("advertises the standard GSM format and suggests matching 16-bit PCM", () => {
        view.setUint32(DETAILS + 8, GSM_TAG, true);
        expect(call("acmFormatTagDetailsA", 0, DETAILS, 1)).toBe(MMSYSERR_NOERROR);
        expect(view.getUint32(DETAILS + 12, true)).toBe(20);
        expect(view.getUint32(DETAILS + 20, true)).toBe(1);
        expect(new TextDecoder().decode(mem.subarray(DETAILS + 24, DETAILS + 32))).toBe("GSM 6.10");
        const tagIndex = view.getUint32(DETAILS + 4, true);
        view.setUint32(DETAILS + 8, 0, true);
        expect(call("acmFormatTagDetailsA", 0, DETAILS, 0)).toBe(MMSYSERR_NOERROR);
        expect(view.getUint32(DETAILS + 4, true)).toBe(tagIndex);
        expect(view.getUint32(DETAILS + 8, true)).toBe(GSM_TAG);

        writeGsmFormat();
        const gsmFormat = mem.slice(SRC_FMT, SRC_FMT + 20);
        mem.fill(0, SRC_FMT, SRC_FMT + 20);
        view.setUint32(DETAILS + 4, 0, true);
        view.setUint32(DETAILS + 16, SRC_FMT, true);
        view.setUint32(DETAILS + 20, 20, true);
        expect(call("acmFormatDetailsA", 0, DETAILS, 0)).toBe(MMSYSERR_NOERROR);
        expect(mem.slice(SRC_FMT, SRC_FMT + 20)).toEqual(gsmFormat);

        writePcmFormat(DST_FMT, 1, 8000);
        const pcmFormat = mem.slice(DST_FMT, DST_FMT + 18);
        mem.fill(0, DST_FMT, DST_FMT + 18);
        expect(call("acmFormatSuggest", 0, SRC_FMT, DST_FMT, 18, 0)).toBe(MMSYSERR_NOERROR);
        expect(mem.slice(DST_FMT, DST_FMT + 18)).toEqual(pcmFormat);
    });

    test("matches the direct decoder and leaves an incomplete source block for the next call", () => {
        writeGsmFormat();
        writePcmFormat(DST_FMT, 1, 8000);
        expect(call("acmStreamOpen", HAS_PTR, 0, SRC_FMT, DST_FMT, 0, 0, 0, 0)).toBe(MMSYSERR_NOERROR);
        const has = view.getUint32(HAS_PTR, true);
        expect(has).not.toBe(0);

        expect(call("acmStreamSize", has, GSM_BLOCK_BYTES - 1, SIZE_OUT, ACM_STREAMSIZEF_SOURCE))
            .toBe(ACMERR_NOTPOSSIBLE);
        expect(call("acmStreamSize", has, GSM_BLOCK_BYTES * 2 - 1, SIZE_OUT, ACM_STREAMSIZEF_SOURCE))
            .toBe(MMSYSERR_NOERROR);
        expect(view.getUint32(SIZE_OUT, true)).toBe(PCM_BLOCK_BYTES);
        expect(call("acmStreamSize", has, PCM_BLOCK_BYTES + 2, SIZE_OUT, 1)).toBe(MMSYSERR_NOERROR);
        expect(view.getUint32(SIZE_OUT, true)).toBe(GSM_BLOCK_BYTES * 2);

        const data = new Uint8Array(GSM_BLOCK_BYTES * 2);
        let seed = 1;
        for (let i = 0; i < data.length; i++) {
            seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
            data[i] = (seed >>> 16) & 0xff;
        }
        mem.set(data, SRC_DATA);

        const decoder = new Gsm610Decoder();
        const expected = new Float32Array(GSM_BLOCK_SAMPLES * 2);
        decoder.decodeWav49Block(data, 0, expected, 0);
        decoder.decodeWav49Block(data, GSM_BLOCK_BYTES, expected, GSM_BLOCK_SAMPLES);

        mem.fill(0, HDR, HDR + ACMSTREAMHEADER_SIZE);
        view.setUint32(HDR, ACMSTREAMHEADER_SIZE, true);
        view.setUint32(HDR + 28, DST_DATA, true);
        view.setUint32(HDR + 32, PCM_BLOCK_BYTES * 2, true);
        expect(call("acmStreamPrepareHeader", has, HDR, 0)).toBe(MMSYSERR_NOERROR);

        view.setUint32(HDR + 12, SRC_DATA, true);
        view.setUint32(HDR + 16, GSM_BLOCK_BYTES - 1, true);
        expect(call("acmStreamConvert", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
        expect(view.getUint32(HDR + 20, true)).toBe(0);
        expect(view.getUint32(HDR + 36, true)).toBe(0);

        const convert = (offset: number, length: number, block: number): void => {
            view.setUint32(HDR + 12, SRC_DATA + offset, true);
            view.setUint32(HDR + 16, length, true);
            expect(call("acmStreamConvert", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
            expect(view.getUint32(HDR + 20, true)).toBe(GSM_BLOCK_BYTES);
            expect(view.getUint32(HDR + 36, true)).toBe(PCM_BLOCK_BYTES);
            const pcm = new Int16Array(mem.buffer, DST_DATA, GSM_BLOCK_SAMPLES);
            const start = block * GSM_BLOCK_SAMPLES;
            expect(pcm).toEqual(Int16Array.from(expected.subarray(start, start + GSM_BLOCK_SAMPLES), x => x * 32768));
        };
        convert(0, data.length - 1, 0);
        expect(mem.slice(SRC_DATA, SRC_DATA + data.length)).toEqual(data);
        const saved = encodeValue(acm.captureSavestate() as unknown as SaveValue);
        convert(GSM_BLOCK_BYTES, GSM_BLOCK_BYTES, 1);
        acm.restoreSavestate(decodeValue(saved) as unknown as Msacm32State);
        convert(GSM_BLOCK_BYTES, GSM_BLOCK_BYTES, 1);
        expect(call("acmStreamReset", has, 0)).toBe(MMSYSERR_NOERROR);
        convert(0, GSM_BLOCK_BYTES, 0);
        expect(call("acmStreamClose", has, 0)).toBe(MMSYSERR_NOERROR);
    });

    test("ACM_STREAMCONVERTF_START decodes the chunk as a fresh stream does", () => {
        const ACM_STREAMCONVERTF_START = 0x10;
        writeGsmFormat();
        writePcmFormat(DST_FMT, 1, 8000);
        const data = new Uint8Array(GSM_BLOCK_BYTES * 2);
        let seed = 7;
        for (let i = 0; i < data.length; i++) {
            seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
            data[i] = (seed >>> 16) & 0xff;
        }
        mem.set(data, SRC_DATA);
        const open = (): number => {
            expect(call("acmStreamOpen", HAS_PTR, 0, SRC_FMT, DST_FMT, 0, 0, 0, 0)).toBe(MMSYSERR_NOERROR);
            const has = view.getUint32(HAS_PTR, true);
            mem.fill(0, HDR, HDR + ACMSTREAMHEADER_SIZE);
            view.setUint32(HDR, ACMSTREAMHEADER_SIZE, true);
            view.setUint32(HDR + 28, DST_DATA, true);
            view.setUint32(HDR + 32, PCM_BLOCK_BYTES, true);
            expect(call("acmStreamPrepareHeader", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
            return has;
        };
        const convert = (has: number, block: number, flags: number): Int16Array => {
            view.setUint32(HDR + 12, SRC_DATA + block * GSM_BLOCK_BYTES, true);
            view.setUint32(HDR + 16, GSM_BLOCK_BYTES, true);
            expect(call("acmStreamConvert", has, HDR, flags)).toBe(MMSYSERR_NOERROR);
            expect(view.getUint32(HDR + 36, true)).toBe(PCM_BLOCK_BYTES);
            return new Int16Array(mem.slice(DST_DATA, DST_DATA + PCM_BLOCK_BYTES).buffer);
        };

        const fresh = open();
        const expected = convert(fresh, 1, 0);
        expect(call("acmStreamClose", fresh, 0)).toBe(MMSYSERR_NOERROR);

        const continued = open();
        convert(continued, 0, 0);
        expect(convert(continued, 1, 0)).not.toEqual(expected);
        expect(call("acmStreamClose", continued, 0)).toBe(MMSYSERR_NOERROR);

        const reused = open();
        convert(reused, 0, 0);
        expect(convert(reused, 1, ACM_STREAMCONVERTF_START)).toEqual(expected);
        expect(call("acmStreamClose", reused, 0)).toBe(MMSYSERR_NOERROR);
    });

    test("PCM to GSM is refused", () => {
        writeGsmFormat();
        writePcmFormat(DST_FMT, 1, 8000);
        view.setUint32(HAS_PTR, 0xdeadbeef, true);
        expect(call("acmStreamOpen", HAS_PTR, 0, DST_FMT, SRC_FMT, 0, 0, 0, 0)).toBe(ACMERR_NOTPOSSIBLE);
        expect(view.getUint32(HAS_PTR, true)).toBe(0);
    });
});

describe("acmMetrics size queries", () => {
    const ACM_METRIC_COUNT_DRIVERS = 1;
    const ACM_METRIC_MAX_SIZE_FORMAT = 50;
    const MS_ADPCM_FORMAT_BYTES = 50;
    const DRIVER_ID = 0xacd10001;
    const OUT = 0x1500;

    function maxFormatSize(hao: number): { result: number; size: number } {
        view.setUint32(OUT, 0, true);
        const result = call("acmMetrics", hao, ACM_METRIC_MAX_SIZE_FORMAT, OUT);
        return { result, size: view.getUint32(OUT, true) };
    }

    test("an open driver handle answers, so a caller can size a buffer for that driver", () => {
        const PHAD = 0x1510;
        expect(call("acmDriverOpen", PHAD, DRIVER_ID, 0)).toBe(MMSYSERR_NOERROR);
        const { result, size } = maxFormatSize(view.getUint32(PHAD, true));
        expect(result).toBe(MMSYSERR_NOERROR);
        expect(size).toBeGreaterThanOrEqual(MS_ADPCM_FORMAT_BYTES);
    });

    test("a driver id and NULL answer too", () => {
        expect(maxFormatSize(DRIVER_ID).size).toBeGreaterThanOrEqual(MS_ADPCM_FORMAT_BYTES);
        expect(maxFormatSize(0).size).toBeGreaterThanOrEqual(MS_ADPCM_FORMAT_BYTES);
    });

    test("an unknown handle is still refused", () => {
        expect(maxFormatSize(0x1234).result).not.toBe(MMSYSERR_NOERROR);
    });

    test("global counts still refuse a driver handle", () => {
        expect(call("acmMetrics", DRIVER_ID, ACM_METRIC_COUNT_DRIVERS, OUT)).not.toBe(MMSYSERR_NOERROR);
    });
});
