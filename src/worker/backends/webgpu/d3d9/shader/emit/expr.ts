/** Shared source-expression and stage naming helpers. */

import { SmDest, SmRegister, SmSource } from "../sm-parser";
import { RegType, SrcMod } from "../sm-enums";

export const LOC_COLOR0 = 0;
export const LOC_COLOR1 = 1;
export const LOC_TEXCOORD_BASE = 2;

export function colField(i: number): string { return `col${i}`; }
export function texField(i: number): string { return `tex${i}`; }

export interface ShaderCtx {
    isPs: boolean;
    major: number;
    minor: number;
    /**
     * Read a register, optionally with the source operand that supplied its
     * relative-addressing metadata.  Keeping the metadata on SmSource is
     * important: the extra token carries both the index register and the
     * component selected from that register.
     */
    readReg(reg: SmRegister, relativeSource?: SmSource): string;
    writeRegName(reg: SmRegister, destination?: SmDest): string | null;
    /** Predicate attached to the instruction currently being lowered. */
    activePredicate?: SmSource;
}

export interface AlphaTest { func: number; ref: number; }

export const COMPONENTS = ["x", "y", "z", "w"] as const;
export type Component = typeof COMPONENTS[number];
const CMP_OP: Record<number, string> = { 2: "<", 3: "==", 4: "<=", 5: ">", 6: "!=", 7: ">=" };

/**
 * Is `expr` certainly a WGSL VALUE — a constructor/builtin result, a `let`, or a member of
 * the entry point's `in` parameter — rather than a reference into a `var`/uniform?
 *
 * Only a reference turns a swizzle into Tint's SwizzleView, so only a reference needs the
 * materializing constructor below. The test is a prefix match against the shapes readReg
 * itself produces, so it can answer "value" only for expressions we built; anything else
 * (r0, t0, p0, oC0, psc.c[n]) falls through to the safe side.
 */
function isMaterializedValue(expr: string): boolean {
    return /^(?:vec[234]<[^>]*>|select|clamp)\(/.test(expr)
        || /^in\.[A-Za-z_]\w*$/.test(expr)
        || /^dc\d+$/.test(expr);
}

/** Load `expr` as a value, so every later component selection stays in SSA value space. */
function materialize(expr: string, scalarType: "f32" | "bool" = "f32"): string {
    return isMaterializedValue(expr) ? expr : `vec4<${scalarType}>(${expr})`;
}

/** DCL write masks describe which lanes of an input/output register exist. */
export function maskVec4(expr: string, writeMask = 0xF): string {
    const mask = writeMask & 0xF;
    if (mask === 0xF) return materialize(expr);
    return `vec4<f32>(${COMPONENTS.map((component, lane) =>
        (mask & (1 << lane)) !== 0 ? `(${expr})[${lane}]` : "0.0").join(", ")})`;
}

/** Lane index encoded by a relative-addressing token. */
export function relativeLane(swizzle: number | undefined): number {
    return (swizzle ?? 0xE4) & 3;
}

/** D3D's round-to-nearest with half values away from zero. WGSL round() uses the
 * ties-to-even rule, which changes MOVA and relative constant addressing at +/-0.5. */
export function roundD3dExpr(value: string): string {
    const x = `(${value})`;
    return `select(ceil(${x} - 0.5), floor(${x} + 0.5), ${x} >= 0.0)`;
}

/**
 * Build the integer index carried by a relative operand/destination.
 *
 * SM1 vertex shaders imply a0.x and therefore have no second token.  SM2+
 * provides relReg/relSwizzle explicitly; missing metadata there is malformed
 * IR and must be loud rather than silently becoming a0/zero.
 */
export function relativeIndexExpr(
    relReg: SmRegister | undefined,
    relSwizzle: number | undefined,
    ctx: ShaderCtx,
    allowImplicitAddress = !ctx.isPs && ctx.major < 2,
): string {
    const indexReg = relReg ?? (allowImplicitAddress
        ? { type: RegType.ADDR, num: 0, relative: false }
        : undefined);
    if (!indexReg) {
        throw new Error("relative addressing is missing its index-register token");
    }
    if (ctx.isPs && indexReg.type !== RegType.LOOP) {
        throw new Error(`pixel relative addressing cannot use register type ${indexReg.type}`);
    }

    const lane = relativeLane(relSwizzle);
    // a0 is an integer vector in the VS emitter.  Preserve that type directly;
    // in particular, do not round the already-converted MOVA result again.
    if (!ctx.isPs && indexReg.type === RegType.ADDR) return `a0[${lane}]`;

    const value = ctx.readReg(indexReg);
    return `i32(${roundD3dExpr(`(${value})[${lane}]`)})`;
}

export function alphaTestSnippet(at: AlphaTest | null, alphaExpr: string): string {
    if (!at) return "";
    const { func } = at;
    if (func === 8 || func === 0) return "";
    if (func === 1) return "discard;";
    const op = CMP_OP[func];
    if (!op) return "";
    const refInt = (((at.ref & 0xff) << 8) | (at.ref & 0xff)) >>> 0;
    return `{ let _atA = round((${alphaExpr}) * 65535.0); if (!(_atA ${op} ${refInt}.0)) { discard; } }`;
}

function applySwizzle(expr: string, sw: number, scalarType: "f32" | "bool" = "f32"): string {
    const lanes = [sw & 3, (sw >>> 2) & 3, (sw >>> 4) & 3, (sw >>> 6) & 3];
    // A swizzle applied directly to a mutable WGSL var becomes Tint's pointer-like
    // SwizzleView, which Dawn currently fails to lower on some legal shaders. Materialize
    // the operand ONCE and swizzle the value: the constructor is the whole safety, so the
    // operand text is never repeated per lane and callers may keep appending components.
    const value = materialize(expr, scalarType);
    if (lanes[0] === 0 && lanes[1] === 1 && lanes[2] === 2 && lanes[3] === 3) return value;
    const letters = lanes.map(lane => COMPONENTS[lane]).join("");
    // A materialized value that came back unwrapped needs its own parentheses; a wrapping
    // constructor call is already atomic.
    return value === expr ? `(${value}).${letters}` : `${value}.${letters}`;
}

/** Build a vec4<f32> WGSL expression for a source operand. */
export function srcExpr(src: SmSource, ctx: ShaderCtx): string {
    let e = ctx.readReg(src.reg, src.reg.relative ? src : undefined);
    const m = src.modifier;
    if (m === SrcMod.DZ) e = `((${e}) / (${e})[2])`;
    else if (m === SrcMod.DW) e = `((${e}) / (${e})[3])`;
    e = applySwizzle(e, src.swizzle);
    switch (m) {
        case SrcMod.NEG: e = `(-(${e}))`; break;
        case SrcMod.BIAS: e = `((${e}) - vec4<f32>(0.5))`; break;
        case SrcMod.BIASNEG: e = `(-((${e}) - vec4<f32>(0.5)))`; break;
        case SrcMod.SIGN: e = `((${e}) * 2.0 - vec4<f32>(1.0))`; break;
        case SrcMod.SIGNNEG: e = `(-((${e}) * 2.0 - vec4<f32>(1.0)))`; break;
        case SrcMod.COMP: e = `(vec4<f32>(1.0) - (${e}))`; break;
        case SrcMod.X2: e = `((${e}) * 2.0)`; break;
        case SrcMod.X2NEG: e = `(-((${e}) * 2.0))`; break;
        case SrcMod.ABS: e = `abs(${e})`; break;
        case SrcMod.ABSNEG: e = `(-abs(${e}))`; break;
        // NOT is a boolean source modifier used by predicate prefixes. Keep the
        // result in the vec4 source domain so callers can still apply swizzles
        // and use the ordinary source-expression seam.
        case SrcMod.NOT: e = `select(vec4<f32>(0.0), vec4<f32>(1.0), (${e}) == vec4<f32>(0.0))`; break;
        default: break;
    }
    return e;
}

/** Build the four lane conditions carried by an instruction predicate token. */
export function predicateExpr(src: SmSource, ctx: ShaderCtx): string {
    if (src.reg.type === RegType.PREDICATE) {
        const value = applySwizzle(`p${src.reg.num}`, src.swizzle, "bool");
        return src.modifier === SrcMod.NOT ? `!(${value})` : value;
    }
    // SrcMod.NOT is a modifier on the predicate token itself. Strip it before
    // reading the bool register so inversion remains a bool operation rather
    // than an accidental float arithmetic transform.
    const base = src.modifier === SrcMod.NOT
        ? { ...src, modifier: SrcMod.NONE }
        : src;
    const value = `((${srcExpr(base, ctx)}) != vec4<f32>(0.0))`;
    return src.modifier === SrcMod.NOT ? `!${value}` : value;
}

/** Select the predicate lane corresponding to one destination channel. */
export function predicateLaneExpr(src: SmSource, lane: number, ctx: ShaderCtx): string {
    if (!Number.isInteger(lane) || lane < 0 || lane >= COMPONENTS.length) {
        throw new Error(`invalid scalar predicate lane ${lane}`);
    }
    return `(${predicateExpr(src, ctx)})[${lane}]`;
}

/** Scalar control operations explicitly consume their x destination lane. */
export function scalarPredicateExpr(src: SmSource, ctx: ShaderCtx): string {
    return predicateLaneExpr(src, 0, ctx);
}
