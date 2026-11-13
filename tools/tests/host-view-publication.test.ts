/**
 * The host surface shows one rectangle V of the virtual screen, chosen by one rule
 * (host-view-policy): the client rectangle of the foreground window's root, clipped to the
 * screen, or the screen when that root covers it, is a popup, is not there, when exclusive
 * DirectDraw owns the display, when a visible top-level window outside V would be cut away,
 * or when the "show the whole desktop" setting is on. V is published only when it changes.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System, type HostView } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { getVirtualScreenRect, windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { installHostViewPolicy, selectHostView } from '../../src/worker/runtime/windowing/host-view-policy';
import { EmulatorConfig } from '../../src/worker/core/emulator-config-manager';
import { WindowManager } from '../../src/worker/runtime/windowing/window-manager';

const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SW_SHOW = 5;

const HWND = 0x44470;
const OTHER = 0x44480;
const THIRD = 0x44490;
const ESP = 0x2000;

let mem: Uint8Array;
let published: HostView[];
let saved: Record<string, unknown> = {};
let savedProcess: unknown;
let savedMemGetter: unknown;
let exports: ReturnType<typeof createWindowExports>;
let foreground = 0;
let savedWindows: Array<[number, WindowInfo]> = [];
let savedDdrawContext: unknown;

function makeWindow(
    handle: number, style: number, x: number, y: number, w: number, h: number, extra: Partial<WindowInfo> = {},
): WindowInfo {
    const win = {
        handle, title: 'view', style, x, y, width: w, height: h,
        children: [], wndProc: 0, userData: 0, visible: (style & WS_VISIBLE) !== 0,
        ...extra,
    } as WindowInfo;
    windows.set(handle, win);
    return win;
}
const call = (name: string, args: number[]): unknown =>
    exports[name]({ esp: ESP } as never, mem, args as never);

beforeEach(() => {
    // Windows and the DirectDraw context are process-wide; the rule reads both, so this file
    // starts from none of either and puts back what it found.
    savedWindows = [...windows.entries()];
    windows.clear();
    savedDdrawContext = (System.getInstance() as unknown as { ddrawContext: unknown }).ddrawContext;
    (System.getInstance() as unknown as { ddrawContext: unknown }).ddrawContext = null;
    EmulatorConfig.getInstance().showWholeDesktop = false;
    mem = new Uint8Array(0x10000);
    published = [];
    savedMemGetter = (Mem as unknown as Record<string, unknown>).memoryGetter;
    Mem.bind(() => mem);
    const system = System.getInstance();
    const wm = system.windowManager as unknown as Record<string, unknown>;
    saved = {
        getWindow: wm.getWindow, postMessage: wm.postMessage,
        setWindowZOrder: wm.setWindowZOrder, getActiveHwnd: wm.getActiveHwnd,
        getForegroundHwnd: wm.getForegroundHwnd,
    };
    wm.getWindow = () => null;
    wm.postMessage = () => {};
    wm.setWindowZOrder = () => {};
    wm.getActiveHwnd = () => HWND;
    foreground = HWND;
    wm.getForegroundHwnd = () => foreground;
    savedProcess = system.process;
    system.process = {
        v86: { mem8: mem },
        memory: { alloc: () => 0x800, free: () => {} },
        getModule: () => undefined,
    } as never;
    system.setHostViewSelector(null);
    system.requestHostResize(640, 480, { modeSet: true });
    system.setHostViewSelector(selectHostView);
    system.setHostResizeCallback((view) => { published.push({ ...view }); });
    exports = createWindowExports();
});

afterEach(() => {
    const system = System.getInstance();
    system.setHostResizeCallback(() => {});
    system.setHostViewSelector(null);
    system.requestHostResize(0, 0);
    EmulatorConfig.getInstance().showWholeDesktop = false;
    Object.assign(system.windowManager as unknown as Record<string, unknown>, saved);
    system.process = savedProcess as never;
    Mem.bind(savedMemGetter as () => Uint8Array);
    windows.clear();
    for (const [h, w] of savedWindows) windows.set(h, w);
    (System.getInstance() as unknown as { ddrawContext: unknown }).ddrawContext = savedDdrawContext;
});

const view = () => System.getInstance().hostView;
const FRAMED = WS_VISIBLE;
const POPUP = (WS_POPUP | WS_VISIBLE) >>> 0;

test('the foreground window\'s client rectangle is the view, with its screen origin', () => {
    makeWindow(HWND, 0, 40, 40, 560, 400);
    call('ShowWindow', [HWND, SW_SHOW]);
    expect(published).toEqual([{ x: 40, y: 40, width: 560, height: 400 }]);
});

test('no foreground window, a popup root, a minimised or hidden root show the screen', () => {
    makeWindow(HWND, POPUP, 40, 40, 560, 400);
    foreground = 0;
    System.getInstance().refreshHostView();
    foreground = HWND;
    System.getInstance().refreshHostView();
    windows.get(HWND)!.style = FRAMED | 0x20000000;
    System.getInstance().refreshHostView();
    windows.get(HWND)!.style = 0;
    windows.get(HWND)!.visible = false;
    System.getInstance().refreshHostView();
    expect(published).toEqual([]);
    expect(view()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
});

test('a root that covers the screen, or reaches past it everywhere, is the screen; one partly off it is clipped', () => {
    makeWindow(HWND, FRAMED, 0, 0, 640, 480);
    System.getInstance().refreshHostView();
    windows.get(HWND)!.width = 1024; windows.get(HWND)!.height = 768;
    System.getInstance().refreshHostView();
    expect(published).toEqual([]);
    windows.get(HWND)!.x = 204; windows.get(HWND)!.y = 123;
    System.getInstance().refreshHostView();
    expect(published).toEqual([{ x: 204, y: 123, width: 436, height: 357 }]);
    windows.get(HWND)!.x = 700;
    System.getInstance().refreshHostView();
    expect(published.at(-1)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
});

test('the view follows the root when it moves or resizes, and publishes once per change', () => {
    makeWindow(HWND, 0, 0, 0, 560, 400);
    call('ShowWindow', [HWND, SW_SHOW]);
    published.length = 0;
    call('SetWindowPos', [HWND, 0, 40, 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE]);
    const win = windows.get(HWND)!;
    expect(published).toEqual([{ x: win.x, y: win.y, width: win.width, height: win.height }]);
    for (let i = 0; i < 5; i++) call('SetWindowPos', [HWND, 0, 40, 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE]);
    expect(published).toHaveLength(1);
});

test('an owned dialog keeps its owner framed while it fits; one that does not fit gives the screen', () => {
    makeWindow(HWND, FRAMED, 40, 40, 560, 400);
    makeWindow(OTHER, POPUP, 100, 100, 200, 120, { parent: HWND });
    foreground = OTHER;
    System.getInstance().refreshHostView();
    expect(view()).toEqual({ x: 40, y: 40, width: 560, height: 400 });
    windows.get(OTHER)!.x = 10;
    System.getInstance().refreshHostView();
    expect(view()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
});

test('a visible window outside the view that is not an owner (a launcher, an ownerless box) gives the screen', () => {
    makeWindow(HWND, FRAMED, 40, 40, 560, 400);
    makeWindow(THIRD, POPUP, 0, 0, 300, 200);
    System.getInstance().refreshHostView();
    expect(view()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    windows.get(THIRD)!.visible = false;
    System.getInstance().refreshHostView();
    expect(view()).toEqual({ x: 40, y: 40, width: 560, height: 400 });
});

test('the root\'s own owner (an application window behind the form) does not count as outside', () => {
    makeWindow(THIRD, FRAMED, 0, 0, 800, 600);
    makeWindow(HWND, FRAMED, 40, 40, 560, 400, { parent: THIRD });
    System.getInstance().refreshHostView();
    expect(view()).toEqual({ x: 40, y: 40, width: 560, height: 400 });
});

test('exclusive DirectDraw and the whole-desktop setting show the screen', () => {
    makeWindow(HWND, FRAMED, 40, 40, 560, 400);
    const system = System.getInstance() as unknown as { ddrawContext: unknown };
    const savedDdraw = system.ddrawContext;
    try {
        system.ddrawContext = { cooperative: { exclusive: true } };
        System.getInstance().refreshHostView();
        expect(view()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
        system.ddrawContext = { cooperative: { exclusive: false } };
        System.getInstance().refreshHostView();
        expect(view()).toEqual({ x: 40, y: 40, width: 560, height: 400 });
    } finally { system.ddrawContext = savedDdraw; }
    EmulatorConfig.getInstance().showWholeDesktop = true;
    System.getInstance().refreshHostView();
    expect(view()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
});

test('a mode set re-derives the view against the new screen', () => {
    makeWindow(HWND, FRAMED, 0, 0, 800, 600);
    System.getInstance().refreshHostView();
    expect(view()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    System.getInstance().requestHostResize(1024, 768, { modeSet: true });
    expect(view()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    System.getInstance().requestHostResize(640, 480, { modeSet: true });
});

test('destroying the root gives the screen back', () => {
    makeWindow(HWND, 0, 40, 40, 560, 400);
    call('ShowWindow', [HWND, SW_SHOW]);
    call('DestroyWindow', [HWND]);
    expect(windows.has(HWND)).toBe(false);
    expect(view()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
});

test('the window manager reports every foreground window change, also within one thread', () => {
    const wm = new WindowManager();
    let calls = 0;
    wm.registerForegroundWindowObserver(() => { calls++; });
    const a = wm.createWindow('Test', 'a', (WS_POPUP | WS_VISIBLE) >>> 0, 0, 0, 0, 64, 64, 0, 0, 0, 0);
    const b = wm.createWindow('Test', 'b', (WS_POPUP | WS_VISIBLE) >>> 0, 0, 0, 0, 64, 64, 0, 0, 0, 0);
    const before = calls;
    wm.setActiveWindow(b);
    wm.setActiveWindow(b);
    wm.setActiveWindow(a);
    expect(calls - before).toBe(2);
});

test('installing the policy registers it with the window manager', () => {
    const registered: Array<() => void> = [];
    installHostViewPolicy({ registerForegroundWindowObserver: (fn: () => void) => registered.push(fn) } as never);
    makeWindow(HWND, FRAMED, 40, 40, 560, 400);
    registered[0]();
    expect(view()).toEqual({ x: 40, y: 40, width: 560, height: 400 });
});
