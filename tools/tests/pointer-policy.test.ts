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

    test("confinement is relative only while no pointer is drawn", () => {
        expect(derivePointerOutputs({ ...BASE, clipped: true }).confinedRelative).toBe(false);
        expect(derivePointerOutputs({ ...BASE, clipped: true, win32Visible: false }).confinedRelative).toBe(true);
        // Suppression by DI makes the same confinement relative, with no ShowCursor call.
        expect(derivePointerOutputs({ ...BASE, clipped: true, exclusiveMouse: true }).confinedRelative).toBe(true);
    });
});

describe("pointer policy publication", () => {
    let visible: boolean[] = [];
    let captured: boolean[] = [];
    let clip: boolean[] = [];
    let warp: boolean[] = [];

    beforeEach(() => {
        const sys = System.getInstance();
        visible = []; captured = []; clip = []; warp = [];
        sys.setHostCursorVisibilityCallback((v) => visible.push(v));
        sys.setHostMouseCaptureCallback((v) => captured.push(v));
        sys.setHostCursorClipSignalCallback((v) => clip.push(v));
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

    test("suppression re-derives the confinement signal with no ClipCursor call", () => {
        setPointerClipped(true);
        expect(clip).toEqual([]);
        setExclusiveMouseOwner({}, true);
        expect(clip).toEqual([true]);
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
