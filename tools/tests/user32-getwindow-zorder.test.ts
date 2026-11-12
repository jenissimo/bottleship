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

function walk(start: number, command: number): number[] {
    const found: number[] = [];
    for (let hwnd = start; hwnd; hwnd = get(hwnd, command)) {
        // Bound traversal so a regression reports a failure instead of hanging the suite.
        expect(found).not.toContain(hwnd);
        expect(found.length).toBeLessThan(windows.size);
        found.push(hwnd);
    }
    return found;
}

test("desktop traversal crosses topmost/ordinary boundaries in both directions", () => {
    const ordinaryA = create(), ordinaryB = create();
    const topA = create(), topB = create();
    for (const hwnd of [topA, topB]) wm.setWindowZOrder(hwnd, -1);
    const order = [topB, topA, ordinaryB, ordinaryA];
    expect(wm.getZOrder()).toEqual(order);
    for (const hwnd of order) {
        expect(get(hwnd, 0)).toBe(topB);
        expect(get(hwnd, 1)).toBe(ordinaryA);
        expect(walk(get(hwnd, 0), 2)).toEqual(order);
        expect(walk(get(hwnd, 1), 3)).toEqual([...order].reverse());
    }
});

test("owned popup NEXT/PREV use desktop siblings and follow reordering", () => {
    const owner = create(), bottom = create(), popup = create(WS_POPUP, owner);
    create(WS_CHILD, owner);
    wm.setWindowZOrder(bottom, 1);
    expect(walk(get(owner, 0), 2)).toEqual([popup, owner, bottom]);
    expect(get(popup, 3)).toBe(0);
    wm.setWindowZOrder(bottom, 0);
    expect(walk(get(popup, 0), 2)).toEqual([bottom, popup, owner]);
    expect(get(popup, 3)).toBe(bottom);
    expect(get(owner, 2)).toBe(0);
});

test("child NEXT/PREV stay within the same parent and respect current order", () => {
    const parent = create(), other = create();
    const a = create(WS_CHILD, parent), b = create(WS_CHILD, parent), c = create(WS_CHILD, parent);
    create(WS_CHILD, other);
    windows.get(parent)!.children = [c, a, b];
    expect(walk(get(a, 0), 2)).toEqual([c, a, b]);
    expect(walk(get(c, 1), 3)).toEqual([b, a, c]);
    windows.get(parent)!.children.reverse();
    expect(walk(get(a, 0), 2)).toEqual([b, a, c]);
});

test("NEXT/PREV return NULL for sole siblings and invalid handles", () => {
    const parent = create(), child = create(WS_CHILD, parent);
    for (const hwnd of [parent, child, 0, 0xdead]) {
        expect(get(hwnd, 2)).toBe(0);
        expect(get(hwnd, 3)).toBe(0);
    }
});
