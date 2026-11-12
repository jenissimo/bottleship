/**
 * GLU32 — OpenGL Utility Library
 *
 * Implements gluPerspective, gluOrtho2D, gluLookAt, gluBuild2DMipmaps,
 * gluProject, gluUnProject, and quadric/error stubs.
 *
 * All matrix functions operate on the opengl32 context's current matrix stack.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import type { OpenGL32 } from "./opengl32";
import { mat4Multiply } from "./opengl32/context";

// ---- f64 argument reader (each double = 2 DWORD slots in stdcall) ----

/** @transient(scratch for one float64 conversion, written before every read) */
const _dvBuf = new ArrayBuffer(8);
/** @transient(view over the float64 scratch above) */
const _dv = new DataView(_dvBuf);

function readF64(args: number[], slot: number): number {
    _dv.setUint32(0, args[slot] >>> 0, true);
    _dv.setUint32(4, args[slot + 1] >>> 0, true);
    return _dv.getFloat64(0, true);
}

// ---- Matrix helpers (column-major) ----

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

/** @transient(matrix scratch, fully written before each multiply) */
const _tempMat = new Float32Array(16);

function multiplyCurrentMatrix(process: Process, temp: Float32Array): void {
    const gl32 = process.getModule("opengl32") as OpenGL32 | undefined;
    const ctx = gl32?.getContext();
    if (!ctx) return;
    const cur = ctx.currentMatrix();
    const result = new Float32Array(16);
    mat4Multiply(result, cur, temp);
    cur.set(result);
}

// ---- Pixel format helpers ----

const GL_UNSIGNED_BYTE = 0x1401;
const GL_RGBA = 0x1908;
const GL_RGB = 0x1907;
const GL_BGR = 0x80E0;
const GL_BGRA = 0x80E1;
const GL_LUMINANCE = 0x1909;
const GL_LUMINANCE_ALPHA = 0x190A;
const GL_ALPHA = 0x1906;
const GL_TEXTURE_2D = 0x0DE1;

function srcBpp(format: number): number {
    switch (format) {
        case GL_RGBA: case GL_BGRA: return 4;
        case GL_RGB: case GL_BGR: return 3;
        case GL_LUMINANCE: case GL_ALPHA: return 1;
        case GL_LUMINANCE_ALPHA: return 2;
        default: return 4;
    }
}

function nextPow2(v: number): number {
    let n = 1;
    while (n < v) n <<= 1;
    return n;
}

// ---- GLU error strings ----

const GLU_ERRORS: Record<number, string> = {
    0: "no error",
    0x0500: "invalid enum",
    0x0501: "invalid value",
    0x0502: "invalid operation",
    0x0503: "stack overflow",
    0x0504: "stack underflow",
    0x0505: "out of memory",
};

// ---- Quadric state ----

export interface GluQuadric {
    normals: number;
    texture: boolean;
    orientation: number;
    drawStyle: number;
}

export interface GluState {
    nextQuadricId: number;
    quadrics: Array<[number, GluQuadric]>;
}

/** @participant(opengl32) */
let nextQuadricId = 1;
/** @participant(opengl32) */
const quadrics = new Map<number, GluQuadric>();

export function captureGluState(): GluState {
    return {
        nextQuadricId,
        quadrics: [...quadrics].map(([id, q]) => [id, { normals: q.normals, texture: q.texture, orientation: q.orientation, drawStyle: q.drawStyle }]),
    };
}

export function restoreGluState(state: GluState): void {
    quadrics.clear();
    for (const [id, q] of state.quadrics) {
        quadrics.set(id, { normals: q.normals, texture: q.texture, orientation: q.orientation, drawStyle: q.drawStyle });
    }
    nextQuadricId = state.nextQuadricId;
}

export class Glu32 implements IModule {
    name = "glu32";
    exports: Record<string, ThunkImplementation> = {};
    private errorStringPtrs = new Map<number, number>();
    private gluStringPtr = 0;

    initialize(process: Process): void {

        // ==================== gluPerspective ====================
        // void gluPerspective(GLdouble fovy, GLdouble aspect, GLdouble zNear, GLdouble zFar)
        // Each GLdouble = 2 DWORD slots → 8 args total
        this.exports["gluPerspective"] = (_ctx, _mem, args) => {
            const fovy = readF64(args, 0);
            const aspect = readF64(args, 2);
            const zNear = readF64(args, 4);
            const zFar = readF64(args, 6);

            const radFovy = fovy * (Math.PI / 180);
            const f = 1.0 / Math.tan(radFovy / 2);
            const nf = zNear - zFar;

            _tempMat.fill(0);
            _tempMat[0] = f / aspect;
            _tempMat[5] = f;
            _tempMat[10] = (zFar + zNear) / nf;
            _tempMat[11] = -1;
            _tempMat[14] = (2 * zFar * zNear) / nf;

            multiplyCurrentMatrix(process, _tempMat);
            return 0;
        };

        // ==================== gluOrtho2D ====================
        // void gluOrtho2D(GLdouble left, GLdouble right, GLdouble bottom, GLdouble top)
        this.exports["gluOrtho2D"] = (_ctx, _mem, args) => {
            const left = readF64(args, 0);
            const right = readF64(args, 2);
            const bottom = readF64(args, 4);
            const top = readF64(args, 6);
            mat4Ortho(_tempMat, left, right, bottom, top, -1, 1);
            multiplyCurrentMatrix(process, _tempMat);
            return 0;
        };

        // ==================== gluLookAt ====================
        // void gluLookAt(eyeX,eyeY,eyeZ, centerX,centerY,centerZ, upX,upY,upZ)
        // 9 doubles = 18 DWORD args
        this.exports["gluLookAt"] = (_ctx, _mem, args) => {
            const eyeX = readF64(args, 0);
            const eyeY = readF64(args, 2);
            const eyeZ = readF64(args, 4);
            const centerX = readF64(args, 6);
            const centerY = readF64(args, 8);
            const centerZ = readF64(args, 10);
            const upX = readF64(args, 12);
            const upY = readF64(args, 14);
            const upZ = readF64(args, 16);

            // Forward = normalize(center - eye)
            let fx = centerX - eyeX, fy = centerY - eyeY, fz = centerZ - eyeZ;
            let flen = Math.sqrt(fx * fx + fy * fy + fz * fz);
            if (flen > 1e-10) { flen = 1 / flen; fx *= flen; fy *= flen; fz *= flen; }

            // Side = normalize(forward x up)
            let sx = fy * upZ - fz * upY;
            let sy = fz * upX - fx * upZ;
            let sz = fx * upY - fy * upX;
            let slen = Math.sqrt(sx * sx + sy * sy + sz * sz);
            if (slen > 1e-10) { slen = 1 / slen; sx *= slen; sy *= slen; sz *= slen; }

            // Recompute up = side x forward
            const ux = sy * fz - sz * fy;
            const uy = sz * fx - sx * fz;
            const uz = sx * fy - sy * fx;

            // Column-major rotation matrix
            _tempMat[0] = sx;   _tempMat[1] = ux;   _tempMat[2] = -fx;  _tempMat[3] = 0;
            _tempMat[4] = sy;   _tempMat[5] = uy;   _tempMat[6] = -fy;  _tempMat[7] = 0;
            _tempMat[8] = sz;   _tempMat[9] = uz;   _tempMat[10] = -fz; _tempMat[11] = 0;
            _tempMat[12] = -(sx * eyeX + sy * eyeY + sz * eyeZ);
            _tempMat[13] = -(ux * eyeX + uy * eyeY + uz * eyeZ);
            _tempMat[14] = -(-fx * eyeX + -fy * eyeY + -fz * eyeZ);
            _tempMat[15] = 1;

            multiplyCurrentMatrix(process, _tempMat);
            return 0;
        };

        // ==================== gluBuild2DMipmaps ====================
        // int gluBuild2DMipmaps(GLenum target, GLint internalFormat, GLsizei width, GLsizei height,
        //                       GLenum format, GLenum type, const void* data)
        this.exports["gluBuild2DMipmaps"] = (_ctx, _mem, args) => {
            const target = args[0] >>> 0;
            const internalFormat = args[1] | 0;
            const width = args[2] | 0;
            const height = args[3] | 0;
            const format = args[4] >>> 0;
            const type = args[5] >>> 0;
            const dataPtr = args[6] >>> 0;

            if (target !== GL_TEXTURE_2D || width <= 0 || height <= 0 || dataPtr === 0) return 0;

            const gl32 = process.getModule("opengl32") as OpenGL32 | undefined;
            const ctx = gl32?.getContext();
            if (!ctx) return 0;

            const texId = ctx.textureUnits[ctx.activeTextureUnit].boundTexture;
            if (texId === 0) return 0;

            let tex = ctx.textures.get(texId);
            if (!tex) {
                tex = {
                    id: texId, width: 0, height: 0, internalFormat: GL_RGBA,
                    data: null, wrapS: 0x2901, wrapT: 0x2901,
                    minFilter: 0x2601, magFilter: 0x2601,
                    dirty: false, gpuVersion: 0,
                };
                ctx.textures.set(texId, tex);
            }

            // Read source pixels and convert to RGBA8
            const mem = process.getCurrentMemory();
            const bpp = srcBpp(format);
            const pw2 = nextPow2(width);
            const ph2 = nextPow2(height);

            // Read source into RGBA
            const srcRGBA = new Uint8Array(width * height * 4);
            const byteOff = mem.byteOffset;
            if (type === GL_UNSIGNED_BYTE) {
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const si = dataPtr + (y * width + x) * bpp;
                        const di = (y * width + x) * 4;
                        switch (format) {
                            case GL_RGBA:
                                srcRGBA[di] = mem[si]; srcRGBA[di + 1] = mem[si + 1];
                                srcRGBA[di + 2] = mem[si + 2]; srcRGBA[di + 3] = mem[si + 3];
                                break;
                            case GL_BGRA:
                                srcRGBA[di] = mem[si + 2]; srcRGBA[di + 1] = mem[si + 1];
                                srcRGBA[di + 2] = mem[si]; srcRGBA[di + 3] = mem[si + 3];
                                break;
                            case GL_RGB:
                                srcRGBA[di] = mem[si]; srcRGBA[di + 1] = mem[si + 1];
                                srcRGBA[di + 2] = mem[si + 2]; srcRGBA[di + 3] = 255;
                                break;
                            case GL_BGR:
                                srcRGBA[di] = mem[si + 2]; srcRGBA[di + 1] = mem[si + 1];
                                srcRGBA[di + 2] = mem[si]; srcRGBA[di + 3] = 255;
                                break;
                            case GL_LUMINANCE: {
                                const l = mem[si];
                                srcRGBA[di] = srcRGBA[di + 1] = srcRGBA[di + 2] = l;
                                srcRGBA[di + 3] = 255;
                                break;
                            }
                            case GL_ALPHA:
                                srcRGBA[di] = srcRGBA[di + 1] = srcRGBA[di + 2] = 0;
                                srcRGBA[di + 3] = mem[si];
                                break;
                            case GL_LUMINANCE_ALPHA: {
                                const l2 = mem[si];
                                srcRGBA[di] = srcRGBA[di + 1] = srcRGBA[di + 2] = l2;
                                srcRGBA[di + 3] = mem[si + 1];
                                break;
                            }
                            default:
                                srcRGBA[di] = mem[si]; srcRGBA[di + 1] = mem[si + 1];
                                srcRGBA[di + 2] = mem[si + 2]; srcRGBA[di + 3] = bpp >= 4 ? mem[si + 3] : 255;
                                break;
                        }
                    }
                }
            }

            // Scale to power-of-2 if needed using bilinear
            let level0: Uint8Array;
            let w0 = width, h0 = height;
            if (pw2 !== width || ph2 !== height) {
                level0 = bilinearScale(srcRGBA, width, height, pw2, ph2);
                w0 = pw2;
                h0 = ph2;
            } else {
                level0 = srcRGBA;
            }

            // Set level 0
            tex.width = w0;
            tex.height = h0;
            tex.internalFormat = internalFormat;
            tex.data = level0;
            tex.dirty = true;
            tex.gpuVersion++;
            ctx.frameSnapshot.texUploads++;

            // We only upload level 0 — WebGPU can generate mipmaps via compute or we skip them.
            // Most games using gluBuild2DMipmaps just want the base texture loaded correctly.

            Logger.verbose(LogCategory.SYSTEM, `GLU32: gluBuild2DMipmaps tex=${texId} ${width}x${height} -> ${w0}x${h0}`);
            return 0;
        };

        // ==================== gluScaleImage ====================
        this.exports["gluScaleImage"] = () => {
            Logger.verbose(LogCategory.SYSTEM, "GLU32: gluScaleImage stub");
            return 0;
        };

        // ==================== gluProject ====================
        // int gluProject(objX,objY,objZ, model[16], proj[16], viewport[4], *winX, *winY, *winZ)
        // 3 doubles (6 slots) + 4 ptrs = 10 DWORD args
        this.exports["gluProject"] = (_ctx, _mem, args) => {
            const objX = readF64(args, 0);
            const objY = readF64(args, 2);
            const objZ = readF64(args, 4);
            const modelPtr = args[6] >>> 0;
            const projPtr = args[7] >>> 0;
            const viewPtr = args[8] >>> 0;
            const winXPtr = args[9] >>> 0;
            const winYPtr = args[10] >>> 0;
            const winZPtr = args[11] >>> 0;

            const mem = process.getCurrentMemory();
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Read model and proj as f64 column-major matrices
            const model = new Float64Array(16);
            const proj = new Float64Array(16);
            for (let ii = 0; ii < 16; ii++) {
                model[ii] = view.getFloat64(modelPtr + ii * 8, true);
                proj[ii] = view.getFloat64(projPtr + ii * 8, true);
            }

            // Read viewport
            const vpX = view.getInt32(viewPtr, true);
            const vpY = view.getInt32(viewPtr + 4, true);
            const vpW = view.getInt32(viewPtr + 8, true);
            const vpH = view.getInt32(viewPtr + 12, true);

            // Transform: v = proj * model * [objX, objY, objZ, 1]
            // model * obj
            const ex = model[0] * objX + model[4] * objY + model[8] * objZ + model[12];
            const ey = model[1] * objX + model[5] * objY + model[9] * objZ + model[13];
            const ez = model[2] * objX + model[6] * objY + model[10] * objZ + model[14];
            const ew = model[3] * objX + model[7] * objY + model[11] * objZ + model[15];
            // proj * eye
            let cx = proj[0] * ex + proj[4] * ey + proj[8] * ez + proj[12] * ew;
            let cy = proj[1] * ex + proj[5] * ey + proj[9] * ez + proj[13] * ew;
            let cz = proj[2] * ex + proj[6] * ey + proj[10] * ez + proj[14] * ew;
            const cw = proj[3] * ex + proj[7] * ey + proj[11] * ez + proj[15] * ew;

            if (Math.abs(cw) < 1e-12) return 0; // GL_FALSE

            cx /= cw; cy /= cw; cz /= cw;
            // Map to window
            const winX = vpX + vpW * (cx * 0.5 + 0.5);
            const winY = vpY + vpH * (cy * 0.5 + 0.5);
            const winZ = cz * 0.5 + 0.5;

            if (winXPtr) view.setFloat64(winXPtr, winX, true);
            if (winYPtr) view.setFloat64(winYPtr, winY, true);
            if (winZPtr) view.setFloat64(winZPtr, winZ, true);
            return 1; // GL_TRUE
        };

        // ==================== gluUnProject ====================
        this.exports["gluUnProject"] = (_ctx, _mem, args) => {
            const winX = readF64(args, 0);
            const winY = readF64(args, 2);
            const winZ = readF64(args, 4);
            const modelPtr = args[6] >>> 0;
            const projPtr = args[7] >>> 0;
            const viewPtr = args[8] >>> 0;
            const objXPtr = args[9] >>> 0;
            const objYPtr = args[10] >>> 0;
            const objZPtr = args[11] >>> 0;

            const mem = process.getCurrentMemory();
            const dview = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            const model = new Float64Array(16);
            const proj = new Float64Array(16);
            for (let ii = 0; ii < 16; ii++) {
                model[ii] = dview.getFloat64(modelPtr + ii * 8, true);
                proj[ii] = dview.getFloat64(projPtr + ii * 8, true);
            }

            const vpX = dview.getInt32(viewPtr, true);
            const vpY = dview.getInt32(viewPtr + 4, true);
            const vpW = dview.getInt32(viewPtr + 8, true);
            const vpH = dview.getInt32(viewPtr + 12, true);

            // Compute A = proj * model
            const A = new Float64Array(16);
            for (let col = 0; col < 4; col++) {
                for (let row = 0; row < 4; row++) {
                    let sum = 0;
                    for (let k = 0; k < 4; k++) sum += proj[k * 4 + row] * model[col * 4 + k];
                    A[col * 4 + row] = sum;
                }
            }

            // Invert A
            const inv = invert4x4(A);
            if (!inv) return 0; // GL_FALSE

            // Normalized device coords
            const ndcX = (winX - vpX) / vpW * 2 - 1;
            const ndcY = (winY - vpY) / vpH * 2 - 1;
            const ndcZ = winZ * 2 - 1;

            const ox = inv[0] * ndcX + inv[4] * ndcY + inv[8] * ndcZ + inv[12];
            const oy = inv[1] * ndcX + inv[5] * ndcY + inv[9] * ndcZ + inv[13];
            const oz = inv[2] * ndcX + inv[6] * ndcY + inv[10] * ndcZ + inv[14];
            const ow = inv[3] * ndcX + inv[7] * ndcY + inv[11] * ndcZ + inv[15];

            if (Math.abs(ow) < 1e-12) return 0;

            if (objXPtr) dview.setFloat64(objXPtr, ox / ow, true);
            if (objYPtr) dview.setFloat64(objYPtr, oy / ow, true);
            if (objZPtr) dview.setFloat64(objZPtr, oz / ow, true);
            return 1; // GL_TRUE
        };

        // ==================== Quadric Objects ====================
        this.exports["gluNewQuadric"] = () => {
            const id = nextQuadricId++;
            quadrics.set(id, { normals: 0x186A1 /* GLU_SMOOTH */, texture: false, orientation: 0x186A2, drawStyle: 0x186A4 });
            return id;
        };
        this.exports["gluDeleteQuadric"] = (_ctx, _mem, args) => { quadrics.delete(args[0] >>> 0); return 0; };
        this.exports["gluQuadricNormals"] = (_ctx, _mem, args) => {
            const q = quadrics.get(args[0] >>> 0);
            if (q) q.normals = args[1] >>> 0;
            return 0;
        };
        this.exports["gluQuadricTexture"] = (_ctx, _mem, args) => {
            const q = quadrics.get(args[0] >>> 0);
            if (q) q.texture = !!(args[1]);
            return 0;
        };
        this.exports["gluQuadricOrientation"] = (_ctx, _mem, args) => {
            const q = quadrics.get(args[0] >>> 0);
            if (q) q.orientation = args[1] >>> 0;
            return 0;
        };
        this.exports["gluQuadricDrawStyle"] = (_ctx, _mem, args) => {
            const q = quadrics.get(args[0] >>> 0);
            if (q) q.drawStyle = args[1] >>> 0;
            return 0;
        };

        // Quadric drawing — stubs (would need to emit glBegin/glVertex/glEnd calls)
        this.exports["gluSphere"] = () => {
            Logger.verbose(LogCategory.SYSTEM, "GLU32: gluSphere stub");
            return 0;
        };
        this.exports["gluCylinder"] = () => {
            Logger.verbose(LogCategory.SYSTEM, "GLU32: gluCylinder stub");
            return 0;
        };
        this.exports["gluDisk"] = () => {
            Logger.verbose(LogCategory.SYSTEM, "GLU32: gluDisk stub");
            return 0;
        };
        this.exports["gluPartialDisk"] = () => {
            Logger.verbose(LogCategory.SYSTEM, "GLU32: gluPartialDisk stub");
            return 0;
        };

        // ==================== Error/String ====================
        this.exports["gluErrorString"] = (_ctx, _mem, args) => {
            const error = args[0] >>> 0;
            let ptr = this.errorStringPtrs.get(error);
            if (!ptr) {
                const str = GLU_ERRORS[error] || "unknown error";
                ptr = process.memory.alloc(str.length + 1);
                const mem = process.getCurrentMemory();
                for (let ii = 0; ii < str.length; ii++) mem[ptr + ii] = str.charCodeAt(ii);
                mem[ptr + str.length] = 0;
                this.errorStringPtrs.set(error, ptr);
            }
            return ptr;
        };

        this.exports["gluGetString"] = (_ctx, _mem, args) => {
            const name = args[0] >>> 0;
            if (!this.gluStringPtr) {
                const str = "1.2.2.0 Microsoft Corporation";
                this.gluStringPtr = process.memory.alloc(str.length + 1);
                const mem = process.getCurrentMemory();
                for (let ii = 0; ii < str.length; ii++) mem[this.gluStringPtr + ii] = str.charCodeAt(ii);
                mem[this.gluStringPtr + str.length] = 0;
            }
            return this.gluStringPtr;
        };

        // ==================== NURBS stubs ====================
        this.exports["gluNewNurbsRenderer"] = () => 0xDEAD0001;
        this.exports["gluDeleteNurbsRenderer"] = () => 0;
        this.exports["gluNurbsProperty"] = () => 0;

        // ==================== Tesselator stubs ====================
        this.exports["gluNewTess"] = () => 0xDEAD0002;
        this.exports["gluDeleteTess"] = () => 0;
    }

    reset(): void {
        quadrics.clear();
        nextQuadricId = 1;
        this.dropCachedStrings();
    }

    dropCachedStrings(): void {
        this.errorStringPtrs.clear();
        this.gluStringPtr = 0;
    }
}

// ---- Bilinear scale (RGBA8) ----

function bilinearScale(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
    const dst = new Uint8Array(dw * dh * 4);
    const xr = sw / dw;
    const yr = sh / dh;
    for (let dy = 0; dy < dh; dy++) {
        const sy = dy * yr;
        const y0 = Math.floor(sy);
        const y1 = Math.min(y0 + 1, sh - 1);
        const fy = sy - y0;
        for (let dx = 0; dx < dw; dx++) {
            const sx = dx * xr;
            const x0 = Math.floor(sx);
            const x1 = Math.min(x0 + 1, sw - 1);
            const fx = sx - x0;
            const di = (dy * dw + dx) * 4;
            for (let c = 0; c < 4; c++) {
                const tl = src[(y0 * sw + x0) * 4 + c];
                const tr = src[(y0 * sw + x1) * 4 + c];
                const bl = src[(y1 * sw + x0) * 4 + c];
                const br = src[(y1 * sw + x1) * 4 + c];
                const top = tl + (tr - tl) * fx;
                const bot = bl + (br - bl) * fx;
                dst[di + c] = top + (bot - top) * fy;
            }
        }
    }
    return dst;
}

// ---- 4x4 matrix inversion (column-major f64) ----

function invert4x4(m: Float64Array): Float64Array | null {
    const inv = new Float64Array(16);
    const s = m;

    inv[0] = s[5]*s[10]*s[15] - s[5]*s[11]*s[14] - s[9]*s[6]*s[15] + s[9]*s[7]*s[14] + s[13]*s[6]*s[11] - s[13]*s[7]*s[10];
    inv[4] = -s[4]*s[10]*s[15] + s[4]*s[11]*s[14] + s[8]*s[6]*s[15] - s[8]*s[7]*s[14] - s[12]*s[6]*s[11] + s[12]*s[7]*s[10];
    inv[8] = s[4]*s[9]*s[15] - s[4]*s[11]*s[13] - s[8]*s[5]*s[15] + s[8]*s[7]*s[13] + s[12]*s[5]*s[11] - s[12]*s[7]*s[9];
    inv[12] = -s[4]*s[9]*s[14] + s[4]*s[10]*s[13] + s[8]*s[5]*s[14] - s[8]*s[6]*s[13] - s[12]*s[5]*s[10] + s[12]*s[6]*s[9];
    inv[1] = -s[1]*s[10]*s[15] + s[1]*s[11]*s[14] + s[9]*s[2]*s[15] - s[9]*s[3]*s[14] - s[13]*s[2]*s[11] + s[13]*s[3]*s[10];
    inv[5] = s[0]*s[10]*s[15] - s[0]*s[11]*s[14] - s[8]*s[2]*s[15] + s[8]*s[3]*s[14] + s[12]*s[2]*s[11] - s[12]*s[3]*s[10];
    inv[9] = -s[0]*s[9]*s[15] + s[0]*s[11]*s[13] + s[8]*s[1]*s[15] - s[8]*s[3]*s[13] - s[12]*s[1]*s[11] + s[12]*s[3]*s[9];
    inv[13] = s[0]*s[9]*s[14] - s[0]*s[10]*s[13] - s[8]*s[1]*s[14] + s[8]*s[2]*s[13] + s[12]*s[1]*s[10] - s[12]*s[2]*s[9];
    inv[2] = s[1]*s[6]*s[15] - s[1]*s[7]*s[14] - s[5]*s[2]*s[15] + s[5]*s[3]*s[14] + s[13]*s[2]*s[7] - s[13]*s[3]*s[6];
    inv[6] = -s[0]*s[6]*s[15] + s[0]*s[7]*s[14] + s[4]*s[2]*s[15] - s[4]*s[3]*s[14] - s[12]*s[2]*s[7] + s[12]*s[3]*s[6];
    inv[10] = s[0]*s[5]*s[15] - s[0]*s[7]*s[13] - s[4]*s[1]*s[15] + s[4]*s[3]*s[13] + s[12]*s[1]*s[7] - s[12]*s[3]*s[5];
    inv[14] = -s[0]*s[5]*s[14] + s[0]*s[6]*s[13] + s[4]*s[1]*s[14] - s[4]*s[2]*s[13] - s[12]*s[1]*s[6] + s[12]*s[2]*s[5];
    inv[3] = -s[1]*s[6]*s[11] + s[1]*s[7]*s[10] + s[5]*s[2]*s[11] - s[5]*s[3]*s[10] - s[9]*s[2]*s[7] + s[9]*s[3]*s[6];
    inv[7] = s[0]*s[6]*s[11] - s[0]*s[7]*s[10] - s[4]*s[2]*s[11] + s[4]*s[3]*s[10] + s[8]*s[2]*s[7] - s[8]*s[3]*s[6];
    inv[11] = -s[0]*s[5]*s[11] + s[0]*s[7]*s[9] + s[4]*s[1]*s[11] - s[4]*s[3]*s[9] - s[8]*s[1]*s[7] + s[8]*s[3]*s[5];
    inv[15] = s[0]*s[5]*s[10] - s[0]*s[6]*s[9] - s[4]*s[1]*s[10] + s[4]*s[2]*s[9] + s[8]*s[1]*s[6] - s[8]*s[2]*s[5];

    const det = s[0]*inv[0] + s[1]*inv[4] + s[2]*inv[8] + s[3]*inv[12];
    if (Math.abs(det) < 1e-20) return null;
    const invDet = 1 / det;
    for (let ii = 0; ii < 16; ii++) inv[ii] *= invDet;
    return inv;
}
