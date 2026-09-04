import { describe, expect, test } from "bun:test";
import { lfbFormatForGpuUnpack } from "../../src/worker/backends/webgpu/glide/glide-lfb-format";
import { detectPixelFormat, PixelFormat } from "../../src/worker/modules/ddraw/gpu-texture-utils";
import {
    GR_COLORFORMAT_ABGR,
    GR_COLORFORMAT_ARGB,
    GR_COLORFORMAT_BGRA,
    GR_COLORFORMAT_RGBA,
    GR_LFBWRITEMODE_1555,
    GR_LFBWRITEMODE_1555_DEPTH,
    GR_LFBWRITEMODE_555,
    GR_LFBWRITEMODE_555_DEPTH,
    GR_LFBWRITEMODE_565,
    GR_LFBWRITEMODE_565_DEPTH,
    GR_LFBWRITEMODE_8888,
    GR_LFBWRITEMODE_888,
    GR_LFBWRITEMODE_ZA16,
} from "../../src/worker/modules/glide2x/constants";

/**
 * The mapping's job is to be right or to say it cannot be. A descriptor that the
 * unpacker's own classifier then calls UNKNOWN would paint magenta; a descriptor
 * for a layout Glide did not mean would paint the wrong colours silently. Both
 * are checked here, against the SAME classifier the shader generator uses.
 */
describe("glide LFB write mode -> GPU unpack format", () => {
    test("every accepted mode classifies as the pixel format it means", () => {
        const cases: Array<[number, number, number, PixelFormat]> = [
            [GR_LFBWRITEMODE_565, GR_COLORFORMAT_ARGB, 2, PixelFormat.RGB565],
            [GR_LFBWRITEMODE_555, GR_COLORFORMAT_ARGB, 2, PixelFormat.RGB555],
            [GR_LFBWRITEMODE_1555, GR_COLORFORMAT_ARGB, 2, PixelFormat.ARGB1555],
            [GR_LFBWRITEMODE_888, GR_COLORFORMAT_ARGB, 4, PixelFormat.XRGB8888],
            [GR_LFBWRITEMODE_8888, GR_COLORFORMAT_ARGB, 4, PixelFormat.ARGB8888],
        ];
        for (const [mode, fmt, bpp, expected] of cases) {
            const d = lfbFormatForGpuUnpack(mode, fmt, bpp);
            expect(d.ok).toBe(true);
            if (!d.ok) continue;
            // The classifier is what picks the shader, so agreeing with it is the
            // property that matters — not that the masks look plausible.
            expect(detectPixelFormat(d.format)).toBe(expected);
        }
    });

    test("the modes the descriptor cannot spell are declined by name, not guessed", () => {
        const declined: Array<[string, number, number, number]> = [
            ["565_DEPTH", GR_LFBWRITEMODE_565_DEPTH, GR_COLORFORMAT_ARGB, 4],
            ["555_DEPTH", GR_LFBWRITEMODE_555_DEPTH, GR_COLORFORMAT_ARGB, 4],
            ["1555_DEPTH", GR_LFBWRITEMODE_1555_DEPTH, GR_COLORFORMAT_ARGB, 4],
            ["ZA16", GR_LFBWRITEMODE_ZA16, GR_COLORFORMAT_ARGB, 2],
            ["unknown 2-byte", 0x7a, GR_COLORFORMAT_ARGB, 2],
            ["unknown 4-byte", 0x7b, GR_COLORFORMAT_ARGB, 4],
            ["odd stride", GR_LFBWRITEMODE_565, GR_COLORFORMAT_ARGB, 3],
        ];
        for (const [name, mode, fmt, bpp] of declined) {
            const d = lfbFormatForGpuUnpack(mode, fmt, bpp);
            expect(d.ok, `${name} must be declined`).toBe(false);
            if (d.ok) continue;
            expect(d.reason.length, `${name} must say why`).toBeGreaterThan(10);
        }
    });

    test("a 32-bit mode in a non-ARGB lane order is declined, not mislabelled as ARGB", () => {
        // These are real grLfbWriteColorFormat states. A mask descriptor has no way
        // to spell them, and calling them ARGB swaps R and B on the whole image.
        for (const fmt of [GR_COLORFORMAT_ABGR, GR_COLORFORMAT_RGBA, GR_COLORFORMAT_BGRA]) {
            for (const mode of [GR_LFBWRITEMODE_888, GR_LFBWRITEMODE_8888]) {
                const d = lfbFormatForGpuUnpack(mode, fmt, 4);
                expect(d.ok, `mode ${mode} colorFormat ${fmt} must be declined`).toBe(false);
            }
        }
    });

    test("the 16-bit modes ignore the colour format, as Glide does", () => {
        // grLfbWriteColorFormat configures 32-bit lane mapping only; a 565 surface is
        // 565 whatever it says. Declining those on lane order would give up the whole
        // hot path for nothing.
        for (const fmt of [GR_COLORFORMAT_ARGB, GR_COLORFORMAT_ABGR, GR_COLORFORMAT_RGBA, GR_COLORFORMAT_BGRA]) {
            const d = lfbFormatForGpuUnpack(GR_LFBWRITEMODE_565, fmt, 2);
            expect(d.ok).toBe(true);
            if (d.ok) expect(detectPixelFormat(d.format)).toBe(PixelFormat.RGB565);
        }
    });
});
