import { describe, expect, test } from 'bun:test';
import { WindowManager } from '../../src/worker/runtime/windowing/window-manager';
import { isOverlayFormCandidate, floatsOverGameWindow } from '../../src/worker/modules/user32/dialog-overlay';
import { windows } from '../../src/worker/modules/user32/shared-state';
import type { WindowInfo } from '../../src/worker/modules/user32/shared-state';

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;
const WS_CAPTION = 0x00c00000;

function info(): WindowInfo {
    return { handle: 0x10011, nativeClassName: 'TMissionForm', style: WS_POPUP | WS_CAPTION | WS_VISIBLE, width: 320, height: 240, visible: true, children: [] } as unknown as WindowInfo;
}

describe('isOverlayFormCandidate', () => {
    test('a captioned app form smaller than the screen is a live overlay candidate', () => {
        expect(isOverlayFormCandidate(info())).toBe(true);
    });
    test('a #32770 keeps its own rule', () => {
        expect(isOverlayFormCandidate({ ...info(), nativeClassName: '#32770' } as WindowInfo)).toBe(false);
    });
    test('a child window is never a form overlay', () => {
        expect(isOverlayFormCandidate({ ...info(), style: WS_CHILD | WS_CAPTION | WS_VISIBLE } as WindowInfo)).toBe(false);
    });
    test('a caption-less popup (Game Maker TMessageForm) is a form too', () => {
        expect(isOverlayFormCandidate({ ...info(), nativeClassName: 'TMessageForm', style: WS_POPUP | WS_VISIBLE, width: 320, height: 127 } as WindowInfo)).toBe(true);
    });
    test('a screen-sized game window is not a form overlay', () => {
        expect(isOverlayFormCandidate({ ...info(), width: 100000, height: 100000 } as WindowInfo)).toBe(false);
    });
});

describe('floatsOverGameWindow', () => {
    test('the only visible game window is not lifted over its own 3D output', () => {
        windows.clear();
        const app = { ...info(), handle: 0x10001, nativeClassName: 'TApplication', width: 800, height: 600, visible: false } as WindowInfo;
        const game = { ...info(), handle: 0x10018, nativeClassName: 'TRunnerForm', width: 640, height: 480 } as WindowInfo;
        windows.set(app.handle, app);
        windows.set(game.handle, game);
        expect(floatsOverGameWindow(game)).toBe(false);
        windows.clear();
    });
    test('a message form over a visible larger game window floats', () => {
        windows.clear();
        const game = { ...info(), handle: 0x10018, nativeClassName: 'TRunnerForm', width: 640, height: 480 } as WindowInfo;
        const msg = { ...info(), handle: 0x10020, nativeClassName: 'TMessageForm', width: 320, height: 127 } as WindowInfo;
        windows.set(game.handle, game);
        windows.set(msg.handle, msg);
        expect(floatsOverGameWindow(msg)).toBe(true);
        expect(floatsOverGameWindow(game)).toBe(false);
        windows.clear();
    });
});

describe('mouse over a disabled top-level window', () => {
    test('a click is routed to the point-routed overlay form, not dropped on the disabled window', () => {
        const wm = new WindowManager();
        const form = wm.createWindow('TMissionForm', 'Mission', WS_POPUP | WS_CAPTION | WS_VISIBLE, 0, 100, 100, 320, 240, 0, 0, 0, 0);
        const game = wm.createWindow('TGameForm', 'Game', WS_POPUP | WS_VISIBLE | WS_DISABLED, 0, 0, 0, 1024, 768, 0, 0, 0, 0);
        wm.getWindow(form)!.visible = true;
        const g = wm.getWindow(game)!;
        g.visible = true;
        g.style |= WS_DISABLED;
        wm.setWindowZOrder(game, 0);
        wm.registerMouseTargetResolver((x, y) => (x >= 100 && y >= 100 && x < 420 && y < 340 ? form : 0));
        expect(wm.getMouseTargetWindow(200, 200)?.hwnd).toBe(form);
        expect(wm.getMouseTargetWindow(10, 10)?.hwnd).toBe(game);
    });
});

describe('mouse over the game window with an overlay form on top', () => {
    test('the overlay form takes the click even though the enabled game window is in front of it', () => {
        const wm = new WindowManager();
        const form = wm.createWindow('TMessageForm', '', WS_POPUP | WS_VISIBLE, 0, 352, 320, 320, 127, 0, 0, 0, 0);
        const game = wm.createWindow('TRunnerForm', '', WS_POPUP | WS_VISIBLE, 0, 0, 0, 1024, 768, 0, 0, 0, 0);
        wm.getWindow(form)!.visible = true;
        wm.getWindow(game)!.visible = true;
        wm.setWindowZOrder(game, 0);
        wm.registerOverlayFormResolver((x, y) => (x >= 352 && y >= 320 && x < 672 && y < 447 ? form : 0));
        expect(wm.getMouseTargetWindow(400, 350)?.hwnd).toBe(form);
        expect(wm.getMouseTargetWindow(10, 10)?.hwnd).toBe(game);
    });
});

describe('keyboard while an overlay form is up', () => {
    test('keystrokes go to the frontmost overlay form, not the focused game window', () => {
        const wm = new WindowManager();
        const form = wm.createWindow('TMessageForm', '', WS_POPUP | WS_VISIBLE, 0, 352, 320, 320, 127, 0, 0, 0, 0);
        const game = wm.createWindow('TRunnerForm', '', WS_POPUP | WS_VISIBLE, 0, 0, 0, 1024, 768, 0, 0, 0, 0);
        wm.getWindow(form)!.visible = true;
        wm.getWindow(game)!.visible = true;
        wm.setFocus(game);
        let live = form;
        wm.registerOverlayFormResolver(() => 0, () => live);
        expect(wm.getKeyboardTargetWindow()?.hwnd).toBe(form);
        live = 0;
        expect(wm.getKeyboardTargetWindow()?.hwnd).toBe(game);
    });
});
