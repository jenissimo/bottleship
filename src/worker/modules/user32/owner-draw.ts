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
import { isButtonSystemControl, repaintChildControls } from './controls';
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

/** Walk a window up to its top-level (non-child) ancestor. */
function topLevelOf(win: WindowInfo): WindowInfo {
    let cur = win;
    let guard = 0;
    while (cur.parent !== undefined && guard++ < 32) {
        const p = windows.get(cur.parent);
        if (!p) break;
        cur = p;
    }
    return cur;
}

/** True if the button's top-level dialog is the currently active window. Used to suppress
 *  stale hover-timer repaints from an occluded menu (a modal submenu drawn on top). */
function isButtonOnActiveTopLevel(button: WindowInfo): boolean {
    const active = System.getInstance().windowManager.getActiveHwnd();
    if (!active) return true; // no active window tracked — don't over-suppress
    return topLevelOf(button).handle === active;
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
 * Subclassed non-button system controls (e.g. an MFC custom CStatic that paints
 * itself). Windows runs each control's own window proc to paint it; we mirror that
 * by delivering WM_PAINT so the guest draws its real content (text, colours) into a
 * client DC seeded from the overlay. Buttons are excluded — owner-draw buttons take
 * the WM_DRAWITEM path above, and non-owner-draw buttons paint as default chrome.
 */
export function enumerateGuestPaintedControls(parentHwnd: number): WindowInfo[] {
    const parent = windows.get(parentHwnd);
    if (!parent) return [];
    const out: WindowInfo[] = [];
    for (const childHwnd of parent.children) {
        const child = windows.get(childHwnd);
        if (!child || !child.visible) continue;
        if (!child.wndProcSubclassed || !child.wndProc) continue;
        if (isButtonSystemControl(child)) continue;
        out.push(child);
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
): ThunkResult | null {
    if (tasks.length === 0) return null;

    const system = System.getInstance();
    const process = system.process;
    const callbackManager = process?.dispatcher?.callbackManager;
    if (!callbackManager || !process) return null;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const thunkReturnAddr = view.getUint32(ctx.esp, true);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: thunkReturnAddr },
        stackCleanup,
        thunkName,
    );
    if (frameId === 0) return null;

    const scratchPtr = getDrawItemScratchPtr(process);
    let taskIndex = 0;
    let pendingDc = 0; // DC of the owner-draw button whose WM_DRAWITEM is in flight
    let pendingCtlColor: WindowInfo | null = null; // control whose WM_CTLCOLOR* is in flight
    let ctlColorsChanged = false;

    // Returns the invokeCallback callbackId (non-zero) if a task was dispatched, or 0 if
    // no further task could be dispatched (chain finished).
    const dispatchNext = (): number => {
        while (taskIndex < tasks.length) {
            const { kind, child } = tasks[taskIndex++];

            if (kind === 'ctlcolor') {
                const msg = ctlColorMessageFor(child);
                if (msg === null) continue;
                const queryDc = deps.createChildDC(child.handle);
                if (!queryDc) continue;
                presetCtlColorDC(child, queryDc, msg);
                pendingDc = queryDc;
                pendingCtlColor = child;
                const inv = callbackManager.invokeCallback(
                    drawItemTarget.wndProc,
                    [drawItemTarget.hwnd, msg, queryDc, child.handle],
                    0,
                    onTaskComplete,
                    false,
                    `${thunkName}-WM_CTLCOLOR`,
                    frameId,
                );
                if (inv.callbackId !== 0) return inv.callbackId;
                deps.flushChildDC(pendingDc);
                pendingDc = 0;
                pendingCtlColor = null;
                continue;
            }

            if (kind === 'paint') {
                // The control paints itself: deliver WM_PAINT to its own wndProc. The
                // guest's BeginPaint returns a client DC seeded from the overlay and its
                // EndPaint composites the result back — no DC plumbing needed here.
                const inv = callbackManager.invokeCallback(
                    child.wndProc,
                    [child.handle, WM_PAINT, 0, 0],
                    0,
                    onTaskComplete,
                    false,
                    `${thunkName}-WM_PAINT`,
                    frameId,
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
            const inv = callbackManager.invokeCallback(
                drawItemTarget.wndProc,
                [drawItemTarget.hwnd, WM_DRAWITEM, ctlId, scratchPtr],
                0,
                onTaskComplete,
                false,
                `${thunkName}-WM_DRAWITEM`,
                frameId,
            );
            if (inv.callbackId !== 0) return inv.callbackId;
            // Dispatch failed: flush whatever (empty) DC and try the next task.
            deps.flushChildDC(pendingDc);
            pendingDc = 0;
        }
        return 0;
    };

    const onTaskComplete = (ret: number): number | null => {
        // WM_CTLCOLOR* answer: cache the DC's text/bk colors + returned HBRUSH.
        if (pendingCtlColor) {
            if (captureCtlColorResult(pendingCtlColor, pendingDc, ret >>> 0)) {
                ctlColorsChanged = true;
            }
            pendingCtlColor = null;
        }
        // Composite the owner-draw button's DC (no-op for self-painting controls;
        // a ctlcolor query DC was seeded from the overlay, so this is a visual no-op).
        if (pendingDc) {
            deps.flushChildDC(pendingDc);
            pendingDc = 0;
        }
        if (dispatchNext() !== 0) return null; // suspended for the next task
        // Apply freshly-captured guest colors in the same paint sequence.
        if (ctlColorsChanged) repaintChildControls(drawItemTarget.hwnd);
        return 1; // all tasks done — calling thunk returns TRUE
    };

    const firstCallbackId = dispatchNext();
    if (firstCallbackId === 0) return null; // nothing dispatched; caller finalizes

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
): ThunkResult | null {
    if (!window.wndProc) return null;
    const tasks: PaintTask[] = [
        ...enumerateCtlColorChildren(hWnd).map((child): PaintTask => ({ kind: 'ctlcolor', child })),
        ...enumerateOwnerDrawChildren(hWnd).map((child): PaintTask => ({ kind: 'drawitem', child })),
        ...enumerateGuestPaintedControls(hWnd).map((child): PaintTask => ({ kind: 'paint', child })),
    ];
    const stackCleanup = 8; // EndPaint(hWnd, lpPaint) — 2 stdcall args
    return runGuestPaintChain(
        ctx, mem, tasks,
        { hwnd: hWnd, wndProc: window.wndProc },
        deps, 'EndPaint', stackCleanup,
    );
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
    // the dialog drawn above it. Only repaint buttons whose top-level dialog is active.
    if (!isButtonOnActiveTopLevel(button)) return null;
    const parent = windows.get(button.parent);
    if (!parent?.wndProc) return null;
    return runGuestPaintChain(
        ctx, mem,
        [{ kind: 'drawitem', child: button }],
        { hwnd: parent.handle, wndProc: parent.wndProc },
        deps, thunkName, stackCleanup,
    );
}
