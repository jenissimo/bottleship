import { describe, expect, test } from "bun:test";
import {
    adapterBppDepth,
    checkDxDeviceFormat,
    checkDxDeviceFormatConversion,
    checkDxDeviceMultiSampleType,
    D3D_OK,
    D3DERR_NOTAVAILABLE,
    D3DOK_NOAUTOGEN,
    getDxFormatSupportCensus,
    isDxMultiSampleTypeSupported,
    isDxRenderTargetFormat,
    isDxTextureFormatCompatibleWithAdapter,
    isDxUnsupportedFormat,
    resetDxFormatSupportCensus,
    textureBppDepth,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";
import {
    D3DFMT_A16B16G16R16,
    D3DFMT_A8R3G3B2,
    D3DFMT_ATI1,
    D3DFMT_ATI2,
    D3DFMT_DXT2,
    D3DFMT_DXT3,
    D3DFMT_DXT4,
    D3DFMT_DXT5,
    D3DFMT_L16,
    D3DFMT_Q16W16V16U16,
    D3DFMT_R3G3B2,
    D3DFMT_DXT1,
    decodeD3DTextureToRgba8,
    d3dFormatBpp,
    d3dFormatToSurfaceFormat,
    float32ToFloat16Bits,
    getD3DTextureLayout,
} from "../../src/worker/backends/webgpu/shared/texture-formats";

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
const D3DFMT_S8_LOCKABLE = 85;
const D3DFMT_R16F = 111;
const D3DFMT_INTZ = 0x5a544e49; // 'INTZ'
const FOURCC_NULL = 0x4c4c554e; // 'NULL'

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
        expect(textureBppDepth(D3DFMT_R3G3B2)).toBe(8);
        expect(textureBppDepth(D3DFMT_A8R3G3B2)).toBe(16);
        expect(textureBppDepth(D3DFMT_A16B16G16R16)).toBe(64);
        expect(textureBppDepth(D3DFMT_Q16W16V16U16)).toBe(64);
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
        expect(isDxTextureFormatCompatibleWithAdapter(0x12345678, D3DFMT_INTZ, 9)).toBe(false);
    });

    test("known D3D9 formats without a faithful backend are not reported compatible", () => {
        expect(isDxUnsupportedFormat(D3DFMT_S8_LOCKABLE, 9)).toBe(true);
        expect(isDxUnsupportedFormat(D3DFMT_R16F, 9)).toBe(true);
        expect(isDxUnsupportedFormat(117 /* CxV8U8 */, 9)).toBe(true);
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_X8R8G8B8, D3DFMT_R16F, 9)).toBe(false);
        // The same numeric values are outside D3D8's format namespace, not a D3D8
        // backend capability downgrade.
        expect(isDxUnsupportedFormat(D3DFMT_R16F, 8)).toBe(false);
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

    test("volume textures: public capability remains gated on both versions", () => {
        expect(check9(0, D3DRTYPE_VOLUMETEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_VOLUMETEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3DERR_NOTAVAILABLE);
    });

    test("does not advertise S8_LOCKABLE, float, or CxV8U8 as color resources", () => {
        expect(check9(0, D3DRTYPE_TEXTURE, D3DFMT_S8_LOCKABLE)).toBe(D3DERR_NOTAVAILABLE);
        expect(check9(0, D3DRTYPE_TEXTURE, D3DFMT_R16F)).toBe(D3DERR_NOTAVAILABLE);
        expect(check9(0, D3DRTYPE_TEXTURE, 117 /* CxV8U8 */)).toBe(D3DERR_NOTAVAILABLE);
        expect(check9(0x1, D3DRTYPE_TEXTURE, D3DFMT_R16F)).toBe(D3DERR_NOTAVAILABLE);
    });

    test("no floating-point format is a render target on any path", () => {
        // Every surface is backed by an rgba8-or-wider integer attachment, so a float RT
        // has nothing behind it. R16F/G16R16F/A16B16G16R16F may still be sampled storage
        // under the host float contract; that must never widen into an attachment claim.
        for (const format of [111, 112, 113, 114, 115, 116]) {
            expect(isDxRenderTargetFormat(format, 9)).toBe(false);
            expect(check9(0x1, D3DRTYPE_TEXTURE, format)).toBe(D3DERR_NOTAVAILABLE);
            expect(check9(0x1, D3DRTYPE_SURFACE, format)).toBe(D3DERR_NOTAVAILABLE);
        }
    });

    test("keeps the standard R3G3B2 and Q16 bump formats in the D3D9 matrix", () => {
        expect(check9(0, D3DRTYPE_TEXTURE, D3DFMT_R3G3B2)).toBe(D3D_OK);
        expect(check9(0, D3DRTYPE_TEXTURE, D3DFMT_Q16W16V16U16)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_LEGACYBUMPMAP, D3DRTYPE_TEXTURE, D3DFMT_Q16W16V16U16))
            .toBe(D3D_OK);
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_Q16W16V16U16),
        ).toBe(D3DERR_NOTAVAILABLE);
    });

    test("refuses unmapped FourCCs while retaining the backed FourCC set", () => {
        resetDxFormatSupportCensus();
        for (const format of [D3DFMT_DXT1, D3DFMT_DXT2, D3DFMT_DXT3, D3DFMT_DXT4, D3DFMT_DXT5, D3DFMT_ATI1, D3DFMT_ATI2, FOURCC_NULL]) {
            expect(check9(0, D3DRTYPE_TEXTURE, format)).toBe(D3D_OK);
        }
        for (const resourceType of [D3DRTYPE_SURFACE, D3DRTYPE_TEXTURE, D3DRTYPE_CUBETEXTURE, D3DRTYPE_VOLUMETEXTURE]) {
            expect(check9(0, resourceType, D3DFMT_INTZ)).toBe(D3DERR_NOTAVAILABLE);
        }
        expect(getDxFormatSupportCensus()).toEqual({
            refusedFormat: {},
            refusedFourCC: { "0x5a544e49": 4 },
        });
    });
});

describe("CheckDeviceFormatConversion", () => {
    test("uses an explicit source/target matrix instead of generic renderability", () => {
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8))
            .toBe(D3D_OK);
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, D3DFMT_DXT1, D3DFMT_A8R8G8B8))
            .toBe(D3D_OK);
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, D3DFMT_INTZ, D3DFMT_A8R8G8B8))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, FOURCC_NULL, D3DFMT_A8R8G8B8))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_R3G3B2))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(checkDxDeviceFormatConversion(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_DXT1))
            .toBe(D3DERR_NOTAVAILABLE);
    });
});

describe("D3D9 multisample capability", () => {
    test("does not advertise MSAA until D3D9 attachment and resolve paths exist", () => {
        expect(isDxMultiSampleTypeSupported(9, 0)).toBe(true);
        // NONMASKABLE lets the driver pick, and one sample is always available — DXVK
        // answers it arithmetically (sampleCount = max(type, 1)).
        expect(isDxMultiSampleTypeSupported(9, 1)).toBe(true);
        expect(isDxMultiSampleTypeSupported(9, 2)).toBe(false);
        expect(isDxMultiSampleTypeSupported(9, 4)).toBe(false);

        expect(checkDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 1, 0)).toBe(D3D_OK);
        expect(checkDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 1, 1)).toBe(D3D_OK);
        for (const sampleType of [2, 4]) {
            expect(checkDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 1, sampleType))
                .toBe(D3DERR_NOTAVAILABLE);
        }
    });

    test("keeps D3D8 on the portable 4x capability contract", () => {
        expect(isDxMultiSampleTypeSupported(8, 0)).toBe(true);
        expect(isDxMultiSampleTypeSupported(8, 2)).toBe(false);
        expect(isDxMultiSampleTypeSupported(8, 4)).toBe(true);
        expect(isDxMultiSampleTypeSupported(8, 8)).toBe(false);
    });
});

describe("D3DFMT_L16 CPU layout", () => {
    test("keeps 16-bit luminance storage and expands it to opaque grayscale", () => {
        expect(getD3DTextureLayout(D3DFMT_L16, 2, 1)).toMatchObject({ pitch: 4, bytes: 4 });
        expect(Array.from(decodeD3DTextureToRgba8(
            new Uint8Array([0x00, 0x00, 0xff, 0xff]), 0, 2, 1, D3DFMT_L16,
        ))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    });
});

describe("D3DFMT_R3G3B2 and D3DFMT_Q16W16V16U16 CPU layouts", () => {
    test("uses the packed 8-bit RGB layout instead of the unknown-format 32-bit fallback", () => {
        expect(d3dFormatBpp(D3DFMT_R3G3B2)).toBe(8);
        expect(d3dFormatToSurfaceFormat(D3DFMT_R3G3B2)).toMatchObject({
            bpp: 8, rMask: 0xe0, gMask: 0x1c, bMask: 0x03, aMask: 0,
        });
        expect(getD3DTextureLayout(D3DFMT_R3G3B2, 2, 1)).toMatchObject({ pitch: 2, bytes: 2 });
        expect(Array.from(decodeD3DTextureToRgba8(
            new Uint8Array([0xff, 0x1c]), 0, 2, 1, D3DFMT_R3G3B2,
        ))).toEqual([255, 255, 255, 255, 0, 255, 0, 255]);
    });

    test("keeps all four signed 16-bit bump components in U,V,W,Q order", () => {
        expect(d3dFormatBpp(D3DFMT_Q16W16V16U16)).toBe(64);
        expect(getD3DTextureLayout(D3DFMT_Q16W16V16U16, 1, 1)).toMatchObject({ pitch: 8, bytes: 8 });
        // Zero is the neutral signed-normalized value in every component.
        expect(Array.from(decodeD3DTextureToRgba8(
            new Uint8Array(8), 0, 1, 1, D3DFMT_Q16W16V16U16,
        ))).toEqual([128, 128, 128, 128]);
    });
});

describe("float texture codec reuse", () => {
    test("decodes multiple half-float texels without cross-texel state", () => {
        const src = new Uint8Array(4);
        const view = new DataView(src.buffer);
        view.setUint16(0, float32ToFloat16Bits(0.25), true);
        view.setUint16(2, float32ToFloat16Bits(1), true);
        const out = new Uint8Array(8);
        expect(Array.from(decodeD3DTextureToRgba8(src, 0, 2, 1, D3DFMT_R16F, { out })))
            .toEqual([64, 0, 0, 255, 255, 0, 0, 255]);
    });
});

describe("checkDxDeviceFormat D3DUSAGE_QUERY_*", () => {
    test("sRGB reads and RGBA8 writes use compatible WebGPU views", () => {
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_CUBETEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_SRGBREAD, D3DRTYPE_SURFACE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
        expect(check9(D3DUSAGE_QUERY_SRGBWRITE, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_SRGBWRITE, D3DRTYPE_TEXTURE, D3DFMT_R5G6B5)).toBe(D3DERR_NOTAVAILABLE);
    });

    test("2D vertex-texture sampling is accepted while displacement mapping is refused", () => {
        expect(check9(D3DUSAGE_QUERY_VERTEXTEXTURE, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)).toBe(D3D_OK);
        expect(check9(D3DUSAGE_QUERY_VERTEXTEXTURE, D3DRTYPE_CUBETEXTURE, D3DFMT_A8R8G8B8)).toBe(D3DERR_NOTAVAILABLE);
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

    test("WRAPANDMIP is supported for authored DXT mip chains", () => {
        // d3d9-device uploads every contiguous authored level, including the 1x1 tail;
        // only automatic mip generation remains unavailable (covered above).
        expect(check9(D3DUSAGE_QUERY_WRAPANDMIP, D3DRTYPE_TEXTURE, D3DFMT_DXT1)).toBe(D3D_OK);
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
