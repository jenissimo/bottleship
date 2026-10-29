import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DDERR_SURFACELOST } from '../../src/worker/modules/ddraw/constants';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { createSurfaceExports } from '../../src/worker/modules/ddraw/surface';
import { convertSurfaceToRGBA } from '../../src/worker/modules/ddraw/gpu-texture-utils';
import { DD_OK, DDSCAPS_BACKBUFFER, DDSCAPS_SYSTEMMEMORY, DDSCAPS_TEXTURE, E_FAIL, E_POINTER, DDERR_DCALREADYCREATED } from '../../src/worker/modules/ddraw/constants';

const SURFACE = 0x1000, OUT = 0x2000, BITS = 0x4000, HDC = 0x99;
const rgba = new Uint8Array([200, 30, 10, 255, 10, 180, 40, 255, 70, 60, 210, 255, 55, 66, 77, 255]);
let system: any, saved: any, savedMem: any, savedGlobals: PropertyDescriptorMap;
beforeEach(() => {
    system = System.getInstance(); saved = { process: system.process, gdiContext: system.gdiContext };
    savedMem = { memoryGetter: (Mem as any).memoryGetter, validateRange: (Mem as any).validateRange, getRegion: (Mem as any).getRegion };
    savedGlobals = {};
    for (const key of ['GPUBufferUsage', 'GPUMapMode']) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        if (descriptor) savedGlobals[key] = descriptor;
    }
});
afterEach(() => {
    Object.assign(system, saved); Object.assign(Mem, savedMem);
    for (const key of ['GPUBufferUsage', 'GPUMapMode']) {
        if (savedGlobals[key]) Object.defineProperty(globalThis, key, savedGlobals[key]!);
        else delete (globalThis as any)[key];
    }
});

function harness(gpu = true) {
    let memory = new Uint8Array(0x10000), linked = 0, seeded = false, dirty = false;
    let canvasPixels: Uint8Array | undefined;
    const calls: string[] = [];
    const denied = new Set<string>();
    const state: any = {
        surfaceType: 'render_surface', caps: DDSCAPS_BACKBUFFER, width: 2, height: 2, pitch: 8,
        surfacePtr: BITS, format: { bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff, aMask: 0xff000000 },
        mode: 'GPU_ONLY', version: 7, gpuWrittenVersion: gpu ? 7 : undefined, gpuDirty: false,
        gpuTexture: gpu ? {} : undefined, everLocked: false, lastUploadVersion: 0,
        // A stale cache must never replace the current GPU frame.
        rgbaScratch: new Uint8Array(16).fill(3), rgbaScratchVersion: 6,
    };
    const object = { getState: () => state };
    let currentObject: any = object;
    const process = {
        getCurrentMemory: () => memory,
        addressSpace: {
            validateRange: (p: number, n: number, perms: string) => p >= 0 && p + n <= memory.length && !denied.has(`${p}:${perms}`),
            findRegionByKind: () => null, getLayoutBucket: () => null,
        },
    };
    const gdi: any = {
        getHDCBySurface: () => linked ? HDC : 0,
        createSurfaceDC: () => { calls.push('create'); canvasPixels = new Uint8Array(16); return HDC; },
        seedSurfaceDC: (_h: number, pixels: Uint8Array) => { calls.push('seed'); canvasPixels = pixels.slice(); seeded = true; return true; },
        linkDCToSurface: (_h: number, s: number) => { linked = s; },
        getLinkedSurface: () => linked,
        getDC: () => ({ canvas: {} }),
        isDirty: () => dirty,
        wasSurfaceSeeded: () => seeded,
        getImageData: () => ({ data: new Uint8ClampedArray(canvasPixels!), width: 2, height: 2 }),
        getCanvasForHDC: () => ({}), getDirtyRect: () => ({ x: 0, y: 0, width: 2, height: 2 }),
        clearDirty: () => { dirty = false; },
        unlinkDCFromSurface: () => { linked = 0; },
        releaseDC: () => { calls.push('release'); },
    };
    const landPixels = () => {
        for (let i = 0; i < 4; ++i) memory.set([rgba[i * 4 + 2]!, rgba[i * 4 + 1]!, rgba[i * 4]!, rgba[i * 4 + 3]!], BITS + i * 4);
        state.cpuSyncedVersion = state.version;
    };
    if (!gpu) landPixels();
    const context: any = {
        resourceProvider: { getComObjectByAddress: (p: number) => p === SURFACE ? currentObject : null, getComObjectsBySurfacePtr: () => [] },
        executor: {
            flush: () => { calls.push('flush'); },
            syncSurfaceToMemoryFromScratch: () => false,
            syncSurfaceToMemory: async () => { calls.push('readback'); landPixels(); },
            uploadCanvasToTexture: () => { calls.push('destructive-upload'); },
        }, surfaces: {}, cooperative: {}, presenter: { present: async () => {} },
    };
    system.process = process; system.gdiContext = gdi; Mem.bind(() => memory);
    const exports = createSurfaceExports(context);
    const get = () => exports.IDirectDrawSurface7_GetDC!({} as any, memory, [SURFACE, OUT]);
    const release = () => exports.IDirectDrawSurface7_ReleaseDC!({} as any, memory, [SURFACE, HDC]);
    return {
        state, context, process, gdi, calls, denied, get, release, landPixels,
        memory: () => memory, pixels: () => canvasPixels,
        grow: () => { const larger = new Uint8Array(memory.length * 2); larger.set(memory); memory = larger; },
        remove: () => { currentObject = null; },
        paintOnePixel: () => { canvasPixels!.set([255, 255, 255, 255], 4); dirty = true; },
    };
}

test('GPU-authored backbuffer survives transparent GDI drawing across a bounding dirty rectangle', async () => {
    const h = harness();
    expect(await h.get()).toBe(DD_OK);
    expect(h.calls).toEqual(['flush', 'readback', 'create', 'seed']);
    expect(h.pixels()).toEqual(rgba);
    // Transparent text changes only glyph pixels, but its bounding dirty box includes background.
    h.paintOnePixel();
    expect(await h.release()).toBe(DD_OK);
    const expected = rgba.slice(); expected.set([255, 255, 255, 255], 4);
    expect(convertSurfaceToRGBA(h.memory(), BITS, 2, 2, 8, h.state.format)).toEqual(expected);
    expect(h.calls).not.toContain('destructive-upload');
    expect(h.state.gpuDirty).toBe(true);
});

test('CPU-current backbuffer remains synchronous and seeds its own pixels', () => {
    const h = harness(false);
    expect(h.get()).toBe(DD_OK);
    expect(h.pixels()).toEqual(rgba);
    expect(h.calls).not.toContain('readback');
});

test('GPU-authored SYSMEM also rejects stale scratch and uses current readback', async () => {
    const h = harness(); h.state.caps = DDSCAPS_SYSTEMMEMORY;
    expect(await h.get()).toBe(DD_OK);
    expect(h.pixels()).toEqual(rgba);
    expect(h.calls).toContain('readback');
});

test('failed or stale GPU readback never hands out a blank successful DC', async () => {
    const h = harness(); h.context.executor.syncSurfaceToMemory = async () => {};
    expect(await h.get()).toBe(E_FAIL);
    expect(h.calls).not.toContain('create');
    expect(new DataView(h.memory().buffer).getUint32(OUT, true)).toBe(0);
});

test('rejected readback fails and permits a later retry', async () => {
    const h = harness(); h.context.executor.syncSurfaceToMemory = async () => { throw new Error('device lost'); };
    expect(await h.get()).toBe(E_FAIL);
    h.context.executor.syncSurfaceToMemory = async () => h.landPixels();
    expect(await h.get()).toBe(DD_OK);
});

test('readback completion uses current memory after growth', async () => {
    const h = harness(); const old = h.memory();
    h.context.executor.syncSurfaceToMemory = async () => { h.grow(); h.landPixels(); };
    expect(await h.get()).toBe(DD_OK);
    expect(new DataView(h.memory().buffer).getUint32(OUT, true)).toBe(HDC);
    expect(new DataView(old.buffer).getUint32(OUT, true)).toBe(0);
    expect(h.pixels()).toEqual(rgba);
});

test('process reset and surface destruction during readback cannot publish stale DC', async () => {
    for (const kind of ['reset', 'destroy']) {
        const h = harness();
        h.context.executor.syncSurfaceToMemory = async () => { h.landPixels(); if (kind === 'reset') system.process = {}; else h.remove(); };
        expect(await h.get()).toBe(E_FAIL);
        expect(h.calls).not.toContain('create');
    }
});

test('pending readback reserves this surface against a second GetDC', async () => {
    const h = harness(); let finish!: () => void;
    h.context.executor.syncSurfaceToMemory = () => new Promise<void>(resolve => { finish = () => { h.landPixels(); resolve(); }; });
    const pending = h.get();
    expect(await h.get()).toBe(DDERR_DCALREADYCREATED);
    finish(); expect(await pending).toBe(DD_OK);
});

test('seeding failure releases allocated DC and reports failure', async () => {
    const h = harness(false); h.gdi.seedSurfaceDC = () => false;
    expect(await h.get()).toBe(E_FAIL);
    expect(h.calls).toContain('release');
    expect(new DataView(h.memory().buffer).getUint32(OUT, true)).toBe(0);
});

test('GetDC validates writable output and readable surface pixels', async () => {
    const h = harness(false); h.denied.add(`${OUT}:rw`);
    expect(await h.get()).toBe(E_POINTER);
    expect(h.calls).not.toContain('create');
    h.denied.clear(); h.denied.add(`${BITS}:r`);
    expect(await h.get()).toBe(E_FAIL);
    expect(h.calls).not.toContain('create');
});

test('ReleaseDC reports refused surface writeback and still releases DC', async () => {
    const h = harness(false); expect(await h.get()).toBe(DD_OK); h.paintOnePixel();
    h.denied.add(`${BITS}:rw`);
    expect(await h.release()).toBe(E_FAIL);
    expect(h.calls).toContain('release');
    expect(convertSurfaceToRGBA(h.memory(), BITS, 2, 2, 8, h.state.format)).toEqual(rgba);
});

test('CPU RGB565 conversion respects padded pitch and preserves background through writeback', async () => {
    const h = harness(false);
    h.state.format = { bpp: 16, rMask: 0xf800, gMask: 0x7e0, bMask: 0x1f, aMask: 0 };
    h.state.pitch = 6;
    h.memory().set([0x00, 0xf8, 0xe0, 0x07, 0xaa, 0xbb, 0x1f, 0x00, 0xff, 0xff, 0xcc, 0xdd], BITS);
    expect(await h.get()).toBe(DD_OK);
    expect(h.pixels()).toEqual(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]));
    h.paintOnePixel(); expect(await h.release()).toBe(DD_OK);
    expect(h.memory().slice(BITS, BITS + 12)).toEqual(new Uint8Array([0x00, 0xf8, 0xff, 0xff, 0xaa, 0xbb, 0x1f, 0x00, 0xff, 0xff, 0xcc, 0xdd]));
});

test('current scratch synchronization avoids an unnecessary asynchronous readback', () => {
    const h = harness();
    h.context.executor.syncSurfaceToMemoryFromScratch = () => { h.landPixels(); return true; };
    expect(h.get()).toBe(DD_OK);
    expect(h.pixels()).toEqual(rgba);
    expect(h.calls).not.toContain('readback');
});

test('flush publishes queued GPU writes before GetDC chooses the authoritative pixels', async () => {
    const h = harness(false); h.state.gpuTexture = {};
    h.context.executor.flush = () => { h.state.version++; h.state.gpuWrittenVersion = h.state.version; };
    expect(await h.get()).toBe(DD_OK);
    expect(h.calls).toContain('readback');
    expect(h.pixels()).toEqual(rgba);
});

test('output permission removed during readback is rechecked before allocating DC', async () => {
    const h = harness();
    h.context.executor.syncSurfaceToMemory = async () => { h.landPixels(); h.denied.add(`${OUT}:rw`); };
    expect(await h.get()).toBe(E_POINTER);
    expect(h.calls).not.toContain('create');
});

test('throwing canvas seeding releases the DC and allows retry', async () => {
    const h = harness(); const seed = h.gdi.seedSurfaceDC;
    h.gdi.seedSurfaceDC = () => { throw new Error('canvas lost'); };
    expect(await h.get()).toBe(E_FAIL);
    expect(h.calls).toContain('release');
    h.gdi.seedSurfaceDC = seed;
    expect(await h.get()).toBe(DD_OK);
});


test('surface loss before and during GetDC returns DDERR_SURFACELOST', async () => {
    const h = harness(); h.state.surfaceLost = true;
    expect(await h.get()).toBe(DDERR_SURFACELOST); h.state.surfaceLost = false;
    h.context.executor.syncSurfaceToMemory = async () => { h.state.surfaceLost = true; h.state.gpuTexture = undefined; };
    expect(await h.get()).toBe(DDERR_SURFACELOST);
    expect(h.calls).not.toContain('create');
});


test('ReleaseDC checks the entire output span, including a protected trailing page', async () => {
    const h = harness(false); expect(await h.get()).toBe(DD_OK); h.paintOnePixel();
    const ordinaryValidation = h.process.addressSpace.validateRange;
    h.process.addressSpace.validateRange = (p, n, perms) => ordinaryValidation(p, n, perms) &&
        !(perms === 'rw' && p <= BITS + 15 && p + n > BITS + 15);
    expect(await h.release()).toBe(E_FAIL);
    expect(convertSurfaceToRGBA(h.memory(), BITS, 2, 2, 8, h.state.format)).toEqual(rgba);
    expect(h.calls).toContain('release');
});

test('ReleaseDC scratch describes packed RGB565 bytes, not unquantized canvas channels', async () => {
    const h = harness(false);
    h.state.format = { bpp: 16, rMask: 0xf800, gMask: 0x7e0, bMask: 0x1f, aMask: 0 };
    h.state.pitch = 6;
    expect(h.get()).toBe(DD_OK); h.paintOnePixel();
    const canvas = new Uint8ClampedArray([13, 37, 71, 63, 211, 99, 41, 5, 99, 11, 17, 83, 127, 191, 63, 0]);
    h.gdi.getImageData = () => ({data: canvas, width: 2, height: 2});
    expect(await h.release()).toBe(DD_OK);
    const written = convertSurfaceToRGBA(h.memory(), BITS, 2, 2, 6, h.state.format);
    expect(h.state.rgbaScratch).toEqual(written);
    expect(h.state.rgbaScratch).not.toEqual(new Uint8Array(canvas));
    const original = h.state.rgbaScratch.slice(); canvas.fill(0);
    expect(h.state.rgbaScratch).toEqual(original);
    expect(h.state.rgbaScratchVersion).toBe(h.state.version);
});

test('ReleaseDC XRGB scratch normalizes unused alpha without sharing canvas storage', async () => {
    const h = harness(false); h.state.format.aMask = 0;
    expect(h.get()).toBe(DD_OK); h.paintOnePixel();
    const canvas = new Uint8ClampedArray(rgba); canvas[3] = 17;
    h.gdi.getImageData = () => ({data: canvas, width: 2, height: 2});
    expect(await h.release()).toBe(DD_OK);
    expect(h.state.rgbaScratch).toEqual(convertSurfaceToRGBA(h.memory(), BITS, 2, 2, 8, h.state.format));
    expect(h.state.rgbaScratch[3]).toBe(255);
    canvas.fill(0); expect(h.state.rgbaScratch[0]).toBe(200);
});

test('GDI owner replacement during suspension refuses stale DC publication', async () => {
    const h = harness();
    h.context.executor.syncSurfaceToMemory = async () => { h.landPixels(); system.gdiContext = {...h.gdi}; };
    expect(await h.get()).toBe(E_FAIL);
    expect(h.calls).not.toContain('create');
    expect(new DataView(h.memory().buffer).getUint32(OUT, true)).toBe(0);
});

test('synchronous readback throw releases pending reservation before retry', async () => {
    const h = harness();
    h.context.executor.syncSurfaceToMemory = () => { throw new Error('sync host readback failure'); };
    expect(await h.get()).toBe(E_FAIL);
    h.context.executor.syncSurfaceToMemory = async () => h.landPixels();
    expect(await h.get()).toBe(DD_OK);
    expect(h.calls.filter(call => call === 'create')).toHaveLength(1);
});

test('current texture pixels are seeded and preserved through transparent drawing', async () => {
    const h = harness(false); h.state.caps = DDSCAPS_TEXTURE;
    expect(h.get()).toBe(DD_OK); expect(h.pixels()).toEqual(rgba);
    h.paintOnePixel(); expect(await h.release()).toBe(DD_OK);
    const expected = rgba.slice(); expected.set([255,255,255,255],4);
    expect(convertSurfaceToRGBA(h.memory(), BITS, 2, 2, 8, h.state.format)).toEqual(expected);
});
