/**
 * A windowed device may declare a zero back-buffer dimension: it means the client area of
 * the device window, and the resolved size is written back into the caller's struct. A
 * window that exists but has no size yet gives a small extent; a window nobody tracks is
 * left alone. D3D8 and D3D9 share the rule.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { LogCategory } from '../../src/worker/core/logger';
import { windows as sharedWindows } from '../../src/worker/modules/user32/shared-state';
import {
    EMPTY_CLIENT_BACK_BUFFER_EXTENT, deviceWindowClientExtent, deviceWindowClientSize,
    resolveWindowedBackBufferExtent,
} from '../../src/worker/runtime/windowing/fullscreen-window';
import { createStateExports } from '../../src/worker/modules/d3d8/state';
import { deviceCreationParams, devices } from '../../src/worker/modules/d3d8/shared-state';
import type { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';

const HWND = 0x10002;
const PP = 0x100;
const memory = new Uint8Array(0x1000);
const view = new DataView(memory.buffer);
let systemSpy: ReturnType<typeof spyOn> | null = null;

function withWindows(shared: { width: number; height: number } | null, managed: { w: number; h: number } | null) {
    sharedWindows.delete(HWND);
    if (shared) sharedWindows.set(HWND, { handle: HWND, x: 0, y: 0, ...shared } as never);
    systemSpy?.mockRestore();
    systemSpy = spyOn(System, 'getInstance').mockReturnValue({
        windowManager: { getWindow: (h: number) => (h === HWND && managed ? { rect: { x: 0, y: 0, ...managed } } : undefined) },
    } as unknown as System);
    Mem.bind(() => memory);
}

function params(width: number, height: number) {
    memory.fill(0, PP, PP + 64);
    view.setUint32(PP, width, true);
    view.setUint32(PP + 4, height, true);
}
const declared = () => [view.getUint32(PP, true), view.getUint32(PP + 4, true)];
const resolve = (fullscreen = false) =>
    resolveWindowedBackBufferExtent(memory, PP, HWND, fullscreen, 'test', LogCategory.SYSTEM);

afterEach(() => { systemSpy?.mockRestore(); systemSpy = null; sharedWindows.delete(HWND); });

describe('a zero windowed back-buffer dimension', () => {
    test('takes the client size of the device window and is written back', () => {
        withWindows({ width: 640, height: 480 }, null);
        params(0, 0);
        expect(resolve()).toEqual({ width: 640, height: 480 });
        expect(declared()).toEqual([640, 480]);
    });

    test('only the zero dimension is replaced', () => {
        withWindows(null, { w: 640, h: 480 });
        params(320, 0);
        expect(resolve()).toEqual({ width: 320, height: 480 });
        expect(declared()).toEqual([320, 480]);
    });

    test('a known window without a size yet gives the small minimum, per dimension', () => {
        withWindows({ width: 0, height: 0 }, { w: 0, h: 0 });
        params(0, 0);
        expect(resolve()).toEqual({ width: EMPTY_CLIENT_BACK_BUFFER_EXTENT, height: EMPTY_CLIENT_BACK_BUFFER_EXTENT });
        expect(declared()).toEqual([EMPTY_CLIENT_BACK_BUFFER_EXTENT, EMPTY_CLIENT_BACK_BUFFER_EXTENT]);
        withWindows({ width: 300, height: 0 }, null);
        params(0, 0);
        expect(resolve()).toEqual({ width: 300, height: EMPTY_CLIENT_BACK_BUFFER_EXTENT });
        expect(deviceWindowClientSize(HWND)).toEqual({ width: 300, height: 0 });
        expect(deviceWindowClientExtent(HWND)).toBeNull();
    });

    test('a window nobody tracks leaves the struct as it is', () => {
        withWindows(null, null);
        params(0, 0);
        expect(resolve()).toEqual({ width: 0, height: 0 });
        expect(declared()).toEqual([0, 0]);
        expect(deviceWindowClientSize(HWND)).toBeNull();
    });

    test('declared sizes and fullscreen devices are not touched', () => {
        withWindows({ width: 640, height: 480 }, null);
        params(800, 600);
        expect(resolve()).toEqual({ width: 800, height: 600 });
        expect(declared()).toEqual([800, 600]);
        params(0, 0);
        expect(resolve(true)).toEqual({ width: 0, height: 0 });
        expect(declared()).toEqual([0, 0]);
    });
});

describe('IDirect3DDevice8_Reset with a zero back buffer', () => {
    const DEVICE = 0x7100;
    afterEach(() => { devices.delete(DEVICE); deviceCreationParams.delete(DEVICE); });

    const reset = (windowed: boolean, hDeviceWindow: number) => {
        const seen: number[][] = [];
        devices.set(DEVICE, {
            reset: (pp: number) => { seen.push([view.getUint32(pp, true), view.getUint32(pp + 4, true)]); return 0x8876086c; },
        } as unknown as D3D8DeviceAdapter);
        deviceCreationParams.set(DEVICE, { adapter: 0, deviceType: 1, hFocusWindow: HWND, behaviorFlags: 0 });
        params(0, 0);
        view.setUint32(PP + 24, hDeviceWindow, true);
        view.setUint32(PP + 28, windowed ? 1 : 0, true);
        createStateExports().IDirect3DDevice8_Reset({} as never, memory, [DEVICE, PP]);
        return seen;
    };

    test('the backend reads the client size of the device window', () => {
        withWindows({ width: 560, height: 400 }, null);
        expect(reset(true, HWND)).toEqual([[560, 400]]);
    });

    test('without a device window in the struct the focus window of the device is used', () => {
        withWindows({ width: 560, height: 400 }, null);
        expect(reset(true, 0)).toEqual([[560, 400]]);
    });

    test('a fullscreen Reset is passed through unchanged', () => {
        withWindows({ width: 560, height: 400 }, null);
        expect(reset(false, HWND)).toEqual([[0, 0]]);
    });
});
