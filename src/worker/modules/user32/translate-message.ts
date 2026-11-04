/**
 * TranslateMessage: a WM_KEYDOWN / WM_SYSKEYDOWN that produces a character posts the
 * matching WM_CHAR / WM_SYSCHAR to the same window (US layout). Shared by the guest's
 * own TranslateMessage call and the modal dialog loop, which runs it on the app's behalf
 * exactly as DialogBox's internal GetMessage/IsDialogMessage/TranslateMessage loop does.
 */
import { System } from '../../core/system';

const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_CHAR = 0x0102;
const WM_SYSCHAR = 0x0106;
const VK_SHIFT = 0x10;
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

/** Returns true (TranslateMessage's TRUE) when a character message was posted. */
export function translateKeyMessage(hwnd: number, message: number, wParam: number, lParam: number): boolean {
    if (message !== WM_KEYDOWN && message !== WM_SYSKEYDOWN) return false;
    const input = System.getInstance().inputManager;
    const charCode = vkToChar(wParam & 0xFF, (input.getKeyState(VK_SHIFT) & 0x8000) !== 0,
        (input.getKeyState(VK_CAPITAL) & 1) !== 0);
    if (charCode === 0) return false;
    System.getInstance().windowManager.postMessage(hwnd, message === WM_SYSKEYDOWN ? WM_SYSCHAR : WM_CHAR, charCode, lParam);
    return true;
}
