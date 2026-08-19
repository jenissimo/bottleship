/**
 * The single owner of the two decisions the host acts on for the pointer:
 *   pointerShown  — does the host draw a pointer at all
 *   relative mouse — does the host want motion instead of position (Pointer Lock, touch deltas)
 *
 * Both are derived HERE, from one named set of guest facts, and republished together
 * whenever any fact moves. Deriving them apart is what let an exclusive-mode DirectInput
 * acquisition capture the mouse while an arrow stayed painted over the 3D view: capture
 * came from dinput and visibility from the ShowCursor counter, and neither knew about the
 * other.
 *
 * The facts are guest state; the outputs are a HOST override layered on top. Nothing here
 * writes back into the ShowCursor display count — that counter is guest-observable
 * (ShowCursor's return value, GetCursorInfo's CURSOR_SHOWING) and must read back exactly
 * what the app set.
 *
 * Windows semantics encoded in the derivation:
 *  - an ACQUIRED exclusive-mode DirectInput mouse hides and confines the system pointer for
 *    the duration, with no ShowCursor/ClipCursor call from the app;
 *  - a SOFTWARE D3D device cursor is a sprite the runtime composites into the frame, not the
 *    OS pointer, so nothing that hides the OS pointer hides it (wined3d device.c,
 *    dxvk d3d9_cursor.cpp); a HARDWARE one IS the OS pointer and follows it;
 *  - ClipCursor alone is ordinary windowed confinement, which keeps a visible pointer;
 *    confinement with NO visible pointer is what marks relative-mouse emulation.
 */
import { System } from "./system";

/** How the active D3D device cursor is realised, or "none" while no device drives one. */
export type DeviceCursorKind = "none" | "hardware" | "software";

export interface PointerFacts {
    /** user32: display count >= 0 AND a non-NULL SetCursor handle. */
    win32Visible: boolean;
    deviceCursor: DeviceCursorKind;
    /** user32 ClipCursor confinement is in force. */
    clipped: boolean;
    /** user32 recentre-burst detector: the app steers by warping the pointer back. */
    warping: boolean;
    /** At least one exclusive-mode DirectInput mouse is acquired. */
    exclusiveMouse: boolean;
}

export interface PointerOutputs {
    pointerShown: boolean;
    /** Relative-mouse claim from an exclusive DI acquisition. */
    captured: boolean;
    /** Relative-mouse claim from confinement with no pointer drawn. */
    confinedRelative: boolean;
    /** Relative-mouse claim from the recentre burst. */
    warping: boolean;
}

/** Pure derivation — the whole policy. Exercised directly by tools/tests/pointer-policy.test.ts. */
export function derivePointerOutputs(f: PointerFacts): PointerOutputs {
    const pointerShown = f.deviceCursor === "software"
        ? true
        : f.exclusiveMouse
            ? false
            : f.deviceCursor === "hardware" || f.win32Visible;
    return {
        pointerShown,
        captured: f.exclusiveMouse,
        confinedRelative: f.clipped && !pointerShown,
        warping: f.warping,
    };
}

// user32 starts with display count 0 and the default arrow installed, so the pointer is
// visible before any guest call.
const facts: PointerFacts = {
    win32Visible: true,
    deviceCursor: "none",
    clipped: false,
    warping: false,
    exclusiveMouse: false,
};

// Keyed by the DI device object, not a global flag: a process may hold several mouse
// devices, and the last one to Unacquire is what releases the claim.
const exclusiveMouseOwners = new Set<object>();

function publish(): void {
    const out = derivePointerOutputs(facts);
    const sys = System.getInstance();
    sys.requestHostCursorVisible(out.pointerShown);
    sys.requestHostMouseCapture(out.captured);
    sys.requestHostCursorClipSignal(out.confinedRelative);
    sys.requestHostCursorWarpMode(out.warping);
}

/**
 * The two visibility facts move together (user32's cursor sync pushes both), and they are
 * set as one so a half-applied pair cannot publish a pointer the policy never wanted.
 */
export function setPointerVisibilityFacts(win32Visible: boolean, deviceCursor: DeviceCursorKind): void {
    if (facts.win32Visible === win32Visible && facts.deviceCursor === deviceCursor) return;
    facts.win32Visible = win32Visible;
    facts.deviceCursor = deviceCursor;
    publish();
}

export function setPointerClipped(clipped: boolean): void {
    if (facts.clipped === clipped) return;
    facts.clipped = clipped;
    publish();
}

export function setPointerWarping(warping: boolean): void {
    if (facts.warping === warping) return;
    facts.warping = warping;
    publish();
}

/**
 * A DirectInput mouse device acquired (or released) an exclusive cooperative level.
 * Every path that ends an exclusive acquisition — Unacquire, a cooperative-level change,
 * final Release — must call this, or the pointer stays hidden for the rest of the run.
 */
export function setExclusiveMouseOwner(owner: object, active: boolean): void {
    const changed = active ? !exclusiveMouseOwners.has(owner) : exclusiveMouseOwners.delete(owner);
    if (active) exclusiveMouseOwners.add(owner);
    if (!changed) return;
    const next = exclusiveMouseOwners.size > 0;
    if (facts.exclusiveMouse === next) return;
    facts.exclusiveMouse = next;
    publish();
}

/** DirectInput teardown: the old process's device objects are gone with their claims. */
export function clearExclusiveMouseOwners(): void {
    if (exclusiveMouseOwners.size === 0) return;
    exclusiveMouseOwners.clear();
    facts.exclusiveMouse = false;
    publish();
}

/** Harness readout: the facts and what they derive to, in one place. */
export function describePointerPolicy(): { facts: PointerFacts; outputs: PointerOutputs; exclusiveMouseOwners: number } {
    return { facts: { ...facts }, outputs: derivePointerOutputs(facts), exclusiveMouseOwners: exclusiveMouseOwners.size };
}

/** Game switch. */
export function resetPointerPolicy(): void {
    exclusiveMouseOwners.clear();
    facts.win32Visible = true;
    facts.deviceCursor = "none";
    facts.clipped = false;
    facts.warping = false;
    facts.exclusiveMouse = false;
}
