import { describe, expect, test } from "bun:test";
import {
    compilePixelShader, compileVertexShader, linkProgram, type RawVertexElement,
} from "../../src/worker/backends/webgpu/d3d9/shader";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import fixtures from "./fixtures/d3d9-sm1-legacy-texture.json";

const END = 0x0000ffff;
const IDENTITY_SWIZZLE = 0xe4;

function reg(type: number, num: number): number {
    return (((type & 7) << 28) | (((type >>> 3) & 3) << 11) | num) >>> 0;
}

function dst(type: number, num: number): number {
    return (reg(type, num) | 0x000f0000) >>> 0;
}

function src(type: number, num: number): number {
    return (reg(type, num) | (IDENTITY_SWIZZLE << 16)) >>> 0;
}

function vertexShader(): Uint32Array {
    return new Uint32Array([
        0xfffe0101,
        Op.MOV, dst(RegType.RASTOUT, 0), src(RegType.INPUT, 0),
        Op.MOV, dst(RegType.TEXCRDOUT, 0), src(RegType.INPUT, 1),
        Op.MOV, dst(RegType.TEXCRDOUT, 1), src(RegType.INPUT, 2),
        Op.MOV, dst(RegType.TEXCRDOUT, 2), src(RegType.INPUT, 3),
        Op.MOV, dst(RegType.TEXCRDOUT, 3), src(RegType.INPUT, 4),
        END,
    ]);
}

const declaration: RawVertexElement[] = [
    { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 },
    { stream: 0, offset: 16, type: 3, usage: 5, usageIndex: 0 },
    { stream: 0, offset: 24, type: 3, usage: 5, usageIndex: 1 },
    { stream: 0, offset: 32, type: 3, usage: 5, usageIndex: 2 },
    { stream: 0, offset: 40, type: 3, usage: 5, usageIndex: 3 },
];

function linked(name: string) {
    const fixture = fixtures.cases.find((candidate) => candidate.name === name)!;
    const tokens = new Uint32Array(fixture.tokens.map((token) => Number(token) >>> 0));
    const ps = compilePixelShader(tokens);
    const result = linkProgram({
        vs: compileVertexShader(vertexShader()), ps,
        declElements: declaration, streamStride: 48,
    });
    return { ps, wgsl: result.wgsl, census: result.census };
}

describe("exact ps_1_x legacy texture/depth operations", () => {
    test("texdepth writes r5.x/r5.y through the fragment-depth ABI", () => {
        const { ps, wgsl, census } = linked("ps_1_4_texdepth");
        expect(ps.analysis.writesDepth).toBe(true);
        expect(wgsl).toContain("@builtin(frag_depth) depth: f32");
        expect(wgsl).toContain("oDepth = select(_legacyDepthZ");
        expect(wgsl).toContain("(r5).x");
        expect(wgsl).toContain("(r5).y");
        expect(census.ps?.unsupportedOps).toEqual([]);
    });

    test("texm3x2depth re-reads both matrix rows and writes z/w depth", () => {
        const { ps, wgsl, census } = linked("ps_1_3_texm3x2depth");
        expect(ps.analysis.writesDepth).toBe(true);
        expect(ps.analysis.readsTexcoord).toEqual(new Set([0, 1, 2]));
        expect(wgsl).toContain("dot((in.tex1).xyz, (t0).xyz)");
        expect(wgsl).toContain("dot((in.tex2).xyz, (t0).xyz)");
        expect(wgsl).toContain("@builtin(frag_depth) depth: f32");
        expect(census.ps?.unsupportedOps).toEqual([]);
    });

    test("texm3x3 stores the matrix result without sampling", () => {
        const { ps, wgsl, census } = linked("ps_1_3_texm3x3");
        expect(ps.analysis.readsTexcoord).toEqual(new Set([0, 1, 2, 3]));
        expect(wgsl).toContain("dot((in.tex1).xyz, (t0).xyz)");
        expect(wgsl).toContain("dot((in.tex3).xyz, (t0).xyz)");
        expect(wgsl).toContain("let _m3Tc");
        expect(wgsl).not.toContain("textureSample(tex3");
        expect(census.ps?.unsupportedOps).toEqual([]);
    });

    test("ps_1_4 bem applies the destination-stage matrix as arithmetic", () => {
        const { ps, wgsl, census } = linked("ps_1_4_bem");
        expect(ps.analysis.usesLegacyBumpEnv).toBe(true);
        expect(wgsl).toContain("psc.bump[3].mat.x * (r2).x");
        expect(wgsl).toContain("psc.bump[3].mat.z * (r2).y");
        expect(wgsl).toContain("psc.bump[3].mat.y * (r2).x");
        expect(wgsl).toContain("psc.bump[3].mat.w * (r2).y");
        expect(wgsl).not.toContain("* 2.0 - vec2<f32>(1.0)");
        expect(census.ps?.unsupportedOps).toEqual([]);
    });
});
