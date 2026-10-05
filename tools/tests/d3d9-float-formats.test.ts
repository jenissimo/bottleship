import { describe, expect, test } from "bun:test";
import {
    checkDxDeviceFormat,
    D3DERR_NOTAVAILABLE,
    D3D_OK,
    isDxUnsupportedFormat,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";
import {
    D3DFMT_A16B16G16R16F,
    D3DFMT_A32B32G32R32F,
    D3DFMT_G16R16F,
    D3DFMT_G32R32F,
    D3DFMT_R16F,
    D3DFMT_R32F,
    d3dFloatFormatInfo,
    d3dFormatBpp,
    decodeD3DTextureToRgba8,
    float16BitsToFloat32,
    float32ToFloat16Bits,
    getD3DTextureLayout,
} from "../../src/worker/backends/webgpu/shared/texture-formats";
import { copyD3D9SurfaceRectCpu, writeD3D9Pixel } from "../../src/worker/backends/webgpu/d3d9/copy-cpu";

const FLOAT_FORMATS = [
    D3DFMT_R16F,
    D3DFMT_G16R16F,
    D3DFMT_A16B16G16R16F,
    D3DFMT_R32F,
    D3DFMT_G32R32F,
    D3DFMT_A32B32G32R32F,
] as const;

describe("D3D9 float format CPU layout", () => {
    test("describes each R/RG/RGBA half and float32 storage width", () => {
        expect(FLOAT_FORMATS.map(format => d3dFloatFormatInfo(format))).toEqual([
            { channels: 1, bytesPerChannel: 2 },
            { channels: 2, bytesPerChannel: 2 },
            { channels: 4, bytesPerChannel: 2 },
            { channels: 1, bytesPerChannel: 4 },
            { channels: 2, bytesPerChannel: 4 },
            { channels: 4, bytesPerChannel: 4 },
        ]);
        expect(FLOAT_FORMATS.map(format => d3dFormatBpp(format))).toEqual([16, 32, 64, 32, 64, 128]);
        expect(FLOAT_FORMATS.map(format => getD3DTextureLayout(format, 2, 1).pitch))
            .toEqual([4, 8, 16, 8, 16, 32]);
    });

    test("decodes half-float R, RG, and RGBA channels to canonical RGBA8", () => {
        const r = new Uint8Array(2);
        new DataView(r.buffer).setUint16(0, 0x3800, true); // 0.5
        expect(Array.from(decodeD3DTextureToRgba8(r, 0, 1, 1, D3DFMT_R16F)))
            .toEqual([128, 0, 0, 255]);

        const rg = new Uint8Array(4);
        const rgView = new DataView(rg.buffer);
        rgView.setUint16(0, float32ToFloat16Bits(0.25), true);
        rgView.setUint16(2, float32ToFloat16Bits(1), true);
        expect(Array.from(decodeD3DTextureToRgba8(rg, 0, 1, 1, D3DFMT_G16R16F)))
            .toEqual([64, 255, 0, 255]);

        const rgba = new Uint8Array(8);
        const rgbaView = new DataView(rgba.buffer);
        for (const [offset, value] of [[0, 0.5], [2, 1], [4, 0.25], [6, 0.75]] as const) {
            rgbaView.setUint16(offset, float32ToFloat16Bits(value), true);
        }
        expect(Array.from(decodeD3DTextureToRgba8(rgba, 0, 1, 1, D3DFMT_A16B16G16R16F)))
            .toEqual([128, 255, 64, 191]);
    });

    test("decodes float32 R/RG/RGBA channels and clamps non-UNORM values", () => {
        const r = new Uint8Array(4);
        new DataView(r.buffer).setFloat32(0, 0.5, true);
        expect(Array.from(decodeD3DTextureToRgba8(r, 0, 1, 1, D3DFMT_R32F)))
            .toEqual([128, 0, 0, 255]);

        const rg = new Uint8Array(8);
        const rgView = new DataView(rg.buffer);
        rgView.setFloat32(0, -1, true);
        rgView.setFloat32(4, 2, true);
        expect(Array.from(decodeD3DTextureToRgba8(rg, 0, 1, 1, D3DFMT_G32R32F)))
            .toEqual([0, 255, 0, 255]);

        const rgba = new Uint8Array(16);
        const rgbaView = new DataView(rgba.buffer);
        [0.5, 1, 0.25, NaN].forEach((value, i) => rgbaView.setFloat32(i * 4, value, true));
        expect(Array.from(decodeD3DTextureToRgba8(rgba, 0, 1, 1, D3DFMT_A32B32G32R32F)))
            .toEqual([128, 255, 64, 0]);
    });

    test("implements IEEE binary16 edge values without Float16Array", () => {
        expect(float16BitsToFloat32(0x3c00)).toBe(1);
        expect(float16BitsToFloat32(0xc000)).toBe(-2);
        expect(Object.is(float16BitsToFloat32(0x8000), -0)).toBe(true);
        expect(float16BitsToFloat32(0x0001)).toBeCloseTo(2 ** -24, 15);
        expect(float32ToFloat16Bits(1)).toBe(0x3c00);
        expect(float32ToFloat16Bits(-2)).toBe(0xc000);
        expect(float32ToFloat16Bits(Infinity)).toBe(0x7c00);
        expect((float32ToFloat16Bits(NaN) & 0x7c00)).toBe(0x7c00);
    });
});

describe("D3D9 float CPU copy", () => {
    test("encodes normalized pixels into all six float destinations", () => {
        for (const format of FLOAT_FORMATS) {
            const layout = getD3DTextureLayout(format, 1, 1);
            const data = new Uint8Array(layout.bytes);
            expect(writeD3D9Pixel(format, data, 0, [128, 255, 64, 191]), format.toString()).toBe(true);
            expect(data.some(byte => byte !== 0), format.toString()).toBe(true);
        }
    });

    test("preserves arbitrary float bytes for an exact-size point copy", () => {
        const source = new Uint8Array(16);
        const view = new DataView(source.buffer);
        view.setFloat32(0, -3.5, true);
        view.setFloat32(4, 7.25, true);
        view.setFloat32(8, Number.NaN, true);
        view.setFloat32(12, -0, true);
        const destination = new Uint8Array(16).fill(0xa5);
        expect(copyD3D9SurfaceRectCpu(
            { data: source, pitch: 16, width: 1, height: 1, format: D3DFMT_A32B32G32R32F },
            { data: destination, pitch: 16, width: 1, height: 1, format: D3DFMT_A32B32G32R32F },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(destination)).toEqual(Array.from(source));
    });
});

describe("D3D9 float capability boundary", () => {
    test("keeps GPU capability refusal while CPU codecs are available", () => {
        for (const format of FLOAT_FORMATS) {
            expect(isDxUnsupportedFormat(format, 9), format.toString()).toBe(true);
            expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 3, format), format.toString())
                .toBe(D3DERR_NOTAVAILABLE);
        }
        expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 3, 21)).toBe(D3D_OK);
    });
});
