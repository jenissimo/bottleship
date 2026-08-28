import { describe, expect, test, afterEach } from "bun:test";
import {
    indexBufferMeta,
    surfaceMeta,
    summarizeDefaultPoolResources,
    textureMeta,
    vertexBufferMeta,
} from "../../src/worker/modules/d3d9/resource-registry";
import { resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import { volumeTextureResources } from "../../src/worker/modules/d3d9/volume-resources";
import { resolveRequestedMipLevels } from "../../src/worker/modules/d3d9/resource-registry";

const device = {} as any;
const ptrs = [0x1001, 0x1002, 0x1003, 0x1004, 0x1005];

afterEach(() => {
    for (const ptr of ptrs) {
        textureMeta.delete(ptr);
        vertexBufferMeta.delete(ptr);
        indexBufferMeta.delete(ptr);
        surfaceMeta.delete(ptr);
        volumeTextureResources.delete(ptr);
        resourceToDevice.delete(ptr);
    }
});

describe("D3D9 Reset DEFAULT-pool census", () => {
    test("creation mip levels reject zero dimensions and chains beyond the last distinct level", () => {
        expect(resolveRequestedMipLevels(0, 8, 0)).toBeNull();
        expect(resolveRequestedMipLevels(8, 4, 0)).toBe(4);
        expect(resolveRequestedMipLevels(8, 4, 3)).toBe(3);
        expect(resolveRequestedMipLevels(8, 4, 4)).toBe(4);
        expect(resolveRequestedMipLevels(8, 4, 5)).toBeNull();
    });

    test("counts only live application resources owned by the device", () => {
        textureMeta.set(ptrs[0]!, { width: 4, height: 4, levels: 1, usage: 0, pool: 0, format: 21 });
        vertexBufferMeta.set(ptrs[1]!, { size: 16, usage: 0, pool: 0 });
        indexBufferMeta.set(ptrs[2]!, { size: 16, usage: 0, pool: 1, format: 101 });
        surfaceMeta.set(ptrs[3]!, {
            format: 21, type: 1, usage: 1, pool: 0, multiSampleType: 0,
            multiSampleQuality: 0, width: 4, height: 4,
        });
        for (const ptr of ptrs.slice(0, 4)) resourceToDevice.set(ptr, device);
        resourceToDevice.set(ptrs[4]!, {} as any);

        expect(summarizeDefaultPoolResources(device)).toEqual({
            textures: 1, volumes: 0, vertexBuffers: 1, indexBuffers: 0, surfaces: 1, total: 3,
        });
    });

    test("managed and system-memory resources do not block Reset", () => {
        textureMeta.set(ptrs[0]!, { width: 4, height: 4, levels: 1, usage: 0, pool: 1, format: 21 });
        vertexBufferMeta.set(ptrs[1]!, { size: 16, usage: 0, pool: 2 });
        volumeTextureResources.set(ptrs[2]!, { width: 2, height: 2, depth: 2, levels: 1,
            usage: 0, pool: 1, format: 21, levelData: [], allocator: {} as any });
        for (const ptr of ptrs.slice(0, 3)) resourceToDevice.set(ptr, device);

        expect(summarizeDefaultPoolResources(device).total).toBe(0);
    });
});
