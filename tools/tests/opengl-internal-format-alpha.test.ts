import { describe, expect, test } from "bun:test";
import { internalFormatHasAlpha, applyInternalFormatComponents as apply } from "../../src/worker/modules/opengl32/texture";
import {
    GL_RGB, GL_RGBA, GL_RGB5, GL_RGB8, GL_RGBA8, GL_RGB5_A1, GL_RGBA4,
    GL_R3_G3_B2, GL_RGB4, GL_RGB10, GL_RGB12, GL_RGB16,
    GL_LUMINANCE, GL_LUMINANCE8, GL_LUMINANCE_ALPHA, GL_LUMINANCE8_ALPHA8,
    GL_ALPHA, GL_ALPHA8, GL_INTENSITY, GL_INTENSITY8,
} from "../../src/worker/modules/opengl32/constants";

/**
 * The internal format — not the client format — decides whether a texture keeps
 * alpha. id Tech 3 cinematics (RE_StretchRaw) upload GL_RGBA client pixels with
 * A = 0 into `internalFormat = 3` (GL_RGB); the video is only visible because GL
 * discards that alpha and samples A = 1.
 */
describe("GL internal format alpha component", () => {
    test("bare component counts (GL 1.0 legacy)", () => {
        expect(internalFormatHasAlpha(1)).toBe(false); // luminance
        expect(internalFormatHasAlpha(2)).toBe(true);  // luminance + alpha
        expect(internalFormatHasAlpha(3)).toBe(false); // rgb — the cinematic path
        expect(internalFormatHasAlpha(4)).toBe(true);  // rgba
    });

    test("RGB-family formats drop alpha", () => {
        for (const f of [GL_RGB, GL_R3_G3_B2, GL_RGB4, GL_RGB5, GL_RGB8, GL_RGB10, GL_RGB12, GL_RGB16]) {
            expect(internalFormatHasAlpha(f)).toBe(false);
        }
    });

    test("RGBA-family formats keep alpha", () => {
        for (const f of [GL_RGBA, GL_RGBA8, GL_RGBA4, GL_RGB5_A1]) {
            expect(internalFormatHasAlpha(f)).toBe(true);
        }
    });

    test("luminance drops alpha, luminance-alpha and alpha keep it", () => {
        expect(internalFormatHasAlpha(GL_LUMINANCE)).toBe(false);
        expect(internalFormatHasAlpha(GL_LUMINANCE8)).toBe(false);
        expect(internalFormatHasAlpha(GL_LUMINANCE_ALPHA)).toBe(true);
        expect(internalFormatHasAlpha(GL_LUMINANCE8_ALPHA8)).toBe(true);
        expect(internalFormatHasAlpha(GL_ALPHA)).toBe(true);
        expect(internalFormatHasAlpha(GL_ALPHA8)).toBe(true);
        expect(internalFormatHasAlpha(GL_INTENSITY)).toBe(true);
    });
});

/**
 * Alpha is only half of GL 1.x §3.8.7: the internal format also decides what RGB
 * samples as. A game building an alpha mask with internalFormat = GL_ALPHA and
 * format = GL_RGBA must get a black-with-alpha mask, not its source image in colour.
 */
describe("GL internal format component substitution", () => {
    /** One RGBA texel through the upload-time substitution. */
    const texel = (rgba: number[], internalFormat: number): number[] => {
        const data = new Uint8Array(rgba);
        apply(data, internalFormat);
        return Array.from(data);
    };

    test("RGBA keeps every component", () => {
        expect(texel([10, 20, 30, 40], GL_RGBA)).toEqual([10, 20, 30, 40]);
    });

    test("RGB drops alpha and samples A = 1", () => {
        expect(texel([10, 20, 30, 0], GL_RGB)).toEqual([10, 20, 30, 255]);
        expect(texel([10, 20, 30, 0], 3)).toEqual([10, 20, 30, 255]);
    });

    test("ALPHA keeps alpha and samples RGB = 0", () => {
        expect(texel([10, 20, 30, 40], GL_ALPHA)).toEqual([0, 0, 0, 40]);
        expect(texel([255, 255, 255, 128], GL_ALPHA8)).toEqual([0, 0, 0, 128]);
    });

    test("LUMINANCE replicates one value into RGB and samples A = 1", () => {
        expect(texel([77, 20, 30, 0], GL_LUMINANCE)).toEqual([77, 77, 77, 255]);
        expect(texel([77, 20, 30, 0], 1)).toEqual([77, 77, 77, 255]);
        expect(texel([77, 20, 30, 5], GL_LUMINANCE8)).toEqual([77, 77, 77, 255]);
    });

    test("LUMINANCE_ALPHA replicates into RGB and keeps alpha", () => {
        expect(texel([77, 20, 30, 40], GL_LUMINANCE_ALPHA)).toEqual([77, 77, 77, 40]);
        expect(texel([77, 20, 30, 40], GL_LUMINANCE8_ALPHA8)).toEqual([77, 77, 77, 40]);
    });

    test("INTENSITY feeds all four components from the one stored value", () => {
        expect(texel([77, 20, 30, 40], GL_INTENSITY)).toEqual([77, 77, 77, 77]);
        expect(texel([77, 20, 30, 40], GL_INTENSITY8)).toEqual([77, 77, 77, 77]);
    });

    test("substitution is per texel, not per buffer", () => {
        const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        apply(data, GL_ALPHA);
        expect(Array.from(data)).toEqual([0, 0, 0, 4, 0, 0, 0, 8]);
    });
});
