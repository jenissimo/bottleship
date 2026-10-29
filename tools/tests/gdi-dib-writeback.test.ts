/**
 * A DIBSection's guest bits ARE its pixel surface, so every draw into a DC with one
 * selected has to land there. Two properties that are invisible on screen and only show
 * up when the guest reads the bits back:
 *
 *  - 32bpp write-back leaves the fourth byte alone. It is the app's (BI_RGB calls it
 *    reserved, and layered-window code puts alpha in it); zeroing it makes a later
 *    AlphaBlend render the drawn rect fully transparent.
 *  - 1bpp write-back quantizes to the colour table's two entries, MSB first, and touches
 *    no bit outside the rect — neighbouring pixels share its bytes.
 *  - 16bpp write-back packs through the section's masks (5-5-5 for BI_RGB), 24bpp as B,G,R.
 *    Text an app draws into a 16-bit section to build its own glyph textures lives there.
 */
import { afterEach, expect, test } from "bun:test";
import { writeBackDibSectionRect } from "../../src/worker/modules/gdi32/bitmap-resolve";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { System } from "../../src/worker/core/system";

const BITS_PTR = 0x800;

/** Minimal 2D context: only getImageData is reached from the write-back. */
function fakeContext(pixels: Uint8ClampedArray, width: number, height: number) {
    return {
        getImageData(x: number, y: number, w: number, h: number) {
            const out = new Uint8ClampedArray(w * h * 4);
            for (let row = 0; row < h; row++) {
                const src = ((y + row) * width + x) * 4;
                out.set(pixels.subarray(src, src + w * 4), row * w * 4);
            }
            return { data: out, width: w, height: h } as ImageData;
        },
    } as unknown as OffscreenCanvasRenderingContext2D;
}

function installGuestMemory(mem: Uint8Array): void {
    // Assign the singleton rather than getInstance(): constructing a real System pulls in
    // the whole runtime, and the write-back only reads process.getCurrentMemory().
    (System as unknown as { instance: unknown }).instance = {
        process: { getCurrentMemory: () => mem },
    };
}

afterEach(() => {
    (System as unknown as { instance: unknown }).instance = undefined;
});

test("32bpp write-back preserves the reserved/alpha byte the app owns", () => {
    const w = 4, h = 2, stride = w * 4;
    const mem = new Uint8Array(BITS_PTR + stride * h + 16);
    for (let i = 0; i < w * h; i++) mem[BITS_PTR + i * 4 + 3] = 0x7f;
    installGuestMemory(mem);

    const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP", width: w, height: h,
        bitsPtr: BITS_PTR, dibBpp: 32, dibStride: stride, dibTopDown: true,
    } as never);

    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        pixels[i * 4] = 0x10; pixels[i * 4 + 1] = 0x20; pixels[i * 4 + 2] = 0x30; pixels[i * 4 + 3] = 0xff;
    }
    writeBackDibSectionRect(hBitmap, fakeContext(pixels, w, h), 0, 0, w, h);

    expect([...mem.subarray(BITS_PTR, BITS_PTR + 4)]).toEqual([0x30, 0x20, 0x10, 0x7f]);
});

test("1bpp write-back quantizes to the colour table and leaves neighbours alone", () => {
    // 12 px wide: two bytes of pixels, padded to a DWORD like every Windows DIB row.
    const w = 12, h = 1, stride = 4;
    const mem = new Uint8Array(BITS_PTR + stride * h + 16);
    mem[BITS_PTR] = 0xff;
    mem[BITS_PTR + 1] = 0xff;
    installGuestMemory(mem);

    const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP", width: w, height: h,
        bitsPtr: BITS_PTR, dibBpp: 1, dibStride: stride, dibTopDown: true,
    } as never);

    // Rect covers pixels 4..7 only: white, black, black, white.
    const pixels = new Uint8ClampedArray(w * 4);
    const set = (x: number, v: number) => {
        pixels[x * 4] = v; pixels[x * 4 + 1] = v; pixels[x * 4 + 2] = v; pixels[x * 4 + 3] = 0xff;
    };
    set(4, 0xff); set(5, 0x00); set(6, 0x00); set(7, 0xff);
    writeBackDibSectionRect(hBitmap, fakeContext(pixels, w, h), 4, 0, 4, 1);

    // Top nibble (pixels 0..3) untouched, bottom nibble quantized to 1,0,0,1.
    expect(mem[BITS_PTR]).toBe(0xf9);
    expect(mem[BITS_PTR + 1]).toBe(0xff);
});

function writeOne(dibBpp: number, rgb: [number, number, number], dibMasks?: number[]): Uint8Array {
    const stride = 4;
    const mem = new Uint8Array(BITS_PTR + stride + 16);
    installGuestMemory(mem);
    const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP", width: 1, height: 1,
        bitsPtr: BITS_PTR, dibBpp, dibStride: stride, dibTopDown: true, dibMasks,
    } as never);
    writeBackDibSectionRect(hBitmap, fakeContext(new Uint8ClampedArray([...rgb, 0xff]), 1, 1), 0, 0, 1, 1);
    return mem.subarray(BITS_PTR, BITS_PTR + 4);
}

test("16bpp BI_RGB write-back packs 5-5-5", () => {
    const px = writeOne(16, [0xff, 0x80, 0x00]);
    expect(px[0]! | (px[1]! << 8)).toBe((31 << 10) | (16 << 5));
});

test("16bpp BI_BITFIELDS write-back packs through the masks", () => {
    const px = writeOne(16, [0xff, 0x80, 0x00], [0xf800, 0x07e0, 0x001f]);
    expect(px[0]! | (px[1]! << 8)).toBe((31 << 11) | (32 << 5));
});

test("24bpp write-back stores B,G,R", () => {
    expect([...writeOne(24, [0x10, 0x20, 0x30]).subarray(0, 3)]).toEqual([0x30, 0x20, 0x10]);
});
