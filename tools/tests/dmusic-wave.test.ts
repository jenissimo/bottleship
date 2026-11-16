/** WAVE decoding and mixing use the same renderer as DirectMusic playback. */
import { describe, expect, test } from "bun:test";
import { decodeWave } from "../../src/worker/core/audio/directmusic/wave";
import { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";
import { DMUS_SEGF_SECONDARY, PerfSegment, Performance } from "../../src/worker/core/audio/directmusic/performance";

function wav(channels: number, rate: number, bits: number, samples: number[]): Uint8Array {
    const bytesPer = bits / 8, data = samples.length * bytesPer;
    const b = new Uint8Array(44 + data), v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("RIFF"), 0); v.setUint32(4, 36 + data, true);
    b.set(new TextEncoder().encode("WAVEfmt "), 8); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * channels * bytesPer, true); v.setUint16(32, channels * bytesPer, true); v.setUint16(34, bits, true);
    b.set(new TextEncoder().encode("data"), 36); v.setUint32(40, data, true);
    samples.forEach((s, i) => (bits === 16 ? v.setInt16(44 + i * 2, s, true) : v.setUint8(44 + i, s)));
    return b;
}

describe("decodeWave", () => {
    test("16-bit PCM keeps its samples; 8-bit PCM is recentred and widened", () => {
        expect(decodeWave(wav(2, 22050, 16, [100, -100, 200, -200]))).toMatchObject({ rate: 22050, frames: 2 });
        const stereo = decodeWave(wav(2, 22050, 16, [100, -100, 200, -200]))!;
        expect(Array.from(stereo.left, x => x * 32768)).toEqual([100, 200]);
        expect(Array.from(stereo.right, x => x * 32768)).toEqual([-100, -200]);
        expect(Array.from(decodeWave(wav(1, 11025, 8, [128, 255, 0]))!.left, x => x * 32768))
            .toEqual([0, 127 << 8, -128 << 8]);
    });

    test("MS ADPCM decodes block by block with the predictor its header names", () => {
        // Mono, one 10-byte block: predictor 1 (512, -256: a straight line), delta 16,
        // sample1 30, sample2 20, then nibbles 0 (no correction) and 1 (+delta).
        const block = [1, 16, 0, 30, 0, 20, 0, 0x01, 0x00, 0x00];
        const fmt = 22 + 7 * 4; // WAVEFORMATEX, samplesPerBlock, numCoef, seven coefficient pairs
        const b = new Uint8Array(12 + 8 + fmt + 8 + block.length), v = new DataView(b.buffer);
        b.set(new TextEncoder().encode("RIFF"), 0); v.setUint32(4, b.length - 8, true);
        b.set(new TextEncoder().encode("WAVEfmt "), 8); v.setUint32(16, fmt, true);
        v.setUint16(20, 2, true); v.setUint16(22, 1, true); v.setUint32(24, 22050, true);
        v.setUint16(32, block.length, true); v.setUint16(34, 4, true);
        v.setUint16(36, 32, true); v.setUint16(38, 8, true); v.setUint16(40, 7, true);
        [256, 0, 512, -256, 0, 0, 192, 64, 240, 0, 460, -208, 392, -232].forEach((c, i) => v.setInt16(42 + i * 2, c, true));
        b.set(new TextEncoder().encode("data"), 20 + fmt); v.setUint32(24 + fmt, block.length, true);
        b.set(block, 28 + fmt);
        const w = decodeWave(b)!;
        // Header samples oldest first, then each nibble high half first: 0, 1, 0, 0, 0, 0.
        expect(Array.from(w.left, x => x * 32768)).toEqual([20, 30, 40, 66, 92, 118, 144, 170]);
    });

    test("anything that is not a decodable WAVE is refused", () => {
        expect(decodeWave(new TextEncoder().encode("RIFF\0\0\0\0DMSG"))).toBeNull();
    });
});

describe("performance wave mixing", () => {
    const fromSamples = (channels: number, rate: number, samples: number[]) =>
        PerfSegment.fromWave(decodeWave(wav(channels, rate, 16, samples))!);

    test("mixes voices, resamples to the path rate, and ends voices after playback", () => {
        const perf = new Performance(new DlsSynth(22050, 8));
        const a = perf.playSegment(fromSamples(1, 22050, [1000, 1000, 1000, 1000]), DMUS_SEGF_SECONDARY);
        const b = perf.playSegment(fromSamples(1, 11025, [500, 500]), DMUS_SEGF_SECONDARY);
        const left = new Float32Array(6), right = new Float32Array(6);
        perf.render(left, right, 6);
        expect(Array.from(left, x => Math.round(x * 32768))).toEqual([1500, 1500, 1500, 1500, 0, 0]);
        expect(Array.from(right, x => Math.round(x * 32768))).toEqual([1500, 1500, 1500, 1500, 0, 0]);
        expect(perf.isPlaying(null, a)).toBe(false);
        expect(perf.isPlaying(null, b)).toBe(false);
    });

    test("stopping one state preserves the other state's stereo samples", () => {
        const perf = new Performance(new DlsSynth(22050, 8));
        const a = perf.playSegment(fromSamples(2, 22050, [400, 0, 400, 0]), DMUS_SEGF_SECONDARY);
        const b = perf.playSegment(fromSamples(1, 22050, [100, 100]), DMUS_SEGF_SECONDARY);
        perf.stop(null, b, 0);
        const left = new Float32Array(2), right = new Float32Array(2);
        perf.render(left, right, 2);
        expect(Array.from(left, x => Math.round(x * 32768))).toEqual([400, 400]);
        expect(Array.from(right)).toEqual([0, 0]);
        perf.stop(null, a, 0);
        expect(perf.isPlaying(null, a)).toBe(false);
        left.fill(0); right.fill(0);
        perf.render(left, right, 2);
        expect(Array.from(left)).toEqual([0, 0]);
        expect(Array.from(right)).toEqual([0, 0]);
    });
});

describe("wave track timing", () => {
    const synth = { sampleRate: 15360, render: () => {}, allNotesOff: () => {} } as unknown as DlsSynth;
    const segment = (length: number): PerfSegment => {
        const s = new PerfSegment();
        s.length = length;
        s.waves.push({ time: 0, sound: "boom" });
        return s;
    };

    test("a wave starts with its state, once, and its end is reported when the segment ends", () => {
        const perf = new Performance(synth);
        const started: unknown[] = [], ended: unknown[] = [];
        perf.onWave = (state, wave) => started.push([state, wave.sound]);
        perf.onStateEnd = (state) => ended.push(state);
        const state = perf.playSegment(segment(768), DMUS_SEGF_SECONDARY);
        const l = new Float32Array(4096), r = new Float32Array(4096);
        perf.render(l, r, 2000);
        expect(started).toEqual([[state, "boom"]]);
        expect(ended).toEqual([]);
        perf.render(l, r, 4096); // 120 bpm at 15360 Hz: 768 ticks is 7680 frames
        perf.render(l, r, 4096);
        expect(started.length).toBe(1);
        expect(ended).toEqual([state]);
    });

    test("stopping a state reports its end at once", () => {
        const perf = new Performance(synth);
        const ended: unknown[] = [];
        perf.onStateEnd = (state) => ended.push(state);
        const state = perf.playSegment(segment(100_000), DMUS_SEGF_SECONDARY);
        perf.render(new Float32Array(64), new Float32Array(64), 64);
        perf.stop(null, state, 0);
        expect(ended).toEqual([state]);
    });
});
