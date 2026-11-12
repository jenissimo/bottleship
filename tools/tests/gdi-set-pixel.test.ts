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

const system = System.getInstance();
const originalGdi = system.gdiContext;
const originalProcess = system.process;
const memory = new Uint8Array(4096);
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
        canvas, fillStyle: '#000',
        fillRect(x: number, y: number, w: number, h: number) {
            const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(this.fillStyle)!.slice(1).map(Number);
            for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
                if (col < 0 || row < 0 || col >= width || row >= height) continue;
                pixels.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], (row * width + col) * 4);
            }
        },
        getImageData(x: number, y: number, w: number, h: number) {
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
    return pixels;
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
