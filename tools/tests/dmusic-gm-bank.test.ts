import { describe, expect, spyOn, test } from "bun:test";
import { DMUS_IO_INST_PATCH, type BandInstrument } from "../../packages/formats/src/dmusic/band";
import type { DlsCollection } from "../../packages/formats/src/dmusic/dls";
import { Performance, PerfSegment } from "../../src/worker/core/audio/directmusic/performance";
import { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";

const empty = (): DlsCollection => ({
    identity: { objectId: "", name: "GM", versionMS: 0, versionLS: 0, hasVersion: false }, instruments: [], waves: [],
});

const instrument = (pChannel: number, patch: number): BandInstrument => ({
    patch, assignPatch: 0, noteRanges: [0, 0, 0, 0], pChannel, flags: DMUS_IO_INST_PATCH, pan: 64, volume: 100,
    transpose: 0, channelPriority: 0, pitchBendRange: 2, collection: null,
} as unknown as BandInstrument);

describe("a band from the default collection gets its instruments when the GM bank arrives", () => {
    test("reinstallInstruments repeats the patches a band installed from that collection only", () => {
        const synth = new DlsSynth(22050, 8);
        const perf = new Performance(synth);
        const gm = empty();
        const other = empty();
        perf.defaultCollection = gm;
        const band = {
            band: { identity: gm.identity, instruments: [instrument(0, 25), instrument(1, 40), instrument(2, 3)] },
            collections: [null, other, null],
        };
        perf.playSegment(PerfSegment.band(band as never), 0);
        perf.render(new Float32Array(64), new Float32Array(64), 64);
        const calls: Array<[number, number]> = [];
        const spy = spyOn(synth, "setInstrument").mockImplementation((ch, c, patch) => { calls.push([ch, patch]); return c === gm; });
        perf.reinstallInstruments(gm);
        expect(calls).toEqual([[0, 25], [2, 3]]);
        spy.mockRestore();
    });
});
