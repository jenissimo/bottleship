import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

function deviceWithOpenFrame(hasWork: boolean) {
    const retained: GPUTexture[] = [];
    const textures = new TextureStore(1);
    const host = Object.assign(Object.create(D3D9Device.prototype), {
        textures,
        renderTargetGpuFormats: new Map<number, GPUTextureFormat>(),
        mipLevelLocks: new Map(),
        mipLevelData: new Map(),
        mipLevelDirty: new Set(),
        cubeFaceLocks: new Map(),
        cubeFaceData: new Map(),
        cubeFaceRenderViews: new Map(),
        commandRecorder: {
            hasWork: () => hasWork,
            registerTemporaryTexture: (texture: GPUTexture) => { retained.push(texture); },
        },
    });
    let destroyed = 0;
    const texture = { destroy: () => { destroyed++; } } as unknown as GPUTexture;
    const index = textures.create(1, 4, 4, 1, 21, 0);
    textures.setGpuTexture(index, texture, {} as GPUTextureView);
    host.releaseTexture(1);
    return { retained, destroyed: () => destroyed, texture };
}

test("a released texture is kept until frame release while the open frame has recorded work", () => {
    const { retained, destroyed, texture } = deviceWithOpenFrame(true);
    expect(retained).toEqual([texture]);
    expect(destroyed()).toBe(0);
});

test("a released texture is destroyed at once when the open frame has recorded nothing", () => {
    const { retained, destroyed } = deviceWithOpenFrame(false);
    expect(retained).toEqual([]);
    expect(destroyed()).toBe(1);
});
