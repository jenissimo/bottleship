/** OpenGL 1.3 section 5.2. Selection stops before rasterization. */
import { type OpenGLContext, VERT_FLOATS } from "./context";
import * as GL from "./constants";

/** @transient(bounded clipping scratch; fully overwritten for each primitive) */
const clipA = new Float64Array(16 * 8);
/** @transient(bounded clipping scratch; fully overwritten before reading) */
const clipB = new Float64Array(16 * 8);
/** @transient(plane transform augmented matrix, overwritten per glClipPlane) */
const planeSolve = new Float64Array(20);
/** @transient(per-plane distances, overwritten before every clipping step) */
const clipDistances = new Float64Array(16);

export function selectionDepth(ctx: OpenGLContext, z: number): void {
    z = Math.max(0, Math.min(1, z));
    if (!Number.isFinite(z)) return;
    ctx.selectHit = true;
    ctx.selectMinZ = Math.min(ctx.selectMinZ, z);
    ctx.selectMaxZ = Math.max(ctx.selectMaxZ, z);
}

export function flushSelectionHit(ctx: OpenGLContext): void {
    if (!ctx.selectHit) return;
    const names = ctx.nameStackTop + 1;
    const words = names + 3;
    const mem = ctx.process.getCurrentMemory();
    // Acquire current memory only here: never retain a guest view across callbacks.
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    for (let i = 0; i < words; i++) {
        const slot = ctx.selectWriteOffset + i;
        const address = ctx.selectBufferPtr + slot * 4;
        if (slot >= ctx.selectBufferSize || address < 0 || address + 4 > mem.byteLength) {
            ctx.selectOverflow = true;
            break;
        }
        const value = i === 0 ? names : i === 1 ? Math.round(ctx.selectMinZ * 0xffffffff)
            : i === 2 ? Math.round(ctx.selectMaxZ * 0xffffffff) : ctx.nameStack[i - 3];
        view.setUint32(address, value >>> 0, true);
    }
    // Saturate after overflow; repeated picking must not grow a host-side list.
    ctx.selectWriteOffset = Math.min(ctx.selectBufferSize, ctx.selectWriteOffset + words);
    ctx.selectHits++;
    ctx.selectHit = false;
    ctx.selectMinZ = 1;
    ctx.selectMaxZ = 0;
}

export function resetSelection(ctx: OpenGLContext): void {
    ctx.selectWriteOffset = 0;
    ctx.selectHits = 0;
    ctx.selectOverflow = false;
    ctx.selectHit = false;
    ctx.selectMinZ = 1;
    ctx.selectMaxZ = 0;
}

/** Store inverse-transpose(modelview) * equation, as required by glClipPlane. */
export function setClipPlane(ctx: OpenGLContext, index: number, view: DataView, ptr: number): void {
    const m = ctx.modelviewStack.stack[ctx.modelviewStack.top];
    const a = planeSolve;
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) a[r * 5 + c] = m[r * 4 + c];
        a[r * 5 + 4] = view.getFloat64(ptr + r * 8, true);
    }
    for (let c = 0; c < 4; c++) {
        let pivot = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 5 + c]) > Math.abs(a[pivot * 5 + c])) pivot = r;
        if (a[pivot * 5 + c] === 0) return; // singular modelview has undefined inverse
        for (let j = 0; j < 5; j++) { const t = a[c * 5 + j]; a[c * 5 + j] = a[pivot * 5 + j]; a[pivot * 5 + j] = t; }
        const scale = a[c * 5 + c];
        for (let j = c; j < 5; j++) a[c * 5 + j] /= scale;
        for (let r = 0; r < 4; r++) if (r !== c) {
            const factor = a[r * 5 + c];
            for (let j = c; j < 5; j++) a[r * 5 + j] -= factor * a[c * 5 + j];
        }
    }
    for (let i = 0; i < 4; i++) ctx.clipPlanes[index * 4 + i] = a[i * 5 + 4];
}

export function insideUserClipPlanes(ctx: OpenGLContext, x: number, y: number, z: number, w: number): boolean {
    for (let p = 0; p < 6; p++) if (ctx.enableFlags.has(GL.GL_CLIP_PLANE0 + p)) {
        const b = p * 4, q = ctx.clipPlanes;
        if (q[b] * x + q[b + 1] * y + q[b + 2] * z + q[b + 3] * w < 0) return false;
    }
    return true;
}

function distance(ctx: OpenGLContext, v: Float64Array, b: number, plane: number): number {
    if (plane < 6) return v[b + 3] + (plane & 1 ? -1 : 1) * v[b + (plane >> 1)];
    const q = ctx.clipPlanes, p = (plane - 6) * 4;
    return q[p] * v[b + 4] + q[p + 1] * v[b + 5] + q[p + 2] * v[b + 6] + q[p + 3] * v[b + 7];
}

function primitive(ctx: OpenGLContext, src: Float32Array, base: number, planes: number, i0: number, i1 = -1, i2 = -1, i3 = -1): void {
    let n = i1 < 0 ? 1 : i2 < 0 ? 2 : i3 < 0 ? 3 : 4;
    const polygon = n >= 3;
    const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];
    const pr = ctx.projectionStack.stack[ctx.projectionStack.top];
    let input = clipA, output = clipB;
    for (let i = 0; i < n; i++) {
        const s = base + (i === 0 ? i0 : i === 1 ? i1 : i === 2 ? i2 : i3) * VERT_FLOATS, d = i * 8;
        const x = src[s], y = src[s + 1], z = src[s + 2], w = src[s + 3];
        for (let r = 0; r < 4; r++) input[d + 4 + r] = mv[r] * x + mv[4 + r] * y + mv[8 + r] * z + mv[12 + r] * w;
        for (let r = 0; r < 4; r++) input[d + r] = pr[r] * input[d + 4] + pr[4 + r] * input[d + 5] + pr[8 + r] * input[d + 6] + pr[12 + r] * input[d + 7];
    }
    // Homogeneous clipping preserves both clip and eye coordinates for user planes.
    for (let p = 0; p < 12 && n; p++) {
        if (!(planes & (1 << p))) continue;
        if (!polygon) {
            const a = distance(ctx, input, 0, p);
            if (n === 1) { if (!(a >= 0)) n = 0; continue; }
            const b = distance(ctx, input, 8, p);
            if (a < 0 && b < 0) { n = 0; break; }
            if ((a < 0) !== (b < 0)) {
                const t = a / (a - b), dst = a < 0 ? 0 : 8;
                for (let k = 0; k < 8; k++) input[dst + k] = input[k] + t * (input[8 + k] - input[k]);
            }
            continue;
        }
        // Most picking primitives miss the tiny selection volume completely.
        // Classify this plane before interpolating/copying any polygon vertices.
        let inside = 0;
        for (let i = 0; i < n; i++) {
            const d = distance(ctx, input, i * 8, p);
            clipDistances[i] = d;
            if (d >= 0) inside++;
        }
        if (!inside) return;
        if (inside === n) continue;
        let out = 0;
        for (let i = 0; i < n; i++) {
            const prev = ((i + n - 1) % n) * 8, cur = i * 8;
            const a = clipDistances[(i + n - 1) % n], b = clipDistances[i];
            if ((a < 0) !== (b < 0)) {
                const t = a / (a - b);
                for (let k = 0; k < 8; k++) output[out * 8 + k] = input[prev + k] + t * (input[cur + k] - input[prev + k]);
                out++;
            }
            if (b >= 0) {
                for (let k = 0; k < 8; k++) output[out * 8 + k] = input[cur + k];
                out++;
            }
        }
        n = out;
        const tmp = input; input = output; output = tmp;
    }
    if (!n) return;
    if (polygon && ctx.enableFlags.has(GL.GL_CULL_FACE)) {
        if (ctx.cullFace === GL.GL_FRONT_AND_BACK) return;
        let area = 0;
        for (let i = 0; i < n; i++) {
            const a = i * 8, b = ((i + 1) % n) * 8;
            area += (input[a] * input[b + 1] - input[b] * input[a + 1]) / (input[a + 3] * input[b + 3]);
        }
        const front = ctx.frontFace === GL.GL_CCW ? area >= 0 : area <= 0;
        if (ctx.cullFace === (front ? GL.GL_FRONT : GL.GL_BACK)) return;
    }
    for (let i = 0; i < n; i++) {
        const b = i * 8;
        if (input[b + 3] > 0) selectionDepth(ctx, ctx.depthRangeNear + (input[b + 2] / input[b + 3] + 1) * .5 * (ctx.depthRangeFar - ctx.depthRangeNear));
    }
}

/** Object-space vertices. Call before texgen, lighting, or primitive expansion. */
export function selectDraw(ctx: OpenGLContext, mode: number, src: Float32Array, base: number, count: number): void {
    let planes = 0x3f;
    for (let p = 0; p < 6; p++) if (ctx.enableFlags.has(GL.GL_CLIP_PLANE0 + p)) planes |= 1 << (p + 6);
    switch (mode) {
        case GL.GL_POINTS: for (let i = 0; i < count; i++) primitive(ctx, src, base, planes, i); break;
        case GL.GL_LINES: for (let i = 0; i + 1 < count; i += 2) primitive(ctx, src, base, planes, i, i + 1); break;
        case GL.GL_LINE_LOOP:
        case GL.GL_LINE_STRIP:
            for (let i = 0; i + 1 < count; i++) primitive(ctx, src, base, planes, i, i + 1);
            if (mode === GL.GL_LINE_LOOP && count > 1) primitive(ctx, src, base, planes, count - 1, 0);
            break;
        case GL.GL_TRIANGLES: for (let i = 0; i + 2 < count; i += 3) primitive(ctx, src, base, planes, i, i + 1, i + 2); break;
        case GL.GL_TRIANGLE_STRIP:
            for (let i = 0; i + 2 < count; i++) primitive(ctx, src, base, planes, i + (i & 1), i + 1 - (i & 1), i + 2);
            break;
        case GL.GL_TRIANGLE_FAN:
        case GL.GL_POLYGON: for (let i = 1; i + 1 < count; i++) primitive(ctx, src, base, planes, 0, i, i + 1); break;
        case GL.GL_QUADS: for (let i = 0; i + 3 < count; i += 4) primitive(ctx, src, base, planes, i, i + 1, i + 2, i + 3); break;
        case GL.GL_QUAD_STRIP: for (let i = 0; i + 3 < count; i += 2) primitive(ctx, src, base, planes, i, i + 1, i + 3, i + 2); break;
    }
}

export function createSelectionExports(ctx: OpenGLContext): Record<string, import("../../core/thunking/thunk-dispatcher").ThunkImplementation> {
    const outsideBegin = (): boolean => {
        if (!ctx.immediateMode) return true;
        ctx.error = GL.GL_INVALID_OPERATION;
        return false;
    };
    return {
        glSelectBuffer: (_c, _m, args) => {
            if (!outsideBegin()) return 0;
            if (ctx.renderMode === GL.GL_SELECT) { ctx.error = GL.GL_INVALID_OPERATION; return 0; }
            if ((args[0] | 0) < 0) { ctx.error = GL.GL_INVALID_VALUE; return 0; }
            ctx.selectBufferSize = args[0] | 0;
            ctx.selectBufferPtr = args[1] >>> 0;
            ctx.selectBufferSet = true;
            return 0;
        },
        glRenderMode: (_c, _m, args) => {
            if (!outsideBegin()) return 0;
            const mode = args[0] >>> 0;
            if (mode !== GL.GL_RENDER && mode !== GL.GL_SELECT && mode !== GL.GL_FEEDBACK) {
                ctx.error = GL.GL_INVALID_ENUM; return 0;
            }
            if (mode === GL.GL_SELECT && !ctx.selectBufferSet) { ctx.error = GL.GL_INVALID_OPERATION; return 0; }
            let result = 0;
            if (ctx.renderMode === GL.GL_SELECT) {
                flushSelectionHit(ctx);
                result = ctx.selectOverflow ? -1 : ctx.selectHits;
            }
            ctx.renderMode = mode;
            ctx.nameStackTop = -1;
            resetSelection(ctx);
            return result;
        },
        glInitNames: () => {
            if (!outsideBegin() || ctx.renderMode !== GL.GL_SELECT) return 0;
            flushSelectionHit(ctx); ctx.nameStackTop = -1; return 0;
        },
        glPushName: (_c, _m, args) => {
            if (!outsideBegin() || ctx.renderMode !== GL.GL_SELECT) return 0;
            if (ctx.nameStackTop + 1 >= GL.NAME_STACK_MAX_DEPTH) { ctx.error = GL.GL_STACK_OVERFLOW; return 0; }
            flushSelectionHit(ctx); ctx.nameStack[++ctx.nameStackTop] = args[0] | 0; return 0;
        },
        glPopName: () => {
            if (!outsideBegin() || ctx.renderMode !== GL.GL_SELECT) return 0;
            if (ctx.nameStackTop < 0) { ctx.error = GL.GL_STACK_UNDERFLOW; return 0; }
            flushSelectionHit(ctx); ctx.nameStackTop--; return 0;
        },
        glLoadName: (_c, _m, args) => {
            if (!outsideBegin() || ctx.renderMode !== GL.GL_SELECT) return 0;
            if (ctx.nameStackTop < 0) { ctx.error = GL.GL_INVALID_OPERATION; return 0; }
            flushSelectionHit(ctx); ctx.nameStack[ctx.nameStackTop] = args[0] | 0; return 0;
        },
    };
}
