import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { DDrawWebGPUExecutor } from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import { D3DCLEAR_ZBUFFER, D3DCLEAR_STENCIL } from "../../src/worker/modules/ddraw/constants";
import { setAuthorityCpu, setAuthorityGpu, surfaceSyncManager } from "../../src/worker/modules/ddraw/surface-sync";
import type { RenderSurface } from "../../src/worker/modules/ddraw/com-objects";

const W = 4, H = 2, PTR = 0x1000;

function surface(): RenderSurface {
    return {
        surfaceType: "render_surface", width: W, height: H, pitch: W * 4, caps: 0, surfacePtr: PTR,
        surfacePtrAllocated: true, attachedSurfaceAddr: 0,
        format: { flags: 0x41, bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff, aMask: 0xff000000 },
        gpuTexture: {} as GPUTexture, gpuTextureFormat: "bgra8unorm", mode: "GPU_ONLY", version: 0,
        gpuDirty: false, everLocked: false, lastUploadVersion: -1, writeGeneration: 0,
    } as unknown as RenderSurface;
}

describe("a GPU readback that finishes after the guest wrote the surface lands nothing", () => {
    const system = System.getInstance() as unknown as { process: unknown };
    let saved: unknown;
    const mem = new Uint8Array(0x4000);
    beforeEach(() => {
        saved = system.process;
        mem.fill(0);
        system.process = { getCurrentMemory: () => mem };
        (globalThis as Record<string, unknown>).GPUMapMode = { READ: 1 };
        (globalThis as Record<string, unknown>).GPUBufferUsage ??= { MAP_READ: 1, COPY_DST: 8 };
    });
    afterEach(() => { system.process = saved; });

    function gpu(fill: number) {
        let finishMap!: () => void;
        const mapped = new Uint8Array(256 * H).fill(fill);
        const buffer = {
            size: 256 * H,
            mapAsync: () => new Promise<void>((resolve) => { finishMap = resolve; }),
            getMappedRange: () => mapped.buffer,
            unmap: () => undefined,
            destroy: () => undefined,
        };
        const device = {
            createBuffer: () => buffer,
            createCommandEncoder: () => ({ copyTextureToBuffer: () => undefined, finish: () => ({}) }),
        } as unknown as GPUDevice;
        const queue = { submit: () => undefined } as unknown as GPUQueue;
        return { device, queue, finish: () => finishMap() };
    }

    test("the guest's newer bytes survive, and the readback reports not current", async () => {
        const s = surface();
        setAuthorityGpu(s);
        const { device, queue, finish } = gpu(0xaa);
        const pending = surfaceSyncManager.syncToCPU(s, device, queue);
        await Promise.resolve();
        mem.fill(0x55, PTR, PTR + W * H * 4);
        setAuthorityCpu(s);
        finish();
        expect(await pending).toBe(false);
        expect([...mem.subarray(PTR, PTR + W * H * 4)].every((b) => b === 0x55)).toBe(true);
    });

    test("negative control: an undisturbed readback lands its bytes", async () => {
        const s = surface();
        setAuthorityGpu(s);
        const { device, queue, finish } = gpu(0xaa);
        const pending = surfaceSyncManager.syncToCPU(s, device, queue);
        await Promise.resolve();
        finish();
        expect(await pending).toBe(true);
        expect(mem[PTR]).toBe(0xaa);
    });
});

describe("a depth- or stencil-only Clear leaves the colour authority alone", () => {
    function clear(flags: number) {
        const target = {
            surfaceType: "render", mode: "GPU_ONLY", width: 640, height: 480, surfacePtr: 0, caps: 0,
            version: 3, lastUploadVersion: 2, gpuDirty: true, gpuTextureView: {}, gpuTextureFormat: "rgba8unorm",
        };
        const executor = Object.assign(Object.create(DDrawWebGPUExecutor.prototype), {
            renderStats: { clears: 0 }, opLogArmed: 0, currentBatch: null, currentRenderPass: null,
            currentEncoder: {}, surfacesNeedingClear: { add: () => undefined },
            ensureSurfaceGPUResources() {}, syncMsaaSampleCount() {}, flushBatch() {},
            resolveSurfaceTextureFormat: () => "rgba8unorm",
            msaaColorManager: { isEnabled: () => false },
            depthManager: {
                ensureDepthForTarget() {}, setNeedsClear() {}, setNeedsStencilClear() {},
                getDepthViewForTarget: () => ({}), markUsedThisFrame() {}, markExplicitClearDone() {},
            },
            clearPipeline: { clear: () => undefined },
        });
        executor.clear(target, flags, 0, 1, { x: 0, y: 0, width: 320, height: 240 }, undefined, 0);
        return target;
    }

    test("a z-only Clear keeps the CPU colour fill pending upload", () => {
        const t = clear(D3DCLEAR_ZBUFFER);
        expect(t.gpuDirty).toBe(true);
        expect(t.version).toBe(3);
        expect(t.lastUploadVersion).toBe(2);
    });

    test("a stencil-only Clear does too", () => {
        expect(clear(D3DCLEAR_STENCIL).version).toBe(3);
    });
});
