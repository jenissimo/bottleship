/**
 * Control-class mouse handling for a SUBCLASSED control. DispatchMessage must not
 * consume the click on the guest's behalf: on Win32 the message reaches the
 * (subclassed) wndproc first, and the class behavior — BN_CLICKED — only happens if
 * the guest forwards to DefWindowProc.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import {
    handleSystemControlMouseAtScreen,
    handleSystemControlClassMouse,
    resetControlInteractionState,
    takePendingControlNotification,
} from "../../src/worker/modules/user32/control-interaction";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";

const WM_COMMAND = 0x0111;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const BN_CLICKED = 0;

const DIALOG = 0x1000;
const BUTTON = 0x1001;

let posted: Array<{ hwnd: number; msg: number; wParam: number }> = [];
let capture = 0;

function makeWindow(over: Partial<WindowInfo> & { handle: number }): WindowInfo {
    return {
        title: "",
        style: 0,
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        children: [],
        visible: true,
        wndProc: 0,
        ...over,
    } as WindowInfo;
}

beforeEach(() => {
    posted = [];
    capture = 0;
    windows.clear();
    resetControlInteractionState();
    windows.set(DIALOG, makeWindow({ handle: DIALOG, x: 10, y: 10, width: 200, height: 100, children: [BUTTON] }));
    windows.set(BUTTON, makeWindow({
        handle: BUTTON,
        parent: DIALOG,
        x: 20,
        y: 20,
        width: 60,
        height: 20,
        controlId: 7,
        isSystemControl: true,
        systemControlClass: "Button",
        title: "OK",
    }));

    const system = System.getInstance() as any;
    // The System singleton is shared with every other test file in this process.
    saved = { windowManager: system.windowManager, scheduler: system.scheduler, gdiContext: system.gdiContext };
    system.windowManager = {
        setFocus: () => {},
        setCapture: (hwnd: number) => { const previous = capture; capture = hwnd; return previous; },
        releaseCapture: () => { const previous = capture; capture = 0; return previous; },
        postMessage: (hwnd: number, msg: number, wParam: number) => { posted.push({ hwnd, msg, wParam }); },
        getWindow: () => undefined,
    };
    system.scheduler = { wakeMessageWaiters: () => {} };
    system.gdiContext = { createOverlayDC: () => 0 };
});

let saved: Record<string, unknown> = {};

afterEach(() => {
    const system = System.getInstance() as any;
    system.windowManager = saved.windowManager;
    system.scheduler = saved.scheduler;
    system.gdiContext = saved.gdiContext;
    windows.clear();
    resetControlInteractionState();
});

const clickButton = (msg: number): boolean =>
    handleSystemControlMouseAtScreen(DIALOG, msg, 0, 10 + 20 + 5, 10 + 20 + 5);

const clicked = (): boolean => {
    const notification = takePendingControlNotification();
    return !!notification
        && notification.hwnd === DIALOG
        && notification.msg === WM_COMMAND
        && notification.wParam === (((BN_CLICKED << 16) | 7) >>> 0);
};

describe("system-control mouse", () => {
    test("an ordinary button captures the mouse and emits BN_CLICKED synchronously", () => {
        expect(clickButton(WM_LBUTTONDOWN)).toBe(true);
        expect(capture).toBe(BUTTON);
        expect(clickButton(WM_LBUTTONUP)).toBe(true);
        expect(capture).toBe(0);
        expect(clicked()).toBe(true);
    });

    test("a SUBCLASSED button is left to the guest's wndproc", () => {
        windows.get(BUTTON)!.wndProcSubclassed = true;
        expect(clickButton(WM_LBUTTONDOWN)).toBe(false);
        expect(clickButton(WM_LBUTTONUP)).toBe(false);
        expect(clicked()).toBe(false);
    });

    test("the class behavior still runs when the guest forwards to DefWindowProc", () => {
        const button = windows.get(BUTTON)!;
        button.wndProcSubclassed = true;
        // lParam = client coords relative to the control (what DefWindowProc receives).
        const lParam = (5 << 16) | 5;
        expect(handleSystemControlClassMouse(button, WM_LBUTTONDOWN, 0, lParam)).toBe(true);
        expect(handleSystemControlClassMouse(button, WM_LBUTTONUP, 0, lParam)).toBe(true);
        expect(clicked()).toBe(true);
    });
});
