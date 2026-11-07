/** GetUpdateRgn: the window's update region, copied into the caller's HRGN, and its type. */
import { beforeEach, expect, test } from 'bun:test';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { invalidateWindow, removeWindowUpdate, validateWindow } from '../../src/worker/modules/user32/paint-region';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { registerPaintingDcStateExports } from '../../src/worker/modules/gdi32/painting-dc-state';
import { NULLREGION, SIMPLEREGION, COMPLEXREGION } from '../../src/worker/modules/gdi32/dc-clip';

const HWND = 0x10021;
const RECT_AT = 0x100;

const user32 = createWindowExports();
const gdi32: Record<string, any> = {};
registerPaintingDcStateExports(gdi32);
const mem = new Uint8Array(4096);

const newRgn = (l = 0, t = 0, r = 1, b = 1): number => gdi32['CreateRectRgn'](null, mem, [l, t, r, b]);
const getUpdateRgn = (hWnd: number, hRgn: number): number => user32['GetUpdateRgn'](null, mem, [hWnd, hRgn, 0]);
const ptIn = (hRgn: number, x: number, y: number): number => gdi32['PtInRegion'](null, mem, [hRgn, x, y]);

function rgnBox(hRgn: number): number[] {
    gdi32['GetRgnBox'](null, mem, [hRgn, RECT_AT]);
    const view = new DataView(mem.buffer);
    return [0, 4, 8, 12].map((o) => view.getInt32(RECT_AT + o, true));
}

beforeEach(() => {
    windows.clear();
    removeWindowUpdate(HWND);
    windows.set(HWND, {
        handle: HWND, title: 't', style: 0, x: 0, y: 0, width: 100, height: 80,
        children: [], visible: true, wndProc: 0,
    } as WindowInfo);
});

test('a single invalid rect comes back as a SIMPLEREGION in client coordinates', () => {
    invalidateWindow(HWND, { left: 10, top: 5, right: 40, bottom: 30 }, false);
    const hRgn = newRgn();
    expect(getUpdateRgn(HWND, hRgn)).toBe(SIMPLEREGION);
    expect(rgnBox(hRgn)).toEqual([10, 5, 40, 30]);
});

test('a partly validated window keeps its shape as a COMPLEXREGION', () => {
    invalidateWindow(HWND, null, false);
    validateWindow(HWND, { left: 20, top: 20, right: 60, bottom: 50 });
    const hRgn = newRgn();
    expect(getUpdateRgn(HWND, hRgn)).toBe(COMPLEXREGION);
    expect(rgnBox(hRgn)).toEqual([0, 0, 100, 80]);
    expect(ptIn(hRgn, 5, 5)).toBe(1);
    expect(ptIn(hRgn, 30, 30)).toBe(0); // the validated hole
});

test('pieces left by validation that tile one rectangle are a SIMPLEREGION', () => {
    invalidateWindow(HWND, null, false);
    validateWindow(HWND, { left: 0, top: 0, right: 50, bottom: 40 });
    validateWindow(HWND, { left: 0, top: 40, right: 50, bottom: 80 });
    const hRgn = newRgn();
    expect(getUpdateRgn(HWND, hRgn)).toBe(SIMPLEREGION);
    expect(rgnBox(hRgn)).toEqual([50, 0, 100, 80]);
});

test('a window with nothing to paint empties the caller region and reports NULLREGION', () => {
    const hRgn = newRgn(0, 0, 50, 50);
    expect(getUpdateRgn(HWND, hRgn)).toBe(NULLREGION);
    expect(ptIn(hRgn, 10, 10)).toBe(0);
});

test('an unknown window or a handle that is not a region is an ERROR', () => {
    expect(getUpdateRgn(0x9999, newRgn())).toBe(0);
    expect(getUpdateRgn(HWND, 0x1234)).toBe(0);
});

test('GetRegionData reads back the COMPLEXREGION rects, and only into a big enough buffer', () => {
    invalidateWindow(HWND, null, false);
    validateWindow(HWND, { left: 20, top: 20, right: 60, bottom: 50 });
    const hRgn = newRgn();
    expect(getUpdateRgn(HWND, hRgn)).toBe(COMPLEXREGION);

    const BUF = 0x200;
    const getRegionData = (count: number, at: number): number => gdi32['GetRegionData'](null, mem, [hRgn, count, at]);
    const size = getRegionData(0, 0);
    const nRects = (size - 32) / 16;
    expect(nRects).toBeGreaterThan(1);
    expect(getRegionData(size - 1, BUF)).toBe(0);
    expect(getRegionData(size, BUF)).toBe(size);

    const view = new DataView(mem.buffer);
    const dword = (at: number) => view.getInt32(at, true);
    // RGNDATAHEADER: dwSize, iType = RDH_RECTANGLES, nCount, nRgnSize, rcBound.
    expect([0, 4, 8, 12, 16, 20, 24, 28].map((o) => dword(BUF + o))).toEqual([32, 1, nRects, nRects * 16, 0, 0, 100, 80]);
    let area = 0;
    for (let i = 0; i < nRects; i++) {
        const [l, t, r, b] = [0, 4, 8, 12].map((o) => dword(BUF + 32 + i * 16 + o));
        area += (r - l) * (b - t);
        expect(ptIn(hRgn, l, t)).toBe(1);
    }
    expect(area).toBe(100 * 80 - 40 * 30); // disjoint, and nothing but the region
});
