import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../../src/worker/modules/user32/index";
import { System } from "../../src/worker/core/system";
import { createWindowExports } from "../../src/worker/modules/user32/window";
import { clickAutoButton, resetControlInteractionState } from "../../src/worker/modules/user32/control-interaction";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { hasPendingUpdate, clearWindowUpdate, invalidateWindow } from "../../src/worker/modules/user32/paint-region";
import { createMessageExports } from "../../src/worker/modules/user32/message";

const WM_PAINT = 0x000f;
const BS_AUTOCHECKBOX = 0x0003;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;

const DIALOG = 0x2000;
const CHECK = 0x2001;
const GUEST_PROC = 0x00596000;

let posted: Array<{ hwnd: number; msg: number }> = [];
let overlayDCs = 0;
let saved: Record<string, unknown> = {};

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

function setup(subclassed: boolean): void {
    windows.set(DIALOG, makeWindow({
        handle: DIALOG, style: WS_POPUP | WS_VISIBLE, width: 439, height: 310,
        children: [CHECK], wndProc: 0x00597000, overlayOnFlipScreen: true, paintCycleRan: true,
    }));
    windows.set(CHECK, makeWindow({
        handle: CHECK, parent: DIALOG, style: WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
        x: 33, y: 200, width: 187, height: 17, controlId: 1325, title: "Popups",
        isSystemControl: true, systemControlClass: "Button", nativeClassName: "Button",
        wndProc: subclassed ? GUEST_PROC : 0, wndProcSubclassed: subclassed,
    }));
}

const gdiStub = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => {
        if (key === "createOverlayDC") return () => { overlayDCs++; return 0; };
        if (key === "then") return undefined;
        return () => 0;
    },
});

beforeEach(() => {
    posted = [];
    overlayDCs = 0;
    windows.clear();
    clearWindowUpdate(CHECK);
    clearWindowUpdate(DIALOG);
    resetControlInteractionState();
    const system = System.getInstance() as any;
    saved = { windowManager: system.windowManager, scheduler: system.scheduler, gdiContext: system.gdiContext };
    system.windowManager = {
        setFocus: () => {},
        setCapture: () => 0,
        releaseCapture: () => 0,
        postMessage: (hwnd: number, msg: number) => { posted.push({ hwnd, msg }); },
        getWindow: () => undefined,
    };
    system.scheduler = { wakeMessageWaiters: () => {} };
    system.gdiContext = gdiStub;
});

afterEach(() => {
    const system = System.getInstance() as any;
    Object.assign(system, saved);
    windows.clear();
    resetControlInteractionState();
});

function invalidate(hwnd: number): void {
    const api = createWindowExports();
    const mem = new Uint8Array(64);
    (api["InvalidateRect"] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, [hwnd, 0, 1]);
}

describe("a subclassed control repaints through its own window proc", () => {
    test("InvalidateRect on it posts the control's WM_PAINT and stamps no dialog chrome", () => {
        setup(true);
        invalidate(CHECK);
        expect(posted).toContainEqual({ hwnd: CHECK, msg: WM_PAINT });
        expect(hasPendingUpdate(CHECK)).toBe(true);
        expect(overlayDCs).toBe(0);
    });

    test("negative control: an unsubclassed control is still stamped by USER", () => {
        setup(false);
        invalidate(CHECK);
        expect(posted.some((p) => p.hwnd === CHECK && p.msg === WM_PAINT)).toBe(false);
        expect(overlayDCs).toBeGreaterThan(0);
    });

    test("a click's state change asks the subclassed checkbox to repaint instead of stamping the dialog", () => {
        setup(true);
        clickAutoButton(windows.get(CHECK)!);
        expect(posted).toContainEqual({ hwnd: CHECK, msg: WM_PAINT });
        expect(overlayDCs).toBe(0);
    });

    test("negative control: the same click on an unsubclassed checkbox repaints the dialog", () => {
        setup(false);
        clickAutoButton(windows.get(CHECK)!);
        expect(posted.some((p) => p.hwnd === CHECK && p.msg === WM_PAINT)).toBe(false);
        expect(overlayDCs).toBeGreaterThan(0);
    });
});

describe("the stock paint of a subclassed control is not lost", () => {
    const SENTINEL = 0xffff0001;

    function dispatchPaint(onCallback: (done: (ret: number) => number | null) => void): void {
        const system = System.getInstance() as any;
        const savedProcess = system.process;
        system.process = { addressSpace: { validateRange: () => true }, dispatcher: { callbackManager: {
            getStubPoolRange: () => ({ base: 0x10000000, end: 0x10000100 }),
            saveSuspendedThunkContext: () => 1,
            invokeCallback: (_fn: number, _args: number[], _c: number, done: (ret: number) => number | null) => { onCallback(done); return { callbackId: 7 }; },
        } } };
        try {
            const mem = new Uint8Array(0x2000);
            const dv = new DataView(mem.buffer);
            [CHECK, WM_PAINT, 0, 0, 0, 0, 0].forEach((v, i) => dv.setUint32(0x400 + i * 4, v, true));
            (createMessageExports()["DispatchMessageW"] as (c: unknown, m: Uint8Array, a: number[]) => unknown)({ esp: 0x1800 }, mem, [0x400]);
        } finally {
            system.process = savedProcess;
        }
    }

    test("an MFC-style subclass that forwards WM_PAINT to the original proc gets the stock control, validated", () => {
        setup(true);
        invalidateWindow(CHECK, null, true);
        const api = createWindowExports();
        (api["CallWindowProcA"] as (c: unknown, m: Uint8Array, a: number[]) => unknown)({ esp: 0 }, new Uint8Array(64), [SENTINEL, CHECK, WM_PAINT, 0, 0]);
        expect(overlayDCs).toBeGreaterThan(0);
        expect(hasPendingUpdate(CHECK)).toBe(false);
    });

    test("a subclass that swallows WM_PAINT without BeginPaint still gets the stock control after it returns", () => {
        setup(true);
        invalidateWindow(CHECK, null, true);
        dispatchPaint((done) => {
            expect(overlayDCs).toBe(0);
            done(0);
        });
        expect(overlayDCs).toBeGreaterThan(0);
        expect(hasPendingUpdate(CHECK)).toBe(false);
    });

    test("negative control: a subclass that painted the control itself (BeginPaint) is not painted over", () => {
        setup(true);
        invalidateWindow(CHECK, null, true);
        dispatchPaint((done) => {
            clearWindowUpdate(CHECK);
            done(0);
        });
        expect(overlayDCs).toBe(0);
    });
});
