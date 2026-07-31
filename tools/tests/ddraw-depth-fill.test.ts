/**
 * DirectDraw depth-surface handling.
 *
 * DirectDraw has no depth API: a DDSCAPS_ZBUFFER surface IS the depth memory. Two
 * contracts follow, and both are invisible until a whole scene z-fails:
 *  - a source-less Blt fill has to leave the guest's own z words holding the value the
 *    app asked for, because the next writable Lock reads them back to decide what to
 *    clear the attachment to;
 *  - "is this surface a uniform fill?" must answer the same at every bit depth. A 24-bpp
 *    pixel does not tile into a 32-bit word (it repeats with period 12), so the word-wide
 *    fast path cannot be used for it.
 */

import { describe, expect, test } from "bun:test";
import "../../src/worker/modules/ddraw/d3d/types";
import { fillZSurfaceMemory, syncZBufferWriteToDepth } from "../../src/worker/modules/ddraw/depth-fill";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

const SURFACE_PTR = 0x2000;
const Z_SURFACE_ADDR = 0x100;
const RT_ADDR = 0x200;

function zSurface(bpp: number, width = 8, height = 4): DirectDrawSurfaceState {
    const bytesPerPixel = bpp / 8;
    return {
        surfaceType: "render_surface",
        width,
        height,
        pitch: width * bytesPerPixel + 8, // deliberate padding: rows are not contiguous
        caps: 0x00020000, // DDSCAPS_ZBUFFER
        surfacePtr: SURFACE_PTR,
        format: { flags: 0, bpp, rMask: 0, gMask: 0, bMask: 0, aMask: 0, zBitMask: (2 ** bpp) - 1 },
        version: 0,
        writeGeneration: 0,
    } as unknown as DirectDrawSurfaceState;
}

/** Enough DDrawContext for the depth path: an executor that records its clears and a
 *  render target that claims the z surface. */
function fakeContext(clears: { depth: number; viewport: unknown }[]): any {
    const renderTarget = { getState: () => ({ surfacePtr: 0x9000, caps: 0x2000 }) };
    return {
        executor: {
            clear: (_rt: unknown, _flags: number, _color: number, depth: number, viewport: unknown) =>
                clears.push({ depth, viewport }),
        },
        process: {},
        resourceProvider: {
            getComObjectByAddress: (addr: number) => (addr === RT_ADDR ? renderTarget : null),
            getAllComObjects: () => [],
        },
    };
}

const readPixel = (mem: Uint8Array, off: number, bytesPerPixel: number): number => {
    let v = 0;
    for (let b = 0; b < bytesPerPixel; b++) v |= mem[off + b]! << (b * 8);
    return v >>> 0;
};

describe("ddraw depth surface memory", () => {
    for (const bpp of [16, 24, 32]) {
        test(`a ${bpp}-bpp fill writes every pixel of the rect and nothing outside it`, () => {
            const mem = new Uint8Array(0x8000);
            const state = zSurface(bpp);
            const bytesPerPixel = bpp / 8;
            const value = bpp === 16 ? 0xfffe : bpp === 24 ? 0xfffffe : 0xfffffffe;

            fillZSurfaceMemory(state, mem, { left: 2, top: 1, right: 6, bottom: 3 }, value);

            for (let y = 0; y < state.height; y++) {
                for (let x = 0; x < state.width; x++) {
                    const off = SURFACE_PTR + y * state.pitch + x * bytesPerPixel;
                    const inside = x >= 2 && x < 6 && y >= 1 && y < 3;
                    expect(readPixel(mem, off, bytesPerPixel)).toBe(inside ? value >>> 0 : 0);
                }
            }
        });
    }

    test("a uniform 24-bpp z surface reaches the depth attachment", () => {
        // A 3-byte pixel repeats with period 12, so a word-wide compare sees four
        // different words and calls a genuinely uniform surface non-uniform — the app's
        // far-plane clear then never leaves guest memory and the next frame z-fails.
        const mem = new Uint8Array(0x8000);
        const state = zSurface(24);
        (state as unknown as { zOwnerSurfaces: number[] }).zOwnerSurfaces = [RT_ADDR];
        fillZSurfaceMemory(state, mem, { left: 0, top: 0, right: state.width, bottom: state.height }, 0xfffffe);

        const clears: { depth: number; viewport: unknown }[] = [];
        syncZBufferWriteToDepth(fakeContext(clears), Z_SURFACE_ADDR, state, mem);

        expect(clears.length).toBe(1);
        expect(clears[0]!.depth).toBeCloseTo(0xfffffe / 0xffffff, 6);
    });

    test("a sub-rect Lock clears only that rect", () => {
        const mem = new Uint8Array(0x8000);
        const state = zSurface(16);
        (state as unknown as { zOwnerSurfaces: number[] }).zOwnerSurfaces = [RT_ADDR];
        fillZSurfaceMemory(state, mem, { left: 0, top: 0, right: state.width, bottom: state.height }, 0xfffe);

        const clears: { depth: number; viewport: unknown }[] = [];
        syncZBufferWriteToDepth(fakeContext(clears), Z_SURFACE_ADDR, state, mem,
            { left: 2, top: 1, right: 6, bottom: 3 });

        expect(clears.length).toBe(1);
        expect(clears[0]!.viewport).toEqual({ x: 2, y: 1, width: 4, height: 2 });
    });

    test("no render target claiming the z surface means no scan and no clear", () => {
        const mem = new Uint8Array(0x8000);
        const state = zSurface(16);
        const clears: { depth: number; viewport: unknown }[] = [];
        // No zOwnerSurfaces and no COM object claiming it: there is nothing to clear, and
        // scanning the whole surface first would be pure cost on every writable Lock.
        syncZBufferWriteToDepth(fakeContext(clears), Z_SURFACE_ADDR, state, mem);
        expect(clears.length).toBe(0);
    });

    test("a fill clipped to the surface never writes past its last row", () => {
        const mem = new Uint8Array(0x8000);
        const state = zSurface(16);
        const lastByte = SURFACE_PTR + (state.height - 1) * state.pitch + state.width * 2;

        fillZSurfaceMemory(state, mem, { left: -10, top: -10, right: 999, bottom: 999 }, 0xffff);

        expect(mem[lastByte - 1]).toBe(0xff);
        // The row padding past the visible pixels is not ours to touch.
        expect(mem[lastByte]).toBe(0);
    });
});
