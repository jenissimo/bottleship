import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

function fixture() {
    const textures = new TextureStore(4);
    textures.markRenderTarget(textures.create(10, 256, 192, 1, 21, 0));
    textures.markRenderTarget(textures.create(20, 256, 192, 1, 21, 0));
    const flushedTargets: Array<{ target: number | null; samples: number }> = [];
    const host = Object.assign(Object.create(D3D9Device.prototype), {
        textures,
        role: "front",
        d3d9MsaaSampleCount: 4,
        renderTargetIndices: [null, null, null, null],
        renderTargetFaces: [-1, -1, -1, -1],
        renderTargetSampleTypes: [4, 0, 0, 0],
        currentRtIndex: null,
        currentRtFace: -1,
        targetSizeCache: { w: -1, h: -1 },
        activeStandaloneDepthSurface: null,
        depthTextureIndex: null,
        standaloneDepthSurfaces: new Map(),
        rtSetsThisFrame: 0,
        rtNonBackThisFrame: 0,
        supportsD3D9MultisampleType: (type: number) => type === 0 || type === 4,
        backendExecutor: { getGuestBackbufferSize: () => ({ width: 1024, height: 768 }) },
        invalidateLastResolve() {},
        getRS: () => 0,
        submitFrame() {
            flushedTargets.push({ target: this.currentRtIndex, samples: this.activeRenderTargetSampleCount() });
        },
    });
    return { host, textures, flushedTargets };
}

test("MSAA backbuffer and single-sample targets use independent pipeline sample identities", () => {
    const { host, textures, flushedTargets } = fixture();
    expect(host.setDepthStencilSurface(100, 1024, 768, 75, 4)).toBe(0);
    const msaaKey = host.rasterStateKey();
    expect(host.setRenderTarget(0, 10, -1, 0)).toBe(0);
    expect(host.viewport).toMatchObject({ width: 256, height: 192 });
    expect(host.currentRtIndex).toBe(textures.getIndex(10));
    expect(host.attachmentCompatibilityError()).toBe("incompatible standalone depth attachment");
    expect(host.setDepthStencilSurface(200, 256, 192, 75, 0)).toBe(0);
    expect(host.attachmentCompatibilityError()).toBeNull();
    expect(host.activeRenderTargetSampleCount()).toBe(1);
    expect(host.rasterStateKey()).not.toBe(msaaKey);
    // Depth-first restoration is equally legal while the color attachment is still single-sample.
    expect(host.setDepthStencilSurface(100, 1024, 768, 75, 4)).toBe(0);
    expect(host.setRenderTarget(0, 0, -1, 4)).toBe(0);
    expect(host.attachmentCompatibilityError()).toBeNull();
    expect(host.activeRenderTargetSampleCount()).toBe(4);
    expect(host.rasterStateKey()).toBe(msaaKey);
    expect(host.viewport).toMatchObject({ width: 1024, height: 768 });
    expect(flushedTargets[1]).toEqual({ target: null, samples: 4 });
    expect(flushedTargets.at(-1)).toEqual({ target: textures.getIndex(10), samples: 1 });
});

test("MRT replacement permits intermediate extent mismatches and validates the final attachments", () => {
    const { host } = fixture();
    expect(host.setRenderTarget(1, 20, -1, 0)).toBe(0);
    expect(host.attachmentCompatibilityError()).toBe("incompatible MRT attachments");
    expect(host.setRenderTarget(0, 10, -1, 0)).toBe(0);
    expect(host.attachmentCompatibilityError()).toBeNull();
    expect(host.setRenderTarget(0, 0, -1, 4)).toBe(0);
    expect(host.attachmentCompatibilityError()).toBe("incompatible MRT attachments");
    expect(host.setRenderTarget(1, 0, -1, 0)).toBe(0);
    expect(host.attachmentCompatibilityError()).toBeNull();
});
