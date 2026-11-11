import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { copySurfaceRegion, copySurfaceRegionWithColorKey } from "../../src/worker/modules/ddraw/surface-helpers";

function surface(ptr: number, width: number, height: number, bpp: number, pitch = width * (bpp >> 3)) {
    const masks = bpp === 16 ? { rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f }
        : bpp === 32 ? { rMask: 0xff0000, gMask: 0xff00, bMask: 0xff }
        : { rMask: 0, gMask: 0, bMask: 0 };
    return {
        surfaceType: "render_surface", width, height, pitch, surfacePtr: ptr,
        format: { flags: bpp === 8 ? 0x20 : 0x40, bpp, aMask: 0, ...masks },
    } as any;
}

describe("a 1:1 Blt validates the guest range once, not once per row", () => {
    let spy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => { spy?.mockRestore(); spy = null; });

    test("a full-screen 640x480 copy checks each surface's span a constant number of times", () => {
        let checks = 0;
        const addressSpace = { validateRange: () => { checks++; return true; } };
        spy = spyOn(System, "getInstance").mockReturnValue({ process: { addressSpace } } as any);
        const mem = new Uint8Array(0x100000);
        for (let i = 0; i < 640 * 480; i++) mem[0x1000 + i] = (i * 13) & 0xff;
        const src = surface(0x1000, 640, 480, 8);
        const dst = surface(0x60000, 640, 480, 8);
        const full = { left: 0, top: 0, right: 640, bottom: 480 };
        copySurfaceRegion(mem, src, dst, full, full);
        expect(mem.subarray(0x60000, 0x60000 + 640 * 480)).toEqual(mem.subarray(0x1000, 0x1000 + 640 * 480));
        expect(checks).toBeLessThanOrEqual(4);
    });
});

describe("colour-keyed Blt gives the per-byte result at every pixel size and alignment", () => {
    function reference(mem: Uint8Array, src: any, dst: any, w: number, h: number, bpp: number, low: number, high: number) {
        const bytes = bpp >> 3;
        const mask = ((src.format.rMask | src.format.gMask | src.format.bMask) >>> 0) || 0xffffffff;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const s = src.surfacePtr + y * src.pitch + x * bytes;
                const d = dst.surfacePtr + y * dst.pitch + x * bytes;
                let p = 0;
                for (let b = 0; b < bytes; b++) p |= mem[s + b]! << (8 * b);
                const k = ((p >>> 0) & mask) >>> 0;
                if (k >= ((low & mask) >>> 0) && k <= ((high & mask) >>> 0)) continue;
                for (let b = 0; b < bytes; b++) mem[d + b] = mem[s + b]!;
            }
        }
    }

    for (const bpp of [8, 16, 32]) {
        for (const shift of [0, 1, 2]) {
            test(`${bpp} bpp, destination offset ${shift}`, () => {
                const w = 37, h = 9, bytes = bpp >> 3;
                const fill = (mem: Uint8Array) => {
                    for (let i = 0; i < 0x4000; i++) mem[0x1000 + i] = (i * 7 + (i >> 3)) & 0xff;
                    for (let i = 0; i < 0x4000; i++) mem[0x8000 + i] = 0xa5;
                };
                const a = new Uint8Array(0x10000), b = new Uint8Array(0x10000);
                fill(a); fill(b);
                const src = surface(0x1000, w, h, bpp, w * bytes + 3);
                const dst = surface(0x8000 + shift, w, h, bpp, w * bytes + 5);
                const rect = { left: 0, top: 0, right: w, bottom: h };
                const key = bpp === 8 ? { low: 0x20, high: 0x60 } : bpp === 16 ? { low: 0x0800, high: 0x4000 } : { low: 0x100000, high: 0x700000 };
                copySurfaceRegionWithColorKey(a, src, dst, rect, rect, key);
                reference(b, src, dst, w, h, bpp, key.low, key.high);
                expect(a).toEqual(b);
            });
        }
    }
});
