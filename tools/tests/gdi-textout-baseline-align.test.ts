/**
 * TextOut with TA_BASELINE: the reference point's y is the alphabetic baseline of the text.
 *
 * The canvas is drawn with textBaseline 'top', and a TextMetrics measured in that state
 * reports the sliver above the em box as fontBoundingBoxAscent, not the font's ascent.
 * A title that lays its labels out as `rect.top + tmAscent` with TA_BASELINE had every
 * label drawn an ascent too low, cut off by its own clip rectangle.
 */
import { describe, expect, test } from "bun:test";
import { textOut } from "../../src/worker/modules/gdi32/gdi-text";
import { fontBaselineDrop } from "../../src/worker/modules/gdi32/text-extent-cache";
import type { GDIContext } from "../../src/worker/modules/gdi32/context";

const ALPHABETIC_ASCENT = 9, TOP_ASCENT = 1.25;

function fakeCanvas(font: string) {
    const drawn: Array<{ text: string; x: number; y: number; baseline: string }> = [];
    const ctx = {
        font, fillStyle: "#000", textAlign: "left", textBaseline: "top", canvas: {},
        measureText: (text: string) => ({
            width: text.length * 6, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 6,
            fontBoundingBoxAscent: ctx.textBaseline === "alphabetic" ? ALPHABETIC_ASCENT : TOP_ASCENT,
            fontBoundingBoxDescent: ctx.textBaseline === "alphabetic" ? 2 : 9.75,
        }),
        fillText: (text: string, x: number, y: number) => drawn.push({ text, x, y, baseline: ctx.textBaseline }),
    };
    return { ctx, drawn };
}

function draw(textAlign: number, font: string) {
    const HDC = 0x20001;
    const { ctx, drawn } = fakeCanvas(font);
    const state = {
        font, appliedFont: font, textColor: "#fff", appliedFillStyle: "#fff", textColorValue: 0xffffff,
        textAlign, fontSize: 10, fontQuality: 0, textEscapement: 0, bkMode: 1, bkColor: "#000", hBitmap: 0,
    };
    const gdi = {
        contexts: new Map([[HDC, ctx]]), hdcStates: new Map([[HDC, state]]), overlayCtx: null,
        setOverlayDirty() {}, getCurrentPosition: () => ({ x: 0, y: 0 }), setCurrentPosition() {},
        beginClipOn: () => false, clipCopyRect: () => null, expandDirtyRect() {}, markDirty() {},
        invalidateImageDataCache() {},
    };
    expect(textOut(gdi as unknown as GDIContext, HDC, 100, 50, "Party")).toBe(true);
    return drawn;
}

describe("TextOut vertical alignment", () => {
    test("TA_BASELINE puts the alphabetic baseline on the reference point", () => {
        const drawn = draw(0x18, "10px baseline-test-a");
        // Drawn from the 'top' baseline, which sits (9 - 1.25) above the alphabetic one.
        expect(drawn).toEqual([{ text: "Party", x: 100, y: 50 - (ALPHABETIC_ASCENT - TOP_ASCENT), baseline: "top" }]);
    });

    test("TA_TOP is unchanged", () => {
        expect(draw(0, "10px baseline-test-b")).toEqual([{ text: "Party", x: 100, y: 50, baseline: "top" }]);
    });

    test("the measurement is taken once per font and leaves the context's baseline alone", () => {
        const { ctx } = fakeCanvas("10px baseline-test-c");
        let measured = 0;
        const inner = ctx.measureText;
        ctx.measureText = (t: string) => { measured++; return inner(t); };
        expect(fontBaselineDrop(ctx)).toBe(ALPHABETIC_ASCENT - TOP_ASCENT);
        expect(ctx.textBaseline).toBe("top");
        const after = measured;
        for (let i = 0; i < 50; i++) fontBaselineDrop(ctx);
        expect(measured).toBe(after);
    });
});
