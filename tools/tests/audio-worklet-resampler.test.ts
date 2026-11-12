/**
 * The ring mixer's interpolation for a source slower than the output.
 *
 * Need for Speed: Porsche Unleashed streams its menu music into a 16 kHz DirectSound
 * buffer. Played at 48 kHz with linear interpolation, the source's spectral images
 * (8-16 kHz) sat ~31 dB under the music, the only thing in the final mix that the guest
 * did not write (captured end to end: the mix matched a linear resampling of every
 * Unlocked byte to 1e-4). Each test drives the real processor; the image-band tests
 * have their negative control in the diagnostic `set_resampler: linear` switch.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    createAudioRingBuffer, setCtrl, writeRingData,
    CTRL_STATE, CTRL_LOOP_MODE, CTRL_DATA_LENGTH, CTRL_FLAGS, CTRL_WRITE_CURSOR,
    STATE_PLAYING, FLAG_CIRCULAR, FLAG_STREAMING,
} from "../../src/audio/audio-ring-buffer";

let Processor: any;
const saved = new Map<string, PropertyDescriptor | undefined>();
function installGlobal(key: string, value: unknown): void {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const OUT = 48000;

beforeAll(async () => {
    installGlobal("AudioWorkletProcessor", class { port = { postMessage(_m: unknown) {}, onmessage: null as any }; });
    installGlobal("registerProcessor", (name: string, ctor: unknown) => { if (name === "bottleship-audio") Processor = ctor; });
    installGlobal("sampleRate", OUT);
    installGlobal("currentTime", 0);
    // A private module instance: the worklet registers its processor once per evaluation.
    await import("../../src/audio/bottleship-audio-worklet.ts?audio-resampler");
    if (!Processor) throw new Error("worklet processor was not registered");
});

afterAll(() => {
    for (const [key, d] of saved) {
        if (d) Object.defineProperty(globalThis, key, d);
        else Reflect.deleteProperty(globalThis, key);
    }
});

/** A playing stereo s16 ring at `rate` Hz holding `pcm` (mono, duplicated to both channels). */
function voice(rate: number, pcm: Float64Array, opts: { loopMode?: number; mode?: "linear" | "sinc" } = {}) {
    const frames = pcm.length;
    const sab = createAudioRingBuffer(frames * 4, { channels: 2, sampleRate: rate, bitsPerSample: 16 }, true);
    const bytes = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) bytes[2 * i] = bytes[2 * i + 1] = Math.round(pcm[i] * 32767);
    writeRingData(sab, 0, new Uint8Array(bytes.buffer), frames * 4);
    setCtrl(sab, CTRL_DATA_LENGTH, frames * 4);
    setCtrl(sab, CTRL_LOOP_MODE, opts.loopMode ?? -1);
    setCtrl(sab, CTRL_STATE, STATE_PLAYING);
    const proc = new Processor();
    if (opts.mode) proc.port.onmessage({ data: { type: "set_resampler", mode: opts.mode } });
    proc.port.onmessage({ data: { type: "register", id: 1, sab } });
    return {
        sab, proc,
        render(n: number): Float64Array {
            const out = new Float64Array(n * 128);
            for (let q = 0; q < n; q++) {
                const block = [new Float32Array(128), new Float32Array(128)];
                proc.process([], [block], {});
                out.set(block[0], q * 128);
            }
            return out;
        },
    };
}

function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const a = -2 * Math.PI / len;
        for (let i = 0; i < n; i += len) {
            for (let k = 0; k < len / 2; k++) {
                const c = Math.cos(a * k), s = Math.sin(a * k);
                const p = i + k, q = p + len / 2;
                const vr = re[q] * c - im[q] * s, vi = re[q] * s + im[q] * c;
                re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi;
            }
        }
    }
}

/** Energy in [lo, hi) Hz of an 8192-point Hann-windowed frame of `x` at `at`. */
function bandEnergy(x: Float64Array, at: number, lo: number, hi: number): number {
    const N = 8192;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[at + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    let e = 0;
    for (let k = 1; k < N / 2; k++) {
        const f = k * OUT / N;
        if (f >= lo && f < hi) e += re[k] * re[k] + im[k] * im[k];
    }
    return e;
}

const db = (a: number, b: number) => 10 * Math.log10(a / b);

/** One second of tones at 16 kHz, a whole number of cycles each so the loop is seamless. */
function tones16k(): Float64Array {
    const x = new Float64Array(16000);
    for (let i = 0; i < x.length; i++) {
        x[i] = 0.3 * Math.sin(2 * Math.PI * 1000 * i / 16000)
            + 0.3 * Math.sin(2 * Math.PI * 5000 * i / 16000)
            + 0.3 * Math.sin(2 * Math.PI * 7000 * i / 16000);
    }
    return x;
}

describe("audio worklet: a 16 kHz source on a 48 kHz output", () => {
    const imageDb = (mode?: "linear" | "sinc") => {
        const out = voice(16000, tones16k(), { mode }).render(200);
        const at = 128 * 40;
        return db(bandEnergy(out, at, 8300, 20000), bandEnergy(out, at, 0, 7700));
    };

    test("its spectral images above the source Nyquist are suppressed", () => {
        expect(imageDb()).toBeLessThan(-60);
    });

    test("negative control: linear interpolation leaves them in the audible band", () => {
        expect(imageDb("linear")).toBeGreaterThan(-20);
    });

    test("the passband keeps its level", () => {
        // The 1 kHz and 5 kHz tones, against the same tones evaluated at the output rate.
        const out = voice(16000, tones16k()).render(200);
        const ref = new Float64Array(out.length);
        for (let i = 0; i < ref.length; i++) {
            const t = i / OUT;
            ref[i] = 0.3 * (Math.sin(2 * Math.PI * 1000 * t) + Math.sin(2 * Math.PI * 5000 * t) + Math.sin(2 * Math.PI * 7000 * t));
        }
        const at = 128 * 40;
        for (const [lo, hi] of [[900, 1100], [4900, 5100]]) {
            expect(Math.abs(db(bandEnergy(out, at, lo, hi), bandEnergy(ref, at, lo, hi)))).toBeLessThan(0.5);
        }
    });
});

describe("audio worklet: where the sinc window meets the data's edge", () => {
    test("a source at the output rate plays its samples unchanged", () => {
        const x = new Float64Array(4096);
        for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(i * 0.37) * Math.cos(i * 0.011);
        const out = voice(OUT, x).render(16);
        for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(Math.round(x[i] * 32767) / 32768, 6);
    });

    test("a one-shot reads silence before its start, not its own tail", () => {
        // Silent data with a loud last 16 frames: the head of a one-shot must stay silent.
        const x = new Float64Array(2048);
        for (let i = x.length - 16; i < x.length; i++) x[i] = 0.9;
        const head = voice(16000, x, { loopMode: 1 }).render(1);
        expect(Math.max(...head.map(Math.abs))).toBeLessThan(1e-6);
    });

    test("negative control: a looping buffer does continue into its tail", () => {
        const x = new Float64Array(2048);
        for (let i = x.length - 16; i < x.length; i++) x[i] = 0.9;
        const head = voice(16000, x, { loopMode: -1 }).render(1);
        expect(Math.max(...head.map(Math.abs))).toBeGreaterThan(0.01);
    });

    test("a holding stream never reads past its producer's frontier", () => {
        // Written: 600 frames of silence. Past the frontier: stale loud data that must not leak.
        // (The ring's last frames stay silent: behind its start a stream continues its
        // previous lap, which on a first lap is the ring's initial silence.)
        const frames = 4096, frontier = 600;
        const x = new Float64Array(frames);
        for (let i = frontier; i < frames - 64; i++) x[i] = 0.9;
        const v = voice(16000, x, { loopMode: 1 });
        setCtrl(v.sab, CTRL_FLAGS, FLAG_CIRCULAR | FLAG_STREAMING);
        setCtrl(v.sab, CTRL_WRITE_CURSOR, frontier * 4);
        const out = v.render(30);
        expect(Math.max(...out.map(Math.abs))).toBeLessThan(1e-6);
    });
});
