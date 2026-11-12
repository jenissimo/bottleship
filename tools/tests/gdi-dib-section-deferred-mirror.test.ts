// The software-renderer frame is: write the DIB section's bits, SelectObject it into a
// memory DC, BitBlt to the window, deselect. The blit converts the rectangle it reads
// from the guest bits itself, so mirroring the whole section into the canvases on the
// select converted every frame twice (plus two full putImageData and a fresh RGBA buffer).
// The select now only marks the DC; anything that takes the canvas mirrors it first.
// What must not change: every GDI path that draws into or reads from the DIB DC sees the
// guest's current bits, and the guest sees what GDI drew.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { GDIContext } from '../../src/worker/modules/gdi32/context';
import { bitBlt } from '../../src/worker/modules/gdi32/gdi-blit';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';

const system = System.getInstance();
const saved = { gdi: system.gdiContext, process: system.process };
const memory = new Uint8Array(1 << 16);
const BITS = 0x4000;
const SRCCOPY = 0x00CC0020, SRCINVERT = 0x00660046;
let gdi: GDIContext;
let globals: Record<string, PropertyDescriptor | undefined>;

/** A pixel-exact stand-in for a 2D canvas that counts what is done to it. */
class FakeContext {
    pixels: Uint8ClampedArray;
    fillStyle = '#FFFFFF'; strokeStyle = '#000000'; textBaseline = 'top'; globalCompositeOperation = 'source-over';
    puts = 0; putPixels = 0; reads = 0; draws = 0;
    constructor(public canvas: FakeCanvas) { this.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4); }
    private at(x: number, y: number) { return (y * this.canvas.width + x) * 4; }
    putImageData(image: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) {
        this.puts++; this.putPixels += image.width * image.height;
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
            if (dx + x < 0 || dy + y < 0 || dx + x >= this.canvas.width || dy + y >= this.canvas.height) continue;
            this.pixels.set(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4), this.at(dx + x, dy + y));
        }
    }
    getImageData(x: number, y: number, w: number, h: number) {
        this.reads++;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
            data.set(this.pixels.subarray(this.at(x + col, y + row), this.at(x + col, y + row) + 4), (row * w + col) * 4);
        }
        return { data, width: w, height: h };
    }
    drawImage(src: FakeCanvas, sx = 0, sy = 0, sw = src.width, sh = src.height, dx = 0, dy = 0) {
        this.draws++;
        const from = src.context.pixels;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
            if (sx + x >= src.width || sy + y >= src.height || dx + x >= this.canvas.width || dy + y >= this.canvas.height) continue;
            const s = ((sy + y) * src.width + sx + x) * 4;
            this.pixels.set(from.subarray(s, s + 4), this.at(dx + x, dy + y));
        }
    }
    fillRect(x: number, y: number, w: number, h: number) {
        const m = /^rgb\((\d+), ?(\d+), ?(\d+)\)$/.exec(this.fillStyle);
        const rgb = m ? m.slice(1).map(Number) : this.fillStyle.toLowerCase() === '#000000' ? [0, 0, 0] : [255, 255, 255];
        for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
            if (col < 0 || row < 0 || col >= this.canvas.width || row >= this.canvas.height) continue;
            this.pixels.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], this.at(col, row));
        }
    }
    clearRect() { this.pixels.fill(0); }
    createImageData(w: number, h: number) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
    save() { } restore() { } beginPath() { } rect() { } clip() { } setTransform() { } resetTransform() { }
}
class FakeCanvas {
    context: FakeContext;
    options: unknown;
    constructor(public width: number, public height: number) { this.context = new FakeContext(this); }
    getContext(_kind?: string, options?: unknown) { this.options ??= options ?? null; return this.context; }
}

beforeEach(() => {
    globals = {};
    for (const key of ['OffscreenCanvas', 'ImageData', 'createImageBitmap']) globals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    (globalThis as any).OffscreenCanvas = FakeCanvas;
    (globalThis as any).ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) { } };
    delete (globalThis as any).createImageBitmap;
    memory.fill(0);
    Mem.bind(() => memory);
    gdi = new GDIContext();
    system.gdiContext = gdi;
    system.process = { getCurrentMemory: () => memory, v86: { mem8: memory } } as never;
});
afterEach(() => {
    system.gdiContext = saved.gdi; system.process = saved.process;
    for (const [key, descriptor] of Object.entries(globals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    }
});

const ctxOf = (hdc: number) => gdi.peekContext(hdc) as unknown as FakeContext;
const rgbaAt = (hdc: number, x: number, y: number) => {
    const c = ctxOf(hdc); const o = (y * c.canvas.width + x) * 4;
    return [...c.pixels.subarray(o, o + 3)];
};
const stride = (w: number, bpp: number) => (((w * bpp + 31) >> 5) << 2);

function dibSection(w: number, h: number, bpp: number, extra: Record<string, unknown> = {}) {
    return SystemResourceProvider.getInstance().registerUserObject({
        type: 'BITMAP', width: w, height: h, bitsPtr: BITS, dibBpp: bpp, dibStride: stride(w, bpp), dibTopDown: true, ...extra,
    } as never) as number;
}
/** The guest writes one pixel of a top-down section, as B,G,R (true colour) or as a raw value. */
function guestWrite(w: number, bpp: number, x: number, y: number, value: number[] | number) {
    const o = BITS + y * stride(w, bpp) + x * (bpp >> 3);
    if (typeof value === 'number') {
        memory[o] = value & 0xff; if (bpp >= 16) memory[o + 1] = (value >> 8) & 0xff;
    } else {
        memory[o] = value[2]!; memory[o + 1] = value[1]!; memory[o + 2] = value[0]!;
    }
}
function memoryDc(w: number, h: number) { return gdi.createSizedMemoryDC(w, h); }

describe('the frame path: select, blit, deselect', () => {
    for (const bpp of [32, 24]) {
        test(`${bpp} bpp: one conversion of the blitted rectangle, none on the select`, () => {
            const W = 8, H = 4;
            const bmp = dibSection(W, H, bpp);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) guestWrite(W, bpp, x, y, [x * 30, y * 60, 200 - x]);
            const mem = memoryDc(W, H), window = memoryDc(W, H);
            gdi.selectObject(mem, bmp);
            const afterCreate = ctxOf(mem).puts;
            expect(gdi.isDibSectionDeferred(mem)).toBe(true);
            expect(ctxOf(mem).puts).toBe(afterCreate);

            expect(bitBlt(gdi, window, 0, 0, W, H, mem, 0, 0, SRCCOPY)).toBe(true);
            expect(ctxOf(mem).puts).toBe(afterCreate + 1);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) expect(rgbaAt(window, x, y)).toEqual([x * 30, y * 60, 200 - x]);
            expect(gdi.isDibSectionDeferred(mem)).toBe(false);
        });
    }

    test('16 bpp 565 and 555 arrive with each channel widened', () => {
        for (const [masks, value, rgb] of [
            [[0xf800, 0x07e0, 0x001f], 0xf81f, [255, 0, 255]],
            [[0xf800, 0x07e0, 0x001f], (16 << 11) | (32 << 5) | 8, [132, 130, 66]],
            [undefined, 0x7c1f, [255, 0, 255]],
            [undefined, (16 << 10) | (8 << 5) | 31, [132, 66, 255]],
        ] as const) {
            const bmp = dibSection(4, 2, 16, masks ? { dibMasks: masks } : {});
            memory.fill(0, BITS, BITS + 64);
            guestWrite(4, 16, 3, 1, value);
            const mem = memoryDc(4, 2), window = memoryDc(4, 2);
            gdi.selectObject(mem, bmp);
            bitBlt(gdi, window, 0, 0, 4, 2, mem, 0, 0, SRCCOPY);
            expect(rgbaAt(window, 3, 1)).toEqual([...rgb]);
            expect(rgbaAt(window, 0, 0)).toEqual([0, 0, 0]);
        }
    });

    test('8 bpp goes through the colour table as it is at the blit', () => {
        const palette = new Uint32Array(256).fill(0xff000000);
        palette[7] = 0xff102030; palette[200] = 0xffffee00;
        const bmp = dibSection(8, 2, 8, { dibPalette: palette });
        guestWrite(8, 8, 1, 0, 7); guestWrite(8, 8, 6, 1, 200);
        const mem = memoryDc(8, 2), window = memoryDc(8, 2);
        gdi.selectObject(mem, bmp);
        palette[7] = 0xff405060;
        bitBlt(gdi, window, 0, 0, 8, 2, mem, 0, 0, SRCCOPY);
        expect(rgbaAt(window, 1, 0)).toEqual([0x40, 0x50, 0x60]);
        expect(rgbaAt(window, 6, 1)).toEqual([0xff, 0xee, 0x00]);
    });

    test('1 bpp and a bottom-up section', () => {
        const palette = new Uint32Array([0xff0000ff, 0xffffff00]);
        const bmp = SystemResourceProvider.getInstance().registerUserObject({
            type: 'BITMAP', width: 8, height: 2, bitsPtr: BITS, dibBpp: 1, dibStride: 4, dibTopDown: false, dibPalette: palette,
        } as never) as number;
        memory[BITS] = 0b10000001;            // bottom-up: this is the LAST row
        const mem = memoryDc(8, 2), window = memoryDc(8, 2);
        gdi.selectObject(mem, bmp);
        bitBlt(gdi, window, 0, 0, 8, 2, mem, 0, 0, SRCCOPY);
        expect(rgbaAt(window, 0, 1)).toEqual([255, 255, 0]);
        expect(rgbaAt(window, 1, 1)).toEqual([0, 0, 255]);
        expect(rgbaAt(window, 7, 1)).toEqual([255, 255, 0]);
        expect(rgbaAt(window, 0, 0)).toEqual([0, 0, 255]);
    });

    test('the blit shows what the guest wrote after the select', () => {
        const bmp = dibSection(4, 2, 32);
        const mem = memoryDc(4, 2), window = memoryDc(4, 2);
        gdi.selectObject(mem, bmp);
        guestWrite(4, 32, 2, 1, [9, 8, 7]);
        bitBlt(gdi, window, 0, 0, 4, 2, mem, 0, 0, SRCCOPY);
        expect(rgbaAt(window, 2, 1)).toEqual([9, 8, 7]);
    });

    test('1000 frames: nothing accumulates and the conversion buffer is reused', () => {
        const W = 16, H = 8;
        const bmp = dibSection(W, H, 32);
        const window = memoryDc(W, H);
        const obj = SystemResourceProvider.getInstance().getUserObject(bmp) as { rectScratch?: Uint8ClampedArray };
        let scratch: Uint8ClampedArray | undefined;
        const contextsBefore = gdi.contexts.size;
        for (let frame = 0; frame < 1000; frame++) {
            guestWrite(W, 32, frame % W, frame % H, [frame & 255, 1, 2]);
            const mem = gdi.createCompatibleDC(window);
            const previous = gdi.selectObject(mem, bmp);
            bitBlt(gdi, window, 0, 0, W, H, mem, 0, 0, SRCCOPY);
            expect(rgbaAt(window, frame % W, frame % H)).toEqual([frame & 255, 1, 2]);
            gdi.selectObject(mem, previous);
            gdi.deleteDC(mem);
            scratch ??= obj.rectScratch;
            expect(obj.rectScratch).toBe(scratch!);
        }
        expect(gdi.contexts.size).toBe(contextsBefore + 1);       // the bitmap's own cache DC
        expect(gdi.contexts.stale.size).toBeLessThanOrEqual(1);   // that cache DC, still owed its mirror
        gdi.purgeBitmapDC(bmp);
        expect(gdi.contexts.stale.size).toBe(0);
        expect(gdi.contexts.size).toBe(contextsBefore);
    });
});

describe('everything else still sees the bits', () => {
    test('GetPixel on the DIB DC reads the guest bits, also those written after the select', () => {
        const bmp = dibSection(4, 2, 32);
        guestWrite(4, 32, 1, 1, [10, 20, 30]);
        const mem = memoryDc(4, 2);
        gdi.selectObject(mem, bmp);
        guestWrite(4, 32, 3, 0, [1, 2, 3]);
        expect(gdi.getPixel(mem, 1, 1)).toBe(0x001E140A);
        expect(gdi.getPixel(mem, 3, 0)).toBe(0x00030201);
        expect(gdi.isDibSectionDeferred(mem)).toBe(false);
    });

    test('GDI drawing into the DIB keeps the rest of the section and lands in the guest bits', () => {
        const W = 6, H = 2;
        const bmp = dibSection(W, H, 32);
        for (let x = 0; x < W; x++) guestWrite(W, 32, x, 0, [50 + x, 60, 70]);
        const mem = memoryDc(W, H);
        gdi.selectObject(mem, bmp);
        expect(gdi.fillRect(mem, 2, 0, 4, 1, 'rgb(1, 2, 3)')).toBe(true);
        // the guest reads its section back: the fill is there, its own pixels are untouched
        expect([memory[BITS + 2 * 4 + 2], memory[BITS + 2 * 4 + 1], memory[BITS + 2 * 4]]).toEqual([1, 2, 3]);
        expect([memory[BITS + 5 * 4 + 2], memory[BITS + 5 * 4 + 1], memory[BITS + 5 * 4]]).toEqual([55, 60, 70]);
        // and the canvas holds the mirrored section under the fill
        expect(rgbaAt(mem, 5, 0)).toEqual([55, 60, 70]);
        expect(rgbaAt(mem, 3, 0)).toEqual([1, 2, 3]);
        const window = memoryDc(W, H);
        bitBlt(gdi, window, 0, 0, W, H, mem, 0, 0, SRCCOPY);
        expect(rgbaAt(window, 0, 0)).toEqual([50, 60, 70]);
        expect(rgbaAt(window, 2, 0)).toEqual([1, 2, 3]);
    });

    test('a partial blit leaves the DC owed its mirror, and a later read gets it', () => {
        const W = 8, H = 2;
        const bmp = dibSection(W, H, 32);
        for (let x = 0; x < W; x++) guestWrite(W, 32, x, 1, [x, x, x]);
        const mem = memoryDc(W, H), window = memoryDc(W, H);
        gdi.selectObject(mem, bmp);
        bitBlt(gdi, window, 0, 0, 2, 1, mem, 0, 1, SRCCOPY);
        expect(rgbaAt(window, 1, 0)).toEqual([1, 1, 1]);
        expect(gdi.isDibSectionDeferred(mem)).toBe(true);
        expect(gdi.getPixel(mem, 7, 1)).toBe(0x00070707);
    });

    test('a blit that converts nothing (mirrored) mirrors the section first', () => {
        const bmp = dibSection(4, 1, 32);
        guestWrite(4, 32, 0, 0, [200, 100, 50]);
        const mem = memoryDc(4, 1), window = memoryDc(4, 1);
        gdi.selectObject(mem, bmp);
        bitBlt(gdi, window, 3, 0, -4, 1, mem, 0, 0, SRCCOPY);
        expect(gdi.isDibSectionDeferred(mem)).toBe(false);
        expect(rgbaAt(mem, 0, 0)).toEqual([200, 100, 50]);
    });

    test('a bitwise ROP reads the converted rectangle', () => {
        const bmp = dibSection(2, 1, 32);
        guestWrite(2, 32, 1, 0, [0xf0, 0x0f, 0xff]);
        const mem = memoryDc(2, 1), window = memoryDc(2, 1);
        ctxOf(window).fillStyle = 'rgb(255, 255, 255)'; ctxOf(window).fillRect(0, 0, 2, 1);
        gdi.selectObject(mem, bmp);
        bitBlt(gdi, window, 0, 0, 2, 1, mem, 0, 0, SRCINVERT);
        expect(rgbaAt(window, 1, 0)).toEqual([0x0f, 0xf0, 0x00]);
    });

    test('selecting another bitmap or deleting the DC drops what the DC was owed', () => {
        const bmp = dibSection(4, 2, 32);
        const mem = memoryDc(4, 2);
        const previous = gdi.selectObject(mem, bmp);
        expect(gdi.isDibSectionDeferred(mem)).toBe(true);
        gdi.selectObject(mem, previous);
        expect(gdi.isDibSectionDeferred(mem)).toBe(false);
        gdi.selectObject(mem, bmp);
        gdi.deleteDC(mem);
        expect(gdi.contexts.stale.has(mem)).toBe(false);
    });

    test('a savestate capture settles every deferred mirror', () => {
        const bmp = dibSection(4, 2, 32);
        guestWrite(4, 32, 2, 1, [11, 22, 33]);
        const mem = memoryDc(4, 2);
        gdi.selectObject(mem, bmp);
        try { gdi.captureState(); } catch { /* the fake canvas cannot be serialised; the mirror runs before that */ }
        expect(gdi.contexts.stale.size).toBe(0);
        expect(rgbaAt(mem, 2, 1)).toEqual([11, 22, 33]);
    });
});

describe('a section whose bits cannot be read', () => {
    test('the deferred mirror shows the bitmap\'s last image instead of leaving the DC as it was', () => {
        const bmp = dibSection(4, 2, 32);
        guestWrite(4, 32, 1, 0, [40, 50, 60]);
        const mem = memoryDc(4, 2);
        ctxOf(mem).fillStyle = 'rgb(9, 9, 9)'; ctxOf(mem).fillRect(0, 0, 4, 2);
        gdi.selectObject(mem, bmp);
        (system.process as any).v86 = {};
        expect(gdi.getPixel(mem, 1, 0)).toBe(0x003C3228);
        expect(gdi.getPixel(mem, 3, 1)).toBe(0);
    });
});

describe('the window side of the frame', () => {
    test('the retained client image is a read-back canvas like the DC it is copied from', () => {
        const W = 8, H = 4, HWND = 0x10001;
        const overlay = new FakeCanvas(W, H);
        (gdi as any).overlayCanvas = overlay; (gdi as any).overlayCtx = overlay.context;
        const window = memoryDc(W, H);
        gdi.attachWindowBlit(window, 0, 0, W, H);
        ctxOf(window).fillStyle = 'rgb(7, 8, 9)'; ctxOf(window).fillRect(0, 0, W, H);
        gdi.markDirty(window);
        expect(gdi.flushWindowMemoryDCToOverlay(window, [], HWND, null)).toBe(true);
        const backing = gdi.getWindowClientBackingCanvas(HWND) as unknown as FakeCanvas;
        expect(backing.options).toEqual({ willReadFrequently: true });
        expect([...backing.context.pixels.subarray(0, 3)]).toEqual([7, 8, 9]);
        expect([...overlay.context.pixels.subarray(0, 3)]).toEqual([7, 8, 9]);
    });
});
