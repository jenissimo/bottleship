/**
 * Text drawn into a DC whose bitmap is a DIB section goes over the section's CURRENT bits.
 *
 * An app paints those bits itself (its own blitter restoring a background each frame) and
 * then calls TextOut/DrawText on the DC. The rect mirrored back into the bits is wider
 * than the glyphs, so it has to start from the bits; starting from the canvas returned
 * whatever the canvas held when the section was selected: a black box under every label,
 * and every earlier string still showing under the new one.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { textOut } from "../../src/worker/modules/gdi32/gdi-text";
import { refreshCanvasFromDibSectionRect, resolveDibSectionRectRgba } from "../../src/worker/modules/gdi32/bitmap-resolve";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { System } from "../../src/worker/core/system";
import type { GDIContext } from "../../src/worker/modules/gdi32/context";

const W = 40, H = 20, STRIDE = W * 4, BITS_PTR = 0x800, HDC = 0x20001;

beforeAll(() => {
    (globalThis as { ImageData?: unknown }).ImageData ??= class {
        data: Uint8ClampedArray;
        constructor(public width: number, public height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
    };
});
afterEach(() => { (System as unknown as { instance: unknown }).instance = undefined; });

/** A pixel-backed 2D context: fillText marks one pixel at its origin with the fill colour. */
function pixelCanvas() {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    let imageDataObjects = 0;
    const ctx = {
        font: "10px dib-text-test", fillStyle: "#ffffff", textAlign: "left", textBaseline: "top", canvas: {},
        measureText: (t: string) => ({ width: t.length * 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: t.length * 2, fontBoundingBoxAscent: 1, fontBoundingBoxDescent: 9 }),
        fillText(_t: string, x: number, y: number) { const o = ((y | 0) * W + (x | 0)) * 4; px[o] = px[o + 1] = px[o + 2] = 255; },
        getImageData(x: number, y: number, w: number, h: number) {
            const out = new Uint8ClampedArray(w * h * 4);
            for (let r = 0; r < h; r++) out.set(px.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + w) * 4), r * w * 4);
            return { data: out, width: w, height: h };
        },
        putImageData(img: { data: Uint8ClampedArray; width: number }, dx: number, dy: number, sx = 0, sy = 0, sw = img.width, sh = 0) {
            imageDataObjects++;
            for (let r = 0; r < sh; r++) for (let c = 0; c < sw; c++) {
                const s = ((sy + r) * img.width + sx + c) * 4, d = ((dy + sy + r) * W + dx + sx + c) * 4;
                px[d] = img.data[s]; px[d + 1] = img.data[s + 1]; px[d + 2] = img.data[s + 2]; px[d + 3] = img.data[s + 3];
            }
        },
    };
    return { ctx, px, puts: () => imageDataObjects };
}

function setup() {
    const mem = new Uint8Array(BITS_PTR + STRIDE * H + 16);
    // The app's own painting: every pixel blue (B,G,R,x).
    for (let i = 0; i < W * H; i++) mem[BITS_PTR + i * 4] = 0xff;
    (System as unknown as { instance: unknown }).instance = { process: { getCurrentMemory: () => mem } };
    const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP", width: W, height: H, bitsPtr: BITS_PTR, dibBpp: 32, dibStride: STRIDE, dibTopDown: true,
    } as never);
    const canvas = pixelCanvas();
    const state = {
        font: canvas.ctx.font, appliedFont: canvas.ctx.font, textColor: "#ffffff", appliedFillStyle: "#ffffff",
        textColorValue: 0xffffff, textAlign: 0, fontSize: 10, fontQuality: 0, textEscapement: 0, bkMode: 1,
        bkColor: "#000000", hBitmap,
    };
    const gdi = {
        contexts: new Map([[HDC, canvas.ctx]]), hdcStates: new Map([[HDC, state]]), overlayCtx: null,
        setOverlayDirty() {}, getCurrentPosition: () => ({ x: 0, y: 0 }), setCurrentPosition() {},
        beginClipOn: () => false, expandDirtyRect() {}, markDirty() {}, invalidateImageDataCache() {},
        clipCopyRect: (_h: number, x: number, y: number, w: number, h: number) => {
            const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
            const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
            return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
        },
    };
    const bgr = (x: number, y: number) => [...mem.subarray(BITS_PTR + (y * W + x) * 4, BITS_PTR + (y * W + x) * 4 + 3)];
    return { gdi: gdi as unknown as GDIContext, canvas, mem, bgr, hBitmap };
}

describe("text into a DIB-section DC", () => {
    test("TextOut keeps the app's pixels around the glyphs", () => {
        const { gdi, bgr } = setup();
        expect(textOut(gdi, HDC, 10, 5, "ab")).toBe(true);
        expect(bgr(10, 5)).toEqual([255, 255, 255]);   // the glyph
        expect(bgr(11, 5)).toEqual([255, 0, 0]);       // beside it, inside the mirrored rect: still the app's blue
        expect(bgr(9, 4)).toEqual([255, 0, 0]);
        expect(bgr(30, 15)).toEqual([255, 0, 0]);      // outside the rect: untouched
    });

    test("a second string does not bring the first one back", () => {
        const { gdi, bgr, mem } = setup();
        textOut(gdi, HDC, 10, 5, "ab");
        // The app repaints its background over the old text, straight into the bits.
        for (let i = 0; i < W * H; i++) { mem[BITS_PTR + i * 4] = 0xff; mem[BITS_PTR + i * 4 + 1] = 0; mem[BITS_PTR + i * 4 + 2] = 0; }
        textOut(gdi, HDC, 12, 5, "cd");
        expect(bgr(12, 5)).toEqual([255, 255, 255]);
        expect(bgr(10, 5)).toEqual([255, 0, 0]);
    });

    test("the refresh reuses one scratch buffer and ignores a bitmap without guest bits", () => {
        const { canvas, hBitmap, gdi } = setup();
        const made: number[] = [];
        const Real = (globalThis as unknown as { ImageData: new (w: number, h: number) => unknown }).ImageData;
        (globalThis as unknown as { ImageData: unknown }).ImageData = class extends (Real as new (w: number, h: number) => object) {
            constructor(w: number, h: number) { super(w, h); made.push(w * h); }
        };
        try {
            const ctx = canvas.ctx as unknown as OffscreenCanvasRenderingContext2D;
            for (let i = 0; i < 100; i++) expect(refreshCanvasFromDibSectionRect(gdi, HDC, hBitmap, ctx, 2, 2, 12, 8)).toBe(true);
            expect(made.length).toBeLessThanOrEqual(1);
            const plain = SystemResourceProvider.getInstance().registerUserObject({ type: "BITMAP", width: W, height: H } as never);
            const before = canvas.puts();
            expect(refreshCanvasFromDibSectionRect(gdi, HDC, plain, ctx, 2, 2, 12, 8)).toBe(false);
            expect(canvas.puts()).toBe(before);
        } finally {
            (globalThis as unknown as { ImageData: unknown }).ImageData = Real;
        }
    });
    // The scratch only grows, so after one large rect every smaller one is converted into
    // a buffer wider than itself: rows must land at the buffer's width, not the rect's.
    for (const bpp of [32, 16, 8]) {
        test(`a ${bpp} bpp rect narrower than the scratch keeps its rows in step`, () => {
            const bytes = bpp / 8, stride = (W * bytes + 3) & ~3;
            const mem = new Uint8Array(BITS_PTR + stride * H + 16);
            // Every pixel differs from its neighbours in both directions.
            const palette = Array.from({ length: 256 }, (_v, i) => (0xff000000 | (i << 16) | ((255 - i) << 8) | ((i * 7) & 0xff)) >>> 0);
            const expected = new Uint8ClampedArray(W * H * 4);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const o = BITS_PTR + y * stride + x * bytes, e = (y * W + x) * 4;
                if (bpp === 32) {
                    mem[o] = x * 5; mem[o + 1] = y * 11; mem[o + 2] = x + y;
                    expected.set([x + y, y * 11, x * 5, 255], e);
                } else if (bpp === 16) {
                    const r5 = x & 31, g6 = (y * 3) & 63, b5 = (x + y) & 31, v = (r5 << 11) | (g6 << 5) | b5;
                    mem[o] = v & 0xff; mem[o + 1] = v >> 8;
                } else {
                    const i = (x * 3 + y * 17) & 0xff;
                    mem[o] = i;
                    expected.set([i, 255 - i, (i * 7) & 0xff, 255], e);
                }
            }
            (System as unknown as { instance: unknown }).instance = { process: { getCurrentMemory: () => mem } };
            const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
                type: "BITMAP", width: W, height: H, bitsPtr: BITS_PTR, dibBpp: bpp, dibStride: stride, dibTopDown: true,
                ...(bpp === 16 ? { dibMasks: [0xf800, 0x07e0, 0x001f] } : {}), ...(bpp === 8 ? { dibPalette: palette } : {}),
            } as never);
            // 16 bpp channel expansion is the decoder's business: take the whole bitmap,
            // converted into a buffer of exactly its own size, as the reference.
            if (bpp === 16) expected.set(resolveDibSectionRectRgba(hBitmap, mem, 0, 0, W, H)!.data);
            const canvas = pixelCanvas();
            const ctx = canvas.ctx as unknown as OffscreenCanvasRenderingContext2D;
            let dropped = 0;
            const gdi = { invalidateImageDataCache: () => { dropped++; } };
            // Grow the shared scratch to the whole bitmap, then refresh a small inner rect.
            expect(refreshCanvasFromDibSectionRect(gdi, HDC, hBitmap, ctx, 0, 0, W, H)).toBe(true);
            canvas.px.fill(0);
            expect(refreshCanvasFromDibSectionRect(gdi, HDC, hBitmap, ctx, 7, 3, 9, 6)).toBe(true);
            expect(dropped).toBe(2);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const e = (y * W + x) * 4, inside = x >= 7 && x < 16 && y >= 3 && y < 9;
                const want = inside ? [...expected.subarray(e, e + 4)] : [0, 0, 0, 0];
                if (canvas.px[e] !== want[0] || canvas.px[e + 1] !== want[1] || canvas.px[e + 2] !== want[2] || canvas.px[e + 3] !== want[3]) {
                    expect({ x, y, got: [...canvas.px.subarray(e, e + 4)] }).toEqual({ x, y, got: want });
                }
            }
        });
    }
});
