// Whether the on-screen touch UI (control layer + HUD) should be on screen.
//
// Not a device sniff. Touch hardware is a NECESSARY condition, never a sufficient
// one: a laptop with a touchscreen, a tablet with a Bluetooth mouse and a desktop
// with a drawing tablet all report touch points while the player uses a mouse.
// So the deciding signal is the same one the rest of the input stack uses — what
// the last pointer actually was — with the media query only breaking the tie
// before anything has been touched at all.

import type { PointerKind } from "./pointer-kind";

export type { PointerKind };

export interface TouchUiSignals {
    /** navigator.maxTouchPoints. Zero means there is no touch UI to show, ever. */
    maxTouchPoints: number;
    /** The primary pointer is coarse — a phone or tablet with no mouse attached. */
    coarsePrimary: boolean;
    /** What last drove the app (see pointer-kind); null only if nothing ever has. */
    lastPointer: PointerKind | null;
    /** uiSettings.touchMode; "off" disables the whole touch path. */
    mode: "auto" | "direct" | "trackpad" | "off";
    /** The player collapsed the controls from the HUD. */
    hidden: boolean;
}

export function shouldShowTouchUi(s: TouchUiSignals): boolean {
    if (s.mode === "off") return false;
    if (s.hidden) return false;
    if (s.maxTouchPoints <= 0) return false;
    // A finger or pen has been used: show. A mouse has: hide — on a hybrid device
    // the controls would just cover the picture.
    if (s.lastPointer === "touch" || s.lastPointer === "pen") return true;
    if (s.lastPointer === "mouse") return false;
    // Nothing touched yet. On a coarse-primary device the controls have to be there
    // before the first contact, or there is nothing to aim at.
    return s.coarsePrimary;
}

/** The HUD is how a player un-hides the controls, so `hidden` must not hide it too. */
export function shouldShowTouchHud(s: TouchUiSignals): boolean {
    return shouldShowTouchUi({ ...s, hidden: false });
}

export function detectCoarsePrimary(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(pointer: coarse)").matches;
}
