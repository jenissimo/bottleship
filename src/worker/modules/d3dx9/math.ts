/**
 * D3DX math helpers (matrices, vectors, planes).
 */

import { Mem } from '../../core/memory/mem-accessor';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

export function u32AsFloat(value: number): number {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value >>> 0, true);
    return view.getFloat32(0, true);
}

function readMatrix(addr: number): Float32Array | null {
    if (!addr) return null;
    const out = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
        const v = Mem.readFloat32(addr + i * 4);
        if (v === null) return null;
        out[i] = v;
    }
    return out;
}

function writeMatrix(addr: number, m: Float32Array): boolean {
    if (!addr) return false;
    for (let i = 0; i < 16; i++) {
        if (!Mem.writeFloat32(addr + i * 4, m[i])) return false;
    }
    return true;
}

/** Reinterpret a stack dword as the FLOAT the caller pushed (cdecl passes it by value). */
function f32FromBits(bits: number): number {
    f32ScratchU32[0] = bits >>> 0;
    return f32ScratchF32[0]!;
}
const f32ScratchBuffer = new ArrayBuffer(4);
const f32ScratchU32 = new Uint32Array(f32ScratchBuffer);
const f32ScratchF32 = new Float32Array(f32ScratchBuffer);

function readVec3(addr: number): [number, number, number] | null {
    if (!addr) return null;
    const x = Mem.readFloat32(addr);
    const y = Mem.readFloat32(addr + 4);
    const z = Mem.readFloat32(addr + 8);
    if (x === null || y === null || z === null) return null;
    return [x, y, z];
}

function writeVec3(addr: number, x: number, y: number, z: number): boolean {
    if (!addr) return false;
    return Mem.writeFloat32(addr, x)
        && Mem.writeFloat32(addr + 4, y)
        && Mem.writeFloat32(addr + 8, z);
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[row * 4 + k] * b[k * 4 + col];
            }
            out[row * 4 + col] = sum;
        }
    }
    return out;
}

export function createMathExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['D3DXMatrixIdentity'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const m = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixMultiply'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const m1 = readMatrix(args[1] >>> 0);
        const m2 = readMatrix(args[2] >>> 0);
        if (!m1 || !m2) return 0;
        return writeMatrix(pOut, multiplyMatrices(m1, m2)) ? pOut : 0;
    };

    exports['D3DXMatrixTranslation'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const x = u32AsFloat(args[1]);
        const y = u32AsFloat(args[2]);
        const z = u32AsFloat(args[3]);
        const m = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            x, y, z, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixRotationY'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const angle = u32AsFloat(args[1]);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const m = new Float32Array([
            c, 0, -s, 0,
            0, 1, 0, 0,
            s, 0, c, 0,
            0, 0, 0, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixPerspectiveFovLH'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const fovy = u32AsFloat(args[1]);
        const aspect = u32AsFloat(args[2]);
        const zn = u32AsFloat(args[3]);
        const zf = u32AsFloat(args[4]);
        const yScale = 1 / Math.tan(fovy * 0.5);
        const xScale = aspect !== 0 ? yScale / aspect : yScale;
        const m = new Float32Array(16);
        m[0] = xScale;
        m[5] = yScale;
        m[10] = zf / (zf - zn);
        m[11] = 1;
        m[14] = (-zn * zf) / (zf - zn);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixLookAtLH'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const eye = readVec3(args[1] >>> 0);
        const at = readVec3(args[2] >>> 0);
        const up = readVec3(args[3] >>> 0);
        if (!eye || !at || !up) return 0;

        let zx = eye[0] - at[0];
        let zy = eye[1] - at[1];
        let zz = eye[2] - at[2];
        let len = Math.hypot(zx, zy, zz);
        if (len === 0) return 0;
        zx /= len; zy /= len; zz /= len;

        let xx = up[1] * zz - up[2] * zy;
        let xy = up[2] * zx - up[0] * zz;
        let xz = up[0] * zy - up[1] * zx;
        len = Math.hypot(xx, xy, xz);
        if (len === 0) return 0;
        xx /= len; xy /= len; xz /= len;

        const yx = zy * xz - zz * xy;
        const yy = zz * xx - zx * xz;
        const yz = zx * xy - zy * xx;

        const m = new Float32Array([
            xx, yx, zx, 0,
            xy, yy, zy, 0,
            xz, yz, zz, 0,
            -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
            -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
            -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
            1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    /**
     * Catmull-Rom spline through V1..V2 with V0/V3 as the outer control points, exactly as
     * d3dx9 spells it. A title interpolating a camera or an animation track calls this per
     * object per frame and uses the OUT-PARAM, not the return value — leaving it unwritten
     * hands back whatever was on the caller's stack.
     */
    exports['D3DXVec3CatmullRom'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v0 = readVec3(args[1] >>> 0);
        const v1 = readVec3(args[2] >>> 0);
        const v2 = readVec3(args[3] >>> 0);
        const v3 = readVec3(args[4] >>> 0);
        // The weight is a FLOAT argument; it arrives as the raw 32-bit pattern in the slot.
        const s = f32FromBits(args[5] >>> 0);
        if (!pOut || !v0 || !v1 || !v2 || !v3) return 0;
        const s2 = s * s;
        const s3 = s2 * s;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            out[i] = 0.5 * (
                2 * v1[i]
                + (-v0[i] + v2[i]) * s
                + (2 * v0[i] - 5 * v1[i] + 4 * v2[i] - v3[i]) * s2
                + (-v0[i] + 3 * v1[i] - 3 * v2[i] + v3[i]) * s3
            );
        }
        return writeVec3(pOut, out[0], out[1], out[2]) ? pOut : 0;
    };

    exports['D3DXVec3Normalize'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v = readVec3(args[1] >>> 0);
        if (!v) return 0;
        const len = Math.hypot(v[0], v[1], v[2]);
        if (len === 0) return 0;
        return writeVec3(pOut, v[0] / len, v[1] / len, v[2] / len) ? pOut : 0;
    };

    exports['D3DXVec3TransformCoord'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v = readVec3(args[1] >>> 0);
        const m = readMatrix(args[2] >>> 0);
        if (!v || !m) return 0;
        const x = v[0] * m[0] + v[1] * m[4] + v[2] * m[8] + m[12];
        const y = v[0] * m[1] + v[1] * m[5] + v[2] * m[9] + m[13];
        const z = v[0] * m[2] + v[1] * m[6] + v[2] * m[10] + m[14];
        const w = v[0] * m[3] + v[1] * m[7] + v[2] * m[11] + m[15];
        if (w === 0) return 0;
        return writeVec3(pOut, x / w, y / w, z / w) ? pOut : 0;
    };

    exports['D3DXPlaneIntersectLine'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const pPlane = args[1] >>> 0;
        const pv1 = args[2] >>> 0;
        const pv2 = args[3] >>> 0;
        if (!pOut || !pPlane || !pv1 || !pv2) return 0;

        const a = Mem.readFloat32(pPlane);
        const b = Mem.readFloat32(pPlane + 4);
        const c = Mem.readFloat32(pPlane + 8);
        const d = Mem.readFloat32(pPlane + 12);
        const v1 = readVec3(pv1);
        const v2 = readVec3(pv2);
        if (a === null || b === null || c === null || d === null || !v1 || !v2) return 0;

        const dx = v2[0] - v1[0];
        const dy = v2[1] - v1[1];
        const dz = v2[2] - v1[2];
        const denom = a * dx + b * dy + c * dz;
        if (Math.abs(denom) < 1e-8) {
            writeVec3(pOut, 0, 0, 0);
            return 0;
        }
        const t = -(a * v1[0] + b * v1[1] + c * v1[2] + d) / denom;
        writeVec3(pOut, v1[0] + dx * t, v1[1] + dy * t, v1[2] + dz * t);
        return pOut;
    };

    return exports;
}
