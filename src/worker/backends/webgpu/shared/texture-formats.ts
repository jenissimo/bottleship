/// <reference types="@webgpu/types" />

import type { SurfaceFormat } from "../../../modules/ddraw/com-objects";
import {
    convertSurfaceToRGBA,
    type FormatInfo,
} from "../../../modules/ddraw/gpu-texture-utils";
import {
    GL_ALPHA,
    GL_BGRA,
    GL_BGR,
    GL_LUMINANCE,
    GL_LUMINANCE_ALPHA,
    GL_RGB,
    GL_RGBA,
    GL_UNSIGNED_BYTE,
    GL_UNSIGNED_SHORT_4_4_4_4,
    GL_UNSIGNED_SHORT_5_5_5_1,
    GL_UNSIGNED_SHORT_5_6_5,
    GL_COMPRESSED_RGB_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT3_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT5_EXT,
    GL_COMPRESSED_RED_RGTC1,
    GL_COMPRESSED_SIGNED_RED_RGTC1,
    GL_COMPRESSED_RG_RGTC2,
    GL_COMPRESSED_SIGNED_RG_RGTC2,
    GL_COMPRESSED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_SIGNED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_LUMINANCE_ALPHA_LATC2_EXT,
    GL_COMPRESSED_SIGNED_LUMINANCE_ALPHA_LATC2_EXT,
} from "../../../modules/opengl32/constants";
import {
    blocksHigh,
    decodeDxtToRgba,
    D3DFMT_DXT1,
    D3DFMT_DXT2,
    D3DFMT_DXT3,
    D3DFMT_DXT4,
    D3DFMT_DXT5,
    dxtBlockBytes,
    dxtRowPitch,
    dxtToBcGpuFormat,
    isBlockAligned,
    isDxtFormat,
} from "./dxt";
import {
    decodeGlideTexture,
    estimateTextureSizeBytes,
    type DecodedNccTable,
} from "../glide/glide-texture-decoder";

// D3DFORMAT constants shared by D3D8 and D3D9.
export const D3DFMT_UNKNOWN      = 0;
export const D3DFMT_R8G8B8       = 20;
export const D3DFMT_A8R8G8B8     = 21;
export const D3DFMT_X8R8G8B8     = 22;
export const D3DFMT_R5G6B5       = 23;
export const D3DFMT_X1R5G5B5     = 24;
export const D3DFMT_A1R5G5B5     = 25;
export const D3DFMT_A4R4G4B4     = 26;
export const D3DFMT_R3G3B2       = 27;
export const D3DFMT_A8           = 28;
export const D3DFMT_A8R3G3B2     = 29;
export const D3DFMT_X4R4G4B4     = 30;
export const D3DFMT_A2B10G10R10  = 31;
export const D3DFMT_A8B8G8R8     = 32;
export const D3DFMT_X8B8G8R8     = 33;
export const D3DFMT_G16R16       = 34;
export const D3DFMT_A2R10G10B10  = 35;
export const D3DFMT_A16B16G16R16 = 36;
export const D3DFMT_A8P8         = 40;
export const D3DFMT_P8           = 41;
export const D3DFMT_L8           = 50;
export const D3DFMT_A8L8         = 51;
export const D3DFMT_A4L4         = 52;
export const D3DFMT_L16          = 81;
export const D3DFMT_V8U8         = 60;
export const D3DFMT_L6V5U5       = 61;
export const D3DFMT_X8L8V8U8     = 62;
export const D3DFMT_Q8W8V8U8     = 63;
export const D3DFMT_V16U16       = 64;
export const D3DFMT_W11V11U10    = 65;
export const D3DFMT_A2W10V10U10  = 67;
/** 64-bit signed bump-map format; components are stored U,V,W,Q (16 bits each). */
export const D3DFMT_Q16W16V16U16 = 110;
/** NVIDIA-only normal-compression format. Named so the capability layer can refuse it
 *  by name; DXVK and wined3d expose no format mapping for it either. */
export const D3DFMT_CxV8U8         = 117;

// D3D9 floating-point texel formats.  These stay out of the public WebGPU
// capability set until a native float texture/RT path is wired, but the CPU
// shadow and readback codecs still need to understand their exact byte layout.
export const D3DFMT_R16F               = 111;
export const D3DFMT_G16R16F            = 112;
export const D3DFMT_A16B16G16R16F      = 113;
export const D3DFMT_R32F               = 114;
export const D3DFMT_G32R32F            = 115;
export const D3DFMT_A32B32G32R32F      = 116;

export const D3DFMT_ATI1         = 0x31495441; // 'ATI1' / BC4_UNORM
export const D3DFMT_ATI2         = 0x32495441; // 'ATI2' / BC5_UNORM
export const D3DFMT_BC4U         = 0x55344342; // 'BC4U'
export const D3DFMT_BC4S         = 0x53344342; // 'BC4S'
export const D3DFMT_BC5U         = 0x55354342; // 'BC5U'
export const D3DFMT_BC5S         = 0x53354342; // 'BC5S'

// DDPIXELFORMAT flags used by the shared SurfaceFormat representation.
export const DDPF_ALPHAPIXELS    = 0x00000001;
export const DDPF_FOURCC         = 0x00000004;
export const DDPF_PALETTEINDEXED8 = 0x00000020;
export const DDPF_RGB            = 0x00000040;

export {
    D3DFMT_DXT1,
    D3DFMT_DXT2,
    D3DFMT_DXT3,
    D3DFMT_DXT4,
    D3DFMT_DXT5,
    dxtToBcGpuFormat,
    isBlockAligned,
    isDxtFormat,
};

export interface TextureLayout {
    pitch: number;
    rows: number;
    bytes: number;
    compressed: boolean;
    blockBytes: number;
}

export interface DecodeD3DTextureOptions {
    pitch?: number;
    out?: Uint8Array;
    palette?: Uint32Array;
    colorKey?: { low: number; high: number };
    surfaceFormat?: FormatInfo;
}

/** Return the number of channels and bytes per channel in a D3D9 float texel. */
export function d3dFloatFormatInfo(format: number): { channels: 1 | 2 | 4; bytesPerChannel: 2 | 4 } | null {
    switch (format >>> 0) {
        case D3DFMT_R16F: return { channels: 1, bytesPerChannel: 2 };
        case D3DFMT_G16R16F: return { channels: 2, bytesPerChannel: 2 };
        case D3DFMT_A16B16G16R16F: return { channels: 4, bytesPerChannel: 2 };
        case D3DFMT_R32F: return { channels: 1, bytesPerChannel: 4 };
        case D3DFMT_G32R32F: return { channels: 2, bytesPerChannel: 4 };
        case D3DFMT_A32B32G32R32F: return { channels: 4, bytesPerChannel: 4 };
        default: return null;
    }
}

export function isD3DFloatFormat(format: number): boolean {
    return d3dFloatFormatInfo(format) !== null;
}

/** Decode an IEEE-754 binary16 word without relying on Float16Array, which is not
 * present in all browsers supported by the worker. */
export function float16BitsToFloat32(bits: number): number {
    const raw = bits & 0xffff;
    const sign = (raw & 0x8000) !== 0 ? -1 : 1;
    const exponent = (raw >>> 10) & 0x1f;
    const fraction = raw & 0x03ff;
    if (exponent === 0) {
        if (fraction === 0) return sign < 0 ? -0 : 0;
        return sign * fraction * 2 ** -24;
    }
    if (exponent === 0x1f) {
        return fraction === 0 ? (sign < 0 ? -Infinity : Infinity) : NaN;
    }
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function roundToNearestEven(value: number, shift: number): number {
    if (shift <= 0) return value << -shift;
    const base = value >>> shift;
    const remainder = value & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    return base + (remainder > halfway || (remainder === halfway && (base & 1) !== 0) ? 1 : 0);
}

// The codec is synchronous and these views never escape, so reusing one pair
// avoids allocating typed arrays for every converted channel.
const FLOAT32_SCRATCH = new Float32Array(1);
const FLOAT32_BITS = new Uint32Array(FLOAT32_SCRATCH.buffer);

/** Encode a number using the D3D9 binary16 (IEEE-754 half) representation.
 * Input is first rounded to binary32, matching a Float32 texture upload. */
export function float32ToFloat16Bits(value: number): number {
    FLOAT32_SCRATCH[0] = value;

    const sign = (FLOAT32_BITS[0]! >>> 16) & 0x8000;
    const exponent = (FLOAT32_BITS[0]! >>> 23) & 0xff;
    const fraction = FLOAT32_BITS[0]! & 0x007fffff;
    if (exponent === 0xff) {
        // Preserve infinity and make every NaN a quiet half NaN.  Payloads are
        // intentionally not retained: D3D only promises the NaN classification.
        return sign | (fraction === 0 ? 0x7c00 : 0x7e00);
    }

    const halfExponent = exponent - 127 + 15;
    if (halfExponent >= 0x1f) return sign | 0x7c00;
    if (halfExponent <= 0) {
        if (halfExponent < -10) return sign;
        const rounded = roundToNearestEven(fraction | 0x00800000, 14 - halfExponent);
        return sign | Math.min(0x03ff + 1, rounded);
    }

    let rounded = roundToNearestEven(fraction, 13);
    let e = halfExponent;
    if (rounded >= 0x400) {
        rounded = 0;
        e++;
        if (e >= 0x1f) return sign | 0x7c00;
    }
    return sign | (e << 10) | rounded;
}

function bytesPerPixelFromBpp(bpp: number): number {
    return Math.max(1, Math.floor(bpp / 8));
}

function blocksWide4(width: number): number {
    return Math.max(1, (Math.max(1, width | 0) + 3) >> 2);
}

export function isBc4Format(format: number): boolean {
    return format === D3DFMT_ATI1 || format === D3DFMT_BC4U || format === D3DFMT_BC4S;
}

export function isBc5Format(format: number): boolean {
    return format === D3DFMT_ATI2 || format === D3DFMT_BC5U || format === D3DFMT_BC5S;
}

export function isBc45Format(format: number): boolean {
    return isBc4Format(format) || isBc5Format(format);
}

export function isBlockCompressedFormat(format: number): boolean {
    return isDxtFormat(format) || isBc45Format(format);
}

export function blockCompressedBlockBytes(format: number): number {
    if (isDxtFormat(format)) return dxtBlockBytes(format);
    return isBc5Format(format) ? 16 : 8;
}

export function blockCompressedRowPitch(format: number, width: number): number {
    if (isDxtFormat(format)) return dxtRowPitch(format, width);
    return blocksWide4(width) * blockCompressedBlockBytes(format);
}

export function blockCompressedSurfaceBytes(format: number, width: number, height: number): number {
    return blockCompressedRowPitch(format, width) * blocksHigh(height);
}

/**
 * Copy extent for one dimension of a miplevel: for a block-compressed format the logical size
 * rounded UP to whole 4x4 blocks, for any other format the logical size unchanged.
 *
 * WebGPU validates a compressed copy against the PHYSICAL miplevel extent and requires the
 * copy size to be a multiple of the block size — unlike Vulkan/D3D, which let the extent stop
 * at the image edge. So a 2x2 or 1x1 mip tail must be copied as the single block that backs
 * it; passing the logical 2 or 1 makes the copy invalid, which invalidates the command buffer
 * and silently drops EVERY draw in the frame (a black screen, reported only in the GPU error
 * scope). The block that backs the tail is already present in the source: the row pitch is
 * block-based, so the bytes are there.
 *
 * The format argument is what keeps this safe to reach for from any upload loop: rounding is
 * only ever legal for a block-compressed target, and an uncompressed copy rounded up to 4 is
 * the same class of silently-invalid copy in the other direction. Deciding from the format
 * the caller already used to create the texture makes both mistakes unreachable.
 * Scalar (not an extent object) so upload loops stay allocation-free.
 */
export function blockCompressedCopyDim(format: number, dim: number): number {
    const d = Math.max(1, dim | 0);
    return isBlockCompressedFormat(format) ? ((d + 3) & ~3) : d;
}

/**
 * Convert a D3DFORMAT FourCC/enum to the SurfaceFormat shape consumed by the
 * DDraw converter. Block-compressed formats keep a 32bpp fallback only for old
 * callers that still ask for bytes-per-pixel; actual storage is owned by
 * getD3DTextureLayout().
 */
export function d3dFormatToSurfaceFormat(fmt: number): SurfaceFormat {
    switch (fmt) {
        case D3DFMT_A8R8G8B8:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 32, rMask: 0x00FF0000, gMask: 0x0000FF00, bMask: 0x000000FF, aMask: 0xFF000000 };
        case D3DFMT_X8R8G8B8:
        case D3DFMT_UNKNOWN:
            return { flags: DDPF_RGB, bpp: 32, rMask: 0x00FF0000, gMask: 0x0000FF00, bMask: 0x000000FF, aMask: 0 };
        case D3DFMT_R5G6B5:
            return { flags: DDPF_RGB, bpp: 16, rMask: 0xF800, gMask: 0x07E0, bMask: 0x001F, aMask: 0 };
        case D3DFMT_A1R5G5B5:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 16, rMask: 0x7C00, gMask: 0x03E0, bMask: 0x001F, aMask: 0x8000 };
        case D3DFMT_X1R5G5B5:
            return { flags: DDPF_RGB, bpp: 16, rMask: 0x7C00, gMask: 0x03E0, bMask: 0x001F, aMask: 0 };
        case D3DFMT_A4R4G4B4:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 16, rMask: 0x0F00, gMask: 0x00F0, bMask: 0x000F, aMask: 0xF000 };
        case D3DFMT_X4R4G4B4:
            return { flags: DDPF_RGB, bpp: 16, rMask: 0x0F00, gMask: 0x00F0, bMask: 0x000F, aMask: 0 };
        case D3DFMT_R3G3B2:
            return { flags: DDPF_RGB, bpp: 8, rMask: 0xE0, gMask: 0x1C, bMask: 0x03, aMask: 0 };
        case D3DFMT_A8R3G3B2:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 16, rMask: 0x00E0, gMask: 0x001C, bMask: 0x0003, aMask: 0xFF00 };
        case D3DFMT_R8G8B8:
            return { flags: DDPF_RGB, bpp: 24, rMask: 0xFF0000, gMask: 0x00FF00, bMask: 0x0000FF, aMask: 0 };
        case D3DFMT_A2B10G10R10:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 32, rMask: 0x000003FF, gMask: 0x000FFC00, bMask: 0x3FF00000, aMask: 0xC0000000 };
        case D3DFMT_A2R10G10B10:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 32, rMask: 0x3FF00000, gMask: 0x000FFC00, bMask: 0x000003FF, aMask: 0xC0000000 };
        case D3DFMT_A8B8G8R8:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 32, rMask: 0x000000FF, gMask: 0x0000FF00, bMask: 0x00FF0000, aMask: 0xFF000000 };
        case D3DFMT_X8B8G8R8:
            return { flags: DDPF_RGB, bpp: 32, rMask: 0x000000FF, gMask: 0x0000FF00, bMask: 0x00FF0000, aMask: 0 };
        case D3DFMT_G16R16:
            return { flags: DDPF_RGB, bpp: 32, rMask: 0x0000FFFF, gMask: 0xFFFF0000, bMask: 0, aMask: 0 };
        case D3DFMT_A16B16G16R16:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 64, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_R16F:
            return { flags: DDPF_RGB, bpp: 16, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_G16R16F:
            return { flags: DDPF_RGB, bpp: 32, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_A16B16G16R16F:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 64, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_R32F:
            return { flags: DDPF_RGB, bpp: 32, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_G32R32F:
            return { flags: DDPF_RGB, bpp: 64, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_A32B32G32R32F:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 128, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_A8:
            return { flags: DDPF_ALPHAPIXELS, bpp: 8, rMask: 0, gMask: 0, bMask: 0, aMask: 0xFF };
        case D3DFMT_A8P8:
            return { flags: DDPF_PALETTEINDEXED8 | DDPF_ALPHAPIXELS, bpp: 16, rMask: 0, gMask: 0, bMask: 0, aMask: 0xFF00 };
        case D3DFMT_P8:
            return { flags: DDPF_PALETTEINDEXED8, bpp: 8, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_L8:
            return { flags: 0, bpp: 8, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_A8L8:
            return { flags: DDPF_ALPHAPIXELS, bpp: 16, rMask: 0, gMask: 0, bMask: 0, aMask: 0xFF00 };
        case D3DFMT_L16:
            // D3DFMT_L16 is a single unsigned-normalized luminance channel.
            // Keep the channel masks empty; the explicit decoder below expands it
            // to RGB and avoids treating the two bytes as an RGB565 pixel.
            return { flags: 0, bpp: 16, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_A4L4:
            return { flags: DDPF_ALPHAPIXELS, bpp: 8, rMask: 0, gMask: 0, bMask: 0, aMask: 0xF0 };
        case D3DFMT_V8U8:
        case D3DFMT_L6V5U5:
            return { flags: 0, bpp: 16, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_X8L8V8U8:
        case D3DFMT_Q8W8V8U8:
        case D3DFMT_V16U16:
        case D3DFMT_W11V11U10:
        case D3DFMT_A2W10V10U10:
            return { flags: 0, bpp: 32, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_Q16W16V16U16:
            return { flags: 0, bpp: 64, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        case D3DFMT_DXT1:
        case D3DFMT_DXT2:
        case D3DFMT_DXT3:
        case D3DFMT_DXT4:
        case D3DFMT_DXT5:
        case D3DFMT_ATI1:
        case D3DFMT_ATI2:
        case D3DFMT_BC4U:
        case D3DFMT_BC4S:
        case D3DFMT_BC5U:
        case D3DFMT_BC5S:
            return { flags: DDPF_FOURCC, bpp: 32, rMask: 0, gMask: 0, bMask: 0, aMask: 0, fourCC: fmt };
        default:
            return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bpp: 32, rMask: 0x00FF0000, gMask: 0x0000FF00, bMask: 0x000000FF, aMask: 0xFF000000 };
    }
}

export function d3dFormatBpp(fmt: number): number {
    switch (fmt) {
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8:
        case D3DFMT_A2B10G10R10:
        case D3DFMT_A8B8G8R8:
        case D3DFMT_X8B8G8R8:
        case D3DFMT_G16R16:
        case D3DFMT_A2R10G10B10:
        case D3DFMT_X8L8V8U8:
        case D3DFMT_Q8W8V8U8:
        case D3DFMT_V16U16:
        case D3DFMT_W11V11U10:
        case D3DFMT_A2W10V10U10:
            return 32;
        case D3DFMT_A16B16G16R16:
        case D3DFMT_Q16W16V16U16:
            return 64;
        case D3DFMT_R16F:
            return 16;
        case D3DFMT_G16R16F:
            return 32;
        case D3DFMT_A16B16G16R16F:
            return 64;
        case D3DFMT_R32F:
            return 32;
        case D3DFMT_G32R32F:
            return 64;
        case D3DFMT_A32B32G32R32F:
            return 128;
        case D3DFMT_R5G6B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_X4R4G4B4:
        case D3DFMT_A8R3G3B2:
        case D3DFMT_A8L8:
        case D3DFMT_A8P8:
        case D3DFMT_L16:
        case D3DFMT_V8U8:
        case D3DFMT_L6V5U5:
            return 16;
        case D3DFMT_R3G3B2:
            return 8;
        case D3DFMT_R8G8B8:
            return 24;
        case D3DFMT_A8:
        case D3DFMT_P8:
        case D3DFMT_L8:
        case D3DFMT_A4L4:
            return 8;
        case D3DFMT_DXT1:
        case D3DFMT_DXT2:
        case D3DFMT_DXT3:
        case D3DFMT_DXT4:
        case D3DFMT_DXT5:
        case D3DFMT_ATI1:
        case D3DFMT_ATI2:
        case D3DFMT_BC4U:
        case D3DFMT_BC4S:
        case D3DFMT_BC5U:
        case D3DFMT_BC5S:
            return 0;
        default:
            return 32;
    }
}

export function getD3DTextureLayout(format: number, width: number, height: number): TextureLayout {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    if (isBlockCompressedFormat(format)) {
        const pitch = blockCompressedRowPitch(format, w);
        const rows = blocksHigh(h);
        return {
            pitch,
            rows,
            bytes: pitch * rows,
            compressed: true,
            blockBytes: blockCompressedBlockBytes(format),
        };
    }

    const sf = d3dFormatToSurfaceFormat(format);
    const pitch = w * bytesPerPixelFromBpp(sf.bpp);
    return {
        pitch,
        rows: h,
        bytes: pitch * h,
        compressed: false,
        blockBytes: 0,
    };
}

export function getSurfaceFormatLayout(format: FormatInfo, width: number, height: number): TextureLayout {
    const fourCC = (format as SurfaceFormat).fourCC;
    if (fourCC !== undefined && isBlockCompressedFormat(fourCC)) {
        return getD3DTextureLayout(fourCC, width, height);
    }
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const pitch = w * bytesPerPixelFromBpp(format.bpp);
    return {
        pitch,
        rows: h,
        bytes: pitch * h,
        compressed: false,
        blockBytes: 0,
    };
}

export function getNativeBCTextureFormat(format: number): GPUTextureFormat | null {
    if (isDxtFormat(format)) return dxtToBcGpuFormat(format);
    switch (format) {
        case D3DFMT_ATI1:
        case D3DFMT_BC4U:
            return "bc4-r-unorm";
        case D3DFMT_BC4S:
            return "bc4-r-snorm";
        case D3DFMT_ATI2:
        case D3DFMT_BC5U:
            return "bc5-rg-unorm";
        case D3DFMT_BC5S:
            return "bc5-rg-snorm";
        default:
            return null;
    }
}

export function canUploadNativeBC(format: number, width: number, height: number, supportsBC: boolean): boolean {
    return supportsBC && getNativeBCTextureFormat(format) !== null && isBlockAligned(width, height);
}

function clampByte(v: number): number {
    return Math.max(0, Math.min(255, v | 0));
}

function signed8ToByte(v: number): number {
    const s = v & 0x80 ? v - 0x100 : v;
    return clampByte(s + 128);
}

function signedNToByte(raw: number, bits: number): number {
    const sign = 1 << (bits - 1);
    const mask = (1 << bits) - 1;
    const value = raw & mask;
    const signed = (value & sign) ? value - (1 << bits) : value;
    return clampByte(Math.round((signed / (sign - 1)) * 127 + 128));
}

function decodeBc4Values(src: Uint8Array, off: number, signed: boolean, out: Uint8Array): void {
    const a0 = src[off] ?? 0;
    const a1 = src[off + 1] ?? 0;
    const pal = new Uint8Array(8);
    if (signed) {
        const s0 = a0 > 127 ? a0 - 256 : a0;
        const s1 = a1 > 127 ? a1 - 256 : a1;
        const tmp = new Int16Array(8);
        tmp[0] = s0;
        tmp[1] = s1;
        if (s0 > s1) {
            for (let i = 1; i < 7; i++) tmp[i + 1] = Math.trunc(((7 - i) * s0 + i * s1) / 7);
        } else {
            for (let i = 1; i < 5; i++) tmp[i + 1] = Math.trunc(((5 - i) * s0 + i * s1) / 5);
            tmp[6] = -128;
            tmp[7] = 127;
        }
        for (let i = 0; i < 8; i++) pal[i] = clampByte(tmp[i] + 128);
    } else {
        pal[0] = a0;
        pal[1] = a1;
        if (a0 > a1) {
            for (let i = 1; i < 7; i++) pal[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
        } else {
            for (let i = 1; i < 5; i++) pal[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0;
            pal[6] = 0;
            pal[7] = 255;
        }
    }

    let bitLo = (src[off + 2] ?? 0) | ((src[off + 3] ?? 0) << 8) | ((src[off + 4] ?? 0) << 16);
    let bitHi = (src[off + 5] ?? 0) | ((src[off + 6] ?? 0) << 8) | ((src[off + 7] ?? 0) << 16);
    for (let i = 0; i < 8; i++) { out[i] = pal[bitLo & 7]; bitLo >>>= 3; }
    for (let i = 8; i < 16; i++) { out[i] = pal[bitHi & 7]; bitHi >>>= 3; }
}

function decodeBc45ToRgba(
    format: number,
    src: Uint8Array,
    srcPitch: number,
    width: number,
    height: number,
    dst: Uint8Array,
): void {
    const bw = blocksWide4(width);
    const bh = blocksHigh(height);
    const blockBytes = blockCompressedBlockBytes(format);
    const signed = format === D3DFMT_BC4S || format === D3DFMT_BC5S;
    const twoChannel = isBc5Format(format);
    const c0 = new Uint8Array(16);
    const c1 = new Uint8Array(16);

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const blockOff = by * srcPitch + bx * blockBytes;
            decodeBc4Values(src, blockOff, signed, c0);
            if (twoChannel) decodeBc4Values(src, blockOff + 8, signed, c1);

            const px0 = bx * 4;
            const py0 = by * 4;
            for (let ty = 0; ty < 4; ty++) {
                const y = py0 + ty;
                if (y >= height) continue;
                const row = y * width;
                for (let tx = 0; tx < 4; tx++) {
                    const x = px0 + tx;
                    if (x >= width) continue;
                    const idx = ty * 4 + tx;
                    const r = c0[idx];
                    const g = twoChannel ? c1[idx] : c0[idx];
                    const b = twoChannel ? 255 : c0[idx];
                    const dstOff = (row + x) * 4;
                    dst[dstOff] = r;
                    dst[dstOff + 1] = g;
                    dst[dstOff + 2] = b;
                    dst[dstOff + 3] = 255;
                }
            }
        }
    }
}

function floatToRgba8(value: number): number {
    // Float render/texture data can be outside the UNORM range.  D3D's fixed
    // byte shadow is clamped; NaN is not a useful colour and is treated as zero.
    if (Number.isNaN(value) || value === -Infinity) return 0;
    if (value === Infinity) return 255;
    return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

/** Decode D3D9 R/G/RGBA float texels to the canonical RGBA8 shadow used by
 * the CPU copy/readback path.  This is intentionally a CPU codec only: the
 * D3D9 capability layer continues to refuse these formats until a real GPU
 * float-storage path exists. */
function decodeFloatD3DTextureToRgba8(
    src: Uint8Array,
    srcPtr: number,
    width: number,
    height: number,
    format: number,
    pitch: number,
    out: Uint8Array,
): boolean {
    const info = d3dFloatFormatInfo(format);
    if (!info) return false;
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const bytesPerPixel = info.channels * info.bytesPerChannel;
    let dst = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = srcPtr + y * pitch + x * bytesPerPixel;
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 1;
            let valid = true;
            for (let channel = 0; channel < info.channels; channel++) {
                const channelOffset = offset + channel * info.bytesPerChannel;
                if (channelOffset < 0 || channelOffset + info.bytesPerChannel > src.byteLength) {
                    valid = false;
                    break;
                }
                const value = info.bytesPerChannel === 2
                    ? float16BitsToFloat32(view.getUint16(channelOffset, true))
                    : view.getFloat32(channelOffset, true);
                if (channel === 0) r = value;
                else if (channel === 1) g = value;
                else if (channel === 2) b = value;
                else a = value;
            }
            // A truncated source must not throw or leave a partially written
            // destination texel.  Use a deterministic black/opaque texel.
            if (!valid) {
                r = g = b = 0;
                a = 1;
            }
            out[dst++] = floatToRgba8(r);
            out[dst++] = info.channels >= 2 ? floatToRgba8(g) : 0;
            out[dst++] = info.channels >= 4 ? floatToRgba8(b) : 0;
            out[dst++] = info.channels >= 4 ? floatToRgba8(a) : 255;
        }
    }
    return true;
}

/**
 * Convert a packed (non-block-compressed) D3D surface to RGBA8, returning false
 * for a format this decoder does not know so the caller can fall back to the
 * generic surface converter.
 *
 * `format` is invariant over the whole surface, so it selects a specialized loop
 * once rather than being re-dispatched per texel.
 */
function decodePackedD3DTextureToRgba8(
    src: Uint8Array,
    srcPtr: number,
    width: number,
    height: number,
    format: number,
    pitch: number,
    out: Uint8Array,
    palette?: Uint32Array,
): boolean {
    // An empty extent converts vacuously, for any format.
    if (width <= 0 || height <= 0) return true;
    let dst = 0;

    switch (format) {
        case D3DFMT_A8:
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 1) {
                    out[dst++] = 255; out[dst++] = 255; out[dst++] = 255; out[dst++] = src[off] ?? 0;
                }
            }
            return true;

        case D3DFMT_A8L8:
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 2) {
                    const l = src[off] ?? 0;
                    const a = src[off + 1] ?? 255;
                    out[dst++] = l; out[dst++] = l; out[dst++] = l; out[dst++] = a;
                }
            }
            return true;

        case D3DFMT_L16: {
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 2) {
                    // D3D's L16 is UNORM luminance; the RGBA8 shadow keeps the
                    // high byte (the same quantisation used by A16B16G16R16).
                    const l = view.getUint16(off, true) >>> 8;
                    out[dst++] = l; out[dst++] = l; out[dst++] = l; out[dst++] = 255;
                }
            }
            return true;
        }

        case D3DFMT_A4L4:
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 1) {
                    const p = src[off] ?? 0;
                    const l = (p & 0x0f) * 17;
                    const a = ((p >>> 4) & 0x0f) * 17;
                    out[dst++] = l; out[dst++] = l; out[dst++] = l; out[dst++] = a;
                }
            }
            return true;

        case D3DFMT_A8P8:
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 2) {
                    const idx = src[off] ?? 0;
                    const a = src[off + 1] ?? 255;
                    const c = palette?.[idx] ?? (0xff000000 | (idx << 16) | (idx << 8) | idx);
                    out[dst++] = c & 0xff;
                    out[dst++] = (c >>> 8) & 0xff;
                    out[dst++] = (c >>> 16) & 0xff;
                    out[dst++] = a;
                }
            }
            return true;

        case D3DFMT_A16B16G16R16: {
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 8) {
                    // All four channels are read before any is stored, so a
                    // short source throws without leaving a half-written texel.
                    const r = view.getUint16(off, true) >>> 8;
                    const g = view.getUint16(off + 2, true) >>> 8;
                    const b = view.getUint16(off + 4, true) >>> 8;
                    const a = view.getUint16(off + 6, true) >>> 8;
                    out[dst++] = r; out[dst++] = g; out[dst++] = b; out[dst++] = a;
                }
            }
            return true;
        }

        case D3DFMT_V8U8:
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 2) {
                    out[dst++] = signed8ToByte(src[off] ?? 0);
                    out[dst++] = signed8ToByte(src[off + 1] ?? 0);
                    out[dst++] = 255; out[dst++] = 255;
                }
            }
            return true;

        case D3DFMT_L6V5U5: {
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 2) {
                    const p = view.getUint16(off, true);
                    out[dst++] = signedNToByte(p, 5);
                    out[dst++] = signedNToByte(p >>> 5, 5);
                    out[dst++] = ((p >>> 10) & 0x3f) * 255 / 63 | 0;
                    out[dst++] = 255;
                }
            }
            return true;
        }

        case D3DFMT_X8L8V8U8:
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 4) {
                    out[dst++] = signed8ToByte(src[off] ?? 0);
                    out[dst++] = signed8ToByte(src[off + 1] ?? 0);
                    out[dst++] = src[off + 2] ?? 255;
                    out[dst++] = 255;
                }
            }
            return true;

        case D3DFMT_Q8W8V8U8:
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 4) {
                    out[dst++] = signed8ToByte(src[off] ?? 0);
                    out[dst++] = signed8ToByte(src[off + 1] ?? 0);
                    out[dst++] = signed8ToByte(src[off + 2] ?? 0);
                    out[dst++] = signed8ToByte(src[off + 3] ?? 0);
                }
            }
            return true;

        case D3DFMT_V16U16: {
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 4) {
                    out[dst++] = signedNToByte(view.getUint16(off, true), 16);
                    out[dst++] = signedNToByte(view.getUint16(off + 2, true), 16);
                    out[dst++] = 255;
                    out[dst++] = 255;
                }
            }
            return true;
        }

        case D3DFMT_Q16W16V16U16: {
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 8) {
                    // D3DFMT_Q16W16V16U16 is laid out least-significant component
                    // first (U,V,W,Q), just like Q8W8V8U8. The RGBA8 shadow keeps
                    // the same component order used by the existing bump decoders.
                    out[dst++] = signedNToByte(view.getUint16(off, true), 16);
                    out[dst++] = signedNToByte(view.getUint16(off + 2, true), 16);
                    out[dst++] = signedNToByte(view.getUint16(off + 4, true), 16);
                    out[dst++] = signedNToByte(view.getUint16(off + 6, true), 16);
                }
            }
            return true;
        }

        case D3DFMT_W11V11U10: {
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 4) {
                    const p = view.getUint32(off, true);
                    out[dst++] = signedNToByte(p, 10);
                    out[dst++] = signedNToByte(p >>> 10, 11);
                    out[dst++] = signedNToByte(p >>> 21, 11);
                    out[dst++] = 255;
                }
            }
            return true;
        }

        case D3DFMT_A2W10V10U10: {
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            for (let y = 0; y < height; y++) {
                let off = srcPtr + y * pitch;
                for (let x = 0; x < width; x++, off += 4) {
                    const p = view.getUint32(off, true);
                    out[dst++] = signedNToByte(p, 10);
                    out[dst++] = signedNToByte(p >>> 10, 10);
                    out[dst++] = signedNToByte(p >>> 20, 10);
                    out[dst++] = ((p >>> 30) & 0x03) * 85;
                }
            }
            return true;
        }

        default:
            return false;
    }
}

export function decodeD3DTextureToRgba8(
    src: Uint8Array,
    srcPtr: number,
    width: number,
    height: number,
    format: number,
    options: DecodeD3DTextureOptions = {},
): Uint8Array {
    const requiredBytes = Math.max(1, width | 0) * Math.max(1, height | 0) * 4;
    const out = options.out && options.out.length >= requiredBytes
        ? options.out.subarray(0, requiredBytes)
        : new Uint8Array(requiredBytes);

    if (isDxtFormat(format)) {
        const pitch = options.pitch ?? dxtRowPitch(format, width);
        const bytes = pitch * blocksHigh(height);
        const compressed = src.subarray(srcPtr, Math.min(src.length, srcPtr + bytes));
        decodeDxtToRgba(format, compressed, pitch, width, height, out);
        return out;
    }

    if (isBc45Format(format)) {
        const pitch = options.pitch ?? blockCompressedRowPitch(format, width);
        const bytes = pitch * blocksHigh(height);
        const compressed = src.subarray(srcPtr, Math.min(src.length, srcPtr + bytes));
        decodeBc45ToRgba(format, compressed, pitch, width, height, out);
        return out;
    }

    if (format === D3DFMT_A8 || format === D3DFMT_A8L8 || format === D3DFMT_A4L4 ||
        format === D3DFMT_A8P8 || format === D3DFMT_A16B16G16R16 || format === D3DFMT_L16 ||
        format === D3DFMT_V8U8 || format === D3DFMT_L6V5U5 || format === D3DFMT_X8L8V8U8 ||
        format === D3DFMT_Q8W8V8U8 || format === D3DFMT_V16U16 || format === D3DFMT_Q16W16V16U16 ||
        format === D3DFMT_W11V11U10 ||
        format === D3DFMT_A2W10V10U10) {
        const pitch = options.pitch ?? getD3DTextureLayout(format, width, height).pitch;
        if (decodePackedD3DTextureToRgba8(src, srcPtr, width, height, format, pitch, out, options.palette)) {
            return out;
        }
    }

    if (isD3DFloatFormat(format)) {
        const pitch = options.pitch ?? getD3DTextureLayout(format, width, height).pitch;
        if (decodeFloatD3DTextureToRgba8(src, srcPtr, width, height, format, pitch, out)) {
            return out;
        }
    }

    const sf = options.surfaceFormat ?? d3dFormatToSurfaceFormat(format);
    return convertSurfaceToRGBA(
        src,
        srcPtr,
        width,
        height,
        options.pitch ?? getD3DTextureLayout(format, width, height).pitch,
        sf,
        out,
        options.colorKey,
        options.palette,
    );
}

export function decodeSurfaceFormatToRgba8(
    src: Uint8Array,
    srcPtr: number,
    width: number,
    height: number,
    pitch: number,
    format: SurfaceFormat,
    out?: Uint8Array,
    colorKey?: { low: number; high: number },
    palette?: Uint32Array,
): Uint8Array {
    const fourCC = format.fourCC;
    if (fourCC !== undefined && isBlockCompressedFormat(fourCC)) {
        return decodeD3DTextureToRgba8(src, srcPtr, width, height, fourCC, { pitch, out });
    }
    return convertSurfaceToRGBA(src, srcPtr, width, height, pitch, format, out, colorKey, palette);
}

export function decodeOpenGLPixelsToRgba8(
    mem: Uint8Array,
    srcPtr: number,
    width: number,
    height: number,
    format: number,
    type: number,
    unpackAlignment: number,
    unpackRowLength: number,
    unpackSkipPixels: number,
    unpackSkipRows: number,
): Uint8Array {
    const totalPixels = width * height;
    const rgba = new Uint8Array(totalPixels * 4);

    if (type === GL_UNSIGNED_BYTE && unpackSkipRows === 0 && unpackSkipPixels === 0 &&
        (unpackRowLength === 0 || unpackRowLength === width)) {
        if (format === GL_RGBA) {
            const rowBytes = width * 4;
            const rowAligned = (rowBytes + unpackAlignment - 1) & ~(unpackAlignment - 1);
            if (rowAligned === rowBytes) {
                rgba.set(mem.subarray(srcPtr, srcPtr + totalPixels * 4));
                return rgba;
            }
        }
        if (format === GL_BGRA && (srcPtr & 3) === 0) {
            const rowBytes = width * 4;
            const rowAligned = (rowBytes + unpackAlignment - 1) & ~(unpackAlignment - 1);
            if (rowAligned === rowBytes) {
                const src32 = new Uint32Array(mem.buffer, mem.byteOffset + srcPtr, totalPixels);
                const dst32 = new Uint32Array(rgba.buffer);
                for (let i = 0; i < totalPixels; i++) {
                    const p = src32[i];
                    dst32[i] = (p & 0xFF00FF00) | ((p & 0xFF) << 16) | ((p >> 16) & 0xFF);
                }
                return rgba;
            }
        }
    }

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let srcBpp: number;
    switch (format) {
        case GL_RGBA:
        case GL_BGRA:
            srcBpp = 4;
            break;
        case GL_RGB:
        case GL_BGR:
            srcBpp = 3;
            break;
        case GL_LUMINANCE:
        case GL_ALPHA:
            srcBpp = 1;
            break;
        case GL_LUMINANCE_ALPHA:
            srcBpp = 2;
            break;
        default:
            srcBpp = 4;
            break;
    }

    if (type !== GL_UNSIGNED_BYTE) {
        const pixelSize = 2;
        const rowPixels = unpackRowLength > 0 ? unpackRowLength : width;
        for (let y = 0; y < height; y++) {
            const rowLen = rowPixels * pixelSize;
            const rowAligned = (rowLen + unpackAlignment - 1) & ~(unpackAlignment - 1);
            const rowStart = srcPtr + (unpackSkipRows + y) * rowAligned + unpackSkipPixels * pixelSize;
            for (let x = 0; x < width; x++) {
                const pixel = view.getUint16(rowStart + x * 2, true);
                const dstOff = (y * width + x) * 4;
                switch (type) {
                    case GL_UNSIGNED_SHORT_5_6_5:
                        rgba[dstOff] = ((pixel >> 11) & 0x1F) * 255 / 31;
                        rgba[dstOff + 1] = ((pixel >> 5) & 0x3F) * 255 / 63;
                        rgba[dstOff + 2] = (pixel & 0x1F) * 255 / 31;
                        rgba[dstOff + 3] = 255;
                        break;
                    case GL_UNSIGNED_SHORT_4_4_4_4:
                        rgba[dstOff] = ((pixel >> 12) & 0xF) * 17;
                        rgba[dstOff + 1] = ((pixel >> 8) & 0xF) * 17;
                        rgba[dstOff + 2] = ((pixel >> 4) & 0xF) * 17;
                        rgba[dstOff + 3] = (pixel & 0xF) * 17;
                        break;
                    case GL_UNSIGNED_SHORT_5_5_5_1:
                        rgba[dstOff] = ((pixel >> 11) & 0x1F) * 255 / 31;
                        rgba[dstOff + 1] = ((pixel >> 6) & 0x1F) * 255 / 31;
                        rgba[dstOff + 2] = ((pixel >> 1) & 0x1F) * 255 / 31;
                        rgba[dstOff + 3] = (pixel & 1) * 255;
                        break;
                    default:
                        rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = 0;
                        rgba[dstOff + 3] = 255;
                        break;
                }
            }
        }
        return rgba;
    }

    const rowPixels = unpackRowLength > 0 ? unpackRowLength : width;
    for (let y = 0; y < height; y++) {
        const rowLen = rowPixels * srcBpp;
        const rowAligned = (rowLen + unpackAlignment - 1) & ~(unpackAlignment - 1);
        const rowStart = srcPtr + (unpackSkipRows + y) * rowAligned + unpackSkipPixels * srcBpp;
        for (let x = 0; x < width; x++) {
            const srcOff = rowStart + x * srcBpp;
            const dstOff = (y * width + x) * 4;
            switch (format) {
                case GL_RGBA:
                    rgba[dstOff] = mem[srcOff];
                    rgba[dstOff + 1] = mem[srcOff + 1];
                    rgba[dstOff + 2] = mem[srcOff + 2];
                    rgba[dstOff + 3] = mem[srcOff + 3];
                    break;
                case GL_BGRA:
                    rgba[dstOff] = mem[srcOff + 2];
                    rgba[dstOff + 1] = mem[srcOff + 1];
                    rgba[dstOff + 2] = mem[srcOff];
                    rgba[dstOff + 3] = mem[srcOff + 3];
                    break;
                case GL_RGB:
                    rgba[dstOff] = mem[srcOff];
                    rgba[dstOff + 1] = mem[srcOff + 1];
                    rgba[dstOff + 2] = mem[srcOff + 2];
                    rgba[dstOff + 3] = 255;
                    break;
                case GL_BGR:
                    rgba[dstOff] = mem[srcOff + 2];
                    rgba[dstOff + 1] = mem[srcOff + 1];
                    rgba[dstOff + 2] = mem[srcOff];
                    rgba[dstOff + 3] = 255;
                    break;
                case GL_LUMINANCE: {
                    const l = mem[srcOff];
                    rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = l;
                    rgba[dstOff + 3] = 255;
                    break;
                }
                case GL_ALPHA:
                    rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = 0;
                    rgba[dstOff + 3] = mem[srcOff];
                    break;
                case GL_LUMINANCE_ALPHA: {
                    const l2 = mem[srcOff];
                    rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = l2;
                    rgba[dstOff + 3] = mem[srcOff + 1];
                    break;
                }
                default:
                    rgba[dstOff] = mem[srcOff];
                    rgba[dstOff + 1] = mem[srcOff + 1];
                    rgba[dstOff + 2] = mem[srcOff + 2];
                    rgba[dstOff + 3] = srcBpp >= 4 ? mem[srcOff + 3] : 255;
                    break;
            }
        }
    }
    return rgba;
}

export function openGLCompressedTextureFormatToD3DFormat(format: number): number {
    switch (format >>> 0) {
        case GL_COMPRESSED_RGB_S3TC_DXT1_EXT:
        case GL_COMPRESSED_RGBA_S3TC_DXT1_EXT:
            return D3DFMT_DXT1;
        case GL_COMPRESSED_RGBA_S3TC_DXT3_EXT:
            return D3DFMT_DXT3;
        case GL_COMPRESSED_RGBA_S3TC_DXT5_EXT:
            return D3DFMT_DXT5;
        case GL_COMPRESSED_RED_RGTC1:
        case GL_COMPRESSED_LUMINANCE_LATC1_EXT:
            return D3DFMT_BC4U;
        case GL_COMPRESSED_SIGNED_RED_RGTC1:
        case GL_COMPRESSED_SIGNED_LUMINANCE_LATC1_EXT:
            return D3DFMT_BC4S;
        case GL_COMPRESSED_RG_RGTC2:
        case GL_COMPRESSED_LUMINANCE_ALPHA_LATC2_EXT:
            return D3DFMT_BC5U;
        case GL_COMPRESSED_SIGNED_RG_RGTC2:
        case GL_COMPRESSED_SIGNED_LUMINANCE_ALPHA_LATC2_EXT:
            return D3DFMT_BC5S;
        default:
            return D3DFMT_UNKNOWN;
    }
}

export function isOpenGLCompressedTextureFormat(format: number): boolean {
    return openGLCompressedTextureFormatToD3DFormat(format) !== D3DFMT_UNKNOWN;
}

export function decodeOpenGLCompressedTextureToRgba8(
    src: Uint8Array,
    srcPtr: number,
    width: number,
    height: number,
    internalFormat: number,
    out?: Uint8Array,
): Uint8Array {
    const d3dFormat = openGLCompressedTextureFormatToD3DFormat(internalFormat);
    if (d3dFormat === D3DFMT_UNKNOWN) {
        const requiredBytes = Math.max(1, width | 0) * Math.max(1, height | 0) * 4;
        return out && out.length >= requiredBytes ? out.subarray(0, requiredBytes) : new Uint8Array(requiredBytes);
    }
    return decodeD3DTextureToRgba8(src, srcPtr, width, height, d3dFormat, { out });
}

export function estimateGlideTextureSizeBytes(width: number, height: number, format: number): number {
    return estimateTextureSizeBytes(width, height, format);
}

export function decodeGlideTextureToRgba8(
    memory: Uint8Array,
    dataPtr: number,
    width: number,
    height: number,
    format: number,
    palette: Uint32Array | null = null,
    ncc: DecodedNccTable | null = null,
): Uint8Array {
    return decodeGlideTexture(memory, dataPtr, width, height, format, palette, ncc);
}

export function d3dTextureSurfaceBytes(format: number, width: number, height: number): number {
    return isBlockCompressedFormat(format)
        ? blockCompressedSurfaceBytes(format, width, height)
        : getD3DTextureLayout(format, width, height).bytes;
}
