import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { DMusic } from "../../src/worker/modules/dmusic";
import {
    CLSID_DirectMusicLoader, CLSID_DirectMusicSegment, IID_IUnknown, type DMusicObject, type SegmentObject,
} from "../../src/worker/modules/dmusic-objects";
import { guidBytes } from "../../src/worker/modules/dpnet/constants";
import { decodeWave } from "../../src/worker/core/audio/directmusic/wave";
import { DMUS_SEGF_SECONDARY, PerfSegment, Performance } from "../../src/worker/core/audio/directmusic/performance";
import { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function wav(tag: number, channels: number, rate: number, blockAlign: number, bits: number, data: number[], fmtExtra: number[] = []): Uint8Array {
    const fmt = [...le16(tag), ...le16(channels), ...le32(rate), ...le32(rate * blockAlign), ...le16(blockAlign), ...le16(bits), ...fmtExtra];
    const body = [...ascii("WAVE"), ...ascii("fmt "), ...le32(fmt.length), ...fmt, ...ascii("data"), ...le32(data.length), ...data];
    return Uint8Array.from([...ascii("RIFF"), ...le32(body.length), ...body]);
}

const pcm16 = (...v: number[]): number[] => v.flatMap((x) => le16(x & 0xffff));

describe("WAVE decode", () => {
    test("16-bit stereo PCM", () => {
        const w = decodeWave(wav(1, 2, 22050, 4, 16, pcm16(16384, -16384, 8192, 0)))!;
        expect(w.frames).toBe(2);
        expect(w.rate).toBe(22050);
        expect(Array.from(w.left)).toEqual([0.5, 0.25]);
        expect(Array.from(w.right)).toEqual([-0.5, 0]);
    });

    test("8-bit mono PCM shares one channel for both sides", () => {
        const w = decodeWave(wav(1, 1, 11025, 1, 8, [128, 192, 64]))!;
        expect(Array.from(w.left)).toEqual([0, 0.5, -0.5]);
        expect(w.right).toBe(w.left);
    });

    test("MS ADPCM: header samples first, zero nibbles hold the predictor", () => {
        const block = [0, ...le16(16), ...le16(1000), ...le16(500), 0, 0];
        const extra = [...le16(32), ...le16(4), ...le16(7), ...[256, 0, 512, -256, 0, 0, 192, 64, 240, 0, 460, -208, 392, -232].flatMap((c) => le16(c & 0xffff))];
        const w = decodeWave(wav(2, 1, 22050, block.length, 4, block, extra))!;
        expect(w.frames).toBe(6);
        expect(Array.from(w.left).map((x) => Math.round(x * 32768))).toEqual([500, 1000, 1000, 1000, 1000, 1000]);
    });

    test("IMA ADPCM: the header sample, then decoded nibbles", () => {
        const block = [...le16(100), 0, 0, 0, 0, 0, 0];
        const w = decodeWave(wav(0x11, 1, 22050, block.length, 4, block))!;
        expect(w.frames).toBe(9);
        expect(Math.round(w.left[0]! * 32768)).toBe(100);
        expect(Array.from(w.left).every((x) => Math.round(x * 32768) === 100)).toBe(true);
    });

    test("not a WAVE", () => {
        expect(decodeWave(Uint8Array.from(ascii("MThd....")))).toBeNull();
    });
});

describe("wave segments in the performance", () => {
    const rate = 22050;
    const wave = { left: Float32Array.from([0.1, 0.2, 0.3, 0.4]), right: Float32Array.from([-0.1, -0.2, -0.3, -0.4]), rate, frames: 4 };

    function run(perf: Performance, frames: number): { l: number[]; r: number[] } {
        const l = new Float32Array(frames), r = new Float32Array(frames);
        perf.render(l, r, frames);
        return { l: Array.from(l, (x) => Math.round(x * 100) / 100), r: Array.from(r, (x) => Math.round(x * 100) / 100) };
    }

    test("plays its samples once, then the state ends", () => {
        const perf = new Performance(new DlsSynth(rate, 8));
        const seg = PerfSegment.fromWave(wave);
        const state = perf.playSegment(seg, DMUS_SEGF_SECONDARY);
        const out = run(perf, 8);
        expect(out.l).toEqual([0.1, 0.2, 0.3, 0.4, 0, 0, 0, 0]);
        expect(out.r).toEqual([-0.1, -0.2, -0.3, -0.4, 0, 0, 0, 0]);
        expect(perf.isPlaying(null, state)).toBe(false);
    });

    test("repeats loop the wave", () => {
        const perf = new Performance(new DlsSynth(rate, 8));
        const seg = PerfSegment.fromWave(wave);
        seg.repeats = 1;
        const state = perf.playSegment(seg, DMUS_SEGF_SECONDARY);
        expect(run(perf, 10).l).toEqual([0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4, 0, 0]);
        expect(perf.isPlaying(null, state)).toBe(false);
    });

    test("a state routed to an audio path sounds only there", () => {
        const perf = new Performance(new DlsSynth(rate, 8));
        const path = {};
        const state = perf.playSegment(PerfSegment.fromWave(wave), DMUS_SEGF_SECONDARY);
        state.output = path;
        expect(run(perf, 4).l).toEqual([0, 0, 0, 0]);
        const l = new Float32Array(4), r = new Float32Array(4);
        perf.renderWaves(path, l, r, 4, rate);
        expect(Array.from(l, (x) => Math.round(x * 100) / 100)).toEqual([0.1, 0.2, 0.3, 0.4]);
    });
});

describe("loader: a WAVE in memory becomes a wave segment", () => {
    const DESC_AT = 0x1000, OUT = 0x200, RIID = 0x300, CLASS_AT = 0x2800, WAV_AT = 0x4000;
    const system = System.getInstance(), savedProcess = system.process;
    let mem: Uint8Array, module: DMusic, created: DMusicObject[];
    let nextCom = 0x8000;

    beforeEach(() => {
        mem = new Uint8Array(0x20000);
        Mem.bind(() => mem);
        created = [];
        const process = {
            resetGeneration: 0,
            getCurrentMemory: () => mem,
            memory: {
                alloc: () => 0, free: () => undefined,
                allocSystemBlock: (n: number) => { const p = nextCom; nextCom += (n + 15) & ~15; return p; },
                freeSystemBlock: () => undefined,
            },
            addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length },
            getModule: () => undefined,
        };
        system.process = process as never;
        module = new DMusic();
        const internals = module as unknown as Record<string, any>;
        internals.process = process;
        module.vtables = new Proxy({}, { get: () => ({ address: 0x1000 }) }) as never;
        internals.registerLoaderExports();
        mem.set(guidBytes(IID_IUnknown), RIID);
        mem.set(guidBytes(CLSID_DirectMusicSegment), CLASS_AT);
    });

    afterEach(() => {
        for (const o of created) o.forceRelease();
        system.process = savedProcess;
    });

    test("DMUS_OBJ_CLASS | DMUS_OBJ_MEMORY", () => {
        expect(module.coCreateInstance(CLSID_DirectMusicLoader, IID_IUnknown, OUT)).toBe(0);
        const loaderPtr = Mem.readUint32(OUT)!;
        created.push(SystemResourceProvider.getInstance().getComObjectByAddress(loaderPtr) as DMusicObject);
        const bytes = wav(1, 1, 22050, 2, 16, pcm16(1000, 2000, 3000));
        mem.set(bytes, WAV_AT);
        const dv = new DataView(mem.buffer);
        dv.setUint32(DESC_AT, 0x350, true);
        dv.setUint32(DESC_AT + 4, (1 << 1) | (1 << 10), true);
        mem.set(mem.subarray(CLASS_AT, CLASS_AT + 16), DESC_AT + 0x18);
        dv.setUint32(DESC_AT + 0x340, bytes.length, true);
        dv.setUint32(DESC_AT + 0x348, WAV_AT, true);
        const hr = module.exports["IDirectMusicLoader8_GetObject"]!({} as never, mem, [loaderPtr, DESC_AT, RIID, OUT]) as number;
        expect(hr).toBe(0);
        const seg = SystemResourceProvider.getInstance().getComObjectByAddress(Mem.readUint32(OUT)!) as SegmentObject;
        created.push(seg);
        expect(seg.segment?.wave?.frames).toBe(3);
        expect(seg.segment!.length).toBeGreaterThan(0);
    });

    test("two same-length WAVEs that differ only between sampled bytes decode separately", () => {
        expect(module.coCreateInstance(CLSID_DirectMusicLoader, IID_IUnknown, OUT)).toBe(0);
        const loaderPtr = Mem.readUint32(OUT)!;
        created.push(SystemResourceProvider.getInstance().getComObjectByAddress(loaderPtr) as DMusicObject);
        const dv = new DataView(mem.buffer);
        const load = (samples: number[]): SegmentObject => {
            const bytes = wav(1, 1, 22050, 2, 16, pcm16(...samples));
            mem.set(bytes, WAV_AT);
            dv.setUint32(DESC_AT, 0x350, true);
            dv.setUint32(DESC_AT + 4, (1 << 1) | (1 << 10), true);
            mem.set(mem.subarray(CLASS_AT, CLASS_AT + 16), DESC_AT + 0x18);
            dv.setUint32(DESC_AT + 0x340, bytes.length, true);
            dv.setUint32(DESC_AT + 0x348, WAV_AT, true);
            expect(module.exports["IDirectMusicLoader8_GetObject"]!({} as never, mem, [loaderPtr, DESC_AT, RIID, OUT]) as number).toBe(0);
            const seg = SystemResourceProvider.getInstance().getComObjectByAddress(Mem.readUint32(OUT)!) as SegmentObject;
            created.push(seg);
            return seg;
        };
        const samples = Array.from({ length: 20000 }, (_, i) => i & 0x7fff);
        const a = load(samples);
        samples[1] = 2001;
        const b = load(samples);
        expect(Math.round(a.segment!.wave!.left[1]! * 32768)).toBe(1);
        expect(Math.round(b.segment!.wave!.left[1]! * 32768)).toBe(2001);
    });
});

describe("wave segment follow-ups", () => {
    const rate = 22050;

    test("an empty WAVE ends its state at once", () => {
        const perf = new Performance(new DlsSynth(rate, 8));
        const ends: number[] = [];
        perf.onNotification = (type) => { ends.push(type); };
        const state = perf.playSegment(PerfSegment.fromWave({ left: new Float32Array(0), right: new Float32Array(0), rate, frames: 0 }), DMUS_SEGF_SECONDARY);
        const l = new Float32Array(4), r = new Float32Array(4);
        perf.render(l, r, 4);
        expect(perf.isPlaying(null, state)).toBe(false);
        expect(ends.length).toBeGreaterThanOrEqual(2);
    });

    test("ending the waves on a released path finishes its states with SEGEND", () => {
        const perf = new Performance(new DlsSynth(rate, 8));
        const wave = { left: new Float32Array(1000).fill(0.1), right: new Float32Array(1000).fill(0.1), rate, frames: 1000 };
        const path = {};
        const state = perf.playSegment(PerfSegment.fromWave(wave), DMUS_SEGF_SECONDARY);
        state.output = path;
        const l = new Float32Array(4), r = new Float32Array(4);
        perf.render(l, r, 4);
        expect(perf.hasWaveOn(path)).toBe(true);
        const seen: number[] = [];
        perf.onNotification = (type) => { seen.push(type); };
        perf.endWavesOn(path);
        expect(perf.hasWaveOn(path)).toBe(false);
        expect(perf.isPlaying(null, state)).toBe(false);
        expect(seen.length).toBe(1);
    });

    test("a partial last ADPCM block is decoded, not dropped", () => {
        const block = [...le16(100), 0, 0, 0, 0, 0, 0];
        const partial = [...le16(200), 0, 0, 0, 0];
        const w = decodeWave(wav(0x11, 1, 22050, block.length, 4, [...block, ...partial]))!;
        expect(w.frames).toBe(9 + 5);
        expect(Math.round(w.left[9]! * 32768)).toBe(200);
    });

    test("WAVE_FORMAT_EXTENSIBLE 32-bit integer PCM decodes as integers, float as float", () => {
        const sub = (tag: number) => [...le16(22), ...le16(32), ...le32(3), ...le16(tag), ...le16(0), 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
        const ints = decodeWave(wav(0xfffe, 1, 22050, 4, 32, le32(0x40000000), sub(1)))!;
        expect(ints.left[0]).toBe(0.5);
        const floats = decodeWave(wav(0xfffe, 1, 22050, 4, 32, Array.from(new Uint8Array(Float32Array.from([0.25]).buffer)), sub(3)))!;
        expect(floats.left[0]).toBe(0.25);
    });

    test("24-bit PCM", () => {
        const w = decodeWave(wav(1, 1, 22050, 3, 24, [0x00, 0x00, 0xc0]))!;
        expect(w.left[0]).toBe(-0.5);
    });
});
