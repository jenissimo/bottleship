/**
 * WM_SETCURSOR is the only route by which a pointer comes back after SetCursor(NULL),
 * and DefWindowProc is the whole of it.
 *
 * NT5 ntuser/kernel/dwp.c xxxDWP_SetCursor, in order: a sizing border answers with its own
 * cursor and stops; every other hit code is SENT to the parent first (`GetChildParent`,
 * i.e. WS_CHILD only, desktop excluded) and stops if the parent returns nonzero; only a
 * declining parent lets the HIT window's class cursor apply, and only
 * `if (pwndHit->pcls->spcur != NULL)` — a NULL class cursor makes DefWindowProc do
 * nothing. Wine's win32u/defwnd.c (WM_SETCURSOR → send_message(parent) → handle_set_cursor)
 * is the same rule, and its win32u/class.c `builtin_classes[]` is the table of what those
 * class cursors are: IDC_ARROW for everything, IDC_IBEAM for Edit, and `#32770`
 * (CS_SAVEBITS|CS_DBLCLKS, DLGWINDOWEXTRA, IDC_ARROW) for the dialog class.
 *
 * Both halves were missing here: our builtin classes carried hCursor 0, so DefWindowProc
 * was a no-op over every dialog and control; and the parent offer was never made at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { System } from "../../src/worker/core/system";
import { describePointerPolicy, resetPointerPolicy } from "../../src/worker/core/pointer-policy";
import { serializeWindows } from "../../src/worker/harness/serialize";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import {
    getWindowClassByName, registerBuiltinClass, resetUser32Classes,
} from "../../src/worker/modules/user32/class";
import {
    getBuiltinSystemClass, getDefDlgProcAddress, getDefWindowProcAddress,
    resetDefWindowProcCache,
} from "../../src/worker/modules/user32/system-classes";
import {
    getSystemCursorHandle, resetSystemCursorHandles, IDC_ARROW, IDC_IBEAM, IDC_SIZEWE,
} from "../../src/worker/modules/user32/system-cursors";
import {
    getCurrentCursorHandle, getCursorDisplayCount, isGuestCursorVisible,
    resetUser32SharedState, windows, type WindowInfo,
} from "../../src/worker/modules/user32/shared-state";
import { createWindowExports, defWindowProcSetCursor } from "../../src/worker/modules/user32/window";

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;

const HTCLIENT = 1;
const HTLEFT = 10;
const HTCAPTION = 2;
const WM_MOUSEMOVE = 0x0200;
const WM_SETCURSOR = 0x0020;

/** lParam of a WM_SETCURSOR the system generated from a mouse move. */
const setCursorLParam = (hitTest: number, trigger = WM_MOUSEMOVE) =>
    (((trigger & 0xFFFF) << 16) | (hitTest & 0xFFFF)) >>> 0;

// The thunk addresses of our OWN default procedures are what tells the walk "no guest
// code owns this parent". They come from the ThunkGenerator, so a test that wants the
// distinction has to supply one.
const DEF_WINDOW_PROC_ADDR = 0x11000;
const DEF_DLG_PROC_ADDR = 0x12000;
const GUEST_PROC_ADDR = 0x401000;

let savedProcess: unknown;
let wm: WindowManager;

function installFakeThunkGenerator(): void {
    const system = System.getInstance() as any;
    savedProcess = system.process;
    system.process = {
        dispatcher: {
            thunkGenerator: {
                getExportAddress: (key: string): number | undefined => ({
                    "user32:defwindowproca": DEF_WINDOW_PROC_ADDR,
                    "user32:defdlgproca": DEF_DLG_PROC_ADDR,
                }[key]),
            },
        },
    };
}

let nextTestHwnd = 0x1000;
function mkWindow(patch: Partial<WindowInfo>): number {
    const handle = nextTestHwnd++;
    windows.set(handle, {
        handle, title: "", style: WS_VISIBLE, x: 0, y: 0, width: 64, height: 64,
        children: [], visible: true, wndProc: 0, ...patch,
    } as WindowInfo);
    if (patch.parent) windows.get(patch.parent)!.children.push(handle);
    return handle;
}

beforeEach(() => {
    resetUser32SharedState();
    resetUser32Classes();
    resetSystemCursorHandles();
    resetDefWindowProcCache();
    installFakeThunkGenerator();
    wm = new WindowManager();
    (System.getInstance() as any).windowManager = wm;
    nextTestHwnd = 0x1000;
});

afterEach(() => {
    (System.getInstance() as any).process = savedProcess;
    resetUser32SharedState();
    resetUser32Classes();
    resetSystemCursorHandles();
    resetDefWindowProcCache();
    resetPointerPolicy();
});

// ---------------------------------------------------------------------------
// ITEM 1 — the OS pre-registers its classes WITH a cursor
// ---------------------------------------------------------------------------

describe("built-in classes carry the cursor the OS registered them with", () => {
    test("the user32 control classes answer IDC_ARROW, and Edit IDC_IBEAM", () => {
        const arrow = getSystemCursorHandle(IDC_ARROW);
        const ibeam = getSystemCursorHandle(IDC_IBEAM);
        expect(arrow).not.toBe(0);
        expect(ibeam).not.toBe(arrow);
        for (const name of ["Button", "Static", "ListBox", "ComboBox", "ScrollBar"]) {
            expect(getWindowClassByName(name)?.hCursor).toBe(arrow);
        }
        expect(getWindowClassByName("Edit")?.hCursor).toBe(ibeam);
    });

    test("#32770 is a real pre-registered class, not an unknown name", () => {
        // The measured answer on retail Windows for a dialog, its Buttons and its Statics
        // is the same shared IDC_ARROW handle; ours reported classKnown:false.
        const dlg = getWindowClassByName("#32770");
        expect(dlg).toBeDefined();
        expect(dlg!.hCursor).toBe(getSystemCursorHandle(IDC_ARROW));
    });

    test("#32770 carries the DIALOG class contract, not a cursor bolted onto a stub", () => {
        // win32u/class.c: CS_SAVEBITS | CS_DBLCLKS, DLGWINDOWEXTRA, IDC_ARROW, and the
        // dialog window procedure — a #32770 reports DefDlgProc through GWL_WNDPROC,
        // never DefWindowProc, or a subclasser's forward misses the dialog manager.
        const descr = getBuiltinSystemClass("#32770")!;
        expect(descr.style).toBe(0x0800 | 0x0008);
        expect(descr.cbWndExtra).toBe(30);
        expect(descr.idcCursor).toBe(IDC_ARROW);

        expect(getDefDlgProcAddress()).toBe(DEF_DLG_PROC_ADDR);
        expect(getWindowClassByName("#32770")!.lpfnWndProc).toBe(DEF_DLG_PROC_ADDR);
        expect(getWindowClassByName("Button")!.lpfnWndProc).toBe(DEF_WINDOW_PROC_ADDR);
    });

    test("materializing a builtin corrects the stand-in class the WindowManager invented", () => {
        // The dialog manager creates its #32770 straight through WindowManager.createWindow,
        // which registers a style-0 placeholder; the WindowObject captured it. Replacing the
        // map entry later would leave that dialog with no CS_DBLCLKS forever.
        const hwnd = wm.createWindow("#32770", "d", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
        expect(wm.getWindow(hwnd)!.wndClass.style).toBe(0);

        getWindowClassByName("#32770");

        expect(wm.getWindow(hwnd)!.wndClass.style).toBe(0x0800 | 0x0008);
        expect(wm.getWindow(hwnd)!.wndClass.wndProc).toBe(DEF_DLG_PROC_ADDR);
    });

    test("registerBuiltinClass defaults to the arrow, and an explicit NULL survives", () => {
        registerBuiltinClass("SysListView32", { cbWndExtra: 4 });
        expect(getWindowClassByName("SysListView32")?.hCursor)
            .toBe(getSystemCursorHandle(IDC_ARROW));
        // comctl32's hotkey and rebar classes really do register hCursor = NULL.
        registerBuiltinClass("msctls_hotkey32", { cbWndExtra: 4, hCursor: 0 });
        expect(getWindowClassByName("msctls_hotkey32")?.hCursor).toBe(0);
    });

    test("state([\"windows\"]) reports the class cursor a dialog actually has", () => {
        const hwnd = mkWindow({ nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE });
        wm.createWindow("#32770", "d", WS_POPUP | WS_VISIBLE, 0, 0, 0, 64, 64, 0, 0, 0, 0);
        const row = (serializeWindows() as any[]).find((w) => w.hwnd === hwnd);
        expect(row.classKnown).toBe(true);
        expect(row.classCursor).toBe(getSystemCursorHandle(IDC_ARROW));
    });
});

describe("DefWindowProc's class cursor never overrides the guest's ShowCursor count", () => {
    test("a hidden pointer stays hidden while the arrow is installed", () => {
        // Worms World Party hides the pointer with two ShowCursor(FALSE) calls in
        // InitInstance and draws its own. Restoring a class cursor is a SHAPE decision;
        // the count is the guest's and nothing here may touch it.
        const api = createWindowExports();
        api.ShowCursor({} as any, new Uint8Array(), [0]);
        api.ShowCursor({} as any, new Uint8Array(), [0]);
        expect(getCursorDisplayCount()).toBe(-2);

        const dlg = mkWindow({ nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE });
        expect(defWindowProcSetCursor(dlg, dlg, setCursorLParam(HTCLIENT))).toBe(0);

        expect(getCurrentCursorHandle()).toBe(getSystemCursorHandle(IDC_ARROW));
        expect(getCursorDisplayCount()).toBe(-2);
        expect(isGuestCursorVisible()).toBe(false);
        expect(describePointerPolicy().outputs.pointerShown).toBe(false);
    });

    test("a NULL class cursor makes DefWindowProc do nothing at all", () => {
        // Not "hide the pointer": dwp.c only calls zzzSetCursor inside the != NULL test.
        // An app that wants no pointer registers a NULL cursor AND hides it itself.
        registerBuiltinClass("ReBarWindow32", { cbWndExtra: 4, hCursor: 0 });
        const before = getCurrentCursorHandle();
        const hwnd = mkWindow({ nativeClassName: "ReBarWindow32", style: WS_POPUP | WS_VISIBLE });
        expect(defWindowProcSetCursor(hwnd, hwnd, setCursorLParam(HTCLIENT))).toBe(0);
        expect(getCurrentCursorHandle()).toBe(before);
        expect(isGuestCursorVisible()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// ITEM 2 — the parent gets first refusal
// ---------------------------------------------------------------------------

describe("WM_SETCURSOR is offered to the parent before any class cursor", () => {
    test("a child names the parent that must be SENT to, and holds the class cursor back", () => {
        const dlg = mkWindow({
            nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE, wndProc: GUEST_PROC_ADDR,
        });
        const child = mkWindow({
            nativeClassName: "Edit", style: WS_CHILD | WS_VISIBLE, parent: dlg,
            wndProc: DEF_WINDOW_PROC_ADDR,
        });
        const before = getCurrentCursorHandle();

        const plan = defWindowProcSetCursor(child, child, setCursorLParam(HTCLIENT));
        expect(typeof plan).toBe("object");
        expect((plan as any).forwardTo).toBe(dlg);
        // Nothing may be installed until the parent has answered.
        expect(getCurrentCursorHandle()).toBe(before);

        // Nonzero = the parent set the cursor itself. dwp.c returns TRUE and stops.
        expect((plan as any).onParentResult(1)).toBe(1);
        expect(getCurrentCursorHandle()).toBe(before);
    });

    test("a declining parent lets the HIT window's class cursor through", () => {
        const dlg = mkWindow({
            nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE, wndProc: GUEST_PROC_ADDR,
        });
        const child = mkWindow({
            nativeClassName: "Edit", style: WS_CHILD | WS_VISIBLE, parent: dlg,
            wndProc: DEF_WINDOW_PROC_ADDR,
        });

        const plan = defWindowProcSetCursor(child, child, setCursorLParam(HTCLIENT)) as any;
        // FALSE from the parent, and DefWindowProc's own answer is FALSE too (dwp.c falls
        // out of the switch to `return FALSE`; returning TRUE would halt the chain above).
        expect(plan.onParentResult(0)).toBe(0);
        expect(getCurrentCursorHandle()).toBe(getSystemCursorHandle(IDC_IBEAM));
    });

    test("the class cursor comes from wParam, the window the pointer is OVER", () => {
        // dwp.c reads pwndHit->pcls->spcur, and hwndHit rides wParam unchanged all the way
        // up the chain — so the dialog handling the offer still applies its EDIT's I-beam.
        const dlg = mkWindow({ nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE });
        const edit = mkWindow({
            nativeClassName: "Edit", style: WS_CHILD | WS_VISIBLE, parent: dlg,
        });
        expect(defWindowProcSetCursor(dlg, edit, setCursorLParam(HTCLIENT))).toBe(0);
        expect(getCurrentCursorHandle()).toBe(getSystemCursorHandle(IDC_IBEAM));
    });

    test("an ancestor running our own default procedure is walked without a guest trip", () => {
        // Round-tripping the guest to arrive back in this same function is pure cost, so
        // the walk is done here — but the RESULT must be the same as the send: the
        // top-level ancestor declines, and the hit window's class cursor applies.
        const top = mkWindow({
            nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE, wndProc: DEF_DLG_PROC_ADDR,
        });
        const group = mkWindow({
            nativeClassName: "Static", style: WS_CHILD | WS_VISIBLE, parent: top,
            wndProc: DEF_WINDOW_PROC_ADDR,
        });
        const edit = mkWindow({
            nativeClassName: "Edit", style: WS_CHILD | WS_VISIBLE, parent: group,
            wndProc: DEF_WINDOW_PROC_ADDR,
        });
        expect(defWindowProcSetCursor(edit, edit, setCursorLParam(HTCLIENT))).toBe(0);
        expect(getCurrentCursorHandle()).toBe(getSystemCursorHandle(IDC_IBEAM));
    });

    test("a top-level window makes no offer — GetChildParent is NULL without WS_CHILD", () => {
        const owner = mkWindow({ nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE, wndProc: GUEST_PROC_ADDR });
        // An OWNED popup keeps `parent` set but is not a child: no offer.
        const popup = mkWindow({
            nativeClassName: "Button", style: WS_POPUP | WS_VISIBLE, parent: owner,
            wndProc: DEF_WINDOW_PROC_ADDR,
        });
        expect(defWindowProcSetCursor(popup, popup, setCursorLParam(HTCLIENT))).toBe(0);
        expect(getCurrentCursorHandle()).toBe(getSystemCursorHandle(IDC_ARROW));
    });

    test("a sizing border answers for itself and skips the offer entirely", () => {
        const dlg = mkWindow({
            nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE, wndProc: GUEST_PROC_ADDR,
        });
        const child = mkWindow({
            nativeClassName: "Edit", style: WS_CHILD | WS_VISIBLE, parent: dlg,
            wndProc: DEF_WINDOW_PROC_ADDR,
        });
        const result = defWindowProcSetCursor(child, child, setCursorLParam(HTLEFT));
        expect(result).toBe(1);
        expect(getCurrentCursorHandle()).toBe(getSystemCursorHandle(IDC_SIZEWE));
    });

    test("a non-client hit code that is not a border is the plain arrow", () => {
        const dlg = mkWindow({ nativeClassName: "#32770", style: WS_POPUP | WS_VISIBLE });
        expect(defWindowProcSetCursor(dlg, dlg, setCursorLParam(HTCAPTION))).toBe(0);
        expect(getCurrentCursorHandle()).toBe(getSystemCursorHandle(IDC_ARROW));
    });

    test("a parent cycle terminates instead of walking forever", () => {
        // SetParent can build one; NT has no guard because its tree cannot cycle, ours can.
        const a = mkWindow({ nativeClassName: "Static", style: WS_CHILD | WS_VISIBLE });
        const b = mkWindow({ nativeClassName: "Static", style: WS_CHILD | WS_VISIBLE, parent: a });
        windows.get(a)!.parent = b;
        expect(defWindowProcSetCursor(a, a, setCursorLParam(HTCLIENT))).toBe(0);
    });
});

/**
 * The class-cursor decision has to stay in ONE place. It was re-derived inline in
 * DefWindowProc before, which is how it kept the pre-parent-offer shape; the guard is
 * that nothing else installs a pointer behind SetCursor's back.
 */
describe("installing a cursor has one decision point outside SetCursor", () => {
    const files = readdirSync("src/worker", { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `src/worker/${f}`.replace(/\\/g, "/"));

    test("installCursorAndUpdateHostVisibility is called only by SetCursor and DefWindowProc", () => {
        const callers = files.filter((f) =>
            !f.endsWith("user32/shared-state.ts") // the definition
            && /installCursorAndUpdateHostVisibility\s*\(/.test(readFileSync(f, "utf8")));
        expect(new Set(callers)).toEqual(new Set([
            "src/worker/modules/user32/system.ts", // SetCursor
            "src/worker/modules/user32/window.ts", // defWindowProcSetCursor
        ]));
    });

    test("defWindowProcSetCursor's callers all carry the parent offer out", () => {
        // A caller that treats the plan as a number would silently drop the SEND and
        // apply the class cursor anyway — exactly the bug this closed.
        const callers = files.filter((f) =>
            !f.endsWith("user32/window.ts")
            && /defWindowProcSetCursor\s*\(/.test(readFileSync(f, "utf8")));
        expect(new Set(callers)).toEqual(new Set(["src/worker/modules/user32/message.ts"]));
        for (const f of callers) {
            expect(readFileSync(f, "utf8")).toMatch(/plan\.forwardTo/);
            expect(readFileSync(f, "utf8")).toMatch(/plan\.onParentResult/);
        }
    });
});
