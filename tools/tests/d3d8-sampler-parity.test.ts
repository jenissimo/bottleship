/**
 * D3D8 fixed-function/programmable sampler decode parity — docs/d3d8-parity/02-samplers.md.
 *
 * F1: the shared FFP decode (ffp-stages.ts + bind-group-manager.ts) is used by BOTH genuine
 * DDraw/D3D7 callers (D3DTFP_* mip-filter numbering: NONE=1/POINT=2/LINEAR=3) and D3D8's
 * fixed-function draws (D3DTEXF_* numbering: NONE=0/POINT=1/LINEAR=2). The two are NOT
 * numerically compatible, so FfpStagesState must decode differently depending on which
 * vocabulary the draw's raw D3DTSS_MIPFILTER value was written in — and must default to the
 * D3D7 vocabulary so no existing DDraw/D3D7 title's decode changes.
 *
 * F5/F3/F2: D3DTSS_MIPMAPLODBIAS / D3DTSS_MAXMIPLEVEL / D3DTSS_MAXANISOTROPY / D3DTSS_BORDERCOLOR
 * plumbed through decodeD3d8TssSampler (programmable path) and FfpStagesState (FFP path).
 */
import { describe, expect, test } from "bun:test";
// Prime the module graph the same way ffp-stages.test.ts does (import-cycle workaround).
import "../../src/worker/modules/ddraw/d3d/types";
import { FfpStagesState } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import {
    decodeD3d8TssSampler,
    D3DTEXF_NONE,
    D3DTEXF_POINT,
    D3DTEXF_LINEAR,
    D3DTEXF_ANISOTROPIC,
} from "../../src/worker/backends/webgpu/d3d8/d3d8-sampler";
import {
    D3DTSS_MIPFILTER,
    D3DTSS_MIPMAPLODBIAS,
    D3DTSS_MAXMIPLEVEL,
    D3DTSS_MAXANISOTROPY,
    D3DTSS_BORDERCOLOR,
    D3DTSS_ADDRESSU,
    D3DTSS_MINFILTER,
    D3DTSS_MAGFILTER,
    D3DTADDRESS_BORDER,
    D3DTFP_NONE,
    D3DTFP_POINT,
    D3DTFP_LINEAR,
} from "../../src/worker/modules/ddraw/d3d/sampler-constants";

function makeStates(): Int32Array {
    return new Int32Array(8 * 32);
}

function set(states: Int32Array, stage: number, key: number, value: number): void {
    states[stage * 32 + key] = value;
}

// Bit-cast helper for building D3DTSS_MIPMAPLODBIAS test fixtures (raw DWORD holding an
// IEEE-754 float), mirroring the production decode's own bit-cast.
function floatBits(f: number): number {
    return new Int32Array(new Float32Array([f]).buffer)[0];
}

describe("FfpStagesState — F1: mip-filter vocabulary must be explicit, not guessed", () => {
    test("defaults to the D3D7 vocabulary — existing DDraw/D3D7 callers are unaffected", () => {
        const st = new FfpStagesState();
        expect(st.getFilterVocabulary()).toBe("d3d7");
    });

    test("raw value 1: D3D7 vocabulary decodes it as D3DTFP_NONE (no mip filtering)", () => {
        const st = new FfpStagesState();
        const states = makeStates();
        set(states, 0, D3DTSS_MIPFILTER, 1); // D3D7: D3DTFP_NONE
        st.resolve(states, 1, true, true);
        expect(st.mipFilter[0]).toBe(D3DTFP_NONE);
    });

    test("raw value 1: D3D9/D3D8 vocabulary decodes the SAME raw value as D3DTEXF_POINT — a different result", () => {
        const st = new FfpStagesState();
        st.setFilterVocabulary("d3d9");
        const states = makeStates();
        set(states, 0, D3DTSS_MIPFILTER, 1); // D3D8/9: D3DTEXF_POINT
        st.resolve(states, 1, true, true);
        expect(st.mipFilter[0]).toBe(D3DTFP_POINT);
        expect(st.mipFilter[0]).not.toBe(D3DTFP_NONE);
    });

    test("raw value 2: D3D7 vocabulary is POINT, D3D9 vocabulary is LINEAR — genuinely diverge", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_MIPFILTER, 2);

        const d7 = new FfpStagesState();
        d7.resolve(states, 1, true, true);
        expect(d7.mipFilter[0]).toBe(D3DTFP_POINT);

        const d9 = new FfpStagesState();
        d9.setFilterVocabulary("d3d9");
        d9.resolve(states, 1, true, true);
        expect(d9.mipFilter[0]).toBe(D3DTFP_LINEAR);

        expect(d7.mipFilter[0]).not.toBe(d9.mipFilter[0]);
    });

    test("raw value 0 (never set) decodes identically in both vocabularies: no mip filtering", () => {
        const states = makeStates(); // D3DTSS_MIPFILTER left at 0 in both cases
        const d7 = new FfpStagesState();
        d7.resolve(states, 1, true, true);
        const d9 = new FfpStagesState();
        d9.setFilterVocabulary("d3d9");
        d9.resolve(states, 1, true, true);
        expect(d7.mipFilter[0]).toBe(D3DTFP_NONE);
        expect(d9.mipFilter[0]).toBe(D3DTFP_NONE);
    });

    test("ANISOTROPIC (D3DTEXF_ANISOTROPIC=3) mip filter maps to D3D7 LINEAR (trilinear-equivalent)", () => {
        const st = new FfpStagesState();
        st.setFilterVocabulary("d3d9");
        const states = makeStates();
        set(states, 0, D3DTSS_MIPFILTER, D3DTEXF_ANISOTROPIC);
        st.resolve(states, 1, true, true);
        expect(st.mipFilter[0]).toBe(D3DTFP_LINEAR);
    });

    test("MIN/MAGFILTER values are unaffected by vocabulary (D3D7 and D3D9 share bit patterns)", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_MINFILTER, 2); // LINEAR in both vocabularies
        set(states, 0, D3DTSS_MAGFILTER, 2);
        const d7 = new FfpStagesState();
        d7.resolve(states, 1, true, true);
        const d9 = new FfpStagesState();
        d9.setFilterVocabulary("d3d9");
        d9.resolve(states, 1, true, true);
        expect(d7.minFilter[0]).toBe(d9.minFilter[0]);
        expect(d7.magFilter[0]).toBe(d9.magFilter[0]);
    });

    test("setFilterVocabulary is per-instance and persists across resolve() calls", () => {
        const st = new FfpStagesState();
        st.setFilterVocabulary("d3d9");
        const states = makeStates();
        set(states, 0, D3DTSS_MIPFILTER, 1);
        st.resolve(states, 1, true, true);
        expect(st.mipFilter[0]).toBe(D3DTFP_POINT);
        // Second resolve() on the same instance keeps the vocabulary — a per-draw call site
        // never re-specifies it.
        st.resolve(states, 1, true, true);
        expect(st.mipFilter[0]).toBe(D3DTFP_POINT);
        expect(st.getFilterVocabulary()).toBe("d3d9");
    });
});

describe("FfpStagesState — F5: MIPMAPLODBIAS/MAXMIPLEVEL/BORDERCOLOR captured per stage", () => {
    test("D3DTSS_MAXMIPLEVEL raw DWORD is captured", () => {
        const st = new FfpStagesState();
        const states = makeStates();
        set(states, 0, D3DTSS_MAXMIPLEVEL, 3);
        st.resolve(states, 1, true, true);
        expect(st.maxMipLevel[0]).toBe(3);
    });

    test("D3DTSS_MIPMAPLODBIAS raw DWORD (float bits) is captured verbatim", () => {
        const st = new FfpStagesState();
        const states = makeStates();
        const bits = floatBits(-1.5);
        set(states, 0, D3DTSS_MIPMAPLODBIAS, bits);
        st.resolve(states, 1, true, true);
        expect(st.mipLodBiasBits[0]).toBe(bits);
    });

    test("D3DTSS_BORDERCOLOR raw ARGB DWORD is captured", () => {
        const st = new FfpStagesState();
        const states = makeStates();
        set(states, 0, D3DTSS_BORDERCOLOR, 0x11223344);
        st.resolve(states, 1, true, true);
        expect(st.borderColor[0] >>> 0).toBe(0x11223344);
    });
});

describe("decodeD3d8TssSampler — F3: real D3DTSS_MAXANISOTROPY, not a hardcoded 16", () => {
    test("ANISOTROPIC filter with an explicit light MAXANISOTROPY uses the real value", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_MINFILTER, D3DTEXF_ANISOTROPIC);
        set(states, 0, D3DTSS_MAGFILTER, D3DTEXF_LINEAR);
        set(states, 0, D3DTSS_MAXANISOTROPY, 2);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.gameAnisotropy).toBe(2);
        expect(spec.gameAnisotropy).not.toBe(16);
    });

    test("ANISOTROPIC filter with MAXANISOTROPY unset falls back to 1, not 16", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_MINFILTER, D3DTEXF_ANISOTROPIC);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.gameAnisotropy).toBe(1);
    });

    test("MAXANISOTROPY above the advertised cap is clamped, never a refused draw", () => {
        // The D3D9 runtime and DXVK both clamp to [1,16]; engines write their config value
        // straight through, so refusing here loses every primitive on the stage.
        const states = makeStates();
        set(states, 0, D3DTSS_MINFILTER, D3DTEXF_ANISOTROPIC);
        set(states, 0, D3DTSS_MAXANISOTROPY, 32);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.unsupportedFeatures ?? []).not.toContain("d3d9-anisotropy-limit");
        // The request survives into the spec; clampAniso in dx-sampler is what caps the
        // descriptor at the advertised 16, and it is covered there.
        expect(spec.gameAnisotropy).toBe(32);
    });
});

describe("decodeD3d8TssSampler — F5: MIPMAPLODBIAS / MAXMIPLEVEL wired into SamplerSpec", () => {
    test("MIPMAPLODBIAS decodes its IEEE-754 bits into a float", () => {
        const states = makeStates();
        const bits = floatBits(2.5);
        set(states, 0, D3DTSS_MIPMAPLODBIAS, bits);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.mipLodBias).toBeCloseTo(2.5, 5);
        expect(spec.mipLodBiasBits).toBe(bits >>> 0);
    });

    test("MAXMIPLEVEL is read, not hardcoded to 0", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_MAXMIPLEVEL, 4);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.maxMipLevel).toBe(4);
    });
});

describe("decodeD3d8TssSampler — F2: BORDERCOLOR read, D3DTADDRESS_BORDER preserved as a real mode", () => {
    test("ADDRESSU=BORDER decodes to the explicit d3d9-border tag, not a bare clamp collapse", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_ADDRESSU, D3DTADDRESS_BORDER);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.addressU).toBe("d3d9-border");
    });

    test("D3DTSS_BORDERCOLOR is read into SamplerSpec.borderColor", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_BORDERCOLOR, 0xff102030);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.borderColor! >>> 0).toBe(0xff102030 >>> 0);
    });
});

describe("decodeD3d8TssSampler — unaffected by F1..F5 fixes (regression guard)", () => {
    test("MIPFILTER still decodes in the correct D3D8/D3D9 D3DTEXF_* vocabulary (this decoder never used D3D7 numbering)", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_MIPFILTER, D3DTEXF_POINT); // = 1
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.mip).toBe("nearest");
        expect(spec.mipNone).toBe(false);
    });

    test("MIPFILTER=NONE (0) still pins the base level", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_MIPFILTER, D3DTEXF_NONE);
        const spec = decodeD3d8TssSampler(states, 0);
        expect(spec.mipNone).toBe(true);
    });
});
