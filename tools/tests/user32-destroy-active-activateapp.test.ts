/**
 * #234: the active window goes away and no window takes over its activation.
 *
 * Windows activates nothing then (Wine activate_other_window -> set_active_window(0)) and
 * tells the window, before WM_DESTROY, WM_NCACTIVATE(FALSE) / WM_ACTIVATE(WA_INACTIVE), and
 * every top-level window of its thread WM_ACTIVATEAPP(FALSE). The app's next window is then
 * a real application activation and hears WM_ACTIVATEAPP(TRUE). Each TRUE follows a FALSE:
 * zeroing the active window silently made Neverwinter Nights hear TRUE after TRUE and rebuild
 * its window on each one, in a loop.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { windows } from '../../src/worker/modules/user32/shared-state';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { createClassExports } from '../../src/worker/modules/user32/class';
import { resetPostedActivations } from '../../src/worker/modules/user32/activation-messages';

const WM_DESTROY = 0x0002;
const WM_ACTIVATE = 0x0006;
const WM_SETFOCUS = 0x0007;
const WM_KILLFOCUS = 0x0008;
const WM_ACTIVATEAPP = 0x001c;
const WM_NCDESTROY = 0x0082;
const WM_NCACTIVATE = 0x0086;
const TRACKED = new Set([WM_DESTROY, WM_ACTIVATE, WM_SETFOCUS, WM_KILLFOCUS, WM_ACTIVATEAPP, WM_NCDESTROY, WM_NCACTIVATE]);

const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const WS_OVERLAPPEDWINDOW = 0x00CF0000;
const WS_VISIBLE = 0x10000000;

const WNDPROC = 0x00401000;
const WNDCLASS = 0x11000;
const CLASS_NAME = 0x11100;
const SCRATCH = 0x3000;
const ESP = 0x2000;

type Event = [kind: 'sent' | 'posted', hwnd: number, msg: number, wParam: number, lParam: number];

let log: Event[] = [];
let pending: Array<() => unknown> = [];
let mem: Uint8Array;
let saved: Record<string, unknown> = {};
let savedProcess: unknown;
let savedMemGetter: unknown;
const created: number[] = [];

beforeEach(() => {
    log = [];
    pending = [];
    mem = new Uint8Array(0x20000);
    savedMemGetter = (Mem as unknown as Record<string, unknown>).memoryGetter;
    Mem.bind(() => mem);
    const system = System.getInstance();
    const wm = system.windowManager;
    // Whether another window can take the activation is the point here, so start from a
    // desktop with none: drop what earlier test files left in the shared WindowManager.
    for (const win of wm.getAllWindows()) {
        windows.delete(win.hwnd);
        wm.destroyWindow(win.hwnd);
    }
    const active = wm.getActiveHwnd();
    if (active) wm.clearActiveWindow(active);
    wm.removePostedMessages(() => true);
    resetPostedActivations();
    const wmAny = wm as unknown as Record<string, unknown>;
    saved = { postMessage: wmAny.postMessage, setWindowZOrder: wmAny.setWindowZOrder };
    wmAny.postMessage = (hwnd: number, msg: number, wParam: number, lParam: number) => {
        log.push(['posted', hwnd >>> 0, msg, wParam >>> 0, lParam >>> 0]);
        return true;
    };
    wmAny.setWindowZOrder = () => {};
    savedProcess = system.process;
    system.process = {
        v86: { mem8: mem },
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 1,
                getStubPoolRange: () => ({ base: 0xf0000000, end: 0xf0001000 }),
                invokeCallback: (_p: number, args: number[], _f: number, complete?: (r: number) => unknown) => {
                    log.push(['sent', args[0]! >>> 0, args[1]!, (args[2] ?? 0) >>> 0, (args[3] ?? 0) >>> 0]);
                    if (complete) pending.push(() => complete(0));
                    return { callbackId: log.length };
                },
            },
        },
        memory: { alloc: () => SCRATCH, free: () => {} },
        getModule: () => undefined,
        getCurrentMemory: () => mem,
    } as never;
    mem.set(new TextEncoder().encode('ActivateAppTest\0'), CLASS_NAME);
    const dv = new DataView(mem.buffer);
    dv.setUint32(WNDCLASS + 4, WNDPROC, true);
    dv.setUint32(WNDCLASS + 16, 0x400000, true);
    dv.setUint32(WNDCLASS + 36, CLASS_NAME, true);
    createClassExports()['RegisterClassA']!({ esp: ESP } as never, mem, [WNDCLASS] as never);
});

afterEach(() => {
    const system = System.getInstance();
    const wm = system.windowManager;
    Object.assign(wm as unknown as Record<string, unknown>, saved);
    system.process = savedProcess as never;
    Mem.bind(savedMemGetter as () => Uint8Array);
    for (const h of created.splice(0)) {
        windows.delete(h);
        wm.destroyWindow(h);
    }
    const active = wm.getActiveHwnd();
    if (active) wm.clearActiveWindow(active);
    wm.removePostedMessages(() => true);
    resetPostedActivations();
});

function drain(): void {
    for (let guard = 0; pending.length && guard < 256; guard++) pending.shift()!();
}

function create(style: number): number {
    const r = createWindowExports()['CreateWindowExA']!({ esp: ESP } as never, mem,
        [0, CLASS_NAME, 0, style >>> 0, 10, 20, 400, 300, 0, 0, 0x400000, 0] as never) as { value: number } | number;
    const hwnd = typeof r === 'number' ? r : r.value;
    created.push(hwnd);
    drain();
    return hwnd;
}

function show(hwnd: number, cmd: number): void {
    createWindowExports()['ShowWindow']!({ esp: ESP } as never, mem, [hwnd, cmd] as never);
    drain();
}

function destroy(hwnd: number): void {
    createWindowExports()['DestroyWindow']!({ esp: ESP } as never, mem, [hwnd] as never);
    drain();
}

/** The activation-relevant messages since `from`, in the order the app would see them. */
function trace(from = 0): Event[] {
    return log.slice(from).filter(([, , msg]) => TRACKED.has(msg));
}

const appActivations = (from = 0): number[] =>
    trace(from).filter(([, , msg]) => msg === WM_ACTIVATEAPP).map(([, , , wParam]) => wParam);

test('destroying the only active window deactivates the app before WM_DESTROY', () => {
    const wm = System.getInstance().windowManager;
    const main = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    expect(wm.getActiveHwnd()).toBe(main);
    const mark = log.length;
    destroy(main);
    expect(trace(mark)).toEqual([
        ['sent', main, WM_NCACTIVATE, 0, 0],
        ['sent', main, WM_ACTIVATE, 0, 0],
        ['sent', main, WM_ACTIVATEAPP, 0, 0],
        ['sent', main, WM_KILLFOCUS, 0, 0],
        ['sent', main, WM_DESTROY, 0, 0],
        ['sent', main, WM_NCDESTROY, 0, 0],
    ]);
    expect(wm.getActiveHwnd()).toBe(0);
    expect(wm.getForegroundHwnd()).toBe(0);
});

test('a window rebuilt after destroying the active one: one FALSE then one TRUE per rebuild, never TRUE twice', () => {
    const wm = System.getInstance().windowManager;
    let win = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    const mark = log.length;
    for (let rebuild = 0; rebuild < 3; rebuild++) {
        destroy(win);
        win = create(WS_OVERLAPPEDWINDOW);
        show(win, SW_SHOWNORMAL);
        expect(wm.getActiveHwnd()).toBe(win);
    }
    expect(appActivations(mark)).toEqual([0, 1, 0, 1, 0, 1]);
    // The rebuilt window is announced as a real application activation, then activated.
    const last = trace(mark).filter(([, hwnd]) => hwnd === win);
    expect(last).toEqual([
        ['posted', win, WM_ACTIVATEAPP, 1, 0],
        ['posted', win, WM_NCACTIVATE, 1, 0],
        ['posted', win, WM_ACTIVATE, 1, 0],
        ['posted', win, WM_SETFOCUS, 0, 0],
    ]);
});

test('splash destroyed, then the main window of the same thread is shown: main is activated with WM_ACTIVATEAPP(TRUE)', () => {
    const wm = System.getInstance().windowManager;
    const splash = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    const main = create(WS_OVERLAPPEDWINDOW); // created hidden while the splash is up
    const mark = log.length;
    destroy(splash);
    // Every top-level window of the thread hears the app lose activation, the hidden main
    // too, in Z-order (the later-created main sits above the splash).
    expect(trace(mark).filter(([, , msg]) => msg === WM_ACTIVATEAPP)).toEqual([
        ['sent', main, WM_ACTIVATEAPP, 0, 0],
        ['sent', splash, WM_ACTIVATEAPP, 0, 0],
    ]);
    const shown = log.length;
    show(main, SW_SHOWNORMAL);
    expect(wm.getActiveHwnd()).toBe(main);
    expect(trace(shown)).toEqual([
        ['posted', main, WM_ACTIVATEAPP, 1, 0],
        ['posted', main, WM_NCACTIVATE, 1, 0],
        ['posted', main, WM_ACTIVATE, 1, 0],
        ['posted', main, WM_SETFOCUS, 0, 0],
    ]);
});

test('a visible window that takes over the activation keeps it inside the app: no WM_ACTIVATEAPP', () => {
    const wm = System.getInstance().windowManager;
    const back = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    const front = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    const mark = log.length;
    destroy(front);
    expect(wm.getActiveHwnd()).toBe(back);
    expect(appActivations(mark)).toEqual([]);
});

test('hiding the only active window deactivates the app; showing it again reactivates it once', () => {
    const wm = System.getInstance().windowManager;
    const main = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    const mark = log.length;
    show(main, SW_HIDE);
    expect(wm.getActiveHwnd()).toBe(0);
    expect(trace(mark)).toEqual([
        ['posted', main, WM_NCACTIVATE, 0, 0],
        ['posted', main, WM_ACTIVATE, 0, 0],
        ['posted', main, WM_ACTIVATEAPP, 0, 0],
        ['posted', main, WM_KILLFOCUS, 0, 0],
    ]);
    show(main, SW_SHOWNORMAL);
    expect(wm.getActiveHwnd()).toBe(main);
    expect(appActivations(mark)).toEqual([0, 1]);
});
