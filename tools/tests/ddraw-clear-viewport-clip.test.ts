/**
 * D3D Clear clips its rects to the current viewport (wined3d_cs_emit_clear: the clear's
 * draw_rect is the viewport). A title may pass the whole target as its one rect and select
 * the region with SetViewport — a letterbox's black bars are cleared exactly that way.
 */
import { describe, expect, test } from "bun:test";
import { clipClearRectsToViewport } from "../../src/worker/backends/webgpu/ddraw/clear-pipeline";
import { DDrawWebGPUExecutor } from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import { createDeviceExports } from "../../src/worker/modules/ddraw/d3d/device-impl";
import { createViewportExports } from "../../src/worker/modules/ddraw/d3d/viewport-impl";
import { D3DCLEAR_TARGET } from "../../src/worker/modules/ddraw/constants";

const FULL = { x1: 0, y1: 0, x2: 640, y2: 480 };

describe("clipClearRectsToViewport", () => {
    test("a full-target rect under a letterbox-band viewport clears only the band", () => {
        expect(clipClearRectsToViewport([FULL], { x: 0, y: 0, width: 640, height: 59 }))
            .toEqual([{ x1: 0, y1: 0, x2: 640, y2: 59 }]);
        expect(clipClearRectsToViewport([FULL], { x: 0, y: 422, width: 640, height: 58 }))
            .toEqual([{ x1: 0, y1: 422, x2: 640, y2: 480 }]);
    });

    test("a full viewport leaves the rects as given", () => {
        const rects = [{ x1: 10, y1: 20, x2: 30, y2: 40 }, { x1: 100, y1: 0, x2: 640, y2: 480 }];
        expect(clipClearRectsToViewport(rects, { x: 0, y: 0, width: 640, height: 480 })).toEqual(rects);
    });

    test("rects partly outside are trimmed, and rects wholly outside are dropped", () => {
        const vp = { x: 100, y: 100, width: 200, height: 100 };
        expect(clipClearRectsToViewport([
            { x1: 50, y1: 50, x2: 150, y2: 150 },
            { x1: 400, y1: 0, x2: 500, y2: 50 },
            { x1: 300, y1: 100, x2: 400, y2: 200 },
        ], vp)).toEqual([{ x1: 100, y1: 100, x2: 150, y2: 150 }]);
    });

    test("nothing inside the viewport means nothing to clear", () => {
        expect(clipClearRectsToViewport([{ x1: 0, y1: 0, x2: 10, y2: 10 }], { x: 20, y: 20, width: 5, height: 5 })).toEqual([]);
    });
});

type Rect = { x1: number; y1: number; x2: number; y2: number };
type Viewport = { x: number; y: number; width: number; height: number };
const BLACK = 0xff000000;
const target = () => ({
    surfaceType: "render", mode: "GPU_ONLY", width: 640, height: 480, surfacePtr: 0, caps: 0,
    version: 1, lastUploadVersion: 1, gpuDirty: false, gpuTextureView: {}, gpuTextureFormat: "rgba8unorm",
});

/** The real DDrawWebGPUExecutor.clear with its GPU objects stubbed: what reaches the clear pass. */
function executorClear(viewport: Viewport | undefined, rects: Rect[] | undefined) {
    const passes: Array<{ rects?: Rect[]; viewport?: Viewport }> = [];
    let deferredFull = false;
    const executor = Object.assign(Object.create(DDrawWebGPUExecutor.prototype), {
        renderStats: { clears: 0 }, opLogArmed: 0, currentBatch: null, currentRenderPass: null,
        currentEncoder: {}, surfacesNeedingClear: { add: () => { deferredFull = true; } },
        ensureSurfaceGPUResources() {}, syncMsaaSampleCount() {}, flushBatch() {},
        resolveSurfaceTextureFormat: () => "rgba8unorm",
        msaaColorManager: { isEnabled: () => false },
        depthManager: { getDepthViewForTarget: () => null },
        clearPipeline: { clear: (...a: unknown[]) => passes.push(a[5] as { rects?: Rect[]; viewport?: Viewport }) },
    });
    executor.clear(target(), D3DCLEAR_TARGET, BLACK, 1, viewport, rects);
    return { passes, deferredFull };
}

describe("DDrawWebGPUExecutor.clear honours the viewport", () => {
    test("a full-target rect under a band viewport reaches the clear pass as the band", () => {
        const { passes, deferredFull } = executorClear({ x: 0, y: 422, width: 640, height: 58 }, [FULL]);
        expect(deferredFull).toBe(false);
        expect(passes).toHaveLength(1);
        expect(passes[0]!.rects).toEqual([{ x1: 0, y1: 422, x2: 640, y2: 480 }]);
    });

    test("rects wholly outside the viewport clear nothing at all", () => {
        expect(executorClear({ x: 0, y: 0, width: 640, height: 59 }, [{ x1: 0, y1: 100, x2: 640, y2: 200 }]))
            .toEqual({ passes: [], deferredFull: false });
    });

    test("without rects, a partial viewport is still the clear region", () => {
        const { passes, deferredFull } = executorClear({ x: 0, y: 0, width: 640, height: 59 }, undefined);
        expect(deferredFull).toBe(false);
        expect(passes[0]!.viewport).toEqual({ x: 0, y: 0, width: 640, height: 59 });
    });
});

/** Guest memory with one D3DRECT at RECTS, and a provider that serves the given objects. */
function apiContext(objects: Record<number, unknown>) {
    const calls: Array<{ viewport?: Viewport; rects?: Rect[] }> = [];
    const context = {
        resourceProvider: { getComObjectByAddress: (a: number) => objects[a] ?? null, getComObject: () => null },
        executor: { clear: (_t: unknown, _f: number, _c: number, _d: number, viewport?: Viewport, rects?: Rect[]) => calls.push({ viewport, rects }) },
        surfaces: { backBuffer: 0, primary: 0 },
        display: { width: 640, height: 480 },
    };
    const mem = new Uint8Array(0x1000);
    new DataView(mem.buffer).setInt32(RECTS + 8, 640, true);
    new DataView(mem.buffer).setInt32(RECTS + 12, 480, true);
    return { context, calls, mem };
}
const DEVICE = 0x100, RT = 0x200, VIEWPORT = 0x300, RECTS = 0x400;
const rtObject = { getState: () => target() };

describe("the D3D Clear entry points pass the viewport along with their rects", () => {
    test("IDirect3DDevice7::Clear", () => {
        const band = { x: 0, y: 0, width: 640, height: 59, minZ: 0, maxZ: 1 };
        const { context, calls, mem } = apiContext({
            [DEVICE]: { getRenderTarget: () => RT, getViewportData: () => band }, [RT]: rtObject,
        });
        const exports = createDeviceExports(context as never, {} as never, {} as never);
        exports["IDirect3DDevice7_Clear"]!(null as never, mem, [DEVICE, 1, RECTS, D3DCLEAR_TARGET, BLACK, 0, 0]);
        expect(calls).toEqual([{ viewport: { x: 0, y: 0, width: 640, height: 59 }, rects: [FULL] }]);
    });

    test("IDirect3DViewport3::Clear", () => {
        const band = { x: 0, y: 422, width: 640, height: 58, minZ: 0, maxZ: 1 };
        const { context, calls, mem } = apiContext({
            [VIEWPORT]: { getDevice: () => DEVICE, getViewport: () => band, getBackground: () => 0, getBackgroundColor: () => BLACK },
            [DEVICE]: { getRenderTarget: () => RT }, [RT]: rtObject,
        });
        const exports = createViewportExports(context as never);
        exports["IDirect3DViewport3_Clear"]!(null as never, mem, [VIEWPORT, 1, RECTS, D3DCLEAR_TARGET]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.viewport).toMatchObject({ x: 0, y: 422, width: 640, height: 58 });
        expect(calls[0]!.rects).toEqual([FULL]);
    });
});
