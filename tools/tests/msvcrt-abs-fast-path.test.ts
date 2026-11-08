import { expect, test } from "bun:test";
import { registerFastPathMsvcrtFunctions } from "../../src/worker/modules/msvcrt";
import { registerCrtConvExports } from "../../src/worker/modules/crt-conv";

type Reg = { dll: string; fn: string; impl: (...a: unknown[]) => unknown; opts?: { trivial?: boolean } };

function registrations(): Reg[] {
    const regs: Reg[] = [];
    registerFastPathMsvcrtFunctions({
        registerFastPath: (dll: string, fn: string, impl: Reg["impl"], opts?: Reg["opts"]) => { regs.push({ dll, fn, impl, opts }); },
    } as never);
    return regs;
}

function slowAbs(): (v: number) => number {
    const exports: Record<string, (...a: unknown[]) => unknown> = {};
    registerCrtConvExports(exports as never, {} as never);
    return (v: number) => exports["abs"]!({}, new Uint8Array(0), [v >>> 0]) as number;
}

const ESP = 0x100;
const mem = new Uint8Array(0x200);
const view = new DataView(mem.buffer);

function call(impl: Reg["impl"], v: number): number {
    view.setUint32(ESP + 4, v >>> 0, true);
    return impl(ESP, view, mem, new Uint32Array(mem.buffer), {}) as number;
}

test("abs and labs answer on the fast path for every C runtime that exports them", () => {
    const regs = registrations();
    for (const dll of ["msvcrt", "crtdll", "msvcr90"]) {
        for (const fn of ["abs", "labs"]) {
            const r = regs.find(x => x.dll === dll && x.fn === fn);
            expect(r?.opts?.trivial).toBe(true);
        }
    }
});

test("the fast path returns what the CRT export returns, edge cases included", () => {
    const fast = registrations().find(x => x.dll === "msvcrt" && x.fn === "abs")!.impl;
    const slow = slowAbs();
    const values = [0, 1, -1, 7, -7, 0x7fffffff, -0x7fffffff, -0x80000000, 123456, -123456];
    let s = 12345;
    for (let i = 0; i < 2000; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; values.push(s | 0); }
    for (const v of values) expect((call(fast, v) >>> 0)).toBe(slow(v) >>> 0);
    expect(call(fast, -0x80000000) >>> 0).toBe(0x80000000);
});

test("negative: a stack too short for the argument falls through to the slow path", () => {
    const fast = registrations().find(x => x.dll === "msvcrt" && x.fn === "abs")!.impl;
    expect(fast(mem.length - 6, view, mem, new Uint32Array(mem.buffer), {})).toBeNull();
});
