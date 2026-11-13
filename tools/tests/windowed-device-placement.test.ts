/**
 * A windowed D3D8/D3D9 frame is an image of its device window's client area. It is shown
 * where that client area lies inside the host view V, and a windowed device no longer
 * publishes a view of its own.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System, type HostView } from '../../src/worker/core/system';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import {
    clearPresentedClientRect, presentedClientPlacement, setGuestView, setPresentedClientRect,
} from '../../src/worker/backends/webgpu/shared/present-geometry';
import { publishPresentedClient } from '../../src/worker/runtime/windowing/fullscreen-window';
import { writePlacedQuad } from '../../src/worker/backends/webgpu/postfx/post-fx-chain';
import { publishCreateDeviceHostView } from '../../src/worker/modules/d3d8/device-lifecycle';
import { createDeviceExports } from '../../src/worker/modules/d3d8/device';
import { devices } from '../../src/worker/modules/d3d8/shared-state';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';
import { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';

const WS_CHILD = 0x40000000;
const TOP = 0x51510;
const CHILD = 0x51520;
const DEVICE = 0x7a0000;

let published: HostView[];

function makeWindow(handle: number, style: number, x: number, y: number, w: number, h: number, parent = 0): WindowInfo {
    const win = {
        handle, title: 'device', style, x, y, width: w, height: h, parent,
        children: [], wndProc: 0, userData: 0, visible: true,
    } as unknown as WindowInfo;
    windows.set(handle, win);
    return win;
}

beforeEach(() => {
    published = [];
    System.getInstance().setHostResizeCallback((view) => { published.push({ ...view }); });
    setGuestView(0, 0, 640, 480);
    clearPresentedClientRect();
});

afterEach(() => {
    System.getInstance().setHostResizeCallback(() => {});
    System.getInstance().requestHostResize(0, 0);
    setGuestView(0, 0, 0, 0);
    clearPresentedClientRect();
    windows.delete(TOP);
    windows.delete(CHILD);
    devices.delete(DEVICE);
});

test('a frame whose client area is the view, or with no client area published, fills the picture', () => {
    expect(presentedClientPlacement().whole).toBe(true);
    setGuestView(40, 40, 560, 400);
    setPresentedClientRect(40, 40, 560, 400);
    expect(presentedClientPlacement().whole).toBe(true);
    setGuestView(0, 0, 0, 0);
    setPresentedClientRect(40, 40, 560, 400);
    expect(presentedClientPlacement().whole).toBe(true);
});

test('a client area inside the view is placed at client - V.origin, scaled by V', () => {
    setPresentedClientRect(40, 40, 560, 400);
    const p = presentedClientPlacement();
    expect(p.whole).toBe(false);
    expect(p.empty).toBe(false);
    expect([p.viewW, p.viewH]).toEqual([640, 480]);
    expect(p.uv).toEqual([0, 0, 1, 1]);
    expect(p.place).toEqual([40 / 640, 40 / 480, 600 / 640, 440 / 480]);
});

test('a client area that reaches outside the view shows only its part inside it', () => {
    setGuestView(100, 50, 400, 300);
    setPresentedClientRect(0, 0, 400, 200);
    const p = presentedClientPlacement();
    expect(p.empty).toBe(false);
    expect(p.uv).toEqual([100 / 400, 50 / 200, 1, 1]);
    expect(p.place).toEqual([0, 0, 300 / 400, 150 / 300]);
});

test('an empty client area, or one outside the view, shows nothing', () => {
    setPresentedClientRect(40, 40, 0, 0);
    expect(presentedClientPlacement().empty).toBe(true);
    setPresentedClientRect(40, 40, 560, 0);
    expect(presentedClientPlacement().empty).toBe(true);
    setPresentedClientRect(700, 10, 100, 100);
    expect(presentedClientPlacement().empty).toBe(true);
});

test('the placed quad draws the uv part into the place part (NDC, uv.y = 0 at the top)', () => {
    const q = new Float32Array(24);
    writePlacedQuad(q, [0, 0, 1, 1], [0, 0, 1, 1]);
    expect(Array.from(q)).toEqual([-1, -1, 0, 1, 1, -1, 1, 1, 1, 1, 1, 0, -1, -1, 0, 1, 1, 1, 1, 0, -1, 1, 0, 0]);
    writePlacedQuad(q, [0.25, 0, 1, 0.5], [0.5, 0.25, 1, 0.75]);
    // left/right x = 0, 1; top/bottom y = 0.5, -0.5
    expect(Array.from(q.slice(0, 12))).toEqual([0, -0.5, 0.25, 0.5, 1, -0.5, 1, 0.5, 1, 0.5, 1, 0]);
});

test('a present publishes its window\'s client rectangle in screen coordinates; no window is a fullscreen frame', () => {
    makeWindow(TOP, 0, 69, 76, 502, 349);
    makeWindow(CHILD, WS_CHILD, 3, 5, 496, 340, TOP);
    publishPresentedClient(CHILD);
    const p = presentedClientPlacement();
    expect(p.place).toEqual([72 / 640, 81 / 480, 568 / 640, 421 / 480]);
    publishPresentedClient(0);
    expect(presentedClientPlacement().whole).toBe(true);
    publishPresentedClient(TOP);
    publishPresentedClient(0x7777);
    expect(presentedClientPlacement().whole).toBe(true);
});

test('D3D8 Present places the frame at the device window, the override window, or not at all when fullscreen', () => {
    makeWindow(TOP, 0, 40, 40, 560, 400);
    makeWindow(CHILD, 0, 100, 60, 320, 240);
    const device = { presentsExclusiveFullscreen: false, presentWindow: TOP, present: () => 0 };
    devices.set(DEVICE, device as never);
    const present = createDeviceExports()['IDirect3DDevice8_Present'];
    present({} as never, new Uint8Array(16), [DEVICE, 0, 0, 0, 0] as never);
    expect(presentedClientPlacement().place).toEqual([40 / 640, 40 / 480, 600 / 640, 440 / 480]);
    present({} as never, new Uint8Array(16), [DEVICE, 0, 0, CHILD, 0] as never);
    expect(presentedClientPlacement().place).toEqual([100 / 640, 60 / 480, 420 / 640, 300 / 480]);
    device.presentsExclusiveFullscreen = true;
    present({} as never, new Uint8Array(16), [DEVICE, 0, 0, 0, 0] as never);
    expect(presentedClientPlacement().whole).toBe(true);
});

test('a windowed device publishes no view on CreateDevice or Reset; a fullscreen one sets the mode', () => {
    makeWindow(TOP, 0, 40, 30, 640, 480);
    const pp = new DataView(new ArrayBuffer(56));
    pp.setUint32(24, TOP, true);
    pp.setUint32(28, 1, true);
    publishCreateDeviceHostView(pp, 0, 640, 480);
    expect(published).toEqual([]);
    pp.setUint32(28, 0, true);
    publishCreateDeviceHostView(pp, 0, 800, 600);
    expect(published).toEqual([{ x: 0, y: 0, width: 800, height: 600 }]);

    published.length = 0;
    const d = Object.create(D3D9Device.prototype) as Record<string, unknown>;
    d.role = 'both';
    d.backendExecutor = { setGuestBackbufferSize: () => {} };
    d.setPresentationInterval = () => {};
    d.setSwapEffect = () => {};
    d.endScene = () => 0;
    const device = d as unknown as D3D9Device;
    device.setBackBufferSize(640, 480, false, TOP);
    device.resetFromParams({
        width: 320, height: 240, windowed: 1, enableAutoDepthStencil: 0, autoDepthStencilFormat: 0,
        presentationInterval: 0, swapEffect: 1,
    } as never);
    expect(published).toEqual([]);
    device.resetFromParams({
        width: 1024, height: 768, windowed: 0, enableAutoDepthStencil: 0, autoDepthStencilFormat: 0,
        presentationInterval: 0, swapEffect: 1,
    } as never);
    expect(published).toEqual([{ x: 0, y: 0, width: 1024, height: 768 }]);
});

function fakeD3D9ForPresent(windowed: boolean, hwnd: number): D3D9Device {
    const d = Object.create(D3D9Device.prototype) as object;
    const fields: Record<string, unknown> = {
        gpuGone: false, role: 'both', splitPresentGate: null, presentInterval: 0,
        renderTargetIndices: [null], submitFrame: () => {}, fetchAuditOnPresent: () => {}, updateFps: () => {},
        backendExecutor: { hasFrameSink: () => true }, splitFramesRemote: false, renderTwin: null,
        frameSnapshot: { presents: 0, frameCounters: null }, frameIdCounter: 0, lastDrawSnapshot: { timestamp: 0 },
        prevPresentTime: 0, presentBoundarySerial: 0, deviceIsWindowed: windowed, deviceWindowHwnd: hwnd,
    };
    for (const [k, value] of Object.entries(fields)) {
        Object.defineProperty(d, k, { value, writable: true, configurable: true });
    }
    return d as D3D9Device;
}

test('D3D9 Present places a windowed frame at its device window; a fullscreen frame fills the picture', async () => {
    makeWindow(TOP, 0, 40, 40, 560, 400);
    expect(await fakeD3D9ForPresent(true, TOP).present()).toBe(0);
    expect(presentedClientPlacement().place).toEqual([40 / 640, 40 / 480, 600 / 640, 440 / 480]);
    expect(await fakeD3D9ForPresent(false, TOP).present()).toBe(0);
    expect(presentedClientPlacement().whole).toBe(true);
});

test('a windowed D3D8 Reset publishes no view; a fullscreen one sets the mode', () => {
    const adapter = Object.create(D3D8DeviceAdapter.prototype) as object;
    const stubs: Record<string, unknown> = {
        applyPresentMultiSampleType: () => true, setPresentationInterval: () => {}, flushProgrammablePending: () => {},
        dropPresentComposite: () => {}, clearTextureBindings: () => {}, initDefaultStates: () => {}, transforms: new Map(),
    };
    for (const [k, value] of Object.entries(stubs)) {
        Object.defineProperty(adapter, k, { value, writable: true, configurable: true });
    }
    const mem = new Uint8Array(128);
    const view = new DataView(mem.buffer);
    view.setUint32(16, 640, true);
    view.setUint32(20, 480, true);
    view.setUint32(16 + 28, 1, true);
    expect((adapter as D3D8DeviceAdapter).reset(16, mem)).toBe(0);
    expect(published).toEqual([]);
    view.setUint32(16 + 28, 0, true);
    expect((adapter as D3D8DeviceAdapter).reset(16, mem)).toBe(0);
    expect(published).toEqual([{ x: 0, y: 0, width: 640, height: 480 }]);
});
