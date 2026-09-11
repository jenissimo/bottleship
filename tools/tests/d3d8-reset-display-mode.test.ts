import { expect, test } from 'bun:test';
import { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';
import { System } from '../../src/worker/core/system';

test('D3D8 Reset updates the desktop only for a fullscreen backbuffer', () => {
    const system = System.getInstance();
    const previousMode = system.emulatedDisplayMode;
    const display = system.ddrawContext?.display;
    const previousDisplay = display ? { ...display } : null;
    // Exercise Reset and the real display-mode publication without allocating a GPU device.
    const adapter = Object.assign(Object.create(D3D8DeviceAdapter.prototype), {
        renderer: { setGuestRequestedMsaa() {} },
        renderStates: new Int32Array(256),
        textureStates: new Int32Array(256),
        textures: new Array(8).fill(null),
        textureHandles: new Uint32Array(8),
        transforms: new Map(),
    }) as D3D8DeviceAdapter;
    const mem = new Uint8Array(128);
    const view = new DataView(mem.buffer);
    const pp = 16;
    const reset = (width: number, height: number, windowed: boolean) => {
        view.setUint32(pp, width, true);
        view.setUint32(pp + 4, height, true);
        view.setUint32(pp + 28, windowed ? 1 : 0, true);
        expect(adapter.reset(pp, mem)).toBe(0);
        expect(adapter.presentsExclusiveFullscreen).toBe(!windowed);
    };
    try {
        system.emulatedDisplayMode = { width: 1920, height: 1080, bpp: 32, refreshRate: 60 };
        reset(800, 600, true);
        expect(system.emulatedDisplayMode).toMatchObject({ width: 1920, height: 1080 });
        reset(1024, 768, false);
        expect(system.emulatedDisplayMode).toMatchObject({ width: 1024, height: 768 });
        reset(640, 480, true);
        expect(system.emulatedDisplayMode).toMatchObject({ width: 1024, height: 768 });
    } finally {
        system.emulatedDisplayMode = previousMode;
        if (display && previousDisplay) Object.assign(display, previousDisplay);
    }
});
