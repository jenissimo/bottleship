import { describe, expect, test } from "bun:test";
import { FFP_FOG_WGSL, resolveFfpFogMode } from "../../src/worker/backends/webgpu/d3d9/ffp-fog";
import { emitFfpShader } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

describe("D3D9 fixed-function fog", () => {
    test("encodes range vertex fog separately from depth-based vertex fog", () => {
        expect(resolveFfpFogMode(1, 0, 3, false, false)).toBe(7);
        expect(resolveFfpFogMode(1, 0, 3, false, false, true)).toBe(11);
        // Table fog wins: RANGEFOGENABLE only changes the vertex-fog branch.
        expect(resolveFfpFogMode(1, 3, 1, false, false, true)).toBe(3);
        // Pre-transformed vertices have no eye-space T&L position and retain the
        // specular-alpha convention even if RANGEFOGENABLE was set.
        expect(resolveFfpFogMode(1, 0, 3, true, false, true)).toBe(0);
    });

    test("WGSL uses Euclidean eye distance for range fog modes", () => {
        expect(FFP_FOG_WGSL).toContain("eyeDistance: f32");
        expect(FFP_FOG_WGSL).toContain("mode >= 8.5");
        expect(FFP_FOG_WGSL).toContain("depth = eyeDistance");
        expect(FFP_FOG_WGSL).toContain("mode = mode - 8.0");
    });

    test("production FFP shader evaluates table fog from fragment position", () => {
        const wgsl = emitFfpShader({
            inputFields: ["@location(0) pos: vec3<f32>"],
            hasRhw: false,
            hasTex: false,
            lit: false,
            colorExpr: "vec4<f32>(1.0)",
            specularExpr: "vec4<f32>(0.0)",
            normalExpr: "vec3<f32>(0.0, 0.0, 1.0)",
        });
        const fragment = wgsl.slice(wgsl.indexOf("@fragment"));
        const vertex = wgsl.slice(0, wgsl.indexOf("@fragment"));
        expect(wgsl).toContain("fn fs_main(input: VertexOutput)");
        expect(wgsl).toContain("if (u.fogParams.w >= 1.0 && u.fogParams.w < 4.0)");
        expect(fragment).toContain("let _fragDepth = input.position.z / input.position.w;");
        expect(fragment).toContain("_fogFactor = ffpFogFactor");
        expect(vertex).not.toContain("let _fragDepth = input.position.z / input.position.w;");

        const textured = emitFfpShader({
            inputFields: [
                "@location(0) pos: vec3<f32>",
                "@location(1) uv: vec2<f32>",
            ],
            hasRhw: false,
            hasTex: true,
            texCoordExprs: ["vec4<f32>(input.uv, 1.0, 0.0)"],
            stageCount: 1,
            lit: false,
            colorExpr: "vec4<f32>(1.0)",
            specularExpr: "vec4<f32>(0.0)",
            normalExpr: "vec3<f32>(0.0, 0.0, 1.0)",
        });
        expect(textured).toContain("@location(5) tc0: vec4<f32>");
        expect(textured).toContain("out.tc0 = ffpTexTransform");
    });
});
