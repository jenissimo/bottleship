/**
 * SetWindowText / SetDlgItemText SEND WM_SETTEXT (Wine routes all of them through
 * NtUserMessageCall); only the class procedure stores the string.
 *
 * Storing it behind the procedure's back is invisible to a control the guest has
 * SUBCLASSED, and a front-end that renders from what its own subclass proc saw then
 * draws an empty box forever — which is exactly what Worms World Party's team editor
 * did: nine Edits held the right names and every one of them rendered blank.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { createDialogExports } from '../../src/worker/modules/user32/dialog';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';

const WM_SETTEXT = 0x000C;
const WM_GETTEXT = 0x000D;
const WM_GETTEXTLENGTH = 0x000E;

const DLG = 0x10010;
const EDIT = 0x10011;
const PLAIN = 0x10012;
const EDIT_ID = 1011;
const GUEST_WNDPROC = 0x005feb1f;
const STRING_PTR = 0x2000;
const OUT_BUF = 0x2100;
const ESP = 0x800;

interface Invocation { wndProc: number; args: number[] }

let invocations: Invocation[];
let mem: Uint8Array;
let windowApi: Record<string, any>;
let dialogApi: Record<string, any>;

function control(handle: number, wndProc: number, subclassed: boolean): WindowInfo {
    return {
        handle, title: 'Worm 1', style: 0x50010080 /* WS_CHILD|WS_VISIBLE|ES_AUTOHSCROLL */,
        x: 27, y: 57, width: 236, height: 19,
        children: [], visible: true, parent: DLG,
        wndProc, wndProcSubclassed: subclassed,
        isSystemControl: true, systemControlClass: 'Edit', nativeClassName: 'Edit',
        controlId: EDIT_ID,
    } as WindowInfo;
}

const ctx = () => ({ esp: ESP, returnAddr: 0x401000 }) as never;

const setWindowText = (hwnd: number, ptr: number): unknown =>
    windowApi['SetWindowTextA'](ctx(), mem, [hwnd, ptr]);

const defWindowProc = (hwnd: number, msg: number, wParam: number, lParam: number): unknown =>
    windowApi['DefWindowProcA'](ctx(), mem, [hwnd, msg, wParam, lParam]);

const sentSetText = (hwnd: number): Invocation | undefined =>
    invocations.find((i) => i.wndProc === GUEST_WNDPROC && i.args[0] === hwnd && i.args[1] === WM_SETTEXT);

describe('WM_SETTEXT reaches the window procedure', () => {
    beforeEach(() => {
        invocations = [];
        mem = new Uint8Array(0x4000);
        mem.set(new TextEncoder().encode('El Capitan\0'), STRING_PTR);
        windows.clear();
        windows.set(DLG, {
            handle: DLG, title: '#dialog', style: 0x90000044,
            x: 0, y: 0, width: 640, height: 480,
            children: [EDIT], visible: true, nativeClassName: '#32770',
        } as WindowInfo);
        windows.set(PLAIN, {
            handle: PLAIN, title: 'WWPGame', style: 0x98080000,
            x: 0, y: 0, width: 1024, height: 768,
            children: [], visible: true, wndProc: GUEST_WNDPROC,
        } as WindowInfo);
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
        windowApi = createWindowExports();
        dialogApi = createDialogExports();
    });

    afterEach(() => {
        (System.getInstance() as unknown as { process: unknown }).process = undefined;
        windows.clear();
    });

    // The defect: the guest owns this control's procedure, so it is the only thing that
    // can learn the caption changed. Assigning our record instead tells it nothing.
    test('SetWindowText on a subclassed control sends WM_SETTEXT to the guest proc', () => {
        windows.set(EDIT, control(EDIT, GUEST_WNDPROC, true));
        const result = setWindowText(EDIT, STRING_PTR) as { suspendedForCallback?: boolean };
        const sent = sentSetText(EDIT);
        expect(sent).toBeDefined();
        // The guest gets the caller's own pointer, as Win32 passes it through.
        expect(sent!.args[3]).toBe(STRING_PTR);
        expect(result.suspendedForCallback).toBe(true);
    });

    test('SetDlgItemText on a subclassed control sends WM_SETTEXT to the guest proc', () => {
        windows.set(EDIT, control(EDIT, GUEST_WNDPROC, true));
        dialogApi['SetDlgItemTextA'](ctx(), mem, [DLG, EDIT_ID, STRING_PTR]);
        expect(sentSetText(EDIT)?.args[3]).toBe(STRING_PTR);
    });

    // The class procedure is what stores it — that is where a subclass that forwards
    // (MFC, ATL) ends up, and without it the caption would never be recorded at all.
    test('the forwarded WM_SETTEXT stores the text in DefWindowProc', () => {
        windows.set(EDIT, control(EDIT, GUEST_WNDPROC, true));
        defWindowProc(EDIT, WM_SETTEXT, 0, STRING_PTR);
        expect(windows.get(EDIT)!.title).toBe('El Capitan');
    });

    // A control WE drive still answers from our own implementation: no guest procedure
    // owns it, so there is nobody to send to and the default handling stores it inline.
    test('an un-subclassed control is stored without re-entering the guest', () => {
        windows.set(EDIT, control(EDIT, 0x21000060 /* our DefWindowProc thunk */, false));
        expect(setWindowText(EDIT, STRING_PTR)).toBe(1);
        expect(invocations.length).toBe(0);
        expect(windows.get(EDIT)!.title).toBe('El Capitan');
    });

    // DefWindowProc is also where a forwarding procedure asks for the text back; before
    // this it answered 0/empty for every window that was not one of our own controls.
    test('DefWindowProc answers WM_GETTEXT / WM_GETTEXTLENGTH', () => {
        expect(defWindowProc(PLAIN, WM_GETTEXTLENGTH, 0, 0)).toBe('WWPGame'.length);
        expect(defWindowProc(PLAIN, WM_GETTEXT, 32, OUT_BUF)).toBe('WWPGame'.length);
        expect(new TextDecoder().decode(mem.subarray(OUT_BUF, OUT_BUF + 8))).toBe('WWPGame\0');
    });

    // Both halves have to go the same way. A subclass that keeps the string itself and
    // never forwards leaves our record permanently stale, and a reader that answers from
    // it hands back an empty caption for text the guest is displaying on screen.
    test('GetWindowText / GetWindowTextLength ask the same procedure', () => {
        windows.set(EDIT, control(EDIT, GUEST_WNDPROC, true));
        windowApi['GetWindowTextA'](ctx(), mem, [EDIT, OUT_BUF, 32]);
        windowApi['GetWindowTextLengthA'](ctx(), mem, [EDIT]);
        const asked = invocations.filter((i) => i.wndProc === GUEST_WNDPROC && i.args[0] === EDIT);
        expect(asked.map((i) => i.args[1])).toEqual([WM_GETTEXT, WM_GETTEXTLENGTH]);
        // WM_GETTEXT carries the caller's own buffer and capacity, as Win32 passes them.
        expect(asked[0].args[2]).toBe(32);
        expect(asked[0].args[3]).toBe(OUT_BUF);
    });

    test('an un-subclassed control is read without re-entering the guest', () => {
        windows.set(EDIT, control(EDIT, 0x21000060 /* our DefWindowProc thunk */, false));
        expect(windowApi['GetWindowTextLengthA'](ctx(), mem, [EDIT])).toBe('Worm 1'.length);
        expect(invocations.length).toBe(0);
    });
});
