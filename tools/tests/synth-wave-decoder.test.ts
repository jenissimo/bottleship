import { afterEach, describe, expect, test } from "bun:test";
import type { DlsCollection } from "../../packages/formats/src/dmusic/dls";
import { WAVE_FORMAT_OGG_VORBIS } from "../../packages/formats/src/dmusic/sf2";
import { DlsSynth, setWaveDecoder } from "../../src/worker/core/audio/directmusic/synth";

function sinePcm(): Uint8Array {
    const pcm = new Int16Array(2000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * i) / 50) * 20000);
    return new Uint8Array(pcm.buffer);
}

function bank(): DlsCollection {
    return {
        identity: { objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false },
        instruments: [{ bank: 0, program: 0, name: "P", articulation: [], regions: [
            { keyLow: 0, keyHigh: 127, velocityLow: 0, velocityHigh: 127, options: 0, keyGroup: 0, sample: null, waveIndex: 0, articulation: [] },
        ] }],
        waves: [{ formatTag: WAVE_FORMAT_OGG_VORBIS, channels: 1, sampleRate: 22050, bitsPerSample: 16, data: new Uint8Array(8),
            sample: { unityNote: 60, fineTune: 0, attenuation: 0, options: 0, loop: { type: 0, start: 0, length: 2000 } } }],
    };
}

const peak = (synth: DlsSynth): number => {
    const l = new Float32Array(256), r = new Float32Array(256);
    synth.render(l, r, 0, 256);
    return Math.max(...l.map(Math.abs));
};

afterEach(() => setWaveDecoder(null));

describe("compressed waves are decoded when an instrument is selected", () => {
    test("the channel is silent until its instrument's waves are decoded, then plays", async () => {
        const c = bank();
        let release!: () => void;
        const requested: string[] = [];
        setWaveDecoder((collection, inst) => {
            requested.push(inst.name);
            return new Promise<void>((resolve) => { release = () => {
                collection.waves[0] = { ...collection.waves[0]!, formatTag: 1, data: sinePcm() };
                resolve();
            }; });
        });
        const synth = new DlsSynth(22050, 8);
        synth.setInstrument(0, c, 0);
        expect(requested).toEqual(["P"]);
        synth.noteOn(0, 60, 100);
        expect(peak(synth)).toBe(0);
        release();
        await Promise.resolve();
        await Promise.resolve();
        synth.noteOn(0, 60, 100);
        expect(peak(synth)).toBeGreaterThan(0.01);
    });

    test("a newer selection on the channel wins over a decode that finishes later", async () => {
        const c = bank();
        let release!: () => void;
        setWaveDecoder((collection) => new Promise<void>((resolve) => { release = () => {
            collection.waves[0] = { ...collection.waves[0]!, formatTag: 1, data: sinePcm() };
            resolve();
        }; }));
        const synth = new DlsSynth(22050, 8);
        synth.setInstrument(0, c, 0);
        synth.setInstrument(0, null, 0);
        release();
        await Promise.resolve();
        await Promise.resolve();
        synth.noteOn(0, 60, 100);
        expect(peak(synth)).toBe(0);
    });
});
