/**
 * The emulated pad, described once.
 *
 * Its shape is fixed by what actually reaches the worker: the host publisher fills
 * INPUT_INDEX.gamepadAxis0..3 and a 16-bit button mask taken from the browser Gamepad
 * API's standard mapping (App.tsx pollGamepad), and InputManager hands both on
 * unchanged. Every API that describes the pad — DirectInput GetCapabilities /
 * EnumObjects, winmm JOYCAPS — must derive its counts from HERE, because two
 * independently written answers about one device are how a device-enumeration screen
 * ends up disagreeing with the device it enumerates.
 */

/** Axis slots the host publishes: left stick X/Y, right stick X/Y. */
export const GAMEPAD_AXES = 4;

/** Buttons the host publishes (standard mapping indices 0..15). */
export const GAMEPAD_BUTTONS = 16;

/** POV hats: the d-pad, reported as a hat as well as buttons 12..15. */
export const GAMEPAD_POVS = 1;

/** Standard-mapping d-pad button indices, in POV order. */
const DPAD_UP = 12, DPAD_DOWN = 13, DPAD_LEFT = 14, DPAD_RIGHT = 15;

/** DirectInput/winmm "hat centred" — the value both APIs read as "no direction". */
export const POV_CENTERED = 0xFFFFFFFF;

/**
 * D-pad bits → POV angle in hundredths of a degree (0 = up, clockwise), or
 * POV_CENTERED when nothing (or an opposing pair) is held. Deriving it is what makes
 * dwPOVs = 1 a fact rather than a claim: a hat we advertise but never move would send
 * a menu that navigates by hat into a dead end with no error anywhere.
 */
export function gamepadPovAngle(buttons: number): number {
    const up = (buttons & (1 << DPAD_UP)) !== 0;
    const down = (buttons & (1 << DPAD_DOWN)) !== 0;
    const left = (buttons & (1 << DPAD_LEFT)) !== 0;
    const right = (buttons & (1 << DPAD_RIGHT)) !== 0;
    const vert = (up ? 1 : 0) - (down ? 1 : 0);
    const horz = (right ? 1 : 0) - (left ? 1 : 0);
    if (vert === 0 && horz === 0) return POV_CENTERED;
    if (vert > 0) return horz > 0 ? 4500 : horz < 0 ? 31500 : 0;
    if (vert < 0) return horz > 0 ? 13500 : horz < 0 ? 22500 : 18000;
    return horz > 0 ? 9000 : 27000;
}
