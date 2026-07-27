/**
 * Contract test for memory/guest-code — a JS-side write of guest-executable bytes MUST drop
 * v86's compiled blocks for exactly the range it wrote.
 *
 * v86 only invalidates on a *guest* store, so JS writes through `mem8` leave stale blocks
 * behind. Our thunk stubs are bump-allocated 16 bytes apart, so a stub published into a page
 * that already holds executing stubs can be entered through a cached block belonging to a
 * different stub — the dispatcher then runs the wrong WinAPI handler.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    invalidateGuestCode,
    resetGuestCodeInvalidationState,
    writeGuestCode,
} from "../../src/worker/core/memory/guest-code";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";

type Range = [number, number];

let dirtied: Range[];
let savedExports: unknown;

/** Stand in for the wasm instance; v86 asserts start < end, so mirror that here. */
function installFakeWasm(): void {
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = {
        jit_dirty_cache: (start: number, end: number) => {
            if (!(start < end)) throw new Error(`jit_dirty_cache called with start >= end (${start}, ${end})`);
            dirtied.push([start >>> 0, end >>> 0]);
        },
    };
}

function removeFakeWasm(): void {
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = null;
}

function covers(address: number, length: number): boolean {
    return dirtied.some(([lo, hi]) => lo <= address && hi >= address + length);
}

beforeEach(() => {
    dirtied = [];
    savedExports = (preemptionManager as unknown as { wasmExports: unknown }).wasmExports;
    resetGuestCodeInvalidationState();
    installFakeWasm();
});

afterEach(() => {
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = savedExports;
    resetGuestCodeInvalidationState();
});

describe("writeGuestCode", () => {
    test("writes the bytes and invalidates the range it wrote", () => {
        const mem = new Uint8Array(0x4000);
        const code = new Uint8Array([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3]);

        expect(writeGuestCode(mem, code, 0x1000)).toBe(true);

        expect(Array.from(mem.subarray(0x1000, 0x1006))).toEqual(Array.from(code));
        expect(dirtied).toEqual([[0x1000, 0x1006]]);
    });

    test("refuses a write that would run past the end of guest memory", () => {
        const mem = new Uint8Array(0x40);
        expect(writeGuestCode(mem, new Uint8Array(0x20), 0x30)).toBe(false);
        expect(dirtied).toEqual([]);
    });

    test("an empty blob neither writes nor trips v86's start < end assert", () => {
        const mem = new Uint8Array(0x40);
        expect(writeGuestCode(mem, new Uint8Array(0), 0x10)).toBe(true);
        expect(dirtied).toEqual([]);
    });
});

describe("invalidateGuestCode", () => {
    test("dirties the whole requested range", () => {
        invalidateGuestCode(0x21046fd0, 1408);
        expect(dirtied).toEqual([[0x21046fd0, 0x21046fd0 + 1408]]);
    });

    test("zero length is a no-op", () => {
        invalidateGuestCode(0x1000, 0);
        expect(dirtied).toEqual([]);
    });

    test("ranges seen before a wasm instance exists are replayed once one appears", () => {
        removeFakeWasm();
        expect(invalidateGuestCode(0x2000, 16)).toBe(false);
        expect(dirtied).toEqual([]);

        installFakeWasm();
        expect(invalidateGuestCode(0x3000, 16)).toBe(true);
        expect(dirtied).toEqual([[0x2000, 0x2010], [0x3000, 0x3010]]);
    });
});

describe("ThunkGenerator hands out no executable space without invalidating it", () => {
    // The PE loader publishes a stub DLL into a page the guest is already executing;
    // without this the guest enters a new stub through a neighbour's cached block.
    test("generateStubDll invalidates the whole bumped span", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);

        const dll = gen.generateStubDll("kernel32", [
            { name: "UnmapViewOfFile", argCount: 1 },
            { name: "Sleep", argCount: 1 },
            { name: "GetTickCount", argCount: 0 },
        ]);

        expect(dll.stubCode.length).toBe(3 * 16);
        expect(covers(dll.baseAddress, dll.stubCode.length)).toBe(true);
    });

    test("a second stub DLL into the same page is invalidated too", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        const first = gen.generateStubDll("kernel32", [{ name: "Sleep", argCount: 1 }]);
        dirtied = [];

        const second = gen.generateStubDll("kernel32", [{ name: "GetLastError", argCount: 0 }]);

        expect(second.baseAddress).toBe(first.baseAddress + 16);
        expect(covers(second.baseAddress, second.stubCode.length)).toBe(true);
    });

    // GetProcAddress at runtime mints a stub next to stubs the guest already runs.
    test("allocateOneStub invalidates its slot", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        dirtied = [];

        const { address, code } = gen.allocateOneStub("kernel32", "Sleep", 1, "stdcall");

        expect(code.length).toBe(16);
        expect(covers(address, 16)).toBe(true);
    });

    test("allocateRawCodeArea invalidates the reserved area", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        dirtied = [];

        const address = gen.allocateRawCodeArea(40);

        expect(covers(address, 48)).toBe(true);
    });

    test("writeTrapStub publishes UD2 and invalidates it", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x1000);
        const mem = new Uint8Array(0x4000);
        dirtied = [];

        expect(gen.writeTrapStub(mem)).toBe(true);

        expect(mem[0x1000]).toBe(0x0f);
        expect(mem[0x1001]).toBe(0x0b);
        expect(covers(0x1000, 16)).toBe(true);
    });
});
