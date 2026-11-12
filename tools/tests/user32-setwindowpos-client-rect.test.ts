/**
 * SetWindowPos and MoveWindow are given the WINDOW rectangle; GetClientRect answers with
 * what is left inside the frame, and GetWindowRect gives the window rectangle back. A
 * title that sizes its window with AdjustWindowRectEx and then reads GetClientRect must
 * see the client area it asked for, and GetWindowRect -> SetWindowPos must be a no-op.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { createWindowExports } from '../../src/worker/modules/user32/window';

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_BORDER = 0x00800000;
const WS_OVERLAPPEDWINDOW = 0x00CF0000;
const WS_EX_CLIENTEDGE = 0x00000200;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOCLIENTSIZE = 0x0800;
const SWP_NOCLIENTMOVE = 0x1000;
const WM_WINDOWPOSCHANGED = 0x0047;

const HWND = 0x44450;
const PARENT = 0x44460;
const RECT = 0x900;
const SCRATCH = 0x800;
const ESP = 0x2000;

let mem: Uint8Array;
let view: DataView;
let saved: Record<string, unknown> = {};
let savedProcess: unknown;
let savedMemGetter: unknown;
let changed: Array<{ x: number; y: number; cx: number; cy: number; flags: number }>;
let exports: ReturnType<typeof createWindowExports>;

function makeWindow(style: number, extra: Partial<WindowInfo> = {}): WindowInfo {
    const win = {
        handle: HWND, title: 'geo', style,
        x: 0, y: 0, width: 320, height: 200,
        children: [], wndProc: 0, userData: 0, visible: false,
        ...extra,
    } as WindowInfo;
    windows.set(win.handle, win);
    return win;
}

const call = (name: string, args: number[]): unknown =>
    exports[name]({ esp: ESP } as never, mem, args as never);

function readRect(): { left: number; top: number; right: number; bottom: number } {
    return {
        left: view.getInt32(RECT, true), top: view.getInt32(RECT + 4, true),
        right: view.getInt32(RECT + 8, true), bottom: view.getInt32(RECT + 12, true),
    };
}
function writeRect(l: number, t: number, r: number, b: number): void {
    view.setInt32(RECT, l, true); view.setInt32(RECT + 4, t, true);
    view.setInt32(RECT + 8, r, true); view.setInt32(RECT + 12, b, true);
}
/** The window rectangle AdjustWindowRectEx computes for a client area at (x, y). */
function adjusted(style: number, exStyle: number, x: number, y: number, w: number, h: number) {
    writeRect(x, y, x + w, y + h);
    expect(call('AdjustWindowRectEx', [RECT, style, 0, exStyle])).toBe(1);
    return readRect();
}
function windowRect() {
    expect(call('GetWindowRect', [HWND, RECT])).toBe(1);
    return readRect();
}
function clientRect() {
    expect(call('GetClientRect', [HWND, RECT])).toBe(1);
    return readRect();
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    changed = [];
    savedMemGetter = (Mem as unknown as Record<string, unknown>).memoryGetter;
    Mem.bind(() => mem);
    const system = System.getInstance();
    const wm = system.windowManager as unknown as Record<string, unknown>;
    saved = {
        getWindow: wm.getWindow, postMessage: wm.postMessage,
        setWindowZOrder: wm.setWindowZOrder, getActiveHwnd: wm.getActiveHwnd,
    };
    wm.getWindow = () => null;
    wm.postMessage = () => {};
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
                    if (args[1] === WM_WINDOWPOSCHANGED) {
                        const p = args[3];
                        changed.push({
                            x: view.getInt32(p + 8, true), y: view.getInt32(p + 12, true),
                            cx: view.getInt32(p + 16, true), cy: view.getInt32(p + 20, true),
                            flags: view.getUint32(p + 24, true),
                        });
                    }
                    queueMicrotask(() => complete?.(0));
                    return { callbackId: 1 };
                },
            },
        },
        memory: { alloc: () => SCRATCH, free: () => {} },
        getModule: () => undefined,
    } as never;
    exports = createWindowExports();
});

afterEach(() => {
    const system = System.getInstance();
    Object.assign(system.windowManager as unknown as Record<string, unknown>, saved);
    system.process = savedProcess as never;
    Mem.bind(savedMemGetter as () => Uint8Array);
    windows.delete(HWND);
    windows.delete(PARENT);
});

const QUIET = SWP_NOZORDER | SWP_NOACTIVATE;

test('a framed window sized with AdjustWindowRectEx gets the client area it asked for', () => {
    const win = makeWindow(WS_OVERLAPPEDWINDOW);
    const outer = adjusted(WS_OVERLAPPEDWINDOW, 0, 100, 80, 640, 480);
    expect(outer.right - outer.left).toBeGreaterThan(640);
    call('SetWindowPos', [HWND, 0, outer.left, outer.top,
        outer.right - outer.left, outer.bottom - outer.top, QUIET]);
    expect(clientRect()).toEqual({ left: 0, top: 0, right: 640, bottom: 480 });
    expect([win.x, win.y]).toEqual([100, 80]);
    expect(windowRect()).toEqual(outer);
});

test('extended edges are part of the frame', () => {
    makeWindow(WS_OVERLAPPEDWINDOW, { exStyle: WS_EX_CLIENTEDGE });
    const outer = adjusted(WS_OVERLAPPEDWINDOW, WS_EX_CLIENTEDGE, 0, 0, 400, 300);
    call('MoveWindow', [HWND, outer.left, outer.top,
        outer.right - outer.left, outer.bottom - outer.top, 0]);
    expect(clientRect()).toEqual({ left: 0, top: 0, right: 400, bottom: 300 });
    expect(windowRect()).toEqual(outer);
});

test('GetWindowRect fed back into SetWindowPos changes nothing, however often', async () => {
    const win = makeWindow(WS_OVERLAPPEDWINDOW, { wndProc: 0x00401000 });
    for (let i = 0; i < 3; i++) {
        const r = windowRect();
        call('SetWindowPos', [HWND, 0, r.left, r.top, r.right - r.left, r.bottom - r.top, QUIET]);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect([win.x, win.y, win.width, win.height]).toEqual([0, 0, 320, 200]);
    // Nothing changed, so no WM_WINDOWPOSCHANGED (and no WM_SIZE out of it) was sent.
    expect(changed).toEqual([]);
});

test('WINDOWPOS carries the window rectangle and flags a real client change', async () => {
    const win = makeWindow(WS_OVERLAPPEDWINDOW, { wndProc: 0x00401000 });
    const outer = adjusted(WS_OVERLAPPEDWINDOW, 0, 10, 20, 800, 600);
    call('SetWindowPos', [HWND, 0, outer.left, outer.top,
        outer.right - outer.left, outer.bottom - outer.top, QUIET]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
        x: outer.left, y: outer.top, cx: outer.right - outer.left, cy: outer.bottom - outer.top,
    });
    expect(changed[0].flags & (SWP_NOCLIENTSIZE | SWP_NOCLIENTMOVE | SWP_NOSIZE | SWP_NOMOVE)).toBe(0);
    expect([win.x, win.y, win.width, win.height]).toEqual([10, 20, 800, 600]);
});

test('a window smaller than its frame has an empty client area', () => {
    const win = makeWindow(WS_OVERLAPPEDWINDOW);
    call('SetWindowPos', [HWND, 0, 0, 0, 2, 2, QUIET | SWP_NOMOVE]);
    expect([win.width, win.height]).toEqual([0, 0]);
});

test('a frameless popup keeps the rectangle it is given', () => {
    const win = makeWindow(WS_POPUP);
    call('SetWindowPos', [HWND, 0, 40, 40, 560, 400, QUIET]);
    expect([win.x, win.y, win.width, win.height]).toEqual([40, 40, 560, 400]);
    expect(windowRect()).toEqual({ left: 40, top: 40, right: 600, bottom: 440 });
});

test('a bordered child keeps the rectangle it is given, in parent coordinates', () => {
    makeWindow(WS_OVERLAPPEDWINDOW, { handle: PARENT, x: 30, y: 50, width: 640, height: 480 });
    const win = makeWindow(WS_CHILD | WS_BORDER, { parent: PARENT });
    call('SetWindowPos', [HWND, 0, 8, 12, 100, 24, QUIET]);
    expect([win.x, win.y, win.width, win.height]).toEqual([8, 12, 100, 24]);
    expect(windowRect()).toEqual({ left: 38, top: 62, right: 138, bottom: 86 });
});

test('SWP_NOSIZE and SWP_NOMOVE leave the other half of the client rectangle alone', () => {
    const win = makeWindow(WS_OVERLAPPEDWINDOW, { x: 5, y: 6 });
    const before = windowRect();
    call('SetWindowPos', [HWND, 0, before.left + 10, before.top + 10, 0, 0, QUIET | SWP_NOSIZE]);
    expect([win.x, win.y, win.width, win.height]).toEqual([15, 16, 320, 200]);
    call('SetWindowPos', [HWND, 0, 0, 0, before.right - before.left + 8, before.bottom - before.top + 4, QUIET | SWP_NOMOVE]);
    expect([win.x, win.y, win.width, win.height]).toEqual([15, 16, 328, 204]);
});
