import { describe, expect, test } from "bun:test";
import { DxSamplerCache, type SamplerSpec } from "../../src/worker/backends/webgpu/shared/dx-sampler";
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

describe("DxSamplerCache.resolveDescriptor — anisotropy invariant", () => {
    test("game anisotropy forces all filters linear and disables base-level pin", () => {
        const d = resolve(base({ min: "nearest", mag: "nearest", mip: "nearest", mipNone: true, gameAnisotropy: 8 }));
        expect(d.minFilter).toBe("linear");
        expect(d.magFilter).toBe("linear");
        expect(d.mipmapFilter).toBe("linear");
        expect(d.maxAnisotropy).toBe(8);
        expect(d.lodMaxClamp).toBeUndefined(); // aniso opts into the mip chain
    });

    test("anisotropy is clamped to [1,16]", () => {
        expect(resolve(base({ gameAnisotropy: 999 })).maxAnisotropy).toBe(16);
        expect(resolve(base({ gameAnisotropy: 0 })).maxAnisotropy).toBe(1);
    });
});

describe("DxSamplerCache.resolveDescriptor — quality overrides", () => {
    test("forceTrilinear upgrades a bilinear NONE texture to mip linear and lifts the base-level pin", () => {
        const d = DxSamplerCache.resolveDescriptor(
            base({ min: "linear", mag: "linear", mip: "nearest", mipNone: true }),
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
