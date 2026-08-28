/** One shared dispatch table for all stage-independent ALU instructions. */

import { Op, opName } from "../sm-enums";
import type { SmInstruction } from "../sm-parser";
import { Emitter } from "../emitter";
import { ShaderCtx, srcExpr } from "./expr";
import { emitStore } from "./store";

export interface EmitCtx extends ShaderCtx {
    instruction?: SmInstruction;
}

export interface AluSpec {
    /** WGSL vec4 expression; `s(i)` returns source i with its modifiers. */
    expr(s: (i: number) => string, ctx: EmitCtx): string;
    minSrc: number;
    stages?: "vs" | "ps";
}

/** The largest finite f32 value accepted by the D3D9 float contract. */
export const FLT_MAX = "3.4028234663852886e+38";

type DotComponents = "xy" | "xyz" | "xyzw";

/** Select safe operands before multiplying so Inf/NaN * 0 is never evaluated. */
export function safeMulOperand(operand: string, other: string): string {
    return `select((${operand}), vec4<f32>(0.0), (${other}) == vec4<f32>(0.0))`;
}

/** D3D9's x * 0 rule, expressed without a raw product in either select arm. */
export function safeMul(a: string, b: string): string {
    return `(${safeMulOperand(a, b)} * ${safeMulOperand(b, a)})`;
}

/** Dot a vector of safe products; this keeps dot/matrix lowering on the same path. */
export function safeDot(a: string, b: string, components: DotComponents): string {
    const width = components.length === 2 ? 2 : components.length === 3 ? 3 : 4;
    return `dot((${safeMul(a, b)}).${components}, vec${width}<f32>(1.0))`;
}

/** Use min/max rather than WGSL clamp for the finite bounds in this contract. */
export function upperBound(value: string): string {
    return `min((${value}), vec4<f32>(${FLT_MAX}))`;
}

export function upperBoundScalar(value: string): string {
    return `min((${value}), ${FLT_MAX})`;
}

export function lowerBound(value: string): string {
    return `max((${value}), vec4<f32>(-${FLT_MAX}))`;
}

export function lowerBoundScalar(value: string): string {
    return `max((${value}), -${FLT_MAX})`;
}

export function exactRcp(source: string): string {
    const x = `(${source}).x`;
    // D3D9's rule is `src0.x == 0.0f -> FLT_MAX`, and -0.0 compares equal to 0.0, so both
    // zero signs take that arm. Every other input is a finite quotient bounded on BOTH
    // sides; an underflowed negative denominator must saturate to -FLT_MAX, not -INF.
    return `select(${lowerBoundScalar(upperBoundScalar(`1.0 / ${x}`))}, ${FLT_MAX}, ${x} == 0.0)`;
}

export function exactRsq(source: string): string {
    const x = `(${source}).x`;
    return upperBoundScalar(`inverseSqrt(abs(${x}))`);
}

export function exactExp(source: string): string {
    const x = `(${source}).x`;
    return upperBoundScalar(`exp2(${x})`);
}

export function exactExpp(source: string): string {
    const x = `(${source}).x`;
    return upperBound(`vec4<f32>(exp2(floor(${x})), fract(${x}), exp2(${x}), 1.0)`);
}

export function exactLog(source: string): string {
    const x = `(${source}).x`;
    return lowerBoundScalar(`log2(abs(${x}))`);
}

export function exactPow(base: string, exponent: string): string {
    const y = `(${exponent}).x`;
    return `select(pow(abs((${base}).x), ${y}), 1.0, ${y} == 0.0)`;
}

export function exactLit(source: string): string {
    const x = `(${source}).x`;
    const y = `(${source}).y`;
    const power = `min(max((${source}).w, -127.9961), 127.9961)`;
    // D3D9's lit pseudocode gates both y and the specular term on strict
    // positivity.  In particular x==0 must leave z at zero (0^0 and 0^-n
    // are not allowed to leak through), unlike a >= predicate.
    const positiveX = `(${x} > 0.0)`;
    const positiveY = `(${y} > 0.0)`;
    const z = `select(0.0, pow(max(${y}, 0.0), ${power}), ${positiveX} && ${positiveY})`;
    const diffuse = `select(0.0, ${x}, ${positiveX})`;
    return `vec4<f32>(1.0, ${diffuse}, ${z}, 1.0)`;
}

function matrixResult(instr: SmInstruction, ctx: EmitCtx, rows: number, dim: number): string {
    const s0 = srcExpr(instr.src[0], ctx);
    const base = instr.src[1]?.reg;
    if (!base) return "vec4<f32>(0.0)";
    const rowExprs: string[] = [];
    for (let r = 0; r < 4; r++) {
        if (r < rows) {
            const matrixSource = instr.src[1]!;
            const rowSource = {
                ...matrixSource,
                reg: { ...base, num: base.num + r },
            };
            const cReg = ctx.readReg(rowSource.reg, rowSource.reg.relative ? rowSource : undefined);
            rowExprs.push(safeDot(s0, cReg, dim === 4 ? "xyzw" : "xyz"));
        } else {
            rowExprs.push("0.0");
        }
    }
    return `vec4<f32>(${rowExprs.join(", ")})`;
}

const unary = (f: (a: string) => string): AluSpec => ({
    minSrc: 1,
    expr: s => f(s(0)),
});
const binary = (f: (a: string, b: string) => string): AluSpec => ({
    minSrc: 2,
    expr: s => f(s(0), s(1)),
});

/** The only ALU opcode seam. Stage files must not switch on ALU opcodes. */
export const ALU: Partial<Record<Op, AluSpec>> = {
    [Op.MOV]: unary(a => a),
    [Op.ADD]: binary((a, b) => `(${a} + ${b})`),
    [Op.SUB]: binary((a, b) => `(${a} - ${b})`),
    [Op.MUL]: binary((a, b) => safeMul(a, b)),
    [Op.MAD]: { minSrc: 3, expr: s => `(${safeMul(s(0), s(1))} + ${s(2)})` },
    [Op.LRP]: {
        minSrc: 3,
        expr: s => {
            const factor = s(0);
            return `(${safeMul(factor, s(1))} + ${safeMul(`(vec4<f32>(1.0) - ${factor})`, s(2))})`;
        },
    },
    [Op.MIN]: binary((a, b) => `min(${a}, ${b})`),
    [Op.MAX]: binary((a, b) => `max(${a}, ${b})`),
    [Op.FRC]: unary(a => `fract(${a})`),
    [Op.ABS]: unary(a => `abs(${a})`),
    [Op.DP3]: binary((a, b) => `vec4<f32>(${safeDot(a, b, "xyz")})`),
    [Op.DP4]: binary((a, b) => `vec4<f32>(${safeDot(a, b, "xyzw")})`),
    [Op.DP2ADD]: { minSrc: 3, expr: s => `vec4<f32>(${safeDot(s(0), s(1), "xy")} + (${s(2)}).x)` },
    [Op.RCP]: unary(a => `vec4<f32>(${exactRcp(a)})`),
    [Op.RSQ]: unary(a => `vec4<f32>(${exactRsq(a)})`),
    [Op.EXP]: unary(a => `vec4<f32>(${exactExp(a)})`),
    [Op.LOG]: unary(a => `vec4<f32>(${exactLog(a)})`),
    // SM1 uses the four-component partial-precision form.  In SM2+ EXPP is
    // the scalar-X EXP form; retaining the SM1 tuple here changes y/z/w.
    [Op.EXPP]: {
        minSrc: 1,
        expr: (s, ctx) => ctx.major >= 2
            ? `vec4<f32>(${exactExp(s(0))})`
            : exactExpp(s(0)),
    },
    [Op.LOGP]: unary(a => `vec4<f32>(${exactLog(a)})`),
    [Op.POW]: binary((a, b) => `vec4<f32>(${exactPow(a, b)})`),
    [Op.SLT]: binary((a, b) => `select(vec4<f32>(0.0), vec4<f32>(1.0), ${a} < ${b})`),
    [Op.SGE]: binary((a, b) => `select(vec4<f32>(0.0), vec4<f32>(1.0), ${a} >= ${b})`),
    [Op.CMP]: { minSrc: 3, expr: s => `select(${s(2)}, ${s(1)}, ${s(0)} >= vec4<f32>(0.0))` },
    // D3D9 CND selects src1 only when src0 is strictly greater than 0.5.
    // The equality boundary is observable for ps_1_4's per-lane form.
    [Op.CND]: { minSrc: 3, expr: s => `select(${s(2)}, ${s(1)}, ${s(0)} > vec4<f32>(0.5))` },
    [Op.CRS]: binary((a, b) => `vec4<f32>(cross((${a}).xyz, (${b}).xyz), 1.0)`),
    [Op.NRM]: unary(a => {
        const rsq = upperBoundScalar(`inverseSqrt(${safeDot(a, a, "xyz")})`);
        return `vec4<f32>((${safeMul(a, `vec4<f32>(${rsq})`)}).xyz, 1.0)`;
    }),
    [Op.SGN]: unary(a => `sign(${a})`),
    [Op.SINCOS]: unary(a => `vec4<f32>(cos((${a}).x), sin((${a}).x), 0.0, 0.0)`),
    [Op.LIT]: unary(exactLit),
    [Op.DST]: binary((a, b) => `vec4<f32>(1.0, (${safeMul(a, b)}).y, (${a}).z, (${b}).w)`),
    [Op.M4x4]: { minSrc: 2, expr: (_s, ctx) => ctx.instruction ? matrixResult(ctx.instruction, ctx, 4, 4) : "vec4<f32>(0.0)" },
    [Op.M4x3]: { minSrc: 2, expr: (_s, ctx) => ctx.instruction ? matrixResult(ctx.instruction, ctx, 3, 4) : "vec4<f32>(0.0)" },
    [Op.M3x4]: { minSrc: 2, expr: (_s, ctx) => ctx.instruction ? matrixResult(ctx.instruction, ctx, 4, 3) : "vec4<f32>(0.0)" },
    [Op.M3x3]: { minSrc: 2, expr: (_s, ctx) => ctx.instruction ? matrixResult(ctx.instruction, ctx, 3, 3) : "vec4<f32>(0.0)" },
    [Op.M3x2]: { minSrc: 2, expr: (_s, ctx) => ctx.instruction ? matrixResult(ctx.instruction, ctx, 2, 3) : "vec4<f32>(0.0)" },
};

export function emitAlu(instr: SmInstruction, ctx: EmitCtx, emitter: Emitter, uid: number): boolean {
    if (instr.opcode === Op.NOP) {
        emitter.line("// nop");
        return true;
    }
    const { dst } = instr;
    if (!dst) return false;
    const result = emitAluExpression(instr, ctx);
    if (result === null) return false;
    emitter.line(`// ${opName(instr.opcode)}`);
    return emitStore(dst, result, ctx, emitter, uid);
}

/** Evaluate an ALU instruction without committing it to a register. */
export function emitAluExpression(instr: SmInstruction, ctx: EmitCtx): string | null {
    const spec = ALU[instr.opcode];
    if (!spec || instr.src.length < spec.minSrc) return null;
    return spec.expr(i => srcExpr(instr.src[i]!, ctx), { ...ctx, instruction: instr });
}
