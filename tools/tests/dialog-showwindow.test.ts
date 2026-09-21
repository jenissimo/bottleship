import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { windows } from '../../src/worker/modules/user32/shared-state';
import { createDialogExports } from '../../src/worker/modules/user32/dialog';
import { showDialogWindow } from '../../src/worker/modules/user32/window-visibility';

const WM_INITDIALOG = 0x0110;
const WM_SHOWWINDOW = 0x0018;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const DLGPROC = 0x00401000;
const TEMPLATE_AT = 0x100;

interface Posted { hwnd: number; msg: number; wParam: number }
interface Invoked { proc: number; args: number[]; complete: (ret: number) => unknown }

let posted: Posted[] = [];
let invoked: Invoked[] = [];
let savedPostMessage: unknown;
let savedProcess: unknown;
let created: number[] = [];

/** Minimal non-extended DLGTEMPLATE with no menu/class/title and no controls. */
function writeTemplate(mem: Uint8Array, style: number): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(TEMPLATE_AT + 0, style >>> 0, true);
    view.setUint32(TEMPLATE_AT + 4, 0, true);
    view.setUint16(TEMPLATE_AT + 8, 0, true);   // cdit
    view.setInt16(TEMPLATE_AT + 10, 0, true);   // x
    view.setInt16(TEMPLATE_AT + 12, 0, true);   // y
    view.setInt16(TEMPLATE_AT + 14, 100, true); // cx
    view.setInt16(TEMPLATE_AT + 16, 80, true);  // cy
    view.setUint16(TEMPLATE_AT + 18, 0, true);  // menu
    view.setUint16(TEMPLATE_AT + 20, 0, true);  // class
    view.setUint16(TEMPLATE_AT + 22, 0, true);  // title
}

function showMessages(): Posted[] {
    return posted.filter((m) => m.msg === WM_SHOWWINDOW);
}

beforeEach(() => {
    posted = [];
    invoked = [];
    created = [];
    const system = System.getInstance();
    const wm = system.windowManager as unknown as Record<string, unknown>;
    savedPostMessage = wm.postMessage;
    wm.postMessage = (hwnd: number, msg: number, wParam: number) => { posted.push({ hwnd, msg, wParam }); };

    savedProcess = system.process;
    system.process = {
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 1,
                invokeCallback: (proc: number, args: number[], _f: number, complete: (r: number) => unknown) => {
                    invoked.push({ proc, args, complete });
                    return { callbackId: 1 };
                },
            },
        },
        memory: { alloc: () => 0, free: () => {} },
        getModule: () => undefined,
    } as never;
});

afterEach(() => {
    const system = System.getInstance();
    (system.windowManager as unknown as Record<string, unknown>).postMessage = savedPostMessage;
    system.process = savedProcess as never;
    for (const hwnd of created) {
        for (const child of windows.get(hwnd)?.children ?? []) windows.delete(child);
        windows.delete(hwnd);
        system.windowManager.destroyWindow(hwnd);
    }
});

function runDialog(exportName: string, style: number): number {
    const mem = new Uint8Array(0x1000);
    writeTemplate(mem, style);
    // The modeless path reads the template through the process's guest memory.
    (System.getInstance().process as unknown as Record<string, unknown>).v86 = { mem8: mem };
    const exports = createDialogExports();
    exports[exportName]({} as never, mem, [0x400000, TEMPLATE_AT, 0, DLGPROC, 0] as never);

    // The dialog manager sends WM_INITDIALOG first; the fake callback manager records it.
    const init = invoked.find((c) => c.args[1] === WM_INITDIALOG);
    expect(init).toBeDefined();
    const hwnd = init!.args[0];
    created.push(hwnd);
    return hwnd;
}

// Win32 creates the dialog HIDDEN and sends WM_INITDIALOG while it is still hidden —
// that is where apps size, populate and position controls. A dialog already on screen
// during its own init flickers and can be painted half-initialised.
test('WM_INITDIALOG runs before the dialog is visible', () => {
    const hwnd = runDialog('CreateDialogIndirectParamA', WS_POPUP | WS_VISIBLE);

    expect(windows.get(hwnd)!.visible).toBe(false);
    expect(windows.get(hwnd)!.style & WS_VISIBLE).toBe(0);
    expect(showMessages()).toHaveLength(0);
});

// Showing the dialog after init is what delivers WM_SHOWWINDOW(TRUE) — exactly one,
// on the transition. HL's launcher loads its background DIB in that handler.
test('a WS_VISIBLE template is shown after init with one WM_SHOWWINDOW(TRUE)', () => {
    const hwnd = runDialog('CreateDialogIndirectParamA', WS_POPUP | WS_VISIBLE);
    invoked.find((c) => c.args[1] === WM_INITDIALOG)!.complete(1);

    const shows = showMessages();
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({ hwnd, wParam: 1 });
    expect(windows.get(hwnd)!.visible).toBe(true);
    expect(windows.get(hwnd)!.style & WS_VISIBLE).toBe(WS_VISIBLE);
});

// A modeless template WITHOUT WS_VISIBLE stays hidden until the app calls ShowWindow.
test('a template without WS_VISIBLE stays hidden and gets no WM_SHOWWINDOW', () => {
    const hwnd = runDialog('CreateDialogIndirectParamA', WS_POPUP);
    invoked.find((c) => c.args[1] === WM_INITDIALOG)!.complete(1);

    expect(windows.get(hwnd)!.visible).toBe(false);
    expect(showMessages()).toHaveLength(0);
});

// DialogBoxIndirectParam shows the dialog before entering its message loop whatever
// the template says.
test('a modal dialog is shown after init even without WS_VISIBLE in the template', () => {
    const hwnd = runDialog('DialogBoxIndirectParamA', WS_POPUP);
    expect(windows.get(hwnd)!.visible).toBe(false);
    expect(showMessages()).toHaveLength(0);

    invoked.find((c) => c.args[1] === WM_INITDIALOG)!.complete(1);

    const shows = showMessages();
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({ hwnd, wParam: 1 });
    expect(windows.get(hwnd)!.visible).toBe(true);
});

// The message belongs to the transition: a second show announces nothing, and a
// spurious WM_SHOWWINDOW re-runs the app's show-time work.
test('showing an already-visible window posts no second WM_SHOWWINDOW', () => {
    const hwnd = runDialog('DialogBoxIndirectParamA', WS_POPUP | WS_VISIBLE);
    invoked.find((c) => c.args[1] === WM_INITDIALOG)!.complete(1);
    expect(showMessages()).toHaveLength(1);

    expect(showDialogWindow(hwnd)).toBe(false);
    expect(showMessages()).toHaveLength(1);
});
