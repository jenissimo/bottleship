/**
 * RegEnumKeyA(hKey, dwIndex, lpName, cchName) contract.
 *
 * The ANSI enumerator has no count out-parameter — cchName is a by-value buffer
 * capacity, so the ONLY guest memory the call may touch is [lpName, lpName+cchName).
 * Anything written past that lands in whatever the caller put next on its stack.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Advapi32 } from "../../src/worker/modules/advapi32";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const HKEY_CURRENT_USER = 0x80000001;

const BUF = 0x2000;
const CCH = 16;
const POISON = 0xdeadbeef;
const SUBKEY = "bottleship";

let mem: Uint8Array;
let view: DataView;
let exports: Record<string, any>;

function call(...args: number[]): number {
    const r = exports["RegEnumKeyA"]!({ esp: 0 } as any, mem, args as any);
    return typeof r === "number" ? r : r.value;
}

/** Poison a generous window either side of the caller's buffer. */
function poisonAround(): void {
    for (let a = BUF - 32; a < BUF + CCH + 64; a += 4) view.setUint32(a, POISON, true);
}

function readAnsi(addr: number): string {
    let s = "";
    for (let i = 0; mem[addr + i]; i++) s += String.fromCharCode(mem[addr + i]!);
    return s;
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem); // stray writes go through Mem, so it must see the same buffer
    const system: any = System.getInstance();
    system.registry.createKey("HKCU", SUBKEY);
    const mod = new Advapi32();
    mod.initialize({ resourceProvider: { getKernelObject: () => null } } as any);
    exports = mod.exports;
});

describe("RegEnumKeyA", () => {
    test("writes the name and nothing outside the caller's buffer", () => {
        poisonAround();
        expect(call(HKEY_CURRENT_USER, 0, BUF, CCH)).toBe(ERROR_SUCCESS);

        expect(readAnsi(BUF).length).toBeGreaterThan(0);
        for (let a = BUF - 32; a < BUF; a += 4) expect(view.getUint32(a, true)).toBe(POISON);
        for (let a = BUF + CCH; a < BUF + CCH + 64; a += 4) expect(view.getUint32(a, true)).toBe(POISON);
    });

    test("a name that does not fit is ERROR_MORE_DATA with the buffer untouched", () => {
        poisonAround();
        expect(call(HKEY_CURRENT_USER, 0, BUF, 2)).toBe(ERROR_MORE_DATA);
        for (let a = BUF; a < BUF + CCH + 64; a += 4) expect(view.getUint32(a, true)).toBe(POISON);
    });

    test("past the end of the subkey list is ERROR_NO_MORE_ITEMS, with no writes", () => {
        poisonAround();
        expect(call(HKEY_CURRENT_USER, 9999, BUF, CCH)).toBe(ERROR_NO_MORE_ITEMS);
        for (let a = BUF - 32; a < BUF + CCH + 64; a += 4) expect(view.getUint32(a, true)).toBe(POISON);
    });

    test("an invalid hive is ERROR_INVALID_HANDLE, with no writes", () => {
        poisonAround();
        expect(call(0x1234, 0, BUF, CCH)).toBe(ERROR_INVALID_HANDLE);
        for (let a = BUF - 32; a < BUF + CCH + 64; a += 4) expect(view.getUint32(a, true)).toBe(POISON);
    });
});
