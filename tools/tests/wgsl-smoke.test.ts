import { describe, expect, test } from "bun:test";
import oracleFixtures from "./fixtures/d3dx-shader-asm.json";
import { asmFixture, d3dxOracleAvailable } from "./helpers/asm-fixture";
import { compilePixelShader, compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import {
    probeOfflineWgslValidator,
    validateWgslOffline,
    type WgslValidatorCapability,
} from "../d3d9-parity/wgsl-validator";

const capability = probeOfflineWgslValidator();

function assertAccepted(wgsl: string, capability: WgslValidatorCapability, name: string): void {
    const result = validateWgslOffline(wgsl, capability);
    expect(result.status, `${name}: ${result.diagnostics ?? result.reason}`).toBe("passed");
    expect(result.passed, name).toBe(true);
}

function assertRejected(wgsl: string, capability: WgslValidatorCapability, name: string): void {
    const result = validateWgslOffline(wgsl, capability);
    expect(result.status, `${name}: validator unexpectedly accepted the module`).toBe("rejected");
    expect(result.passed, name).toBe(false);
}

describe.skipIf(!capability.available)("offline WGSL validator", () => {
    test("accepts valid WGSL and rejects malformed WGSL", () => {
        assertAccepted("@compute @workgroup_size(1) fn main() {}", capability, "valid sentinel");
        assertRejected("@compute @workgroup_size(1) fn main( {}", capability, "invalid sentinel");
    });
});

interface ProgramCase {
    name: string;
    vs: string;
    ps: string | null;
    rejected?: RegExp;
    pointExpansion?: boolean;
}

function oracleAsm(name: string): string {
    const fixture = oracleFixtures.cases.find(candidate => candidate.name === name);
    if (!fixture?.asm) throw new Error(`oracle fixture ${name} has no assembly source`);
    return fixture.asm;
}

function recordedTokens(name: string): Uint32Array {
    const fixture = oracleFixtures.cases.find(candidate => candidate.name === name);
    if (!fixture) throw new Error(`missing recorded oracle fixture ${name}`);
    return new Uint32Array(fixture.tokens.map(token => Number(token) >>> 0));
}

async function fixtureTokens(name: string): Promise<Uint32Array> {
    const fixture = oracleFixtures.cases.find(candidate => candidate.name === name);
    if (fixture?.asm && d3dxOracleAvailable()) return (await asmFixture(fixture.asm)).tokens;
    return recordedTokens(name);
}

const PROGRAM_CASES: ProgramCase[] = [
    {
        name: "SM1 vs_1_1 + ps_1_1 legacy texture",
        vs: oracleAsm("vs_1_1_skinned"),
        ps: oracleAsm("ps_1_1_coissue"),
    },
    {
        name: "SM2 vs_2_0 + ps_2_0 texture load",
        vs: oracleAsm("vs_2_0_loop"),
        ps: oracleAsm("ps_2_0_texld"),
    },
    {
        name: "SM3 centroid + dynamic-flow sample",
        vs: `vs_3_0
             dcl_position v0
             dcl_texcoord0 v1
             dcl_position o0
             dcl_texcoord0 o1
             mov o0, v0
             mov o1, v1`,
        ps: `ps_3_0
             dcl_texcoord0_centroid v0.xy
             dcl_2d s0
             def c0, 0.5, 0, 0, 0
             if_gt v0.x, c0.x
               texld r0, v0, s0
             else
               mov r0, c0
             endif
             mov oC0, r0`,
    },
    {
        name: "SM3 gradient instructions in flow (current refusal)",
        vs: `vs_3_0
             dcl_position v0
             dcl_texcoord0 v1
             dcl_position o0
             dcl_texcoord0 o1
             mov o0, v0
             mov o1, v1`,
        ps: `ps_3_0
             dcl_texcoord0 v0
             dcl_2d s0
             def c0, 0.5, 0, 0, 0
             if_gt v0.x, c0.x
               dsx r1, v0
               dsy r2, v0
               texldd r0, v0, s0, r1, r2
             else
               mov r0, c0
             endif
             mov oC0, r0`,
        rejected: /dsx in dynamic control flow cannot be lowered to WGSL/,
    },
    {
        name: "SM3 relative matrix + predication",
        vs: `vs_3_0
             dcl_position v0
             dcl_blendindices v1
             dcl_position o0
             def c60, 2.0, 2.0, 2.0, 2.0
             defb b0, true
             mova a0.x, v1.x
             m4x4 r0, v0, c[a0.x + 7]
             (!p0) add r0, r0, c60
             mov o0, r0`,
        ps: null,
    },
    {
        name: "SM3 MRT + oDepth arithmetic",
        vs: `vs_3_0
             dcl_position v0
             dcl_texcoord0 v1
             dcl_position o0
             dcl_texcoord0 o1
             mov o0, v0
             mov o1, v1`,
        ps: `ps_3_0
             dcl_texcoord0 v0
             def c0, 0.25, 0.5, 0.75, 1.0
             mad oDepth, v0.x, c0.x, c0.y
             mov oC0, c0
             mov oC1, v0`,
    },
    {
        name: "SM3 point size + loop through point expansion",
        vs: `vs_3_0
             dcl_position v0
             dcl_position o0
             dcl_psize o1
             defi i0, 4, 0, 1, 0
             def c0, 1.0, 0, 0, 0
             mov r0, c0
             loop aL, i0
               add r0, r0, c[aL + 1]
             endloop
             mov o0, v0
             mov o1, r0.x`,
        ps: null,
        pointExpansion: true,
    },
];

describe.skipIf(!capability.available || !d3dxOracleAvailable())("WGSL shader smoke", () => {
    test("runs the current SM1/SM2/SM3 oracle cases through Naga", async () => {
        for (const shaderCase of PROGRAM_CASES) {
            const vsTokens = (await asmFixture(shaderCase.vs)).tokens;
            const psTokens = shaderCase.ps ? (await asmFixture(shaderCase.ps)).tokens : null;
            const compile = () => linkProgram({
                vs: compileVertexShader(vsTokens),
                ps: psTokens ? compilePixelShader(psTokens) : null,
                declElements: null,
                streamStride: 0,
                pointExpansion: shaderCase.pointExpansion,
            });

            if (shaderCase.rejected) {
                expect(compile, shaderCase.name).toThrow(shaderCase.rejected);
                continue;
            }
            const linked = compile();
            assertAccepted(linked.wgsl, capability, shaderCase.name);
        }
    });
});

describe.skipIf(!capability.available)("recorded SM3 accept-only WGSL smoke", () => {
    test("accepts the reference assembler's SM3 setp/texldd and breakp variants", async () => {
        const baseVs = compileVertexShader(await fixtureTokens("vs_1_1_skinned"));
        for (const shaderCase of oracleFixtures.acceptOnlyCases) {
            const tokens = new Uint32Array(shaderCase.tokens.map(token => Number(token) >>> 0));
            const program = parseShader(tokens);
            const linked = linkProgram({
                vs: program.isPixelShader ? baseVs : compileVertexShader(tokens),
                ps: program.isPixelShader ? compilePixelShader(tokens) : null,
                declElements: null,
                streamStride: 16,
            });
            assertAccepted(linked.wgsl, capability, shaderCase.name);
        }
    });
});

describe.skipIf(!capability.available)("recorded SM1/SM2/SM3 WGSL smoke", () => {
    test("accepts every current recorded vertex and pixel shader variant", async () => {
        const vertexCases = oracleFixtures.cases.filter(candidate => candidate.name.startsWith("vs_"));
        const pixelCases = oracleFixtures.cases.filter(candidate => candidate.name.startsWith("ps_"));
        const baseVs = compileVertexShader(await fixtureTokens("vs_1_1_skinned"));

        for (const shaderCase of vertexCases) {
            const linked = linkProgram({
                vs: compileVertexShader(await fixtureTokens(shaderCase.name)),
                ps: null,
                declElements: null,
                streamStride: 16,
            });
            assertAccepted(linked.wgsl, capability, shaderCase.name);
        }
        for (const shaderCase of pixelCases) {
            const linked = linkProgram({
                vs: baseVs,
                ps: compilePixelShader(await fixtureTokens(shaderCase.name)),
                declElements: null,
                streamStride: 16,
            });
            assertAccepted(linked.wgsl, capability, shaderCase.name);
        }
    });
});

describe.skipIf(!capability.available)("FFP WGSL smoke", () => {
    test("runs the current untextured, lit-textured, and RHW variants", async () => {
        // VertexOutput already carries the interpolated @builtin(position). Reusing it in the
        // fragment stage keeps the FFP module within WGSL's one-position-builtin rule.
        const { emitFfpShader } = await import("../../src/worker/backends/webgpu/d3d9/d3d9-device");
        const variants = [
            {
                name: "FFP untextured",
                options: {
                    inputFields: ["@location(0) pos: vec3<f32>"],
                    hasRhw: false,
                    hasTex: false,
                    lit: false,
                    colorExpr: "vec4<f32>(1.0)",
                    specularExpr: "vec4<f32>(0.0)",
                    normalExpr: "vec3<f32>(0.0, 0.0, 1.0)",
                    alphaTest: null,
                },
            },
            {
                name: "FFP lit textured",
                options: {
                    inputFields: [
                        "@location(0) pos: vec3<f32>",
                        "@location(1) normal: vec3<f32>",
                        "@location(2) color: u32",
                        "@location(3) specColor: u32",
                        "@location(4) uv: vec2<f32>",
                    ],
                    hasRhw: false,
                    hasTex: true,
                    texCoordExprs: ["vec4<f32>(input.uv, 1.0, 0.0)"],
                    stageCount: 2,
                    lit: true,
                    colorExpr: "unpackColor(input.color)",
                    specularExpr: "unpackColor(input.specColor)",
                    normalExpr: "input.normal",
                    alphaTest: null,
                },
            },
            {
                name: "FFP RHW textured",
                options: {
                    inputFields: [
                        "@location(0) pos: vec4<f32>",
                        "@location(1) color: u32",
                        "@location(2) uv: vec2<f32>",
                    ],
                    hasRhw: true,
                    hasTex: true,
                    texCoordExprs: ["vec4<f32>(input.uv, 1.0, 0.0)"],
                    lit: false,
                    colorExpr: "unpackColor(input.color)",
                    specularExpr: "vec4<f32>(0.0)",
                    normalExpr: "vec3<f32>(0.0, 0.0, 1.0)",
                    alphaTest: null,
                },
            },
        ];

        for (const variant of variants) {
            const wgsl = emitFfpShader(variant.options);
            assertAccepted(wgsl, capability, variant.name);
        }
    });
});
