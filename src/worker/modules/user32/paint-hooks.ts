/**
 * Cross-module paint hooks, in a module with NO imports of its own.
 *
 * controls.ts and dialog-paint.ts sit in an import cycle, and dialog-paint registers
 * its hook while its own module body runs — which, depending on which side the cycle
 * is entered from, happens before controls.ts has evaluated a single statement. A
 * `let` living in controls.ts is still in its temporal dead zone at that moment, so
 * the registration throws. A leaf module is evaluated before either of them and has
 * no such window.
 */

/** Re-stamps modal popups floating above a window whose controls were repainted. */
let ownedPopupRestamper: ((hwnd: number) => void) | null = null;

export function registerOwnedPopupRestamper(fn: (hwnd: number) => void): void {
    ownedPopupRestamper = fn;
}

export function restampOwnedPopups(parentHwnd: number): void {
    ownedPopupRestamper?.(parentHwnd);
}
