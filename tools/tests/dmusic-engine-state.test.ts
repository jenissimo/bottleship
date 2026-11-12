import { describe, expect, test } from "bun:test";
import { DMUS_IO_INST_PATCH, DMUS_IO_INST_TRANSPOSE, DMUS_IO_INST_VOLUME, parseBand } from "../../packages/formats/src/dmusic/band";
import { type DlsCollection, parseDls } from "../../packages/formats/src/dmusic/dls";
import type { PartRef, Style, StyleNote, StylePart, StylePattern, TimeSignature } from "../../packages/formats/src/dmusic/style";
import { loadBand } from "../../src/worker/core/audio/directmusic/build";
import {
    capturePerfSegmentState, DMUS_SEGF_MEASURE, DMUS_SEGF_QUEUE, DMUS_SEGF_SECONDARY, PerfSegment, type PerfSegmentState,
    linkPerfSegmentState, type PerfSegmentStateData, Performance, type PerformanceData, restorePerfSegmentState,
} from "../../src/worker/core/audio/directmusic/performance";
import { DlsSynth, SYNTH_STATE_KEYS, type SynthData } from "../../src/worker/core/audio/directmusic/synth";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { ascii, bandChunks, chunk, guid, i16, i32, list, riff, u16, u32 } from "./dmusic-fixtures";

const RATE = 22050;
const SIG: TimeSignature = { beatsPerMeasure: 4, beat: 4, gridsPerBeat: 4 };
const MEASURE = 3072;
const SEED = 7;
const ID = "0e54d502-1111-2222-3344-556677889900";

function collection(): DlsCollection {
    const pcm = i16(...Array.from({ length: 400 }, (_, i) => Math.round(Math.sin(i / 400 * Math.PI * 16) * 12000)));
    const wave = list("wave",
        chunk("fmt ", u16(1, 1), u32(RATE, RATE * 2), u16(2, 16)),
        chunk("wsmp", u32(20), u16(60), i16(0), i32(0), u32(0, 1), u32(16, 0, 0, 400)),
        chunk("data", pcm));
    return parseDls(riff("DLS ",
        chunk("colh", u32(1)), chunk("dlid", guid(ID)),
        list("lins", list("ins ",
            chunk("insh", u32(1, 0, 25)),
            list("lrgn", list("rgn ", chunk("rgnh", u16(0, 127, 0, 127, 0, 0)), chunk("wlnk", u16(0, 0), u32(1, 0)))),
            list("lart", chunk("art1", u32(8, 2), u16(0, 0, 0x206, 0), i32(-0x1e000000), u16(0, 0, 0x209, 0), i32(-0x20000000))),
            list("INFO", chunk("INAM", ascii("Tone\0"))))),
        chunk("ptbl", u32(8, 1), u32(0)),
        list("wvpl", wave)))!;
}

let nextId = 0;
function part(notes: Array<[grid: number, key: number, mask: number]>): StylePart {
    const variationChoices = new Array<number>(32).fill(0x20000000);
    variationChoices[0] = variationChoices[1] = variationChoices[2] = 0x3fffffff;
    return {
        timeSig: SIG, variationChoices, partId: `part-${nextId++}`, measures: 1, playModeFlags: 14, invertUpper: 0, invertLower: 0, curves: [],
        notes: notes.map(([gridStart, key, variation]): StyleNote => ({
            gridStart, variation, duration: 500, timeOffset: 0, musicValue: (3 + Math.floor(key / 12)) << 12 | [0, 0x10, 0x100, 0x200][key % 4]!,
            velocity: 90, timeRange: 0, durRange: 200, velRange: 40, inversionId: 0, playModeFlags: 14,
        })),
    };
}

const partRef = (p: StylePart, pChannel: number, randomVariation: number): PartRef => ({
    partId: p.partId, logicalPartId: pChannel, variationLockId: 0, subChordLevel: 0, priority: 0, randomVariation, pChannel, name: "",
});

function pattern(name: string, partRefs: PartRef[], measures = 1): StylePattern {
    return { name, timeSig: SIG, grooveBottom: 1, grooveTop: 100, embellishment: 0, measures, rhythm: [], partRefs, motifSettings: null, band: null };
}

function world() {
    const dls = collection();
    const band = loadBand(parseBand(riff("DMBD", ...bandChunks("B", [
        { patch: 25, pChannel: 0, flags: DMUS_IO_INST_PATCH | DMUS_IO_INST_VOLUME, volume: 110, collection: "tone.dls" },
        { patch: 25, pChannel: 1, flags: DMUS_IO_INST_PATCH | DMUS_IO_INST_TRANSPOSE, transpose: 5, collection: "tone.dls" },
    ])))!, () => dls);
    const parts = [part([[0, 0, 1], [4, 1, 2], [8, 2, 4], [12, 3, 7]]), part([[2, 4, 1], [6, 5, 2], [10, 6, 4]]), part([[0, 7, 7], [8, 9, 7]])];
    const motif = { ...pattern("Sting", [partRef(parts[2]!, 1, 1)]), motifSettings: { repeats: 5, playStart: 0, loopStart: 0, loopEnd: 0, resolution: 0 } };
    const style: Style = {
        identity: { objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false }, timeSig: SIG, tempo: 120, bands: [],
        parts: new Map(parts.map((p) => [p.partId, p])),
        patterns: [pattern("a", [partRef(parts[0]!, 0, 1), partRef(parts[1]!, 1, 0)]), pattern("b", [partRef(parts[1]!, 0, 1), partRef(parts[0]!, 1, 0)])],
        motifs: [motif],
    };
    const song = new PerfSegment();
    song.length = MEASURE * 2;
    song.repeats = 50;
    song.styles = [{ time: 0, style }];
    song.bands = [{ time: 0, band }];
    song.tempos = [{ time: 0, tempo: 140 }];
    song.commands = [{ time: 0, measure: 0, beat: 0, command: 0, grooveLevel: 50, grooveRange: 20 }];
    const next = new PerfSegment();
    next.length = MEASURE;
    next.styles = [{ time: 0, style }];
    next.commands = [{ time: 0, measure: 0, beat: 0, command: 0, grooveLevel: 10, grooveRange: 0 }];
    const frames = 9000;
    const wave = PerfSegment.fromWave({
        left: Float32Array.from({ length: frames }, (_, i) => Math.sin(i / 20) * 0.2), right: Float32Array.from({ length: frames }, (_, i) => Math.cos(i / 30) * 0.2),
        rate: 11025, frames,
    });
    wave.repeats = 3;
    return { dls, song, next, wave, sting: PerfSegment.motif(style, motif) };
}

type Saved = { engine: PerformanceData; synth: SynthData; states: Array<[segment: number, data: PerfSegmentStateData]>; notes: string[] };

class Rig {
    readonly synth = new DlsSynth(RATE, 24);
    readonly perf = new Performance(this.synth);
    readonly notes: string[] = [];
    readonly known: PerfSegmentState[] = [];

    constructor(readonly segments: PerfSegment[], readonly collections: DlsCollection[]) {
        this.perf.onNotification = (type, state, time) => { this.notes.push(`${type}@${time}:${this.segments.indexOf(state.segment)}`); };
    }

    run(frames: number): Float32Array {
        const left = new Float32Array(frames), right = new Float32Array(frames);
        for (let done = 0; done < frames; done += 441) {
            const n = Math.min(441, frames - done);
            this.perf.render(left.subarray(done), right.subarray(done), n);
        }
        const out = new Float32Array(frames * 2);
        out.set(left);
        out.set(right, frames);
        return out;
    }

    capture(): Saved {
        const known = this.known;
        const stateRef = (s: PerfSegmentState): number => {
            if (!known.includes(s)) known.push(s);
            return known.indexOf(s);
        };
        const collectionRef = (c: DlsCollection | null): number => c ? this.collections.indexOf(c) : -1;
        const engine = this.perf.captureState(stateRef, collectionRef);
        const states: Saved["states"] = [];
        for (let i = 0; i < known.length; i++) {
            states.push([this.segments.indexOf(known[i]!.segment), capturePerfSegmentState(known[i]!, stateRef, () => 0)]);
        }
        const saved = { engine, synth: this.synth.captureState(collectionRef), states, notes: [...this.notes] };
        return decodeValue(encodeValue(saved as unknown as SaveValue)) as unknown as Saved;
    }

    static restore(saved: Saved, segments: PerfSegment[], collections: DlsCollection[]): Rig {
        const rig = new Rig(segments, collections);
        const stateOf = (ref: number): PerfSegmentState => rig.known[ref]!;
        const collectionOf = (ref: number): DlsCollection | null => collections[ref] ?? null;
        for (const [segment, data] of saved.states) rig.known.push(restorePerfSegmentState(segments[segment]!, data));
        saved.states.forEach(([, data], ref) => linkPerfSegmentState(rig.known[ref]!, data, stateOf, () => rig));
        rig.perf.restoreState(saved.engine, stateOf, collectionOf);
        rig.synth.restoreState(saved.synth, collectionOf);
        rig.notes.push(...saved.notes);
        return rig;
    }
}

function playing(): { a: Rig; segments: PerfSegment[]; collections: DlsCollection[] } {
    const w = world();
    const segments = [w.song, w.next, w.wave, w.sting], collections = [w.dls];
    const a = new Rig(segments, collections);
    a.perf.seedRandom(SEED);
    a.perf.playSegment(w.song, 0);
    a.perf.playSegment(w.wave, DMUS_SEGF_SECONDARY);
    a.run(20000);
    a.perf.playSegment(w.sting, DMUS_SEGF_SECONDARY | DMUS_SEGF_MEASURE);
    a.perf.playSegment(w.next, DMUS_SEGF_QUEUE);
    a.synth.controlChange(1, 64, 127);
    a.synth.pitchBend(0, 0x2400);
    a.run(23456);
    return { a, segments, collections };
}

describe("the performance engine across a save", () => {
    test("music restored mid-pattern continues sample for sample, with the same notes, choices and notifications", () => {
        const { a, segments, collections } = playing();
        expect(a.synth.activeVoiceCount).toBeGreaterThan(0);
        const saved = a.capture();
        expect(saved.engine.events.length).toBeGreaterThan(0);
        expect(saved.synth.voices.length).toBe(a.synth.activeVoiceCount);
        expect(saved.states.map(([segment]) => segment).sort()).toEqual([0, 1, 2, 3]);
        const b = Rig.restore(saved, segments, collections);
        expect(b.capture()).toEqual(saved);
        const notesBefore = a.synth.stats.notes;
        const heardA = a.run(RATE * 6), heardB = b.run(RATE * 6);
        expect(heardA.some((x) => x !== 0)).toBe(true);
        expect(a.synth.stats.notes).toBeGreaterThan(notesBefore + 8);
        expect(b.synth.stats).toEqual(a.synth.stats);
        expect(b.perf.musicTime).toBe(a.perf.musicTime);
        expect(b.notes).toEqual(a.notes);
        expect(b.notes.length).toBeGreaterThan(saved.notes.length);
        let differing = 0;
        for (let i = 0; i < heardA.length; i++) if (heardA[i] !== heardB[i]) differing++;
        expect(differing).toBe(0);
        expect(b.capture()).toEqual(a.capture());
    });

    test("without the saved random state the continuation differs", () => {
        const { a, segments, collections } = playing();
        const saved = a.capture();
        saved.engine.randomState ^= 0x5555;
        const b = Rig.restore(saved, segments, collections);
        const heardA = a.run(RATE * 6), heardB = b.run(RATE * 6);
        expect(heardA.some((x, i) => x !== heardB[i])).toBe(true);
    });

    test("every saved value of the engine, a state and the synthesizer comes back", () => {
        const { a, segments, collections } = playing();
        const saved = a.capture();
        const again = (edit: (s: Saved) => void): Saved => {
            const copy = structuredClone(saved);
            edit(copy);
            const out = Rig.restore(copy, segments, collections).capture();
            expect(out).toEqual(copy);
            expect(out).not.toEqual(saved);
            return out;
        };
        for (const key of ["now", "tempo", "masterTempo", "randomState"] as const) again((s) => { s.engine[key] += 3; });
        again((s) => { s.engine.states.reverse(); });
        again((s) => { s.engine.states.pop(); });
        again((s) => { s.engine.events[0]![0] += 1; });
        again((s) => { s.engine.events[0]![5] = -1; });
        again((s) => { s.engine.transpose.push([9, -2]); });
        again((s) => { s.engine.drumChannels.push(9); });
        again((s) => { s.engine.installed[0]![2] = 99; });
        again((s) => { s.engine.installed[0]![1] = -1; });
        const state = saved.states.findIndex(([segment, d]) => segment === 0 && d.started);
        for (const key of ["startTime", "base", "repeatsLeft", "patternStart", "patternEnd", "grooveLevel", "wavePosition"] as const) {
            again((s) => { s.states[state]![1][key] += 2; });
        }
        const ended = structuredClone(saved);
        ended.states[state]![1].ended = true;
        const afterEnd = Rig.restore(ended, segments, collections).capture();
        expect(afterEnd.states[state]![1].ended).toBe(true);
        expect(afterEnd.engine.events.every((e) => e[5] !== state)).toBe(true);
        for (const key of ["started", "fresh"] as const) again((s) => { s.states[state]![1][key] = !s.states[state]![1][key]; });
        again((s) => { s.states[state]![1].stopAt = 123456; });
        again((s) => { s.states[state]![1].pattern ^= 1; });
        again((s) => { s.states[state]![1].variations[0] = 2; });
        again((s) => { s.states[state]![1].sequentialVariation.push(["x/1", 4]); });
        again((s) => { s.states[state]![1].queued = -1; });
        again((s) => { s.states[state]![1].patternStyle = -1; s.states[state]![1].pattern = -1; s.states[state]![1].variations = []; });
        again((s) => { s.states.find(([segment]) => segment === 2)![1].output = 0; });
        again((s) => { s.synth.masterGain = 0.5; });
        again((s) => { s.synth.noteCounter += 1; });
        again((s) => { s.synth.stats[2] += 1; });
        again((s) => { s.synth.channels[0]!.sustain = !s.synth.channels[0]!.sustain; });
        again((s) => { s.synth.channels[0]!.patch = 3; });
        saved.synth.channels[0]!.values.forEach((_, i) => again((s) => { s.synth.channels[0]!.values[i]! += 1; }));
        saved.synth.voices[0]!.values.forEach((_, i) => {
            if (SYNTH_STATE_KEYS.voice[i + 6] !== "channelId" && SYNTH_STATE_KEYS.voice[i + 6] !== "patch") again((s) => { s.synth.voices[0]!.values[i] = Number.isFinite(s.synth.voices[0]!.values[i]) ? s.synth.voices[0]!.values[i]! + 1 : 5; });
        });
        saved.synth.voices[0]!.flags.forEach((_, i) => again((s) => { s.synth.voices[0]!.flags[i] = !s.synth.voices[0]!.flags[i]; }));
        expect(saved.synth.channels[0]!.values.length + 4).toBe(SYNTH_STATE_KEYS.channel.length);
        expect(saved.synth.voices[0]!.values.length + saved.synth.voices[0]!.flags.length + 3).toBe(SYNTH_STATE_KEYS.voice.length);
    });

    test("a voice whose instrument is gone is dropped, and a pattern outside its segment is named", () => {
        const { a, segments, collections } = playing();
        const saved = a.capture();
        const b = Rig.restore(saved, segments, []);
        expect(b.synth.activeVoiceCount).toBe(0);
        const state = saved.states.findIndex(([segment, d]) => segment === 0 && d.started);
        saved.states[state]![1].pattern = 9;
        expect(() => Rig.restore(saved, segments, collections)).toThrow("directmusic: a saved pattern is not part of its segment");
        saved.states[state]![1].pattern = 0;
        saved.states[state]![1].variations.pop();
        expect(() => Rig.restore(saved, segments, collections)).toThrow("directmusic: a saved pattern has other parts than its style");
        const live = a.perf.activeStates()[0]!;
        live.pattern = pattern("stray", []);
        expect(() => a.capture()).toThrow("directmusic: a playing pattern is not part of its segment");
    });
});
