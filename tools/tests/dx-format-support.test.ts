import { describe, expect, test } from "bun:test";
import {
    adapterBppDepth,
    checkDxDeviceFormat,
    D3D_OK,
    D3DERR_NOTAVAILABLE,
    D3DOK_NOAUTOGEN,
    isDxTextureFormatCompatibleWithAdapter,
    textureBppDepth,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";

const D3DDEVTYPE_HAL = 1;
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DRTYPE_CUBETEXTURE = 5;

const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_A1R5G5B5 = 25;
const D3DFMT_P8 = 41;
const D3DFMT_V8U8 = 60;
const D3DFMT_DXT1 = 0x31545844;

const D3DUSAGE_AUTOGENMIPMAP = 0x00000400;
const D3DUSAGE_DMAP = 0x00004000;
const D3DUSAGE_QUERY_LEGACYBUMPMAP = 0x00008000;
const D3DUSAGE_QUERY_SRGBREAD = 0x00010000;
const D3DUSAGE_QUERY_FILTER = 0x00020000;
const D3DUSAGE_QUERY_SRGBWRITE = 0x00040000;
const D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING = 0x00080000;
const D3DUSAGE_QUERY_VERTEXTEXTURE = 0x00100000;
const D3DUSAGE_QUERY_WRAPANDMIP = 0x00200000;

describe("adapterBppDepth / textureBppDepth", () => {
    test("known display formats", () => {
        expect(adapterBppDepth(D3DFMT_R5G6B5, 8)).toBe(16);
        expect(adapterBppDepth(D3DFMT_X8R8G8B8, 8)).toBe(32);
        expect(adapterBppDepth(0xdeadbeef, 8)).toBeNull();
    });

    test("texture bpp classes", () => {
        expect(textureBppDepth(D3DFMT_X8R8G8B8)).toBe(32);
        expect(textureBppDepth(D3DFMT_R5G6B5)).toBe(16);
        expect(textureBppDepth(D3DFMT_P8)).toBe(8);
    });
});

describe("isDxTextureFormatCompatibleWithAdapter", () => {
    test("HLE accepts cross-bpp combinations (PoP SoT R5G6B5 adapter probes)", () => {
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_X8R8G8B8, 8)).toBe(true);
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_A8R8G8B8, 8)).toBe(true);
    });

    test("same-bpp and P8 ok on 16-bit adapter", () => {
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8, 8)).toBe(true);
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_A1R5G5B5, 8)).toBe(true);
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_P8, 8)).toBe(true);
    });

    test("unknown adapter stays permissive (Morrowind probe)", () => {
        expect(isDxTextureFormatCompatibleWithAdapter(0x12345678, D3DFMT_A8R8G8B8, 8)).toBe(true);
    });
});

describe("checkDxDeviceFormat adapter gating", () => {
    test("GTA III CAPS path: 32-bit adapter accepts 888/8888", () => {
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3D_OK);
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_X8R8G8B8),
        ).toBe(D3D_OK);
    });

    test("16-bit adapter accepts 32-bit textures (PoP SoT CheckDeviceFormat matrix)", () => {
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_X8R8G8B8),
        ).toBe(D3D_OK);
        expect(
            checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0x1, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3D_OK);
    });

    test("garbage adapter format stays permissive", () => {
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, 0xcafebabe, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3D_OK);
    });
});

/** CheckDeviceFormat(9, 0, HAL, X8R8G8B8, usage, rType, fmt) with the fixed prefix. */
function check9(usage: number, rType: number, fmt: number): number {
    return checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, usage, rType, fmt);
}

describe("checkDxDeviceFormat resource types", () => {
    // These answers must track the two caps blobs (modules/d3d8/caps.ts TextureCaps,
    // modules/d3d9/caps.ts): an app gates on the cap and confirms with this probe, so a
    // probe that disagrees sends it down a path that dies at Create*.
    test("cube textures: D3D9 creates them, D3D8 cannot", () => {
        expect(check9(0, D3DRTYPE_CUBETEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_CUBETEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3DERR_NOTAVAILABLE);
    });

    test("volume textures: refused on both versions", () => {
        expect(check9(0, D3DRTYPE_VOLUMETEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_VOLUMETEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3DERR_NOTAVAILABLE);
    });
});

describe("checkDxDeviceFormat D3DUSAGE_QUERY_*", () => {
    test("sRGB read/write are refused — no backend applies the transfer function", () => {
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
        expect(check9(D3DUSAGE_QUERY_SRGBWRITE, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
    });

    test("vertex-texture sampling and displacement mapping are refused", () => {
        expect(check9(D3DUSAGE_QUERY_VERTEXTEXTURE, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
        expect(check9(D3DUSAGE_DMAP, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
    });

    test("AUTOGENMIPMAP succeeds as NOAUTOGEN, not as plain OK", () => {
        // SUCCEEDED() either way — but the app must keep generating its own mips, and only
        // the distinct code says so. A plain D3D_OK here is the regression to catch.
        expect(check9(D3DUSAGE_AUTOGENMIPMAP, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DOK_NOAUTOGEN);
        expect(D3DOK_NOAUTOGEN & 0x80000000).toBe(0);
        // D3D8 has no such usage bit: the same value must not be reinterpreted there.
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DUSAGE_AUTOGENMIPMAP, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3D_OK);
    });

    test("legacy bump-map query is format-gated", () => {
        expect(check9(D3DUSAGE_QUERY_LEGACYBUMPMAP, D3DRTYPE_TEXTURE, D3DFMT_V8U8)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_LEGACYBUMPMAP, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
    });

    test("WRAPANDMIP refused for block-compressed formats (level 0 only)", () => {
        expect(check9(D3DUSAGE_QUERY_WRAPANDMIP, D3DRTYPE_TEXTURE, D3DFMT_DXT1)).toBe(D3DERR_NOTAVAILABLE);
        expect(check9(D3DUSAGE_QUERY_WRAPANDMIP, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
    });

    test("filtering and post-PS blending are held", () => {
        expect(check9(D3DUSAGE_QUERY_FILTER, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
    });

    test("a plain surface answers only POSTPIXELSHADER_BLENDING", () => {
        expect(check9(D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING, D3DRTYPE_SURFACE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_FILTER, D3DRTYPE_SURFACE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
    });
});
