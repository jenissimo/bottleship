export const GLIDE_TEXFMT_RGB_332 = 0x00;
export const GLIDE_TEXFMT_YIQ_422 = 0x01;
export const GLIDE_TEXFMT_ALPHA_8 = 0x02;
export const GLIDE_TEXFMT_INTENSITY_8 = 0x03;
export const GLIDE_TEXFMT_ALPHA_INTENSITY_44 = 0x04;
export const GLIDE_TEXFMT_P_8 = 0x05;
export const GLIDE_TEXFMT_ARGB_8332 = 0x08;
export const GLIDE_TEXFMT_AYIQ_8422 = 0x09;
export const GLIDE_TEXFMT_RGB_565 = 0x0a;
export const GLIDE_TEXFMT_ARGB_1555 = 0x0b;
export const GLIDE_TEXFMT_ARGB_4444 = 0x0c;
export const GLIDE_TEXFMT_ALPHA_INTENSITY_88 = 0x0d;
export const GLIDE_TEXFMT_AP_88 = 0x0e;

/**
 * Decoded 3dfx NCC (Narrow Channel Compression / YIQ) table — GuNccTable from
 * glideutl.h: FxU8 yRGB[16]; FxI16 iRGB[4][3]; FxI16 qRGB[4][3]; FxU32 packed[12].
 */
export interface DecodedNccTable {
    yRGB: Uint8Array; // 16 luminance values
    iRGB: Int16Array; // [4][3] signed chroma (flattened: idx*3 + channel)
    qRGB: Int16Array; // [4][3] signed chroma
}

// Parse a 112-byte GuNccTable from guest memory bytes.
export function parseNccTable(bytes: Uint8Array): DecodedNccTable {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const yRGB = new Uint8Array(16);
    for (let i = 0; i < 16; i++) yRGB[i] = bytes[i] ?? 0;
    const iRGB = new Int16Array(12);
    const qRGB = new Int16Array(12);
    for (let i = 0; i < 12; i++) {
        iRGB[i] = bytes.length >= 16 + (i + 1) * 2 ? dv.getInt16(16 + i * 2, true) : 0;
        qRGB[i] = bytes.length >= 40 + (i + 1) * 2 ? dv.getInt16(40 + i * 2, true) : 0;
    }
    return { yRGB, iRGB, qRGB };
}

function clampByte(v: number): number {
    return Math.max(0, Math.min(255, v | 0));
}

// Decode one 8-bit YIQ texel via the NCC table: Y index = high 4 bits, I = bits
// [3:2], Q = bits [1:0]; RGB = clamp(Y + iRGB[I] + qRGB[Q]) per channel.
function decodeYiqTexel(texel: number, ncc: DecodedNccTable): [number, number, number] {
    const y = ncc.yRGB[(texel >> 4) & 0x0f] ?? 0;
    const ii = (texel >> 2) & 0x03;
    const qq = texel & 0x03;
    return [
        clampByte(y + (ncc.iRGB[ii * 3 + 0] ?? 0) + (ncc.qRGB[qq * 3 + 0] ?? 0)),
        clampByte(y + (ncc.iRGB[ii * 3 + 1] ?? 0) + (ncc.qRGB[qq * 3 + 1] ?? 0)),
        clampByte(y + (ncc.iRGB[ii * 3 + 2] ?? 0) + (ncc.qRGB[qq * 3 + 2] ?? 0)),
    ];
}

/** Source bytes per texel; every Glide format is a fixed 1 or 2 bytes. */
function glideBytesPerTexel(format: number): number {
    switch (format | 0) {
        case GLIDE_TEXFMT_RGB_565:
        case GLIDE_TEXFMT_ARGB_1555:
        case GLIDE_TEXFMT_ARGB_4444:
        case GLIDE_TEXFMT_ARGB_8332:
        case GLIDE_TEXFMT_ALPHA_INTENSITY_88:
        case GLIDE_TEXFMT_AP_88:
        case GLIDE_TEXFMT_AYIQ_8422: // 16-bit: 8-bit alpha + 8-bit YIQ index
            return 2;
        case GLIDE_TEXFMT_RGB_332:
        case GLIDE_TEXFMT_YIQ_422: // 8-bit YIQ index
        case GLIDE_TEXFMT_ALPHA_8:
        case GLIDE_TEXFMT_INTENSITY_8:
        case GLIDE_TEXFMT_ALPHA_INTENSITY_44:
        case GLIDE_TEXFMT_P_8:
        default:
            return 1;
    }
}

export function estimateTextureSizeBytes(width: number, height: number, format: number): number {
    return Math.max(1, width | 0) * Math.max(1, height | 0) * glideBytesPerTexel(format);
}

/**
 * An NCC texel index is 8 bits, so the whole YIQ→RGB mapping is 256 entries;
 * building it once per surface keeps the chroma arithmetic out of the texel loop.
 */
function buildYiqLut(ncc: DecodedNccTable): Uint8Array {
    const lut = new Uint8Array(256 * 3);
    for (let t = 0; t < 256; t++) {
        const c = decodeYiqTexel(t, ncc);
        lut[t * 3 + 0] = c[0];
        lut[t * 3 + 1] = c[1];
        lut[t * 3 + 2] = c[2];
    }
    return lut;
}

/**
 * Copy the texel extent into a zero-filled buffer for the case where it is not
 * wholly resident. The per-texel guards this replaces answered 0 for any texel
 * not entirely inside `memory`, so those texels stay zero here: the accepted set
 * is identical, the check just no longer runs per texel.
 */
function stageTexelExtent(
    memory: Uint8Array,
    dataPtr: number,
    texels: number,
    bytesPerTexel: number,
): Uint8Array {
    const staged = new Uint8Array(texels * bytesPerTexel);
    for (let i = 0; i < texels; i++) {
        const off = dataPtr + i * bytesPerTexel;
        if (off < 0 || off + bytesPerTexel > memory.length) continue;
        for (let b = 0; b < bytesPerTexel; b++) staged[i * bytesPerTexel + b] = memory[off + b];
    }
    return staged;
}

export function decodeGlideTexture(
    memory: Uint8Array,
    dataPtr: number,
    width: number,
    height: number,
    format: number,
    palette: Uint32Array | null = null,
    ncc: DecodedNccTable | null = null,
): Uint8Array {
    const safeWidth = Math.max(1, width | 0);
    const safeHeight = Math.max(1, height | 0);
    const texels = safeWidth * safeHeight;
    const out = new Uint8Array(texels * 4);

    // Validate the whole extent once at the boundary, then index it unchecked:
    // format, palette and NCC table are all invariant over the surface, so the
    // only thing the texel loop still has to do is convert.
    const bpt = glideBytesPerTexel(format);
    const resident = dataPtr >= 0 && dataPtr + texels * bpt <= memory.length;
    const src = resident ? memory : stageTexelExtent(memory, dataPtr, texels, bpt);
    const base = resident ? dataPtr : 0;

    switch (format) {
        case GLIDE_TEXFMT_RGB_332:
            for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
                const raw = src[base + i];
                out[dst + 0] = ((raw >>> 5) & 0x07) * 255 / 7 | 0;
                out[dst + 1] = ((raw >>> 2) & 0x07) * 255 / 7 | 0;
                out[dst + 2] = (raw & 0x03) * 255 / 3 | 0;
                out[dst + 3] = 255;
            }
            return out;

        case GLIDE_TEXFMT_YIQ_422: {
            const lut = ncc ? buildYiqLut(ncc) : null;
            if (lut) {
                for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
                    const e = src[base + i] * 3;
                    out[dst + 0] = lut[e];
                    out[dst + 1] = lut[e + 1];
                    out[dst + 2] = lut[e + 2];
                    out[dst + 3] = 255;
                }
            } else {
                // No NCC table downloaded yet: fall back to luminance from the index.
                for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
                    const raw = src[base + i];
                    out[dst + 0] = raw;
                    out[dst + 1] = raw;
                    out[dst + 2] = raw;
                    out[dst + 3] = 255;
                }
            }
            return out;
        }

        case GLIDE_TEXFMT_AYIQ_8422: {
            const lut = ncc ? buildYiqLut(ncc) : null;
            for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                const yiq = src[off];
                if (lut) {
                    const e = yiq * 3;
                    out[dst + 0] = lut[e];
                    out[dst + 1] = lut[e + 1];
                    out[dst + 2] = lut[e + 2];
                } else {
                    out[dst + 0] = yiq;
                    out[dst + 1] = yiq;
                    out[dst + 2] = yiq;
                }
                out[dst + 3] = src[off + 1];
            }
            return out;
        }

        case GLIDE_TEXFMT_RGB_565:
            for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                const raw = src[off] | (src[off + 1] << 8);
                out[dst + 0] = (((raw >>> 11) & 0x1f) * 255 / 31) | 0;
                out[dst + 1] = (((raw >>> 5) & 0x3f) * 255 / 63) | 0;
                out[dst + 2] = ((raw & 0x1f) * 255 / 31) | 0;
                out[dst + 3] = 255;
            }
            return out;

        case GLIDE_TEXFMT_ARGB_1555:
            for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                const raw = src[off] | (src[off + 1] << 8);
                out[dst + 0] = (((raw >>> 10) & 0x1f) * 255 / 31) | 0;
                out[dst + 1] = (((raw >>> 5) & 0x1f) * 255 / 31) | 0;
                out[dst + 2] = ((raw & 0x1f) * 255 / 31) | 0;
                out[dst + 3] = (raw & 0x8000) ? 255 : 0;
            }
            return out;

        case GLIDE_TEXFMT_ARGB_4444:
            for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                const lo = src[off];
                const hi = src[off + 1];
                out[dst + 0] = (hi & 0x0f) * 17;
                out[dst + 1] = ((lo >>> 4) & 0x0f) * 17;
                out[dst + 2] = (lo & 0x0f) * 17;
                out[dst + 3] = ((hi >>> 4) & 0x0f) * 17;
            }
            return out;

        case GLIDE_TEXFMT_ARGB_8332:
            for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                const raw = src[off];
                out[dst + 0] = ((raw >>> 5) & 0x07) * 255 / 7 | 0;
                out[dst + 1] = ((raw >>> 2) & 0x07) * 255 / 7 | 0;
                out[dst + 2] = (raw & 0x03) * 255 / 3 | 0;
                out[dst + 3] = src[off + 1];
            }
            return out;

        case GLIDE_TEXFMT_ALPHA_8:
            for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
                out[dst + 0] = 255;
                out[dst + 1] = 255;
                out[dst + 2] = 255;
                out[dst + 3] = src[base + i];
            }
            return out;

        case GLIDE_TEXFMT_INTENSITY_8:
            for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
                const v = src[base + i];
                out[dst + 0] = v;
                out[dst + 1] = v;
                out[dst + 2] = v;
                out[dst + 3] = 255;
            }
            return out;

        case GLIDE_TEXFMT_ALPHA_INTENSITY_44:
            for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
                const raw = src[base + i];
                const v = (raw & 0x0f) * 17;
                out[dst + 0] = v;
                out[dst + 1] = v;
                out[dst + 2] = v;
                out[dst + 3] = ((raw >>> 4) & 0x0f) * 17;
            }
            return out;

        case GLIDE_TEXFMT_ALPHA_INTENSITY_88:
            for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                const v = src[off];
                out[dst + 0] = v;
                out[dst + 1] = v;
                out[dst + 2] = v;
                out[dst + 3] = src[off + 1];
            }
            return out;

        case GLIDE_TEXFMT_AP_88:
            if (palette) {
                for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                    const c = palette[src[off]] >>> 0;
                    out[dst + 0] = (c >>> 16) & 0xff;
                    out[dst + 1] = (c >>> 8) & 0xff;
                    out[dst + 2] = c & 0xff;
                    out[dst + 3] = src[off + 1];
                }
            } else {
                for (let i = 0, dst = 0, off = base; i < texels; i++, dst += 4, off += 2) {
                    const idx = src[off];
                    out[dst + 0] = idx;
                    out[dst + 1] = idx;
                    out[dst + 2] = idx;
                    out[dst + 3] = src[off + 1];
                }
            }
            return out;

        case GLIDE_TEXFMT_P_8:
            if (palette) {
                for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
                    const raw = palette[src[base + i]] >>> 0;
                    out[dst + 0] = (raw >>> 16) & 0xff;
                    out[dst + 1] = (raw >>> 8) & 0xff;
                    out[dst + 2] = raw & 0xff;
                    out[dst + 3] = (raw >>> 24) & 0xff;
                }
                return out;
            }
            break; // no palette downloaded: grayscale fallback
    }

    // Fallback: grayscale from source byte.
    for (let i = 0, dst = 0; i < texels; i++, dst += 4) {
        const gray = src[base + i];
        out[dst + 0] = gray;
        out[dst + 1] = gray;
        out[dst + 2] = gray;
        out[dst + 3] = 255;
    }
    return out;
}

// Glide 2.x: GR_LOD_256=0, GR_LOD_128=1, ..., GR_LOD_1=8
function lodToSize(lod: number): number {
    const table = [256, 128, 64, 32, 16, 8, 4, 2, 1];
    const idx = Math.max(0, Math.min(table.length - 1, lod | 0));
    return table[idx] ?? 64;
}

// Glide 2.x aspects are unsigned: 0=8:1, 1=4:1, 2=2:1, 3=1:1, 4=1:2, 5=1:4, 6=1:8
// LOD gives the max dimension; aspect shrinks the smaller axis.
export function computeTextureDimensions(lod: number, aspectRatio: number): { width: number; height: number } {
    const base = lodToSize(lod);
    const ar = aspectRatio | 0;
    if (ar < 3) {
        // Wider than tall: shrink height
        return { width: base, height: Math.max(1, base >> (3 - ar)) };
    } else if (ar > 3) {
        // Taller than wide: shrink width
        return { width: Math.max(1, base >> (ar - 3)), height: base };
    }
    return { width: base, height: base };
}

/**
 * s/t -> normalized uv scale for one texture.
 *
 * Glide's texture coordinates span 0..255 across the LONGER axis whatever the LOD,
 * and the shorter axis is scaled by the aspect ratio — the 3dfx SDK's view3df.c
 * multiplies its 255.0 by a factor that depends on aspect and NOT on size. So a
 * 64x16 texture is addressed with s in 0..255 and t in only 0..63; dividing both by
 * 256 stretches every non-square texture by its aspect ratio.
 */
export function glideTexCoordScale(width: number, height: number): { x: number; y: number } {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const longAxis = Math.max(w, h);
    return { x: longAxis / (256 * w), y: longAxis / (256 * h) };
}

export const GR_MIPMAPLEVELMASK_EVEN = 1;
export const GR_MIPMAPLEVELMASK_ODD = 2;
export const GR_MIPMAPLEVELMASK_BOTH = GR_MIPMAPLEVELMASK_EVEN | GR_MIPMAPLEVELMASK_ODD;

export function glideIncludesMipLevel(evenOdd: number, lod: number): boolean {
    if (evenOdd === GR_MIPMAPLEVELMASK_BOTH) return true;
    if (evenOdd === GR_MIPMAPLEVELMASK_EVEN) return (lod & 1) === 0;
    if (evenOdd === GR_MIPMAPLEVELMASK_ODD) return (lod & 1) !== 0;
    return false;
}

export interface GlideMipLevel {
    lod: number;
    width: number;
    height: number;
    byteOffset: number;
    byteSize: number;
}

/**
 * Where each downloaded LOD sits in the guest buffer grTexDownloadMipMap was given.
 *
 * Glide numbers LODs largest-first (GR_LOD_256 = 0) and lays the selected levels out
 * in that order, so the offsets are a running sum. The returned run stops at the first
 * level that is not exactly half the previous one: WebGPU mip levels must halve, and an
 * EVEN/ODD mask produces a chain that skips levels, which no GPU mip chain can express.
 */
export function glideMipLevelPlan(
    largeLod: number,
    smallLod: number,
    evenOdd: number,
    aspectRatio: number,
    sizeOf: (width: number, height: number) => number,
): GlideMipLevel[] {
    const out: GlideMipLevel[] = [];
    if (largeLod < 0 || smallLod < largeLod) return out;

    let offset = 0;
    let expected: { width: number; height: number } | null = null;
    for (let lod = largeLod; lod <= smallLod; lod++) {
        const dims = computeTextureDimensions(lod, aspectRatio);
        const size = sizeOf(dims.width, dims.height);
        if (!glideIncludesMipLevel(evenOdd, lod)) {
            // Not downloaded: it occupies no bytes, and it breaks the halving chain a GPU
            // mip chain has to be. Everything past the gap is unreachable as a mip level.
            if (out.length > 0) break;
            continue;
        }
        if (expected && (dims.width !== expected.width || dims.height !== expected.height)) {
            break;
        }
        out.push({ lod, width: dims.width, height: dims.height, byteOffset: offset, byteSize: size });
        offset += size;
        expected = { width: Math.max(1, dims.width >> 1), height: Math.max(1, dims.height >> 1) };
    }
    return out;
}
