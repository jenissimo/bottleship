import { describe, expect, test } from 'bun:test';
import { WindowManager } from '../../src/worker/runtime/windowing/window-manager';
import { isOverlayFormCandidate, floatsOverGameWindow, ownsGameSurface, isFloatingOverlayForm } from '../../src/worker/modules/user32/dialog-overlay';
import { windows } from '../../src/worker/modules/user32/shared-state';
import { notePresentingDeviceWindow as publishPresentedClient } from '../../src/worker/runtime/windowing/fullscreen-window';
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

describe('ownsGameSurface', () => {
    test('the window a windowed device presents into, and its ancestors, own the game surface', () => {
        windows.clear();
        const top = { ...info(), handle: 0x10030, nativeClassName: 'TRunnerForm', width: 640, height: 480 } as WindowInfo;
        const view = { ...info(), handle: 0x10031, nativeClassName: 'TPanel', style: WS_CHILD | WS_VISIBLE, parent: 0x10030, width: 640, height: 480 } as WindowInfo;
        windows.set(top.handle, top);
        windows.set(view.handle, view);
        publishPresentedClient(view.handle);
        expect(ownsGameSurface(view.handle)).toBe(true);
        expect(ownsGameSurface(top.handle)).toBe(true);
        expect(ownsGameSurface(0x10099)).toBe(false);
        publishPresentedClient(0);
        windows.clear();
    });
});

describe('only top-level game window smaller than the screen', () => {
    test('is never made an overlay form', () => {
        windows.clear();
        const game = { ...info(), handle: 0x10040, nativeClassName: 'TRunnerForm', width: 640, height: 480 } as WindowInfo;
        windows.set(game.handle, game);
        expect(isOverlayFormCandidate(game)).toBe(true);
        expect(isFloatingOverlayForm(game)).toBe(false);
        const msg = { ...info(), handle: 0x10041, nativeClassName: 'TMessageForm', width: 320, height: 127 } as WindowInfo;
        windows.set(msg.handle, msg);
        expect(isFloatingOverlayForm(msg)).toBe(true);
        publishPresentedClient(msg.handle);
        expect(isFloatingOverlayForm(msg)).toBe(false);
        publishPresentedClient(0);
        windows.clear();
    });
});

describe('an overlay form that stops floating', () => {
    test('is dropped once the screen shrinks to its size', async () => {
        const mod = await import('../../src/worker/modules/user32/dialog-overlay');
        windows.clear();
        const app = { ...info(), handle: 0x10050, nativeClassName: 'TApplication', width: 800, height: 600 } as WindowInfo;
        const game = { ...info(), handle: 0x10051, nativeClassName: 'TRunnerForm', width: 640, height: 480, overlayOnFlipScreen: true } as WindowInfo;
        windows.set(app.handle, app);
        windows.set(game.handle, game);
        mod.adoptOverlayForm(game.handle);
        expect(mod.isOverlayForm(game.handle)).toBe(true);
        publishPresentedClient(game.handle);
        expect(mod.isOverlayForm(game.handle)).toBe(false);
        expect(game.overlayOnFlipScreen).toBe(false);
        publishPresentedClient(0);
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
        wm.setActiveWindow(form);
        wm.setFocus(game);
        let live = form;
        wm.registerOverlayFormResolver(() => 0, () => live);
        expect(wm.getKeyboardTargetWindow()?.hwnd).toBe(form);
        live = 0;
        expect(wm.getKeyboardTargetWindow()?.hwnd).toBe(game);
    });

    test('a form shown without activation (SW_SHOWNA) leaves the keystrokes with the focused game window', () => {
        const wm = new WindowManager();
        const form = wm.createWindow('TMessageForm', '', WS_POPUP | WS_VISIBLE, 0, 352, 320, 320, 127, 0, 0, 0, 0);
        const game = wm.createWindow('TRunnerForm', '', WS_POPUP | WS_VISIBLE, 0, 0, 0, 1024, 768, 0, 0, 0, 0);
        wm.getWindow(form)!.visible = true;
        wm.getWindow(game)!.visible = true;
        wm.setActiveWindow(game);
        wm.setFocus(game);
        wm.registerOverlayFormResolver(() => 0, () => form);
        expect(wm.getKeyboardTargetWindow()?.hwnd).toBe(game);
        wm.setActiveWindow(form);
        expect(wm.getKeyboardTargetWindow()?.hwnd).toBe(form);
    });
});

describe('an overlay form across a savestate', () => {
    test('a restore into a fresh worker brings the form back as a live overlay form', async () => {
        const mod = await import('../../src/worker/modules/user32/dialog-overlay');
        const { captureUser32State, restoreUser32State } = await import('../../src/worker/modules/user32/savestate');
        const { resetUser32SharedState } = await import('../../src/worker/modules/user32/shared-state');
        const { resetListViewStatesForTests } = await import('../../src/worker/modules/user32/list-view-control');
        const { resetTabStatesForTests } = await import('../../src/worker/modules/user32/tab-control');
        const { resetRichEditStatesForTests } = await import('../../src/worker/modules/user32/rich-edit-control');
        const { resetEditStatesForTests } = await import('../../src/worker/modules/user32/edit-control');
        const { resetHooks } = await import('../../src/worker/modules/user32/hooks');
        const { resetMenuState } = await import('../../src/worker/modules/user32/menu');
        const { restorePaintRegions } = await import('../../src/worker/modules/user32/paint-region');
        const { activeDialogs } = await import('../../src/worker/modules/user32/modal-dialog-state');
        const resetStores = () => {
            resetUser32SharedState();
            resetHooks();
            resetMenuState();
            restorePaintRegions([]);
            activeDialogs.clear();
            resetEditStatesForTests();
            resetRichEditStatesForTests();
            resetTabStatesForTests();
            resetListViewStatesForTests();
        };
        resetStores();
        try {
            const game = { ...info(), handle: 0x10060, nativeClassName: 'TRunnerForm', width: 800, height: 600 } as WindowInfo;
            const form = { ...info(), handle: 0x10061, nativeClassName: 'TMessageForm', width: 320, height: 127, overlayOnFlipScreen: true } as WindowInfo;
            const plain = { ...info(), handle: 0x10062, nativeClassName: 'TOther', width: 200, height: 100 } as WindowInfo;
            windows.set(game.handle, game);
            windows.set(form.handle, form);
            windows.set(plain.handle, plain);
            mod.adoptOverlayForm(form.handle);
            expect(mod.resolveFrontOverlayFormHwnd()).toBe(form.handle);
            const saved = structuredClone(captureUser32State());
            mod.forgetOverlayForm(form.handle);
            windows.clear();
            expect(mod.resolveFrontOverlayFormHwnd()).toBe(0);
            restoreUser32State(saved);
            expect(windows.get(form.handle)?.overlayOnFlipScreen).toBe(true);
            expect(mod.resolveFrontOverlayFormHwnd()).toBe(form.handle);
            expect(mod.isOverlayForm(form.handle)).toBe(true);
            expect(mod.isOverlayForm(plain.handle)).toBe(false);
        } finally {
            mod.forgetOverlayForm(0x10061);
            resetStores();
        }
    });
});
