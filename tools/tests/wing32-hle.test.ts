/**
 * WinG over GDI (Wine dlls/wing32): every WinG export is the matching GDI call, so a WinG
 * DC is a memory DC, a WinG bitmap is a DIB section whose bits the guest writes directly,
 * and the blits are SRCCOPY BitBlt/StretchBlt. These run the REAL gdi32 handlers; only
 * the canvas-backed GDIContext primitives (DC creation, selection, the blit itself) are
 * recorded, because a test runtime has no OffscreenCanvas.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { Wing32 } from "../../src/worker/modules/wing32";

const SRCCOPY = 0x00cc0020;
type Call = [string, ...number[]];

let mem: Uint8Array;
let calls: Call[];
let lastError: number;
let gdi32: Record<string, any>;
let wing: Record<string, any>;
let gdi: GDIContext;
let heap: number;

function alloc(size: number): number {
    const ptr = heap;
    heap += (size + 15) & ~15;
    return ptr;
}
const u32 = (addr: number) => new DataView(mem.buffer).getUint32(addr, true);
const i32 = (addr: number) => new DataView(mem.buffer).getInt32(addr, true);
const u16 = (addr: number) => new DataView(mem.buffer).getUint16(addr, true);

beforeEach(() => {
    mem = new Uint8Array(1 << 20);
    heap = 0x10000;
    calls = [];
    lastError = 0;
    Mem.bind(() => mem);
    gdi = new GDIContext();
    let nextDc = 0x7000;
    gdi.createCompatibleDC = (hdc: number) => {
        calls.push(["createCompatibleDC", hdc]);
        const h = nextDc++;
        gdi.hdcStates.set(h, { hBitmap: 0 } as never);
        return h;
    };
    gdi.selectObject = (hdc: number, obj: number) => {
        const state = gdi.hdcStates.get(hdc)!;
        const prev = state.hBitmap;
        state.hBitmap = obj;
        return prev;
    };
    gdi.refreshDibSectionCanvas = () => null;
    gdi.bitBlt = (...a: number[]) => { calls.push(["bitBlt", ...a]); return true; };
    gdi.stretchBlt = (...a: number[]) => { calls.push(["stretchBlt", ...a]); return true; };
    gdi.getLinkedSurface = () => 0;

    gdi32 = createPaintingExports();
    const process = {
        memory: { alloc },
        getCurrentMemory: () => mem,
        getModule: (name: string) => (name === "gdi32" ? { exports: gdi32 } : undefined),
    };
    (System as unknown as { instance: unknown }).instance = {
        process, gdiContext: gdi, scheduler: { setLastError: (e: number) => { lastError = e; } },
    };
    const module = new Wing32();
    module.initialize(process as never);
    wing = module.exports;
});

afterEach(() => {
    (System as unknown as { instance: unknown }).instance = undefined;
});

/** A BITMAPINFO from WinGRecommendDIBFormat, resized, with a 256-entry colour table. */
function recommendedBitmapInfo(width: number, height: number): number {
    const bmi = alloc(40 + 256 * 4);
    expect(wing.WinGRecommendDIBFormat(null, mem, [bmi])).toBe(1);
    new DataView(mem.buffer).setInt32(bmi + 4, width, true);
    new DataView(mem.buffer).setInt32(bmi + 8, height, true);
    for (let i = 0; i < 256; i++) mem.set([i, 255 - i, i ^ 0x55, 0], bmi + 40 + i * 4);
    return bmi;
}

test("WinGRecommendDIBFormat asks for an 8bpp top-down BI_RGB DIB", () => {
    const bmi = alloc(40);
    mem.fill(0xcc, bmi, bmi + 40);
    expect(wing.WinGRecommendDIBFormat(null, mem, [bmi])).toBe(1);
    expect(u32(bmi)).toBe(40);
    expect(i32(bmi + 8)).toBeLessThan(0);
    expect(u16(bmi + 12)).toBe(1);
    expect(u16(bmi + 14)).toBe(8);
    expect(u32(bmi + 16)).toBe(0);
    expect(u32(bmi + 32)).toBe(0); // biClrUsed: no stack garbage left behind
    expect(wing.WinGRecommendDIBFormat(null, mem, [0])).toBe(0);
});

test("WinGCreateDC is a memory DC compatible with the screen", () => {
    const hdc = wing.WinGCreateDC(null, mem, []);
    expect(hdc).toBeGreaterThan(0);
    expect(calls).toEqual([["createCompatibleDC", 0]]);
});

test("WinGCreateBitmap is a DIB section: HBITMAP back, bits pointer through ppvBits", () => {
    const hdc = wing.WinGCreateDC(null, mem, []);
    const bmi = recommendedBitmapInfo(64, -32);
    const ppvBits = alloc(4);
    const hbm = wing.WinGCreateBitmap(null, mem, [hdc, bmi, ppvBits]);
    expect(hbm).toBeGreaterThan(0);
    const bits = u32(ppvBits);
    expect(bits).toBeGreaterThan(0);

    const obj = SystemResourceProvider.getInstance().getUserObject(hbm) as Record<string, unknown>;
    expect(obj.dibBpp).toBe(8);
    expect(obj.dibTopDown).toBe(true);
    expect(obj.bitsPtr).toBe(bits);
    expect(obj.dibStride).toBe(64);

    // WinGGetDIBPointer answers the same bits and the section's header.
    const out = alloc(40);
    expect(wing.WinGGetDIBPointer(null, mem, [hbm, out])).toBe(bits);
    expect(i32(out + 4)).toBe(64);
    expect(i32(out + 8)).toBe(-32);
    expect(u16(out + 14)).toBe(8);
    expect(wing.WinGGetDIBPointer(null, mem, [hbm, 0])).toBe(bits);
});

test("WinGGetDIBPointer is NULL for a bitmap that is not a DIB section", () => {
    const ddb = gdi32.CreateBitmap(null, mem, [8, 8, 1, 1, 0]);
    expect(wing.WinGGetDIBPointer(null, mem, [ddb, 0])).toBe(0);
    expect(wing.WinGGetDIBPointer(null, mem, [0xdead, 0])).toBe(0);
});

test("WinG colour tables set and read back through the selected DIB section", () => {
    const hdc = wing.WinGCreateDC(null, mem, []);
    const hbm = wing.WinGCreateBitmap(null, mem, [hdc, recommendedBitmapInfo(16, -16), alloc(4)]);
    gdi32.SelectObject(null, mem, [hdc, hbm]);

    const colors = alloc(8);
    mem.set([0x11, 0x22, 0x33, 0, 0x44, 0x55, 0x66, 0], colors);
    expect(wing.WinGSetDIBColorTable(null, mem, [hdc, 10, 2, colors])).toBe(2);

    const back = alloc(16);
    expect(wing.WinGGetDIBColorTable(null, mem, [hdc, 9, 4, back])).toBe(4);
    // Entry 9 is still the creation colour table's; 10 and 11 are what was set.
    expect([...mem.subarray(back, back + 4)]).toEqual([9, 255 - 9, 9 ^ 0x55, 0]);
    expect([...mem.subarray(back + 4, back + 12)]).toEqual([0x11, 0x22, 0x33, 0, 0x44, 0x55, 0x66, 0]);
});

test("WinGBitBlt is a SRCCOPY BitBlt into an ordinary DC", () => {
    const hdcWing = wing.WinGCreateDC(null, mem, []);
    const hdcWindow = 0x1234;
    calls.length = 0;
    expect(wing.WinGBitBlt(null, mem, [hdcWindow, 1, 2, 30, 40, hdcWing, 5, 6])).toBe(1);
    expect(calls).toEqual([["bitBlt", hdcWindow, 1, 2, 30, 40, hdcWing, 5, 6, SRCCOPY]]);
});

test("WinGStretchBlt is a SRCCOPY StretchBlt", () => {
    calls.length = 0;
    expect(wing.WinGStretchBlt(null, mem, [0x1234, 0, 0, 640, 480, 0x7000, 0, 0, 320, 240])).toBe(1);
    expect(calls).toEqual([["stretchBlt", 0x1234, 0, 0, 640, 480, 0x7000, 0, 0, 320, 240, SRCCOPY]]);
});

test("WinGCreateHalftonePalette and WinGCreateHalftoneBrush are the GDI objects", () => {
    const hpal = wing.WinGCreateHalftonePalette(null, mem, []);
    expect(hpal).toBeGreaterThan(0);
    expect(gdi32.GetPaletteEntries(null, mem, [hpal, 0, 256, 0])).toBe(256);

    const hbr = wing.WinGCreateHalftoneBrush(null, mem, [0, 0x0000ff, 0]);
    expect(gdi.objects.get(hbr)?.type).toBe("BRUSH");
});

// --- gdi32 additions -------------------------------------------------------------------

const PC_RESERVED = 0x01;

function logPalette(entries: number[][]): number {
    const p = alloc(4 + entries.length * 4);
    new DataView(mem.buffer).setUint16(p, 0x300, true);
    new DataView(mem.buffer).setUint16(p + 2, entries.length, true);
    entries.forEach((e, i) => mem.set(e, p + 4 + i * 4));
    return gdi32.CreatePalette(null, mem, [p]);
}

test("AnimatePalette replaces only PC_RESERVED entries and keeps every flag", () => {
    const hpal = logPalette([[1, 1, 1, PC_RESERVED], [2, 2, 2, 0], [3, 3, 3, PC_RESERVED], [4, 4, 4, 0]]);
    const repl = alloc(16);
    mem.set([0xa0, 0xa1, 0xa2, 0, 0xb0, 0xb1, 0xb2, 0, 0xc0, 0xc1, 0xc2, 0, 0xd0, 0xd1, 0xd2, 0], repl);
    expect(gdi32.AnimatePalette(null, mem, [hpal, 0, 4, repl])).toBe(1);

    const out = alloc(16);
    expect(gdi32.GetPaletteEntries(null, mem, [hpal, 0, 4, out])).toBe(4);
    expect([...mem.subarray(out, out + 16)]).toEqual([
        0xa0, 0xa1, 0xa2, PC_RESERVED, 2, 2, 2, 0, 0xc0, 0xc1, 0xc2, PC_RESERVED, 4, 4, 4, 0,
    ]);
});

test("AnimatePalette clamps to the palette size and rejects a start past it", () => {
    const hpal = logPalette([[0, 0, 0, PC_RESERVED], [0, 0, 0, PC_RESERVED]]);
    const repl = alloc(8);
    mem.set([9, 9, 9, 0, 8, 8, 8, 0], repl);
    // Count runs past the two entries: only entry 1 is animated, from the FIRST colour given.
    expect(gdi32.AnimatePalette(null, mem, [hpal, 1, 10, repl])).toBe(1);
    const out = alloc(8);
    gdi32.GetPaletteEntries(null, mem, [hpal, 0, 2, out]);
    expect([...mem.subarray(out, out + 8)]).toEqual([0, 0, 0, PC_RESERVED, 9, 9, 9, PC_RESERVED]);

    expect(gdi32.AnimatePalette(null, mem, [hpal, 2, 1, repl])).toBe(0);
    expect(gdi32.AnimatePalette(null, mem, [0x5eadbeef, 0, 1, repl])).toBe(0);
    // The stock DEFAULT_PALETTE has nothing to animate, which is not a failure.
    expect(gdi32.AnimatePalette(null, mem, [0x8000000f, 0, 1, repl])).toBe(1);
});

test("a logical palette is as large as its LOGPALETTE says", () => {
    const hpal = logPalette([[1, 2, 3, 0], [4, 5, 6, 0], [7, 8, 9, 0]]);
    expect(gdi32.GetPaletteEntries(null, mem, [hpal, 0, 0, 0])).toBe(3);
    const out = alloc(16);
    expect(gdi32.GetPaletteEntries(null, mem, [hpal, 1, 10, out])).toBe(2);
    // No phantom black entries past the end for the nearest-colour search to land on.
    expect(gdi32.GetNearestPaletteIndex(null, mem, [hpal, 0x000000])).toBe(0);
    const repl = alloc(16);
    mem.fill(0x10, repl, repl + 16);
    expect(gdi32.SetPaletteEntries(null, mem, [hpal, 2, 4, repl])).toBe(1);
});

test("CreateBitmapIndirect is CreateBitmap from the BITMAP struct", () => {
    const bits = alloc(8);
    mem.set([0b10100000, 0, 0b01000000, 0], bits); // 1bpp, WORD-aligned rows
    const bm = alloc(24);
    const dv = new DataView(mem.buffer);
    dv.setInt32(bm + 4, 3, true);      // bmWidth
    dv.setInt32(bm + 8, 2, true);      // bmHeight
    dv.setInt32(bm + 12, 2, true);     // bmWidthBytes
    dv.setUint16(bm + 16, 1, true);    // bmPlanes
    dv.setUint16(bm + 18, 1, true);    // bmBitsPixel
    dv.setUint32(bm + 20, bits, true); // bmBits
    const hbm = gdi32.CreateBitmapIndirect(null, mem, [bm]);
    expect(hbm).toBeGreaterThan(0);
    const obj = SystemResourceProvider.getInstance().getUserObject(hbm) as { width: number; height: number; pixels: Uint8Array };
    expect([obj.width, obj.height]).toEqual([3, 2]);
    const white = (x: number, y: number) => obj.pixels[(y * 3 + x) * 4] === 0xff;
    expect([white(0, 0), white(1, 0), white(2, 0), white(0, 1), white(1, 1)]).toEqual([true, false, true, false, true]);

    dv.setInt32(bm, 1, true); // bmType must be 0
    expect(gdi32.CreateBitmapIndirect(null, mem, [bm])).toBe(0);
    expect(lastError).toBe(87);
    expect(gdi32.CreateBitmapIndirect(null, mem, [0])).toBe(0);
});
