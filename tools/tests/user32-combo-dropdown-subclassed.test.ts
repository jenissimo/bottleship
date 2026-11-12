/**
 * A SUBCLASSED combobox's drop-down list must be on the screen when the click that
 * opened it returns.
 *
 * On Windows the list is the ComboLBox popup: USER's own class proc, never the guest's,
 * shown by CBDropDown with RedrawWindow(RDW_UPDATENOW). Our list is not a window — it is
 * stamped after the dialog's siblings — and a subclassed combo is repainted through its
 * own WM_PAINT, whose class proc draws the closed box only. So the list used to wait for
 * an unrelated full repaint of the parent (Max Payne's Options → Antialiasing: MFC
 * subclasses every combo; the list showed up seconds later, or never).
 *
 * Negative control: revert paintOpenComboDropdown in repaintHost and the first test fails
 * (no fill over the drop rect), while WM_PAINT is still posted to the combo; the second
 * test pins why — that WM_PAINT's class proc draws the box and not the list.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// Enter user32 through its index, as the worker does (see user32-control-mouse.test.ts).
import "../../src/worker/modules/user32/index";
import { System } from "../../src/worker/core/system";
import {
    handleSystemControlClassMouse,
    resetControlInteractionState,
} from "../../src/worker/modules/user32/control-interaction";
import { windows, getOrCreateListState, listControlStates, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { getComboDropdownRect } from "../../src/worker/modules/user32/controls";
import { handleSystemControlMessage } from "../../src/worker/modules/user32/dialog-control-messages";

const WM_PAINT = 0x000f;
const WM_LBUTTONDOWN = 0x0201;
const DIALOG = 0x2000;
const COMBO = 0x2001;
const OVERLAY_DC = 0x77;

let posted: Array<{ hwnd: number; msg: number }> = [];
let fills: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
let saved: Record<string, unknown> = {};

/** Records fillRect; every other 2D call is a no-op (measureText answers a width). */
function recordingCtx(): unknown {
    const state: Record<string, unknown> = { fillStyle: "#000000" };
    return new Proxy(state, {
        get(target, prop) {
            if (prop === "fillRect") {
                return (x: number, y: number, w: number, h: number) =>
                    fills.push({ x, y, w, h, style: String(target.fillStyle) });
            }
            if (prop === "measureText") {
                return (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 2 });
            }
            if (prop in target) return target[prop as string];
            return () => undefined;
        },
        set(target, prop, value) { target[prop as string] = value; return true; },
    });
}

function makeWindow(over: Partial<WindowInfo> & { handle: number }): WindowInfo {
    return { title: "", style: 0, x: 0, y: 0, width: 100, height: 40, children: [], visible: true, wndProc: 0, ...over } as WindowInfo;
}

beforeEach(() => {
    posted = [];
    fills = [];
    windows.clear();
    listControlStates.delete(COMBO);
    resetControlInteractionState();
    windows.set(DIALOG, makeWindow({ handle: DIALOG, x: 10, y: 10, width: 300, height: 200, children: [COMBO] }));
    windows.set(COMBO, makeWindow({
        handle: COMBO, parent: DIALOG, x: 40, y: 30, width: 140, height: 21, controlId: 1020,
        isSystemControl: true, systemControlClass: "ComboBox", title: "Off",
        style: 0x50210003, // WS_CHILD|WS_VISIBLE|WS_VSCROLL|CBS_DROPDOWNLIST
        // MFC's AfxWndProc took over the combo's wndproc.
        wndProcSubclassed: true, wndProc: 0x401000,
    }));
    const st = getOrCreateListState(COMBO);
    st.items = [{ text: "Off", data: 0 }, { text: "4 samples", data: 0 }];
    st.selectedIndex = 0;

    const system = System.getInstance() as any;
    saved = { windowManager: system.windowManager, scheduler: system.scheduler, gdiContext: system.gdiContext };
    system.windowManager = {
        setFocus: () => {},
        setCapture: () => 0,
        releaseCapture: () => 0,
        postMessage: (hwnd: number, msg: number) => { posted.push({ hwnd, msg }); },
        getWindow: () => undefined,
        getZOrder: () => [DIALOG],
    };
    system.scheduler = { wakeMessageWaiters: () => {} };
    const ctx = recordingCtx();
    system.gdiContext = {
        createOverlayDC: () => OVERLAY_DC,
        getDC: (hdc: number) => (hdc === OVERLAY_DC ? ctx : undefined),
        releaseDC: () => {},
        setOverlayDirty: () => {},
        clearOverlayRect: () => {},
    };
});

afterEach(() => {
    const system = System.getInstance() as any;
    system.windowManager = saved.windowManager;
    system.scheduler = saved.scheduler;
    system.gdiContext = saved.gdiContext;
    windows.clear();
    listControlStates.delete(COMBO);
    resetControlInteractionState();
});

/** The guest's wndproc forwarding the click to the class proc (CallWindowProc/DefWindowProc);
 *  lParam is client coords inside the closed box. */
const clickCombo = (): boolean =>
    handleSystemControlClassMouse(windows.get(COMBO)!, WM_LBUTTONDOWN, 0, (10 << 16) | 20);

/** A fill that covers the whole drop rect — the list's background, i.e. the list was stamped. */
const listStamped = (): boolean => {
    const r = getComboDropdownRect(windows.get(COMBO)!);
    return fills.some((f) => f.x <= r.x && f.y <= r.y && f.x + f.w >= r.x + r.w && f.y + f.h >= r.y + r.h);
};

describe("subclassed combobox drop-down", () => {
    test("opening it stamps the list before the click returns", () => {
        expect(clickCombo()).toBe(true);
        expect(listControlStates.get(COMBO)?.dropdownOpen).toBe(true);
        // The closed box is still repainted through the guest's wndproc (WM_PAINT) ...
        expect(posted.some((p) => p.hwnd === COMBO && p.msg === WM_PAINT)).toBe(true);
        // ... and the ComboLBox, which is USER's, is already on the overlay.
        expect(listStamped()).toBe(true);
    });

    test("control: the combo's own WM_PAINT draws the closed box, never the list", () => {
        // This is the only paint the subclassed route asks for, so without the direct
        // ComboLBox stamp nothing puts the list on the screen.
        expect(clickCombo()).toBe(true);
        fills = [];
        handleSystemControlMessage(windows.get(COMBO)!, WM_PAINT, OVERLAY_DC, 0, new Uint8Array(1024));
        expect(fills.length).toBeGreaterThan(0); // the box itself was painted
        expect(listStamped()).toBe(false);
    });
});
