/**
 * The FIXED-FUNCTION shader generator must emit WGSL that actually compiles.
 *
 * The offline WGSL validator only ever checked a sentinel pair (one valid module, one malformed
 * one), so it proved naga worked and never saw a single shader WE generate — and an invalid FFP
 * module shipped: `(_ffpMode >= 1u && _ffpMode <= 3u || _ffpMode == 256u)` is a parse error in
 * WGSL ("mixing '&&' and '||' requires parenthesis"), which is only reachable on the SKINNING
 * path. The pipeline then fails to build and every world draw is dropped with
 * `drawIndexed:noPipeline` — a black 3D scene while the 2D UI still renders.
 *
 * So: feed the generator's real permutations to the validator.
 */
import { describe, expect, test } from "bun:test";
import { emitFfpShader } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { probeOfflineWgslValidator, validateWgslOffline } from "../d3d9-parity/wgsl-validator";

const capability = probeOfflineWgslValidator();

const BASE = {
    inputFields: [
        "@location(0) pos: vec4<f32>",
        "@location(1) normal: vec3<f32>",
        "@location(2) color: u32",
        "@location(3) uv: vec2<f32>",
        "@location(4) blendWeights: vec4<f32>",
        "@location(5) blendIndices: vec4<u32>",
        "@location(6) pos1: vec3<f32>",
    ],
    hasRhw: false,
    hasTex: true,
    lit: true,
    colorExpr: "unpackColor(input.color)",
    specularExpr: "vec4<f32>(0.0)",
    normalExpr: "input.normal",
    positionExpr: "input.pos.xyz",
    alphaTest: null,
};

// Spelled exactly as the declaration path spells them (d3d9-device.ts weightExpr/indexExpr):
// weights are a vec4<f32>, indices a vec4<u32>. A scalar here would fail for reasons the
// product never sees, which is worse than no test.
const WEIGHTS = "input.blendWeights";
const INDICES = "input.blendIndices";

/** The permutations the D3D9 FFP path actually reaches, named so a failure says which. */
const CASES: Array<{ name: string; d: Parameters<typeof emitFfpShader>[0] }> = [
    { name: "plain lit+textured", d: { ...BASE } },
    { name: "unlit", d: { ...BASE, lit: false } },
    { name: "screen-space (RHW)", d: { ...BASE, hasRhw: true, positionWExpr: "input.pos.w" } },
    // The regression: indexed/weighted skinning enables the _ffpMode branch.
    { name: "skinning: weights", d: { ...BASE, blendWeightsExpr: WEIGHTS } },
    { name: "skinning: indices", d: { ...BASE, blendIndicesExpr: INDICES } },
    { name: "skinning: weights+indices", d: { ...BASE, blendWeightsExpr: "input.normal", blendIndicesExpr: INDICES } },
    // Tweening takes the sibling branch of the same `if` chain.
    { name: "tween", d: { ...BASE, tweenPosExpr: "input.pos1", tweenNormalExpr: "input.normal" } },
    { name: "tween + skinning", d: { ...BASE, tweenPosExpr: "input.pos1", blendWeightsExpr: WEIGHTS } },
    // Environment mapping: a cube bound to a blend stage. The stage declares texture_cube and
    // samples with a vec3 direction; a vec2 coord against a cube (or the reverse) is a type
    // error naga does see.
    { name: "cube at stage 0", d: { ...BASE, cubeStageMask: 0x1 } },
    { name: "cube at stage 1 of 2", d: { ...BASE, stageCount: 2, cubeStageMask: 0x2 } },
    { name: "cube + 2D mixed, 3 stages", d: { ...BASE, stageCount: 3, cubeStageMask: 0x5 } },
    { name: "cube + skinning", d: { ...BASE, cubeStageMask: 0x1, blendWeightsExpr: WEIGHTS } },
];

describe.skipIf(!capability.available)("FFP-generated WGSL compiles", () => {
    for (const c of CASES) {
        test(c.name, () => {
            const wgsl = emitFfpShader(c.d);
            const r = validateWgslOffline(wgsl, capability);
            expect(r.status, `${c.name}: ${r.diagnostics ?? r.reason}`).toBe("passed");
        });
    }
});

/**
 * The offline validator CANNOT catch this class: naga ACCEPTS `a && b || c`, Dawn (Chrome's
 * WGSL, which actually runs our shaders) REJECTS it. So the rule is enforced structurally here,
 * at every nesting depth — the shipped bug had the mix INSIDE a parenthesised group, so any
 * check that flattens groups first looks right and sees nothing.
 */
function mixedLogicalAtSomeDepth(condition: string): string | null {
    // depth -> operators seen directly at that depth of THIS condition
    const seen: Array<Set<string>> = [new Set()];
    let depth = 0;
    for (let i = 0; i < condition.length; i++) {
        const two = condition.slice(i, i + 2);
        if (condition[i] === "(") { depth++; seen[depth] = new Set(); continue; }
        if (condition[i] === ")") { depth = Math.max(0, depth - 1); continue; }
        if (two === "&&" || two === "||") {
            seen[depth]!.add(two);
            if (seen[depth]!.size > 1) return `depth ${depth}`;
            i++;
        }
    }
    return null;
}

describe("FFP WGSL never mixes && and || unparenthesised", () => {
    for (const c of CASES) {
        test(c.name, () => {
            for (const line of emitFfpShader(c.d).split("\n")) {
                const cond = line.match(/if\s*\((.*)\)\s*\{/)?.[1];
                if (!cond) continue;
                const where = mixedLogicalAtSomeDepth(cond);
                expect(where, `unparenthesised &&/|| at ${where} in: ${line.trim()}`).toBeNull();
            }
        });
    }
});

/**
 * A cube stage's DECLARATION and its sampling coordinate have to move together: a texture_cube
 * sampled with a vec2 (or a texture_2d with a vec3) is rejected, and every draw of that pipeline
 * is dropped. Structural, so it holds even where the offline validator is unavailable.
 */
describe("FFP cube stages declare and sample as cubes", () => {
    test("mask selects which stages are cube", () => {
        const wgsl = emitFfpShader({ ...BASE, stageCount: 3, cubeStageMask: 0x5 });
        expect(wgsl).toContain("var tex: texture_cube<f32>");
        expect(wgsl).toContain("var tex1: texture_2d<f32>");
        expect(wgsl).toContain("var tex2: texture_cube<f32>");
        // vec3 direction for the cube stages, vec2 for the 2-D one.
        expect(wgsl).toContain("let _ffpSampleCoord0 = ffpProjectTexcoord3(");
        expect(wgsl).toContain("let _ffpSampleCoord1 = ffpProjectTexcoord(");
        expect(wgsl).toContain("let _ffpSampleCoord2 = ffpProjectTexcoord3(");
    });

    test("no mask keeps every stage 2-D", () => {
        const wgsl = emitFfpShader({ ...BASE, stageCount: 3 });
        expect(wgsl).not.toContain("texture_cube");
        // The helper is always DECLARED (it lives in the shared texgen block); what a
        // 2-D-only shader must never do is CALL it.
        expect(wgsl).not.toContain("= ffpProjectTexcoord3(");
    });

    test("a cube stage applies no 2-D address fixup", () => {
        // BORDER on a cube has nothing to clamp — the coordinate is a direction. Emitting the
        // 2-D clamp/select would be a vec2 expression handed to a cube sample.
        const samplerStates = new Map([[0, { addressU: "d3d9-border", addressV: "d3d9-border", borderColor: 0xff00ff00 }]]);
        const wgsl = emitFfpShader({
            ...BASE, cubeStageMask: 0x1,
            samplerStates: samplerStates as Parameters<typeof emitFfpShader>[0]["samplerStates"],
        });
        expect(wgsl).toContain("textureSample(tex, texSampler, _ffpSampleCoord0)");
    });
});
