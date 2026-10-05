import { describe, expect, test } from "bun:test";
import {
    DxSamplerCache, dxSamplerShaderKey, dxSamplerShaderStatesKey,
    dxSrgbViewFormat, dxSrgbViewFormats, type SamplerSpec,
} from "../../src/worker/backends/webgpu/shared/dx-sampler";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

// Default (no overrides) quality so the pure mapping is exercised, not the QoL enhancements.
const Q = { anisotropy: 1, forceTrilinear: false };
const resolve = (spec: SamplerSpec) => DxSamplerCache.resolveDescriptor(spec, Q);

const base = (over: Partial<SamplerSpec> = {}): SamplerSpec => ({
    min: "linear",
    mag: "linear",
    mip: "nearest",
    mipNone: true,
    addressU: "repeat",
    addressV: "repeat",
    ...over,
});

describe("DxSamplerCache.resolveDescriptor — base mapping", () => {
    test("passes filters and address modes straight through", () => {
        const d = resolve(base({ min: "nearest", mag: "linear", addressU: "mirror-repeat", addressV: "clamp-to-edge" }));
        expect(d.minFilter).toBe("nearest");
        expect(d.magFilter).toBe("linear");
        expect(d.addressModeU).toBe("mirror-repeat");
        expect(d.addressModeV).toBe("clamp-to-edge");
        expect(d.maxAnisotropy).toBe(1);
    });

    test("MIPFILTER=NONE pins the base level (lodMaxClamp = 0)", () => {
        const d = resolve(base({ mip: "nearest", mipNone: true }));
        expect(d.lodMaxClamp).toBe(0);
    });

    test("MIPFILTER=LINEAR leaves the full mip range open (no lodMaxClamp)", () => {
        const d = resolve(base({ mip: "linear", mipNone: false }));
        expect(d.lodMaxClamp).toBeUndefined();
        expect(d.mipmapFilter).toBe("linear");
    });

    test("MAXMIPLEVEL maps to lodMinClamp (most-detailed usable level)", () => {
        const d = resolve(base({ mip: "linear", mipNone: false, maxMipLevel: 3 }));
        expect(d.lodMinClamp).toBe(3);
    });

    test("MAXMIPLEVEL with NONE clamps both ends to the requested base level", () => {
        const d = resolve(base({ mip: "nearest", mipNone: true, maxMipLevel: 2 }));
        expect(d.lodMinClamp).toBe(2);
        expect(d.lodMaxClamp).toBe(2);
    });
});

describe("DxSamplerCache — shader-emulated Direct3D address modes", () => {
    test("maps BORDER to a clamp baseline while preserving its shader key", () => {
        const spec = base({ addressU: "d3d9-border", borderColor: 0x80402010 });
        expect(DxSamplerCache.unsupportedAddressMode(spec)).toBe("d3d9-border");
        expect(resolve(spec).addressModeU).toBe("clamp-to-edge");
        expect(dxSamplerShaderKey(spec)).toContain("b");
        expect(dxSamplerShaderKey(spec)).toContain("80402010");
    });

    test("maps MIRRORONCE to a clamp baseline, not mirror-repeat", () => {
        const spec = base({ addressV: "d3d9-mirror-once" });
        expect(DxSamplerCache.unsupportedAddressMode(spec)).toBe("d3d9-mirror-once");
        expect(resolve(spec).addressModeV).toBe("clamp-to-edge");
        expect(dxSamplerShaderKey(spec)).toContain("o");
    });

    test("acquires a clamp baseline for shader-emulated modes", () => {
        let creates = 0;
        const device = {
            createSampler: () => {
                creates++;
                return {} as GPUSampler;
            },
        } as unknown as GPUDevice;
        const cache = new DxSamplerCache(device);
        expect(cache.tryAcquire(base({ addressU: "d3d9-border" }))).not.toBeNull();
        expect(creates).toBe(1);
    });

    test("keeps non-zero LOD bias in the shader key while descriptor remains native", () => {
        const spec = base({ mipLodBias: 1, mipLodBiasBits: 0x3f800000 });
        expect(DxSamplerCache.unsupportedReason(spec)).toBeNull();
        expect(resolve(spec).addressModeU).toBe("repeat");
        expect(dxSamplerShaderKey(spec)).toContain("3f800000");
    });

    test("shader-state keys are stable regardless of insertion order", () => {
        const a = new Map<number, SamplerSpec>([
            [2, base({ addressU: "d3d9-border" })], [0, base({ addressV: "d3d9-mirror-once" })],
        ]);
        const b = new Map<number, SamplerSpec>([
            [0, base({ addressV: "d3d9-mirror-once" })], [2, base({ addressU: "d3d9-border" })],
        ]);
        expect(dxSamplerShaderStatesKey(a)).toBe(dxSamplerShaderStatesKey(b));
    });

    test("keeps sRGB texture decode out of the sampler descriptor", () => {
        const spec = base({ srgbTexture: true });
        expect(DxSamplerCache.unsupportedReason(spec)).toBeNull();
        expect(resolve(spec).compare).toBeUndefined();
    });

    test("maps compatible linear texture formats to sRGB views", () => {
        expect(dxSrgbViewFormat("rgba8unorm")).toBe("rgba8unorm-srgb");
        expect(dxSrgbViewFormat("bc1-rgba-unorm")).toBe("bc1-rgba-unorm-srgb");
        expect(dxSrgbViewFormats("bgra8unorm")).toEqual(["bgra8unorm-srgb"]);
        expect(dxSrgbViewFormat("depth32float")).toBeNull();
    });
});

describe("DxSamplerCache.resolveDescriptor — anisotropy invariant", () => {
    test("game anisotropy forces all filters linear when a mip chain is selected", () => {
        const d = resolve(base({ min: "linear", mag: "linear", mip: "nearest", mipNone: false, gameAnisotropy: 8 }));
        expect(d.minFilter).toBe("linear");
        expect(d.magFilter).toBe("linear");
        expect(d.mipmapFilter).toBe("linear");
        expect(d.maxAnisotropy).toBe(8);
        expect(d.lodMaxClamp).toBeUndefined(); // aniso opts into the mip chain
    });

    test("MIPFILTER=NONE keeps anisotropy and still pins the base level", () => {
        // D3DTEXF_ANISOTROPIC with MIPFILTER=NONE is legal on real hardware: anisotropy
        // filters the in-plane footprint, it does not select a mip. WebGPU only asks for
        // three "linear" filters, which the LOD pin below keeps on one level.
        const d = resolve(base({ min: "linear", mag: "linear", mip: "nearest", mipNone: true, gameAnisotropy: 8 }));
        expect(d.maxAnisotropy).toBe(8);
        expect(d.mipmapFilter).toBe("linear");
        expect(d.lodMaxClamp).toBe(0);
        expect(d.lodMinClamp ?? 0).toBe(0);
    });

    test("a MIPFILTER=NONE pin follows MAXMIPLEVEL instead of collapsing to level zero", () => {
        const d = resolve(base({
            min: "linear", mag: "linear", mip: "nearest", mipNone: true,
            gameAnisotropy: 4, maxMipLevel: 3,
        }));
        expect(d.maxAnisotropy).toBe(4);
        expect(d.lodMinClamp).toBe(3);
        expect(d.lodMaxClamp).toBe(3);
    });

    test("anisotropy is clamped to [1,16]", () => {
        expect(resolve(base({ mipNone: false, gameAnisotropy: 999 })).maxAnisotropy).toBe(16);
        expect(resolve(base({ gameAnisotropy: 0 })).maxAnisotropy).toBe(1);
    });
});

describe("DxSamplerCache.resolveDescriptor — quality overrides", () => {
    test("forceTrilinear preserves a bilinear NONE texture's base-level pin", () => {
        const d = DxSamplerCache.resolveDescriptor(
            base({ min: "linear", mag: "linear", mip: "nearest", mipNone: true }),
            { anisotropy: 1, forceTrilinear: true },
        );
        expect(d.mipmapFilter).toBe("nearest");
        expect(d.lodMaxClamp).toBe(0);
    });

    test("forceTrilinear upgrades a texture that already selected mip filtering", () => {
        const d = DxSamplerCache.resolveDescriptor(
            base({ min: "linear", mag: "linear", mip: "nearest", mipNone: false }),
            { anisotropy: 1, forceTrilinear: true },
        );
        expect(d.mipmapFilter).toBe("linear");
        expect(d.lodMaxClamp).toBeUndefined();
    });

    test("forceTrilinear NEVER touches an intentionally point-sampled texture", () => {
        const d = DxSamplerCache.resolveDescriptor(
            base({ min: "nearest", mag: "nearest", mip: "nearest", mipNone: true }),
            { anisotropy: 16, forceTrilinear: true },
        );
        expect(d.minFilter).toBe("nearest");
        expect(d.magFilter).toBe("nearest");
        expect(d.maxAnisotropy).toBe(1);
        expect(d.lodMaxClamp).toBe(0); // still pinned to base — no QoL applied to point art
    });

    test("tryAcquire turns an unsupported feature into a draw-safe null", () => {
        let creates = 0;
        const device = {
            createSampler: () => {
                creates++;
                return {} as GPUSampler;
            },
        } as unknown as GPUDevice;
        const cache = new DxSamplerCache(device);
        expect(() => cache.tryAcquire(base({ unsupportedFeatures: ["d3d9-anisotropy-limit"] }))).not.toThrow();
        expect(cache.tryAcquire(base({ unsupportedFeatures: ["d3d9-anisotropy-limit"] }))).toBeNull();
        expect(creates).toBe(0);
    });
});

// Callers memoise an acquired sampler against their own state; the token is what stops that
// memo surviving a live quality change (a stale sampler renders with no error anywhere).
describe("DxSamplerCache.qualityToken", () => {
    test("moves iff the quality inputs resolveDescriptor reads move", () => {
        const cfg = EmulatorConfig.getInstance();
        const restore = { anisotropy: cfg.quality.anisotropy, forceTrilinear: cfg.quality.forceTrilinear };
        try {
            cfg.applyQuality({ anisotropy: 1, forceTrilinear: false });
            const t0 = DxSamplerCache.qualityToken();
            expect(DxSamplerCache.qualityToken()).toBe(t0);

            cfg.applyQuality({ forceTrilinear: true });
            expect(DxSamplerCache.qualityToken()).not.toBe(t0);

            cfg.applyQuality({ anisotropy: 8, forceTrilinear: false });
            expect(DxSamplerCache.qualityToken()).not.toBe(t0);

            // An unrelated quality field must NOT churn the token (that would rebuild every sampler).
            cfg.applyQuality({ anisotropy: 1, forceTrilinear: false });
            expect(DxSamplerCache.qualityToken()).toBe(t0);
            cfg.applyQuality({ brightness: 1.5 });
            expect(DxSamplerCache.qualityToken()).toBe(t0);
        } finally {
            cfg.applyQuality(restore);
        }
    });
});
