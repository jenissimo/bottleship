import { beforeEach, describe, expect, test } from 'bun:test';
import { recordLastActive } from '../../src/worker/modules/user32/activation-messages';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;

const FRAME = 0x10001;
const DIALOG = 0x10010;
const NESTED = 0x10020;
const CHILD = 0x10030;

function win(handle: number, style: number, parent?: number): WindowInfo {
    return {
        handle, title: '', style, x: 0, y: 0, width: 10, height: 10,
        children: [], visible: true, wndProc: 0x401000,
        ...(parent !== undefined ? { parent } : {}),
    } as WindowInfo;
}

/**
 * GetLastActivePopup is what MFC's CWnd::GetSafeOwner hands to CreateDialog, so the
 * record decides which window a nested dialog is OWNED by — and therefore which C++
 * object the app gets back from GetParent + CWnd::FromHandle. Answering with the frame
 * when a dialog is on screen makes MFC map the frame's HWND to CMainFrame and then call
 * a dialog-only virtual on it (Worms World Party crashed exactly there).
 */
describe('GetLastActivePopup', () => {
    let api: Record<string, any>;

    beforeEach(() => {
        windows.clear();
        api = createWindowExports();
        windows.set(FRAME, win(FRAME, 0));
        windows.set(DIALOG, win(DIALOG, WS_POPUP, FRAME));
        windows.set(NESTED, win(NESTED, WS_POPUP, DIALOG));
        windows.set(CHILD, win(CHILD, WS_CHILD, FRAME));
    });

    const get = (hwnd: number) => api.GetLastActivePopup({} as any, new Uint8Array(), [hwnd]);

    test('answers hWnd itself until something is activated', () => {
        expect(get(FRAME)).toBe(FRAME);
    });

    test('activating an owned popup records it on the owner', () => {
        recordLastActive(DIALOG);
        expect(get(FRAME)).toBe(DIALOG);
        expect(get(DIALOG)).toBe(DIALOG);
    });

    // Wine server make_window_active walks the WHOLE owner chain, not just the immediate
    // owner: a dialog owned by a dialog must still be what the frame answers with.
    test('records up the whole owner chain', () => {
        recordLastActive(NESTED);
        expect(get(FRAME)).toBe(NESTED);
        expect(get(DIALOG)).toBe(NESTED);
    });

    // make_window_active has no style filter. An owned top-level without WS_POPUP is
    // still a popup for this purpose, and filtering on the style left the frame
    // answering with itself.
    test('no WS_POPUP filter — any owned top-level counts', () => {
        windows.set(DIALOG, win(DIALOG, 0, FRAME));
        recordLastActive(DIALOG);
        expect(get(FRAME)).toBe(DIALOG);
    });

    // A WS_CHILD window has a PARENT in that same field, not an owner; the walk must
    // stop there rather than pinning the frame to one of its controls.
    test('a WS_CHILD window does not record onto its parent', () => {
        recordLastActive(CHILD);
        expect(get(FRAME)).toBe(FRAME);
    });

    test('falls back to hWnd once the recorded popup is destroyed', () => {
        recordLastActive(DIALOG);
        windows.delete(DIALOG);
        expect(get(FRAME)).toBe(FRAME);
    });
});
