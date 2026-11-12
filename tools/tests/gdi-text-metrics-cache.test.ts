import { beforeEach, describe, expect, test } from "bun:test";
import { invalidateTextExtentCache, measureTextMetricsCached, type TextMeasurer } from "../../src/worker/modules/gdi32/text-extent-cache";

const DEFAULTS = { ascent: 13, descent: 3, aveWidth: 8, maxWidth: 12 };

/** A canvas stand-in whose glyph size scales with the pixel size in its font string. */
function fakeCtx(font: string): TextMeasurer & { calls: number } {
    const px = Number(/(\d+)px/.exec(font)![1]);
    const ctx = {
        font,
        calls: 0,
        measureText(text: string) {
            ctx.calls++;
            return {
                width: text.length * px / 2,
                fontBoundingBoxAscent: px * 0.8,
                fontBoundingBoxDescent: px * 0.2,
                actualBoundingBoxLeft: 0,
                actualBoundingBoxRight: px / 2,
            };
        },
    };
    return ctx;
}

describe("GetTextMetrics measurement cache", () => {
    beforeEach(() => invalidateTextExtentCache());

    test("a repeat call for the same font does not measure again", () => {
        const ctx = fakeCtx("12px Arial");
        const first = measureTextMetricsCached(ctx, DEFAULTS);
        const calls = ctx.calls;
        expect(calls).toBeGreaterThan(200);
        expect(measureTextMetricsCached(ctx, DEFAULTS)).toEqual(first);
        expect(ctx.calls).toBe(calls);
        // A different canvas object with an identical font string shares the entry.
        const twin = fakeCtx("12px Arial");
        expect(measureTextMetricsCached(twin, DEFAULTS)).toEqual(first);
        expect(twin.calls).toBe(0);
    });

    test("values match a direct measurement", () => {
        const m = measureTextMetricsCached(fakeCtx("20px Arial"), DEFAULTS);
        expect(m).toEqual({ ascent: 16, descent: 4, aveWidth: 10, maxWidth: 10 });
    });

    test("different fonts do not share results", () => {
        const small = measureTextMetricsCached(fakeCtx("10px Arial"), DEFAULTS);
        const big = measureTextMetricsCached(fakeCtx("30px Arial"), DEFAULTS);
        expect(big.ascent).toBeGreaterThan(small.ascent);
        expect(measureTextMetricsCached(fakeCtx("10px Arial"), DEFAULTS)).toEqual(small);
        const bold = measureTextMetricsCached(fakeCtx("bold 10px Arial"), DEFAULTS);
        expect(bold).toEqual(small); // same fake geometry, but via its own entry:
        const ctx = fakeCtx("italic 10px Arial");
        measureTextMetricsCached(ctx, DEFAULTS);
        expect(ctx.calls).toBeGreaterThan(200);
    });

    test("invalidation (font added/removed) forces a re-measure", () => {
        const ctx = fakeCtx("12px Arial");
        measureTextMetricsCached(ctx, DEFAULTS);
        const calls = ctx.calls;
        invalidateTextExtentCache();
        measureTextMetricsCached(ctx, DEFAULTS);
        expect(ctx.calls).toBe(calls * 2);
    });

    test("a canvas that cannot measure yields defaults and is not cached", () => {
        let broken = true;
        const ctx: TextMeasurer = {
            font: "12px Arial",
            measureText(): never { throw new Error("no canvas"); },
        };
        expect(measureTextMetricsCached(ctx, DEFAULTS)).toEqual(DEFAULTS);
        const good = fakeCtx("12px Arial");
        expect(measureTextMetricsCached(good, DEFAULTS).ascent).toBe(10);
        void broken;
    });
});
describe("GetTextMetrics measures from the alphabetic baseline", () => {
    beforeEach(() => invalidateTextExtentCache());

    /** fontBoundingBoxAscent/Descent depend on the context's textBaseline, as on a real canvas. */
    function baselineCtx(font: string, textBaseline: string): TextMeasurer & { seen: string[] } {
        const px = Number(/(\d+)px/.exec(font)![1]);
        const ctx = {
            font,
            textBaseline,
            seen: [] as string[],
            measureText(text: string) {
                ctx.seen.push(ctx.textBaseline);
                const top = ctx.textBaseline === "top";
                return {
                    width: text.length * px / 2,
                    fontBoundingBoxAscent: top ? 0 : px * 0.8,
                    fontBoundingBoxDescent: top ? px : px * 0.2,
                    actualBoundingBoxLeft: 0,
                    actualBoundingBoxRight: px / 2,
                };
            },
        };
        return ctx;
    }

    test("a context drawing with 'top' still reports ascent and descent around the baseline", () => {
        const ctx = baselineCtx("20px Arial", "top");
        const m = measureTextMetricsCached(ctx, DEFAULTS);
        expect(m.ascent).toBe(16);
        expect(m.descent).toBe(4);
        expect(new Set(ctx.seen)).toEqual(new Set(["alphabetic"]));
        expect(ctx.textBaseline).toBe("top");
    });

    test("the baseline is restored when the measurement throws", () => {
        const ctx = baselineCtx("21px Arial", "top");
        ctx.measureText = () => { throw new Error("no metrics"); };
        expect(measureTextMetricsCached(ctx, DEFAULTS)).toEqual(DEFAULTS);
        expect(ctx.textBaseline).toBe("top");
    });
});
