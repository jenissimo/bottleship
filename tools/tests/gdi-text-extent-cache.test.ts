/**
 * GetTextExtentExPoint's per-character extents come from cached advances + pair kerning.
 * The result must equal measuring every prefix directly (what the uncached code did), while
 * costing measureText only for characters and pairs not seen before in that font.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { fontCellHeight, invalidateTextExtentCache, prefixWidths, type TextMeasurer } from "../../src/worker/modules/gdi32/text-extent-cache";

/** Per-font advances with a fractional part, plus a kerning table, like a real shaper. */
function fakeMeasurer(font: string, scale: number) {
    const kern: Record<string, number> = { AV: -1.3, To: -0.9, Wa: -0.6 };
    let calls = 0;
    const ctx: TextMeasurer & { calls(): number } = {
        font,
        measureText(text: string) {
            calls++;
            let w = 0;
            for (let i = 0; i < text.length; i++) {
                w += (5 + (text.charCodeAt(i) % 7) * 0.37) * scale;
                if (i > 0) w += (kern[text.slice(i - 1, i + 1)] ?? 0) * scale;
            }
            return { width: w, fontBoundingBoxAscent: 11.2 * scale, fontBoundingBoxDescent: 3.1 * scale };
        },
        calls: () => calls,
    };
    return ctx;
}

const direct = (ctx: TextMeasurer, text: string) =>
    Array.from(text, (_, i) => Math.round(ctx.measureText(text.slice(0, i + 1)).width));

describe("text-extent-cache", () => {
    beforeEach(() => invalidateTextExtentCache());

    test("prefix widths equal measuring each prefix, kerning included", () => {
        const text = "AVATAR Today Wave Diner Dash";
        const ctx = fakeMeasurer("12px Arial", 1);
        const out: number[] = [];
        const total = prefixWidths(ctx, text, out);
        expect(out).toEqual(direct(fakeMeasurer("12px Arial", 1), text));
        expect(total).toBe(out[text.length - 1]!);
    });

    test("a repeat call measures nothing; new text measures only new characters and pairs", () => {
        const ctx = fakeMeasurer("12px Arial", 1);
        prefixWidths(ctx, "Diner Dash", []);
        const warm = ctx.calls();
        prefixWidths(ctx, "Diner Dash", []);
        expect(ctx.calls()).toBe(warm);
        prefixWidths(ctx, "Dash Diner", []);
        // Same characters; the only pair not in "Diner Dash" is "h ".
        expect(ctx.calls() - warm).toBe(1);
    });

    test("cost is linear in the string, not quadratic", () => {
        const ctx = fakeMeasurer("12px Arial", 1);
        const text = "ab".repeat(500);
        prefixWidths(ctx, text, []);
        // two advances + "ab" and "ba" pairs, each measured once
        expect(ctx.calls()).toBe(4);
    });

    test("fonts are cached separately", () => {
        const small = fakeMeasurer("12px Arial", 1);
        const big = fakeMeasurer("24px Arial", 2);
        prefixWidths(small, "Flo", []);
        const out: number[] = [];
        prefixWidths(big, "Flo", out);
        expect(out).toEqual(direct(fakeMeasurer("24px Arial", 2), "Flo"));
    });

    test("invalidation drops cached widths (a font face was added or removed)", () => {
        const before = fakeMeasurer("12px Andy", 1);
        prefixWidths(before, "Flo", []);
        invalidateTextExtentCache();
        const after = fakeMeasurer("12px Andy", 1.5);
        const out: number[] = [];
        prefixWidths(after, "Flo", out);
        expect(out).toEqual(direct(fakeMeasurer("12px Andy", 1.5), "Flo"));
    });

    test("cell height is the font bounding box, cached per font", () => {
        const ctx = fakeMeasurer("12px Arial", 1);
        expect(fontCellHeight(ctx)).toBe(Math.ceil(11.2 + 3.1));
        const n = ctx.calls();
        fontCellHeight(ctx);
        expect(ctx.calls()).toBe(n);
    });
});
