import { describe, expect, test } from "bun:test";
import { Emitter } from "../../src/worker/backends/webgpu/d3d9/shader/emitter";
import { emitTexOp, emitTextureSample } from "../../src/worker/backends/webgpu/d3d9/shader/emit/tex";
import { analyzePs, emitPsMain } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { emitBindLayout } from "../../src/worker/backends/webgpu/d3d9/shader/link/bind-layout";
import { PROG_BIND } from "../../src/worker/backends/webgpu/d3d9/shader/link";
import { arenaSupportsFragmentSamplerBank } from "../../src/worker/backends/webgpu/d3d9/d3d9-wasm-arena";
import { Census } from "../../src/worker/backends/webgpu/d3d9/shader/census";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { PsAnalysis } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import type { ShaderCtx } from "../../src/worker/backends/webgpu/d3d9/shader/emit/expr";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

const IDENTITY = 0xe4;

function source(type: RegType, num: number, swizzle = IDENTITY): SmSource {
    return { reg: { type, num, relative: false }, swizzle, modifier: 0 };
}

function destination(num: number): NonNullable<SmInstruction["dst"]> {
    return {
        reg: { type: RegType.TEMP, num, relative: false },
        writeMask: 0xf,
        shift: 0,
        saturate: false,
        partialPrecision: false,
        centroid: false,
    };
}

function pixelProgram(instructions: SmInstruction[]): SmProgram {
    return {
        isPixelShader: true,
        major: 3,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: 3,
        maxConst: -1,
        maxBool: -1,
        samplersUsed: new Set([0, 1]),
        inputRegs: new Set([0, 1]),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

function instruction(opcode: Op, src: SmSource[], dst: SmInstruction["dst"]): SmInstruction {
    return { opcode, coissue: false, predicated: false, specificData: 0, dst, src };
}

function ctx(): ShaderCtx {
    return {
        isPs: true,
        major: 3,
        minor: 0,
        readReg(reg) {
            if (reg.type === RegType.INPUT) return `in.tex${reg.num}`;
            if (reg.type === RegType.TEMP) return `r${reg.num}`;
            return "vec4<f32>(0.0)";
        },
        writeRegName(reg) { return reg.type === RegType.TEMP ? `r${reg.num}` : null; },
    };
}

function analysis(): PsAnalysis {
    return {
        constantCount: 0,
        readsColor: [false, false],
        readsTexcoord: new Set([0, 1]),
        samplers: new Set([0, 1]),
        samplerTexType: new Map(),
        defConsts: new Map(),
        defInts: new Map(),
        defBools: new Map(),
        maxTemp: 3,
        isPs14: false,
        samplesTexture: true,
        usesLegacyBumpEnv: false,
        inputBindings: new Map(),
        readsVPos: false,
        readsVFace: false,
        writesDepth: false,
    };
}

describe("D3D9 SM3 texture instructions", () => {
    test("lowers texldl/texldd and dsx/dsy without unsupported markers", () => {
        const coord = source(RegType.INPUT, 0);
        const sampler0 = source(RegType.SAMPLER, 0, 0x00); // sample result xxxx swizzle
        const sampler1 = source(RegType.SAMPLER, 1);
        const program = pixelProgram([
            instruction(Op.TEXLDL, [coord, sampler0], destination(0)),
            instruction(Op.TEXLDD, [coord, sampler1, source(RegType.INPUT, 1), source(RegType.INPUT, 1)], destination(1)),
            instruction(Op.DSX, [coord], destination(2)),
            instruction(Op.DSY, [coord], destination(3)),
        ]);

        const census = new Census();
        const wgsl = emitPsMain(program, analyzePs(program), null, 0, 0, null, census);
        expect(wgsl).toContain("textureSampleLevel(tex0, samp, (in.tex0).xy, (in.tex0).w)");
        expect(wgsl).toContain("textureSampleGrad(tex1, samp1, (in.tex0).xy, (in.tex1).xy, (in.tex1).xy)");
        expect(wgsl).toContain("dpdx(in.tex0)");
        expect(wgsl).toContain("dpdy(in.tex0)");
        expect(wgsl).toContain("textureSampleLevel(tex0, samp, (in.tex0).xy, (in.tex0).w)).xxxx");
        expect(census.summary().unsupportedOps).toEqual([]);
    });

    test("emits independent programmable sampler bindings per PS stage", () => {
        const emitter = new Emitter();
        emitBindLayout(emitter, {
            hasTexture: true,
            fragSamplers: [0, 1],
            cubeMask: 0,
            programmablePixel: true,
            samplerBinding: 2,
            textureBase: 3,
            hybridSamplerBase: PROG_BIND.FRAGMENT_SAMPLER_BASE,
        });
        expect(emitter.toString()).toContain("@binding(2) var samp: sampler;");
        expect(emitter.toString()).toContain("@binding(19) var samp1: sampler;");
        expect(emitter.toString()).not.toContain("@binding(19) var samp: sampler;");
    });

    test("allocates non-overlapping bindings for the complete s0..s15 bank", () => {
        const emitter = new Emitter();
        emitBindLayout(emitter, {
            hasTexture: true,
            fragSamplers: Array.from({ length: 16 }, (_, stage) => stage),
            cubeMask: 1 << 15,
            programmablePixel: true,
            samplerBinding: PROG_BIND.SAMPLER,
            textureBase: PROG_BIND.TEX_BASE,
            hybridSamplerBase: PROG_BIND.FRAGMENT_SAMPLER_BASE,
        });
        const wgsl = emitter.toString();
        const bindings = [...wgsl.matchAll(/@binding\((\d+)\)/g)].map(match => Number(match[1]));
        expect(new Set(bindings).size).toBe(bindings.length);
        expect(wgsl).toContain("@binding(18) var tex15: texture_cube<f32>;");
        expect(wgsl).toContain("@binding(33) var samp15: sampler;");
        expect(wgsl).toContain("@binding(34) var vtex0: texture_2d<f32>;");
        expect(wgsl).toContain("@binding(41) var vsamp3: sampler;");
        expect(bindings.filter(binding => binding === 2 || (binding >= 19 && binding <= 33))).toHaveLength(16);
    });

    test("routes any high fragment-stage draw away from the eight-stage arena ABI", () => {
        expect(arenaSupportsFragmentSamplerBank([0, 7], () => false)).toBe(true);
        expect(arenaSupportsFragmentSamplerBank([0, 15], () => false)).toBe(false);
        expect(arenaSupportsFragmentSamplerBank([0], stage => stage === 12)).toBe(false);
    });

    test("lowers a 2D depth sample to comparison WGSL with D3D9 Dref policy", () => {
        const coord = source(RegType.INPUT, 0);
        const sampler = source(RegType.SAMPLER, 0);
        const instructionToEmit = instruction(Op.TEX, [coord, sampler], destination(0));
        const emitter = new Emitter();
        emitTexOp(
            instructionToEmit,
            pixelProgram([instructionToEmit]),
            analysis(),
            ctx(),
            emitter,
            0,
            0,
            0,
            new Map(),
            { comparisonSamplers: new Map([[0, { drefScaleShift: 24, clampDref: true }]]) },
        );

        const wgsl = emitter.toString();
        expect(wgsl).toContain("textureSampleCompare(tex0, samp, (_tc0).xy");
        expect(wgsl).toContain("1.0 / 16777215.0");
        expect(wgsl).toContain("clamp(");
        expect(wgsl).not.toContain("textureSample(tex0");
        expect(wgsl).not.toContain("texture_2d<f32>");
    });

    test("binds only comparison stages as depth texture/comparison sampler", () => {
        const emitter = new Emitter();
        emitBindLayout(emitter, {
            hasTexture: true,
            fragSamplers: [0, 1],
            cubeMask: 0,
            comparisonMask: 1,
            programmablePixel: true,
            samplerBinding: 2,
            textureBase: 3,
            hybridSamplerBase: PROG_BIND.FRAGMENT_SAMPLER_BASE,
        });
        const wgsl = emitter.toString();
        expect(wgsl).toContain("@binding(2) var samp: sampler_comparison;");
        expect(wgsl).toContain("@binding(3) var tex0: texture_depth_2d;");
        expect(wgsl).toContain("@binding(19) var samp1: sampler;");
        expect(wgsl).toContain("@binding(4) var tex1: texture_2d<f32>;");
    });

    test("comparison sample seam keeps the ordinary colour spelling", () => {
        expect(emitTextureSample({ stage: 0, coordinate: "uv" }))
            .toBe("textureSample(tex0, samp, uv)");
        expect(emitTextureSample({
            stage: 0,
            coordinate: "uv",
            depthCoordinate: "coord",
            comparison: true,
            clampDref: true,
        })).toBe("vec4<f32>(textureSampleCompare(tex0, samp, uv, clamp(((coord).z), 0.0, 1.0)))");
    });

    test("folds texldb's dynamic bias into explicit gradients", () => {
        const sample = emitTextureSample({
            stage: 0,
            coordinate: "uv",
            mode: "grad",
            bias: "coord.w",
        });
        expect(sample).toContain("exp2(coord.w)");
        expect(sample).toContain("textureSampleGrad(tex0, samp, uv");
    });

    test("comparison texldl supplies the explicit level required by WGSL", () => {
        const coord = source(RegType.INPUT, 0);
        const sampler = source(RegType.SAMPLER, 0);
        const instructionToEmit = instruction(Op.TEXLDL, [coord, sampler], destination(0));
        const emitter = new Emitter();
        emitTexOp(
            instructionToEmit,
            pixelProgram([instructionToEmit]),
            analysis(),
            ctx(),
            emitter,
            0,
            0,
            0,
            new Map(),
            { comparisonSamplers: new Map([[0, { clampDref: true }]]) },
        );
        const wgsl = emitter.toString();
        expect(wgsl).toContain("textureSampleCompareLevel(tex0, samp, (in.tex0).xy, clamp(((in.tex0).z), 0.0, 1.0), (in.tex0).w)");
        expect(wgsl).not.toContain("textureSampleCompareLevel(tex0, samp, (in.tex0).xy, clamp(((in.tex0).z), 0.0, 1.0))");
    });

    test("keeps the direct emitTexOp seam usable by stage emitters", () => {
        const emitter = new Emitter();
        const instructionToEmit = instruction(Op.DSX, [source(RegType.INPUT, 0)], destination(0));
        expect(emitTexOp(
            instructionToEmit,
            pixelProgram([instructionToEmit]),
            analysis(),
            ctx(),
            emitter,
            0,
            0,
            0,
            new Map(),
        )).toBe(true);
        expect(emitter.toString()).toContain("dpdx(in.tex0)");
    });
});
