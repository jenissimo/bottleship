import { afterEach, beforeEach, expect, test } from "bun:test";
import { invalidateTextExtentCache, measureWholeTextCached } from "../../src/worker/modules/gdi32/text-extent-cache";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
let calls: number, width: number;
const ctx = { font: "12px test", textBaseline: "top", measureText: (_s: string) => {
    calls++; return { width, fontBoundingBoxAscent: 2.2, fontBoundingBoxDescent: 13.8,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: width };
} };
beforeEach(() => { invalidateTextExtentCache(); calls = 0; width = 12.6; ctx.font = "12px test"; });
afterEach(invalidateTextExtentCache);
test("whole-string results are reused without approximating shaping", () => {
    const first = measureWholeTextCached(ctx, "ffi");
    expect(first).toEqual({ width: 13, height: 16 });
    for (let i = 0; i < 100; i++) expect(measureWholeTextCached(ctx, "ffi")).toBe(first);
    expect(calls).toBe(1);
    measureWholeTextCached(ctx, "fi"); expect(calls).toBe(2);
});
test("selected fonts and invalidated font generations get fresh measurements", () => {
    expect(measureWholeTextCached(ctx, "x")!.width).toBe(13);
    width = 20; ctx.font = "14px test";
    expect(measureWholeTextCached(ctx, "x")!.width).toBe(20);
    width = 30; invalidateTextExtentCache();
    expect(measureWholeTextCached(ctx, "x")!.width).toBe(30);
    expect(calls).toBe(3);
});
test("entry and font bounds evict results; long strings are not retained", () => {
    measureWholeTextCached(ctx, "first");
    for (let i = 0; i < 1024; i++) measureWholeTextCached(ctx, String(i));
    const before = calls; measureWholeTextCached(ctx, "first"); expect(calls).toBe(before + 1);
    invalidateTextExtentCache();
    for (let i = 0; i < 65; i++) { ctx.font = String(i); measureWholeTextCached(ctx, "x"); }
    const atLimit = calls; ctx.font = "0"; measureWholeTextCached(ctx, "x"); expect(calls).toBe(atLimit + 1);
    const long = "x".repeat(257), start = calls;
    measureWholeTextCached(ctx, long); measureWholeTextCached(ctx, long); expect(calls).toBe(start + 2);
});
test("measurement failures are retried and missing font bounds keep existing fallback height", () => {
    let fail = true;
    const canvas = { ...ctx, measureText: () => { if (fail) throw Error("font unavailable"); return {width: 7} as never; } };
    expect(measureWholeTextCached(canvas, "x")).toBeNull();
    fail = false; expect(measureWholeTextCached(canvas, "x")).toEqual({width: 7, height: 16});
});
test("A/W text extent handlers retain identical SIZE output while sharing cached font measurements", () => {
    const saved = (System as any).instance;
    const binding = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, Object.getOwnPropertyDescriptor(Mem, k)] as const);
    const mem = new Uint8Array(0x10000); Mem.bind(() => mem);
    (System as any).instance = { gdiContext: { getMeasureContext: (hdc: number) => hdc === 1 ? ctx : undefined } };
    try {
        mem.set(new TextEncoder().encode("ffi"), 0x100);
        for (let i = 0; i < 3; i++) Mem.writeUint16(0x200 + i*2, "ffi".charCodeAt(i));
        const exports = createPaintingExports();
        for (const name of ["GetTextExtentPointA", "GetTextExtentPoint32A", "GetTextExtentPoint32W"]) {
            expect(exports[name]!(null as never, mem, [1, name.endsWith("W") ? 0x200 : 0x100, 3, 0x400])).toBe(1);
            expect([Mem.readUint32(0x400), Mem.readUint32(0x404)]).toEqual([13,16]);
        }
        expect(calls).toBe(1);
        exports.GetTextExtentPoint32A!(null as never, mem, [99, 0x100, 3, 0x400]);
        expect([Mem.readUint32(0x400), Mem.readUint32(0x404)]).toEqual([24,16]);
    } finally {
        (System as any).instance = saved;
        for (const [k,d] of binding) if (d) Object.defineProperty(Mem,k,d);
    }
});

test("non-default canvas shaping properties bypass results cached for the default font", () => {
    measureWholeTextCached(ctx, "x");
    for (const property of ["letterSpacing", "wordSpacing", "fontKerning", "fontStretch", "fontVariantCaps", "textRendering"]) {
        const special = { ...ctx, [property]: "different" };
        width++;
        const before = calls;
        expect(measureWholeTextCached(special, "x")!.width).toBe(Math.round(width));
        expect(calls).toBe(before + 1);
    }
});
