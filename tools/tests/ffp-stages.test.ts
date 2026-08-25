/**
 * FFP stage-cascade resolver + packing tests (ffp-stages.ts) and WGSL generation
 * smoke tests (shader-generator.ts). Characterizes the D3D7/D3D8 per-stage rules
 * that used to live inline in the executor:
 *  - stage-0 defaults (MODULATE / SELECTARG1, CURRENT→DIFFUSE, missing-texture remaps)
 *  - stage-N defaults (DISABLE, TEXTURE/CURRENT args)
 *  - cascade termination at the first disabled stage
 *  - arithmetic stages (no TEXTURE args) running without a texture binding
 *  - sampling demotion re-terminating the cascade
 *  - vec4u packing consumed by both uniform writers
 */
import { describe, expect, test } from "bun:test";
// Prime the module graph: ddraw/constants participates in an import cycle through
// core/com/com-memory → … → d3d/types (which reads constants at module scope).
// Evaluating d3d/types first resolves the cycle the same way the worker entry does.
import "../../src/worker/modules/ddraw/d3d/types";
import {
    FfpStagesState,
    MAX_FFP_STAGES,
    MAX_FFP_SAMPLED_STAGES,
} from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import {
    generateShaderCode,
    generateMegaBatchShaderCode,
    ShaderConfig,
} from "../../src/worker/backends/webgpu/ddraw/shader-generator";
import {
    D3DTSS_COLOROP,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    D3DTSS_COLORARG0,
    D3DTSS_ALPHAARG0,
    D3DTOP_DISABLE,
    D3DTOP_MODULATE,
    D3DTOP_SELECTARG1,
    D3DTOP_MULTIPLYADD,
    D3DTOP_LERP,
    D3DTA_TEXTURE,
    D3DTA_DIFFUSE,
    D3DTA_CURRENT,
    D3DTA_TFACTOR,
} from "../../src/worker/modules/ddraw/constants";

function makeStates(): Int32Array {
    return new Int32Array(8 * 32);
}

function set(states: Int32Array, stage: number, key: number, value: number): void {
    states[stage * 32 + key] = value;
}

describe("FfpStagesState.resolve", () => {
    test("uninitialized stage 0 with texture: MODULATE(TEXTURE, DIFFUSE), samples", () => {
        const st = new FfpStagesState();
        st.resolve(makeStates(), /*realTexMask*/ 1, /*hasTexCoords*/ true, /*dummy*/ true);
        expect(st.colorOp[0]).toBe(D3DTOP_MODULATE);
        expect(st.alphaOp[0]).toBe(D3DTOP_SELECTARG1);
        expect(st.colorArg1[0]).toBe(D3DTA_TEXTURE);
        expect(st.colorArg2[0]).toBe(D3DTA_DIFFUSE);
        expect(st.sampledMask).toBe(1);
        expect(st.enabledMask).toBe(1);
        expect(st.stageCount).toBe(1);
        expect(st.missingMask).toBe(0);
    });

    test("stage 0 without texture: TEXTURE args remap to DIFFUSE, MODULATE→SELECTARG1", () => {
        const st = new FfpStagesState();
        st.resolve(makeStates(), 0, true, true);
        // MODULATE(DIFFUSE, DIFFUSE) darkens vertex-color rendering → SELECTARG1
        expect(st.colorOp[0]).toBe(D3DTOP_SELECTARG1);
        expect(st.colorArg1[0]).toBe(D3DTA_DIFFUSE);
        expect(st.sampledMask).toBe(0);
        expect(st.missingMask).toBe(1); // active, wanted TEXTURE, none bound
    });

    test("stage 0 CURRENT resolves to DIFFUSE", () => {
        const states = makeStates();
        set(states, 0, D3DTSS_COLORARG2, D3DTA_CURRENT);
        const st = new FfpStagesState();
        st.resolve(states, 1, true, true);
        expect(st.colorArg2[0]).toBe(D3DTA_DIFFUSE);
    });

    test("textured stage 1 (lightmap): samples and extends the cascade", () => {
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_MODULATE);
        const st = new FfpStagesState();
        st.resolve(states, 0b11, true, true);
        expect(st.sampledMask).toBe(0b11);
        expect(st.enabledMask).toBe(0b11);
        expect(st.stageCount).toBe(2);
        // Stage 1+ defaults blend against CURRENT
        expect(st.colorArg2[1]).toBe(D3DTA_CURRENT);
        expect(st.alphaOp[1]).toBe(D3DTOP_SELECTARG1);
    });

    test("MULTIPLYADD preserves COLORARG0 for the third combiner operand", () => {
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_MULTIPLYADD);
        set(states, 1, D3DTSS_COLORARG0, D3DTA_CURRENT);
        set(states, 1, D3DTSS_COLORARG1, D3DTA_TEXTURE);
        set(states, 1, D3DTSS_COLORARG2, D3DTA_TFACTOR);
        const st = new FfpStagesState();
        st.resolve(states, 0b11, true, true);
        expect(st.colorArg0[1]).toBe(D3DTA_CURRENT);
        st.pack();
        expect((st.packed[4] >>> 16) & 0xff).toBe(D3DTA_CURRENT);
    });

    test("a stale ARG0 on a non-ARG0 op does not make an arithmetic stage look textured", () => {
        // ARG0 persists across draws, so a stage that ran LERP with ARG0=TEXTURE and is
        // then reused as a pure CURRENT×TFACTOR fade still carries it. Only MULTIPLYADD
        // and LERP read ARG0; counting it anywhere else drops the stage — and every stage
        // above it — out of the cascade, and the fade silently vanishes.
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_MODULATE);
        set(states, 1, D3DTSS_COLORARG1, D3DTA_CURRENT);
        set(states, 1, D3DTSS_COLORARG2, D3DTA_TFACTOR);
        set(states, 1, D3DTSS_COLORARG0, D3DTA_TEXTURE);   // stale, MODULATE ignores it
        set(states, 1, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
        set(states, 1, D3DTSS_ALPHAARG1, D3DTA_CURRENT);
        set(states, 1, D3DTSS_ALPHAARG2, D3DTA_CURRENT);
        set(states, 1, D3DTSS_ALPHAARG0, D3DTA_TEXTURE);   // stale, SELECTARG1 ignores it
        const st = new FfpStagesState();
        st.resolve(states, 0b01, true, true);              // no stage-1 texture
        expect(st.enabledMask).toBe(0b11);                 // cascade survives
        expect(st.sampledMask).toBe(0b01);
        expect(st.missingMask & 0b10).toBe(0);             // arithmetic, not "missing"
    });

    test("LERP still counts ARG0, so a missing texture is reported", () => {
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_LERP);
        set(states, 1, D3DTSS_COLORARG0, D3DTA_TEXTURE);   // LERP reads it
        set(states, 1, D3DTSS_COLORARG1, D3DTA_CURRENT);
        set(states, 1, D3DTSS_COLORARG2, D3DTA_TFACTOR);
        const st = new FfpStagesState();
        st.resolve(states, 0b01, true, true);              // no stage-1 texture
        expect(st.missingMask & 0b10).not.toBe(0);
    });

    test("arithmetic stage 1 (CURRENT×TFACTOR fade) runs without sampling", () => {
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_MODULATE);
        set(states, 1, D3DTSS_COLORARG1, D3DTA_CURRENT);
        set(states, 1, D3DTSS_COLORARG2, D3DTA_TFACTOR);
        set(states, 1, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
        set(states, 1, D3DTSS_ALPHAARG1, D3DTA_CURRENT);
        set(states, 1, D3DTSS_ALPHAARG2, D3DTA_CURRENT);
        const st = new FfpStagesState();
        st.resolve(states, 0b01, true, true); // no stage-1 texture
        expect(st.sampledMask).toBe(0b01);
        expect(st.enabledMask).toBe(0b11);
        expect(st.stageCount).toBe(2);
        expect(st.missingMask & 0b10).toBe(0); // arithmetic — not "missing"
    });

    test("cascade terminates at first DISABLE: stage 2 active behind disabled stage 1 is off", () => {
        const states = makeStates();
        // stage 1 left uninitialized → DISABLE
        set(states, 2, D3DTSS_COLOROP, D3DTOP_MODULATE);
        const st = new FfpStagesState();
        st.resolve(states, 0b101, true, true);
        expect(st.enabledMask).toBe(0b001);
        expect(st.sampledMask).toBe(0b001);
        expect(st.stageCount).toBe(1);
    });

    test("full 3-texture cascade + arithmetic stage 3", () => {
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_MODULATE);
        set(states, 2, D3DTSS_COLOROP, D3DTOP_MODULATE);
        set(states, 3, D3DTSS_COLOROP, D3DTOP_MODULATE);
        set(states, 3, D3DTSS_COLORARG1, D3DTA_CURRENT);
        set(states, 3, D3DTSS_COLORARG2, D3DTA_TFACTOR);
        set(states, 3, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
        set(states, 3, D3DTSS_ALPHAARG1, D3DTA_CURRENT);
        set(states, 3, D3DTSS_ALPHAARG2, D3DTA_CURRENT);
        const st = new FfpStagesState();
        st.resolve(states, 0b0111, true, true);
        expect(st.sampledMask).toBe(0b0111);
        expect(st.enabledMask).toBe(0b1111);
        expect(st.stageCount).toBe(4);
    });

    test("stages beyond MAX_FFP_SAMPLED_STAGES never sample", () => {
        const states = makeStates();
        for (let s = 1; s < MAX_FFP_STAGES; s++) {
            set(states, s, D3DTSS_COLOROP, D3DTOP_MODULATE);
            set(states, s, D3DTSS_COLORARG1, D3DTA_CURRENT);
            set(states, s, D3DTSS_COLORARG2, D3DTA_TFACTOR);
            set(states, s, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
            set(states, s, D3DTSS_ALPHAARG1, D3DTA_CURRENT);
            set(states, s, D3DTSS_ALPHAARG2, D3DTA_CURRENT);
        }
        const st = new FfpStagesState();
        st.resolve(states, 0xff, true, true);
        expect(st.sampledMask & ~((1 << MAX_FFP_SAMPLED_STAGES) - 1)).toBe(0);
        // All-arithmetic upper stages keep the cascade alive to the top
        expect(st.stageCount).toBe(MAX_FFP_STAGES);
    });

    test("demoteSampling re-terminates the cascade above a textured stage", () => {
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_MODULATE); // textured (default TEXTURE arg)
        set(states, 2, D3DTSS_COLOROP, D3DTOP_MODULATE); // textured
        const st = new FfpStagesState();
        st.resolve(states, 0b111, true, true);
        expect(st.enabledMask).toBe(0b111);
        st.demoteSampling(1);
        // Stage 1 wanted a texture → drops out; stage 2 rides the cascade → also off.
        expect(st.enabledMask).toBe(0b001);
        expect(st.sampledMask).toBe(0b001);
        expect(st.stageCount).toBe(1);
    });

    test("pack: ops/args/tci/xform-flags packed per vec4u lane, disabled stages → DISABLE", () => {
        const states = makeStates();
        set(states, 1, D3DTSS_COLOROP, D3DTOP_MODULATE);
        set(states, 1, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
        const st = new FfpStagesState();
        st.resolve(states, 0b11, true, true);
        st.tci[1] = 0x00020001; // texgen mode 2 + UV set 1
        st.texXformFlags[1] = 0x102;
        st.pack();
        // stage 1: ops and ARG0 values are packed as u8×4.
        expect(st.packed[1 * 4 + 0]).toBe(
            D3DTOP_MODULATE | (D3DTOP_SELECTARG1 << 8) |
            (D3DTA_CURRENT << 16) | (D3DTA_CURRENT << 24));
        // y = args u8×4 (defaults TEXTURE/CURRENT for stage 1)
        expect(st.packed[1 * 4 + 1]).toBe(
            D3DTA_TEXTURE | (D3DTA_CURRENT << 8) | (D3DTA_TEXTURE << 16) | (D3DTA_CURRENT << 24));
        expect(st.packed[1 * 4 + 2]).toBe(0x00020001);
        expect(st.packed[1 * 4 + 3]).toBe(0x102);
        // stage 2 disabled → DISABLE ops
        expect(st.packed[2 * 4 + 0] & 0xff).toBe(D3DTOP_DISABLE);
    });
});

describe("shader generation (stage-generic WGSL)", () => {
    const baseConfig: Omit<ShaderConfig, "sampledMask" | "stageCount"> = {
        alphaTestEnabled: false,
        alphaFunc: 8,
        shouldEnableBlending: false,
        missingTexture: false,
        colorKeyEnabled: false,
        colorKey: null,
        debugFlags: { forceZMidpoint: false } as any,
    };

    test("legacy shader: bindings and stage blocks follow the masks", () => {
        const code = generateShaderCode({ ...baseConfig, sampledMask: 0b1011, stageCount: 4 });
        for (const s of [0, 1, 3]) {
            expect(code).toContain(`var tex${s}Sampler`);
            expect(code).toContain(`var tex${s}: texture_2d<f32>`);
        }
        expect(code).not.toContain("var tex2Sampler");
        // 4 cascade blocks; the non-sampled stage 2 uses the neutral texture color
        for (const s of [0, 1, 2, 3]) expect(code).toContain(`uniforms.stages[${s}]`);
        expect(code).toContain(`stages: array<vec4u, ${MAX_FFP_STAGES}>`);
        expect(code).toContain("var tex2Color = vec4f(0.0, 0.0, 0.0, 1.0)");
        expect(code).toContain("arg0 + arg1 * arg2");
    });

    test("legacy shader: untextured stage 0 falls back to diffuse", () => {
        const code = generateShaderCode({ ...baseConfig, sampledMask: 0, stageCount: 1 });
        expect(code).toContain("var tex0Color = diffuse");
        expect(code).not.toContain("textureSample(tex0");
    });

    test("megabatch shader mirrors the stage cascade against the storage slot", () => {
        const code = generateMegaBatchShaderCode({ ...baseConfig, sampledMask: 0b11, stageCount: 2, useMegaBatch: true });
        expect(code).toContain("var<storage, read> draws");
        expect(code).toContain("draw.stages[0]");
        expect(code).toContain("draw.stages[1]");
        expect(code).toContain("textureSample(tex1, tex1Sampler, in.uv1)");
    });
});
