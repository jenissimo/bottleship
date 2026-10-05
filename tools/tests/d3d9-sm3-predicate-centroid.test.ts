/** Focused W14 acceptance: SETP/predicated stores, !p0, and centroid linkage. */
import { describe, expect, test } from "bun:test";
import { compilePixelShader, compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { emitVsMain, analyzeVs } from "../../src/worker/backends/webgpu/d3d9/shader/emit/vs";
import { emitPsMain, analyzePs } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { Census } from "../../src/worker/backends/webgpu/d3d9/shader/census";
import { Op, RegType, SrcMod, Usage } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

const IDENTITY_SWIZZLE = 0xE4;
const END = 0x0000FFFF;

function source(type: RegType, num: number, modifier = 0, swizzle = IDENTITY_SWIZZLE): SmSource {
    return { reg: { type, num, relative: false }, swizzle, modifier };
}

function destination(type: RegType, num: number, writeMask = 0xF): NonNullable<SmInstruction["dst"]> {
    return {
        reg: { type, num, relative: false },
        writeMask,
        shift: 0,
        saturate: false,
        partialPrecision: false,
        centroid: false,
    };
}

function swizzle(x: number, y: number, z: number, w: number): number {
    return x | (y << 2) | (z << 4) | (w << 6);
}

function pixelProgram(instructions: SmInstruction[]): SmProgram {
    return { ...vertexProgram(instructions), isPixelShader: true };
}

function instruction(
    opcode: Op,
    src: SmSource[],
    dst: SmInstruction["dst"],
    comparison?: SmInstruction["comparison"],
    predicated = false,
    predicate?: SmSource,
): SmInstruction {
    return { opcode, coissue: false, predicated, specificData: 0, comparison, predicate, dst, src };
}

function vertexProgram(instructions: SmInstruction[]): SmProgram {
    return {
        isPixelShader: false,
        major: 3,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: 3,
        maxConst: -1,
        maxBool: -1,
        samplersUsed: new Set(),
        inputRegs: new Set(),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

function regBits(type: number, num: number): number {
    return (((type & 7) << 28) | (((type >>> 3) & 3) << 11) | (num & 0x7FF)) >>> 0;
}

function instrToken(opcode: number, operandCount: number): number {
    return (opcode | (operandCount << 24)) >>> 0;
}

function dstToken(type: number, num: number, mask = 0xF, centroid = false): number {
    return (regBits(type, num) | (mask << 16) | (centroid ? (1 << 22) : 0)) >>> 0;
}

function srcToken(type: number, num: number, swizzle = IDENTITY_SWIZZLE): number {
    return (regBits(type, num) | (swizzle << 16)) >>> 0;
}

function dclToken(usage: number, usageIndex: number, type: number, num: number, centroid = false): number[] {
    return [
        instrToken(Op.DCL, 2),
        (usage | (usageIndex << 16)) >>> 0,
        dstToken(type, num, 0xF, centroid),
    ];
}

describe("D3D9 SM3 W14 predicate and centroid seams", () => {
    test("lowers setp_gt lane-wise and predicates each destination channel", () => {
        const p = source(RegType.PREDICATE, 0);
        const program = vertexProgram([
            instruction(Op.SETP, [source(RegType.TEMP, 0), source(RegType.TEMP, 1)], destination(RegType.PREDICATE, 0, 0x3), "gt"),
            instruction(Op.MAD, [source(RegType.TEMP, 1), source(RegType.TEMP, 2), source(RegType.TEMP, 3)], destination(RegType.TEMP, 0), undefined, true, p),
        ]);
        const census = new Census();
        const wgsl = emitVsMain(program, analyzeVs(program), {
            interpColors: [false, false],
            interpTexcoords: [],
            inputExprs: new Map(),
            constantCount: 0,
            pixelCentreSlot: 0,
            census,
        });

        expect(wgsl).toContain("// setp_gt");
        expect(wgsl).toContain("var p0: vec4<bool> = vec4<bool>(false);");
        expect(wgsl).toContain("let _setp");
        expect(wgsl).toContain("((vec4<f32>(r0)) > (vec4<f32>(r1)))");
        expect(wgsl).toContain("p0 = vec4<bool>(_setp");
        expect(wgsl).toContain("p0[2], p0[3]);");
        expect(wgsl).not.toMatch(/p0\.[xyzw]\s*=/);
        expect(wgsl).toContain("select(r0[0], _st");
        expect(wgsl).toContain(", (vec4<bool>(p0))[0])");
        expect(wgsl).toContain(", (vec4<bool>(p0))[1])");
        expect(census.summary().unsupportedOps).toEqual([]);
    });

    test("applies predicate swizzles and ! per destination lane", () => {
        const program = vertexProgram([
            instruction(Op.MOV, [source(RegType.TEMP, 1)], destination(RegType.TEMP, 0, 0x3), undefined, true,
                source(RegType.PREDICATE, 0, SrcMod.NOT, swizzle(1, 0, 3, 2))),
        ]);
        const wgsl = emitVsMain(program, analyzeVs(program), {
            interpColors: [false, false],
            interpTexcoords: [],
            inputExprs: new Map(),
            constantCount: 0,
            pixelCentreSlot: 0,
        });

        expect(wgsl).toContain("r0 = vec4<f32>(select(r0[0], _st");
        expect(wgsl).toContain(", (!(vec4<bool>(p0).yxwz))[0])");
        expect(wgsl).toContain(", (!(vec4<bool>(p0).yxwz))[1])");
        expect(wgsl).not.toMatch(/r0\.[xyzw]\s*=/);
    });

    test("uses the destination x predicate lane for depth and lane-wise predicates for texkill", () => {
        const depthProgram = pixelProgram([
            instruction(Op.MOV, [source(RegType.TEMP, 1)], destination(RegType.DEPTHOUT, 0, 0x1), undefined, true,
                source(RegType.PREDICATE, 0, 0, swizzle(1, 1, 1, 1))),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.COLOROUT, 0)),
        ]);
        const depthWgsl = emitPsMain(depthProgram, analyzePs(depthProgram));
        expect(depthWgsl).toContain("select(oDepth,");
        expect(depthWgsl).toContain(", (vec4<bool>(p0).yyyy)[0])");

        const killProgram = pixelProgram([
            instruction(Op.TEXKILL, [], destination(RegType.TEMP, 0, 0x3), undefined, true,
                source(RegType.PREDICATE, 0)),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.COLOROUT, 0)),
        ]);
        const killWgsl = emitPsMain(killProgram, analyzePs(killProgram));
        expect(killWgsl).toContain("(vec4<bool>(p0))[0] && ((r0)[0] < 0.0)");
        expect(killWgsl).toContain("(vec4<bool>(p0))[1] && ((r0)[1] < 0.0)");
        expect(killWgsl).not.toContain("(vec4<bool>(p0))[2] &&");
    });

    test("decodes dcl_centroid and emits a valid centroid fragment input qualifier", () => {
        const vsTokens = new Uint32Array([
            0xFFFE0300,
            ...dclToken(Usage.POSITION, 0, RegType.INPUT, 0),
            ...dclToken(Usage.TEXCOORD, 0, RegType.INPUT, 1),
            ...dclToken(Usage.POSITION, 0, RegType.OUTPUT, 0),
            ...dclToken(Usage.TEXCOORD, 0, RegType.OUTPUT, 1),
            instrToken(Op.MOV, 2), dstToken(RegType.OUTPUT, 0), srcToken(RegType.INPUT, 0),
            instrToken(Op.MOV, 2), dstToken(RegType.OUTPUT, 1), srcToken(RegType.INPUT, 1),
            END,
        ]);
        const psTokens = new Uint32Array([
            0xFFFF0300,
            ...dclToken(Usage.TEXCOORD, 0, RegType.INPUT, 0, true),
            instrToken(Op.MOV, 2), dstToken(RegType.COLOROUT, 0), srcToken(RegType.INPUT, 0),
            END,
        ]);
        const result = linkProgram({
            vs: compileVertexShader(vsTokens),
            ps: compilePixelShader(psTokens),
            declElements: [
                { stream: 0, offset: 0, type: 2, usage: Usage.POSITION, usageIndex: 0 },
                { stream: 0, offset: 12, type: 3, usage: Usage.TEXCOORD, usageIndex: 0 },
            ],
            streamStride: 28,
        });

        expect(result.wgsl).toContain("@location(2) @interpolate(perspective, centroid) tex0: vec4<f32>");
        const structs = result.wgsl.slice(result.wgsl.indexOf("struct Interp {"), result.wgsl.indexOf("@vertex"));
        expect(structs).toMatchSnapshot();
    });
});
