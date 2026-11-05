import { System } from '../../core/system';
import { savestateParticipants, stateKeys, type FieldPolicy } from '../../savestate/participant';
import { CaptureRefusal } from '../../savestate/object-codecs';
import type { SaveValue } from '../../savestate/value-codec';
import {
    WINDOW_CLASS_FIELDS, WINDOW_OBJECT_FIELDS, type WindowManagerState,
} from '../../runtime/windowing/window-manager';
import { PENDING_MESSAGE_FIELDS, type MessageQueueState } from '../../runtime/windowing/message-queue';
import {
    LIST_CONTROL_FIELDS, TRACKBAR_FIELDS, WINDOW_INFO_FIELDS, captureUser32Windows, restoreUser32Windows,
    type CursorClipRect, type User32WindowState,
} from './shared-state';
import { USER32_CLASS_FIELDS, captureUser32Classes, restoreUser32Classes, type User32ClassState } from './class';
import { capturePaintRegions, restorePaintRegions, type ClientRect } from './paint-region';
import { captureHooks, restoreHooks, type HookRegistration, type HookState } from './hooks';
import { captureMenus, restoreMenus, type MenuData, type MenuItem, type MenuState } from './menu';
import { captureScrollState, restoreScrollState, type ScrollBarState } from './scroll-state';
import { captureWindowPlacements, restoreWindowPlacements, type StoredWindowPlacement } from './window-geometry';
import { captureDeviceNotifications, restoreDeviceNotifications, type DeviceNotification, type DeviceNotifyState } from './device-notify';
import { capturePowerNotifications, restorePowerNotifications, type PowerNotifyState } from './power-notify';
import { captureDpiAwareness, restoreDpiAwareness, type DpiAwarenessState } from './dpi-awareness';
import { captureTouchPointerState, restoreTouchPointerState } from './touch-pointer';
import { captureOwnerDrawScratch, restoreOwnerDrawScratch } from './owner-draw';
import { captureNotifyScratch, restoreNotifyScratch } from './control-notify';
import { captureWindowPosState, restoreWindowPosState, type DeferredWindowPosEntry, type WindowPosState } from './window';
import { captureSystemCursorHandles, restoreSystemCursorHandles } from './system-cursors';
import { controlGestureInProgress, getWheelScrollLines, setWheelScrollLines } from './control-interaction';
import { pendingDialogCommandFor } from './dialog';
import { pendingChromeDeadlineCount } from './dialog-paint';
import { activeDialogs } from './modal-dialog-state';
import { animateControlCount } from './animate-control';
import { editControlCount } from './edit-control';
import { listViewControlCount } from './list-view-control';
import { richEditControlCount } from './rich-edit-control';
import { tabControlCount } from './tab-control';

export interface User32State {
    windows: User32WindowState;
    classes: User32ClassState;
    paintRegions: ReturnType<typeof capturePaintRegions>;
    hooks: HookState;
    menus: MenuState;
    scrollBars: Array<[string, ScrollBarState]>;
    placements: ReturnType<typeof captureWindowPlacements>;
    deviceNotify: DeviceNotifyState;
    powerNotify: PowerNotifyState;
    dpi: DpiAwarenessState;
    mouseInPointer: number;
    drawItemScratch: number;
    notifyScratch: [number, number];
    windowPos: WindowPosState;
    systemCursors: Array<[number, number]>;
    wheelScrollLines: number;
}

const keys = <T>(k: Record<keyof T, true>) => stateKeys<T>(k);

const SCROLL_BAR_FIELDS = {
    min: 'save', max: 'save', page: 'save', pos: 'save', enabled: 'save', visible: 'save', upEnabled: 'save', downEnabled: 'save',
} as const satisfies Record<keyof ScrollBarState, FieldPolicy>;

export const USER32_SCHEMA = {
    state: keys<User32State>({
        windows: true, classes: true, paintRegions: true, hooks: true, menus: true, scrollBars: true, placements: true,
        deviceNotify: true, powerNotify: true, dpi: true, mouseInPointer: true, drawItemScratch: true, notifyScratch: true,
        windowPos: true, systemCursors: true, wheelScrollLines: true,
    }),
    windows: keys<User32WindowState>({
        windows: true, buttonCheckStates: true, listControlStates: true, trackbarStates: true, controlImageHandles: true,
        clipboard: true, clipboardOpenOwner: true, clipboardSequence: true, cursorDisplayCount: true, cursorClipRect: true,
        currentCursorHandle: true, lockWindowUpdateHwnd: true, doubleClickTimeMs: true,
    }),
    window: WINDOW_INFO_FIELDS,
    listControl: LIST_CONTROL_FIELDS,
    trackbar: TRACKBAR_FIELDS,
    cursorClip: keys<CursorClipRect>({ left: true, top: true, right: true, bottom: true }),
    classes: keys<User32ClassState>({ classes: true, byName: true, nextClassId: true, appRegistered: true, builtins: true }),
    windowClass: USER32_CLASS_FIELDS,
    updateRect: keys<ClientRect>({ left: true, top: true, right: true, bottom: true }),
    hooks: keys<HookState>({ hooks: true, nextHookHandle: true }),
    hook: keys<HookRegistration>({ handle: true, idHook: true, lpfn: true, hMod: true, dwThreadId: true }),
    menus: keys<MenuState>({ menus: true, nextMenuHandle: true, systemMenus: true }),
    menu: keys<MenuData>({ handle: true, isPopup: true, items: true }),
    menuItem: keys<MenuItem>({ id: true, flags: true, text: true, hSubMenu: true }),
    scrollBar: SCROLL_BAR_FIELDS,
    placement: keys<StoredWindowPlacement>({
        flags: true, showCmd: true, ptMinX: true, ptMinY: true, ptMaxX: true, ptMaxY: true,
        normalLeft: true, normalTop: true, normalRight: true, normalBottom: true,
    }),
    deviceNotify: keys<DeviceNotifyState>({ registrations: true, nextHandle: true, payloads: true }),
    deviceRegistration: keys<DeviceNotification>({ hRecipient: true, devicetype: true, classGuid: true, unicode: true }),
    powerNotify: keys<PowerNotifyState>({ registrations: true, nextHandle: true }),
    dpi: keys<DpiAwarenessState>({ processContext: true, threadContexts: true }),
    windowPos: keys<WindowPosState>({ deferBatches: true, nextDeferHandle: true }),
    deferredPos: keys<DeferredWindowPosEntry>({ hWnd: true, hWndInsertAfter: true, x: true, y: true, cx: true, cy: true, uFlags: true }),
} as const;

export const WINDOW_MANAGER_SCHEMA = {
    state: keys<WindowManagerState>({
        classes: true, windows: true, nextHwnd: true, activeHwnd: true, focusHwnd: true,
        foregroundHwnd: true, foregroundThreadId: true, captureHwnd: true, zOrder: true,
    }),
    windowClass: WINDOW_CLASS_FIELDS,
    window: WINDOW_OBJECT_FIELDS,
} as const;

export const MESSAGE_QUEUE_SCHEMA = {
    state: keys<MessageQueueState>({
        posted: true, input: true, paintPending: true, timerPending: true, nextTimerMessage: true,
        lastMouseMove: true, moveSetCursor: true, lastDequeued: true,
    }),
    pending: PENDING_MESSAGE_FIELDS,
} as const;

function refuseUnsupported(): void {
    const controls: Array<[string, number]> = [
        ['animation', animateControlCount()], ['rich edit', richEditControlCount()], ['edit', editControlCount()],
        ['list view', listViewControlCount()], ['tab', tabControlCount()],
    ];
    for (const [name, count] of controls) {
        if (count > 0) throw new Error(`user32: ${name} controls are not part of a v1 savestate`);
    }
    if (activeDialogs.size > 0) throw new Error('user32: a modal dialog is open');
    if (pendingDialogCommandFor()) throw new Error('user32: a dialog command is pending');
    if (pendingChromeDeadlineCount() > 0) throw new Error('user32: a dialog is waiting for its first paint');
    const gesture = controlGestureInProgress();
    if (gesture) throw new Error(`user32: ${gesture}`);
}

export function captureUser32State(): User32State {
    refuseUnsupported();
    return {
        windows: captureUser32Windows(),
        classes: captureUser32Classes(),
        paintRegions: capturePaintRegions(),
        hooks: captureHooks(),
        menus: captureMenus(),
        scrollBars: captureScrollState(),
        placements: captureWindowPlacements(),
        deviceNotify: captureDeviceNotifications(),
        powerNotify: capturePowerNotifications(),
        dpi: captureDpiAwareness(),
        mouseInPointer: captureTouchPointerState(),
        drawItemScratch: captureOwnerDrawScratch(),
        notifyScratch: captureNotifyScratch(),
        windowPos: captureWindowPosState(),
        systemCursors: captureSystemCursorHandles(),
        wheelScrollLines: getWheelScrollLines(),
    };
}

export function restoreUser32State(s: User32State): void {
    restoreUser32Classes(s.classes);
    restorePaintRegions(s.paintRegions);
    restoreHooks(s.hooks);
    restoreMenus(s.menus);
    restoreScrollState(s.scrollBars);
    restoreWindowPlacements(s.placements);
    restoreDeviceNotifications(s.deviceNotify);
    restorePowerNotifications(s.powerNotify);
    restoreDpiAwareness(s.dpi);
    restoreTouchPointerState(s.mouseInPointer);
    restoreOwnerDrawScratch(s.drawItemScratch);
    restoreNotifyScratch(s.notifyScratch);
    restoreWindowPosState(s.windowPos);
    restoreSystemCursorHandles(s.systemCursors);
    setWheelScrollLines(s.wheelScrollLines);
    restoreUser32Windows(s.windows);
}

function refusing<T>(run: () => T): T {
    try {
        return run();
    } catch (e) {
        if (e instanceof CaptureRefusal) throw e;
        throw new CaptureRefusal(e instanceof Error ? e.message : String(e));
    }
}

export function registerUser32Participants(): void {
    savestateParticipants.add({
        id: 'window-manager', version: 1, order: 30, schema: WINDOW_MANAGER_SCHEMA as unknown as SaveValue,
        capture: () => refusing(() => System.getInstance().windowManager.captureState()) as unknown as SaveValue,
        restore: (s) => System.getInstance().windowManager.restoreState(s as unknown as WindowManagerState),
    });
    savestateParticipants.add({
        id: 'message-queue', version: 1, order: 31, schema: MESSAGE_QUEUE_SCHEMA as unknown as SaveValue,
        capture: () => refusing(() => System.getInstance().windowManager.captureQueueState()) as unknown as SaveValue,
        restore: (s) => System.getInstance().windowManager.restoreQueueState(s as unknown as MessageQueueState),
    });
    savestateParticipants.add({
        id: 'user32', version: 2, order: 40, covers: ['user32'], schema: USER32_SCHEMA as unknown as SaveValue,
        capture: () => refusing(captureUser32State) as unknown as SaveValue,
        restore: (s) => restoreUser32State(s as unknown as User32State),
    });
}
