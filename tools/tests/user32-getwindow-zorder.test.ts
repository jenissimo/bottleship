import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { registerWindowQueryExports } from "../../src/worker/modules/user32/window-query";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const api: Record<string, ThunkImplementation> = {};
registerWindowQueryExports(api);
let savedWindows: Map<number, WindowInfo>;
let savedManager: WindowManager;
let wm: WindowManager;
beforeEach(() => {
    savedWindows = new Map(windows);
    windows.clear();
    savedManager = System.getInstance().windowManager;
    wm = new WindowManager();
    System.getInstance().windowManager = wm;
});
afterEach(() => {
    windows.clear();
    for (const [id, win] of savedWindows) windows.set(id, win);
    System.getInstance().windowManager = savedManager;
});
function create(style = WS_POPUP, parent = 0): number {
    const handle = wm.createWindow("Test", "test", style, 0, 0, 0, 10, 10, parent, 0, 0, 0);
    windows.set(handle, { handle, title: "test", style, parent, children: [], visible: true,
        x: 0, y: 0, width: 10, height: 10, wndProc: 0 });
    if ((style & WS_CHILD) && parent) windows.get(parent)!.children.unshift(handle);
    return handle;
}
function get(hwnd: number, command: number): number {
    return api.GetWindow!({} as never, new Uint8Array(0), [hwnd, command]) as number;
}
test("first and last follow current desktop Z-order rather than creation order", () => {
    const a = create(), b = create(), c = create();
    wm.setWindowZOrder(a, 0);
    wm.setWindowZOrder(b, 1);
    expect(wm.getZOrder()).toEqual([a, c, b]);
    for (const hwnd of [a, b, c]) {
        expect(get(hwnd, 0)).toBe(a);
        expect(get(hwnd, 1)).toBe(b);
    }
});
test("child traversal stays among siblings", () => {
    const parent = create(), other = create();
    const a = create(WS_CHILD, parent), b = create(WS_CHILD, parent);
    create(WS_CHILD, other);
    windows.get(parent)!.children = [a, b];
    for (const hwnd of [a, b]) {
        expect(get(hwnd, 0)).toBe(a);
        expect(get(hwnd, 1)).toBe(b);
    }
    windows.get(parent)!.children.reverse();
    expect(get(a, 0)).toBe(b);
    expect(get(b, 1)).toBe(a);
});
test("owned popups share the desktop list, not their owner's children", () => {
    const owner = create(), bottom = create();
    const popup = create(WS_POPUP, owner);
    create(WS_CHILD, owner);
    wm.setWindowZOrder(bottom, 1);
    expect(get(popup, 0)).toBe(popup);
    expect(get(popup, 1)).toBe(bottom);
});
test("a sole sibling returns itself; invalid handles return NULL", () => {
    const parent = create(), child = create(WS_CHILD, parent);
    expect(get(child, 0)).toBe(child);
    expect(get(child, 1)).toBe(child);
    expect(get(0, 0)).toBe(0);
    expect(get(0xdead, 1)).toBe(0);
});

test("desktop traversal keeps topmost and ordinary windows in their own groups", () => {
    const ordinaryA = create(), ordinaryB = create();
    const topA = create(), topB = create();
    for (const hwnd of [topA, topB]) {
        wm.setWindowZOrder(hwnd, -1);
    }
    expect(get(ordinaryA, 0)).toBe(ordinaryB);
    expect(get(ordinaryB, 1)).toBe(ordinaryA);
    expect(get(topA, 0)).toBe(topB);
    expect(get(topB, 1)).toBe(topA);
});
