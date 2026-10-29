/**
 * A system control's class procedure has an A and a W face. A Unicode subclasser
 * (SetWindowLongW / GetWindowLongW on GWL_WNDPROC) receives the W face and forwards
 * wide text through it with CallWindowProcW, so WM_SETTEXT must decode as UTF-16
 * whatever its length — the ANSI-or-wide probe alone misreads any wide caption longer
 * than its probe window as a one-letter ANSI string.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { registerWindowPropExports } from "../../src/worker/modules/user32/window-props";
import { handleSystemControlMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import {
    getDefWindowProcAddress, getDefWindowProcWAddress, resetDefWindowProcCache,
} from "../../src/worker/modules/user32/system-classes";

const DEF_WINDOW_PROC_A = 0x21049060;
const DEF_WINDOW_PROC_W = 0x21049070;
const GUEST_SUBCLASS_PROC = 0x1100130c;
const GWL_WNDPROC = -4;
const WM_SETTEXT = 0x000c;
const HWND = 0x10002;

let savedProcess: unknown;
let savedWindowManager: unknown;

beforeEach(() => {
    windows.clear();
    resetDefWindowProcCache();
    const system = System.getInstance() as any;
    savedProcess = system.process;
    savedWindowManager = system.windowManager;
    system.process = {
        dispatcher: {
            thunkGenerator: {
                getExportAddress: (key: string): number | undefined => ({
                    "user32:defwindowproca": DEF_WINDOW_PROC_A,
                    "user32:defwindowprocw": DEF_WINDOW_PROC_W,
                }[key]),
            },
        },
    };
    system.windowManager = new WindowManager();
    windows.set(HWND, {
        handle: HWND, title: "", style: 0x50000000, x: 0, y: 0, width: 395, height: 39,
        children: [], visible: true, wndProc: getDefWindowProcAddress(),
        isSystemControl: true, nativeClassName: "Static", controlId: 1011,
    } as WindowInfo);
});

afterEach(() => {
    const system = System.getInstance() as any;
    system.process = savedProcess;
    system.windowManager = savedWindowManager;
    windows.clear();
    resetDefWindowProcCache();
});

function api(): Record<string, any> {
    const exports: Record<string, any> = {};
    registerWindowPropExports(exports);
    return exports;
}

function wide(text: string): Uint8Array {
    const mem = new Uint8Array(0x1000);
    for (let i = 0; i < text.length; i++) mem[0x100 + i * 2] = text.charCodeAt(i);
    return mem;
}

describe("system control class procedure A/W faces", () => {
    test("GWL_WNDPROC reports the face matching the caller's charset", () => {
        const user32 = api();
        expect(getDefWindowProcWAddress()).toBe(DEF_WINDOW_PROC_W);
        expect(user32.GetWindowLongA({}, new Uint8Array(), [HWND, GWL_WNDPROC])).toBe(DEF_WINDOW_PROC_A);
        expect(user32.GetWindowLongW({}, new Uint8Array(), [HWND, GWL_WNDPROC])).toBe(DEF_WINDOW_PROC_W);
    });

    test("SetWindowLongW subclassing hands back the W class procedure", () => {
        const user32 = api();
        const prev = user32.SetWindowLongW({}, new Uint8Array(), [HWND, GWL_WNDPROC, GUEST_SUBCLASS_PROC]);
        expect(prev).toBe(DEF_WINDOW_PROC_W);
        expect(windows.get(HWND)!.wndProc).toBe(GUEST_SUBCLASS_PROC);
        expect(windows.get(HWND)!.wndProcSubclassed).toBe(true);
    });

    test("un-subclassing with the W class procedure restores the un-subclassed control", () => {
        const user32 = api();
        const old = user32.SetWindowLongW({}, new Uint8Array(), [HWND, GWL_WNDPROC, GUEST_SUBCLASS_PROC]);
        expect(user32.SetWindowLongW({}, new Uint8Array(), [HWND, GWL_WNDPROC, old])).toBe(GUEST_SUBCLASS_PROC);
        const win = windows.get(HWND)!;
        // Stored as the one class proc, so identity checks see the default procedure and
        // its messages are not round-tripped through the guest or read as wide.
        expect(win.wndProc).toBe(DEF_WINDOW_PROC_A);
        expect(win.wndProcSubclassed).toBe(false);
        expect(user32.GetWindowLongW({}, new Uint8Array(), [HWND, GWL_WNDPROC])).toBe(DEF_WINDOW_PROC_W);
        expect(user32.GetWindowLongA({}, new Uint8Array(), [HWND, GWL_WNDPROC])).toBe(DEF_WINDOW_PROC_A);
    });

    test("SetWindowLongA subclassing keeps handing back the A class procedure", () => {
        const user32 = api();
        const prev = user32.SetWindowLongA({}, new Uint8Array(), [HWND, GWL_WNDPROC, GUEST_SUBCLASS_PROC]);
        expect(prev).toBe(DEF_WINDOW_PROC_A);
    });

    test("a wide WM_SETTEXT longer than the probe window keeps its whole caption", () => {
        const caption = "Your computer is using old video card drivers that may not work correctly with this game.";
        const win = windows.get(HWND)!;
        handleSystemControlMessage(win, WM_SETTEXT, 0, 0x100, wide(caption), "wide");
        expect(win.title).toBe(caption);
    });
});
