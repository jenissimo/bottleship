import { describe, expect, test } from "bun:test";
import {
    GR_COLORFORMAT_ABGR,
    GR_COLORFORMAT_ARGB,
    GR_COLORFORMAT_BGRA,
    GR_COLORFORMAT_RGBA,
    swizzleGlideColor,
} from "../../src/worker/modules/glide2x/constants";

// Four distinguishable bytes: any two channels swapped changes the result, and every
// byte is distinct from every shifted copy of another, so a wrong shift cannot alias.
const A = 0x12, R = 0x34, G = 0x56, B = 0x78;

/** Pack four named bytes MSB-first, i.e. the order the format's NAME spells out. */
const pack = (b0: number, b1: number, b2: number, b3: number) =>
    (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0);

/** What every consumer downstream of the swizzle reads (unpackColorU32, the WGSL combine). */
const ARGB = pack(A, R, G, B);

describe("swizzleGlideColor", () => {
    // Expectations are stated as "this format's byte order, normalised to ARGB" —
    // derived from _grSwizzleColor (glide2x/cvg/glide/src/diglide.c:220), not transcribed
    // from our shifts, so a matching bug in both cannot pass.
    test.each([
        ["ARGB", GR_COLORFORMAT_ARGB, pack(A, R, G, B)],
        ["ABGR", GR_COLORFORMAT_ABGR, pack(A, B, G, R)],
        ["RGBA", GR_COLORFORMAT_RGBA, pack(R, G, B, A)],
        ["BGRA", GR_COLORFORMAT_BGRA, pack(B, G, R, A)],
    ])("normalises %s to ARGB", (_name, format, packedInThatFormat) => {
        expect(swizzleGlideColor(packedInThatFormat, format)).toBe(ARGB);
    });

    test("ARGB is the identity for any word", () => {
        for (const c of [0x00000000, 0xffffffff, 0xdeadbeef, 0x80402010]) {
            expect(swizzleGlideColor(c, GR_COLORFORMAT_ARGB)).toBe(c >>> 0);
        }
    });

    test("every format round-trips the high bit — no sign leak through the shifts", () => {
        // 0x80.. words are where a >> instead of >>> shows up as a negative result.
        for (const format of [GR_COLORFORMAT_ARGB, GR_COLORFORMAT_ABGR, GR_COLORFORMAT_RGBA, GR_COLORFORMAT_BGRA]) {
            const out = swizzleGlideColor(0xff804020, format);
            expect(out).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(out)).toBe(true);
        }
    });

    test("an unknown format passes the word through rather than corrupting it", () => {
        expect(swizzleGlideColor(ARGB, 0x7f)).toBe(ARGB);
    });
});
