/** Shared masked destination stores. */

import type { SmDest, SmInstruction } from "../sm-parser";
import type { Emitter } from "../emitter";
import { COMPONENTS, predicateExpr, predicateLaneExpr, srcExpr, type ShaderCtx } from "./expr";
import { RegType, type CmpOp } from "../sm-enums";

function shiftMultiplier(shift: number): string {
    if (shift > 0) return (1 << shift).toFixed(1);
    return (1 / (1 << -shift)).toString();
}

export function emitStore(
    dst: SmDest,
    valueVec4: string,
    ctx: ShaderCtx,
    emitter: Emitter,
    uid: number,
    forceSaturate = false,
): boolean {
    const name = ctx.writeRegName(dst.reg, dst);
    if (name === null || dst.writeMask === 0) return false;
    let value = valueVec4;
    if (dst.shift !== 0) value = `((${value}) * ${shiftMultiplier(dst.shift)})`;
    if (dst.saturate || forceSaturate) {
        // D3D's NClamp suppresses NaN to the lower bound. WGSL min/max propagate NaN, so
        // select the ordinary clamp only for ordered lanes and zero the unordered lanes.
        // Bind the value first: the select names it three times, and for texld_sat that
        // would be three textureSample calls of the same texel.
        const raw = emitter.tmp("sat");
        emitter.line(`let ${raw} = ${value};`);
        value = `select(vec4<f32>(0.0), min(max(${raw}, vec4<f32>(0.0)), vec4<f32>(1.0)), (${raw}) == (${raw}))`;
    }
    const tmp = emitter.tmp("st");
    emitter.line(`let ${tmp} = ${value};`);
    for (const [lane, component] of COMPONENTS.entries()) {
        if ((dst.writeMask & (1 << lane)) === 0) continue;
        const predicate = ctx.activePredicate
            ? predicateLaneExpr(ctx.activePredicate, lane, ctx)
            : null;
        emitter.line(`${name}.${component} = ${predicate
            ? `select(${name}.${component}, ${tmp}.${component}, ${predicate})`
            : `${tmp}.${component}`};`);
    }
    return true;
}

const CMP_OPERATOR: Record<CmpOp, string> = {
    gt: ">",
    eq: "==",
    ge: ">=",
    lt: "<",
    ne: "!=",
    le: "<=",
};

/** Lower setp_comp into the stage's mutable lane-wise predicate state. */
export function emitPredicateStore(
    instruction: SmInstruction,
    ctx: ShaderCtx,
    emitter: Emitter,
): boolean {
    const dst = instruction.dst;
    const comparison = instruction.comparison;
    if (!dst || dst.reg.type !== RegType.PREDICATE || !comparison || instruction.src.length < 2) {
        return false;
    }

    const a = srcExpr(instruction.src[0]!, ctx);
    const b = srcExpr(instruction.src[1]!, ctx);
    const result = `((${a}) ${CMP_OPERATOR[comparison]} (${b}))`;
    const name = `p${dst.reg.num}`;
    emitter.line(`// setp_${comparison}`);
    const resultTmp = emitter.tmp("setp");
    emitter.line(`let ${resultTmp} = ${result};`);
    const predicateTmp = ctx.activePredicate ? emitter.tmp("pred") : null;
    if (predicateTmp && ctx.activePredicate) {
        // Snapshot the whole predicate before writing p#. A predicated SETP may
        // read and write the same register through a non-identity swizzle.
        emitter.line(`let ${predicateTmp} = ${predicateExpr(ctx.activePredicate, ctx)};`);
    }
    for (const [lane, component] of COMPONENTS.entries()) {
        if ((dst.writeMask & (1 << lane)) === 0) continue;
        emitter.line(`${name}.${component} = ${predicateTmp
            ? `select(${name}.${component}, ${resultTmp}.${component}, ${predicateTmp}.${component})`
            : `${resultTmp}.${component}`};`);
    }
    return true;
}

export function maskCount(mask: number): number {
    return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}
