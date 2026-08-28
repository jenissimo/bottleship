import { describe, expect, test } from "bun:test";
import { asmFixture, d3dxOracleAvailable } from "./helpers/asm-fixture";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import { compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { analyzeVs } from "../../src/worker/backends/webgpu/d3d9/shader/emit/vs";
import { analyzePs, emitPsMain } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

const IDENTITY = 0xe4;

function source(type: RegType, num: number, relative = false, relReg?: RegType, relSwizzle = IDENTITY): SmSource {
    return {
        reg: { type, num, relative },
        swizzle: IDENTITY,
        modifier: 0,
        ...(relative && relReg !== undefined
            ? { relReg: { type: relReg, num: 0, relative: false }, relSwizzle }
            : {}),
    };
}

function destination(type: RegType, num: number): NonNullable<SmInstruction["dst"]> {
    return {
        reg: { type, num, relative: false },
        writeMask: 0xf,
        shift: 0,
        saturate: false,
        partialPrecision: false,
        centroid: false,
    };
}

function relativeOutputVsProgram(): SmProgram {
    const position = { usage: 0, usageIndex: 0, textureType: 0, writeMask: 0xf, centroid: false };
    const color = { usage: 10, usageIndex: 0, textureType: 0, writeMask: 0xf, centroid: false };
    const dynamicOutput = destination(RegType.OUTPUT, 1);
    dynamicOutput.reg.relative = true;
    dynamicOutput.relReg = { type: RegType.LOOP, num: 0, relative: false };
    dynamicOutput.relSwizzle = IDENTITY;
    const instructions: SmInstruction[] = [
        {
            opcode: Op.LOOP, coissue: false, predicated: false, specificData: 0, dst: null,
            src: [source(RegType.LOOP, 0), source(RegType.CONSTINT, 0)],
        },
        {
            opcode: Op.MOV, coissue: false, predicated: false, specificData: 0,
            dst: dynamicOutput,
            src: [source(RegType.INPUT, 0)],
        },
        { opcode: Op.ENDLOOP, coissue: false, predicated: false, specificData: 0, dst: null, src: [] },
        {
            opcode: Op.MOV, coissue: false, predicated: false, specificData: 0,
            dst: destination(RegType.OUTPUT, 0),
            src: [source(RegType.INPUT, 0)],
        },
    ];
    return {
        isPixelShader: false,
        major: 3,
        minor: 0,
        instructions,
        declarations: [
            { ...position, reg: { type: RegType.INPUT, num: 0, relative: false } },
            { ...position, reg: { type: RegType.OUTPUT, num: 0, relative: false } },
            { ...color, reg: { type: RegType.OUTPUT, num: 1, relative: false } },
        ],
        definitions: [{
            reg: { type: RegType.CONSTINT, num: 0, relative: false },
            values: new Float32Array(new Int32Array([1, 0, 1, 0]).buffer),
            rawInt: new Int32Array([1, 0, 1, 0]),
            kind: "i",
        }],
        maxTemp: -1,
        maxConst: -1,
        maxBool: -1,
        samplersUsed: new Set(),
        inputRegs: new Set([0]),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

function relativePsProgram(): SmProgram {
    const instructions: SmInstruction[] = [
        {
            opcode: Op.LOOP, coissue: false, predicated: false, specificData: 0, dst: null,
            src: [source(RegType.LOOP, 0), source(RegType.CONSTINT, 0)],
        },
        {
            opcode: Op.MOV, coissue: false, predicated: false, specificData: 0,
            dst: destination(RegType.TEMP, 0),
            src: [source(RegType.CONST, 1, true, RegType.LOOP)],
        },
        { opcode: Op.ENDLOOP, coissue: false, predicated: false, specificData: 0, dst: null, src: [] },
        {
            opcode: Op.MOV, coissue: false, predicated: false, specificData: 0,
            dst: destination(RegType.COLOROUT, 0),
            src: [source(RegType.TEMP, 0)],
        },
    ];
    return {
        isPixelShader: true,
        major: 3,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: 0,
        maxConst: 1,
        maxBool: -1,
        samplersUsed: new Set(),
        inputRegs: new Set(),
        usesRelativeConst: true,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

describe.skipIf(!d3dxOracleAvailable())("D3D9 SM3 relative source acceptance", () => {
    test("oracle matrix-palette fixture preserves a0 component and aL per-iteration constant selection", async () => {
        const sourceText = `
            vs_3_0
            dcl_position v0
            dcl_position o0
            defi i0, 2, 0, 1, 0
            mova a0.y, v0.x
            mov r0, c[a0.y+1]
            loop aL, i0
                add r0, r0, c[aL+2]
            endloop
            mov o0, r0
        `;
        const parsed = await asmFixture(sourceText);
        const relativeSources = parsed.instructions.flatMap(instruction => instruction.src)
            .filter(source => source.reg.type === RegType.CONST && source.reg.relative);
        expect(relativeSources).toHaveLength(2);
        expect(relativeSources[0]!.relReg).toMatchObject({ type: RegType.ADDR });
        expect(relativeSources[0]!.relSwizzle).not.toBe(0xe4);
        expect(relativeSources[1]!.relReg).toMatchObject({ type: RegType.LOOP });

        const { assemble } = await import("../d3dx-oracle");
        const assembled = assemble(sourceText);
        if (!assembled.tokens) throw new Error(assembled.error ?? "oracle returned no tokens");
        const linked = linkProgram({
            vs: compileVertexShader(assembled.tokens),
            ps: null,
            declElements: [{ stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 }],
            streamStride: 12,
        });

        expect(linked.vsConstantCount).toBe(256);
        expect(linked.wgsl).toContain("var a0: vec4<i32>");
        expect(linked.wgsl).toContain("clamp(a0.y + 1, 0, 255)");
        expect(linked.wgsl).toContain("clamp(i32(select(ceil(((vec4<f32>(f32(aL))).x) - 0.5)");
    });
});

test("PS relative constant indexing keeps the parsed loop register and full register-file clamp", () => {
    const program = relativePsProgram();
    const wgsl = emitPsMain(program, analyzePs(program));

    expect(analyzePs(program).constantCount).toBe(224);
    expect(wgsl).toContain("psc.c[clamp(i32(select(ceil(((vec4<f32>(f32(aL))).x) - 0.5)");
    expect(wgsl).not.toContain("psc.c[1]");
});

test("VS3 relative output destinations route through the declared semantic register file", () => {
    const prog = relativeOutputVsProgram();
    const linked = linkProgram({
        vs: { prog, analysis: analyzeVs(prog) },
        ps: null,
        declElements: [{ stream: 0, offset: 0, type: 3, usage: 0, usageIndex: 0 }],
        streamStride: 16,
    });

    expect(linked.census.vs.unsupported).toBe(0);
    expect(linked.wgsl).toContain("var oReg: array<vec4<f32>, 16>");
    expect(linked.wgsl).toContain("oReg[clamp(i32(select(ceil(((vec4<f32>(f32(aL))).x) - 0.5)");
    expect(linked.wgsl).toContain("out.col0 = oReg[1]");
});
