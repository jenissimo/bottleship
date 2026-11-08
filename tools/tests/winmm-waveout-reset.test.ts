import { afterEach, describe, expect, test } from "bun:test";
import { WinMM } from "../../src/worker/modules/winmm";
import {
    CTRL_PLAY_CURSOR,
    CTRL_RESERVED,
    CTRL_STATE,
    CTRL_STOP_REQUESTED,
    STATE_PLAYING,
    STATE_STOPPED,
    getCtrl,
} from "../../src/audio/audio-ring-buffer";

const g = globalThis as { postMessage?: unknown };
g.postMessage ??= () => undefined;

const MMSYSERR_NOERROR = 0;
const PWFX = 0x100, PHWO = 0x200, HDR = 0x300, DATA = 0x400;
let opened: { winmm: WinMM; hwo: number; mem: Uint8Array } | null = null;

function open() {
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
    const call = (name: string, args: number[]) =>
        (winmm.exports[name] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, args);
    expect(call("waveOutOpen", [PHWO, 0, PWFX, 0, 0, 0])).toBe(MMSYSERR_NOERROR);
    const hwo = v.getUint32(PHWO, true);
    opened = { winmm, hwo, mem };
    const write = () => {
        v.setUint32(HDR, DATA, true);
        v.setUint32(HDR + 4, 512, true);
        v.setUint32(HDR + 16, 0, true);
        return call("waveOutWrite", [hwo, HDR, 32]);
    };
    const sab = (winmm as unknown as { waveOutDevices: Map<number, { sab: SharedArrayBuffer }> }).waveOutDevices.get(hwo)!.sab;
    return { call, hwo, write, sab };
}

afterEach(() => {
    if (opened) {
        (opened.winmm.exports["waveOutClose"] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, opened.mem, [opened.hwo]);
        opened = null;
    }
});

describe("waveOutReset followed by new buffers", () => {
    test("buffers written right after a reset keep playing", () => {
        const d = open();
        expect(d.write()).toBe(MMSYSERR_NOERROR);
        expect(d.call("waveOutReset", [d.hwo])).toBe(MMSYSERR_NOERROR);
        expect(d.write()).toBe(MMSYSERR_NOERROR);
        expect(getCtrl(d.sab, CTRL_STOP_REQUESTED)).toBe(0);
        expect(getCtrl(d.sab, CTRL_STATE)).toBe(STATE_PLAYING);
        expect(getCtrl(d.sab, CTRL_RESERVED)).toBe(1);
        expect(getCtrl(d.sab, CTRL_PLAY_CURSOR)).toBe(0);
    });

    test("negative control: a reset with nothing written after it stays stopped", () => {
        const d = open();
        expect(d.write()).toBe(MMSYSERR_NOERROR);
        expect(d.call("waveOutReset", [d.hwo])).toBe(MMSYSERR_NOERROR);
        expect(getCtrl(d.sab, CTRL_STATE)).toBe(STATE_STOPPED);
    });
});
