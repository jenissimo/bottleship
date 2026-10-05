import { describe, expect, test } from "bun:test";
import {
    beginD3D9MultisampleRenderPass,
    D3D9MultisampleTargetCache,
    getD3D9MsaaCapabilityContract,
    makeD3D9MultisamplePassDescriptor,
    resolveD3D9MrtCompatibility,
    resolveD3D9StandaloneDepthPolicy,
    resolveD3D9StandaloneDepthPolicyBySampleCount,
    resolveD3D9StretchRectMsaaPolicy,
    setD3D9MsaaCapabilityContract,
} from "../../src/worker/backends/webgpu/d3d9/multisample";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type MockTexture = {
    descriptor: Record<string, unknown>;
    destroyed: boolean;
    createView: () => object;
    destroy: () => void;
};

function makeMockDevice() {
    const textures: MockTexture[] = [];
    const device = {
        createTexture(descriptor: Record<string, unknown>): MockTexture {
            const texture: MockTexture = {
                descriptor,
                destroyed: false,
                createView: () => ({ texture }),
                destroy: () => { texture.destroyed = true; },
            };
            textures.push(texture);
            return texture;
        },
    };
    return { device, textures };
}

function installGpuTextureUsage(): void {
    (globalThis as typeof globalThis & { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage = {
        COPY_SRC: 1,
        COPY_DST: 2,
        TEXTURE_BINDING: 4,
        RENDER_ATTACHMENT: 16,
    };
}

describe("D3D9 multisample resources", () => {
    test("creates matching 2x color/depth attachments and a single-sample resolve target", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: (count) => count === 2 || count === 4,
        });
        const target = cache.acquire({
            key: 7,
            width: 320,
            height: 200,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 2,
        });
        expect(target).not.toBeNull();
        expect(target!.sampleCount).toBe(2);
        expect(textures).toHaveLength(3);
        expect(textures[0]!.descriptor.sampleCount).toBe(2);
        expect(textures[1]!.descriptor.sampleCount).toBe(1);
        expect(textures[2]!.descriptor.sampleCount).toBe(2);
        expect(textures[0]!.descriptor.usage).toBe(16);
        expect(textures[1]!.descriptor.usage).toBe(23);
        expect(textures[2]!.descriptor.usage).toBe(16);
    });

    test("declares color view formats so an sRGB MSAA view is legal", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: () => true,
        });
        expect(cache.acquire({
            key: "srgb-rt",
            width: 16,
            height: 16,
            colorFormat: "bgra8unorm",
            colorViewFormats: ["bgra8unorm-srgb"],
            depthFormat: "depth24plus",
            sampleCount: 2,
        })).not.toBeNull();
        expect(textures[0]!.descriptor.viewFormats).toEqual(["bgra8unorm-srgb"]);
    });

    test("reuses exact cache identity and retires old resources when descriptor changes", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: () => true,
        });
        const desc = {
            key: "backbuffer",
            width: 64,
            height: 64,
            colorFormat: "bgra8unorm" as GPUTextureFormat,
            depthFormat: "depth24plus" as GPUTextureFormat,
            sampleCount: 4,
        };
        const first = cache.acquire(desc);
        const same = cache.acquire({ ...desc });
        expect(same).toBe(first);
        expect(textures).toHaveLength(3);
        const changed = cache.acquire({ ...desc, width: 128 });
        expect(changed).not.toBe(first);
        expect(textures[0]!.destroyed).toBe(false);
        cache.flushGarbage();
        expect(textures[0]!.destroyed).toBe(true);
        expect(textures[1]!.destroyed).toBe(true);
        expect(textures[2]!.destroyed).toBe(true);
    });

    test("rekeys an external resolve when its view format changes", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const resolveTexture = device.createTexture({ sampleCount: 1, usage: 23 });
        const firstView = resolveTexture.createView();
        const secondView = resolveTexture.createView();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: () => true,
        });
        const first = cache.acquire({
            key: "rt-view",
            width: 16,
            height: 16,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 2,
            resolveTexture: resolveTexture as unknown as GPUTexture,
            resolveView: firstView as unknown as GPUTextureView,
        });
        const second = cache.acquire({
            key: "rt-view",
            width: 16,
            height: 16,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 2,
            resolveTexture: resolveTexture as unknown as GPUTexture,
            resolveView: secondView as unknown as GPUTextureView,
        });
        expect(second).not.toBe(first);
        expect(textures[1]!.destroyed).toBe(false);
        cache.flushGarbage();
        expect(textures[1]!.destroyed).toBe(true);
        expect(textures[0]!.destroyed).toBe(false);
    });

    test("refuses unsupported adapter counts before creating any texture", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: (count) => count === 4,
        });
        const target = cache.acquire({
            key: 1,
            width: 16,
            height: 16,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 2,
        });
        expect(target).toBeNull();
        expect(textures).toHaveLength(0);
        expect(cache.get(1)).toBeNull();
    });

    test("render-pass descriptor uses resolveTarget and matching depth count", () => {
        installGpuTextureUsage();
        const { device } = makeMockDevice();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: () => true,
        });
        const target = cache.acquire({
            key: 2,
            width: 8,
            height: 8,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 4,
        })!;
        const desc = makeD3D9MultisamplePassDescriptor(target, {
            clearColor: { r: 0, g: 0, b: 0, a: 1 },
            colorLoadOp: "clear",
            depthLoadOp: "clear",
            stencilLoadOp: "clear",
        });
        const color = desc.colorAttachments[0]!;
        expect(color.view).toBe(target.colorView);
        expect(color.resolveTarget).toBe(target.resolveView);
        expect(desc.depthStencilAttachment!.view).toBe(target.depthView);
        expect(desc.depthStencilAttachment!.stencilLoadOp).toBeUndefined();
        expect(color.storeOp).toBe("store");

        const occlusionQuerySet = {} as GPUQuerySet;
        const queryDesc = makeD3D9MultisamplePassDescriptor(target, {
            clearColor: { r: 0, g: 0, b: 0, a: 1 },
            occlusionQuerySet,
        });
        expect(queryDesc.occlusionQuerySet).toBe(occlusionQuerySet);
    });

    test("begin helper forwards the complete descriptor to the command encoder", () => {
        installGpuTextureUsage();
        const { device } = makeMockDevice();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: () => true,
        });
        const target = cache.acquire({
            key: "pass",
            width: 4,
            height: 4,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 2,
        })!;
        let received: GPURenderPassDescriptor | null = null;
        const pass = {} as GPURenderPassEncoder;
        const encoder = {
            beginRenderPass(descriptor: GPURenderPassDescriptor) {
                received = descriptor;
                return pass;
            },
        } as unknown as GPUCommandEncoder;
        expect(beginD3D9MultisampleRenderPass(encoder, target, {
            clearColor: { r: 1, g: 0, b: 0, a: 1 },
        })).toBe(pass);
        expect(received?.colorAttachments[0]?.resolveTarget).toBe(target.resolveView);
    });

    test("defaults to safe refusal when no adapter probe is supplied", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice);
        expect(cache.acquire({
            key: "unprobed",
            width: 4,
            height: 4,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 4,
        })).toBeNull();
        expect(textures).toHaveLength(0);
    });

    test("uses an external D3D9 RT texture as resolve target without owning or destroying it", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const resolveTexture = device.createTexture({ sampleCount: 1, usage: 23 });
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: () => true,
        });
        const target = cache.acquire({
            key: "rt0",
            width: 32,
            height: 32,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus",
            sampleCount: 4,
            resolveTexture: resolveTexture as unknown as GPUTexture,
        });
        expect(target!.resolveTexture).toBe(resolveTexture);
        expect(target!.ownsResolveTexture).toBe(false);
        expect(textures).toHaveLength(3);
        cache.remove("rt0");
        cache.flushGarbage();
        expect(resolveTexture.destroyed).toBe(false);
    });

    test("uses a standalone D3D9 depth surface for the MSAA attachment without owning it", () => {
        installGpuTextureUsage();
        const { device, textures } = makeMockDevice();
        const depthTexture = device.createTexture({ sampleCount: 4, format: "depth24plus-stencil8", usage: 16 });
        const depthView = depthTexture.createView();
        const cache = new D3D9MultisampleTargetCache(device as unknown as GPUDevice, {
            supportsSampleCount: () => true,
        });
        const target = cache.acquire({
            key: "rt-with-standalone-depth",
            width: 32,
            height: 32,
            colorFormat: "rgba8unorm",
            depthFormat: "depth24plus-stencil8",
            sampleCount: 4,
            depthTexture: depthTexture as unknown as GPUTexture,
            depthView: depthView as unknown as GPUTextureView,
        });
        expect(target).not.toBeNull();
        expect(target!.depthTexture).toBe(depthTexture);
        expect(target!.depthView).toBe(depthView);
        expect(target!.ownsDepthTexture).toBe(false);
        // color + resolve are owned; the external depth remains alive through cache retirement.
        expect(textures).toHaveLength(3);
        cache.remove("rt-with-standalone-depth");
        cache.flushGarbage();
        expect(depthTexture.destroyed).toBe(false);
    });

    test("module-local adapter contract is explicit and absent by default", () => {
        const previous = getD3D9MsaaCapabilityContract();
        setD3D9MsaaCapabilityContract(null);
        expect(getD3D9MsaaCapabilityContract()).toBeNull();
        setD3D9MsaaCapabilityContract({ supportsSampleCount: (count) => count === 4 });
        expect(getD3D9MsaaCapabilityContract()?.supportsSampleCount(2)).toBe(false);
        expect(getD3D9MsaaCapabilityContract()?.supportsSampleCount(4)).toBe(true);
        setD3D9MsaaCapabilityContract(previous);
    });

    test("allows MSAA-source StretchRect only as a resolve into a single-sample target", () => {
        const resolve = resolveD3D9StretchRectMsaaPolicy(2, 0);
        expect(resolve.supported).toBe(true);
        expect(resolve.requiresResolve).toBe(true);
        expect(resolve.sourceSampleCount).toBe(2);
        expect(resolve.destinationSampleCount).toBe(1);

        const msaaToMsaa = resolveD3D9StretchRectMsaaPolicy(2, 4);
        expect(msaaToMsaa.supported).toBe(false);
        expect(msaaToMsaa.reason).toContain("multisample destination");
    });

    test("requires standalone depth sample count to match the active color target", () => {
        expect(resolveD3D9StandaloneDepthPolicy(2, 2)).toEqual({
            supported: true,
            depthSampleCount: 2,
            targetSampleCount: 2,
            reason: null,
        });
        const mismatch = resolveD3D9StandaloneDepthPolicy(4, 2);
        expect(mismatch.supported).toBe(false);
        expect(mismatch.reason).toContain("must match");
        expect(resolveD3D9StandaloneDepthPolicy(8, 2).supported).toBe(false);
    });

    test("accepts a non-MSAA standalone depth surface against a non-MSAA target", () => {
        // A sample COUNT of 1 is "no MSAA"; as a D3DMULTISAMPLE_TYPE the same 1 is
        // NONMASKABLE, which decodes to no supported count at all. A caller holding counts
        // must therefore not reach the type-decoding entry point — doing so refused every
        // ordinary D24S8 SetDepthStencilSurface on the default backbuffer.
        expect(resolveD3D9StandaloneDepthPolicyBySampleCount(1, 1)).toEqual({
            supported: true,
            depthSampleCount: 1,
            targetSampleCount: 1,
            reason: null,
        });
        expect(resolveD3D9StandaloneDepthPolicy(1, 1).supported).toBe(false);
        expect(resolveD3D9StandaloneDepthPolicyBySampleCount(4, 4).supported).toBe(true);
        const mismatch = resolveD3D9StandaloneDepthPolicyBySampleCount(1, 4);
        expect(mismatch.supported).toBe(false);
        expect(mismatch.reason).toContain("must match");
    });

    test("rejects MRT sample-count and extent mismatches before render-pass creation", () => {
        expect(resolveD3D9MrtCompatibility(
            { sampleCount: 4, width: 320, height: 200 },
            { sampleCount: 2, width: 320, height: 200 },
        )).toEqual({
            supported: false,
            reason: "MRT color targets must use one sample count",
        });
        expect(resolveD3D9MrtCompatibility(
            { sampleCount: 4, width: 320, height: 200 },
            { sampleCount: 4, width: 321, height: 200 },
        )).toEqual({
            supported: false,
            reason: "MRT color targets must use one attachment extent",
        });
        expect(resolveD3D9MrtCompatibility(
            { sampleCount: 4, width: 320, height: 200 },
            { sampleCount: 4, width: 320, height: 200 },
        ).supported).toBe(true);
    });
});

describe("D3DRS_MULTISAMPLEMASK reaches the pipeline", () => {
    // resolveD3D9SampleMaskPolicy reports mask===0 as supported, so the mask MUST arrive at
    // GPUMultisampleState.mask. Decoding it into a policy nobody consumes renders a
    // stipple/dissolve effect fully opaque where D3D9 would write no samples at all.
    const device = readFileSync(join(import.meta.dir, "..", "..", "src", "worker",
        "backends", "webgpu", "d3d9", "d3d9-device.ts"), "utf8");
    const sites = [...device.matchAll(/multisample:\s*\{([\s\S]{0,200}?)\}/g)].map(m => m[1]!);

    test("every createRenderPipeline site passes both the count and the mask", () => {
        expect(sites.length).toBeGreaterThanOrEqual(2); // FFP + programmable
        for (const site of sites) {
            expect(site).toContain("count:");
            expect(site).toContain("mask:");
            expect(site).toContain("D3DRS_MULTISAMPLEMASK");
        }
    });
});
