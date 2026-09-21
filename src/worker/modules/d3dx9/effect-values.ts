/**
 * Reading and writing an effect parameter's value, with the type conversions d3dx performs.
 *
 * A parameter owns ONE block of `rows * columns` numbers per element, laid out in its OWN
 * major order: row-major for MATRIX_ROWS, column-major for MATRIX_COLUMNS. That is what the
 * register-upload math reads back (Wine's get_const_upload_info indexes a COLUMNS parameter
 * as `data[column * rows + row]`), so storing both classes row-major would transpose every
 * column-major matrix on its way to the shader.
 *
 * Every setter answers false for a shape the real d3dx refuses (an array through the scalar
 * entry point, a matrix through SetVector); the caller turns that into D3DERR_INVALIDCALL
 * rather than writing something plausible.
 */

import { EffectParamClass, EffectParamType, noteSetTextureOutcome, type EffectParameter } from "./effect-state";
import { addComRef, releaseComRef } from "../d3d9/shared-state";
import { propagateSharedObject } from "./effect-pool";

/** D3DX packs a D3DCOLOR into a float vector through SetInt with 1/255 scaling. */
const INT_FLOAT_MULTI = 255.0;

function elementCount(param: EffectParameter): number {
    return Math.max(1, param.elements);
}

function numberCount(param: EffectParameter): number {
    return param.value.length >>> 2;
}

function viewOf(param: EffectParameter): DataView | null {
    if (!param.value.length) return null;
    return new DataView(param.value.buffer, param.value.byteOffset, param.value.byteLength);
}

/**
 * Which effect parameters the app actually WRITES, by name.
 *
 * The companion to the zero-upload census in effect-apply: that one says which constants we
 * fed zeros, this one says whether the app ever supplied a value for them. A name that is
 * uploaded thousands of times and written zero times is not the app's own state — it is a
 * set that landed somewhere else.
 */
const paramWriteCensus = new Map<string, { writes: number; zeroWrites: number; sourceZero: number; lastZeroPtr: number; lastZeroCaller: number; lastPtr: number }>();
/** The exact parameter OBJECTS the app has written, so "never set" can be told apart from
 *  "set, but on a different effect's copy of the same name". */
const writtenParams = new WeakSet<EffectParameter>();

export function effectParamWasWritten(param: EffectParameter): boolean {
    return writtenParams.has(param);
}

export function effectParamWriteCensus(): Array<{ name: string; writes: number; zeroWrites: number; sourceZero: number; lastZeroPtr: string; lastZeroCaller: string; lastPtr: string }> {
    return [...paramWriteCensus.entries()]
        .map(([name, row]) => ({ name, writes: row.writes, zeroWrites: row.zeroWrites, sourceZero: row.sourceZero, lastZeroPtr: "0x" + (row.lastZeroPtr >>> 0).toString(16), lastZeroCaller: "0x" + (row.lastZeroCaller >>> 0).toString(16), lastPtr: "0x" + (row.lastPtr >>> 0).toString(16) }))
        .sort((a, b) => b.writes - a.writes);
}

export function resetEffectParamWriteCensus(): void {
    paramWriteCensus.clear();
}

/** Guest address the value in flight was read from; the setter parks it here so a
 *  zero source can name the block it came from instead of only saying "zero". */
let pendingSourcePtr = 0;

let pendingSourceCaller = 0;

export function noteSourcePointer(ptr: number, caller = 0): void {
    pendingSourcePtr = ptr >>> 0;
    pendingSourceCaller = caller >>> 0;
}

function noteWrite(param: EffectParameter, source?: ArrayLike<number>): true {
    writtenParams.add(param);
    let row = paramWriteCensus.get(param.name);
    if (!row) {
        if (paramWriteCensus.size >= 1024) return true;
        row = { writes: 0, zeroWrites: 0, sourceZero: 0, lastZeroPtr: 0, lastZeroCaller: 0, lastPtr: 0 };
        paramWriteCensus.set(param.name, row);
    }
    if (pendingSourcePtr) row.lastPtr = pendingSourcePtr;
    if (source) {
        let srcZero = true;
        for (let i = 0; i < source.length; i++) {
            if (source[i] !== 0) { srcZero = false; break; }
        }
        if (srcZero) { row.sourceZero++; row.lastZeroPtr = pendingSourcePtr; row.lastZeroCaller = pendingSourceCaller; }
    }
    row.writes++;
    // A write that STORES zeros is the app handing us zeros (or an argument we marshalled
    // wrong); a non-zero write that later uploads as zero is a value we lost after the fact.
    // The two look identical from the picture and need opposite fixes.
    let allZero = true;
    for (let i = 0; i < param.value.length; i++) {
        if (param.value[i] !== 0) { allZero = false; break; }
    }
    if (allZero) row.zeroWrites++;
    return true;
}

/** Read slot `i` of the block as a JS number in the parameter's own type. */
export function readNumber(param: EffectParameter, i: number): number {
    const dv = viewOf(param);
    if (!dv || (i + 1) * 4 > dv.byteLength) return 0;
    switch (param.type) {
        case EffectParamType.Float: return dv.getFloat32(i * 4, true);
        case EffectParamType.Bool: return dv.getInt32(i * 4, true) !== 0 ? 1 : 0;
        default: return dv.getInt32(i * 4, true);
    }
}

/** Write `v` (given as a float) into slot `i`, converted to the parameter's type. */
function writeNumberFromFloat(dv: DataView, param: EffectParameter, i: number, v: number): void {
    switch (param.type) {
        case EffectParamType.Float: dv.setFloat32(i * 4, v, true); break;
        case EffectParamType.Bool: dv.setInt32(i * 4, v !== 0 ? 1 : 0, true); break;
        default: dv.setInt32(i * 4, Math.trunc(v) | 0, true); break;
    }
}

/** Write `v` (given as an int) into slot `i`, converted to the parameter's type. */
function writeNumberFromInt(dv: DataView, param: EffectParameter, i: number, v: number): void {
    switch (param.type) {
        case EffectParamType.Float: dv.setFloat32(i * 4, v, true); break;
        case EffectParamType.Bool: dv.setInt32(i * 4, v !== 0 ? 1 : 0, true); break;
        default: dv.setInt32(i * 4, v | 0, true); break;
    }
}

function isNumericClass(param: EffectParameter): boolean {
    return param.paramClass === EffectParamClass.Scalar
        || param.paramClass === EffectParamClass.Vector
        || param.paramClass === EffectParamClass.MatrixRows
        || param.paramClass === EffectParamClass.MatrixColumns;
}

function isScalarSlot(param: EffectParameter): boolean {
    return !param.elements && param.rows === 1 && param.columns === 1;
}

/**
 * The ONLY mutation of an object parameter's interface pointer — and the owner of its
 * REFERENCE.
 *
 * A D3DX object parameter holds a counted reference: SetTexture/SetValue AddRef what they take
 * and Release what they displace, and every Get* hands the caller its own counted copy, so an
 * app that follows COM may Release its own handle as soon as the effect has taken one. AddRef
 * the new object BEFORE releasing the old, and skip both when the pointer is unchanged (Wine
 * d3dx9_36/effect.c set_value/SetTexture).
 *
 * Three setters reach this (SetTexture, SetValue, SetRawValue), so the reference cannot be owned
 * at the call sites. The shared-parameter mirrors are propagated HERE for the same reason — a
 * pool group is ONE logical parameter holding ONE reference, so `param.objectPtr` must already
 * be the group's current value when this compares against it.
 */
export function setObjectParam(param: EffectParameter, next: number): void {
    const prev = param.objectPtr >>> 0;
    const ptr = next >>> 0;
    if (ptr === prev) return;
    if (ptr) addComRef(ptr);
    param.objectPtr = ptr;
    propagateSharedObject(param);
    if (prev) releaseComRef(prev);
}

/** A Get* hands the caller a counted reference; the caller Releases it. Same contract as above,
 *  read from the other side — without this the app's Release takes the count one too low. */
export function retainReturnedObject(ptr: number): number {
    const p = ptr >>> 0;
    if (p) addComRef(p);
    return p;
}

/** SetValue: raw bytes, refused unless the caller offers at least the whole block. */
export function setRawValue(param: EffectParameter, bytes: Uint8Array): boolean {
    // SetValue is the generic setter and d3dx accepts it for a TEXTURE parameter too — the
    // four bytes are the interface pointer, the same thing SetTexture stores. An object
    // parameter has no value block (the compiled effect keeps an object index there), so the
    // block-copy below would refuse it, and an engine that binds its textures through SetValue
    // would silently bind none: the call fails, the sampler resolves to NULL and every draw
    // samples the fallback texture.
    if (isTextureParameter(param)) {
        if (bytes.length < 4) return false;
        setObjectParam(param, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true));
        noteSetTextureOutcome(param.objectPtr ? "setValue" : "setValueNull");
        return noteWrite(param);
    }
    if (!param.value.length || bytes.length < param.value.length) return false;
    param.value.set(bytes.subarray(0, param.value.length));
    return noteWrite(param);
}

export function setScalarFloat(param: EffectParameter, v: number): boolean {
    const dv = viewOf(param);
    if (!dv || !isScalarSlot(param)) return false;
    writeNumberFromFloat(dv, param, 0, v);
    return noteWrite(param);
}

export function setScalarBool(param: EffectParameter, v: number): boolean {
    const dv = viewOf(param);
    if (!dv || !isScalarSlot(param)) return false;
    writeNumberFromInt(dv, param, 0, v !== 0 ? 1 : 0);
    return noteWrite(param);
}

/**
 * SetInt on a float vector is the D3DCOLOR path: an app packs ARGB into one int and expects
 * four normalised floats back, so refusing it would leave a material black.
 */
export function setScalarInt(param: EffectParameter, v: number): boolean {
    const dv = viewOf(param);
    if (!dv || param.elements) return false;
    if (isScalarSlot(param)) {
        writeNumberFromInt(dv, param, 0, v);
        return noteWrite(param);
    }
    const colourFixup = param.type === EffectParamType.Float
        && ((param.paramClass === EffectParamClass.Vector && param.columns !== 2)
            || (param.paramClass === EffectParamClass.MatrixRows && param.rows !== 2 && param.columns === 1));
    if (!colourFixup) return false;
    const slots = Math.min(4, param.rows * param.columns);
    const channels = [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, (v >>> 24) & 0xff];
    for (let i = 0; i < slots; i++) dv.setFloat32(i * 4, channels[i]! / INT_FLOAT_MULTI, true);
    return noteWrite(param);
}

/** SetFloatArray/SetIntArray/SetBoolArray: a flat fill of the block, clamped to its size. */
export function setNumberArray(
    param: EffectParameter,
    values: ArrayLike<number>,
    fromFloat: boolean,
): boolean {
    const dv = viewOf(param);
    if (!dv || !isNumericClass(param)) return false;
    const size = Math.min(values.length, numberCount(param));
    for (let i = 0; i < size; i++) {
        const v = values[i]!;
        if (fromFloat) writeNumberFromFloat(dv, param, i, v);
        else writeNumberFromInt(dv, param, i, v);
    }
    return noteWrite(param);
}

export function getNumberArray(param: EffectParameter, out: Float32Array | Int32Array): void {
    const size = Math.min(out.length, numberCount(param));
    for (let i = 0; i < size; i++) out[i] = readNumber(param, i);
}

/** SetVector: the first `columns` components of a D3DXVECTOR4, per element. */
function writeVectorInto(
    param: EffectParameter,
    dv: DataView,
    base: number,
    v: ArrayLike<number>,
    at: number,
): void {
    if (param.type === EffectParamType.Int && param.value.length === 4) {
        // A whole D3DCOLOR in one int slot — the inverse of the SetInt fixup above.
        const clamp = (x: number) => Math.max(0, Math.min(1, x)) * INT_FLOAT_MULTI;
        const packed = (clamp(v[at + 2]!) | (clamp(v[at + 1]!) << 8) | (clamp(v[at]!) << 16)
            | (clamp(v[at + 3]!) << 24)) >>> 0;
        dv.setInt32(base * 4, packed | 0, true);
        return;
    }
    for (let i = 0; i < param.columns; i++) writeNumberFromFloat(dv, param, base + i, v[at + i]!);
}

export function setVector(param: EffectParameter, v: ArrayLike<number>): boolean {
    const dv = viewOf(param);
    if (!dv || param.elements) return false;
    if (param.paramClass !== EffectParamClass.Scalar && param.paramClass !== EffectParamClass.Vector) return false;
    writeVectorInto(param, dv, 0, v, 0);
    return noteWrite(param, v);
}

export function setVectorArray(param: EffectParameter, v: ArrayLike<number>, count: number): boolean {
    const dv = viewOf(param);
    if (!dv || param.paramClass !== EffectParamClass.Vector) return false;
    if (!param.elements || count > param.elements) return false;
    for (let i = 0; i < count; i++) writeVectorInto(param, dv, i * param.columns, v, i * 4);
    return noteWrite(param, v);
}

export function getVector(param: EffectParameter, out: Float32Array): void {
    for (let i = 0; i < 4; i++) out[i] = i < param.columns ? readNumber(param, i) : 0;
}

/**
 * GetVectorArray: `count` D3DXVECTOR4s, each the element's own `columns` components zero-filled
 * to four — the exact inverse of setVectorArray. Elements past the parameter's array are zeroed
 * rather than left alone: the caller's buffer is uninitialised, so handing part of it back
 * untouched would let it read its own stack as vector data.
 */
export function getVectorArray(param: EffectParameter, out: Float32Array, count: number): void {
    const elements = Math.max(1, param.elements);
    const columns = Math.max(1, param.columns);
    for (let e = 0; e < count; e++) {
        for (let i = 0; i < 4; i++) {
            out[e * 4 + i] = e < elements && i < columns ? readNumber(param, e * columns + i) : 0;
        }
    }
}

/**
 * SetMatrix: the source is always a 4x4 row-major D3DXMATRIX; only the top-left
 * `rows x columns` corner is kept, in the block's own major order.
 */
function slotOf(param: EffectParameter, r: number, c: number): number {
    return param.paramClass === EffectParamClass.MatrixColumns
        ? c * param.rows + r
        : r * param.columns + c;
}

function writeMatrixInto(
    param: EffectParameter,
    dv: DataView,
    base: number,
    m: ArrayLike<number>,
    at: number,
    transpose: boolean,
): void {
    for (let r = 0; r < param.rows; r++) {
        for (let c = 0; c < param.columns; c++) {
            const src = transpose ? at + c * 4 + r : at + r * 4 + c;
            writeNumberFromFloat(dv, param, base + slotOf(param, r, c), m[src]!);
        }
    }
}

export function setMatrix(param: EffectParameter, m: ArrayLike<number>, transpose: boolean): boolean {
    const dv = viewOf(param);
    if (!dv || param.elements) return false;
    if (param.paramClass !== EffectParamClass.MatrixRows && param.paramClass !== EffectParamClass.MatrixColumns) {
        return false;
    }
    writeMatrixInto(param, dv, 0, m, 0, transpose);
    return noteWrite(param, m);
}

export function setMatrixArray(
    param: EffectParameter,
    m: ArrayLike<number>,
    count: number,
    transpose: boolean,
): boolean {
    const dv = viewOf(param);
    if (!dv || count > param.elements) return false;
    if (param.paramClass !== EffectParamClass.MatrixRows && param.paramClass !== EffectParamClass.MatrixColumns) {
        return false;
    }
    const stride = param.rows * param.columns;
    for (let i = 0; i < count; i++) writeMatrixInto(param, dv, i * stride, m, i * 16, transpose);
    return noteWrite(param, m);
}

/** GetMatrix: the block widened back to a 4x4, everything outside the corner zeroed. */
export function getMatrix(param: EffectParameter, out: Float32Array, transpose: boolean): void {
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const inside = r < param.rows && c < param.columns;
            const value = inside ? readNumber(param, slotOf(param, r, c)) : 0;
            out[transpose ? c * 4 + r : r * 4 + c] = value;
        }
    }
}

export function getMatrixArray(
    param: EffectParameter,
    out: Float32Array,
    count: number,
    transpose: boolean,
): void {
    const stride = param.rows * param.columns;
    const limit = Math.min(count, elementCount(param));
    for (let i = 0; i < limit; i++) {
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                const inside = r < param.rows && c < param.columns;
                const value = inside ? readNumber(param, i * stride + slotOf(param, r, c)) : 0;
                out[i * 16 + (transpose ? c * 4 + r : r * 4 + c)] = value;
            }
        }
    }
}

/** A texture parameter's data IS the interface pointer; d3dx stores nothing else for it. */
export function isTextureParameter(param: EffectParameter): boolean {
    return param.paramClass === EffectParamClass.Object
        && param.type >= EffectParamType.Texture
        && param.type <= EffectParamType.TextureCube;
}
