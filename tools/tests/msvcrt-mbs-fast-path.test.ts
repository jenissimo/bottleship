/**
 * The _mbs* fast paths answer what the crt-mb.ts handlers answer under SBCS, and hand a
 * DBCS code page or an unreadable pointer back to the slow handler (null) instead of
 * guessing. Empires: Dawn of the Modern World's loader calls these ~180K times a second.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { registerFastPathMsvcrtFunctions } from "../../src/worker/modules/msvcrt";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

const MEM_SIZE = 0x4000;
const ESP = 0x1000;
const mem = new Uint8Array(MEM_SIZE);
const mem32 = new Uint32Array(mem.buffer);
const view = new DataView(mem.buffer);
const cpu = { reg32: new Uint32Array(8) };

const impls = new Map<string, { impl: Function; trivial: boolean }>();
registerFastPathMsvcrtFunctions({
    registerFastPath: (dll: string, fn: string, impl: Function, opts?: { trivial?: boolean }) => {
        if (dll === "msvcrt") impls.set(fn, { impl, trivial: !!opts?.trivial });
    },
} as any);

function call(fn: string, ...args: number[]): number | null {
    const entry = impls.get(fn);
    if (!entry) throw new Error(`no fast path for ${fn}`);
    args.forEach((a, i) => view.setUint32(ESP + 4 + i * 4, a >>> 0, true));
    return entry.impl(ESP, view, mem, mem32, cpu) as number | null;
}

function put(addr: number, s: string): number {
    for (let i = 0; i < s.length; i++) mem[addr + i] = s.charCodeAt(i);
    mem[addr + s.length] = 0;
    return addr;
}

const savedCp = EmulatorConfig.getInstance().ansiCodePage;
afterEach(() => { EmulatorConfig.getInstance().ansiCodePage = savedCp; });

describe("msvcrt _mbs* fast paths (SBCS)", () => {
    test("registered for every hot helper, as trivial", () => {
        for (const fn of ["_mbslen", "_mbsnbcnt", "_mbsnccnt", "_mbsninc", "_mbsinc", "_mbscmp"]) {
            expect(impls.get(fn)?.trivial).toBe(true);
        }
    });

    test("counting helpers follow the slow handlers", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        const s = put(0x2000, "Empires\xe9");
        expect(call("_mbslen", s)).toBe(8);
        expect(call("_mbsnbcnt", s, 3)).toBe(3);
        expect(call("_mbsnbcnt", s, 100)).toBe(8);
        expect(call("_mbsnccnt", s, 0)).toBe(0);
        expect(call("_mbsninc", s, 5)).toBe(s + 5);
        expect(call("_mbsninc", s, 100)).toBe(s + 8);
        expect(call("_mbsninc", 0, 5)).toBe(0);
        expect(call("_mbsinc", s)).toBe(s + 1);
        expect(call("_mbsinc", 0)).toBe(0);
    });

    test("_mbscmp is an unsigned byte compare", () => {
        const a = put(0x2100, "abc"), b = put(0x2200, "abd"), c = put(0x2300, "abc\xe9");
        expect(call("_mbscmp", a, a)).toBe(0);
        expect(call("_mbscmp", a, put(0x2400, "abc"))).toBe(0);
        expect(Math.sign(call("_mbscmp", a, b)!)).toBe(-1);
        expect(Math.sign(call("_mbscmp", c, a)!)).toBe(1);
    });

    test("a pointer the slow handler would refuse goes back to it", () => {
        EmulatorConfig.getInstance().ansiCodePage = 1252;
        expect(call("_mbslen", 0)).toBeNull();
        expect(call("_mbsnbcnt", 0, 4)).toBeNull();
        mem.fill(0x41, MEM_SIZE - 8); // unterminated at the end of the view
        expect(call("_mbslen", MEM_SIZE - 8)).toBeNull();
    });

    test("a DBCS code page is left to the slow handler", () => {
        EmulatorConfig.getInstance().ansiCodePage = 932;
        const s = put(0x2000, "abc");
        expect(call("_mbslen", s)).toBeNull();
        expect(call("_mbsnbcnt", s, 2)).toBeNull();
        expect(call("_mbsninc", s, 2)).toBeNull();
        expect(call("_mbsinc", s)).toBeNull();
    });

    test("_mbscmp leaves a NULL argument to the slow handler", () => {
        const a = put(0x2100, "abc");
        expect(call("_mbscmp", 0, a)).toBeNull();
        expect(call("_mbscmp", a, 0)).toBeNull();
    });
});
