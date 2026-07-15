/**
 * GPU Compute Shader for Texture Format Conversion
 *
 * Converts DirectDraw surface formats (RGB565, RGB555, ARGB1555) to RGBA8.
 * Uses compute shaders for large textures, CPU fallback for small ones.
 */

import { Logger, LogCategory } from "../../../../core/logger";
import { profiler } from "../../../../core/profiler";
import {
    PixelFormat,
    detectPixelFormat,
    FormatInfo,
    RGB565_TO_RGBA,
    RGB555_TO_RGBA,
    ARGB1555_TO_RGBA,
} from "../../../../modules/ddraw/gpu-texture-utils";

// Threshold for using GPU compute vs CPU fallback (in pixels)
const GPU_PIXEL_THRESHOLD = 64 * 64; // 4096 pixels

const KNOWN_NON_LUT_FORMATS: PixelFormat[] = [
    PixelFormat.RGB565,
    PixelFormat.RGB555,
    PixelFormat.ARGB1555,
    PixelFormat.ARGB4444,
    PixelFormat.ARGB8888,
    PixelFormat.XRGB8888,
];
const warnedUnknownFormats = new Set<PixelFormat>();

// Workgroup size for compute shader
const WORKGROUP_SIZE_X = 16;
const WORKGROUP_SIZE_Y = 16;

// ============================================================================
// REVERSE CONVERSION SHADERS (GPU Texture → Surface Format)
// Used for fast GPU→CPU readback with format conversion on GPU
// ============================================================================

/**
 * Generate compute shader for reverse conversion (texture → surface format).
 * Reads from GPU texture, converts to surface format, writes to storage buffer.
 *
 * @param targetFormat Target surface format (RGB565, RGB555, ARGB8888, etc.)
 * @param srcTextureFormat Source texture format (rgba8unorm or bgra8unorm)
 */
function generateReverseConverterShader(targetFormat: PixelFormat, srcTextureFormat: GPUTextureFormat): string {
    let conversionCode: string;
    let bytesPerPixel: number;

    switch (targetFormat) {
        case PixelFormat.RGB565:
            bytesPerPixel = 2;
            conversionCode = `
    // Convert to RGB565: RRRRRGGGGGGBBBBB
    let r5 = u32(r * 31.0 + 0.5);
    let g6 = u32(g * 63.0 + 0.5);
    let b5 = u32(b * 31.0 + 0.5);
    let pixel16 = (r5 << 11u) | (g6 << 5u) | b5;

    // Pack two 16-bit pixels into one 32-bit write for efficiency
    let pixelIdx = gid.y * params.width + gid.x;
    let wordIdx = pixelIdx >> 1u;
    let isOdd = (pixelIdx & 1u) != 0u;

    // Use atomic OR to combine two pixels (avoids race conditions)
    if (isOdd) {
        atomicOr(&outputData[wordIdx], pixel16 << 16u);
    } else {
        atomicOr(&outputData[wordIdx], pixel16);
    }
`;
            break;

        case PixelFormat.RGB555:
            bytesPerPixel = 2;
            conversionCode = `
    // Convert to RGB555: XRRRRRGGGGGBBBBB
    let r5 = u32(r * 31.0 + 0.5);
    let g5 = u32(g * 31.0 + 0.5);
    let b5 = u32(b * 31.0 + 0.5);
    let pixel16 = (r5 << 10u) | (g5 << 5u) | b5;

    let pixelIdx = gid.y * params.width + gid.x;
    let wordIdx = pixelIdx >> 1u;
    let isOdd = (pixelIdx & 1u) != 0u;

    if (isOdd) {
        atomicOr(&outputData[wordIdx], pixel16 << 16u);
    } else {
        atomicOr(&outputData[wordIdx], pixel16);
    }
`;
            break;

        case PixelFormat.ARGB8888:
        case PixelFormat.XRGB8888:
            bytesPerPixel = 4;
            conversionCode = `
    // Convert to ARGB8888/XRGB8888 (BGRA memory layout)
    let r8 = u32(r * 255.0 + 0.5);
    let g8 = u32(g * 255.0 + 0.5);
    let b8 = u32(b * 255.0 + 0.5);
    let a8 = u32(a * 255.0 + 0.5);

    // ARGB8888 in memory is actually BGRA byte order
    let pixel32 = b8 | (g8 << 8u) | (r8 << 16u) | (a8 << 24u);

    let pixelIdx = gid.y * params.width + gid.x;
    outputData[pixelIdx] = pixel32;
`;
            break;

        default:
            // Fallback to ARGB8888
            bytesPerPixel = 4;
            conversionCode = `
    let r8 = u32(r * 255.0 + 0.5);
    let g8 = u32(g * 255.0 + 0.5);
    let b8 = u32(b * 255.0 + 0.5);
    let a8 = u32(a * 255.0 + 0.5);
    let pixel32 = b8 | (g8 << 8u) | (r8 << 16u) | (a8 << 24u);
    let pixelIdx = gid.y * params.width + gid.x;
    outputData[pixelIdx] = pixel32;
`;
            break;
    }

    // For 16-bit formats, use atomic storage buffer
    const storageType = bytesPerPixel === 2 ? "atomic<u32>" : "u32";

    return `
struct Params {
    width: u32,
    height: u32,
    pitch: u32,  // Output pitch in bytes (may include padding)
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outputData: array<${storageType}>;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= params.width || gid.y >= params.height) {
        return;
    }

    // Read from texture (returns vec4f with values in 0-1 range)
    // NOTE: WebGPU textureLoad on bgra8unorm already normalizes to RGBA component order
    // (texel.r=R, texel.g=G, texel.b=B, texel.a=A) regardless of memory layout.
    // No manual swizzle is needed.
    let texel = textureLoad(srcTexture, vec2i(gid.xy), 0);

    let r = texel.r;
    let g = texel.g;
    let b = texel.b;
    let a = texel.a;

    ${conversionCode}
}
`;
}

    /**
     * Generate compute shader for specific pixel format
     * @param textureFormat - Target texture format (rgba8unorm or bgra8unorm)
     */
function generateTextureConverterShader(format: PixelFormat, textureFormat: GPUTextureFormat = "rgba8unorm"): string {
    let conversionCode: string;

    switch (format) {
        case PixelFormat.RGB565:
            conversionCode = `
    // RGB565: RRRRRGGGGGGBBBBB
    let r5 = (pixel >> 11u) & 0x1Fu;
    let g6 = (pixel >> 5u) & 0x3Fu;
    let b5 = pixel & 0x1Fu;

    // Expand 5/6 bits to 8 bits: (val * 255 + max/2) / max
    let r8 = (r5 * 255u + 15u) / 31u;
    let g8 = (g6 * 255u + 31u) / 63u;
    let b8 = (b5 * 255u + 15u) / 31u;
    let a8 = 255u;
`;
            break;

        case PixelFormat.RGB555:
            conversionCode = `
    // RGB555: XRRRRRGGGGGBBBBB
    let r5 = (pixel >> 10u) & 0x1Fu;
    let g5 = (pixel >> 5u) & 0x1Fu;
    let b5 = pixel & 0x1Fu;

    let r8 = (r5 * 255u + 15u) / 31u;
    let g8 = (g5 * 255u + 15u) / 31u;
    let b8 = (b5 * 255u + 15u) / 31u;
    let a8 = 255u;
`;
            break;

        case PixelFormat.ARGB1555:
            conversionCode = `
    // ARGB1555: ARRRRRGGGGGBBBBB
    let a1 = (pixel >> 15u) & 0x1u;
    let r5 = (pixel >> 10u) & 0x1Fu;
    let g5 = (pixel >> 5u) & 0x1Fu;
    let b5 = pixel & 0x1Fu;

    let r8 = (r5 * 255u + 15u) / 31u;
    let g8 = (g5 * 255u + 15u) / 31u;
    let b8 = (b5 * 255u + 15u) / 31u;
    let a8 = select(0u, 255u, a1 != 0u);
`;
            break;

        case PixelFormat.ARGB4444:
            conversionCode = `
    // ARGB4444: AAAARRRRGGGGBBBB — each nibble expanded ×17 (n*255/15)
    let r8 = ((pixel >> 8u) & 0xFu) * 17u;
    let g8 = ((pixel >> 4u) & 0xFu) * 17u;
    let b8 = (pixel & 0xFu) * 17u;
    let a8 = ((pixel >> 12u) & 0xFu) * 17u;
`;
            break;

        case PixelFormat.ARGB8888:
            conversionCode = `
    // ARGB8888: Already 32-bit, just swizzle BGRA -> RGBA
    let b8 = pixel & 0xFFu;
    let g8 = (pixel >> 8u) & 0xFFu;
    let r8 = (pixel >> 16u) & 0xFFu;
    let a8 = (pixel >> 24u) & 0xFFu;
`;
            break;

        case PixelFormat.XRGB8888:
            conversionCode = `
    // XRGB8888: 32-bit, ignore alpha
    let b8 = pixel & 0xFFu;
    let g8 = (pixel >> 8u) & 0xFFu;
    let r8 = (pixel >> 16u) & 0xFFu;
    let a8 = 255u;
`;
            break;

        default:
            // Unrecognized format: output magenta so we notice (black was hiding bugs)
            conversionCode = `
    let r8 = 255u;
    let g8 = 0u;
    let b8 = 255u;
    let a8 = 255u;
`;
    }

    // Determine bytes per pixel based on format
    const bytesPerPixel =
        format === PixelFormat.RGB888
            ? 3
            : format === PixelFormat.ARGB8888 || format === PixelFormat.XRGB8888
            ? 4
            : 2;

    const readPixelCode =
        bytesPerPixel === 2
            ? `
    let byteOffset = srcBase + y * params.srcPitch + x * 2u;
    let byteIdx = byteOffset >> 2u;
    let shift = (byteOffset & 3u) * 8u;

    var pixel: u32;
    if (shift == 0u) {
        pixel = srcData[byteIdx] & 0xFFFFu;
    } else if (shift == 8u) {
        // 16-bit at bytes 1-2: both in same u32
        pixel = (srcData[byteIdx] >> 8u) & 0xFFFFu;
    } else if (shift == 16u) {
        pixel = (srcData[byteIdx] >> 16u) & 0xFFFFu;
    } else {
        // shift==24: 16-bit spans bytes 3 and 4 (two u32s)
        pixel = (srcData[byteIdx] >> 24u) | ((srcData[byteIdx + 1u] & 0xFFu) << 8u);
    }
`
            : bytesPerPixel === 4
            ? `
    let byteOffset = srcBase + y * params.srcPitch + x * 4u;
    let byteIdx = byteOffset >> 2u;
    let shift = (byteOffset & 3u) * 8u;

    var pixel: u32;
    if (shift == 0u) {
        pixel = srcData[byteIdx];
    } else {
        // Spans two u32s or unaligned
        pixel = (srcData[byteIdx] >> shift) | (srcData[byteIdx + 1u] << (32u - shift));
    }
`
            : `
    // 24-bit not yet optimized
    let pixel = 0u;
    let a8 = 255u;
    let r8 = 0u;
    let g8 = 0u;
    let b8 = 0u;
`;

    return `
// Texture format converter compute shader
// Converts surface format to RGBA8

struct Params {
    width: u32,
    height: u32,
    srcPitch: u32,
    dstPitch: u32, // aligned bytes-per-row for WebGPU (256-byte aligned)
    srcOffset: u32,
    colorkeyLow: u32,
    colorkeyHigh: u32,
    hasColorkey: u32,
    colorkeyMask: u32, // RGB mask for colorkey comparison (excludes alpha)
    textureFormat: u32, // 0 = rgba8unorm, 1 = bgra8unorm
    debugMode: u32, // 0 = normal, 1 = format, 2 = raw, 3 = UV grid
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> srcData: array<u32>;
@group(0) @binding(2) var<storage, read_write> dstData: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
    let x = global_id.x;
    let y = global_id.y;

    if (x >= params.width || y >= params.height) {
        return;
    }

    let srcBase = params.srcOffset;
    ${readPixelCode}

    if (params.debugMode != 0u) {
        if (params.debugMode == 1u) {
            // Show format detection: red = 32-bit, green = 16-bit, blue = 8-bit
            let dstRowOffset = y * (params.dstPitch / 4u);
            var debugRgba: u32;
            if (${bytesPerPixel}u == 4u) {
                // 32-bit = red
                debugRgba = 0xFF0000FFu; // RGBA: R=255, G=0, B=0, A=255
            } else if (${bytesPerPixel}u == 2u) {
                // 16-bit = green
                debugRgba = 0xFF00FF00u; // RGBA: R=0, G=255, B=0, A=255
            } else {
                // 8-bit = blue
                debugRgba = 0xFFFF0000u; // RGBA: R=0, G=0, B=255, A=255
            }
            // Output in format matching texture format
            var debugOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r = debugRgba & 0xFFu;
                let g = (debugRgba >> 8u) & 0xFFu;
                let b = (debugRgba >> 16u) & 0xFFu;
                let a = (debugRgba >> 24u) & 0xFFu;
                debugOutput = b | (g << 8u) | (r << 16u) | (a << 24u);
            } else {
                debugOutput = debugRgba;
            }
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = debugOutput;
            return;
        } else if (params.debugMode == 2u) {
            // Show raw data: display raw pixel data without conversion
            var rawRgba: u32;
            if (${bytesPerPixel}u == 4u) {
                // 32-bit: pixel contains BGRA (little-endian u32 read from memory)
                // Convert to logical RGBA for consistency
                let b = pixel & 0xFFu;
                let g = (pixel >> 8u) & 0xFFu;
                let r = (pixel >> 16u) & 0xFFu;
                let a = (pixel >> 24u) & 0xFFu;
                rawRgba = r | (g << 8u) | (b << 16u) | (a << 24u);
            } else {
                // 16-bit or 8-bit: show as grayscale based on raw value
                let val = pixel & 0xFFu; // Just take low byte for grayscale
                rawRgba = val | (val << 8u) | (val << 16u) | 0xFF000000u;
            }
            // Output in format matching texture format
            var rawOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r = rawRgba & 0xFFu;
                let g = (rawRgba >> 8u) & 0xFFu;
                let b = (rawRgba >> 16u) & 0xFFu;
                let a = (rawRgba >> 24u) & 0xFFu;
                rawOutput = b | (g << 8u) | (r << 16u) | (a << 24u);
            } else {
                rawOutput = rawRgba;
            }
            let dstRowOffset = y * (params.dstPitch / 4u);
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = rawOutput;
            return;
        } else if (params.debugMode == 3u) {
            // Show UV Grid: display a pattern based on coordinates
            // This helps verify if UV mapping is correct in the renderer
            let grid = ((x / 16u) + (y / 16u)) % 2u;
            var uvRgba: u32 = select(0xFF333333u, 0xFFCCCCCCu, grid == 0u);
            // Add a red gradient for X and green for Y
            let r = (x * 255u / params.width) & 0xFFu;
            let g = (y * 255u / params.height) & 0xFFu;
            uvRgba = (uvRgba & 0xFF000000u) | r | (g << 8u);
            // Output in format matching texture format
            var uvOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r8 = uvRgba & 0xFFu;
                let g8 = (uvRgba >> 8u) & 0xFFu;
                let b8 = (uvRgba >> 16u) & 0xFFu;
                let a8 = (uvRgba >> 24u) & 0xFFu;
                uvOutput = b8 | (g8 << 8u) | (r8 << 16u) | (a8 << 24u);
            } else {
                uvOutput = uvRgba;
            }
            let dstRowOffset = y * (params.dstPitch / 4u);
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = uvOutput;
            return;
        }
    }

    ${conversionCode}

    // Apply colorkey by setting alpha=0 (preserve RGB for debugging)
    var colorkeyMatch = false;
    if (params.hasColorkey != 0u) {
        let pm = pixel & params.colorkeyMask;
        let ckLowM = params.colorkeyLow & params.colorkeyMask;
        let ckHighM = params.colorkeyHigh & params.colorkeyMask;
        colorkeyMatch = (pm >= ckLowM && pm <= ckHighM);
    }

    // Write pixel data in format matching texture format
    // For rgba8unorm: output RGBA (R in LSB)
    // For bgra8unorm: output BGRA (B in LSB)
    // If colorkey match, set alpha=0 (preserve RGB for debugging)
    let alphaValue = select(a8, 0u, colorkeyMatch);
    var pixelData: u32;
    if (params.textureFormat == 1u) {
        // bgra8unorm: output BGRA (B in LSB)
        pixelData = b8 | (g8 << 8u) | (r8 << 16u) | (alphaValue << 24u);
    } else {
        // rgba8unorm: output RGBA (R in LSB)
        pixelData = r8 | (g8 << 8u) | (b8 << 16u) | (alphaValue << 24u);
    }
    let dstRowOffset = y * (params.dstPitch / 4u);
    let dstIdx = dstRowOffset + x;
    dstData[dstIdx] = pixelData;
}
`;
}

/** LUT format index expression for WGSL (pixel -> idx). */
function lutIdxExpr(format: PixelFormat): string {
    if (format === PixelFormat.RGB555) {
        // XRGB1555: mask off bit15 (undefined), index into 32768-entry RGB555 LUT
        return "pixel & 0x7FFFu";
    }
    // RGB565 and ARGB1555: full 16-bit pixel value as LUT index
    return "pixel";
}

/**
 * Generate LUT-based compute shader for RGB565/RGB555/ARGB1555.
 * Colorkey check before LUT lookup to skip memory read for transparent pixels.
 * @param textureFormat - Target texture format (rgba8unorm or bgra8unorm)
 */
function generateTextureConverterShaderLUT(format: PixelFormat, textureFormat: GPUTextureFormat = "rgba8unorm"): string {
    const idxExpr = lutIdxExpr(format);
    const maxIdx = format === PixelFormat.RGB555 ? 32767 : 65535;
    return `
// Texture converter LUT path - ${format === PixelFormat.RGB565 ? "RGB565" : format === PixelFormat.RGB555 ? "RGB555" : "ARGB1555"}
struct Params {
    width: u32,
    height: u32,
    srcPitch: u32,
    dstPitch: u32, // aligned bytes-per-row for WebGPU (256-byte aligned)
    srcOffset: u32,
    colorkeyLow: u32,
    colorkeyHigh: u32,
    hasColorkey: u32,
    colorkeyMask: u32, // RGB mask for colorkey comparison (excludes alpha)
    textureFormat: u32, // 0 = rgba8unorm, 1 = bgra8unorm
    debugMode: u32, // 0 = normal, 1 = format, 2 = raw, 3 = UV grid
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> srcData: array<u32>;
@group(0) @binding(2) var<storage, read> lutData: array<u32>;
@group(0) @binding(3) var<storage, read_write> dstData: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
    let x = global_id.x;
    let y = global_id.y;

    if (x >= params.width || y >= params.height) {
        return;
    }

    let srcBase = params.srcOffset;
    let byteOffset = srcBase + y * params.srcPitch + x * 2u;
    let byteIdx = byteOffset >> 2u;
    let shift = (byteOffset & 3u) * 8u;

    var pixel: u32;
    if (shift == 0u) {
        pixel = srcData[byteIdx] & 0xFFFFu;
    } else if (shift == 8u) {
        pixel = (srcData[byteIdx] >> 8u) & 0xFFFFu;
    } else if (shift == 16u) {
        pixel = (srcData[byteIdx] >> 16u) & 0xFFFFu;
    } else {
        // shift==24: spans two u32s
        pixel = (srcData[byteIdx] >> 24u) | ((srcData[byteIdx + 1u] & 0xFFu) << 8u);
    }

    // Debug mode: paint pixels based on format detection
    let dstRowOffset = y * (params.dstPitch / 4u);
    if (params.debugMode != 0u) {
        if (params.debugMode == 1u) {
            // Show format detection: 16-bit = green (LUT path is always 16-bit)
            var debugRgba: u32 = 0xFF00FF00u; // RGBA: R=0, G=255, B=0, A=255
            // Output in format matching texture format
            var debugOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r = debugRgba & 0xFFu;
                let g = (debugRgba >> 8u) & 0xFFu;
                let b = (debugRgba >> 16u) & 0xFFu;
                let a = (debugRgba >> 24u) & 0xFFu;
                debugOutput = b | (g << 8u) | (r << 16u) | (a << 24u);
            } else {
                debugOutput = debugRgba;
            }
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = debugOutput;
            return;
        } else if (params.debugMode == 2u) {
            // Show raw data: display raw pixel data (16-bit) as grayscale
            // Show full 16-bit value scaled to 8-bit for better visibility
            let val = (pixel * 255u) / 65535u; // Scale 16-bit to 8-bit
            var rawRgba: u32 = val | (val << 8u) | (val << 16u) | 0xFF000000u;
            // Output in format matching texture format
            var rawOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r = rawRgba & 0xFFu;
                let g = (rawRgba >> 8u) & 0xFFu;
                let b = (rawRgba >> 16u) & 0xFFu;
                let a = (rawRgba >> 24u) & 0xFFu;
                rawOutput = b | (g << 8u) | (r << 16u) | (a << 24u);
            } else {
                rawOutput = rawRgba;
            }
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = rawOutput;
            return;
        } else if (params.debugMode == 3u) {
            // Show UV Grid
            let grid = ((x / 16u) + (y / 16u)) % 2u;
            var uvRgba: u32 = select(0xFF333333u, 0xFFCCCCCCu, grid == 0u);
            let r = (x * 255u / params.width) & 0xFFu;
            let g = (y * 255u / params.height) & 0xFFu;
            uvRgba = (uvRgba & 0xFF000000u) | r | (g << 8u);
            // Output in format matching texture format
            var uvOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r8 = uvRgba & 0xFFu;
                let g8 = (uvRgba >> 8u) & 0xFFu;
                let b8 = (uvRgba >> 16u) & 0xFFu;
                let a8 = (uvRgba >> 24u) & 0xFFu;
                uvOutput = b8 | (g8 << 8u) | (r8 << 16u) | (a8 << 24u);
            } else {
                uvOutput = uvRgba;
            }
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = uvOutput;
            return;
        }
    }

    // Check colorkey match (will set alpha=0 later, preserving RGB)
    var colorkeyMatch = false;
    if (params.hasColorkey != 0u) {
        let pm = pixel & params.colorkeyMask;
        let ckLowM = params.colorkeyLow & params.colorkeyMask;
        let ckHighM = params.colorkeyHigh & params.colorkeyMask;
        colorkeyMatch = (pm >= ckLowM && pm <= ckHighM);
    }

    let idx = ${idxExpr};
    // DIAGNOSTIC: Clamp index to prevent OOB access
    let clampedIdx = min(idx, ${maxIdx}u);
    var rgba = lutData[clampedIdx];
    // LUT format (JS): (a<<24)|(b<<16)|(g<<8)|r => LE bytes [R,G,B,A] = RGBA
    // If colorkey match, override alpha to 0 (preserve RGB for debugging)
    if (colorkeyMatch) {
        rgba = rgba & 0x00FFFFFFu; // Clear alpha byte (bits 24-31)
    }
    // Output in format matching texture format
    var pixelData: u32;
    if (params.textureFormat == 1u) {
        // bgra8unorm: convert RGBA to BGRA
        let r = rgba & 0xFFu;
        let g = (rgba >> 8u) & 0xFFu;
        let b = (rgba >> 16u) & 0xFFu;
        let a = (rgba >> 24u) & 0xFFu;
        pixelData = b | (g << 8u) | (r << 16u) | (a << 24u);
    } else {
        // rgba8unorm: use RGBA as-is
        pixelData = rgba;
    }
    
    let dstIdx = dstRowOffset + x;
    dstData[dstIdx] = pixelData;
}
`;
}

/**
 * GPU Texture Converter
 * Converts DirectDraw surface formats to RGBA8 using compute shaders.
 */
const LUT_RGB565_SIZE = 65536 * 4;
const LUT_RGB555_SIZE = 32768 * 4;
const LUT_ARGB1555_SIZE = 65536 * 4;

export class TextureConverter {
    private device: GPUDevice;
    private queue: GPUQueue;

    // Pipeline cache by format + textureFormat (non-LUT: ARGB8888, XRGB8888)
    private pipelineCache = new Map<string, GPUComputePipeline>();

    // LUT pipeline cache (RGB565, RGB555, ARGB1555)
    private pipelineCacheLUT = new Map<string, GPUComputePipeline>();

    // Reverse conversion pipeline cache (texture → surface format)
    private reversePipelineCache = new Map<string, GPUComputePipeline>();

    // Bind group layout (params, src, dst)
    private bindGroupLayout: GPUBindGroupLayout;

    // LUT bind group layout (params, src, lut, dst)
    private bindGroupLayoutLUT: GPUBindGroupLayout;

    // Reverse conversion bind group layout (params, texture, dst)
    private reverseBindGroupLayout: GPUBindGroupLayout | null = null;

    // GPU LUT buffers (Uint32Array, 0xAABBGGRR)
    private lutRGB565: GPUBuffer;
    private lutRGB555: GPUBuffer;
    private lutARGB1555: GPUBuffer;

    // Buffers to destroy after next queue.submit() (avoid "used in submit while destroyed")
    private pendingDestroyBuffers: GPUBuffer[] = [];

    // Debug mode: 0 = normal, 1 = format, 2 = raw, 3 = UV grid
    private debugMode: number = 0;

    constructor(device: GPUDevice, queue: GPUQueue) {
        this.device = device;
        this.queue = queue;

        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            ],
        });

        this.bindGroupLayoutLUT = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            ],
        });

        this.lutRGB565 = device.createBuffer({
            size: LUT_RGB565_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.lutRGB555 = device.createBuffer({
            size: LUT_RGB555_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.lutARGB1555 = device.createBuffer({
            size: LUT_ARGB1555_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        queue.writeBuffer(this.lutRGB565, 0, RGB565_TO_RGBA);
        queue.writeBuffer(this.lutRGB555, 0, RGB555_TO_RGBA);
        queue.writeBuffer(this.lutARGB1555, 0, ARGB1555_TO_RGBA);
    }

    /**
     * Get or create compute pipeline for format
     */
    private getOrCreatePipeline(format: PixelFormat, textureFormat: GPUTextureFormat): GPUComputePipeline {
        const cacheKey = `${format}_${textureFormat}`;
        let pipeline = this.pipelineCache.get(cacheKey);
        if (pipeline) return pipeline;

        if (!KNOWN_NON_LUT_FORMATS.includes(format) && !warnedUnknownFormats.has(format)) {
            warnedUnknownFormats.add(format);
            Logger.warn(
                LogCategory.DDRAW,
                `TextureConverter: Unrecognized format ${format}; outputting magenta. Check detectPixelFormat / FVF.`
            );
        }

        const shaderCode = generateTextureConverterShader(format, textureFormat);
        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayout],
            }),
            compute: {
                module: shaderModule,
                entryPoint: "main",
            },
        });

        this.pipelineCache.set(cacheKey, pipeline);
        Logger.log(LogCategory.SYSTEM, `TextureConverter: Created pipeline for format ${format} textureFormat ${textureFormat}`);
        return pipeline;
    }

    private getOrCreatePipelineLUT(format: PixelFormat, textureFormat: GPUTextureFormat): GPUComputePipeline {
        const cacheKey = `${format}_${textureFormat}`;
        let pipeline = this.pipelineCacheLUT.get(cacheKey);
        if (pipeline) return pipeline;

        let shaderCode: string;
        if (format === PixelFormat.PALETTE8) {
            shaderCode = `
// Texture converter palette path - 8-bit
struct Params {
    width: u32,
    height: u32,
    srcPitch: u32,
    dstPitch: u32, // aligned bytes-per-row for WebGPU (256-byte aligned)
    srcOffset: u32,
    colorkeyLow: u32,
    colorkeyHigh: u32,
    hasColorkey: u32,
    colorkeyMask: u32,
    textureFormat: u32, // 0 = rgba8unorm, 1 = bgra8unorm
    debugMode: u32, // 0 = normal, 1 = format, 2 = raw, 3 = UV grid
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> srcData: array<u32>;
@group(0) @binding(2) var<storage, read> paletteData: array<u32>;
@group(0) @binding(3) var<storage, read_write> dstData: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
    let x = global_id.x;
    let y = global_id.y;

    if (x >= params.width || y >= params.height) {
        return;
    }

    let srcBase = params.srcOffset;
    let byteOffset = srcBase + y * params.srcPitch + x;
    let byteIdx = byteOffset >> 2u;
    let shift = (byteOffset & 3u) * 8u;

    let pixel = (srcData[byteIdx] >> shift) & 0xFFu;

    let dstRowOffset = y * (params.dstPitch / 4u);
    // Debug mode: paint pixels based on format detection
    if (params.debugMode != 0u) {
        if (params.debugMode == 1u) {
            // Show format detection: 8-bit = blue (palette path is always 8-bit)
            var debugRgba: u32 = 0xFFFF0000u; // RGBA: R=0, G=0, B=255, A=255
            // Output in format matching texture format
            var debugOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r = debugRgba & 0xFFu;
                let g = (debugRgba >> 8u) & 0xFFu;
                let b = (debugRgba >> 16u) & 0xFFu;
                let a = (debugRgba >> 24u) & 0xFFu;
                debugOutput = b | (g << 8u) | (r << 16u) | (a << 24u);
            } else {
                debugOutput = debugRgba;
            }
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = debugOutput;
            return;
        } else if (params.debugMode == 2u) {
            // Show raw data: display raw pixel data (8-bit palette index) as grayscale
            var rawRgba: u32 = pixel | (pixel << 8u) | (pixel << 16u) | 0xFF000000u;
            // Output in format matching texture format
            var rawOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r = rawRgba & 0xFFu;
                let g = (rawRgba >> 8u) & 0xFFu;
                let b = (rawRgba >> 16u) & 0xFFu;
                let a = (rawRgba >> 24u) & 0xFFu;
                rawOutput = b | (g << 8u) | (r << 16u) | (a << 24u);
            } else {
                rawOutput = rawRgba;
            }
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = rawOutput;
            return;
        } else if (params.debugMode == 3u) {
            // Show UV Grid
            let grid = ((x / 16u) + (y / 16u)) % 2u;
            var uvRgba: u32 = select(0xFF333333u, 0xFFCCCCCCu, grid == 0u);
            let r = (x * 255u / params.width) & 0xFFu;
            let g = (y * 255u / params.height) & 0xFFu;
            uvRgba = (uvRgba & 0xFF000000u) | r | (g << 8u);
            // Output in format matching texture format
            var uvOutput: u32;
            if (params.textureFormat == 1u) {
                // bgra8unorm: convert RGBA to BGRA
                let r8 = uvRgba & 0xFFu;
                let g8 = (uvRgba >> 8u) & 0xFFu;
                let b8 = (uvRgba >> 16u) & 0xFFu;
                let a8 = (uvRgba >> 24u) & 0xFFu;
                uvOutput = b8 | (g8 << 8u) | (r8 << 16u) | (a8 << 24u);
            } else {
                uvOutput = uvRgba;
            }
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = uvOutput;
            return;
        }
    }

    if (params.hasColorkey != 0u) {
        let pm = pixel & params.colorkeyMask;
        let ckLowM = params.colorkeyLow & params.colorkeyMask;
        let ckHighM = params.colorkeyHigh & params.colorkeyMask;
        if (pm >= ckLowM && pm <= ckHighM) {
            let dstIdx = dstRowOffset + x;
            dstData[dstIdx] = 0u;
            return;
        }
    }

    // Palette canonical format: RGBA (0xAABBGGRR), same as LUT
    // Output in format matching texture format
    var rgba = paletteData[pixel];
    var pixelData: u32;
    if (params.textureFormat == 1u) {
        // bgra8unorm: convert RGBA to BGRA
        let r = rgba & 0xFFu;
        let g = (rgba >> 8u) & 0xFFu;
        let b = (rgba >> 16u) & 0xFFu;
        let a = (rgba >> 24u) & 0xFFu;
        pixelData = b | (g << 8u) | (r << 16u) | (a << 24u);
    } else {
        // rgba8unorm: use RGBA as-is
        pixelData = rgba;
    }
    let dstIdx = dstRowOffset + x;
    dstData[dstIdx] = pixelData;
}
`;
        } else {
            shaderCode = generateTextureConverterShaderLUT(format, textureFormat);
        }
        
        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayoutLUT],
            }),
            compute: { module: shaderModule, entryPoint: "main" },
        });

        this.pipelineCacheLUT.set(cacheKey, pipeline);
        Logger.log(LogCategory.SYSTEM, `TextureConverter: Created LUT pipeline for format ${format} textureFormat ${textureFormat}`);
        return pipeline;
    }

    private getLUTBuffer(format: PixelFormat): GPUBuffer {
        switch (format) {
            case PixelFormat.RGB565:
                return this.lutRGB565;
            case PixelFormat.RGB555:
                return this.lutRGB555;
            case PixelFormat.ARGB1555:
                return this.lutARGB1555;
            default:
                return this.lutRGB565;
        }
    }

    private getLUTBufferSize(format: PixelFormat): number {
        switch (format) {
            case PixelFormat.RGB565:
                return LUT_RGB565_SIZE;
            case PixelFormat.RGB555:
                return LUT_RGB555_SIZE;
            case PixelFormat.ARGB1555:
                return LUT_ARGB1555_SIZE;
            default:
                return LUT_RGB565_SIZE;
        }
    }

    /**
     * Convert texture directly to GPUTexture using GPU compute shader.
     * Zero-copy path: compute -> buffer -> texture (no CPU round-trip).
     *
     * @param encoder Command encoder (can be reused for batching)
     * @param memory Source memory
     * @param srcAddr Source address in memory
     * @param width Texture width
     * @param height Texture height
     * @param pitch Source pitch
     * @param format Pixel format
     * @param texture Destination GPU texture
     * @param colorkey Optional color key
     * @param textureFormat Optional texture format (defaults to rgba8unorm)
     */
    convertToTexture(
        encoder: GPUCommandEncoder,
        memory: Uint8Array,
        srcAddr: number,
        width: number,
        height: number,
        pitch: number,
        format: FormatInfo,
        texture: GPUTexture,
        colorkey?: { low: number; high: number },
        textureFormat: GPUTextureFormat = "rgba8unorm",
        palette?: Uint32Array
    ): void {
        profiler.start("TextureConverter.convertToTexture");

        const pixelFormat = detectPixelFormat(format);

        // srcAddr is x86 address which maps directly to memory[srcAddr] = buffer[byteOffset + srcAddr]
        const srcRelOffset = srcAddr;
        const srcSize = pitch * height;

        if (pixelFormat === PixelFormat.UNKNOWN || pixelFormat === PixelFormat.RGB888) {
            // Fall back to CPU for unsupported formats
            profiler.end("TextureConverter.convertToTexture");
            const rgba = this.convertCPU(memory, srcAddr, width, height, pitch, format, colorkey, undefined, textureFormat, palette);
            const unpaddedBPR = width * 4;
            const alignedBPR = (unpaddedBPR + 255) & ~255;
            if (alignedBPR === unpaddedBPR || height === 1) {
                this.queue.writeTexture(
                    { texture },
                    rgba as GPUAllowSharedBufferSource,
                    { bytesPerRow: unpaddedBPR, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: 1 }
                );
            } else {
                const paddedSize = alignedBPR * height;
                const padded = new Uint8Array(paddedSize);
                for (let y = 0; y < height; y++) {
                    padded.set(
                        rgba.subarray(y * unpaddedBPR, (y + 1) * unpaddedBPR),
                        y * alignedBPR
                    );
                }
                this.queue.writeTexture(
                    { texture },
                    padded as GPUAllowSharedBufferSource,
                    { bytesPerRow: alignedBPR, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: 1 }
                );
            }
            return;
        }

        // GPU path: per-call temp buffers to avoid writeBuffer/dispatch race (plan: texture_sync_race_fix).
        // 256-byte aligned dst pitch so copyBufferToTexture always succeeds.
        const unpaddedBPR = width * 4;
        const alignedBPR = (unpaddedBPR + 255) & ~255;
        const dstSize = alignedBPR * height;
        // +8 bytes padding so "spans two u32s" read never OOB (srcData[byteIdx + 1u])
        const srcBindSize = (srcSize + 8 + 3) & ~3;

        // Validation: srcAddr should be within memory bounds (no offset subtraction needed)
        if (srcAddr < 0 || srcAddr + srcSize > memory.length) {
            Logger.error(LogCategory.DDRAW, `convertToTexture: Invalid srcAddr=0x${srcAddr.toString(16)}, memory.length=${memory.length}, srcSize=${srcSize}`);
            profiler.end("TextureConverter.convertToTexture");
            return;
        }

        // Create temp buffers per call (bind group per call); correct usage flags.
        const tempSrc = this.device.createBuffer({
            size: srcBindSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        const tempParams = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
        });
        const tempDst = this.device.createBuffer({
            size: dstSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Upload source data; zero tail so unaligned reads never OOB
        // srcRelOffset is just srcAddr (x86 address maps directly to memory index)
        if (srcRelOffset < 0 || srcRelOffset + srcSize > memory.length) {
            Logger.error(LogCategory.DDRAW, `convertToTexture: Invalid srcAddr=0x${srcAddr.toString(16)}, memory.length=${memory.length}, srcSize=${srcSize}`);
            profiler.end("TextureConverter.convertToTexture");
            return;
        }
        this.queue.writeBuffer(tempSrc, 0, memory.buffer, memory.byteOffset + srcRelOffset, srcSize);
        this.queue.writeBuffer(tempSrc, srcSize, new Uint8Array(8), 0, 8);

        const textureFormatFlag = textureFormat === "bgra8unorm" ? 1 : 0;
        const ckMask = colorkey 
            ? (pixelFormat === PixelFormat.PALETTE8 
                ? 0xFF 
                : ((format.rMask | format.gMask | format.bMask) >>> 0))
            : 0;
        const paramsData = new Uint32Array([
            width,
            height,
            pitch,
            alignedBPR,
            0,
            colorkey?.low ?? 0,
            colorkey?.high ?? 0,
            colorkey ? 1 : 0,
            ckMask, // colorkeyMask
            textureFormatFlag,
            this.debugMode,
        ]);
        this.queue.writeBuffer(tempParams, 0, paramsData);

        const useLUT =
            pixelFormat === PixelFormat.RGB565 ||
            pixelFormat === PixelFormat.RGB555 ||
            pixelFormat === PixelFormat.ARGB1555 ||
            pixelFormat === PixelFormat.PALETTE8;

        let bindGroup: GPUBindGroup;
        let pipeline: GPUComputePipeline;
        let tempPalette: GPUBuffer | null = null;

        if (useLUT) {
            pipeline = this.getOrCreatePipelineLUT(pixelFormat, textureFormat);
            let lutBuffer: GPUBuffer;
            let lutSize: number;
            if (pixelFormat === PixelFormat.PALETTE8) {
                tempPalette = this.device.createBuffer({
                    size: 1024,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
                });
                if (palette) {
                    this.queue.writeBuffer(tempPalette, 0, palette as unknown as GPUAllowSharedBufferSource);
                } else {
                    const black = new Uint32Array(256).fill(0xff000000);
                    this.queue.writeBuffer(tempPalette, 0, black as unknown as GPUAllowSharedBufferSource);
                }
                lutBuffer = tempPalette;
                lutSize = 1024;
            } else {
                lutBuffer = this.getLUTBuffer(pixelFormat);
                lutSize = this.getLUTBufferSize(pixelFormat);
            }
            bindGroup = this.device.createBindGroup({
                layout: this.bindGroupLayoutLUT,
                entries: [
                    { binding: 0, resource: { buffer: tempParams } },
                    { binding: 1, resource: { buffer: tempSrc, size: srcBindSize } },
                    { binding: 2, resource: { buffer: lutBuffer, size: lutSize } },
                    { binding: 3, resource: { buffer: tempDst, size: dstSize } },
                ],
            });
        } else {
            pipeline = this.getOrCreatePipeline(pixelFormat, textureFormat);
            bindGroup = this.device.createBindGroup({
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: tempParams } },
                    { binding: 1, resource: { buffer: tempSrc, size: srcBindSize } },
                    { binding: 2, resource: { buffer: tempDst, size: dstSize } },
                ],
            });
        }

        const workgroupsX = Math.ceil(width / WORKGROUP_SIZE_X);
        const workgroupsY = Math.ceil(height / WORKGROUP_SIZE_Y);
        Logger.verbose(LogCategory.DDRAW,
            `TextureConverter: Dispatching compute shader for format ${pixelFormat} ` +
            `size=${width}x${height} workgroups=${workgroupsX}x${workgroupsY} ` +
            `useLUT=${useLUT} textureFormat=${textureFormat}`
        );
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(workgroupsX, workgroupsY);
        pass.end();

        encoder.copyBufferToTexture(
            { buffer: tempDst, bytesPerRow: alignedBPR, rowsPerImage: height },
            { texture },
            { width, height, depthOrArrayLayers: 1 }
        );

        // Update frame snapshot counters
        const system = (globalThis as any).System?.getInstance?.();
        const ddraw = system?.process?.getModule("ddraw") as any;
        if (ddraw?.incrementFrameCounter) {
            ddraw.incrementFrameCounter("uploads");
            ddraw.incrementFrameCounter("textureBytes", dstSize);
        }

        // Lifecycle invariant: push to pendingDestroy only after commands are recorded.
        this.pendingDestroyBuffers.push(tempSrc, tempParams, tempDst);
        if (tempPalette) this.pendingDestroyBuffers.push(tempPalette);

        profiler.end("TextureConverter.convertToTexture");
    }

    /**
     * Convert texture using GPU compute shader (legacy method with readback).
     * DEPRECATED: Use convertToTexture for better performance.
     */
    async convertGPU(
        memory: Uint8Array,
        srcAddr: number,
        width: number,
        height: number,
        pitch: number,
        format: FormatInfo,
        colorkey?: { low: number; high: number }
    ): Promise<Uint8Array> {
        // Fallback to CPU for legacy API
        return this.convertCPU(memory, srcAddr, width, height, pitch, format, colorkey);
    }

    /**
     * Convert texture using CPU with LUT (fallback for small textures).
     * OPTIMIZED: Uses Uint16Array for aligned reads, merged colorkey loop.
     * @param textureFormat - Target texture format (rgba8unorm or bgra8unorm)
     */
    convertCPU(
        memory: Uint8Array,
        srcAddr: number,
        width: number,
        height: number,
        pitch: number,
        format: FormatInfo,
        colorkey?: { low: number; high: number },
        outBuffer?: Uint8Array,
        textureFormat: GPUTextureFormat = "rgba8unorm",
        palette?: Uint32Array
    ): Uint8Array {
        profiler.start("TextureConverter.convertCPU");

        const pixelFormat = detectPixelFormat(format);
        const dstSize = width * height * 4;
        const result = outBuffer && outBuffer.length >= dstSize ? outBuffer : new Uint8Array(dstSize);
        const dst32 = new Uint32Array(result.buffer, result.byteOffset, width * height);

        const bytesPerPixel = Math.max(1, format.bpp >> 3);
        const hasColorkey = colorkey !== undefined;
        const ckMask = (format.rMask | format.gMask | format.bMask) >>> 0;
        const ckLow = colorkey?.low ?? 0;
        const ckHigh = colorkey?.high ?? 0;
        const ckLowM = (ckLow & ckMask) >>> 0;
        const ckHighM = (ckHigh & ckMask) >>> 0;

        // Helper function to convert RGBA to target format
        const convertToFormat = (rgba: number): number => {
            if (textureFormat === "bgra8unorm") {
                // Convert RGBA to BGRA: swap R and B
                const r = rgba & 0xff;
                const g = (rgba >> 8) & 0xff;
                const b = (rgba >> 16) & 0xff;
                const a = (rgba >> 24) & 0xff;
                return (a << 24) | (r << 16) | (g << 8) | b;
            } else {
                // rgba8unorm: use as-is
                return rgba;
            }
        };

        // Check if source is 4-byte aligned (common case for D3D7)
        const isAligned = (srcAddr % 4 === 0) && (pitch % 4 === 0);

        switch (pixelFormat) {
            case PixelFormat.PALETTE8: {
                if (palette) {
                    for (let y = 0; y < height; y++) {
                        const rowOffset = srcAddr + y * pitch;
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixel = memory[rowOffset + x];
                            if (hasColorkey && pixel >= ckLow && pixel <= ckHigh) {
                                dst32[dstIdx++] = 0;
                            } else {
                                dst32[dstIdx++] = convertToFormat(palette[pixel]);
                            }
                        }
                    }
                } else {
                    const black = convertToFormat(0xFF000000);
                    dst32.fill(black);
                }
                break;
            }

            case PixelFormat.RGB565: {
                const LUT = RGB565_TO_RGBA;
                if (isAligned && bytesPerPixel === 2) {
                    // Fast path: aligned 16-bit reads
                    for (let y = 0; y < height; y++) {
                        const rowBase = srcAddr + y * pitch;
                        const src16 = new Uint16Array(memory.buffer, memory.byteOffset + rowBase, width);
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixel = src16[x];
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            dst32[dstIdx++] = convertToFormat(LUT[pixel]);
                        }
                    }
                } else {
                    // Slow path: unaligned or non-standard pitch
                    for (let y = 0; y < height; y++) {
                        const rowOffset = srcAddr + y * pitch;
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixelOffset = rowOffset + x * 2;
                            const pixel = memory[pixelOffset] | (memory[pixelOffset + 1] << 8);
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            dst32[dstIdx++] = convertToFormat(LUT[pixel]);
                        }
                    }
                }
                break;
            }

            case PixelFormat.RGB555: {
                // XRGB1555: mask off bit15 (undefined) and use RGB555 LUT (alpha=255).
                // ARGB1555 surfaces use the separate case below which preserves bit15 as alpha.
                const LUT = RGB555_TO_RGBA;
                if (isAligned && bytesPerPixel === 2) {
                    // Fast path: aligned 16-bit reads
                    for (let y = 0; y < height; y++) {
                        const rowBase = srcAddr + y * pitch;
                        const src16 = new Uint16Array(memory.buffer, memory.byteOffset + rowBase, width);
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixel = src16[x] & 0x7FFF;
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            dst32[dstIdx++] = convertToFormat(LUT[pixel]);
                        }
                    }
                } else {
                    // Slow path: unaligned
                    for (let y = 0; y < height; y++) {
                        const rowOffset = srcAddr + y * pitch;
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixelOffset = rowOffset + x * 2;
                            const pixel = (memory[pixelOffset] | (memory[pixelOffset + 1] << 8)) & 0x7FFF;
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            dst32[dstIdx++] = convertToFormat(LUT[pixel]);
                        }
                    }
                }
                break;
            }

            case PixelFormat.ARGB1555: {
                const LUT = ARGB1555_TO_RGBA;
                if (isAligned && bytesPerPixel === 2) {
                    // Fast path: aligned 16-bit reads
                    for (let y = 0; y < height; y++) {
                        const rowBase = srcAddr + y * pitch;
                        const src16 = new Uint16Array(memory.buffer, memory.byteOffset + rowBase, width);
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixel = src16[x];
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            dst32[dstIdx++] = convertToFormat(LUT[pixel]);
                        }
                    }
                } else {
                    // Slow path: unaligned
                    for (let y = 0; y < height; y++) {
                        const rowOffset = srcAddr + y * pitch;
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixelOffset = rowOffset + x * 2;
                            const pixel = memory[pixelOffset] | (memory[pixelOffset + 1] << 8);
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            dst32[dstIdx++] = convertToFormat(LUT[pixel]);
                        }
                    }
                }
                break;
            }

            case PixelFormat.ARGB8888:
            case PixelFormat.XRGB8888: {
                if (isAligned && bytesPerPixel === 4) {
                    // Fast path: aligned 32-bit reads
                    for (let y = 0; y < height; y++) {
                        const rowBase = srcAddr + y * pitch;
                        const src32 = new Uint32Array(memory.buffer, memory.byteOffset + rowBase, width);
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixel = src32[x];
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            const b = pixel & 0xff;
                            const g = (pixel >> 8) & 0xff;
                            const r = (pixel >> 16) & 0xff;
                            const a = (pixelFormat === PixelFormat.XRGB8888 || format.aMask === 0) 
                                ? 0xff 
                                : (pixel >> 24) & 0xff;
                            const rgba = (a << 24) | (b << 16) | (g << 8) | r;
                            dst32[dstIdx++] = convertToFormat(rgba);
                        }
                    }
                } else {
                    // Slow path: unaligned
                    for (let y = 0; y < height; y++) {
                        const rowOffset = srcAddr + y * pitch;
                        let dstIdx = y * width;
                        for (let x = 0; x < width; x++) {
                            const pixelOffset = rowOffset + x * 4;
                            const pixel =
                                memory[pixelOffset] |
                                (memory[pixelOffset + 1] << 8) |
                                (memory[pixelOffset + 2] << 16) |
                                (memory[pixelOffset + 3] << 24);
                            if (hasColorkey) {
                                const pixelM = (pixel & ckMask) >>> 0;
                                if (pixelM >= ckLowM && pixelM <= ckHighM) {
                                    dst32[dstIdx++] = 0;
                                    continue;
                                }
                            }
                            const b = pixel & 0xff;
                            const g = (pixel >> 8) & 0xff;
                            const r = (pixel >> 16) & 0xff;
                            const a = (pixelFormat === PixelFormat.XRGB8888 || format.aMask === 0) 
                                ? 0xff 
                                : (pixel >> 24) & 0xff;
                            const rgba = (a << 24) | (b << 16) | (g << 8) | r;
                            dst32[dstIdx++] = convertToFormat(rgba);
                        }
                    }
                }
                break;
            }

            default:
                // Generic fallback
                const black = convertToFormat(0xff000000);
                for (let y = 0; y < height; y++) {
                    let dstIdx = y * width;
                    for (let x = 0; x < width; x++) {
                        dst32[dstIdx++] = black;
                    }
                }
                break;
        }

        profiler.end("TextureConverter.convertCPU");
        
        // Update frame snapshot counters
        const system = (globalThis as any).System?.getInstance?.();
        const ddraw = system?.process?.getModule("ddraw") as any;
        if (ddraw?.incrementFrameCounter) {
            ddraw.incrementFrameCounter("textureBytes", dstSize);
        }

        return result;
    }

    /**
     * Convert texture using optimal method.
     */
    async convert(
        memory: Uint8Array,
        srcAddr: number,
        width: number,
        height: number,
        pitch: number,
        format: FormatInfo,
        colorkey?: { low: number; high: number },
        outBuffer?: Uint8Array,
        palette?: Uint32Array
    ): Promise<Uint8Array> {
        const pixelCount = width * height;

        if (pixelCount < GPU_PIXEL_THRESHOLD) {
            return this.convertCPU(memory, srcAddr, width, height, pitch, format, colorkey, outBuffer, "rgba8unorm", palette);
        }
        return this.convertGPU(memory, srcAddr, width, height, pitch, format, colorkey);
    }

    /**
     * Synchronous convert using CPU only
     */
    convertSync(
        memory: Uint8Array,
        srcAddr: number,
        width: number,
        height: number,
        pitch: number,
        format: FormatInfo,
        colorkey?: { low: number; high: number },
        outBuffer?: Uint8Array,
        textureFormat: GPUTextureFormat = "rgba8unorm",
        palette?: Uint32Array
    ): Uint8Array {
        return this.convertCPU(memory, srcAddr, width, height, pitch, format, colorkey, outBuffer, textureFormat, palette);
    }

    /**
     * Set debug mode for texture conversion
     * @param debugMode 0 = normal, 1 = format (red=32b, green=16b, blue=8b), 2 = raw, 3 = UV grid
     */
    setDebugMode(debugMode: number): void {
        this.debugMode = debugMode;
        // Clear pipeline cache when debug mode changes, as it affects shader generation
        this.pipelineCache.clear();
        this.pipelineCacheLUT.clear();
    }

    // ========================================================================
    // REVERSE CONVERSION: GPU Texture → Surface Format (for fast readback)
    // ========================================================================

    /**
     * Get or create reverse conversion bind group layout (lazy init)
     */
    private getReverseBindGroupLayout(): GPUBindGroupLayout {
        if (!this.reverseBindGroupLayout) {
            this.reverseBindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    // binding 0: params uniform
                    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                    // binding 1: source texture
                    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                    // binding 2: output storage buffer
                    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                ],
            });
        }
        return this.reverseBindGroupLayout;
    }

    /**
     * Get or create reverse conversion pipeline
     */
    private getOrCreateReversePipeline(
        targetFormat: PixelFormat,
        srcTextureFormat: GPUTextureFormat
    ): GPUComputePipeline {
        const cacheKey = `rev_${targetFormat}_${srcTextureFormat}`;
        let pipeline = this.reversePipelineCache.get(cacheKey);
        if (pipeline) return pipeline;

        const shaderCode = generateReverseConverterShader(targetFormat, srcTextureFormat);
        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.getReverseBindGroupLayout()],
            }),
            compute: {
                module: shaderModule,
                entryPoint: "main",
            },
        });

        this.reversePipelineCache.set(cacheKey, pipeline);
        Logger.log(LogCategory.SYSTEM,
            `TextureConverter: Created reverse pipeline for ${targetFormat} from ${srcTextureFormat}`);
        return pipeline;
    }

    /**
     * Convert GPU texture to surface format using compute shader.
     * This is MUCH faster than CPU conversion for readback operations.
     *
     * Flow:
     * 1. GPU compute shader reads texture, converts to target format, writes to buffer
     * 2. Copy buffer to staging buffer (MAP_READ)
     * 3. Map staging buffer and copy to CPU memory
     *
     * @param texture Source GPU texture
     * @param textureFormat Format of the source texture (rgba8unorm or bgra8unorm)
     * @param targetFormat Target surface pixel format
     * @param width Texture width
     * @param height Texture height
     * @param pitch Output pitch in bytes (must be >= width * bytesPerPixel)
     * @returns Uint8Array with converted pixel data, or null on failure
     */
    async convertFromTexture(
        texture: GPUTexture,
        textureFormat: GPUTextureFormat,
        targetFormat: PixelFormat,
        width: number,
        height: number,
        pitch: number
    ): Promise<Uint8Array | null> {
        profiler.start("TextureConverter.convertFromTexture");

        try {
            const bytesPerPixel = targetFormat === PixelFormat.RGB565 || targetFormat === PixelFormat.RGB555
                ? 2
                : 4;

            // For 16-bit formats, we write 32-bit words (2 pixels per word)
            // Buffer size needs to account for this
            const pixelCount = width * height;
            const wordCount = targetFormat === PixelFormat.RGB565 || targetFormat === PixelFormat.RGB555
                ? Math.ceil(pixelCount / 2)
                : pixelCount;
            const outputBufferSize = wordCount * 4; // Always 32-bit words

            // Create output storage buffer
            const outputBuffer = this.device.createBuffer({
                size: outputBufferSize,
                // COPY_DST required because we zero-init via queue.writeBuffer for 16-bit atomics
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });

            // For 16-bit atomic writes, we need to zero-initialize the buffer
            if (bytesPerPixel === 2) {
                const zeros = new Uint32Array(wordCount);
                this.queue.writeBuffer(outputBuffer, 0, zeros);
            }

            // Create params uniform buffer
            const paramsBuffer = this.device.createBuffer({
                size: 16, // 4 x u32
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            const paramsData = new Uint32Array([width, height, pitch, 0]);
            this.queue.writeBuffer(paramsBuffer, 0, paramsData);

            // Create texture view
            const textureView = texture.createView();

            // Get pipeline
            const pipeline = this.getOrCreateReversePipeline(targetFormat, textureFormat);

            // Create bind group
            const bindGroup = this.device.createBindGroup({
                layout: this.getReverseBindGroupLayout(),
                entries: [
                    { binding: 0, resource: { buffer: paramsBuffer } },
                    { binding: 1, resource: textureView },
                    { binding: 2, resource: { buffer: outputBuffer } },
                ],
            });

            // Encode compute pass
            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);

            const workgroupsX = Math.ceil(width / WORKGROUP_SIZE_X);
            const workgroupsY = Math.ceil(height / WORKGROUP_SIZE_Y);
            pass.dispatchWorkgroups(workgroupsX, workgroupsY);
            pass.end();

            // The reverse shader writes pixels TIGHTLY PACKED (output index = y*width + x),
            // i.e. the output buffer has a row stride of `width * bytesPerPixel`, NOT `pitch`.
            // Stage exactly that tight payload, then de-pad into the pitch-strided surface buffer.
            const tightRowBytes = width * bytesPerPixel;
            const stagingBuffer = this.device.createBuffer({
                size: outputBufferSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });

            // Copy output to staging
            encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputBufferSize);

            // Submit
            this.queue.submit([encoder.finish()]);

            // Wait for GPU to finish
            profiler.start("convertFromTexture:gpuWait");
            await this.queue.onSubmittedWorkDone();
            profiler.end("convertFromTexture:gpuWait");

            // Map and read staging buffer
            profiler.start("convertFromTexture:mapAsync");
            await stagingBuffer.mapAsync(GPUMapMode.READ);
            profiler.end("convertFromTexture:mapAsync");

            const mapped = new Uint8Array(stagingBuffer.getMappedRange());
            // Output is pitch*height so the caller can write it straight into surface
            // memory at the surface's pitch. When pitch > tightRowBytes (padded pitch),
            // copy row-by-row to avoid the shear bug; otherwise a single copy suffices.
            const readbackSize = pitch * height;
            const result = new Uint8Array(readbackSize);
            if (pitch === tightRowBytes) {
                result.set(mapped.subarray(0, Math.min(mapped.length, readbackSize)));
            } else {
                for (let y = 0; y < height; y++) {
                    const srcOff = y * tightRowBytes;
                    result.set(mapped.subarray(srcOff, srcOff + tightRowBytes), y * pitch);
                }
            }

            // Cleanup
            stagingBuffer.unmap();
            stagingBuffer.destroy();
            outputBuffer.destroy();
            paramsBuffer.destroy();

            profiler.end("TextureConverter.convertFromTexture");

            Logger.log(LogCategory.DDRAW,
                `TextureConverter.convertFromTexture: ${width}x${height} ${textureFormat} → ` +
                `format=${targetFormat} (${readbackSize} bytes)`);

            return result;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `TextureConverter.convertFromTexture failed: ${e}`);
            profiler.end("TextureConverter.convertFromTexture");
            return null;
        }
    }

    /**
     * Destroy temp buffers from GPU path (per-call). Call after queue.submit().
     */
    destroyPendingAfterSubmit(): void {
        for (const b of this.pendingDestroyBuffers) b.destroy();
        this.pendingDestroyBuffers.length = 0;
    }

    /**
     * Destroy resources
     */
    destroy(): void {
        this.destroyPendingAfterSubmit();
        this.lutRGB565.destroy();
        this.lutRGB555.destroy();
        this.lutARGB1555.destroy();
        this.pipelineCache.clear();
        this.pipelineCacheLUT.clear();
        this.reversePipelineCache.clear();
        this.reverseBindGroupLayout = null;
    }
}
