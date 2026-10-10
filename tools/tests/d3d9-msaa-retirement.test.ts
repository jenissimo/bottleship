import { expect, test } from "bun:test";
import { D3D9BackendExecutor } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";
import { RenderFrame } from "../../src/worker/backends/webgpu/render-frame";
import { D3D9MultisampleTargetCache } from "../../src/worker/backends/webgpu/d3d9/multisample";

test("normal non-present submissions retire MSAA attachments after submit", () => {
    const textures: Array<{ destroyed: boolean; createView(): GPUTextureView; destroy(): void }> = [];
    let submits = 0;
    const queue = { submit: () => {
        submits++;
        expect(textures.every(texture => !texture.destroyed)).toBe(true);
    } };
    const pass = { end() {}, setStencilReference() {} };
    const device = {
        queue,
        createTexture: () => {
            const texture = {
                destroyed: false,
                createView: () => ({}) as GPUTextureView,
                destroy: () => { texture.destroyed = true; },
            };
            textures.push(texture);
            return texture;
        },
        pushErrorScope() {},
        popErrorScope: async () => null,
        createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    };
    const executor = new D3D9BackendExecutor({
        getDevice: () => device,
        getQueue: () => queue,
        getFormat: () => "bgra8unorm",
    } as never);
    const host = executor as unknown as {
        offscreenSize: { width: number; height: number };
        offscreenView: GPUTextureView;
        depthView: GPUTextureView;
        d3d9MsaaCache: D3D9MultisampleTargetCache;
    };
    host.offscreenSize = { width: 64, height: 64 };
    host.offscreenView = {} as GPUTextureView;
    host.depthView = {} as GPUTextureView;
    host.d3d9MsaaCache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
        supportsSampleCount: () => true,
    });
    const descriptor = {
        key: "backbuffer",
        width: 64,
        height: 64,
        colorFormat: "bgra8unorm" as GPUTextureFormat,
        depthFormat: "depth24plus-stencil8" as GPUTextureFormat,
        sampleCount: 4,
    };
    host.d3d9MsaaCache.acquire(descriptor);
    host.d3d9MsaaCache.acquire({ ...descriptor, width: 128 });
    executor.setGuestBackbufferSize(64, 64);
    executor.execute(new RenderFrame(), {} as never, null, false, undefined, {
        colorViews: [host.offscreenView],
        depthView: host.depthView,
        backbuffer: false,
    });
    expect(submits).toBe(1);
    expect(textures).toHaveLength(6);
    expect(textures.slice(0, 3).every(texture => texture.destroyed)).toBe(true);
    expect(textures.slice(3).every(texture => !texture.destroyed)).toBe(true);
});
