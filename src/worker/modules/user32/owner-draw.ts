/**
 * Generic BS_OWNERDRAW support — synthesize WM_DRAWITEM to the parent dialog proc
 * at EndPaint so guest code blits each owner-draw button's tile ON TOP of the
 * background the parent just painted.
 *
 * Why EndPaint and not BeginPaint: a dialog's WM_PAINT
 * first draws its background (e.g. HL's splash.bmp) into the paint HDC, then the
 * owner-draw child controls paint themselves over it. Running WM_DRAWITEM at
 * BeginPaint drew the buttons first; the guest's subsequent full-client background
 * blit then covered them. So we wait until EndPaint has flushed the background to
 * the overlay, then give each owner-draw child its OWN client DC (positioned at the
 * child + seeded from the overlay so the background shows through) and let the guest
 * draw the button tile into it, flushing each on top.
 */

import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import type { Process } from '../../core/process';
import type { ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { windows, buttonCheckStates, type WindowInfo } from './shared-state';
import { paintTraceEnabled, logOwnerDrawChain } from './paint-trace';
import { isButtonSystemControl, repaintChildControls } from './controls';
import { isAppRegisteredClass } from './class';
import { invalidateWindow } from './paint-region';
import {
    enumerateCtlColorChildren,
    ctlColorMessageFor,
    presetCtlColorDC,
    captureCtlColorResult,
} from './control-colors';

const WM_DRAWITEM = 0x002B;
const WM_PAINT = 0x000F;
const ODT_BUTTON = 4;
const ODA_DRAWENTIRE = 0x0001;
const ODS_SELECTED = 0x0001;
const ODS_DISABLED = 0x0004;
const ODS_FOCUS = 0x0010;
const ODS_DEFAULT = 0x0020;

const BS_TYPEMASK = 0x000F;
const BS_OWNERDRAW = 0x000B;
const BS_DEFPUSHBUTTON = 0x0001;
const WS_DISABLED = 0x08000000;
const BST_PUSHED = 4;

let drawItemScratchPtr = 0;

export function resetOwnerDrawScratch(): void {
    drawItemScratchPtr = 0;
}

/** True when a window belongs to the active window's child/owned subtree. */
export function isWindowInActiveTree(win: WindowInfo, activeHwnd: number): boolean {
    let cur = win;
    let guard = 0;
    while (guard++ < 32) {
        if (cur.handle === activeHwnd) return true;
        if (cur.parent === undefined) break;
        const p = windows.get(cur.parent);
        if (!p) break;
        cur = p;
    }
    return false;
}

/** Suppress stale hover-timer repaints from an occluded menu. */
function isButtonOnActiveWindowTree(button: WindowInfo): boolean {
    const active = System.getInstance().windowManager.getActiveHwnd();
    if (!active) return true; // no active window tracked — don't over-suppress
    return isWindowInActiveTree(button, active);
}

function getDrawItemScratchPtr(process: Process): number {
    if (!drawItemScratchPtr) {
        drawItemScratchPtr = process.memory.alloc(64, 'THUNK_DATA', 'rw');
    }
    return drawItemScratchPtr;
}

export function enumerateOwnerDrawChildren(parentHwnd: number): WindowInfo[] {
    const parent = windows.get(parentHwnd);
    if (!parent) return [];
    const out: WindowInfo[] = [];
    for (const childHwnd of parent.children) {
        const child = windows.get(childHwnd);
        if (!child || !child.visible) continue;
        if (!isButtonSystemControl(child)) continue;
        if ((child.style & BS_TYPEMASK) !== BS_OWNERDRAW) continue;
        out.push(child);
    }
    return out;
}

/**
 * Child controls whose pixels only the GUEST can produce. Windows runs each control's own
 * window proc to paint it; we mirror that by delivering WM_PAINT so the guest draws its
 * real content into a client DC seeded from the overlay. Two cases:
 *
 *   • a subclassed system control (MFC custom CStatic that took over WM_PAINT), and
 *   • a control of a class the APP registered — a custom control. This one has no
 *     fallback at all: there is no default chrome for an app class, so a custom control
 *     we never send WM_PAINT to is simply invisible for the life of the dialog (HL's
 *     CODSliderCls sliders: created, sized, clickable, and blank).
 *
 * Buttons are excluded — owner-draw buttons take the WM_DRAWITEM path above, and
 * non-owner-draw buttons paint as default chrome.
 */
export function isGuestPaintedControl(child: WindowInfo | undefined): boolean {
    if (!child || !child.visible || !child.wndProc) return false;
    if (isButtonSystemControl(child)) return false;
    if (child.externalPaintManaged) return false;
    const custom = !child.isSystemControl && isAppRegisteredClass(child.nativeClassName);
    return !!child.wndProcSubclassed || custom;
}

export function enumerateGuestPaintedControls(parentHwnd: number): WindowInfo[] {
    const parent = windows.get(parentHwnd);
    if (!parent) return [];
    const out: WindowInfo[] = [];
    for (const childHwnd of parent.children) {
        const child = windows.get(childHwnd);
        if (isGuestPaintedControl(child)) out.push(child!);
    }
    return out;
}

function mapButtonItemState(child: WindowInfo): number {
    let state = 0;
    const check = buttonCheckStates.get(child.handle) ?? 0;
    if ((check & BST_PUSHED) !== 0) state |= ODS_SELECTED;
    if ((child.style & WS_DISABLED) !== 0) state |= ODS_DISABLED;
    const buttonType = child.style & BS_TYPEMASK;
    if (buttonType === BS_DEFPUSHBUTTON) state |= ODS_DEFAULT;
    return state;
}

function writeDrawItemStruct(
    mem: Uint8Array,
    ptr: number,
    child: WindowInfo,
    hdc: number,
): void {
    const ctlId = child.controlId ?? 0;
    const itemState = mapButtonItemState(child);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(ptr + 0, ODT_BUTTON, true);
    view.setUint32(ptr + 4, ctlId >>> 0, true);
    view.setUint32(ptr + 8, 0, true); // itemID (buttons)
    view.setUint32(ptr + 12, ODA_DRAWENTIRE, true);
    view.setUint32(ptr + 16, itemState >>> 0, true);
    view.setUint32(ptr + 20, child.handle >>> 0, true);
    view.setUint32(ptr + 24, hdc >>> 0, true);
    view.setInt32(ptr + 28, 0, true);
    view.setInt32(ptr + 32, 0, true);
    view.setInt32(ptr + 36, child.width, true);
    view.setInt32(ptr + 40, child.height, true);
    view.setUint32(ptr + 44, 0, true);
}

/** Per-child DC plumbing supplied by the EndPaint caller (which owns the GDI ctx). */
export interface OwnerDrawDeps {
    /** Create a client memory DC for the child, positioned at its screen rect and
     *  seeded from the overlay (so the just-flushed background shows through). */
    createChildDC: (childHwnd: number) => number;
    /** Composite the child DC onto the overlay (on top of the background) + release it. */
    flushChildDC: (childDc: number) => void;
    /** Release a child DC WITHOUT compositing it. */
    discardChildDC: (childDc: number) => void;
    /** Called after the complete owner-draw sequence has landed on the overlay. */
    onComplete?: () => void;
}

/** One guest-paint task: an owner-draw button (WM_DRAWITEM into a DC we supply), a
 *  subclassed control (WM_PAINT to its own proc, which BeginPaint/EndPaints itself),
 *  or a WM_CTLCOLOR* color query to the parent (result cached, control repainted). */
interface PaintTask {
    kind: 'drawitem' | 'paint' | 'ctlcolor';
    child: WindowInfo;
}

/** Where WM_DRAWITEM is delivered: the owner-draw button's PARENT (which draws the tile). */
interface DrawItemTarget {
    hwnd: number;
    wndProc: number;
}

/** Resume point for a thunk that was itself invoked from a callback stub (CallWindowProc
 *  reaching DefDlgProc): it returns through its own RET N, not an outer suspended frame. */
export interface DirectThunkReturn {
    returnAddr: number;
    postEsp: number;
}

/**
 * Shared runner: serialize a list of guest-paint tasks one at a time, suspending the
 * calling thunk until the whole chain finishes (the thunk then returns TRUE/1).
 *   • 'drawitem' → WM_DRAWITEM to `drawItemTarget.wndProc`, drawing into a per-child
 *     client DC (seeded from the overlay) that we composite on top once it returns.
 *   • 'paint' → WM_PAINT to the CONTROL's own wndProc; the guest's BeginPaint/EndPaint
 *     create and composite the DC themselves (no DC plumbing here).
 * Returns a suspended-thunk ThunkResult, or null if nothing could be dispatched (the
 * caller then finalizes normally).
 */
function runGuestPaintChain(
    ctx: { esp: number },
    mem: Uint8Array,
    tasks: PaintTask[],
    drawItemTarget: DrawItemTarget,
    deps: OwnerDrawDeps,
    thunkName: string,
    stackCleanup: number,
    existingFrameId?: number,
    directReturn?: DirectThunkReturn,
): ThunkResult | null {
    if (tasks.length === 0) return null;

    const system = System.getInstance();
    const process = system.process;
    const callbackManager = process?.dispatcher?.callbackManager;
    if (!callbackManager || !process) return null;

    // Three ways to get back here after a task's guest callback:
    //  • directReturn — the calling thunk was itself invoked from a callback stub, so it
    //    resumes through its own RET N rather than consuming an outer suspended frame;
    //  • existingFrameId — an earlier step of the same paint (the default WM_PAINT sends
    //    WM_ERASEBKGND first) already saved a frame, and ctx.esp now belongs to it;
    //  • otherwise save one from this thunk's own stack.
    let frameId = existingFrameId ?? 0;
    if (!frameId && !directReturn) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const thunkReturnAddr = view.getUint32(ctx.esp, true);
        frameId = callbackManager.saveSuspendedThunkContext(
            { ...ctx, returnAddr: thunkReturnAddr },
            stackCleanup,
            thunkName,
        );
    }
    if (frameId === 0 && !directReturn) return null;

    const invokeTask = (target: number, cbArgs: number[], label: string): { callbackId: number } =>
        directReturn
            ? callbackManager.invokeCallback(
                target, cbArgs, 0, undefined, false, label, undefined,
                { directThunkReturn: { ...directReturn, complete: onTaskComplete } })
            : callbackManager.invokeCallback(
                target, cbArgs, 0, onTaskComplete, false, label, frameId);

    const scratchPtr = getDrawItemScratchPtr(process);
    let taskIndex = 0;
    let pendingDc = 0; // DC of the owner-draw button whose WM_DRAWITEM is in flight
    let pendingCtlColor: WindowInfo | null = null; // control whose WM_CTLCOLOR* is in flight
    let ctlColorsChanged = false;
    let holdReleased = false;

    // The chain owns ONE publish hold and every exit path has to give it back exactly
    // once — completion, a throw out of a guest callback, or a page teardown that
    // destroys the controls mid-sequence. A hold left standing withholds the plane until
    // the fail-open deadline, i.e. the erase reaches the screen and the repaint does not.
    const releaseHold = (): void => {
        if (holdReleased) return;
        holdReleased = true;
        system.gdiContext.endOverlayPublish();
    };

    // Returns the invokeCallback callbackId (non-zero) if a task was dispatched, or 0 if
    // no further task could be dispatched (chain finished).
    const dispatchNext = (): number => {
        while (taskIndex < tasks.length) {
            // The task list was enumerated before any guest code ran, and every callback
            // since then is a chance for the guest to tear the page down. Dispatching to
            // a destroyed control sends WM_PAINT to a wndProc whose window is gone.
            if (!windows.has(drawItemTarget.hwnd)) return 0;
            const { kind, child } = tasks[taskIndex++];
            if (!windows.has(child.handle)) continue;

            if (kind === 'ctlcolor') {
                const msg = ctlColorMessageFor(child);
                if (msg === null) continue;
                const queryDc = deps.createChildDC(child.handle);
                if (!queryDc) continue;
                presetCtlColorDC(child, queryDc, msg);
                pendingDc = queryDc;
                pendingCtlColor = child;
                const inv = invokeTask(
                    drawItemTarget.wndProc,
                    [drawItemTarget.hwnd, msg, queryDc, child.handle],
                    `${thunkName}-WM_CTLCOLOR`,
                );
                if (inv.callbackId !== 0) return inv.callbackId;
                deps.discardChildDC(pendingDc);
                pendingDc = 0;
                pendingCtlColor = null;
                continue;
            }

            if (kind === 'paint') {
                // The control paints itself: deliver WM_PAINT to its own wndProc. The
                // guest's BeginPaint returns a client DC seeded from the overlay and its
                // EndPaint composites the result back — no DC plumbing needed here.
                // This direct delivery satisfies any coalesced WM_PAINT already waiting
                // for the control; leaving it queued paints transparent glyphs twice.
                // The parent just repainted the ground under this control, so its whole
                // client is invalid AND needs erasing — the same state Win32 leaves after
                // a parent's erase runs under a non-WS_CLIPCHILDREN child. Without the
                // invalidate the paint arrives with fErase FALSE and the control draws
                // over its own previous output (glyphs thicken with every repaint).
                invalidateWindow(child.handle, null, true);
                System.getInstance().windowManager.clearPaintMessage(child.handle);
                const inv = invokeTask(
                    child.wndProc,
                    [child.handle, WM_PAINT, 0, 0],
                    `${thunkName}-WM_PAINT`,
                );
                if (inv.callbackId !== 0) return inv.callbackId;
                continue;
            }

            // Owner-draw button: draw into a per-child DC we supply via DRAWITEMSTRUCT.
            const childDc = deps.createChildDC(child.handle);
            if (!childDc) {
                Logger.warn(LogCategory.USER32,
                    `${thunkName} owner-draw: no DC for child 0x${child.handle.toString(16)}`);
                continue;
            }
            pendingDc = childDc;
            writeDrawItemStruct(mem, scratchPtr, child, childDc);
            const ctlId = (child.controlId ?? 0) & 0xFFFF;
            const inv = invokeTask(
                drawItemTarget.wndProc,
                [drawItemTarget.hwnd, WM_DRAWITEM, ctlId, scratchPtr],
                `${thunkName}-WM_DRAWITEM`,
            );
            if (inv.callbackId !== 0) return inv.callbackId;
            // Dispatch failed: flush whatever (empty) DC and try the next task.
            deps.flushChildDC(pendingDc);
            pendingDc = 0;
        }
        return 0;
    };

    const onTaskComplete = (ret: number): number | null => {
        try {
            // WM_CTLCOLOR* answer: cache the DC's text/bk colors + returned HBRUSH. The
            // query DC is DISCARDED, never composited — it is seeded from an ancestor's
            // retained client backing (createWindowClientDC), so flushing it would stamp
            // that backdrop over the control's current pixels once per query.
            if (pendingCtlColor) {
                if (captureCtlColorResult(pendingCtlColor, pendingDc, ret >>> 0)) {
                    ctlColorsChanged = true;
                }
                pendingCtlColor = null;
                if (pendingDc) {
                    deps.discardChildDC(pendingDc);
                    pendingDc = 0;
                }
            }
            // Composite the owner-draw button's DC (no-op for self-painting controls).
            if (pendingDc) {
                deps.flushChildDC(pendingDc);
                pendingDc = 0;
            }
            if (dispatchNext() !== 0) return null; // suspended for the next task; hold stays
            // Apply freshly-captured guest colors in the same paint sequence.
            if (ctlColorsChanged) repaintChildControls(drawItemTarget.hwnd);
            deps.onComplete?.();
        } catch (err) {
            Logger.error(LogCategory.USER32, `${thunkName}: guest-paint chain aborted — ${err}`);
        }
        // Sequence over (finished, or abandoned mid-flight) — publish the plane either
        // way; withholding it past this point can only show the screen a stale erase.
        releaseHold();
        return 1; // calling thunk returns TRUE
    };

    // Hold publication across the whole chain: each task is a guest callback, so the
    // states between them (background painted, controls not yet) span display frames and
    // would otherwise be composited as a flash of missing controls.
    system.gdiContext.beginOverlayPublish();
    let firstCallbackId = 0;
    try {
        firstCallbackId = dispatchNext();
    } catch (err) {
        Logger.error(LogCategory.USER32, `${thunkName}: guest-paint chain failed to start — ${err}`);
    }
    if (firstCallbackId === 0) {
        releaseHold();
        return null; // nothing dispatched; caller finalizes
    }

    Logger.log(LogCategory.USER32,
        `${thunkName}: guest-paint chain tasks=${tasks.length} drawItemTarget=0x${drawItemTarget.hwnd.toString(16)}`);

    return {
        value: 1,
        suspendedForCallback: true,
        callbackId: firstCallbackId,
        stackCleanup,
    };
}

/**
 * During a dialog's EndPaint — AFTER its background was flushed to the overlay — let the
 * guest paint the controls it owns (owner-draw buttons + subclassed controls). Returns a
 * suspended-thunk result (EndPaint returns TRUE once the chain finishes), or null if
 * there is nothing to do (caller returns normally).
 */
export function tryEndPaintOwnerDrawChain(
    ctx: { esp: number },
    mem: Uint8Array,
    hWnd: number,
    window: WindowInfo,
    deps: OwnerDrawDeps,
    stackCleanup = 8, // EndPaint(hWnd, lpPaint) — 2 stdcall args
    existingFrameId?: number,
    directReturn?: DirectThunkReturn,
): ThunkResult | null {
    if (!window.wndProc) {
        if (paintTraceEnabled) logOwnerDrawChain(hWnd, { ctlcolor: 0, drawitem: 0, paint: 0 }, 'no-wndProc');
        return null;
    }
    const ctlColor = enumerateCtlColorChildren(hWnd);
    const drawItem = enumerateOwnerDrawChildren(hWnd);
    const guestPainted = enumerateGuestPaintedControls(hWnd);
    const tasks: PaintTask[] = [
        ...ctlColor.map((child): PaintTask => ({ kind: 'ctlcolor', child })),
        ...drawItem.map((child): PaintTask => ({ kind: 'drawitem', child })),
        ...guestPainted.map((child): PaintTask => ({ kind: 'paint', child })),
    ];
    const result = runGuestPaintChain(
        ctx, mem, tasks,
        { hwnd: hWnd, wndProc: window.wndProc },
        deps, 'EndPaint', stackCleanup, existingFrameId, directReturn,
    );
    if (paintTraceEnabled) {
        logOwnerDrawChain(
            hWnd,
            { ctlcolor: ctlColor.length, drawitem: drawItem.length, paint: guestPainted.length },
            result ? 'dispatched' : (tasks.length === 0 ? 'no-tasks' : 'not-dispatched'),
        );
    }
    return result;
}

/**
 * Re-render ONE owner-draw button on demand (e.g. when its own RedrawWindow fires from a
 * hover-glow timer). Sends a single WM_DRAWITEM to the button's PARENT wndProc, into a
 * client DC seeded from the overlay (so the background shows through), then composites it
 * on top — exactly one iteration of the EndPaint chain. The guest computes any hover-glow
 * blend itself from the button object's own timing state. Returns a suspended-thunk result
 * (the calling thunk returns TRUE once the repaint finishes), or null to finalize normally.
 */
export function tryRepaintOwnerDrawButton(
    ctx: { esp: number },
    mem: Uint8Array,
    button: WindowInfo,
    deps: OwnerDrawDeps,
    thunkName: string,
    stackCleanup: number,
): ThunkResult | null {
    if (!button.visible || button.parent === undefined) return null;
    if (!isButtonSystemControl(button)) return null;
    if ((button.style & BS_TYPEMASK) !== BS_OWNERDRAW) return null;
    // Guard against ghosts: a hover timer on a now-occluded menu (e.g. after a modal
    // submenu opened on top) must NOT composite its button onto the flat overlay over
    // the dialog drawn above it. Nested dialogs may themselves be the active HWND.
    if (!isButtonOnActiveWindowTree(button)) return null;
    const parent = windows.get(button.parent);
    if (!parent?.wndProc) return null;
    return runGuestPaintChain(
        ctx, mem,
        [{ kind: 'drawitem', child: button }],
        { hwnd: parent.handle, wndProc: parent.wndProc },
        deps, thunkName, stackCleanup,
    );
}
