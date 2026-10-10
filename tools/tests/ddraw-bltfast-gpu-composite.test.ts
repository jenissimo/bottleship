/**
 * BltFast of a small sprite onto a surface whose current pixels are on the GPU.
 *
 * The shape is a HUD: D3D draws the scene into the back buffer, then the game BltFasts a
 * dozen colour-keyed digits over it. Copying on the CPU needs the destination's pixels in
 * guest memory first — a download of the whole back buffer, every frame. The copy composites
 * on the GPU instead, as Blt's mixed path does. A frame the game builds on the CPU (a 2D
 * menu) has nothing to download and stays a plain memory copy.
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { DDBLTFAST_SRCCOLORKEY } from "../../src/worker/modules/ddraw/constants";
import { createSurfaceBltFlipExports } from "../../src/worker/modules/ddraw/surface-blt-flip";
import { setAuthorityCpu, setAuthorityGpu, surfaceSyncManager } from "../../src/worker/modules/ddraw/surface-sync";

const DD_OK = 0;
const DST = 0x5000, SRC = 0x5100;
const DST_PIXELS = 0x8000, SRC_PIXELS = 0x4000;
const WIDTH = 64, HEIGHT = 32;
const SPRITE = 4;
const RGB565 = { flags: 0, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };
const KEY = { low: 0, high: 0 };

function surfaceObject(state: unknown): DirectDrawSurfaceObject {
    const obj = Object.create(DirectDrawSurfaceObject.prototype);
    Object.defineProperty(obj, "getState", { value: () => state });
    return obj;
}

function setup(opts: { sourceHasTexture?: boolean } = {}) {
    const mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    const view = new DataView(mem.buffer);
    const dst: any = {
        surfaceType: "render_surface", mode: "GPU_ONLY", width: WIDTH, height: HEIGHT, pitch: WIDTH * 2,
        caps: 0, surfacePtr: DST_PIXELS, format: RGB565, gpuTexture: { format: "bgra8unorm" },
        gpuTextureFormat: "bgra8unorm", version: 1, lastUploadVersion: 1, gpuDirty: false,
    };
    const src: any = {
        surfaceType: "render_surface", mode: "CPU", width: SPRITE, height: SPRITE, pitch: SPRITE * 2,
        caps: 0, surfacePtr: SRC_PIXELS, format: RGB565, srcColorKey: KEY,
        gpuTexture: opts.sourceHasTexture === false ? undefined : {},
        version: 1, lastUploadVersion: 1, gpuDirty: false,
    };
    // A sprite with a transparent (key) corner and opaque pixels elsewhere.
    for (let i = 0; i < SPRITE * SPRITE; i++) view.setUint16(SRC_PIXELS + i * 2, i === 0 ? 0 : 0xffff, true);

    const calls: string[] = [];
    const rect = (r: { left: number; top: number; right: number; bottom: number }) => `${r.left},${r.top},${r.right},${r.bottom}`;
    const context: any = {
        backend: {},
        surfaces: {},
        resourceProvider: {
            getComObjectByAddress: (addr: number) => (addr === DST ? surfaceObject(dst) : addr === SRC ? surfaceObject(src) : null),
        },
        executor: {
            syncSurfaceToMemoryFromScratch: () => false,
            syncSurfaceToMemory: () => { calls.push("download"); return Promise.resolve(); },
            blitWithColorKey(s: unknown, d: unknown, sr: any, dr: any, key: unknown) {
                expect([s, d, key]).toEqual([src, dst, KEY]);
                calls.push(`gpu keyed ${rect(sr)} -> ${rect(dr)}`);
            },
            blitWithShaderCopy(s: unknown, d: unknown, sr: any, dr: any) {
                expect([s, d]).toEqual([src, dst]);
                calls.push(`gpu copy ${rect(sr)} -> ${rect(dr)}`);
            },
            flush() { calls.push("flush"); },
        },
    };
    const bltFast = createSurfaceBltFlipExports(context).IDirectDrawSurface7_BltFast!;
    const blt = (x: number, y: number, trans: number) => bltFast({ esp: 0 } as never, mem, [DST, x, y, SRC, 0, trans]);
    const dstPixel = (x: number, y: number) => view.getUint16(DST_PIXELS + y * dst.pitch + x * 2, true);
    return { dst, src, calls, blt, dstPixel };
}

describe("BltFast onto a surface whose pixels are on the GPU", () => {
    test("a keyed sprite composites on the GPU: nothing is downloaded, guest memory is untouched", () => {
        const { dst, calls, blt, dstPixel } = setup();
        setAuthorityGpu(dst);
        expect(surfaceSyncManager.needsCPUSync(dst).needed).toBe(true);
        const before = dst.version;

        expect(blt(10, 6, DDBLTFAST_SRCCOLORKEY)).toBe(DD_OK);
        expect(calls).toEqual([`gpu keyed 0,0,${SPRITE},${SPRITE} -> 10,6,${10 + SPRITE},${6 + SPRITE}`, "flush"]);
        expect(dstPixel(11, 6)).toBe(0);
        // The blit is a new version of the surface, written by the GPU: a copy of the old
        // version that was read back earlier must not pass for the current pixels.
        expect(dst.version).toBeGreaterThan(before);
        expect(dst.gpuWrittenVersion).toBe(dst.version);
        // The GPU still holds the surface's current pixels, so the next sprite goes the same way.
        expect(surfaceSyncManager.needsCPUSync(dst).needed).toBe(true);
        expect(surfaceSyncManager.needsGPUSync(dst).needed).toBe(false);
    });

    test("without the colour-key flag it is a plain GPU copy", () => {
        const { dst, calls, blt } = setup();
        setAuthorityGpu(dst);
        expect(blt(0, 8, 0)).toBe(DD_OK);
        expect(calls).toEqual([`gpu copy 0,0,${SPRITE},${SPRITE} -> 0,8,${SPRITE},${8 + SPRITE}`, "flush"]);
    });

    test("a frame built on the CPU stays a memory copy", () => {
        const { dst, calls, blt, dstPixel } = setup();
        setAuthorityCpu(dst);
        expect(blt(10, 6, DDBLTFAST_SRCCOLORKEY)).toBe(DD_OK);
        expect(calls).toEqual([]);
        expect(dstPixel(10, 6)).toBe(0);        // the key pixel is skipped
        expect(dstPixel(11, 6)).toBe(0xffff);
        expect(surfaceSyncManager.needsGPUSync(dst).needed).toBe(true);
    });

    test("a destination that is not a GPU render target falls back to the download", async () => {
        const { dst, calls, blt, dstPixel } = setup();
        setAuthorityGpu(dst);
        dst.mode = "CPU";
        expect(await blt(10, 6, DDBLTFAST_SRCCOLORKEY)).toBe(DD_OK);
        expect(calls).toEqual(["download"]);
        expect(dstPixel(11, 6)).toBe(0xffff);
    });
});
