/**
 * Diagnostic control tint: flood each system control with a per-hwnd colour so its
 * PAINTED extent can be measured off the overlay plane and compared with the rect the
 * guest declared.
 *
 * "The dialog sits crooked over the game frame" has three candidate causes a screenshot
 * cannot separate: the control's own layout (our DLU->px), the group's visual bounds, and
 * the composite's scale. The tint settles the first: it is stamped in the same call, with
 * the same clip, as the control's real paint, so the rect it leaves IS the rect we
 * painted. Armed by the harness `controlTint` verb, which also returns the expected rects.
 *
 * Its own module so the harness can name a colour without importing the paint module.
 */

const PALETTE = [
    '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8000', '#8000ff',
];

/** Stable per-window colour; the same hwnd always tints the same. */
export function controlTintColor(hwnd: number): string {
    return PALETTE[(hwnd >>> 0) % PALETTE.length]!;
}

export function isControlTintArmed(): boolean {
    return !!(globalThis as { __controlTint?: boolean }).__controlTint;
}

export function setControlTintArmed(on: boolean): void {
    (globalThis as { __controlTint?: boolean }).__controlTint = on;
}
