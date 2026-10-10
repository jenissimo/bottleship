import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { GDIContext } from '../../src/worker/modules/gdi32/context';
import { extTextOut } from '../../src/worker/modules/gdi32/ext-text-out';
import { createPaintingExports } from '../../src/worker/modules/gdi32/painting';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';

const system = System.getInstance();
const originalGdi = system.gdiContext;
const originalProcess = system.process;
const memory = new Uint8Array(8192);
const view = new DataView(memory.buffer);
let gdi: GDIContext;

beforeEach(() => {
    memory.fill(0);
    Mem.bind(() => memory);
    gdi = new GDIContext();
    system.gdiContext = gdi;
    system.process = { getCurrentMemory: () => memory } as never;
});
afterEach(() => { system.gdiContext = originalGdi; system.process = originalProcess; });

function pixelsContext(width: number, height: number) {
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const canvas: any = { width, height };
    const context: any = {
        canvas, pixels, fillStyle: '#fff',
        fillRect(x: number, y: number, w: number, h: number) {
            const color = this.fillStyle === '#000' ? 0 : 255;
            for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
                if (col < 0 || row < 0 || col >= width || row >= height) continue;
                const i = (row * width + col) * 4;
                pixels[i] = pixels[i + 1] = pixels[i + 2] = color;
            }
        },
        getImageData(x: number, y: number, w: number, h: number) {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let row = 0; row < h; row++) data.set(pixels.subarray(((row + y) * width + x) * 4, ((row + y) * width + x + w) * 4), row * w * 4);
            return { data, width: w, height: h };
        },
    };
    canvas.getContext = () => context;
    return context;
}

function state() {
    return { brushColor: '#fff', textColor: '#fff', textColorValue: 0xffffff, bkMode: 1, bkColor: '#000',
        font: '16px sans-serif', fontSize: 16, fontQuality: 0, textEscapement: 0, textAlign: 0,
        appliedFont: '', appliedFillStyle: '', hBrush: 0, hPen: 0, hFont: 0, hBitmap: 0,
        imageDataDirty: true, dirty: false, dirtyRect: null } as any;
}

test('empty ETO_OPAQUE clears exactly the rectangle on DC, mirror and guest DIB, preserving alpha', () => {
    const dc = pixelsContext(8, 2), mirror = pixelsContext(8, 2);
    dc.canvas.__bitmapCanvas = mirror.canvas;
    gdi.contexts.set(1, dc);
    const s = state();
    memory.fill(255, 4096, 4096 + 64);
    for (let i = 0; i < 16; i++) memory[4096 + i * 4 + 3] = 127;
    s.hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: 'BITMAP', width: 8, height: 2, bitsPtr: 4096, dibBpp: 32, dibStride: 32, dibTopDown: true,
    } as never);
    gdi.hdcStates.set(1, s);
    [2, 0, 5, 2].forEach((n, i) => view.setInt32(256 + i * 4, n, true));
    expect(extTextOut([1, 0, 0, 2, 256, 0, 0, 0], false)).toBe(1);
    for (let i = 0; i < 16; i++) {
        const color = i % 8 >= 2 && i % 8 < 5 ? 0 : 255;
        expect([...memory.subarray(4096 + i * 4, 4096 + i * 4 + 4)]).toEqual([color, color, color, 127]);
        expect(dc.pixels[i * 4]).toBe(color);
        expect(mirror.pixels[i * 4]).toBe(color);
    }
    expect(s.brushColor).toBe('#fff');
    expect(s.bkMode).toBe(1);
});

test('ETO_CLIPPED is temporary and ETO_PDY advances the current position by caller spacing', () => {
    gdi.contexts.set(1, pixelsContext(30, 20));
    const s = state(); s.textAlign = 1;
    gdi.hdcStates.set(1, s);
    gdi.setCurrentPosition(1, 3, 4);
    gdi.intersectClipRect(1, 0, 0, 20, 20);
    const before = gdi.getClip(1);
    const draws: any[] = [];
    gdi.textOut = (hdc, x, y, text) => { draws.push({ x, y, text, clip: gdi.getClipBox(hdc), align: s.textAlign }); return true; };
    [5, 1, 10, 8].forEach((n, i) => view.setInt32(256 + i * 4, n, true));
    view.setUint16(512, 0x41, true); view.setUint16(514, 0x42, true);
    [7, 2, -3, 5].forEach((n, i) => view.setInt32(768 + i * 4, n, true));
    expect(extTextOut([1, 99, 99, 4 | 0x2000, 256, 512, 2, 768], true)).toBe(1);
    expect(draws.map(d => [d.x, d.y, d.text, d.align])).toEqual([[3, 4, 'A', 0], [10, 6, 'B', 0]]);
    expect(draws[0].clip).toMatchObject({ left: 5, top: 1, right: 10, bottom: 8 });
    expect(gdi.getClip(1)).toBe(before);
    expect(gdi.getCurrentPosition(1)).toEqual({ x: 7, y: 11 });
    expect(s.textAlign).toBe(1);
});

test('ABC widths retain negative bearings and blank glyphs while their sum equals the advance', () => {
    const exports = createPaintingExports();
    gdi.getMeasureContext = () => ({ measureText: (text: string) => text === 'j'
        ? { width: 8, actualBoundingBoxLeft: 2.25, actualBoundingBoxRight: 8.25 }
        : { width: 6, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 } }) as never;
    expect(exports.GetCharABCWidthsA(null as never, memory, [1, 106, 106, 1024])).toBe(1);
    expect([0, 4, 8].map(i => view.getInt32(1024 + i, true))).toEqual([-3, 12, -1]);
    expect(exports.GetCharABCWidthsW(null as never, memory, [1, 32, 32, 1024])).toBe(1);
    expect([0, 4, 8].map(i => view.getInt32(1024 + i, true))).toEqual([0, 0, 6]);
});

test('selecting a differently sized bitmap reapplies the DC font after Canvas resets its state', () => {
    const dc = pixelsContext(2, 2);
    dc.font = '24px sans-serif';
    dc.measureText = () => ({ width: dc.font === '24px sans-serif' ? 24 : 10 });
    dc.clearRect = () => {};
    dc.drawImage = () => {};
    let width = 2, height = 2;
    Object.defineProperties(dc.canvas, {
        width: { get: () => width, set: (value: number) => { width = value; dc.font = '10px sans-serif'; } },
        height: { get: () => height, set: (value: number) => { height = value; dc.font = '10px sans-serif'; } },
    });
    const s = state(); s.font = s.appliedFont = '24px sans-serif'; s.appliedFillStyle = '#abc';
    gdi.contexts.set(1, dc); gdi.hdcStates.set(1, s);
    gdi.contexts.set(2, pixelsContext(20, 20));
    gdi.createBitmapDC = () => 2;
    gdi.objects.set(99, { handle: 99, type: 'BITMAP', data: { width: 20, height: 20 } });
    gdi.selectObject(1, 99);
    expect(dc.font).toBe('10px sans-serif');
    expect(s.appliedFont).toBe('');
    expect(s.appliedFillStyle).toBe('');
    expect(gdi.getMeasureContext(1)?.measureText('X').width).toBe(24);
    expect(dc.font).toBe('24px sans-serif');
    expect(s.hBitmap).toBe(99);
});
