/**
 * DefDlgProc bottoms out in DefWindowProc (Wine defdlg.c DEFDLG_Proc).
 *
 * WM_MOVE / WM_SIZE are produced by DefWindowProc alone, out of WM_WINDOWPOSCHANGED.
 * A dialog manager that answers 0 for everything it does not itself consume therefore
 * never tells a dialog it moved — and a dialog IS moved after creation whenever anything
 * centres it, which is most of them. An app that caches its rect on WM_MOVE then keeps
 * the pre-centring one and draws itself in the top-left corner for the rest of its life.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDialogExports } from '../../src/worker/modules/user32/dialog';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';

const WM_MOVE = 0x0003;
const WM_SIZE = 0x0005;
const WM_WINDOWPOSCHANGED = 0x0047;
const WM_ERASEBKGND = 0x0014;
const SWP_NOCLIENTSIZE = 0x0800;
const SWP_NOCLIENTMOVE = 0x1000;

const DLG = 0x10018;
const GUEST_WNDPROC = 0x00606b2d;
const WINDOWPOS = 0x1000;   // guest WINDOWPOS: hwnd, insertAfter, x, y, cx, cy, flags
const ESP = 0x800;

interface Invocation { wndProc: number; args: number[] }

let invocations: Invocation[];
let mem: Uint8Array;
let dialogApi: Record<string, any>;

function dlgWindow(): WindowInfo {
    return {
        handle: DLG, title: '', style: 0x90000040 /* WS_POPUP|WS_VISIBLE|DS_SETFONT */,
        x: 137, y: 182, width: 366, height: 115,
        children: [], visible: true, wndProc: GUEST_WNDPROC,
        nativeClassName: '#32770',
    } as WindowInfo;
}

/** WINDOWPOS the SetWindowPos path hands to WM_WINDOWPOSCHANGED. */
function writeWindowPos(flags: number): void {
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    dv.setUint32(WINDOWPOS + 0, DLG, true);
    dv.setUint32(WINDOWPOS + 4, 0, true);
    dv.setUint32(WINDOWPOS + 8, 137, true);
    dv.setUint32(WINDOWPOS + 12, 182, true);
    dv.setUint32(WINDOWPOS + 16, 366, true);
    dv.setUint32(WINDOWPOS + 20, 115, true);
    dv.setUint32(WINDOWPOS + 24, flags >>> 0, true);
}

const defDlgProc = (msg: number, wParam: number, lParam: number): unknown =>
    dialogApi['DefDlgProcA']({ esp: ESP, returnAddr: 0x401000 } as never, mem, [DLG, msg, wParam, lParam]);

const sentTo = (hwnd: number, msg: number): boolean =>
    invocations.some((i) => i.wndProc === GUEST_WNDPROC && i.args[0] === hwnd && i.args[1] === msg);

describe('DefDlgProc → DefWindowProc fallthrough', () => {
    beforeEach(() => {
        invocations = [];
        mem = new Uint8Array(0x4000);
        windows.clear();
        windows.set(DLG, dlgWindow());
        (System.getInstance() as unknown as { process: unknown }).process = {
            getModule: () => undefined,
            v86: { mem8: mem },
            getCurrentMemory: () => mem,
            dispatcher: {
                callbackManager: {
                    getStubPoolRange: () => ({ base: 0x21000000, end: 0x21010000 }),
                    saveSuspendedThunkContext: () => 55,
                    invokeCallback: (wndProc: number, args: number[]) => {
                        invocations.push({ wndProc, args });
                        return { callbackId: 0x1000 };
                    },
                },
            },
        };
        Mem.bind(() => mem);
        // The window factory publishes DefWindowProc for the dialog manager to end in.
        createWindowExports();
        dialogApi = createDialogExports();
    });

    afterEach(() => {
        (System.getInstance() as unknown as { process: unknown }).process = undefined;
        windows.clear();
    });

    test('WM_WINDOWPOSCHANGED reaches the dialog as WM_MOVE', () => {
        writeWindowPos(0);
        defDlgProc(WM_WINDOWPOSCHANGED, 0, WINDOWPOS);
        expect(sentTo(DLG, WM_MOVE)).toBe(true);
    });

    // The client did not move, only resize: Windows sets SWP_NOCLIENTMOVE and sends
    // WM_SIZE alone. Sending both regardless would be just as wrong as sending neither.
    test('SWP_NOCLIENTMOVE suppresses WM_MOVE and leaves WM_SIZE', () => {
        writeWindowPos(SWP_NOCLIENTMOVE);
        defDlgProc(WM_WINDOWPOSCHANGED, 0, WINDOWPOS);
        expect(sentTo(DLG, WM_MOVE)).toBe(false);
        expect(sentTo(DLG, WM_SIZE)).toBe(true);
    });

    test('neither flag clear ⇒ no geometry message at all', () => {
        writeWindowPos(SWP_NOCLIENTMOVE | SWP_NOCLIENTSIZE);
        defDlgProc(WM_WINDOWPOSCHANGED, 0, WINDOWPOS);
        expect(sentTo(DLG, WM_MOVE)).toBe(false);
        expect(sentTo(DLG, WM_SIZE)).toBe(false);
    });

    // The dialog manager owns the erase (Wine DEFDLG_Proc fills with the dialog brush);
    // it must NOT reach DefWindowProc's class-brush erase, which a #32770 has no brush for.
    test('WM_ERASEBKGND stays with the dialog manager', () => {
        expect(defDlgProc(WM_ERASEBKGND, 0, 0)).toBe(0);
        expect(invocations.length).toBe(0);
    });
});
