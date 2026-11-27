import { afterEach, describe, expect, test } from "bun:test";
import { WinMM } from "../../src/worker/modules/winmm";
import { System } from "../../src/worker/core/system";

const g = globalThis as { postMessage?: unknown };
g.postMessage ??= () => undefined;

const WOM_OPEN = 0x3bb, WOM_CLOSE = 0x3bc, WOM_DONE = 0x3bd;
const CALLBACK_WINDOW = 0x10000, CALLBACK_THREAD = 0x20000, CALLBACK_EVENT = 0x50000;
const PWFX = 0x100, PHWO = 0x200, HDR = 0x300, HDR2 = 0x340, DATA = 0x400;

type Call = (name: string, args: number[]) => number;
const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

function setup(flags: number, callback: number) {
    const posted: number[][] = [];
    const events: number[] = [];
    let threadState = 2;
    const system = System.getInstance() as unknown as { windowManager: unknown; scheduler: unknown };
    const wm = system.windowManager, sched = system.scheduler;
    system.windowManager = {
        postMessage: (hwnd: number, m: number, w: number, l: number, _x: number, _y: number, tid: number) => posted.push([hwnd, m, w, l, tid ?? 0]),
    };
    system.scheduler = {
        getThreadStateById: (id: number) => (id === 0x2c ? { state: threadState } : null),
        setEvent: (h: number) => events.push(h),
        timerWheel: { add: () => 1, cancel: () => undefined },
    };
    restore.push(() => { system.windowManager = wm; system.scheduler = sched; });

    const winmm = new WinMM();
    winmm.initialize({} as never);
    const mem = new Uint8Array(0x2000);
    const v = new DataView(mem.buffer);
    v.setUint16(PWFX, 1, true);
    v.setUint16(PWFX + 2, 1, true);
    v.setUint32(PWFX + 4, 22050, true);
    v.setUint32(PWFX + 8, 22050, true);
    v.setUint16(PWFX + 12, 1, true);
    v.setUint16(PWFX + 14, 8, true);
    const call: Call = (name, args) =>
        (winmm.exports[name] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, args);
    expect(call("waveOutOpen", [PHWO, 0, PWFX, callback, 0x77, flags])).toBe(0);
    const hwo = v.getUint32(PHWO, true);
    const write = (hdr: number) => {
        v.setUint32(hdr, DATA, true);
        v.setUint32(hdr + 4, 512, true);
        v.setUint32(hdr + 16, 0, true);
        return call("waveOutWrite", [hwo, hdr, 32]);
    };
    return { call, hwo, write, posted, events, winmm, setThreadState: (s: number) => { threadState = s; } };
}

describe("waveOut CALLBACK_WINDOW / CALLBACK_THREAD / CALLBACK_EVENT", () => {
    test("CALLBACK_WINDOW posts MM_WOM_OPEN, one MM_WOM_DONE per returned buffer in order, and MM_WOM_CLOSE", () => {
        const d = setup(CALLBACK_WINDOW, 0x1234);
        expect(d.posted).toEqual([[0x1234, WOM_OPEN, d.hwo, 0, 0]]);
        expect(d.write(HDR)).toBe(0);
        expect(d.write(HDR2)).toBe(0);
        expect(d.call("waveOutReset", [d.hwo])).toBe(0);
        expect(d.call("waveOutClose", [d.hwo])).toBe(0);
        expect(d.posted).toEqual([
            [0x1234, WOM_OPEN, d.hwo, 0, 0],
            [0x1234, WOM_DONE, d.hwo, HDR, 0],
            [0x1234, WOM_DONE, d.hwo, HDR2, 0],
            [0x1234, WOM_CLOSE, d.hwo, 0, 0],
        ]);
    });

    test("CALLBACK_THREAD posts the same messages through the thread queue (hwnd 0)", () => {
        const d = setup(CALLBACK_THREAD, 0x2c);
        expect(d.write(HDR)).toBe(0);
        expect(d.call("waveOutReset", [d.hwo])).toBe(0);
        expect(d.call("waveOutClose", [d.hwo])).toBe(0);
        expect(d.posted).toEqual([
            [0, WOM_OPEN, d.hwo, 0, 0x2c],
            [0, WOM_DONE, d.hwo, HDR, 0x2c],
            [0, WOM_CLOSE, d.hwo, 0, 0x2c],
        ]);
    });

    test("CALLBACK_EVENT signals the event on open, on each returned buffer and on close", () => {
        const d = setup(CALLBACK_EVENT, 0x5150);
        expect(d.write(HDR)).toBe(0);
        expect(d.write(HDR2)).toBe(0);
        expect(d.call("waveOutReset", [d.hwo])).toBe(0);
        expect(d.call("waveOutClose", [d.hwo])).toBe(0);
        expect(d.events).toEqual([0x5150, 0x5150, 0x5150, 0x5150]);
        expect(d.posted).toEqual([]);
    });

    test("a terminated or unknown thread receives nothing", () => {
        const dead = setup(CALLBACK_THREAD, 0x2c);
        dead.posted.length = 0;
        dead.setThreadState(5);
        expect(dead.call("waveOutClose", [dead.hwo])).toBe(0);
        expect(dead.posted).toEqual([]);
        const unknown = setup(CALLBACK_THREAD, 0x99);
        expect(unknown.posted).toEqual([]);
    });

    test("negative control: CALLBACK_NULL posts and signals nothing", () => {
        const d = setup(0, 0);
        expect(d.write(HDR)).toBe(0);
        expect(d.call("waveOutReset", [d.hwo])).toBe(0);
        expect(d.call("waveOutClose", [d.hwo])).toBe(0);
        expect(d.posted).toEqual([]);
        expect(d.events).toEqual([]);
    });
});
