/**
 * Packing an effect parameter's bytes into the shader constant registers a CTAB asks for.
 *
 * A compiled effect keeps every parameter as a flat little-endian blob; a shader's CTAB says
 * which register each constant occupies and in what shape it expects to read it. Neither side
 * knows the other, so this file is the join: parameter bytes in, one contiguous range ready
 * for SetVertexShaderConstant{F,I,B} out.
 *
 * Pure — no guest memory, no COM, no device. A shape that cannot be packed returns null rather
 * than a zero-filled range: a caller that uploads zeros draws a plausible wrong image, which
 * hides the gap instead of reporting it.
 */

import {
    CtabConstant, CtabTable, CtabType, ParameterClass, RegisterSet,
} from "./ctab";
import {
    EffectModel, EffectParamClass, EffectParamType, EffectParameter, findParameterIndex,
} from "./effect-state";

/** One contiguous upload: `registerIndex` onward, in whichever bank `registerSet` names. */
export interface ConstantUpload {
    registerSet: RegisterSet;
    registerIndex: number;
    floats?: Float32Array;
    ints?: Int32Array;
    bools?: Int32Array;
}

/**
 * The shape half of an EffectParameter. CTAB and effect blobs are two encodings of the same
 * D3DXPARAMETER_* enums, so ParameterClass and EffectParamClass share their numbering and a
 * comparison between the two is meaningful.
 */
interface ParamShape {
    paramClass: EffectParamClass;
    type: EffectParamType;
    rows: number;
    columns: number;
    elements: number;
    members: readonly ParamShape[];
}

/** Which scalar the parameter blob holds. Validated before any load, so `load` stays total. */
const enum SourceKind { Float, Int, Bool }

interface PackContext {
    set: RegisterSet;
    /** Components one register holds: a bool register holds exactly one BOOL, the rest hold 4. */
    components: number;
    out: Float32Array | Int32Array;
    view: DataView;
    /** How many 4-byte components the parameter blob actually has. */
    sourceComponents: number;
}

function sourceKind(type: EffectParamType): SourceKind | null {
    switch (type) {
        case EffectParamType.Float: return SourceKind.Float;
        case EffectParamType.Int: return SourceKind.Int;
        case EffectParamType.Bool: return SourceKind.Bool;
        default: return null;
    }
}

function load(ctx: PackContext, index: number, kind: SourceKind): number {
    if (kind === SourceKind.Float) return ctx.view.getFloat32(index * 4, true);
    const raw = ctx.view.getInt32(index * 4, true);
    // A BOOL is a 4-byte int whose only meaning is its truth; normalising here makes every
    // conversion below the identity.
    return kind === SourceKind.Bool ? (raw !== 0 ? 1 : 0) : raw;
}

function store(ctx: PackContext, index: number, value: number, fromFloat: boolean): void {
    switch (ctx.set) {
        case RegisterSet.Float4:
            ctx.out[index] = value;
            break;
        case RegisterSet.Int4:
            // d3dx converts float→int register with a C cast, i.e. toward zero, not to nearest.
            ctx.out[index] = fromFloat ? Math.trunc(value) : value;
            break;
        default:
            ctx.out[index] = value !== 0 ? 1 : 0;
            break;
    }
}

/**
 * Registers ONE element of `t` occupies. A vector is one register however few components it
 * has; a matrix costs one register per major vector; a struct costs the sum of its members,
 * each of which starts on a register boundary even though the value blob packs them tight.
 */
function registersForOneElement(t: CtabType, set: RegisterSet): number {
    if (t.class === ParameterClass.Struct) {
        if (t.members.length === 0) return 0;
        let sum = 0;
        for (const m of t.members) {
            const r = registersForType(m.type, set);
            if (r <= 0) return 0;
            sum += r;
        }
        return sum;
    }
    const rows = Math.max(1, t.rows);
    const columns = Math.max(1, t.columns);
    if (set === RegisterSet.Bool) return rows * columns;
    switch (t.class) {
        case ParameterClass.Scalar: return rows * columns;
        case ParameterClass.Vector: return 1;
        case ParameterClass.MatrixRows: return rows;
        case ParameterClass.MatrixColumns: return columns;
        default: return 0;
    }
}

function registersForType(t: CtabType, set: RegisterSet): number {
    return registersForOneElement(t, set) * Math.max(1, t.elements);
}

/** 4-byte components the parameter blob spends on `p`, arrays and struct members included. */
function componentsForParam(p: ParamShape): number {
    const elements = Math.max(1, p.elements);
    if (p.paramClass === EffectParamClass.Struct) {
        let sum = 0;
        for (const m of p.members) sum += componentsForParam(m);
        return sum * elements;
    }
    return Math.max(1, p.rows) * Math.max(1, p.columns) * elements;
}

/** Registers written, or null when the two shapes cannot be reconciled. */
function packShape(
    ctx: PackContext,
    param: ParamShape,
    ct: CtabType,
    dstRegister: number,
    srcComponent: number,
): number | null {
    const elements = Math.max(1, param.elements);
    if (elements !== Math.max(1, ct.elements)) return null;

    if (param.paramClass === EffectParamClass.Struct || ct.class === ParameterClass.Struct) {
        if (param.paramClass !== EffectParamClass.Struct || ct.class !== ParameterClass.Struct) return null;
        if (param.members.length === 0 || param.members.length !== ct.members.length) return null;
        let reg = dstRegister;
        let src = srcComponent;
        for (let e = 0; e < elements; e++) {
            for (let i = 0; i < param.members.length; i++) {
                const member = param.members[i]!;
                const wrote = packShape(ctx, member, ct.members[i]!.type, reg, src);
                if (wrote === null) return null;
                reg += wrote;
                src += componentsForParam(member);
            }
        }
        return reg - dstRegister;
    }

    const kind = sourceKind(param.type);
    if (kind === null) return null;
    const fromFloat = kind === SourceKind.Float;

    const rows = Math.max(1, param.rows);
    const columns = Math.max(1, param.columns);
    // SM1-3 has no constant wider or taller than a float4x4; anything else is a corrupt table.
    if (rows > 4 || columns > 4) return null;

    const perElement = registersForOneElement(ct, ctx.set);
    if (perElement <= 0) return null;
    const srcPerElement = rows * columns;
    if (srcComponent + elements * srcPerElement > ctx.sourceComponents) return null;

    if (ct.class === ParameterClass.Scalar || ct.class === ParameterClass.Vector) {
        const count = Math.min(Math.max(rows, columns), perElement * ctx.components);
        for (let e = 0; e < elements; e++) {
            const dst = (dstRegister + e * perElement) * ctx.components;
            const src = srcComponent + e * srcPerElement;
            // A float3 occupies a WHOLE register and .w keeps the pad below; pack the next
            // constant into it and every vector after this one reads a register too early.
            for (let k = 0; k < count; k++) store(ctx, dst + k, load(ctx, src + k, kind), fromFloat);
        }
        return perElement * elements;
    }

    if (ct.class !== ParameterClass.MatrixRows && ct.class !== ParameterClass.MatrixColumns) return null;

    const byColumn = ct.class === ParameterClass.MatrixColumns;
    // The CONSTANT decides what a register holds; the PARAMETER decides how its bytes are laid
    // out. Transpose exactly when they disagree — get it backwards and every transform in the
    // scene is the inverse-ish garbage of its own transpose, which still renders.
    const transpose = byColumn
        ? param.paramClass === EffectParamClass.MatrixRows
        : param.paramClass === EffectParamClass.MatrixColumns;
    const major = byColumn ? columns : rows;
    const minor = byColumn ? rows : columns;
    const majorStride = ctx.components === 1 ? minor : ctx.components;
    const majorCount = Math.min(major, perElement);

    for (let e = 0; e < elements; e++) {
        const dst = (dstRegister + e * perElement) * ctx.components;
        const src = srcComponent + e * srcPerElement;
        for (let i = 0; i < majorCount; i++) {
            for (let j = 0; j < minor; j++) {
                const at = transpose ? i + j * major : i * minor + j;
                store(ctx, dst + i * majorStride + j, load(ctx, src + at, kind), fromFloat);
            }
        }
    }
    return perElement * elements;
}

/**
 * Pack `param`'s current value for the registers `constant` occupies, or null when it cannot
 * feed them — a sampler, an object, a type or element count the two do not agree on, or a
 * value blob too short for the shape it claims.
 */
export function packParameter(param: EffectParameter, constant: CtabConstant): ConstantUpload | null {
    const set = constant.registerSet;
    if (set !== RegisterSet.Float4 && set !== RegisterSet.Int4 && set !== RegisterSet.Bool) return null;
    if (constant.registerCount <= 0) return null;
    if (param.value.byteLength < 4) return null;

    const footprint = registersForType(constant.type, set);
    if (footprint <= 0) return null;

    const components = set === RegisterSet.Bool ? 1 : 4;
    const total = footprint * components;
    const out = set === RegisterSet.Float4 ? new Float32Array(total) : new Int32Array(total);
    if (set === RegisterSet.Int4) {
        // An integer register feeds rep/loop as (count, initial, STEP, unused); d3dx leaves the
        // step at 1 in components a constant does not supply, and a step of 0 never terminates.
        for (let r = 0; r < footprint; r++) out[r * 4 + 2] = 1;
    }

    const ctx: PackContext = {
        set,
        components,
        out,
        view: new DataView(param.value.buffer, param.value.byteOffset, param.value.byteLength),
        sourceComponents: param.value.byteLength >>> 2,
    };
    if (packShape(ctx, param, constant.type, 0, 0) === null) return null;

    // fxc writes a component count rather than a register count for some aggregate int4
    // constants, so the shape is what bounds the upload; a shorter declared count still wins,
    // since the registers past it belong to whatever was placed after.
    const registers = Math.min(footprint, constant.registerCount);
    const value = registers < footprint ? out.subarray(0, registers * components) : out;
    const upload: ConstantUpload = { registerSet: set, registerIndex: constant.registerIndex };
    if (set === RegisterSet.Float4) upload.floats = value as Float32Array;
    else if (set === RegisterSet.Int4) upload.ints = value as Int32Array;
    else upload.bools = value as Int32Array;
    return upload;
}

/**
 * Pair each uploadable CTAB constant with the parameter that feeds it. Sampler constants are
 * left out — they have no value to upload and {@link samplerBindings} answers for them.
 *
 * A name that resolves to nothing is DROPPED, not faked: the caller compares this list against
 * `table.constants` to see how much of the shader it could not supply.
 */
export function bindConstants(
    params: readonly EffectParameter[],
    table: CtabTable,
    skipConstants?: ReadonlySet<string>,
): Array<{ constant: CtabConstant; param: EffectParameter }> {
    // findParameterIndex owns the dotted/indexed spellings (`Light[1].Position` → `Light`);
    // it reads only `parameters`, so a throwaway model is enough to reuse it — and it only
    // READS them, so the array is borrowed rather than copied.
    const model: EffectModel = { creator: "", parameters: params as EffectParameter[], techniques: [], objects: [] };
    const out: Array<{ constant: CtabConstant; param: EffectParameter }> = [];
    for (const constant of table.constants) {
        if (constant.registerSet === RegisterSet.Sampler) continue;
        // pSkipConstants names registers the APP owns: d3dx builds no constant set for them,
        // so the effect never writes over the raw SetShaderConstantF the app makes itself.
        if (skipConstants?.has(constant.name)) continue;
        const index = findParameterIndex(model, constant.name);
        const param = index >= 0 ? model.parameters[index] : undefined;
        if (param) out.push({ constant, param });
    }
    return out;
}

/** The sampler units the shader reads, one entry per occupied unit. */
export function samplerBindings(table: CtabTable): Array<{ name: string; unit: number }> {
    const out: Array<{ name: string; unit: number }> = [];
    for (const constant of table.constants) {
        if (constant.registerSet !== RegisterSet.Sampler) continue;
        const elements = Math.max(1, constant.type.elements);
        const count = Math.max(1, Math.min(elements, constant.registerCount || elements));
        for (let i = 0; i < count; i++) {
            out.push({
                name: count > 1 ? `${constant.name}[${i}]` : constant.name,
                unit: constant.registerIndex + i,
            });
        }
    }
    return out;
}
