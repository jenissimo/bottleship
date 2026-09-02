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
    // Assign the complete vector once. A component l-value write such as `r0.x = ...` is a
    // writable "swizzle view" inside Tint, which fails to lower some valid shaders of that
    // shape ("swizzle view instruction still has usages after lowering") and invalidates
    // the whole pipeline. `tmp` snapshots the source before the destination changes, so the
    // rebuilt vec4 keeps D3D's read-before-write for aliasing swizzles; unwritten and
    // predicate-false lanes retain the old destination value.
    const lanes = COMPONENTS.map((component, lane) => {
        if ((dst.writeMask & (1 << lane)) === 0) return `${name}[${lane}]`;
        const predicate = ctx.activePredicate
            ? predicateLaneExpr(ctx.activePredicate, lane, ctx)
            : null;
        return predicate
            ? `select(${name}[${lane}], ${tmp}[${lane}], ${predicate})`
            : `${tmp}[${lane}]`;
    });
    emitter.line(`${name} = vec4<f32>(${lanes.join(", ")});`);
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
    const lanes = COMPONENTS.map((component, lane) => {
        if ((dst.writeMask & (1 << lane)) === 0) return `${name}[${lane}]`;
        return predicateTmp
            ? `select(${name}[${lane}], ${resultTmp}[${lane}], ${predicateTmp}[${lane}])`
            : `${resultTmp}[${lane}]`;
    });
    emitter.line(`${name} = vec4<bool>(${lanes.join(", ")});`);
    return true;
}

export function maskCount(mask: number): number {
    return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}
