/**
 * Small, deterministic CPU fixed-function vertex processor used by D3D9
 * ProcessVertices.
 *
 * This is deliberately a data-only helper. It supports the common D3D9 FFP path
 * and a bounded SM2/SM3 programmable SWVP subset. Unsupported texture/control-flow
 * opcodes return D3DERR_NOTAVAILABLE before a partial destination write.
 */

import type { RawVertexElement } from "./shader";
import { parseFvf } from "./shader/fvf-layout";
import type { SmProgram, SmInstruction, SmSource, SmRegister } from "./shader/sm-parser";
import { Op, RegType, SrcMod } from "./shader/sm-enums";

export const D3D_OK = 0;
export const D3DERR_INVALIDCALL = 0x8876086c;
export const D3DERR_NOTAVAILABLE = 0x8876086a;

const D3DDECLTYPE_UNUSED = 17;
const D3DDECLTYPE_FLOAT1 = 0;
const D3DDECLTYPE_FLOAT2 = 1;
const D3DDECLTYPE_FLOAT3 = 2;
const D3DDECLTYPE_FLOAT4 = 3;
const D3DDECLTYPE_D3DCOLOR = 4;
const D3DDECLTYPE_UBYTE4 = 5;
const D3DDECLTYPE_SHORT2 = 6;
const D3DDECLTYPE_SHORT4 = 7;
const D3DDECLTYPE_UBYTE4N = 8;
const D3DDECLTYPE_SHORT2N = 9;
const D3DDECLTYPE_SHORT4N = 10;
const D3DDECLTYPE_USHORT2N = 11;
const D3DDECLTYPE_USHORT4N = 12;

/**
 * Opcodes for which the CPU SWVP interpreter has complete operand and control
 * flow handling. Keep this separate from the switch in executeVertexShader:
 * ProcessVertices must reject an entire program before touching the destination
 * when an instruction would otherwise fall through to the interpreter's
 * NOTAVAILABLE path on a later vertex.
 */
const SWVP_SUPPORTED_OPS: ReadonlySet<number> = new Set([
    Op.NOP, Op.MOV, Op.ADD, Op.SUB, Op.MUL, Op.MAD, Op.MIN, Op.MAX,
    Op.SLT, Op.SGE, Op.DP3, Op.DP4, Op.DP2ADD, Op.RCP, Op.RSQ,
    Op.EXP, Op.EXPP, Op.LOG, Op.LOGP, Op.POW, Op.ABS, Op.SGN, Op.FRC,
    Op.NRM, Op.CRS, Op.LRP, Op.CMP, Op.CND, Op.LIT, Op.DST, Op.SINCOS,
    Op.MOVA, Op.SETP, Op.M4x4, Op.M4x3, Op.M3x4, Op.M3x3, Op.M3x2,
    Op.DCL, Op.IF, Op.IFC, Op.ELSE, Op.ENDIF, Op.RET,
]);

export const D3DDECLUSAGE_POSITION = 0;
export const D3DDECLUSAGE_NORMAL = 3;
export const D3DDECLUSAGE_TEXCOORD = 5;
export const D3DDECLUSAGE_POSITIONT = 9;
export const D3DDECLUSAGE_COLOR = 10;

export interface SwvpStream {
    data: Uint8Array;
    /** SetStreamSource OffsetInBytes. */
    offset: number;
    /** SetStreamSource Stride. */
    stride: number;
}

export interface SwvpViewport {
    x: number;
    y: number;
    width: number;
    height: number;
    minZ: number;
    maxZ: number;
}

/**
 * The fixed-function vertex state that D3D9 evaluates *inside* ProcessVertices.
 * This CPU processor implements the transform and the attribute copy only, so a
 * caller with any of these active must be refused: lit/fogged/generated output
 * written from unlit source colours would be indistinguishable from success.
 */
export interface SwvpFixedFunctionState {
    /** D3DRS_LIGHTING with at least one enabled light, or a non-default material. */
    lighting: boolean;
    /** D3DRS_FOGENABLE with a vertex fog mode (fog factor lands in the diffuse alpha). */
    fog: boolean;
    /** Any stage whose D3DTSS_TEXCOORDINDEX carries a D3DTSS_TCI_* generation mode,
     *  or a non-identity D3DTS_TEXTURE* matrix. */
    texgen: boolean;
}

export interface SwvpRequest {
    srcStartIndex: number;
    destIndex: number;
    vertexCount: number;
    sourceFvf: number;
    sourceElements: RawVertexElement[] | null;
    streams: ReadonlyArray<SwvpStream | null>;
    destElements: RawVertexElement[];
    destData: Uint8Array;
    mvp: Float32Array;
    viewport: SwvpViewport;
    /** D3DPV_DONOTCOPYDATA.  Copying all supported data remains legal for this flag. */
    flags: number;
    /** Fixed-function state this processor does not evaluate. Absent means the
     *  caller has verified none of it is active. */
    fixedFunction?: SwvpFixedFunctionState | null;
    /** Optional programmable VS IR and the expanded SWVP register files. */
    shader?: SmProgram | null;
    constantsF?: Float32Array;
    constantsI?: Int32Array;
    constantsB?: Uint8Array;
}

interface Value {
    components: number[];
    rawColor?: number;
}

interface PositionValue extends Value {
    preTransformed: boolean;
}

const SWVP_FLT_MAX = 3.4028234663852886e38;

function splat(value: number): Vec4 {
    return vec(value, value, value, value);
}

function upperBoundF32(value: number): number {
    return Math.min(value, SWVP_FLT_MAX);
}

function lowerBoundF32(value: number): number {
    return Math.max(value, -SWVP_FLT_MAX);
}

/** WGSL round() and D3D MOVA round halfway cases away from zero. */
function roundAwayFromZero(value: number): number {
    return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

/** Number of bytes consumed by a D3DDECLTYPE. */
export function declarationTypeBytes(type: number): number {
    switch (type) {
        case D3DDECLTYPE_FLOAT1: return 4;
        case D3DDECLTYPE_FLOAT2: return 8;
        case D3DDECLTYPE_FLOAT3: return 12;
        case D3DDECLTYPE_FLOAT4: return 16;
        case D3DDECLTYPE_D3DCOLOR:
        case D3DDECLTYPE_UBYTE4:
        case D3DDECLTYPE_UBYTE4N:
        case D3DDECLTYPE_SHORT2:
        case D3DDECLTYPE_SHORT2N:
        case D3DDECLTYPE_USHORT2N: return 4;
        case D3DDECLTYPE_SHORT4:
        case D3DDECLTYPE_SHORT4N:
        case D3DDECLTYPE_USHORT4N: return 8;
        default: return 0;
    }
}

/** Convert the destination FVF carried by a vertex buffer into the declaration-like
 * elements consumed by ProcessVertices. D3D9 permits a NULL pVertexDecl in that call:
 * the destination buffer's FVF then supplies the output layout. Keep this conversion
 * alongside the SWVP source fallback so source and destination byte layouts cannot drift. */
export function fvfToRawElements(fvf: number): RawVertexElement[] | null {
    if (!Number.isSafeInteger(fvf) || !fvf) return null;
    const f = parseFvf(fvf >>> 0);
    const out: RawVertexElement[] = [];
    const xyzw = (fvf & 0x4000) !== 0;
    const positionType = f.hasRhw || xyzw ? D3DDECLTYPE_FLOAT4 : D3DDECLTYPE_FLOAT3;
    out.push({
        stream: 0, offset: f.posOff, type: positionType,
        usage: f.hasRhw ? D3DDECLUSAGE_POSITIONT : D3DDECLUSAGE_POSITION, usageIndex: 0,
    });

    // XYZBn stores betas immediately after XYZ. The LASTBETA flags turn the final
    // four bytes into matrix indices; values beyond four explicit float weights are
    // not representable by the declaration ABI and are rejected atomically.
    const weightType = (count: number): number => count === 1 ? D3DDECLTYPE_FLOAT1
        : count === 2 ? D3DDECLTYPE_FLOAT2 : count === 3 ? D3DDECLTYPE_FLOAT3 : D3DDECLTYPE_FLOAT4;
    if (f.blendWeightCount > 4) return null;
    if (f.blendWeightCount > 0) {
        out.push({ stream: 0, offset: f.blendWeightOff, type: weightType(f.blendWeightCount), usage: 1, usageIndex: 0 });
    }
    if (f.blendIndexFormat) {
        out.push({
            stream: 0, offset: f.blendIndexOff,
            type: f.blendIndexFormat === "uint8x4" ? D3DDECLTYPE_UBYTE4 : D3DDECLTYPE_UBYTE4N,
            usage: 2, usageIndex: 0,
        });
    }

    let cursor = (positionType === D3DDECLTYPE_FLOAT4 ? 16 : 12)
        + f.blendWeightCount * 4 + (f.blendIndexFormat ? 4 : 0);
    if (f.hasNormal) {
        out.push({ stream: 0, offset: f.normalOff, type: D3DDECLTYPE_FLOAT3, usage: D3DDECLUSAGE_NORMAL, usageIndex: 0 });
        cursor = f.normalOff + 12;
    }
    if ((fvf & 0x0020) !== 0) {
        out.push({ stream: 0, offset: cursor, type: D3DDECLTYPE_FLOAT1, usage: 4, usageIndex: 0 });
        cursor += 4;
    }
    if (f.hasColor) out.push({ stream: 0, offset: f.colorOff, type: D3DDECLTYPE_D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 });
    if (f.hasSpecular) out.push({ stream: 0, offset: f.specularOff, type: D3DDECLTYPE_D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 1 });
    for (let set = 0; set < f.texCount && set < 8; set++) {
        const dims = f.texDims[set] ?? 2;
        out.push({
            stream: 0, offset: f.texOffs[set] ?? 0,
            type: dims === 1 ? D3DDECLTYPE_FLOAT1 : dims === 3 ? D3DDECLTYPE_FLOAT3
                : dims === 4 ? D3DDECLTYPE_FLOAT4 : D3DDECLTYPE_FLOAT2,
            usage: D3DDECLUSAGE_TEXCOORD, usageIndex: set,
        });
    }
    return out;
}

function fvfSourceElements(fvf: number): RawVertexElement[] | null {
    return fvfToRawElements(fvf);
}

function validElement(e: RawVertexElement): boolean {
    return Number.isSafeInteger(e.stream) && e.stream >= 0
        && Number.isSafeInteger(e.offset) && e.offset >= 0
        && e.type !== D3DDECLTYPE_UNUSED && declarationTypeBytes(e.type) > 0;
}

function validViewport(viewport: SwvpViewport): boolean {
    return Number.isFinite(viewport.x) && Number.isFinite(viewport.y)
        && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
        && Number.isFinite(viewport.minZ) && Number.isFinite(viewport.maxZ)
        && viewport.width > 0 && viewport.height > 0
        && viewport.minZ <= viewport.maxZ;
}

function validMatrix(matrix: Float32Array): boolean {
    if (matrix.length < 16) return false;
    for (let i = 0; i < 16; i++) if (!Number.isFinite(matrix[i]!)) return false;
    return true;
}

/**
 * Return the D3D9 homogeneous clip bits for a clip-space position.  Bits 0/1
 * and 2/3 are the -w/+w tests for x/y.  Bits 4/5 are the D3D9 z=0 and z=w
 * near/far tests.  Bit 6 marks a non-positive w; a non-finite component
 * returns null because it cannot be classified safely.
 */
export function homogeneousClipCode(position: readonly number[]): number | null {
    if (position.length < 4 || position.some(v => !Number.isFinite(v))) return null;
    const x = position[0]!, y = position[1]!, z = position[2]!, w = position[3]!;
    let code = 0;
    if (x < -w) code |= 1;
    if (x > w) code |= 2;
    if (y < -w) code |= 4;
    if (y > w) code |= 8;
    if (z < 0) code |= 16;
    if (z > w) code |= 32;
    if (!(w > 0)) code |= 64;
    return code;
}

function viewportPosition(position: Vec4, viewport: SwvpViewport): Value | null {
    const code = homogeneousClipCode(position);
    // A point outside x/y/z is still a valid vertex: primitive clipping will
    // handle it at draw time.  Non-positive w is different; dividing it here
    // would fabricate coordinates because ProcessVertices has no primitive
    // context in which to intersect a clip edge.
    if (code === null || (code & 64) !== 0) return null;
    const w = position[3]!;
    const inv = 1 / w;
    return {
        components: [
            (position[0]! * inv * 0.5 + 0.5) * viewport.width + viewport.x,
            (0.5 - position[1]! * inv * 0.5) * viewport.height + viewport.y,
            viewport.minZ + position[2]! * inv * (viewport.maxZ - viewport.minZ),
            inv,
        ],
    };
}

function readValue(view: DataView, offset: number, type: number): Value | null {
    const readF = (n: number): Value => {
        const components: number[] = [];
        for (let i = 0; i < n; i++) components.push(view.getFloat32(offset + i * 4, true));
        return { components };
    };
    switch (type) {
        case D3DDECLTYPE_FLOAT1: return readF(1);
        case D3DDECLTYPE_FLOAT2: return readF(2);
        case D3DDECLTYPE_FLOAT3: return readF(3);
        case D3DDECLTYPE_FLOAT4: return readF(4);
        case D3DDECLTYPE_D3DCOLOR: {
            // D3DCOLOR is stored as BGRA bytes (0xAARRGGBB in the DWORD), but the
            // vertex-shader register convention is normalized RGBA. Keep the raw
            // value so a direct D3DCOLOR -> D3DCOLOR copy remains byte-exact.
            const rawColor = view.getUint32(offset, true);
            return {
                components: [
                    ((rawColor >>> 16) & 0xff) / 255,
                    ((rawColor >>> 8) & 0xff) / 255,
                    (rawColor & 0xff) / 255,
                    ((rawColor >>> 24) & 0xff) / 255,
                ],
                rawColor,
            };
        }
        case D3DDECLTYPE_UBYTE4:
            return { components: [view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3)] };
        case D3DDECLTYPE_UBYTE4N:
            return { components: [view.getUint8(offset) / 255, view.getUint8(offset + 1) / 255, view.getUint8(offset + 2) / 255, view.getUint8(offset + 3) / 255] };
        case D3DDECLTYPE_SHORT2:
            return { components: [view.getInt16(offset, true), view.getInt16(offset + 2, true)] };
        case D3DDECLTYPE_SHORT4:
            return { components: [view.getInt16(offset, true), view.getInt16(offset + 2, true), view.getInt16(offset + 4, true), view.getInt16(offset + 6, true)] };
        case D3DDECLTYPE_SHORT2N:
            return { components: [Math.max(-1, view.getInt16(offset, true) / 32767), Math.max(-1, view.getInt16(offset + 2, true) / 32767)] };
        case D3DDECLTYPE_SHORT4N:
            return { components: [Math.max(-1, view.getInt16(offset, true) / 32767), Math.max(-1, view.getInt16(offset + 2, true) / 32767), Math.max(-1, view.getInt16(offset + 4, true) / 32767), Math.max(-1, view.getInt16(offset + 6, true) / 32767)] };
        case D3DDECLTYPE_USHORT2N:
            return { components: [view.getUint16(offset, true) / 65535, view.getUint16(offset + 2, true) / 65535] };
        case D3DDECLTYPE_USHORT4N:
            return { components: [view.getUint16(offset, true) / 65535, view.getUint16(offset + 2, true) / 65535, view.getUint16(offset + 4, true) / 65535, view.getUint16(offset + 6, true) / 65535] };
        default: return null;
    }
}

function writeValue(view: DataView, offset: number, type: number, value: Value): boolean {
    const c = value.components;
    const at = (i: number, fallback = 0): number => c[i] ?? fallback;
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    if (type === D3DDECLTYPE_D3DCOLOR && value.rawColor !== undefined) {
        view.setUint32(offset, value.rawColor >>> 0, true);
        return true;
    }
    const writeF = (n: number): void => { for (let i = 0; i < n; i++) view.setFloat32(offset + i * 4, at(i, i === 3 ? 1 : 0), true); };
    switch (type) {
        case D3DDECLTYPE_FLOAT1: writeF(1); return true;
        case D3DDECLTYPE_FLOAT2: writeF(2); return true;
        case D3DDECLTYPE_FLOAT3: writeF(3); return true;
        case D3DDECLTYPE_FLOAT4: writeF(4); return true;
        case D3DDECLTYPE_D3DCOLOR: {
            // Components are logical RGBA; D3DCOLOR memory order is BGRA.
            const bytes = [at(2, 1), at(1, 1), at(0, 1), at(3, 1)]
                .map(v => Math.round(clamp01(v) * 255));
            view.setUint32(offset, (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0, true);
            return true;
        }
        case D3DDECLTYPE_UBYTE4:
            for (let i = 0; i < 4; i++) view.setUint8(offset + i, at(i));
            return true;
        case D3DDECLTYPE_UBYTE4N:
            for (let i = 0; i < 4; i++) view.setUint8(offset + i, Math.round(clamp01(at(i, i === 3 ? 1 : 0)) * 255));
            return true;
        case D3DDECLTYPE_SHORT2:
            view.setInt16(offset, at(0), true); view.setInt16(offset + 2, at(1), true); return true;
        case D3DDECLTYPE_SHORT4:
            for (let i = 0; i < 4; i++) view.setInt16(offset + i * 2, at(i), true); return true;
        case D3DDECLTYPE_SHORT2N:
            view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, at(0))) * 32767), true);
            view.setInt16(offset + 2, Math.round(Math.max(-1, Math.min(1, at(1))) * 32767), true); return true;
        case D3DDECLTYPE_SHORT4N:
            for (let i = 0; i < 4; i++) view.setInt16(offset + i * 2, Math.round(Math.max(-1, Math.min(1, at(i, i === 3 ? 1 : 0))) * 32767), true); return true;
        case D3DDECLTYPE_USHORT2N:
            view.setUint16(offset, Math.round(clamp01(at(0)) * 65535), true);
            view.setUint16(offset + 2, Math.round(clamp01(at(1)) * 65535), true); return true;
        case D3DDECLTYPE_USHORT4N:
            for (let i = 0; i < 4; i++) view.setUint16(offset + i * 2, Math.round(clamp01(at(i, i === 3 ? 1 : 0)) * 65535), true); return true;
        default: return false;
    }
}

function semantic(e: RawVertexElement): string {
    return `${e.usage}:${e.usageIndex}`;
}

function findElement(elements: RawVertexElement[], usage: number, usageIndex: number): RawVertexElement | null {
    return elements.find(e => e.usage === usage && e.usageIndex === usageIndex) ?? null;
}

function readElement(
    element: RawVertexElement,
    streams: ReadonlyArray<SwvpStream | null>,
    vertex: number,
): Value | null {
    const stream = streams[element.stream];
    if (!stream || stream.stride <= 0) return null;
    const offset = stream.offset + vertex * stream.stride + element.offset;
    const bytes = declarationTypeBytes(element.type);
    if (offset < 0 || offset + bytes > stream.data.byteLength) return null;
    return readValue(new DataView(stream.data.buffer, stream.data.byteOffset, stream.data.byteLength), offset, element.type);
}

function readPosition(
    element: RawVertexElement,
    streams: ReadonlyArray<SwvpStream | null>,
    vertex: number,
): PositionValue | null {
    const value = readElement(element, streams, vertex);
    if (!value || value.components.length < 3) return null;
    return { ...value, preTransformed: element.usage === D3DDECLUSAGE_POSITIONT };
}

function shaderInputVector(element: RawVertexElement, value: Value): Vec4 {
    const position = element.usage === D3DDECLUSAGE_POSITION || element.usage === D3DDECLUSAGE_POSITIONT;
    return [value.components[0] ?? 0, value.components[1] ?? 0, value.components[2] ?? 0,
        value.components[3] ?? (position ? 1 : 0)];
}

function outputStride(elements: RawVertexElement[]): number {
    let end = 0;
    for (const e of elements) if (e.stream === 0) end = Math.max(end, e.offset + declarationTypeBytes(e.type));
    return end;
}

type Vec4 = [number, number, number, number];

const vec = (x = 0, y = 0, z = 0, w = 0): Vec4 => [x, y, z, w];
const cloneVec = (v: ArrayLike<number>): Vec4 => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0];
const mapVec = (v: readonly number[], fn: (x: number, i: number) => number): Vec4 => [fn(v[0] ?? 0, 0), fn(v[1] ?? 0, 1), fn(v[2] ?? 0, 2), fn(v[3] ?? 0, 3)];
const zipVec = (a: readonly number[], b: readonly number[], fn: (x: number, y: number) => number): Vec4 => [
    fn(a[0] ?? 0, b[0] ?? 0), fn(a[1] ?? 0, b[1] ?? 0), fn(a[2] ?? 0, b[2] ?? 0), fn(a[3] ?? 0, b[3] ?? 0),
];

function sourceModifier(v: Vec4, modifier: number): Vec4 {
    switch (modifier) {
        case SrcMod.NEG: return mapVec(v, x => -x);
        case SrcMod.BIAS: return mapVec(v, x => x - 0.5);
        case SrcMod.BIASNEG: return mapVec(v, x => 0.5 - x);
        case SrcMod.SIGN: return mapVec(v, x => x * 2 - 1);
        case SrcMod.SIGNNEG: return mapVec(v, x => 1 - x * 2);
        case SrcMod.COMP: return mapVec(v, x => 1 - x);
        case SrcMod.X2: return mapVec(v, x => x * 2);
        case SrcMod.X2NEG: return mapVec(v, x => -x * 2);
        // D3D's _dz/_dw modifiers divide the complete source vector by z/w. They are
        // principally used by legacy projective vertex paths; replacing w with one (the old
        // approximation) changes both POSITIONT and any subsequent arithmetic.
        case SrcMod.DZ: { const d = v[2]; return mapVec(v, x => d === 0 ? 0 : x / d); }
        case SrcMod.DW: { const d = v[3]; return mapVec(v, x => d === 0 ? 0 : x / d); }
        case SrcMod.ABS: return mapVec(v, x => Math.abs(x));
        case SrcMod.ABSNEG: return mapVec(v, x => -Math.abs(x));
        case SrcMod.NOT: return mapVec(v, x => x === 0 ? 1 : 0);
        default: return v;
    }
}

function swizzle(v: Vec4, code: number): Vec4 {
    return [
        v[(code >>> 0) & 3] ?? 0,
        v[(code >>> 2) & 3] ?? 0,
        v[(code >>> 4) & 3] ?? 0,
        v[(code >>> 6) & 3] ?? 0,
    ];
}

function compare(a: number, b: number, op: SmInstruction["comparison"]): boolean {
    switch (op) {
        case "gt": return a > b;
        case "eq": return a === b;
        case "ge": return a >= b;
        case "lt": return a < b;
        case "ne": return a !== b;
        case "le": return a <= b;
        default: return a !== 0;
    }
}

function outputKey(reg: SmRegister): string {
    return `${reg.type}:${reg.num}`;
}

function semanticOutputKey(usage: number, usageIndex: number): string {
    return `${usage}:${usageIndex}`;
}

function semanticKey(usage: number, usageIndex: number): string {
    return semanticOutputKey(usage, usageIndex);
}

/** SM2 vertex shaders have no dcl instructions.  D3D9's fixed declaration
 * register convention is still observable by ProcessVertices: the first
 * seven input registers are position/blend-weight/blend-index/normal/psize/
 * texcoord..., with later texcoords continuing at v5. */
function legacyInputRegister(e: RawVertexElement): number | null {
    switch (e.usage) {
        case D3DDECLUSAGE_POSITION: return 0;
        case 1: return 1; // BLENDWEIGHT
        case 2: return 2; // BLENDINDICES
        case D3DDECLUSAGE_NORMAL: return 3;
        case 4: return 4; // PSIZE
        case D3DDECLUSAGE_TEXCOORD: return 5 + e.usageIndex;
        case 6: return 13; // TANGENT
        case 7: return 14; // BINORMAL
        default: return null;
    }
}

function readShaderSource(
    source: SmSource,
    regs: Map<string, Vec4>,
    constantsF: Float32Array,
    constantsI: Int32Array,
    constantsB: Uint8Array,
    address: number,
): Vec4 {
    let base: Vec4;
    const r = source.reg;
    switch (r.type) {
        case RegType.CONST:
        case RegType.CONST2:
        case RegType.CONST3:
        case RegType.CONST4: {
            const index = Math.max(0, (r.num + (r.type - RegType.CONST) * 2048) + (r.relative ? address : 0));
            const off = index * 4;
            base = [constantsF[off] ?? 0, constantsF[off + 1] ?? 0, constantsF[off + 2] ?? 0, constantsF[off + 3] ?? 0];
            break;
        }
        case RegType.CONSTINT: {
            const off = r.num * 4;
            base = [constantsI[off] ?? 0, constantsI[off + 1] ?? 0, constantsI[off + 2] ?? 0, constantsI[off + 3] ?? 0];
            break;
        }
        case RegType.CONSTBOOL:
            base = [constantsB[r.num] ? 1 : 0, 0, 0, 0];
            break;
        default:
            base = cloneVec(regs.get(outputKey(r)) ?? vec());
            break;
    }
    return sourceModifier(swizzle(base, source.swizzle), source.modifier);
}

/** Resolve the register used by an SM2/3 relative source token.  The parser
 * keeps the second (index-register) token on `relReg`; older SM1 streams use
 * the implicit a0 register.  Keeping this lookup here makes the CPU path obey
 * the same relative-constant ABI as the shader emitter instead of silently
 * reading a stale global address. */
function relativeAddress(source: SmSource, regs: Map<string, Vec4>, fallback: number): number {
    if (!source.reg.relative) return 0;
    const rel = source.relReg ?? { type: RegType.ADDR, num: 0, relative: false };
    const value = regs.get(outputKey(rel)) ?? regs.get(`${RegType.ADDR}:0`) ?? vec(fallback);
    const swz = source.relSwizzle ?? 0;
    const lane = Math.max(0, Math.min(3, (swz >>> 0) & 3));
    return Math.trunc(value[lane] ?? fallback);
}

function writeShaderDestination(
    dst: NonNullable<SmInstruction["dst"]>, value: Vec4, regs: Map<string, Vec4>, address: number,
): void {
    // SM3 permits relative output/temp destinations (o[a0.x], r[a0.x]). Resolve the same
    // explicit index-register token used by relative source operands before applying the mask.
    const target = dst.reg.relative
        ? { ...dst.reg, num: dst.reg.num + relativeAddress({
            reg: dst.reg, swizzle: 0xe4, modifier: SrcMod.NONE,
            relReg: dst.relReg, relSwizzle: dst.relSwizzle,
        }, regs, address), relative: false }
        : dst.reg;
    const key = outputKey(target);
    const old = regs.get(key) ?? vec();
    const out = [...old] as Vec4;
    for (let lane = 0; lane < 4; lane++) {
        if ((dst.writeMask & (1 << lane)) === 0) continue;
        let v = value[lane] ?? 0;
        if (dst.shift > 0) v *= 2 ** dst.shift;
        else if (dst.shift < 0) v /= 2 ** (-dst.shift);
        if (dst.saturate) v = Math.max(0, Math.min(1, v));
        out[lane] = v;
    }
    regs.set(key, out);
}

function sourceAt(sources: SmSource[], index: number, regs: Map<string, Vec4>, f: Float32Array, i: Int32Array, b: Uint8Array, address: number): Vec4 {
    const source = sources[index];
    if (!source) return vec();
    return readShaderSource(source, regs, f, i, b, relativeAddress(source, regs, address));
}

/** Validate structured flow before running any vertex. Texture and loop
 * instructions are rejected by the opcode set above; accepting an unmatched
 * ELSE/ENDIF here would otherwise make the interpreter silently choose a
 * different branch. */
function isSwvpFlowLegal(instructions: readonly SmInstruction[]): boolean {
    const flow: boolean[] = [];
    for (const ins of instructions) {
        switch (ins.opcode) {
            case Op.IF:
            case Op.IFC:
                flow.push(false);
                break;
            case Op.ELSE:
                if (flow.length === 0 || flow[flow.length - 1]) return false;
                flow[flow.length - 1] = true;
                break;
            case Op.ENDIF:
                if (flow.length === 0) return false;
                flow.pop();
                break;
            default:
                break;
        }
    }
    return flow.length === 0;
}

export function isSwvpProgramSupported(program: SmProgram): boolean {
    // ProcessVertices executes a vertex shader only. A truncated token stream
    // or a pixel program must never reach the per-vertex write loop.
    // BREAK* has defined behavior only inside LOOP/REP, and those loop opcodes are
    // outside this bounded interpreter, so BREAK* is absent from the supported set:
    // accepting it would silently terminate a vertex shader early.
    return !program.isPixelShader && program.terminated
        && program.instructions.every(ins => SWVP_SUPPORTED_OPS.has(ins.opcode))
        && isSwvpFlowLegal(program.instructions);
}

/** Execute a useful SM2/SM3 vertex subset on the CPU.  The interpreter intentionally
 * shares the parser IR with the WGSL backend, so ProcessVertices and draw-time shader
 * legality cannot drift in register decoding or source modifiers. */
function executeVertexShader(
    program: SmProgram,
    inputs: Map<number, Vec4>,
    constantsF: Float32Array,
    constantsI: Int32Array,
    constantsB: Uint8Array,
): Map<string, Vec4> | null {
    const regs = new Map<string, Vec4>();
    for (const [n, value] of inputs) regs.set(`${RegType.INPUT}:${n}`, value);
    for (const def of program.definitions) {
        const value = def.kind === "f" ? cloneVec(def.values) : def.kind === "i" ? cloneVec(def.rawInt) : vec(def.rawInt[0] ? 1 : 0, 0, 0, 0);
        regs.set(outputKey(def.reg), value);
    }
    let address = 0;
    const insns = program.instructions;
    const ifElse = new Map<number, number>();
    const elseFor = new Map<number, number>();
    const endifFor = new Map<number, number>();
    const stack: number[] = [];
    for (let n = 0; n < insns.length; n++) {
        const op = insns[n]!.opcode;
        if (op === Op.IF || op === Op.IFC) stack.push(n);
        else if (op === Op.ELSE && stack.length) { const start = stack[stack.length - 1]!; ifElse.set(start, n); elseFor.set(n, start); }
        else if (op === Op.ENDIF && stack.length) { const start = stack.pop()!; endifFor.set(start, n); }
    }
    if (!isSwvpProgramSupported(program)) return null;
    let pc = 0;
    let guard = 0;
    while (pc < insns.length && guard++ < 100000) {
        const ins = insns[pc]!;
        const src = (n: number) => sourceAt(ins.src, n, regs, constantsF, constantsI, constantsB, address);
        if (ins.opcode === Op.IF || ins.opcode === Op.IFC) {
            const a = src(0);
            const pass = ins.opcode === Op.IF ? a[0] !== 0 : compare(a[0], src(1)[0], ins.comparison);
            if (!pass) {
                const jump = ifElse.get(pc);
                const end = endifFor.get(pc);
                pc = (jump !== undefined ? jump + 1 : (end ?? pc) + 1);
                continue;
            }
        } else if (ins.opcode === Op.ELSE) {
            const start = elseFor.get(pc);
            pc = (start !== undefined ? (endifFor.get(start) ?? pc) + 1 : pc + 1);
            continue;
        } else if (ins.opcode === Op.ENDIF || ins.opcode === Op.NOP) { pc++; continue; }
        if (ins.opcode === Op.RET) break;
        if (ins.predicated && ins.predicate) {
            const predicate = sourceAt([ins.predicate], 0, regs, constantsF, constantsI, constantsB, address);
            if (!(predicate[0] !== 0)) { pc++; continue; }
        }
        if (ins.opcode === Op.DCL || !ins.dst && ins.opcode !== Op.MOVA) { pc++; continue; }
        const a = src(0), c = src(1), d = src(2);
        let value: Vec4 | null = null;
        switch (ins.opcode) {
            case Op.MOV: value = a; break;
            case Op.ADD: value = zipVec(a, c, (x, y) => x + y); break;
            case Op.SUB: value = zipVec(a, c, (x, y) => x - y); break;
            case Op.MUL: value = zipVec(a, c, (x, y) => x * y); break;
            case Op.MAD: value = zipVec(zipVec(a, c, (x, y) => x * y), d, (x, y) => x + y); break;
            case Op.MIN: value = zipVec(a, c, Math.min); break;
            case Op.MAX: value = zipVec(a, c, Math.max); break;
            case Op.SLT: value = zipVec(a, c, (x, y) => x < y ? 1 : 0); break;
            case Op.SGE: value = zipVec(a, c, (x, y) => x >= y ? 1 : 0); break;
            case Op.DP3: { const x = a[0] * c[0] + a[1] * c[1] + a[2] * c[2]; value = vec(x, x, x, x); break; }
            case Op.DP4: { const x = a[0] * c[0] + a[1] * c[1] + a[2] * c[2] + a[3] * c[3]; value = vec(x, x, x, x); break; }
            case Op.DP2ADD: { const x = a[0] * c[0] + a[1] * c[1] + d[0]; value = vec(x, x, x, x); break; }
            case Op.RCP: value = splat(a[0] === 0 ? SWVP_FLT_MAX : upperBoundF32(1 / a[0])); break;
            case Op.RSQ: value = splat(upperBoundF32(1 / Math.sqrt(Math.abs(a[0])))); break;
            case Op.EXP: value = splat(upperBoundF32(2 ** a[0])); break;
            case Op.EXPP: {
                const x = a[0];
                value = vec(upperBoundF32(2 ** Math.floor(x)), x - Math.floor(x), upperBoundF32(2 ** x), 1);
                break;
            }
            case Op.LOG: case Op.LOGP: value = splat(lowerBoundF32(Math.log2(Math.abs(a[0])))); break;
            case Op.POW: value = splat(c[0] === 0 ? 1 : Math.pow(Math.abs(a[0]), c[0])); break;
            case Op.ABS: value = mapVec(a, Math.abs); break;
            case Op.SGN: value = mapVec(a, x => x < 0 ? -1 : x > 0 ? 1 : 0); break;
            case Op.FRC: value = mapVec(a, x => x - Math.floor(x)); break;
            case Op.NRM: { const len = Math.hypot(a[0], a[1], a[2]); const k = len ? 1 / len : 0; value = vec(a[0] * k, a[1] * k, a[2] * k, 1); break; }
            case Op.CRS: value = vec(a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0], 1); break;
            case Op.LRP: value = [
                a[0] * c[0] + d[0] * (1 - a[0]),
                a[1] * c[1] + d[1] * (1 - a[1]),
                a[2] * c[2] + d[2] * (1 - a[2]),
                a[3] * c[3] + d[3] * (1 - a[3]),
            ]; break;
            case Op.CMP: value = [a[0] >= 0 ? c[0] : d[0], a[1] >= 0 ? c[1] : d[1], a[2] >= 0 ? c[2] : d[2], a[3] >= 0 ? c[3] : d[3]]; break;
            case Op.LIT: value = vec(1, Math.max(0, a[0]), a[0] > 0 ? Math.pow(Math.max(0, a[1]), a[3]) : 0, 1); break;
            case Op.DST: value = vec(1, a[1] * c[1], a[2], c[3]); break;
            case Op.CND: value = [a[0] > 0.5 ? c[0] : d[0], a[1] > 0.5 ? c[1] : d[1], a[2] > 0.5 ? c[2] : d[2], a[3] > 0.5 ? c[3] : d[3]]; break;
            case Op.SINCOS: value = vec(Math.cos(a[0]), Math.sin(a[0]), 0, 0); break;
            case Op.MOVA: address = roundAwayFromZero(a[0]); value = vec(address, address, address, address); break;
            case Op.SETP: {
                const pass = compare(a[0], c[0], ins.comparison);
                value = vec(pass ? 1 : 0, pass ? 1 : 0, pass ? 1 : 0, pass ? 1 : 0);
                break;
            }
            case Op.M4x4: case Op.M4x3: case Op.M3x4: case Op.M3x3: case Op.M3x2: {
                // The mnemonic is input-width x output-width. Matrix constants are laid out
                // as one row per output component (m3x4 therefore consumes 4 rows of 3-wide
                // dot products, while m4x3 consumes 3 rows of 4-wide dot products).
                const inputComponents = ins.opcode === Op.M4x4 || ins.opcode === Op.M4x3 ? 4 : 3;
                const outputComponents = ins.opcode === Op.M4x4 || ins.opcode === Op.M3x4 ? 4
                    : ins.opcode === Op.M3x2 ? 2 : 3;
                const out = vec();
                const matrixBase = ins.src[1]?.reg.num ?? 0;
                const matrixRelative = ins.src[1] ? relativeAddress(ins.src[1]!, regs, address) : 0;
                for (let row = 0; row < outputComponents; row++) {
                    const m = readShaderSource({ reg: { type: RegType.CONST, num: matrixBase + row, relative: false }, swizzle: 0xe4, modifier: SrcMod.NONE }, regs, constantsF, constantsI, constantsB, matrixRelative);
                    out[row] = a[0] * m[0] + a[1] * m[1] + a[2] * m[2]
                        + (inputComponents > 3 ? a[3] * m[3] : 0);
                }
                value = out; break;
            }
            default: return null;
        }
        if (value && ins.dst) writeShaderDestination(ins.dst, value, regs, address);
        pc++;
    }
    return guard >= 100000 ? null : regs;
}

function processProgrammableVertices(req: SwvpRequest): number {
    const program = req.shader;
    if (!program || !isSwvpProgramSupported(program)) return D3DERR_NOTAVAILABLE;
    if (!validViewport(req.viewport)) return D3DERR_INVALIDCALL;
    // A NULL declaration means SetFVF is active. Resolve the legacy v# mapping here so
    // programmable ProcessVertices has the same source ABI as the fixed-function path.
    const sourceElements = req.sourceElements ?? fvfSourceElements(req.sourceFvf);
    if (!sourceElements) return D3DERR_NOTAVAILABLE;
    const f = req.constantsF ?? new Float32Array(8192 * 4);
    const i = req.constantsI ?? new Int32Array(2048 * 4);
    const b = req.constantsB ?? new Uint8Array(2048);
    const dstElements = req.destElements.filter(e => e.type !== D3DDECLTYPE_UNUSED);
    const dstStride = outputStride(dstElements);
    if (dstStride <= 0 || dstElements.some(e => e.stream !== 0 || !validElement(e))) return D3DERR_NOTAVAILABLE;
    // Validate the complete source span before executing the first vertex. A malformed stream
    // must not turn an out-of-range read into a zero-filled v# and then partially write a
    // destination buffer; the native ProcessVertices contract fails the call atomically.
    for (const e of sourceElements) {
        if (!validElement(e)) return D3DERR_NOTAVAILABLE;
        const stream = req.streams[e.stream];
        if (!stream || stream.stride <= 0) return D3DERR_INVALIDCALL;
        const first = stream.offset + req.srcStartIndex * stream.stride + e.offset;
        const last = first + (req.vertexCount - 1) * stream.stride + declarationTypeBytes(e.type);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)
            || first < 0 || last < first || last > stream.data.byteLength) return D3DERR_INVALIDCALL;
    }
    const dstFirst = req.destIndex * dstStride;
    const dstLast = dstFirst + (Math.max(0, req.vertexCount - 1) * dstStride) + dstStride;
    if (!Number.isSafeInteger(dstFirst) || !Number.isSafeInteger(dstLast)
        || dstFirst < 0 || dstLast < dstFirst || dstLast > req.destData.byteLength) return D3DERR_INVALIDCALL;
    const dcls = program.declarations.filter(d => d.reg.type === RegType.INPUT);
    const outputDcls = program.declarations.filter(d => d.reg.type === RegType.OUTPUT);
    const srcBySemantic = new Map<string, RawVertexElement>();
    for (const e of sourceElements) srcBySemantic.set(semantic(e), e);
    // Stage exactly the destination span.  A late shader/output failure must
    // not leave earlier vertices visible to the caller.
    const staged = req.destData.slice(dstFirst, dstLast);
    const view = new DataView(staged.buffer, staged.byteOffset, staged.byteLength);
    const positionDcl = outputDcls.find(d =>
        (d.usage === D3DDECLUSAGE_POSITION || d.usage === D3DDECLUSAGE_POSITIONT)
        && d.usageIndex === 0);
    for (let n = 0; n < req.vertexCount; n++) {
        const inputs = new Map<number, Vec4>();
        if (dcls.length > 0) {
            for (const dcl of dcls) {
                const e = srcBySemantic.get(semanticKey(dcl.usage, dcl.usageIndex));
                const value = e ? readElement(e, req.streams, req.srcStartIndex + n) : null;
                inputs.set(dcl.reg.num, value && e ? shaderInputVector(e, value) : vec());
            }
        } else {
            for (const e of sourceElements) {
                const reg = legacyInputRegister(e);
                if (reg === null) continue;
                const value = readElement(e, req.streams, req.srcStartIndex + n);
                if (value) inputs.set(reg, shaderInputVector(e, value));
            }
        }
        const regs = executeVertexShader(program, inputs, f, i, b);
        if (!regs) return D3DERR_NOTAVAILABLE;
        const position = (positionDcl ? regs.get(outputKey(positionDcl.reg)) : undefined)
            ?? regs.get(`${RegType.RASTOUT}:0`) ?? regs.get(`${RegType.OUTPUT}:0`);
        if (!position) return D3DERR_INVALIDCALL;
        const dstBase = n * dstStride;
        for (const dst of dstElements) {
            let value: Value | null = null;
            const isPosition = (dst.usage === D3DDECLUSAGE_POSITION || dst.usage === D3DDECLUSAGE_POSITIONT)
                && dst.usageIndex === 0;
            if (isPosition) {
                const clip = position;
                if (dst.usage === D3DDECLUSAGE_POSITIONT) {
                    value = viewportPosition(clip, req.viewport);
                } else value = { components: [...clip] };
            } else {
                const dcl = outputDcls.find(d => d.usage === dst.usage && d.usageIndex === dst.usageIndex);
                if (dcl) {
                    const out = regs.get(outputKey(dcl.reg));
                    if (out) value = { components: [...out] };
                } else if (dst.usage === D3DDECLUSAGE_COLOR) {
                    const out = regs.get(`${RegType.ATTROUT}:${dst.usageIndex}`);
                    if (out) value = { components: [...out] };
                } else if (dst.usage === D3DDECLUSAGE_TEXCOORD) {
                    const out = regs.get(`${RegType.TEXCRDOUT}:${dst.usageIndex}`);
                    if (out) value = { components: [...out] };
                } else if (dst.usage === 11) {
                    const out = regs.get(`${RegType.RASTOUT}:1`);
                    if (out) value = { components: [...out] };
                }
            }
            // A programmable declaration with no corresponding shader output is
            // not a legal zero-fill request. Refuse instead of hiding the
            // missing semantic behind an empty vec4.
            if (!value || !writeValue(view, dstBase + dst.offset, dst.type, value)) return D3DERR_NOTAVAILABLE;
        }
    }
    req.destData.set(staged, dstFirst);
    return D3D_OK;
}

/** Execute the supported D3D9 fixed-function ProcessVertices subset. */
export function processSoftwareVertices(req: SwvpRequest): number {
    if (req.vertexCount === 0) return D3D_OK;
    if (req.flags & ~1) return D3DERR_NOTAVAILABLE;
    if (!validViewport(req.viewport)) return D3DERR_INVALIDCALL;
    if (req.shader) return processProgrammableVertices(req);
    // Refuse before any read or write: D3D9's fixed-function ProcessVertices also
    // lights, fogs and generates texture coordinates, and this processor does none
    // of those. Answering D3D_OK would hand the caller pre-transformed vertices
    // carrying the source's unlit colours with nothing to distinguish them.
    const ff = req.fixedFunction;
    if (ff && (ff.lighting || ff.fog || ff.texgen)) return D3DERR_NOTAVAILABLE;
    if (!Number.isSafeInteger(req.srcStartIndex) || !Number.isSafeInteger(req.destIndex) || !Number.isSafeInteger(req.vertexCount)
        || req.srcStartIndex < 0 || req.destIndex < 0 || req.vertexCount < 0) return D3DERR_INVALIDCALL;
    if (!validMatrix(req.mvp)) return D3DERR_INVALIDCALL;

    const sourceElements = req.sourceElements ?? fvfSourceElements(req.sourceFvf);
    if (!sourceElements || sourceElements.length === 0) return D3DERR_NOTAVAILABLE;
    const destElements = req.destElements.filter(e => e.type !== D3DDECLTYPE_UNUSED);
    if (destElements.length === 0 || destElements.some(e => e.stream !== 0 || !validElement(e))) return D3DERR_NOTAVAILABLE;
    const dstStride = outputStride(destElements);
    if (dstStride <= 0) return D3DERR_INVALIDCALL;

    const srcPos = findElement(sourceElements, D3DDECLUSAGE_POSITIONT, 0)
        ?? findElement(sourceElements, D3DDECLUSAGE_POSITION, 0);
    const dstPos = findElement(destElements, D3DDECLUSAGE_POSITIONT, 0)
        ?? findElement(destElements, D3DDECLUSAGE_POSITION, 0);
    if (!srcPos || !dstPos) return D3DERR_INVALIDCALL;
    const positionDestinations = destElements.filter(e =>
        (e.usage === D3DDECLUSAGE_POSITION || e.usage === D3DDECLUSAGE_POSITIONT)
        && e.usageIndex === 0);
    // The bounded FFP conversion has one transformed position representation;
    // silently leaving a second POSITION/POSITIONT field untouched is worse
    // than an explicit refusal.
    if (positionDestinations.length !== 1) return D3DERR_NOTAVAILABLE;

    // Validate every source field and the complete destination span before writing one byte.
    for (const e of sourceElements) {
        if (!validElement(e)) return D3DERR_NOTAVAILABLE;
        const stream = req.streams[e.stream];
        if (!stream || stream.stride <= 0) return D3DERR_INVALIDCALL;
        const first = stream.offset + req.srcStartIndex * stream.stride + e.offset;
        const last = first + (req.vertexCount - 1) * stream.stride + declarationTypeBytes(e.type);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)
            || first < 0 || last < first || last > stream.data.byteLength) return D3DERR_INVALIDCALL;
    }
    const dstFirst = req.destIndex * dstStride;
    const dstLast = dstFirst + (req.vertexCount - 1) * dstStride + dstStride;
    if (!Number.isSafeInteger(dstFirst) || !Number.isSafeInteger(dstLast)
        || dstFirst < 0 || dstLast < dstFirst || dstLast > req.destData.byteLength) return D3DERR_INVALIDCALL;

    const sourceBySemantic = new Map<string, RawVertexElement>();
    for (const e of sourceElements) sourceBySemantic.set(semantic(e), e);
    const m = req.mvp;
    const vp = req.viewport;
    const staged = req.destData.slice(dstFirst, dstLast);
    const dstView = new DataView(staged.buffer, staged.byteOffset, staged.byteLength);

    for (let i = 0; i < req.vertexCount; i++) {
        const srcVertex = req.srcStartIndex + i;
        const dstBase = i * dstStride;
        const pos = readPosition(srcPos, req.streams, srcVertex);
        if (!pos) return D3DERR_INVALIDCALL;
        let outputPos: Value | null;
        if (pos.preTransformed) {
            outputPos = { components: [pos.components[0]!, pos.components[1]!, pos.components[2]!, pos.components[3] ?? 1] };
        } else {
            const x = pos.components[0]!, y = pos.components[1]!, z = pos.components[2]!;
            const wIn = pos.components[3] ?? 1;
            const cx = x * m[0]! + y * m[4]! + z * m[8]! + wIn * m[12]!;
            const cy = x * m[1]! + y * m[5]! + z * m[9]! + wIn * m[13]!;
            const cz = x * m[2]! + y * m[6]! + z * m[10]! + wIn * m[14]!;
            const cw = x * m[3]! + y * m[7]! + z * m[11]! + wIn * m[15]!;
            outputPos = viewportPosition([cx, cy, cz, cw], vp);
        }
        if (!outputPos || !writeValue(dstView, dstBase + dstPos.offset, dstPos.type, outputPos)) return D3DERR_NOTAVAILABLE;

        for (const dst of destElements) {
            if (dst === dstPos || ((dst.usage === D3DDECLUSAGE_POSITION || dst.usage === D3DDECLUSAGE_POSITIONT)
                && dst.usageIndex === 0)) continue;
            const src = sourceBySemantic.get(semantic(dst));
            let value = src ? readElement(src, req.streams, srcVertex) : null;
            if (!value && dst.usage === D3DDECLUSAGE_NORMAL && dst.usageIndex === 0) value = { components: [0, 0, 1] };
            if (!value && dst.usage === D3DDECLUSAGE_COLOR) value = { components: [1, 1, 1, 1], rawColor: 0xffffffff };
            // There is no D3D-defined default for arbitrary declaration
            // semantics. Writing an empty vec4 would look successful while
            // dropping the attribute; refuse the unsupported copy instead.
            if (!value) return D3DERR_NOTAVAILABLE;
            if (!writeValue(dstView, dstBase + dst.offset, dst.type, value)) return D3DERR_NOTAVAILABLE;
        }
    }
    req.destData.set(staged, dstFirst);
    return D3D_OK;
}
