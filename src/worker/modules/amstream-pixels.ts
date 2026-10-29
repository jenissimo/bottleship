/**
 * Decoded BGRA frames into an RGB DirectDraw surface of any 16/24/32-bit layout — what
 * the multimedia-streaming video renderer negotiates with the decoder for a sample surface.
 */

export interface RgbLayout {
    bpp: number;
    rMask: number;
    gMask: number;
    bMask: number;
    /** Filled opaque: video has no alpha. */
    aMask?: number;
}

interface Channel { shift: number; drop: number }

function channel(mask: number): Channel {
    const m = mask >>> 0;
    if (!m) return { shift: 0, drop: 8 };
    let shift = 0;
    while (!((m >>> shift) & 1)) shift++;
    let bits = 0;
    while ((m >>> (shift + bits)) & 1) bits++;
    // A channel wider than 8 bits keeps the source's 8 at its top.
    return bits >= 8 ? { shift: shift + bits - 8, drop: 0 } : { shift, drop: 8 - bits };
}

/** Whether frames can be written into a surface of this layout. */
export function isPackableRgb(layout: RgbLayout): boolean {
    return (layout.bpp === 16 || layout.bpp === 24 || layout.bpp === 32)
        && (layout.rMask | layout.gMask | layout.bMask) !== 0;
}

/**
 * Write `width` x `height` BGRA pixels (`srcStride` bytes per source row) into `dst` from
 * `offset`, `pitch` bytes per row. The caller has validated the whole destination extent.
 */
export function packBgraRows(
    src: Uint8Array, srcStride: number, width: number, height: number,
    dst: Uint8Array, offset: number, pitch: number, layout: RgbLayout,
): void {
    const r = channel(layout.rMask), g = channel(layout.gMask), b = channel(layout.bMask);
    const bytes = layout.bpp >> 3;
    const alpha = (layout.aMask ?? 0) >>> 0;
    for (let y = 0; y < height; y++) {
        let s = y * srcStride;
        let d = offset + y * pitch;
        for (let x = 0; x < width; x++, s += 4, d += bytes) {
            const v = (((src[s + 2]! >> r.drop) << r.shift)
                | ((src[s + 1]! >> g.drop) << g.shift)
                | ((src[s]! >> b.drop) << b.shift) | alpha) >>> 0;
            dst[d] = v & 0xff;
            dst[d + 1] = (v >>> 8) & 0xff;
            if (bytes > 2) dst[d + 2] = (v >>> 16) & 0xff;
            if (bytes > 3) dst[d + 3] = (v >>> 24) & 0xff;
        }
    }
}
