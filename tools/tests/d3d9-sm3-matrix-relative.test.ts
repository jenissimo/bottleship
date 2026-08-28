import { describe, expect, test } from "bun:test";
import { ALU, type EmitCtx } from "../../src/worker/backends/webgpu/d3d9/shader/emit/alu";
import { Op, RegType, SrcMod } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import { asmFixture, d3dxOracleAvailable } from "./helpers/asm-fixture";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

const IDENTITY = 0xe4;

const MATRIX_CASES = [
    [Op.M4x4, 4],
    [Op.M4x3, 3],
    [Op.M3x4, 4],
    [Op.M3x3, 3],
    [Op.M3x2, 2],
] as const;

function source(type: RegType, num: number): SmSource {
    return {
        reg: { type, num, relative: false },
        swizzle: IDENTITY,
        modifier: SrcMod.NONE,
    };
}

function matrixInstruction(opcode: Op, relType: RegType, relSwizzle: number): SmInstruction {
    const matrix = source(RegType.CONST, 7);
    matrix.reg.relative = true;
    matrix.relReg = { type: relType, num: 0, relative: false };
    matrix.relSwizzle = relSwizzle;
    return {
        opcode,
        coissue: false,
        predicated: false,
        specificData: 0,
        dst: null,
        src: [source(RegType.TEMP, 0), matrix],
    };
}

describe("SM3 relative matrix row lowering", () => {
    for (const [opcode, rows] of MATRIX_CASES) {
        for (const [name, relType, relSwizzle] of [
            ["a0", RegType.ADDR, 0x55],
            ["aL", RegType.LOOP, 0xaa],
        ] as const) {
            test(`${Op[opcode]} advances rows while preserving ${name} and its component`, () => {
                const reads: Array<{ num: number; relativeSource?: SmSource }> = [];
                const ctx: EmitCtx = {
                    isPs: false,
                    major: 3,
                    minor: 0,
                    readReg(reg, relativeSource) {
                        reads.push({ num: reg.num, relativeSource });
                        return `reg${reg.num}`;
                    },
                    writeRegName: () => null,
                };
                const instruction = matrixInstruction(opcode, relType, relSwizzle);

                ALU[opcode]!.expr(() => "unused", { ...ctx, instruction });

                const matrixReads = reads.slice(1);
                expect(matrixReads.map(read => read.num)).toEqual(
                    Array.from({ length: rows }, (_, row) => 7 + row),
                );
                for (const read of matrixReads) {
                    expect(read.relativeSource?.reg.relative).toBe(true);
                    expect(read.relativeSource?.relReg).toEqual({ type: relType, num: 0, relative: false });
                    expect(read.relativeSource?.relSwizzle).toBe(relSwizzle);
                }
            });
        }
    }
});

describe.skipIf(!d3dxOracleAvailable())("D3DX SM3 relative matrix fixtures", () => {
    test("a0.y matrix base carries the oracle's exact relative token", async () => {
        const program = await asmFixture(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            mova a0.y, v0.x
            m4x4 r0, v0, c[a0.y + 1]
            mov o0, r0
        `);
        const matrix = program.instructions.find(instruction => instruction.opcode === Op.M4x4)!.src[1]!;

        expect(matrix.reg).toEqual({ type: RegType.CONST, num: 1, relative: true });
        expect(matrix.relReg).toEqual({ type: RegType.ADDR, num: 0, relative: false });
        expect(matrix.relSwizzle).toBe(0x55);
    });

    test("aL matrix base carries the oracle's exact loop-relative token", async () => {
        const program = await asmFixture(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            defi i0, 1, 0, 1, 0
            loop aL, i0
                m3x3 r0.xyz, v0, c[aL + 2]
            endloop
            mov o0, r0
        `);
        const matrix = program.instructions.find(instruction => instruction.opcode === Op.M3x3)!.src[1]!;

        expect(matrix.reg).toEqual({ type: RegType.CONST, num: 2, relative: true });
        expect(matrix.relReg).toEqual({ type: RegType.LOOP, num: 0, relative: false });
        expect(matrix.relSwizzle).toBe(IDENTITY);
    });
});
