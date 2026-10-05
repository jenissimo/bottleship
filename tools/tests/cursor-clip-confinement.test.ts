/**
 * ClipCursor's reduction to a confinement claim.
 *
 * A clip that covers the whole virtual screen confines nothing — wineserver's
 * is_cursor_clipped() is exactly `clip_rect != virtual_screen_rect`, and win32u tells the
 * driver to release its grab for such a rect ("we are clipping if the clip rectangle is
 * smaller than the screen"). Titles that pin the pointer to their own fullscreen window do
 * this constantly, and asking the host for a confining transport there would take the
 * mouse away from the user for nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { describePointerPolicy, resetPointerPolicy } from "../../src/worker/core/pointer-policy";
import { getVirtualScreenRect, setCursorClipRect, getCursorClipRect } from "../../src/worker/modules/user32/shared-state";

afterEach(() => {
    setCursorClipRect(null);
    resetPointerPolicy();
});

describe("ClipCursor → confinement claim", () => {
    test("a clip smaller than the screen is confinement", () => {
        EmulatorConfig.getInstance().screenResolution = { width: 1024, height: 768, bpp: 32, refreshRate: 60 };
        const screen = getVirtualScreenRect();
        expect(screen).toEqual({ left: 0, top: 0, right: 1024, bottom: 768 });

        const box = { left: 0, top: 0, right: 640, bottom: 480 };
        setCursorClipRect(box);
        const state = describePointerPolicy();
        expect(state.facts.clipped).toBe(true);
        expect(state.clipRect).toEqual(box);
        // The claim is made with a VISIBLE pointer — the two are unrelated.
        expect(state.outputs.pointerShown).toBe(true);
        expect(state.outputs.confinedRelative).toBe(true);
    });

    test("a clip covering the whole screen claims nothing, but still binds the pointer", () => {
        EmulatorConfig.getInstance().screenResolution = { width: 1024, height: 768, bpp: 32, refreshRate: 60 };
        const full = getVirtualScreenRect();
        setCursorClipRect({ ...full });
        expect(describePointerPolicy().facts.clipped).toBe(false);
        expect(describePointerPolicy().clipRect).toBeNull();
        // ClipCursor still recorded it: the clamp is what the guest reads back through
        // GetClipCursor, and Wine keeps the server-side rect even when it cannot grab.
        expect(getCursorClipRect()).toEqual(full);
    });

    test("releasing a real confinement withdraws the claim", () => {
        setCursorClipRect({ left: 10, top: 10, right: 100, bottom: 100 });
        expect(describePointerPolicy().facts.clipped).toBe(true);
        setCursorClipRect(null);
        expect(describePointerPolicy().facts.clipped).toBe(false);
        expect(describePointerPolicy().clipRect).toBeNull();
    });
});
