/**
 * EnableWindow follows Wine's NtUserEnableWindow: only a state change has effects, the
 * style reaches the window manager's record too (input routing reads that one), and a
 * window that is disabled while it holds the focus gives it up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { registerWindowPropExports } from "../../src/worker/modules/user32/window-props";

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;

let savedWindowManager: unknown;
let wm: WindowManager;
let hwnd = 0;

beforeEach(() => {
    windows.clear();
    const system = System.getInstance() as any;
    savedWindowManager = system.windowManager;
    wm = new WindowManager();
    system.windowManager = wm;
    hwnd = wm.createWindow("Button", "Turn Left", WS_CHILD | WS_VISIBLE, 0, 0, 0, 140, 23, 0, 0, 0, 0);
    windows.set(hwnd, {
        handle: hwnd, title: "Turn Left", style: WS_CHILD | WS_VISIBLE, x: 0, y: 0,
        width: 140, height: 23, children: [], visible: true, wndProc: 0,
        isSystemControl: true, nativeClassName: "Button", controlId: 1030,
    } as WindowInfo);
});

afterEach(() => {
    (System.getInstance() as any).windowManager = savedWindowManager;
    windows.clear();
});

function enableWindow(enable: boolean): number {
    const exports: Record<string, any> = {};
    registerWindowPropExports(exports);
    return exports.EnableWindow({}, new Uint8Array(0x100), [hwnd, enable ? 1 : 0]);
}

describe("EnableWindow", () => {
    test("returns the previous disabled state and mirrors the style into the window manager", () => {
        expect(enableWindow(false)).toBe(0);
        expect(windows.get(hwnd)!.style & WS_DISABLED).toBe(WS_DISABLED);
        expect(wm.getWindow(hwnd)!.style & WS_DISABLED).toBe(WS_DISABLED);

        expect(enableWindow(false)).toBe(1);
        expect(enableWindow(true)).toBe(1);
        expect(windows.get(hwnd)!.style & WS_DISABLED).toBe(0);
        expect(wm.getWindow(hwnd)!.style & WS_DISABLED).toBe(0);
        expect(enableWindow(true)).toBe(0);
    });

    test("disabling the focus window releases the focus; enabling does not take it back", () => {
        wm.setFocus(hwnd);
        enableWindow(false);
        expect(wm.getFocusHwnd()).toBe(0);
        enableWindow(true);
        expect(wm.getFocusHwnd()).toBe(0);
    });

    test("an unchanged state leaves the focus alone", () => {
        wm.setFocus(hwnd);
        expect(enableWindow(true)).toBe(0);
        expect(wm.getFocusHwnd()).toBe(hwnd);
    });

    test("an unknown window answers FALSE", () => {
        hwnd = 0xdead;
        expect(enableWindow(false)).toBe(0);
    });
});
