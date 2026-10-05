/**
 * DirectDraw source-colour-key contract.
 *
 * Two rules, both learned the hard way, both cheap to break again:
 *
 * 1. KEYING IS NON-DESTRUCTIVE OF COLOUR. `SetColorKey(DDCKEY_SRCBLT, …)` does not
 *    modify a surface's pixels — it records a per-OPERATION modifier. Every consumer
 *    applies it by comparing the SAMPLED colour against the key: the colour-key blit
 *    shader (generateColorKeyBlitShaderCode) and the D3D COLORKEYENABLE path
 *    (prepareDraw). So when the CPU→GPU decode bakes the key into the cached RGBA it
 *    may clear ALPHA only. Zeroing RGB destroys exactly the texels those comparisons
 *    need, the key can never match again, and the "transparent" region is composited
 *    as an OPAQUE BLACK RECTANGLE. It also corrupts guest pixels, because that buffer
 *    is cached as rgbaScratch and written back by syncToCPUFromScratch.
 *
 * 2. ONLY THE COLOUR BITS OF THE KEY ARE SIGNIFICANT. The key is expressed in the
 *    surface's pixel format; the padding/alpha bits of an X8R8G8B8 or X1R5G5B5 surface
 *    are don't-care. Games write SetColorKey(0x00ff00ff) into surfaces whose stored
 *    texels are 0xffff00ff, so a raw full-DWORD compare never matches. Paletted formats
 *    carry no RGB masks — there the key IS the raw index and must compare in full.
 *
 * Pinned against the DDraw semantics Wine's conformance tests exercise on real Windows
 * (dlls/ddraw/tests/ddraw7.c `test_colorkey_blit` / `test_transparency`): a keyed Blt
 * leaves the destination untouched where the source matches the key, and a NON-keyed
 * Blt of the same surface copies the key colour through unchanged.
 */

import { describe, expect, test } from "bun:test";
import { convertSurfaceToRGBA } from "../../src/worker/modules/ddraw/gpu-texture-utils";
import { copySurfaceRegionWithColorKey } from "../../src/worker/modules/ddraw/surface-helpers";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

const XRGB8888 = { flags: 0x40, bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0 };
const MAGENTA_KEY = { low: 0x00ff00ff, high: 0x00ff00ff };

/** 32bpp surface state over `mem` at `ptr`, w×h, no row padding. */
function surface(ptr: number, w: number, h: number): DirectDrawSurfaceState {
    return {
        surfaceType: "render_surface",
        width: w,
        height: h,
        pitch: w * 4,
        caps: 0x840, // OFFSCREENPLAIN | SYSTEMMEMORY
        surfacePtr: ptr,
        surfacePtrAllocated: true,
        attachedSurfaceAddr: 0,
        format: XRGB8888,
        mode: "CPU",
        version: 1,
        gpuDirty: false,
        everLocked: false,
        lastUploadVersion: -1,
    } as unknown as DirectDrawSurfaceState;
}

/** Fill w×h 32bpp pixels at `ptr` with the little-endian DWORD `value`. */
function fill(mem: Uint8Array, ptr: number, w: number, h: number, value: number): void {
    new Uint32Array(mem.buffer, ptr, w * h).fill(value >>> 0);
}

describe("colour key is not baked destructively into the cached RGBA", () => {
    test("keyed texels keep their RGB and lose only alpha", () => {
        const w = 4, h = 2, ptr = 0x1000;
        const mem = new Uint8Array(0x4000);
        // Opaque magenta everywhere — the texel a game stores when it clears a sprite
        // surface to its colour key (alpha byte set, key written without it).
        fill(mem, ptr, w, h, 0xffff00ff);

        const rgba = convertSurfaceToRGBA(mem, ptr, w, h, w * 4, XRGB8888, undefined, MAGENTA_KEY);
        const px = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);

        for (let i = 0; i < w * h; i++) {
            // RGBA little-endian is 0xAABBGGRR: magenta = R 0xff, G 0, B 0xff.
            expect(px[i] & 0x00ffffff).toBe(0x00ff00ff);
            expect(px[i] >>> 24).toBe(0);
        }
        // The failure this guards: an all-zero texel can never match the key again, so
        // the colour-key blit discards nothing and paints an opaque black rectangle.
        expect(px[0]).not.toBe(0);
    });

    test("non-keyed texels are untouched", () => {
        const w = 2, h = 1, ptr = 0x1000;
        const mem = new Uint8Array(0x4000);
        fill(mem, ptr, w, h, 0xff204080);

        const rgba = convertSurfaceToRGBA(mem, ptr, w, h, w * 4, XRGB8888, undefined, MAGENTA_KEY);
        const px = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
        expect(px[0] >>> 24).toBe(0xff);
        expect(px[0] & 0x00ffffff).toBe(0x00804020); // 0xAABBGGRR
    });
});

describe("CPU colour-key blit compares only the key's colour bits", () => {
    test("opaque magenta source over an X8R8G8B8 key leaves the destination intact", () => {
        const w = 4, h = 2;
        const srcPtr = 0x1000, dstPtr = 0x2000;
        const mem = new Uint8Array(0x4000);
        fill(mem, srcPtr, w, h, 0xffff00ff); // alpha byte set, key written without it
        fill(mem, dstPtr, w, h, 0xff112233); // the background that must survive

        copySurfaceRegionWithColorKey(
            mem, surface(srcPtr, w, h), surface(dstPtr, w, h),
            { left: 0, top: 0, right: w, bottom: h },
            { left: 0, top: 0, right: w, bottom: h },
            MAGENTA_KEY,
        );

        const dst = new Uint32Array(mem.buffer, dstPtr, w * h);
        for (let i = 0; i < w * h; i++) expect(dst[i] >>> 0).toBe(0xff112233);
    });

    test("non-matching texels are still copied", () => {
        const w = 2, h = 1;
        const srcPtr = 0x1000, dstPtr = 0x2000;
        const mem = new Uint8Array(0x4000);
        fill(mem, srcPtr, w, h, 0xff00ff00);
        fill(mem, dstPtr, w, h, 0xff112233);

        copySurfaceRegionWithColorKey(
            mem, surface(srcPtr, w, h), surface(dstPtr, w, h),
            { left: 0, top: 0, right: w, bottom: h },
            { left: 0, top: 0, right: w, bottom: h },
            MAGENTA_KEY,
        );

        const dst = new Uint32Array(mem.buffer, dstPtr, w * h);
        for (let i = 0; i < w * h; i++) expect(dst[i] >>> 0).toBe(0xff00ff00);
    });
});
