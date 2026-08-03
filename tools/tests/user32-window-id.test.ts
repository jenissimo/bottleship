import { beforeEach, describe, expect, test } from 'bun:test';
import { controlIdFromCreateWindow } from '../../src/worker/modules/user32/window';
import { registerWindowPropExports } from '../../src/worker/modules/user32/window-props';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';

const WS_CHILD = 0x40000000;
const HWND = 0x12001;

function windowInfo(): WindowInfo {
    return {
        handle: HWND,
        title: '',
        style: WS_CHILD,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        children: [],
        visible: true,
        wndProc: 0x401000,
        controlId: 0x415,
    };
}

describe('child window identifiers', () => {
    beforeEach(() => windows.clear());

    test('CreateWindowEx hMenu becomes the id for guest custom child classes', () => {
        expect(controlIdFromCreateWindow(WS_CHILD, 0x415)).toBe(0x415);
        expect(controlIdFromCreateWindow(0, 0x415)).toBeUndefined();
    });

    test('GWLP_ID reads and replaces the id observed by GetDlgCtrlID', () => {
        const api: Record<string, any> = {};
        registerWindowPropExports(api);
        windows.set(HWND, windowInfo());

        expect(api.GetWindowLongA({} as any, new Uint8Array(), [HWND, -12])).toBe(0x415);
        expect(api.SetWindowLongA({} as any, new Uint8Array(), [HWND, -12, 0x522])).toBe(0x415);
        expect(windows.get(HWND)?.controlId).toBe(0x522);
        expect(api.GetWindowLongW({} as any, new Uint8Array(), [HWND, -12])).toBe(0x522);
    });
});
