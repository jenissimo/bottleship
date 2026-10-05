// Touch feedback for on-screen controls.
//
// Glass has no travel and no click: without a pulse, a press that registered feels
// exactly like one that missed. Three channels, tried in order, because no single
// API covers the devices this runs on:
//
//   1. navigator.vibrate            — Android/Chromium. Precise, no user gesture.
//   2. a Safari `switch` control    — iOS has no Vibration API at all, but Safari
//                                     plays a system haptic when a checkbox with
//                                     the `switch` attribute toggles. Toggling a
//                                     hidden one is the only way to reach the Taptic
//                                     engine from a page. Feature-detected, since it
//                                     depends on the Safari version.
//   3. gamepad vibrationActuator    — when the press came from a physical pad, the
//                                     pad should rumble, not the screen.
//
// This is HOST feedback for HOST controls. Passing the GUEST's DirectInput force
// feedback effects through to a real pad is a separate feature living in the dinput
// HLE, not here.

export type HapticKind = "press" | "release" | "bump";

const MS: Record<HapticKind, number> = { press: 10, release: 6, bump: 18 };

let enabled = true;
let iosSwitch: HTMLInputElement | null | undefined;

export function setHapticsEnabled(on: boolean): void {
    enabled = on;
}

export function hapticsEnabled(): boolean {
    return enabled;
}

function supportsVibrate(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/**
 * A detached `<input type="checkbox" switch>`. `undefined` = not probed yet,
 * `null` = this browser does not implement the switch appearance, so toggling it
 * would be a no-op with a DOM cost.
 */
function getIosSwitch(): HTMLInputElement | null {
    if (iosSwitch !== undefined) return iosSwitch;
    if (typeof document === "undefined") return (iosSwitch = null);
    const el = document.createElement("input");
    el.type = "checkbox";
    // Reflected as a property only where the control is implemented.
    if (!("switch" in el)) return (iosSwitch = null);
    el.setAttribute("switch", "");
    el.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    document.body.appendChild(el);
    return (iosSwitch = el);
}

/** Fire host feedback for a control press. Cheap and best-effort by design. */
export function haptic(kind: HapticKind = "press"): void {
    if (!enabled) return;
    if (supportsVibrate()) {
        navigator.vibrate(MS[kind]);
        return;
    }
    const sw = getIosSwitch();
    if (sw) {
        // The haptic comes from the state CHANGE, so alternate rather than reset.
        sw.checked = !sw.checked;
        sw.dispatchEvent(new Event("change", { bubbles: false }));
    }
}

/**
 * Rumble a connected pad instead of the screen — right when the press came from
 * the physical device. `index` is the Gamepad index the host is reading.
 */
export function rumble(index: number, ms = 60, strong = 0.4, weak = 0.2): void {
    if (!enabled || typeof navigator === "undefined" || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[index];
    const actuator = (pad as (Gamepad & {
        vibrationActuator?: { playEffect?: (type: string, opts: Record<string, number>) => Promise<unknown> };
    }) | null)?.vibrationActuator;
    void actuator?.playEffect?.("dual-rumble", {
        duration: ms, strongMagnitude: strong, weakMagnitude: weak,
    })?.catch(() => { /* no actuator, or the pad went away mid-effect */ });
}

/** Drop the probe element (tests, teardown). */
export function resetHaptics(): void {
    iosSwitch?.remove();
    iosSwitch = undefined;
}
