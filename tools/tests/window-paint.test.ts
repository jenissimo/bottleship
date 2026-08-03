/**
 * Window paint fidelity harness — invalid regions, child Z-order, overlay repair hooks.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
    invalidateWindow,
    validateWindow,
    hasPendingUpdate,
    getWindowUpdateBounds,
    getWindowUpdateRects,
    consumeNeedsErase,
    clearWindowUpdate,
    removeWindowUpdate,
} from '../../src/worker/modules/user32/paint-region';
import {
    windows,
    controlImageHandles,
    reorderChildInParent,
    isWindowPosZOrderRequestValid,
    shouldSeedPaintFromParent,
    isCoveredByGuestChild,
    isFullyCoveredByGuestChild,
    getChildZOrderSibling,
    getChildrenInPaintOrder,
    setLockWindowUpdate,
    tryLockWindowUpdate,
    getLockWindowUpdate,
    isWindowUpdateLocked,
    type WindowInfo,
} from '../../src/worker/modules/user32/shared-state';
import { isWindowInActiveTree } from '../../src/worker/modules/user32/owner-draw';

function mkWin(handle: number, w = 100, h = 80): WindowInfo {
    return {
        handle,
        title: 't',
        style: 0,
        x: 0,
        y: 0,
        width: w,
        height: h,
        children: [],
        visible: true,
        wndProc: 0,
    };
}

describe('owner-draw active subtree guard', () => {
    const ROOT = 0x10001;
    const SUBMENU = 0x1001e;
    const SUBMENU_BUTTON = 0x10020;
    const ROOT_BUTTON = 0x10003;

    beforeEach(() => {
        windows.clear();
        windows.set(ROOT, { ...mkWin(ROOT), children: [ROOT_BUTTON, SUBMENU] });
        windows.set(ROOT_BUTTON, { ...mkWin(ROOT_BUTTON), parent: ROOT });
        windows.set(SUBMENU, { ...mkWin(SUBMENU), parent: ROOT, children: [SUBMENU_BUTTON] });
        windows.set(SUBMENU_BUTTON, { ...mkWin(SUBMENU_BUTTON), parent: SUBMENU });
    });

    test('allows a button in an active nested dialog', () => {
        expect(isWindowInActiveTree(windows.get(SUBMENU_BUTTON)!, SUBMENU)).toBe(true);
    });

    test('suppresses a root button underneath an active nested dialog', () => {
        expect(isWindowInActiveTree(windows.get(ROOT_BUTTON)!, SUBMENU)).toBe(false);
    });
});

describe('paint-region invalid areas', () => {
    const HWND = 0x10001;

    beforeEach(() => {
        windows.clear();
        removeWindowUpdate(HWND);
        windows.set(HWND, mkWin(HWND));
    });

    test('InvalidateRect NULL marks full client', () => {
        invalidateWindow(HWND, null, false);
        expect(hasPendingUpdate(HWND)).toBe(true);
        const b = getWindowUpdateBounds(HWND)!;
        expect(b).toEqual({ left: 0, top: 0, right: 100, bottom: 80 });
    });

    test('partial invalidation unions into bounding box', () => {
        invalidateWindow(HWND, { left: 10, top: 10, right: 50, bottom: 40 }, false);
        invalidateWindow(HWND, { left: 60, top: 20, right: 90, bottom: 70 }, true);
        const b = getWindowUpdateBounds(HWND)!;
        expect(b.left).toBe(10);
        expect(b.top).toBe(10);
        expect(b.right).toBe(90);
        expect(b.bottom).toBe(70);
        expect(consumeNeedsErase(HWND)).toBe(true);
    });

    test('ValidateRect partial subtracts from update region', () => {
        invalidateWindow(HWND, { left: 0, top: 0, right: 100, bottom: 80 }, false);
        validateWindow(HWND, { left: 0, top: 0, right: 50, bottom: 80 });
        const rects = getWindowUpdateRects(HWND);
        expect(rects.length).toBe(1);
        expect(rects[0].left).toBe(50);
    });

    test('ValidateRect NULL clears update region', () => {
        invalidateWindow(HWND, null, false);
        validateWindow(HWND, null);
        expect(hasPendingUpdate(HWND)).toBe(false);
    });

    test('BeginPaint clears update region', () => {
        invalidateWindow(HWND, null, true);
        expect(consumeNeedsErase(HWND)).toBe(true);
        clearWindowUpdate(HWND);
        expect(hasPendingUpdate(HWND)).toBe(false);
    });
});

describe('child Z-order helpers', () => {
    const PARENT = 0x10000;
    const A = 0x10001;
    const B = 0x10002;
    const C = 0x10003;

    beforeEach(() => {
        windows.clear();
        windows.set(PARENT, { ...mkWin(PARENT), children: [A, B, C] });
        windows.set(A, { ...mkWin(A), parent: PARENT });
        windows.set(B, { ...mkWin(B), parent: PARENT });
        windows.set(C, { ...mkWin(C), parent: PARENT });
    });

    test('paint order is back to front', () => {
        expect(getChildrenInPaintOrder(PARENT)).toEqual([C, B, A]);
    });

    test('SetWindowPos Z-order reorder', () => {
        reorderChildInParent(A, B);
        expect(windows.get(PARENT)!.children).toEqual([B, A, C]);
        expect(getChildZOrderSibling(A, 'prev')).toBe(B);
        expect(getChildZOrderSibling(A, 'next')).toBe(C);
    });

    test('SetWindowPos rejects TOPMOST/NOTOPMOST for child windows before applying the request', () => {
        const child = { ...windows.get(A)!, style: 0x40000000 }; // WS_CHILD
        expect(isWindowPosZOrderRequestValid(child, -1, 0)).toBe(false);
        expect(isWindowPosZOrderRequestValid(child, -2, 0)).toBe(false);
        expect(isWindowPosZOrderRequestValid(child, 0, 0)).toBe(true);
        expect(isWindowPosZOrderRequestValid(child, -1, 0x0004)).toBe(true); // SWP_NOZORDER
        windows.get(B)!.style |= 0x40000000;
        expect(isWindowPosZOrderRequestValid(child, B, 0)).toBe(true);
        expect(isWindowPosZOrderRequestValid(child, 0xdead, 0)).toBe(false);

        const topLevel = mkWin(0x20000);
        expect(isWindowPosZOrderRequestValid(topLevel, -1, 0)).toBe(true);
    });

    test('HWND_TOP moves child to front', () => {
        reorderChildInParent(A, 0);
        expect(windows.get(PARENT)!.children[0]).toBe(A);
        expect(getChildrenInPaintOrder(PARENT).at(-1)).toBe(A);
    });

    test('HWND_BOTTOM moves child to back', () => {
        reorderChildInParent(A, 1);
        expect(windows.get(PARENT)!.children.at(-1)).toBe(A);
        expect(getChildrenInPaintOrder(PARENT)[0]).toBe(A);
    });
});

describe('control paint backing', () => {
    test('subclassed STATIC starts from its parent instead of accumulated glyph pixels', () => {
        const parent = mkWin(0x30000);
        const child = {
            ...mkWin(0x30001),
            parent: parent.handle,
            isSystemControl: true,
            systemControlClass: 'Static',
            wndProcSubclassed: true,
        };
        expect(shouldSeedPaintFromParent(child)).toBe(true);
        expect(shouldSeedPaintFromParent({ ...child, wndProcSubclassed: false })).toBe(false);
        expect(shouldSeedPaintFromParent({ ...child, systemControlClass: 'Button' })).toBe(false);
    });

    test('guest child covering a STATIC suppresses the placeholder chrome', () => {
        const top = { ...mkWin(0x31000), children: [0x31001] };
        const placeholder = {
            ...mkWin(0x31001), parent: top.handle, children: [0x31002],
            x: 10, y: 20, width: 100, height: 80,
            style: 0x0007,
            isSystemControl: true, systemControlClass: 'Static',
        };
        const page = {
            ...mkWin(0x31002), parent: placeholder.handle,
            width: 120, height: 100,
        };
        windows.set(top.handle, top);
        windows.set(placeholder.handle, placeholder);
        windows.set(page.handle, page);

        expect(isFullyCoveredByGuestChild(placeholder.handle)).toBe(true);
        page.width = 90;
        expect(isFullyCoveredByGuestChild(placeholder.handle)).toBe(false);
        page.x = 10;
        page.width = 98;
        expect(isCoveredByGuestChild(placeholder.handle, 2)).toBe(true);
    });

    test('page hosted by an image STATIC seeds its paint DC from the parent', () => {
        const host = {
            ...mkWin(0x32000), children: [0x32001],
            isSystemControl: true, systemControlClass: 'Static',
        };
        const page = { ...mkWin(0x32001), parent: host.handle };
        windows.set(host.handle, host);
        windows.set(page.handle, page);
        controlImageHandles.set(host.handle, 0x40000);
        try {
            expect(shouldSeedPaintFromParent(page)).toBe(true);
        } finally {
            controlImageHandles.delete(host.handle);
        }
    });
});

describe('LockWindowUpdate', () => {
    const ROOT = 0x10000;
    const CHILD = 0x10001;

    beforeEach(() => {
        windows.clear();
        setLockWindowUpdate(0);
        windows.set(ROOT, { ...mkWin(ROOT), children: [CHILD] });
        windows.set(CHILD, { ...mkWin(CHILD), parent: ROOT });
    });

    test('locks subtree', () => {
        setLockWindowUpdate(ROOT);
        expect(isWindowUpdateLocked(ROOT)).toBe(true);
        expect(isWindowUpdateLocked(CHILD)).toBe(true);
        expect(isWindowUpdateLocked(0x99999)).toBe(false);
        setLockWindowUpdate(0);
        expect(isWindowUpdateLocked(ROOT)).toBe(false);
    });

    test('tryLockWindowUpdate: second lock fails until unlock', () => {
        expect(tryLockWindowUpdate(ROOT)).toBe(true);
        expect(getLockWindowUpdate()).toBe(ROOT);
        expect(tryLockWindowUpdate(CHILD)).toBe(false);
        expect(getLockWindowUpdate()).toBe(ROOT);
        expect(tryLockWindowUpdate(0)).toBe(true);
        expect(getLockWindowUpdate()).toBe(0);
        expect(tryLockWindowUpdate(CHILD)).toBe(true);
        expect(tryLockWindowUpdate(0)).toBe(true);
    });
});
