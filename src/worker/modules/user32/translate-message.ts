/**
 * TranslateMessage: a WM_KEYDOWN / WM_SYSKEYDOWN that produces a character posts the
 * matching WM_CHAR / WM_SYSCHAR to the same window. The character is the one the press
 * typed on the HOST keyboard layout when its producer knows it, as a byte of the ANSI
 * code page; a press without one (on-screen keys, injected input) is read off the US
 * table. Shared by the guest's
 * own TranslateMessage call and the modal dialog loop, which runs it on the app's behalf
 * exactly as DialogBox's internal GetMessage/IsDialogMessage/TranslateMessage loop does.
 */
import { System } from '../../core/system';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { codePageToByteLut } from '../kernel32/codepage-lut';
import { KEY_TEXT_NONE, KEY_TEXT_UNKNOWN } from '../../../input/sab-layout';

const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_CHAR = 0x0102;
const WM_SYSCHAR = 0x0106;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_CAPITAL = 0x14;

const OEM_US: Record<number, [number, number]> = {
    0xBA: [0x3B, 0x3A], // ;  :
    0xBB: [0x3D, 0x2B], // =  +
    0xBC: [0x2C, 0x3C], // ,  <
    0xBD: [0x2D, 0x5F], // -  _
    0xBE: [0x2E, 0x3E], // .  >
    0xBF: [0x2F, 0x3F], // /  ?
    0xC0: [0x60, 0x7E], // `  ~
    0xDB: [0x5B, 0x7B], // [  {
    0xDC: [0x5C, 0x7C], // \  |
    0xDD: [0x5D, 0x7D], // ]  }
    0xDE: [0x27, 0x22], // '  "
};

export function vkToChar(vk: number, shiftDown: boolean, capsLock: boolean): number {
    const upper = shiftDown !== capsLock;
    if (vk >= 0x41 && vk <= 0x5A) return upper ? vk : (vk + 32);
    if (vk >= 0x30 && vk <= 0x39) return shiftDown ? ')!@#$%^&*('.charCodeAt(vk - 0x30) : vk;
    if (vk >= 0x60 && vk <= 0x69) return 0x30 + (vk - 0x60);
    if (vk === 0x6A) return 0x2A;
    if (vk === 0x6B) return 0x2B;
    if (vk === 0x6D) return 0x2D;
    if (vk === 0x6E) return 0x2E;
    if (vk === 0x6F) return 0x2F;
    if (vk === 0x20 || vk === 0x0D || vk === 0x08 || vk === 0x09 || vk === 0x1B) return vk;
    const oem = OEM_US[vk];
    if (oem) return shiftDown ? oem[1] : oem[0];
    return 0;
}

/** controlChar's answer for a key that has a control column but types nothing with Shift added. */
export const CONTROL_NONE = -2;

/**
 * The control character a key types with Ctrl down and Alt up; CONTROL_NONE when the key
 * types nothing; -1 when the key has no control column and types as without Ctrl.
 * Keyed by virtual key, like the US layout's own table (kbdus): Ctrl+A..Z are 0x01..0x1A
 * with or without Shift; [ \ ] (and the ISO key left of Z), Backspace, Esc, Enter, Space
 * and Break have a Ctrl column but no Ctrl+Shift column; 2, 6 and - have only a
 * Ctrl+Shift column. 0x00 (Ctrl+Shift+2) is a character, which is why "none" is not 0.
 */
export function controlChar(vk: number, shiftDown: boolean): number {
    if (vk >= 0x41 && vk <= 0x5A) return vk - 0x40;
    let column = -1;
    switch (vk) {
        case 0xDB: column = 0x1B; break;   // [
        case 0xDC: column = 0x1C; break;   // \
        case 0xDD: column = 0x1D; break;   // ]
        case 0xE2: column = 0x1C; break;   // VK_OEM_102, the ISO \ key
        case 0x08: column = 0x7F; break;   // Backspace
        case 0x1B: column = 0x1B; break;   // Esc
        case 0x0D: column = 0x0A; break;   // Enter
        case 0x20: column = 0x20; break;   // Space
        case 0x03: column = 0x03; break;   // VK_CANCEL (Ctrl+Break)
    }
    if (column >= 0) return shiftDown ? CONTROL_NONE : column;
    if (shiftDown) {
        if (vk === 0x32) return 0x00;   // 2
        if (vk === 0x36) return 0x1E;   // 6
        if (vk === 0xBD) return 0x1F;   // -
    }
    return -1;
}

/** A host-typed UTF-16 unit as the WM_CHAR byte of the ANSI code page; 0 when the page has no such character. */
export function hostTextToChar(unit: number): number {
    if (unit < 0x80) return unit;
    const lut = codePageToByteLut(EmulatorConfig.getInstance().ansiCodePage);
    const byte = lut ? lut[unit]! : 0xffff;
    return byte === 0xffff ? 0 : byte;
}

/**
 * The WM_CHAR code of a key-down whose press typed `text` (KEY_TEXT_*) on the host; 0 for
 * none. A host character the guest's ANSI code page cannot represent (a Cyrillic layout
 * over a cp1252 guest) is not typed as nothing: the key falls back to the US table, which
 * is also the layout the guest is told it has.
 */
export function keyDownChar(text: number, vk: number, shiftDown: boolean, capsLock: boolean): number {
    if (text === KEY_TEXT_NONE) return 0;
    if (text !== KEY_TEXT_UNKNOWN) {
        const hostChar = hostTextToChar(text);
        if (hostChar !== 0) return hostChar;
    }
    return vkToChar(vk, shiftDown, capsLock);
}

/** Returns true (TranslateMessage's TRUE) when a character message was posted. */
export function translateKeyMessage(hwnd: number, message: number, wParam: number, lParam: number): boolean {
    if (message !== WM_KEYDOWN && message !== WM_SYSKEYDOWN) return false;
    const input = System.getInstance().inputManager;
    const vk = wParam & 0xFF;
    const shiftDown = (input.getKeyState(VK_SHIFT) & 0x8000) !== 0;
    // Ctrl alone selects the control column; Ctrl+Alt is AltGr and types the layout's character.
    const ctrlOnly = (input.getKeyState(VK_CONTROL) & 0x8000) !== 0 && (input.getKeyState(VK_MENU) & 0x8000) === 0;
    let charCode = ctrlOnly ? controlChar(vk, shiftDown) : -1;
    if (charCode === CONTROL_NONE) return false;
    if (charCode < 0) {
        charCode = keyDownChar(input.getKeyDownText(vk), vk, shiftDown, (input.getKeyState(VK_CAPITAL) & 1) !== 0);
        if (charCode === 0) return false;
    }
    System.getInstance().windowManager.postMessage(hwnd, message === WM_SYSKEYDOWN ? WM_SYSCHAR : WM_CHAR, charCode, lParam);
    return true;
}
