import { Mem } from "../../src/worker/core/memory/mem-accessor";
/**
 * CreateBrushIndirect must return a usable HBRUSH for every LOGBRUSH style an app commonly
 * passes. BS_HOLLOW is the stock NULL_BRUSH: failing it yields a NULL handle that
 * SelectObject ignores, leaving the previous brush selected.
 */
import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";

const savedMem = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, Object.getOwnPropertyDescriptor(Mem, k)] as const);
afterEach(() => { for (const [k,d] of savedMem) if (d) Object.defineProperty(Mem,k,d); });
const savedInstance = (System as unknown as { instance: unknown }).instance;
afterEach(() => { (System as unknown as { instance: unknown }).instance = savedInstance; });

function brush(style: number, color = 0x00336699, hatch = 0): number {
    const mem = new Uint8Array(0x100);
    Mem.bind(() => mem);
    const dv = new DataView(mem.buffer);
    dv.setUint32(0x10, style, true);
    dv.setUint32(0x14, color, true);
    dv.setUint32(0x18, hatch, true);
    const gdi = new GDIContext();
    (System as unknown as { instance: unknown }).instance = { gdiContext: gdi, process: { getCurrentMemory: () => mem } };
    return (createPaintingExports()["CreateBrushIndirect"] as (c: unknown, m: Uint8Array, a: number[]) => number)({}, mem, [0x10]);
}

test("BS_SOLID yields a brush handle", () => {
    expect(brush(0)).toBeGreaterThan(0);
});

test("BS_HOLLOW yields the stock NULL_BRUSH", () => {
    expect(brush(1)).toBe((0x80000000 | 5) >>> 0);
});

test("BS_HATCHED fails until hatch rendering is supported", () => {
    expect(brush(2)).toBe(0);
});

test("an unsupported style still fails with NULL", () => {
    expect(brush(99)).toBe(0);
});
