import { describe, expect, test } from "bun:test";
import { asmFixture, d3dxOracleAvailable } from "./helpers/asm-fixture";
import fixtures from "./fixtures/d3d9-sm3-parser.json";
import { parseShader, ShaderParseError, type SmInstruction, type SmProgram } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import { compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader/index";
import { Op, RegType, Usage } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";

interface ParserFixture {
    name: string;
    source: string;
    tokens: string[];
}

const cases = fixtures.cases as ParserFixture[];

function programFor(name: string): SmProgram {
    const fixture = cases.find((candidate) => candidate.name === name);
    if (!fixture) throw new Error(`parser fixture '${name}' is missing`);
    return parseShader(new Uint32Array(fixture.tokens.map((token) => Number(token) >>> 0)));
}

function instructionFor(program: SmProgram, opcode: Op): SmInstruction {
    const instruction = program.instructions.find((candidate) => candidate.opcode === opcode);
    if (!instruction) throw new Error(`opcode ${opcode} is missing from parser fixture`);
    return instruction;
}

function decodedInstructions(program: SmProgram): unknown[] {
    return program.instructions.map((instruction) => ({
        opcode: instruction.opcode,
        predicated: instruction.predicated,
        specificData: instruction.specificData,
        comparison: instruction.comparison,
        predicate: instruction.predicate && [
            instruction.predicate.reg.type,
            instruction.predicate.reg.num,
            instruction.predicate.swizzle,
            instruction.predicate.modifier,
        ],
        dst: instruction.dst && {
            reg: [instruction.dst.reg.type, instruction.dst.reg.num, instruction.dst.reg.relative],
            writeMask: instruction.dst.writeMask,
            shift: instruction.dst.shift,
            saturate: instruction.dst.saturate,
            relReg: instruction.dst.relReg && [instruction.dst.relReg.type, instruction.dst.relReg.num],
            relSwizzle: instruction.dst.relSwizzle,
        },
        src: instruction.src.map((source) => [
            source.reg.type,
            source.reg.num,
            source.reg.relative,
            source.swizzle,
            source.modifier,
            source.relReg && [source.relReg.type, source.relReg.num],
            source.relSwizzle,
        ]),
    }));
}

describe("SM3 parser operand order", () => {
    test("consumes the predicate between dst and the three mad sources", () => {
        const instruction = instructionFor(programFor("vs_3_0_predicated_mad"), Op.MAD);

        expect(instruction.predicated).toBe(true);
        expect(instruction.predicate).toMatchObject({
            reg: { type: RegType.PREDICATE, num: 0, relative: false },
        });
        expect(instruction.src).toHaveLength(3);
        expect(instruction.src.map((source) => [source.reg.type, source.reg.num])).toEqual([
            [RegType.TEMP, 1], [RegType.TEMP, 2], [RegType.TEMP, 3],
        ]);
    });

    test("consumes the SM3 dst-relative token before walking sources", () => {
        const instruction = instructionFor(programFor("vs_3_0_destination_relative_output"), Op.MOV);
        const destination = instruction.dst!;

        expect(destination.reg).toMatchObject({ type: RegType.OUTPUT, num: 1, relative: true });
        expect(destination.relReg).toMatchObject({ type: RegType.LOOP, num: 0, relative: false });
        expect(destination.relSwizzle).toBe(0xE4);
        expect(instruction.src).toHaveLength(1);
        expect(instruction.src[0].reg).toMatchObject({ type: RegType.TEMP, num: 0 });
    });

    test("exposes typed comparisons while preserving raw specificData", () => {
        const program = programFor("vs_3_0_typed_comparisons");
        const comparisons = program.instructions.filter((instruction) =>
            instruction.opcode === Op.IFC || instruction.opcode === Op.BREAKC || instruction.opcode === Op.SETP);

        expect(comparisons.map((instruction) => instruction.comparison)).toEqual(["gt", "lt", "gt"]);
        expect(comparisons.map((instruction) => instruction.specificData)).toEqual([1, 4, 1]);
    });
});

describe("SM shader token-buffer validation", () => {
    test("rejects unknown SM3 opcodes before code generation", () => {
        const unknown = (0x1234 | (2 << 24)) >>> 0;
        expect(() => compileVertexShader(new Uint32Array([
            0xfffe0300, unknown, 0, 0, 0x0000FFFF,
        ]))).toThrow(/unknown shader opcode/);
    });

    test("rejects a forged length nibble that omits a required source", () => {
        const movWithoutSource = (Op.MOV | (1 << 24)) >>> 0;
        expect(() => compileVertexShader(new Uint32Array([
            0xfffe0300, movWithoutSource, 0, 0x0000FFFF,
        ]))).toThrow(/mov supplied 0 source operands; expected 1/);
    });

    test("rejects pixel outputs outside the D3D9 MRT range", () => {
        const mov = (Op.MOV | (2 << 24)) >>> 0;
        const color4 = 0x80000000 | (1 << 11) | (0xF << 16) | 4;
        const temp0 = (RegType.TEMP << 28) | (0xE4 << 16);
        expect(() => parseShader(new Uint32Array([
            0xffff0300, mov, color4 >>> 0, temp0 >>> 0, 0x0000FFFF,
        ]))).toThrow(/outside the D3D9 MRT range/);
    });

    test("records VS oPts as an explicit approximation on ordinary non-point links", () => {
        const mov = (Op.MOV | (2 << 24)) >>> 0;
        const oPts = (4 << 28) | (0xF << 16) | 2;
        const v0 = (1 << 28) | (0xE4 << 16);
        const vs = compileVertexShader(new Uint32Array([
            0xfffe0300, mov, oPts >>> 0, v0 >>> 0, 0x0000FFFF,
        ]));
        const linked = linkProgram({ vs, ps: null, declElements: null, streamStride: null });
        expect(linked.census.vs.unsupported).toBe(0);
        expect(linked.census.vs.approximatedOps).toContain("oPts");
        expect(linked.census.vs.approximated).toBe(1);
    });

    test("links VS oPts through the six-corner programmable point lowering", () => {
        const mov = (Op.MOV | (2 << 24)) >>> 0;
        const oPts = (4 << 28) | (0xF << 16) | 2;
        const oPos = (4 << 28) | (0xF << 16) | 0;
        const v0 = (1 << 28) | (0xE4 << 16);
        const vs = compileVertexShader(new Uint32Array([
            0xfffe0300, mov, oPts >>> 0, v0 >>> 0,
            mov, oPos >>> 0, v0 >>> 0, 0x0000FFFF,
        ]));
        const linked = linkProgram({
            vs, ps: null, declElements: null, streamStride: 16, pointExpansion: true,
        });
        expect(linked.wgsl).toContain("@builtin(vertex_index) vertexIndex: u32");
        expect(linked.wgsl).toContain("let _pointHalfSize = max(_pointSize, 0.0) * 0.5;");
        expect(linked.wgsl).toContain("array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0)");
        expect(linked.census.vs.unsupportedOps).not.toContain("oPts");
    });

    test("lowers programmable point-sprite texture coordinates from the corner index", () => {
        const mov = (Op.MOV | (2 << 24)) >>> 0;
        const oPts = (4 << 28) | (0xF << 16) | 2;
        const oPos = (4 << 28) | (0xF << 16) | 0;
        const oT0 = (6 << 28) | (0xF << 16) | 0;
        const v0 = (1 << 28) | (0xE4 << 16);
        const vs = compileVertexShader(new Uint32Array([
            0xfffe0300,
            (Op.DCL | (2 << 24)) >>> 0, Usage.TEXCOORD,
            (6 << 28) | (0xF << 16) | 0,
            mov, oPts >>> 0, v0 >>> 0,
            mov, oPos >>> 0, v0 >>> 0,
            mov, oT0 >>> 0, v0 >>> 0,
            0x0000FFFF,
        ]));
        const linked = linkProgram({
            vs, ps: null, declElements: null, streamStride: 16,
            pointExpansion: true, pointSpriteEnable: true,
        });
        expect(linked.wgsl).toContain("select(1.0, 0.0");
        expect(linked.wgsl).toContain("_pointCorner == 3u");
    });

    test("rejects a declared operand block that extends past the buffer", () => {
        const fixture = cases.find((candidate) => candidate.name === "vs_3_0_predicated_mad")!;
        const truncated = new Uint32Array(fixture.tokens.slice(0, -2).map((token) => Number(token) >>> 0));

        expect(() => parseShader(truncated)).toThrow(ShaderParseError);
        expect(() => parseShader(truncated)).toThrow(/extends past the shader buffer/);
    });

    test("rejects a comment whose payload is truncated", () => {
        const version = 0xfffe0300;
        const commentWithTwoDwords = (0xFFFE | (2 << 16)) >>> 0;
        expect(() => parseShader(new Uint32Array([
            version,
            commentWithTwoDwords,
            0x42415443,
        ]))).toThrow(/comment payload/);
    });

    test("rejects fixed-layout declarations with a forged operand length", () => {
        const version = 0xfffe0300;
        const dclWithOneOperand = (Op.DCL | (1 << 24)) >>> 0;
        expect(() => parseShader(new Uint32Array([
            version,
            dclWithOneOperand,
            0,
            0,
            0x0000FFFF,
        ]))).toThrow(/expected 2/);
    });

    test("keeps parse termination visible but refuses compilation without END", () => {
        const fixture = cases.find((candidate) => candidate.name === "vs_3_0_predicated_mad")!;
        const unterminated = new Uint32Array(fixture.tokens.slice(0, -1).map((token) => Number(token) >>> 0));
        expect(parseShader(unterminated).terminated).toBe(false);
        expect(() => compileVertexShader(unterminated)).toThrow(/Unterminated vertex shader bytecode/);
    });
});

describe.skipIf(!d3dxOracleAvailable())("SM3 parser oracle fixtures", () => {
    test("asmFixture parses the same operand shapes from the real d3dx9 stream", async () => {
        for (const fixture of cases) {
            const oracleProgram = await asmFixture(fixture.source);
            const recordedProgram = programFor(fixture.name);
            expect(oracleProgram.tokenCount, fixture.name).toBe(recordedProgram.tokenCount);
            expect(decodedInstructions(oracleProgram), fixture.name).toEqual(decodedInstructions(recordedProgram));
        }
    });
});

/**
 * SINCOS and SGN carry two extra scratch/constant sources in SM2 and only one in
 * SM3, so their arity is a property of the shader model, not of the opcode.
 * Token streams below are verbatim d3dx9 (fxc) output — see the oracle
 * cross-check at the end of this block.
 */
describe("SM2 sincos/sgn operand arity", () => {
    const tokensOf = (words: string[]) => new Uint32Array(words.map(word => Number(word) >>> 0));

    const VS_2_0_SINCOS = [
        "0xfffe0200", "0x05000051", "0xa00f0001", "0xb9473abd", "0xbab630a9", "0x3c087a8d",
        "0x3caaa3ad", "0x05000051", "0xa00f0002", "0xbe2aa8eb", "0x3f000000", "0x3f800000",
        "0x3f000000", "0x0200001f", "0x80000000", "0x900f0000", "0x04000025", "0x80030001",
        "0x90000000", "0xa0e40001", "0xa0e40002", "0x02000001", "0xc00f0000", "0x80e40001",
        "0x0000ffff",
    ];
    const VS_2_0_SGN = [
        "0xfffe0200", "0x0200001f", "0x80000000", "0x900f0000", "0x04000022", "0x800f0000",
        "0x90e40000", "0x80e40001", "0x80e40002", "0x02000001", "0xc00f0000", "0x80e40000",
        "0x0000ffff",
    ];
    const PS_2_0_SINCOS = [
        "0xffff0200", "0x05000051", "0xa00f0001", "0xb9473abd", "0xbab630a9", "0x3c087a8d",
        "0x3caaa3ad", "0x05000051", "0xa00f0002", "0xbe2aa8eb", "0x3f000000", "0x3f800000",
        "0x3f000000", "0x0200001f", "0x80000000", "0xb00f0000", "0x04000025", "0x80030001",
        "0xb0000000", "0xa0e40001", "0xa0e40002", "0x02000001", "0x800f0000", "0x80000001",
        "0x02000001", "0x800f0800", "0x80e40000", "0x0000ffff",
    ];
    const VS_3_0_SINCOS = [
        "0xfffe0300", "0x0200001f", "0x80000000", "0x900f0000", "0x0200001f", "0x80000000",
        "0xe00f0000", "0x02000025", "0x80030001", "0x90000000", "0x02000001", "0xe00f0000",
        "0x80e40001", "0x0000ffff",
    ];

    test("accepts the three-source SM2 forms and the one-source SM3 form", () => {
        for (const [name, words, opcode] of [
            ["vs_2_0 sincos", VS_2_0_SINCOS, Op.SINCOS],
            ["vs_2_0 sgn", VS_2_0_SGN, Op.SGN],
            ["ps_2_0 sincos", PS_2_0_SINCOS, Op.SINCOS],
        ] as const) {
            const program = parseShader(tokensOf(words));
            expect(instructionFor(program, opcode).src, name).toHaveLength(3);
        }
        const sm3 = parseShader(tokensOf(VS_3_0_SINCOS));
        expect(instructionFor(sm3, Op.SINCOS).src).toHaveLength(1);
    });

    test("links a vs_2_0 sincos instead of failing shader creation", () => {
        const linked = linkProgram({
            vs: compileVertexShader(tokensOf(VS_2_0_SINCOS)),
            ps: null,
            declElements: null,
            streamStride: 16,
        });
        expect(linked.wgsl).toContain("cos(");
        expect(linked.census.vs.unsupportedOps).toEqual([]);
    });

    test("still rejects a source count the shader model does not have", () => {
        // The same vs_2_0 sincos with the length nibble forged down to one source.
        const forged = tokensOf(VS_2_0_SINCOS);
        forged[16] = (Op.SINCOS | (2 << 24)) >>> 0;
        expect(() => parseShader(forged)).toThrow(/sincos supplied 1 source operand; expected 3/);

        // And an SM3 stream carrying the SM2 operand block.
        const sm3Forged = tokensOf(VS_3_0_SINCOS);
        sm3Forged[7] = (Op.SINCOS | (4 << 24)) >>> 0;
        expect(() => parseShader(sm3Forged)).toThrow(/expected 1/);
    });
});

describe.skipIf(!d3dxOracleAvailable())("SM2 sincos/sgn oracle cross-check", () => {
    test("d3dx9 emits the same length nibble the parser requires", async () => {
        const sm2 = await asmFixture(`
            vs_2_0
            def c1, -0.00019, -0.00139, 0.00833, 0.02083
            def c2, -0.16666, 0.5, 1.0, 0.5
            dcl_position v0
            sincos r1.xy, v0.x, c1, c2
            mov oPos, r1
        `);
        expect(instructionFor(sm2, Op.SINCOS).src).toHaveLength(3);

        const sm3 = await asmFixture(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            sincos r1.xy, v0.x
            mov o0, r1
        `);
        expect(instructionFor(sm3, Op.SINCOS).src).toHaveLength(1);
    });
});
