/**
 * User32 Window functions
 *
 * Atomic implementation for window operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { DESKTOP_HWND } from '../../runtime/windowing/window-manager';
import { getWindowClass, getWindowClassByName } from './class';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { WindowInfo, windows, incrementNextWindowId, getCursorDisplayCount, updateCursorDisplayCount, isGuestCursorVisible, syncHostCursorToGuestState, installCursorAndUpdateHostVisibility, getAbsoluteWindowPosition, markGuestCustomPaint, killWindowTimers, registerWindowDestroyFinalizer, reorderChildInParent, setLockWindowUpdate, isWindowUpdateLocked, hasSystemControlChildren } from './shared-state';
import {
    invalidateWindow,
    validateWindow,
    hasPendingUpdate,
    getWindowUpdateBounds,
    consumeNeedsErase,
    clearWindowUpdate,
    removeWindowUpdate,
    readClientRectFromMem,
    writeClientRectToMem,
} from './paint-region';
import { WH_CBT, HCBT_CREATEWND, getHooksOfType } from './hooks';
import { registerWindowDrawingExports } from './window-drawing';
import { registerWindowGeometryExports, removeWindowPlacement } from './window-geometry';
import { registerWindowQueryExports } from './window-query';
import { registerWindowPropExports } from './window-props';
import { GDIContext } from '../gdi32/context';
import { ensureAnimateControlClasses, clearAnimateState, onAnimateShowWindow, isAnimateControlWindow } from './animate-control';
import { getBuiltinSystemClass } from './system-classes';
import { invalidateControlColors } from './control-colors';
import { applyScrollInfo, setScrollPos as setScrollBarPos } from './scroll-state';
import { repaintDialogOverlayIfVisible, repaintDialogAfterContentChange, isSentinelWndProc, handleSystemControlMessage, isContentChangingMessage, requestGuestDialogPaint } from './dialog';
import { noteDialogOverlayCandidate, eraseDialogOverlay } from './dialog-overlay';
import { resetControlInteractionState } from './control-interaction';
import { isDDrawExclusiveFullscreen } from '../ddraw/gdi-visibility';
import { PAINT_TRACE_ENABLED, logBeginEndPaint } from './paint-trace';
import { repaintChildControls } from './controls';
import { tryEndPaintOwnerDrawChain, tryRepaintOwnerDrawButton } from './owner-draw';
import { beginSyncDestroyDelivery } from './destroy-sync';
import {
    postInitialActivationMessages,
    activateTopLevelWindow,
    setForegroundWithFocus,
    resolveForegroundTargets,
    reactivateOwnerIfNeeded,
    buildPendingActivationSteps,
    markPendingActivation,
    markActivationDelivered,
    needsActivationDelivery,
    type ActivationStep,
    resolveActivationWndProc,
    isDialogInitInProgress,
    isWindowInitInProgress,
} from './activation-messages';

export function getWindowByHandle(handle: number): WindowInfo | undefined {
    return windows.get(handle);
}

function isDialogLikeWindow(window: WindowInfo): boolean {
    return !!window.guestCustomPaint
        || (window.nativeClassName ?? '').toLowerCase() === '#32770';
}

/** Repaint the parent's overlay when a system child (static/logo) moves or resizes.
 *  The parent needn't be a dialog — repaintDialogAfterContentChange handles any
 *  window hosting system controls (plain launcher/menu windows included). */
function repaintParentDialogIfSystemControlGeometryChanged(
    window: WindowInfo,
    moved: boolean,
    resized: boolean,
): void {
    if (!window.isSystemControl || !window.parent || (!moved && !resized)) return;
    const parentHwnd = window.parent;
    const parent = windows.get(parentHwnd);
    if (!parent) return;
    Logger.verbose(LogCategory.USER32,
        `repaint parent dialog 0x${parentHwnd.toString(16)} after child ` +
        `0x${window.handle.toString(16)} id=${window.controlId ?? '?'} ` +
        `${window.systemControlClass ?? '?'} geom → (${window.x},${window.y}) ${window.width}x${window.height}`);
    repaintDialogAfterContentChange(parentHwnd);
}

const WM_SIZE_GEO = 0x0005;
const WM_MOVE_GEO = 0x0003;
const SIZE_RESTORED_GEO = 0;
const SWP_NOMOVE_GEO = 0x0002;
const SWP_NOSIZE_GEO = 0x0001;
const SWP_NOSENDCHANGING_GEO = 0x0400;

const makeGeometryLParam = (lo: number, hi: number): number =>
    (((lo & 0xFFFF) | ((hi & 0xFFFF) << 16)) >>> 0);

interface DeferredWindowPosEntry {
    hWnd: number;
    hWndInsertAfter: number;
    x: number;
    y: number;
    cx: number;
    cy: number;
    uFlags: number;
}

const deferWindowPosBatches = new Map<number, DeferredWindowPosEntry[]>();
let nextDeferWindowPosHandle = 1;

interface ApplyWindowPosOptions {
    /** Batch EndDeferWindowPos repaints once after all entries apply. */
    skipDialogOverlayRepaint?: boolean;
}

function resolveGuestWndProc(win: WindowInfo): number {
    // The dialog/window procedure lives in win.wndProc. extraBytes is the guest-owned
    // Win32 DWL/DWLP area (DWLP_MSGRESULT=0, DWLP_DLGPROC=4, DWLP_USER=8) addressed by
    // SetWindowLong/GetWindowLong (idx>>2); it must NOT be aliased to the proc, or a
    // guest SetWindowLong(hDlg, DWLP_MSGRESULT, ...) would clobber it.
    return win.wndProc ?? 0;
}

const WM_PAINT_GEO = 0x000F;

function finishWindowPosRepaint(hWnd: number): void {
    const win = windows.get(hWnd);
    if (!win?.visible || win.nativeClassName !== '#32770') return;
    if (win.guestCustomPaint) {
        repaintChildControls(hWnd);
        return;
    }
    repaintDialogOverlayIfVisible(hWnd);
}

function trySuspendForSyncWindowMessage(
    ctx: any,
    hWnd: number,
    msg: number,
    wParam: number,
    lParam: number,
    label: string,
    stackCleanup: number,
    onComplete: () => number | null,
    existingFrameId?: number,
): { suspended: true; callbackId: number } | { suspended: false } {
    const win = windows.get(hWnd);
    // A subclassed system control's wndproc IS the guest's — sync messages must reach it.
    if (!win || (win.isSystemControl && !win.wndProcSubclassed)) return { suspended: false };

    // Win32 does not re-enter WM_PAINT while WM_CREATE / WM_INITDIALOG is running.
    if (msg === WM_PAINT_GEO && isWindowInitInProgress(hWnd)) {
        return { suspended: false };
    }

    const wndProc = resolveGuestWndProc(win);
    if (!wndProc || isSentinelWndProc(wndProc)) return { suspended: false };

    const system = System.getInstance();
    const callbackManager = system.process?.dispatcher?.callbackManager;
    const mem = system.process?.v86?.mem8 ?? system.process?.v86?.v86?.cpu?.mem8;
    if (!callbackManager || !mem) return { suspended: false };

    let frameId = existingFrameId ?? 0;
    if (!frameId) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const thunkReturnAddr = view.getUint32(ctx.esp, true);
        frameId = callbackManager.saveSuspendedThunkContext(
            { ...ctx, returnAddr: thunkReturnAddr },
            stackCleanup,
            label,
        );
        if (!frameId) return { suspended: false };
    }

    const first = callbackManager.invokeCallback(
        wndProc,
        [hWnd, msg, wParam, lParam],
        0,
        onComplete,
        false,
        `${label}:sync0x${msg.toString(16)}`,
        frameId,
    );
    if (first.callbackId === 0) return { suspended: false };
    return { suspended: true, callbackId: first.callbackId };
}

/**
 * Win32 SetWindowPos delivers WM_SIZE/WM_MOVE synchronously (SendMessage) before returning.
 * dlgProc often resizes child controls or paints the client in WM_PAINT (UE1 splash).
 */
function trySuspendForSyncGeometryNotify(
    ctx: any,
    hWnd: number,
    moved: boolean,
    resized: boolean,
    uFlags: number,
    label: string,
    stackCleanup: number,
): { suspended: true; callbackId: number } | { suspended: false } {
    if (uFlags & SWP_NOSENDCHANGING_GEO) return { suspended: false };
    const win = windows.get(hWnd);
    // A subclassed system control's wndproc IS the guest's — sync messages must reach it.
    if (!win || (win.isSystemControl && !win.wndProcSubclassed)) return { suspended: false };

    const wndProc = resolveGuestWndProc(win);
    if (!wndProc || isSentinelWndProc(wndProc)) return { suspended: false };

    let msg = 0;
    let wParam = 0;
    let lParam = 0;
    if (resized) {
        msg = WM_SIZE_GEO;
        wParam = SIZE_RESTORED_GEO;
        lParam = makeGeometryLParam(win.width, win.height);
    } else if (moved) {
        msg = WM_MOVE_GEO;
        lParam = makeGeometryLParam(win.x, win.y);
    } else {
        return { suspended: false };
    }

    const system = System.getInstance();
    const callbackManager = system.process?.dispatcher?.callbackManager;
    const mem = system.process?.v86?.mem8 ?? system.process?.v86?.v86?.cpu?.mem8;
    if (!callbackManager || !mem) return { suspended: false };

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const thunkReturnAddr = view.getUint32(ctx.esp, true);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: thunkReturnAddr },
        stackCleanup,
        label,
    );
    if (!frameId) return { suspended: false };

    const completeRepaint = (): number | null => {
        finishWindowPosRepaint(hWnd);
        return 1;
    };

    const completeAfterSize = (): number | null => {
        if (resized && !isWindowInitInProgress(hWnd)) {
            const paintSync = trySuspendForSyncWindowMessage(
                ctx, hWnd, WM_PAINT_GEO, 0, 0, label, stackCleanup, completeRepaint, frameId);
            if (paintSync.suspended) return null;
        }
        return completeRepaint();
    };

    const first = callbackManager.invokeCallback(
        wndProc,
        [hWnd, msg, wParam, lParam],
        0,
        completeAfterSize,
        false,
        `${label}:syncGeo`,
        frameId,
    );
    if (first.callbackId === 0) return { suspended: false };
    return { suspended: true, callbackId: first.callbackId };
}

/** Shared SetWindowPos / DeferWindowPos geometry apply (Win32-faithful). */
function applyWindowPosGeometry(
    hWnd: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
    uFlags: number,
    options?: ApplyWindowPosOptions,
): { moved: boolean; resized: boolean } | null {
    const window = windows.get(hWnd);
    if (!window) return null;

    const moving = !(uFlags & SWP_NOMOVE_GEO) && (x !== window.x || y !== window.y);
    const resizing = !(uFlags & SWP_NOSIZE_GEO) && cx > 0 && cy > 0
        && (cx !== window.width || cy !== window.height);

    if (window.isSystemControl && resizing) {
        Logger.log(LogCategory.USER32,
            `SetWindowPos: system control 0x${hWnd.toString(16)} id=${window.controlId ?? '?'} ` +
            `→ ${cx}x${cy} (was ${window.width}x${window.height})`);
    }

    if ((moving || resizing) && window.visible && window.nativeClassName === '#32770') {
        eraseDialogOverlay(hWnd);
    }
    if (!(uFlags & SWP_NOMOVE_GEO)) {
        window.x = x;
        window.y = y;
    }
    if (!(uFlags & SWP_NOSIZE_GEO) && cx > 0 && cy > 0) {
        window.width = cx;
        window.height = cy;
    }

    const wmWin = System.getInstance().windowManager.getWindow(hWnd);
    if (wmWin) {
        if (!(uFlags & SWP_NOMOVE_GEO)) {
            wmWin.rect.x = window.x;
            wmWin.rect.y = window.y;
        }
        if (!(uFlags & SWP_NOSIZE_GEO) && cx > 0 && cy > 0) {
            wmWin.rect.w = window.width;
            wmWin.rect.h = window.height;
        }
    }

    repaintParentDialogIfSystemControlGeometryChanged(window, moving, resizing);

    if (!options?.skipDialogOverlayRepaint
        && window.visible && window.nativeClassName === '#32770'
        && (moving || resizing)) {
        finishWindowPosRepaint(hWnd);
    }

    return { moved: moving, resized: resizing };
}

function shouldSuppressWindowOverlay(hWnd: number, window: WindowInfo): boolean {
    const ddraw = System.getInstance().ddrawContext;
    if (!ddraw || ddraw.cooperative.hwnd !== hWnd) return false;
    if (isDialogLikeWindow(window)) return false;
    return isDDrawExclusiveFullscreen(ddraw);
}

/** Client-area memory DC; composited to overlay on EndPaint / ReleaseDC. */
function createWindowClientDC(gdi: GDIContext, hWnd: number): number {
    const window = getWindowByHandle(hWnd);
    if (!window) {
        return gdi.createDC();
    }
    const { x, y } = getAbsoluteWindowPosition(window);
    const hdc = gdi.createSizedMemoryDC(window.width, window.height);
    if (hdc) {
        if (!shouldSuppressWindowOverlay(hWnd, window)) {
            gdi.attachWindowBlit(hdc, x, y, window.width, window.height);
            gdi.seedMemoryDCFromOverlay(hdc);
        } else {
            Logger.verbose(LogCategory.USER32,
                `createWindowClientDC: suppress overlay for exclusive DDraw hwnd=0x${hWnd.toString(16)}`);
        }
    }
    return hdc;
}

export function createWindowExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // CW_USEDEFAULT is 0x80000000, which as a signed 32-bit int is -2147483648
    const CW_USEDEFAULT = 0x80000000 | 0; // Force signed representation
    const WM_SIZE = 0x0005;
    const WM_SHOWWINDOW = 0x0018;
    const WM_PAINT = 0x000F;
    const SIZE_RESTORED = 0;

    function isCwUseDefault(val: number): boolean {
        return (val | 0) === CW_USEDEFAULT || (val >>> 0) === 0x80000000;
    }

    function resolveSize(width: number, height: number): { width: number; height: number } {
        const w = (width === 0 || isCwUseDefault(width)) ? 800 : width;
        const h = (height === 0 || isCwUseDefault(height)) ? 600 : height;
        return { width: Math.max(1, w), height: Math.max(1, h) };
    }

    const makeLParam = (lo: number, hi: number): number =>
        (((lo & 0xFFFF) | ((hi & 0xFFFF) << 16)) >>> 0);

    const postInitialVisibleWindowMessages = (windowInfo: WindowInfo): void => {
        if (!windowInfo.visible) return;
        const system = System.getInstance();

        // First visible top-level window: deliver WM_ACTIVATEAPP + WM_ACTIVATE so
        // guest OnActivate handlers run (StarCraft render loop, HL splash.bmp load, etc.).
        if (!windowInfo.parent && system.windowManager.getActiveHwnd() === windowInfo.handle) {
            postInitialActivationMessages(windowInfo.handle);
        }

        if (!windowInfo.createSyncVisibleDelivered) {
            system.windowManager.postMessage(windowInfo.handle, WM_SHOWWINDOW, 1, 0);
            system.windowManager.postMessage(
                windowInfo.handle,
                WM_SIZE,
                SIZE_RESTORED,
                makeLParam(windowInfo.width, windowInfo.height)
            );
        }
        system.windowManager.postMessage(windowInfo.handle, WM_PAINT, 0, 0);
    };

    /** Win32: WM_SHOWWINDOW/WM_SIZE/WM_PAINT follow WM_CREATE, not precede it. */
    const finishCreateWindowCallbacks = (windowInfo: WindowInfo): number => {
        windowInfo.createInProgress = false;
        postInitialVisibleWindowMessages(windowInfo);
        return windowInfo.handle;
    };

    function createInternal(
        className: string | number,
        windowName: string,
        dwStyle: number,
        dwExStyle: number,
        X: number,
        Y: number,
        nWidth: number,
        nHeight: number,
        hWndParent: number,
        hMenu: number,
        hInstance: number,
        lpParam: number
    ): WindowInfo | null {
        // Find class
        let classInfo: any;
        let classId: number | undefined;

        if (typeof className === 'number') {
            classId = className;
            classInfo = getWindowClass(classId);
        } else {
            classInfo = getWindowClassByName(className);
        }

        if (!classInfo && typeof className === 'string') {
            ensureAnimateControlClasses();
            classInfo = getWindowClassByName(className);
        }

        if (!classInfo && typeof className === 'string') {
            Logger.warn(LogCategory.USER32, `CreateWindowEx: class "${className}" not found, using dummy`);
            classInfo = { lpfnWndProc: 0 };
        }

        // Built-in user32 control class (Button/Static/Edit/...) not shadowed by an
        // app-registered class: create a JS-driven system control, same machinery as
        // dialog-template children.
        const builtinDescr = (typeof className === 'string' && classInfo?.isBuiltinSystemClass)
            ? getBuiltinSystemClass(className)
            : undefined;

        const WS_CHILD = 0x40000000;
        const isChildWindow = (dwStyle & WS_CHILD) !== 0;

        // CW_USEDEFAULT / zero-size defaults are a top-level concept; a child control
        // keeps its requested size (games create 0-sized or tiny controls on purpose).
        const size = (builtinDescr && isChildWindow)
            ? { width: Math.max(0, nWidth | 0), height: Math.max(0, nHeight | 0) }
            : resolveSize(nWidth, nHeight);

        const resolvedClassName = typeof className === 'string'
            ? (builtinDescr?.name ?? className)
            : (classInfo?.className ?? 'Static');

        // Create in system WindowManager FIRST to get the canonical hwnd
        // This ensures hwnd is consistent between shared-state and WindowManager.
        // Honor the real X,Y for CHILD windows — their coords are relative to the parent
        // client, which is exactly our render-surface origin. Top-level windows stay at (0,0):
        // we render a single app surface, so on-screen placement is irrelevant and forcing 0,0
        // avoids a raw CW_USEDEFAULT (0x80000000) landing the window far off-surface.
        // The HL menu banner (SysAnimate32 "logo.avi", WS_CHILD) is created via CreateWindowExA
        // with a non-zero Y and never MoveWindow'd — discarding its Y pinned it to the top
        // instead of over the title. (Owner-draw buttons survive the old 0,0 because HL
        // MoveWindows them afterward, which overrides this.)
        const xUseDefault = (X | 0) === (0x80000000 | 0) || (X >>> 0) === 0x80000000;
        const yUseDefault = (Y | 0) === (0x80000000 | 0) || (Y >>> 0) === 0x80000000;
        const resolvedX = (isChildWindow && !xUseDefault) ? (X | 0) : 0;
        const resolvedY = (isChildWindow && !yUseDefault) ? (Y | 0) : 0;

        const hwnd = System.getInstance().windowManager.createWindow(
            resolvedClassName,
            windowName,
            dwStyle,
            dwExStyle,
            resolvedX,
            resolvedY,
            size.width,
            size.height,
            hWndParent,
            hMenu,
            hInstance,
            lpParam
        );

        const windowInfo: WindowInfo = {
            handle: hwnd, // Use hwnd from WindowManager
            classId,
            title: windowName,
            style: dwStyle,
            exStyle: dwExStyle,
            x: resolvedX,
            y: resolvedY,
            width: size.width,
            height: size.height,
            hMenu: ((dwStyle & 0x40000000) === 0 && hMenu) ? hMenu : undefined,
            // Never self-parent: a window whose parent handle equals its own (or the
            // desktop pseudo-handle) is top-level. Self-parenting would form a cycle in
            // the window tree and spin getAbsoluteWindowPosition forever.
            parent: (hWndParent && hWndParent !== hwnd && hWndParent !== DESKTOP_HWND) ? hWndParent : undefined,
            children: [],
            visible: (dwStyle & 0x10000000) !== 0,  // WS_VISIBLE
            wndProc: classInfo?.lpfnWndProc ?? 0,
            userData: 0,
            cbWndExtra: classInfo?.cbWndExtra ?? 0,
            extraBytes: classInfo?.cbWndExtra ? new Uint32Array(Math.ceil(classInfo.cbWndExtra / 4)) : undefined,
            nativeClassName: resolvedClassName,
        };

        if (builtinDescr?.controlClass) {
            windowInfo.isSystemControl = true;
            windowInfo.systemControlClass = builtinDescr.controlClass;
            // For a WS_CHILD window the hMenu argument is the control id.
            if (isChildWindow) windowInfo.controlId = hMenu >>> 0;
            windowInfo.fontHandle = windows.get(hWndParent)?.fontHandle;
        }

        windows.set(windowInfo.handle, windowInfo);

        // Add to parent's children list
        if (hWndParent) {
            const parent = windows.get(hWndParent);
            if (parent) {
                parent.children.push(windowInfo.handle);
                // A visible plain window gaining its first system control while the
                // game owns the screen becomes an overlay candidate (controls are
                // usually created AFTER the parent was shown).
                if (windowInfo.isSystemControl) {
                    noteDialogOverlayCandidate(parent);
                }
            }
        }

        Logger.log(LogCategory.USER32, `Created window ${windowInfo.handle} (${windowInfo.width}x${windowInfo.height}) at (${resolvedX},${resolvedY}) reqXY=(${X | 0},${Y | 0}) child=${isChildWindow ? 1 : 0}`);

        return windowInfo;
    }

    /**
     * Shared callback chain for CreateWindowExA/W.
     * Phases: CBT hooks (0..N-1), WM_NCCREATE (N), WM_CREATE (N+1).
     * When no CBT hooks are registered, phase starts at N — identical to previous behavior.
     */
    function fireCreateWindowCallbacks(
        ctx: any, windowInfo: WindowInfo,
        lpParam: number, hInstance: number, hMenu: number, hWndParent: number,
        dwStyle: number, lpWindowName: number, lpClassName: number, dwExStyle: number,
        label: string,
    ): any {
        const system = System.getInstance();
        const callbackManager = system.process?.dispatcher?.callbackManager;

        // Gather CBT hooks — only allocate if needed
        const cbtHooks = callbackManager ? getHooksOfType(WH_CBT) : [];
        const totalCbtHooks = cbtHooks.length;

        // JS-driven system controls have a DefWindowProc thunk wndProc; WM_NCCREATE /
        // WM_CREATE into it is a guest round-trip for a no-op (dialog children skip it
        // the same way). CBT hooks still fire below when present.
        const hasGuestCreateProc = !!windowInfo.wndProc && !windowInfo.isSystemControl;

        if (!callbackManager || (!hasGuestCreateProc && totalCbtHooks === 0)) {
            postInitialVisibleWindowMessages(windowInfo);
            return windowInfo.handle;
        }

        windowInfo.createInProgress = true;

        // Allocate CREATESTRUCT (48 bytes)
        const createStruct = system.process!.memory.alloc(48, "HEAP", "rw");
        Mem.writeUint32(createStruct + 0, lpParam >>> 0);
        Mem.writeUint32(createStruct + 4, hInstance >>> 0);
        Mem.writeUint32(createStruct + 8, hMenu >>> 0);
        Mem.writeUint32(createStruct + 12, hWndParent >>> 0);
        Mem.writeUint32(createStruct + 16, windowInfo.height >>> 0);
        Mem.writeUint32(createStruct + 20, windowInfo.width >>> 0);
        Mem.writeUint32(createStruct + 24, windowInfo.y >>> 0);
        Mem.writeUint32(createStruct + 28, windowInfo.x >>> 0);
        Mem.writeUint32(createStruct + 32, dwStyle >>> 0);
        Mem.writeUint32(createStruct + 36, lpWindowName >>> 0);
        Mem.writeUint32(createStruct + 40, lpClassName >>> 0);
        Mem.writeUint32(createStruct + 44, dwExStyle >>> 0);

        // Allocate CBT_CREATEWND (8 bytes) if CBT hooks exist
        let cbtCreateWndPtr = 0;
        if (totalCbtHooks > 0) {
            cbtCreateWndPtr = system.process!.memory.alloc(8, "HEAP", "rw");
            Mem.writeUint32(cbtCreateWndPtr + 0, createStruct);  // lpcs → CREATESTRUCT*
            Mem.writeUint32(cbtCreateWndPtr + 4, 0);             // hwndInsertAfter = HWND_TOP
        }

        const WM_NCCREATE = 0x0081;
        const WM_CREATE = 0x0001;
        Logger.log(LogCategory.USER32,
            `${label}: cbtHooks=${totalCbtHooks} hwnd=0x${windowInfo.handle.toString(16)} wndProc=0x${windowInfo.wndProc.toString(16)}`);

        const stackCleanup = 12 * 4;
        const frameId = callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, label);
        if (!frameId) {
            Logger.error(LogCategory.USER32, `${label}: failed to save suspended thunk context`);
            return 0;
        }

        // Phase layout: 0..totalCbtHooks-1 = CBT hooks, totalCbtHooks = WM_NCCREATE, totalCbtHooks+1 = WM_CREATE
        let phase = 0;
        const completeThunk = (_ret: number): number | null => {
            if (phase < totalCbtHooks) {
                // More CBT hooks to fire
                phase++;
                if (phase < totalCbtHooks) {
                    try {
                        callbackManager.invokeCallback(
                            cbtHooks[phase].lpfn,
                            [HCBT_CREATEWND, windowInfo.handle, cbtCreateWndPtr],
                            0,
                            completeThunk,
                            false,
                            `${label}:CBT_${phase}`,
                            frameId
                        );
                        return null;
                    } catch (e) {
                        Logger.warn(LogCategory.USER32, `${label}: CBT hook ${phase} invoke failed: ${e}`);
                        // Fall through to WM_NCCREATE
                    }
                }
                // Fall through: all CBT hooks done, now WM_NCCREATE
            }

            if (phase <= totalCbtHooks && hasGuestCreateProc) {
                // WM_NCCREATE phase
                phase = totalCbtHooks + 1;
                try {
                    callbackManager.invokeCallback(
                        windowInfo.wndProc,
                        [windowInfo.handle, WM_NCCREATE, 0, createStruct],
                        0,
                        completeThunk,
                        false,
                        `${label}:WM_NCCREATE`,
                        frameId
                    );
                    return null;
                } catch (e) {
                    Logger.warn(LogCategory.USER32, `${label}: WM_NCCREATE invoke failed: ${e}`);
                    windowInfo.createInProgress = false;
                    return windowInfo.handle;
                }
            }

            if (phase === totalCbtHooks + 1 && hasGuestCreateProc) {
                // WM_CREATE phase
                phase = totalCbtHooks + 2;
                try {
                    callbackManager.invokeCallback(
                        windowInfo.wndProc,
                        [windowInfo.handle, WM_CREATE, 0, createStruct],
                        0,
                        completeThunk,
                        false,
                        `${label}:WM_CREATE`,
                        frameId
                    );
                    return null;
                } catch (e) {
                    Logger.warn(LogCategory.USER32, `${label}: WM_CREATE invoke failed: ${e}`);
                    windowInfo.createInProgress = false;
                    return windowInfo.handle;
                }
            }

            // Win32 CreateWindowEx(WS_VISIBLE) delivers WM_SHOWWINDOW/WM_SIZE synchronously
            // (via the initial show-SetWindowPos) BEFORE returning; only WM_PAINT arrives via
            // the queue. Deliver them here for guest-proc windows — including system controls
            // subclassed by a CBT hook above — so post-Create guest code observes the WM_SIZE
            // side effects in real user32 order (a deferred WM_SIZE lands AFTER the caller's
            // post-Create setup and can wipe its state).
            const guestVisibleProc = windowInfo.visible
                && !!windowInfo.wndProc
                && (!windowInfo.isSystemControl || !!windowInfo.wndProcSubclassed)
                && !isSentinelWndProc(windowInfo.wndProc);

            if (phase < totalCbtHooks + 3) {
                phase = totalCbtHooks + 3;
                if (guestVisibleProc) {
                    windowInfo.createSyncVisibleDelivered = true;
                    try {
                        callbackManager.invokeCallback(
                            windowInfo.wndProc,
                            [windowInfo.handle, WM_SHOWWINDOW, 1, 0],
                            0,
                            completeThunk,
                            false,
                            `${label}:WM_SHOWWINDOW`,
                            frameId
                        );
                        return null;
                    } catch (e) {
                        Logger.warn(LogCategory.USER32, `${label}: WM_SHOWWINDOW invoke failed: ${e}`);
                    }
                }
            }

            if (phase < totalCbtHooks + 4) {
                phase = totalCbtHooks + 4;
                if (guestVisibleProc) {
                    windowInfo.createSyncVisibleDelivered = true;
                    try {
                        callbackManager.invokeCallback(
                            windowInfo.wndProc,
                            [windowInfo.handle, WM_SIZE, SIZE_RESTORED,
                                makeLParam(windowInfo.width, windowInfo.height)],
                            0,
                            completeThunk,
                            false,
                            `${label}:WM_SIZE`,
                            frameId
                        );
                        return null;
                    } catch (e) {
                        Logger.warn(LogCategory.USER32, `${label}: WM_SIZE invoke failed: ${e}`);
                    }
                }
            }

            return finishCreateWindowCallbacks(windowInfo);
        };

        // Kick off: first CBT hook or WM_NCCREATE if no hooks
        if (totalCbtHooks > 0) {
            const first = callbackManager.invokeCallback(
                cbtHooks[0].lpfn,
                [HCBT_CREATEWND, windowInfo.handle, cbtCreateWndPtr],
                0,
                completeThunk,
                false,
                `${label}:CBT_0`,
                frameId
            );
            return { value: windowInfo.handle, suspendedForCallback: true, callbackId: first.callbackId, stackCleanup };
        } else if (hasGuestCreateProc) {
            // No CBT hooks — start directly with WM_NCCREATE (phase = totalCbtHooks = 0)
            phase = totalCbtHooks; // = 0, will match `phase <= totalCbtHooks` in completeThunk
            const first = callbackManager.invokeCallback(
                windowInfo.wndProc,
                [windowInfo.handle, WM_NCCREATE, 0, createStruct],
                0,
                completeThunk,
                false,
                `${label}:WM_NCCREATE`,
                frameId
            );
            // Advance phase so completeThunk enters WM_CREATE next
            phase = totalCbtHooks + 1;
            return { value: windowInfo.handle, suspendedForCallback: true, callbackId: first.callbackId, stackCleanup };
        }

        return windowInfo.handle;
    }

    exports['CreateWindowExA'] = (ctx, mem, args) => {
        const dwExStyle = args[0];
        const lpClassName = args[1];
        const lpWindowName = args[2];
        const dwStyle = args[3];
        const X = args[4];
        const Y = args[5];
        const nWidth = args[6];
        const nHeight = args[7];
        const hWndParent = args[8];
        const hMenu = args[9];
        const hInstance = args[10];
        const lpParam = args[11];

        const className = (lpClassName > 0 && lpClassName < 0x10000) ? lpClassName : Marshaler.readString(mem, lpClassName);
        const windowName = Marshaler.readString(mem, lpWindowName);

        Logger.log(LogCategory.USER32, `CreateWindowExA("${className}", "${windowName}", 0x${dwStyle.toString(16)})`);

        const windowInfo = createInternal(className, windowName, dwStyle, dwExStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam);
        if (!windowInfo) return 0;
        if (windowName && !hWndParent) {
            System.getInstance().notifyWindowTitle(windowName, 'CreateWindowEx');
        }

        return fireCreateWindowCallbacks(ctx, windowInfo, lpParam, hInstance, hMenu, hWndParent, dwStyle, lpWindowName, lpClassName, dwExStyle, 'CreateWindowExA');
    };

    exports['CreateWindowExW'] = (ctx, mem, args) => {
        const dwExStyle = args[0];
        const lpClassName = args[1];
        const lpWindowName = args[2];
        const dwStyle = args[3];
        const X = args[4];
        const Y = args[5];
        const nWidth = args[6];
        const nHeight = args[7];
        const hWndParent = args[8];
        const hMenu = args[9];
        const hInstance = args[10];
        const lpParam = args[11];

        const className = (lpClassName > 0 && lpClassName < 0x10000) ? lpClassName : Marshaler.readWideString(mem, lpClassName);
        const windowName = Marshaler.readWideString(mem, lpWindowName);

        Logger.log(LogCategory.USER32, `CreateWindowExW("${className}", "${windowName}", 0x${dwStyle.toString(16)})`);

        const windowInfo = createInternal(className, windowName, dwStyle, dwExStyle, X, Y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam);
        if (!windowInfo) return 0;
        if (windowName && !hWndParent) {
            System.getInstance().notifyWindowTitle(windowName, 'CreateWindowEx');
        }

        return fireCreateWindowCallbacks(ctx, windowInfo, lpParam, hInstance, hMenu, hWndParent, dwStyle, lpWindowName, lpClassName, dwExStyle, 'CreateWindowExW');
    };

    // DestroyWindow - destroys the specified window
    exports['DestroyWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.log(LogCategory.USER32, `DestroyWindow(0x${hWnd.toString(16)})`);

        const windowInfo = windows.get(hWnd);
        if (!windowInfo) {
            Logger.verbose(LogCategory.USER32, `DestroyWindow: window 0x${hWnd.toString(16)} already destroyed`);
            return 1;
        }
        if (windowInfo.pendingDestroy) {
            // Already torn down once (e.g. parent's child-loop ran, then the guest calls
            // DestroyWindow on the same child) — its WM_DESTROY/WM_NCDESTROY are already
            // queued; don't double-post.
            return 1;
        }

        clearAnimateState(hWnd);

        // Win32: DestroyWindow SYNCHRONOUSLY sends WM_DESTROY, destroys children, then
        // WM_NCDESTROY — MFC's CWnd::OnNcDestroy (on WM_NCDESTROY) detaches the CWnd from
        // afxMapHWND. We must deliver these synchronously (re-entering the guest) BEFORE
        // DestroyWindow returns, so MFC detaches before any later queued message (e.g. an
        // owner-draw button's hover WM_TIMER) is pumped — otherwise a pre-translate
        // (WalkPreTranslateTree → FromHandlePermanent) derefs a not-yet-detached, freed CWnd
        // and crashes. Mark the subtree pending-destroy + invisible + kill its
        // timers up-front (so IsWindow=false, input/paint skip them, no new WM_TIMER posts),
        // then deliver the destroy + owner-activation chain via beginSyncDestroyDelivery,
        // which finalizes each window (removes it from the maps, purging its queued messages)
        // right after that window's WM_NCDESTROY.
        // Mark the subtree invisible BEFORE erasing its overlay pixels. eraseDialogOverlay
        // synchronously repaints the PARENT dialog (invokeOverlayRepairRepaint) to patch the
        // hole its erase just cut — if this window were still `visible=true` at that moment,
        // the parent's recursive repaint (paintWindowSubtreeToOverlay walks all children,
        // visible or not filtered by each child's own flag) would walk right back into this
        // window and repaint it, resurrecting the ghost in the same synchronous call chain.
        // getWindowVisualBounds (what the erase rect is computed from) never reads .visible,
        // so marking invisible first doesn't affect what gets erased — only what gets excluded
        // from the immediately-following parent repair repaint.
        const markSubtree = (h: number): void => {
            const wi = windows.get(h);
            if (!wi || wi.pendingDestroy) return;
            wi.pendingDestroy = true;
            wi.visible = false;
            killWindowTimers(h);
            for (const childHwnd of [...wi.children]) markSubtree(childHwnd);
        };
        markSubtree(hWnd);

        // Erase the dialog's pixels from the GDI overlay BEFORE teardown, while its
        // rect is still known — otherwise a closed dialog lingers as a ghost over the
        // game (the overlay is a persistent screen-space canvas). Only #32770 dialogs
        // paint into the overlay; skip for other windows (no-op rect).
        if (windowInfo.nativeClassName === '#32770') {
            eraseDialogOverlay(hWnd);
            resetControlInteractionState();
        }

        const ownerHwnd = windowInfo.parent ?? 0;
        const stackCleanup = 4;
        const sync = beginSyncDestroyDelivery(
            ctx, mem, hWnd, finalizeDestroy, stackCleanup,
            () => reactivateOwnerIfNeeded(hWnd, ownerHwnd),
        );
        if (sync) {
            return sync;
        }

        // Nothing was delivered to the guest — beginSyncDestroyDelivery already finalized the
        // subtree and ran the owner reactivation. Done.
        return 1; // TRUE
    };

    // Deferred-destroy finalizer: actually remove a window from the maps. Called from
    // DispatchMessageW once WM_NCDESTROY has been delivered to the window's wndProc (so
    // MFC's OnNcDestroy has detached the CWnd). Idempotent. See DestroyWindow above.
    const finalizeDestroy = (hWnd: number): void => {
        const wi = windows.get(hWnd);
        if (!wi) return;
        if (wi.parent) {
            const parent = windows.get(wi.parent);
            if (parent) {
                const idx = parent.children.indexOf(hWnd);
                if (idx >= 0) parent.children.splice(idx, 1);
            }
        }
        windows.delete(hWnd);
        removeWindowPlacement(hWnd);
        removeWindowUpdate(hWnd);
        System.getInstance().windowManager.destroyWindow(hWnd);
        Logger.verbose(LogCategory.USER32, `finalizeDestroy: removed window 0x${hWnd.toString(16)}`);
    };
    registerWindowDestroyFinalizer(finalizeDestroy);

    exports['DefWindowProcA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const Msg = args[1];
        const wParam = args[2];
        const lParam = args[3];

        Logger.verbose(LogCategory.USER32, `DefWindowProcA(0x${hWnd.toString(16)}, ${Msg}, 0x${wParam.toString(16)}, 0x${lParam.toString(16)})`);

        const WM_CLOSE = 0x0010;
        const WM_DESTROY = 0x0002;
        const WM_SETCURSOR = 0x0020;
        const HTCLIENT = 1;

        const win = windows.get(hWnd);
        if (win?.isSystemControl) {
            const result = handleSystemControlMessage(win, Msg, wParam, lParam, mem);
            if (isContentChangingMessage(Msg)) {
                repaintDialogAfterContentChange(win.parent ?? hWnd);
            }
            return result;
        }

        if (Msg === WM_CLOSE) {
            // Default: DestroyWindow(hWnd) which posts WM_DESTROY
            Logger.log(LogCategory.USER32, `DefWindowProcA: WM_CLOSE -> DestroyWindow(0x${hWnd.toString(16)})`);
            exports['DestroyWindow']?.(ctx, mem, [hWnd]);
            return 0;
        }

        if (Msg === WM_DESTROY) {
            // DefWindowProc does NOT call PostQuitMessage — that's the app's responsibility.
            // Only return 0 to indicate "processed".
            return 0;
        }

        if (Msg === WM_SETCURSOR) {
            // Default WM_SETCURSOR: on HTCLIENT install the class cursor (hCursor from
            // RegisterClass). This re-shows the pointer after SetCursor(NULL) — only
            // SetCursor writes currentCursorHandle, so without it NULL sticks forever.
            if ((lParam & 0xFFFF) === HTCLIENT) {
                const classInfo = win?.classId !== undefined
                    ? getWindowClass(win.classId)
                    : (win?.nativeClassName ? getWindowClassByName(win.nativeClassName) : undefined);
                const classCursor = (classInfo?.hCursor ?? 0) >>> 0;
                if (classCursor !== 0) {
                    installCursorAndUpdateHostVisibility(classCursor);
                }
            }
            return 1;
        }

        return 0; // 0 = processed
    };

    exports['DefWindowProcW'] = exports['DefWindowProcA'];
    exports['DefMDIChildProcA'] = exports['DefWindowProcA'];
    exports['DefMDIChildProcW'] = exports['DefWindowProcA'];
    exports['DefFrameProcA'] = (ctx, mem, args) =>
        exports['DefWindowProcA'](ctx, mem, [args[0], args[2], args[3], args[4]]);
    exports['DefFrameProcW'] = exports['DefFrameProcA'];

    exports['ShowWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nCmdShow = args[1];

        Logger.log(LogCategory.USER32, `ShowWindow(0x${hWnd.toString(16)}, ${nCmdShow})`);

        const window = windows.get(hWnd);
        if (window) {
            const wasVisible = window.visible;
            window.visible = nCmdShow !== 0; // SW_HIDE = 0

            // Hiding a dialog: erase its pixels from the persistent overlay (while its
            // rect is still known) so it doesn't linger as a ghost. TS hides the
            // campaign dialog (ShowWindow(hWnd,0)) when opening a sub-dialog.
            if (wasVisible && !window.visible && window.nativeClassName === '#32770') {
                eraseDialogOverlay(hWnd);
            }

            // Sync WS_VISIBLE style flag
            if (window.visible) {
                window.style |= 0x10000000;  // WS_VISIBLE
            } else {
                window.style &= ~0x10000000; // clear WS_VISIBLE
            }

            // Sync visibility to WindowManager + Z-order (shown window comes to front,
            // hidden window drops to back so it no longer wins WindowFromPoint hit-tests).
            const wm = System.getInstance().windowManager;
            const wmWin = wm.getWindow(hWnd);
            if (wmWin) {
                wmWin.visible = window.visible;
                if (window.visible !== wasVisible) wm.onWindowVisibilityChanged(hWnd, window.visible);
            }

            // Generic Win32: the system sends WM_SHOWWINDOW when a window is shown or
            // hidden, with wParam=fShow and lParam=0 (status code 0 = "called via the
            // ShowWindow function"). Only on an actual show-state change — Windows does
            // not send it when the visible state is unchanged. HL's menu loads its
            // background DIB (gfx/shell/splash.bmp) + button strip inside
            // OnShowWindow(bShow=TRUE, nStatus=0); without this the menu paints its
            // owner-draw buttons then wipes them with an empty 640x480 backbuffer (black
            // background). Windows created already-visible get this via
            // postInitialVisibleWindowMessages; this covers the create-hidden +
            // ShowWindow(SW_SHOW) path.
            if (window.visible !== wasVisible) {
                System.getInstance().windowManager.postMessage(hWnd, 0x18 /* WM_SHOWWINDOW */, window.visible ? 1 : 0, 0);
            }

            if (window.visible) {
                // Dialog shown while the DDraw flip chain owns the screen → live
                // overlay that the presenter must composite over every flip.
                noteDialogOverlayCandidate(window);

                // Win32: when a dialog becomes visible the system paints it (DefDlgProc
                // erase + each control class paints itself). Our HLE equivalent is the
                // overlay chrome paint, which creation only does for visible dialogs —
                // so a create-hidden + ShowWindow dialog needs it here. Only #32770
                // (the standard dialog class): non-dialog windows own their pixels via
                // guest WM_PAINT and must not get a default background.
                if (!wasVisible && window.nativeClassName === '#32770') {
                    repaintDialogOverlayIfVisible(hWnd);
                }
                // Resize host canvas for normal top-level windows only.
                // Skip WS_POPUP (dialogs, MCI/message boxes) — they must not shrink the
                // canvas after DDraw SetDisplayMode (small error dialogs).
                // Skip WS_CHILD. DDraw SetDisplayMode owns resolution for fullscreen games.
                const WS_CHILD = 0x40000000;
                const WS_POPUP = 0x80000000;
                if (!(window.style & WS_CHILD) && !(window.style & WS_POPUP)) {
                    const system = System.getInstance();
                    system.requestHostResize(window.width, window.height);
                }

                // Activate the window when shown (most SW_* commands activate)
                // SW_SHOWNOACTIVATE (4) and SW_SHOWNA (8) don't activate
                if (nCmdShow !== 4 && nCmdShow !== 8) {
                    const prevActive = System.getInstance().windowManager.getActiveHwnd();
                    if (prevActive !== hWnd || needsActivationDelivery(hWnd)) {
                        activateTopLevelWindow(hWnd);
                    }
                }

                // Trigger paint for the newly shown window (deferred while WM_CREATE runs).
                if (!window.createInProgress) {
                    System.getInstance().windowManager.postMessage(hWnd, WM_PAINT, 0, 0);
                }

                if (window.guestCustomPaint) {
                    requestGuestDialogPaint(hWnd);
                }
            }

            if (isAnimateControlWindow(window)) {
                onAnimateShowWindow(hWnd, nCmdShow);
            }

            return wasVisible ? 1 : 0; // Return previous visibility state
        }

        return 0;
    };

    exports['UpdateWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `UpdateWindow(0x${hWnd.toString(16)})`);

        if (!hWnd || !hasPendingUpdate(hWnd)) return 1;

        if (isWindowUpdateLocked(hWnd)) return 1;

        const win = windows.get(hWnd);
        if (win && isDialogLikeWindow(win)) {
            repaintDialogOverlayIfVisible(hWnd);
            return 1;
        }

        System.getInstance().windowManager.postMessage(hWnd, WM_PAINT, 0, 0);
        // Plain window hosting system controls: the guest may not paint at all —
        // recomposite the controls regardless.
        if (win && hasSystemControlChildren(win)) {
            repaintDialogAfterContentChange(hWnd);
        }
        System.getInstance().scheduler.wakeMessageWaiters();
        return 1; // TRUE
    };

    exports['SetWindowPos'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const hWndInsertAfter = args[1];
        const x = args[2] | 0;
        const y = args[3] | 0;
        const cx = args[4];
        const cy = args[5];
        const uFlags = args[6];

        Logger.verbose(LogCategory.USER32,
            `SetWindowPos(0x${hWnd.toString(16)}, insertAfter=0x${hWndInsertAfter.toString(16)}, x=${x}, y=${y}, cx=${cx}, cy=${cy}, flags=0x${uFlags.toString(16)})`);

        // Update window position/size if window exists.
        const window = windows.get(hWnd);
        if (window) {
            // SWP_HIDEWINDOW/SWP_SHOWWINDOW: SetWindowPos can toggle visibility same as
            // ShowWindow(SW_HIDE/SW_SHOW). Mirror ShowWindow's hide path exactly (mark
            // invisible THEN erase — see DestroyWindow for why that order matters: erasing
            // while still visible=true lets the erase's own parent-repaint walk back into
            // this window and repaint it right back). Real MFC CDialog::DoModal hides the
            // dialog this way before DestroyWindow; skipping this left window.visible=true
            // forever, so later repaints of THIS (should-be-hidden) window kept firing.
            const SWP_HIDEWINDOW = 0x0080;
            const SWP_SHOWWINDOW = 0x0040;
            if ((uFlags & SWP_HIDEWINDOW) !== 0 && window.visible) {
                window.visible = false;
                window.style &= ~0x10000000; // clear WS_VISIBLE
                if (window.nativeClassName === '#32770') {
                    eraseDialogOverlay(hWnd);
                }
                const wmWinHide = System.getInstance().windowManager.getWindow(hWnd);
                if (wmWinHide) {
                    wmWinHide.visible = false;
                    System.getInstance().windowManager.onWindowVisibilityChanged(hWnd, false);
                }
            } else if ((uFlags & SWP_SHOWWINDOW) !== 0 && !window.visible) {
                window.visible = true;
                window.style |= 0x10000000; // set WS_VISIBLE
                const wmWinShow = System.getInstance().windowManager.getWindow(hWnd);
                if (wmWinShow) {
                    wmWinShow.visible = true;
                    System.getInstance().windowManager.onWindowVisibilityChanged(hWnd, true);
                }
                if (window.nativeClassName === '#32770') {
                    repaintDialogOverlayIfVisible(hWnd);
                }
            }

            // Z-order: honor hWndInsertAfter unless SWP_NOZORDER (0x0004).
            const SWP_NOZORDER = 0x0004;
            if ((uFlags & SWP_NOZORDER) === 0) {
                const WS_CHILD = 0x40000000;
                if ((window.style & WS_CHILD) !== 0) {
                    reorderChildInParent(hWnd, hWndInsertAfter | 0);
                } else {
                    System.getInstance().windowManager.setWindowZOrder(hWnd, hWndInsertAfter | 0);
                }
            }
            const geom = applyWindowPosGeometry(hWnd, x, y, cx, cy, uFlags, { skipDialogOverlayRepaint: true });
            Logger.verbose(LogCategory.USER32,
                `SetWindowPos result: win.x=${window.x} win.y=${window.y} win.w=${window.width} win.h=${window.height}`);

            if (geom) {
                const stackCleanup = 7 * 4;
                const sync = trySuspendForSyncGeometryNotify(
                    ctx, hWnd, geom.moved, geom.resized, uFlags, 'SetWindowPos', stackCleanup);
                if (sync.suspended) {
                    return {
                        value: 1,
                        suspendedForCallback: true,
                        callbackId: sync.callbackId,
                        stackCleanup,
                        skipStackCheck: true,
                    };
                }
                finishWindowPosRepaint(hWnd);
            }
        }

        return 1; // TRUE
    };

    exports['MoveWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const X = args[1] | 0;      // signed int
        const Y = args[2] | 0;      // signed int
        const nWidth = args[3];
        const nHeight = args[4];
        const bRepaint = args[5];

        Logger.verbose(LogCategory.USER32,
            `MoveWindow(0x${hWnd.toString(16)}, x=${X}, y=${Y}, w=${nWidth}, h=${nHeight}, repaint=${bRepaint})`);

        const window = windows.get(hWnd);
        if (window) {
            const oldX = window.x;
            const oldY = window.y;
            const oldW = window.width;
            const oldH = window.height;
            const moving = X !== oldX || Y !== oldY;
            const resizing = nWidth > 0 && nHeight > 0 && (nWidth !== oldW || nHeight !== oldH);
            const moved = moving || resizing;

            // Erase the dialog's OLD overlay rect before moving/resizing so it doesn't
            // smear its previous position (persistent screen-space overlay canvas).
            if (moved && window.visible && window.nativeClassName === '#32770') {
                eraseDialogOverlay(hWnd);
            }
            window.x = X;
            window.y = Y;
            if (nWidth > 0 && nHeight > 0) {
                window.width = nWidth;
                window.height = nHeight;
            }

            // Sync the new geometry to the WindowManager's WindowObject. The input path
            // (getInputTargetWindow → InputManager) translates screen→client coords against
            // WindowObject.rect; without this sync it keeps the window's CREATION rect, so a
            // repositioned window (e.g. HL's difficulty dialog, created centered then
            // MoveWindow'd to (0,0,640,480)) gets the wrong client coords → mouse lParam is
            // offset/clamped → owner-draw hit-tests miss every control. Mirrors ShowWindow's
            // visibility sync.
            const wmWin = System.getInstance().windowManager.getWindow(hWnd);
            if (wmWin) {
                wmWin.rect.x = X;
                wmWin.rect.y = Y;
                if (nWidth > 0 && nHeight > 0) {
                    wmWin.rect.w = nWidth;
                    wmWin.rect.h = nHeight;
                }
            }

            // If bRepaint is TRUE, invalidate and post WM_PAINT
            if (bRepaint && window.visible) {
                invalidateWindow(hWnd, null, true);
                System.getInstance().windowManager.postMessage(hWnd, WM_PAINT, 0, 0);
            }

            repaintParentDialogIfSystemControlGeometryChanged(window, moving, resizing);

            // Win32 repaints a moved/resized window; repaint dialog chrome at the
            // new geometry (the overlay still holds it at the old position).
            if (window.visible && window.nativeClassName === '#32770') {
                repaintDialogOverlayIfVisible(hWnd);
            }
        }

        return 1; // TRUE
    };

    exports['ShowCursor'] = (ctx, mem, args) => {
        const bShow = args[0] !== 0;
        const prevCount = getCursorDisplayCount();
        const nextCount = updateCursorDisplayCount(bShow ? 1 : -1);
        syncHostCursorToGuestState();
        Logger.verbose(LogCategory.USER32, `ShowCursor(${bShow ? 1 : 0}) -> ${nextCount} (prev=${prevCount}), visible=${isGuestCursorVisible()}`);
        return nextCount;
    };

    // BOOL OpenIcon(HWND hWnd) — restores a minimized window
    // We never minimize, so just return TRUE (success)
    exports['OpenIcon'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `OpenIcon(0x${args[0].toString(16)}) -> stub`);
        return 1;
    };

    // BOOL CloseWindow(HWND hWnd) — minimizes the specified window (does NOT destroy it)
    // We don't support minimizing in emulator, return TRUE
    exports['CloseWindow'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `CloseWindow(0x${args[0].toString(16)}) -> stub (no-op)`);
        return 1;
    };

    exports['InvalidateRect'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpRect = args[1];
        const bErase = args[2];

        Logger.verbose(LogCategory.USER32, `InvalidateRect(0x${hWnd.toString(16)}, ${lpRect ? 'rect' : 'NULL'}, ${bErase})`);

        if (!hWnd) return 1;

        const rect = lpRect ? readClientRectFromMem(mem, lpRect) : null;
        invalidateWindow(hWnd, rect, bErase !== 0);

        if (isWindowUpdateLocked(hWnd)) return 1;

        const win = windows.get(hWnd);
        if (win?.isSystemControl && win.parent) {
            invalidateControlColors(hWnd); // next EndPaint chain re-queries WM_CTLCOLOR*
            repaintDialogAfterContentChange(win.parent);
        } else if (win && isDialogLikeWindow(win)) {
            repaintDialogOverlayIfVisible(hWnd);
        } else if (win) {
            System.getInstance().windowManager.postMessage(hWnd, WM_PAINT, 0, 0);
            if (hasSystemControlChildren(win)) {
                repaintDialogAfterContentChange(hWnd);
            }
        }
        // Win32: InvalidateRect marks invalid; WM_PAINT delivered on pump / UpdateWindow.

        return 1; // TRUE
    };

    exports['GetDC'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const gdi = System.getInstance().gdiContext;
        const hdc = createWindowClientDC(gdi, hWnd);
        Logger.verbose(LogCategory.USER32, `GetDC(0x${hWnd.toString(16)}) -> 0x${hdc.toString(16)}`);
        return hdc;
    };

    exports['GetWindowDC'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const gdi = System.getInstance().gdiContext;
        const hdc = createWindowClientDC(gdi, hWnd);
        Logger.log(LogCategory.USER32, `GetWindowDC(0x${hWnd.toString(16)}) -> 0x${hdc.toString(16)}`);
        return hdc;
    };

    exports['ReleaseDC'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const hDC = args[1];
        Logger.verbose(LogCategory.USER32, `ReleaseDC(0x${hWnd.toString(16)}, 0x${hDC.toString(16)})`);
        const gdi = System.getInstance().gdiContext;
        if (gdi.flushWindowMemoryDCToOverlay(hDC)) {
            markGuestCustomPaint(hWnd);
            const win = getWindowByHandle(hWnd);
            // OS-owned controls (statics/edits) repaint on top of the guest's flush —
            // owner-draw buttons early-out inside repaintChildControls.
            if (win && win.children.length) {
                repaintChildControls(hWnd);
            }
        }
        gdi.releaseDC(hDC);
        return 1;
    };

    exports['BeginPaint'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpPaint = args[1];

        Logger.verbose(LogCategory.USER32, `BeginPaint(0x${hWnd.toString(16)}, 0x${lpPaint.toString(16)})`);

        const gdi = System.getInstance().gdiContext;
        const window = getWindowByHandle(hWnd);
        const hdc = createWindowClientDC(gdi, hWnd);

        const updateBounds = window
            ? (getWindowUpdateBounds(hWnd) ?? { left: 0, top: 0, right: window.width, bottom: window.height })
            : null;
        const fErase = consumeNeedsErase(hWnd);
        clearWindowUpdate(hWnd);

        if (updateBounds && hdc) {
            const paintCtx = gdi.getDC(hdc);
            if (paintCtx) {
                paintCtx.save();
                paintCtx.beginPath();
                paintCtx.rect(
                    updateBounds.left,
                    updateBounds.top,
                    updateBounds.right - updateBounds.left,
                    updateBounds.bottom - updateBounds.top,
                );
                paintCtx.clip();
            }
        }

        if (PAINT_TRACE_ENABLED) logBeginEndPaint('BeginPaint', hWnd,
            `lpPaint=0x${lpPaint.toString(16)} hdc=0x${hdc.toString(16)} ` +
            `${window?.width ?? 0}x${window?.height ?? 0}`);

        if (lpPaint && window && updateBounds) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpPaint, hdc, true); // hdc
            view.setUint32(lpPaint + 4, fErase ? 1 : 0, true); // fErase
            view.setInt32(lpPaint + 8, updateBounds.left, true);
            view.setInt32(lpPaint + 12, updateBounds.top, true);
            view.setInt32(lpPaint + 16, updateBounds.right, true);
            view.setInt32(lpPaint + 20, updateBounds.bottom, true);
        }

        return hdc;
    };

    exports['EndPaint'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpPaint = args[1];

        Logger.verbose(LogCategory.USER32, `EndPaint(0x${hWnd.toString(16)}, 0x${lpPaint.toString(16)})`);

        const gdi = System.getInstance().gdiContext;
        if (lpPaint) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const hdc = view.getUint32(lpPaint, true);
            const flushed = gdi.flushWindowMemoryDCToOverlay(hdc);
            if (PAINT_TRACE_ENABLED) logBeginEndPaint('EndPaint', hWnd,
                `lpPaint=0x${lpPaint.toString(16)} hdc=0x${hdc.toString(16)} flush=${flushed ? 1 : 0}`);
            if (flushed) {
                markGuestCustomPaint(hWnd);
                const win = getWindowByHandle(hWnd);
                // OS-owned controls (statics/edits) paint on top of the guest's flushed
                // background; owner-draw buttons early-out and are drawn by the chain below.
                if (win && win.children.length) {
                    repaintChildControls(hWnd);
                }
            }
            gdi.releaseDC(hdc);

            // Owner-draw buttons paint on TOP of the now-flushed background. Each child
            // gets its own client DC (positioned + seeded from the overlay); the guest
            // blits its tile in via WM_DRAWITEM, then we composite each onto the overlay.
            const odWin = getWindowByHandle(hWnd);
            if (odWin) {
                try {
                    const ownerDraw = tryEndPaintOwnerDrawChain(ctx, mem, hWnd, odWin, {
                        createChildDC: (childHwnd) => createWindowClientDC(gdi, childHwnd),
                        flushChildDC: (childDc) => {
                            gdi.flushWindowMemoryDCToOverlay(childDc);
                            gdi.releaseDC(childDc);
                        },
                    });
                    if (ownerDraw) return ownerDraw;
                } catch (err) {
                    Logger.error(LogCategory.USER32,
                        `EndPaint owner-draw chain failed for hwnd=0x${hWnd.toString(16)}: ${err}`);
                }
            }
        }

        return 1;
    };

    exports['CallWindowProcA'] = (ctx, mem, args) => {
        const lpPrevWndFunc = args[0] >>> 0;
        const hWnd = args[1] >>> 0;
        const Msg = args[2] >>> 0;
        const wParam = args[3] >>> 0;
        const lParam = args[4] >>> 0;

        Logger.log(LogCategory.USER32,
            `CallWindowProcA(prev=0x${lpPrevWndFunc.toString(16)}, hwnd=0x${hWnd.toString(16)}, msg=0x${Msg.toString(16)})`);

        // Sentinel WndProc: system control (Button/Static/Edit etc.) — handle in JS, don't call x86
        if ((lpPrevWndFunc & 0xFFFF0000) === 0xFFFF0000) {
            Logger.verbose(LogCategory.USER32,
                `CallWindowProcA: sentinel WndProc 0x${lpPrevWndFunc.toString(16)}, returning 0`);
            return { value: 0, stackCleanup: 5 * 4 };
        }

        const system = System.getInstance();
        const callbackManager = system.process?.dispatcher?.callbackManager;
        if (!callbackManager || lpPrevWndFunc === 0) return 0;

        const stackCleanup = 5 * 4;
        callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, 'CallWindowProcA');

        const first = callbackManager.invokeCallback(
            lpPrevWndFunc,
            [hWnd, Msg, wParam, lParam],
            0,
            (wndRet: number): number | null => {
                if (Msg === WM_SIZE && getWindowByHandle(hWnd)?.guestCustomPaint) {
                    requestGuestDialogPaint(hWnd);
                }
                return wndRet >>> 0;
            },
        );

        return { value: 0, suspendedForCallback: true, callbackId: first.callbackId, stackCleanup };
    };

    exports['CallWindowProcW'] = exports['CallWindowProcA'];

    // RegisterHotKey / UnregisterHotKey - stubs (no hotkey support needed)
    exports['RegisterHotKey'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `RegisterHotKey(0x${args[0].toString(16)}, ${args[1]}, 0x${args[2].toString(16)}, 0x${args[3].toString(16)})`);
        return 1; // TRUE = success
    };
    exports['UnregisterHotKey'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `UnregisterHotKey(0x${args[0].toString(16)}, ${args[1]})`);
        return 1; // TRUE = success
    };

    // CallWindowProcA/W — duplicate stub removed; proper callback implementation is above (line ~1005)

    // Focus / Active window management
    const WS_POPUP = 0x80000000;

    function recordLastActivePopup(hWnd: number): void {
        const wnd = windows.get(hWnd);
        if (!wnd) return;
        if ((wnd.style >>> 0) & WS_POPUP) {
            const ownerHwnd = wnd.parent;
            if (ownerHwnd) {
                const owner = windows.get(ownerHwnd);
                if (owner) owner.lastActivePopupHwnd = hWnd;
            }
        }
    }

    exports['SetActiveWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.log(LogCategory.USER32, `SetActiveWindow(0x${hWnd.toString(16)})`);
        const prevActive = activateTopLevelWindow(hWnd);
        recordLastActivePopup(hWnd);
        return prevActive;
    };

    exports['GetActiveWindow'] = (ctx, mem, args) => {
        const hwnd = System.getInstance().windowManager.getActiveHwnd();
        Logger.verbose(LogCategory.USER32, `GetActiveWindow() -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    exports['SetForegroundWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.log(LogCategory.USER32, `SetForegroundWindow(0x${hWnd.toString(16)})`);
        const { topLevel, focusHwnd } = resolveForegroundTargets(hWnd);
        const wm = System.getInstance().windowManager;
        if (topLevel && wm.getActiveHwnd() === topLevel && needsActivationDelivery(focusHwnd)) {
            markPendingActivation(focusHwnd);
        }
        setForegroundWithFocus(topLevel, focusHwnd);
        return 1; // TRUE
    };

    exports['GetForegroundWindow'] = (ctx, mem, args) => {
        const hwnd = System.getInstance().windowManager.getForegroundHwnd();
        Logger.verbose(LogCategory.USER32, `GetForegroundWindow() -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    // GetDesktopWindow: UT99 WinDrv uses this; returning 0x1 pseudo-handle may confuse
    // games that pass the result to other APIs expecting a real window handle.
    // Revert to returning the active window (fallback to 0x10000 shell desktop).
    exports['GetDesktopWindow'] = () => {
        return System.getInstance().windowManager.getActiveHwnd() || DESKTOP_HWND;
    };

    exports['SetFocus'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.log(LogCategory.USER32, `SetFocus(0x${hWnd.toString(16)})`);
        // Faithful Win32: SetFocus sets the focus window (a CHILD is allowed) and sends
        // WM_KILLFOCUS/WM_SETFOCUS — it does NOT change the active/foreground window.
        const wm = System.getInstance().windowManager;
        const prevFocus = wm.setFocus(hWnd);
        recordLastActivePopup(hWnd);
        return prevFocus;
    };

    exports['GetFocus'] = (ctx, mem, args) => {
        const hwnd = System.getInstance().windowManager.getFocusHwnd();
        Logger.verbose(LogCategory.USER32, `GetFocus() -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    // GetLastActivePopup — returns the most recently active owned popup of hWnd,
    // or hWnd itself if no owned popup was ever activated.
    exports['GetLastActivePopup'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const wnd = windows.get(hWnd);
        if (!wnd) {
            Logger.warn(LogCategory.USER32, `GetLastActivePopup(0x${hWnd.toString(16)}): unknown hwnd`);
            return hWnd;
        }
        // If a tracked popup is still alive, return it; otherwise fall back to hWnd.
        const popup = wnd.lastActivePopupHwnd;
        const result = (popup && windows.has(popup)) ? popup : hWnd;
        Logger.verbose(LogCategory.USER32, `GetLastActivePopup(0x${hWnd.toString(16)}) -> 0x${result.toString(16)}`);
        return result;
    };

    exports['BringWindowToTop'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `BringWindowToTop(0x${hWnd.toString(16)})`);
        System.getInstance().windowManager.bringWindowToTop(hWnd);
        return 1; // TRUE
    };

    exports['LockWindowUpdate'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `LockWindowUpdate(0x${hWnd.toString(16)})`);
        setLockWindowUpdate(hWnd);
        return 1; // TRUE
    };

    exports['SetScrollPos'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nBar = args[1];
        const nPos = args[2];
        const bRedraw = args[3];
        Logger.verbose(LogCategory.USER32, `SetScrollPos(0x${hWnd.toString(16)}, ${nBar}, ${nPos}, ${bRedraw})`);
        return setScrollBarPos(hWnd, nBar, nPos);
    };

    // int SetScrollInfo(HWND hwnd, int nBar, LPCSCROLLINFO lpsi, BOOL redraw)
    exports['SetScrollInfo'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const nBar = args[1] | 0;
        const lpsi = args[2] >>> 0;
        const redraw = args[3] >>> 0;
        const prevPos = applyScrollInfo(mem, hWnd, nBar, lpsi);
        Logger.verbose(LogCategory.USER32,
            `SetScrollInfo(0x${hWnd.toString(16)}, bar=${nBar}, prev=${prevPos}, redraw=${redraw})`);
        if (redraw) {
            invalidateWindow(hWnd, null, false);
        }
        return prevPos;
    };

    exports['BeginDeferWindowPos'] = (ctx, mem, args) => {
        const nNumWindows = args[0];
        const handle = nextDeferWindowPosHandle++;
        deferWindowPosBatches.set(handle, []);
        Logger.verbose(LogCategory.USER32, `BeginDeferWindowPos(${nNumWindows}) -> 0x${handle.toString(16)}`);
        return handle;
    };

    exports['DeferWindowPos'] = (ctx, mem, args) => {
        const hWinPosInfo = args[0];
        const hWnd = args[1];
        const hWndInsertAfter = args[2];
        const x = args[3] | 0;
        const y = args[4] | 0;
        const cx = args[5];
        const cy = args[6];
        const uFlags = args[7];

        const batch = deferWindowPosBatches.get(hWinPosInfo);
        if (!batch) {
            Logger.warn(LogCategory.USER32, `DeferWindowPos: invalid hdwp=0x${hWinPosInfo.toString(16)}`);
            return 0;
        }
        batch.push({ hWnd, hWndInsertAfter, x, y, cx, cy, uFlags });

        Logger.verbose(LogCategory.USER32,
            `DeferWindowPos(0x${hWinPosInfo.toString(16)}, 0x${hWnd.toString(16)}, ...)`);
        return hWinPosInfo;
    };

    exports['EndDeferWindowPos'] = (ctx, mem, args) => {
        const hWinPosInfo = args[0];
        const batch = deferWindowPosBatches.get(hWinPosInfo);
        if (!batch) {
            Logger.warn(LogCategory.USER32, `EndDeferWindowPos: invalid hdwp=0x${hWinPosInfo.toString(16)}`);
            return 0;
        }
        deferWindowPosBatches.delete(hWinPosInfo);

        const dialogsToRepaint = new Set<number>();
        for (const entry of batch) {
            applyWindowPosGeometry(
                entry.hWnd, entry.x, entry.y, entry.cx, entry.cy, entry.uFlags,
                { skipDialogOverlayRepaint: true },
            );
            const win = windows.get(entry.hWnd);
            if (win?.visible && win.nativeClassName === '#32770') {
                dialogsToRepaint.add(entry.hWnd);
            }
            if (win?.isSystemControl && win.parent) {
                dialogsToRepaint.add(win.parent);
            }
        }
        for (const hwnd of dialogsToRepaint) {
            repaintDialogOverlayIfVisible(hwnd);
        }

        Logger.verbose(LogCategory.USER32, `EndDeferWindowPos(0x${hWinPosInfo.toString(16)}) -> TRUE`);
        return 1;
    };

    exports['ValidateRect'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpRect = args[1];
        Logger.verbose(LogCategory.USER32, `ValidateRect(0x${hWnd.toString(16)}, 0x${lpRect.toString(16)})`);
        if (!hWnd) return 0;
        const rect = lpRect ? readClientRectFromMem(mem, lpRect) : null;
        validateWindow(hWnd, rect);
        return 1; // TRUE
    };

    exports['GetUpdateRect'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const lpRect = args[1] >>> 0;
        const bErase = args[2] >>> 0;
        Logger.verbose(
            LogCategory.USER32,
            `GetUpdateRect(0x${hWnd.toString(16)}, 0x${lpRect.toString(16)}, ${bErase})`
        );

        const bounds = getWindowUpdateBounds(hWnd);
        if (!bounds) return 0; // FALSE

        if (lpRect) {
            writeClientRectToMem(mem, lpRect, bounds);
        }
        // Win32: bErase=TRUE erases the background within the update region.
        if (bErase) {
            const win = windows.get(hWnd);
            if (win && isDialogLikeWindow(win)) {
                repaintDialogOverlayIfVisible(hWnd);
            }
        }
        return 1; // TRUE
    };

    exports['ShowOwnedPopups'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const fShow = args[1];
        Logger.verbose(LogCategory.USER32, `ShowOwnedPopups(0x${hWnd.toString(16)}, ${fShow})`);
        return 1; // TRUE
    };

    exports['RedrawWindow'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const flags = args[3] >>> 0;

        const RDW_INVALIDATE = 0x0001;
        const RDW_ERASE = 0x0004;
        const RDW_ALLCHILDREN = 0x0080;
        const RDW_UPDATENOW = 0x0100;

        Logger.log(LogCategory.USER32,
            `RedrawWindow(0x${hWnd.toString(16)} flags=0x${flags.toString(16)})`);

        // HL launcher (FUN_00425310): RedrawWindow(hwnd, NULL, NULL, 0x180) after btns_main.bmp load.
        const needsPaint = (flags & (RDW_INVALIDATE | RDW_ERASE | RDW_UPDATENOW)) !== 0;
        if (!needsPaint) return 1;

        const system = System.getInstance();
        let queuedPaints = 0;
        const queuePaint = (hwnd: number) => {
            const win = windows.get(hwnd);
            if (!win?.visible) return;
            if (win.guestCustomPaint) {
                requestGuestDialogPaint(hwnd);
            } else {
                system.windowManager.postMessage(hwnd, WM_PAINT, 0, 0);
            }
            queuedPaints++;
        };

        const win = windows.get(hWnd);

        // Owner-draw button self-repaint (e.g. a hover-glow timer calling
        // RedrawWindow(button, NULL, NULL, RDW_INVALIDATE|RDW_UPDATENOW)). Our owner-draw
        // buttons are painted by the PARENT's WM_DRAWITEM, not the button's own WM_PAINT,
        // so posting WM_PAINT to the button (the default path below) would not redraw the
        // tile. Re-run just this button's WM_DRAWITEM into a seeded child DC instead. The
        // guest computes any glow blend from the button object's own timing state.
        const BS_TYPEMASK = 0x000F;
        const BS_OWNERDRAW = 0x000B;
        const isOwnerDrawButton = !!win && !!win.isSystemControl
            && (win.style & BS_TYPEMASK) === BS_OWNERDRAW;
        if (isOwnerDrawButton && (flags & RDW_INVALIDATE) !== 0) {
            try {
                const gdi = system.gdiContext;
                const stackCleanup = 4 * 4; // RedrawWindow(hWnd, lpRect, hrgn, flags)
                const repaint = tryRepaintOwnerDrawButton(ctx, mem, win!, {
                    createChildDC: (childHwnd) => createWindowClientDC(gdi, childHwnd),
                    flushChildDC: (childDc) => {
                        gdi.flushWindowMemoryDCToOverlay(childDc);
                        gdi.releaseDC(childDc);
                    },
                }, 'RedrawWindow', stackCleanup);
                if (repaint) {
                    system.scheduler.wakeMessageWaiters();
                    return repaint;
                }
            } catch (err) {
                Logger.error(LogCategory.USER32,
                    `RedrawWindow owner-draw repaint failed hwnd=0x${hWnd.toString(16)}: ${err}`);
            }
            // Owner-draw button repaint was skipped (occluded by an active modal dialog, or
            // not paintable) — do NOT fall through to post WM_PAINT (it would re-enter and
            // could ghost the button over the dialog on top). Treat as handled.
            return 1;
        }

        const sendPaintNow = (flags & RDW_UPDATENOW) !== 0
            && !!win?.visible
            && !!win.wndProc
            && !win.isSystemControl;

        if (!sendPaintNow) {
            queuePaint(hWnd);
        }
        if (flags & RDW_ALLCHILDREN) {
            if (win) {
                for (const childHwnd of win.children) {
                    queuePaint(childHwnd);
                }
            }
        }

        if (sendPaintNow && win) {
            const clearedPending = system.windowManager.clearPaintMessage(hWnd);
            const hasFreshInvalidate = (flags & (RDW_INVALIDATE | RDW_ERASE)) !== 0;
            const callbackManager = system.process?.dispatcher?.callbackManager;
            if (!clearedPending && !hasFreshInvalidate) {
                Logger.log(LogCategory.USER32,
                    `RedrawWindow: RDW_UPDATENOW no pending paint hwnd=0x${hWnd.toString(16)}`);
            } else if (callbackManager) {
                const stackCleanup = 4 * 4;
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const thunkReturnAddr = view.getUint32(ctx.esp, true);
                const frameId = callbackManager.saveSuspendedThunkContext(
                    { ...ctx, returnAddr: thunkReturnAddr },
                    stackCleanup,
                    'RedrawWindow:WM_PAINT'
                );
                if (frameId !== 0) {
                    const prevActive = system.windowManager.getActiveHwnd();
                    const skipActivationDuringInit = isDialogInitInProgress(hWnd);
                    const activationSteps: ActivationStep[] =
                        !skipActivationDuringInit && needsActivationDelivery(hWnd)
                            ? buildPendingActivationSteps(hWnd, win.wndProc, prevActive)
                            : [];
                    if (skipActivationDuringInit && needsActivationDelivery(hWnd)) {
                        Logger.log(LogCategory.USER32,
                            `RedrawWindow: defer activation (WM_INITDIALOG in progress) hwnd=0x${hWnd.toString(16)}`);
                    }
                    if (activationSteps.length > 0 && prevActive !== hWnd) {
                        system.windowManager.setActiveWindow(hWnd);
                    }

                    let activationStep = 0;
                    const deliverPaint = (wndRet: number): number | null => {
                        Logger.log(LogCategory.USER32,
                            `RedrawWindow: RDW_UPDATENOW WM_PAINT returned 0x${(wndRet >>> 0).toString(16)} ` +
                            `hwnd=0x${hWnd.toString(16)}`);
                        return 1;
                    };
                    const sendPaint = (): ReturnType<typeof callbackManager.invokeCallback> => {
                        Logger.log(LogCategory.USER32,
                            `RedrawWindow: RDW_UPDATENOW sending WM_PAINT hwnd=0x${hWnd.toString(16)} ` +
                            `wndProc=0x${win.wndProc.toString(16)} clearedPending=${clearedPending ? 1 : 0}`);
                        return callbackManager.invokeCallback(
                            win.wndProc,
                            [hWnd, WM_PAINT, 0, 0],
                            0,
                            deliverPaint,
                            false,
                            'RedrawWindow:WM_PAINT',
                            frameId
                        );
                    };
                    const continueActivationChain = (_ret: number): number | null => {
                        if (activationStep < activationSteps.length) {
                            const step = activationSteps[activationStep]!;
                            activationStep++;
                            const wndProc = resolveActivationWndProc(step.hwnd, step.wndProc);
                            Logger.log(LogCategory.USER32,
                                `deliverActivation[during-init]: hwnd=0x${step.hwnd.toString(16)} msg=0x${step.msg.toString(16)} ` +
                                `wParam=0x${step.wParam.toString(16)} lParam=0x${step.lParam.toString(16)} ` +
                                `wndProc=0x${wndProc.toString(16)}`);
                            callbackManager.invokeCallback(
                                wndProc,
                                [step.hwnd, step.msg, step.wParam, step.lParam],
                                0,
                                continueActivationChain,
                                false,
                                'RedrawWindow:activation',
                                frameId
                            );
                            return null;
                        }
                        markActivationDelivered(hWnd);
                        sendPaint();
                        return null;
                    };

                    let first;
                    if (activationSteps.length > 0) {
                        const step = activationSteps[activationStep]!;
                        activationStep++;
                        const wndProc = resolveActivationWndProc(step.hwnd, step.wndProc);
                        Logger.log(LogCategory.USER32,
                            `deliverActivation[during-init]: hwnd=0x${step.hwnd.toString(16)} msg=0x${step.msg.toString(16)} ` +
                            `wParam=0x${step.wParam.toString(16)} lParam=0x${step.lParam.toString(16)} ` +
                            `wndProc=0x${wndProc.toString(16)}`);
                        first = callbackManager.invokeCallback(
                            wndProc,
                            [step.hwnd, step.msg, step.wParam, step.lParam],
                            0,
                            continueActivationChain,
                            false,
                            'RedrawWindow:activation',
                            frameId
                        );
                    } else {
                        first = sendPaint();
                    }
                    if (first.callbackId !== 0) {
                        system.scheduler.wakeMessageWaiters();
                        return {
                            value: 1,
                            suspendedForCallback: true,
                            callbackId: first.callbackId,
                            stackCleanup,
                            skipStackCheck: true,
                        };
                    }
                    Logger.warn(LogCategory.USER32,
                        `RedrawWindow: RDW_UPDATENOW invokeCallback failed hwnd=0x${hWnd.toString(16)}`);
                } else {
                    Logger.warn(LogCategory.USER32,
                        `RedrawWindow: failed to save suspended frame hwnd=0x${hWnd.toString(16)}`);
                }
            }

            if (clearedPending || hasFreshInvalidate) {
                queuePaint(hWnd);
            }
        }

        if ((flags & RDW_UPDATENOW) !== 0) {
            Logger.log(LogCategory.USER32,
                `RedrawWindow: RDW_UPDATENOW queuedPaints=${queuedPaints} hwnd=0x${hWnd.toString(16)}`);
        }
        system.scheduler.wakeMessageWaiters();
        return 1;
    };

    exports['ExcludeUpdateRgn'] = (ctx, mem, args) => {
        const hdc = args[0];
        const hWnd = args[1];
        Logger.verbose(LogCategory.USER32, `ExcludeUpdateRgn(0x${hdc.toString(16)}, 0x${hWnd.toString(16)})`);
        return 1; // SIMPLEREGION
    };

    registerWindowQueryExports(exports);
    registerWindowPropExports(exports);
    registerWindowGeometryExports(exports, { repaintParentDialogIfSystemControlGeometryChanged });
    registerWindowDrawingExports(exports);


    return exports;
}
