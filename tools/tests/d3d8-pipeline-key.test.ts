/**
 * D3D8 programmable pipeline cache key tests.
 */
import { describe, expect, test } from "bun:test";
import { buildD3D8PipelineKey } from "../../src/worker/backends/webgpu/d3d8/d3d8-shader-registry";
import { computeBlendKey } from "../../src/worker/backends/webgpu/d3d9/d3d9-blend";
import { buildD3D8FfpVariantKey } from "../../src/worker/backends/webgpu/d3d8/d3d8-programmable-draw";
import type { SamplerSpec } from "../../src/worker/backends/webgpu/shared/dx-sampler";

function spec(overrides: Partial<SamplerSpec> = {}): SamplerSpec {
    return {
        min: "linear", mag: "linear", mip: "linear", mipNone: false,
        addressU: "clamp-to-edge", addressV: "clamp-to-edge",
        ...overrides,
    };
}

describe("d3d8-pipeline-key", () => {
    test("different cull modes produce different keys", () => {
        const rs1 = new Int32Array(256);
        const rs2 = new Int32Array(256);
        rs1[22] = 2; // D3DRENDERSTATE_CULLMODE — CW
        rs2[22] = 3; // CCW
        const blend = computeBlendKey((s) => rs1[s] ?? 0);
        const k1 = buildD3D8PipelineKey(rs1, 1, 0, 32, 32, "triangle-list", false, blend, "a0", 0);
        const k2 = buildD3D8PipelineKey(rs2, 1, 0, 32, 32, "triangle-list", false, blend, "a0", 0);
        expect(k1).not.toBe(k2);
    });

    test("alpha test change produces different keys", () => {
        const rs = new Int32Array(256);
        const blend = computeBlendKey((s) => rs[s] ?? 0);
        const k1 = buildD3D8PipelineKey(rs, 1, 3, 32, 32, "triangle-list", false, blend, "a0", 0);
        const k2 = buildD3D8PipelineKey(rs, 1, 3, 32, 32, "triangle-list", false, blend, "a3.128", 0);
        expect(k1).not.toBe(k2);
    });

    test("multi-stream stride key is distinct from single-stream", () => {
        const rs = new Int32Array(256);
        const blend = computeBlendKey((s) => rs[s] ?? 0);
        const single = buildD3D8PipelineKey(rs, 1, 0, 24, "24", "triangle-list", false, blend, "a0", 0);
        const multi = buildD3D8PipelineKey(rs, 1, 0, 24, "24|8", "triangle-list", false, blend, "a0", 0);
        expect(single).not.toBe(multi);
        // Numeric and string forms of the same single-stream stride serialize identically.
        expect(buildD3D8PipelineKey(rs, 1, 0, 24, 24, "triangle-list", false, blend, "a0", 0)).toBe(single);
    });

    // linkProgram bakes per-stage sampler semantics INTO the WGSL for a VS + fixed-function
    // pixel draw ("d3d9-border" address emulation, LOD bias, border colour), exactly as the
    // D3D9 path does. A stage switching CLAMP -> BORDER between two otherwise identical draws
    // must therefore land on a different pipeline, or it renders the rest of the session with
    // the shader built for the old sampler state.
    test("sampler state participates in the fixed-function variant key", () => {
        const clamp = new Map([[0, spec()]]);
        const border = new Map([[0, spec({ addressU: "d3d9-border", borderColor: 0xff00ff00 })]]);
        expect(buildD3D8FfpVariantKey(1, 0, clamp)).not.toBe(buildD3D8FfpVariantKey(1, 0, border));

        const biased = new Map([[0, spec({ mipLodBiasBits: 0xbf800000 })]]);
        expect(buildD3D8FfpVariantKey(1, 0, clamp)).not.toBe(buildD3D8FfpVariantKey(1, 0, biased));

        // Stage 1 differing is just as load-bearing as stage 0.
        const twoA = new Map([[0, spec()], [1, spec()]]);
        const twoB = new Map([[0, spec()], [1, spec({ addressV: "d3d9-border" })]]);
        expect(buildD3D8FfpVariantKey(2, 0, twoA)).not.toBe(buildD3D8FfpVariantKey(2, 0, twoB));

        // Same state, same key (or the cache never hits).
        expect(buildD3D8FfpVariantKey(1, 0, clamp)).toBe(buildD3D8FfpVariantKey(1, 0, new Map([[0, spec()]])));
    });

    test("a draw with a real pixel shader reads no sampler state, so its key carries none", () => {
        expect(buildD3D8FfpVariantKey(0, 0, null)).toBe("hs0:pj0");
    });

    test("the variant key still separates stage count and projected mask", () => {
        const s = new Map([[0, spec()]]);
        expect(buildD3D8FfpVariantKey(1, 0, s)).not.toBe(buildD3D8FfpVariantKey(2, 0, s));
        expect(buildD3D8FfpVariantKey(1, 0, s)).not.toBe(buildD3D8FfpVariantKey(1, 1, s));
    });

    test("identical state produces identical keys", () => {
        const rs = new Int32Array(256);
        rs[7] = 1;  // D3DRENDERSTATE_ZENABLE
        rs[14] = 1; // D3DRENDERSTATE_ZWRITEENABLE
        rs[22] = 3; // D3DRENDERSTATE_CULLMODE
        const blend = computeBlendKey((s) => rs[s] ?? 0);
        const k1 = buildD3D8PipelineKey(rs, 5, 7, 36, 36, "triangle-list", false, blend, "a0", 0);
        const k2 = buildD3D8PipelineKey(rs, 5, 7, 36, 36, "triangle-list", false, blend, "a0", 0);
        expect(k1).toBe(k2);
    });
});
