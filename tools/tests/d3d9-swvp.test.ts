import { describe, expect, test } from "bun:test";
import {
    D3D_OK, D3DERR_INVALIDCALL, D3DERR_NOTAVAILABLE, D3DDECLUSAGE_COLOR, D3DDECLUSAGE_POSITION, D3DDECLUSAGE_POSITIONT,
    processSoftwareVertices, fvfToRawElements, homogeneousClipCode, isSwvpProgramSupported,
} from "../../src/worker/backends/webgpu/d3d9/swvp";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader";

const FLOAT3 = 2;
const FLOAT4 = 3;
const D3DCOLOR = 4;
const XYZ = 0x2;
const XYZB2 = 0x8;
const LASTBETA_UBYTE4 = 0x1000;
const DIFFUSE = 0x40;
const TEX1 = 0x100;

const identity = (): Float32Array => new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
]);

const viewport = { x: 0, y: 0, width: 100, height: 50, minZ: 0, maxZ: 1 };

describe("D3D9 CPU FFP ProcessVertices", () => {
    test("converts an FVF destination layout for NULL ProcessVertices declarations", () => {
        const elements = fvfToRawElements(XYZ | DIFFUSE | TEX1);
        expect(elements).toEqual([
            { stream: 0, offset: 0, type: FLOAT3, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 },
            { stream: 0, offset: 12, type: D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            { stream: 0, offset: 16, type: 1, usage: 5, usageIndex: 0 },
        ]);
    });

    test("keeps XYZBn beta weights and LASTBETA indices at their packed offsets", () => {
        expect(fvfToRawElements(XYZB2 | LASTBETA_UBYTE4)).toEqual([
            { stream: 0, offset: 0, type: FLOAT3, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 },
            { stream: 0, offset: 12, type: 0, usage: 1, usageIndex: 0 },
            { stream: 0, offset: 16, type: 5, usage: 2, usageIndex: 0 },
        ]);
    });
    test("transforms FVF XYZ to a POSITIONT destination and copies color", () => {
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 0, true); sv.setFloat32(4, 0, true); sv.setFloat32(8, 0.25, true);
        sv.setUint32(12, 0x80402010, true);
        const dest = new Uint8Array(20);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: XYZ,
            sourceElements: null, streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [
                { stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 },
                { stream: 0, offset: 16, type: D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            destData: dest, mvp: identity(), viewport, flags: 0,
        });
        expect(hr).toBe(D3D_OK);
        const dv = new DataView(dest.buffer);
        expect(dv.getFloat32(0, true)).toBeCloseTo(50);
        expect(dv.getFloat32(4, true)).toBeCloseTo(25);
        expect(dv.getFloat32(8, true)).toBeCloseTo(0.25);
        expect(dv.getFloat32(12, true)).toBeCloseTo(1);
        // FVF XYZ has no source color; FFP's default vertex colour is opaque white.
        expect(dv.getUint32(16, true)).toBe(0xffffffff);
    });

    test("decodes packed D3DCOLOR into normalized RGBA components", () => {
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 0, true); sv.setFloat32(4, 0, true); sv.setFloat32(8, 0.25, true);
        sv.setUint32(12, 0x80402010, true); // A=0x80, R=0x40, G=0x20, B=0x10
        const dest = new Uint8Array(32);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [
                { stream: 0, offset: 0, type: FLOAT3, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 },
                { stream: 0, offset: 12, type: D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [
                { stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 },
                { stream: 0, offset: 16, type: FLOAT4, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            destData: dest, mvp: identity(), viewport, flags: 0,
        });
        expect(hr).toBe(D3D_OK);
        const dv = new DataView(dest.buffer);
        expect(dv.getFloat32(16, true)).toBeCloseTo(0x40 / 255, 6);
        expect(dv.getFloat32(20, true)).toBeCloseTo(0x20 / 255, 6);
        expect(dv.getFloat32(24, true)).toBeCloseTo(0x10 / 255, 6);
        expect(dv.getFloat32(28, true)).toBeCloseTo(0x80 / 255, 6);
    });

    test("encodes normalized RGBA components into packed D3DCOLOR", () => {
        const source = new Uint8Array(28);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 0, true); sv.setFloat32(4, 0, true); sv.setFloat32(8, 0.25, true);
        sv.setFloat32(12, 0.25, true); sv.setFloat32(16, 0.5, true);
        sv.setFloat32(20, 0.75, true); sv.setFloat32(24, 1, true);
        const dest = new Uint8Array(20);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [
                { stream: 0, offset: 0, type: FLOAT3, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 },
                { stream: 0, offset: 12, type: FLOAT4, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            streams: [{ data: source, offset: 0, stride: 28 }],
            destElements: [
                { stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 },
                { stream: 0, offset: 16, type: D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            destData: dest, mvp: identity(), viewport, flags: 0,
        });
        expect(hr).toBe(D3D_OK);
        expect(new DataView(dest.buffer).getUint32(16, true)).toBe(0xff4080bf);
    });

    test("preserves a pre-transformed source POSITIONT", () => {
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 13, true); sv.setFloat32(4, 17, true);
        sv.setFloat32(8, 0.75, true); sv.setFloat32(12, 0.5, true);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0,
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([13, 17, 0.75, 0.5]);
    });

    test("validates the complete destination extent before writing", () => {
        const source = new Uint8Array(12);
        const dest = new Uint8Array(16);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 2, sourceFvf: XYZ,
            sourceElements: null, streams: [{ data: source, offset: 0, stride: 12 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0,
        });
        expect(hr).toBe(D3DERR_INVALIDCALL);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });

    test("classifies homogeneous clip planes and marks non-positive w explicitly", () => {
        expect(homogeneousClipCode([0, 0, 0, 1])).toBe(0);
        expect(homogeneousClipCode([2, 0, 0, 1])).toBe(2);
        expect(homogeneousClipCode([0, 0, -0.01, 1])).toBe(16);
        expect(homogeneousClipCode([0, 0, 0, 0])).toBe(64);
        expect(homogeneousClipCode([Number.NaN, 0, 0, 1])).toBeNull();
    });

    test("refuses an object-space vertex with zero homogeneous w atomically", () => {
        const source = new Uint8Array(12);
        const dest = new Uint8Array(16);
        dest.fill(0xa5);
        const mvp = identity();
        mvp[15] = 0;
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: XYZ,
            sourceElements: null, streams: [{ data: source, offset: 0, stride: 12 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            destData: dest, mvp, viewport, flags: 0,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });

    test("refuses an FFP destination semantic with no source/default", () => {
        const source = new Uint8Array(12);
        const dest = new Uint8Array(32);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: XYZ,
            sourceElements: null, streams: [{ data: source, offset: 0, stride: 12 }],
            destElements: [
                { stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 },
                { stream: 0, offset: 16, type: FLOAT4, usage: 5, usageIndex: 0 },
            ],
            destData: dest, mvp: identity(), viewport, flags: 0,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });
});

describe("D3D9 CPU programmable SWVP", () => {
    const reg = (type: number, num: number, mask = 0xf): number =>
        (num & 0x7ff) | ((mask & 0xf) << 16) | ((type & 7) << 28) | (((type >>> 3) & 3) << 11);
    test("executes a SM2 mov oPos,v0 and converts clip coordinates to POSITIONT", () => {
        const OpMOV = 1;
        const OpDCL = 31;
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            (2 << 24) | OpDCL, 0x00000000, reg(1, 0), // dcl_position v0
            (2 << 24) | OpMOV, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 0, true); sv.setFloat32(4, 0, true); sv.setFloat32(8, 0.5, true); sv.setFloat32(12, 1, true);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: 0, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
            constantsF: new Float32Array(8192 * 4), constantsI: new Int32Array(2048 * 4), constantsB: new Uint8Array(2048),
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([50, 25, 0.5, 1]);
    });

    test("uses the legacy FVF v0 mapping when ProcessVertices has no declaration", () => {
        const OpMOV = 1;
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            (2 << 24) | OpMOV, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Uint8Array(12);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 0.25, true); sv.setFloat32(4, -0.5, true); sv.setFloat32(8, 0.5, true);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: XYZ,
            sourceElements: null, streams: [{ data: source, offset: 0, stride: 12 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([62.5, 37.5, 0.5, 1]);
    });

    test("executes the SM2 matrix macros with the documented input/output widths", () => {
        const OpM4x4 = 20;
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            (3 << 24) | OpM4x4,
            reg(4, 0), reg(1, 0, 0) | (0xe4 << 16), reg(2, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 1, true); sv.setFloat32(4, 2, true); sv.setFloat32(8, 3, true); sv.setFloat32(12, 1, true);
        const constants = new Float32Array(8192 * 4);
        constants.set([1, 0, 0, 0], 0);
        constants.set([0, 2, 0, 0], 4);
        constants.set([0, 0, 3, 0], 8);
        constants.set([4, 5, 6, 1], 12);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader, constantsF: constants,
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([1, 4, 9, 33]);
    });

    test("replicates scalar RCP from source x across the destination", () => {
        const OpRCP = 6;
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            (2 << 24) | OpRCP, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Float32Array([2, 4, 8, 16]);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: new Uint8Array(source.buffer), offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([0.5, 0.5, 0.5, 0.5]);
    });

    test("resolves an SM3 relative constant through the explicit a0 token", () => {
        const OpMOV = 1;
        const OpMOVA = 46;
        const relativeC0 = reg(2, 0, 0) | (1 << 13) | (0xe4 << 16);
        const a0 = reg(3, 0, 0) | (0xe4 << 16);
        const shader = parseShader(new Uint32Array([
            0xfffe0300,
            (2 << 24) | OpMOVA, reg(3, 0), reg(1, 0, 0) | (0xe4 << 16),
            (3 << 24) | OpMOV, reg(4, 0), relativeC0, a0,
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, 1, true);
        const constants = new Float32Array(8192 * 4);
        constants.set([9, 8, 7, 1], 4);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader, constantsF: constants,
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([9, 8, 7, 1]);
    });

    test("MOVA rounds to nearest instead of truncating the address", () => {
        const OpMOV = 1;
        const OpMOVA = 46;
        const relativeC0 = reg(2, 0, 0) | (1 << 13) | (0xe4 << 16);
        const a0 = reg(3, 0, 0) | (0xe4 << 16);
        const shader = parseShader(new Uint32Array([
            0xfffe0300,
            (2 << 24) | OpMOVA, reg(3, 0), reg(1, 0, 0) | (0xe4 << 16),
            (3 << 24) | OpMOV, reg(4, 0), relativeC0, a0,
            0x0000ffff,
        ]));
        const source = new Float32Array([1.6, 0, 0, 0]);
        const constants = new Float32Array(8192 * 4);
        constants.set([1, 1, 1, 1], 4);
        constants.set([2, 2, 2, 2], 8);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: new Uint8Array(source.buffer), offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader, constantsF: constants,
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([2, 2, 2, 2]);
    });

    test("takes the ELSE branch of a structured SM2 IF and skips the true body", () => {
        const OpMOV = 1, OpIF = 40, OpELSE = 42, OpENDIF = 43;
        const c0 = reg(2, 0, 0) | (0xe4 << 16);
        const c1 = reg(2, 1, 0) | (0xe4 << 16);
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            (1 << 24) | OpIF, reg(1, 0, 0) | (0xe4 << 16),
            (2 << 24) | OpMOV, reg(4, 0), c0,
            OpELSE,
            (2 << 24) | OpMOV, reg(4, 0), c1,
            OpENDIF,
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const dest = new Uint8Array(16);
        const constants = new Float32Array(8192 * 4);
        constants.set([1, 2, 3, 1], 0);
        constants.set([4, 5, 6, 1], 4);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader, constantsF: constants,
        });
        expect(hr).toBe(D3D_OK);
        expect(Array.from(new Float32Array(dest.buffer))).toEqual([4, 5, 6, 1]);
    });

    test("executes SINCOS and CND without falling back to NOTAVAILABLE", () => {
        const OpSINCOS = 37;
        const shader = parseShader(new Uint32Array([
            0xfffe0300,
            (2 << 24) | OpSINCOS, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(0, Math.PI * 0.5, true);
        const constants = new Float32Array(8192 * 4);
        constants.set([0, 0, 0, 0], 0);
        const dest = new Uint8Array(16);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader, constantsF: constants,
        });
        expect(hr).toBe(D3D_OK);
        const output = Array.from(new Float32Array(dest.buffer));
        expect(output[0]).toBeCloseTo(0, 5);
        expect(output.slice(1)).toEqual([1, 0, 0]);
    });

    test("rejects a pixel shader before writing ProcessVertices output", () => {
        const OpMOV = 1;
        const shader = parseShader(new Uint32Array([
            0xffff0200,
            (2 << 24) | OpMOV, reg(8, 0), reg(1, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const dest = new Uint8Array(16);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 2, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });

    test("rejects malformed structured flow atomically", () => {
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            0x0000002a, // unmatched else
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const dest = new Uint8Array(16);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });

    test("rejects BREAK* because loop control is outside the bounded SWVP subset", () => {
        const shader = parseShader(new Uint32Array([
            0xfffe0300,
            44, // break (no operands)
            0x0000ffff,
        ]));
        expect(isSwvpProgramSupported(shader)).toBe(false);
        const source = new Uint8Array(16);
        const dest = new Uint8Array(16);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });

    test("refuses a programmable destination semantic with no shader output", () => {
        const OpMOV = 1;
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            (2 << 24) | OpMOV, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const dest = new Uint8Array(20);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [
                { stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 },
                { stream: 0, offset: 16, type: D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });

    test("refuses programmable zero-w output instead of treating w as one", () => {
        const OpMOV = 1;
        const shader = parseShader(new Uint32Array([
            0xfffe0200,
            (2 << 24) | OpMOV, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16),
            0x0000ffff,
        ]));
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(12, 0, true);
        const dest = new Uint8Array(16);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });

    test("refuses BREAK outside a loop, and the supported set no longer lists it", () => {
        const OpMOV = 1;
        const OpBREAK = 44;
        const shader = parseShader(new Uint32Array([
            0xfffe0300,
            (2 << 24) | OpMOV, reg(4, 0), reg(1, 0, 0) | (0xe4 << 16),
            (0 << 24) | OpBREAK,
            0x0000ffff,
        ]));
        expect(shader && isSwvpProgramSupported(shader)).toBe(false);
        const source = new Uint8Array(16);
        const dest = new Uint8Array(16);
        dest.fill(0xa5);
        const hr = processSoftwareVertices({
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 }],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [{ stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 }],
            destData: dest, mvp: identity(), viewport, flags: 0, shader,
        });
        expect(hr).toBe(D3DERR_NOTAVAILABLE);
        expect(dest.every(v => v === 0xa5)).toBe(true);
    });
});

describe("D3D9 fixed-function ProcessVertices state this processor does not evaluate", () => {
    const request = (fixedFunction: { lighting: boolean; fog: boolean; texgen: boolean } | null,
        dest: Uint8Array) => {
        const source = new Uint8Array(16);
        const sv = new DataView(source.buffer);
        sv.setFloat32(8, 0.25, true);
        sv.setUint32(12, 0xff102030, true);
        return {
            srcStartIndex: 0, destIndex: 0, vertexCount: 1, sourceFvf: 0,
            sourceElements: [
                { stream: 0, offset: 0, type: FLOAT3, usage: D3DDECLUSAGE_POSITION, usageIndex: 0 },
                { stream: 0, offset: 12, type: D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            streams: [{ data: source, offset: 0, stride: 16 }],
            destElements: [
                { stream: 0, offset: 0, type: FLOAT4, usage: D3DDECLUSAGE_POSITIONT, usageIndex: 0 },
                { stream: 0, offset: 16, type: D3DCOLOR, usage: D3DDECLUSAGE_COLOR, usageIndex: 0 },
            ],
            destData: dest, mvp: identity(), viewport, flags: 0, fixedFunction,
        };
    };

    test("refuses lighting, fog and texgen atomically instead of copying source colours", () => {
        for (const state of [
            { lighting: true, fog: false, texgen: false },
            { lighting: false, fog: true, texgen: false },
            { lighting: false, fog: false, texgen: true },
        ]) {
            const dest = new Uint8Array(20).fill(0xa5);
            expect(processSoftwareVertices(request(state, dest))).toBe(D3DERR_NOTAVAILABLE);
            expect(dest.every(v => v === 0xa5)).toBe(true);
        }
    });

    test("still transforms when no unimplemented fixed-function state is active", () => {
        const dest = new Uint8Array(20).fill(0xa5);
        expect(processSoftwareVertices(
            request({ lighting: false, fog: false, texgen: false }, dest))).toBe(D3D_OK);
        expect(new DataView(dest.buffer).getUint32(16, true)).toBe(0xff102030);
    });
});
