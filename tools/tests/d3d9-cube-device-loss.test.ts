/**
 * A MANAGED cube texture survives D3D9 device loss: its faces live in the CPU shadow
 * (cubeFaceData), so after the GPU object is dropped the next bind must rebuild it and
 * re-upload every authored face — with no guest involvement, exactly like a 2-D texture.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

const D3DFMT_A8R8G8B8 = 21;
const D3DPOOL_MANAGED = 1;
const CUBE = 0x7000;
const EDGE = 2;

function makeDevice() {
    const created: Array<{ mipLevelCount: number; depthOrArrayLayers: number }> = [];
    const writes: Array<{ z: number; level: number }> = [];
    const fakeTexture = (desc: any) => ({
        mipLevelCount: desc.mipLevelCount ?? 1,
        format: desc.format,
        createView: () => ({}),
        destroy: () => {},
    });
    const gpu = {
        createTexture: (desc: any) => {
            created.push({ mipLevelCount: desc.mipLevelCount ?? 1, depthOrArrayLayers: desc.size.depthOrArrayLayers });
            return fakeTexture(desc);
        },
    };
    const queue = {
        writeTexture: (dst: any) => { writes.push({ z: dst.origin?.z ?? 0, level: dst.mipLevel ?? 0 }); },
    };
    const dev: any = Object.create(D3D9Device.prototype);
    dev.backend = { getDevice: () => gpu, getQueue: () => queue };
    dev.textures = new TextureStore(4);
    dev.cubeFaceData = new Map<string, Uint8Array>();
    dev.gpuResourceGeneration = 0;
    dev.arenaSamplerBankGeneration = 0;
    dev.frameSnapshot = { frameCounters: null };

    const index = dev.textures.create(CUBE, EDGE, EDGE, 1, D3DFMT_A8R8G8B8, 0, D3DPOOL_MANAGED);
    dev.textures.markCube(index);
    // createCubeTexture's eager GPU object.
    dev.textures.setGpuTexture(index, fakeTexture({ mipLevelCount: 1, format: "rgba8unorm" }), {});
    for (let face = 0; face < 6; face++) {
        dev.cubeFaceData.set(`${CUBE}:${face}:0`, new Uint8Array(EDGE * EDGE * 4).fill(0x40 + face));
    }
    dev.textures.setDirty(index, true);
    return { dev, index, created, writes };
}

describe("D3D9 cube texture across device loss", () => {
    const g = globalThis as { GPUTextureUsage?: unknown };
    const savedUsage = g.GPUTextureUsage;
    beforeAll(() => {
        g.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
    });
    afterAll(() => { g.GPUTextureUsage = savedUsage; });

    test("a MANAGED cube is rebuilt and all six faces re-uploaded after the GPU side is dropped", () => {
        const { dev, index, created, writes } = makeDevice();
        dev.ensureTexture(index);
        expect(writes.length).toBe(6);
        expect(dev.textures.isDirty(index)).toBe(false);

        writes.length = 0;
        created.length = 0;
        dev.textures.dropGpuResources();
        expect(dev.textures.getGpuTexture(index)).toBeNull();
        expect(dev.textures.isDirty(index)).toBe(true);

        dev.ensureTexture(index);
        expect(dev.textures.getGpuTexture(index)).not.toBeNull();
        expect(dev.textures.getView(index)).not.toBeNull();
        expect(created).toEqual([{ mipLevelCount: 1, depthOrArrayLayers: 6 }]);
        expect(writes.map((w) => w.z).sort()).toEqual([0, 1, 2, 3, 4, 5]);
        expect(dev.textures.isDirty(index)).toBe(false);
    });
});
