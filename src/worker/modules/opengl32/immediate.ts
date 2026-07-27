import { ThunkImplementation, WriteBufHandler } from "../../core/thunking/thunk-dispatcher";
import {
    OpenGLContext, GLDrawCommandType, mat4Multiply, VERT_FLOATS,
    CMD_I32, CMD_F32,
    CI_MODE, CI_VERT_OFFSET, CI_VERT_COUNT, CI_FLAGS, CI_DEPTH_FUNC, CI_BLEND_SRC, CI_BLEND_DST,
    CI_ALPHA_FUNC, CI_CULL_FACE, CI_FRONT_FACE, CI_TEX_ID0, CI_TEX_ID1, CI_TEXENV0, CI_TEXENV1,
    CI_SHADE_MODEL, CI_FOG_MODE, CI_POLYGON_MODE, CI_STENCIL_FUNC, CI_STENCIL_REF, CI_STENCIL_MASK,
    CI_STENCIL_FAIL, CI_STENCIL_ZFAIL, CI_STENCIL_ZPASS, CI_STENCIL_WRITE_MASK,
    CI_SCISSOR_X, CI_SCISSOR_Y, CI_SCISSOR_W, CI_SCISSOR_H, CI_VP_X, CI_VP_Y, CI_VP_W, CI_VP_H,
    CF_ALPHA_REF, CF_FOG_R, CF_FOG_G, CF_FOG_B, CF_FOG_A, CF_FOG_DENSITY, CF_FOG_START, CF_FOG_END,
    CF_DEPTH_RANGE_NEAR, CF_DEPTH_RANGE_FAR,
    DF_DEPTH_TEST, DF_DEPTH_MASK, DF_BLEND, DF_ALPHA_TEST, DF_CULL, DF_FOG,
    DF_COLOR_MASK_R, DF_COLOR_MASK_G, DF_COLOR_MASK_B, DF_COLOR_MASK_A, DF_STENCIL_TEST, DF_SCISSOR,
} from "./context";
import {
    GL_TRIANGLES, GL_TRIANGLE_STRIP, GL_TRIANGLE_FAN, GL_QUADS, GL_QUAD_STRIP,
    GL_POLYGON, GL_POINTS, GL_LINES, GL_LINE_STRIP, GL_LINE_LOOP,
    GL_INVALID_OPERATION,
    GL_TEXTURE_GEN_S, GL_TEXTURE_GEN_T,
    GL_OBJECT_LINEAR, GL_EYE_LINEAR, GL_SPHERE_MAP, GL_STENCIL_TEST,
} from "./constants";
import { Logger, LogCategory } from "../../core/logger";
import { asArrayBuffer } from "../../../dom-buffer";

const _f32ab = new ArrayBuffer(4);
const _f32dv = new DataView(_f32ab);
export function bitsToF32(bits: number): number {
    _f32dv.setUint32(0, bits >>> 0, true);
    return _f32dv.getFloat32(0, true);
}

// Module-level scratch buffers — zero allocations on hot paths
const _mvpScratch = new Float32Array(16);

// Cached DataView for guest memory — recreate only when buffer changes
let _cachedDVBuf: ArrayBuffer | null = null;
let _cachedDV: DataView | null = null;

function getMemDV(ctx: OpenGLContext): DataView {
    const mem = ctx.process.getCurrentMemory();
    if (mem.buffer !== _cachedDVBuf) {
        _cachedDVBuf = asArrayBuffer(mem.buffer);
        _cachedDV = new DataView(mem.buffer, mem.byteOffset);
    }
    return _cachedDV!;
}

// Helper to read from guest memory without null-returning Mem API
function getMem(ctx: OpenGLContext): Uint8Array { return ctx.process.getCurrentMemory(); }

function pushVertex(ctx: OpenGLContext, x: number, y: number, z: number, w: number): void {
    let buf = ctx.immediateFlatBuf;
    const base = ctx.immediateFlatCount * VERT_FLOATS;
    // Grow if needed
    if (base + VERT_FLOATS > buf.length) {
        const newBuf = new Float32Array(buf.length * 2);
        newBuf.set(buf);
        ctx.immediateFlatBuf = newBuf;
        buf = newBuf;
    }
    const b = ctx.immediateFlatCount * VERT_FLOATS;
    buf[b]    = x;  buf[b+1]  = y;  buf[b+2]  = z;  buf[b+3]  = w;
    buf[b+4]  = ctx.currentColor[0];  buf[b+5]  = ctx.currentColor[1];
    buf[b+6]  = ctx.currentColor[2];  buf[b+7]  = ctx.currentColor[3];
    buf[b+8]  = ctx.currentNormal[0]; buf[b+9]  = ctx.currentNormal[1]; buf[b+10] = ctx.currentNormal[2];
    buf[b+11] = ctx.currentTexCoord[0][0]; buf[b+12] = ctx.currentTexCoord[0][1];
    buf[b+13] = ctx.currentTexCoord[1][0]; buf[b+14] = ctx.currentTexCoord[1][1];
    ctx.immediateFlatCount++;
}

/** Reserve one vertex in the immediate buffer and return its float offset; the caller
 *  writes all VERT_FLOATS slots. Used by glArrayElement, which gathers straight in. */
export function immediateReserveVertex(ctx: OpenGLContext): number {
    const base = ctx.immediateFlatCount * VERT_FLOATS;
    if (base + VERT_FLOATS > ctx.immediateFlatBuf.length) {
        const newBuf = new Float32Array(ctx.immediateFlatBuf.length * 2);
        newBuf.set(ctx.immediateFlatBuf);
        ctx.immediateFlatBuf = newBuf;
    }
    ctx.immediateFlatCount++;
    return base;
}

/** Copy one 15-float vertex. Explicit stores, not subarray()/set(): the view pair
 *  allocated per vertex dominated primitive assembly. */
function copyVert(src: Float32Array, srcVert: number, dst: Float32Array, d: number): void {
    const s = srcVert * VERT_FLOATS;
    dst[d]    = src[s];    dst[d+1]  = src[s+1];  dst[d+2]  = src[s+2];  dst[d+3]  = src[s+3];
    dst[d+4]  = src[s+4];  dst[d+5]  = src[s+5];  dst[d+6]  = src[s+6];  dst[d+7]  = src[s+7];
    dst[d+8]  = src[s+8];  dst[d+9]  = src[s+9];  dst[d+10] = src[s+10];
    dst[d+11] = src[s+11]; dst[d+12] = src[s+12]; dst[d+13] = src[s+13]; dst[d+14] = src[s+14];
}

/**
 * Exact assembled vertex count for `mode`/`srcCount`. MUST stay in lockstep with
 * assembleFlatVerts' loop bounds — the arena reserve is sized from it.
 */
export function assembledVertCount(mode: number, srcCount: number): number {
    switch (mode) {
        case GL_TRIANGLES:      return srcCount - (srcCount % 3);
        case GL_TRIANGLE_STRIP:
        case GL_TRIANGLE_FAN:
        case GL_POLYGON:        return srcCount >= 3 ? (srcCount - 2) * 3 : 0;
        case GL_QUADS:          return ((srcCount / 4) | 0) * 6;
        case GL_QUAD_STRIP:     return srcCount >= 4 ? (((srcCount - 2) / 2) | 0) * 6 : 0;
        default:                return srcCount;
    }
}

export function assembleFlatVerts(
    src: Float32Array, srcCount: number, mode: number, dst: Float32Array, dstOffset = 0,
): number {
    const V = VERT_FLOATS;
    let d = dstOffset;
    switch (mode) {
        case GL_TRIANGLES:
            for (let i = 0; i + 2 < srcCount; i += 3) {
                copyVert(src, i, dst, d); d += V;
                copyVert(src, i+1, dst, d); d += V;
                copyVert(src, i+2, dst, d); d += V;
            }
            break;
        case GL_TRIANGLE_STRIP:
            for (let i = 0; i + 2 < srcCount; i++) {
                if ((i & 1) === 0) {
                    copyVert(src, i, dst, d); d += V;
                    copyVert(src, i+1, dst, d); d += V;
                } else {
                    copyVert(src, i+1, dst, d); d += V;
                    copyVert(src, i, dst, d); d += V;
                }
                copyVert(src, i+2, dst, d); d += V;
            }
            break;
        case GL_TRIANGLE_FAN:
        case GL_POLYGON:
            for (let i = 1; i + 1 < srcCount; i++) {
                copyVert(src, 0, dst, d); d += V;
                copyVert(src, i, dst, d); d += V;
                copyVert(src, i+1, dst, d); d += V;
            }
            break;
        case GL_QUADS:
            for (let i = 0; i + 3 < srcCount; i += 4) {
                copyVert(src, i, dst, d); d += V;
                copyVert(src, i+1, dst, d); d += V;
                copyVert(src, i+2, dst, d); d += V;
                copyVert(src, i, dst, d); d += V;
                copyVert(src, i+2, dst, d); d += V;
                copyVert(src, i+3, dst, d); d += V;
            }
            break;
        case GL_QUAD_STRIP:
            for (let i = 0; i + 3 < srcCount; i += 2) {
                copyVert(src, i, dst, d); d += V;
                copyVert(src, i+1, dst, d); d += V;
                copyVert(src, i+2, dst, d); d += V;
                copyVert(src, i+2, dst, d); d += V;
                copyVert(src, i+1, dst, d); d += V;
                copyVert(src, i+3, dst, d); d += V;
            }
            break;
        default:
            // GL_POINTS, GL_LINES, GL_LINE_STRIP, GL_LINE_LOOP: pass through
            for (let i = 0; i < srcCount; i++) { copyVert(src, i, dst, d); d += V; }
            break;
    }
    return (d - dstOffset) / V;
}

let transformDiagCount = 0;

export function transformFlatVerts(ctx: OpenGLContext, buf: Float32Array, offset: number, count: number): void {
    const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];
    const proj = ctx.projectionStack.stack[ctx.projectionStack.top];
    mat4Multiply(_mvpScratch, proj, mv);
    const m = _mvpScratch;

    if (transformDiagCount < 2 && count > 0) {
        transformDiagCount++;
        const b0 = offset;
        Logger.log(LogCategory.SYSTEM,
            `[GL TRANSFORM] verts=${count} viewport=(${ctx.viewportX},${ctx.viewportY},${ctx.viewportW}x${ctx.viewportH}) ` +
            `obj_v0=(${buf[b0].toFixed(1)},${buf[b0+1].toFixed(1)},${buf[b0+2].toFixed(1)},${buf[b0+3].toFixed(1)})`);
        Logger.log(LogCategory.SYSTEM,
            `  proj=[${Array.from(proj).map(v => v.toFixed(4)).join(',')}]`);
        Logger.log(LogCategory.SYSTEM,
            `  mv=[${Array.from(mv).map(v => v.toFixed(4)).join(',')}]`);
        Logger.log(LogCategory.SYSTEM,
            `  mvp=[${Array.from(m).map(v => v.toFixed(4)).join(',')}]`);
    }

    // Output clip-space coordinates directly — GPU handles perspective divide,
    // near/far plane clipping, and viewport transform via setViewport().
    for (let i = 0; i < count; i++) {
        const b = offset + i * VERT_FLOATS;
        const x = buf[b], y = buf[b+1], z = buf[b+2], w = buf[b+3];
        buf[b]   = m[0]*x + m[4]*y + m[8]*z  + m[12]*w;  // clip.x
        buf[b+1] = m[1]*x + m[5]*y + m[9]*z  + m[13]*w;  // clip.y
        buf[b+2] = m[2]*x + m[6]*y + m[10]*z + m[14]*w;  // clip.z
        buf[b+3] = m[3]*x + m[7]*y + m[11]*z + m[15]*w;  // clip.w
    }
}

function computeTexGenCoordFlat(
    mode: number, objPlane: Float32Array, eyePlane: Float32Array,
    coordIndex: number,
    ox: number, oy: number, oz: number, ow: number, // object pos
    ex: number, ey: number, ez: number,              // eye-space pos
    enx: number, eny: number, enz: number,           // eye-space normal
): number {
    switch (mode) {
        case GL_OBJECT_LINEAR:
            return objPlane[0]*ox + objPlane[1]*oy + objPlane[2]*oz + objPlane[3]*ow;
        case GL_EYE_LINEAR:
            return eyePlane[0]*ex + eyePlane[1]*ey + eyePlane[2]*ez + eyePlane[3];
        case GL_SPHERE_MAP: {
            const elen = Math.sqrt(ex*ex + ey*ey + ez*ez);
            const invE = elen > 1e-8 ? 1/elen : 0;
            const ux = ex*invE, uy = ey*invE, uz = ez*invE;
            const dot2 = 2*(ux*enx + uy*eny + uz*enz);
            const rx = ux - dot2*enx;
            const ry = uy - dot2*eny;
            const rz = uz - dot2*enz + 1;
            const mm = 2*Math.sqrt(rx*rx + ry*ry + rz*rz);
            if (mm < 1e-8) return 0.5;
            return (coordIndex === 0 ? rx : ry) / mm + 0.5;
        }
        default:
            return 0;
    }
}

export function applyTexGenFlat(ctx: OpenGLContext, buf: Float32Array, offset: number, count: number): void {
    const genS = ctx.enableFlags.has(GL_TEXTURE_GEN_S);
    const genT = ctx.enableFlags.has(GL_TEXTURE_GEN_T);
    if (!genS && !genT) return;

    const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];

    for (let i = 0; i < count; i++) {
        const b = offset + i * VERT_FLOATS;
        const ox = buf[b], oy = buf[b+1], oz = buf[b+2], ow = buf[b+3];
        const onx = buf[b+8], ony = buf[b+9], onz = buf[b+10];

        // Eye-space position
        const ex = mv[0]*ox + mv[4]*oy + mv[8]*oz  + mv[12]*ow;
        const ey = mv[1]*ox + mv[5]*oy + mv[9]*oz  + mv[13]*ow;
        const ez = mv[2]*ox + mv[6]*oy + mv[10]*oz + mv[14]*ow;

        // Eye-space normal
        let enx = mv[0]*onx + mv[4]*ony + mv[8]*onz;
        let eny = mv[1]*onx + mv[5]*ony + mv[9]*onz;
        let enz = mv[2]*onx + mv[6]*ony + mv[10]*onz;
        const nlen = Math.sqrt(enx*enx + eny*eny + enz*enz);
        if (nlen > 1e-8) { enx /= nlen; eny /= nlen; enz /= nlen; }

        if (genS) buf[b+11] = computeTexGenCoordFlat(ctx.texGenS.mode, ctx.texGenS.objectPlane, ctx.texGenS.eyePlane, 0, ox, oy, oz, ow, ex, ey, ez, enx, eny, enz);
        if (genT) buf[b+12] = computeTexGenCoordFlat(ctx.texGenT.mode, ctx.texGenT.objectPlane, ctx.texGenT.eyePlane, 1, ox, oy, oz, ow, ex, ey, ez, enx, eny, enz);
    }
}

/**
 * Merging two consecutive draws concatenates their vertex ranges into one draw.
 * That is only equivalent for topologies whose primitives are self-contained:
 * a line strip/loop would gain a segment joining the two ranges. Everything else
 * (points, line lists, and every triangle-ish mode — assembleFlatVerts has already
 * expanded those to triangle lists) is safe.
 */
function isMergeableMode(mode: number): boolean {
    return mode !== GL_LINE_STRIP && mode !== GL_LINE_LOOP;
}

/**
 * Vertices per primitive in the assembled stream. Concatenation is only safe on a
 * primitive boundary — an odd-length GL_LINES range would otherwise gain a segment
 * joining its dangling vertex to the next range's first.
 */
function mergePrimStride(mode: number): number {
    if (mode === GL_POINTS) return 1;
    if (mode === GL_LINES) return 2;
    return 3; // every triangle-ish mode has been expanded to a triangle list
}

/** True when two DRAW records differ only in their vertex range. */
function drawStateEqual(i32: Int32Array, f32: Float32Array, a: number, b: number): boolean {
    const ai = a * CMD_I32, bi = b * CMD_I32;
    if (i32[ai + CI_MODE] !== i32[bi + CI_MODE]) return false;
    for (let k = CI_FLAGS; k < CMD_I32; k++) {
        if (i32[ai + k] !== i32[bi + k]) return false;
    }
    const af = a * CMD_F32, bf = b * CMD_F32;
    for (let k = 0; k < CMD_F32; k++) {
        if (f32[af + k] !== f32[bf + k]) return false;
    }
    return true;
}

function pushGLDrawCommand(ctx: OpenGLContext, mode: number, vertOffset: number, vertCount: number): void {
    const unit0 = ctx.textureUnits[0];
    const unit1 = ctx.textureUnits[1];
    const fc = ctx.fogColor;
    const en = ctx.enableFlags;

    let flags = 0;
    if (en.has(0x0B71)) flags |= DF_DEPTH_TEST;
    if (ctx.depthMask) flags |= DF_DEPTH_MASK;
    if (en.has(0x0BE2)) flags |= DF_BLEND;
    if (en.has(0x0BC0)) flags |= DF_ALPHA_TEST;
    if (en.has(0x0B44)) flags |= DF_CULL;
    if (en.has(0x0B60)) flags |= DF_FOG;
    if (ctx.colorMaskR) flags |= DF_COLOR_MASK_R;
    if (ctx.colorMaskG) flags |= DF_COLOR_MASK_G;
    if (ctx.colorMaskB) flags |= DF_COLOR_MASK_B;
    if (ctx.colorMaskA) flags |= DF_COLOR_MASK_A;
    if (en.has(GL_STENCIL_TEST)) flags |= DF_STENCIL_TEST;
    if (en.has(0x0C11)) flags |= DF_SCISSOR;

    const stream = ctx.commands;
    const idx = stream.alloc(GLDrawCommandType.DRAW);
    const I = stream.i32, F = stream.f32;
    const i = idx * CMD_I32;
    const f = idx * CMD_F32;

    I[i + CI_MODE] = mode;
    I[i + CI_VERT_OFFSET] = vertOffset;
    I[i + CI_VERT_COUNT] = vertCount;
    I[i + CI_FLAGS] = flags;
    I[i + CI_DEPTH_FUNC] = ctx.depthFunc;
    I[i + CI_BLEND_SRC] = ctx.blendSrc;
    I[i + CI_BLEND_DST] = ctx.blendDst;
    I[i + CI_ALPHA_FUNC] = ctx.alphaFunc;
    I[i + CI_CULL_FACE] = ctx.cullFace;
    I[i + CI_FRONT_FACE] = ctx.frontFace;
    I[i + CI_TEX_ID0] = unit0.enabled2d ? unit0.boundTexture : 0;
    I[i + CI_TEX_ID1] = unit1.enabled2d ? unit1.boundTexture : 0;
    I[i + CI_TEXENV0] = unit0.texEnvMode;
    I[i + CI_TEXENV1] = unit1.texEnvMode;
    I[i + CI_SHADE_MODEL] = ctx.shadeModel;
    I[i + CI_FOG_MODE] = ctx.fogMode;
    I[i + CI_POLYGON_MODE] = ctx.polygonModeFront;
    I[i + CI_STENCIL_FUNC] = ctx.stencilFunc;
    I[i + CI_STENCIL_REF] = ctx.stencilRef;
    I[i + CI_STENCIL_MASK] = ctx.stencilMask;
    I[i + CI_STENCIL_FAIL] = ctx.stencilFail;
    I[i + CI_STENCIL_ZFAIL] = ctx.stencilZFail;
    I[i + CI_STENCIL_ZPASS] = ctx.stencilZPass;
    I[i + CI_STENCIL_WRITE_MASK] = ctx.stencilWriteMask;
    I[i + CI_SCISSOR_X] = ctx.scissorX;
    I[i + CI_SCISSOR_Y] = ctx.scissorY;
    I[i + CI_SCISSOR_W] = ctx.scissorW;
    I[i + CI_SCISSOR_H] = ctx.scissorH;
    I[i + CI_VP_X] = ctx.viewportX;
    I[i + CI_VP_Y] = ctx.viewportY;
    I[i + CI_VP_W] = ctx.viewportW;
    I[i + CI_VP_H] = ctx.viewportH;

    F[f + CF_ALPHA_REF] = ctx.alphaRef;
    F[f + CF_FOG_R] = fc[0];
    F[f + CF_FOG_G] = fc[1];
    F[f + CF_FOG_B] = fc[2];
    F[f + CF_FOG_A] = fc[3];
    F[f + CF_FOG_DENSITY] = ctx.fogDensity;
    F[f + CF_FOG_START] = ctx.fogStart;
    F[f + CF_FOG_END] = ctx.fogEnd;
    F[f + CF_DEPTH_RANGE_NEAR] = ctx.depthRangeNear;
    F[f + CF_DEPTH_RANGE_FAR] = ctx.depthRangeFar;

    ctx.frameSnapshot.vertexCount += vertCount;

    // Fold into the previous draw when it is state-identical and its vertices end
    // exactly where ours begin — the concatenated range is the same draw.
    if (idx > 0 && isMergeableMode(mode) && stream.typeAt(idx - 1) === GLDrawCommandType.DRAW) {
        const p = (idx - 1) * CMD_I32;
        if (I[p + CI_VERT_OFFSET] + I[p + CI_VERT_COUNT] * VERT_FLOATS === vertOffset &&
            I[p + CI_VERT_COUNT] % mergePrimStride(mode) === 0 &&
            drawStateEqual(I, F, idx - 1, idx)) {
            I[p + CI_VERT_COUNT] += vertCount;
            stream.pop();
            return;
        }
    }

    ctx.frameSnapshot.drawCalls++;
}

export function emitDrawCommandFlat(
    ctx: OpenGLContext, mode: number, src: Float32Array, srcCount: number, preTransformed = false,
): void {
    const expected = assembledVertCount(mode, srcCount);
    if (expected === 0) return;

    const arena = ctx.vertArena;
    arena.reserve(expected);
    const base = arena.used;
    const asmCount = assembleFlatVerts(src, srcCount, mode, arena.data, base);
    if (asmCount === 0) return;
    emitArenaDraw(ctx, mode, base, asmCount, preTransformed);
}

/** Reserve room for `vertCount` vertices in the frame arena and return the float offset
 *  to write them at. Read `ctx.vertArena.data` AFTER this — reserve may reallocate, and
 *  `used` only advances once emitArenaDraw publishes the range. */
export function arenaReserve(ctx: OpenGLContext, vertCount: number): number {
    ctx.vertArena.reserve(vertCount);
    return ctx.vertArena.used;
}

/** Publish an already-assembled arena range as one DRAW. `preTransformed` means the
 *  positions are already in clip space (compiled vertex arrays), which also implies
 *  texgen is off — the caller only takes that path when nothing needs object space. */
export function emitArenaDraw(
    ctx: OpenGLContext, mode: number, base: number, count: number, preTransformed = false,
): void {
    if (count === 0) return;
    const arena = ctx.vertArena;
    arena.used = base + count * VERT_FLOATS;

    if (!preTransformed) {
        if (ctx.enableFlags.has(GL_TEXTURE_GEN_S) || ctx.enableFlags.has(GL_TEXTURE_GEN_T)) {
            applyTexGenFlat(ctx, arena.data, base, count);
        }
        transformFlatVerts(ctx, arena.data, base, count);
    }

    pushGLDrawCommand(ctx, mode, base, count);
}

/** For pre-baked display list items — data is already triangle-assembled, apply texgen + transform now */
export function emitDrawCommandFromPrebaked(ctx: OpenGLContext, mode: number, flatVerts: Float32Array, count: number): void {
    if (count === 0) return;

    const arena = ctx.vertArena;
    arena.reserve(count);
    const base = arena.used;
    const floats = count * VERT_FLOATS;
    if (flatVerts.length === floats) arena.data.set(flatVerts, base);
    else arena.data.set(flatVerts.subarray(0, floats), base);
    arena.used = base + floats;

    if (ctx.enableFlags.has(GL_TEXTURE_GEN_S) || ctx.enableFlags.has(GL_TEXTURE_GEN_T)) {
        applyTexGenFlat(ctx, arena.data, base, count);
    }
    transformFlatVerts(ctx, arena.data, base, count);

    pushGLDrawCommand(ctx, mode, base, count);
}

export function createImmediateExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['glBegin'] = (_c, _m, args): number => {
        if (ctx.immediateMode) {
            ctx.error = GL_INVALID_OPERATION;
            return 0;
        }
        ctx.immediateMode = true;
        ctx.immediatePrimMode = args[0] >>> 0;
        ctx.immediateFlatCount = 0;
        return 0;
    };

    exports['glEnd'] = (): number => {
        if (!ctx.immediateMode) {
            ctx.error = GL_INVALID_OPERATION;
            return 0;
        }
        ctx.immediateMode = false;
        emitDrawCommandFlat(ctx, ctx.immediatePrimMode, ctx.immediateFlatBuf, ctx.immediateFlatCount);
        ctx.immediateFlatCount = 0;
        return 0;
    };

    // glVertex variants
    exports['glVertex2f'] = (_c, _m, args): number => {
        pushVertex(ctx, bitsToF32(args[0]), bitsToF32(args[1]), 0, 1);
        return 0;
    };
    exports['glVertex3f'] = (_c, _m, args): number => {
        pushVertex(ctx, bitsToF32(args[0]), bitsToF32(args[1]), bitsToF32(args[2]), 1);
        return 0;
    };
    exports['glVertex4f'] = (_c, _m, args): number => {
        pushVertex(ctx, bitsToF32(args[0]), bitsToF32(args[1]), bitsToF32(args[2]), bitsToF32(args[3]));
        return 0;
    };
    exports['glVertex2d'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] as number, args[1] as number, 0, 1);
        return 0;
    };
    exports['glVertex3d'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] as number, args[1] as number, args[2] as number, 1);
        return 0;
    };
    exports['glVertex4d'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] as number, args[1] as number, args[2] as number, args[3] as number);
        return 0;
    };
    exports['glVertex2i'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] | 0, args[1] | 0, 0, 1);
        return 0;
    };
    exports['glVertex3i'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] | 0, args[1] | 0, args[2] | 0, 1);
        return 0;
    };
    exports['glVertex4i'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] | 0, args[1] | 0, args[2] | 0, args[3] | 0);
        return 0;
    };
    exports['glVertex2s'] = exports['glVertex2i'];
    exports['glVertex3s'] = exports['glVertex3i'];
    exports['glVertex4s'] = exports['glVertex4i'];

    // Vector variants - read from guest ptr using cached DataView
    exports['glVertex2fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat32(ptr, true), dv.getFloat32(ptr+4, true), 0, 1);
        return 0;
    };
    exports['glVertex3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat32(ptr, true), dv.getFloat32(ptr+4, true), dv.getFloat32(ptr+8, true), 1);
        return 0;
    };
    exports['glVertex4fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat32(ptr, true), dv.getFloat32(ptr+4, true), dv.getFloat32(ptr+8, true), dv.getFloat32(ptr+12, true));
        return 0;
    };
    exports['glVertex2dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat64(ptr, true), dv.getFloat64(ptr+8, true), 0, 1);
        return 0;
    };
    exports['glVertex3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat64(ptr, true), dv.getFloat64(ptr+8, true), dv.getFloat64(ptr+16, true), 1);
        return 0;
    };
    exports['glVertex4dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat64(ptr, true), dv.getFloat64(ptr+8, true), dv.getFloat64(ptr+16, true), dv.getFloat64(ptr+24, true));
        return 0;
    };
    exports['glVertex2iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt32(ptr, true), dv.getInt32(ptr+4, true), 0, 1);
        return 0;
    };
    exports['glVertex3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt32(ptr, true), dv.getInt32(ptr+4, true), dv.getInt32(ptr+8, true), 1);
        return 0;
    };
    exports['glVertex4iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt32(ptr, true), dv.getInt32(ptr+4, true), dv.getInt32(ptr+8, true), dv.getInt32(ptr+12, true));
        return 0;
    };
    exports['glVertex2sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt16(ptr, true), dv.getInt16(ptr+2, true), 0, 1);
        return 0;
    };
    exports['glVertex3sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt16(ptr, true), dv.getInt16(ptr+2, true), dv.getInt16(ptr+4, true), 1);
        return 0;
    };
    exports['glVertex4sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt16(ptr, true), dv.getInt16(ptr+2, true), dv.getInt16(ptr+4, true), dv.getInt16(ptr+6, true));
        return 0;
    };

    // glColor variants
    exports['glColor3f'] = (_c, _m, args): number => {
        ctx.currentColor[0] = bitsToF32(args[0]);
        ctx.currentColor[1] = bitsToF32(args[1]);
        ctx.currentColor[2] = bitsToF32(args[2]);
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4f'] = (_c, _m, args): number => {
        ctx.currentColor[0] = bitsToF32(args[0]);
        ctx.currentColor[1] = bitsToF32(args[1]);
        ctx.currentColor[2] = bitsToF32(args[2]);
        ctx.currentColor[3] = bitsToF32(args[3]);
        return 0;
    };
    exports['glColor3ub'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFF) / 255;
        ctx.currentColor[1] = (args[1] & 0xFF) / 255;
        ctx.currentColor[2] = (args[2] & 0xFF) / 255;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4ub'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFF) / 255;
        ctx.currentColor[1] = (args[1] & 0xFF) / 255;
        ctx.currentColor[2] = (args[2] & 0xFF) / 255;
        ctx.currentColor[3] = (args[3] & 0xFF) / 255;
        return 0;
    };
    exports['glColor3d'] = (_c, _m, args): number => {
        ctx.currentColor[0] = args[0] as number;
        ctx.currentColor[1] = args[1] as number;
        ctx.currentColor[2] = args[2] as number;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4d'] = (_c, _m, args): number => {
        ctx.currentColor[0] = args[0] as number;
        ctx.currentColor[1] = args[1] as number;
        ctx.currentColor[2] = args[2] as number;
        ctx.currentColor[3] = args[3] as number;
        return 0;
    };
    exports['glColor3b'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((args[1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((args[2] << 24) >> 24) / 127;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4b'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((args[1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((args[2] << 24) >> 24) / 127;
        ctx.currentColor[3] = ((args[3] << 24) >> 24) / 127;
        return 0;
    };
    exports['glColor3i'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] | 0) / 2147483647;
        ctx.currentColor[1] = (args[1] | 0) / 2147483647;
        ctx.currentColor[2] = (args[2] | 0) / 2147483647;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4i'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] | 0) / 2147483647;
        ctx.currentColor[1] = (args[1] | 0) / 2147483647;
        ctx.currentColor[2] = (args[2] | 0) / 2147483647;
        ctx.currentColor[3] = (args[3] | 0) / 2147483647;
        return 0;
    };
    exports['glColor3s'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 16) >> 16) / 32767;
        ctx.currentColor[1] = ((args[1] << 16) >> 16) / 32767;
        ctx.currentColor[2] = ((args[2] << 16) >> 16) / 32767;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4s'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 16) >> 16) / 32767;
        ctx.currentColor[1] = ((args[1] << 16) >> 16) / 32767;
        ctx.currentColor[2] = ((args[2] << 16) >> 16) / 32767;
        ctx.currentColor[3] = ((args[3] << 16) >> 16) / 32767;
        return 0;
    };
    exports['glColor3ui'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] >>> 0) / 4294967295;
        ctx.currentColor[1] = (args[1] >>> 0) / 4294967295;
        ctx.currentColor[2] = (args[2] >>> 0) / 4294967295;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4ui'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] >>> 0) / 4294967295;
        ctx.currentColor[1] = (args[1] >>> 0) / 4294967295;
        ctx.currentColor[2] = (args[2] >>> 0) / 4294967295;
        ctx.currentColor[3] = (args[3] >>> 0) / 4294967295;
        return 0;
    };
    exports['glColor3us'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFFFF) / 65535;
        ctx.currentColor[1] = (args[1] & 0xFFFF) / 65535;
        ctx.currentColor[2] = (args[2] & 0xFFFF) / 65535;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4us'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFFFF) / 65535;
        ctx.currentColor[1] = (args[1] & 0xFFFF) / 65535;
        ctx.currentColor[2] = (args[2] & 0xFFFF) / 65535;
        ctx.currentColor[3] = (args[3] & 0xFFFF) / 65535;
        return 0;
    };

    // Vector color variants
    exports['glColor3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat32(ptr, true);
        ctx.currentColor[1] = dv.getFloat32(ptr+4, true);
        ctx.currentColor[2] = dv.getFloat32(ptr+8, true);
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat32(ptr, true);
        ctx.currentColor[1] = dv.getFloat32(ptr+4, true);
        ctx.currentColor[2] = dv.getFloat32(ptr+8, true);
        ctx.currentColor[3] = dv.getFloat32(ptr+12, true);
        return 0;
    };
    exports['glColor3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat64(ptr, true);
        ctx.currentColor[1] = dv.getFloat64(ptr+8, true);
        ctx.currentColor[2] = dv.getFloat64(ptr+16, true);
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat64(ptr, true);
        ctx.currentColor[1] = dv.getFloat64(ptr+8, true);
        ctx.currentColor[2] = dv.getFloat64(ptr+16, true);
        ctx.currentColor[3] = dv.getFloat64(ptr+24, true);
        return 0;
    };
    exports['glColor3bv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = ((mem[ptr] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((mem[ptr + 1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((mem[ptr + 2] << 24) >> 24) / 127;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4bv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = ((mem[ptr] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((mem[ptr + 1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((mem[ptr + 2] << 24) >> 24) / 127;
        ctx.currentColor[3] = ((mem[ptr + 3] << 24) >> 24) / 127;
        return 0;
    };
    exports['glColor3ubv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = mem[ptr] / 255;
        ctx.currentColor[1] = mem[ptr + 1] / 255;
        ctx.currentColor[2] = mem[ptr + 2] / 255;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4ubv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = mem[ptr] / 255;
        ctx.currentColor[1] = mem[ptr + 1] / 255;
        ctx.currentColor[2] = mem[ptr + 2] / 255;
        ctx.currentColor[3] = mem[ptr + 3] / 255;
        return 0;
    };
    exports['glColor3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt32(ptr, true) / 2147483647;
        ctx.currentColor[1] = dv.getInt32(ptr+4, true) / 2147483647;
        ctx.currentColor[2] = dv.getInt32(ptr+8, true) / 2147483647;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt32(ptr, true) / 2147483647;
        ctx.currentColor[1] = dv.getInt32(ptr+4, true) / 2147483647;
        ctx.currentColor[2] = dv.getInt32(ptr+8, true) / 2147483647;
        ctx.currentColor[3] = dv.getInt32(ptr+12, true) / 2147483647;
        return 0;
    };
    exports['glColor3sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt16(ptr, true) / 32767;
        ctx.currentColor[1] = dv.getInt16(ptr+2, true) / 32767;
        ctx.currentColor[2] = dv.getInt16(ptr+4, true) / 32767;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt16(ptr, true) / 32767;
        ctx.currentColor[1] = dv.getInt16(ptr+2, true) / 32767;
        ctx.currentColor[2] = dv.getInt16(ptr+4, true) / 32767;
        ctx.currentColor[3] = dv.getInt16(ptr+6, true) / 32767;
        return 0;
    };
    exports['glColor3uiv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint32(ptr, true) / 4294967295;
        ctx.currentColor[1] = dv.getUint32(ptr + 4, true) / 4294967295;
        ctx.currentColor[2] = dv.getUint32(ptr + 8, true) / 4294967295;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4uiv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint32(ptr, true) / 4294967295;
        ctx.currentColor[1] = dv.getUint32(ptr + 4, true) / 4294967295;
        ctx.currentColor[2] = dv.getUint32(ptr + 8, true) / 4294967295;
        ctx.currentColor[3] = dv.getUint32(ptr + 12, true) / 4294967295;
        return 0;
    };
    exports['glColor3usv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint16(ptr, true) / 65535;
        ctx.currentColor[1] = dv.getUint16(ptr + 2, true) / 65535;
        ctx.currentColor[2] = dv.getUint16(ptr + 4, true) / 65535;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4usv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint16(ptr, true) / 65535;
        ctx.currentColor[1] = dv.getUint16(ptr + 2, true) / 65535;
        ctx.currentColor[2] = dv.getUint16(ptr + 4, true) / 65535;
        ctx.currentColor[3] = dv.getUint16(ptr + 6, true) / 65535;
        return 0;
    };

    // glNormal variants
    exports['glNormal3f'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = bitsToF32(args[0]);
        ctx.currentNormal[1] = bitsToF32(args[1]);
        ctx.currentNormal[2] = bitsToF32(args[2]);
        return 0;
    };
    exports['glNormal3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getFloat32(ptr, true);
        ctx.currentNormal[1] = dv.getFloat32(ptr+4, true);
        ctx.currentNormal[2] = dv.getFloat32(ptr+8, true);
        return 0;
    };
    exports['glNormal3d'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = args[0] as number;
        ctx.currentNormal[1] = args[1] as number;
        ctx.currentNormal[2] = args[2] as number;
        return 0;
    };
    exports['glNormal3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getFloat64(ptr, true);
        ctx.currentNormal[1] = dv.getFloat64(ptr+8, true);
        ctx.currentNormal[2] = dv.getFloat64(ptr+16, true);
        return 0;
    };
    exports['glNormal3b'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = ((args[0] << 24) >> 24) / 127;
        ctx.currentNormal[1] = ((args[1] << 24) >> 24) / 127;
        ctx.currentNormal[2] = ((args[2] << 24) >> 24) / 127;
        return 0;
    };
    exports['glNormal3bv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentNormal[0] = ((mem[ptr] << 24) >> 24) / 127;
        ctx.currentNormal[1] = ((mem[ptr + 1] << 24) >> 24) / 127;
        ctx.currentNormal[2] = ((mem[ptr + 2] << 24) >> 24) / 127;
        return 0;
    };
    exports['glNormal3i'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = (args[0] | 0) / 2147483647;
        ctx.currentNormal[1] = (args[1] | 0) / 2147483647;
        ctx.currentNormal[2] = (args[2] | 0) / 2147483647;
        return 0;
    };
    exports['glNormal3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getInt32(ptr, true) / 2147483647;
        ctx.currentNormal[1] = dv.getInt32(ptr+4, true) / 2147483647;
        ctx.currentNormal[2] = dv.getInt32(ptr+8, true) / 2147483647;
        return 0;
    };
    exports['glNormal3s'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = ((args[0] << 16) >> 16) / 32767;
        ctx.currentNormal[1] = ((args[1] << 16) >> 16) / 32767;
        ctx.currentNormal[2] = ((args[2] << 16) >> 16) / 32767;
        return 0;
    };
    exports['glNormal3sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getInt16(ptr, true) / 32767;
        ctx.currentNormal[1] = dv.getInt16(ptr+2, true) / 32767;
        ctx.currentNormal[2] = dv.getInt16(ptr+4, true) / 32767;
        return 0;
    };

    // glTexCoord variants
    exports['glTexCoord1f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = 0;
        return 0;
    };
    exports['glTexCoord2f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = bitsToF32(args[1]);
        return 0;
    };
    exports['glTexCoord3f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = bitsToF32(args[1]);
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = bitsToF32(args[2]);
        return 0;
    };
    exports['glTexCoord4f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = bitsToF32(args[1]);
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = bitsToF32(args[2]);
        ctx.currentTexCoord[ctx.activeTextureUnit][3] = bitsToF32(args[3]);
        return 0;
    };
    exports['glTexCoord1d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = 0;
        return 0;
    };
    exports['glTexCoord2d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] as number;
        return 0;
    };
    exports['glTexCoord3d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = args[2] as number;
        return 0;
    };
    exports['glTexCoord4d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = args[2] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][3] = args[3] as number;
        return 0;
    };
    exports['glTexCoord1i'] = (_c, _m, args): number => { ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] | 0; return 0; };
    exports['glTexCoord2i'] = (_c, _m, args): number => { ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] | 0; ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] | 0; return 0; };
    exports['glTexCoord3i'] = (_c, _m, args): number => { const tc = ctx.currentTexCoord[ctx.activeTextureUnit]; tc[0] = args[0] | 0; tc[1] = args[1] | 0; tc[2] = args[2] | 0; return 0; };
    exports['glTexCoord4i'] = (_c, _m, args): number => { const tc = ctx.currentTexCoord[ctx.activeTextureUnit]; tc[0] = args[0] | 0; tc[1] = args[1] | 0; tc[2] = args[2] | 0; tc[3] = args[3] | 0; return 0; };
    exports['glTexCoord1s'] = exports['glTexCoord1i'];
    exports['glTexCoord2s'] = exports['glTexCoord2i'];
    exports['glTexCoord3s'] = exports['glTexCoord3i'];
    exports['glTexCoord4s'] = exports['glTexCoord4i'];

    // Vector tex coord variants — use cached DataView
    exports['glTexCoord1fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = getMemDV(ctx).getFloat32(ptr, true);
        return 0;
    };
    exports['glTexCoord2fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = dv.getFloat32(ptr, true);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = dv.getFloat32(ptr+4, true);
        return 0;
    };
    exports['glTexCoord3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat32(ptr, true); tc[1] = dv.getFloat32(ptr+4, true); tc[2] = dv.getFloat32(ptr+8, true);
        return 0;
    };
    exports['glTexCoord4fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat32(ptr, true); tc[1] = dv.getFloat32(ptr+4, true); tc[2] = dv.getFloat32(ptr+8, true); tc[3] = dv.getFloat32(ptr+12, true);
        return 0;
    };
    exports['glTexCoord1dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = getMemDV(ctx).getFloat64(ptr, true);
        return 0;
    };
    exports['glTexCoord2dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = dv.getFloat64(ptr, true);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = dv.getFloat64(ptr+8, true);
        return 0;
    };
    exports['glTexCoord3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat64(ptr, true); tc[1] = dv.getFloat64(ptr+8, true); tc[2] = dv.getFloat64(ptr+16, true);
        return 0;
    };
    exports['glTexCoord4dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat64(ptr, true); tc[1] = dv.getFloat64(ptr+8, true); tc[2] = dv.getFloat64(ptr+16, true); tc[3] = dv.getFloat64(ptr+24, true);
        return 0;
    };
    exports['glTexCoord1iv'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = getMemDV(ctx).getInt32(args[0] >>> 0, true);
        return 0;
    };
    exports['glTexCoord2iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = dv.getInt32(ptr, true);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = dv.getInt32(ptr+4, true);
        return 0;
    };
    exports['glTexCoord3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getInt32(ptr, true); tc[1] = dv.getInt32(ptr+4, true); tc[2] = dv.getInt32(ptr+8, true);
        return 0;
    };
    exports['glTexCoord4iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getInt32(ptr, true); tc[1] = dv.getInt32(ptr+4, true); tc[2] = dv.getInt32(ptr+8, true); tc[3] = dv.getInt32(ptr+12, true);
        return 0;
    };
    exports['glTexCoord1sv'] = exports['glTexCoord1iv'];
    exports['glTexCoord2sv'] = exports['glTexCoord2iv'];
    exports['glTexCoord3sv'] = exports['glTexCoord3iv'];
    exports['glTexCoord4sv'] = exports['glTexCoord4iv'];

    return exports;
}

/**
 * Register Tier-0 write-buffer stubs for the highest-frequency OpenGL immediate-mode functions.
 *
 * These functions (glVertex*, glNormal*, glTexCoord*, glColor*) account for the bulk of
 * OUT-trap overhead in games using immediate mode.  Replacing them with JMP-trampoline stubs
 * saves ~75 ms/frame on a typical OpenGL game (140K glVertex3fv calls × 7 µs each).
 *
 * Flush triggers (glEnd, glFlush, wglSwapBuffers) remain as OUT traps.  drainWriteBuffer()
 * is called at the top of handlePortWrite(), so all buffered vertex data is applied before
 * glEnd's emitDrawCommandFlat() runs.
 *
 * Display-list recording: each handler checks ctx.compilingList.  During GL_COMPILE the
 * args are recorded into compilingCommands and execution is skipped.  During
 * GL_COMPILE_AND_EXECUTE they are recorded AND executed.
 */
export function registerWriteBufferGLFunctions(dispatcher: any, ctx: OpenGLContext): void {
    if (typeof dispatcher.registerWriteBufferFunction !== 'function') return;

    // GL_COMPILE = 0x1300.  Inline the constant to avoid an extra import at hot-path drain time.
    const _GL_COMPILE = 0x1300;

    // Wraps a WBUF handler to support display-list recording.
    // `readArgs` extracts the arg array from the ring buffer (same values the normal thunk
    // would pass in `args[]`).  When compiling a list we push {fn, args} and optionally
    // skip execution (GL_COMPILE).
    const reg = (name: string, argCount: number, readArgs: (mem32: Uint32Array, ptr: number) => number[], handler: WriteBufHandler) => {
        const wrapped: WriteBufHandler = (mem8, mem32, ptr) => {
            if (ctx.compilingList !== null) {
                ctx.compilingCommands.push({ fn: name, args: readArgs(mem32, ptr) });
                if (ctx.compilingListMode === _GL_COMPILE) return;
            }
            handler(mem8, mem32, ptr);
        };
        dispatcher.registerWriteBufferFunction('opengl32', name, argCount, wrapped, true /* stdcall */);
    };

    // --- Pointer-dereference WBUF variants ---
    // These use PtrDeref trampolines that dereference the float* inline in x86,
    // writing actual float bits to the ring buffer (not the pointer).
    // Drain side is identical to the scalar variants.
    // IMPORTANT: display-list recording uses the SCALAR function name (e.g. 'glVertex3f'
    // instead of 'glVertex3fv') because the ring contains float bits, not a pointer.
    // lists.ts replay for *fv variants treats args[0] as a pointer — using the scalar
    // name ensures the replay switch-case interprets the args as float bits correctly.
    if (typeof dispatcher.registerPtrDerefWriteBufferFunction === 'function') {
        const regPd = (name: string, scalarName: string, floatCount: number, readArgs: (mem32: Uint32Array, ptr: number) => number[], handler: WriteBufHandler) => {
            const wrapped: WriteBufHandler = (mem8, mem32, ptr) => {
                if (ctx.compilingList !== null) {
                    ctx.compilingCommands.push({ fn: scalarName, args: readArgs(mem32, ptr) });
                    if (ctx.compilingListMode === _GL_COMPILE) return;
                }
                handler(mem8, mem32, ptr);
            };
            dispatcher.registerPtrDerefWriteBufferFunction('opengl32', name, floatCount, wrapped, true /* stdcall */);
        };

        // glVertex3fv(const GLfloat *v) — ring contains 3 float bits, record as glVertex3f
        regPd('glVertex3fv', 'glVertex3f', 3,
            (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
            (_mem8, mem32, ptr) => {
                pushVertex(ctx,
                    bitsToF32(mem32[ptr >> 2]),
                    bitsToF32(mem32[(ptr + 4) >> 2]),
                    bitsToF32(mem32[(ptr + 8) >> 2]),
                    1);
            });

        // glNormal3fv(const GLfloat *v) — ring contains 3 float bits, record as glNormal3f
        regPd('glNormal3fv', 'glNormal3f', 3,
            (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
            (_mem8, mem32, ptr) => {
                ctx.currentNormal[0] = bitsToF32(mem32[ptr >> 2]);
                ctx.currentNormal[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
                ctx.currentNormal[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
            });

        // glTexCoord2fv(const GLfloat *v) — ring contains 2 float bits, record as glTexCoord2f
        regPd('glTexCoord2fv', 'glTexCoord2f', 2,
            (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2]],
            (_mem8, mem32, ptr) => {
                const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
                tc[0] = bitsToF32(mem32[ptr >> 2]);
                tc[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            });
    }

    // --- glBegin (mode) ---
    // Safe on the ring even though glEnd stays an OUT trap: the ring is FIFO and
    // glEnd's trap drains it before running, so Begin still precedes its vertices.
    reg('glBegin', 1,
        (m32, p) => [m32[p >> 2]],
        (_mem8, mem32, ptr) => {
            if (ctx.immediateMode) {
                ctx.error = GL_INVALID_OPERATION;
                return;
            }
            ctx.immediateMode = true;
            ctx.immediatePrimMode = mem32[ptr >> 2] >>> 0;
            ctx.immediateFlatCount = 0;
        });

    // --- glVertex3f (x, y, z) ---
    reg('glVertex3f', 3,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
        (_mem8, mem32, ptr) => {
            pushVertex(ctx,
                bitsToF32(mem32[ptr >> 2]),
                bitsToF32(mem32[(ptr + 4) >> 2]),
                bitsToF32(mem32[(ptr + 8) >> 2]),
                1);
        });

    // --- glVertex2f (x, y) ---
    reg('glVertex2f', 2,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2]],
        (_mem8, mem32, ptr) => {
            pushVertex(ctx, bitsToF32(mem32[ptr >> 2]), bitsToF32(mem32[(ptr + 4) >> 2]), 0, 1);
        });

    // --- glNormal3f (nx, ny, nz) ---
    reg('glNormal3f', 3,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentNormal[0] = bitsToF32(mem32[ptr >> 2]);
            ctx.currentNormal[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            ctx.currentNormal[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
        });

    // --- glTexCoord2f (s, t) ---
    reg('glTexCoord2f', 2,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2]],
        (_mem8, mem32, ptr) => {
            const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
            tc[0] = bitsToF32(mem32[ptr >> 2]);
            tc[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
        });

    // --- glColor4f (r, g, b, a) ---
    reg('glColor4f', 4,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2], m32[(p + 12) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentColor[0] = bitsToF32(mem32[ptr >> 2]);
            ctx.currentColor[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            ctx.currentColor[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
            ctx.currentColor[3] = bitsToF32(mem32[(ptr + 12) >> 2]);
        });

    // --- glColor3f (r, g, b) ---
    reg('glColor3f', 3,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentColor[0] = bitsToF32(mem32[ptr >> 2]);
            ctx.currentColor[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            ctx.currentColor[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
            ctx.currentColor[3] = 1.0;
        });

    // --- glColor4ub (r, g, b, a) — byte args packed as separate u32 words in ring buffer ---
    reg('glColor4ub', 4,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2], m32[(p + 12) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentColor[0] = (mem32[ptr >> 2] & 0xFF) / 255;
            ctx.currentColor[1] = (mem32[(ptr + 4) >> 2] & 0xFF) / 255;
            ctx.currentColor[2] = (mem32[(ptr + 8) >> 2] & 0xFF) / 255;
            ctx.currentColor[3] = (mem32[(ptr + 12) >> 2] & 0xFF) / 255;
        });

    Logger.log(LogCategory.SYSTEM,
        'Registered Tier-0 write-buffer stubs for OpenGL immediate-mode functions');
}
