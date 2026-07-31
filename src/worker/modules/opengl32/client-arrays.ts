/**
 * Client vertex arrays — the gather behind glDrawArrays / glDrawElements /
 * glArrayElement, and EXT_compiled_vertex_array's lock cache.
 *
 * Vertices are produced as FLAT interleaved floats (VERT_FLOATS per vertex) written
 * straight into the caller's buffer: no per-vertex object, no per-draw array, and one
 * set of typed views over guest RAM per draw instead of a DataView per component.
 *
 * The indices are decoded ONCE into a scratch Uint32Array (which also yields the
 * touched [min,max] for free); every attribute pass then reads plain integers and
 * switches on its element type once per draw rather than once per component.
 */

import {
    OpenGLContext, GLArrayPointer, VERT_FLOATS, mat4Multiply,
} from "./context";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";
import { Logger, LogCategory } from "../../core/logger";
import {
    GL_FLOAT, GL_DOUBLE, GL_INT, GL_SHORT, GL_UNSIGNED_BYTE, GL_UNSIGNED_SHORT,
    GL_UNSIGNED_INT, GL_BYTE, GL_TEXTURE_GEN_S, GL_TEXTURE_GEN_T,
} from "./constants";

// Interleaved vertex layout (VERT_FLOATS floats):
//   0..3 position xyzw | 4..7 colour rgba | 8..10 normal | 11..12 tc0 | 13..14 tc1
const SLOT_POS = 0;
const SLOT_COLOR = 4;
const SLOT_NORMAL = 8;
const SLOT_TC0 = 11;
const SLOT_TC1 = 13;

const _mvpScratch = new Float32Array(16);

// ---------------------------------------------------------------------------
// Guest memory views
// ---------------------------------------------------------------------------

/**
 * Typed views over the live guest window. An element view exists only when the
 * window's byteOffset is aligned for it; a guest address `a` then indexes it as
 * `a >> shift`, and only when `a` itself is aligned. `dv` is the universal fallback.
 */
export interface GuestViews {
    u8: Uint8Array;
    dv: DataView;
    f32: Float32Array | null;
    u16: Uint16Array | null;
    u32: Uint32Array | null;
}

let _viewsBuffer: ArrayBufferLike | null = null;
let _viewsOffset = -1;
let _views: GuestViews | null = null;

/** Views over guest RAM for the current turn. Never hold the result across an await —
 *  a WASM growth detaches the buffer; the cache is keyed on buffer identity. */
export function guestViews(ctx: OpenGLContext): GuestViews {
    const mem = toPlainGuestMemory(ctx.process.getCurrentMemory());
    const off = mem.byteOffset;
    if (_views && _viewsBuffer === mem.buffer && _viewsOffset === off) return _views;
    const views: GuestViews = {
        u8: mem,
        dv: new DataView(mem.buffer, off),
        f32: (off & 3) === 0 ? new Float32Array(mem.buffer, off, mem.length >>> 2) : null,
        u16: (off & 1) === 0 ? new Uint16Array(mem.buffer, off, mem.length >>> 1) : null,
        u32: (off & 3) === 0 ? new Uint32Array(mem.buffer, off, mem.length >>> 2) : null,
    };
    _viewsBuffer = mem.buffer;
    _viewsOffset = off;
    _views = views;
    return views;
}

export function elemSize(type: number): number {
    switch (type) {
        case GL_DOUBLE: return 8;
        case GL_SHORT: case GL_UNSIGNED_SHORT: return 2;
        case GL_BYTE: case GL_UNSIGNED_BYTE: return 1;
        default: return 4; // GL_FLOAT, GL_INT, GL_UNSIGNED_INT and anything unrecognised
    }
}

/** One component at a guest address. `type` is loop-invariant at every call site. */
function readComp(v: GuestViews, addr: number, type: number): number {
    switch (type) {
        case GL_FLOAT: return (v.f32 !== null && (addr & 3) === 0) ? v.f32[addr >>> 2] : v.dv.getFloat32(addr, true);
        case GL_UNSIGNED_BYTE: return v.u8[addr];
        case GL_BYTE: return (v.u8[addr] << 24) >> 24;
        case GL_UNSIGNED_SHORT: return v.dv.getUint16(addr, true);
        case GL_SHORT: return v.dv.getInt16(addr, true);
        case GL_UNSIGNED_INT: return v.dv.getUint32(addr, true);
        case GL_INT: return v.dv.getInt32(addr, true);
        case GL_DOUBLE: return v.dv.getFloat64(addr, true);
        default: return 0;
    }
}

/**
 * Factor that maps a raw integer component onto the normalised range GL defines for
 * COLOUR and NORMAL arrays: unsigned types span [0,1], signed types [-1,1], both by
 * dividing by the type's largest positive value. Float and double components are
 * already in GL's units and pass through at scale 1, as do unrecognised types.
 *
 * Position and texture-coordinate arrays are NOT normalised — an integer there is the
 * coordinate itself — so they must never use this.
 */
export function normScale(type: number): number {
    switch (type) {
        case GL_UNSIGNED_BYTE: return 1 / 255;
        case GL_BYTE: return 1 / 127;
        case GL_UNSIGNED_SHORT: return 1 / 65535;
        case GL_SHORT: return 1 / 32767;
        case GL_UNSIGNED_INT: return 1 / 4294967295;
        case GL_INT: return 1 / 2147483647;
        default: return 1;
    }
}

/** Byte stride between consecutive elements of `arr` (stride 0 means tightly packed). */
function arrayStride(arr: GLArrayPointer, comps: number): number {
    return arr.stride > 0 ? arr.stride : comps * elemSize(arr.type);
}

// ---------------------------------------------------------------------------
// Draw-range validation
// ---------------------------------------------------------------------------

/**
 * The gather reads guest memory with an index the GUEST supplied, so the whole span a
 * draw will touch is validated ONCE here and the inner loops stay unchecked (§3.1).
 * Out of range the typed-array reads would yield undefined -> NaN vertices and the
 * DataView reads would throw a RangeError the dispatcher swallows: a silently dropped
 * draw with EAX never set, instead of a diagnosable fault.
 */
function arrayOutOfRange(
    arr: GLArrayPointer, comps: number, lo: number, hi: number,
    limit: number, space: { getRegion(a: number): { perms: string } | null } | undefined,
): boolean {
    if (comps <= 0) return true;
    const stride = arrayStride(arr, comps);
    const start = arr.pointer + lo * stride;
    const end = arr.pointer + hi * stride + comps * elemSize(arr.type);
    if (end > limit) return true;
    if (!space) return false;
    // A region the map knows to be unreadable is a hard reject; an address it has no
    // region for is not — plenty of legitimate guest buffers live outside the map.
    return space.getRegion(start)?.perms === "noaccess"
        || space.getRegion(end - 1)?.perms === "noaccess";
}

/**
 * True when every enabled array covers indices [lo,hi]. Call once per draw, before
 * gathering; a false answer must fail the draw with GL_INVALID_OPERATION.
 */
export function validateClientArrayRange(ctx: OpenGLContext, lo: number, hi: number): boolean {
    if (hi < lo) return true;
    if (lo < 0) return false;
    const limit = toPlainGuestMemory(ctx.process.getCurrentMemory()).length;
    const space = (ctx.process as unknown as {
        addressSpace?: { getRegion(a: number): { perms: string } | null };
    }).addressSpace;

    let bad = "";
    if (ctx.vertexArray.enabled && ctx.vertexArray.pointer
        && arrayOutOfRange(ctx.vertexArray, ctx.vertexArray.size, lo, hi, limit, space)) bad = "vertex";
    else if (ctx.colorArray.enabled && ctx.colorArray.pointer
        && arrayOutOfRange(ctx.colorArray, ctx.colorArray.size, lo, hi, limit, space)) bad = "color";
    else if (ctx.normalArray.enabled && ctx.normalArray.pointer
        && arrayOutOfRange(ctx.normalArray, 3, lo, hi, limit, space)) bad = "normal";
    else {
        for (let unit = 0; unit < ctx.texCoordArrays.length; unit++) {
            const arr = ctx.texCoordArrays[unit];
            if (arr.enabled && arr.pointer && arrayOutOfRange(arr, arr.size, lo, hi, limit, space)) {
                bad = `texcoord${unit}`;
                break;
            }
        }
    }
    if (!bad) return true;
    Logger.warn(LogCategory.SYSTEM,
        `opengl32: ${bad} array out of range for indices [${lo},${hi}] — draw dropped`);
    return false;
}

// ---------------------------------------------------------------------------
// Index decoding
// ---------------------------------------------------------------------------

let _indexScratch = new Uint32Array(8192);
let _idxMin = 0;
let _idxMax = 0;

/** Lowest / highest index of the most recent decode — the range a lock must cover. */
export function lastIndexMin(): number { return _idxMin; }
export function lastIndexMax(): number { return _idxMax; }

function ensureIndexScratch(n: number): Uint32Array {
    if (_indexScratch.length < n) {
        let len = _indexScratch.length;
        while (len < n) len *= 2;
        _indexScratch = new Uint32Array(len);
    }
    return _indexScratch;
}

/** Decode `count` indices of `type` at guest `ptr`; records the touched [min,max].
 *  Null for an index type GL does not define — the caller must raise GL_INVALID_ENUM. */
export function decodeIndices(v: GuestViews, ptr: number, type: number, count: number): Uint32Array | null {
    const out = ensureIndexScratch(count);
    let lo = 0xFFFFFFFF, hi = 0;
    switch (type) {
        case GL_UNSIGNED_INT:
            if (v.u32 !== null && (ptr & 3) === 0) {
                const src = v.u32, base = ptr >>> 2;
                for (let i = 0; i < count; i++) {
                    const x = src[base + i];
                    out[i] = x;
                    if (x < lo) lo = x;
                    if (x > hi) hi = x;
                }
            } else {
                const dv = v.dv;
                for (let i = 0; i < count; i++) {
                    const x = dv.getUint32(ptr + i * 4, true);
                    out[i] = x;
                    if (x < lo) lo = x;
                    if (x > hi) hi = x;
                }
            }
            break;
        case GL_UNSIGNED_SHORT:
            if (v.u16 !== null && (ptr & 1) === 0) {
                const src = v.u16, base = ptr >>> 1;
                for (let i = 0; i < count; i++) {
                    const x = src[base + i];
                    out[i] = x;
                    if (x < lo) lo = x;
                    if (x > hi) hi = x;
                }
            } else {
                const dv = v.dv;
                for (let i = 0; i < count; i++) {
                    const x = dv.getUint16(ptr + i * 2, true);
                    out[i] = x;
                    if (x < lo) lo = x;
                    if (x > hi) hi = x;
                }
            }
            break;
        case GL_UNSIGNED_BYTE: {
            const src = v.u8;
            for (let i = 0; i < count; i++) {
                const x = src[ptr + i];
                out[i] = x;
                if (x < lo) lo = x;
                if (x > hi) hi = x;
            }
            break;
        }
        default:
            // GL_INVALID_ENUM, and the draw is skipped entirely: a fan of `count`
            // vertex-0 copies is invisible garbage that also pins the CVA range to [0,0].
            _idxMin = 0;
            _idxMax = 0;
            return null;
    }
    _idxMin = count > 0 ? lo : 0;
    _idxMax = count > 0 ? hi : 0;
    return out;
}

/** Indices `first .. first+count-1`, for glDrawArrays / glArrayElement. */
export function sequentialIndices(first: number, count: number): Uint32Array {
    const out = ensureIndexScratch(count);
    for (let i = 0; i < count; i++) out[i] = first + i;
    _idxMin = first;
    _idxMax = count > 0 ? first + count - 1 : first;
    return out;
}

// ---------------------------------------------------------------------------
// Attribute gather (guest memory -> interleaved floats)
// ---------------------------------------------------------------------------

function gatherPosition(
    v: GuestViews, arr: GLArrayPointer, idx: Uint32Array, count: number,
    dst: Float32Array, dstBase: number,
): void {
    const size = arr.size, type = arr.type, ptr = arr.pointer;
    const es = elemSize(type);
    const stride = arrayStride(arr, size);
    const V = VERT_FLOATS;

    if (type === GL_FLOAT && size === 3 && v.f32 !== null && ((ptr | stride) & 3) === 0) {
        const f = v.f32, base = ptr >>> 2, st = stride >>> 2;
        for (let i = 0; i < count; i++) {
            const s = base + idx[i] * st;
            const b = dstBase + i * V;
            dst[b] = f[s]; dst[b + 1] = f[s + 1]; dst[b + 2] = f[s + 2]; dst[b + 3] = 1;
        }
        return;
    }

    for (let i = 0; i < count; i++) {
        const a = ptr + idx[i] * stride;
        const b = dstBase + i * V;
        dst[b]     = size >= 1 ? readComp(v, a, type) : 0;
        dst[b + 1] = size >= 2 ? readComp(v, a + es, type) : 0;
        dst[b + 2] = size >= 3 ? readComp(v, a + 2 * es, type) : 0;
        dst[b + 3] = size >= 4 ? readComp(v, a + 3 * es, type) : 1;
    }
}

function gatherColor(
    v: GuestViews, arr: GLArrayPointer, idx: Uint32Array, count: number,
    dst: Float32Array, dstBase: number,
): void {
    const size = arr.size, type = arr.type, ptr = arr.pointer;
    const es = elemSize(type);
    const stride = arrayStride(arr, size);
    const V = VERT_FLOATS;
    const has1 = size >= 1, has2 = size >= 2, has3 = size >= 3, has4 = size >= 4;
    // An absent component defaults to 1.0 — already normalised, so never scaled.
    const sc = normScale(type);

    if (type === GL_UNSIGNED_BYTE) {
        const u = v.u8;
        for (let i = 0; i < count; i++) {
            const a = ptr + idx[i] * stride;
            const b = dstBase + i * V;
            dst[b + 4] = has1 ? u[a] * sc : 1;
            dst[b + 5] = has2 ? u[a + 1] * sc : 1;
            dst[b + 6] = has3 ? u[a + 2] * sc : 1;
            dst[b + 7] = has4 ? u[a + 3] * sc : 1;
        }
        return;
    }

    for (let i = 0; i < count; i++) {
        const a = ptr + idx[i] * stride;
        const b = dstBase + i * V;
        dst[b + 4] = has1 ? readComp(v, a, type) * sc : 1;
        dst[b + 5] = has2 ? readComp(v, a + es, type) * sc : 1;
        dst[b + 6] = has3 ? readComp(v, a + 2 * es, type) * sc : 1;
        dst[b + 7] = has4 ? readComp(v, a + 3 * es, type) * sc : 1;
    }
}

function gatherNormal(
    v: GuestViews, arr: GLArrayPointer, idx: Uint32Array, count: number,
    dst: Float32Array, dstBase: number,
): void {
    const type = arr.type, ptr = arr.pointer;
    const es = elemSize(type);
    // A normal array is three components whatever `size` happens to hold.
    const stride = arr.stride > 0 ? arr.stride : 3 * es;
    const V = VERT_FLOATS;

    if (type === GL_FLOAT && v.f32 !== null && ((ptr | stride) & 3) === 0) {
        const f = v.f32, base = ptr >>> 2, st = stride >>> 2;
        for (let i = 0; i < count; i++) {
            const s = base + idx[i] * st;
            const b = dstBase + i * V;
            dst[b + 8] = f[s]; dst[b + 9] = f[s + 1]; dst[b + 10] = f[s + 2];
        }
        return;
    }

    const sc = normScale(type);
    for (let i = 0; i < count; i++) {
        const a = ptr + idx[i] * stride;
        const b = dstBase + i * V;
        dst[b + 8] = readComp(v, a, type) * sc;
        dst[b + 9] = readComp(v, a + es, type) * sc;
        dst[b + 10] = readComp(v, a + 2 * es, type) * sc;
    }
}

function gatherTexCoord(
    v: GuestViews, arr: GLArrayPointer, idx: Uint32Array, count: number,
    dst: Float32Array, dstBase: number, slot: number,
): void {
    const size = arr.size, type = arr.type, ptr = arr.pointer;
    const es = elemSize(type);
    const stride = arrayStride(arr, size);
    const V = VERT_FLOATS;

    if (type === GL_FLOAT && size >= 2 && v.f32 !== null && ((ptr | stride) & 3) === 0) {
        const f = v.f32, base = ptr >>> 2, st = stride >>> 2;
        for (let i = 0; i < count; i++) {
            const s = base + idx[i] * st;
            const b = dstBase + i * V + slot;
            dst[b] = f[s]; dst[b + 1] = f[s + 1];
        }
        return;
    }

    for (let i = 0; i < count; i++) {
        const a = ptr + idx[i] * stride;
        const b = dstBase + i * V + slot;
        dst[b] = size >= 1 ? readComp(v, a, type) : 0;
        dst[b + 1] = size >= 2 ? readComp(v, a + es, type) : 0;
    }
}

/** Broadcast a constant into one attribute's slots — the disabled-array case. */
function fillConst2(dst: Float32Array, dstBase: number, count: number, slot: number,
                    c0: number, c1: number): void {
    for (let i = 0; i < count; i++) {
        const b = dstBase + i * VERT_FLOATS + slot;
        dst[b] = c0; dst[b + 1] = c1;
    }
}

function fillConst3(dst: Float32Array, dstBase: number, count: number, slot: number,
                    c: Float32Array): void {
    const c0 = c[0], c1 = c[1], c2 = c[2];
    for (let i = 0; i < count; i++) {
        const b = dstBase + i * VERT_FLOATS + slot;
        dst[b] = c0; dst[b + 1] = c1; dst[b + 2] = c2;
    }
}

function fillConst4(dst: Float32Array, dstBase: number, count: number, slot: number,
                    c0: number, c1: number, c2: number, c3: number): void {
    for (let i = 0; i < count; i++) {
        const b = dstBase + i * VERT_FLOATS + slot;
        dst[b] = c0; dst[b + 1] = c1; dst[b + 2] = c2; dst[b + 3] = c3;
    }
}

// ---------------------------------------------------------------------------
// EXT_compiled_vertex_array
// ---------------------------------------------------------------------------
//
// LockArraysEXT(first, count) is the application declaring that the CURRENTLY ENABLED
// arrays hold static data over [first, first+count) until UnlockArraysEXT — exactly so
// a driver can convert and transform each unique vertex once and reuse it across the
// draws that follow. Indexed draws reference each vertex several times over, so the
// locked range is typically much smaller than a draw's index count; that ratio, more
// than the number of draws per lock, is where the work goes.
//
// Soundness:
//  - Only arrays ENABLED AT LOCK TIME are cached. An array enabled afterwards was never
//    covered by the lock, and applications depend on that: a multipass renderer disables
//    its colour/texcoord arrays before locking precisely because it is about to rewrite
//    those buffers between passes.
//  - Each attribute's cache carries the array spec it was built from and is dropped the
//    moment size/type/stride/pointer/enable drifts, so re-pointing an array mid-lock can
//    never serve stale geometry.
//  - Cached positions are clip space, keyed on the MVP; a matrix change refills them.
//  - The cache is consulted only when the draw's whole index range lies inside the lock.
//  - NOTHING is cached outside a lock: between draws an application may legally rewrite
//    its arrays in place and we have no way to observe that.
//  - Correctness never depends on the lock. With glLockArraysEXT ignored entirely, every
//    draw takes the direct gather and renders identically.

const CVA_POS = 0, CVA_COLOR = 1, CVA_NORMAL = 2, CVA_TC0 = 3, CVA_TC1 = 4;
const CVA_ATTRIBS = 5;
/** Floats stored per vertex, per attribute slot. */
const CVA_COMPS = [4, 4, 3, 2, 2];
/** Interleaved-layout slot each attribute is gathered through / written back to. */
const CVA_SLOT = [SLOT_POS, SLOT_COLOR, SLOT_NORMAL, SLOT_TC0, SLOT_TC1];

interface GLCvaAttrib {
    /** Array was enabled when the lock was taken — the only arrays the lock covers. */
    covered: boolean;
    /** Array spec the cached data was built from; any drift invalidates it. */
    size: number; type: number; stride: number; pointer: number;
    data: Float32Array;
    /** Filled index window [first, end). Empty while end <= first. */
    first: number; end: number;
}

export interface GLCvaState {
    active: boolean;
    /** Locked vertex range. */
    first: number;
    count: number;
    attribs: GLCvaAttrib[];
    /** MVP the cached positions were transformed with. */
    mvp: Float32Array;
    mvpValid: boolean;
}

export function createCvaState(): GLCvaState {
    const attribs: GLCvaAttrib[] = [];
    for (let i = 0; i < CVA_ATTRIBS; i++) {
        attribs.push({
            covered: false, size: 0, type: 0, stride: 0, pointer: 0,
            data: new Float32Array(0), first: 0, end: 0,
        });
    }
    return { active: false, first: 0, count: 0, attribs, mvp: new Float32Array(16), mvpValid: false };
}

function ctxArray(ctx: OpenGLContext, slot: number): GLArrayPointer {
    switch (slot) {
        case CVA_POS: return ctx.vertexArray;
        case CVA_COLOR: return ctx.colorArray;
        case CVA_NORMAL: return ctx.normalArray;
        case CVA_TC0: return ctx.texCoordArrays[0];
        default: return ctx.texCoordArrays[1];
    }
}

/** Snapshot the enabled arrays and drop every cached window. */
export function cvaLock(ctx: OpenGLContext, first: number, count: number): void {
    const cva = ctx.cva;
    cva.active = count > 0;
    cva.first = first;
    cva.count = count;
    cva.mvpValid = false;
    for (let slot = 0; slot < CVA_ATTRIBS; slot++) {
        const arr = ctxArray(ctx, slot);
        const a = cva.attribs[slot];
        a.covered = arr.enabled && arr.pointer !== 0;
        a.size = arr.size; a.type = arr.type; a.stride = arr.stride; a.pointer = arr.pointer;
        a.first = 0; a.end = 0;
    }
}

export function cvaUnlock(ctx: OpenGLContext): void {
    const cva = ctx.cva;
    cva.active = false;
    cva.mvpValid = false;
    for (let slot = 0; slot < CVA_ATTRIBS; slot++) {
        const a = cva.attribs[slot];
        a.covered = false;
        a.first = 0; a.end = 0;
    }
}

/** True while `slot`'s cache may serve indices in [lo,hi]: locked, covered, spec intact. */
function cvaUsable(ctx: OpenGLContext, slot: number, lo: number, hi: number): boolean {
    const cva = ctx.cva;
    if (!cva.active) return false;
    if (lo < cva.first || hi >= cva.first + cva.count) return false;
    const a = cva.attribs[slot];
    if (!a.covered) return false;
    const arr = ctxArray(ctx, slot);
    return arr.enabled && arr.pointer === a.pointer && arr.size === a.size
        && arr.type === a.type && arr.stride === a.stride;
}

// The cache fill runs INSIDE a draw's gather, so it needs its own index and staging
// scratch: the draw's own index array and (for assembled modes) its destination are
// the shared draw-time scratches.
// Sized on first use: context.ts imports this module, so nothing here may read a
// context.ts binding (VERT_FLOATS) while the module graph is still initialising.
let _cvaIdx = new Uint32Array(4096);
let _cvaStage = new Float32Array(0);

/** Widen `slot`'s cached window to cover [lo,hi] and refill it. */
function cvaFill(ctx: OpenGLContext, v: GuestViews, slot: number, lo: number, hi: number): void {
    const cva = ctx.cva;
    const a = cva.attribs[slot];
    const populated = a.end > a.first;
    if (populated && lo >= a.first && hi < a.end) return;

    let first = populated ? Math.min(a.first, lo) : lo;
    let end = populated ? Math.max(a.end, hi + 1) : hi + 1;
    if (first < cva.first) first = cva.first;
    if (end > cva.first + cva.count) end = cva.first + cva.count;
    if (end <= first) { a.first = 0; a.end = 0; return; }

    const comps = CVA_COMPS[slot];
    const count = end - first;
    if (a.data.length < count * comps) a.data = new Float32Array(count * comps);
    if (_cvaIdx.length < count) _cvaIdx = new Uint32Array(count);
    if (_cvaStage.length < count * VERT_FLOATS) _cvaStage = new Float32Array(count * VERT_FLOATS);

    const idx = _cvaIdx, stage = _cvaStage;
    for (let i = 0; i < count; i++) idx[i] = first + i;

    const arr = ctxArray(ctx, slot);
    switch (slot) {
        case CVA_POS:
            gatherPosition(v, arr, idx, count, stage, 0);
            transformClipInPlace(ctx, stage, count);
            break;
        case CVA_COLOR: gatherColor(v, arr, idx, count, stage, 0); break;
        case CVA_NORMAL: gatherNormal(v, arr, idx, count, stage, 0); break;
        default: gatherTexCoord(v, arr, idx, count, stage, 0, CVA_SLOT[slot]); break;
    }

    const src = CVA_SLOT[slot];
    const data = a.data;
    for (let i = 0; i < count; i++) {
        const s = i * VERT_FLOATS + src;
        const d = i * comps;
        for (let k = 0; k < comps; k++) data[d + k] = stage[s + k];
    }
    a.first = first;
    a.end = end;
}

/** Object-space xyzw at slots 0..3 -> clip space, in place. */
function transformClipInPlace(ctx: OpenGLContext, buf: Float32Array, count: number): void {
    const m = ctx.cva.mvp;
    for (let i = 0; i < count; i++) {
        const b = i * VERT_FLOATS;
        const x = buf[b], y = buf[b + 1], z = buf[b + 2], w = buf[b + 3];
        buf[b]     = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
        buf[b + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
        buf[b + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
        buf[b + 3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    }
}

/** Copy `count` indexed vertices out of `slot`'s cache into the interleaved buffer. */
function gatherFromCache(
    ctx: OpenGLContext, slot: number, idx: Uint32Array, count: number,
    dst: Float32Array, dstBase: number, dstSlot: number,
): void {
    const a = ctx.cva.attribs[slot];
    const data = a.data;
    const first = a.first;
    const V = VERT_FLOATS;
    switch (CVA_COMPS[slot]) {
        case 4:
            for (let i = 0; i < count; i++) {
                const s = (idx[i] - first) * 4;
                const b = dstBase + i * V + dstSlot;
                dst[b] = data[s]; dst[b + 1] = data[s + 1]; dst[b + 2] = data[s + 2]; dst[b + 3] = data[s + 3];
            }
            break;
        case 3:
            for (let i = 0; i < count; i++) {
                const s = (idx[i] - first) * 3;
                const b = dstBase + i * V + dstSlot;
                dst[b] = data[s]; dst[b + 1] = data[s + 1]; dst[b + 2] = data[s + 2];
            }
            break;
        default:
            for (let i = 0; i < count; i++) {
                const s = (idx[i] - first) * 2;
                const b = dstBase + i * V + dstSlot;
                dst[b] = data[s]; dst[b + 1] = data[s + 1];
            }
            break;
    }
}

/** Recompute the MVP; a change since the last fill drops the clip-space positions. */
function refreshCvaMvp(ctx: OpenGLContext): void {
    const cva = ctx.cva;
    mat4Multiply(_mvpScratch,
        ctx.projectionStack.stack[ctx.projectionStack.top],
        ctx.modelviewStack.stack[ctx.modelviewStack.top]);
    if (cva.mvpValid) {
        let same = true;
        for (let i = 0; i < 16; i++) {
            if (cva.mvp[i] !== _mvpScratch[i]) { same = false; break; }
        }
        if (same) return;
        const pos = cva.attribs[CVA_POS];
        pos.first = 0; pos.end = 0;
    }
    cva.mvp.set(_mvpScratch);
    cva.mvpValid = true;
}

// ---------------------------------------------------------------------------
// Draw-time entry point
// ---------------------------------------------------------------------------

let _gatherScratch = new Float32Array(0);

/** Reusable interleaved staging block for draws that still need primitive assembly. */
export function ensureGatherScratch(vertCount: number): Float32Array {
    const need = vertCount * VERT_FLOATS;
    if (_gatherScratch.length < need) {
        let len = Math.max(_gatherScratch.length, 4096 * VERT_FLOATS);
        while (len < need) len *= 2;
        _gatherScratch = new Float32Array(len);
    }
    return _gatherScratch;
}

/** Coordinate space the position slots came back in. */
export const enum VertexSpace { OBJECT = 0, CLIP = 1 }

/**
 * Gather `count` indexed vertices into `dst` as interleaved floats.
 *
 * Returns CLIP when the positions came from the compiled-vertex-array cache and are
 * already MVP-transformed — the caller must then skip its own transform. Everything
 * else, including every unlocked draw, comes back in OBJECT space.
 */
export function gatherVertices(
    ctx: OpenGLContext, idx: Uint32Array, count: number,
    dst: Float32Array, dstBase: number, allowClipCache: boolean,
): VertexSpace {
    if (count <= 0) return VertexSpace.OBJECT;
    const v = guestViews(ctx);
    const lo = _idxMin, hi = _idxMax;

    // Positions. The cache holds clip space, so it is ineligible whenever something
    // downstream still needs object space — texgen reads object position and normal.
    const texGen = ctx.enableFlags.has(GL_TEXTURE_GEN_S) || ctx.enableFlags.has(GL_TEXTURE_GEN_T);
    let space = VertexSpace.OBJECT;
    const posArr = ctx.vertexArray;
    if (allowClipCache && !texGen && cvaUsable(ctx, CVA_POS, lo, hi)) {
        refreshCvaMvp(ctx);
        cvaFill(ctx, v, CVA_POS, lo, hi);
        gatherFromCache(ctx, CVA_POS, idx, count, dst, dstBase, SLOT_POS);
        space = VertexSpace.CLIP;
    } else if (posArr.enabled && posArr.pointer) {
        gatherPosition(v, posArr, idx, count, dst, dstBase);
    } else {
        fillConst4(dst, dstBase, count, SLOT_POS, 0, 0, 0, 1);
    }

    const colArr = ctx.colorArray;
    if (colArr.enabled && colArr.pointer) {
        if (cvaUsable(ctx, CVA_COLOR, lo, hi)) {
            cvaFill(ctx, v, CVA_COLOR, lo, hi);
            gatherFromCache(ctx, CVA_COLOR, idx, count, dst, dstBase, SLOT_COLOR);
        } else {
            gatherColor(v, colArr, idx, count, dst, dstBase);
        }
    } else {
        const c = ctx.currentColor;
        fillConst4(dst, dstBase, count, SLOT_COLOR, c[0], c[1], c[2], c[3]);
    }

    const nrmArr = ctx.normalArray;
    if (nrmArr.enabled && nrmArr.pointer) {
        if (cvaUsable(ctx, CVA_NORMAL, lo, hi)) {
            cvaFill(ctx, v, CVA_NORMAL, lo, hi);
            gatherFromCache(ctx, CVA_NORMAL, idx, count, dst, dstBase, SLOT_NORMAL);
        } else {
            gatherNormal(v, nrmArr, idx, count, dst, dstBase);
        }
    } else {
        fillConst3(dst, dstBase, count, SLOT_NORMAL, ctx.currentNormal);
    }

    gatherUnit(ctx, v, idx, count, dst, dstBase, 0, CVA_TC0, SLOT_TC0, lo, hi);
    gatherUnit(ctx, v, idx, count, dst, dstBase, 1, CVA_TC1, SLOT_TC1, lo, hi);

    return space;
}

function gatherUnit(
    ctx: OpenGLContext, v: GuestViews, idx: Uint32Array, count: number,
    dst: Float32Array, dstBase: number,
    unit: number, cvaSlot: number, dstSlot: number, lo: number, hi: number,
): void {
    const arr = ctx.texCoordArrays[unit];
    if (arr.enabled && arr.pointer) {
        if (cvaUsable(ctx, cvaSlot, lo, hi)) {
            cvaFill(ctx, v, cvaSlot, lo, hi);
            gatherFromCache(ctx, cvaSlot, idx, count, dst, dstBase, dstSlot);
        } else {
            gatherTexCoord(v, arr, idx, count, dst, dstBase, dstSlot);
        }
    } else {
        fillConst2(dst, dstBase, count, dstSlot, 0, 0);
    }
}
