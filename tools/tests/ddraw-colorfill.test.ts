/**
 * DirectDraw ColorFill of CPU pixel memory.
 *
 * The fill writes through a word view and replicates rows with copyWithin instead of
 * storing pixel bytes one at a time — guest RAM is v86's Proxy, where a per-byte store
 * costs ~40x a word store, and a full-screen fill at that rate starves the audio pump
 * before it ever reads as a slow frame. Everything the rewrite has to keep is here:
 * rows are pitch-strided (never contiguous), the start need not be word-aligned, an odd
 * pixel count leaves a partial trailing word, and nothing outside the rect may move.
 */

import { describe, expect, test } from "bun:test";
import { fillSurfaceRectCpu } from "../../src/worker/modules/ddraw/surface-blt-flip";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

function surface(surfacePtr: number, bpp: number, width: number, height: number, pitchPad: number): DirectDrawSurfaceState {
    return {
        surfaceType: "render_surface",
        width,
        height,
        pitch: width * (bpp / 8) + pitchPad,
        caps: 0,
        surfacePtr,
        format: { flags: 0, bpp, rMask: 0, gMask: 0, bMask: 0, aMask: 0 },
        version: 0,
        writeGeneration: 0,
    } as unknown as DirectDrawSurfaceState;
}

const readPixel = (mem: Uint8Array, off: number, bytesPerPixel: number): number => {
    let v = 0;
    for (let b = 0; b < bytesPerPixel; b++) v |= mem[off + b]! << (b * 8);
    return v >>> 0;
};

describe("ddraw ColorFill of CPU pixel memory", () => {
    for (const bpp of [8, 16, 32]) {
        // An odd width leaves a trailing half-word at 16 bpp; the +2 base and +6 pad put the
        // row start off a 4-byte boundary on some rows and on it for others.
        for (const [width, base, pad] of [[8, 0x2000, 0], [7, 0x2002, 6]] as const) {
            test(`${bpp} bpp, width ${width}, base 0x${base.toString(16)}, pitch pad ${pad}`, () => {
                const bytesPerPixel = bpp / 8;
                const state = surface(base, bpp, width, 5, pad);
                const mem = new Uint8Array(0x8000).fill(0xa5);
                const value = bpp === 8 ? 0x3c : bpp === 16 ? 0xbeef : 0xdeadbeef;

                fillSurfaceRectCpu(mem, state, { left: 1, top: 1, right: width - 1, bottom: 4 },
                    width - 2, 3, bytesPerPixel, value);

                for (let y = 0; y < state.height; y++) {
                    for (let x = 0; x < width; x++) {
                        const off = base + y * state.pitch + x * bytesPerPixel;
                        const inside = x >= 1 && x < width - 1 && y >= 1 && y < 4;
                        expect(readPixel(mem, off, bytesPerPixel)).toBe(inside ? value >>> 0 : 0xa5a5a5a5 >>> (32 - bpp));
                    }
                }
                // The pitch padding between rows is nobody's pixel and must be untouched.
                for (let y = 0; y < state.height; y++) {
                    for (let p = 0; p < pad; p++) {
                        expect(mem[base + y * state.pitch + width * bytesPerPixel + p]).toBe(0xa5);
                    }
                }
            });
        }
    }

    test("a rect running past the end of the view fills the rows that fit and writes nothing beyond", () => {
        const pitch = 64;
        const mem = new Uint8Array(pitch * 4 + 16);
        const state = surface(0, 32, 16, 100, 0);
        fillSurfaceRectCpu(mem, state, { left: 0, top: 0, right: 16, bottom: 100 }, 16, 100, 4, 0xffffffff);
        for (let y = 0; y < 4; y++) expect(readPixel(mem, y * pitch, 4)).toBe(0xffffffff);
        for (let i = pitch * 4; i < mem.length; i++) expect(mem[i]).toBe(0);
    });

    test("a 24 bpp fill writes whole pixels, not a repeated low byte", () => {
        const mem = new Uint8Array(0x400);
        const state = surface(0x100, 24, 4, 2, 3);
        fillSurfaceRectCpu(mem, state, { left: 0, top: 0, right: 4, bottom: 2 }, 4, 2, 3, 0x123456);
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 4; x++) expect(readPixel(mem, 0x100 + y * state.pitch + x * 3, 3)).toBe(0x123456);
        }
    });
});
