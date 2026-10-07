import { expect, test } from 'bun:test';
import { PrimaryScanoutTracker } from '../../src/worker/modules/ddraw/primary-scanout';
import type { DirectDrawSurfaceState } from '../../src/worker/modules/ddraw/com-objects';

test('scanout observes writes between calls and emits no duplicate for unchanged pixels', () => {
    const tracker = new PrimaryScanoutTracker(), mem = new Uint8Array(128);
    const state = { surfacePtr: 16, pitch: 7, height: 3 } as DirectDrawSurfaceState;
    const observed: number[][] = [];
    const tick = () => { if (tracker.changed(mem, state)) observed.push([...mem.subarray(16, 37)]); };
    tick(); tick();
    for (const [offset, value] of [[0, 11], [13, 22], [20, 33]]) {
        mem[16 + offset] = value; tick(); tick();
    }
    expect(observed.length).toBe(4);
    expect(observed[3]).toEqual([11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22, 0, 0, 0, 0, 0, 0, 33]);
    tracker.reset(); expect(tracker.changed(mem, state)).toBe(true);
});

test('scanout owns its snapshot across memory growth, surface replacement and unaligned pointers', () => {
    const tracker = new PrimaryScanoutTracker();
    const state = { surfacePtr: 17, pitch: 5, height: 2 } as DirectDrawSurfaceState;
    const oldMemory = new Uint8Array(64);
    expect(tracker.changed(oldMemory, state)).toBe(true);
    const grown = new Uint8Array(128); grown.set(oldMemory); grown[26] = 99;
    expect(tracker.changed(grown, state)).toBe(true);
    expect(tracker.changed(grown, state)).toBe(false);
    expect(tracker.changed(grown, { ...state } as DirectDrawSurfaceState)).toBe(true);
    expect(tracker.changed(grown, { ...state, surfacePtr: 120 } as DirectDrawSurfaceState)).toBe(false);
});
