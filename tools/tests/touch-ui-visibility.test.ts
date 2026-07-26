// Showing thumb controls to someone holding a mouse is worse than not shipping
// them: they cover the picture and answer a question nobody asked.

import { describe, expect, test } from "bun:test";
import {
    shouldShowTouchHud, shouldShowTouchUi, type TouchUiSignals,
} from "../../src/input/touch-ui-visibility";

const phone: TouchUiSignals = {
    maxTouchPoints: 5, coarsePrimary: true, lastPointer: null, mode: "auto", hidden: false,
};
const desktop: TouchUiSignals = {
    maxTouchPoints: 0, coarsePrimary: false, lastPointer: "mouse", mode: "auto", hidden: false,
};
const hybrid: TouchUiSignals = {
    maxTouchPoints: 10, coarsePrimary: false, lastPointer: null, mode: "auto", hidden: false,
};

describe("touch UI visibility", () => {
    test("a phone shows controls before anything is touched", () => {
        expect(shouldShowTouchUi(phone)).toBe(true);
    });

    test("a mouse-only desktop never shows them", () => {
        expect(shouldShowTouchUi(desktop)).toBe(false);
        expect(shouldShowTouchUi({ ...desktop, lastPointer: null })).toBe(false);
    });

    test("a touch laptop waits for an actual finger", () => {
        expect(shouldShowTouchUi(hybrid)).toBe(false);
        expect(shouldShowTouchUi({ ...hybrid, lastPointer: "touch" })).toBe(true);
        expect(shouldShowTouchUi({ ...hybrid, lastPointer: "pen" })).toBe(true);
    });

    test("picking the mouse back up hides them again", () => {
        expect(shouldShowTouchUi({ ...phone, lastPointer: "touch" })).toBe(true);
        expect(shouldShowTouchUi({ ...phone, lastPointer: "mouse" })).toBe(false);
    });

    test("mode off wins over everything", () => {
        expect(shouldShowTouchUi({ ...phone, lastPointer: "touch", mode: "off" })).toBe(false);
        expect(shouldShowTouchHud({ ...phone, lastPointer: "touch", mode: "off" })).toBe(false);
    });

    test("hiding the controls keeps the HUD — it is the way back", () => {
        const hidden = { ...phone, lastPointer: "touch" as const, hidden: true };
        expect(shouldShowTouchUi(hidden)).toBe(false);
        expect(shouldShowTouchHud(hidden)).toBe(true);
    });

    test("no touch hardware means no HUD either", () => {
        expect(shouldShowTouchHud(desktop)).toBe(false);
    });
});
