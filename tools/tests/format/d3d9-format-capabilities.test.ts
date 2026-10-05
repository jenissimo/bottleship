import { describe, expect, test } from "bun:test";
import {
    checkDxDeviceFormat,
    D3D_OK,
    D3DERR_NOTAVAILABLE,
} from "../../../src/worker/backends/webgpu/shared/dx-format-support";
import {
    D3DFMT_BC4U,
    D3DFMT_DXT1,
    D3DFMT_DXT5,
    D3DFMT_V8U8,
} from "../../../src/worker/backends/webgpu/shared/texture-formats";

const D3DDEVTYPE_HAL = 1;
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_A8B8G8R8 = 32;
const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_QUERY_SRGBREAD = 0x00010000;
const D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING = 0x00080000;

function check9(usage: number, type: number, format: number): number {
    return checkDxDeviceFormat(
        9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, usage, type, format,
    );
}

describe("D3D9 format capability/runtime agreement", () => {
    test("BC4/BC5 and DXT formats are never render targets", () => {
        expect(check9(D3DUSAGE_RENDERTARGET, D3DRTYPE_SURFACE, D3DFMT_BC4U))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(check9(D3DUSAGE_RENDERTARGET, D3DRTYPE_TEXTURE, D3DFMT_DXT1))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(check9(D3DUSAGE_RENDERTARGET, D3DRTYPE_TEXTURE, D3DFMT_DXT5))
            .toBe(D3DERR_NOTAVAILABLE);
    });

    test("post-pixel-shader blending follows the actual render-target set", () => {
        expect(check9(
            D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING,
            D3DRTYPE_TEXTURE,
            D3DFMT_A8R8G8B8,
        )).toBe(D3D_OK);
        expect(check9(
            D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING,
            D3DRTYPE_TEXTURE,
            D3DFMT_A8B8G8R8,
        )).toBe(D3D_OK);
        expect(check9(
            D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING,
            D3DRTYPE_TEXTURE,
            D3DFMT_BC4U,
        )).toBe(D3DERR_NOTAVAILABLE);
    });

    test("sRGB reads are limited to formats with a compatible sRGB view", () => {
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8))
            .toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_CUBETEXTURE, D3DFMT_DXT1))
            .toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_TEXTURE, D3DFMT_BC4U))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_TEXTURE, D3DFMT_V8U8))
            .toBe(D3DERR_NOTAVAILABLE);
    });
});
