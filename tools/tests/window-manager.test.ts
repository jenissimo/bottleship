/**
 * Windowing unit harness — faithful Win32 window/input model. Pins the WindowManager
 * primitives:
 * Z-order, faithful WindowFromPoint (overlap / child hit-test / WS_DISABLED / hidden),
 * focus-vs-active separation, capture release on destroy (WM_CAPTURECHANGED), and
 * destroy → next-in-Z-order activation.
 *
 * Runs against a real `new WindowManager()` — no v86, no DOM. The only runtime deps it
 * touches are benign: System.getInstance().scheduler.getCurrentThreadId() (returns 1
 * with no live thread), hypercallDataManager.updateMessageQueueFlag (no-op when CPU is
 * uninitialized), and the user32 shared-state capture globals.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import type { Message } from "../../src/worker/runtime/windowing/message-queue";

// Window style bits used by the harness.
const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;
const WS_DISABLED = 0x08000000;
const WS_POPUP = 0x80000000;
const WS_EX_TOPMOST = 0x00000008;

// Messages.
const WM_ACTIVATE = 0x0006;
const WM_SETFOCUS = 0x0007;
const WM_KILLFOCUS = 0x0008;
const WM_NCACTIVATE = 0x0086;
const WM_CAPTURECHANGED = 0x0215;

// SetWindowPos hWndInsertAfter sentinels (unsigned, as the guest passes them).
const HWND_TOP = 0;
const HWND_BOTTOM = 1;
const HWND_TOPMOST = 0xffffffff;   // -1
const HWND_NOTOPMOST = 0xfffffffe; // -2

function mkTopLevel(
    wm: WindowManager,
    x: number, y: number, w: number, h: number,
    opts: { visible?: boolean; disabled?: boolean; topmost?: boolean } = {},
): number {
    let style = WS_POPUP;
    if (opts.visible ?? true) style |= WS_VISIBLE;
    if (opts.disabled) style |= WS_DISABLED;
    const exStyle = opts.topmost ? WS_EX_TOPMOST : 0;
    return wm.createWindow("TestTop", "top", style, exStyle, x, y, w, h, 0, 0, 0, 0);
}

function mkChild(
    wm: WindowManager, parent: number,
    x: number, y: number, w: number, h: number,
    opts: { visible?: boolean; disabled?: boolean } = {},
): number {
    let style = WS_CHILD;
    if (opts.visible ?? true) style |= WS_VISIBLE;
    if (opts.disabled) style |= WS_DISABLED;
    return wm.createWindow("TestChild", "child", style, 0, x, y, w, h, parent, 0, 0, 0);
}

/** Drain the message queue and return all messages targeting `hwnd`. */
function drainFor(wm: WindowManager, hwnd: number): Message[] {
    const out: Message[] = [];
    let msg: Message | null;
    // eslint-disable-next-line no-cond-assign
    while ((msg = wm.getMessage()) !== null) {
        if (msg.hwnd === hwnd) out.push(msg);
    }
    return out;
}

function drainAll(wm: WindowManager): Message[] {
    const out: Message[] = [];
    let msg: Message | null;
    // eslint-disable-next-line no-cond-assign
    while ((msg = wm.getMessage()) !== null) out.push(msg);
    return out;
}

describe("WindowManager Z-order", () => {
    let wm: WindowManager;
    beforeEach(() => { wm = new WindowManager(); });

    test("new visible top-level windows insert at the top (front of Z-order)", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100);
        const c = mkTopLevel(wm, 0, 0, 100, 100);
        // Front → back; last created is frontmost.
        expect(wm.getZOrder()).toEqual([c, b, a]);
    });

    test("BringWindowToTop moves a window to the front", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100);
        wm.bringWindowToTop(a);
        expect(wm.getZOrder()).toEqual([a, b]);
    });

    test("SetWindowPos HWND_BOTTOM sends a window to the back; HWND_TOP brings it front", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100);
        const c = mkTopLevel(wm, 0, 0, 100, 100);
        wm.setWindowZOrder(c, HWND_BOTTOM | 0);
        expect(wm.getZOrder()).toEqual([b, a, c]);
        wm.setWindowZOrder(a, HWND_TOP);
        expect(wm.getZOrder()).toEqual([a, b, c]);
    });

    test("SetWindowPos with explicit hwnd inserts directly behind it", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100);
        const c = mkTopLevel(wm, 0, 0, 100, 100); // z: [c,b,a]
        // Place c behind a (so a stays in front of c).
        wm.setWindowZOrder(c, a);
        expect(wm.getZOrder()).toEqual([b, a, c]);
    });

    test("HWND_TOPMOST keeps a window above the normal group", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100); // z: [b,a]
        wm.setWindowZOrder(a, HWND_TOPMOST | 0);
        // a is now topmost → ahead of normal group; a new normal window stays below it.
        const c = mkTopLevel(wm, 0, 0, 100, 100);
        expect(wm.getZOrder()).toEqual([a, c, b]);
        // Demote a back to normal → it returns to the top of the normal group.
        wm.setWindowZOrder(a, HWND_NOTOPMOST | 0);
        expect(wm.getZOrder()).toEqual([a, c, b]);
    });

    test("a topmost window created last stays ahead of normal windows", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const t = mkTopLevel(wm, 0, 0, 100, 100, { topmost: true });
        const b = mkTopLevel(wm, 0, 0, 100, 100);
        // topmost group (t) first, then normal group front→back (b, a).
        expect(wm.getZOrder()).toEqual([t, b, a]);
    });

    test("ShowWindow visibility change reorders (shown → front, hidden → back)", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100); // z: [b,a]
        wm.onWindowVisibilityChanged(b, false); // hide b → back
        expect(wm.getZOrder()).toEqual([a, b]);
        wm.onWindowVisibilityChanged(b, true); // show b → front
        expect(wm.getZOrder()).toEqual([b, a]);
    });
});

describe("WindowManager WindowFromPoint", () => {
    let wm: WindowManager;
    beforeEach(() => { wm = new WindowManager(); });

    test("overlap: the frontmost containing top-level wins", () => {
        const back = mkTopLevel(wm, 0, 0, 200, 200);
        const front = mkTopLevel(wm, 50, 50, 100, 100); // overlaps back; created last → front
        expect(wm.windowFromPoint(75, 75)).toBe(front);
        // A point only in the back window resolves to the back window.
        expect(wm.windowFromPoint(10, 10)).toBe(back);
    });

    test("point outside all windows → 0", () => {
        mkTopLevel(wm, 0, 0, 100, 100);
        expect(wm.windowFromPoint(500, 500)).toBe(0);
    });

    test("descends to a child containing the point", () => {
        const top = mkTopLevel(wm, 0, 0, 300, 300);
        const child = mkChild(wm, top, 50, 50, 100, 100); // parent-relative
        expect(wm.windowFromPoint(75, 75)).toBe(child);
        // Inside the parent but outside the child → parent.
        expect(wm.windowFromPoint(10, 10)).toBe(top);
    });

    test("nested children: deepest containing child wins", () => {
        const top = mkTopLevel(wm, 0, 0, 400, 400);
        const child = mkChild(wm, top, 50, 50, 200, 200);
        const grandchild = mkChild(wm, child, 25, 25, 50, 50); // screen rect (75,75)-(125,125)
        expect(wm.windowFromPoint(80, 80)).toBe(grandchild);
    });

    test("WS_DISABLED top-level is skipped (window behind it is hit)", () => {
        const back = mkTopLevel(wm, 0, 0, 200, 200);
        mkTopLevel(wm, 0, 0, 200, 200, { disabled: true }); // covers back, but disabled
        expect(wm.windowFromPoint(50, 50)).toBe(back);
    });

    test("hidden top-level is skipped", () => {
        const back = mkTopLevel(wm, 0, 0, 200, 200);
        mkTopLevel(wm, 0, 0, 200, 200, { visible: false });
        expect(wm.windowFromPoint(50, 50)).toBe(back);
    });

    test("disabled / hidden child is skipped → resolves to parent", () => {
        const top = mkTopLevel(wm, 0, 0, 300, 300);
        mkChild(wm, top, 50, 50, 100, 100, { disabled: true });
        expect(wm.windowFromPoint(75, 75)).toBe(top);
    });
});

describe("WindowManager focus vs active", () => {
    let wm: WindowManager;
    beforeEach(() => { wm = new WindowManager(); });

    test("SetFocus on a child sets focus but does NOT change active/foreground", () => {
        const top = mkTopLevel(wm, 0, 0, 300, 300);
        const child = mkChild(wm, top, 0, 0, 100, 100);
        // top auto-activated on create.
        expect(wm.getActiveHwnd()).toBe(top);
        const prevFocus = wm.setFocus(child);
        expect(prevFocus).toBe(top);              // previous focus was the active top
        expect(wm.getFocusHwnd()).toBe(child);    // GetFocus → child
        expect(wm.getActiveHwnd()).toBe(top);     // GetActiveWindow unchanged
        expect(wm.getForegroundHwnd()).toBe(top); // GetForegroundWindow unchanged
        // GetFocus ≠ GetActiveWindow.
        expect(wm.getFocusHwnd()).not.toBe(wm.getActiveHwnd());
    });

    test("SetFocus posts WM_KILLFOCUS to old and WM_SETFOCUS to new", () => {
        const top = mkTopLevel(wm, 0, 0, 300, 300);
        const child = mkChild(wm, top, 0, 0, 100, 100);
        drainAll(wm); // clear create/auto-activate noise (none posted, but be safe)
        wm.setFocus(child);
        const all = drainAll(wm);
        const kill = all.find(m => m.hwnd === top && m.message === WM_KILLFOCUS);
        const set = all.find(m => m.hwnd === child && m.message === WM_SETFOCUS);
        expect(kill).toBeDefined();
        expect(set).toBeDefined();
        expect(kill!.wParam).toBe(child >>> 0); // wParam = hwnd gaining focus
        expect(set!.wParam).toBe(top >>> 0);    // wParam = hwnd losing focus
    });

    test("setActiveWindow moves active+foreground+focus and brings to top", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100); // active=a (first), z:[b,a]
        wm.setActiveWindow(b);
        expect(wm.getActiveHwnd()).toBe(b);
        expect(wm.getForegroundHwnd()).toBe(b);
        expect(wm.getFocusHwnd()).toBe(b);
        expect(wm.getZOrder()[0]).toBe(b);
        // A child cannot become active (no-op).
        const child = mkChild(wm, b, 0, 0, 10, 10);
        wm.setActiveWindow(child);
        expect(wm.getActiveHwnd()).toBe(b);
    });
});

describe("WindowManager capture + destroy", () => {
    let wm: WindowManager;
    beforeEach(() => { wm = new WindowManager(); });

    test("destroying the capture window releases capture + posts WM_CAPTURECHANGED", () => {
        const top = mkTopLevel(wm, 0, 0, 200, 200);
        wm.setCapture(top);
        expect(wm.getCaptureHwnd()).toBe(top);
        wm.destroyWindow(top);
        expect(wm.getCaptureHwnd()).toBe(0);
        // WM_CAPTURECHANGED must have been queued to the losing window.
        const all = drainAll(wm);
        expect(all.some(m => m.hwnd === top && m.message === WM_CAPTURECHANGED)).toBe(true);
    });

    test("destroying a window whose CHILD holds capture also releases it", () => {
        const top = mkTopLevel(wm, 0, 0, 200, 200);
        const child = mkChild(wm, top, 0, 0, 50, 50);
        wm.setCapture(child);
        wm.destroyWindow(top); // dies with its subtree → capture (held by child) released
        expect(wm.getCaptureHwnd()).toBe(0);
    });

    test("destroying the active top-level activates the next in Z-order with full chain", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        const b = mkTopLevel(wm, 0, 0, 100, 100); // active=a (first created); z:[b,a]
        // Make a the active/foreground window, then destroy it.
        wm.setActiveWindow(a); // z:[a,b], active=a
        drainAll(wm);
        wm.destroyWindow(a);
        // Activation transfers to the next visible top-level in Z-order = b.
        expect(wm.getActiveHwnd()).toBe(b);
        expect(wm.getForegroundHwnd()).toBe(b);
        expect(wm.getFocusHwnd()).toBe(b);
        expect(wm.getZOrder()).toEqual([b]);
        // b received the activation chain (WM_NCACTIVATE/WM_ACTIVATE/WM_SETFOCUS).
        const forB = drainFor(wm, b);
        const msgs = forB.map(m => m.message);
        expect(msgs).toContain(WM_NCACTIVATE);
        expect(msgs).toContain(WM_ACTIVATE);
        expect(msgs).toContain(WM_SETFOCUS);
    });

    test("destroying the last top-level leaves active=0 (no successor)", () => {
        const a = mkTopLevel(wm, 0, 0, 100, 100);
        wm.destroyWindow(a);
        expect(wm.getActiveHwnd()).toBe(0);
        expect(wm.getZOrder()).toEqual([]);
    });
});
