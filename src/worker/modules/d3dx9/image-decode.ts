/**
 * Image decode for D3DX texture loaders (PNG/JPEG/BMP/DDS/TGA).
 */

import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';
import type { SurfaceFormat } from '../ddraw/com-objects';
import { asBlobPart, asArrayBufferView } from '../../../dom-buffer';
import {
    D3DFMT_A1R5G5B5,
    D3DFMT_A4R4G4B4,
    D3DFMT_A8,
    D3DFMT_A8B8G8R8,
    D3DFMT_A8L8,
    D3DFMT_A8P8,
    D3DFMT_A8R8G8B8,
    D3DFMT_ATI1,
    D3DFMT_ATI2,
    D3DFMT_BC4S,
    D3DFMT_BC4U,
    D3DFMT_BC5S,
    D3DFMT_BC5U,
    D3DFMT_DXT1,
    D3DFMT_DXT2,
    D3DFMT_DXT3,
    D3DFMT_DXT4,
    D3DFMT_DXT5,
    D3DFMT_G16R16,
    D3DFMT_L8,
    D3DFMT_R5G6B5,
    D3DFMT_X8R8G8B8,
    DDPF_ALPHAPIXELS,
    DDPF_FOURCC,
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    decodeD3DTextureToRgba8,
    decodeSurfaceFormatToRgba8,
    getSurfaceFormatLayout,
} from '../../backends/webgpu/shared/texture-formats';

export type DecodedImage = {
    width: number;
    height: number;
    rgba: Uint8Array;
    mipLevels: number;
};

import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';

const DDS_MAGIC = 0x20534444; // "DDS "
const DDS_HEADER_SIZE = 124;
const DDS_PIXELFORMAT_SIZE = 32;
const DDSD_PITCH = 0x00000008;
const DDPF_ALPHA = 0x00000002;
const DDPF_LUMINANCE = 0x00020000;
const DDSCAPS2_CUBEMAP = 0x00000200;
const DDSCAPS2_VOLUME = 0x00200000;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DRTYPE_CUBETEXTURE = 5;
const FOURCC_DX10 = 0x30315844; // "DX10"

// DXGI_FORMAT values used by DDS DX10 headers. We decode the first 2D
// subresource; cube/array/volume variants are accepted as first-slice images.
const DXGI_FORMAT_R8G8B8A8_UNORM = 28;
const DXGI_FORMAT_R8G8B8A8_UNORM_SRGB = 29;
const DXGI_FORMAT_R16G16_UNORM = 35;
const DXGI_FORMAT_BC1_TYPELESS = 70;
const DXGI_FORMAT_BC1_UNORM = 71;
const DXGI_FORMAT_BC1_UNORM_SRGB = 72;
const DXGI_FORMAT_BC2_TYPELESS = 73;
const DXGI_FORMAT_BC2_UNORM = 74;
const DXGI_FORMAT_BC2_UNORM_SRGB = 75;
const DXGI_FORMAT_BC3_TYPELESS = 76;
const DXGI_FORMAT_BC3_UNORM = 77;
const DXGI_FORMAT_BC3_UNORM_SRGB = 78;
const DXGI_FORMAT_BC4_TYPELESS = 79;
const DXGI_FORMAT_BC4_UNORM = 80;
const DXGI_FORMAT_BC4_SNORM = 81;
const DXGI_FORMAT_BC5_TYPELESS = 82;
const DXGI_FORMAT_BC5_UNORM = 83;
const DXGI_FORMAT_BC5_SNORM = 84;
const DXGI_FORMAT_B5G6R5_UNORM = 85;
const DXGI_FORMAT_B5G5R5A1_UNORM = 86;
const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
const DXGI_FORMAT_B8G8R8X8_UNORM = 88;
const DXGI_FORMAT_B8G8R8A8_UNORM_SRGB = 91;
const DXGI_FORMAT_B8G8R8X8_UNORM_SRGB = 93;
const DXGI_FORMAT_B4G4R4A4_UNORM = 115;

function readU16LE(data: Uint8Array, offset: number): number {
    return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readU32LE(data: Uint8Array, offset: number): number {
    return (
        (data[offset] ?? 0) |
        ((data[offset + 1] ?? 0) << 8) |
        ((data[offset + 2] ?? 0) << 16) |
        ((data[offset + 3] ?? 0) << 24)
    ) >>> 0;
}

function ddsFourCCToD3DFormat(fourCC: number): number {
    switch (fourCC >>> 0) {
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
            return fourCC >>> 0;
        default:
            return 0;
    }
}

/**
 * A DDS whose surface format has no four-character code carries the D3DFORMAT enum VALUE in
 * dwFourCC instead — that is how d3dx writes the float formats (R16F .. A32B32G32R32F) and
 * A16B16G16R16. Reading such a value as a four-character code returns 0 and refuses a
 * perfectly good HDR map, which an engine then treats as a missing asset.
 *
 * A real code is four PRINTABLE bytes; anything else is a number. The value is still only
 * accepted when the shared format table knows it, so an unrecognised one stays a refusal
 * rather than becoming a wrong layout.
 */
const NUMERIC_FOURCC_FORMATS = new Set<number>([
    36,   // D3DFMT_A16B16G16R16
    110,  // D3DFMT_Q16W16V16U16
    111,  // D3DFMT_R16F
    112,  // D3DFMT_G16R16F
    113,  // D3DFMT_A16B16G16R16F
    114,  // D3DFMT_R32F
    115,  // D3DFMT_G32R32F
    116,  // D3DFMT_A32B32G32R32F
]);

function numericFourCCFormat(fourCC: number): number {
    let printable = 0;
    for (let i = 0; i < 4; i++) {
        const b = (fourCC >>> (i * 8)) & 0xff;
        if (b >= 0x20 && b < 0x7f) printable++;
    }
    if (printable === 4) return 0;
    // An explicit list, NOT a "does the format table know it" test: d3dFormatBpp answers 32 for
    // everything it does not recognise, so that check would accept any number at all and hand
    // the loader a wrong layout instead of a refusal.
    return NUMERIC_FOURCC_FORMATS.has(fourCC >>> 0) ? fourCC >>> 0 : 0;
}

function dxgiFormatToD3DFormat(dxgiFormat: number): number {
    switch (dxgiFormat) {
        case DXGI_FORMAT_R8G8B8A8_UNORM:
        case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
            return D3DFMT_A8B8G8R8;
        case DXGI_FORMAT_B8G8R8A8_UNORM:
        case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
            return D3DFMT_A8R8G8B8;
        case DXGI_FORMAT_B8G8R8X8_UNORM:
        case DXGI_FORMAT_B8G8R8X8_UNORM_SRGB:
            return D3DFMT_X8R8G8B8;
        case DXGI_FORMAT_B5G6R5_UNORM:
            return D3DFMT_R5G6B5;
        case DXGI_FORMAT_B5G5R5A1_UNORM:
            return D3DFMT_A1R5G5B5;
        case DXGI_FORMAT_B4G4R4A4_UNORM:
            return D3DFMT_A4R4G4B4;
        case DXGI_FORMAT_R16G16_UNORM:
            return D3DFMT_G16R16;
        case DXGI_FORMAT_BC1_TYPELESS:
        case DXGI_FORMAT_BC1_UNORM:
        case DXGI_FORMAT_BC1_UNORM_SRGB:
            return D3DFMT_DXT1;
        case DXGI_FORMAT_BC2_TYPELESS:
        case DXGI_FORMAT_BC2_UNORM:
        case DXGI_FORMAT_BC2_UNORM_SRGB:
            return D3DFMT_DXT3;
        case DXGI_FORMAT_BC3_TYPELESS:
        case DXGI_FORMAT_BC3_UNORM:
        case DXGI_FORMAT_BC3_UNORM_SRGB:
            return D3DFMT_DXT5;
        case DXGI_FORMAT_BC4_TYPELESS:
        case DXGI_FORMAT_BC4_UNORM:
            return D3DFMT_BC4U;
        case DXGI_FORMAT_BC4_SNORM:
            return D3DFMT_BC4S;
        case DXGI_FORMAT_BC5_TYPELESS:
        case DXGI_FORMAT_BC5_UNORM:
            return D3DFMT_BC5U;
        case DXGI_FORMAT_BC5_SNORM:
            return D3DFMT_BC5S;
        default:
            return 0;
    }
}

/** No D3D9 device holds a larger surface, so a header naming one is not a file. */
const MAX_DDS_EXTENT = 16384;

/** The handful of uncompressed D3DFORMAT values a DDS header can name. */
const D3DFMT_R8G8B8_INFO = 20;
const D3DFMT_A8R8G8B8_INFO = 21;
const D3DFMT_X8R8G8B8_INFO = 22;
const D3DFMT_R5G6B5_INFO = 23;
const D3DFMT_A1R5G5B5_INFO = 25;

/** D3DXIMAGE_FILEFORMAT. */
export const enum ImageFileFormat {
    Bmp = 0, Jpg = 1, Tga = 2, Png = 3, Dds = 4, Ppm = 5, Dib = 6, Hdr = 7, Pfm = 8,
}

/**
 * What the CONTAINER is, from its magic alone. D3DX answers D3DXIMAGE_INFO.ImageFileFormat
 * from the header, never from a decode — and an engine that switches on the value it gets
 * back will index a jump table with it, so a placeholder there is a call through a garbage
 * pointer rather than a cosmetic wrong field.
 */
export function imageFileFormatOf(data: Uint8Array): ImageFileFormat | null {
    if (data.length >= 4 && readU32LE(data, 0) === DDS_MAGIC) return ImageFileFormat.Dds;
    if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
        return ImageFileFormat.Png;
    }
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return ImageFileFormat.Jpg;
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return ImageFileFormat.Bmp;
    if (data.length >= 18) return ImageFileFormat.Tga;
    return null;
}

/**
 * A DDS header read WITHOUT decoding: dimensions, real mip count and the surface format the
 * file stores. The decode that follows converts to RGBA, but the info query has to describe
 * the file.
 */
export function readDdsInfo(
    data: Uint8Array,
): {
    width: number; height: number; depth: number; mipLevels: number;
    /** What the HEADER claims, which is what d3dx would create. `mipLevels` is what the
     *  payload actually carries; a streamed asset ships fewer. */
    claimedMipLevels: number;
    format: number; resourceType: number; dataOffset: number;
} | null {
    if (data.length < 128 || readU32LE(data, 0) !== DDS_MAGIC) return null;
    if (readU32LE(data, 4) !== DDS_HEADER_SIZE || readU32LE(data, 76) !== DDS_PIXELFORMAT_SIZE) return null;
    const height = readU32LE(data, 12);
    const width = readU32LE(data, 16);
    // A garbage/hostile header is just bytes: an extent no D3D9 device could hold is not a
    // file we describe, it is a create call for gigabytes. D3D9's own cap is 8192.
    if (width <= 0 || height <= 0 || width > MAX_DDS_EXTENT || height > MAX_DDS_EXTENT) return null;
    const mipMapCount = readU32LE(data, 28);
    // caps2 separates the three shapes a .dds can hold. An engine picks its loader from the
    // RESOURCE TYPE d3dx reports back, so answering 2D for a cube map sends it down a branch
    // that builds a different object than the file describes.
    const caps2 = readU32LE(data, 112);
    const isCube = (caps2 & DDSCAPS2_CUBEMAP) !== 0;
    const isVolume = (caps2 & DDSCAPS2_VOLUME) !== 0;
    const depthField = readU32LE(data, 24);
    if (isVolume && depthField > MAX_DDS_EXTENT) return null;
    const depth = isVolume ? Math.max(1, depthField) : 1;
    const resourceType = isCube ? D3DRTYPE_CUBETEXTURE : isVolume ? D3DRTYPE_VOLUMETEXTURE : D3DRTYPE_TEXTURE;
    const pfFlags = readU32LE(data, 80);
    const fourCC = readU32LE(data, 84);
    let format = 0;
    if ((pfFlags & DDPF_FOURCC) !== 0) {
        format = fourCC === FOURCC_DX10 && data.length >= 148
            ? dxgiFormatToD3DFormat(readU32LE(data, 128))
            : ddsFourCCToD3DFormat(fourCC) || numericFourCCFormat(fourCC);
    } else {
        // An uncompressed DDS: the masks name the format. Only the spellings a D3D9 title
        // actually ships are recognised; anything else stays 0 and the caller falls back to
        // describing what the decode produced.
        const bpp = readU32LE(data, 88);
        const aMask = readU32LE(data, 104);
        if (bpp === 32) format = aMask ? D3DFMT_A8R8G8B8_INFO : D3DFMT_X8R8G8B8_INFO;
        else if (bpp === 24) format = D3DFMT_R8G8B8_INFO;
        else if (bpp === 16) format = aMask ? D3DFMT_A1R5G5B5_INFO : D3DFMT_R5G6B5_INFO;
    }
    if (!format) return null;
    // Where the surface bytes begin: past the 124-byte header, past the DX10 extension, and
    // past an 8-bit palette when the file carries one.
    let dataOffset = 128;
    if (fourCC === FOURCC_DX10 && (pfFlags & DDPF_FOURCC) !== 0) dataOffset = 148;
    else if ((pfFlags & DDPF_PALETTEINDEXED8) !== 0) dataOffset += 256 * 4;
    // The header's mip COUNT and the levels the payload actually carries are two different
    // numbers, and a caller that trusts the first walks off the end of a texture built from
    // the second. Report what is there.
    const claimed = Math.max(1, mipMapCount);
    let present = 0;
    let at = dataOffset;
    for (let level = 0; level < claimed; level++) {
        const layout = getD3DTextureLayout(format, Math.max(1, width >>> level), Math.max(1, height >>> level));
        if (at + layout.bytes > data.length) break;
        at += layout.bytes;
        present++;
    }
    return {
        width, height, depth,
        mipLevels: Math.max(1, present), claimedMipLevels: claimed,
        format, resourceType, dataOffset,
    };
}

function decodeDDS(data: Uint8Array): { width: number; height: number; rgba: Uint8Array; mipLevels: number } | null {
    if (data.length < 128 || readU32LE(data, 0) !== DDS_MAGIC) return null;
    if (readU32LE(data, 4) !== DDS_HEADER_SIZE || readU32LE(data, 76) !== DDS_PIXELFORMAT_SIZE) return null;

    const flags = readU32LE(data, 8);
    const height = readU32LE(data, 12);
    const width = readU32LE(data, 16);
    const pitchOrLinearSize = readU32LE(data, 20);
    const mipMapCount = readU32LE(data, 28);
    const pfFlags = readU32LE(data, 80);
    const fourCC = readU32LE(data, 84);
    const bpp = readU32LE(data, 88);
    const rMask = readU32LE(data, 92);
    const gMask = readU32LE(data, 96);
    const bMask = readU32LE(data, 100);
    const aMask = readU32LE(data, 104);
    let dataOffset = 128;

    if (width <= 0 || height <= 0 || dataOffset >= data.length) return null;

    let palette: Uint32Array | undefined;
    if ((pfFlags & DDPF_PALETTEINDEXED8) !== 0) {
        if (data.length < dataOffset + 256 * 4) return null;
        palette = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            const p = dataOffset + i * 4;
            const r = data[p] ?? 0;
            const g = data[p + 1] ?? 0;
            const b = data[p + 2] ?? 0;
            palette[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
        dataOffset += 256 * 4;
    }

    if (dataOffset >= data.length) return null;

    if ((pfFlags & DDPF_FOURCC) !== 0) {
        let format = ddsFourCCToD3DFormat(fourCC);
        if (fourCC === FOURCC_DX10) {
            if (data.length < 148) return null;
            const dxgiFormat = readU32LE(data, 128);
            format = dxgiFormatToD3DFormat(dxgiFormat);
            dataOffset = 148;
        }
        if (!format) return null;
        if (dataOffset >= data.length) return null;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, format),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if ((pfFlags & DDPF_LUMINANCE) !== 0) {
        const format = bpp === 16 && aMask ? D3DFMT_A8L8 : D3DFMT_L8;
        const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
            ? pitchOrLinearSize
            : getSurfaceFormatLayout({ flags: 0, bpp, rMask: 0, gMask: 0, bMask: 0, aMask }, width, height).pitch;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, format, { pitch }),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if ((pfFlags & DDPF_ALPHA) !== 0 && bpp === 8 && (pfFlags & DDPF_RGB) === 0) {
        const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
            ? pitchOrLinearSize
            : width;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, D3DFMT_A8, { pitch }),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if ((pfFlags & DDPF_PALETTEINDEXED8) !== 0 && bpp === 16) {
        const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
            ? pitchOrLinearSize
            : width * 2;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, D3DFMT_A8P8, { pitch, palette }),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if (bpp !== 8 && bpp !== 16 && bpp !== 24 && bpp !== 32) return null;
    if ((pfFlags & (DDPF_RGB | DDPF_ALPHA | DDPF_PALETTEINDEXED8)) === 0) return null;

    const format: SurfaceFormat = {
        flags: pfFlags,
        bpp,
        rMask,
        gMask,
        bMask,
        aMask: (pfFlags & (DDPF_ALPHAPIXELS | DDPF_ALPHA)) !== 0 ? aMask : 0,
    };
    const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
        ? pitchOrLinearSize
        : getSurfaceFormatLayout(format, width, height).pitch;

    return {
        width,
        height,
        rgba: decodeSurfaceFormatToRgba8(data, dataOffset, width, height, pitch, format, undefined, undefined, palette),
        mipLevels: Math.max(1, mipMapCount || 1),
    };
}

function decodeTGA(data: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
    if (data.length < 18) return null;

    const idLength = data[0];
    const colorMapType = data[1];
    const imageType = data[2];
    const colorMapFirst = readU16LE(data, 3);
    const colorMapLength = readU16LE(data, 5);
    const colorMapBpp = data[7];
    const width = readU16LE(data, 12);
    const height = readU16LE(data, 14);
    const bpp = data[16];
    const descriptor = data[17];
    const topDown = (descriptor & 0x20) !== 0;
    const rightToLeft = (descriptor & 0x10) !== 0;
    const alphaBits = descriptor & 0x0f;
    const isColorMapped = imageType === 1 || imageType === 9;
    const isTrueColor = imageType === 2 || imageType === 10;
    const isGrayscale = imageType === 3 || imageType === 11;
    const isRLE = imageType === 9 || imageType === 10 || imageType === 11;

    if (width <= 0 || height <= 0) return null;
    if (!isColorMapped && !isTrueColor && !isGrayscale) return null;
    if (isColorMapped && colorMapType !== 1) return null;
    if (!isColorMapped && colorMapType !== 0) return null;
    if (isTrueColor && bpp !== 15 && bpp !== 16 && bpp !== 24 && bpp !== 32) return null;
    if (isGrayscale && bpp !== 8 && bpp !== 16) return null;
    if (isColorMapped && bpp !== 8 && bpp !== 16) return null;

    const colorMapBytesPerEntry = colorMapType ? Math.ceil(colorMapBpp / 8) : 0;
    const colorMapBytes = colorMapLength * colorMapBytesPerEntry;
    const pixelBytes = Math.ceil(bpp / 8);
    const rgba = new Uint8Array(width * height * 4);
    let src = 18 + idLength + colorMapBytes;

    const palette: Uint32Array | null = isColorMapped ? new Uint32Array(colorMapFirst + colorMapLength) : null;
    if (palette) {
        let p = 18 + idLength;
        for (let i = 0; i < colorMapLength; i++) {
            const c = readTgaColor(data, p, colorMapBpp, colorMapBpp === 16 ? 1 : 0);
            palette[colorMapFirst + i] = (c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
            p += colorMapBytesPerEntry;
        }
    }

    function writePixel(pixel: number, r: number, g: number, b: number, a: number): void {
        const logicalRow = Math.floor(pixel / width);
        const logicalCol = pixel % width;
        const row = topDown ? logicalRow : (height - 1 - logicalRow);
        const col = rightToLeft ? (width - 1 - logicalCol) : logicalCol;
        const dst = (row * width + col) * 4;
        rgba[dst] = r;
        rgba[dst + 1] = g;
        rgba[dst + 2] = b;
        rgba[dst + 3] = a;
    }

    const readPixel = (): [number, number, number, number] => {
        if (isColorMapped) {
            const idx = bpp === 16 ? readU16LE(data, src) : (data[src] ?? 0);
            src += pixelBytes;
            const raw = palette?.[idx] ?? 0xff000000;
            return [raw & 0xff, (raw >>> 8) & 0xff, (raw >>> 16) & 0xff, (raw >>> 24) & 0xff];
        }
        if (isGrayscale) {
            const l = data[src] ?? 0;
            const a = bpp === 16 ? (data[src + 1] ?? 255) : 255;
            src += pixelBytes;
            return [l, l, l, a];
        }
        const c = readTgaColor(data, src, bpp, alphaBits);
        src += pixelBytes;
        return c;
    };

    if (!isRLE) {
        for (let pixel = 0; pixel < width * height && src < data.length; pixel++) {
            const c = readPixel();
            writePixel(pixel, c[0], c[1], c[2], c[3]);
        }
    } else {
        let pixel = 0;
        while (pixel < width * height && src < data.length) {
            const packet = data[src++];
            const count = (packet & 0x7f) + 1;
            const packetIsRLE = (packet & 0x80) !== 0;

            if (packetIsRLE) {
                const c = readPixel();
                for (let j = 0; j < count && pixel < width * height; j++, pixel++) {
                    writePixel(pixel, c[0], c[1], c[2], c[3]);
                }
            } else {
                for (let j = 0; j < count && pixel < width * height; j++, pixel++) {
                    const c = readPixel();
                    writePixel(pixel, c[0], c[1], c[2], c[3]);
                }
            }
        }
    }

    return { width, height, rgba };
}

function readTgaColor(data: Uint8Array, offset: number, bpp: number, alphaBits: number = 0): [number, number, number, number] {
    if (bpp === 16 || bpp === 15) {
        const raw = readU16LE(data, offset);
        return [
            ((raw >>> 10) & 0x1f) * 255 / 31 | 0,
            ((raw >>> 5) & 0x1f) * 255 / 31 | 0,
            (raw & 0x1f) * 255 / 31 | 0,
            bpp === 16 && alphaBits > 0 && (raw & 0x8000) === 0 ? 0 : 255,
        ];
    }
    return [
        data[offset + 2] ?? 0,
        data[offset + 1] ?? 0,
        data[offset] ?? 0,
        bpp === 32 ? (data[offset + 3] ?? 255) : 255,
    ];
}

async function imageBitmapFromRGBA(rgba: Uint8Array, width: number, height: number): Promise<ImageBitmap> {
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return createImageBitmap(new ImageData(asArrayBufferView(clamped), width, height));
}

async function rgbaFromImageBitmap(bitmap: ImageBitmap): Promise<Uint8Array> {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
}

function computeMipLevels(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

export async function decodeImageBytes(data: Uint8Array): Promise<DecodedImage | null> {
    try {
        let width: number;
        let height: number;
        let rgba: Uint8Array;

        if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
            const bitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: 'image/png' }));
            width = bitmap.width;
            height = bitmap.height;
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        } else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
            const bitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: 'image/jpeg' }));
            width = bitmap.width;
            height = bitmap.height;
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        } else if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
            const bitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: 'image/bmp' }));
            width = bitmap.width;
            height = bitmap.height;
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        } else if (data.length >= 4 && readU32LE(data, 0) === DDS_MAGIC) {
            const dds = decodeDDS(data);
            if (!dds) return null;
            width = dds.width;
            height = dds.height;
            rgba = dds.rgba;
            return {
                width,
                height,
                rgba,
                mipLevels: dds.mipLevels,
            };
        } else {
            const tga = decodeTGA(data);
            if (!tga) return null;
            width = tga.width;
            height = tga.height;
            const bitmap = await imageBitmapFromRGBA(tga.rgba, width, height);
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        }

        return {
            width,
            height,
            rgba,
            mipLevels: computeMipLevels(width, height),
        };
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `d3dx9: image decode failed: ${e}`);
        return null;
    }
}

export async function loadImageFromVfs(path: string): Promise<DecodedImage | null> {
    const vfs = System.getInstance().fileSystem;
    const normalized = path.replace(/\\/g, '/');
    const fh = await vfs.open(normalized, 0x80000000, 3);
    if (!fh) {
        Logger.warn(LogCategory.SYSTEM, `d3dx9: file not found "${normalized}"`);
        return null;
    }
    const size = vfs.getFileSize(normalized);
    if (size <= 0) return null;
    const data = await vfs.read(fh, size);
    return decodeImageBytes(data);
}
