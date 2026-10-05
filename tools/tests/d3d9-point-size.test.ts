import { describe, expect, test } from "bun:test";
import { makeFvfDeclaration, D3DFVF_PSIZE, D3DFVF_XYZ } from "../../src/worker/backends/webgpu/d3d9/shader/fvf-layout";
import { compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader/link";
import { Op, RegType, Usage } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";

const MASK = 0xF;
const IDENTITY_SWIZZLE = 0xE4;
const FVF = D3DFVF_XYZ | D3DFVF_PSIZE;
const FVF_DECL = makeFvfDeclaration(FVF)!;
const MODELS = [1, 2, 3] as const;

function regBits(type: RegType, num: number): number {
    return (((type & 0x7) << 28) | (num & 0x7FF)) >>> 0;
}

function dst(type: RegType, num: number): number {
    return (regBits(type, num) | (MASK << 16)) >>> 0;
}

function src(type: RegType, num: number): number {
    return (regBits(type, num) | (IDENTITY_SWIZZLE << 16)) >>> 0;
}

function version(model: number): number {
    const minor = model === 1 ? 1 : 0;
    return ((0xFFFE << 16) | (model << 8) | minor) >>> 0;
}

function instruction(opcode: Op): number {
    return (opcode | (2 << 24)) >>> 0;
}

function dcl(usage: Usage, type: RegType, num: number): number[] {
    return [instruction(Op.DCL), usage, dst(type, num)];
}

function mov(model: number, type: RegType, num: number, sourceNum: number): number[] {
    return [model === 1 ? Op.MOV : instruction(Op.MOV), dst(type, num), src(RegType.INPUT, sourceNum)];
}

function pointSizeVs(model: number): Uint32Array {
    const setup = model === 1
        ? []
        : [
            ...dcl(Usage.POSITION, RegType.INPUT, 0),
            ...dcl(Usage.PSIZE, RegType.INPUT, 4),
        ];
    const outputs = model === 3
        ? [
            ...dcl(Usage.POSITION, RegType.OUTPUT, 0),
            ...dcl(Usage.PSIZE, RegType.OUTPUT, 6),
        ]
        : [];
    const pointOutput = model === 3
        ? [RegType.OUTPUT, 6]
        : [RegType.RASTOUT, 2];
    const positionOutput = model === 3
        ? [RegType.OUTPUT, 0]
        : [RegType.RASTOUT, 0];
    return new Uint32Array([
        version(model),
        ...setup,
        ...outputs,
        ...mov(model, pointOutput[0]!, pointOutput[1]!, 4),
        ...mov(model, positionOutput[0]!, positionOutput[1]!, 0),
        0x0000FFFF,
    ]);
}

function linkPointSize(model: number, pointExpansion: boolean) {
    return linkProgram({
        vs: compileVertexShader(pointSizeVs(model)),
        ps: null,
        declElements: FVF_DECL,
        streamStride: 16,
        pointExpansion,
    });
}

describe("D3D9 programmable point size", () => {
    for (const model of MODELS) {
        test(`vs_${model}_${model === 1 ? 1 : 0} preserves oPts through point expansion`, () => {
            const linked = linkPointSize(model, true);

            // FVF PSIZE is the legacy v4 input. This is the SM1 case that used to
            // produce an in.v4 accessor without a corresponding WGSL field.
            expect(linked.wgsl).toContain("@location(4) v4: f32");
            expect(linked.wgsl).toContain("vec4<f32>(in.v4, 0.0, 0.0, 1.0)");
            expect(linked.wgsl).toContain("@builtin(vertex_index) vertexIndex: u32");
            expect(linked.wgsl).toContain("let _pointSize = clamp(oPts[0]");
            expect(linked.wgsl).toContain("let _pointHalfSize = max(_pointSize, 0.0) * 0.5;");
            expect(linked.census.vs.unsupported).toBe(0);
            expect(linked.census.vs.unsupportedOps).toEqual([]);
        });

        test(`vs_${model}_${model === 1 ? 1 : 0} ignores oPts without point expansion`, () => {
            const linked = linkPointSize(model, false);
            expect(linked.census.vs.unsupported).toBe(0);
            expect(linked.census.vs.approximatedOps).toContain("oPts");
            expect(linked.census.vs.approximated).toBe(1);
        });
    }
});
