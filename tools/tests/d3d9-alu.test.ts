import { describe, expect, test } from "bun:test";
import { ALU, exactLit, exactPow, lowerBound, safeDot, safeMul, safeMulOperand, upperBound } from "../../src/worker/backends/webgpu/d3d9/shader/emit/alu";
import { emitStore } from "../../src/worker/backends/webgpu/d3d9/shader/emit/store";
import { Emitter } from "../../src/worker/backends/webgpu/d3d9/shader/emitter";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { EmitCtx } from "../../src/worker/backends/webgpu/d3d9/shader/emit/alu";

const ctx: EmitCtx = {
    isPs: false,
    major: 3,
    minor: 0,
    readReg: () => "reg",
    writeRegName: () => "r0",
};

function alu(op: Op, sources: string[] = ["a", "b", "c"]): string {
    const spec = ALU[op];
    if (!spec) throw new Error(`missing ALU spec ${op}`);
    return spec.expr(i => sources[i]!, ctx);
}

/**
 * There is no runtime WebGPU numeric ALU harness in the Bun test environment. These golden
 * snapshots are the edge-case oracle: they pin the helper lowering and prevent a listed
 * contract from regressing back to raw WGSL arithmetic.
 */
describe("d3d9 ALU float contract", () => {
    test("safe multiply helper is used by mul/mad/dot variants", () => {
        expect({
            operand: safeMulOperand("a", "b"),
            product: safeMul("a", "b"),
            dot3: safeDot("a", "b", "xyz"),
            mul: alu(Op.MUL),
            mad: alu(Op.MAD),
            dp3: alu(Op.DP3),
            dp4: alu(Op.DP4),
            dp2add: alu(Op.DP2ADD),
        }).toMatchSnapshot();
    });

    test("rcp(0) is the finite positive maximum for both zero signs", () => {
        const rcp = alu(Op.RCP, ["a"]);
        // D3D9's rule is `src0.x == 0.0f -> FLT_MAX`, and -0.0 compares equal to 0.0,
        // so there is no sign-carrying second zero arm and no infinity in the lowering.
        expect(rcp).not.toContain("0x7f800000u");
        expect(rcp).not.toContain("0x80000000u");
        // The quotient is bounded on BOTH sides: rcp(-1e-40) is -FLT_MAX, not -inf.
        expect(rcp).toContain("max((min((1.0 / (a).x), 3.4028234663852886e+38)), -3.4028234663852886e+38)");
        expect({
            rcp,
            max: upperBound("value"),
        }).toMatchSnapshot();
    });

    test("rsq clamps its infinite zero-input result", () => {
        expect(alu(Op.RSQ, ["a"])).toMatchSnapshot();
    });

    test("log and logp clamp zero to the finite lower bound", () => {
        expect({
            log: alu(Op.LOG, ["a"]),
            logp: alu(Op.LOGP, ["a"]),
            lower: lowerBound("value"),
        }).toMatchSnapshot();
    });

    test("exp and expp clamp overflow to the finite upper bound", () => {
        expect({
            exp: alu(Op.EXP, ["a"]),
            expp: alu(Op.EXPP, ["a"]),
        }).toMatchSnapshot();
    });

    test("pow has an exact zero-exponent result", () => {
        expect({
            helper: exactPow("a", "b"),
            opcode: alu(Op.POW),
        }).toMatchSnapshot();
    });

    test("lit clamps power and uses both positive predicates", () => {
        expect({
            helper: exactLit("a"),
            opcode: alu(Op.LIT, ["a"]),
        }).toMatchSnapshot();
    });

    test("lit gates diffuse/specular on strict positive dot products", () => {
        const lit = exactLit("a");
        expect(lit).toContain(".x > 0.0");
        expect(lit).toContain(".y > 0.0");
        expect(lit).not.toContain(".x >= 0.0");
        expect(lit).not.toContain(".y >= 0.0");
        // The zero-dot case must select a literal zero diffuse/specular term;
        // max(x, 0) would leak NaN and 0^negative through WGSL's eager arms.
        expect(lit).toContain("select(0.0");
    });

    test("cnd uses the strict 0.5 threshold", () => {
        const cnd = alu(Op.CND, ["condition", "whenTrue", "whenFalse"]);
        expect(cnd).toContain("condition > vec4<f32>(0.5)");
        expect(cnd).not.toContain("condition >= vec4<f32>(0.5)");
    });

    test("the saturate modifier uses NaN-suppressing NClamp instead of WGSL clamp", () => {
        const emitter = new Emitter();
        emitStore({
            reg: { type: RegType.TEMP, num: 0, relative: false },
            writeMask: 0xf,
            shift: 0,
            saturate: true,
        }, "value", ctx, emitter, 0);

        const wgsl = emitter.toString();
        expect(wgsl).toContain("let _sat0 = value;");
        expect(wgsl).toContain(
            "select(vec4<f32>(0.0), min(max(_sat0, vec4<f32>(0.0)), vec4<f32>(1.0)), (_sat0) == (_sat0))",
        );
        expect(wgsl).not.toContain("clamp(value");
        // The NaN select names its operand three times; a saturated texld must not
        // become three textureSample calls, so the value is bound exactly once.
        expect(wgsl.split("value").length - 1).toBe(1);
    });

    test("masked stores rebuild one vec4 without writable swizzle views", () => {
        const emitter = new Emitter();
        emitStore({
            reg: { type: RegType.TEMP, num: 0, relative: false },
            writeMask: 0x5,
            shift: 0,
            saturate: false,
        }, "source", ctx, emitter, 0);

        const wgsl = emitter.toString();
        expect(wgsl).toContain("r0 = vec4<f32>(_st0[0], r0[1], _st0[2], r0[3]);");
        expect(wgsl).not.toMatch(/r0\.[xyzw]\s*=/);
    });
});
