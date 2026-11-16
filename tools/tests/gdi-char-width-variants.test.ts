import { afterEach, beforeEach, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { SHIFTJIS_CHARSET } from "../../src/worker/modules/gdi32/font-charset";
import { gdi32Module } from "../../src/worker/api/gdi32.api";
import { preserveMemBinding } from "./helpers/scoped-process-state";

preserveMemBinding();
const HDC = 0x200a0, OUT = 0x2000;
const system = System.getInstance();
let mem: Uint8Array, measured: string[], exports: ReturnType<typeof createPaintingExports>;
let savedGdi: typeof system.gdiContext, savedProcess: typeof system.process;
let width: number;
beforeEach(() => {
    savedGdi = system.gdiContext;
    savedProcess = system.process;
    (system as any).process = null;
    mem = new Uint8Array(0x8000).fill(0xcc);
    Mem.bind(() => mem);
    measured = [];
    width = 10.4;
    (system as any).gdiContext = {
        getMeasureContext: (hdc: number) => hdc !== HDC ? null : {
            measureText(text: string) { measured.push(text); return { width }; },
        },
        getSelectedFontCharset: () => SHIFTJIS_CHARSET,
    };
    exports = createPaintingExports();
});
afterEach(() => {
    (system as any).gdiContext = savedGdi;
    (system as any).process = savedProcess;
});
const call = (name: string, first: number, last: number, out = OUT, dc = HDC): number =>
    exports[name]!(null as never, mem, [dc, first, last, out]) as number;
for (const name of ["GetCharWidthA", "GetCharWidth32A", "GetCharWidthW", "GetCharWidth32W"]) {
    test(name + " declares four stdcall arguments", () => {
        const f = gdi32Module.functions.find(f => f.name === name)!;
        expect(f.callingConvention).toBe("stdcall");
        expect(f.params.length).toBe(4);
    });
    test(name + " writes inclusive rounded INT widths and preserves the tail", () => {
        expect(call(name, 65, 67)).toBe(1);
        expect(measured).toEqual(["A", "B", "C"]);
        const v = new DataView(mem.buffer);
        expect([0, 4, 8].map(i => v.getInt32(OUT + i, true))).toEqual([10, 10, 10]);
        expect(mem[OUT + 12]).toBe(0xcc);
    });
    test(name + " preserves zero-advance widths", () => {
        width = 0;
        expect(call(name, 65, 65)).toBe(1);
        expect(Mem.readUint32(OUT)).toBe(0);
    });
    test(name + " rejects invalid ranges, handles and output before writing", () => {
        expect(call(name, 67, 65)).toBe(0);
        expect(call(name, 65, 65, 0)).toBe(0);
        expect(call(name, 65, 65, OUT, 0)).toBe(0);
        expect(call(name, 65, 65, OUT, HDC + 1)).toBe(0);
        expect(call(name, 0x10000, 0x10000)).toBe(0);
        expect(call(name, 65, 67, mem.length - 4)).toBe(0);
        expect(measured).toEqual([]);
        expect(mem.every(b => b === 0xcc)).toBe(true);
    });
    test(name + " validates the complete region, including write permissions", () => {
        const checked: unknown[] = [];
        (system as any).process = { addressSpace: { validateRange: (...args: unknown[]) => { checked.push(args); return false; } } };
        expect(call(name, 65, 67)).toBe(0);
        expect(checked).toEqual([[OUT, 12, "rw"]]);
        expect(measured).toEqual([]);
        expect(mem.every(b => b === 0xcc)).toBe(true);
    });
}
for (const name of ["GetCharWidthW", "GetCharWidth32W"]) {
    test(name + " uses UTF-16 code units independently of the selected ANSI charset", () => {
        expect(call(name, 0x82a0, 0x82a0)).toBe(1);
        expect(call(name, 0x80, 0x80)).toBe(1);
        expect(measured).toEqual(["芠", "\u0080"]);
    });
    test(name + " accepts the last UTF-16 code unit", () => {
        expect(call(name, 0xffff, 0xffff)).toBe(1);
        expect(measured).toEqual(["\uffff"]);
    });
}
