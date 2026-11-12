import { afterEach, expect, test } from 'bun:test';
import { registerFastPathD3D8Functions } from '../../src/worker/modules/d3d8/fast-path';
import { createStateExports } from '../../src/worker/modules/d3d8/state';
import { devices } from '../../src/worker/modules/d3d8/shared-state';
import type { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';

type FastPath = (esp: number, view: DataView, mem: Uint8Array) => number | null;

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const DEVICE = 0x1000;
const ESP = 0x100;
const VIEWPORT = 0x200;

function fastSetViewport(): FastPath {
    let found: FastPath | null = null;
    const dispatcher = new Proxy({}, {
        get: (_t, prop) => (_dll: string, name: string, impl: FastPath) => {
            if (prop === 'registerFastPath' && name === 'IDirect3DDevice8_SetViewport') found = impl;
        },
    });
    registerFastPathD3D8Functions(dispatcher as never);
    if (!found) throw new Error('no SetViewport fast path');
    return found;
}

function setup(targetWidth: number, targetHeight: number) {
    const device = {
        activeRenderTarget: { width: targetWidth, height: targetHeight },
        viewport: { x: 0, y: 0, width: targetWidth, height: targetHeight, minZ: 0, maxZ: 1 },
        recordingStateBlock: false,
    };
    devices.set(DEVICE, device as unknown as D3D8DeviceAdapter);
    const mem = new Uint8Array(0x400);
    const view = new DataView(mem.buffer);
    view.setUint32(ESP + 4, DEVICE, true);
    view.setUint32(ESP + 8, VIEWPORT, true);
    const write = (x: number, y: number, width: number, height: number) => {
        view.setUint32(VIEWPORT, x, true);
        view.setUint32(VIEWPORT + 4, y, true);
        view.setUint32(VIEWPORT + 8, width, true);
        view.setUint32(VIEWPORT + 12, height, true);
        view.setFloat32(VIEWPORT + 16, 0, true);
        view.setFloat32(VIEWPORT + 20, 1, true);
    };
    return { device, mem, view, write };
}

afterEach(() => { devices.delete(DEVICE); });

test('D3D8 SetViewport fast path applies a viewport that fits the render target', () => {
    const fast = fastSetViewport();
    const { device, mem, view, write } = setup(512, 256);
    write(0, 0, 320, 240);
    expect(fast(ESP, view, mem)).toBe(D3D_OK);
    expect(device.viewport).toMatchObject({ x: 0, y: 0, width: 320, height: 240 });
    write(192, 16, 320, 240);
    expect(fast(ESP, view, mem)).toBe(D3D_OK);
    expect(device.viewport).toMatchObject({ x: 192, y: 16, width: 320, height: 240 });
});

test('D3D8 SetViewport fast path leaves a viewport larger than the render target to the thunk, which rejects it', () => {
    const fast = fastSetViewport();
    const slow = createStateExports()['IDirect3DDevice8_SetViewport'];
    const { device, mem, view, write } = setup(512, 256);
    write(0, 0, 320, 240);
    expect(fast(ESP, view, mem)).toBe(D3D_OK);
    for (const [x, y, w, h] of [[0, 0, 640, 480], [0, 0, 512, 257], [200, 0, 320, 240], [0, 20, 320, 240], [600, 0, 1, 1]]) {
        write(x, y, w, h);
        expect(fast(ESP, view, mem)).toBeNull();
        expect(device.viewport).toMatchObject({ x: 0, y: 0, width: 320, height: 240 });
        expect(slow({} as never, mem, [DEVICE, VIEWPORT]) as number >>> 0).toBe(D3DERR_INVALIDCALL);
        expect(device.viewport).toMatchObject({ x: 0, y: 0, width: 320, height: 240 });
    }
});
