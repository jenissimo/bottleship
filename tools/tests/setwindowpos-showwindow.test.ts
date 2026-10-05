/**
 * The SetWindowPos / ShowWindow half of the WM_SHOWWINDOW visibility contract.
 *
 * Measured against real user32 (Windows 11, a DefWindowProc window logging its own
 * messages): SetWindowPos does NOT send WM_SHOWWINDOW, for either SWP_SHOWWINDOW or
 * SWP_HIDEWINDOW, top-level or child. ShowWindow is the only API that sends it, and it
 * sends it BEFORE the WM_WINDOWPOSCHANGING/CHANGED pair, while WS_VISIBLE still holds
 * its old value. These tests pin both the presence and the ABSENCE, because adding the
 * message to SetWindowPos is a plausible-looking "fix" that would double-deliver it to
 * every app that shows a window through SetWindowPos.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { createWindowExports } from '../../src/worker/modules/user32/window';

const WM_SHOWWINDOW = 0x0018;
const WM_WINDOWPOSCHANGING = 0x0046;
const WM_WINDOWPOSCHANGED = 0x0047;

const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;

const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_SHOWNA = 8;

const QUIET = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;

const HWND = 0x44440;
const WNDPROC = 0x00401000;
const SCRATCH = 0x800;
const ESP = 0x2000;
const RETADDR = 0x00402000;

interface Posted { hwnd: number; msg: number; wParam: number }
interface Invoked { args: number[]; complete?: (ret: number) => unknown }

let posted: Posted[] = [];
let invoked: Invoked[] = [];
let mem: Uint8Array;
let saved: Record<string, unknown> = {};
let savedProcess: unknown;
let savedMemGetter: unknown;

function makeWindow(visible: boolean): WindowInfo {
    return {
        handle: HWND,
        title: 'swp',
        style: WS_POPUP | (visible ? WS_VISIBLE : 0),
        x: 0, y: 0, width: 320, height: 200,
        children: [],
        wndProc: WNDPROC,
        userData: 0,
        visible,
    } as WindowInfo;
}

/** Messages the window actually received, sent (invokeCallback) or posted, in order. */
function received(): number[] {
    return invoked.map((c) => c.args[1]);
}
function showMessages(): Array<{ wParam: number }> {
    return [
        ...invoked.filter((c) => c.args[1] === WM_SHOWWINDOW).map((c) => ({ wParam: c.args[2] })),
        ...posted.filter((m) => m.msg === WM_SHOWWINDOW).map((m) => ({ wParam: m.wParam })),
    ];
}
/** Drain the suspended-callback chain the way a returning guest WndProc would. */
function completeAll(): void {
    for (let i = 0; i < invoked.length; i++) invoked[i].complete?.(0);
}

beforeEach(() => {
    posted = [];
    invoked = [];
    mem = new Uint8Array(0x10000);
    new DataView(mem.buffer).setUint32(ESP, RETADDR, true);

    savedMemGetter = (Mem as unknown as Record<string, unknown>).memoryGetter;
    Mem.bind(() => mem);

    const system = System.getInstance();
    const wm = system.windowManager as unknown as Record<string, unknown>;
    saved = {
        getWindow: wm.getWindow,
        postMessage: wm.postMessage,
        setWindowZOrder: wm.setWindowZOrder,
        getActiveHwnd: wm.getActiveHwnd,
    };
    wm.getWindow = () => null;
    wm.postMessage = (hwnd: number, msg: number, wParam: number) => { posted.push({ hwnd, msg, wParam }); };
    wm.setWindowZOrder = () => {};
    wm.getActiveHwnd = () => HWND;

    savedProcess = system.process;
    system.process = {
        v86: { mem8: mem },
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 1,
                getStubPoolRange: () => ({ base: 0xf0000000, end: 0xf0001000 }),
                invokeCallback: (_p: number, args: number[], _f: number, complete?: (r: number) => unknown) => {
                    invoked.push({ args, complete });
                    return { callbackId: 1 };
                },
            },
        },
        memory: { alloc: () => SCRATCH, free: () => {} },
        getModule: () => undefined,
    } as never;
});

afterEach(() => {
    const system = System.getInstance();
    Object.assign(system.windowManager as unknown as Record<string, unknown>, saved);
    system.process = savedProcess as never;
    Mem.bind(savedMemGetter as () => Uint8Array);
    windows.delete(HWND);
});

function setWindowPos(flags: number): void {
    const exports = createWindowExports();
    exports['SetWindowPos']({ esp: ESP } as never, mem, [HWND, 0, 0, 0, 0, 0, flags] as never);
}
function showWindow(cmd: number): void {
    const exports = createWindowExports();
    exports['ShowWindow']({ esp: ESP } as never, mem, [HWND, cmd] as never);
}

// ---------------------------------------------------------------------------
// SetWindowPos — the message it must NOT send.
// ---------------------------------------------------------------------------

// Real user32: SetWindowPos(hidden, SWP_SHOWWINDOW) delivers WM_WINDOWPOSCHANGING,
// flips WS_VISIBLE, then WM_WINDOWPOSCHANGED. No WM_SHOWWINDOW at any point.
test('SetWindowPos(SWP_SHOWWINDOW) shows the window and sends no WM_SHOWWINDOW', () => {
    windows.set(HWND, makeWindow(false));
    setWindowPos(QUIET | SWP_SHOWWINDOW);
    completeAll();

    expect(received()).toEqual([WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED]);
    expect(showMessages()).toHaveLength(0);
    expect(windows.get(HWND)!.visible).toBe(true);
    expect(windows.get(HWND)!.style & WS_VISIBLE).toBe(WS_VISIBLE);
});

// The visibility flip lands BETWEEN the two messages: hidden while the app is still
// allowed to veto the change, visible by the time it is told the change happened.
test('SetWindowPos(SWP_SHOWWINDOW) flips WS_VISIBLE between CHANGING and CHANGED', () => {
    windows.set(HWND, makeWindow(false));
    const visibleAt: Record<number, boolean> = {};

    const exports = createWindowExports();
    const system = System.getInstance();
    const cbm = (system.process as unknown as { dispatcher: { callbackManager: Record<string, unknown> } })
        .dispatcher.callbackManager;
    const realInvoke = cbm.invokeCallback as (...a: unknown[]) => unknown;
    cbm.invokeCallback = (...a: unknown[]) => {
        const args = a[1] as number[];
        visibleAt[args[1]] = windows.get(HWND)!.visible;
        return realInvoke(...a);
    };
    exports['SetWindowPos']({ esp: ESP } as never, mem, [HWND, 0, 0, 0, 0, 0, QUIET | SWP_SHOWWINDOW] as never);
    completeAll();

    expect(visibleAt[WM_WINDOWPOSCHANGING]).toBe(false);
    expect(visibleAt[WM_WINDOWPOSCHANGED]).toBe(true);
});

test('SetWindowPos(SWP_HIDEWINDOW) hides the window and sends no WM_SHOWWINDOW', () => {
    windows.set(HWND, makeWindow(true));
    setWindowPos(QUIET | SWP_HIDEWINDOW);
    completeAll();

    expect(received()).toEqual([WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED]);
    expect(showMessages()).toHaveLength(0);
    expect(windows.get(HWND)!.visible).toBe(false);
    expect(windows.get(HWND)!.style & WS_VISIBLE).toBe(0);
});

// A no-op show is announced as a candidate change and then dropped: real user32 sends
// WM_WINDOWPOSCHANGING and, having nothing to do, no WM_WINDOWPOSCHANGED.
test('SetWindowPos(SWP_SHOWWINDOW) on an already-visible window changes nothing', () => {
    windows.set(HWND, makeWindow(true));
    setWindowPos(QUIET | SWP_SHOWWINDOW);
    completeAll();

    expect(received()).toEqual([WM_WINDOWPOSCHANGING]);
    expect(showMessages()).toHaveLength(0);
    expect(windows.get(HWND)!.visible).toBe(true);
});

// ---------------------------------------------------------------------------
// ShowWindow — the one API that does send it.
// ---------------------------------------------------------------------------

// ShowWindow sends WM_SHOWWINDOW(TRUE) before it makes the window visible: the app's
// handler runs with WS_VISIBLE still clear, which is what the documented "is being
// shown" wording means. HL's launcher loads its background DIB in that handler.
test('ShowWindow(SW_SHOW) on a hidden window sends one WM_SHOWWINDOW(TRUE) first', () => {
    windows.set(HWND, makeWindow(false));
    showWindow(SW_SHOW);

    expect(received()).toEqual([WM_SHOWWINDOW]);
    expect(invoked[0].args[2]).toBe(1);
    // The message precedes the transition, not the other way round.
    expect(windows.get(HWND)!.visible).toBe(false);

    invoked[0].complete?.(0);
    expect(windows.get(HWND)!.visible).toBe(true);
    expect(showMessages()).toHaveLength(1);
});

test('ShowWindow(SW_HIDE) on a visible window sends one WM_SHOWWINDOW(FALSE) first', () => {
    windows.set(HWND, makeWindow(true));
    showWindow(SW_HIDE);

    expect(received()).toEqual([WM_SHOWWINDOW]);
    expect(invoked[0].args[2]).toBe(0);
    expect(windows.get(HWND)!.visible).toBe(true);

    invoked[0].complete?.(0);
    expect(windows.get(HWND)!.visible).toBe(false);
    expect(showMessages()).toHaveLength(1);
});

// The message belongs to the TRANSITION. A duplicate re-runs the app's show-time work.
test('ShowWindow(SW_SHOW) on an already-visible window sends no WM_SHOWWINDOW', () => {
    windows.set(HWND, makeWindow(true));
    showWindow(SW_SHOW);

    expect(showMessages()).toHaveLength(0);
});

test('ShowWindow(SW_HIDE) on an already-hidden window sends no WM_SHOWWINDOW', () => {
    windows.set(HWND, makeWindow(false));
    showWindow(SW_HIDE);

    expect(showMessages()).toHaveLength(0);
});

// SW_SHOWNA is the documented exception: real user32 sends WM_SHOWWINDOW(TRUE) for it
// even when the window is already visible, so this one is NOT gated on the transition.
test('ShowWindow(SW_SHOWNA) sends WM_SHOWWINDOW even on an already-visible window', () => {
    windows.set(HWND, makeWindow(true));
    showWindow(SW_SHOWNA);

    const shows = showMessages();
    expect(shows).toHaveLength(1);
    expect(shows[0].wParam).toBe(1);
});
