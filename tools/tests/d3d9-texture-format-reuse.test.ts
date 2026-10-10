import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

test("released RT slots cannot select the previous format for sampled sRGB views", () => {
    const textures = new TextureStore(1);
    const host = Object.assign(Object.create(D3D9Device.prototype), {
        textures,
        renderTargetGpuFormats: new Map<number, GPUTextureFormat>(),
        srgbTextureViews: new WeakMap(),
        mipLevelLocks: new Map(),
        mipLevelData: new Map(),
        mipLevelDirty: new Set(),
        cubeFaceLocks: new Map(),
        cubeFaceData: new Map(),
        cubeFaceRenderViews: new Map(),
        samplerSpecForStage: () => ({ srgbTexture: true }),
        backend: { supportsBC: () => true },
    });
    for (const [d3dFormat, gpuFormat, srgbFormat] of [
        [21, "rgba8unorm", "rgba8unorm-srgb"],
        [0x35545844, "bc3-rgba-unorm", "bc3-rgba-unorm-srgb"],
    ] as const) {
        const oldIndex = textures.create(1, 4, 4, 1, 21, 0);
        host.renderTargetGpuFormats.set(oldIndex, "bgra8unorm");
        host.releaseTexture(1);
        expect(host.renderTargetGpuFormats.has(oldIndex)).toBe(false);
        const index = textures.create(2, 4, 4, 1, d3dFormat, 0);
        expect(index).toBe(oldIndex);
        const createdViews: GPUTextureViewDescriptor[] = [];
        const texture = {
            format: gpuFormat,
            createView: (descriptor: GPUTextureViewDescriptor) => {
                createdViews.push(descriptor);
                return {} as GPUTextureView;
            },
        } as unknown as GPUTexture;
        textures.setGpuTexture(index, texture, {} as GPUTextureView);
        expect(host.resolveTextureView(0, index, false)).not.toBeNull();
        expect(createdViews).toEqual([{ format: srgbFormat, dimension: "2d" }]);
        textures.release(2);
    }
});
