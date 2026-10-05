import { describe, expect, test } from "bun:test";
import { emitFfpShader } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import {
    D3DVBF_0WEIGHTS,
    D3DVBF_1WEIGHTS,
    D3DVBF_3WEIGHTS,
    D3DVBF_DISABLE,
    D3DVBF_TWEENING,
    blendFfpNormal,
    blendFfpPosition,
    resolveFfpVertexBlend,
    tweenFfpVector,
} from "../../src/worker/backends/webgpu/d3d9/ffp-vertex-blend";

function translation(x: number, y = 0, z = 0): Float32Array {
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        x, y, z, 1,
    ]);
}

function expectVec(actual: ArrayLike<number>, expected: readonly number[]): void {
    expect(Array.from(actual)).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 5);
}

describe("D3D9 fixed-function vertex blend math", () => {
    test("resolves N explicit weights to N+1 matrices", () => {
        expect(resolveFfpVertexBlend(D3DVBF_1WEIGHTS, false).mode).toMatchObject({
            kind: "palette", matrixCount: 2, explicitWeightCount: 1, indexed: false,
        });
        expect(resolveFfpVertexBlend(D3DVBF_3WEIGHTS, true).mode).toMatchObject({
            kind: "palette", matrixCount: 4, explicitWeightCount: 3, indexed: true,
        });
        expect(resolveFfpVertexBlend(D3DVBF_0WEIGHTS, true).mode).toMatchObject({
            kind: "palette", matrixCount: 1, explicitWeightCount: 0, indexed: true,
        });
        expect(resolveFfpVertexBlend(D3DVBF_DISABLE, false).mode?.kind).toBe("disabled");
        expect(resolveFfpVertexBlend(D3DVBF_TWEENING, true).mode).toBeNull();
    });

    test("blends a position and computes the implicit final weight", () => {
        const mode = resolveFfpVertexBlend(D3DVBF_1WEIGHTS, false).mode!;
        const result = blendFfpPosition([1, 2, 3], [0.25], [translation(10), translation(20)], mode);
        // 0.25*(1+10) + 0.75*(1+20) = 18.5; y/z remain unchanged.
        expectVec(result, [18.5, 2, 3]);
    });

    test("indexed blend uses each UBYTE4 matrix index, including 0WEIGHTS", () => {
        const palette = [translation(1), translation(11), translation(21)];
        const mode = resolveFfpVertexBlend(D3DVBF_0WEIGHTS, true).mode!;
        expectVec(blendFfpPosition([0, 0, 0], [], palette, mode, [2]), [21, 0, 0]);

        const weighted = resolveFfpVertexBlend(D3DVBF_1WEIGHTS, true).mode!;
        expectVec(blendFfpPosition([0, 0, 0], [0.25], palette, weighted, [1, 2]), [18.5, 0, 0]);
    });

    test("normals omit translation but use the same partition of unity", () => {
        const mode = resolveFfpVertexBlend(D3DVBF_1WEIGHTS, false).mode!;
        expectVec(blendFfpNormal([1, 0, 0], [0.25], [translation(10), translation(20)], mode), [1, 0, 0]);
    });

    test("tweening linearly interpolates POSITION0/POSITION1", () => {
        const mode = resolveFfpVertexBlend(D3DVBF_TWEENING, false).mode!;
        expect(mode.kind).toBe("tweening");
        expectVec(tweenFfpVector([0, 2, 4], [10, 6, 0], 0.25), [2.5, 3, 3]);
        // The pure helper leaves clamping to the D3D state validation layer;
        // this is useful for faithfully exposing malformed guest state.
        expectVec(tweenFfpVector([0, 0, 0], [1, 1, 1], 1.5), [1.5, 1.5, 1.5]);
    });

    test("the shipped FFP vertex stage consumes the palette blend state", () => {
        const wgsl = emitFfpShader({
            inputFields: [
                "@location(0) pos: vec3<f32>",
                "@location(1) blendWeights: vec4<f32>",
            ],
            hasRhw: false,
            hasTex: false,
            lit: false,
            colorExpr: "vec4<f32>(1.0)",
            specularExpr: "vec4<f32>(0.0)",
            normalExpr: "vec3<f32>(0.0, 0.0, 1.0)",
            blendWeightsExpr: "input.blendWeights",
        });
        expect(wgsl).toContain("let _ffpMode = u32(u.blendCtrl.x)");
        expect(wgsl).toContain("u.blendMatrices[_ffpIndex]");
        expect(wgsl).toContain("_ffpRemain = _ffpRemain - _ffpWeight");
        expect(wgsl).toContain("_ffpBlendPos = _ffpBlendPos + _ffpWeight");
    });
});
