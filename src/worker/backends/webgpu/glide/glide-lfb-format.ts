/**
 * Glide LFB write mode -> the mask descriptor the shared GPU unpacker speaks.
 *
 * The unpacker (shared/texture-converter.ts) is driven by a FormatInfo — bpp plus
 * channel masks — which is a pixel layout, not a DirectDraw type. Most Glide write
 * modes ARE one of those layouts, so the LFB image can be unpacked on the GPU
 * straight out of guest memory instead of walking it twice in JS.
 *
 * The ones that are not, this DECLINES BY NAME. That is the whole contract: an
 * unpacker that guesses at a layout it cannot express produces a plausible frame
 * in the wrong colours, and nothing downstream can tell. A decline costs a CPU
 * conversion; a wrong guess costs a bug nobody can see.
 */

import {
    GR_COLORFORMAT_ARGB,
    GR_LFBWRITEMODE_1555,
    GR_LFBWRITEMODE_1555_DEPTH,
    GR_LFBWRITEMODE_555,
    GR_LFBWRITEMODE_555_DEPTH,
    GR_LFBWRITEMODE_565,
    GR_LFBWRITEMODE_565_DEPTH,
    GR_LFBWRITEMODE_8888,
    GR_LFBWRITEMODE_888,
    GR_LFBWRITEMODE_ZA16,
} from "../../../modules/glide2x/constants";
import type { FormatInfo } from "../../../modules/ddraw/gpu-texture-utils";

export type LfbFormatDecision =
    | { ok: true; format: FormatInfo }
    | { ok: false; reason: string };

const RGB565: FormatInfo = { bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };
const RGB555: FormatInfo = { bpp: 16, rMask: 0x7c00, gMask: 0x03e0, bMask: 0x001f, aMask: 0 };
const ARGB1555: FormatInfo = { bpp: 16, rMask: 0x7c00, gMask: 0x03e0, bMask: 0x001f, aMask: 0x8000 };
const ARGB8888: FormatInfo = { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0xff000000 };
const XRGB8888: FormatInfo = { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0 };

/**
 * `bytesPerPixel` is the SURFACE's, which the presenter already resolved: a
 * *_DEPTH mode lays a 16-bit colour in a 32-bit slot, so the mode alone does not
 * say the stride.
 */
export function lfbFormatForGpuUnpack(
    writeMode: number,
    colorFormat: number,
    bytesPerPixel: number,
): LfbFormatDecision {
    const mode = writeMode | 0;

    // A *_DEPTH mode carries colour in the low half of a 32-bit word and depth in
    // the high half. The unpacker reads a whole element by bpp, so it would take
    // the depth bits as colour: the LAYOUT is expressible, the STRIDE is not.
    if (mode === GR_LFBWRITEMODE_565_DEPTH || mode === GR_LFBWRITEMODE_555_DEPTH ||
        mode === GR_LFBWRITEMODE_1555_DEPTH) {
        return { ok: false, reason: `write mode ${mode} packs 16-bit colour beside depth in a 32-bit element; the unpacker has no strided-element form` };
    }

    if (bytesPerPixel === 2) {
        switch (mode) {
            case GR_LFBWRITEMODE_555: return { ok: true, format: RGB555 };
            case GR_LFBWRITEMODE_1555: return { ok: true, format: ARGB1555 };
            case GR_LFBWRITEMODE_565: return { ok: true, format: RGB565 };
            case GR_LFBWRITEMODE_ZA16:
                // Depth/alpha only — every pixel is opaque black, which is a fill and
                // not a conversion. Sending it through a colour LUT would paint depth.
                return { ok: false, reason: "GR_LFBWRITEMODE_ZA16 carries no colour" };
            default:
                // The CPU decode treats an unrecognised 2-byte mode as 565. Guessing the
                // same way on the GPU would make the guess invisible; say it instead.
                return { ok: false, reason: `unrecognised 2-byte write mode ${mode}` };
        }
    }

    if (bytesPerPixel === 4) {
        // The 32-bit modes take their lane order from grLfbWriteColorFormat, and the
        // mask descriptor can only spell the ARGB one. ABGR/RGBA/BGRA are real Glide
        // states, so they are declined rather than mislabelled as ARGB.
        if ((colorFormat | 0) !== GR_COLORFORMAT_ARGB) {
            return { ok: false, reason: `grLfbWriteColorFormat ${colorFormat} is not ARGB; the mask descriptor cannot spell the other lane orders` };
        }
        if (mode === GR_LFBWRITEMODE_888) return { ok: true, format: XRGB8888 };
        if (mode === GR_LFBWRITEMODE_8888) return { ok: true, format: ARGB8888 };
        return { ok: false, reason: `unrecognised 4-byte write mode ${mode}` };
    }

    return { ok: false, reason: `unsupported LFB stride of ${bytesPerPixel} bytes per pixel` };
}
