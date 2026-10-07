import { expect, test } from 'bun:test';
import { createDirectDrawPaletteClipperExports } from '../../src/worker/modules/ddraw/directdraw-palette-clipper';
import { DirectDrawPaletteObject, DirectDrawSurfaceObject } from '../../src/worker/modules/ddraw/com-objects';
import { DDSCAPS_PRIMARYSURFACE, DD_OK } from '../../src/worker/modules/ddraw/constants';
import { createSurfaceExports } from '../../src/worker/modules/ddraw/surface';

function fixture() {
    const mem = new Uint8Array(0x1000);
    mem.set([1, 2, 1, 2], 0x100);
    const palette = Object.assign(Object.create(DirectDrawPaletteObject.prototype), {
        entriesRaw: new Uint8Array(1024), paletteRGBA: new Uint32Array(256), version: 0,
    });
    Object.defineProperty(palette, 'handle', { value: 77 });
    const state = (caps: number, handle = 77) => ({ surfaceType: 'render_surface',
        caps, paletteHandle: handle, version: 1, mode: 'CPU', width: 4, height: 1,
        pitch: 4, surfacePtr: 0x100, format: { bpp: 8 }, gpuDirty: false });
    const front = state(DDSCAPS_PRIMARYSURFACE), back = state(0), unrelated = state(0, 78);
    const surfaces = [front, back, unrelated].map(s => Object.assign(Object.create(DirectDrawSurfaceObject.prototype), { getState: () => s }));
    const frames: number[][] = [];
    const context: any = {
        resourceProvider: {
            getAllComObjects: () => surfaces,
            getComObjectByAddress: (ptr: number) => ptr === 0x300 ? palette : ptr === 0x400 ? surfaces[0] : null,
        },
        presenter: { present: (s: typeof front, bytes: Uint8Array) => {
            frames.push([...bytes.subarray(s.surfacePtr, s.surfacePtr + 4)].map(index => palette.getEntries()[index]));
            return Promise.resolve();
        } },
    };
    return { mem, palette, context, front, back, unrelated, frames };
}

test('palette animation changes the displayed indexed image without a draw or Flip', () => {
    const f = fixture();
    const api = createDirectDrawPaletteClipperExports(f.context, () => 0);
    f.mem.set([255, 0, 0, 0, 0, 255, 0, 0], 0x200);
    expect(api.IDirectDrawPalette_SetEntries({} as any, f.mem, [0x300, 0, 1, 2, 0x200])).toBe(DD_OK);
    expect(f.frames).toEqual([[0xff0000ff, 0xff00ff00, 0xff0000ff, 0xff00ff00]]);
    f.mem.set([0, 0, 255, 0], 0x200);
    api.IDirectDrawPalette_SetEntries({} as any, f.mem, [0x300, 0, 1, 1, 0x200]);
    expect(f.frames[1]).toEqual([0xffff0000, 0xff00ff00, 0xffff0000, 0xff00ff00]);
    expect(f.back.gpuDirty).toBe(true);
    expect(f.unrelated.gpuDirty).toBe(false);
});

test('attaching a palette also changes primary scanout immediately; suppressed output stays quiet', () => {
    const f = fixture();
    f.palette.setEntriesFromRGB(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]), 0, 3);
    const api = createSurfaceExports(f.context);
    expect(api.IDirectDrawSurface7_SetPalette({} as any, f.mem, [0x400, 0x300])).toBe(DD_OK);
    expect(f.frames).toEqual([[0xff00ff00, 0xffff0000, 0xff00ff00, 0xffff0000]]);
    f.context.suppressPresent = true;
    const palettes = createDirectDrawPaletteClipperExports(f.context, () => 0);
    f.mem.set([20, 30, 40, 0], 0x200);
    palettes.IDirectDrawPalette_SetEntries({} as any, f.mem, [0x300, 0, 1, 1, 0x200]);
    expect(f.frames.length).toBe(1);
});
