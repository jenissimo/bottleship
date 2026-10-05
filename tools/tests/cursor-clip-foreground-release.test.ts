/**
 * The cursor clip is a GLOBAL input mode that Windows drops when the foreground input
 * queue switches.
 *
 * NT5 xxxSetForegroundWindow2 (ntuser/kernel/focusact.c) does it inside
 * `if (gpqForeground != gpqForegroundPrev)`: "Remove the clip cursor rectangle - it is a
 * global mode that gets removed when switching." wineserver set_foreground_input is the
 * same rule (`set_clip_rectangle(desktop, NULL, SET_CURSOR_NOCLIP, 1)` after an early
 * return when the foreground input is unchanged).
 *
 * Two halves, and the second is what makes this safe to ship: a queue is a THREAD's, so
 * moving the foreground between two windows of one thread is NOT a switch and must leave
 * the clip alone — otherwise an app that clips the pointer to its client area loses it the
 * moment it puts up its own dialog.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { describePointerPolicy, resetPointerPolicy } from "../../src/worker/core/pointer-policy";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import {
    getCursorClipRect, getVirtualScreenRect, setCursorClipRect, windows, type WindowInfo,
} from "../../src/worker/modules/user32/shared-state";
import { installUser32WindowObservers } from "../../src/worker/modules/user32/window-observers";

const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;

const BOX = { left: 100, top: 100, right: 200, bottom: 200 };

let wm: WindowManager;

/** A top-level window in BOTH maps: the manager routes, user32 holds the owner chain. */
function mkTop(threadId: number): number {
    const hwnd = wm.createWindow("Test", "t", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
    wm.getWindow(hwnd)!.creatorThreadId = threadId;
    windows.set(hwnd, {
        handle: hwnd, title: "", style: WS_POPUP | WS_VISIBLE, x: 0, y: 0, width: 64, height: 64,
        children: [], visible: true, wndProc: 0x401000,
    } as WindowInfo);
    return hwnd;
}

beforeEach(() => {
    EmulatorConfig.getInstance().screenResolution = { width: 1024, height: 768, bpp: 32, refreshRate: 60 };
    windows.clear();
    wm = new WindowManager();
    installUser32WindowObservers(wm);
});

afterEach(() => {
    setCursorClipRect(null);
    resetPointerPolicy();
    windows.clear();
});

describe("cursor clip vs the foreground queue", () => {
    test("a foreground switch to another thread's window releases the clip", () => {
        const game = mkTop(1);
        wm.setActiveWindow(game);
        setCursorClipRect({ ...BOX });
        expect(describePointerPolicy().facts.clipped).toBe(true);

        wm.setActiveWindow(mkTop(2));

        // zzzClipCursor(NULL) stores grcCursorClip = rcScreen, so the guest reads back the
        // whole virtual screen — there is no "no clip" value to report.
        expect(getCursorClipRect()).toBeNull();
        expect(describePointerPolicy().facts.clipped).toBe(false);
        expect(describePointerPolicy().clipRect).toBeNull();
    });

    test("a foreground move inside ONE thread keeps the clip", () => {
        const main = mkTop(1);
        const dialog = mkTop(1);
        wm.setActiveWindow(main);
        setCursorClipRect({ ...BOX });

        wm.setActiveWindow(dialog);

        expect(getCursorClipRect()).toEqual(BOX);
        expect(describePointerPolicy().facts.clipped).toBe(true);
    });

    test("re-activating the window that is already foreground is not a switch", () => {
        const main = mkTop(1);
        wm.setActiveWindow(main);
        setCursorClipRect({ ...BOX });

        wm.setActiveWindow(main);

        expect(getCursorClipRect()).toEqual(BOX);
    });

    test("losing the foreground altogether releases the clip", () => {
        const only = mkTop(1);
        wm.setActiveWindow(only);
        setCursorClipRect({ ...BOX });

        wm.destroyWindow(only);

        expect(wm.getForegroundHwnd()).toBe(0);
        expect(getCursorClipRect()).toBeNull();
    });

    test("the clip is global: the switch drops it whichever thread set it", () => {
        const a = mkTop(1);
        const b = mkTop(2);
        wm.setActiveWindow(a);
        wm.setActiveWindow(b);          // b's queue is foreground
        setCursorClipRect({ ...BOX });  // ...and something clips
        wm.setActiveWindow(a);          // switch back

        expect(getCursorClipRect()).toBeNull();
    });

    test("a clip that never confined is left alone by a switch", () => {
        const full = getVirtualScreenRect();
        wm.setActiveWindow(mkTop(1));
        setCursorClipRect({ ...full });
        wm.setActiveWindow(mkTop(2));

        // The switch still drops the recorded rect (NT resets grcCursorClip to rcScreen,
        // which is what `null` means here) and the confinement claim was never made.
        expect(getCursorClipRect()).toBeNull();
        expect(describePointerPolicy().facts.clipped).toBe(false);
    });

    test("installUser32WindowObservers wires the clip release AND the last-active record", () => {
        const owner = mkTop(1);
        const popup = mkTop(2);
        windows.get(popup)!.parent = owner;
        wm.setActiveWindow(owner);
        setCursorClipRect({ ...BOX });

        wm.setActiveWindow(popup);

        // Both observers on the same activation: one record must not shadow the other.
        expect(getCursorClipRect()).toBeNull();
        expect(windows.get(owner)!.lastActivePopupHwnd).toBe(popup);
    });
});
