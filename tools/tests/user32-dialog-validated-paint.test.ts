import {expect, spyOn, test} from 'bun:test';
import {completeDefaultDialogPaint, repaintDialogOverlayIfVisible} from '../../src/worker/modules/user32/dialog-paint';
import {eraseDialogOverlay} from '../../src/worker/modules/user32/dialog-overlay';
import {armPaintTrace, clearPaintTrace, readPaintTrace} from '../../src/worker/modules/user32/paint-trace';
import {clearWindowUpdate, hasPendingUpdate, validateWindow} from '../../src/worker/modules/user32/paint-region';
import {handleSystemControlClassMouse, resetControlInteractionState} from '../../src/worker/modules/user32/control-interaction';
import {captureScrollState, getScrollBarState, restoreScrollState, SB_CTL, setScrollBarState} from '../../src/worker/modules/user32/scroll-state';
import {windows, type WindowInfo} from '../../src/worker/modules/user32/shared-state';
import {System} from '../../src/worker/core/system';

import {createWindowExports} from '../../src/worker/modules/user32/window';
import type {X86Context} from '../../src/worker/core/thunking/thunk-dispatcher';
import {DirectDrawSurfaceObject} from '../../src/worker/modules/ddraw/com-objects';
import {DDSCL_EXCLUSIVE, DDSCL_FULLSCREEN} from '../../src/worker/modules/ddraw/constants';
test('default dialog paint only falls back while an update region remains pending', async () => {
    const validated = 0x17340;
    const waiting = 0x17341;
    const synchronous = 0x17342;
    const subclassed = 0x1734a;
    const ownerDraw = 0x1734b;
    const handles = [validated, waiting, synchronous, subclassed];
    for (const handle of handles) {
        windows.set(handle, {
            handle, wndProc: 0x450000, nativeClassName: '#32770', visible: true,
            x: 0, y: 0, width: 100, height: 100, style: 0, children: [],
        } as WindowInfo);
    }
    const customDialog = windows.get(subclassed)!;
    customDialog.overlayOnFlipScreen = true;
    customDialog.children.push(ownerDraw);
    windows.set(ownerDraw, {
        handle: ownerDraw, parent: subclassed, visible: true, wndProc: 0x450010,
        x: 0, y: 0, width: 100, height: 60, style: 0x50000151, children: [],
        isSystemControl: true, systemControlClass: 'ListBox', wndProcSubclassed: true,
    } as WindowInfo);
    clearPaintTrace();
    armPaintTrace(true, handles);
    try {
        for (const handle of handles) repaintDialogOverlayIfVisible(handle);
        validateWindow(validated, null);
        validateWindow(synchronous, null);
        completeDefaultDialogPaint(synchronous);
        await Bun.sleep(320);
        const rows = readPaintTrace().entries;
        expect(rows.find(row => row.hwnd === validated && row.detail.includes('update-region-validated'))).toBeDefined();
        expect(rows.find(row => row.hwnd === waiting && row.detail.includes('fired: no paint cycle'))).toBeDefined();
        expect(rows.some(row => row.hwnd === subclassed && row.detail.includes('fired: no paint cycle'))).toBe(false);
        expect(hasPendingUpdate(subclassed)).toBe(true);
        expect(rows.some(row => row.hwnd === synchronous && row.detail.includes('default paint:'))).toBe(false);
    } finally {
        armPaintTrace(false);
        clearPaintTrace();
        windows.delete(ownerDraw);
        for (const handle of handles) {
            windows.delete(handle);
            clearWindowUpdate(handle);
            System.getInstance().windowManager.clearPaintMessage(handle);
        }
    }
});

test('invalidating and updating a hidden child keeps the repaint on that child', () => {
    const parent = 0x17343;
    const button = 0x17344;
    windows.set(parent, {
        handle: parent, wndProc: 0x450000, nativeClassName: '#32770', visible: true,
        x: 0, y: 0, width: 100, height: 100, style: 0, children: [button], overlayOnFlipScreen: true,
    } as WindowInfo);
    windows.set(button, {
        handle: button, wndProc: 0x450010, visible: false, parent,
        x: 0, y: 0, width: 50, height: 25, style: 0x4000000b, children: [],
        isSystemControl: true, systemControlClass: 'Button', wndProcSubclassed: true,
    } as WindowInfo);
    const api = createWindowExports();
    const memory = new Uint8Array(1024);
    try {
        expect(api.InvalidateRect!({} as X86Context, memory, [button, 0, 0])).toBe(1);
        expect(hasPendingUpdate(button)).toBe(true);
        expect(hasPendingUpdate(parent)).toBe(false);
        expect(api.UpdateWindow!({} as X86Context, memory, [button])).toBe(1);
        expect(System.getInstance().windowManager.hasMessages(0xf, 0xf)).toBe(false);
    } finally {
        for (const handle of [button, parent]) {
            windows.delete(handle);
            clearWindowUpdate(handle);
            System.getInstance().windowManager.clearPaintMessage(handle);
        }
    }
});

test('a DirectDraw dialog that validated its paint keeps ownership on the next update', async () => {
    const dialog = 0x17345;
    windows.set(dialog, {
        handle: dialog, wndProc: 0x450000, nativeClassName: '#32770', visible: true,
        x: 0, y: 0, width: 100, height: 100, style: 0, children: [], overlayOnFlipScreen: true,
    } as WindowInfo);
    const api = createWindowExports();
    const memory = new Uint8Array(1024);
    const ctx = {} as X86Context;
    clearPaintTrace();
    armPaintTrace(true, [dialog]);
    try {
        repaintDialogOverlayIfVisible(dialog);
        expect(api.ValidateRect!(ctx, memory, [dialog, 0])).toBe(1);
        expect(hasPendingUpdate(dialog)).toBe(false);
        clearPaintTrace();
        repaintDialogOverlayIfVisible(dialog);
        expect(hasPendingUpdate(dialog)).toBe(true);
        await Bun.sleep(320);
        const rows = readPaintTrace().entries;
        expect(rows.some(row => row.detail === 'posted')).toBe(true);
        expect(rows.some(row => row.detail.includes('guest-validated-paint'))).toBe(true);
        expect(rows.some(row => row.detail.includes('fired: no paint cycle'))).toBe(false);
    } finally {
        armPaintTrace(false);
        clearPaintTrace();
        windows.delete(dialog);
        clearWindowUpdate(dialog);
        System.getInstance().windowManager.clearPaintMessage(dialog);
    }
});

test('erasing a dialog reveals the presented DirectDraw owner without stamping its client onto the overlay', () => {
    const owner = 0x17346;
    const dialog = 0x17347;
    windows.set(owner, {
        handle: owner, wndProc: 0, visible: true,
        x: 0, y: 0, width: 800, height: 600, style: 0, children: [dialog],
    } as WindowInfo);
    windows.set(dialog, {
        handle: dialog, wndProc: 0x450000, nativeClassName: '#32770', visible: true,
        x: 140, y: 180, width: 200, height: 150, style: 0x40000000, parent: owner, children: [],
    } as WindowInfo);
    const surface: DirectDrawSurfaceObject = Object.create(DirectDrawSurfaceObject.prototype);
    let presented = true;
    let repaints = 0;
    const context = {
        cooperative: {hwnd: owner, flags: DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN},
        surfaces: {primary: 0x100000},
        resourceProvider: {getComObjectByAddress: () => surface},
        presenter: {hasPresentedFrame: () => presented},
    };
    const system = spyOn(System, 'getInstance').mockReturnValue({
        process: {getModule: () => ({context})},
        windowManager: {getZOrder: () => [owner], getZOrderWindow: () => undefined},
        services: {render: {getActive: () => null}},
        gdiContext: {clearOverlayRect: () => {}, createOverlayDC: () => { repaints++; return 0; }},
    } as never);
    try {
        eraseDialogOverlay(dialog);
        expect(repaints).toBe(0);
        presented = false;
        eraseDialogOverlay(dialog);
        expect(repaints).toBe(1);
    } finally {
        system.mockRestore();
        windows.delete(dialog);
        windows.delete(owner);
    }
});

test('dragging a scrollbar in a validated DirectDraw dialog requests a guest repaint', () => {
    const dialog = 0x17348;
    const scrollbar = 0x17349;
    const bar: WindowInfo = {
        handle: scrollbar, parent: dialog, visible: true, children: [],
        x: 75, y: 8, width: 16, height: 84, style: 0x40000001,
        isSystemControl: true, systemControlClass: 'ScrollBar',
    } as WindowInfo;
    windows.set(dialog, {
        handle: dialog, wndProc: 0x450000, nativeClassName: '#32770', visible: true,
        x: 0, y: 0, width: 100, height: 100, style: 0, children: [scrollbar],
        overlayOnFlipScreen: true, guestValidatedPaint: true, paintCycleRan: true,
    } as WindowInfo);
    windows.set(scrollbar, bar);
    const scrollState = captureScrollState();
    setScrollBarState(scrollbar, SB_CTL, {...getScrollBarState(scrollbar, SB_CTL), max: 100, page: 10});
    const windowManager = System.getInstance().windowManager;
    const postMessage = spyOn(windowManager, 'postMessage').mockImplementation(() => {});
    clearPaintTrace();
    armPaintTrace(true, [dialog]);
    try {
        expect(handleSystemControlClassMouse(bar, 0x0201, 1, (20 << 16) | 8)).toBe(true);
        expect(windowManager.getCaptureHwnd()).toBe(scrollbar);
        expect(handleSystemControlClassMouse(bar, 0x0200, 1, (45 << 16) | 8)).toBe(true);
        expect(hasPendingUpdate(dialog)).toBe(true);
        expect(readPaintTrace().entries.some(row => row.detail === 'posted')).toBe(true);
        expect(readPaintTrace().entries.some(row => row.detail.startsWith('paintDialogToOverlay'))).toBe(false);
        expect(postMessage.mock.calls.some(([hwnd, message]) => hwnd === dialog && message === 0x000f)).toBe(true);
        expect(postMessage.mock.calls.some(([hwnd, message, value]) =>
            hwnd === dialog && message === 0x0115 && (value & 0xffff) === 5)).toBe(true);
        expect(handleSystemControlClassMouse(bar, 0x0202, 0, (45 << 16) | 8)).toBe(true);
        expect(windowManager.getCaptureHwnd()).toBe(0);
    } finally {
        resetControlInteractionState();
        restoreScrollState(scrollState);
        postMessage.mockRestore();
        armPaintTrace(false);
        clearPaintTrace();
        windows.delete(dialog);
        windows.delete(scrollbar);
        clearWindowUpdate(dialog);
    }
});
