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
import { Msacm32 } from "../../src/worker/modules/msacm32";
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
