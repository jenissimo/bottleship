import { KEY_TEXT_NONE, KEY_TEXT_UNKNOWN } from "../input/sab-layout";

const SIDE_MODIFIER_VK: Readonly<Record<string, number>> = {
    ShiftLeft: 0xa0,
    ShiftRight: 0xa1,
    ControlLeft: 0xa2,
    ControlRight: 0xa3,
    AltLeft: 0xa4,
    AltRight: 0xa5,
};

export function hardwareKeyVk(code: string, keyCode: number): number {
    return SIDE_MODIFIER_VK[code] ?? (keyCode & 0xff);
}

export interface HardwareKeyText {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    getModifierState(key: string): boolean;
}

/**
 * The UTF-16 unit a key-down types on the host layout, for the guest's WM_CHAR.
 * `key` is already resolved by the host: AltGr+Q is "@" on a German keyboard, Shift+2
 * is '"', a dead key is "Dead". AltGr arrives as Ctrl+Alt on Windows and is the one
 * modifier combination taken from `key`. Ctrl alone is a shortcut, and Alt alone never
 * changes the character on Windows (macOS Option does: Option+F is "ƒ", Option+E is
 * "Dead"), so both are left to the guest's table, as is Meta.
 */
export function hardwareKeyText(event: HardwareKeyText): number {
    const altGraph = event.getModifierState("AltGraph") || (event.ctrlKey && event.altKey);
    if (event.metaKey || ((event.ctrlKey || event.altKey) && !altGraph)) return KEY_TEXT_UNKNOWN;
    if (event.key === "Dead") return KEY_TEXT_NONE;
    if (event.key.length !== 1) return KEY_TEXT_UNKNOWN;
    const unit = event.key.charCodeAt(0);
    return unit === KEY_TEXT_NONE ? KEY_TEXT_UNKNOWN : unit;
}
