/**
 * A colour fill of PART of a GPU-authoritative surface must not lose what a CPU blit left
 * waiting to be uploaded.
 *
 * The shape is a loading screen: BltFast a full-screen background into the back buffer
 * (written to guest memory, upload pending), Blt-fill a progress bar over it, Flip. The fill
 * runs as a scissored GPU clear and then declares the GPU texture current, so the upload
 * has to happen first — otherwise the frame is the bar on whatever the texture held before.
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { DDBLT_COLORFILL, DDBLTFX_OFFSETS } from "../../src/worker/modules/ddraw/constants";
import { createSurfaceBltFlipExports } from "../../src/worker/modules/ddraw/surface-blt-flip";
import { setAuthorityCpu, surfaceSyncManager } from "../../src/worker/modules/ddraw/surface-sync";

const DD_OK = 0;
const SURFACE = 0x5000;
const RECT = 0x1000;
const BLTFX = 0x1100;
const WIDTH = 800, HEIGHT = 600;

function setup() {
    const mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    const view = new DataView(mem.buffer);
    const state: any = {
        surfaceType: "render_surface",
        mode: "GPU_ONLY",
        width: WIDTH,
        height: HEIGHT,
        pitch: WIDTH * 2,
        caps: 0,
        surfacePtr: 0x8000,
        format: { flags: 0, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 },
        gpuTexture: {},
        version: 3,
        lastUploadVersion: 3,
        gpuDirty: false,
    };
    const surface = Object.create(DirectDrawSurfaceObject.prototype);
    Object.defineProperty(surface, "getState", { value: () => state });

    const calls: string[] = [];
    const context: any = {
        resourceProvider: { getComObjectByAddress: (addr: number) => (addr === SURFACE ? surface : null) },
        surfaces: {},
        executor: {
            syncSurfaceFromMemory(s: unknown) {
                expect(s).toBe(state);
                calls.push("upload");
                state.lastUploadVersion = state.version;
                state.gpuDirty = false;
            },
            clear(s: unknown, _flags: number, _color: number, _z: number, rect: { x: number; y: number; width: number; height: number }) {
                expect(s).toBe(state);
                calls.push(`clear ${rect.x},${rect.y} ${rect.width}x${rect.height}`);
            },
        },
    };
    const blt = createSurfaceBltFlipExports(context).IDirectDrawSurface7_Blt!;
    view.setUint32(BLTFX + DDBLTFX_OFFSETS.fillColor, 0x001f, true);
    const fill = (rect: [number, number, number, number] | null) => {
        if (rect) rect.forEach((v, i) => view.setInt32(RECT + i * 4, v, true));
        return blt({ esp: 0 } as never, mem, [SURFACE, rect ? RECT : 0, 0, 0, DDBLT_COLORFILL, BLTFX]);
    };
    return { state, calls, fill };
}

describe("GPU colour fill over a pending CPU upload", () => {
    test("a partial fill uploads the pending pixels first", () => {
        const { state, calls, fill } = setup();
        setAuthorityCpu(state);
        expect(surfaceSyncManager.needsGPUSync(state).needed).toBe(true);

        expect(fill([440, 537, 473, 549])).toBe(DD_OK);
        expect(calls).toEqual(["upload", "clear 440,537 33x12"]);
        expect(surfaceSyncManager.needsGPUSync(state).needed).toBe(false);
    });

    test("a fill of the whole surface replaces them, so nothing is uploaded", () => {
        for (const rect of [null, [0, 0, WIDTH, HEIGHT]] as const) {
            const { state, calls, fill } = setup();
            setAuthorityCpu(state);
            expect(fill(rect as never)).toBe(DD_OK);
            expect(calls).toEqual([`clear 0,0 ${WIDTH}x${HEIGHT}`]);
            expect(surfaceSyncManager.needsGPUSync(state).needed).toBe(false);
        }
    });

    test("a partial fill with nothing pending uploads nothing", () => {
        const { calls, fill } = setup();
        expect(fill([10, 10, 20, 20])).toBe(DD_OK);
        expect(calls).toEqual(["clear 10,10 10x10"]);
    });

    test("a fill one pixel short of the surface still counts as partial", () => {
        const { state, calls, fill } = setup();
        setAuthorityCpu(state);
        expect(fill([0, 0, WIDTH, HEIGHT - 1])).toBe(DD_OK);
        expect(calls[0]).toBe("upload");
    });
});
