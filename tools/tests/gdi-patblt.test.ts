/**
 * PatBlt's BLACKNESS, WHITENESS and DSTINVERT paint without a brush. An app that clears a
 * DIB section with PatBlt(BLACKNESS) before drawing each string into it, then reads the
 * bits back, otherwise gets every earlier string under the new one.
 */
import { afterEach, expect, test } from "bun:test";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { System } from "../../src/worker/core/system";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { patBlt } from "../../src/worker/modules/gdi32/gdi-blit";

const W = 4, H = 2, BITS_PTR = 0x800, STRIDE = W * 2;
const BLACKNESS = 0x42, WHITENESS = 0xff0062, DSTINVERT = 0x550009;

/** A raster 2D context: enough of the API for fills, inversion and write-back reads. */
function rasterCtx() {
    const pixels = new Uint8ClampedArray(W * H * 4).fill(0x80);
    let fillStyle = "";
    const region = (x: number, y: number, w: number, h: number, fn: (o: number) => void) => {
        for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) fn((row * W + col) * 4);
    };
    return {
        pixels,
        canvas: { width: W, height: H },
        get fillStyle() { return fillStyle; },
        set fillStyle(v: string) { fillStyle = v; },
        save() {}, restore() {},
        fillRect(x: number, y: number, w: number, h: number) {
            const v = fillStyle.toLowerCase() === "#ffffff" ? 255 : 0;
            region(x, y, w, h, o => { pixels[o] = pixels[o + 1] = pixels[o + 2] = v; pixels[o + 3] = 255; });
        },
        getImageData(x: number, y: number, w: number, h: number) {
            const data = new Uint8ClampedArray(w * h * 4);
            let i = 0;
            region(x, y, w, h, o => { data.set(pixels.subarray(o, o + 4), i); i += 4; });
            return { data, width: w, height: h };
        },
        putImageData(image: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
            let i = 0;
            region(x, y, image.width, image.height, o => { pixels.set(image.data.subarray(i, i + 4), o); i += 4; });
        },
    };
}

function setup() {
    const mem = new Uint8Array(BITS_PTR + STRIDE * H).fill(0x55);
    (System as unknown as { instance: unknown }).instance = { process: { getCurrentMemory: () => mem } };
    const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP", width: W, height: H, bitsPtr: BITS_PTR, dibBpp: 16, dibStride: STRIDE, dibTopDown: true,
        dibMasks: [0xf800, 0x07e0, 0x001f],
    } as never);
    const gdi = new GDIContext();
    const ctx = rasterCtx();
    const hdc = 0x1234;
    gdi.contexts.set(hdc, ctx as never);
    gdi.hdcStates.set(hdc, { hBitmap, dirty: false, dirtyRect: null, imageDataDirty: true } as never);
    const word = (x: number, y: number) => mem[BITS_PTR + y * STRIDE + x * 2]! | (mem[BITS_PTR + y * STRIDE + x * 2 + 1]! << 8);
    return { gdi, ctx, hdc, word };
}

afterEach(() => { (System as unknown as { instance: unknown }).instance = undefined; });

test("BLACKNESS clears the rect in the DIB section bits", () => {
    const { gdi, hdc, word } = setup();
    expect(patBlt(gdi, hdc, 0, 0, 2, 2, BLACKNESS)).toBe(true);
    expect([word(0, 0), word(1, 1)]).toEqual([0, 0]);
    expect(word(2, 0)).toBe(0x5555);
});

test("WHITENESS fills white; a negative extent reaches left of the origin", () => {
    const { gdi, hdc, word } = setup();
    patBlt(gdi, hdc, 4, 0, -2, 1, WHITENESS);
    expect([word(2, 0), word(3, 0)]).toEqual([0xffff, 0xffff]);
    expect(word(1, 0)).toBe(0x5555);
});

test("DSTINVERT inverts what is there", () => {
    const { gdi, ctx, hdc } = setup();
    patBlt(gdi, hdc, 0, 0, 1, 1, DSTINVERT);
    expect([...ctx.pixels.subarray(0, 3)]).toEqual([0x7f, 0x7f, 0x7f]);
});
