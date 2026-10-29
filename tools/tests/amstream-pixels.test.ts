/**
 * Movie frames into DirectDraw sample surfaces: each RGB layout gets its channels at the
 * positions its masks name, truncated to the mask width, and the destination pitch and
 * source stride are honoured independently.
 */
import { describe, expect, test } from "bun:test";
import { isPackableRgb, packBgraRows } from "../../src/worker/modules/amstream-pixels";

/** One BGRA pixel: r=0xF8 g=0x84 b=0x18 (565 encodes it exactly as 0xFC23). */
const PIXEL = [0x18, 0x84, 0xf8, 0xff];

describe("packBgraRows", () => {
    test("RGB565", () => {
        const dst = new Uint8Array(2);
        packBgraRows(new Uint8Array(PIXEL), 4, 1, 1, dst, 0, 2, { bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f });
        expect(dst[0]! | (dst[1]! << 8)).toBe((0xf8 >> 3) << 11 | (0x84 >> 2) << 5 | (0x18 >> 3));
    });

    test("RGB555", () => {
        const dst = new Uint8Array(2);
        packBgraRows(new Uint8Array(PIXEL), 4, 1, 1, dst, 0, 2, { bpp: 16, rMask: 0x7c00, gMask: 0x03e0, bMask: 0x001f });
        expect(dst[0]! | (dst[1]! << 8)).toBe((0xf8 >> 3) << 10 | (0x84 >> 3) << 5 | (0x18 >> 3));
    });

    test("X8R8G8B8 and A8R8G8B8 (alpha filled opaque)", () => {
        const xrgb = new Uint8Array(4);
        packBgraRows(new Uint8Array(PIXEL), 4, 1, 1, xrgb, 0, 4, { bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff });
        expect([...xrgb]).toEqual([0x18, 0x84, 0xf8, 0x00]);
        const argb = new Uint8Array(4);
        packBgraRows(new Uint8Array(PIXEL), 4, 1, 1, argb, 0, 4,
            { bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff, aMask: 0xff000000 });
        expect([...argb]).toEqual([0x18, 0x84, 0xf8, 0xff]);
    });

    test("24-bit BGR", () => {
        const dst = new Uint8Array(3);
        packBgraRows(new Uint8Array(PIXEL), 4, 1, 1, dst, 0, 3, { bpp: 24, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff });
        expect([...dst]).toEqual([0x18, 0x84, 0xf8]);
    });

    test("destination pitch and offset, source stride", () => {
        // 2x2 frame inside a 4-pixel-wide source row; written at (1,1) of a 3x3 32-bit surface.
        const src = new Uint8Array(4 * 4 * 2);
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) src[y * 16 + x * 4] = 10 * y + x + 1;
        const pitch = 12;
        const dst = new Uint8Array(pitch * 3);
        packBgraRows(src, 16, 2, 2, dst, pitch + 4, pitch, { bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff });
        const blue = (x: number, y: number) => dst[y * pitch + x * 4];
        expect([blue(1, 1), blue(2, 1), blue(1, 2), blue(2, 2)]).toEqual([1, 2, 11, 12]);
        expect([blue(0, 0), blue(0, 1), blue(1, 0)]).toEqual([0, 0, 0]);
    });
});

describe("isPackableRgb", () => {
    test("RGB layouts are packable, palettized ones are not", () => {
        expect(isPackableRgb({ bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f })).toBe(true);
        expect(isPackableRgb({ bpp: 8, rMask: 0, gMask: 0, bMask: 0 })).toBe(false);
        expect(isPackableRgb({ bpp: 32, rMask: 0, gMask: 0, bMask: 0 })).toBe(false);
    });
});
