/**
 * BINKFRAMEBUFFERS — the planar-YUV view of a Bink stream (bink.h, Bink 1.x).
 *
 * `BinkGetFrameBuffersInfo` is how a title that converts YUV→RGB on the GPU learns the
 * plane geometry and where the decoded planes live. Answering it with an untouched
 * struct is the worst possible lie: the caller reads plane POINTERS out of it, so
 * uninitialised stack becomes a dereference far from here.
 *
 * Our decoder hands back BGRA, not the stream's native planes, so the planes we publish
 * are converted per frame (BT.601 limited range — the inverse of the transform ffmpeg
 * applied on the way out). That costs one pass over the frame, and only for a title that
 * actually asked for this path.
 */

/** bink.h: `BINKFRAMEPLANE Frames[BINKMAXFRAMEBUFFERS]`. */
export const BINK_MAX_FRAME_BUFFERS = 2;

/** BINKFRAMEPLANE { U32 Allocate; void *Buffer; U32 BufferPitch; } */
const PLANE_SIZE = 12;
/** YPlane, cRPlane, cBPlane, APlane. */
const PLANES_PER_SET = 4;
const SET_SIZE = PLANES_PER_SET * PLANE_SIZE;

export const BINKFRAMEBUFFERS_SIZE = 24 + BINK_MAX_FRAME_BUFFERS * SET_SIZE;

export const BFB = {
    TotalFrames: 0,
    YABufferWidth: 4,
    YABufferHeight: 8,
    cRcBBufferWidth: 12,
    cRcBBufferHeight: 16,
    FrameNum: 20,
    Frames: 24,
} as const;

/** Plane index within one BINKFRAMEPLANE set. */
export const enum BinkPlane { Y = 0, cR = 1, cB = 2, A = 3 }

/** Byte offset of `Frames[set].<plane>` inside a BINKFRAMEBUFFERS. */
export function planeOffset(set: number, plane: BinkPlane): number {
    return BFB.Frames + set * SET_SIZE + plane * PLANE_SIZE;
}

/** BINKHEADER videoflags bit meaning "this stream carries an alpha plane". */
export const BINK_FLAG_ALPHA = 0x00100000;
/** Byte offset of videoflags in the 44-byte Bink file header. */
export const BINK_HEADER_VIDEOFLAGS_OFFSET = 0x24;

const align16 = (v: number) => (v + 15) & ~15;

/** Geometry of one decoded frame's planes, and where each one starts in the block. */
export interface BinkPlaneGeometry {
    yWidth: number;
    yHeight: number;
    cWidth: number;
    cHeight: number;
    hasAlpha: boolean;
    /** Byte offsets from the start of the plane block. */
    yOffset: number;
    cROffset: number;
    cBOffset: number;
    aOffset: number;
    /** Total bytes the three (or four) planes occupy. */
    totalBytes: number;
}

/**
 * Plane geometry for a video of this size. Luma is the frame rounded up to a macroblock
 * (16); 4:2:0 chroma is exactly half of THAT in both axes, so pitch/2 and height/2 stay
 * exact and a caller can derive one from the other without a second rounding rule.
 */
export function binkPlaneGeometry(width: number, height: number, hasAlpha: boolean): BinkPlaneGeometry {
    const yWidth = align16(Math.max(1, width));
    const yHeight = align16(Math.max(1, height));
    const cWidth = yWidth >> 1;
    const cHeight = yHeight >> 1;
    const ySize = yWidth * yHeight;
    const cSize = cWidth * cHeight;
    const yOffset = 0;
    const cROffset = ySize;
    const cBOffset = ySize + cSize;
    const aOffset = ySize + 2 * cSize;
    return {
        yWidth, yHeight, cWidth, cHeight, hasAlpha,
        yOffset, cROffset, cBOffset, aOffset,
        totalBytes: aOffset + (hasAlpha ? ySize : 0),
    };
}

/**
 * BGRA (the decoder's output) → planar Y/cR/cB (+A), BT.601 limited range.
 *
 * `dst` is a scratch block laid out by {@link binkPlaneGeometry}; the caller blits it into
 * guest memory in one go, because a per-byte write through the guest view costs ~40x.
 * Chroma is box-filtered over each 2x2 luma quad, which is what a 4:2:0 encoder does and
 * what the app's own upsampler expects to undo.
 */
export function bgraToBinkPlanes(
    bgra: Uint8Array,
    srcWidth: number,
    srcHeight: number,
    dst: Uint8Array,
    g: BinkPlaneGeometry,
): void {
    const { yWidth, yHeight, cWidth, cHeight, yOffset, cROffset, cBOffset, aOffset } = g;

    // Luma + alpha, one pass. Rows past the frame keep the padding the block was cleared
    // to, so the macroblock alignment never shows a stale edge.
    for (let y = 0; y < srcHeight && y < yHeight; y++) {
        let src = y * srcWidth * 4;
        let yd = yOffset + y * yWidth;
        let ad = aOffset + y * yWidth;
        for (let x = 0; x < srcWidth && x < yWidth; x++, src += 4, yd++, ad++) {
            const b = bgra[src], gr = bgra[src + 1], r = bgra[src + 2];
            dst[yd] = ((66 * r + 129 * gr + 25 * b + 128) >> 8) + 16;
            if (g.hasAlpha) dst[ad] = bgra[src + 3];
        }
    }

    // Chroma, box-filtered per 2x2 quad.
    const maxCx = Math.min(cWidth, (srcWidth + 1) >> 1);
    const maxCy = Math.min(cHeight, (srcHeight + 1) >> 1);
    for (let cy = 0; cy < maxCy; cy++) {
        const y0 = cy * 2;
        const y1 = Math.min(y0 + 1, srcHeight - 1);
        let crd = cROffset + cy * cWidth;
        let cbd = cBOffset + cy * cWidth;
        for (let cx = 0; cx < maxCx; cx++, crd++, cbd++) {
            const x0 = cx * 2;
            const x1 = Math.min(x0 + 1, srcWidth - 1);
            const p00 = (y0 * srcWidth + x0) * 4;
            const p01 = (y0 * srcWidth + x1) * 4;
            const p10 = (y1 * srcWidth + x0) * 4;
            const p11 = (y1 * srcWidth + x1) * 4;
            const b = (bgra[p00] + bgra[p01] + bgra[p10] + bgra[p11] + 2) >> 2;
            const gg = (bgra[p00 + 1] + bgra[p01 + 1] + bgra[p10 + 1] + bgra[p11 + 1] + 2) >> 2;
            const r = (bgra[p00 + 2] + bgra[p01 + 2] + bgra[p10 + 2] + bgra[p11 + 2] + 2) >> 2;
            dst[cbd] = ((-38 * r - 74 * gg + 112 * b + 128) >> 8) + 128;
            dst[crd] = ((112 * r - 94 * gg - 18 * b + 128) >> 8) + 128;
        }
    }
}
