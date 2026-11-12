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
 * is '"', a dead key is "Dead". AltGr arrives as Ctrl+Alt on Windows, so only Ctrl
 * WITHOUT Alt (a shortcut, which types nothing of its own) is left to the guest's table.
 */
export function hardwareKeyText(event: HardwareKeyText): number {
    if (event.key === "Dead") return KEY_TEXT_NONE;
    if (event.key.length !== 1) return KEY_TEXT_UNKNOWN;
    if (event.metaKey) return KEY_TEXT_UNKNOWN;
    if (event.ctrlKey && !event.altKey && !event.getModifierState("AltGraph")) return KEY_TEXT_UNKNOWN;
    const unit = event.key.charCodeAt(0);
    return unit === KEY_TEXT_NONE ? KEY_TEXT_UNKNOWN : unit;
}
