import { describe, expect, test } from "bun:test";
import { Emitter } from "../../src/worker/backends/webgpu/d3d9/shader/emitter";
import { analyzePs, emitPsMain } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { analyzeVs, emitVsMain } from "../../src/worker/backends/webgpu/d3d9/shader/emit/vs";
import { emitBindLayout } from "../../src/worker/backends/webgpu/d3d9/shader/link/bind-layout";
import { Op, RegType, TexType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import { PROG_BIND } from "../../src/worker/backends/webgpu/d3d9/shader/link";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

const IDENTITY = 0xe4;

function source(type: RegType, num: number, swizzle = IDENTITY): SmSource {
    return { reg: { type, num, relative: false }, swizzle, modifier: 0 };
}

function destination(type: RegType, num: number): NonNullable<SmInstruction["dst"]> {
    return {
        reg: { type, num, relative: false }, writeMask: 0xf, shift: 0,
        saturate: false, partialPrecision: false, centroid: false,
    };
}

function instruction(opcode: Op, src: SmSource[], dst: SmInstruction["dst"]): SmInstruction {
    return { opcode, coissue: false, predicated: false, specificData: 0, dst, src };
}

function program(isPixelShader: boolean, instructions: SmInstruction[], sampler = 0): SmProgram {
    return {
        isPixelShader,
        major: 3,
        minor: 0,
        instructions,
        declarations: [{
            usage: 0, usageIndex: 0, textureType: TexType.VOLUME,
            reg: { type: RegType.SAMPLER, num: sampler, relative: false },
            writeMask: 0xf, centroid: false,
        }],
        definitions: [],
        maxTemp: 1,
        maxConst: -1,
        maxBool: -1,
        samplersUsed: new Set([sampler]),
        inputRegs: new Set([0]),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

describe("D3D9 programmable volume texture lowering", () => {
    test("bind layout uses texture_3d for a declared pixel volume sampler", () => {
        const emitter = new Emitter();
        emitBindLayout(emitter, {
            hasTexture: true,
            fragSamplers: [0],
            cubeMask: 0,
            volumeMask: 1,
            programmablePixel: true,
            samplerBinding: PROG_BIND.SAMPLER,
            textureBase: PROG_BIND.TEX_BASE,
            hybridSamplerBase: PROG_BIND.FRAGMENT_SAMPLER_BASE,
        });
        expect(emitter.toString()).toContain("@binding(3) var tex0: texture_3d<f32>;");
        expect(emitter.toString()).not.toContain("@binding(3) var tex0: texture_2d<f32>");

        const vertexEmitter = new Emitter();
        emitBindLayout(vertexEmitter, {
            hasTexture: false,
            fragSamplers: [],
            cubeMask: 0,
            vertexVolumeMask: 1,
            programmablePixel: true,
            samplerBinding: PROG_BIND.SAMPLER,
            textureBase: PROG_BIND.TEX_BASE,
            hybridSamplerBase: PROG_BIND.FRAGMENT_SAMPLER_BASE,
        });
        expect(vertexEmitter.toString()).toContain("@binding(34) var vtex0: texture_3d<f32>;");
        expect(vertexEmitter.toString()).toContain("@binding(35) var vtex1: texture_2d<f32>;");
    });

    test("texld samples xyz coordinates for a volume declaration", () => {
        const ps = program(true, [
            instruction(Op.TEX, [source(RegType.INPUT, 0), source(RegType.SAMPLER, 0)], destination(RegType.TEMP, 0)),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.COLOROUT, 0)),
        ]);
        const wgsl = emitPsMain(ps, analyzePs(ps), null, 0, 0, null, null, undefined, 1);
        expect(wgsl).toContain("textureSample(tex0, samp, (_tc0).xyz)");
        expect(wgsl).not.toContain("textureSample(tex0, samp, (_tc0).xy)");
    });

    test("vertex texldl samples xyz coordinates for a volume declaration", () => {
        const vs = program(false, [
            instruction(Op.TEXLDL, [source(RegType.INPUT, 0), source(RegType.SAMPLER, 0)], destination(RegType.TEMP, 0)),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.ATTROUT, 0)),
        ]);
        const wgsl = emitVsMain(vs, analyzeVs(vs), {
            interpColors: [true, false],
            interpTexcoords: [],
            inputExprs: new Map(),
            constantCount: 0,
            pixelCentreSlot: 0,
            volumeMask: 1,
        });
        expect(wgsl).toContain("textureSampleLevel(vtex0, vsamp0, (vec4<f32>(in.v0)).xyz");
        expect(wgsl).not.toContain("textureSampleLevel(vtex0, vsamp0, (vec4<f32>(in.v0)).xy,");
    });
});
