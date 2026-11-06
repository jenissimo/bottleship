import { describe, expect, test } from "bun:test";
import {
    CONN_DST_EG1_ATTACKTIME, CONN_DST_EG1_SUSTAINLEVEL, CONN_DST_PAN, CONN_DST_PITCH, CONN_SRC_LFO, F_INSTRUMENT_DRUMS,
} from "../../packages/formats/src/dmusic/dls";
import {
    WAVE_FORMAT_OGG_VORBIS, decodeCompressedWaves, hasCompressedWaves, parseSoundFont,
} from "../../packages/formats/src/dmusic/sf2";
import { oggPackets, xiphLacedHeaders } from "../../packages/formats/src/audio/ogg-packets";
import { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";

const GEN = {
    pan: 17, attackVolEnv: 34, sustainVolEnv: 37, vibLfoToPitch: 6, instrument: 41, keyRange: 43, velRange: 44,
    initialAttenuation: 48, sampleID: 53, sampleModes: 54, scaleTuning: 56, exclusiveClass: 57, overridingRootKey: 58,
};

type Gen = [number, number];
const range = (lo: number, hi: number): number => lo | (hi << 8);

function chunk(id: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
}

function list(type: string, ...parts: Uint8Array[]): Uint8Array {
    const body = concat([ascii(type), ...parts]);
    return chunk("LIST", body);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

function ascii(s: string, size = s.length): Uint8Array {
    const out = new Uint8Array(size);
    for (let i = 0; i < Math.min(size, s.length); i++) out[i] = s.charCodeAt(i);
    return out;
}

function records(size: number, rows: Array<(v: DataView, o: number) => void>): Uint8Array {
    const out = new Uint8Array(size * rows.length);
    const view = new DataView(out.buffer);
    rows.forEach((row, i) => row(view, i * size));
    return out;
}

interface Zone { gens: Gen[] }
interface Sample { name: string; start: number; end: number; loop: [number, number]; rate: number; pitch: number; type?: number }

function soundFont(opts: {
    presets: Array<{ name: string; program: number; bank: number; zones: Zone[] }>;
    instruments: Array<{ name: string; zones: Zone[] }>;
    samples: Sample[];
    smpl: Uint8Array;
}): Uint8Array {
    const pbag: Array<[number]> = [];
    const pgen: Gen[] = [];
    const phdr: Array<{ name: string; program: number; bank: number; bag: number }> = [];
    for (const p of opts.presets) {
        phdr.push({ name: p.name, program: p.program, bank: p.bank, bag: pbag.length });
        for (const z of p.zones) { pbag.push([pgen.length]); pgen.push(...z.gens); }
    }
    phdr.push({ name: "EOP", program: 0, bank: 0, bag: pbag.length });
    pbag.push([pgen.length]);
    pgen.push([0, 0]);
    const ibag: Array<[number]> = [];
    const igen: Gen[] = [];
    const inst: Array<{ name: string; bag: number }> = [];
    for (const i of opts.instruments) {
        inst.push({ name: i.name, bag: ibag.length });
        for (const z of i.zones) { ibag.push([igen.length]); igen.push(...z.gens); }
    }
    inst.push({ name: "EOI", bag: ibag.length });
    ibag.push([igen.length]);
    igen.push([0, 0]);
    const shdr = [...opts.samples, { name: "EOS", start: 0, end: 0, loop: [0, 0] as [number, number], rate: 0, pitch: 0 }];

    const pdta = list("pdta",
        chunk("phdr", records(38, phdr.map((p) => (v, o) => {
            new Uint8Array(v.buffer).set(ascii(p.name, 20), o);
            v.setUint16(o + 20, p.program, true); v.setUint16(o + 22, p.bank, true); v.setUint16(o + 24, p.bag, true);
        }))),
        chunk("pbag", records(4, pbag.map(([g]) => (v, o) => v.setUint16(o, g, true)))),
        chunk("pmod", new Uint8Array(10)),
        chunk("pgen", records(4, pgen.map(([op, amount]) => (v, o) => { v.setUint16(o, op, true); v.setInt16(o + 2, amount, true); }))),
        chunk("inst", records(22, inst.map((i) => (v, o) => {
            new Uint8Array(v.buffer).set(ascii(i.name, 20), o); v.setUint16(o + 20, i.bag, true);
        }))),
        chunk("ibag", records(4, ibag.map(([g]) => (v, o) => v.setUint16(o, g, true)))),
        chunk("imod", new Uint8Array(10)),
        chunk("igen", records(4, igen.map(([op, amount]) => (v, o) => { v.setUint16(o, op, true); v.setInt16(o + 2, amount, true); }))),
        chunk("shdr", records(46, shdr.map((s) => (v, o) => {
            new Uint8Array(v.buffer).set(ascii(s.name, 20), o);
            v.setUint32(o + 20, s.start, true); v.setUint32(o + 24, s.end, true);
            v.setUint32(o + 28, s.loop[0], true); v.setUint32(o + 32, s.loop[1], true);
            v.setUint32(o + 36, s.rate, true); v.setUint8(o + 40, s.pitch);
            v.setUint16(o + 44, ("type" in s && s.type) || 1, true);
        }))),
    );
    const body = concat([ascii("sfbk"), list("INFO", chunk("ifil", new Uint8Array([2, 0, 1, 0])), chunk("INAM", ascii("Test Bank\0"))),
        list("sdta", chunk("smpl", opts.smpl)), pdta]);
    return chunk("RIFF", body);
}

function pcm(frames: number, value: number): Uint8Array {
    const s = new Int16Array(frames).fill(value);
    return new Uint8Array(s.buffer);
}

const SMPL = concat([pcm(100, 1000), pcm(100, 2000)]);
const SAMPLES: Sample[] = [
    { name: "soft", start: 0, end: 100, loop: [10, 90], rate: 22050, pitch: 60 },
    { name: "loud", start: 100, end: 200, loop: [110, 190], rate: 22050, pitch: 72 },
];

function bank(): Uint8Array {
    return soundFont({
        presets: [
            { name: "Piano", program: 0, bank: 0, zones: [
                { gens: [[GEN.pan, 100]] },
                { gens: [[GEN.keyRange, range(0, 100)], [GEN.instrument, 0]] },
            ] },
            { name: "Kit", program: 0, bank: 128, zones: [{ gens: [[GEN.instrument, 1]] }] },
        ],
        instruments: [
            { name: "Layers", zones: [
                { gens: [[GEN.attackVolEnv, -1200], [GEN.sampleModes, 1]] },
                { gens: [[GEN.velRange, range(0, 63)], [GEN.sustainVolEnv, 480], [GEN.sampleID, 0]] },
                { gens: [[GEN.velRange, range(64, 127)], [GEN.vibLfoToPitch, 50], [GEN.initialAttenuation, 100], [GEN.sampleID, 1]] },
            ] },
            { name: "Drums", zones: [
                { gens: [[GEN.keyRange, range(36, 38)], [GEN.scaleTuning, 0], [GEN.exclusiveClass, 3], [GEN.overridingRootKey, 36], [GEN.sampleID, 0]] },
            ] },
        ],
        samples: SAMPLES,
        smpl: SMPL,
    });
}

const scaleOf = (r: { articulation: Array<{ source: number; destination: number; scale: number }> }, source: number, destination: number): number | undefined =>
    r.articulation.find((c) => c.source === source && c.destination === destination)?.scale;

describe("SoundFont banks read as DLS collections", () => {
    test("presets become instruments, zones become regions with merged generators", () => {
        const c = parseSoundFont(bank())!;
        expect(c.identity.name).toBe("Test Bank");
        expect(c.instruments.map((i) => [i.name, i.program, i.bank])).toEqual([["Piano", 0, 0], ["Kit", 0, F_INSTRUMENT_DRUMS]]);
        const [soft, loud] = c.instruments[0]!.regions;
        expect([soft!.keyLow, soft!.keyHigh, soft!.velocityLow, soft!.velocityHigh]).toEqual([0, 100, 0, 63]);
        expect([loud!.velocityLow, loud!.velocityHigh, loud!.waveIndex]).toEqual([64, 127, 1]);
        expect(scaleOf(soft!, 0, CONN_DST_EG1_ATTACKTIME)).toBe(-1200 * 65536);
        expect(scaleOf(soft!, 0, CONN_DST_EG1_SUSTAINLEVEL)! / 65536).toBeCloseTo(500, 0);
        expect(scaleOf(soft!, 0, CONN_DST_PAN)).toBe(100 * 65536);
        expect(scaleOf(loud!, CONN_SRC_LFO, CONN_DST_PITCH)).toBe(50 * 65536);
        expect(loud!.sample!.attenuation).toBe(Math.round(-100 * 0.4 * 65536));
        expect(soft!.sample!.loop).toEqual({ type: 0, start: 10, length: 80 });
        expect(loud!.sample!.loop).toEqual({ type: 0, start: 10, length: 80 });
        expect(loud!.sample!.unityNote).toBe(72);
    });

    test("waves are the sample's 16-bit frames", () => {
        const c = parseSoundFont(bank())!;
        expect(c.waves).toHaveLength(2);
        const w = c.waves[1]!;
        expect([w.formatTag, w.channels, w.bitsPerSample, w.sampleRate, w.data.length]).toEqual([1, 1, 16, 22050, 200]);
        expect(new DataView(w.data.buffer, w.data.byteOffset).getInt16(0, true)).toBe(2000);
        expect(hasCompressedWaves(c)).toBe(false);
    });

    test("a scale tuning other than 100 becomes one region per key with the pitch held", () => {
        const kit = parseSoundFont(bank())!.instruments[1]!;
        expect(kit.regions.map((r) => [r.keyLow, r.keyHigh, r.sample!.fineTune, r.keyGroup])).toEqual([
            [36, 36, 0, 3], [37, 37, -100, 3], [38, 38, -200, 3],
        ]);
    });

    test("SF3 samples stay Vorbis until decoded, with loops relative to the sample", async () => {
        const ogg = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const c = parseSoundFont(soundFont({
            presets: [{ name: "P", program: 1, bank: 0, zones: [{ gens: [[GEN.instrument, 0]] }] }],
            instruments: [{ name: "I", zones: [{ gens: [[GEN.sampleModes, 1], [GEN.sampleID, 0]] }] }],
            samples: [{ name: "v", start: 0, end: 6, loop: [5, 40], rate: 44100, pitch: 60, type: 0x11 }],
            smpl: ogg,
        }))!;
        expect(c.waves[0]!.formatTag).toBe(WAVE_FORMAT_OGG_VORBIS);
        expect([...c.waves[0]!.data]).toEqual([...ogg]);
        expect(c.instruments[0]!.regions[0]!.sample!.loop).toEqual({ type: 0, start: 5, length: 35 });
        expect(hasCompressedWaves(c)).toBe(true);
        await decodeCompressedWaves(c, async (bytes, rate) => {
            expect(rate).toBe(44100);
            return new Int16Array([bytes.length, -1]);
        });
        expect(c.waves[0]!.formatTag).toBe(1);
        expect([...new Int16Array(c.waves[0]!.data.buffer, c.waves[0]!.data.byteOffset, 2)]).toEqual([6, -1]);
    });

    test("not a SoundFont", () => {
        expect(parseSoundFont(new Uint8Array(16))).toBeNull();
        expect(parseSoundFont(chunk("RIFF", concat([ascii("sfbk")])))).toBeNull();
    });
});

describe("the synthesizer picks regions by velocity and sounds layers together", () => {
    test("velocity selects the layer, and overlapping regions all sound", () => {
        const c = parseSoundFont(bank())!;
        const synth = new DlsSynth(22050, 16);
        synth.setInstrument(0, c, 0);
        synth.noteOn(0, 60, 30);
        expect(synth.activeVoiceCount).toBe(1);
        synth.noteOn(0, 61, 100);
        expect(synth.activeVoiceCount).toBe(2);
        const layered = structuredClone(c);
        layered.instruments[0]!.regions[1]!.velocityLow = 0;
        const both = new DlsSynth(22050, 16);
        both.setInstrument(0, layered, 0);
        both.noteOn(0, 60, 30);
        expect(both.activeVoiceCount).toBe(2);
        both.noteOn(0, 60, 30);
        both.render(new Float32Array(1000), new Float32Array(1000), 0, 1000);
        expect(both.activeVoiceCount).toBe(2);
    });
});

describe("Ogg packets", () => {
    function page(serial: number, granule: number, segments: number[], body: Uint8Array): Uint8Array {
        const out = new Uint8Array(27 + segments.length + body.length);
        out.set([0x4f, 0x67, 0x67, 0x53], 0);
        const v = new DataView(out.buffer);
        v.setUint32(6, granule, true);
        v.setUint32(14, serial, true);
        out[26] = segments.length;
        out.set(segments, 27);
        out.set(body, 27 + segments.length);
        return out;
    }

    test("packets split by lacing, continue across pages, and carry the page granule", () => {
        const big = new Uint8Array(300).map((_, i) => i & 0xff);
        const stream = concat([
            page(7, 0, [3, 2], new Uint8Array([1, 1, 1, 2, 2])),
            page(9, 0, [1], new Uint8Array([9])),
            page(7, 0, [255], big.subarray(0, 255)),
            page(7, 1234, [45, 1], concat([big.subarray(255), new Uint8Array([3])])),
        ]);
        const packets = oggPackets(stream);
        expect(packets.map((p) => p.data.length)).toEqual([3, 2, 300, 1]);
        expect([...packets[2]!.data]).toEqual([...big]);
        expect(packets.map((p) => p.granule)).toEqual([-1, 0, -1, 1234]);
    });

    test("Xiph lacing of codec headers", () => {
        const a = new Uint8Array(30), b = new Uint8Array(300), c = new Uint8Array(5);
        const laced = xiphLacedHeaders([a, b, c]);
        expect([...laced.subarray(0, 4)]).toEqual([2, 30, 255, 45]);
        expect(laced.length).toBe(4 + 335);
    });
});
