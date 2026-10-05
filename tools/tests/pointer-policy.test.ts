/**
 * Pointer policy: one derivation for "does the host draw a pointer" and "does the host
 * want relative mouse". The two used to be derived by different code from different state,
 * which is how an exclusive-mode DirectInput acquisition captured the mouse while the
 * guest-cursor overlay kept painting an arrow over the 3D view.
 *
 * Both halves are covered: the pure derivation, and the published transport (through
 * System, whose callbacks the worker turns into host messages) so a lifecycle path that
 * strands the claim fails here rather than on a game.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import {
    clearExclusiveMouseOwners,
    derivePointerOutputs,
    describePointerPolicy,
    resetPointerPolicy,
    setExclusiveMouseOwner,
    setPointerClipped,
    setPointerVisibilityFacts,
    setPointerWarping,
    type PointerFacts,
} from "../../src/worker/core/pointer-policy";

const BASE: PointerFacts = {
    win32Visible: true,
    deviceCursor: "none",
    clipped: false,
    warping: false,
    exclusiveMouse: false,
};

describe("pointer policy derivation", () => {
    test("an acquired exclusive DI mouse hides the pointer without touching the guest count", () => {
        const out = derivePointerOutputs({ ...BASE, exclusiveMouse: true });
        expect(out.pointerShown).toBe(false);
        expect(out.captured).toBe(true);
    });

    test("a SOFTWARE device cursor is a sprite, so DI suppression does not hide it", () => {
        expect(derivePointerOutputs({ ...BASE, deviceCursor: "software", exclusiveMouse: true }).pointerShown)
            .toBe(true);
    });

    test("a HARDWARE device cursor is the OS pointer, so DI suppression hides it", () => {
        expect(derivePointerOutputs({ ...BASE, deviceCursor: "hardware", exclusiveMouse: true }).pointerShown)
            .toBe(false);
    });

    test("a hardware device cursor outranks a hidden Win32 pointer", () => {
        expect(derivePointerOutputs({ ...BASE, win32Visible: false, deviceCursor: "hardware" }).pointerShown)
            .toBe(true);
    });

    /**
     * A D3D device in exclusive fullscreen does NOT suppress the Win32 pointer. Neither
     * wined3d nor DXVK touches the cursor on the fullscreen transition
     * (wined3d_swapchain_state_setup_fullscreen / d3d9_swapchain.cpp EnterFullscreenMode
     * make no cursor call), and both realise a 32x32 device cursor AS the OS cursor with
     * ::SetCursor precisely because Windows composites it over the fullscreen frame.
     * Measured the same way on a real box: a fullscreen D3D9 title shows the system arrow
     * unless something else hides it — the app's ShowCursor count, an exclusive DirectInput
     * acquisition, or a window class registered with hCursor NULL.
     *
     * So the presenter's mode is not an input here, and adding it would blank the pointer
     * for every fullscreen title that legitimately relies on the class arrow.
     */
    test("nothing about a fullscreen presenter is an input to the derivation", () => {
        // The whole fact set — if a fullscreen fact is ever added it has to appear here.
        expect(Object.keys(BASE).sort())
            .toEqual(["clipped", "deviceCursor", "exclusiveMouse", "warping", "win32Visible"]);
        // A fullscreen guest that hides nothing keeps its pointer.
        expect(derivePointerOutputs(BASE).pointerShown).toBe(true);
        // ...and the app's own suppression is what takes it away.
        expect(derivePointerOutputs({ ...BASE, win32Visible: false }).pointerShown).toBe(false);
    });

    /**
     * ClipCursor confines whether or not a pointer is drawn. In the wineserver the show
     * count and the clip rect are disjoint fields written by disjoint request flags
     * (SET_CURSOR_COUNT vs SET_CURSOR_CLIP; set_clip_rectangle never reads the count), and
     * the X11 driver's real pointer grab is gated on focus / XInput2 / the rect being
     * smaller than the screen — never on visibility. Requiring a hidden pointer dropped the
     * commonest use of ClipCursor (a visible pointer held inside a window's client area):
     * the guest clamped its pointer at the clip edge while the host's kept travelling, so
     * everything outside the box was dead and coming back had to retrace the whole drift.
     */
    test("confinement does not depend on whether a pointer is drawn", () => {
        expect(derivePointerOutputs({ ...BASE, clipped: true }).confinedRelative).toBe(true);
        expect(derivePointerOutputs({ ...BASE, clipped: true }).pointerShown).toBe(true);
        expect(derivePointerOutputs({ ...BASE, clipped: true, win32Visible: false }).confinedRelative).toBe(true);
        // Suppression by DI is the same confinement, with no ShowCursor call.
        expect(derivePointerOutputs({ ...BASE, clipped: true, exclusiveMouse: true }).confinedRelative).toBe(true);
        // ...and no confinement is claimed without a clip, however the pointer is drawn.
        expect(derivePointerOutputs({ ...BASE, win32Visible: false }).confinedRelative).toBe(false);
        expect(derivePointerOutputs({ ...BASE, exclusiveMouse: true }).confinedRelative).toBe(false);
    });
});

const BOX = { left: 0, top: 0, right: 640, bottom: 480 };

describe("pointer policy publication", () => {
    let visible: boolean[] = [];
    let captured: boolean[] = [];
    let clip: boolean[] = [];
    let clipRects: Array<typeof BOX | null> = [];
    let warp: boolean[] = [];

    beforeEach(() => {
        const sys = System.getInstance();
        visible = []; captured = []; clip = []; clipRects = []; warp = [];
        sys.setHostCursorVisibilityCallback((v) => visible.push(v));
        sys.setHostMouseCaptureCallback((v) => captured.push(v));
        sys.setHostCursorClipSignalCallback((v, r) => { clip.push(v); clipRects.push(r); });
        sys.setHostCursorWarpModeCallback((v) => warp.push(v));
        resetPointerPolicy();
        // System dedups per value; force a known baseline so the assertions below read
        // transitions, not the first publish of a fresh process.
        setPointerVisibilityFacts(false, "none");
        setPointerVisibilityFacts(true, "none");
        visible = []; captured = []; clip = []; warp = [];
    });

    afterEach(() => {
        resetPointerPolicy();
    });

    test("acquire hides the pointer and captures; unacquire restores both", () => {
        const device = {};
        setExclusiveMouseOwner(device, true);
        expect(visible).toEqual([false]);
        expect(captured).toEqual([true]);
        setExclusiveMouseOwner(device, false);
        expect(visible).toEqual([false, true]);
        expect(captured).toEqual([true, false]);
    });

    test("the claim survives one of two devices releasing it", () => {
        const a = {}, b = {};
        setExclusiveMouseOwner(a, true);
        setExclusiveMouseOwner(b, true);
        setExclusiveMouseOwner(a, false);
        expect(describePointerPolicy().facts.exclusiveMouse).toBe(true);
        expect(visible).toEqual([false]);
        setExclusiveMouseOwner(b, false);
        expect(visible).toEqual([false, true]);
    });

    test("device teardown releases a claim its owner never gave back", () => {
        setExclusiveMouseOwner({}, true);
        expect(visible).toEqual([false]);
        clearExclusiveMouseOwners();
        expect(visible).toEqual([false, true]);
    });

    /**
     * The host cannot confine a pointer it cannot locate: Pointer Lock is not always
     * granted (refused, released with Esc, an unfocused window), and the fallback needs
     * the same rect the guest clamps to or the two pointers drift apart. So the rect
     * travels with the claim and is withdrawn with it.
     */
    test("the claim carries the rect the host must confine to, and drops it on release", () => {
        setPointerClipped(BOX);
        expect(clip).toEqual([true]);
        expect(clipRects).toEqual([BOX]);
        setPointerClipped(null);
        expect(clip).toEqual([true, false]);
        expect(clipRects).toEqual([BOX, null]);
    });

    test("a moved clip republishes the rect under an unchanged claim", () => {
        setPointerClipped(BOX);
        setPointerClipped({ left: 10, top: 20, right: 300, bottom: 200 });
        expect(clip).toEqual([true, true]);
        expect(clipRects[1]).toEqual({ left: 10, top: 20, right: 300, bottom: 200 });
        // ...and an identical re-clip is not a transition.
        setPointerClipped({ left: 10, top: 20, right: 300, bottom: 200 });
        expect(clip).toEqual([true, true]);
    });

    test("a visible pointer does not withhold the confinement signal", () => {
        expect(describePointerPolicy().outputs.pointerShown).toBe(true);
        setPointerClipped(BOX);
        expect(clip).toEqual([true]);
        // ...and hiding it afterwards changes nothing about the claim.
        setPointerVisibilityFacts(false, "none");
        expect(clip).toEqual([true]);
    });

    test("a game switch withdraws a confinement the guest never released", () => {
        setPointerClipped(BOX);
        expect(describePointerPolicy().clipRect).toEqual(BOX);
        resetPointerPolicy();
        expect(describePointerPolicy().facts.clipped).toBe(false);
        expect(describePointerPolicy().clipRect).toBeNull();
    });

    test("a software device cursor stays drawn under an exclusive acquisition", () => {
        setExclusiveMouseOwner({}, true);
        expect(visible).toEqual([false]);
        setPointerVisibilityFacts(true, "software");
        expect(visible).toEqual([false, true]);
    });

    test("warp mode is published through the same owner", () => {
        setPointerWarping(true);
        expect(warp).toEqual([true]);
        setPointerWarping(false);
        expect(warp).toEqual([true, false]);
    });
});
