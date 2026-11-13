/**
 * The host surface shows one rectangle of the virtual screen, and one place publishes it.
 * A plain size (a mode set, a device, a dialog) is that size at the screen origin; a shown
 * top-level window publishes its client rectangle WITH its screen origin, and the
 * rectangle follows the window while no other publisher has spoken since.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System, type HostView } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { getVirtualScreenRect, windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { requestWindowedDeviceHostView } from '../../src/worker/runtime/windowing/fullscreen-window';
import { publishCreateDeviceHostView } from '../../src/worker/modules/d3d8/device-lifecycle';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';

const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SW_SHOW = 5;

const HWND = 0x44470;
const OTHER = 0x44480;
const ESP = 0x2000;

let mem: Uint8Array;
let published: HostView[];
let saved: Record<string, unknown> = {};
let savedProcess: unknown;
let savedMemGetter: unknown;
let exports: ReturnType<typeof createWindowExports>;

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
    mem = new Uint8Array(0x10000);
    published = [];
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
        memory: { alloc: () => 0x800, free: () => {} },
        getModule: () => undefined,
    } as never;
    system.setHostResizeCallback((view) => { published.push({ ...view }); });
    exports = createWindowExports();
});

afterEach(() => {
    const system = System.getInstance();
    system.setHostResizeCallback(() => {});
    system.requestHostResize(0, 0);
    Object.assign(system.windowManager as unknown as Record<string, unknown>, saved);
    system.process = savedProcess as never;
    Mem.bind(savedMemGetter as () => Uint8Array);
    windows.delete(HWND);
    windows.delete(OTHER);
});

test('a published size is that size at the screen origin', () => {
    System.getInstance().requestHostResize(800, 600);
    expect(published).toEqual([{ x: 0, y: 0, width: 800, height: 600 }]);
    expect(System.getInstance().hostView).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(System.getInstance().hostViewOwner).toBe(0);
});

test('showing a top-level window publishes its client rectangle with its screen origin', () => {
    makeWindow(HWND, 0, 40, 40, 560, 400);
    call('ShowWindow', [HWND, SW_SHOW]);
    expect(published).toEqual([{ x: 40, y: 40, width: 560, height: 400 }]);
    expect(System.getInstance().hostViewOwner).toBe(HWND);
});

test('a window at the screen origin publishes what a plain size would', () => {
    makeWindow(HWND, 0, 0, 0, 640, 480);
    call('ShowWindow', [HWND, SW_SHOW]);
    expect(published).toEqual([{ x: 0, y: 0, width: 640, height: 480 }]);
});

test('the view follows the shown window when it moves or resizes, once per change', () => {
    makeWindow(HWND, 0, 0, 0, 560, 400);
    call('ShowWindow', [HWND, SW_SHOW]);
    published.length = 0;
    const win = windows.get(HWND)!;
    win.style |= WS_POPUP;   // frameless from here on, so the rectangles below are client ones
    call('SetWindowPos', [HWND, 0, 40, 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE]);
    expect(published).toEqual([{ x: 40, y: 40, width: 560, height: 400 }]);
    // The same rectangle again, as a title that repositions itself every frame does.
    for (let i = 0; i < 5; i++) {
        call('SetWindowPos', [HWND, 0, 40, 40, 560, 400, SWP_NOZORDER | SWP_NOACTIVATE]);
    }
    expect(published).toHaveLength(1);
    call('SetWindowPos', [HWND, 0, 0, 0, 640, 480, SWP_NOZORDER | SWP_NOACTIVATE]);
    expect(published.at(-1)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(published).toHaveLength(2);
});

test('a window that is not the shown one does not move the view', () => {
    makeWindow(HWND, 0, 0, 0, 640, 480);
    makeWindow(OTHER, (WS_POPUP | WS_VISIBLE) >>> 0, 10, 10, 100, 100);
    call('ShowWindow', [HWND, SW_SHOW]);
    published.length = 0;
    call('SetWindowPos', [OTHER, 0, 200, 150, 120, 90, SWP_NOZORDER | SWP_NOACTIVATE]);
    expect(published).toEqual([]);
});

test('after another publisher has spoken the window no longer drives the view', () => {
    makeWindow(HWND, 0, 0, 0, 560, 400);
    call('ShowWindow', [HWND, SW_SHOW]);
    windows.get(HWND)!.style |= WS_POPUP;
    System.getInstance().requestHostResize(640, 480);
    published.length = 0;
    call('SetWindowPos', [HWND, 0, 40, 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE]);
    expect(published).toEqual([]);
    expect(System.getInstance().hostView).toEqual({ x: 0, y: 0, width: 640, height: 480 });
});

test('a destroyed window stops driving the view, and a reused handle does not inherit it', () => {
    makeWindow(HWND, 0, 0, 0, 560, 400);
    call('ShowWindow', [HWND, SW_SHOW]);
    call('DestroyWindow', [HWND]);
    expect(windows.has(HWND)).toBe(false);
    makeWindow(HWND, (WS_POPUP | WS_VISIBLE) >>> 0, 0, 0, 100, 100);
    published.length = 0;
    call('SetWindowPos', [HWND, 0, 40, 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE]);
    expect(published).toEqual([]);
    expect(System.getInstance().hostView).toEqual({ x: 0, y: 0, width: 560, height: 400 });
});

test('while DirectDraw holds the display exclusively a shown window does not replace the mode\'s view', () => {
    const system = System.getInstance() as unknown as { ddrawContext: unknown };
    const savedDdraw = system.ddrawContext;
    system.ddrawContext = { cooperative: { exclusive: true } };
    try {
        System.getInstance().requestHostResize(640, 480, { modeSet: false });
        published.length = 0;
        makeWindow(HWND, 0, 4, 23, 632, 453);
        call('ShowWindow', [HWND, SW_SHOW]);
        expect(published).toEqual([]);
        expect(System.getInstance().hostView).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    } finally { system.ddrawContext = savedDdraw; }
});

test('a window larger than the screen publishes the part of it that is on the screen', () => {
    const screen = getVirtualScreenRect();
    const sw = screen.right - screen.left, sh = screen.bottom - screen.top;
    makeWindow(HWND, 0, 0, 0, sw + 384, sh + 288);
    call('ShowWindow', [HWND, SW_SHOW]);
    expect(published).toEqual([{ x: 0, y: 0, width: sw, height: sh }]);
    windows.get(HWND)!.style |= WS_POPUP;
    call('SetWindowPos', [HWND, 0, -100, 50, sw + 384, sh + 288, SWP_NOZORDER | SWP_NOACTIVATE]);
    expect(published.at(-1)).toEqual({ x: 0, y: 50, width: sw, height: sh - 50 });
});

test('a window wholly off the screen shows the screen', () => {
    const screen = getVirtualScreenRect();
    const sw = screen.right - screen.left, sh = screen.bottom - screen.top;
    makeWindow(HWND, 0, sw + 10, 0, 200, 100);
    call('ShowWindow', [HWND, SW_SHOW]);
    expect(published).toEqual([{ x: 0, y: 0, width: sw, height: sh }]);
});

test('popups and children do not publish a view when shown', () => {
    makeWindow(HWND, WS_POPUP >>> 0, 30, 30, 200, 100);
    call('ShowWindow', [HWND, SW_SHOW]);
    makeWindow(OTHER, WS_CHILD, 5, 5, 50, 20);
    call('ShowWindow', [OTHER, SW_SHOW]);
    expect(published).toEqual([]);
});

test('a windowed device publishes its back buffer at the device window\'s screen origin', () => {
    makeWindow(OTHER, 0, 69, 76, 502, 349);
    makeWindow(HWND, WS_CHILD, 3, 5, 496, 340, { parent: OTHER });
    requestWindowedDeviceHostView(HWND, 640, 480);
    expect(published).toEqual([{ x: 72, y: 81, width: 640, height: 480 }]);
    // The back buffer is not a window's client rectangle, so no window drives it afterwards.
    expect(System.getInstance().hostViewOwner).toBe(0);
});

test('a windowed device whose window is unknown publishes at the screen origin', () => {
    requestWindowedDeviceHostView(0x7777, 800, 600);
    requestWindowedDeviceHostView(0, 320, 240);
    expect(published).toEqual([
        { x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 320, height: 240 },
    ]);
});

function d3d8PresentParams(windowed: number, hDeviceWindow: number): DataView {
    const view = new DataView(new ArrayBuffer(56));
    view.setUint32(0, 640, true);
    view.setUint32(4, 480, true);
    view.setUint32(20, OTHER, true);        // SwapEffect's slot holds a live handle: +20 must not be read as the window
    view.setUint32(24, hDeviceWindow, true);
    view.setUint32(28, windowed, true);
    return view;
}

test('D3D8 CreateDevice: a windowed device publishes its back buffer at its device window\'s origin', () => {
    makeWindow(HWND, 0, 40, 30, 640, 480);
    makeWindow(OTHER, 0, 0, 0, 800, 600);
    publishCreateDeviceHostView(d3d8PresentParams(1, HWND), 0, OTHER, 640, 480);
    expect(published).toEqual([{ x: 40, y: 30, width: 640, height: 480 }]);
});

test('D3D8 CreateDevice: without a device window the focus window places it; fullscreen is a mode set', () => {
    makeWindow(HWND, 0, 40, 30, 640, 480);
    publishCreateDeviceHostView(d3d8PresentParams(1, 0), 0, HWND, 640, 480);
    publishCreateDeviceHostView(d3d8PresentParams(0, HWND), 0, HWND, 800, 600);
    expect(published).toEqual([
        { x: 40, y: 30, width: 640, height: 480 }, { x: 0, y: 0, width: 800, height: 600 },
    ]);
});

function d3d9Device(): D3D9Device {
    const d = Object.create(D3D9Device.prototype) as Record<string, unknown>;
    d.role = 'both';
    d.backendExecutor = { setGuestBackbufferSize: () => {} };
    d.setPresentationInterval = () => {};
    d.setSwapEffect = () => {};
    d.endScene = () => 0;
    return d as unknown as D3D9Device;
}

test('D3D9 CreateDevice and Reset: a windowed device publishes at its device window\'s origin', () => {
    const win = makeWindow(HWND, 0, 40, 30, 640, 480);
    const device = d3d9Device();
    device.setBackBufferSize(640, 480, false, HWND);
    win.x = 100; win.y = 60;
    device.resetFromParams({
        width: 320, height: 240, windowed: 1, enableAutoDepthStencil: 0, autoDepthStencilFormat: 0,
        presentationInterval: 0, swapEffect: 1,
    } as never);
    expect(published).toEqual([
        { x: 40, y: 30, width: 640, height: 480 }, { x: 100, y: 60, width: 320, height: 240 },
    ]);
});
