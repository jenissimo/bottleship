import { describe, expect, test } from "bun:test";
import { compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import { structureProgram } from "../../src/worker/backends/webgpu/d3d9/shader/passes/structure";
import { InlineCallError, inlineCalls } from "../../src/worker/backends/webgpu/d3d9/shader/passes/inline-calls";
import { d3dxOracleAvailable } from "./helpers/asm-fixture";

const FULL_SWIZZLE = 0xe4;

function source(type: RegType, num: number): SmSource {
    return { reg: { type, num, relative: false }, swizzle: FULL_SWIZZLE, modifier: 0 };
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

function instruction(
    opcode: Op,
    src: SmSource[] = [],
    dst: SmInstruction["dst"] = null,
): SmInstruction {
    return { opcode, coissue: false, predicated: false, specificData: 0, dst, src };
}

function program(instructions: SmInstruction[]): SmProgram {
    return {
        isPixelShader: false,
        major: 3,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: 1,
        maxConst: 0,
        maxBool: 0,
        samplersUsed: new Set(),
        inputRegs: new Set(),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

function label(num: number): SmInstruction {
    return instruction(Op.LABEL, [source(RegType.LABEL, num)]);
}

function call(num: number): SmInstruction {
    return instruction(Op.CALL, [source(RegType.LABEL, num)]);
}

function ret(): SmInstruction {
    return instruction(Op.RET);
}

function errorCode(action: () => unknown): InlineCallError["code"] {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(InlineCallError);
        return (error as InlineCallError).code;
    }
    throw new Error("expected inlineCalls to fail");
}

describe("D3D9 SM3 subroutine inlining", () => {
    test("splices call bodies and preserves the structured Block tree", () => {
        const inlined = inlineCalls(program([
            call(0),
            instruction(Op.MOV, [source(RegType.TEMP, 0)], destination(RegType.RASTOUT, 0)),
            ret(),
            label(0),
            instruction(Op.MOV, [source(RegType.INPUT, 0)], destination(RegType.TEMP, 0)),
            ret(),
        ]));

        expect(inlined.instructions.map(instruction => instruction.opcode)).toEqual([Op.MOV, Op.MOV]);
        expect(structureProgram(inlined)).toEqual([{ kind: "instrs", instrs: inlined.instructions }]);
    });

    test("lowers callnz into an ordinary conditional block", () => {
        const inlined = inlineCalls(program([
            instruction(Op.CALLNZ, [source(RegType.LABEL, 0), source(RegType.TEMP, 1)]),
            ret(),
            label(0),
            instruction(Op.NOP),
            ret(),
        ]));

        expect(inlined.instructions.map(instruction => instruction.opcode)).toEqual([
            Op.IF, Op.NOP, Op.ENDIF,
        ]);
        expect(structureProgram(inlined)[0]).toMatchObject({ kind: "if", then: [{ kind: "instrs" }] });
    });

    test("rejects missing labels, recursion, and call depth beyond four", () => {
        expect(errorCode(() => inlineCalls(program([call(7), ret()])))).toBe("missing-label");

        expect(errorCode(() => inlineCalls(program([
            call(0), ret(), label(0), call(0), ret(),
        ])))).toBe("recursive-call");

        const deep: SmInstruction[] = [call(0), ret()];
        for (let i = 0; i < 5; i++) {
            deep.push(label(i));
            if (i < 4) deep.push(call(i + 1));
            deep.push(ret());
        }
        expect(errorCode(() => inlineCalls(program(deep)))).toBe("call-depth-limit");
    });

    test("rejects malformed call operands instead of leaving a silent flow fallback", () => {
        expect(errorCode(() => inlineCalls(program([
            instruction(Op.CALL, [source(RegType.TEMP, 0)]), ret(),
        ])))).toBe("invalid-operand");
    });
});

describe.skipIf(!d3dxOracleAvailable())("D3D9 SM3 subroutine oracle fixture", () => {
    test("links a call fixture identically to its manually inlined baseline", async () => {
        const { assemble } = await import("../d3dx-oracle");
        const withCall = assemble(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            call l0
            mov o0, r0
            ret
            label l0
            mov r0, v0
            ret
        `);
        const baseline = assemble(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            mov r0, v0
            mov o0, r0
            ret
        `);
        if (!withCall.tokens) throw new Error(withCall.error ?? "oracle rejected call fixture");
        if (!baseline.tokens) throw new Error(baseline.error ?? "oracle rejected baseline fixture");

        const options = {
            ps: null,
            declElements: null,
            streamStride: 16,
        } as const;
        const actual = linkProgram({ ...options, vs: compileVertexShader(withCall.tokens) });
        const expected = linkProgram({ ...options, vs: compileVertexShader(baseline.tokens) });
        expect(actual.wgsl).toBe(expected.wgsl);
    });
});
