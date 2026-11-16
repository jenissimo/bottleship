import { afterEach, beforeEach, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { preserveGlobals } from "./helpers/scoped-globals";
preserveGlobals("OffscreenCanvas", "ImageData");

class Canvas {
    readonly pixels: Uint8ClampedArray;
    readonly ctx: any;
    constructor(public width: number, public height: number) {
        this.pixels = new Uint8ClampedArray(width * height * 4).fill(0x55);
        this.ctx = { canvas: this, fillStyle: "", save() {}, restore() {},
            putImageData: (img: {data: Uint8ClampedArray}) => this.pixels.set(img.data),
            createPattern: (tile: Canvas) => tile,
            fillRect: (x: number, y: number, w: number, h: number) => {
                const fill = this.ctx.fillStyle;
                if (fill === "transparent") return;
                for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
                    const rgba = fill instanceof Canvas
                        ? fill.pixels.subarray(((row % fill.height) * fill.width + col % fill.width) * 4,
                            ((row % fill.height) * fill.width + col % fill.width) * 4 + 4)
                        : new Uint8ClampedArray([255, 255, 255, 255]);
                    this.pixels.set(rgba, (row * this.width + col) * 4);
                }
            },
        };
    }
    getContext() { return this.ctx; }
}
let mem: Uint8Array, gdi: GDIContext, provider: SystemResourceProvider, savedSystem: unknown, savedProvider: unknown;
let bindings: Array<[string, PropertyDescriptor | undefined]>;
beforeEach(() => {
    bindings = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, Object.getOwnPropertyDescriptor(Mem, k)]);
    savedSystem = (System as any).instance; savedProvider = (SystemResourceProvider as any).instance;
    (globalThis as any).OffscreenCanvas = Canvas;
    (globalThis as any).ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
    mem = new Uint8Array(0x10000); Mem.bind(() => mem);
    gdi = new GDIContext(); provider = new (SystemResourceProvider as any)();
    (SystemResourceProvider as any).instance = provider;
    (System as any).instance = { gdiContext: gdi, resourceProvider: provider,
        process: { getCurrentMemory: () => mem, addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length } } };
});
afterEach(() => {
    (System as any).instance = savedSystem; (SystemResourceProvider as any).instance = savedProvider;
    for (const [k, d] of bindings) if (d) Object.defineProperty(Mem, k, d);
});
function brush(style: number, hatch = 0): number {
    Mem.writeUint32(0x100, style); Mem.writeUint32(0x104, 0x00336699); Mem.writeUint32(0x108, hatch);
    return createPaintingExports().CreateBrushIndirect!(null as never, mem, [0x100]) as number;
}
test("hollow brushes reuse the stock null brush, leave pixels alone and survive deletion", () => {
    const first = brush(1), second = brush(1);
    expect(first).toBeGreaterThan(0); expect(second).toBe(first);
    expect(gdi.isStockObject(first)).toBe(true);
    const canvas = new Canvas(2, 2), dc = gdi.createDC(canvas as never);
    const old = gdi.selectObject(dc, first);
    expect(gdi.hdcStates.get(dc)!.hBrush).toBe(first);
    expect(gdi.fillRect(dc, 0, 0, 2, 2)).toBe(true);
    expect([...canvas.pixels]).toEqual(Array(16).fill(0x55));
    gdi.selectObject(dc, old);
    expect(gdi.deleteObject(first)).toBe(true); expect(gdi.getStockObject(first)?.data).toBe("transparent");
    expect(brush(1)).toBe(second);
});
test("GetObject returns a LOGBRUSH and refuses a short output", () => {
    const h = brush(1);
    expect(gdi.getObject(h, 0, 0, mem)).toBe(12);
    expect(gdi.getObject(h, 12, 0x200, mem)).toBe(12);
    expect([0,4,8].map(n => Mem.readUint32(0x200+n))).toEqual([1,0,0]);
    mem.fill(0x55, 0x200, 0x210);
    expect(gdi.getObject(h, 8, 0x200, mem)).toBe(0);
    expect(Mem.readUint32(0x200)).toBe(0x55555555);
    const solid = brush(0);
    expect(gdi.getObject(solid, 12, 0x200, mem)).toBe(12);
    expect([Mem.readUint32(0x200), Mem.readUint32(0x204)]).toEqual([0, 0x00336699]);
});
test("pattern brushes copy bitmap pixels and keep drawing after the bitmap is deleted", () => {
    const pixels = new Uint8ClampedArray([255,0,0,255,0,255,0,255]);
    const bitmap = provider.registerUserObject({type: "BITMAP", width: 2, height: 1, pixels} as never);
    const h = brush(3, bitmap);
    expect(h).toBeGreaterThan(0);
    pixels.fill(0); provider.unregisterUserObject(bitmap);
    const canvas = new Canvas(4, 1), dc = gdi.createDC(canvas as never);
    gdi.selectObject(dc, h); expect(gdi.fillRect(dc, 0, 0, 4, 1)).toBe(true);
    expect([...canvas.pixels]).toEqual([255,0,0,255,0,255,0,255,255,0,0,255,0,255,0,255]);
    expect(gdi.getObject(h, 12, 0x200, mem)).toBe(12);
    expect(Mem.readUint32(0x200)).toBe(3);
    expect(gdi.deleteObject(h)).toBe(true);
});
test("unsupported hatches, invalid bitmap handles and invalid LOGBRUSH pointers fail", () => {
    expect(brush(2)).toBe(0); expect(brush(99)).toBe(0); expect(brush(3, 0xdead)).toBe(0);
    expect(createPaintingExports().CreateBrushIndirect!(null as never, mem, [0])).toBe(0);
    expect(createPaintingExports().CreateBrushIndirect!(null as never, mem, [mem.length - 8])).toBe(0);
});
