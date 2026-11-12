/**
 * BINKBUFFER head + BinkBufferBlit's rect copy (src/worker/modules/bink-buffer.ts).
 *
 * The field offsets are the ones a shipped caller dereferences: GTA2's playback loop
 * (gta2.exe 0x481ea0) reads Height@+4, SurfaceType@+0x10, Buffer@+0x14 and
 * BufferPitch@+0x18 straight out of the BinkBufferOpen result and passes them to
 * BinkCopyToBuffer.
 */
import { describe, expect, test } from "bun:test";
import { BB, BINKBUFFER_ALLOC_BYTES, binkSurfaceForPixelFormat, blitBinkRects } from "../../src/worker/modules/bink-buffer";
import { binkDestRowPixels } from "../../src/worker/modules/binkw32";

describe("BinkCopyToBuffer destination row", () => {
    test("a declared 16-bit surface is a full row, not a 32-bit half row", () => {
        // GTA2: buf->BufferPitch 1280, buf->SurfaceType 565 | BINKCOPYALL, no BinkDDSurfaceType.
        expect(binkDestRowPixels(1280, 10 | 0x4000000, 0, null)).toBe(640);
        expect(binkDestRowPixels(1280, 9, 0, null)).toBe(640);
        expect(binkDestRowPixels(2560, 3, 0, null)).toBe(640);
    });
    test("undeclared formats keep the stored bpp, then the pitch heuristic", () => {
        expect(binkDestRowPixels(1280, 0, 2, null)).toBe(640);
        expect(binkDestRowPixels(2560, 0, 0, null)).toBe(640);
    });
});

describe("BINKBUFFER layout", () => {
    test("the fields a caller reads sit at the public bink.h offsets", () => {
        expect(BB.width).toBe(0);
        expect(BB.height).toBe(4);
        expect(BB.surfaceType).toBe(0x10);
        expect(BB.buffer).toBe(0x14);
        expect(BB.bufferPitch).toBe(0x18);
        expect(BB.stretchHeight).toBe(0x40);
        expect(BINKBUFFER_ALLOC_BYTES).toBeGreaterThan(BB.stretchHeight + 4);
    });

    test("pixel formats map onto BINKSURFACE types", () => {
        expect(binkSurfaceForPixelFormat(16, 0xf800, 0x7e0)).toBe(10);
        expect(binkSurfaceForPixelFormat(16, 0x7c00, 0x3e0)).toBe(9);
        expect(binkSurfaceForPixelFormat(32, 0xff0000, 0xff00)).toBe(3);
        expect(binkSurfaceForPixelFormat(32, 0xff, 0xff00)).toBe(4);
        expect(binkSurfaceForPixelFormat(24, 0xff0000, 0xff00)).toBe(1);
        expect(binkSurfaceForPixelFormat(8, 0, 0)).toBe(0);
        expect(binkSurfaceForPixelFormat(12, 0, 0)).toBe(-1);
    });
});

describe("blitBinkRects", () => {
    const bpp = 2;
    const src = new Uint8Array(4 * bpp * 3);
    for (let i = 0; i < src.length; i++) src[i] = i + 1;

    test("copies a rect to the offset position and reports what it wrote", () => {
        const dst = new Uint8Array(6 * bpp * 5);
        const dirty = blitBinkRects(src, 4 * bpp, 4, 3, dst, 6 * bpp, 6, 5, bpp,
            [{ left: 1, top: 1, width: 2, height: 2 }], 2, 1);
        expect(dirty).toEqual({ left: 3, top: 2, right: 5, bottom: 4 });
        const row = (y: number) => Array.from(dst.subarray(y * 12, y * 12 + 12));
        expect(row(0)).toEqual(new Array(12).fill(0));
        expect(row(2)).toEqual([0, 0, 0, 0, 0, 0, 11, 12, 13, 14, 0, 0]);
        expect(row(3)).toEqual([0, 0, 0, 0, 0, 0, 19, 20, 21, 22, 0, 0]);
    });

    test("clips to the destination and to the source", () => {
        const dst = new Uint8Array(3 * bpp * 2);
        const dirty = blitBinkRects(src, 4 * bpp, 4, 3, dst, 3 * bpp, 3, 2, bpp,
            [{ left: 0, top: 0, width: 100, height: 100 }], -1, 0);
        expect(dirty).toEqual({ left: 0, top: 0, right: 3, bottom: 2 });
        expect(Array.from(dst)).toEqual([3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16]);
    });

    test("a rect entirely off-screen writes nothing", () => {
        const dst = new Uint8Array(4 * bpp * 3);
        expect(blitBinkRects(src, 4 * bpp, 4, 3, dst, 4 * bpp, 4, 3, bpp,
            [{ left: 0, top: 0, width: 4, height: 3 }], 10, 10)).toBeNull();
        expect(dst.every((b) => b === 0)).toBe(true);
    });
});
