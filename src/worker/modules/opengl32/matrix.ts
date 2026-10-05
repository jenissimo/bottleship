/**
 * OpenGL matrix stack operations.
 * Column-major 4x4 matrices (OpenGL convention).
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { OpenGLContext, mat4Identity, mat4Multiply, GLMatrixStack } from "./context";
import { GL_MODELVIEW, GL_PROJECTION, GL_TEXTURE, GL_STACK_OVERFLOW, GL_STACK_UNDERFLOW,
         GL_INVALID_ENUM, GL_NO_ERROR } from "./constants";

// ---- f32 bit reinterpretation ----

const _f32ab = new ArrayBuffer(4);
const _f32dv = new DataView(_f32ab);

function bitsToF32(bits: number): number {
    _f32dv.setUint32(0, bits >>> 0, true);
    return _f32dv.getFloat32(0, true);
}

// ---- Matrix construction helpers (column-major) ----

function mat4Translation(out: Float32Array, tx: number, ty: number, tz: number): void {
    mat4Identity(out);
    out[12] = tx;
    out[13] = ty;
    out[14] = tz;
}

function mat4Scale(out: Float32Array, sx: number, sy: number, sz: number): void {
    out.fill(0);
    out[0] = sx;
    out[5] = sy;
    out[10] = sz;
    out[15] = 1;
}

function mat4Rotation(out: Float32Array, angleDeg: number, ax: number, ay: number, az: number): void {
    const rad = angleDeg * (Math.PI / 180);
    let len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-10) {
        mat4Identity(out);
        return;
    }
    len = 1 / len;
    ax *= len;
    ay *= len;
    az *= len;

    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const t = 1 - c;

    // Column 0
    out[0] = t * ax * ax + c;
    out[1] = t * ax * ay + s * az;
    out[2] = t * ax * az - s * ay;
    out[3] = 0;
    // Column 1
    out[4] = t * ax * ay - s * az;
    out[5] = t * ay * ay + c;
    out[6] = t * ay * az + s * ax;
    out[7] = 0;
    // Column 2
    out[8] = t * ax * az + s * ay;
    out[9] = t * ay * az - s * ax;
    out[10] = t * az * az + c;
    out[11] = 0;
    // Column 3
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
}

function mat4Ortho(
    out: Float32Array,
    left: number, right: number, bottom: number, top: number, near: number, far: number,
): void {
    const rl = right - left;
    const tb = top - bottom;
    const fn = far - near;
    out.fill(0);
    out[0] = 2 / rl;
    out[5] = 2 / tb;
    out[10] = -2 / fn;
    out[12] = -(right + left) / rl;
    out[13] = -(top + bottom) / tb;
    out[14] = -(far + near) / fn;
    out[15] = 1;
}

function mat4Frustum(
    out: Float32Array,
    left: number, right: number, bottom: number, top: number, near: number, far: number,
): void {
    const rl = right - left;
    const tb = top - bottom;
    const fn = far - near;
    out.fill(0);
    out[0] = (2 * near) / rl;
    out[5] = (2 * near) / tb;
    out[8] = (right + left) / rl;
    out[9] = (top + bottom) / tb;
    out[10] = -(far + near) / fn;
    out[11] = -1;
    out[14] = -(2 * far * near) / fn;
}

// ---- Helpers for reading matrices from guest memory ----

function readFloat32Matrix(mem: Uint8Array, ptr: number, out: Float32Array): void {
    const view = new DataView(mem.buffer, mem.byteOffset);
    for (let i = 0; i < 16; i++) {
        out[i] = view.getFloat32(ptr + i * 4, true);
    }
}

function readFloat64Matrix(mem: Uint8Array, ptr: number, out: Float32Array): void {
    const view = new DataView(mem.buffer, mem.byteOffset);
    for (let i = 0; i < 16; i++) {
        out[i] = view.getFloat64(ptr + i * 8, true);
    }
}

function transposeInPlace(m: Float32Array): void {
    // Swap off-diagonal elements: (row,col) <-> (col,row)
    // Column-major index = col*4 + row
    let tmp: number;
    tmp = m[1]; m[1] = m[4]; m[4] = tmp;   // (1,0) <-> (0,1)
    tmp = m[2]; m[2] = m[8]; m[8] = tmp;   // (2,0) <-> (0,2)
    tmp = m[3]; m[3] = m[12]; m[12] = tmp; // (3,0) <-> (0,3)
    tmp = m[6]; m[6] = m[9]; m[9] = tmp;   // (2,1) <-> (1,2)
    tmp = m[7]; m[7] = m[13]; m[13] = tmp; // (3,1) <-> (1,3)
    tmp = m[11]; m[11] = m[14]; m[14] = tmp; // (3,2) <-> (2,3)
}

// ---- Multiply current matrix by temp ----

const _mulResult = new Float32Array(16);

function multiplyCurrentByTemp(ctx: OpenGLContext, temp: Float32Array): void {
    const cur = ctx.currentMatrix();
    mat4Multiply(_mulResult, cur, temp);
    cur.set(_mulResult);
}

// ---- Stack helpers ----

function getStackForMode(ctx: OpenGLContext, mode: number): GLMatrixStack | null {
    switch (mode) {
        case GL_MODELVIEW: return ctx.modelviewStack;
        case GL_PROJECTION: return ctx.projectionStack;
        case GL_TEXTURE: return ctx.textureStack;
        default: return null;
    }
}

// Scratch matrices reused across calls
const _tempMat = new Float32Array(16);

// ---- Export ----

export function createMatrixExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    return {

        // 1. glMatrixMode
        glMatrixMode: (_sysCtx, _mem, args) => {
            const mode = args[0] | 0;
            if (mode !== GL_MODELVIEW && mode !== GL_PROJECTION && mode !== GL_TEXTURE) {
                if (ctx.error === GL_NO_ERROR) ctx.error = GL_INVALID_ENUM;
                return 0;
            }
            ctx.matrixMode = mode;
            return 0;
        },

        // 2. glLoadIdentity
        glLoadIdentity: () => {
            mat4Identity(ctx.currentMatrix());
            return 0;
        },

        // 3. glLoadMatrixf
        glLoadMatrixf: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            readFloat32Matrix(mem, ptr, ctx.currentMatrix());
            return 0;
        },

        // 4. glLoadMatrixd
        glLoadMatrixd: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            readFloat64Matrix(mem, ptr, ctx.currentMatrix());
            return 0;
        },

        // 5. glMultMatrixf
        glMultMatrixf: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            readFloat32Matrix(mem, ptr, _tempMat);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 6. glMultMatrixd
        glMultMatrixd: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            readFloat64Matrix(mem, ptr, _tempMat);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 7. glPushMatrix
        glPushMatrix: () => {
            const stack = ctx.currentStack();
            if (stack.top >= stack.maxDepth - 1) {
                if (ctx.error === GL_NO_ERROR) ctx.error = GL_STACK_OVERFLOW;
                return 0;
            }
            const copy = new Float32Array(16);
            copy.set(stack.stack[stack.top]);
            stack.top++;
            if (stack.top >= stack.stack.length) {
                stack.stack.push(copy);
            } else {
                stack.stack[stack.top] = copy;
            }
            return 0;
        },

        // 8. glPopMatrix
        glPopMatrix: () => {
            const stack = ctx.currentStack();
            if (stack.top <= 0) {
                if (ctx.error === GL_NO_ERROR) ctx.error = GL_STACK_UNDERFLOW;
                return 0;
            }
            stack.top--;
            return 0;
        },

        // 9. glTranslatef
        glTranslatef: (_sysCtx, _mem, args) => {
            const x = bitsToF32(args[0]);
            const y = bitsToF32(args[1]);
            const z = bitsToF32(args[2]);
            mat4Translation(_tempMat, x, y, z);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 10. glTranslated
        glTranslated: (_sysCtx, _mem, args) => {
            // f64 params: each is two 32-bit args (lo, hi) in little-endian
            const mem = ctx.process.getCurrentMemory();
            const view = new DataView(mem.buffer, mem.byteOffset);
            // Args passed on stack as doubles: read from guest stack
            // For stdcall f64 params, each double occupies 2 DWORD slots
            const ab = new ArrayBuffer(8);
            const dv = new DataView(ab);
            dv.setUint32(0, args[0] >>> 0, true);
            dv.setUint32(4, args[1] >>> 0, true);
            const x = dv.getFloat64(0, true);
            dv.setUint32(0, args[2] >>> 0, true);
            dv.setUint32(4, args[3] >>> 0, true);
            const y = dv.getFloat64(0, true);
            dv.setUint32(0, args[4] >>> 0, true);
            dv.setUint32(4, args[5] >>> 0, true);
            const z = dv.getFloat64(0, true);
            mat4Translation(_tempMat, x, y, z);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 11. glRotatef
        glRotatef: (_sysCtx, _mem, args) => {
            const angle = bitsToF32(args[0]);
            const x = bitsToF32(args[1]);
            const y = bitsToF32(args[2]);
            const z = bitsToF32(args[3]);
            mat4Rotation(_tempMat, angle, x, y, z);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 12. glRotated
        glRotated: (_sysCtx, _mem, args) => {
            const ab = new ArrayBuffer(8);
            const dv = new DataView(ab);
            dv.setUint32(0, args[0] >>> 0, true);
            dv.setUint32(4, args[1] >>> 0, true);
            const angle = dv.getFloat64(0, true);
            dv.setUint32(0, args[2] >>> 0, true);
            dv.setUint32(4, args[3] >>> 0, true);
            const x = dv.getFloat64(0, true);
            dv.setUint32(0, args[4] >>> 0, true);
            dv.setUint32(4, args[5] >>> 0, true);
            const y = dv.getFloat64(0, true);
            dv.setUint32(0, args[6] >>> 0, true);
            dv.setUint32(4, args[7] >>> 0, true);
            const z = dv.getFloat64(0, true);
            mat4Rotation(_tempMat, angle, x, y, z);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 13. glScalef
        glScalef: (_sysCtx, _mem, args) => {
            const x = bitsToF32(args[0]);
            const y = bitsToF32(args[1]);
            const z = bitsToF32(args[2]);
            mat4Scale(_tempMat, x, y, z);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 14. glScaled
        glScaled: (_sysCtx, _mem, args) => {
            const ab = new ArrayBuffer(8);
            const dv = new DataView(ab);
            dv.setUint32(0, args[0] >>> 0, true);
            dv.setUint32(4, args[1] >>> 0, true);
            const x = dv.getFloat64(0, true);
            dv.setUint32(0, args[2] >>> 0, true);
            dv.setUint32(4, args[3] >>> 0, true);
            const y = dv.getFloat64(0, true);
            dv.setUint32(0, args[4] >>> 0, true);
            dv.setUint32(4, args[5] >>> 0, true);
            const z = dv.getFloat64(0, true);
            mat4Scale(_tempMat, x, y, z);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 15. glOrtho
        glOrtho: (_sysCtx, _mem, args) => {
            const ab = new ArrayBuffer(8);
            const dv = new DataView(ab);
            dv.setUint32(0, args[0] >>> 0, true);
            dv.setUint32(4, args[1] >>> 0, true);
            const left = dv.getFloat64(0, true);
            dv.setUint32(0, args[2] >>> 0, true);
            dv.setUint32(4, args[3] >>> 0, true);
            const right = dv.getFloat64(0, true);
            dv.setUint32(0, args[4] >>> 0, true);
            dv.setUint32(4, args[5] >>> 0, true);
            const bottom = dv.getFloat64(0, true);
            dv.setUint32(0, args[6] >>> 0, true);
            dv.setUint32(4, args[7] >>> 0, true);
            const top = dv.getFloat64(0, true);
            dv.setUint32(0, args[8] >>> 0, true);
            dv.setUint32(4, args[9] >>> 0, true);
            const near = dv.getFloat64(0, true);
            dv.setUint32(0, args[10] >>> 0, true);
            dv.setUint32(4, args[11] >>> 0, true);
            const far = dv.getFloat64(0, true);
            mat4Ortho(_tempMat, left, right, bottom, top, near, far);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 16. glFrustum
        glFrustum: (_sysCtx, _mem, args) => {
            const ab = new ArrayBuffer(8);
            const dv = new DataView(ab);
            dv.setUint32(0, args[0] >>> 0, true);
            dv.setUint32(4, args[1] >>> 0, true);
            const left = dv.getFloat64(0, true);
            dv.setUint32(0, args[2] >>> 0, true);
            dv.setUint32(4, args[3] >>> 0, true);
            const right = dv.getFloat64(0, true);
            dv.setUint32(0, args[4] >>> 0, true);
            dv.setUint32(4, args[5] >>> 0, true);
            const bottom = dv.getFloat64(0, true);
            dv.setUint32(0, args[6] >>> 0, true);
            dv.setUint32(4, args[7] >>> 0, true);
            const top = dv.getFloat64(0, true);
            dv.setUint32(0, args[8] >>> 0, true);
            dv.setUint32(4, args[9] >>> 0, true);
            const near = dv.getFloat64(0, true);
            dv.setUint32(0, args[10] >>> 0, true);
            dv.setUint32(4, args[11] >>> 0, true);
            const far = dv.getFloat64(0, true);
            mat4Frustum(_tempMat, left, right, bottom, top, near, far);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 17. glLoadTransposeMatrixf
        glLoadTransposeMatrixf: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            const cur = ctx.currentMatrix();
            readFloat32Matrix(mem, ptr, cur);
            transposeInPlace(cur);
            return 0;
        },

        // 18. glLoadTransposeMatrixd
        glLoadTransposeMatrixd: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            const cur = ctx.currentMatrix();
            readFloat64Matrix(mem, ptr, cur);
            transposeInPlace(cur);
            return 0;
        },

        // 19. glMultTransposeMatrixf
        glMultTransposeMatrixf: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            readFloat32Matrix(mem, ptr, _tempMat);
            transposeInPlace(_tempMat);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },

        // 20. glMultTransposeMatrixd
        glMultTransposeMatrixd: (_sysCtx, _mem, args) => {
            const ptr = args[0] | 0;
            const mem = ctx.process.getCurrentMemory();
            readFloat64Matrix(mem, ptr, _tempMat);
            transposeInPlace(_tempMat);
            multiplyCurrentByTemp(ctx, _tempMat);
            return 0;
        },
    };
}
