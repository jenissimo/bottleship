/**
 * ffp-lighting.ts owns both halves of one contract: the WGSL `Uniforms` struct and
 * `packFfpUniforms`, the JS writer that fills the matching byte block. Nothing at runtime
 * checks that they agree — a mismatched field reads as plausible garbage, not as an error.
 *
 * These tests derive every field offset from the WGSL text (std140 uniform layout) and probe
 * the packer with distinctive values, so adding, moving or resizing a member on one side and
 * not the other fails here instead of in a shader.
 */
import { describe, expect, test } from "bun:test";
import {
    FFP_UNIFORM_STRUCT_WGSL,
    FFP_UNIFORM_FLOATS,
    FFP_MAX_LIGHTS,
    FFP_MAX_STAGES,
    FFP_MAX_TEX_MATRICES,
    FFP_TEXGEN_WGSL,
    ffpStageOffset,
    ffpTexGenOffset,
    ffpTexMatrixOffset,
    packFfpUniforms,
    emitFfpComputeLighting,
    D3DLIGHT_DIRECTIONAL,
    type FfpUniformParams,
    type FfpLightInput,
} from "../../src/worker/backends/webgpu/d3d9/ffp-lighting";

/** Size + alignment, in FLOATS, of the WGSL types the FFP uniform struct uses. */
function sizeAlign(type: string): { size: number; align: number } {
    const t = type.trim();
    if (t === "vec4<f32>") return { size: 4, align: 4 };
    if (t === "mat4x4<f32>") return { size: 16, align: 4 };
    if (t === "FfpLight") return { size: 28, align: 4 };
    if (t === "FfpStage") return { size: 8, align: 4 };
    const arr = /^array<\s*([^,]+)\s*,\s*(\d+)\s*>$/.exec(t);
    if (arr) {
        const el = sizeAlign(arr[1]);
        // Uniform-address-space arrays use a 16-byte (4-float) element stride.
        const stride = Math.ceil(el.size / 4) * 4;
        return { size: stride * Number(arr[2]), align: el.align };
    }
    throw new Error(`unhandled WGSL type in FFP uniform struct: ${t}`);
}

/** Float offsets of every member of the WGSL `Uniforms` struct, in declaration order. */
function wgslUniformOffsets(): Map<string, number> {
    const body = /struct Uniforms \{([\s\S]*?)\n\}/.exec(FFP_UNIFORM_STRUCT_WGSL);
    expect(body).not.toBeNull();
    const out = new Map<string, number>();
    let cursor = 0;
    for (const raw of body![1].split("\n")) {
        const line = raw.replace(/\/\/.*$/, "").trim().replace(/,$/, "");
        if (!line) continue;
        const m = /^(\w+)\s*:\s*(.+)$/.exec(line);
        if (!m) continue;
        const { size, align } = sizeAlign(m[2]);
        cursor = Math.ceil(cursor / align) * align;
        out.set(m[1], cursor);
        cursor += size;
    }
    out.set("__end", Math.ceil(cursor / 4) * 4);
    return out;
}

const light = (over: Partial<FfpLightInput> = {}): FfpLightInput => ({
    type: D3DLIGHT_DIRECTIONAL,
    diffuse: { r: 0, g: 0, b: 0, a: 0 },
    specular: { r: 0, g: 0, b: 0, a: 0 },
    ambient: { r: 0, g: 0, b: 0, a: 0 },
    position: [0, 0, 0], direction: [0, 0, 1],
    range: 0, falloff: 0, att0: 1, att1: 0, att2: 0, theta: 0, phi: 0,
    ...over,
});

/** A params block whose every field carries a distinct, findable value. */
function probeParams(): FfpUniformParams {
    const ramp = (base: number) => Float32Array.from({ length: 16 }, (_u, i) => base + i);
    return {
        viewportW: 640, viewportH: 480,
        mvp: ramp(1000), worldView: ramp(2000), normalMatrix: ramp(3000),
        view: ramp(4000), world: ramp(5000),
        clipPlanes: Float32Array.from({ length: 24 }, (_u, i) => 6000 + i),
        clipPlaneEnable: 0x2a,
        material: {
            diffuse: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 },
            ambient: { r: 0.5, g: 0.6, b: 0.7, a: 0.8 },
            specular: { r: 0.11, g: 0.12, b: 0.13, a: 0.14 },
            emissive: { r: 0.21, g: 0.22, b: 0.23, a: 0.24 },
            power: 17,
        },
        globalAmbient: { r: 0.31, g: 0.32, b: 0.33, a: 0.34 },
        lightingEnabled: true, specularEnable: true, localViewer: true,
        diffuseSrc: 1, ambientSrc: 0, specularSrc: 2, emissiveSrc: 0,
        hasNormal: true, normalizeNormals: true,
        lights: [light({ diffuse: { r: 7, g: 8, b: 9, a: 10 } })],
        stages: [{
            colorOp: 4, colorArg1: 2, colorArg2: 1, alphaOp: 2, alphaArg1: 2, alphaArg2: 1,
            // ARG0s and RESULTARG=D3DTA_TEMP share one word — see the packing assertion below.
            colorArg0: 0x23, alphaArg0: 0x11, resultArg: 5,
            // D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR | UV set 1, and COUNT2 | PROJECTED.
            texCoordIndex: 0x00030001, texTransformFlags: 0x102,
        }],
        texMatrices: Float32Array.from({ length: FFP_MAX_TEX_MATRICES * 16 }, (_u, i) => 7000 + i),
        tfactor: { r: 0.41, g: 0.42, b: 0.43, a: 0.44 },
        fogColor: { r: 0.51, g: 0.52, b: 0.53, a: 1 },
        fogStart: 12, fogEnd: 34, fogDensity: 0.5, fogMode: 2,
    };
}

describe("FFP uniform block ↔ WGSL struct", () => {
    const off = wgslUniformOffsets();

    test("the WGSL struct is exactly FFP_UNIFORM_FLOATS long", () => {
        expect(off.get("__end")).toBe(FFP_UNIFORM_FLOATS);
    });

    test("ffpStageOffset points at the WGSL stages array", () => {
        const base = off.get("stages")!;
        for (let s = 0; s < FFP_MAX_STAGES; s++) {
            expect(ffpStageOffset(s)).toBe(base + s * 8);
        }
    });

    test("ffpTexGenOffset / ffpTexMatrixOffset point at their WGSL arrays", () => {
        const gen = off.get("texGen")!;
        const mat = off.get("texMatrices")!;
        for (let s = 0; s < FFP_MAX_STAGES; s++) expect(ffpTexGenOffset(s)).toBe(gen + s * 4);
        for (let s = 0; s < FFP_MAX_TEX_MATRICES; s++) expect(ffpTexMatrixOffset(s)).toBe(mat + s * 16);
    });

    test("packFfpUniforms writes every member where the WGSL struct declares it", () => {
        const p = probeParams();
        const out = new Float32Array(FFP_UNIFORM_FLOATS);
        // This test is about WHERE each member lands, not what the transform does to it.
        // The pixel-centre convention (backends/webgpu/pixel-center.ts) shifts mvp's x/y by
        // design, so switch it off here to keep the probe values readable as placements.
        (globalThis as Record<string, unknown>).__d3dNoPixelCentre = true;
        try {
            packFfpUniforms(out, p);
        } finally {
            delete (globalThis as Record<string, unknown>).__d3dNoPixelCentre;
        }

        const at = (name: string, i = 0) => out[off.get(name)! + i];
        expect(at("viewport")).toBe(640);
        expect(at("viewport", 1)).toBe(480);
        expect(at("mvp")).toBe(1000);
        expect(at("mvp", 15)).toBe(1015);
        expect(at("worldView")).toBe(2000);
        expect(at("normalMatrix")).toBe(3000);
        expect(at("normalMatrix", 15)).toBe(3015);
        expect(at("world")).toBe(5000);
        expect(at("clipPlanes")).toBe(6000);
        expect(at("clipPlanes", 23)).toBe(6023);
        expect(at("matDiffuse")).toBeCloseTo(0.1);
        expect(at("matAmbient")).toBeCloseTo(0.5);
        expect(at("matSpecular")).toBeCloseTo(0.11);
        expect(at("matEmissive")).toBeCloseTo(0.21);
        expect(at("globalAmbient")).toBeCloseTo(0.31);
        expect(at("tfactor")).toBeCloseTo(0.41);
        expect(at("fogColor")).toBeCloseTo(0.51);
        expect(at("fogParams")).toBe(12);
        expect(at("fogParams", 3)).toBe(2);
        expect(at("stages")).toBe(4);      // colorOp
        // FfpStage.b.w packs the two ARG0 selectors and the RESULTARG==TEMP flag into one word;
        // the shader unpacks it with the same shifts. A widened FfpStage would move
        // ffpStageOffset, which callers index directly, so the packing is the contract.
        expect(out[ffpStageOffset(0) + 7]).toBe(0x23 | (0x11 << 8) | (1 << 16));
        // Texgen state travels RAW: the shader, not the packer, decodes TCI_* and D3DTTFF.
        expect(out[ffpTexGenOffset(0)]).toBe(0x00030001);
        expect(out[ffpTexGenOffset(0) + 1]).toBe(0x102);
        expect(out[ffpTexMatrixOffset(0)]).toBe(7000);
        expect(out[ffpTexMatrixOffset(FFP_MAX_TEX_MATRICES - 1) + 15])
            .toBe(7000 + FFP_MAX_TEX_MATRICES * 16 - 1);

        // ctrl words: power/lighting/specular/localViewer, the four colour sources,
        // then numLights/hasNormal/clipPlaneEnable/normalizeNormals.
        expect([at("ctrl0"), at("ctrl0", 1), at("ctrl0", 2), at("ctrl0", 3)]).toEqual([17, 1, 1, 1]);
        expect([at("ctrl1"), at("ctrl1", 1), at("ctrl1", 2), at("ctrl1", 3)]).toEqual([1, 0, 2, 0]);
        expect([at("ctrl2"), at("ctrl2", 1), at("ctrl2", 2), at("ctrl2", 3)]).toEqual([1, 1, 0x2a, 1]);

        // Light 0's diffuse is the first vec4 of the first FfpLight slot.
        expect(at("lights")).toBe(7);
        expect(at("lights", 3)).toBe(10);
    });

    test("the light array holds FFP_MAX_LIGHTS slots and no more", () => {
        const p = probeParams();
        p.lights = Array.from({ length: FFP_MAX_LIGHTS + 3 }, (_u, i) =>
            light({ diffuse: { r: i + 1, g: 0, b: 0, a: 0 } }));
        const out = new Float32Array(FFP_UNIFORM_FLOATS);
        packFfpUniforms(out, p);
        expect(out[off.get("ctrl2")!]).toBe(FFP_MAX_LIGHTS);
        expect(out[off.get("lights")! + (FFP_MAX_LIGHTS - 1) * 28]).toBe(FFP_MAX_LIGHTS);
        // The slot past the last one belongs to the next member, not to a 9th light.
        expect(off.get("world")).toBe(off.get("lights")! + FFP_MAX_LIGHTS * 28);
    });
});

describe("ffpTexCoordSrc / ffpTexTransform WGSL", () => {
    test("implements every D3DTSS_TCI_* generator the census treats as supported", () => {
        // Modes 1..4 = CAMERASPACENORMAL / POSITION / REFLECTIONVECTOR / SPHEREMAP; 0 is
        // passthrough. censusFfpGaps only counts a mode above 4, so all five must be here.
        for (const mode of [1, 2, 3, 4]) {
            expect(FFP_TEXGEN_WGSL).toContain(`mode == ${mode}u`);
        }
    });

    test("applies the texture matrix only for D3DTTFF_COUNT2..COUNT4", () => {
        // DXVK: applyTransform = flags > D3DTTFF_COUNT1 && flags <= D3DTTFF_COUNT4. Passing
        // COUNT1 (or DISABLE) through untransformed is the part that is easy to get wrong.
        expect(FFP_TEXGEN_WGSL).toContain("if (count < 2u || count > 4u) { return src.xy; }");
    });

    test("divides by the D3DTTFF_PROJECTED component, not blindly by w", () => {
        expect(FFP_TEXGEN_WGSL).toContain("v[count - 1u]");
    });
});

describe("ffpComputeLighting WGSL", () => {
    const wgsl = emitFfpComputeLighting("u.lights");

    test("templates the light-array expression", () => {
        expect(wgsl).toContain("u.lights[i]");
    });

    test("takes the normalize-normals switch rather than normalizing unconditionally", () => {
        expect(wgsl).toContain("normalizeNormals: bool");
        expect(wgsl).not.toContain("normalize(ecNormalIn)");
    });

    test("does not gate specular on a non-zero material power", () => {
        // D3DMATERIAL9.Power == 0 means pow(x, 0) == 1, not "no specular".
        expect(wgsl).not.toContain("power > 0.0");
    });
});
