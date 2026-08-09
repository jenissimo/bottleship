/**
 * User32 Window functions
 *
 * Atomic implementation for window operations
 */

import { FastPathImplementation, ThunkImplementation, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { DESKTOP_HWND } from '../../runtime/windowing/window-manager';
import { getWindowClass, getWindowClassByName } from './class';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { WindowInfo, windows, getWindowByHandle, getCursorDisplayCount, updateCursorDisplayCount, isGuestCursorVisible, syncHostCursorToGuestState, installCursorAndUpdateHostVisibility, getAbsoluteWindowPosition, markGuestCustomPaint, killWindowTimers, registerWindowDestroyFinalizer, reorderChildInParent, isWindowPosZOrderRequestValid, shouldSeedPaintFromParent, tryLockWindowUpdate, isWindowUpdateLocked, hasSystemControlChildren, getChildWindowExclusions, isEffectivelyVisible, getAncestorClipRect } from './shared-state';
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
    type ClientRect,
} from './paint-region';
import { WH_CBT, HCBT_CREATEWND, getHooksOfType } from './hooks';
import { registerWindowDrawingExports, eraseWindowBackgroundWithClassBrush } from './window-drawing';
import { registerWindowGeometryExports, removeWindowPlacement } from './window-geometry';
import { registerWindowQueryExports } from './window-query';
import { registerWindowPropExports } from './window-props';
import { GDIContext } from '../gdi32/context';
import { ensureAnimateControlClasses, clearAnimateState, onAnimateShowWindow, isAnimateControlWindow } from './animate-control';
import { getBuiltinSystemClass, getDefWindowProcAddress } from './system-classes';
import { invalidateControlColors } from './control-colors';
import {
    applyScrollInfo,
    readScrollInfo,
    getScrollRange,
    getScrollPos,
    enableScrollBar,
    showScrollBar,
    setScrollRange,
    setScrollPos as setScrollBarPos,
} from './scroll-state';
import { isSentinelWndProc } from './dialog';
import { handleSystemControlMessage, isContentChangingMessage } from './dialog-control-messages';
import { noteDialogOverlayCandidate, eraseDialogOverlay, isWindowFullyCoveredByHigherTopLevel } from './dialog-overlay';
import { eraseControlOverlayRect, eraseHiddenWindowPixels, repaintDialogOverlayIfVisible, repaintDialogAfterContentChange, requestGuestDialogPaint } from './dialog-paint';
import {
    resetControlInteractionState,
    handleSystemControlClassMouse,
    handleSystemControlKey,
    takePendingControlNotification,
} from './control-interaction';
import { isDDrawExclusiveFullscreen } from '../ddraw/gdi-visibility';
import { paintTraceEnabled, logBeginEndPaint } from './paint-trace';
import { repaintChildControls } from './controls';
import { tryEndPaintOwnerDrawChain, tryRepaintOwnerDrawButton, isGuestPaintedControl } from './owner-draw';
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
const SWP_NOMOVE_GEO = 0x0002;
const SWP_NOSIZE_GEO = 0x0001;

/**
 * Win32 stores CreateWindowEx's hMenu argument as GWLP_ID for every WS_CHILD
 * window. Guest custom controls depend on it just as built-in controls do.
 */
export function controlIdFromCreateWindow(style: number, hMenu: number): number | undefined {
    return (style & 0x40000000) !== 0 ? hMenu >>> 0 : undefined;
}

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
    if (!win || !isEffectivelyVisible(win) || !hasPendingUpdate(hWnd)) return;
    if (win.guestCustomPaint) {
        requestGuestDialogPaint(hWnd);
        return;
    }
    if (win.nativeClassName === '#32770' || win.isSystemControl || hasSystemControlChildren(win)) {
        repaintDialogOverlayIfVisible(win.isSystemControl && win.parent ? win.parent : hWnd);
        return;
    }
    System.getInstance().windowManager.postMessage(hWnd, WM_PAINT_GEO, 0, 0);
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
    existingDirectReturn?: { returnAddr: number; postEsp: number },
): {
    suspended: true;
    callbackId: number;
    frameId: number;
    reusedFrame: boolean;
    directThunkReturn?: { returnAddr: number; postEsp: number };
} | { suspended: false } {
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
    let reusedFrame = !!existingFrameId;
    if (!frameId) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const thunkReturnAddr = existingDirectReturn?.returnAddr
            ?? (view.getUint32(ctx.esp, true) >>> 0);
        const stubRange = callbackManager.getStubPoolRange();
        if (existingDirectReturn
            || (thunkReturnAddr >= stubRange.base && thunkReturnAddr < stubRange.end)) {
            // This API thunk itself was called from a guest callback. Complete only
            // this nested thunk and return to its callback stub; consuming the outer
            // suspended frame would abandon the rest of the current WndProc.
            const directThunkReturn = existingDirectReturn ?? {
                returnAddr: thunkReturnAddr,
                postEsp: (ctx.esp + 4 + stackCleanup) >>> 0,
            };
            const nested = callbackManager.invokeCallback(
                wndProc,
                [hWnd, msg, wParam, lParam],
                0,
                undefined,
                false,
                `${label}:sync0x${msg.toString(16)}`,
                undefined,
                {
                    directThunkReturn: {
                        ...directThunkReturn,
                        complete: onComplete,
                    },
                },
            );
            if (!nested.callbackId) return { suspended: false };
            return {
                suspended: true,
                callbackId: nested.callbackId,
                frameId: 0,
                reusedFrame: true,
                directThunkReturn,
            };
        } else {
            frameId = callbackManager.saveSuspendedThunkContext(
                { ...ctx, returnAddr: thunkReturnAddr },
                stackCleanup,
                label,
            );
        }
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
    return { suspended: true, callbackId: first.callbackId, frameId, reusedFrame };
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
    const resizing = !(uFlags & SWP_NOSIZE_GEO)
        && (cx !== window.width || cy !== window.height);

    if (window.isSystemControl && resizing) {
        Logger.log(LogCategory.USER32,
            `SetWindowPos: system control 0x${hWnd.toString(16)} id=${window.controlId ?? '?'} ` +
            `→ ${cx}x${cy} (was ${window.width}x${window.height})`);
    }

    if ((moving || resizing) && !(uFlags & 0x0008 /* SWP_NOREDRAW */)
        && isEffectivelyVisible(window)) {
        eraseHiddenWindowPixels(window);
    }
    if (!(uFlags & SWP_NOMOVE_GEO)) {
        window.x = x;
        window.y = y;
    }
    if (!(uFlags & SWP_NOSIZE_GEO)) {
        window.width = cx;
        window.height = cy;
    }

    const wmWin = System.getInstance().windowManager.getWindow(hWnd);
    if (wmWin) {
        if (!(uFlags & SWP_NOMOVE_GEO)) {
            wmWin.rect.x = window.x;
            wmWin.rect.y = window.y;
        }
        if (!(uFlags & SWP_NOSIZE_GEO)) {
            wmWin.rect.w = window.width;
            wmWin.rect.h = window.height;
        }
    }

    if (!(uFlags & 0x0008 /* SWP_NOREDRAW */)) {
        repaintParentDialogIfSystemControlGeometryChanged(window, moving, resizing);
    }

    if (!options?.skipDialogOverlayRepaint && !(uFlags & 0x0008 /* SWP_NOREDRAW */)
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

/** Seed `hdc` from the nearest ancestor that has a retained client image covering it. */
function restoreSeedFromAncestors(gdi: GDIContext, hdc: number, window: WindowInfo): boolean {
    for (let anc = window.parent !== undefined ? windows.get(window.parent) : undefined; anc;
         anc = anc.parent !== undefined ? windows.get(anc.parent) : undefined) {
        if (gdi.seedMemoryDCFromClientBacking?.(hdc, anc.handle)) return true;
    }
    return false;
}

/**
 * Publish a window DC's guest pixels to the overlay: punch child windows out of the
 * blit, retain the guest's client for ShowWindow(SW_HIDE) restore, and skip the
 * composite when the window is not effectively visible. Shared by ReleaseDC and the
 * held-DC flush so both apply one policy (EndPaint has its own, publish-bracketed copy).
 */
function publishWindowDC(hWnd: number, hDC: number): boolean {
    const gdi = System.getInstance().gdiContext;
    const win = getWindowByHandle(hWnd);
    // No repaintedAfterFlush here: this path restamps only the OS-owned controls, so a
    // guest-owned child's pixels would be destroyed with nothing to bring them back —
    // every child stays punched out regardless of WS_CLIPCHILDREN.
    const exclusions = hWnd ? getChildWindowExclusions(hWnd) : [];
    const flushed = win && (!isEffectivelyVisible(win)
        || isWindowFullyCoveredByHigherTopLevel(win))
        ? false
        : gdi.flushWindowMemoryDCToOverlay(
            hDC,
            exclusions,
            hWnd && !win?.isSystemControl ? hWnd : undefined,
            win ? getAncestorClipRect(win) : null);
    if (flushed) {
        markGuestCustomPaint(hWnd);
        // OS-owned controls (statics/edits) repaint on top of the guest's flush —
        // owner-draw buttons early-out inside repaintChildControls.
        if (win && win.children.length) {
            repaintChildControls(hWnd);
        }
    }
    return flushed;
}

/**
 * Publish every window DC the guest has drawn on and still holds. Real GDI writes
 * through a window DC straight to the screen; ours buffers into the DC's canvas and
 * publishes on release, so a renderer that does GetDC once and BitBlts every frame
 * (the standard Win32 software-renderer shape) would never reach the screen at all.
 * Called once per composite so a frame's worth of GDI calls coalesces into one blit.
 */
export function flushHeldWindowDCs(): void {
    const gdi = System.getInstance().gdiContext;
    const held = gdi.heldDirtyWindowDCs();
    for (const { hdc, hwnd } of held) {
        if (hwnd && isWindowUpdateLocked(hwnd)) {
            gdi.clearDirty(hdc);
            continue;
        }
        publishWindowDC(hwnd, hdc);
    }
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
        gdi.setDCWindow(hdc, hWnd);
        if (!shouldSuppressWindowOverlay(hWnd, window)) {
            gdi.attachWindowBlit(hdc, x, y, window.width, window.height);
            // Prefer retained client backing over the flat overlay. The overlay already
            // holds stamped children / prior captions; seeding from it makes the next
            // GetDC→BitBlt "background snapshot" (menu slide transitions) permanently
            // accumulate every page that was ever shown. Own backing first, then an
            // ancestor's, then overlay only when nothing was retained yet.
            const seeded = shouldSeedPaintFromParent(window)
                ? (restoreSeedFromAncestors(gdi, hdc, window)
                    || !!gdi.seedMemoryDCFromClientBacking?.(hdc, window.handle))
                : (!!gdi.seedMemoryDCFromClientBacking?.(hdc, window.handle)
                    || restoreSeedFromAncestors(gdi, hdc, window));
            if (!seeded) {
                gdi.seedMemoryDCFromOverlay(hdc);
            }

            // A RECT/FRAME STATIC and the child page it hosts form one retained page
            // surface. USER clips an oversized page to the host; normalize that clipped
            // raster edge from adjacent page pixels so a stale placeholder/background
            // edge cannot survive the next flush on either level.
            const type = window.style & 0x001f;
            const parent = window.parent !== undefined ? windows.get(window.parent) : undefined;
            const parentType = (parent?.style ?? 0) & 0x001f;
            const isStaticHost = window.isSystemControl
                && window.systemControlClass?.toLowerCase() === 'static'
                && type >= 0x0004 && type <= 0x0009 && window.children.length > 0;
            const isHostedPage = parent?.isSystemControl
                && parent.systemControlClass?.toLowerCase() === 'static'
                && parentType >= 0x0004 && parentType <= 0x0009;
            if ((isStaticHost || isHostedPage) && window.width > 6 && window.height > 6) {
                const dcCtx = gdi.getDC(hdc);
                if (dcCtx) {
                    const edge = 3;
                    let clipX = 0;
                    let clipY = 0;
                    let clipW = window.width;
                    let clipH = window.height;
                    if (isHostedPage) {
                        const clip = getAncestorClipRect(window);
                        if (clip) {
                            clipX = Math.max(0, Math.floor(clip.x - x));
                            clipY = Math.max(0, Math.floor(clip.y - y));
                            clipW = Math.min(window.width - clipX, Math.ceil(clip.w));
                            clipH = Math.min(window.height - clipY, Math.ceil(clip.h));
                        }
                    }
                    const snapshot = new OffscreenCanvas(window.width, window.height);
                    const snapshotCtx = snapshot.getContext('2d');
                    if (snapshotCtx && clipW > edge * 2 && clipH > edge * 2) {
                        snapshotCtx.drawImage(dcCtx.canvas, 0, 0);
                        dcCtx.imageSmoothingEnabled = false;
                        dcCtx.drawImage(snapshot, clipX + edge, clipY + edge, clipW - edge * 2, 1,
                            clipX + edge, clipY, clipW - edge * 2, edge);
                        dcCtx.drawImage(snapshot, clipX + edge, clipY + clipH - edge - 1, clipW - edge * 2, 1,
                            clipX + edge, clipY + clipH - edge, clipW - edge * 2, edge);
                        dcCtx.drawImage(snapshot, clipX + edge, clipY + edge, 1, clipH - edge * 2,
                            clipX, clipY + edge, edge, clipH - edge * 2);
                        dcCtx.drawImage(snapshot, clipX + clipW - edge - 1, clipY + edge, 1, clipH - edge * 2,
                            clipX + clipW - edge, clipY + edge, edge, clipH - edge * 2);
                        dcCtx.drawImage(snapshot, clipX + edge, clipY + edge, 1, 1,
                            clipX, clipY, edge, edge);
                        dcCtx.drawImage(snapshot, clipX + clipW - edge - 1, clipY + edge, 1, 1,
                            clipX + clipW - edge, clipY, edge, edge);
                        dcCtx.drawImage(snapshot, clipX + edge, clipY + clipH - edge - 1, 1, 1,
                            clipX, clipY + clipH - edge, edge, edge);
                        dcCtx.drawImage(snapshot, clipX + clipW - edge - 1, clipY + clipH - edge - 1, 1, 1,
                            clipX + clipW - edge, clipY + clipH - edge, edge, edge);
                    }
                }
            }
        } else {
            Logger.verbose(LogCategory.USER32,
                `createWindowClientDC: suppress overlay for exclusive DDraw hwnd=0x${hWnd.toString(16)}`);
        }
    }
    return hdc;
}

const WM_ERASEBKGND_PAINT = 0x0014;

/**
 * The area USER is erasing for a window, published while its WM_ERASEBKGND is in flight.
 * Win32 hands the erase a DC clipped to the update region; the class-brush fill must
 * respect that or an InvalidateRect of one control's rect repaints the whole client.
 */
const pendingEraseRects = new Map<number, ClientRect>();

function windowClientRect(window: WindowInfo): ClientRect {
    return { left: 0, top: 0, right: window.width, bottom: window.height };
}

/** WNDCLASS.hbrBackground, still in its raw (possibly COLOR_* + 1) form. */
function getClassBackgroundBrush(window: WindowInfo): number {
    const classInfo = window.classId !== undefined
        ? getWindowClass(window.classId)
        : (window.nativeClassName ? getWindowClassByName(window.nativeClassName) : undefined);
    return (classInfo?.hbrBackground ?? 0) >>> 0;
}

/**
 * DefWindowProc's WM_ERASEBKGND. Returns nonzero when the class brush painted, which is
 * what BeginPaint's fErase contract and every guest that forwards the message expect.
 */
function eraseWindowBackground(hWnd: number, hdc: number): number {
    const window = getWindowByHandle(hWnd);
    if (!window || !hdc) return 0;
    const rect = pendingEraseRects.get(hWnd) ?? windowClientRect(window);
    return eraseWindowBackgroundWithClassBrush(hdc, getClassBackgroundBrush(window), rect) ? 1 : 0;
}

/**
 * Erase for a paint that is starting. The guest sees WM_ERASEBKGND when it has a wndproc —
 * it may answer itself, or forward to DefWindowProc and land back in eraseWindowBackground.
 * With no guest proc, USER's default is all there is, so it runs inline instead of the
 * erase silently not happening. Returns whether the caller must still send the message.
 */
function beginWindowErase(hWnd: number, window: WindowInfo, hdc: number, bounds: ClientRect | null): boolean {
    pendingEraseRects.set(hWnd, bounds ?? windowClientRect(window));
    if (resolveGuestWndProc(window)) return true;
    eraseWindowBackground(hWnd, hdc);
    pendingEraseRects.delete(hWnd);
    return false;
}

/** EndPaint's composite step: put the painted client DC on the overlay, then restamp the
 *  OS-owned controls that sit on top of it. Returns whether the blit actually landed. */
function flushPaintDCToOverlay(hWnd: number, hdc: number): boolean {
    const gdi = System.getInstance().gdiContext;
    // This is the ONE composite path that restamps guest-painted children afterwards
    // (tryEndPaintOwnerDrawChain, below), so it is the one that may let a parent without
    // WS_CLIPCHILDREN paint the ground under them the way GDI does. The chain needs the
    // window's own wndProc to run; without one nothing would repaint and the holes stay.
    const painted = getWindowByHandle(hWnd);
    const exclusions = getChildWindowExclusions(hWnd, painted?.wndProc
        ? { repaintedAfterFlush: isGuestPaintedControl }
        : undefined);
    // A window that is not EFFECTIVELY visible must not reach the screen, however
    // dutifully it paints: Win32 sends its WM_PAINT to a DC nobody sees. Without this
    // the guest's splash dialogs kept re-flushing after EndDialog had already erased
    // them, so the old splash hung behind the launcher menu for the whole session.
    // The DC itself is still filled and released normally — only the composite stops.
    const flushed = painted && (!isEffectivelyVisible(painted)
        || isWindowFullyCoveredByHigherTopLevel(painted))
        ? false
        : gdi.flushWindowMemoryDCToOverlay(
            hdc, exclusions, painted?.isSystemControl ? undefined : hWnd,
            painted ? getAncestorClipRect(painted) : null);
    if (flushed) {
        markGuestCustomPaint(hWnd);
        // OS-owned controls (statics/edits) paint on top of the guest's flushed
        // background; owner-draw buttons early-out and are drawn by the chain below.
        const win = getWindowByHandle(hWnd);
        if (win && win.children.length) repaintChildControls(hWnd);
    }
    return !!flushed;
}

/**
 * DefWindowProc/DefDlgProc's WM_PAINT. Win32's default is literally `BeginPaint(&ps);
 * EndPaint(&ps);` — which is where WM_ERASEBKGND gets sent and, here, where the
 * owner-draw chain runs. A window proc that hands an unhandled WM_PAINT down its
 * subclass chain (MFC's `CWnd::Default()`) depends on landing here; a launcher whose
 * whole art is an OnEraseBkgnd blit plus CBitmapButtons draws nothing without it.
 *
 * Returns a suspended-thunk result while guest paint callbacks are in flight, or null
 * when the sequence finished inline (the caller then returns 0 as DefWindowProc does).
 */
export function runDefaultWindowPaint(
    ctx: any,
    mem: Uint8Array,
    hWnd: number,
    label: string,
    stackCleanup: number,
): ThunkResult | null {
    const window = getWindowByHandle(hWnd);
    if (!window || window.isSystemControl) return null;
    // Win32 does not re-enter WM_PAINT while WM_CREATE / WM_INITDIALOG is running.
    if (isWindowInitInProgress(hWnd)) return null;

    const system = System.getInstance();
    const callbackManager = system.process?.dispatcher?.callbackManager;
    if (!callbackManager) return null;
    const gdi = system.gdiContext;
    const hdc = createWindowClientDC(gdi, hWnd);
    if (!hdc) return null;
    gdi.markPaintDC(hdc);
    const updateBounds = getWindowUpdateBounds(hWnd);
    // No update region at all is not a Win32 state — there WM_PAINT is derived FROM the
    // region, so the message could not exist. Ours can (repaint requests that post it
    // directly), and it means a full-client repaint: erase, or a guest that draws text
    // every paint stacks glyphs on the ones the last paint left (visibly bolder).
    const fErase = consumeNeedsErase(hWnd) || updateBounds === null;
    clearWindowUpdate(hWnd);

    // Reached through CallWindowProc from a subclass chain, this thunk IS the callback —
    // its return address is a callback stub, so every guest step below has to resume
    // through this thunk's own RET N instead of consuming the outer frame.
    const thunkReturnAddr =
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32(ctx.esp, true) >>> 0;
    const stubRange = callbackManager.getStubPoolRange();
    const directReturn = thunkReturnAddr >= stubRange.base && thunkReturnAddr < stubRange.end
        ? { returnAddr: thunkReturnAddr, postEsp: (ctx.esp + 4 + stackCleanup) >>> 0 }
        : undefined;
    if (paintTraceEnabled) logBeginEndPaint('BeginPaint', hWnd,
        `via=${label} hdc=0x${hdc.toString(16)} fErase=${fErase ? 1 : 0}`);

    // Background + controls are one frame; each control is a guest callback, so without
    // the hold a compositor samples the middle of the sequence.
    gdi.beginOverlayPublish();
    let holdReleased = false;
    const releaseHold = (): void => {
        if (holdReleased) return;
        holdReleased = true;
        gdi.endOverlayPublish();
    };

    /** The EndPaint half: composite, then let the guest draw the controls it owns. */
    const endPaint = (frameId?: number): ThunkResult | null => {
        pendingEraseRects.delete(hWnd);
        try {
            const flushed = flushPaintDCToOverlay(hWnd, hdc);
            gdi.releaseDC(hdc);
            if (paintTraceEnabled) logBeginEndPaint('EndPaint', hWnd,
                `via=${label} hdc=0x${hdc.toString(16)} flush=${flushed ? 1 : 0}`);
            const odWin = flushed ? getWindowByHandle(hWnd) : undefined;
            if (odWin) {
                const chain = tryEndPaintOwnerDrawChain(ctx, mem, hWnd, odWin, {
                    createChildDC: (childHwnd) => createWindowClientDC(gdi, childHwnd),
                    flushChildDC: (childDc) => {
                        gdi.flushWindowMemoryDCToOverlay(childDc);
                        gdi.releaseDC(childDc);
                    },
                    discardChildDC: (childDc) => gdi.releaseDC(childDc),
                    onComplete: releaseHold,
                }, stackCleanup, frameId, directReturn);
                // The chain took its own hold and releases ours via onComplete.
                if (chain) return chain;
            }
        } catch (err) {
            Logger.error(LogCategory.USER32, `${label}: default paint failed — ${err}`);
        }
        releaseHold();
        return null;
    };

    if (fErase && beginWindowErase(hWnd, window, hdc, updateBounds)) {
        // The frame the erase suspension saved; the owner-draw chain reuses it rather
        // than saving a second one from an ESP that no longer belongs to this thunk.
        // It stays 0 on the nested (directThunkReturn) path, where the live frame is an
        // outer callback's and the chain must not touch it.
        let eraseFrameId = 0;
        const sync = trySuspendForSyncWindowMessage(
            ctx, hWnd, WM_ERASEBKGND_PAINT, hdc, 0, `${label}:erase`, stackCleanup,
            // The erase answered; finish the paint. Returning null keeps this thunk
            // suspended for the owner-draw chain the EndPaint half just started.
            () => (endPaint(eraseFrameId || undefined) ? null : 0),
            undefined, directReturn,
        );
        if (sync.suspended) {
            eraseFrameId = sync.frameId;
            return {
                value: 0,
                suspendedForCallback: true,
                callbackId: sync.callbackId,
                stackCleanup,
                skipStackCheck: true,
                preserveCallbackReturnAddress: sync.reusedFrame,
            };
        }
    }
    return endPaint();
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
        // A window born visible is entirely invalid AND needs erasing — the update region
        // is what carries that to BeginPaint. Posting WM_PAINT alone delivers a paint whose
        // fErase is FALSE, so the class brush never runs and the client keeps whatever the
        // screen held (on a DirectDraw primary, the raw surface).
        invalidateWindow(windowInfo.handle, null, true);
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
            controlId: controlIdFromCreateWindow(dwStyle, hMenu),
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

        // user32 builtins expose controlClass via BuiltinSystemClass; comctl32
        // classes (SysListView32, …) carry it on the registerBuiltinClass info.
        const controlClass = builtinDescr?.controlClass ?? classInfo?.controlClass;
        if (controlClass) {
            windowInfo.isSystemControl = true;
            windowInfo.systemControlClass = controlClass;
            windowInfo.externalPaintManaged = !!classInfo?.externalPaintManaged;
            windowInfo.fontHandle = windows.get(hWndParent)?.fontHandle;
            // comctl registerBuiltinClass leaves lpfnWndProc=0; system controls
            // need DefWindowProc so DispatchMessage / subclass forward works.
            if (!windowInfo.wndProc) {
                windowInfo.wndProc = getDefWindowProcAddress();
            }
        }

        windows.set(windowInfo.handle, windowInfo);

        // Add to parent's children list
        if (hWndParent) {
            const parent = windows.get(hWndParent);
            if (parent) {
                // children[] is front-to-back (index 0 = topmost, see reorderChildInParent),
                // and CreateWindowEx puts a new window at the TOP of its siblings' Z-order.
                // Appending inverted that for every CreateWindow-made control: the OLDEST
                // sibling hit-tested first and, once controls started filling their own
                // background, painted last — a static's fill wiping its neighbour's text.
                parent.children.unshift(windowInfo.handle);
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
        const WM_WINDOWPOSCHANGED = 0x0047;
        const HTCLIENT = 1;

        const win = windows.get(hWnd);
        if (win && Msg === WM_WINDOWPOSCHANGED && lParam) {
            const flags = Mem.readUint32(lParam + 24) ?? 0;
            const sendMove = (flags & 0x1000 /* SWP_NOCLIENTMOVE */) === 0;
            const sendSize = (flags & 0x0800 /* SWP_NOCLIENTSIZE */) === 0
                || (flags & 0x8000 /* SWP_STATECHANGED */) !== 0;
            if (!sendMove && !sendSize) return 0;
            let frameId = 0;
            let directThunkReturn: { returnAddr: number; postEsp: number } | undefined;
            const completeSize = (): number | null => 0;
            const sendSizeMessage = (): number | null => {
                if (!sendSize) return 0;
                const sizeType = (win.style & 0x20000000) !== 0 ? 1
                    : ((win.style & 0x01000000) !== 0 ? 2 : 0);
                const sync = trySuspendForSyncWindowMessage(
                    ctx, hWnd, WM_SIZE_GEO, sizeType,
                    makeGeometryLParam(win.width, win.height),
                    'DefWindowProc:WM_WINDOWPOSCHANGED', 16, completeSize, frameId || undefined,
                    directThunkReturn,
                );
                return sync.suspended ? null : 0;
            };
            const sync = trySuspendForSyncWindowMessage(
                ctx, hWnd,
                sendMove ? WM_MOVE_GEO : WM_SIZE_GEO,
                sendMove ? 0 : ((win.style & 0x20000000) !== 0 ? 1 : ((win.style & 0x01000000) !== 0 ? 2 : 0)),
                sendMove
                    ? makeGeometryLParam(win.x, win.y)
                    : makeGeometryLParam(win.width, win.height),
                'DefWindowProc:WM_WINDOWPOSCHANGED', 16,
                sendMove ? sendSizeMessage : completeSize,
            );
            if (sync.suspended) {
                frameId = sync.frameId;
                directThunkReturn = sync.directThunkReturn;
                return {
                    value: 0,
                    suspendedForCallback: true,
                    callbackId: sync.callbackId,
                    stackCleanup: 16,
                    skipStackCheck: true,
                    preserveCallbackReturnAddress: sync.reusedFrame,
                };
            }
            return 0;
        }
        if (win?.isSystemControl) {
            // A system control's wndProc IS this thunk (createDialogChildren), so a guest
            // that subclasses the control and forwards what it doesn't handle lands here —
            // which on real Windows is the BUTTON/LISTBOX/COMBOBOX class proc. Run the
            // class's input behavior (click -> WM_COMMAND(BN_CLICKED), combo drop, …)
            // before the message-based handling, or the forwarded click dies here.
            const WM_KEYDOWN_CTL = 0x0100, WM_KEYUP_CTL = 0x0101;
            const classHandled = (Msg === WM_KEYDOWN_CTL || Msg === WM_KEYUP_CTL)
                ? handleSystemControlKey(win, Msg, wParam & 0xFF)
                : handleSystemControlClassMouse(win, Msg, wParam, lParam);
            if (classHandled) {
                const notification = takePendingControlNotification();
                if (notification) {
                    const sync = trySuspendForSyncWindowMessage(
                        ctx, notification.hwnd, notification.msg,
                        notification.wParam, notification.lParam,
                        'DefWindowProc:control-notify', 16, () => 0,
                    );
                    if (sync.suspended) {
                        return {
                            value: 0,
                            suspendedForCallback: true,
                            callbackId: sync.callbackId,
                            stackCleanup: 16,
                            skipStackCheck: true,
                            preserveCallbackReturnAddress: sync.reusedFrame,
                        };
                    }
                }
                return 0;
            }
            const result = handleSystemControlMessage(win, Msg, wParam, lParam, mem);
            if (isContentChangingMessage(win, Msg)) {
                repaintDialogAfterContentChange(win.parent ?? hWnd);
            }
            return result;
        }

        if (Msg === WM_PAINT_GEO) {
            const paint = runDefaultWindowPaint(ctx, mem, hWnd, 'DefWindowProc', 16);
            return paint ?? 0;
        }

        if (Msg === WM_ERASEBKGND_PAINT) {
            // The class brush is the ONLY thing that paints a plain registered class's
            // client: a window whose whole UI is child controls shows whatever was on the
            // screen between them (here, the DirectDraw primary) until this fills it.
            return eraseWindowBackground(hWnd, wParam >>> 0);
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

    const showWindowImpl = (
        ctx: any,
        hWnd: number,
        nCmdShow: number,
        stackCleanup: number,
        forcedResult?: number,
        existingFrameId = 0,
    ): any => {

        Logger.verbose(LogCategory.USER32, `ShowWindow(0x${hWnd.toString(16)}, ${nCmdShow})`);

        const window = windows.get(hWnd);
        if (!window || nCmdShow < 0 || nCmdShow > 11) return 0;

        const WS_VISIBLE = 0x10000000;
        const WS_CHILD = 0x40000000;
        const WS_POPUP = 0x80000000;
        const WS_MINIMIZE = 0x20000000;
        const WS_MAXIMIZE = 0x01000000;
        const wasVisible = (window.style & WS_VISIBLE) !== 0;
        const resultValue = forcedResult ?? (wasVisible ? 1 : 0);
        const show = nCmdShow !== 0;
        const visibilityChanged = show !== wasVisible;
        const isChild = (window.style & WS_CHILD) !== 0;
        const noActivate = isChild || nCmdShow === 4 || nCmdShow === 6
            || nCmdShow === 7 || nCmdShow === 8 || nCmdShow === 11;
        const noZOrder = isChild || nCmdShow === 4 || nCmdShow === 6 || nCmdShow === 7
            || (!show && System.getInstance().windowManager.getActiveHwnd() !== hWnd);

        if ((nCmdShow === 0 && !wasVisible) || (nCmdShow === 5 && wasVisible)) {
            return resultValue;
        }

        const applyShowState = (): number => {
            const live = windows.get(hWnd);
            if (!live) return resultValue;

            if (nCmdShow === 2 || nCmdShow === 6 || nCmdShow === 7 || nCmdShow === 11) {
                live.style = (live.style | WS_MINIMIZE) & ~WS_MAXIMIZE;
            } else if (nCmdShow === 3) {
                live.style = (live.style | WS_MAXIMIZE) & ~WS_MINIMIZE;
            } else if (nCmdShow === 1 || nCmdShow === 4 || nCmdShow === 9 || nCmdShow === 10) {
                live.style &= ~(WS_MINIMIZE | WS_MAXIMIZE);
            }

            if (visibilityChanged) {
                live.visible = show;
                if (show) live.style |= WS_VISIBLE;
                else live.style &= ~WS_VISIBLE;

                const wm = System.getInstance().windowManager;
                const wmWin = wm.getWindow(hWnd);
                if (wmWin) wmWin.visible = show;

                if (!show) {
                    eraseHiddenWindowPixels(live);
                    if (!isChild && wm.getActiveHwnd() === hWnd) {
                        const successor = wm.getZOrder().find(candidate => {
                            if (candidate === hWnd) return false;
                            const next = wm.getWindow(candidate);
                            // A disabled top-level window cannot become active. This matters
                            // for nested modal dialogs: MFC disables the main window while the
                            // intermediate dialog remains enabled, so choosing the disabled
                            // owner here would route the next click through the window beneath
                            // the still-visible modal dialog.
                            return !!next?.visible
                                && (next.style & WS_CHILD) === 0
                                && (next.style & 0x08000000 /* WS_DISABLED */) === 0;
                        }) ?? 0;
                        if (successor) activateTopLevelWindow(successor);
                        else wm.clearActiveWindow(hWnd);
                    }
                } else if (isEffectivelyVisible(live)) {
                    if (!noZOrder && !isChild) wm.setWindowZOrder(hWnd, 0 /* HWND_TOP */);
                    noteDialogOverlayCandidate(live);
                    invalidateWindow(hWnd, null, true);
                    if (live.isSystemControl && live.parent) {
                        repaintDialogAfterContentChange(live.parent);
                    }
                    // Showing invalidates the window; WM_PAINT is still dispatched even
                    // when our flat-overlay fallback supplied an immediate default face.
                    // The guest may handle it (and owner-draw its controls), replacing the
                    // fallback exactly as the native paint lifecycle would.
                    if (!live.createInProgress) {
                        if (live.guestCustomPaint) requestGuestDialogPaint(hWnd);
                        else System.getInstance().windowManager.postMessage(hWnd, WM_PAINT, 0, 0);
                    }
                }
            }

            if (show && !noActivate && !isChild) {
                const wm = System.getInstance().windowManager;
                if (wm.getActiveHwnd() !== hWnd || needsActivationDelivery(hWnd)) {
                    activateTopLevelWindow(hWnd);
                }
            }

            if (show && !isChild && !(live.style & WS_POPUP)) {
                System.getInstance().requestHostResize(live.width, live.height);
            }
            if (isAnimateControlWindow(live)) onAnimateShowWindow(hWnd, nCmdShow);
            return resultValue;
        };

        // USER sends WM_SHOWWINDOW synchronously before SetWindowPos changes WS_VISIBLE.
        if (visibilityChanged || nCmdShow === 8 /* SW_SHOWNA */) {
            const sync = trySuspendForSyncWindowMessage(
                ctx, hWnd, 0x0018 /* WM_SHOWWINDOW */, show ? 1 : 0, 0,
                'ShowWindow', stackCleanup, applyShowState, existingFrameId || undefined,
            );
            if (sync.suspended) {
                return {
                    value: resultValue,
                    suspendedForCallback: true,
                    callbackId: sync.callbackId,
                    stackCleanup,
                    skipStackCheck: true,
                    preserveCallbackReturnAddress: sync.reusedFrame,
                };
            }
        }
        return applyShowState();
    };

    exports['ShowWindow'] = (ctx, mem, args) =>
        showWindowImpl(ctx, args[0] >>> 0, args[1] | 0, 8);

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

    const setWindowPosImpl = (
        ctx: any,
        mem: Uint8Array,
        args: number[],
        stackCleanup: number,
        existingFrameId = 0,
        onComplete?: () => number | null,
        onFrame?: (frameId: number) => void,
    ): any => {
        const hWnd = args[0] >>> 0;
        const hWndInsertAfter = args[1] >>> 0;
        const x = Math.max(-32768, Math.min(32767, args[2] | 0));
        const y = Math.max(-32768, Math.min(32767, args[3] | 0));
        const cx = Math.max(0, Math.min(32767, args[4] | 0));
        const cy = Math.max(0, Math.min(32767, args[5] | 0));
        const uFlags = args[6] >>> 0;

        Logger.verbose(LogCategory.USER32,
            `SetWindowPos(0x${hWnd.toString(16)}, insertAfter=0x${hWndInsertAfter.toString(16)}, x=${x}, y=${y}, cx=${cx}, cy=${cy}, flags=0x${uFlags.toString(16)})`);

        const window = windows.get(hWnd);
        if (!window) return 0;
        // An invalid child Z-order target suppresses only the Z-order portion. USER
        // still applies move/size/show flags (native launchers commonly pass
        // HWND_TOPMOST while positioning a child page).

        const SWP_NOSIZE = 0x0001;
        const SWP_NOMOVE = 0x0002;
        const SWP_NOZORDER = 0x0004;
        const SWP_NOREDRAW = 0x0008;
        const SWP_NOACTIVATE = 0x0010;
        const SWP_FRAMECHANGED = 0x0020;
        const SWP_SHOWWINDOW = 0x0040;
        const SWP_HIDEWINDOW = 0x0080;
        const SWP_NOSENDCHANGING = 0x0400;
        const SWP_NOCLIENTSIZE = 0x0800;
        const SWP_NOCLIENTMOVE = 0x1000;
        const WS_VISIBLE = 0x10000000;
        const WS_CHILD = 0x40000000;
        const process = System.getInstance().process;

        type WindowPosValue = {
            insertAfter: number; x: number; y: number; cx: number; cy: number; flags: number;
        };

        const writeWindowPos = (ptr: number, pos: WindowPosValue): void => {
            Mem.writeUint32(ptr, hWnd);
            Mem.writeUint32(ptr + 4, pos.insertAfter);
            Mem.writeUint32(ptr + 8, pos.x >>> 0);
            Mem.writeUint32(ptr + 12, pos.y >>> 0);
            Mem.writeUint32(ptr + 16, pos.cx >>> 0);
            Mem.writeUint32(ptr + 20, pos.cy >>> 0);
            Mem.writeUint32(ptr + 24, pos.flags >>> 0);
        };
        const readWindowPos = (ptr: number): WindowPosValue => ({
            insertAfter: Mem.readUint32(ptr + 4) ?? hWndInsertAfter,
            x: Math.max(-32768, Math.min(32767, Mem.readInt32(ptr + 8) ?? x)),
            y: Math.max(-32768, Math.min(32767, Mem.readInt32(ptr + 12) ?? y)),
            cx: Math.max(0, Math.min(32767, Mem.readInt32(ptr + 16) ?? cx)),
            cy: Math.max(0, Math.min(32767, Mem.readInt32(ptr + 20) ?? cy)),
            flags: Mem.readUint32(ptr + 24) ?? uFlags,
        });

        const applyWindowPos = (pos: WindowPosValue, ptr: number): boolean => {
            const live = windows.get(hWnd);
            if (!live) return false;

            let flags = pos.flags >>> 0;
            if (!isWindowPosZOrderRequestValid(live, pos.insertAfter, flags)) {
                // HWND_TOPMOST/NOTOPMOST belong to the desktop Z-order domain. Some
                // legacy callers nevertheless use that pair for a WS_CHILD page while
                // supplying desktop coordinates. Downgrade the invalid Z request to
                // ordinary child Z-order and map the accompanying point into the
                // parent's client space. This is style/coordinate-domain compatibility,
                // independent of dialog class, resource ids, or application identity.
                if ((live.style & WS_CHILD) && !(flags & SWP_NOMOVE)
                    && (pos.insertAfter === 0xffffffff || pos.insertAfter === 0xfffffffe)
                    && live.parent) {
                    const parent = windows.get(live.parent);
                    if (parent) {
                        const origin = getAbsoluteWindowPosition(parent);
                        pos.x -= origin.x;
                        pos.y -= origin.y;
                    }
                }
                flags |= SWP_NOZORDER;
            }
            const wasVisible = (live.style & WS_VISIBLE) !== 0;
            if (wasVisible) flags &= ~SWP_SHOWWINDOW;
            else {
                flags &= ~SWP_HIDEWINDOW;
                if (!(flags & SWP_SHOWWINDOW)) flags |= SWP_NOREDRAW;
            }
            if (!(flags & SWP_NOSIZE) && pos.cx === live.width && pos.cy === live.height) flags |= SWP_NOSIZE;
            if (!(flags & SWP_NOMOVE) && pos.x === live.x && pos.y === live.y) flags |= SWP_NOMOVE;

            const oldRect = { x: live.x, y: live.y, w: live.width, h: live.height };
            const showing = (flags & SWP_SHOWWINDOW) !== 0;
            const hiding = !showing && (flags & SWP_HIDEWINDOW) !== 0;

            if (hiding) eraseHiddenWindowPixels(live);

            if (!(flags & SWP_NOZORDER)) {
                if (live.style & WS_CHILD) reorderChildInParent(hWnd, pos.insertAfter | 0);
                else System.getInstance().windowManager.setWindowZOrder(hWnd, pos.insertAfter | 0);
            }

            const geom = applyWindowPosGeometry(
                hWnd, pos.x, pos.y, pos.cx, pos.cy, flags,
                { skipDialogOverlayRepaint: true },
            );
            const moved = !!geom?.moved;
            const resized = !!geom?.resized;
            if (showing) {
                live.visible = true;
                live.style |= WS_VISIBLE;
            } else if (hiding) {
                live.visible = false;
                live.style &= ~WS_VISIBLE;
            }
            if (!moved) flags |= SWP_NOCLIENTMOVE;
            if (!resized) flags |= SWP_NOCLIENTSIZE;
            pos.flags = flags;
            if (ptr) writeWindowPos(ptr, pos);

            const wmWin = System.getInstance().windowManager.getWindow(hWnd);
            if (wmWin) wmWin.visible = live.visible;

            if (!(flags & SWP_NOREDRAW) && live.parent && wasVisible
                && (hiding || moved || resized || !(flags & SWP_NOZORDER))) {
                invalidateWindow(live.parent, {
                    left: oldRect.x,
                    top: oldRect.y,
                    right: oldRect.x + oldRect.w,
                    bottom: oldRect.y + oldRect.h,
                }, true);
            }
            if (!(flags & SWP_NOREDRAW) && live.visible
                && (showing || moved || resized || (flags & SWP_FRAMECHANGED))) {
                invalidateWindow(hWnd, null, true);
                noteDialogOverlayCandidate(live);
            }
            if (!(flags & SWP_NOACTIVATE) && !(live.style & WS_CHILD) && !hiding) {
                activateTopLevelWindow(hWnd);
            }
            Logger.verbose(LogCategory.USER32,
                `SetWindowPos result: win.x=${live.x} win.y=${live.y} win.w=${live.width} win.h=${live.height} flags=0x${flags.toString(16)}`);
            return moved || resized || showing || hiding || !(flags & SWP_NOZORDER) || !!(flags & SWP_FRAMECHANGED);
        };

        const wndProc = resolveGuestWndProc(window);
        const hasGuestWndProc = !!wndProc && !isSentinelWndProc(wndProc)
            && (!window.isSystemControl || !!window.wndProcSubclassed);
        if (!hasGuestWndProc || !process) {
            const pos = { insertAfter: hWndInsertAfter, x, y, cx, cy, flags: uFlags };
            const changed = applyWindowPos(pos, 0);
            if (changed) finishWindowPosRepaint(hWnd);
            return onComplete ? onComplete() : 1;
        }

        const callbackManager = process.dispatcher?.callbackManager;
        if (!callbackManager) return 0;
        const windowPosPtr = process.memory.alloc(28, 'HEAP', 'rw');
        if (!windowPosPtr) return 0;
        writeWindowPos(windowPosPtr, { insertAfter: hWndInsertAfter, x, y, cx, cy, flags: uFlags });
        const thunkReturnAddr = Mem.readUint32(ctx.esp) ?? 0;
        const saveFrame = (): number => {
            const frameId = existingFrameId || callbackManager.saveSuspendedThunkContext(
                { ...ctx, returnAddr: thunkReturnAddr }, stackCleanup, 'SetWindowPos');
            if (frameId) onFrame?.(frameId);
            return frameId;
        };

        if (uFlags & SWP_NOSENDCHANGING) {
            const changed = applyWindowPos(readWindowPos(windowPosPtr), windowPosPtr);
            if (!changed) {
                process.memory.free(windowPosPtr);
                return onComplete ? onComplete() : 1;
            }
            const frameId = saveFrame();
            if (!frameId) {
                process.memory.free(windowPosPtr);
                return 0;
            }
            const changedCall = callbackManager.invokeCallback(
                wndProc, [hWnd, 0x0047 /* WM_WINDOWPOSCHANGED */, 0, windowPosPtr], 0,
                () => {
                    process.memory.free(windowPosPtr);
                    finishWindowPosRepaint(hWnd);
                    return onComplete ? onComplete() : 1;
                },
                false, 'SetWindowPos:WM_WINDOWPOSCHANGED', frameId);
            if (!changedCall.callbackId) {
                process.memory.free(windowPosPtr);
                return 0;
            }
            return {
                value: 1,
                suspendedForCallback: true,
                callbackId: changedCall.callbackId,
                stackCleanup,
                skipStackCheck: true,
            };
        }

        const frameId = saveFrame();
        if (!frameId) {
            process.memory.free(windowPosPtr);
            return 0;
        }

        const finish = (): number | null => {
            process.memory.free(windowPosPtr);
            finishWindowPosRepaint(hWnd);
            return onComplete ? onComplete() : 1;
        };
        const afterChanging = (): number | null => {
            if (!windows.has(hWnd)) return finish();
            const changed = applyWindowPos(readWindowPos(windowPosPtr), windowPosPtr);
            if (!changed) return finish();
            const changedCall = callbackManager.invokeCallback(
                wndProc, [hWnd, 0x0047 /* WM_WINDOWPOSCHANGED */, 0, windowPosPtr], 0,
                () => finish(), false, 'SetWindowPos:WM_WINDOWPOSCHANGED', frameId);
            return changedCall.callbackId ? null : finish();
        };

        const first = callbackManager.invokeCallback(
            wndProc, [hWnd, 0x0046 /* WM_WINDOWPOSCHANGING */, 0, windowPosPtr], 0,
            afterChanging, false, 'SetWindowPos:WM_WINDOWPOSCHANGING', frameId);
        if (!first.callbackId) {
            process.memory.free(windowPosPtr);
            return 0;
        }
        return {
            value: 1,
            suspendedForCallback: true,
            callbackId: first.callbackId,
            stackCleanup,
            skipStackCheck: true,
        };
    };

    exports['SetWindowPos'] = (ctx, mem, args) =>
        setWindowPosImpl(ctx, mem, args, 7 * 4);

    exports['MoveWindow'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const X = args[1] | 0;
        const Y = args[2] | 0;
        const nWidth = args[3] | 0;
        const nHeight = args[4] | 0;
        const bRepaint = args[5] !== 0;

        Logger.verbose(LogCategory.USER32,
            `MoveWindow(0x${hWnd.toString(16)}, x=${X}, y=${Y}, w=${nWidth}, h=${nHeight}, repaint=${bRepaint})`);

        const flags = 0x0004 /* SWP_NOZORDER */ | 0x0010 /* SWP_NOACTIVATE */
            | (bRepaint ? 0 : 0x0008 /* SWP_NOREDRAW */);
        return setWindowPosImpl(ctx, mem, [
            hWnd, 0, X, Y, nWidth, nHeight, flags,
        ], 6 * 4);
    };

    exports['ShowCursor'] = (ctx, mem, args) => {
        const bShow = args[0] !== 0;
        const prevCount = getCursorDisplayCount();
        const wasVisible = isGuestCursorVisible();
        const nextCount = updateCursorDisplayCount(bShow ? 1 : -1);
        // ShowCursor is a COUNTER; visibility is only its sign. Apps drive it in loops
        // (`while (ShowCursor(FALSE) >= 0);` is the idiomatic force-hide), so most calls
        // move the count without changing what the host should show — and the host sync
        // costs a cursor-resource lookup each time. Sync on the transition only.
        if (isGuestCursorVisible() !== wasVisible) syncHostCursorToGuestState();
        Logger.verbose(LogCategory.USER32, `ShowCursor(${bShow ? 1 : 0}) -> ${nextCount} (prev=${prevCount}), visible=${isGuestCursorVisible()}`);
        return nextCount;
    };

    // BOOL OpenIcon(HWND hWnd) — restores a minimized window
    // We never minimize, so just return TRUE (success)
    exports['OpenIcon'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `OpenIcon(0x${hWnd.toString(16)})`);
        if (!windows.has(hWnd)) return 0;
        return showWindowImpl(ctx, hWnd, 9 /* SW_RESTORE */, 4, 1);
    };

    // BOOL CloseWindow(HWND hWnd) — minimizes the specified window (does NOT destroy it)
    // We don't support minimizing in emulator, return TRUE
    exports['CloseWindow'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `CloseWindow(0x${hWnd.toString(16)})`);
        if (!windows.has(hWnd)) return 0;
        return showWindowImpl(ctx, hWnd, 6 /* SW_MINIMIZE */, 4, 1);
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

        // LockWindowUpdate: drawing without DCX_LOCKWINDOWUPDATE must not reach the
        // screen (Wine win.c test_LockWindowUpdate — pixels stay at the pre-lock value
        // after unlock). Drop the dirty flag so a later accidental flush cannot publish them.
        if (hWnd && isWindowUpdateLocked(hWnd)) {
            gdi.clearDirty(hDC);
            gdi.releaseDC(hDC);
            return 1;
        }

        publishWindowDC(hWnd, hDC);
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
        gdi.markPaintDC(hdc);

        // See runDefaultWindowPaint: a paint with no update region is our own artifact and
        // means "repaint everything", which in Win32 always comes with an erase.
        const pending = getWindowUpdateBounds(hWnd);
        const updateBounds = window
            ? (pending ?? { left: 0, top: 0, right: window.width, bottom: window.height })
            : null;
        const fErase = consumeNeedsErase(hWnd) || pending === null;
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

        if (paintTraceEnabled) logBeginEndPaint('BeginPaint', hWnd,
            `lpPaint=0x${lpPaint.toString(16)} hdc=0x${hdc.toString(16)} ` +
            `${window?.width ?? 0}x${window?.height ?? 0} fErase=${fErase ? 1 : 0} ` +
            `upd=${updateBounds
                ? `${updateBounds.left},${updateBounds.top},${updateBounds.right},${updateBounds.bottom}`
                : 'none'}`);

        if (lpPaint && window && updateBounds) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpPaint, hdc, true); // hdc
            view.setUint32(lpPaint + 4, fErase ? 1 : 0, true); // fErase
            view.setInt32(lpPaint + 8, updateBounds.left, true);
            view.setInt32(lpPaint + 12, updateBounds.top, true);
            view.setInt32(lpPaint + 16, updateBounds.right, true);
            view.setInt32(lpPaint + 20, updateBounds.bottom, true);
        }

        // USER — not the caller — erases: BeginPaint sends WM_ERASEBKGND when the update
        // region was invalidated with bErase, and reports fErase=FALSE afterwards. An app
        // whose background lives in OnEraseBkgnd never draws it otherwise, and MFC's
        // CPaintDC does not erase on its own.
        if (fErase && hdc && window && !window.isSystemControl
            && beginWindowErase(hWnd, window, hdc, updateBounds)) {
            const sync = trySuspendForSyncWindowMessage(
                ctx, hWnd, WM_ERASEBKGND_PAINT, hdc, 0, 'BeginPaint:erase', 8,
                () => { pendingEraseRects.delete(hWnd); return hdc; },
            );
            if (sync.suspended) {
                if (lpPaint) {
                    new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
                        .setUint32(lpPaint + 4, 0, true); // fErase: USER already erased
                }
                return {
                    value: hdc,
                    suspendedForCallback: true,
                    callbackId: sync.callbackId,
                    stackCleanup: 8,
                    skipStackCheck: true,
                    preserveCallbackReturnAddress: sync.reusedFrame,
                };
            }
        }
        pendingEraseRects.delete(hWnd);

        return hdc;
    };

    exports['EndPaint'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpPaint = args[1];

        Logger.verbose(LogCategory.USER32, `EndPaint(0x${hWnd.toString(16)}, 0x${lpPaint.toString(16)})`);

        const gdi = System.getInstance().gdiContext;
        // A repaint is a SEQUENCE: the window background lands first and covers the
        // controls, then each control is drawn back on top — and the control half runs as
        // guest callbacks, so it spans frames. Publish the whole thing atomically or a
        // compositor samples the middle of it (controls momentarily gone).
        gdi.beginOverlayPublish();
        try {
        if (lpPaint) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const hdc = view.getUint32(lpPaint, true);
            const flushed = flushPaintDCToOverlay(hWnd, hdc);
            if (paintTraceEnabled) logBeginEndPaint('EndPaint', hWnd,
                `lpPaint=0x${lpPaint.toString(16)} hdc=0x${hdc.toString(16)} flush=${flushed ? 1 : 0}`);
            gdi.releaseDC(hdc);

            // Owner-draw buttons paint on TOP of the now-flushed background. Each child
            // gets its own client DC (positioned + seeded from the overlay); the guest
            // blits its tile in via WM_DRAWITEM, then we composite each onto the overlay.
            // A fully occluded window gets an empty native update region. If its parent
            // blit was suppressed above, its owner-draw children must be suppressed too;
            // otherwise only the lower window's buttons leak through the popup.
            const odWin = flushed ? getWindowByHandle(hWnd) : undefined;
            if (odWin) {
                try {
                    const ownerDraw = tryEndPaintOwnerDrawChain(ctx, mem, hWnd, odWin, {
                        createChildDC: (childHwnd) => createWindowClientDC(gdi, childHwnd),
                        flushChildDC: (childDc) => {
                            gdi.flushWindowMemoryDCToOverlay(childDc);
                            gdi.releaseDC(childDc);
                        },
                        discardChildDC: (childDc) => gdi.releaseDC(childDc),
                    });
                    // The chain took its own publish hold; it closes when the last
                    // control has painted, so the sequence stays atomic past this return.
                    if (ownerDraw) return ownerDraw;
                } catch (err) {
                    Logger.error(LogCategory.USER32,
                        `EndPaint owner-draw chain failed for hwnd=0x${hWnd.toString(16)}: ${err}`);
                }
            }
        }

        return 1;
        } finally {
            gdi.endOverlayPublish();
        }
    };

    exports['CallWindowProcA'] = (ctx, mem, args) => {
        const lpPrevWndFunc = args[0] >>> 0;
        const hWnd = args[1] >>> 0;
        const Msg = args[2] >>> 0;
        const wParam = args[3] >>> 0;
        const lParam = args[4] >>> 0;

        Logger.verboseLazy(LogCategory.USER32, () =>
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
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const returnAddr = view.getUint32(ctx.esp, true) >>> 0;
        const first = callbackManager.invokeCallback(
            lpPrevWndFunc,
            [hWnd, Msg, wParam, lParam],
            0,
            undefined,
            false,
            'CallWindowProcA',
            undefined,
            {
                directThunkReturn: {
                    returnAddr,
                    postEsp: (ctx.esp + 4 + stackCleanup) >>> 0,
                    complete: (wndRet: number): number | null => {
                        if (Msg === WM_SIZE && getWindowByHandle(hWnd)?.guestCustomPaint) {
                            requestGuestDialogPaint(hWnd);
                        }
                        return wndRet >>> 0;
                    },
                },
            },
        );
        if (!first.callbackId) return { value: 0, stackCleanup };

        // CallWindowProc is a nested guest call, not the end of the outer
        // DispatchMessage/SendMessage callback.  Return through this thunk's own
        // continuation so the subclass WndProc resumes with the callee's EAX.
        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: first.callbackId,
            stackCleanup,
            skipStackCheck: true,
            preserveCallbackReturnAddress: true,
        };
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
        const hWnd = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `LockWindowUpdate(0x${hWnd.toString(16)})`);
        // Unlock does not invent paint — guest Invalidate/RedrawWindow owns that (Wine/NT).
        return tryLockWindowUpdate(hWnd) ? 1 : 0;
    };

    exports['SetScrollPos'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const nBar = args[1];
        const nPos = args[2];
        const bRedraw = args[3];
        Logger.verbose(LogCategory.USER32, `SetScrollPos(0x${hWnd.toString(16)}, ${nBar}, ${nPos}, ${bRedraw})`);
        return setScrollBarPos(hWnd, nBar, nPos);
    };

    exports['GetScrollPos'] = (ctx, mem, args) => getScrollPos(args[0] >>> 0, args[1] | 0);

    exports['SetScrollRange'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        setScrollRange(hWnd, args[1] | 0, args[2] | 0, args[3] | 0);
        if (args[4]) invalidateWindow(hWnd, null, false);
        return 1;
    };

    exports['GetScrollRange'] = (ctx, mem, args) =>
        getScrollRange(mem, args[0] >>> 0, args[1] | 0, args[2] >>> 0, args[3] >>> 0) ? 1 : 0;

    // BOOL GetScrollInfo(HWND hwnd, int nBar, LPSCROLLINFO lpsi)
    exports['GetScrollInfo'] = (ctx, mem, args) =>
        readScrollInfo(mem, args[0] >>> 0, args[1] | 0, args[2] >>> 0) ? 1 : 0;

    exports['EnableScrollBar'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const changed = enableScrollBar(hWnd, args[1] | 0, args[2] >>> 0);
        if (changed) invalidateWindow(hWnd, null, false);
        return changed ? 1 : 0;
    };

    exports['ShowScrollBar'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        showScrollBar(hWnd, args[1] | 0, !!args[2]);
        invalidateWindow(hWnd, null, false);
        return 1;
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

        // EndDeferWindowPos is one synchronous USER transaction, but every member
        // still receives the normal mutable WM_WINDOWPOSCHANGING -> apply ->
        // WM_WINDOWPOSCHANGED protocol. Reuse one suspended frame and append each
        // callback to it; bypassing this path made deferred layouts observably
        // different from SetWindowPos.
        let index = 0;
        let sharedFrameId = 0;
        let firstSuspension: any = null;
        const advance = (): number | null => {
            while (index < batch.length) {
                const entry = batch[index++]!;
                const result = setWindowPosImpl(ctx, mem, [
                    entry.hWnd, entry.hWndInsertAfter, entry.x, entry.y,
                    entry.cx, entry.cy, entry.uFlags,
                ], 4, sharedFrameId, advance, frameId => { sharedFrameId = frameId; });
                if (result && typeof result === 'object' && result.suspendedForCallback) {
                    if (!firstSuspension) firstSuspension = result;
                    return null;
                }
                if (result === null) return null;
            }
            Logger.verbose(LogCategory.USER32,
                `EndDeferWindowPos(0x${hWinPosInfo.toString(16)}) -> TRUE`);
            return 1;
        };

        const immediate = advance();
        return firstSuspension ?? immediate ?? 1;
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

        Logger.verbose(LogCategory.USER32,
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
                    discardChildDC: (childDc) => gdi.releaseDC(childDc),
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
    registerWindowGeometryExports(exports, {
        repaintParentDialogIfSystemControlGeometryChanged,
        applyWindowPlacement: (ctx, mem, hWnd, showCmd, normalRect) => {
            let placementFrameId = 0;
            const showPlacement = (): number | null => {
                const shown = showWindowImpl(ctx, hWnd, showCmd, 8, 1, placementFrameId);
                return shown && typeof shown === 'object' && shown.suspendedForCallback
                    ? null
                    : 1;
            };
            if (!normalRect) return showWindowImpl(ctx, hWnd, showCmd, 8, 1);
            const win = windows.get(hWnd);
            if (!win) return 0;
            const placementParent = win.parent ? windows.get(win.parent) : undefined;
            const parentOrigin = placementParent
                ? getAbsoluteWindowPosition(placementParent)
                : { x: 0, y: 0 };
            return setWindowPosImpl(ctx, mem, [
                hWnd,
                0,
                normalRect.left - parentOrigin.x,
                normalRect.top - parentOrigin.y,
                Math.max(0, normalRect.right - normalRect.left),
                Math.max(0, normalRect.bottom - normalRect.top),
                0x0004 /* SWP_NOZORDER */ | 0x0010 /* SWP_NOACTIVATE */,
            ], 8, 0, showPlacement, frameId => { placementFrameId = frameId; });
        },
    });
    registerWindowDrawingExports(exports);


    return exports;
}

/** Hot launcher-loop reads/no-ops that do not need argument marshaling or a boundary per call. */
export function registerFastPathWindowFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    const getForeground: FastPathImplementation = () =>
        System.getInstance().windowManager.getForegroundHwnd();

    const showCursor: FastPathImplementation = (cpu: any, _mem8: Uint8Array, _mem32: Uint32Array, view: DataView) => {
        const esp = cpu.reg32[4] >>> 0;
        const beforeVisible = isGuestCursorVisible();
        const next = updateCursorDisplayCount(view.getUint32(esp + 4, true) !== 0 ? 1 : -1);
        if (beforeVisible !== isGuestCursorVisible()) syncHostCursorToGuestState();
        return next;
    };

    const showWindowNoop: FastPathImplementation = (cpu: any, _mem8: Uint8Array, _mem32: Uint32Array, view: DataView) => {
        const esp = cpu.reg32[4] >>> 0;
        const hwnd = view.getUint32(esp + 4, true);
        const cmd = view.getInt32(esp + 8, true);
        const win = windows.get(hwnd);
        if (!win) return null;
        const visible = (win.style & 0x10000000) !== 0;
        if (cmd === 0 && !visible) return 0;
        if (cmd === 5 && visible) return 1;
        // NT xxxShowWindow returns immediately for SW_SHOWNORMAL/SW_RESTORE when
        // an already-visible window is neither minimized nor maximized.
        if ((cmd === 1 || cmd === 9) && visible
            && (win.style & (0x20000000 | 0x01000000)) === 0) return 1;
        return null;
    };

    dispatcher.registerFastPath('user32', 'GetForegroundWindow', getForeground, { trivial: true });
    dispatcher.registerFastPath('user32', 'ShowCursor', showCursor, { trivial: true });
    dispatcher.registerFastPath('user32', 'ShowWindow', showWindowNoop, { trivial: true });
}
