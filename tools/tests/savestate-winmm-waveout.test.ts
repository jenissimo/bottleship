import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { savestateParticipants, schemaHash } from "../../src/worker/savestate/participant";
import { CaptureRefusal, newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { System } from "../../src/worker/core/system";
import { WinMM, WAVEOUT_DEVICE_FIELDS, WINMM_SCHEMA, type WaveOutDevice, type WinMMState } from "../../src/worker/modules/winmm";
import {
    CTRL_BLOCK_BYTES, CTRL_DATA_LENGTH, CTRL_LOOP_MODE, CTRL_PAN, CTRL_PLAY_CURSOR, CTRL_RESERVED, CTRL_STATE, CTRL_VOLUME,
    CTRL_WRITE_CURSOR, STATE_PLAYING, STATE_STOPPED, getCtrl, setCtrl,
} from "../../src/audio/audio-ring-buffer";

const WOM_DONE = 0x3bd;
const CALLBACK_FUNCTION = 0x30000;
const WHDR_DONE = 1, WHDR_PREPARED = 2, WHDR_BEGINLOOP = 4, WHDR_ENDLOOP = 8, WHDR_INQUEUE = 16;
const TIME_MS = 1, TIME_SAMPLES = 2, TIME_BYTES = 4;
const PWFX = 0x100, PHWO = 0x200, MMTIME = 0x240, HDR = 0x300, DATA = 0x1000, WAV = 0x20000;
const LEN = 8000;
const CALLBACK = 0x401000, INSTANCE = 0x77;

type Internals = Record<string, unknown>;
type Module = WinMM & Internals;
type Posted = { type: string; payload?: { id?: number; sab?: SharedArrayBuffer } };
type Queued = { args?: number[]; timerId: number };

const rings = new Map<number, SharedArrayBuffer>();
const posted: Posted[] = [];
const armed = new Map<number, number>();
const system = System.getInstance() as unknown as Record<string, unknown>;
let savedSelf: PropertyDescriptor | undefined;
let savedScheduler: unknown;
let savedProcess: unknown;
let nextWheel = 500;

beforeAll(() => {
    savedSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
    Object.defineProperty(globalThis, "self", {
        configurable: true, writable: true,
        value: {
            postMessage(msg: Posted) {
                posted.push(msg);
                if (msg.type === "audio_register") rings.set(msg.payload!.id!, msg.payload!.sab!);
                if (msg.type === "audio_unregister") rings.delete(msg.payload!.id!);
            },
        },
    });
});

afterAll(() => {
    if (savedSelf) Object.defineProperty(globalThis, "self", savedSelf);
    else Reflect.deleteProperty(globalThis, "self");
});

beforeEach(() => {
    rings.clear();
    posted.length = 0;
    armed.clear();
    savedScheduler = system.scheduler;
    savedProcess = system.process;
    system.process = null;
    system.scheduler = {
        timerWheel: {
            add: (_ms: number, _periodic: boolean, _kind: number, owner: number) => { armed.set(++nextWheel, owner); return nextWheel; },
            cancel: (id: number) => { armed.delete(id); },
        },
        notifyWinmmTimerThread: () => undefined,
    };
});
afterEach(() => {
    system.scheduler = savedScheduler;
    system.process = savedProcess;
});

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};
const throughCodec = <T>(v: T): T => {
    const e = encodeValue(v as unknown as SaveValue);
    return decodeValue(e) as unknown as T;
};

function guest(): Uint8Array {
    const mem = new Uint8Array(0x40000);
    const v = new DataView(mem.buffer);
    v.setUint16(PWFX, 1, true);
    v.setUint16(PWFX + 2, 1, true);
    v.setUint32(PWFX + 4, 22050, true);
    v.setUint32(PWFX + 8, 44100, true);
    v.setUint16(PWFX + 12, 2, true);
    v.setUint16(PWFX + 14, 16, true);
    for (let i = 0; i < 4 * LEN; i++) mem[DATA + i] = (i * 7 + (i >> 8) * 13 + 1) & 0xff;
    return mem;
}

function moduleOn(mem: Uint8Array): Module {
    const w = new WinMM() as Module;
    w.initialize({} as never);
    w.guestMemory = () => mem;
    return w;
}

function rig(flags = 0) {
    const mem = guest();
    const v = new DataView(mem.buffer);
    const w = moduleOn(mem);
    const call = (m: Module, name: string, args: number[]) =>
        (m.exports[name] as (c: unknown, mem: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, args);
    expect(call(w, "waveOutOpen", [PHWO, 0, PWFX, flags ? CALLBACK : 0, flags ? INSTANCE : 0, flags])).toBe(0);
    const hwo = v.getUint32(PHWO, true);
    const header = (i: number) => HDR + i * 0x20;
    const write = (m: Module, i: number, length = LEN, headerFlags = WHDR_PREPARED) => {
        v.setUint32(header(i), DATA + i * LEN, true);
        v.setUint32(header(i) + 4, length, true);
        v.setUint32(header(i) + 16, headerFlags, true);
        return call(m, "waveOutWrite", [hwo, header(i), 32]);
    };
    const device = (m: Module) => (m.waveOutDevices as Map<number, WaveOutDevice>).get(hwo)!;
    const play = (m: Module, cursor: number) => setCtrl(device(m).sab!, CTRL_PLAY_CURSOR, cursor);
    const poll = (m: Module) => (m.checkCompletions as (d: WaveOutDevice) => void).call(m, device(m));
    const done = (m: Module) => (m.pendingTimerCallbacks as Queued[]).slice(m.pendingTimerHead as number).map(cb => cb.args);
    const drain = (m: Module) => { m.pendingTimerCallbacks = []; m.pendingTimerHead = 0; };
    const position = (m: Module, type: number) => {
        v.setUint32(MMTIME, type, true);
        expect(call(m, "waveOutGetPosition", [hwo, MMTIME, 12])).toBe(0);
        return v.getUint32(MMTIME + 4, true);
    };
    const ring = (m: Module, from: number, to: number) => [...new Uint8Array(device(m).sab!, CTRL_BLOCK_BYTES + from, to - from)];
    const reload = (state: WinMMState, target: Uint8Array = mem) => {
        const fresh = moduleOn(target);
        fresh.restoreSavestate(throughCodec(state));
        return fresh;
    };
    const flagsOf = (i: number) => v.getUint32(header(i) + 16, true);
    return { mem, v, w, hwo, call, header, write, device, play, poll, done, drain, position, ring, reload, flagsOf };
}

describe("winmm waveOut savestate", () => {
    test("three queued headers, the first half played: the ring, the position and one WOM_DONE per header", () => {
        const r = rig(CALLBACK_FUNCTION);
        r.call(r.w, "waveOutSetVolume", [r.hwo, 0x4000_8000]);
        for (let i = 0; i < 3; i++) expect(r.write(r.w, i)).toBe(0);
        r.play(r.w, LEN / 2);
        const state = r.w.captureSavestate();
        const original = r.ring(r.w, LEN / 2, 3 * LEN);
        const fresh = r.reload(state);

        expect(bytes(fresh.captureSavestate())).toBe(bytes(state));
        const sab = r.device(fresh).sab!;
        expect(sab).not.toBe(r.device(r.w).sab);
        expect(rings.get(r.hwo)).toBe(sab);
        expect(r.ring(fresh, LEN / 2, 3 * LEN)).toEqual(original);
        expect(original).toEqual([...r.mem.subarray(DATA + LEN / 2, DATA + 3 * LEN)]);
        expect(getCtrl(sab, CTRL_PLAY_CURSOR)).toBe(LEN / 2);
        expect(getCtrl(sab, CTRL_RESERVED)).toBe(1);
        expect(getCtrl(sab, CTRL_WRITE_CURSOR)).toBe(3 * LEN);
        expect(getCtrl(sab, CTRL_STATE)).toBe(STATE_PLAYING);
        expect(getCtrl(sab, CTRL_LOOP_MODE)).toBe(-1);
        expect(getCtrl(sab, CTRL_VOLUME)).toBe(getCtrl(r.device(r.w).sab!, CTRL_VOLUME));
        expect(getCtrl(sab, CTRL_VOLUME)).not.toBe(0);
        expect(getCtrl(sab, CTRL_PAN)).toBe(getCtrl(r.device(r.w).sab!, CTRL_PAN));
        expect(getCtrl(sab, CTRL_PAN)).not.toBe(0);
        expect(r.device(fresh).completionPollerId).toBe(r.device(r.w).completionPollerId);
        expect(r.device(fresh).completionPollerId).not.toBe(0);
        expect([...armed.values()].filter(o => o === r.hwo).length).toBe(1);

        expect(r.position(fresh, TIME_BYTES)).toBe(LEN / 2);
        expect(r.position(fresh, TIME_SAMPLES)).toBe(LEN / 4);
        expect(r.position(fresh, TIME_MS)).toBe(Math.floor(LEN / 2 / 44100 * 1000));
        r.play(fresh, LEN / 2 + 1000);
        expect(r.position(fresh, TIME_BYTES)).toBe(LEN / 2 + 1000);

        const seen: Array<number[] | undefined> = [];
        for (const cursor of [LEN, 2 * LEN, 3 * LEN, 3 * LEN]) {
            r.play(fresh, cursor);
            r.poll(fresh);
            r.poll(fresh);
            seen.push(...r.done(fresh));
            r.drain(fresh);
        }
        expect(seen).toEqual([0, 1, 2].map(i => [r.hwo, WOM_DONE, INSTANCE, r.header(i), 0]));
        for (let i = 0; i < 3; i++) expect(r.flagsOf(i) & (WHDR_DONE | WHDR_INQUEUE)).toBe(WHDR_DONE);
        expect(r.position(fresh, TIME_BYTES)).toBe(3 * LEN);
    });

    test("negative control: without the saved queue no WOM_DONE is delivered", () => {
        const r = rig(CALLBACK_FUNCTION);
        for (let i = 0; i < 3; i++) r.write(r.w, i);
        r.play(r.w, LEN / 2);
        const state = r.w.captureSavestate();
        state.waveOut[0]!.fields.pendingBuffers = [];
        const fresh = r.reload(state);
        r.play(fresh, 3 * LEN);
        r.poll(fresh);
        expect(r.done(fresh)).toEqual([]);
        expect(r.ring(fresh, LEN, 3 * LEN).every(b => b === 0)).toBe(true);
    });

    test("audio of a header that already completed early is kept, even after the guest reused its buffer", () => {
        const r = rig();
        for (let i = 0; i < 3; i++) r.write(r.w, i);
        r.play(r.w, LEN - 2000);
        r.poll(r.w);
        expect(r.flagsOf(0) & WHDR_DONE).toBe(WHDR_DONE);
        const original = r.ring(r.w, LEN - 2000, 3 * LEN);
        const state = r.w.captureSavestate();
        expect(state.waveOut[0]!.tail.length).toBe(2000);
        expect(state.waveOut[0]!.fields.pendingBuffers.map(p => p.pwh)).toEqual([r.header(1), r.header(2)]);
        r.mem.fill(0xee, DATA, DATA + LEN);

        const fresh = r.reload(state);
        expect(r.ring(fresh, LEN - 2000, 3 * LEN)).toEqual(original);
        r.play(fresh, 3 * LEN);
        r.poll(fresh);
        expect(r.flagsOf(1) & r.flagsOf(2) & WHDR_DONE).toBe(WHDR_DONE);
        expect(r.device(fresh).pendingBuffers).toEqual([]);

        const cut = { ...state, waveOut: [{ ...state.waveOut[0]!, tail: new Uint8Array(0) }] };
        expect(r.ring(r.reload(cut), LEN - 2000, LEN).every(b => b === 0)).toBe(true);
    });

    test("a paused device stays paused, keeps its position and restarts", () => {
        const r = rig();
        r.write(r.w, 0);
        r.play(r.w, 1000);
        expect(r.call(r.w, "waveOutPause", [r.hwo])).toBe(0);
        const state = r.w.captureSavestate();
        expect(state.waveOut[0]!.fields.isPlaying).toBe(false);
        const fresh = r.reload(state);
        const sab = r.device(fresh).sab!;
        expect(getCtrl(sab, CTRL_STATE)).toBe(STATE_STOPPED);
        expect(getCtrl(sab, CTRL_PLAY_CURSOR)).toBe(1000);
        expect(r.position(fresh, TIME_BYTES)).toBe(1000);
        expect(r.call(fresh, "waveOutRestart", [r.hwo])).toBe(0);
        expect(getCtrl(sab, CTRL_STATE)).toBe(STATE_PLAYING);
        expect(r.ring(fresh, 1000, LEN)).toEqual([...r.mem.subarray(DATA + 1000, DATA + LEN)]);
    });

    test("a header flagged as a loop keeps its flags in guest memory and completes once", () => {
        const r = rig(CALLBACK_FUNCTION);
        r.v.setUint32(r.header(0) + 20, 3, true);
        r.write(r.w, 0, LEN, WHDR_PREPARED | WHDR_BEGINLOOP | WHDR_ENDLOOP);
        r.play(r.w, 2000);
        const fresh = r.reload(r.w.captureSavestate());
        expect(r.flagsOf(0)).toBe(WHDR_PREPARED | WHDR_BEGINLOOP | WHDR_ENDLOOP | WHDR_INQUEUE);
        expect(r.v.getUint32(r.header(0) + 20, true)).toBe(3);
        r.play(fresh, LEN);
        r.poll(fresh);
        r.poll(fresh);
        expect(r.done(fresh)).toEqual([[r.hwo, WOM_DONE, INSTANCE, r.header(0), 0]]);
    });

    test("a device that is open with nothing written comes back idle and takes a first buffer", () => {
        const r = rig(CALLBACK_FUNCTION);
        const state = r.w.captureSavestate();
        expect(state.waveOut.length).toBe(1);
        expect(state.waveOut[0]!.fields.completionPollerId).toBe(0);
        const fresh = r.reload(state);
        expect(bytes(fresh.captureSavestate())).toBe(bytes(state));
        expect(r.device(fresh).completionPollerId).toBe(0);
        expect(getCtrl(r.device(fresh).sab!, CTRL_STATE)).toBe(STATE_STOPPED);
        expect(r.write(fresh, 0)).toBe(0);
        expect(r.ring(fresh, 0, LEN)).toEqual([...r.mem.subarray(DATA, DATA + LEN)]);
        expect(getCtrl(r.device(fresh).sab!, CTRL_STATE)).toBe(STATE_PLAYING);
        expect((fresh.nextWaveOutId as number)).toBe(r.hwo + 1);
    });

    test("everything already played in the worklet but not yet reported: each header still completes once, in order", () => {
        const r = rig(CALLBACK_FUNCTION);
        for (let i = 0; i < 3; i++) r.write(r.w, i);
        r.play(r.w, 3 * LEN);
        const state = r.w.captureSavestate();
        expect(state.waveOut[0]!.fields.playedBytes).toBe(3 * LEN);
        expect(state.waveOut[0]!.fields.pendingBuffers.length).toBe(3);
        const fresh = r.reload(state);
        r.poll(fresh);
        r.poll(fresh);
        expect(r.done(fresh)).toEqual([0, 1, 2].map(i => [r.hwo, WOM_DONE, INSTANCE, r.header(i), 0]));
        expect(r.position(fresh, TIME_BYTES)).toBe(3 * LEN);
    });

    function feeding() {
        const r = rig(CALLBACK_FUNCTION);
        const SMALL = 4000;
        const wakes: number[] = [];
        (system.scheduler as Record<string, unknown>).setEvent = (h: number) => { wakes.push(h); };
        r.w.timerWakeEvent = 0x66;
        for (let i = 0; i < 4; i++) r.write(r.w, i, SMALL);
        let played = 0;
        const step = (m: Module, delivered: number[]) => {
            played += 1000;
            r.play(m, played % 131072);
            r.poll(m);
            for (;;) {
                const cb = (m.shiftPendingCallback as () => { args?: number[]; callbackAddr: number } | undefined).call(m);
                if (!cb) break;
                expect(cb.callbackAddr).toBe(CALLBACK);
                expect(cb.args!.slice(0, 3)).toEqual([r.hwo, WOM_DONE, INSTANCE]);
                const index = (cb.args![3]! - HDR) / 0x20;
                delivered.push(index);
                expect(r.write(m, index, SMALL)).toBe(0);
            }
        };
        const until = (m: Module, delivered: number[], queued: number) => {
            for (let i = 0; i < 400 && r.done(m).length < queued; i++) {
                played += 1000;
                r.play(m, played % 131072);
                r.poll(m);
                if (r.done(m).length < queued) step(m, delivered);
            }
        };
        return { r, step, until, wakes, rewind: (to: number) => { played = to; }, at: () => played };
    }

    test("a title that refeeds in WOM_DONE saves while a completion is queued; it is delivered once and the chain goes on", () => {
        const f = feeding();
        const lead: number[] = [];
        for (let i = 0; i < 9; i++) f.step(f.r.w, lead);
        f.until(f.r.w, lead, 1);
        expect(f.r.done(f.r.w).length).toBe(1);
        const queuedHeader = (f.r.done(f.r.w)[0]![3]! - HDR) / 0x20;
        const state = f.r.w.captureSavestate();
        expect(state.waveDone).toEqual([{ callback: CALLBACK, args: [f.r.hwo, WOM_DONE, INSTANCE, f.r.header(queuedHeader), 0] }]);
        expect(state.waveOut[0]!.fields.pendingBuffers.map(p => p.pwh)).not.toContain(f.r.header(queuedHeader));
        const at = f.at();
        const guestThen = f.r.mem.slice(0, 0x1000);

        const original: number[] = [];
        for (let i = 0; i < 60; i++) f.step(f.r.w, original);
        expect(original[0]).toBe(queuedHeader);
        expect(original.length).toBeGreaterThan(12);
        for (let i = 0; i < original.length; i++) expect(original[i]).toBe((queuedHeader + i) % 4);

        f.rewind(at);
        f.r.mem.set(guestThen, 0);
        f.wakes.length = 0;
        const fresh = f.r.reload(state);
        fresh.timerWakeEvent = 0x66;
        expect(f.wakes).toEqual([0x66]);
        expect(f.r.done(fresh)).toEqual([[f.r.hwo, WOM_DONE, INSTANCE, f.r.header(queuedHeader), 0]]);
        expect(bytes(fresh.captureSavestate())).toBe(bytes(state));
        const restored: number[] = [];
        for (let i = 0; i < 60; i++) f.step(fresh, restored);
        expect(restored).toEqual(original);

        f.rewind(at);
        f.r.mem.set(guestThen, 0);
        const lost = f.r.reload({ ...state, waveDone: [] });
        const broken: number[] = [];
        for (let i = 0; i < 60; i++) f.step(lost, broken);
        expect(broken).not.toContain(queuedHeader);
        expect(new Set(broken).size).toBe(3);
        expect(broken).not.toEqual(original);
    });

    test("a restore without a queued completion does not wake the callback thread", () => {
        const f = feeding();
        f.r.drain(f.r.w);
        f.wakes.length = 0;
        f.r.reload(f.r.w.captureSavestate());
        expect(f.wakes).toEqual([]);
    });

    test("a queued timer or posted callback still refuses, also next to a queued completion", () => {
        const r = rig(CALLBACK_FUNCTION);
        for (let i = 0; i < 3; i++) r.write(r.w, i);
        r.play(r.w, LEN);
        r.poll(r.w);
        expect(r.done(r.w).length).toBe(1);
        expect(() => r.w.captureSavestate()).not.toThrow();
        const refusal = "winmm: a multimedia timer callback is queued or running; try saving again";
        (r.w.pendingTimerCallbacks as Queued[]).push({ timerId: 3 });
        expect(() => r.w.captureSavestate()).toThrow(refusal);
        (r.w.pendingTimerCallbacks as Queued[]).pop();
        (r.w.pendingTimerCallbacks as Array<Record<string, unknown>>).push({ timerId: 0, args: [r.hwo, WOM_DONE, 0, 0, 0], onReturn: () => undefined });
        expect(() => r.w.captureSavestate()).toThrow(refusal);
        (r.w.pendingTimerCallbacks as Queued[]).pop();
        r.w.dispatchingPosted = { timerId: 0 };
        expect(() => r.w.captureSavestate()).toThrow(refusal);
        r.w.dispatchingPosted = null;
        expect(() => r.w.captureSavestate()).not.toThrow();
    });

    test("a single buffer the guest keeps rewriting is refilled from guest memory as it is now", () => {
        const r = rig();
        r.write(r.w, 0, 4000);
        r.play(r.w, 1200);
        (r.w.syncGuestToSab as (d: WaveOutDevice) => void).call(r.w, r.device(r.w));
        const state = r.w.captureSavestate();
        expect(state.waveOut[0]!.tail.length).toBe(0);
        expect(state.waveOut[0]!.dataLength).toBe(4000);
        r.mem.fill(0x5a, DATA, DATA + 4000);
        const fresh = r.reload(state);
        const sab = r.device(fresh).sab!;
        expect(r.ring(fresh, 0, 4000).every(b => b === 0x5a)).toBe(true);
        expect(getCtrl(sab, CTRL_DATA_LENGTH)).toBe(4000);
        expect(getCtrl(sab, CTRL_PLAY_CURSOR)).toBe(1200);
        expect(getCtrl(sab, CTRL_WRITE_CURSOR)).toBe(getCtrl(r.device(r.w).sab!, CTRL_WRITE_CURSOR));
        expect(r.device(fresh).guestLpData).toBe(DATA);
        expect(r.device(fresh).multiBuffer).toBe(false);
    });

    test("every saved device field and every ring value reaches the capture", () => {
        const r = rig(CALLBACK_FUNCTION);
        for (let i = 0; i < 2; i++) r.write(r.w, i);
        r.play(r.w, 4000);
        const before = bytes(r.w.captureSavestate());
        const d = r.device(r.w) as unknown as Record<string, unknown>;
        expect(Object.keys(d).sort()).toEqual(Object.keys(WAVEOUT_DEVICE_FIELDS).sort());
        const differs = () => bytes(r.w.captureSavestate()) !== before;
        for (const [field, policy] of Object.entries(WAVEOUT_DEVICE_FIELDS)) {
            if (policy !== "save" || field === "id") continue;
            const old = d[field];
            if (field === "format") d[field] = { ...(old as object), sampleRate: 11025 };
            else if (field === "pendingBuffers") d[field] = [...(old as unknown[]), { pwh: 1, data: 2, length: 3, endOffset: 4 }];
            else if (field === "guestLpData") { d.guestLpData = DATA; }
            else d[field] = typeof old === "number" ? old + 2 : !old;
            expect({ field, differs: differs() }).toEqual({ field, differs: true });
            d[field] = old;
            if (field === "lastPlayCursor") d.playedBytes = 4000;
            expect({ field, restored: !differs() }).toEqual({ field, restored: true });
        }
        const sab = r.device(r.w).sab!;
        for (const [name, slot] of [["writeCursor", CTRL_WRITE_CURSOR], ["dataLength", CTRL_DATA_LENGTH], ["loopMode", CTRL_LOOP_MODE], ["volume", CTRL_VOLUME], ["pan", CTRL_PAN]] as const) {
            const old = getCtrl(sab, slot);
            setCtrl(sab, slot, old - 2);
            expect({ name, differs: differs() }).toEqual({ name, differs: true });
            setCtrl(sab, slot, old);
        }
        for (const row of ["header data", "header length", "header end"] as const) {
            const p = r.device(r.w).pendingBuffers[1]!;
            const key = row === "header data" ? "data" : row === "header length" ? "length" : "endOffset";
            p[key] += 2;
            expect({ row, differs: differs() }).toEqual({ row, differs: true });
            p[key] -= 2;
        }
    });

    test("a queued buffer that is no longer in guest memory fails the restore by name", () => {
        const r = rig();
        r.write(r.w, 0);
        const state = r.w.captureSavestate();
        expect(() => r.reload(state, new Uint8Array(DATA + 100)))
            .toThrow(`winmm: a queued buffer of waveOut device 0x${r.hwo.toString(16)} at 0x${DATA.toString(16)} (${LEN} bytes) is not in guest memory`);
    });

    test("fifty rounds of open, write, reset and close leave no ring, poller or device behind", () => {
        const r = rig(CALLBACK_FUNCTION);
        r.call(r.w, "waveOutClose", [r.hwo]);
        r.drain(r.w);
        const count = () => ({ rings: rings.size, pollers: armed.size, devices: (r.w.waveOutDevices as Map<number, unknown>).size, queued: r.done(r.w).length });
        const before = count();
        expect(before).toEqual({ rings: 0, pollers: 0, devices: 0, queued: 0 });
        for (let round = 0; round < 50; round++) {
            expect(r.call(r.w, "waveOutOpen", [PHWO, 0, PWFX, CALLBACK, INSTANCE, CALLBACK_FUNCTION])).toBe(0);
            const hwo = r.v.getUint32(PHWO, true);
            for (let i = 0; i < 3; i++) {
                r.v.setUint32(r.header(i), DATA + i * LEN, true);
                r.v.setUint32(r.header(i) + 4, LEN, true);
                r.v.setUint32(r.header(i) + 16, WHDR_PREPARED, true);
                expect(r.call(r.w, "waveOutWrite", [hwo, r.header(i), 32])).toBe(0);
            }
            if (round % 2) {
                const fresh = r.w.captureSavestate();
                r.w.restoreSavestate(throughCodec(fresh));
            }
            expect(r.call(r.w, "waveOutReset", [hwo])).toBe(0);
            expect(r.call(r.w, "waveOutClose", [hwo])).toBe(0);
            r.drain(r.w);
        }
        expect(count()).toEqual(before);
        expect(posted.filter(m => m.type === "audio_register").length - posted.filter(m => m.type === "audio_unregister").length).toBe(0);
    });

    test("a restore replaces the devices that are open, unregisters their rings and leaves the restored timer wheel alone", () => {
        const r = rig();
        r.write(r.w, 0);
        const state = r.w.captureSavestate();
        const old = r.device(r.w).sab;
        const poller = r.device(r.w).completionPollerId;
        r.w.restoreSavestate(throughCodec(state));
        expect(r.device(r.w).sab).not.toBe(old);
        expect(armed.has(poller)).toBe(true);
        expect(r.device(r.w).completionPollerId).toBe(poller);
        expect(armed.size).toBe(1);
        expect(posted.filter(m => m.type === "audio_unregister" && m.payload?.id === r.hwo).length).toBe(1);
        expect(rings.get(r.hwo)).toBe(r.device(r.w).sab!);
    });
});

describe("winmm PlaySound savestate", () => {
    function wav(mem: Uint8Array, samples: number): void {
        const v = new DataView(mem.buffer);
        const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); };
        text(WAV, "RIFF");
        v.setUint32(WAV + 4, 36 + samples, true);
        text(WAV + 8, "WAVEfmt ");
        v.setUint32(WAV + 16, 16, true);
        v.setUint16(WAV + 20, 1, true);
        v.setUint16(WAV + 22, 1, true);
        v.setUint32(WAV + 24, 11025, true);
        v.setUint32(WAV + 28, 11025, true);
        v.setUint16(WAV + 32, 1, true);
        v.setUint16(WAV + 34, 8, true);
        text(WAV + 36, "data");
        v.setUint32(WAV + 40, samples, true);
        for (let i = 0; i < samples; i++) mem[WAV + 44 + i] = (i * 5 + 3) & 0xff;
    }

    function playing(flags: number) {
        const mem = guest();
        wav(mem, 6000);
        const w = moduleOn(mem);
        const result = (w.exports["PlaySoundA"] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, [WAV, 0, flags]);
        expect(result).toBe(1);
        return { mem, w, sab: w.playSoundSab as SharedArrayBuffer, id: w.playSoundId as number };
    }

    test("a sound that is playing continues from its cursor with the same samples, after the guest freed the image", () => {
        const p = playing(0x4 | 0x1);
        setCtrl(p.sab, CTRL_PLAY_CURSOR, 2500);
        const state = p.w.captureSavestate();
        expect(state.playSound?.pcm.length).toBe(6000);
        p.mem.fill(0, WAV, WAV + 7000);
        const fresh = moduleOn(p.mem);
        fresh.restoreSavestate(throughCodec(state));
        const sab = fresh.playSoundSab as SharedArrayBuffer;
        expect(rings.get(p.id)).toBe(sab);
        expect(fresh.playSoundId).toBe(p.id);
        expect([...new Uint8Array(sab, CTRL_BLOCK_BYTES, 6000)]).toEqual([...new Uint8Array(p.sab, CTRL_BLOCK_BYTES, 6000)]);
        expect(getCtrl(sab, CTRL_PLAY_CURSOR)).toBe(2500);
        expect(getCtrl(sab, CTRL_RESERVED)).toBe(1);
        expect(getCtrl(sab, CTRL_DATA_LENGTH)).toBe(6000);
        expect(getCtrl(sab, CTRL_LOOP_MODE)).toBe(1);
        expect(getCtrl(sab, CTRL_STATE)).toBe(STATE_PLAYING);
        expect(bytes(fresh.captureSavestate())).toBe(bytes(state));
    });

    test("a looping sound keeps looping", () => {
        const p = playing(0x4 | 0x1 | 0x8);
        const fresh = moduleOn(p.mem);
        fresh.restoreSavestate(throughCodec(p.w.captureSavestate()));
        expect(getCtrl(fresh.playSoundSab as SharedArrayBuffer, CTRL_LOOP_MODE)).toBe(-1);
    });

    test("a sound the worklet already finished is saved as no sound and does not refuse", () => {
        const p = playing(0x4 | 0x1);
        setCtrl(p.sab, CTRL_STATE, STATE_STOPPED);
        setCtrl(p.sab, CTRL_PLAY_CURSOR, 0);
        const state = p.w.captureSavestate();
        expect(state.playSound).toBeNull();
        const fresh = moduleOn(p.mem);
        fresh.restoreSavestate(throughCodec(state));
        expect(fresh.playSoundSab).toBeNull();
        expect(rings.size).toBe(1);
    });

    test("every saved PlaySound value reaches the capture", () => {
        const p = playing(0x4 | 0x1);
        const before = bytes(p.w.captureSavestate());
        const differs = () => bytes(p.w.captureSavestate()) !== before;
        setCtrl(p.sab, CTRL_PLAY_CURSOR, 10);
        expect(differs()).toBe(true);
        setCtrl(p.sab, CTRL_PLAY_CURSOR, 0);
        setCtrl(p.sab, CTRL_LOOP_MODE, -1);
        expect(differs()).toBe(true);
        setCtrl(p.sab, CTRL_LOOP_MODE, 1);
        new Uint8Array(p.sab, CTRL_BLOCK_BYTES)[5]! ^= 1;
        expect(differs()).toBe(true);
        new Uint8Array(p.sab, CTRL_BLOCK_BYTES)[5]! ^= 1;
        p.w.playSoundId = p.id + 1;
        expect(differs()).toBe(true);
        p.w.playSoundId = p.id;
        expect(differs()).toBe(false);
    });
});

describe("winmm participant", () => {
    test("version 3 with a pinned schema, and a refusal reaches the caller as a CaptureRefusal", () => {
        const w = new WinMM() as Module;
        const before = savestateParticipants.all().find(x => x.id === "winmm");
        const off = w.registerSavestate();
        try {
            const p = savestateParticipants.all().find(x => x.id === "winmm")!;
            expect(p.version).toBe(3);
            expect(schemaHash(WINMM_SCHEMA as unknown as SaveValue)).toBe("13a32abfc6563265");
            (w.mmioHandles as Map<number, unknown>).set(1, {});
            expect(() => p.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            off();
            if (before) savestateParticipants.add(before);
        }
    });

    test("the ring tail and the PlaySound audio are stored as blobs, once per content, and come back through the participant", () => {
        const r = rig();
        for (let i = 0; i < 3; i++) r.write(r.w, i);
        r.play(r.w, LEN - 2000);
        r.poll(r.w);
        const inner = r.w.captureSavestate();
        const before = savestateParticipants.all().find(x => x.id === "winmm");
        const off = r.w.registerSavestate();
        try {
            const p = savestateParticipants.all().find(x => x.id === "winmm")!;
            const graph = newObjectGraph();
            const stored = p.capture(graph as never) as unknown as { waveOut: Array<{ tail: unknown }>; playSound: unknown };
            expect(typeof stored.waveOut[0]!.tail).toBe("string");
            expect([...graph.blobs.get(stored.waveOut[0]!.tail as string)!]).toEqual([...inner.waveOut[0]!.tail]);
            const again = p.capture(graph as never) as unknown as { waveOut: Array<{ tail: unknown }> };
            expect(again.waveOut[0]!.tail).toBe(stored.waveOut[0]!.tail);
            expect(graph.blobs.size).toBe(1);

            const original = r.ring(r.w, LEN - 2000, 3 * LEN);
            const fresh = moduleOn(r.mem);
            const offFresh = fresh.registerSavestate();
            try {
                const q = savestateParticipants.all().find(x => x.id === "winmm")!;
                void q.restore(throughCodec(stored as unknown as SaveValue), restoreObjectGraph([], graph.blobs));
                expect(r.ring(fresh, LEN - 2000, 3 * LEN)).toEqual(original);
                expect(() => q.restore(throughCodec(stored as unknown as SaveValue), restoreObjectGraph([], new Map()))).toThrow("missing");
            } finally {
                offFresh();
            }

            const idle = new WinMM() as Module;
            const offIdle = idle.registerSavestate();
            try {
                const q = savestateParticipants.all().find(x => x.id === "winmm")!;
                const empty = newObjectGraph();
                const saved = q.capture(empty as never);
                expect(empty.blobs.size).toBe(0);
                const target = new WinMM() as Module;
                target.guestMemory = () => { throw new Error("guest memory is not needed without waveOut devices"); };
                const offTarget = target.registerSavestate();
                try {
                    void savestateParticipants.all().find(x => x.id === "winmm")!.restore(throughCodec(saved), restoreObjectGraph([], empty.blobs));
                } finally {
                    offTarget();
                }
            } finally {
                offIdle();
            }
        } finally {
            off();
            if (before) savestateParticipants.add(before);
        }
    });
});
