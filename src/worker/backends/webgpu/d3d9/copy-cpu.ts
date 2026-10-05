import {
    decodeD3DTextureToRgba8,
    d3dFloatFormatInfo,
    float16BitsToFloat32,
    float32ToFloat16Bits,
    getD3DTextureLayout,
    isD3DFloatFormat,
} from "../shared/texture-formats";

export interface D3D9CpuCopySurface {
    data: Uint8Array;
    pitch: number;
    width: number;
    height: number;
    format: number;
}

export interface D3D9CopyRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/**
 * Formats that can be written without inventing a GPU-side conversion contract.
 * Sources may be broader because the shared decoder can turn DXT into RGBA8, but
 * a CPU copy must still land in the exact destination byte layout.
 */
export function isD3D9CpuCopyDestinationFormat(format: number): boolean {
    switch (format >>> 0) {
        case 20: case 21: case 22: case 23: case 24: case 25: case 26: case 27: case 29: case 30:
        case 28: case 31: case 32: case 33: case 34: case 35: case 36:
        case 50: case 51: case 52: case 60: case 61: case 62: case 63: case 64: case 65: case 67: case 81: case 110:
            return true;
        default:
            // This is a CPU conversion contract only.  D3D9 capability queries
            // still refuse float formats until a real GPU float-storage path is
            // available, but an already-created shadow can be copied losslessly.
            return isD3DFloatFormat(format);
    }
}

function clampByte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value))) | 0;
}

/** Inverse of the mask decoder's `value * 255 / max`: an n-bit UNORM field is a
 * fraction of its own maximum, not the top n bits of the canonical byte. */
function encodeUnsignedNormalized(value: number, bits: number): number {
    const max = (1 << bits) - 1;
    return Math.max(0, Math.min(max, Math.round((clampByte(value) * max) / 255)));
}

/** texture-formats.ts signedNToByte(): the canonical 8-bit shadow of one
 * signed-normalized code point. Mirrored here so the encoder can be verified
 * against the decoder it must invert instead of approximating it. */
function signedNormalizedToByte(signed: number, bits: number): number {
    const max = (1 << (bits - 1)) - 1;
    return clampByte(Math.round((signed / max) * 127 + 128));
}

/** Inverse of texture-formats.ts signedNToByte(), preserving the asymmetric
 * signed-normalized minimum (for example -128/-32768). */
function encodeSignedNormalized(value: number, bits: number): number {
    const canonical = clampByte(value);
    const max = (1 << (bits - 1)) - 1;
    const min = -(1 << (bits - 1));
    const signed = Math.max(min, Math.min(max, Math.round(((canonical - 128) * max) / 127)));
    // The asymmetric minimum shares a shadow byte with -max only when the format is
    // as fine as the 8-bit shadow (16-bit lanes); for a coarser lane (5/10/11 bits)
    // -max has a shadow of its own, and claiming the minimum for it would move the
    // value by a whole code point. Take the minimum exactly when it decodes back here.
    if (signed === -max && signedNormalizedToByte(min, bits) === canonical) return min & ((1 << bits) - 1);
    return signed & ((1 << bits) - 1);
}

function sampleNearest(rgba: Uint8Array, width: number, height: number, x: number, y: number, out: number[]): void {
    const sx = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const sy = Math.max(0, Math.min(height - 1, Math.floor(y)));
    const offset = (sy * width + sx) * 4;
    out[0] = rgba[offset]!;
    out[1] = rgba[offset + 1]!;
    out[2] = rgba[offset + 2]!;
    out[3] = rgba[offset + 3]!;
}

function sampleLinear(rgba: Uint8Array, width: number, height: number, x: number, y: number, out: number[]): void {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const sx0 = Math.max(0, Math.min(width - 1, x0));
    const sy0 = Math.max(0, Math.min(height - 1, y0));
    const a = (sy0 * width + sx0) * 4;
    const b = (sy0 * width + x1) * 4;
    const c = (y1 * width + sx0) * 4;
    const d = (y1 * width + x1) * 4;
    for (let channel = 0; channel < 4; channel++) {
        const top = rgba[a + channel]! * (1 - fx) + rgba[b + channel]! * fx;
        const bottom = rgba[c + channel]! * (1 - fx) + rgba[d + channel]! * fx;
        out[channel] = top * (1 - fy) + bottom * fy;
    }
}

/** Read a float texel without passing through the lossy RGBA8 shadow.  D3D9's
 * float texture layouts are R, RG and RGBA in little-endian channel order;
 * absent channels are the same canonical zero/one values used by the normal
 * decoder. */
function readD3DFloatPixel(
    source: D3D9CpuCopySurface,
    offset: number,
    out: number[],
): boolean {
    const info = d3dFloatFormatInfo(source.format);
    if (!info || offset < 0 || offset + info.channels * info.bytesPerChannel > source.data.byteLength) return false;
    const view = new DataView(source.data.buffer, source.data.byteOffset, source.data.byteLength);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    for (let channel = 0; channel < info.channels; channel++) {
        const channelOffset = offset + channel * info.bytesPerChannel;
        out[channel] = info.bytesPerChannel === 2
            ? float16BitsToFloat32(view.getUint16(channelOffset, true))
            : view.getFloat32(channelOffset, true);
    }
    return true;
}

/** Write a float texel directly in the requested D3D9 float layout.  Keeping
 * this separate from writeD3D9Pixel is important: the latter intentionally
 * accepts an 8-bit canonical colour and is therefore not suitable for a
 * float-to-float StretchRect filter. */
function writeD3DFloatPixel(format: number, data: Uint8Array, offset: number, pixel: number[]): boolean {
    const info = d3dFloatFormatInfo(format);
    if (!info || offset < 0 || offset + info.channels * info.bytesPerChannel > data.byteLength) return false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let channel = 0; channel < info.channels; channel++) {
        const value = pixel[channel] ?? (channel === 3 ? 1 : 0);
        const channelOffset = offset + channel * info.bytesPerChannel;
        if (info.bytesPerChannel === 2) view.setUint16(channelOffset, float32ToFloat16Bits(value), true);
        else view.setFloat32(channelOffset, value, true);
    }
    return true;
}

function sampleNearestFloat(
    source: D3D9CpuCopySurface,
    bytesPerPixel: number,
    x: number,
    y: number,
    out: number[],
): boolean {
    const sx = Math.max(0, Math.min(source.width - 1, Math.floor(x)));
    const sy = Math.max(0, Math.min(source.height - 1, Math.floor(y)));
    return readD3DFloatPixel(source, sy * source.pitch + sx * bytesPerPixel, out);
}

function sampleLinearFloat(
    source: D3D9CpuCopySurface,
    bytesPerPixel: number,
    x: number,
    y: number,
    out: number[],
): boolean {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1);
    const sx0 = Math.max(0, Math.min(source.width - 1, x0));
    const sy0 = Math.max(0, Math.min(source.height - 1, y0));
    const a: number[] = [], b: number[] = [], c: number[] = [], d: number[] = [];
    if (!readD3DFloatPixel(source, sy0 * source.pitch + sx0 * bytesPerPixel, a) ||
        !readD3DFloatPixel(source, sy0 * source.pitch + x1 * bytesPerPixel, b) ||
        !readD3DFloatPixel(source, y1 * source.pitch + sx0 * bytesPerPixel, c) ||
        !readD3DFloatPixel(source, y1 * source.pitch + x1 * bytesPerPixel, d)) return false;
    for (let channel = 0; channel < 4; channel++) {
        const top = a[channel]! * (1 - fx) + b[channel]! * fx;
        const bottom = c[channel]! * (1 - fx) + d[channel]! * fx;
        out[channel] = top * (1 - fy) + bottom * fy;
    }
    return true;
}

/** Encode one RGBA8 sample into a D3D9 CPU layout. Shared by StretchRect and
 * device-side ColorFill so accepted packed formats cannot diverge between the
 * two paths. */
export function writeD3D9Pixel(format: number, data: Uint8Array, offset: number, pixel: number[]): boolean {
    const r = clampByte(pixel[0]!);
    const g = clampByte(pixel[1]!);
    const b = clampByte(pixel[2]!);
    const a = clampByte(pixel[3]!);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (format >>> 0) {
        case 20: // R8G8B8: D3D's 24-bit memory order is B G R.
            data[offset] = b; data[offset + 1] = g; data[offset + 2] = r;
            return true;
        case 21: // A8R8G8B8, little-endian B G R A
            data[offset] = b; data[offset + 1] = g; data[offset + 2] = r; data[offset + 3] = a;
            return true;
        case 22: // X8R8G8B8
            data[offset] = b; data[offset + 1] = g; data[offset + 2] = r; data[offset + 3] = 0xff;
            return true;
        case 32: // A8B8G8R8, little-endian R G B A
            data[offset] = r; data[offset + 1] = g; data[offset + 2] = b; data[offset + 3] = a;
            return true;
        case 33: // X8B8G8R8
            data[offset] = r; data[offset + 1] = g; data[offset + 2] = b; data[offset + 3] = 0xff;
            return true;
        case 23:
            view.setUint16(offset, ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), true);
            return true;
        case 24:
            view.setUint16(offset, ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3), true);
            return true;
        case 25:
            view.setUint16(offset, ((a >= 128 ? 1 : 0) << 15) | ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3), true);
            return true;
        case 26:
            view.setUint16(offset, ((a >> 4) << 12) | ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4), true);
            return true;
        case 27: // R3G3B2: R in the high three bits, G in the middle three, B in the low two.
            data[offset] = ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6);
            return true;
        case 29: // A8R3G3B2, low byte RGB packed, high byte alpha.
            view.setUint16(offset, (a << 8) | ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6), true);
            return true;
        case 30:
            view.setUint16(offset, ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4), true);
            return true;
        case 28:
            data[offset] = a;
            return true;
        case 31: { // A2B10G10R10: R low, G middle, B high, A top.
            const packed = (encodeUnsignedNormalized(a, 2) << 30) |
                (encodeUnsignedNormalized(b, 10) << 20) |
                (encodeUnsignedNormalized(g, 10) << 10) | encodeUnsignedNormalized(r, 10);
            view.setUint32(offset, packed >>> 0, true);
            return true;
        }
        case 34: { // G16R16, little-endian R then G.
            view.setUint16(offset, r * 257, true);
            view.setUint16(offset + 2, g * 257, true);
            return true;
        }
        case 35: { // A2R10G10B10: B low, G middle, R high, A top.
            const packed = (encodeUnsignedNormalized(a, 2) << 30) |
                (encodeUnsignedNormalized(r, 10) << 20) |
                (encodeUnsignedNormalized(g, 10) << 10) | encodeUnsignedNormalized(b, 10);
            view.setUint32(offset, packed >>> 0, true);
            return true;
        }
        case 36: // A16B16G16R16, little-endian 16-bit R/G/B/A.
            view.setUint16(offset, r * 257, true);
            view.setUint16(offset + 2, g * 257, true);
            view.setUint16(offset + 4, b * 257, true);
            view.setUint16(offset + 6, a * 257, true);
            return true;
        case 50:
            data[offset] = r;
            return true;
        case 51:
            data[offset] = r; data[offset + 1] = a;
            return true;
        case 52: // A4L4, high alpha nibble and low luminance nibble.
            data[offset] = ((a >> 4) << 4) | (r >> 4);
            return true;
        case 60: // V8U8: signed-normalized U in the low byte, V in the high byte.
            // The decoder exposes signed bytes in the canonical shadow as [s + 128].
            // Subtracting the same midpoint makes same-format CPU copies lossless,
            // including the asymmetric -128 endpoint (0x80).
            data[offset] = (clampByte(r) - 128) & 0xff;
            data[offset + 1] = (clampByte(g) - 128) & 0xff;
            return true;
        case 61: { // L6V5U5: signed-normalized U/V plus 6-bit luminance.
            const packed = encodeSignedNormalized(r, 5) |
                (encodeSignedNormalized(g, 5) << 5) |
                (Math.max(0, Math.min(63, Math.round(clampByte(b) * 63 / 255))) << 10);
            view.setUint16(offset, packed, true);
            return true;
        }
        case 62: // X8L8V8U8: U/V are signed-normalized, L is UNORM, X is unused.
            // The shared decoder exposes [U + 128, V + 128, L, 255].  Store the
            // canonical unused X byte just as the other D3D9 X* encoders do.
            data[offset] = (clampByte(r) - 128) & 0xff;
            data[offset + 1] = (clampByte(g) - 128) & 0xff;
            data[offset + 2] = b;
            data[offset + 3] = 0xff;
            return true;
        case 63: // Q8W8V8U8: signed-normalized U,V,W,Q, least-significant first.
            // The decoder's canonical shadow is [U + 128, V + 128, W + 128,
            // Q + 128], so use the same midpoint inverse for every component.
            data[offset] = (clampByte(r) - 128) & 0xff;
            data[offset + 1] = (clampByte(g) - 128) & 0xff;
            data[offset + 2] = (clampByte(b) - 128) & 0xff;
            data[offset + 3] = (clampByte(a) - 128) & 0xff;
            return true;
        case 64: { // V16U16: signed-normalized U then V, little-endian 16-bit words.
            // Packed bump formats are decoded into an 8-bit canonical shadow before
            // the CPU copy.  Re-expand that shadow with the same [-1, 1] convention
            // used by texture-formats.ts (127 positive code points, with the minimum
            // signed value clamped to -32768).  Keep the endpoint explicit: -32768
            // decodes to shadow value 1 because the signed denominator is 32767.
            view.setInt16(offset, encodeSignedNormalized(r, 16), true);
            view.setInt16(offset + 2, encodeSignedNormalized(g, 16), true);
            return true;
        }
        case 65: { // W11V11U10: signed-normalized U10/V11/W11, alpha is implicit 1.
            const packed = encodeSignedNormalized(r, 10) |
                (encodeSignedNormalized(g, 11) << 10) |
                (encodeSignedNormalized(b, 11) << 21);
            view.setUint32(offset, packed >>> 0, true);
            return true;
        }
        case 67: { // A2W10V10U10: signed-normalized U/V/W plus 2-bit UNORM alpha.
            const packed = encodeSignedNormalized(r, 10) |
                (encodeSignedNormalized(g, 10) << 10) |
                (encodeSignedNormalized(b, 10) << 20) |
                (Math.max(0, Math.min(3, Math.round(clampByte(a) * 3 / 255))) << 30);
            view.setUint32(offset, packed >>> 0, true);
            return true;
        }
        case 110: { // Q16W16V16U16: signed-normalized U,V,W,Q, little-endian words.
            view.setInt16(offset, encodeSignedNormalized(r, 16), true);
            view.setInt16(offset + 2, encodeSignedNormalized(g, 16), true);
            view.setInt16(offset + 4, encodeSignedNormalized(b, 16), true);
            view.setInt16(offset + 6, encodeSignedNormalized(a, 16), true);
            return true;
        }
        case 111: { // R16F: one red half-float channel; G/B are absent and A is implicit 1.
            view.setUint16(offset, float32ToFloat16Bits(r / 255), true);
            return true;
        }
        case 112: { // G16R16F: little-endian R then G half-floats.
            view.setUint16(offset, float32ToFloat16Bits(r / 255), true);
            view.setUint16(offset + 2, float32ToFloat16Bits(g / 255), true);
            return true;
        }
        case 113: { // A16B16G16R16F: little-endian R/G/B/A half-floats.
            view.setUint16(offset, float32ToFloat16Bits(r / 255), true);
            view.setUint16(offset + 2, float32ToFloat16Bits(g / 255), true);
            view.setUint16(offset + 4, float32ToFloat16Bits(b / 255), true);
            view.setUint16(offset + 6, float32ToFloat16Bits(a / 255), true);
            return true;
        }
        case 114: { // R32F.
            view.setFloat32(offset, r / 255, true);
            return true;
        }
        case 115: { // G32R32F: little-endian R then G floats.
            view.setFloat32(offset, r / 255, true);
            view.setFloat32(offset + 4, g / 255, true);
            return true;
        }
        case 116: { // A32B32G32R32F: little-endian R/G/B/A floats.
            view.setFloat32(offset, r / 255, true);
            view.setFloat32(offset + 4, g / 255, true);
            view.setFloat32(offset + 8, b / 255, true);
            view.setFloat32(offset + 12, a / 255, true);
            return true;
        }
        case 81: {
            const l = r * 257;
            view.setUint16(offset, l, true);
            return true;
        }
        default:
            return false;
    }
}

/**
 * CPU fallback for DEFAULT offscreen surfaces. It is deliberately rect-local:
 * pixels outside the destination rectangle are never rewritten. Sampling follows
 * the D3D9 StretchRect point/linear distinction, with half-pixel centers so a
 * same-size copy is an exact copy for POINT.
 */
export function copyD3D9SurfaceRectCpu(
    source: D3D9CpuCopySurface,
    destination: D3D9CpuCopySurface,
    sourceRect: D3D9CopyRect,
    destinationRect: D3D9CopyRect,
    linear: boolean,
): boolean {
    if (!isD3D9CpuCopyDestinationFormat(destination.format)) return false;
    if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) return false;
    const sw = sourceRect.right - sourceRect.left, sh = sourceRect.bottom - sourceRect.top;
    const dw = destinationRect.right - destinationRect.left, dh = destinationRect.bottom - destinationRect.top;
    if (sourceRect.left < 0 || sourceRect.top < 0 || sourceRect.right > source.width || sourceRect.bottom > source.height ||
        destinationRect.left < 0 || destinationRect.top < 0 || destinationRect.right > destination.width || destinationRect.bottom > destination.height ||
        sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return false;

    const sourceLayout = getD3DTextureLayout(source.format, source.width, source.height);
    const destinationLayout = getD3DTextureLayout(destination.format, destination.width, destination.height);
    if (sourceLayout.compressed || destinationLayout.compressed) {
        // Compressed source decode is supported by decodeD3DTextureToRgba8, but a
        // compressed destination cannot be authored one pixel at a time.
        if (destinationLayout.compressed) return false;
    }

    // Preserve arbitrary finite values, NaNs, and signed zero for an exact-size
    // float point copy.  The RGBA8 shadow is intentionally lossy, so routing this
    // case through it would make a same-format StretchRect silently quantize the
    // float texels even though the byte layouts are identical.
    if (!linear && isD3DFloatFormat(source.format) && source.format === destination.format &&
        sw === dw && sh === dh && !sourceLayout.compressed && !destinationLayout.compressed) {
        const bytesPerPixel = d3dFloatFormatInfo(source.format)!.channels *
            d3dFloatFormatInfo(source.format)!.bytesPerChannel;
        const rowBytes = sw * bytesPerPixel;
        for (let y = 0; y < sh; y++) {
            const sourceOffset = (sourceRect.top + y) * source.pitch + sourceRect.left * bytesPerPixel;
            const destinationOffset = (destinationRect.top + y) * destination.pitch + destinationRect.left * bytesPerPixel;
            if (sourceOffset < 0 || destinationOffset < 0 ||
                sourceOffset + rowBytes > source.data.byteLength ||
                destinationOffset + rowBytes > destination.data.byteLength) return false;
            destination.data.set(source.data.subarray(sourceOffset, sourceOffset + rowBytes), destinationOffset);
        }
        return true;
    }

    // Do not quantize a float source through the canonical RGBA8 shadow when the
    // destination is float as well.  This matters for a stretched R16F copy:
    // an 8-bit round trip changes values that are otherwise representable by the
    // destination half-float (and can turn a signed zero/NaN into a different
    // value).  Missing channels use the normal D3D colour defaults (0,0,0,1).
    if (isD3DFloatFormat(source.format) && isD3DFloatFormat(destination.format) &&
        !sourceLayout.compressed && !destinationLayout.compressed) {
        const sourceInfo = d3dFloatFormatInfo(source.format)!;
        const sourceBytesPerPixel = sourceInfo.channels * sourceInfo.bytesPerChannel;
        const destinationInfo = d3dFloatFormatInfo(destination.format)!;
        const destinationBytesPerPixel = destinationInfo.channels * destinationInfo.bytesPerChannel;
        if (!Number.isSafeInteger(source.pitch) || source.pitch < source.width * sourceBytesPerPixel ||
            source.data.byteLength < source.pitch * source.height ||
            !Number.isSafeInteger(destination.pitch) || destination.pitch < destination.width * destinationBytesPerPixel ||
            destination.data.byteLength < destination.pitch * destination.height) return false;
        const pixel = [0, 0, 0, 1];
        for (let y = 0; y < dh; y++) {
            const v = (y + 0.5) / dh;
            const sourceY = sourceRect.top + v * sh - 0.5;
            for (let x = 0; x < dw; x++) {
                const u = (x + 0.5) / dw;
                const sourceX = sourceRect.left + u * sw - 0.5;
                const sampled = linear
                    ? sampleLinearFloat(source, sourceBytesPerPixel, sourceX, sourceY, pixel)
                    : sampleNearestFloat(source, sourceBytesPerPixel, sourceX + 0.5, sourceY + 0.5, pixel);
                if (!sampled) return false;
                const dstOffset = (destinationRect.top + y) * destination.pitch +
                    (destinationRect.left + x) * destinationBytesPerPixel;
                if (!writeD3DFloatPixel(destination.format, destination.data, dstOffset, pixel)) return false;
            }
        }
        return true;
    }

    const rgba = decodeD3DTextureToRgba8(source.data, 0, source.width, source.height, source.format, {
        pitch: source.pitch,
    });
    const pixel = [0, 0, 0, 0];
    const bytesPerPixel = destinationLayout.pitch / Math.max(1, destination.width);
    if (!Number.isInteger(bytesPerPixel) || bytesPerPixel < 1) return false;
    for (let y = 0; y < dh; y++) {
        const v = (y + 0.5) / dh;
        const sourceY = sourceRect.top + v * sh - 0.5;
        for (let x = 0; x < dw; x++) {
            const u = (x + 0.5) / dw;
            const sourceX = sourceRect.left + u * sw - 0.5;
            if (linear) sampleLinear(rgba, source.width, source.height, sourceX, sourceY, pixel);
            else sampleNearest(rgba, source.width, source.height, sourceX + 0.5, sourceY + 0.5, pixel);
            const dstOffset = (destinationRect.top + y) * destination.pitch +
                (destinationRect.left + x) * bytesPerPixel;
            if (!writeD3D9Pixel(destination.format, destination.data, dstOffset, pixel)) return false;
        }
    }
    return true;
}
