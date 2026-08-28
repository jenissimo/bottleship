/**
 * IDirectInputDevice*::GetDeviceState answers identically on both tiers.
 *
 * It is the second-largest count in the slow-path thunk census (a per-frame poll), so it
 * has a fast path. The two tiers share one body; what these tests pin is the part that is
 * NOT shared — the stack decode (this, cbData, lpvData) and the refusal to touch guest
 * memory when the arguments cannot be read.
 *
 * No COM object is created, so every case runs the device==NULL path: that is what a game
 * calling through a released interface hits, and it exercises all four state layouts by
 * cbData alone.
 */

import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { INPUT_BUFFER_SIZE } from "../../src/input/sab-layout";
import { DInput } from "../../src/worker/modules/dinput/dinput";

const DI_OK = 0;
const DIERR_INVALIDPARAM = 0x80070057;

const MEM_SIZE = 0x20000;
const ESP = 0x1000;
const BUF = 0x2000;

const mem = new Uint8Array(MEM_SIZE);
const mem32 = new Uint32Array(mem.buffer);
const view = new DataView(mem.buffer);
const cpu = { reg32: new Uint32Array(8) };

// initialize() needs a live guest process to build vtables; the two members the state
// reader actually uses are the memory supplier and the fast-path registrar.
const dinput = new DInput();
(dinput as any).process = { getCurrentMemory: () => mem };

let fastImpl: Function;
(dinput as any).registerFastPaths({
    registerFastPath: (_dll: string, _fn: string, impl: Function) => { fastImpl = impl; },
});

function callImpl(thisPtr: number, cbData: number, lpvData: number): number {
    return (dinput as any).getDeviceStateImpl(mem, thisPtr, cbData, lpvData);
}

function callFast(thisPtr: number, cbData: number, lpvData: number): number | null {
    cpu.reg32[4] = ESP;
    view.setUint32(ESP + 4, thisPtr >>> 0, true);
    view.setUint32(ESP + 8, cbData >>> 0, true);
    view.setUint32(ESP + 12, lpvData >>> 0, true);
    return fastImpl(cpu, mem, mem32, view) as number | null;
}

function seed(pressedVk?: number): void {
    const im = System.getInstance().inputManager;
    im.setInputBuffer(new SharedArrayBuffer(INPUT_BUFFER_SIZE));
    im.reset();
    if (pressedVk !== undefined) im.injectKey(pressedVk, true);
}

const layouts: Array<{ name: string; cbData: number }> = [
    { name: "DIMOUSESTATE", cbData: 16 },
    { name: "DIMOUSESTATE2", cbData: 20 },
    { name: "DIKEYBOARDSTATE", cbData: 256 },
    { name: "DIJOYSTATE", cbData: 80 },
    { name: "an unrecognised size", cbData: 8 },
];

describe("dinput GetDeviceState: fast path == thunk body", () => {
    for (const l of layouts) {
        test(`${l.name} — same return and same bytes`, () => {
            seed(0x41);
            mem.fill(0xcc, BUF, BUF + l.cbData + 1);
            const slow = callImpl(0, l.cbData, BUF);
            const slowBytes = Array.from(mem.subarray(BUF, BUF + l.cbData + 1));

            seed(0x41);
            mem.fill(0xcc, BUF, BUF + l.cbData + 1);
            const fast = callFast(0, l.cbData, BUF);

            expect(fast).toBe(slow);
            expect(slow).toBe(DI_OK);
            expect(Array.from(mem.subarray(BUF, BUF + l.cbData + 1))).toEqual(slowBytes);
            expect(mem[BUF + l.cbData]).toBe(0xcc); // nothing written past cbData
        });
    }

    test("a NULL buffer or a zero size is a parameter error on both tiers", () => {
        seed();
        expect(callImpl(0, 16, 0)).toBe(DIERR_INVALIDPARAM);
        expect(callFast(0, 16, 0)).toBe(DIERR_INVALIDPARAM);
        expect(callImpl(0, 0, BUF)).toBe(DIERR_INVALIDPARAM);
        expect(callFast(0, 0, BUF)).toBe(DIERR_INVALIDPARAM);
    });

    test("declines rather than decode three arguments off the end of guest RAM", () => {
        seed();
        cpu.reg32[4] = MEM_SIZE - 8;
        expect(fastImpl(cpu, mem, mem32, view)).toBe(null);
    });
});
