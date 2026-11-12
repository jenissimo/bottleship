// SetPixel has to draw. ddutil's DDColorMatch — the helper DirectDraw titles of the era
// copy to turn an RGB colour key into the surface's own pixel value — writes the colour
// to pixel (0,0) of the surface DC, releases the DC, reads the pixel back through Lock
// and then restores the old one. With a SetPixel that only returns its argument the key
// is whatever happened to be in that corner, and every sprite keeps its key-coloured box.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { GDIContext } from '../../src/worker/modules/gdi32/context';
import { createPaintingExports } from '../../src/worker/modules/gdi32/painting';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';

const system = System.getInstance();
const originalGdi = system.gdiContext;
const originalProcess = system.process;
const memory = new Uint8Array(8192);
const BITS = 4096;
const HDC = 1, CLR_INVALID = 0xFFFFFFFF, MAGENTA = 0x00FF00FF;
let gdi: GDIContext;
let exports: ReturnType<typeof createPaintingExports>;

beforeEach(() => {
    Mem.bind(() => memory);
    gdi = new GDIContext();
    system.gdiContext = gdi;
    system.process = { getCurrentMemory: () => memory } as never;
    exports = createPaintingExports();
});
afterEach(() => { system.gdiContext = originalGdi; system.process = originalProcess; });

function surfaceDc(width: number, height: number, fill: [number, number, number]) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) pixels.set([...fill, 255], i * 4);
    const canvas: any = { width, height };
    const context: any = {
        canvas, fillStyle: '#000', reads: [] as number[],
        fillRect(x: number, y: number, w: number, h: number) {
            const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(this.fillStyle)!.slice(1).map(Number);
            for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
                if (col < 0 || row < 0 || col >= width || row >= height) continue;
                pixels.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], (row * width + col) * 4);
            }
        },
        getImageData(x: number, y: number, w: number, h: number) {
            this.reads.push(w * h);
            const data = new Uint8ClampedArray(w * h * 4);
            for (let row = 0; row < h; row++) data.set(pixels.subarray(((row + y) * width + x) * 4, ((row + y) * width + x + w) * 4), row * w * 4);
            return { data, width: w, height: h };
        },
        save() { }, restore() { },
    };
    canvas.getContext = () => context;
    gdi.contexts.set(HDC, context);
    gdi.hdcStates.set(HDC, { brushColor: '#fff', textColor: '#fff', textColorValue: 0xffffff, bkMode: 1, bkColor: '#000',
        font: '16px sans-serif', fontSize: 16, fontQuality: 0, textEscapement: 0, textAlign: 0,
        appliedFont: '', appliedFillStyle: '', hBrush: 0, hPen: 0, hFont: 0, hBitmap: 0,
        imageDataDirty: true, dirty: false, dirtyRect: null } as never);
    return Object.assign(pixels, { context });
}

const call = (name: string, ...args: number[]) => exports[name]!({} as never, memory, args) as number;

test('DDColorMatch: the colour set at (0,0) is on the DC and marks it for the surface write-back', () => {
    const pixels = surfaceDc(4, 2, [10, 20, 30]);
    const before = call('GetPixel', HDC, 0, 0);
    expect(before).toBe(0x001E140A);

    expect(call('SetPixel', HDC, 0, 0, MAGENTA)).toBe(MAGENTA);
    expect([...pixels.subarray(0, 4)]).toEqual([255, 0, 255, 255]);
    expect([...pixels.subarray(4, 8)]).toEqual([10, 20, 30, 255]);
    expect(call('GetPixel', HDC, 0, 0)).toBe(MAGENTA);
    expect(gdi.isDirty(HDC)).toBe(true);
    expect(gdi.getDirtyRect(HDC)).toEqual({ x: 0, y: 0, width: 1, height: 1 });

    expect(call('SetPixel', HDC, 0, 0, before)).toBe(before);
    expect(call('GetPixel', HDC, 0, 0)).toBe(before);
});

test('a point outside the DC is CLR_INVALID and draws nothing', () => {
    const pixels = surfaceDc(4, 2, [10, 20, 30]);
    const untouched = pixels.slice();
    expect(call('SetPixel', HDC, 4, 0, MAGENTA) >>> 0).toBe(CLR_INVALID);
    expect(call('SetPixel', HDC, -1, 0, MAGENTA) >>> 0).toBe(CLR_INVALID);
    expect(call('SetPixel', 77, 0, 0, MAGENTA) >>> 0).toBe(CLR_INVALID);
    expect(pixels).toEqual(untouched);
    expect(gdi.isDirty(HDC)).toBe(false);
});

test('SetPixelV draws the same pixel and answers BOOL', () => {
    const pixels = surfaceDc(4, 2, [0, 0, 0]);
    expect(call('SetPixelV', HDC, 3, 1, 0x00102030)).toBe(1);
    expect([...pixels.subarray(7 * 4, 8 * 4)]).toEqual([0x30, 0x20, 0x10, 255]);
    expect(call('SetPixelV', HDC, 9, 9, 0x00102030)).toBe(0);
});

test('alternating SetPixel and GetPixel reads the surface once, not once per pair', () => {
    const pixels = surfaceDc(8, 4, [1, 2, 3]);
    for (let i = 0; i < 200; i++) {
        const x = i % 8, y = (i >> 3) % 4, color = (i * 0x010305) & 0xFFFFFF;
        expect(call('SetPixel', HDC, x, y, color)).toBe(color);
        expect(call('GetPixel', HDC, x, y)).toBe(color);
        expect(call('GetPixel', HDC, (x + 1) % 8, y)).toBe(
            pixels[(y * 8 + (x + 1) % 8) * 4]! | (pixels[(y * 8 + (x + 1) % 8) * 4 + 1]! << 8) | (pixels[(y * 8 + (x + 1) % 8) * 4 + 2]! << 16));
    }
    expect(pixels.context.reads).toEqual([32]);
});

test('SetPixel alone never reads the surface back', () => {
    const pixels = surfaceDc(8, 4, [0, 0, 0]);
    for (let i = 0; i < 100; i++) call('SetPixel', HDC, i % 8, i % 4, 0x00123456);
    expect(pixels.context.reads).toEqual([]);
});

test('a point inside the DC but outside its clip region is CLR_INVALID', () => {
    const pixels = surfaceDc(8, 4, [9, 9, 9]);
    (gdi.hdcStates.get(HDC) as any).clip = { region: { rects: [0, 0, 2, 2, 4, 0, 6, 2], x1: 0, y1: 0, x2: 6, y2: 2 } };
    const untouched = pixels.slice();
    expect(call('SetPixel', HDC, 3, 1, MAGENTA) >>> 0).toBe(CLR_INVALID);
    expect(call('SetPixel', HDC, 1, 3, MAGENTA) >>> 0).toBe(CLR_INVALID);
    expect([...pixels]).toEqual([...untouched]);
    expect(gdi.isDirty(HDC)).toBe(false);
    expect(call('SetPixel', HDC, 5, 1, MAGENTA)).toBe(MAGENTA);
});

function dibSection(width: number, height: number, bpp: number, extra: Record<string, unknown> = {}) {
    const pixels = surfaceDc(width, height, [0, 0, 0]);
    const stride = (((width * bpp + 31) >> 5) << 2);
    memory.fill(0, BITS, BITS + stride * height);
    const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: 'BITMAP', width, height, bitsPtr: BITS, dibBpp: bpp, dibStride: stride, dibTopDown: true, ...extra,
    } as never);
    (gdi.hdcStates.get(HDC) as any).hBitmap = hBitmap;
    return { pixels, stride };
}

const PALETTE = new Uint32Array([0xff000000, 0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffffff, 0xffff00ff]);

test('8 bpp DIB section: the palette index lands in the guest bits and the palette colour comes back', () => {
    const { pixels, stride } = dibSection(8, 2, 8, { dibPalette: PALETTE });
    expect(call('SetPixel', HDC, 3, 1, 0x00F010F8)).toBe(MAGENTA);
    expect(memory[BITS + stride + 3]).toBe(5);
    expect([...pixels.subarray((8 + 3) * 4, (8 + 3) * 4 + 3)]).toEqual([255, 0, 255]);
    expect(call('GetPixel', HDC, 3, 1)).toBe(MAGENTA);
    expect(pixels.context.reads).toEqual([16]);
});

test('4 bpp DIB section: only the addressed nibble changes', () => {
    const { stride } = dibSection(8, 2, 4, { dibPalette: PALETTE });
    memory[BITS + stride] = 0x34;
    expect(call('SetPixel', HDC, 0, 1, 0x000000FF)).toBe(0x000000FF);
    expect(memory[BITS + stride]).toBe(0x14);
    expect(call('SetPixel', HDC, 1, 1, 0x0000FF00)).toBe(0x0000FF00);
    expect(memory[BITS + stride]).toBe(0x12);
});

test('16 bpp 565 DIB section: the stored pixel and the returned colour are the quantized one', () => {
    const { pixels } = dibSection(4, 1, 16, { dibMasks: [0xf800, 0x07e0, 0x001f] });
    expect(call('SetPixel', HDC, 2, 0, MAGENTA)).toBe(MAGENTA);
    expect(memory[BITS + 4]! | (memory[BITS + 5]! << 8)).toBe(0xf81f);
    const set = call('SetPixel', HDC, 1, 0, 0x00818283);
    expect(memory[BITS + 2]! | (memory[BITS + 3]! << 8)).toBe((16 << 11) | (32 << 5) | 16);
    expect(set).toBe(0x00848284);
    expect(call('GetPixel', HDC, 1, 0)).toBe(set);
    expect(pixels.context.reads).toEqual([4]);
});

test('24 and 32 bpp DIB sections take the pixel as B,G,R without a canvas read-back', () => {
    for (const bpp of [24, 32]) {
        const { pixels } = dibSection(4, 2, bpp);
        expect(call('SetPixel', HDC, 1, 1, 0x00102030)).toBe(0x00102030);
        const o = BITS + (((4 * bpp + 31) >> 5) << 2) + (bpp >> 3);
        expect([memory[o], memory[o + 1], memory[o + 2]]).toEqual([0x10, 0x20, 0x30]);
        expect(pixels.context.reads).toEqual([]);
    }
});
