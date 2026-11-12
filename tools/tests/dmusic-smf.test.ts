/**
 * Standard MIDI Files loaded as DirectMusic segments: the parser's segment (tempo, time
 * signature, band, sequence) and the notes the performance hands the synthesizer when that
 * segment plays, plus the GM fallbacks a MIDI program change relies on.
 */
import { describe, expect, test } from "bun:test";
import { F_INSTRUMENT_DRUMS, type DlsCollection } from "../../packages/formats/src/dmusic/dls";
import type { ObjectReference } from "../../packages/formats/src/dmusic/reference";
import { buildSegment } from "../../src/worker/core/audio/directmusic/build";
import { Performance } from "../../src/worker/core/audio/directmusic/performance";
import { isStandardMidiFile, smfToSegment } from "../../src/worker/core/audio/directmusic/smf";
import { type DlsSynth, findInstrument } from "../../src/worker/core/audio/directmusic/synth";

const GM: ObjectReference = {
    validData: 0, classId: "", objectId: "gm", name: "", category: "", fileName: "", versionMS: 0, versionLS: 0,
};

const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const be16 = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const track = (events: number[]): number[] => [...ascii("MTrk"), ...be32(events.length), ...events];

/** Format 1, 480 ticks per quarter: a conductor track and one music track. */
function smf(): Uint8Array {
    const conductor = track([
        0x00, 0xff, 0x51, 0x03, ...[0x09, 0x27, 0xc0],      // 600000 us per quarter = 100 bpm
        0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,      // 3/4
        0x00, 0xff, 0x2f, 0x00,
    ]);
    const music = track([
        0x00, 0xb0, 0x00, 0x00,                 // bank select MSB 0 (absorbed into the patch)
        0x00, 0xc0, 0x05,                       // program 5 on channel 0
        0x00, 0xb0, 0x07, 0x64,                 // volume 100
        0x00, 0x90, 0x3c, 0x64,                 // C4 on
        0x83, 0x60, 0x80, 0x3c, 0x00,           // +480: C4 off (one quarter)
        0x00, 0x90, 0x40, 0x50,                 // E4 on
        0x81, 0x70, 0x40, 0x00,                 // +240, running status, velocity 0 = off
        0x00, 0x99, 0x24, 0x7f,                 // bass drum on channel 10
        0x83, 0x60, 0x89, 0x24, 0x00,           // +480: off
        0x00, 0xe0, 0x00, 0x50,                 // pitch bend
        0x00, 0xff, 0x2f, 0x00,
    ]);
    return Uint8Array.from([...ascii("MThd"), ...be32(6), ...be16(1), ...be16(2), ...be16(480), ...conductor, ...music]);
}

class RecordingSynth {
    sampleRate = 15360;
    frame = 0;
    on: Array<{ tick: number; channel: number; key: number; velocity: number }> = [];
    off: Array<{ tick: number; channel: number; key: number }> = [];
    patches: string[] = [];
    log: string[] = [];
    private tick(): number { return Math.round(this.frame / 10); }
    render(_l: Float32Array, _r: Float32Array, _offset: number, count: number): void { this.frame += count; }
    noteOn(channel: number, key: number, velocity: number): void { this.on.push({ tick: this.tick(), channel, key, velocity }); }
    noteOff(channel: number, key: number): void { this.off.push({ tick: this.tick(), channel, key }); }
    controlChange(channel: number, cc: number, value: number): void { this.log.push(`cc${cc} ch${channel}=${value}`); }
    pitchBend(channel: number, value: number): void { this.log.push(`bend ch${channel}=${value}`); }
    setInstrument(channel: number, collection: DlsCollection | null, patch: number): boolean {
        this.patches.push(`ch${channel}=${(patch >>> 0).toString(16)}${collection ? "" : " (default)"}`);
        return true;
    }
    allNotesOff(): void { this.log.push("allNotesOff"); }
}

const emptyCollection = (instruments: DlsCollection["instruments"] = []): DlsCollection => ({
    identity: { objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false }, instruments, waves: [],
});

describe("SMF parsing", () => {
    test("recognises MThd only", () => {
        expect(isStandardMidiFile(smf())).toBe(true);
        expect(isStandardMidiFile(Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("DMSG"), 0, 0]))).toBe(false);
        expect(smfToSegment(Uint8Array.from(ascii("RIFF....DMSG..")), "x", GM)).toBeNull();
    });

    test("builds tempo, time signature, band and sequence tracks in DirectMusic ticks", () => {
        const seg = smfToSegment(smf(), "song.mid", GM)!;
        expect(seg.identity.name).toBe("song.mid");
        const kinds = seg.tracks.map((t) => t.kind);
        expect(kinds).toEqual(["tempo", "timesig", "band", "seq"]);
        const [tempo, sig, band, seq] = seg.tracks as any[];
        expect(tempo.items).toEqual([{ time: 0, tempo: 100 }]);
        expect(sig.items[0].timeSig).toEqual({ beatsPerMeasure: 3, beat: 4, gridsPerBeat: 4 });

        const instruments = band.items[0].band.instruments.map((i: any) => [i.pChannel, i.patch >>> 0, i.collection]);
        expect(instruments).toContainEqual([0, 5, GM]);
        expect(instruments).toContainEqual([9, F_INSTRUMENT_DRUMS >>> 0, GM]);

        const notes = seq.events.filter((e: any) => (e.status & 0xf0) === 0x90)
            .map((e: any) => [e.time, e.duration, e.pChannel, e.byte1, e.byte2]);
        expect(notes).toEqual([
            [0, 768, 0, 0x3c, 0x64],
            [768, 384, 0, 0x40, 0x50],
            [1152, 768, 9, 0x24, 0x7f],
        ]);
        const other = seq.events.filter((e: any) => (e.status & 0xf0) !== 0x90).map((e: any) => [e.time, e.status, e.byte1, e.byte2]);
        expect(other).toEqual([[0, 0xb0, 7, 100], [1920, 0xe0, 0, 0x50]]);
        expect(seg.header.length).toBe(1920);
    });

    test("a note left open at the end of its track lasts to the end of the song", () => {
        const bytes = Uint8Array.from([...ascii("MThd"), ...be32(6), ...be16(0), ...be16(1), ...be16(96),
            ...track([0x00, 0x90, 0x30, 0x40, 0x60, 0x91, 0x31, 0x40, 0x60, 0x81, 0x31, 0x00, 0x00, 0xff, 0x2f, 0x00])]);
        const seq = smfToSegment(bytes, "open.mid", GM)!.tracks.find((t) => t.kind === "seq") as any;
        const open = seq.events.find((e: any) => e.byte1 === 0x30);
        expect([open.time, open.duration]).toEqual([0, 1536]);
    });
});

describe("SMF running status", () => {
    const notesOf = (events: number[]) => {
        const bytes = Uint8Array.from([...ascii("MThd"), ...be32(6), ...be16(0), ...be16(1), ...be16(96), ...track(events)]);
        const seq = smfToSegment(bytes, "rs.mid", GM)!.tracks.find((t) => t.kind === "seq") as any;
        return seq.events.filter((e: any) => (e.status & 0xf0) === 0x90).map((e: any) => e.byte1);
    };

    test("running status carries a note-on to the next data bytes", () => {
        expect(notesOf([0x00, 0x90, 0x3c, 0x64, 0x00, 0x3e, 0x64, 0x00, 0xff, 0x2f, 0x00])).toEqual([0x3c, 0x3e]);
    });

    test("a meta event cancels running status", () => {
        expect(notesOf([0x00, 0x90, 0x3c, 0x64, 0x00, 0xff, 0x01, 0x00, 0x00, 0x3e, 0x64, 0x00, 0xff, 0x2f, 0x00])).toEqual([0x3c]);
    });

    test("a sysex event cancels running status", () => {
        expect(notesOf([0x00, 0x90, 0x3c, 0x64, 0x00, 0xf0, 0x01, 0xf7, 0x00, 0x3e, 0x64, 0x00, 0xff, 0x2f, 0x00])).toEqual([0x3c]);
        expect(notesOf([0x00, 0x90, 0x3c, 0x64, 0x00, 0xf7, 0x00, 0x00, 0x3e, 0x64, 0x00, 0xff, 0x2f, 0x00])).toEqual([0x3c]);
    });
});

describe("SMF segment playback", () => {
    test("plays the file's notes on its channels with the band's programs", () => {
        const synth = new RecordingSynth();
        const perf = new Performance(synth as unknown as DlsSynth);
        const gm = emptyCollection();
        const segment = buildSegment(smfToSegment(smf(), "song.mid", GM)!, () => null, (ref) => ref.objectId === "gm" ? gm : null);
        perf.playSegment(segment, 0);
        const scratch = new Float32Array(4096);
        for (let frames = 2400 * 10 * 2; frames > 0;) {
            const n = Math.min(scratch.length, frames);
            perf.render(scratch, scratch, n);
            frames -= n;
        }
        expect(synth.on.map((n) => [n.channel, n.key, n.velocity])).toEqual([[0, 0x3c, 0x64], [0, 0x40, 0x50], [9, 0x24, 0x7f]]);
        expect(synth.off.map((n) => [n.channel, n.key])).toEqual([[0, 0x3c], [0, 0x40], [9, 0x24]]);
        const [c4, e4, drum] = synth.on;
        expect(e4!.tick - c4!.tick).toBeGreaterThan(0);
        expect(drum!.tick).toBeGreaterThan(e4!.tick);
        expect(synth.patches).toContain("ch0=5");
        expect(synth.patches).toContain(`ch9=${(F_INSTRUMENT_DRUMS >>> 0).toString(16)}`);
    });
});

describe("GM fallbacks for MIDI program changes", () => {
    const inst = (bank: number, program: number, name: string) => ({ bank, program, name, regions: [], articulation: [] });
    const gm = emptyCollection([inst(0, 5, "Piano"), inst(F_INSTRUMENT_DRUMS, 0, "Standard kit")]);

    test("a bank the collection lacks falls back to the same program in bank 0", () => {
        expect(findInstrument(gm, 5 | (8 << 16))?.name).toBe("Piano");
        expect(findInstrument(gm, 5 | (1 << 8))?.name).toBe("Piano");
        expect(findInstrument(gm, 6 | (8 << 16))).toBeNull();
    });

    test("a missing drum kit falls back to the standard kit", () => {
        expect(findInstrument(gm, (F_INSTRUMENT_DRUMS | 25) >>> 0)?.name).toBe("Standard kit");
    });
});
