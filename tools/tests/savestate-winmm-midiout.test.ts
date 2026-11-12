import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { savestateParticipants, schemaHash } from "../../src/worker/savestate/participant";
import { currentGmBank, loadGmBank, resetGmBankForTests } from "../../src/worker/core/audio/gm-bank";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { TimeService } from "../../src/worker/runtime/time";
import { WinMM, WINMM_SCHEMA } from "../../src/worker/modules/winmm";
import { MIDI_HANDLE_FIELDS, MIDI_OUT_FIELDS, WinmmMidiOut, type MidiOutState } from "../../src/worker/modules/winmm-midi";
import { MIDI_OUTPUT_FIELDS, MidiSynthOutput } from "../../src/worker/modules/winmm-midi-synth";
import { ascii, chunk, i16, i32, list, riff, u16, u32 } from "./dmusic-fixtures";

const RATE = 44100;
const BLOCK = 4;
const SIZE = RATE * BLOCK * 2;
const DEVICE = 0x8000, BUFFER = 0x9000, DATA = 0x40000, PHMO = 0x11100, HDR = 0x12000, SYSEX = 0x13000;
const MOM_OPEN = 0x3c7, MOM_CLOSE = 0x3c8, MOM_DONE = 0x3c9;
const CALLBACK_FUNCTION = 0x30000;
const CALLBACK = 0x401000, INSTANCE = 0x77;

type Internals = Record<string, unknown>;
const msg = (status: number, d1: number, d2 = 0): number => status | (d1 << 8) | (d2 << 16);
const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};
const throughCodec = <T>(v: T): T => decodeValue(encodeValue(v as unknown as SaveValue)) as unknown as T;

function dls(): Uint8Array {
    const sine = new Int16Array(400), square = new Int16Array(400);
    for (let i = 0; i < 400; i++) {
        sine[i] = Math.round(Math.sin((2 * Math.PI * i) / 50) * 20000);
        square[i] = i % 40 < 20 ? 12000 : -12000;
    }
    const wave = (pcm: Int16Array): Uint8Array => list("wave",
        chunk("fmt ", u16(1, 1), u32(22050, 44100), u16(2, 16)),
        chunk("wsmp", u32(20), u16(60), i16(0), i32(0), u32(0, 1), u32(16, 0, 0, 400)),
        chunk("data", new Uint8Array(pcm.buffer)));
    const first = wave(sine), second = wave(square);
    const inst = (program: number, table: number, name: string): Uint8Array => list("ins ",
        chunk("insh", u32(1, 0, program)),
        list("lrgn", list("rgn ", chunk("rgnh", u16(0, 127, 0, 127, 0, 0)), chunk("wlnk", u16(0, 0), u32(1, table)))),
        list("INFO", chunk("INAM", ascii(`${name}\0`))));
    return riff("DLS ",
        chunk("colh", u32(2)),
        list("lins", inst(0, 0, "Piano"), inst(40, 1, "Violin")),
        chunk("ptbl", u32(8, 2), u32(0, first.length)),
        list("wvpl", first, second));
}

const BANK = dls();
const system = System.getInstance() as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const armed = new Map<number, number>();
let mem: Uint8Array;
let view: DataView;
let play = 0;
let nextAlloc = 0;
let nextWheel = 700;
let bankOnDisk = true;
let made: Record<string, number>;
let fetchSpy: { mockRestore(): void } | null = null;

const exports: Record<string, (ctx: unknown, m: Uint8Array, a: number[]) => number> = {
    directsoundcreate: (_c, _m, a) => { made.device!++; view.setUint32(a[1]!, DEVICE, true); return 0; },
    idirectsound8_createsoundbuffer: (_c, _m, a) => { made.buffer!++; view.setUint32(a[2]!, BUFFER, true); return 0; },
    idirectsound8_release: () => { made.deviceRelease!++; return 0; },
    idirectsoundbuffer8_release: () => { made.bufferRelease!++; return 0; },
    idirectsoundbuffer8_getcaps: (_c, _m, a) => { view.setUint32(a[1]! + 8, SIZE, true); return 0; },
    idirectsoundbuffer8_play: () => { made.play!++; return 0; },
    idirectsoundbuffer8_stop: () => { made.stop!++; return 0; },
    idirectsoundbuffer8_getcurrentposition: (_c, _m, a) => {
        view.setUint32(a[1]!, play, true);
        view.setUint32(a[2]!, play, true);
        return 0;
    },
    idirectsoundbuffer8_lock: (_c, _m, a) => {
        const offset = a[1]!, length = a[2]!;
        const first = Math.min(length, SIZE - offset);
        view.setUint32(a[3]!, DATA + offset, true);
        view.setUint32(a[4]!, first, true);
        view.setUint32(a[5]!, first < length ? DATA : 0, true);
        view.setUint32(a[6]!, length - first, true);
        return 0;
    },
    idirectsoundbuffer8_unlock: () => 0,
};

const process = {
    getModule: (name: string) => (name === "dsound" ? { exports } : undefined),
    getCurrentMemory: () => undefined,
    memory: { alloc: (size: number) => { const p = nextAlloc; nextAlloc += size; return p; }, free: () => undefined },
};

beforeAll(() => {
    for (const key of ["process", "fileSystem", "scheduler"]) saved[key] = system[key];
});
afterAll(() => {
    Object.assign(system, saved);
    TimeService.getInstance().setMode("realtime");
    resetGmBankForTests();
    MidiSynthOutput.discard();
});

beforeEach(async () => {
    mem = new Uint8Array(DATA + SIZE + 0x100);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    play = 0;
    nextAlloc = 0x20000;
    bankOnDisk = true;
    made = { device: 0, buffer: 0, deviceRelease: 0, bufferRelease: 0, play: 0, stop: 0 };
    armed.clear();
    system.process = process;
    system.fileSystem = {
        getFileSize: (p: string) => (bankOnDisk && p.toUpperCase().endsWith("SYSTEM32\\DRIVERS\\GM.DLS") ? BANK.length : -1),
        openSync: (p: string) => (bankOnDisk ? { path: p, at: 0 } : null),
        readSync: (h: { at: number }, n: number) => { const out = BANK.subarray(h.at, h.at + n); h.at += out.length; return out; },
    };
    system.scheduler = {
        timerWheel: {
            add: (_ms: number, _periodic: boolean, _kind: number, owner: number) => { armed.set(++nextWheel, owner); return nextWheel; },
            cancel: (id: number) => { armed.delete(id); },
        },
        notifyWinmmTimerThread: () => undefined,
    };
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("{}", { status: 200 })) as never);
    TimeService.getInstance().setManualTime(1000);
    MidiSynthOutput.discard();
    resetGmBankForTests();
    expect((await loadGmBank())?.instruments.length).toBe(2);
});
afterEach(() => { fetchSpy?.mockRestore(); });

function rig(flags = 0) {
    const calls: number[][] = [];
    const midi = new WinmmMidiOut({ callFunction: (cb, args) => calls.push([cb, ...args]) });
    expect(midi.open(PHMO, 0xffffffff, flags ? CALLBACK : 0, flags ? INSTANCE : 0, flags)).toBe(0);
    const h = view.getUint32(PHMO, true);
    return { midi, h, calls, output: MidiSynthOutput.active()! };
}

function pump(ms = 10): number[] {
    TimeService.getInstance().advanceByMs(ms);
    play = (play + Math.floor(RATE * ms / 1000) * BLOCK) % SIZE;
    const before = mem.slice(DATA, DATA + SIZE);
    (MidiSynthOutput.active() as unknown as { pump(): void }).pump();
    const out: number[] = [];
    const now = new Int16Array(mem.buffer, DATA, SIZE / 2), old = new Int16Array(before.buffer, 0, SIZE / 2);
    for (let i = 0; i < now.length; i++) if (now[i] !== old[i]) out.push(i, now[i]!);
    return out;
}

function setUp(r: ReturnType<typeof rig>): void {
    for (const m of [
        msg(0xc1, 40), msg(0xb1, 7, 50), msg(0xb1, 10, 20), msg(0xb1, 11, 90), msg(0xb1, 1, 30), msg(0xe1, 0, 0x50),
        msg(0xb1, 101, 0), msg(0xb1, 100, 0), msg(0xb1, 6, 12), msg(0xb2, 0, 3), msg(0xb2, 32, 4), msg(0xc2, 9),
    ]) expect(r.midi.shortMessage(r.h, m)).toBe(0);
    pump();
}

function reload(state: MidiOutState): { midi: WinmmMidiOut; calls: number[][]; done: void | Promise<void> } {
    const calls: number[][] = [];
    const midi = new WinmmMidiOut({ callFunction: (cb, args) => calls.push([cb, ...args]) });
    const done = midi.restoreState(throughCodec(state));
    return { midi, calls, done };
}

function snapshot() {
    const time = TimeService.getInstance().nowMs();
    return { time, play, pcm: mem.slice(DATA, DATA + SIZE) };
}
function rewind(s: ReturnType<typeof snapshot>): void {
    TimeService.getInstance().setManualTime(s.time);
    play = s.play;
    mem.set(s.pcm, DATA);
}

describe("winmm MIDI output savestate", () => {
    test("the channel state is identical after a restore and nothing is created twice", () => {
        const r = rig(CALLBACK_FUNCTION);
        r.midi.setVolume(r.h, 0x60008000);
        setUp(r);
        const state = r.midi.captureState();
        expect(state.output!.router.channels[1]).toEqual({ program: 40, bankMsb: 0, bankLsb: 0 });
        expect(state.output!.router.channels[2]).toEqual({ program: 9, bankMsb: 3, bankLsb: 4 });
        const wheel = [...armed.keys()];
        const before = { ...made };
        const fresh = reload(state);
        expect(fresh.done).toBeUndefined();
        expect(made).toEqual(before);
        expect([...armed.keys()]).toEqual(wheel);
        expect(fresh.calls).toEqual([]);
        expect(bytes(fresh.midi.captureState())).toBe(bytes(state));
        const out = MidiSynthOutput.active()!;
        expect(out).not.toBe(r.output);
        expect(out.router.channels).toEqual(r.output.router.channels);
        expect(out.router.volume).toBe(0x60008000);
        expect(out.router.patchFor(2)).toBe((3 << 16) | (4 << 8) | 9);
        expect(fresh.midi.getVolume(r.h, 0x11200)).toBe(0);
        expect(view.getUint32(0x11200, true)).toBe(0x60008000);
        expect(state.output!.pumpTimer).toBe(wheel[0]!);
        expect(state.output!.buffer).toBe(BUFFER);
    });

    test("a note sent after the restore sounds with the saved program and controllers", () => {
        const r = rig();
        setUp(r);
        const state = r.midi.captureState();
        const at = snapshot();
        r.midi.shortMessage(r.h, msg(0x91, 64, 110));
        const original = [...pump(), ...pump()];
        expect(original.length).toBeGreaterThan(100);

        rewind(at);
        const fresh = reload(state);
        fresh.midi.shortMessage(r.h, msg(0x91, 64, 110));
        expect([...pump(), ...pump()]).toEqual(original);

        rewind(at);
        const plain = reload({ ...state, output: { ...state.output!, router: rig().midi.captureState().output!.router } });
        plain.midi.shortMessage(r.h, msg(0x91, 64, 110));
        const other = [...pump(), ...pump()];
        expect(other.length).toBeGreaterThan(100);
        expect(other).not.toEqual(original);
    });

    test("a note that is sounding keeps sounding from where it was", () => {
        const r = rig();
        setUp(r);
        r.midi.shortMessage(r.h, msg(0x91, 60, 100));
        pump();
        pump();
        expect(r.output.router.synth.activeVoiceCount).toBe(1);
        const state = r.midi.captureState();
        expect(state.output!.router.synth.voices.length).toBe(1);
        const at = snapshot();
        const original = [...pump(), ...pump()];
        expect(original.length).toBeGreaterThan(100);

        rewind(at);
        const fresh = reload(state);
        expect(MidiSynthOutput.active()!.router.synth.activeVoiceCount).toBe(1);
        expect([...pump(), ...pump()]).toEqual(original);
        fresh.midi.shortMessage(r.h, msg(0x81, 60));
        for (let i = 0; i < 400; i++) pump();
        expect(MidiSynthOutput.active()!.router.synth.activeVoiceCount).toBe(0);

        rewind(at);
        reload({ ...state, output: { ...state.output!, router: { ...state.output!.router, synth: { ...state.output!.router.synth, voices: [] } } } });
        expect(pump()).toEqual([]);
    });

    test("short messages that were sent but not yet rendered are played after the restore", () => {
        const r = rig();
        setUp(r);
        r.midi.shortMessage(r.h, msg(0xc3, 40));
        TimeService.getInstance().advanceByMs(4);
        r.midi.shortMessage(r.h, msg(0x93, 62, 100));
        const state = r.midi.captureState();
        expect(state.output!.router.queue.map(e => [e.at, e.status, e.data1, e.data2])).toEqual([[-4, 0xc3, 40, 0], [0, 0x93, 62, 100]]);
        const at = snapshot();
        const original = pump();

        rewind(at);
        TimeService.getInstance().setManualTime(500000);
        const fresh = reload(state);
        expect(MidiSynthOutput.active()!.router.pending).toBe(2);
        TimeService.getInstance().advanceByMs(10);
        play = (play + Math.floor(RATE * 10 / 1000) * BLOCK) % SIZE;
        const before = mem.slice(DATA, DATA + SIZE);
        (MidiSynthOutput.active() as unknown as { pump(): void }).pump();
        const out: number[] = [];
        const now = new Int16Array(mem.buffer, DATA, SIZE / 2), old = new Int16Array(before.buffer, 0, SIZE / 2);
        for (let i = 0; i < now.length; i++) if (now[i] !== old[i]) out.push(i, now[i]!);
        expect(out).toEqual(original);
        expect(MidiSynthOutput.active()!.router.channels[3]!.program).toBe(40);
        expect(fresh.midi.openCount()).toBe(1);
    });

    test("a restore before the bank is loaded waits for it, then notes sound as saved", async () => {
        const r = rig();
        setUp(r);
        r.midi.shortMessage(r.h, msg(0x91, 60, 100));
        pump();
        const state = r.midi.captureState();
        expect(state.output!.router.bank).toBe(true);
        const at = snapshot();
        const original = [...pump(), ...pump()];

        rewind(at);
        resetGmBankForTests();
        expect(currentGmBank()).toBeNull();
        const fresh = reload(state);
        expect(fresh.done).toBeInstanceOf(Promise);
        expect(fresh.midi.openCount()).toBe(0);
        await fresh.done;
        expect(currentGmBank()).not.toBeNull();
        expect(fresh.midi.openCount()).toBe(1);
        expect([...pump(), ...pump()]).toEqual(original);
    });

    test("with no bank to load the channel state still comes back, and the saved program plays once a bank arrives", async () => {
        const r = rig();
        setUp(r);
        r.midi.shortMessage(r.h, msg(0x91, 60, 100));
        pump();
        const state = r.midi.captureState();
        const bank = currentGmBank()!;
        resetGmBankForTests();
        bankOnDisk = false;
        const fresh = reload(state);
        await fresh.done;
        const out = MidiSynthOutput.active()!;
        expect(currentGmBank()).toBeNull();
        expect(out.router.channels).toEqual(r.output.router.channels);
        expect(out.router.synth.activeVoiceCount).toBe(0);
        const again = fresh.midi.captureState().output!.router;
        expect(again.bank).toBe(false);
        expect(again.synth.channels.map(c => c.values)).toEqual(state.output!.router.synth.channels.map(c => c.values));
        fresh.midi.shortMessage(r.h, msg(0x91, 64, 110));
        expect(pump()).toEqual([]);

        const chosen: number[][] = [];
        const spy = spyOn(out.router.synth, "setInstrument");
        out.router.setBank(bank);
        for (const c of spy.mock.calls) chosen.push([c[0] as number, c[2] as number]);
        spy.mockRestore();
        expect(chosen).toContainEqual([1, 40]);
        expect(chosen).toContainEqual([2, (3 << 16) | (4 << 8) | 9]);
        fresh.midi.shortMessage(r.h, msg(0x91, 67, 110));
        expect(pump().length).toBeGreaterThan(100);
    });

    test("two handles share the synthesizer after a restore and the last close shuts it down", () => {
        const r = rig(CALLBACK_FUNCTION);
        expect(r.midi.open(PHMO + 4, 0, 0, 0, 0)).toBe(0);
        const second = view.getUint32(PHMO + 4, true);
        expect(made.buffer).toBe(1);
        const fresh = reload(r.midi.captureState());
        expect(fresh.midi.openCount()).toBe(2);
        expect(fresh.midi.open(PHMO + 8, 0, 0, 0, 0)).toBe(0);
        expect(view.getUint32(PHMO + 8, true)).toBe(second + 4);
        expect(fresh.midi.close(view.getUint32(PHMO + 8, true))).toBe(0);
        expect(fresh.midi.close(second)).toBe(0);
        expect(MidiSynthOutput.active()).not.toBeNull();
        expect(made.stop).toBe(0);
        expect(fresh.midi.close(r.h)).toBe(0);
        expect(fresh.calls).toEqual([[CALLBACK, r.h, MOM_CLOSE, INSTANCE, 0, 0]]);
        expect(MidiSynthOutput.active()).toBeNull();
        expect(made).toMatchObject({ buffer: 1, stop: 1, bufferRelease: 1 });
        expect(armed.size).toBe(0);
    });

    test("no open handle: the state is empty and a restore drops an output left open", () => {
        const idle = new WinmmMidiOut({ callFunction: () => undefined }).captureState();
        expect(idle).toEqual({ nextHandle: 0x5d000, handles: [], output: null });
        const r = rig();
        expect(r.midi.restoreState(throughCodec(idle))).toBeUndefined();
        expect(r.midi.openCount()).toBe(0);
        expect(MidiSynthOutput.active()).toBeNull();
        expect(made.stop + made.bufferRelease).toBe(0);
    });

    test("every saved value reaches the capture", () => {
        const r = rig(CALLBACK_FUNCTION);
        setUp(r);
        r.midi.shortMessage(r.h, msg(0x91, 60, 100));
        pump();
        r.midi.shortMessage(r.h, msg(0x91, 61, 100));
        const before = bytes(r.midi.captureState());
        const differs = () => bytes(r.midi.captureState()) !== before;
        const check = (name: string, change: () => void, undo: () => void) => {
            change();
            expect({ name, differs: differs() }).toEqual({ name, differs: true });
            undo();
            expect({ name, same: !differs() }).toEqual({ name, same: true });
        };
        const handle = r.midi.handles.get(r.h) as unknown as Record<string, number>;
        expect(Object.keys(handle).sort()).toEqual(Object.keys(MIDI_HANDLE_FIELDS).sort());
        for (const field of ["flags", "callback", "instance"]) check(field, () => { handle[field]! += 1; }, () => { handle[field]! -= 1; });
        const midi = r.midi as unknown as Record<string, number>;
        expect(Object.keys(midi).sort()).toEqual(Object.keys(MIDI_OUT_FIELDS).sort());
        check("nextHandle", () => { midi.nextHandle! += 4; }, () => { midi.nextHandle! -= 4; });
        const out = r.output as unknown as Record<string, number> & { sink: Record<string, number | boolean> };
        expect(Object.keys(out).sort()).toEqual(Object.keys(MIDI_OUTPUT_FIELDS).sort());
        for (const field of ["buffer", "pumpTimer", "lastPumpMs"]) check(field, () => { out[field]! += 1; }, () => { out[field]! -= 1; });
        for (const field of ["bufferBytes", "scratch", "writeOffset", "silentBytes"]) {
            check(`sink.${field}`, () => { (out.sink[field] as number) += 4; }, () => { (out.sink[field] as number) -= 4; });
        }
        check("sink.playing", () => { out.sink.playing = false; }, () => { out.sink.playing = true; });
        const router = r.output.router;
        check("volume", () => { router.volume -= 1; }, () => { router.volume += 1; });
        for (const field of ["program", "bankMsb", "bankLsb"] as const) {
            check(`channel.${field}`, () => { router.channels[5]![field] += 1; }, () => { router.channels[5]![field] -= 1; });
        }
        const queue = (router as unknown as { queue: Array<Record<string, number>> }).queue;
        for (const field of ["at", "status", "data1", "data2"]) check(`event.${field}`, () => { queue[0]![field]! += 1; }, () => { queue[0]![field]! -= 1; });
        const synth = router.synth as unknown as { masterGain: number; channels: Map<number, Record<string, number>>; voices: Array<Record<string, number>> };
        check("masterGain", () => { synth.masterGain /= 2; }, () => { synth.masterGain *= 2; });
        for (const field of ["volume", "expression", "pan", "modWheel", "pitchBend", "bendRangeCents", "rpn", "patch"]) {
            check(`synth channel ${field}`, () => { synth.channels.get(1)![field]! += 1; }, () => { synth.channels.get(1)![field]! -= 1; });
        }
        const voice = synth.voices.find(v => (v as unknown as { active: boolean }).active)!;
        for (const field of ["position", "age", "key"]) check(`voice ${field}`, () => { voice[field]! += 1; }, () => { voice[field]! -= 1; });
    });

    test("a sequencer playing through the synthesizer refuses by name", () => {
        const r = rig();
        const off = r.output.addTicker(() => undefined);
        expect(() => r.midi.captureState()).toThrow("winmm: a MIDI sequencer is playing through the synthesizer, which is not part of a v1 savestate");
        off();
        expect(() => r.midi.captureState()).not.toThrow();
    });
});

describe("winmm participant with MIDI output", () => {
    function module(): WinMM & Internals {
        const w = new WinMM() as WinMM & Internals;
        w.initialize({} as never);
        return w;
    }
    const call = (w: WinMM, name: string, args: number[]) =>
        (w.exports[name] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, args);
    const queued = (w: WinMM & Internals) => (w.pendingTimerCallbacks as Array<{ args?: number[] }>).slice(w.pendingTimerHead as number).map(cb => cb.args);
    const drain = (w: WinMM & Internals) => { w.pendingTimerCallbacks = []; w.pendingTimerHead = 0; };

    test("an open handle is saved with the module; a long message whose MOM_DONE is still queued refuses until it ran", () => {
        const w = module();
        expect(call(w, "midiOutOpen", [PHMO, 0xffffffff, CALLBACK, INSTANCE, CALLBACK_FUNCTION])).toBe(0);
        const h = view.getUint32(PHMO, true);
        expect(queued(w)).toEqual([[h, MOM_OPEN, INSTANCE, 0, 0]]);
        const refusal = "winmm: a MIDI output callback (MOM_OPEN, MOM_CLOSE or MOM_DONE) is queued or running; try saving again";
        expect(() => w.captureSavestate()).toThrow(refusal);
        drain(w);
        expect(() => w.captureSavestate()).not.toThrow();

        call(w, "midiOutShortMsg", [h, msg(0xc1, 40)]);
        pump();
        mem.set([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7], SYSEX);
        view.setUint32(HDR, SYSEX, true);
        view.setUint32(HDR + 4, 6, true);
        expect(call(w, "midiOutPrepareHeader", [h, HDR, 48])).toBe(0);
        expect(call(w, "midiOutLongMsg", [h, HDR, 48])).toBe(0);
        expect(queued(w)).toEqual([[h, MOM_DONE, INSTANCE, HDR, 0]]);
        expect(() => w.captureSavestate()).toThrow(refusal);
        w.dispatchingPosted = (w.pendingTimerCallbacks as unknown[])[0];
        drain(w);
        expect(() => w.captureSavestate()).toThrow(refusal);
        w.dispatchingPosted = null;

        const state = w.captureSavestate();
        expect(view.getUint32(HDR + 16, true) & 7).toBe(3);
        expect(state.midiOut!.handles).toEqual([{ handle: h, flags: CALLBACK_FUNCTION, callback: CALLBACK, instance: INSTANCE }]);
        expect(state.midiOut!.output!.router.channels[1]!.program).toBe(0);

        const fresh = module();
        expect(fresh.restoreSavestate(throughCodec(state))).toBeUndefined();
        expect(bytes(fresh.captureSavestate())).toBe(bytes(state));
        expect(call(fresh, "midiOutShortMsg", [h, msg(0x90, 60, 100)])).toBe(0);
        expect(pump().length).toBeGreaterThan(100);
        expect(call(fresh, "midiOutClose", [h])).toBe(0);
        expect(queued(fresh)).toEqual([[h, MOM_CLOSE, INSTANCE, 0, 0]]);
    });

    test("negative control: a queued multimedia timer callback keeps its own refusal", () => {
        const w = module();
        (w.pendingTimerCallbacks as unknown[]).push({ callbackAddr: 1, timerId: 3, dwUser: 0 });
        expect(() => w.captureSavestate()).toThrow("multimedia timer callback");
        expect(() => w.captureSavestate()).not.toThrow("MIDI");
    });

    test("an open MCI device still refuses", () => {
        const w = module();
        w.mci = { openDeviceCount: () => 1 };
        expect(() => w.captureSavestate()).toThrow("winmm: open MCI devices are not part of a v1 savestate");
    });

    test("version 4 with a pinned schema", () => {
        const w = new WinMM();
        const off = w.registerSavestate();
        try {
            expect(savestateParticipants.all().find(x => x.id === "winmm")!.version).toBe(4);
            expect(schemaHash(WINMM_SCHEMA as unknown as SaveValue)).toBe("b4123d23bf913087");
        } finally {
            off();
        }
    });
});
