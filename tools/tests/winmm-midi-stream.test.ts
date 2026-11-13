/**
 * midiStream* plays queued MIDIEVENT buffers on the stream's own clock. It was a stub that
 * answered MMSYSERR_BADDEVICEID, so a title that plays its MIDI music through a stream
 * (rather than midiOutShortMsg or MCI) had no music at all.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MidiRouter } from "../../src/worker/core/audio/midi-router";
import { resetGmBankForTests } from "../../src/worker/core/audio/gm-bank";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { TimeService } from "../../src/worker/runtime/time";
import { WinmmMidiOut } from "../../src/worker/modules/winmm-midi";
import { MEVT_F_CALLBACK, MidiStream } from "../../src/worker/modules/winmm-midi-stream";
import { MidiSynthOutput } from "../../src/worker/modules/winmm-midi-synth";

const HDR = 0x12000, DATA = 0x13000, HDR2 = 0x12100, DATA2 = 0x14000;
const MHDR_DONE = 1, MHDR_PREPARED = 2, MHDR_INQUEUE = 4, MHDR_ISSTRM = 8;
const MEVT_TEMPO = 0x01000000, MEVT_LONGMSG = 0x80000000;
const msg = (status: number, d1: number, d2 = 0): number => status | (d1 << 8) | (d2 << 16);

let mem: Uint8Array;
const view = (): DataView => new DataView(mem.buffer);

/** Writes MIDIEVENTs into a buffer at `data` and a MIDIHDR for them at `hdr`. */
function buffer(hdr: number, data: number, events: Array<[number, number, Uint8Array?]>, flags = MHDR_PREPARED): number {
    let o = 0;
    for (const [delta, event, params] of events) {
        view().setUint32(data + o, delta, true);
        view().setUint32(data + o + 4, 0, true);
        view().setUint32(data + o + 8, event >>> 0, true);
        o += 12;
        if (params) {
            mem.set(params, data + o);
            o += (params.length + 3) & ~3;
        }
    }
    view().setUint32(hdr, data, true);
    view().setUint32(hdr + 4, o, true);
    view().setUint32(hdr + 8, o, true);
    view().setUint32(hdr + 16, flags, true);
    return o;
}

interface Sink { played: Array<[number, number]>; sysex: number[][]; off: number; shortMessage(m: number, at: number): void; systemExclusive(b: Uint8Array): void; allNotesOff(): void }
function sink(): Sink {
    return {
        played: [], sysex: [], off: 0,
        shortMessage(m, at) { this.played.push([m, Math.round(at)]); },
        systemExclusive(b) { this.sysex.push([...b]); },
        allNotesOff() { this.off++; },
    };
}

beforeEach(() => {
    mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
});

describe("the stream player", () => {
    const make = () => {
        const s = sink(), done: number[] = [], positions: number[] = [];
        const stream = new MidiStream(s, { done: (h) => done.push(h), position: (h) => positions.push(h) });
        return { s, done, positions, stream };
    };

    test("opens paused; once restarted, events play at their delta on the stream's tempo", () => {
        const { s, done, stream } = make();
        stream.timeDiv = 96;
        buffer(HDR, DATA, [[0, msg(0x90, 60, 100)], [96, msg(0x80, 60)], [48, msg(0x90, 64, 90)]]);
        stream.enqueue(HDR);
        stream.tick(1000);
        expect(s.played).toEqual([]);
        stream.restart(1000);
        stream.tick(1000);
        expect(s.played).toEqual([[msg(0x90, 60, 100), 1000]]);
        stream.tick(1499);
        expect(s.played.length).toBe(1);
        stream.tick(1760);
        expect(s.played).toEqual([[msg(0x90, 60, 100), 1000], [msg(0x80, 60), 1500], [msg(0x90, 64, 90), 1750]]);
        expect(done).toEqual([HDR]);
        expect(view().getUint32(HDR + 16, true) & (MHDR_DONE | MHDR_INQUEUE)).toBe(MHDR_DONE);
        expect(stream.positionTicks()).toBe(144);
    });

    test("MEVT_TEMPO changes the length of the ticks after it; a long event goes out as one message", () => {
        const { s, stream } = make();
        stream.timeDiv = 100;
        const sysex = new Uint8Array([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
        buffer(HDR, DATA, [[0, MEVT_TEMPO | 250000], [100, msg(0x90, 60, 100)], [0, MEVT_LONGMSG | sysex.length, sysex], [100, msg(0x80, 60)]]);
        stream.enqueue(HDR);
        stream.restart(0);
        stream.tick(1000);
        expect(stream.tempo).toBe(250000);
        expect(s.played).toEqual([[msg(0x90, 60, 100), 250], [msg(0x80, 60), 500]]);
        expect(s.sysex).toEqual([[...sysex]]);
    });

    test("MEVT_F_CALLBACK reports the event's offset in the header's dwOffset", () => {
        const { positions, stream } = make();
        buffer(HDR, DATA, [[0, msg(0x90, 60, 100)], [0, (MEVT_F_CALLBACK | msg(0x80, 60)) >>> 0]]);
        stream.enqueue(HDR);
        stream.restart(0);
        stream.tick(0);
        expect(positions).toEqual([HDR]);
        expect(view().getUint32(HDR + 28, true)).toBe(12);
    });

    test("pause holds the position and restart continues from it", () => {
        const { s, stream } = make();
        stream.timeDiv = 96;
        buffer(HDR, DATA, [[0, msg(0x90, 60, 100)], [96, msg(0x80, 60)]]);
        stream.enqueue(HDR);
        stream.restart(0);
        stream.tick(0);
        stream.pause(200);
        expect(s.off).toBe(1);
        expect(stream.positionMs(5000)).toBe(200);
        stream.tick(5000);
        expect(s.played.length).toBe(1);
        stream.restart(5000);
        stream.tick(5299);
        expect(s.played.length).toBe(1);
        stream.tick(5300);
        expect(s.played[1]).toEqual([msg(0x80, 60), 5300]);
    });

    test("stop silences, returns every queued buffer and rewinds", () => {
        const { s, done, stream } = make();
        buffer(HDR, DATA, [[1000, msg(0x90, 60, 100)]]);
        buffer(HDR2, DATA2, [[0, msg(0x90, 62, 100)]]);
        stream.enqueue(HDR);
        stream.enqueue(HDR2);
        stream.restart(0);
        stream.tick(10);
        stream.stop();
        expect(s.off).toBe(1);
        expect(done).toEqual([HDR, HDR2]);
        expect(stream.queued).toBe(0);
        expect(stream.playing).toBe(false);
        expect(stream.positionMs(100)).toBe(0);
    });

    test("a buffer that arrives after the queue ran dry plays from now, not as a burst", () => {
        const { s, stream } = make();
        stream.timeDiv = 96;
        buffer(HDR, DATA, [[0, msg(0x90, 60, 100)]]);
        stream.enqueue(HDR);
        stream.restart(0);
        stream.tick(0);
        buffer(HDR2, DATA2, [[96, msg(0x80, 60)], [96, msg(0x90, 62, 100)]]);
        stream.enqueue(HDR2);
        stream.tick(3000);
        expect(s.played.slice(1)).toEqual([[msg(0x80, 60), 3000]]);
        expect(stream.positionMs(3000)).toBe(500);
        stream.tick(3500);
        expect(s.played[2]).toEqual([msg(0x90, 62, 100), 3500]);
    });

    test("SMPTE time division counts ticks per frame", () => {
        const { stream } = make();
        stream.timeDiv = ((-25 & 0xff) << 8) | 40;
        expect(stream.msPerTick()).toBe(1);
    });
});

describe("midiStream handles", () => {
    const restore: Array<() => void> = [];
    const calls: number[][] = [];
    let now = 0;
    let output: { router: MidiRouter; release: () => void; tickers: Set<(n: number) => void>; addTicker: (t: (n: number) => void) => () => void };

    beforeEach(() => {
        calls.length = 0;
        now = 0;
        const router = new MidiRouter(22050, 8);
        output = {
            router, tickers: new Set(), release() { /* counted by the synth tests */ },
            addTicker(t) { this.tickers.add(t); return () => this.tickers.delete(t); },
        };
        const acquire = spyOn(MidiSynthOutput, "acquire").mockImplementation(() => output as unknown as MidiSynthOutput);
        const clock = spyOn(TimeService.getInstance(), "nowMs").mockImplementation(() => now);
        const system = System.getInstance() as unknown as { process: unknown; fileSystem: unknown };
        const process = system.process, fs = system.fileSystem;
        system.process = {};
        system.fileSystem = { getFileSize: (p: string) => (p.toUpperCase().endsWith("GM.DLS") ? 100 : -1) };
        resetGmBankForTests();
        restore.push(() => { acquire.mockRestore(); clock.mockRestore(); system.process = process; system.fileSystem = fs; resetGmBankForTests(); });
    });
    afterEach(() => { while (restore.length) restore.pop()!(); });

    const PHMS = 0x11100, DEVID = 0x11104, PROP = 0x11110, MMT = 0x11120;
    const open = (midi: WinmmMidiOut): number => {
        view().setUint32(DEVID, 0, true);
        expect(midi.openStream(PHMS, DEVID, 1, 0x401000, 0x77, 0x30000)).toBe(0);
        return view().getUint32(PHMS, true);
    };
    const pump = (to: number): void => { now = to; for (const t of [...output.tickers]) t(now); };

    test("open, set the time division, queue a buffer, restart: the notes play and MOM_DONE comes back", () => {
        const midi = new WinmmMidiOut({ callFunction: (cb, args) => calls.push([cb, ...args]) });
        const h = open(midi);
        expect(h).not.toBe(0);
        expect(calls[0]).toEqual([0x401000, h, 0x3c7, 0x77, 0, 0]);
        view().setUint32(PROP, 8, true);
        view().setUint32(PROP + 4, 96, true);
        expect(midi.streamProperty(h, PROP, 0x80000001)).toBe(0);
        view().setUint32(PROP + 4, 0, true);
        expect(midi.streamProperty(h, PROP, 0x40000002)).toBe(0);
        expect(view().getUint32(PROP + 4, true)).toBe(500000);

        buffer(HDR, DATA, [[0, msg(0x90, 60, 100)], [96, msg(0x80, 60)]], 0);
        expect(midi.streamOut(h, HDR, 64)).toBe(64);
        expect(midi.prepare(h, HDR, 64, true)).toBe(0);
        expect(midi.streamOut(h, HDR, 64)).toBe(0);
        expect(view().getUint32(HDR + 16, true)).toBe(MHDR_PREPARED | MHDR_INQUEUE | MHDR_ISSTRM);
        expect(midi.streamOut(h, HDR, 64)).toBe(65);
        expect(output.router.pending).toBe(0);

        expect(midi.streamRestart(h)).toBe(0);
        expect(output.router.pending).toBe(1);
        pump(499);
        expect(output.router.pending).toBe(1);
        pump(500);
        expect(output.router.pending).toBe(2);
        expect(calls.at(-1)).toEqual([0x401000, h, 0x3c9, 0x77, HDR, 0]);
        expect(view().getUint32(HDR + 16, true) & (MHDR_DONE | MHDR_INQUEUE)).toBe(MHDR_DONE);

        view().setUint32(MMT, 0x20, true);
        expect(midi.streamPosition(h, MMT, 12)).toBe(0);
        expect(view().getUint32(MMT + 4, true)).toBe(96);
        view().setUint32(MMT, 0x4, true);
        expect(midi.streamPosition(h, MMT, 12)).toBe(0);
        expect([view().getUint32(MMT, true), view().getUint32(MMT + 4, true)]).toEqual([1, 500]);
    });

    test("close returns what is still queued, then MOM_CLOSE; the ticker goes away", () => {
        const midi = new WinmmMidiOut({ callFunction: (cb, args) => calls.push([cb, ...args]) });
        const h = open(midi);
        buffer(HDR, DATA, [[100000, msg(0x90, 60, 100)]]);
        expect(midi.streamOut(h, HDR, 64)).toBe(0);
        expect(output.tickers.size).toBe(1);
        expect(midi.streamClose(h)).toBe(0);
        expect(calls.slice(-2).map(c => [c[2], c[4]])).toEqual([[0x3c9, HDR], [0x3c8, 0]]);
        expect(output.tickers.size).toBe(0);
        expect(midi.streamClose(h)).toBe(5);
    });

    test("midiOutReset on a stream returns every queued buffer; unprepare then succeeds", () => {
        const midi = new WinmmMidiOut({ callFunction: (cb, args) => calls.push([cb, ...args]) });
        const h = open(midi);
        buffer(HDR, DATA, [[100000, msg(0x90, 60, 100)]], 0);
        buffer(HDR2, DATA2, [[0, msg(0x90, 62, 100)]], 0);
        for (const hdr of [HDR, HDR2]) {
            expect(midi.prepare(h, hdr, 64, true)).toBe(0);
            expect(midi.streamOut(h, hdr, 64)).toBe(0);
        }
        expect(midi.prepare(h, HDR, 64, false)).toBe(65);
        expect(midi.reset(h)).toBe(0);
        expect(calls.slice(-2).map(c => [c[2], c[4]])).toEqual([[0x3c9, HDR], [0x3c9, HDR2]]);
        for (const hdr of [HDR, HDR2]) {
            expect(view().getUint32(hdr + 16, true) & (MHDR_DONE | MHDR_INQUEUE)).toBe(MHDR_DONE);
            expect(midi.prepare(h, hdr, 64, false)).toBe(0);
        }
    });

    test("a buffer queued while playing starts at once, not on the next pump", () => {
        const midi = new WinmmMidiOut({ callFunction: () => undefined });
        const h = open(midi);
        expect(midi.streamRestart(h)).toBe(0);
        buffer(HDR, DATA, [[0, msg(0x90, 60, 100)]]);
        expect(midi.streamOut(h, HDR, 64)).toBe(0);
        expect(output.router.pending).toBe(1);
    });

    test("stream calls refuse a plain midiOut handle, and bad arguments", () => {
        const midi = new WinmmMidiOut({ callFunction: () => undefined });
        expect(midi.open(PHMS, 0, 0, 0, 0)).toBe(0);
        const plain = view().getUint32(PHMS, true);
        expect(midi.streamRestart(plain)).toBe(5);
        expect(midi.streamOut(plain, HDR, 64)).toBe(5);
        view().setUint32(DEVID, 0, true);
        expect(midi.openStream(PHMS, DEVID, 2, 0, 0, 0)).toBe(11);
        expect(view().getUint32(PHMS, true)).toBe(0);
        expect(midi.openStream(PHMS, 0, 1, 0, 0, 0)).toBe(11);
        const h = open(midi);
        view().setUint32(PROP, 8, true);
        expect(midi.streamProperty(h, PROP, 0xc0000001)).toBe(11);
        expect(midi.streamProperty(h, PROP, 0x80000004)).toBe(11);
        view().setUint32(PROP, 12, true);
        expect(midi.streamProperty(h, PROP, 0x80000001)).toBe(11);
        expect(midi.streamPosition(h, MMT, 8)).toBe(11);
    });

    test("an open stream refuses a savestate instead of dropping its queue", () => {
        const midi = new WinmmMidiOut({ callFunction: () => undefined });
        const h = open(midi);
        expect(() => midi.captureState()).toThrow(/MIDI stream is open/);
        midi.streamClose(h);
        expect(() => midi.captureState()).not.toThrow();
    });
});
