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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    invalidateAllGuestCode,
    invalidateGuestCode,
    resetGuestCodeInvalidationState,
    writeGuestCode,
} from "../../src/worker/core/memory/guest-code";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";

type Range = [number, number];

let dirtied: Range[];
let cleared: number;
let savedExports: unknown;

/** Stand in for the wasm instance; v86 asserts start < end, so mirror that here. */
function installFakeWasm(): void {
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = {
        jit_dirty_cache: (start: number, end: number) => {
            if (!(start < end)) throw new Error(`jit_dirty_cache called with start >= end (${start}, ${end})`);
            dirtied.push([start >>> 0, end >>> 0]);
        },
        jit_clear_cache_js: () => { cleared++; },
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
    cleared = 0;
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

describe("invalidateAllGuestCode", () => {
    test("drops every compiled block (FlushInstructionCache with no range)", () => {
        expect(invalidateAllGuestCode()).toBe(true);
        expect(cleared).toBe(1);
        expect(dirtied).toEqual([]);
    });

    test("reports failure rather than throwing when no wasm instance exists", () => {
        removeFakeWasm();
        expect(invalidateAllGuestCode()).toBe(false);
    });
});

/**
 * The two kernel32 entry points whose whole purpose is publishing bytes the guest will
 * execute. WriteProcessMemory into our own process is how allocator interposers and detour
 * libraries patch live code (SmartHeap's shi_PatchMallocs is one); FlushInstructionCache is
 * the guest telling us which bytes it just rewrote. Both are JS-side writes/declarations that
 * v86 cannot observe, so both must route through guest-code.ts. Structural, like the
 * ownership gate: the handlers pull in System/Mem and are not unit-instantiable.
 */
describe("kernel32 code-publication entry points route through guest-code", () => {
    const src = readFileSync(
        join(import.meta.dir, "..", "..", "src", "worker", "modules", "kernel32", "process", "process.ts"),
        "utf8",
    );

    function bodyOf(name: string): string {
        const start = src.indexOf(`'${name}': (ctx, mem, args)`);
        expect(start).toBeGreaterThan(-1);
        const next = src.indexOf("\n    '", start + 1);
        return src.slice(start, next === -1 ? src.length : next);
    }

    test("WriteProcessMemory invalidates the bytes it wrote", () => {
        expect(bodyOf("WriteProcessMemory")).toContain("invalidateGuestCode(lpBaseAddress, copied)");
    });

    test("FlushInstructionCache honours the guest's declared range", () => {
        const body = bodyOf("FlushInstructionCache");
        expect(body).toContain("invalidateGuestCode(lpBaseAddress, dwSize)");
        expect(body).toContain("invalidateAllGuestCode()");
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

    test("an in-image alias reuses the canonical function ID", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        const canonical = gen.allocateOneStub("kernel32", "QueryPerformanceCounter", 1, "stdcall");
        const target = gen.getStubByAddress(canonical.address)!;

        const alias = gen.allocateAliasStubAt(0x2a001000, target, 1, "stdcall");
        const next = gen.allocateOneStub("kernel32", "QueryPerformanceFrequency", 1, "stdcall");

        const aliasId = new DataView(alias.code.buffer).getUint32(1, true);
        expect(aliasId).toBe(target.functionId);
        expect(gen.getStubByAddress(alias.address)?.functionId).toBe(target.functionId);
        expect(gen.getStubByAddress(next.address)?.functionId).toBe(target.functionId + 1);
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
