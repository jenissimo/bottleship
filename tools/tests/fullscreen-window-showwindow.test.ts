import { afterEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { windows as sharedWindows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { resizeFullscreenWindowToMode } from '../../src/worker/runtime/windowing/fullscreen-window';

const WM_SHOWWINDOW = 0x0018;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const HWND = 0x12340;

function makeWindow(visible: boolean): WindowInfo {
    return {
        handle: HWND,
        title: 'test',
        style: WS_POPUP | (visible ? WS_VISIBLE : 0),
        x: 0, y: 0, width: 320, height: 200,
        children: [],
        wndProc: 0,
        userData: 0,
        visible,
    } as WindowInfo;
}

/** Record every postMessage the mode-set makes, with the real WindowManager stubbed out. */
function withRecordedMessages(fn: () => void): Array<{ hwnd: number; msg: number; wParam: number }> {
    const system = System.getInstance();
    const wm = system.windowManager as unknown as Record<string, unknown>;
    const saved = { getWindow: wm.getWindow, postMessage: wm.postMessage, setWindowZOrder: wm.setWindowZOrder };
    const posted: Array<{ hwnd: number; msg: number; wParam: number }> = [];
    wm.getWindow = () => null;
    wm.postMessage = (hwnd: number, msg: number, wParam: number) => { posted.push({ hwnd, msg, wParam }); };
    wm.setWindowZOrder = () => {};
    try {
        fn();
    } finally {
        Object.assign(wm, saved);
    }
    return posted;
}

afterEach(() => { sharedWindows.delete(HWND); });

// A mode-set that takes a hidden window fullscreen SHOWS it, and a hidden->visible
// transition made through ShowWindow owes the window WM_SHOWWINDOW(TRUE) — the message
// SetWindowPos never sends. Apps hang real work off it — HL's
// launcher loads the menu's background DIB in OnShowWindow(bShow=TRUE) — so flipping
// WS_VISIBLE without the message leaves the app believing it was never shown.
test('a fullscreen mode-set that shows a hidden window delivers WM_SHOWWINDOW(TRUE)', () => {
    sharedWindows.set(HWND, makeWindow(false));
    const posted = withRecordedMessages(() => resizeFullscreenWindowToMode(HWND, 640, 480, 'test'));

    const show = posted.filter((m) => m.msg === WM_SHOWWINDOW);
    expect(show).toHaveLength(1);
    expect(show[0]).toMatchObject({ hwnd: HWND, wParam: 1 });
    expect(sharedWindows.get(HWND)!.style & WS_VISIBLE).toBe(WS_VISIBLE);
    expect(sharedWindows.get(HWND)!.visible).toBe(true);
});

// The message belongs to the TRANSITION, not to the mode-set: a window that was already
// visible has nothing to announce, and a spurious WM_SHOWWINDOW would re-run the app's
// show-time work on every Reset.
test('a mode-set on an already-visible window posts no WM_SHOWWINDOW', () => {
    sharedWindows.set(HWND, makeWindow(true));
    const posted = withRecordedMessages(() => resizeFullscreenWindowToMode(HWND, 640, 480, 'test'));

    expect(posted.filter((m) => m.msg === WM_SHOWWINDOW)).toHaveLength(0);
});
