import { describe, expect, test } from "bun:test";
import { internalFormatHasAlpha } from "../../src/worker/modules/opengl32/texture";
import {
    GL_RGB, GL_RGBA, GL_RGB5, GL_RGB8, GL_RGBA8, GL_RGB5_A1, GL_RGBA4,
    GL_R3_G3_B2, GL_RGB4, GL_RGB10, GL_RGB12, GL_RGB16,
    GL_LUMINANCE, GL_LUMINANCE8, GL_LUMINANCE_ALPHA, GL_LUMINANCE8_ALPHA8,
    GL_ALPHA, GL_ALPHA8,
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
    });
});
