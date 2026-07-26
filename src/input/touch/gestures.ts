// Tunable thresholds for the touch gesture recognizer. Every magic number the
// state machine consults lives here, so a feel change is one file and one test
// run — never a literal buried in the recognizer.
//
// All distances are in the recognizer's coordinate space (guest px in "direct"
// mode, raw contact px in "trackpad"); all times are wall-clock ms.

/**
 * Window after the first contact in which a further contact SELECTS A BUTTON
 * (2nd → RMB, 3rd → MMB) instead of being an unrelated second finger. Past it,
 * extra contacts only feed the two-finger wheel gesture.
 */
export const ARBITRATION_MS = 80;

/** Movement before a contact counts as having moved at all. */
export const DRAG_SLOP_PX = 8;

/**
 * Slop crossed this soon after touchdown reads as "I meant to drag". Later and
 * slow it reads as a precision aim slide (REFINE) — which is what stops the
 * fingertip offset and the slop from turning every careful aim into a drag.
 */
export const DRAG_COMMIT_MS = 180;

/** px/ms. A flick is a drag however late it starts. */
export const FLICK_SPEED_PX_MS = 0.6;

/** A still contact is genuinely ambiguous; this is the standard resolution point. */
export const LONG_PRESS_MS = 500;

/**
 * Wall clock a synthesized button is held down before its release is published.
 * The SAB input transport is LEVEL-based with no edge queue: a down and an up
 * published inside one poll interval cancel out entirely and the guest never
 * observes the click. Same mechanism the harness `clickHold` verb exists for
 * (src/worker/harness/cmds/input.ts) — 64 ms covers a 15 fps state poller, and
 * the added latency lands on the up, where it is imperceptible.
 */
export const TAP_HOLD_MS = 64;

/** Cursor gain once a contact is in the precision aim slide. */
export const REFINE_GAIN = 0.35;

/**
 * Two-finger travel over which pan-vs-pinch is decided. Latched ONCE and held
 * for the life of the gesture — a fingers-on-glass gesture never stays purely
 * one or the other, so re-deciding per sample reads as noise.
 */
export const AXIS_LATCH_PX = 24;

/** Two-finger travel along the latched axis per emitted wheel notch. */
export const WHEEL_NOTCH_PX = 40;

/**
 * The published cursor sits above the contact point: a fingertip covers ~34
 * guest px and the era's hotspots are 10–20 px, so an un-offset cursor is
 * invisible under the finger that is aiming it.
 */
export const FINGER_OFFSET_Y_PX = -28;
