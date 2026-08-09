/**
 * GPU Texture Utilities - Data-Oriented Design optimizations
 *
 * Pre-computed lookup tables and optimized converters for texture upload.
 * Eliminates per-pixel divisions and bit manipulations.
 */

import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { isValidAddress, overlapsThunkCode } from "../../core/memory/address-guard";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";
import { DDPF_FOURCC } from "./constants";
import type { DirectDrawSurfaceState } from "./com-objects";

// ============================================================================
// PRE-COMPUTED LOOKUP TABLES (initialized once at module load)
// ============================================================================

/**
 * RGB565 to RGBA8888 lookup table (65536 entries × 4 bytes = 256KB)
 * Format: 0xAABBGGRR (little-endian RGBA for direct Uint32 write)
 */
export const RGB565_TO_RGBA = new Uint32Array(65536);

/**
 * RGB555 to RGBA8888 lookup table (32768 entries × 4 bytes = 128KB)
 * Format: 0xAABBGGRR
 */
export const RGB555_TO_RGBA = new Uint32Array(32768);

/**
 * ARGB1555 to RGBA8888 lookup table (65536 entries × 4 bytes = 256KB)
 * Format: 0xAABBGGRR
 */
export const ARGB1555_TO_RGBA = new Uint32Array(65536);

/**
 * ARGB4444 to RGBA8888 lookup table (65536 entries × 4 bytes = 256KB)
 * Format: 0xAABBGGRR
 */
export const ARGB4444_TO_RGBA = new Uint32Array(65536);

/**
 * REVERSE LOOKUPS: RGBA8888 to Surface Formats
 * Used for GDI/ReleaseDC sync (GDI → Surface memory)
 * 
 * We use 5-bit R, 5-bit G, 5-bit B (or 6 for 565) to index.
 * Total 32*32*32 = 32768 entries or 32*64*32 = 65536 entries.
 * But we can just use bit shifts since RGBA8888 is already component-separated.
 */

/** 5/6-bit to 8-bit expansion (internal, used only for LUT init) */
const EXPAND_5_TO_8 = new Uint8Array(32);
const EXPAND_6_TO_8 = new Uint8Array(64);

// Initialize lookup tables at module load
(function initLookupTables() {
    // 5-bit to 8-bit expansion: (value * 255 + 15) / 31
    for (let i = 0; i < 32; i++) {
        EXPAND_5_TO_8[i] = (i * 255 + 15) / 31 | 0;
    }

    // 6-bit to 8-bit expansion: (value * 255 + 31) / 63
    for (let i = 0; i < 64; i++) {
        EXPAND_6_TO_8[i] = (i * 255 + 31) / 63 | 0;
    }

    // RGB565: RRRRRGGGGGGBBBBB
    // R: bits 11-15 (5 bits), G: bits 5-10 (6 bits), B: bits 0-4 (5 bits)
    for (let pixel = 0; pixel < 65536; pixel++) {
        const r5 = (pixel >> 11) & 0x1F;
        const g6 = (pixel >> 5) & 0x3F;
        const b5 = pixel & 0x1F;

        const r8 = EXPAND_5_TO_8[r5];
        const g8 = EXPAND_6_TO_8[g6];
        const b8 = EXPAND_5_TO_8[b5];

        // RGBA little-endian: 0xAABBGGRR
        RGB565_TO_RGBA[pixel] = 0xFF000000 | (b8 << 16) | (g8 << 8) | r8;
    }

    // RGB555: XRRRRRGGGGGBBBBB (X = ignored)
    for (let pixel = 0; pixel < 32768; pixel++) {
        const r5 = (pixel >> 10) & 0x1F;
        const g5 = (pixel >> 5) & 0x1F;
        const b5 = pixel & 0x1F;

        const r8 = EXPAND_5_TO_8[r5];
        const g8 = EXPAND_5_TO_8[g5];
        const b8 = EXPAND_5_TO_8[b5];

        RGB555_TO_RGBA[pixel] = 0xFF000000 | (b8 << 16) | (g8 << 8) | r8;
    }

    // ARGB1555: ARRRRRGGGGGBBBBB
    // bit15 (A) determines alpha: 1→opaque (255), 0→transparent (0).
    // Games control transparency through bit15: fonts set 0 for transparent bg,
    // BMP conversions set 1 for all opaque pixels.
    // Colorkey transparency is handled separately via applyColorKeyToRGBA().
    for (let pixel = 0; pixel < 65536; pixel++) {
        const a1 = (pixel >> 15) & 0x1;
        const r5 = (pixel >> 10) & 0x1F;
        const g5 = (pixel >> 5) & 0x1F;
        const b5 = pixel & 0x1F;

        const a8 = a1 ? 255 : 0;
        const r8 = EXPAND_5_TO_8[r5];
        const g8 = EXPAND_5_TO_8[g5];
        const b8 = EXPAND_5_TO_8[b5];

        ARGB1555_TO_RGBA[pixel] = (a8 << 24) | (b8 << 16) | (g8 << 8) | r8;
    }

    // ARGB4444: AAAARRRRGGGGBBBB — each nibble expanded to 8 bits (n*17 = n*255/15).
    for (let pixel = 0; pixel < 65536; pixel++) {
        const a8 = ((pixel >> 12) & 0xF) * 17;
        const r8 = ((pixel >> 8) & 0xF) * 17;
        const g8 = ((pixel >> 4) & 0xF) * 17;
        const b8 = (pixel & 0xF) * 17;
        ARGB4444_TO_RGBA[pixel] = (a8 << 24) | (b8 << 16) | (g8 << 8) | r8;
    }
})();

// ============================================================================
// FORMAT DETECTION
// ============================================================================

export const enum PixelFormat {
    UNKNOWN = 0,
    RGB565 = 1,      // R:5 G:6 B:5 (no alpha)
    RGB555 = 2,      // R:5 G:5 B:5 (no alpha, 1 bit unused)
    ARGB1555 = 3,    // A:1 R:5 G:5 B:5
    ARGB4444 = 4,    // A:4 R:4 G:4 B:4
    RGB888 = 5,      // R:8 G:8 B:8 (24-bit)
    ARGB8888 = 6,    // A:8 R:8 G:8 B:8 (32-bit)
    XRGB8888 = 7,    // X:8 R:8 G:8 B:8 (32-bit, alpha ignored)
    PALETTE8 = 8,    // 8-bit palette indexed
    LUMINANCE8 = 9,  // 8-bit luminance (L → RGB(L,L,L), A=255)
}

export interface FormatInfo {
    bpp: number;
    rMask: number;
    gMask: number;
    bMask: number;
    aMask: number;
    flags?: number; // Optional DDPIXELFORMAT flags (e.g., DDPF_PALETTEINDEXED8)
}

/**
 * Detect pixel format from masks
 */
export function detectPixelFormat(format: FormatInfo): PixelFormat {
    const { bpp, rMask, gMask, bMask, aMask, flags = 0 } = format;

    // DDPF_FOURCC: the masks and dwRGBBitCount are meaningless by contract, and the guest
    // leaves them 0 — which readPixelFormat then substitutes with the RGB565 defaults. The
    // mask tests below would call a DXT1 surface "RGB565", and every consumer gating on this
    // classifier would read 4x4 blocks as pixels. Only getSurfaceFormatLayout /
    // decodeSurfaceFormatToRgba8 know the layout, so say UNKNOWN and route callers there.
    if (flags & DDPF_FOURCC) {
        return PixelFormat.UNKNOWN;
    }

    if (bpp === 8) {
        // Check for DDPF_PALETTEINDEXED8 (0x20)
        if (flags & 0x20) {
            return PixelFormat.PALETTE8;
        }
        // L8 luminance: bpp=8, no palette flag, no color/alpha masks
        if (!rMask && !gMask && !bMask && !aMask) {
            return PixelFormat.LUMINANCE8;
        }
    } else if (bpp === 16) {
        // RGB565: R=0xF800, G=0x07E0, B=0x001F
        if (rMask === 0xF800 && gMask === 0x07E0 && bMask === 0x001F && !aMask) {
            return PixelFormat.RGB565;
        }
        // RGB555: R=0x7C00, G=0x03E0, B=0x001F
        if (rMask === 0x7C00 && gMask === 0x03E0 && bMask === 0x001F && !aMask) {
            return PixelFormat.RGB555;
        }
        // ARGB1555: A=0x8000, R=0x7C00, G=0x03E0, B=0x001F
        if (rMask === 0x7C00 && gMask === 0x03E0 && bMask === 0x001F && aMask === 0x8000) {
            return PixelFormat.ARGB1555;
        }
        // ARGB4444: A=0xF000, R=0x0F00, G=0x00F0, B=0x000F
        if (rMask === 0x0F00 && gMask === 0x00F0 && bMask === 0x000F && aMask === 0xF000) {
            return PixelFormat.ARGB4444;
        }
    } else if (bpp === 24) {
        return PixelFormat.RGB888;
    } else if (bpp === 32) {
        if (rMask === 0x00FF0000 && gMask === 0x0000FF00 && bMask === 0x000000FF) {
            if (aMask === 0xFF000000) {
                return PixelFormat.ARGB8888;
            }
            if (aMask === 0) {
                return PixelFormat.XRGB8888;
            }
            return PixelFormat.UNKNOWN;
        }
    }

    return PixelFormat.UNKNOWN;
}

// ============================================================================
// COLOR KEY DECODING (format-aware)
// ============================================================================

/** 5-bit to 8-bit expansion: (val * 255 + 15) / 31, clamped to 255 */
const expand5 = (v: number) => Math.min(255, ((v * 255 + 15) / 31) | 0);
/** 6-bit to 8-bit expansion: (val * 255 + 31) / 63, clamped to 255 */
const expand6 = (v: number) => Math.min(255, ((v * 255 + 31) / 63) | 0);

/**
 * Decode color key (DDCOLORKEY low/high) to normalized RGBA [0,1] based on surface pixel format.
 * DX7 games use 16-bit formats (RGB565, ARGB1555); assuming ARGB8888 breaks transparency (e.g. magenta key).
 */
export function decodeColorKeyToRGBA(
    raw: number,
    format: PixelFormat
): { r: number; g: number; b: number; a: number } {
    switch (format) {
        case PixelFormat.RGB565: {
            const r5 = (raw >> 11) & 0x1f;
            const g6 = (raw >> 5) & 0x3f;
            const b5 = raw & 0x1f;
            return {
                r: expand5(r5) / 255,
                g: expand6(g6) / 255,
                b: expand5(b5) / 255,
                a: 1,
            };
        }
        case PixelFormat.RGB555: {
            const r5 = (raw >> 10) & 0x1f;
            const g5 = (raw >> 5) & 0x1f;
            const b5 = raw & 0x1f;
            return {
                r: expand5(r5) / 255,
                g: expand5(g5) / 255,
                b: expand5(b5) / 255,
                a: 1,
            };
        }
        case PixelFormat.ARGB1555: {
            const a1 = (raw >> 15) & 1;
            const r5 = (raw >> 10) & 0x1f;
            const g5 = (raw >> 5) & 0x1f;
            const b5 = raw & 0x1f;
            return {
                r: expand5(r5) / 255,
                g: expand5(g5) / 255,
                b: expand5(b5) / 255,
                a: a1 ? 1 : 0,
            };
        }
        case PixelFormat.ARGB8888: {
            return {
                r: ((raw >> 16) & 0xff) / 255,
                g: ((raw >> 8) & 0xff) / 255,
                b: (raw & 0xff) / 255,
                a: ((raw >> 24) & 0xff) / 255,
            };
        }
        case PixelFormat.XRGB8888: {
            return {
                r: ((raw >> 16) & 0xff) / 255,
                g: ((raw >> 8) & 0xff) / 255,
                b: (raw & 0xff) / 255,
                a: 1,
            };
        }
        default:
            return { r: 1, g: 0, b: 1, a: 1 }; // Magenta fallback
    }
}

// ============================================================================
// COLORKEY APPLICATION FOR BITMAP TEXTURES
// ============================================================================

/**
 * Apply color key transparency to an existing RGBA buffer.
 *
 * Used for BitmapTextureSurface where rgbaScratch is authoritative and should not
 * be mutated. Creates a new buffer with alpha=0 for colorkey-matched pixels.
 *
 * DirectDraw/D3D colorkey semantics:
 * - Colorkey is specified in SURFACE pixel format (RGB565, palette index, etc.)
 * - Range [low, high] inclusive - pixels in range are transparent
 * - For palette textures: colorkey is palette INDEX, not RGB value
 * - Games may set colorkey AFTER texture load
 *
 * @param rgbaScratch Original RGBA buffer (will NOT be modified)
 * @param mem Guest memory containing surface pixels in original format
 * @param surfacePtr Guest address of surface pixels
 * @param width Surface width
 * @param height Surface height
 * @param pitch Surface pitch in bytes
 * @param format Surface pixel format info
 * @param colorkey Colorkey range { low, high } in surface format
 * @param palette Optional palette for 8-bit indexed textures
 * @returns New RGBA buffer with colorkey applied (alpha=0 for transparent pixels)
 */
export function applyColorKeyToRGBA(
    rgbaScratch: Uint8Array,
    mem: Uint8Array,
    surfacePtr: number,
    width: number,
    height: number,
    pitch: number,
    format: FormatInfo,
    colorkey: { low: number; high: number },
    palette?: Uint32Array
): Uint8Array {
    const pixelCount = width * height;
    const requiredBytes = pixelCount * 4;

    // Create output buffer (copy of original)
    const result = new Uint8Array(requiredBytes);
    result.set(rgbaScratch);
    const rgba32 = new Uint32Array(result.buffer, result.byteOffset, pixelCount);

    const pixelFormat = detectPixelFormat(format);
    const bytesPerPixel = Math.max(1, format.bpp >> 3);

    // Calculate colorkey mask and range
    // For RGB formats, mask out alpha bits to compare only RGB
    const ckMask = (format.rMask | format.gMask | format.bMask) >>> 0;
    const ckLow = (colorkey.low & ckMask) >>> 0;
    const ckHigh = (colorkey.high & ckMask) >>> 0;

    let transparentCount = 0;

    // Special handling for palette-indexed textures
    // Colorkey is palette INDEX, not RGB color!
    if (pixelFormat === PixelFormat.PALETTE8) {
        // For 8-bit palette textures, colorkey.low/high are palette indices
        const idxLow = colorkey.low & 0xFF;
        const idxHigh = colorkey.high & 0xFF;

        for (let y = 0; y < height; y++) {
            const rowOffset = surfacePtr + y * pitch;
            const rgbaRowOffset = y * width;

            for (let x = 0; x < width; x++) {
                const pixelOffset = rowOffset + x;
                const rgbaIdx = rgbaRowOffset + x;

                if (pixelOffset >= 0 && pixelOffset < mem.length) {
                    const paletteIndex = mem[pixelOffset];

                    // Check if palette index is in colorkey range
                    if (paletteIndex >= idxLow && paletteIndex <= idxHigh) {
                        // Set alpha to 0 (RGBA little-endian: 0xAABBGGRR)
                        rgba32[rgbaIdx] = rgba32[rgbaIdx] & 0x00FFFFFF; // Clear alpha byte
                        transparentCount++;
                    }
                }
            }
        }
    } else {
        // For RGB formats (RGB565, RGB555, ARGB1555, RGB888, etc.)
        // Strategy: Try raw surface pixels first. If surfacePtr has no valid data
        // (common when ReleaseDC uses fast GPU path), fall back to comparing RGBA values.
        // Decode colorkey range to 8-bit RGB (0-255) for RGBA-based comparison.
        // decodeColorKeyToRGBA returns normalized floats [0,1]; multiply by 255 for byte comparison.
        const ckRGBA = decodeColorKeyToRGBA(colorkey.low, pixelFormat);
        const ckR = Math.round(ckRGBA.r * 255), ckG = Math.round(ckRGBA.g * 255), ckB = Math.round(ckRGBA.b * 255);
        let ckHighR = ckR, ckHighG = ckG, ckHighB = ckB;
        if (colorkey.high !== colorkey.low) {
            const ckHighRGBA = decodeColorKeyToRGBA(colorkey.high, pixelFormat);
            ckHighR = Math.round(ckHighRGBA.r * 255); ckHighG = Math.round(ckHighRGBA.g * 255); ckHighB = Math.round(ckHighRGBA.b * 255);
        }

        // Check if raw surface pixels are available (non-zero data in the region)
        let hasRawPixels = false;
        if (surfacePtr > 0 && surfacePtr + bytesPerPixel * 4 < mem.length) {
            // Quick probe: check first few pixels for non-zero data
            for (let i = 0; i < Math.min(16, width * bytesPerPixel); i++) {
                if (mem[surfacePtr + i] !== 0) { hasRawPixels = true; break; }
            }
        }

        for (let y = 0; y < height; y++) {
            const rgbaRowOffset = y * width;

            for (let x = 0; x < width; x++) {
                const rgbaIdx = rgbaRowOffset + x;
                let isMatch = false;

                if (hasRawPixels) {
                    // Primary path: compare raw surface pixel values against colorkey
                    const pixelOffset = surfacePtr + y * pitch + x * bytesPerPixel;
                    if (pixelOffset >= 0 && pixelOffset + bytesPerPixel <= mem.length) {
                        let pixelValue = 0;
                        if (bytesPerPixel === 2) {
                            pixelValue = (mem[pixelOffset] | (mem[pixelOffset + 1] << 8)) >>> 0;
                        } else if (bytesPerPixel === 4) {
                            pixelValue = (mem[pixelOffset] |
                                        (mem[pixelOffset + 1] << 8) |
                                        (mem[pixelOffset + 2] << 16) |
                                        (mem[pixelOffset + 3] << 24)) >>> 0;
                        } else if (bytesPerPixel === 3) {
                            pixelValue = (mem[pixelOffset] |
                                        (mem[pixelOffset + 1] << 8) |
                                        (mem[pixelOffset + 2] << 16)) >>> 0;
                        } else {
                            pixelValue = mem[pixelOffset];
                        }
                        const pixelMasked = (pixelValue & ckMask) >>> 0;
                        isMatch = (pixelMasked >= ckLow && pixelMasked <= ckHigh);
                    }
                } else {
                    // Fallback: compare RGBA values (when raw pixels unavailable, e.g. fast GPU path)
                    const byteIdx = rgbaIdx * 4;
                    const r = rgbaScratch[byteIdx];
                    const g = rgbaScratch[byteIdx + 1];
                    const b = rgbaScratch[byteIdx + 2];
                    isMatch = (r >= ckR && r <= ckHighR &&
                              g >= ckG && g <= ckHighG &&
                              b >= ckB && b <= ckHighB);
                }

                if (isMatch) {
                    rgba32[rgbaIdx] = rgba32[rgbaIdx] & 0x00FFFFFF;
                    transparentCount++;
                }
            }
        }
    }

    if (transparentCount > 0) {
        Logger.verbose(LogCategory.DDRAW,
            `applyColorKeyToRGBA: colorkey 0x${colorkey.low.toString(16)}-0x${colorkey.high.toString(16)} ` +
            `format=${pixelFormat} → ${transparentCount}/${pixelCount} transparent`);
    }

    return result;
}

/**
 * Check if colorkey has changed (for cache invalidation).
 * Handles undefined/null comparisons correctly.
 */
export function colorKeyChanged(
    current: { low: number; high: number } | undefined,
    cached: { low: number; high: number } | undefined
): boolean {
    if (current === cached) return false; // Both undefined or same object
    if (!current && !cached) return false; // Both undefined
    if (!current || !cached) return true; // One undefined, other not
    return current.low !== cached.low || current.high !== cached.high;
}

// ============================================================================
// OPTIMIZED CONVERTERS (format-specific, no per-pixel branching)
// ============================================================================

/** RGB565 → RGBA (internal, used by convertSurfaceToRGBA) */
function convertRGB565ToRGBA(
    src: Uint8Array,
    srcOffset: number,
    srcPitch: number,
    dst: Uint32Array,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeSrcOffset = srcOffset;

    // PERFORMANCE FAST PATH: Use Uint16Array view + batch lookup (5-20× faster than byte-by-byte!)
    const rowBytes = width * 2; // RGB565 is 2 bytes per pixel
    const isPacked = srcPitch === rowBytes;
    const totalPixels = width * height;

    if (skipBoundsCheck && isPacked) {
        // ULTRA FAST PATH: Single Uint16Array view + lookup table
        Logger.verbose(LogCategory.DDRAW,
            `⚡ convertRGB565ToRGBA ULTRA FAST PATH: ${width}x${height} (${(totalPixels*4/1024/1024).toFixed(2)}MB)`
        );
        const src16 = new Uint16Array(src.buffer, src.byteOffset + relativeSrcOffset, totalPixels);
        for (let i = 0; i < totalPixels; i++) {
            dst[i] = RGB565_TO_RGBA[src16[i]];
        }
        return;
    }

    // MEDIUM FAST PATH: Uint16Array per-row (pitch padding)
    if (skipBoundsCheck) {
        Logger.verbose(LogCategory.DDRAW,
            `🐢 convertRGB565ToRGBA MEDIUM PATH (pitch padding): ${width}x${height} pitch=${srcPitch} expected=${rowBytes}`
        );
        for (let y = 0; y < height; y++) {
            const rowOffset = relativeSrcOffset + y * srcPitch;
            const src16Row = new Uint16Array(src.buffer, src.byteOffset + rowOffset, width);
            const dstRowStart = y * width;
            for (let x = 0; x < width; x++) {
                dst[dstRowStart + x] = RGB565_TO_RGBA[src16Row[x]];
            }
        }
        return;
    }

    // SLOW PATH: Bounds-checked byte-by-byte
    Logger.warn(LogCategory.DDRAW,
        `🐌 convertRGB565ToRGBA SLOW PATH (bounds check): ${width}x${height} skipBoundsCheck=${skipBoundsCheck}`
    );
    let dstIdx = 0;
    for (let y = 0; y < height; y++) {
        const rowOffset = relativeSrcOffset + y * srcPitch;
        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + x * 2;
            if (pixelOffset >= 0 && pixelOffset + 1 < src.length) {
                const pixel = src[pixelOffset] | (src[pixelOffset + 1] << 8);
                dst[dstIdx++] = RGB565_TO_RGBA[pixel];
            } else {
                dst[dstIdx++] = 0xFF000000;
            }
        }
    }
}

/** RGB555 → RGBA (internal)
 * Uses RGB555 LUT: XRGB1555 surfaces have undefined bit15, so we mask it off
 * and always produce alpha=255 (fully opaque). ARGB1555 surfaces (with aMask=0x8000)
 * use the separate convertARGB1555ToRGBA path which preserves bit15 as alpha.
 */
function convertRGB555ToRGBA(
    src: Uint8Array,
    srcOffset: number,
    srcPitch: number,
    dst: Uint32Array,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeSrcOffset = srcOffset;
    let dstIdx = 0;

    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            const rowOffset = relativeSrcOffset + y * srcPitch;
            for (let x = 0; x < width; x++) {
                const pixelOffset = rowOffset + x * 2;
                const pixel = src[pixelOffset] | (src[pixelOffset + 1] << 8);
                dst[dstIdx++] = RGB555_TO_RGBA[pixel & 0x7FFF];
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        const rowOffset = relativeSrcOffset + y * srcPitch;
        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + x * 2;
            if (pixelOffset >= 0 && pixelOffset + 1 < src.length) {
                const pixel = src[pixelOffset] | (src[pixelOffset + 1] << 8);
                dst[dstIdx++] = RGB555_TO_RGBA[pixel & 0x7FFF];
            } else {
                dst[dstIdx++] = 0xFF000000;
            }
        }
    }
}

/** ARGB1555 → RGBA (internal) */
function convertARGB1555ToRGBA(
    src: Uint8Array,
    srcOffset: number,
    srcPitch: number,
    dst: Uint32Array,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeSrcOffset = srcOffset;
    let dstIdx = 0;

    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            const rowOffset = relativeSrcOffset + y * srcPitch;
            for (let x = 0; x < width; x++) {
                const pixelOffset = rowOffset + x * 2;
                const pixel = src[pixelOffset] | (src[pixelOffset + 1] << 8);
                dst[dstIdx++] = ARGB1555_TO_RGBA[pixel];
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        const rowOffset = relativeSrcOffset + y * srcPitch;
        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + x * 2;
            if (pixelOffset >= 0 && pixelOffset + 1 < src.length) {
                const pixel = src[pixelOffset] | (src[pixelOffset + 1] << 8);
                dst[dstIdx++] = ARGB1555_TO_RGBA[pixel];
            } else {
                dst[dstIdx++] = 0xFF000000;
            }
        }
    }
}

/** ARGB4444 → RGBA (internal). Alpha nibble drives transparency (fonts: 0 bg / f glyph). */
function convertARGB4444ToRGBA(
    src: Uint8Array,
    srcOffset: number,
    srcPitch: number,
    dst: Uint32Array,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    let dstIdx = 0;
    for (let y = 0; y < height; y++) {
        const rowOffset = srcOffset + y * srcPitch;
        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + x * 2;
            if (skipBoundsCheck || (pixelOffset >= 0 && pixelOffset + 1 < src.length)) {
                dst[dstIdx++] = ARGB4444_TO_RGBA[src[pixelOffset] | (src[pixelOffset + 1] << 8)];
            } else {
                dst[dstIdx++] = 0xFF000000;
            }
        }
    }
}

/** RGB888 → RGBA (internal) */
function convertRGB888ToRGBA(
    src: Uint8Array,
    srcOffset: number,
    srcPitch: number,
    dst: Uint8Array,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeSrcOffset = srcOffset;
    let dstIdx = 0;
    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            let srcIdx = relativeSrcOffset + y * srcPitch;
            for (let x = 0; x < width; x++) {
                // Input Memory: B G R (Little Endian)
                dst[dstIdx++] = src[srcIdx + 2]; // R
                dst[dstIdx++] = src[srcIdx + 1]; // G
                dst[dstIdx++] = src[srcIdx];     // B
                dst[dstIdx++] = 255;             // A
                srcIdx += 3;
            }
        }
        return;
    }
    for (let y = 0; y < height; y++) {
        let srcIdx = relativeSrcOffset + y * srcPitch;
        for (let x = 0; x < width; x++) {
            if (srcIdx >= 0 && srcIdx + 2 < src.length) {
                dst[dstIdx++] = src[srcIdx + 2]; // R
                dst[dstIdx++] = src[srcIdx + 1]; // G
                dst[dstIdx++] = src[srcIdx];     // B
                dst[dstIdx++] = 255;             // A
            } else {
                dst[dstIdx++] = 0;
                dst[dstIdx++] = 0;
                dst[dstIdx++] = 0;
                dst[dstIdx++] = 255;
            }
            srcIdx += 3;
        }
    }
}

/** ARGB8888 → RGBA (internal) */
function convertARGB8888ToRGBA(
    src: Uint8Array,
    srcOffset: number,
    srcPitch: number,
    dst: Uint32Array,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeSrcOffset = srcOffset;

    // PERFORMANCE FAST PATH: If pitch == width*4 (no padding), use Uint32 batch swizzle (10-50× faster!)
    const rowBytes = width * 4;
    const isPacked = srcPitch === rowBytes;
    const totalPixels = width * height;

    if (skipBoundsCheck && isPacked) {
        // ULTRA FAST PATH: Single-pass Uint32 swizzle (BGRA → RGBA)
        // Memory layout: [B, G, R, A] = little-endian 0xAARRGGBB
        // We want RGBA = 0xAABBGGRR (R at LSB)
        const src32 = new Uint32Array(src.buffer, src.byteOffset + relativeSrcOffset, totalPixels);
        for (let i = 0; i < totalPixels; i++) {
            const bgra = src32[i];
            // Swizzle: keep A and G, swap R and B
            // BGRA (0xAARRGGBB) → RGBA (0xAABBGGRR)
            dst[i] = (bgra & 0xFF00FF00) | ((bgra & 0xFF) << 16) | ((bgra >> 16) & 0xFF);
        }
        return;
    }

    // MEDIUM FAST PATH: Uint32 per-row swizzle (pitch padding)
    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            const rowOffset = relativeSrcOffset + y * srcPitch;
            const src32Row = new Uint32Array(src.buffer, src.byteOffset + rowOffset, width);
            const dstRowStart = y * width;
            for (let x = 0; x < width; x++) {
                const bgra = src32Row[x];
                dst[dstRowStart + x] = (bgra & 0xFF00FF00) | ((bgra & 0xFF) << 16) | ((bgra >> 16) & 0xFF);
            }
        }
        return;
    }

    // SLOW PATH: Bounds-checked byte-by-byte
    let dstIdx = 0;
    for (let y = 0; y < height; y++) {
        const rowOffset = relativeSrcOffset + y * srcPitch;
        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + x * 4;
            if (pixelOffset >= 0 && pixelOffset + 3 < src.length) {
                const b = src[pixelOffset];
                const g = src[pixelOffset + 1];
                const r = src[pixelOffset + 2];
                const a = src[pixelOffset + 3];
                dst[dstIdx++] = (a << 24) | (b << 16) | (g << 8) | r;
            } else {
                dst[dstIdx++] = 0xFF000000;
            }
        }
    }
}

/** XRGB8888 → RGBA (internal) */
function convertXRGB8888ToRGBA(
    src: Uint8Array,
    srcOffset: number,
    srcPitch: number,
    dst: Uint32Array,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeSrcOffset = srcOffset;

    // PERFORMANCE FAST PATH: If pitch == width*4 (no padding), use Uint32 batch swizzle (10-50× faster!)
    const rowBytes = width * 4;
    const isPacked = srcPitch === rowBytes;
    const totalPixels = width * height;

    if (skipBoundsCheck && isPacked) {
        // ULTRA FAST PATH: Single-pass Uint32 swizzle (XRGB → RGBA with alpha=0xFF)
        // Memory layout: [B, G, R, X] = little-endian 0xXXRRGGBB
        // We want RGBA = 0xFFBBGGRR (R at LSB, A=0xFF)
        Logger.verbose(LogCategory.DDRAW,
            `⚡ convertXRGB8888ToRGBA ULTRA FAST PATH: ${width}x${height} (${(totalPixels*4/1024/1024).toFixed(2)}MB)`
        );
        const src32 = new Uint32Array(src.buffer, src.byteOffset + relativeSrcOffset, totalPixels);
        for (let i = 0; i < totalPixels; i++) {
            const xrgb = src32[i];
            // Swizzle: set alpha=0xFF, keep G, swap R and B
            // XRGB (0xXXRRGGBB) → RGBA (0xFFBBGGRR)
            dst[i] = 0xFF000000 | ((xrgb & 0x0000FF00)) | ((xrgb & 0xFF) << 16) | ((xrgb >> 16) & 0xFF);
        }
        return;
    }

    // MEDIUM FAST PATH: Uint32 per-row swizzle (pitch padding)
    if (skipBoundsCheck) {
        Logger.log(LogCategory.DDRAW,
            `🐢 convertXRGB8888ToRGBA MEDIUM PATH (pitch padding): ${width}x${height} pitch=${srcPitch} expected=${rowBytes}`
        );
        for (let y = 0; y < height; y++) {
            const rowOffset = relativeSrcOffset + y * srcPitch;
            const src32Row = new Uint32Array(src.buffer, src.byteOffset + rowOffset, width);
            const dstRowStart = y * width;
            for (let x = 0; x < width; x++) {
                const xrgb = src32Row[x];
                dst[dstRowStart + x] = 0xFF000000 | ((xrgb & 0x0000FF00)) | ((xrgb & 0xFF) << 16) | ((xrgb >> 16) & 0xFF);
            }
        }
        return;
    }

    // SLOW PATH: Bounds-checked byte-by-byte
    Logger.warn(LogCategory.DDRAW,
        `🐌 convertXRGB8888ToRGBA SLOW PATH (bounds check): ${width}x${height} skipBoundsCheck=${skipBoundsCheck}`
    );
    let dstIdx = 0;
    for (let y = 0; y < height; y++) {
        const rowOffset = relativeSrcOffset + y * srcPitch;
        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + x * 4;
            if (pixelOffset >= 0 && pixelOffset + 2 < src.length) {
                const b = src[pixelOffset];
                const g = src[pixelOffset + 1];
                const r = src[pixelOffset + 2];
                dst[dstIdx++] = 0xFF000000 | (b << 16) | (g << 8) | r;
            } else {
                dst[dstIdx++] = 0xFF000000;
            }
        }
    }
}

// ============================================================================
// REVERSE CONVERTERS (RGBA → Surface Format)
// ============================================================================

/**
 * Convert RGBA8888 (from GDI canvas) to RGB565 surface
 */
export function convertRGBAToRGB565(
    rgbaData: Uint8ClampedArray,
    dst: Uint8Array,
    dstOffset: number,
    dstPitch: number,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeDstOffset = dstOffset;
    const canUseUint32 = rgbaData.byteOffset % 4 === 0 && rgbaData.length % 4 === 0;
    let rgba32: Uint32Array | null = null;
    
    if (canUseUint32) {
        try {
            rgba32 = new Uint32Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.length / 4);
        } catch (e) {
            rgba32 = null;
        }
    }
    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            let dstIdx = relativeDstOffset + y * dstPitch;
            const srcRowOffset = y * width;
            for (let x = 0; x < width; x++) {
                let r: number, g: number, b: number;
                if (rgba32) {
                    const pixel32 = rgba32[srcRowOffset + x];
                    r = pixel32 & 0xFF;
                    g = (pixel32 >> 8) & 0xFF;
                    b = (pixel32 >> 16) & 0xFF;
                } else {
                    const pixelIdx = (srcRowOffset + x) * 4;
                    r = rgbaData[pixelIdx];
                    g = rgbaData[pixelIdx + 1];
                    b = rgbaData[pixelIdx + 2];
                }
                const pixel = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
                dst[dstIdx++] = pixel & 0xFF;
                dst[dstIdx++] = (pixel >> 8) & 0xFF;
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        const rowOffset = relativeDstOffset + y * dstPitch;
        const srcRowOffset = y * width;
        for (let x = 0; x < width; x++) {
            let r: number, g: number, b: number;
            if (rgba32) {
                const pixel32 = rgba32[srcRowOffset + x];
                r = pixel32 & 0xFF;
                g = (pixel32 >> 8) & 0xFF;
                b = (pixel32 >> 16) & 0xFF;
            } else {
                const pixelIdx = (srcRowOffset + x) * 4;
                r = rgbaData[pixelIdx];
                g = rgbaData[pixelIdx + 1];
                b = rgbaData[pixelIdx + 2];
            }
            const pixel = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
            const writeOffset = rowOffset + x * 2;
            if (writeOffset >= 0 && writeOffset + 1 < dst.length) {
                dst[writeOffset] = pixel & 0xFF;
                dst[writeOffset + 1] = (pixel >> 8) & 0xFF;
            }
        }
    }
}

/**
 * Convert RGBA8888 (from GDI canvas) to RGB555 surface
 */
export function convertRGBAToRGB555(
    rgbaData: Uint8ClampedArray,
    dst: Uint8Array,
    dstOffset: number,
    dstPitch: number,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeDstOffset = dstOffset;
    const canUseUint32 = rgbaData.byteOffset % 4 === 0 && rgbaData.length % 4 === 0;
    let rgba32: Uint32Array | null = null;
    if (canUseUint32) {
        try {
            rgba32 = new Uint32Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.length / 4);
        } catch (e) {
            rgba32 = null;
        }
    }

    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            let dstIdx = relativeDstOffset + y * dstPitch;
            const srcRowOffset = y * width;
            for (let x = 0; x < width; x++) {
                let r: number, g: number, b: number;
                if (rgba32) {
                    const pixel32 = rgba32[srcRowOffset + x];
                    r = pixel32 & 0xFF;
                    g = (pixel32 >> 8) & 0xFF;
                    b = (pixel32 >> 16) & 0xFF;
                } else {
                    const pixelIdx = (srcRowOffset + x) * 4;
                    r = rgbaData[pixelIdx];
                    g = rgbaData[pixelIdx + 1];
                    b = rgbaData[pixelIdx + 2];
                }
                const pixel = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                dst[dstIdx++] = pixel & 0xFF;
                dst[dstIdx++] = (pixel >> 8) & 0xFF;
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        const rowOffset = relativeDstOffset + y * dstPitch;
        const srcRowOffset = y * width;
        for (let x = 0; x < width; x++) {
            let r: number, g: number, b: number;
            if (rgba32) {
                const pixel32 = rgba32[srcRowOffset + x];
                r = pixel32 & 0xFF;
                g = (pixel32 >> 8) & 0xFF;
                b = (pixel32 >> 16) & 0xFF;
            } else {
                const pixelIdx = (srcRowOffset + x) * 4;
                r = rgbaData[pixelIdx];
                g = rgbaData[pixelIdx + 1];
                b = rgbaData[pixelIdx + 2];
            }
            const pixel = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            const writeOffset = rowOffset + x * 2;
            if (writeOffset >= 0 && writeOffset + 1 < dst.length) {
                dst[writeOffset] = pixel & 0xFF;
                dst[writeOffset + 1] = (pixel >> 8) & 0xFF;
            }
        }
    }
}

/**
 * Convert RGBA8888 (from GDI canvas) to ARGB8888 surface (swizzle)
 */
export function convertRGBAToARGB8888(
    rgbaData: Uint8ClampedArray,
    dst: Uint8Array,
    dstOffset: number,
    dstPitch: number,
    width: number,
    height: number,
    skipBoundsCheck: boolean = false
): void {
    const relativeDstOffset = dstOffset;

    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            let dstIdx = relativeDstOffset + y * dstPitch;
            let srcIdx = (y * width) * 4;
            for (let x = 0; x < width; x++) {
                dst[dstIdx] = rgbaData[srcIdx + 2];     // B
                dst[dstIdx + 1] = rgbaData[srcIdx + 1]; // G
                dst[dstIdx + 2] = rgbaData[srcIdx];     // R
                dst[dstIdx + 3] = rgbaData[srcIdx + 3]; // A
                dstIdx += 4;
                srcIdx += 4;
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        const rowOffset = relativeDstOffset + y * dstPitch;
        for (let x = 0; x < width; x++) {
            const srcIdx = (y * width + x) * 4;
            const dstIdx = rowOffset + x * 4;
            if (dstIdx >= 0 && dstIdx + 3 < dst.length) {
                dst[dstIdx] = rgbaData[srcIdx + 2];     // B
                dst[dstIdx + 1] = rgbaData[srcIdx + 1]; // G
                dst[dstIdx + 2] = rgbaData[srcIdx];     // R
                dst[dstIdx + 3] = rgbaData[srcIdx + 3]; // A
            }
        }
    }
}

// ============================================================================
// UNIFIED CONVERTER WITH FORMAT DISPATCH
// ============================================================================

/**
 * Convert surface pixels to RGBA8888 using the optimal method for the format.
 * Returns the RGBA buffer ready for GPU upload.
 * 
 * @param surfacePtr Absolute guest address of the surface memory
 */
export function convertSurfaceToRGBA(
    mem: Uint8Array,
    surfacePtr: number,
    width: number,
    height: number,
    pitch: number,
    format: FormatInfo,
    outBuffer?: Uint8Array,
    colorkey?: { low: number; high: number },
    palette?: Uint32Array
): Uint8Array {
    // Unwrap v86's per-element Proxy to a plain (JIT-fast) view. This is the hottest JS
    // function in the Porsche trace (~26% worker self-time + ~13% in the Proxy `get` trap
    // it drove). All branches below read `mem[i]` per pixel into a separate output buffer;
    // the loops are synchronous (no guest re-entry), so the plain snapshot can't go stale.
    mem = toPlainGuestMemory(mem);

    const pixelCount = width * height;
    const requiredBytes = pixelCount * 4;
    const rgbaBuffer = outBuffer && outBuffer.length >= requiredBytes ? outBuffer : new Uint8Array(requiredBytes);
    const rgba32 = new Uint32Array(rgbaBuffer.buffer, rgbaBuffer.byteOffset, pixelCount);

    const pixelFormat = detectPixelFormat(format);
    const bytesPerPixel = Math.max(1, format.bpp >> 3);
    const relativeSurfacePtr = surfacePtr;
    const lastOffset = relativeSurfacePtr + (height - 1) * pitch + width * bytesPerPixel - 1;
    const inBounds = width > 0 && height > 0 && relativeSurfacePtr >= 0 && lastOffset < mem.length;


    switch (pixelFormat) {
        case PixelFormat.PALETTE8:
            if (palette) {
                for (let y = 0; y < height; y++) {
                    const rowOffset = relativeSurfacePtr + y * pitch;
                    let dstIdx = y * width;
                    for (let x = 0; x < width; x++) {
                        const pixel = mem[rowOffset + x];
                        rgba32[dstIdx++] = palette[pixel];
                    }
                }
            } else {
                rgba32.fill(0xFF000000);
            }
            break;

        case PixelFormat.RGB565:
            convertRGB565ToRGBA(mem, surfacePtr, pitch, rgba32, width, height, inBounds);
            break;

        case PixelFormat.RGB555:
            convertRGB555ToRGBA(mem, surfacePtr, pitch, rgba32, width, height, inBounds);
            break;

        case PixelFormat.ARGB1555:
            convertARGB1555ToRGBA(mem, surfacePtr, pitch, rgba32, width, height, inBounds);
            break;

        case PixelFormat.ARGB4444:
            convertARGB4444ToRGBA(mem, surfacePtr, pitch, rgba32, width, height, inBounds);
            break;

        case PixelFormat.RGB888:
            convertRGB888ToRGBA(mem, surfacePtr, pitch, rgbaBuffer, width, height, inBounds);
            break;

        case PixelFormat.ARGB8888:
            convertARGB8888ToRGBA(mem, surfacePtr, pitch, rgba32, width, height, inBounds);
            break;

        case PixelFormat.XRGB8888:
            convertXRGB8888ToRGBA(mem, surfacePtr, pitch, rgba32, width, height, inBounds);
            break;

        case PixelFormat.LUMINANCE8: {
            for (let y = 0; y < height; y++) {
                const rowOffset = relativeSurfacePtr + y * pitch;
                let dstIdx = y * width;
                for (let x = 0; x < width; x++) {
                    const L = mem[rowOffset + x];
                    rgba32[dstIdx++] = 0xFF000000 | (L << 16) | (L << 8) | L;
                }
            }
            break;
        }

        default:
            convertGenericToRGBA(mem, surfacePtr, pitch, rgbaBuffer, width, height, format, inBounds);
            break;
    }

    if (colorkey) {
        const ckMask = (format.rMask | format.gMask | format.bMask) >>> 0;
        const ckLowM = ((colorkey.low >>> 0) & ckMask) >>> 0;
        const ckHighM = ((colorkey.high >>> 0) & ckMask) >>> 0;
        const bytesPerPixel = Math.max(1, format.bpp >> 3);
        // LEGACY: classic DirectDraw treats black (0x0000) as transparent under any colorkey.

        // Keying clears ALPHA ONLY and preserves RGB — never `= 0`. SetColorKey does not
        // modify a surface's pixels; the key is a per-OPERATION modifier, and every consumer
        // applies it by comparing the SAMPLED COLOUR against the key: the colour-key Blt
        // shader (generateColorKeyBlitShaderCode) and the D3D COLORKEYENABLE path
        // (prepareDraw). Zeroing RGB here overwrites exactly the texels those comparisons
        // need, so the key can never match again and the "transparent" region is blitted as
        // OPAQUE BLACK. It also corrupts guest pixels, because this buffer is cached as
        // rgbaScratch and written BACK through syncToCPUFromScratch.
        // Matches applyColorKeyToRGBA and the compute converter, which already do this.

        // PERF: read the source through a plain typed-array VIEW over the underlying buffer.
        // Guest `mem` is a "bound Uint8Array" whose indexed reads are deoptimized ~50× — the
        // old per-pixel `mem[off]` byte loop here cost ~225ms on an 800×600 colorkeyed surface
        // (the in-game Flip/Blt stall). A Uint16/Uint32 view + one-time bounds check is ~3ms.
        const byteBase = mem.byteOffset + relativeSurfacePtr;
        const lastByte = relativeSurfacePtr + (height - 1) * pitch + width * bytesPerPixel;
        const regionInBounds = relativeSurfacePtr >= 0 && lastByte <= mem.length;

        if (regionInBounds && bytesPerPixel === 2 && (byteBase & 1) === 0 && (pitch & 1) === 0) {
            const src16 = new Uint16Array(mem.buffer, byteBase, (height - 1) * (pitch >> 1) + width);
            const pitch16 = pitch >> 1;
            for (let y = 0; y < height; y++) {
                const ro = y * pitch16;
                const rr = y * width;
                for (let x = 0; x < width; x++) {
                    const pv = src16[ro + x];
                    const pm = pv & ckMask;
                    if ((pm >= ckLowM && pm <= ckHighM) || pv === 0) rgba32[rr + x] &= 0x00FFFFFF;
                }
            }
        } else if (regionInBounds && bytesPerPixel === 4 && (byteBase & 3) === 0 && (pitch & 3) === 0) {
            const src32 = new Uint32Array(mem.buffer, byteBase, (height - 1) * (pitch >> 2) + width);
            const pitch32 = pitch >> 2;
            for (let y = 0; y < height; y++) {
                const ro = y * pitch32;
                const rr = y * width;
                for (let x = 0; x < width; x++) {
                    const pv = src32[ro + x] >>> 0;
                    const pm = (pv & ckMask) >>> 0;
                    if ((pm >= ckLowM && pm <= ckHighM) || pv === 0) rgba32[rr + x] &= 0x00FFFFFF;
                }
            }
        } else {
            // Fallback (unaligned base/pitch, 1bpp, or OOB): per-pixel, bounds-checked.
            // `mem` is already a plain Uint8Array (AddressSpace re-wraps v86's bound array).
            for (let y = 0; y < height; y++) {
                const rowOffset = relativeSurfacePtr + y * pitch;
                const rgbaRowOffset = y * width;
                for (let x = 0; x < width; x++) {
                    const pixelOffset = rowOffset + x * bytesPerPixel;
                    if (pixelOffset < 0 || pixelOffset + bytesPerPixel > mem.length) continue;
                    let pixelValue = 0;
                    if (bytesPerPixel === 2) pixelValue = (mem[pixelOffset] | (mem[pixelOffset + 1] << 8)) >>> 0;
                    else if (bytesPerPixel === 4) pixelValue = (mem[pixelOffset] | (mem[pixelOffset + 1] << 8) | (mem[pixelOffset + 2] << 16) | (mem[pixelOffset + 3] << 24)) >>> 0;
                    else pixelValue = mem[pixelOffset];
                    const pixelM = (pixelValue & ckMask) >>> 0;
                    if ((pixelM >= ckLowM && pixelM <= ckHighM) || pixelValue === 0) rgba32[rgbaRowOffset + x] &= 0x00FFFFFF;
                }
            }
        }
    }

    return rgbaBuffer;
}

/**
 * Convert RGBA8888 pixels back to a DirectDraw surface using the optimal method.
 * 
 * @param surfacePtr Absolute guest address of the surface memory
 */
export function convertRGBAToSurface(
    rgbaData: Uint8ClampedArray,
    mem: Uint8Array,
    surfacePtr: number,
    width: number,
    height: number,
    pitch: number,
    format: FormatInfo,
    options?: { clearAlphaBit?: boolean }
): void {
    // Write leg of convertSurfaceToRGBA — same argument, same fix: every branch below
    // stores `mem[i]` per pixel (2–4 Proxy set-traps per texel), and the loops execute
    // no guest code, so the plain view cannot be invalidated under them.
    mem = toPlainGuestMemory(mem);
    const pixelFormat = detectPixelFormat(format);
    const bytesPerPixel = Math.max(1, Math.floor(format.bpp / 8));
    const totalSize = pitch * height;
    // NOTE: surfacePtr is a guest address that maps directly to mem[] index.
    // Do NOT subtract mem.byteOffset — that writes to the wrong guest address.
    const inBounds = surfacePtr >= 0 && surfacePtr + totalSize <= mem.length;

    // Check if we're about to write into protected region
    if (overlapsThunkCode(surfacePtr, totalSize) || !inBounds) {
        Logger.error(LogCategory.DDRAW,
            `🚨 convertRGBAToSurface: BLOCKED write to protected region! ` +
            `surfacePtr=0x${surfacePtr.toString(16)} size=0x${totalSize.toString(16)} ` +
            `overlapsThunk=${overlapsThunkCode(surfacePtr, totalSize)} inBounds=${inBounds} ` +
            `mem.byteOffset=0x${mem.byteOffset.toString(16)} mem.length=0x${mem.length.toString(16)}`);
        return; // ABORT write to prevent corruption
    }

    switch (pixelFormat) {
        case PixelFormat.RGB565:
            convertRGBAToRGB565(rgbaData, mem, surfacePtr, pitch, width, height, inBounds);
            break;
        case PixelFormat.RGB555:
            convertRGBAToRGB555(rgbaData, mem, surfacePtr, pitch, width, height, inBounds);
            break;
        case PixelFormat.ARGB8888:
        case PixelFormat.XRGB8888:
            convertRGBAToARGB8888(rgbaData, mem, surfacePtr, pitch, width, height, inBounds);
            break;
        default:
            convertGenericRGBAToSurface(rgbaData, mem, surfacePtr, width, height, pitch, format, options?.clearAlphaBit);
            break;
    }
}

function convertGenericRGBAToSurface(
    rgbaData: Uint8ClampedArray,
    mem: Uint8Array,
    surfacePtr: number,
    width: number,
    height: number,
    pitch: number,
    format: FormatInfo,
    clearAlphaBit?: boolean
): void {
    // NOTE: surfacePtr maps directly to mem[] index — no byteOffset adjustment needed.
    // A surface's pixels can be a BORROWED pointer (app-supplied lpSurface), so validate the
    // full extent once here — the per-pixel loop below is the hot path and stays unguarded.
    const span = Math.max(0, (height - 1)) * pitch + width * Math.max(1, format.bpp >> 3);
    if (span > 0 && !isValidAddress(mem, surfacePtr, span, "rw")) {
        Logger.warn(LogCategory.DDRAW,
            `convertGenericRGBAToSurface: refusing 0x${surfacePtr.toString(16)}+0x${span.toString(16)} (${width}x${height} pitch=${pitch})`);
        return;
    }
    const bytesPerPixel = Math.max(1, format.bpp >> 3);

    const getMaskInfo = (mask: number) => {
        if (!mask) return { shift: 0, bits: 0 };
        let shift = 0;
        let bits = 0;
        let value = mask >>> 0;
        while (value && (value & 1) === 0) { value >>>= 1; shift++; }
        while (value & 1) { bits++; value >>>= 1; }
        return { shift, bits };
    };

    const rInfo = getMaskInfo(format.rMask);
    const gInfo = getMaskInfo(format.gMask);
    const bInfo = getMaskInfo(format.bMask);
    const aInfo = getMaskInfo(format.aMask);

    const compress = (val: number, bits: number) => {
        if (!bits) return 0;
        const max = (1 << bits) - 1;
        return (val * max / 255) | 0;
    };

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    for (let y = 0; y < height; y++) {
        const dstRowOffset = surfacePtr + y * pitch;
        for (let x = 0; x < width; x++) {
            const srcIdx = (y * width + x) * 4;
            const r = rgbaData[srcIdx];
            const g = rgbaData[srcIdx + 1];
            const b = rgbaData[srcIdx + 2];
            const a = rgbaData[srcIdx + 3];

            const pixelOffset = dstRowOffset + x * bytesPerPixel;

            if (format.bpp === 16) {
                const p = (compress(r, rInfo.bits) << rInfo.shift) |
                          (compress(g, gInfo.bits) << gInfo.shift) |
                          (compress(b, bInfo.bits) << bInfo.shift) |
                          (aInfo.bits && !clearAlphaBit ? (compress(a, aInfo.bits) << aInfo.shift) : 0);
                view.setUint16(pixelOffset, p, true);
            } else if (format.bpp === 24) {
                mem[pixelOffset] = b;
                mem[pixelOffset + 1] = g;
                mem[pixelOffset + 2] = r;
            } else if (format.bpp === 32) {
                const p = (compress(r, rInfo.bits) << rInfo.shift) |
                          (compress(g, gInfo.bits) << gInfo.shift) |
                          (compress(b, bInfo.bits) << bInfo.shift) |
                          (aInfo.bits && !clearAlphaBit ? (compress(a, aInfo.bits) << aInfo.shift) : 0);
                view.setUint32(pixelOffset, p, true);
            }
        }
    }
}

function convertGenericToRGBA(
    mem: Uint8Array,
    surfacePtr: number,
    pitch: number,
    dst: Uint8Array,
    width: number,
    height: number,
    format: FormatInfo,
    skipBoundsCheck: boolean = false
): void {
    const relativeSurfacePtr = surfacePtr;
    const bpp = format.bpp;
    const bytesPerPixel = Math.max(1, bpp >> 3);

    const rShift = countTrailingZeros(format.rMask);
    const gShift = countTrailingZeros(format.gMask);
    const bShift = countTrailingZeros(format.bMask);
    const aShift = format.aMask ? countTrailingZeros(format.aMask) : 0;

    const rBits = countBits(format.rMask);
    const gBits = countBits(format.gMask);
    const bBits = countBits(format.bMask);
    const aBits = format.aMask ? countBits(format.aMask) : 0;

    const rMax = (1 << rBits) - 1;
    const gMax = (1 << gBits) - 1;
    const bMax = (1 << bBits) - 1;
    const aMax = aBits ? (1 << aBits) - 1 : 0;

    let dstIdx = 0;

    if (skipBoundsCheck) {
        for (let y = 0; y < height; y++) {
            let srcOffset = relativeSurfacePtr + y * pitch;

            for (let x = 0; x < width; x++) {
                let pixel: number;

                if (bpp === 16) {
                    pixel = mem[srcOffset] | (mem[srcOffset + 1] << 8);
                } else if (bpp === 24) {
                    pixel = mem[srcOffset] | (mem[srcOffset + 1] << 8) | (mem[srcOffset + 2] << 16);
                } else {
                    pixel = mem[srcOffset] | (mem[srcOffset + 1] << 8) |
                        (mem[srcOffset + 2] << 16) | (mem[srcOffset + 3] << 24);
                }

                const r = rMax ? Math.round(((pixel >>> rShift) & rMax) * 255 / rMax) : 0;
                const g = gMax ? Math.round(((pixel >>> gShift) & gMax) * 255 / gMax) : 0;
                const b = bMax ? Math.round(((pixel >>> bShift) & bMax) * 255 / bMax) : 0;
                const a = format.aMask === 0 ? 255 : (aMax ? Math.round(((pixel >>> aShift) & aMax) * 255 / aMax) : 255);

                dst[dstIdx++] = r;
                dst[dstIdx++] = g;
                dst[dstIdx++] = b;
                dst[dstIdx++] = a;

                srcOffset += bytesPerPixel;
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        let srcOffset = relativeSurfacePtr + y * pitch;

        for (let x = 0; x < width; x++) {
            if (srcOffset < 0 || srcOffset + bytesPerPixel > mem.length) {
                dst[dstIdx++] = 0; dst[dstIdx++] = 0; dst[dstIdx++] = 0; dst[dstIdx++] = 255;
                srcOffset += bytesPerPixel;
                continue;
            }

            let pixel: number;
            if (bpp === 16) {
                pixel = mem[srcOffset] | (mem[srcOffset + 1] << 8);
            } else if (bpp === 24) {
                pixel = mem[srcOffset] | (mem[srcOffset + 1] << 8) | (mem[srcOffset + 2] << 16);
            } else {
                pixel = mem[srcOffset] | (mem[srcOffset + 1] << 8) |
                    (mem[srcOffset + 2] << 16) | (mem[srcOffset + 3] << 24);
            }

            const r = rMax ? Math.round(((pixel >>> rShift) & rMax) * 255 / rMax) : 0;
            const g = gMax ? Math.round(((pixel >>> gShift) & gMax) * 255 / gMax) : 0;
            const b = bMax ? Math.round(((pixel >>> bShift) & bMax) * 255 / bMax) : 0;
            const a = aMax ? Math.round(((pixel >>> aShift) & aMax) * 255 / aMax) : 255;

            dst[dstIdx++] = r; dst[dstIdx++] = g; dst[dstIdx++] = b; dst[dstIdx++] = a;
            srcOffset += bytesPerPixel;
        }
    }
}

function countTrailingZeros(n: number): number {
    if (n === 0) return 0;
    let count = 0;
    while ((n & 1) === 0) {
        n >>>= 1;
        count++;
    }
    return count;
}

function countBits(n: number): number {
    let count = 0;
    while (n) {
        count += n & 1;
        n >>>= 1;
    }
    return count;
}

// ============================================================================
// WEBGPU UTILITIES
// ============================================================================

export function surfaceFormatOutputsRGBA(format: FormatInfo): boolean {
    // All paths now output RGBA by default
    return true;
}

/**
 * Read a surface's pixels back as tightly-packed RGBA8888, preferring the CPU
 * `rgbaScratch` (zero GPU) and falling back to a `copyTextureToBuffer` readback of
 * its `gpuTexture`. The single readback used by BOTH the DDraw `readSurfaceRGBA`
 * (ptr lookup) and the D3D8 fade-quad probe (surface object in hand) — DirectDraw
 * and D3D8 share the DirectDrawSurfaceState shape, so the pixel readback is one
 * routine, not two. `backend` is any object exposing getDevice/getQueue (the
 * WebGPUBackend); `flush` (optional) drains pending GPU work before the copy.
 */
export async function readSurfaceStateRGBA(
    state: DirectDrawSurfaceState,
    backend: { getDevice(): GPUDevice | null; getQueue(): GPUQueue | null } | null,
    flush?: () => void,
    from: "auto" | "gpu" | "scratch" = "auto",
): Promise<{ w: number; h: number; rgba: Uint8Array; source: string } | { err: string }> {
    const w = state.width, h = state.height;
    if (!(w > 0 && h > 0)) return { err: `bad surface dims ${w}x${h}` };
    const scratch = (state as { rgbaScratch?: Uint8Array }).rgbaScratch;
    // `from` forces which representation is read. The pair is the diagnostic: a surface
    // whose CPU copy is full while the texture we actually sample is blank blits black.
    if (from !== "gpu" && scratch && scratch.length >= w * h * 4) {
        return { w, h, rgba: scratch.slice(0, w * h * 4), source: "scratch" };
    }
    if (from === "scratch") return { err: "no rgbaScratch" };
    if (!state.gpuTexture || !backend) return { err: "no gpuTexture and no rgbaScratch" };
    const device = backend.getDevice();
    const queue = backend.getQueue();
    if (!device || !queue) return { err: "no device/queue" };
    flush?.();
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    device.pushErrorScope("validation");
    const buf = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: state.gpuTexture }, { buffer: buf, bytesPerRow }, { width: w, height: h, depthOrArrayLayers: 1 });
    queue.submit([enc.finish()]);
    const verr = await device.popErrorScope();
    if (verr) { buf.destroy(); return { err: `validation: ${verr.message}` }; }
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const rgba = new Uint8Array(w * h * 4);
    const swizzle = state.gpuTextureFormat === "bgra8unorm";
    for (let y = 0; y < h; y++) {
        const src = y * bytesPerRow;
        const dst = y * w * 4;
        for (let x = 0; x < w; x++) {
            const so = src + x * 4, doff = dst + x * 4;
            if (swizzle) {
                rgba[doff] = padded[so + 2]; rgba[doff + 1] = padded[so + 1]; rgba[doff + 2] = padded[so]; rgba[doff + 3] = padded[so + 3];
            } else {
                rgba[doff] = padded[so]; rgba[doff + 1] = padded[so + 1]; rgba[doff + 2] = padded[so + 2]; rgba[doff + 3] = padded[so + 3];
            }
        }
    }
    buf.unmap();
    buf.destroy();
    return { w, h, rgba, source: "gpu" };
}


/**
 * Quantize color key to match surface format degradation.
 * 
 * Simulates the precision loss that occurs when converting RGBA8888 -> surface format -> RGBA8888.
 * This ensures Color Key in shader exactly matches quantized values from texture after conversion.
 * 
 * Example: RGB565 format loses precision (5-6-5 bits), so a color like (255, 128, 64) becomes
 * (248, 132, 66) after quantization. This function simulates that degradation.
 * 
 * @param color Color in RGBA8888 format (0-255 range)
 * @param format Surface format info (RGB565, ARGB1555, etc.)
 * @returns Quantized color in RGBA8888 format that matches what comes from texture
 */
export function quantizeColorKey(
    color: { r: number; g: number; b: number; a: number },
    format: FormatInfo
): { r: number; g: number; b: number; a: number } {
    // For 32-bit formats, no quantization needed
    if (format.bpp === 32) {
        return { ...color };
    }

    // Convert RGBA8888 -> surface format -> RGBA8888
    // We'll use a temporary buffer to simulate the conversion
    const rgbaInput = new Uint8ClampedArray([color.r, color.g, color.b, color.a]);
    
    // Create a temporary surface buffer (1 pixel)
    // We need to create a buffer that simulates guest memory with proper byteOffset
    const surfaceBytes = Math.max(1, format.bpp >> 3);
    const tempMem = new Uint8Array(surfaceBytes + 8); // Add padding for safety
    // Use offset 4 to simulate a valid guest address (not at 0)
    const surfacePtr = 4;
    
    // Convert RGBA -> surface format
    convertRGBAToSurface(
        rgbaInput,
        tempMem,
        surfacePtr, // Absolute guest address (will be converted to relative inside)
        1, // width
        1, // height
        surfaceBytes, // pitch
        format
    );
    
    // Now convert back: surface format -> RGBA8888
    const rgbaOutput = convertSurfaceToRGBA(
        tempMem,
        surfacePtr, // Absolute guest address
        1, // width
        1, // height
        surfaceBytes, // pitch
        format
    );
    
    return {
        r: rgbaOutput[0],
        g: rgbaOutput[1],
        b: rgbaOutput[2],
        a: rgbaOutput[3],
    };
}

// ============================================================================
// GPU TEXTURE POOL - Reuse textures instead of create/destroy churn
// ============================================================================

const GPU_TEXTURE_POOL_MAX_PER_KEY = 16;

/** Pool of recycled GPU textures keyed by "WxH_format_usage". */
const gpuTexturePool: Map<string, GPUTexture[]> = new Map();

function texturePoolKey(w: number, h: number, format: GPUTextureFormat, usage: GPUTextureUsageFlags): string {
    return `${w}x${h}_${format}_${usage}`;
}

/**
 * Return a GPU texture to the pool for reuse instead of destroying it.
 * Call this instead of texture.destroy() when the surface is released.
 * Returns true if pooled, false if pool is full (caller should destroy).
 */
export function returnGPUTextureToPool(
    texture: GPUTexture,
    width: number,
    height: number,
    format: GPUTextureFormat,
    usage: GPUTextureUsageFlags
): boolean {
    const key = texturePoolKey(width, height, format, usage);
    let pool = gpuTexturePool.get(key);
    if (!pool) {
        pool = [];
        gpuTexturePool.set(key, pool);
    }
    if (pool.length < GPU_TEXTURE_POOL_MAX_PER_KEY) {
        pool.push(texture);
        return true;
    }
    return false;
}

/** Clear the entire GPU texture pool (e.g., on device lost). */
export function clearGPUTexturePool(): void {
    for (const [, pool] of gpuTexturePool) {
        for (const tex of pool) {
            try { tex.destroy(); } catch { /* already destroyed */ }
        }
    }
    gpuTexturePool.clear();
}

export function createGPUTexture(
    device: GPUDevice,
    queue: GPUQueue | null,
    width: number,
    height: number,
    usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    format: GPUTextureFormat = 'rgba8unorm'
): { texture: GPUTexture, view: GPUTextureView } | null {
    try {
        let texture: GPUTexture;

        // Check pool for a recycled texture with matching parameters
        const key = texturePoolKey(width, height, format, usage);
        const pool = gpuTexturePool.get(key);
        if (pool && pool.length > 0) {
            texture = pool.pop()!;
        } else {
            texture = device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format,
                usage,
            });
        }

        const view = texture.createView();

        // Clear texture to prevent stale (recycled) or uninitialized data from being sampled
        if (queue && (usage & GPUTextureUsage.RENDER_ATTACHMENT)) {
            const encoder = device.createCommandEncoder();
            encoder.beginRenderPass({
                colorAttachments: [{
                    view,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                }],
            }).end();
            queue.submit([encoder.finish()]);
        }

        return { texture, view };
    } catch (err) {
        Logger.warn(LogCategory.DDRAW, `createGPUTexture failed: ${err}`);
        return null;
    }
}

/**
 * Upload only a dirty region of texture (partial upload optimization).
 * Used for small updates like cursor (32x32) or small sprite tiles (64x64).
 * Reduces upload data by 98-99% for typical cases.
 */
function uploadPartialRegion(
    queue: GPUQueue,
    texture: GPUTexture,
    rgbaData: Uint8Array,
    fullWidth: number,
    fullHeight: number,
    dirtyRegion: { left: number; top: number; right: number; bottom: number },
    scratch?: Uint8Array,
    format?: GPUTextureFormat
): void {
    const dirtyWidth = dirtyRegion.right - dirtyRegion.left;
    const dirtyHeight = dirtyRegion.bottom - dirtyRegion.top;

    // Clamp to texture bounds
    const x = Math.max(0, Math.min(dirtyRegion.left, fullWidth - 1));
    const y = Math.max(0, Math.min(dirtyRegion.top, fullHeight - 1));
    const w = Math.max(1, Math.min(dirtyWidth, fullWidth - x));
    const h = Math.max(1, Math.min(dirtyHeight, fullHeight - y));

    const textureFormat = format ?? (texture as unknown as { format?: GPUTextureFormat }).format ?? "rgba8unorm";
    const needsSwizzle = textureFormat === "bgra8unorm";

    // Extract dirty rect from full RGBA data
    const dirtyBPR = w * 4;
    const alignedDirtyBPR = (dirtyBPR + 255) & ~255;
    const needsPadding = alignedDirtyBPR !== dirtyBPR && h > 1;
    const dirtySize = needsPadding ? alignedDirtyBPR * h : w * h * 4;

    // Allocate or reuse scratch buffer for dirty region
    const dirtyData = scratch && scratch.length >= dirtySize
        ? new Uint8Array(scratch.buffer, scratch.byteOffset, dirtySize)
        : new Uint8Array(dirtySize);

    // Copy dirty rows from full RGBA data
    const fullBPR = fullWidth * 4;
    for (let row = 0; row < h; row++) {
        const srcOffset = ((y + row) * fullWidth + x) * 4;
        const dstOffset = needsPadding ? row * alignedDirtyBPR : row * dirtyBPR;
        const srcRow = rgbaData.subarray(srcOffset, srcOffset + dirtyBPR);

        if (needsSwizzle) {
            // Swizzle RGBA -> BGRA during copy
            const rgba32 = new Uint32Array(srcRow.buffer, srcRow.byteOffset, w);
            const bgra32 = new Uint32Array(dirtyData.buffer, dirtyData.byteOffset + dstOffset, w);
            for (let i = 0; i < w; i++) {
                const rgba = rgba32[i];
                bgra32[i] = (rgba & 0xFF00FF00) | ((rgba & 0x00FF0000) >> 16) | ((rgba & 0x000000FF) << 16);
            }
        } else {
            dirtyData.set(srcRow, dstOffset);
        }
    }

    const bytesPerRow = needsPadding ? alignedDirtyBPR : dirtyBPR;
    queue.writeTexture(
        { texture, origin: { x, y, z: 0 } },
        dirtyData as GPUAllowSharedBufferSource,
        { bytesPerRow, rowsPerImage: h },
        { width: w, height: h }
    );

    Logger.verbose(LogCategory.DDRAW,
        `Partial upload: rect=({${x},${y}}-{${x + w},${y + h}}) size=${w}×${h} ` +
        `vs full=${fullWidth}×${fullHeight} (${((w * h) / (fullWidth * fullHeight) * 100).toFixed(1)}% of texture)`);
}

/**
 * Upload RGB565 data to GPU texture as r16uint format
 * This avoids CPU conversion - the GPU shader will handle RGB565→RGBA
 *
 * @param queue - GPU queue for upload
 * @param texture - Target r16uint texture
 * @param mem - Guest memory containing RGB565 pixels
 * @param surfacePtr - Pointer to surface data
 * @param width - Surface width
 * @param height - Surface height
 * @param pitch - Surface pitch in bytes
 */
export function uploadRGB565ToGPU(
    queue: GPUQueue,
    texture: GPUTexture,
    mem: Uint8Array,
    surfacePtr: number,
    width: number,
    height: number,
    pitch: number
): void {
    const pixels = width * height;
    const isPacked = pitch === width * 2; // RGB565 is 2 bytes per pixel

    let data: Uint16Array;

    if (isPacked) {
        // Fast path: direct Uint16Array view (zero-copy!)
        data = new Uint16Array(mem.buffer, mem.byteOffset + surfacePtr, pixels);
    } else {
        // Slow path: need to copy row-by-row due to pitch padding
        const temp = new Uint16Array(pixels);
        const src16Base = new Uint16Array(mem.buffer, mem.byteOffset);

        for (let y = 0; y < height; y++) {
            const srcOffset = (surfacePtr + y * pitch) / 2; // Divide by 2 for Uint16 indexing
            const dstOffset = y * width;
            temp.set(src16Base.subarray(srcOffset, srcOffset + width), dstOffset);
        }
        data = temp;
    }

    // Upload RGB565 as-is (no conversion!)
    const bytesPerRow = width * 2; // r16uint = 2 bytes per pixel
    const alignedBPR = (bytesPerRow + 255) & ~255;
    const needsPadding = alignedBPR !== bytesPerRow && height > 1;

    if (needsPadding) {
        // Add row padding for WebGPU alignment
        const padded = new Uint16Array(alignedBPR / 2 * height);
        for (let y = 0; y < height; y++) {
            padded.set(
                data.subarray(y * width, (y + 1) * width),
                y * (alignedBPR / 2)
            );
        }
        queue.writeTexture(
            { texture },
            padded as unknown as GPUAllowSharedBufferSource,
            { bytesPerRow: alignedBPR, rowsPerImage: height },
            { width, height }
        );
    } else {
        queue.writeTexture(
            { texture },
            data as unknown as GPUAllowSharedBufferSource,
            { bytesPerRow, rowsPerImage: height },
            { width, height }
        );
    }

    const sizeKB = (pixels * 2) / 1024;
    Logger.verbose(LogCategory.DDRAW,
        `⚡ uploadRGB565ToGPU: ${width}x${height} (${sizeKB.toFixed(1)}KB) packed=${isPacked} padded=${needsPadding}`
    );
}

/**
 * Create r16uint texture for RGB565 data
 * Used for GPU-based RGB565→RGBA conversion
 */
export function createRGB565Texture(
    device: GPUDevice,
    width: number,
    height: number
): { texture: GPUTexture, view: GPUTextureView } | null {
    try {
        const texture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: 'r16uint',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const view = texture.createView();
        Logger.verbose(LogCategory.DDRAW, `Created r16uint texture: ${width}x${height}`);
        return { texture, view };
    } catch (err) {
        Logger.error(LogCategory.DDRAW, `createRGB565Texture failed: ${err}`);
        return null;
    }
}

export function uploadToGPUTexture(
    queue: GPUQueue,
    texture: GPUTexture,
    rgbaData: Uint8Array,
    width: number,
    height: number,
    scratch?: Uint8Array,
    format?: GPUTextureFormat,
    dirtyRegion?: { left: number; top: number; right: number; bottom: number }
): void {
    // Partial upload optimization for small regions (cursor/sprite tiles)
    if (dirtyRegion) {
        const dirtyWidth = dirtyRegion.right - dirtyRegion.left;
        const dirtyHeight = dirtyRegion.bottom - dirtyRegion.top;
        const fullArea = width * height;
        const dirtyArea = dirtyWidth * dirtyHeight;

        // Use partial upload if dirty region is < 30% of full texture
        if (dirtyArea < fullArea * 0.3 && dirtyWidth > 0 && dirtyHeight > 0) {
            uploadPartialRegion(queue, texture, rgbaData, width, height, dirtyRegion, scratch, format);
            return;
        }
    }

    // Full texture upload (fallback)
    const unpaddedBPR = width * 4;
    const alignedBPR = (unpaddedBPR + 255) & ~255;
    const textureFormat = format ?? (texture as unknown as { format?: GPUTextureFormat }).format ?? "rgba8unorm";
    const needsSwizzle = textureFormat === "bgra8unorm";
    const totalPixels = width * height;
    const needsPadding = alignedBPR !== unpaddedBPR && height > 1;

    // Convert RGBA to BGRA if texture format is bgra8unorm
    let dataToUpload: Uint8Array;
    if (needsSwizzle) {
        // Convert RGBA to BGRA: swap R and B channels
        const swizzledSize = needsPadding ? alignedBPR * height : totalPixels * 4;
        const swizzled = scratch && scratch.length >= swizzledSize
            ? new Uint8Array(scratch.buffer, scratch.byteOffset, swizzledSize)
            : new Uint8Array(swizzledSize);
        
        const rgbaView = new Uint32Array(rgbaData.buffer, rgbaData.byteOffset, totalPixels);
        const bgraView = new Uint32Array(swizzled.buffer, swizzled.byteOffset, swizzledSize / 4);

        if (needsPadding) {
            // Swizzle and pad in one pass using 32-bit words
            const wordsPerRow = width;
            const alignedWordsPerRow = alignedBPR / 4;
            for (let y = 0; y < height; y++) {
                const srcRowStart = y * wordsPerRow;
                const dstRowStart = y * alignedWordsPerRow;
                for (let x = 0; x < width; x++) {
                    const rgba = rgbaView[srcRowStart + x];
                    // RGBA (0xAA_BB_GG_RR) -> BGRA (0xAA_RR_GG_BB) on little-endian
                    // In JS Uint32Array on LE: [R, G, B, A] is 0xAABBGGRR
                    // We need [B, G, R, A] which is 0xAARRGGBB
                    bgraView[dstRowStart + x] = 
                        (rgba & 0xFF00FF00) |          // Keep G and A
                        ((rgba & 0x00FF0000) >> 16) |  // Move B to R position
                        ((rgba & 0x000000FF) << 16);   // Move R to B position
                }
            }
        } else {
            // Fast swizzle without padding
            for (let i = 0; i < totalPixels; i++) {
                const rgba = rgbaView[i];
                bgraView[i] = (rgba & 0xFF00FF00) | ((rgba & 0x00FF0000) >> 16) | ((rgba & 0x000000FF) << 16);
            }
        }
        dataToUpload = swizzled;
    } else if (needsPadding) {
        // Just pad, no swizzle needed
        const requiredBytes = alignedBPR * height;
        const paddedData = scratch && scratch.length === requiredBytes ? scratch : new Uint8Array(requiredBytes);
        for (let y = 0; y < height; y++) {
            paddedData.set(
                rgbaData.subarray(y * unpaddedBPR, (y + 1) * unpaddedBPR),
                y * alignedBPR
            );
        }
        dataToUpload = paddedData;
    } else {
        dataToUpload = rgbaData;
    }

    const bytesPerRow = needsPadding ? alignedBPR : unpaddedBPR;
    queue.writeTexture(
        { texture },
        dataToUpload as GPUAllowSharedBufferSource,
        { bytesPerRow, rowsPerImage: height },
        { width, height }
    );
}

/**
 * Resolve the palette (Uint32Array of 256 RGBA entries) for a palettized surface.
 * Returns undefined if no palette is attached.
 */
/** Default grayscale palette for 8bpp surfaces without an attached palette */
let defaultGrayscalePalette: Uint32Array | undefined;

function getDefaultGrayscalePalette(): Uint32Array {
    if (!defaultGrayscalePalette) {
        defaultGrayscalePalette = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            // 0xAABBGGRR (little-endian RGBA)
            defaultGrayscalePalette[i] = 0xFF000000 | (i << 16) | (i << 8) | i;
        }
    }
    return defaultGrayscalePalette;
}

export function resolvePalette(state: DirectDrawSurfaceState): Uint32Array | undefined {
    if (!state.paletteHandle) {
        // No palette attached — check if format is palettized and needs a fallback
        const isPalettized = state.format.bpp === 8 && (state.format.flags & 0x20);
        if (isPalettized) {
            // Try to find palette from the primary surface (DDraw shares palette across flipping chain)
            try {
                const system = System.getInstance();
                const ddraw = system.process?.getModule("ddraw") as any;
                const primaryAddr = ddraw?.context?.surfaces?.primary;
                if (primaryAddr) {
                    const primaryObj = system.resourceProvider.getComObjectByAddress(primaryAddr);
                    if (primaryObj) {
                        const primaryState = (primaryObj as any).getState?.() as DirectDrawSurfaceState | undefined;
                        if (primaryState?.paletteHandle) {
                            const palObj = system.resourceProvider.getComObject(primaryState.paletteHandle);
                            if (palObj && typeof (palObj as any).getEntries === "function") {
                                return (palObj as any).getEntries() as Uint32Array;
                            }
                        }
                    }
                }
            } catch { /* fallback below */ }
            return getDefaultGrayscalePalette();
        }
        return undefined;
    }
    const system = System.getInstance();
    const obj = system.resourceProvider.getComObject(state.paletteHandle);
    if (!obj || typeof (obj as any).getEntries !== "function") {
        Logger.warn(LogCategory.DDRAW, `resolvePalette: handle=0x${state.paletteHandle.toString(16)} -> obj=${!!obj} hasGetEntries=${obj ? typeof (obj as any).getEntries : 'N/A'}`);
        return state.format.bpp === 8 ? getDefaultGrayscalePalette() : undefined;
    }
    return (obj as any).getEntries() as Uint32Array;
}
