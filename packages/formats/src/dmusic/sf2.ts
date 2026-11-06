import {
    CONN_DST_ATTENUATION, CONN_DST_EG1_ATTACKTIME, CONN_DST_EG1_DECAYTIME, CONN_DST_EG1_RELEASETIME,
    CONN_DST_EG1_SUSTAINLEVEL, CONN_DST_EG2_ATTACKTIME, CONN_DST_EG2_DECAYTIME, CONN_DST_EG2_RELEASETIME,
    CONN_DST_EG2_SUSTAINLEVEL, CONN_DST_LFO_FREQUENCY, CONN_DST_LFO_STARTDELAY, CONN_DST_PAN, CONN_DST_PITCH,
    CONN_SRC_EG2, CONN_SRC_KEYNUMBER, CONN_SRC_LFO, CONN_SRC_NONE, F_INSTRUMENT_DRUMS,
    type DlsCollection, type DlsConnection, type DlsInstrument, type DlsRegion, type DlsWave,
} from "./dls";
import { dataView, isList, riffChunks, riffRoot, type RiffChunk } from "./riff";

export const WAVE_FORMAT_OGG_VORBIS = 0x674f;

const SAMPLE_TYPE_COMPRESSED = 0x10;
const SAMPLE_TYPE_ROM = 0x8000;
const PERCUSSION_BANK = 128;
const SHDR_SIZE = 46;
const PHDR_SIZE = 38;
const INST_SIZE = 22;
const BAG_SIZE = 4;
const GEN_SIZE = 4;
const ATTENUATION_SCALE = 0.4;

const G = {
    startloopAddrsOffset: 2, endloopAddrsOffset: 3, modLfoToPitch: 5, vibLfoToPitch: 6, modEnvToPitch: 7,
    modLfoToVolume: 13, pan: 17, delayModLFO: 21, freqModLFO: 22, delayVibLFO: 23, freqVibLFO: 24,
    attackModEnv: 26, holdModEnv: 27, decayModEnv: 28, sustainModEnv: 29, releaseModEnv: 30, keynumToModEnvDecay: 32,
    attackVolEnv: 34, holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38, keynumToVolEnvDecay: 40,
    instrument: 41, keyRange: 43, velRange: 44, startloopAddrsCoarseOffset: 45, initialAttenuation: 48,
    endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52, sampleID: 53, sampleModes: 54, scaleTuning: 56,
    exclusiveClass: 57, overridingRootKey: 58,
} as const;

const DEFAULTS: Record<number, number> = {
    [G.delayModLFO]: -12000, [G.delayVibLFO]: -12000,
    [G.attackModEnv]: -12000, [G.holdModEnv]: -12000, [G.decayModEnv]: -12000, [G.releaseModEnv]: -12000,
    [G.attackVolEnv]: -12000, [G.holdVolEnv]: -12000, [G.decayVolEnv]: -12000, [G.releaseVolEnv]: -12000,
    [G.scaleTuning]: 100, [G.overridingRootKey]: -1,
};

type Generators = Map<number, number>;
interface Zone { gens: Generators; low: number; high: number; velLow: number; velHigh: number }

interface SampleHeader {
    start: number; end: number; loopStart: number; loopEnd: number;
    rate: number; pitch: number; correction: number; type: number;
}

function zones(genIndex: number[], genOps: Uint16Array, genAmounts: Int16Array,
    first: number, last: number, terminal: number): { global: Zone | null; zones: Zone[] } {
    const out: Zone[] = [];
    let global: Zone | null = null;
    for (let b = first; b < last; b++) {
        const gens: Generators = new Map();
        let low = 0, high = 127, velLow = 0, velHigh = 127;
        for (let g = genIndex[b]!; g < genIndex[b + 1]!; g++) {
            const op = genOps[g]!;
            const amount = genAmounts[g]!;
            if (op === G.keyRange) { low = amount & 0xff; high = (amount >> 8) & 0xff; }
            else if (op === G.velRange) { velLow = amount & 0xff; velHigh = (amount >> 8) & 0xff; }
            else gens.set(op, amount);
        }
        const zone = { gens, low, high, velLow, velHigh };
        if (!gens.has(terminal)) {
            if (b === first && global === null) global = zone;
            continue;
        }
        out.push(zone);
    }
    return { global, zones: out };
}

function value(op: number, inst: Zone, instGlobal: Zone | null, preset: Zone, presetGlobal: Zone | null): number {
    const base = inst.gens.get(op) ?? instGlobal?.gens.get(op) ?? DEFAULTS[op] ?? 0;
    const offset = preset.gens.get(op) ?? presetGlobal?.gens.get(op) ?? 0;
    return base + offset;
}

function conn(source: number, destination: number, amount: number): DlsConnection {
    return { source, control: CONN_SRC_NONE, destination, transform: 0, scale: Math.round(amount * 65536) };
}

function articulation(v: (op: number) => number): DlsConnection[] {
    const vibToPitch = v(G.vibLfoToPitch);
    const useVib = vibToPitch !== 0 || v(G.modLfoToPitch) === 0;
    const sustainVol = Math.min(1, Math.max(0, 1 - v(G.sustainVolEnv) / 10 / 96));
    const sustainMod = Math.min(1, Math.max(0, 1 - v(G.sustainModEnv) / 1000));
    const list = [
        conn(CONN_SRC_NONE, CONN_DST_EG1_ATTACKTIME, v(G.attackVolEnv)),
        conn(CONN_SRC_NONE, CONN_DST_EG1_DECAYTIME, Math.max(v(G.decayVolEnv), v(G.holdVolEnv))),
        conn(CONN_SRC_NONE, CONN_DST_EG1_SUSTAINLEVEL, sustainVol * 1000),
        conn(CONN_SRC_NONE, CONN_DST_EG1_RELEASETIME, v(G.releaseVolEnv)),
        conn(CONN_SRC_NONE, CONN_DST_EG2_ATTACKTIME, v(G.attackModEnv)),
        conn(CONN_SRC_NONE, CONN_DST_EG2_DECAYTIME, Math.max(v(G.decayModEnv), v(G.holdModEnv))),
        conn(CONN_SRC_NONE, CONN_DST_EG2_SUSTAINLEVEL, sustainMod * 1000),
        conn(CONN_SRC_NONE, CONN_DST_EG2_RELEASETIME, v(G.releaseModEnv)),
        conn(CONN_SRC_NONE, CONN_DST_LFO_FREQUENCY, useVib ? v(G.freqVibLFO) : v(G.freqModLFO)),
        conn(CONN_SRC_NONE, CONN_DST_LFO_STARTDELAY, useVib ? v(G.delayVibLFO) : v(G.delayModLFO)),
        conn(CONN_SRC_NONE, CONN_DST_PAN, Math.min(500, Math.max(-500, v(G.pan)))),
    ];
    const lfoToPitch = useVib ? vibToPitch : v(G.modLfoToPitch);
    if (lfoToPitch) list.push(conn(CONN_SRC_LFO, CONN_DST_PITCH, lfoToPitch));
    if (v(G.modLfoToVolume)) list.push(conn(CONN_SRC_LFO, CONN_DST_ATTENUATION, -v(G.modLfoToVolume)));
    if (v(G.modEnvToPitch)) list.push(conn(CONN_SRC_EG2, CONN_DST_PITCH, v(G.modEnvToPitch)));
    if (v(G.keynumToVolEnvDecay)) list.push(conn(CONN_SRC_KEYNUMBER, CONN_DST_EG1_DECAYTIME, v(G.keynumToVolEnvDecay) * 128));
    if (v(G.keynumToModEnvDecay)) list.push(conn(CONN_SRC_KEYNUMBER, CONN_DST_EG2_DECAYTIME, v(G.keynumToModEnvDecay) * 128));
    return list;
}

function region(sample: SampleHeader, waveIndex: number, low: number, high: number, velLow: number, velHigh: number,
    v: (op: number) => number, extraCents: number): DlsRegion {
    const root = v(G.overridingRootKey);
    const loops = (v(G.sampleModes) & 1) !== 0;
    const loopStart = sample.loopStart + v(G.startloopAddrsOffset) + v(G.startloopAddrsCoarseOffset) * 32768;
    const loopEnd = sample.loopEnd + v(G.endloopAddrsOffset) + v(G.endloopAddrsCoarseOffset) * 32768;
    return {
        keyLow: low, keyHigh: high, velocityLow: velLow, velocityHigh: velHigh,
        options: 0,
        keyGroup: v(G.exclusiveClass),
        sample: {
            unityNote: root >= 0 && root <= 127 ? root : sample.pitch,
            fineTune: sample.correction + v(G.fineTune) + v(G.coarseTune) * 100 + extraCents,
            attenuation: Math.round(-v(G.initialAttenuation) * ATTENUATION_SCALE * 65536),
            options: 0,
            loop: loops && loopEnd > loopStart ? { type: 0, start: loopStart, length: loopEnd - loopStart } : null,
        },
        waveIndex,
        articulation: articulation(v),
    };
}

function sampleName(buf: Uint8Array, o: number): string {
    let s = "";
    for (let i = 0; i < 20 && buf[o + i]; i++) s += String.fromCharCode(buf[o + i]!);
    return s;
}

export function parseSoundFont(buf: Uint8Array): DlsCollection | null {
    const root = riffRoot(buf, "sfbk");
    if (!root) return null;
    const view = dataView(buf);
    let smpl: RiffChunk | null = null;
    const pdta = new Map<string, RiffChunk>();
    let name = "";
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (isList(c, "sdta")) {
            for (const s of riffChunks(buf, c.start, c.end)) if (s.id === "smpl") smpl = s;
        } else if (isList(c, "pdta")) {
            for (const s of riffChunks(buf, c.start, c.end)) pdta.set(s.id, s);
        } else if (isList(c, "INFO")) {
            for (const s of riffChunks(buf, c.start, c.end)) {
                if (s.id === "INAM") name = sampleName(buf.subarray(0, s.end), s.start).trim();
            }
        }
    }
    const need = ["phdr", "pbag", "pgen", "inst", "ibag", "igen", "shdr"];
    if (!smpl || need.some((id) => !pdta.has(id))) return null;

    const table = (id: string, size: number): { start: number; count: number } => {
        const c = pdta.get(id)!;
        return { start: c.start, count: Math.floor((c.end - c.start) / size) };
    };
    const readBags = (id: string): { gen: number[] } => {
        const t = table(id, BAG_SIZE);
        const gen: number[] = [];
        for (let i = 0; i < t.count; i++) gen.push(view.getUint16(t.start + i * BAG_SIZE, true));
        return { gen };
    };
    const readGens = (id: string): { ops: Uint16Array; amounts: Int16Array } => {
        const t = table(id, GEN_SIZE);
        const ops = new Uint16Array(t.count);
        const amounts = new Int16Array(t.count);
        for (let i = 0; i < t.count; i++) {
            ops[i] = view.getUint16(t.start + i * GEN_SIZE, true);
            amounts[i] = view.getInt16(t.start + i * GEN_SIZE + 2, true);
        }
        return { ops, amounts };
    };

    const samples: SampleHeader[] = [];
    const waves: Array<DlsWave | null> = [];
    const sh = table("shdr", SHDR_SIZE);
    for (let i = 0; i + 1 < sh.count; i++) {
        const o = sh.start + i * SHDR_SIZE + 20;
        const s: SampleHeader = {
            start: view.getUint32(o, true), end: view.getUint32(o + 4, true),
            loopStart: view.getUint32(o + 8, true), loopEnd: view.getUint32(o + 12, true),
            rate: view.getUint32(o + 16, true), pitch: buf[o + 20]!, correction: view.getInt8(o + 21),
            type: view.getUint16(o + 24, true),
        };
        const compressed = (s.type & SAMPLE_TYPE_COMPRESSED) !== 0;
        if (!compressed) {
            s.loopStart -= s.start;
            s.loopEnd -= s.start;
        }
        samples.push(s);
        const from = smpl.start + (compressed ? s.start : s.start * 2);
        const to = smpl.start + (compressed ? s.end : s.end * 2);
        const usable = (s.type & SAMPLE_TYPE_ROM) === 0 && s.rate > 0 && to > from && to <= smpl.end;
        waves.push(usable ? {
            formatTag: compressed ? WAVE_FORMAT_OGG_VORBIS : 1,
            channels: 1, sampleRate: s.rate, bitsPerSample: 16,
            data: buf.subarray(from, to), sample: null,
        } : null);
    }

    const pbag = readBags("pbag");
    const pgen = readGens("pgen");
    const ibag = readBags("ibag");
    const igen = readGens("igen");
    const it = table("inst", INST_SIZE);
    const instBags: number[] = [];
    for (let i = 0; i < it.count; i++) instBags.push(view.getUint16(it.start + i * INST_SIZE + 20, true));

    const collection: DlsCollection = {
        identity: { objectId: "", name, versionMS: 0, versionLS: 0, hasVersion: false },
        instruments: [], waves,
    };
    const ph = table("phdr", PHDR_SIZE);
    for (let p = 0; p + 1 < ph.count; p++) {
        const o = ph.start + p * PHDR_SIZE;
        const program = view.getUint16(o + 20, true);
        const bank = view.getUint16(o + 22, true);
        const firstBag = view.getUint16(o + 24, true);
        const lastBag = view.getUint16(o + PHDR_SIZE + 24, true);
        const preset = zones(pbag.gen, pgen.ops, pgen.amounts, firstBag, lastBag, G.instrument);
        const inst: DlsInstrument = {
            bank: bank === PERCUSSION_BANK ? F_INSTRUMENT_DRUMS : (bank & 0x7f) << 8,
            program: program & 0x7f,
            name: sampleName(buf, o),
            regions: [], articulation: [],
        };
        for (const pz of preset.zones) {
            const instIndex = pz.gens.get(G.instrument)!;
            if (instIndex < 0 || instIndex + 1 >= instBags.length) continue;
            const iz = zones(ibag.gen, igen.ops, igen.amounts,
                instBags[instIndex]!, instBags[instIndex + 1]!, G.sampleID);
            for (const z of iz.zones) {
                const sampleIndex = z.gens.get(G.sampleID)!;
                const sample = samples[sampleIndex];
                if (!sample || !waves[sampleIndex]) continue;
                const low = Math.max(z.low, pz.low), high = Math.min(z.high, pz.high);
                const velLow = Math.max(z.velLow, pz.velLow), velHigh = Math.min(z.velHigh, pz.velHigh);
                if (low > high || velLow > velHigh) continue;
                const v = (op: number): number => value(op, z, iz.global, pz, preset.global);
                const scale = v(G.scaleTuning);
                if (scale === 100) {
                    inst.regions.push(region(sample, sampleIndex, low, high, velLow, velHigh, v, 0));
                    continue;
                }
                const root = v(G.overridingRootKey) >= 0 ? v(G.overridingRootKey) : sample.pitch;
                for (let key = low; key <= high; key++) {
                    inst.regions.push(region(sample, sampleIndex, key, key, velLow, velHigh, v, (key - root) * (scale - 100)));
                }
            }
        }
        if (inst.regions.length > 0) collection.instruments.push(inst);
    }
    return collection;
}

export function hasCompressedWaves(collection: DlsCollection): boolean {
    return collection.waves.some((w) => w?.formatTag === WAVE_FORMAT_OGG_VORBIS);
}

export async function decodeCompressedWaves(collection: DlsCollection,
    decode: (ogg: Uint8Array, sampleRate: number) => Promise<Int16Array | null>): Promise<void> {
    for (let i = 0; i < collection.waves.length; i++) {
        const wave = collection.waves[i];
        if (!wave || wave.formatTag !== WAVE_FORMAT_OGG_VORBIS) continue;
        const pcm = await decode(wave.data, wave.sampleRate).catch(() => null);
        collection.waves[i] = pcm ? { ...wave, formatTag: 1, data: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) } : null;
    }
}
