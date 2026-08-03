/**
 * Generic Win32 activation message delivery (WM_ACTIVATEAPP / WM_ACTIVATE / focus).
 * Used whenever the active top-level window changes so guest OnActivate handlers run.
 */
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { windows } from './shared-state';

export const WM_ACTIVATE = 0x0006;
export const WM_SETFOCUS = 0x0007;
export const WM_KILLFOCUS = 0x0008;
export const WM_ACTIVATEAPP = 0x001c;

export const WA_INACTIVE = 0;
export const WA_ACTIVE = 1;
export const WA_CLICKACTIVE = 2;

export interface ActivationStep {
    hwnd: number;
    wndProc: number;
    msg: number;
    wParam: number;
    lParam: number;
}

function resolveWndProc(hwnd: number): number {
    return windows.get(hwnd)?.wndProc ?? 0;
}

/** Current wndProc for activation delivery (subclass may change between steps). */
export function resolveActivationWndProc(hwnd: number, fallback = 0): number {
    return resolveWndProc(hwnd) || fallback;
}

/** First activation on a hwnd that is already active but never received WM_ACTIVATE. */
export function buildInitialActivationSteps(hwnd: number, wndProc: number): ActivationStep[] {
    if (!hwnd || !wndProc) return [];
    return [
        { hwnd, wndProc, msg: WM_ACTIVATEAPP, wParam: 1, lParam: 0 },
        { hwnd, wndProc, msg: WM_ACTIVATE, wParam: WA_ACTIVE, lParam: 0 },
        { hwnd, wndProc, msg: WM_SETFOCUS, wParam: 0, lParam: 0 },
    ];
}

/** Ordered activation/deactivation steps for synchronous delivery via invokeCallback. */
export function buildActivationSteps(
    newHwnd: number,
    newWndProc: number,
    prevHwnd: number,
): ActivationStep[] {
    const steps: ActivationStep[] = [];
    if (prevHwnd && prevHwnd !== newHwnd) {
        const prevProc = resolveWndProc(prevHwnd);
        if (prevProc) {
            steps.push({ hwnd: prevHwnd, wndProc: prevProc, msg: WM_ACTIVATEAPP, wParam: 0, lParam: 0 });
            steps.push({ hwnd: prevHwnd, wndProc: prevProc, msg: WM_ACTIVATE, wParam: WA_INACTIVE, lParam: newHwnd >>> 0 });
            steps.push({ hwnd: prevHwnd, wndProc: prevProc, msg: WM_KILLFOCUS, wParam: newHwnd >>> 0, lParam: 0 });
        }
    }
    if (newHwnd && newWndProc) {
        steps.push({ hwnd: newHwnd, wndProc: newWndProc, msg: WM_ACTIVATEAPP, wParam: 1, lParam: 0 });
        steps.push({ hwnd: newHwnd, wndProc: newWndProc, msg: WM_ACTIVATE, wParam: WA_ACTIVE, lParam: prevHwnd >>> 0 });
        steps.push({ hwnd: newHwnd, wndProc: newWndProc, msg: WM_SETFOCUS, wParam: prevHwnd >>> 0, lParam: 0 });
    }
    return steps;
}

/** Pending delivery: initial steps if hwnd is already active, full transition otherwise. */
export function buildPendingActivationSteps(
    hwnd: number,
    wndProc: number,
    prevHwnd: number,
): ActivationStep[] {
    if (!hwnd || !wndProc) return [];
    if (!prevHwnd || prevHwnd === hwnd) {
        return buildInitialActivationSteps(hwnd, wndProc);
    }
    return buildActivationSteps(hwnd, wndProc, prevHwnd);
}

export function markPendingActivation(hwnd: number): void {
    const win = windows.get(hwnd);
    if (win) win.activationDelivered = false;
}

export function markActivationDelivered(hwnd: number): void {
    const win = windows.get(hwnd);
    if (win) win.activationDelivered = true;
}

export function needsActivationDelivery(hwnd: number): boolean {
    const win = windows.get(hwnd);
    return win !== undefined && win.activationDelivered !== true;
}

export function isDialogInitInProgress(hwnd: number): boolean {
    return windows.get(hwnd)?.dialogInitInProgress === true;
}

export function isCreateInProgress(hwnd: number): boolean {
    return windows.get(hwnd)?.createInProgress === true;
}

/** WM_NCCREATE/WM_CREATE or WM_INITDIALOG callback still in flight. */
export function isWindowInitInProgress(hwnd: number): boolean {
    const win = windows.get(hwnd);
    return !!(win?.createInProgress || win?.dialogInitInProgress);
}

/**
 * Post deactivation to prevHwnd and activation to newHwnd (real Windows order).
 * lParam of WM_ACTIVATE is the other window handle being (de)activated.
 */
export function postActivationTransition(newHwnd: number, prevHwnd: number): void {
    const wm = System.getInstance().windowManager;
    if (prevHwnd && prevHwnd !== newHwnd) {
        wm.postMessage(prevHwnd, WM_ACTIVATEAPP, 0, 0);
        wm.postMessage(prevHwnd, WM_ACTIVATE, WA_INACTIVE, newHwnd >>> 0);
        wm.postMessage(prevHwnd, WM_KILLFOCUS, newHwnd >>> 0, 0);
        markPendingActivation(prevHwnd);
    }
    if (newHwnd) {
        wm.postMessage(newHwnd, WM_ACTIVATEAPP, 1, 0);
        wm.postMessage(newHwnd, WM_ACTIVATE, WA_ACTIVE, prevHwnd >>> 0);
        wm.postMessage(newHwnd, WM_SETFOCUS, prevHwnd >>> 0, 0);
        // Queued counts as delivered for the needsActivationDelivery gate. Without this,
        // a guest that calls SetForegroundWindow/SetFocus from its WM_ACTIVATE handler
        // re-posts the triplet on every dispatch → the message queue never drains →
        // the game's PeekMessage pump never exits → engine Tick starves (HP EA-splash freeze).
        markActivationDelivered(newHwnd);
    }
}

/** First visible top-level window at CreateWindow time (no previous active hwnd). */
export function postInitialActivationMessages(hwnd: number): void {
    if (!hwnd) return;
    const wm = System.getInstance().windowManager;
    wm.postMessage(hwnd, WM_ACTIVATEAPP, 1, 0);
    wm.postMessage(hwnd, WM_ACTIVATE, WA_ACTIVE, 0);
    wm.postMessage(hwnd, WM_SETFOCUS, 0, 0);
    markActivationDelivered(hwnd); // queued counts as delivered (see postActivationTransition)
}

/**
 * Change active window and post matching activation messages when the hwnd changes.
 * Returns previous active hwnd (Win32 SetActiveWindow contract).
 */
const WS_CHILD = 0x40000000;

/** Resolve SetForegroundWindow targets: foreground is always top-level; focus may be a child. */
export function resolveForegroundTargets(hwnd: number): { topLevel: number; focusHwnd: number } {
    if (!hwnd) return { topLevel: 0, focusHwnd: 0 };
    const wm = System.getInstance().windowManager;
    let cur = wm.getWindow(hwnd);
    if (!cur) return { topLevel: hwnd, focusHwnd: hwnd };
    if ((cur.style & WS_CHILD) === 0) return { topLevel: hwnd, focusHwnd: hwnd };
    let top = hwnd;
    while (cur?.parent) {
        top = cur.parent;
        cur = wm.getWindow(top);
    }
    return { topLevel: top, focusHwnd: hwnd };
}

/**
 * Set foreground to a top-level window and deliver focus/activation to focusHwnd
 * (may equal topLevel or be a child that receives WM_SETFOCUS / WM_ACTIVATE).
 */
export function setForegroundWithFocus(topLevel: number, focusHwnd: number): number {
    const wm = System.getInstance().windowManager;
    const prevActive = wm.getActiveHwnd();
    if (!topLevel) return prevActive;

    const topWin = wm.getWindow(topLevel);
    if (!topWin || (topWin.style & WS_CHILD) !== 0) return prevActive;

    const focus = focusHwnd || topLevel;
    const focusProc = resolveWndProc(focus);

    if (topLevel === prevActive) {
        if (!needsActivationDelivery(focus)) return prevActive;
        if (focus === topLevel) {
            postInitialActivationMessages(topLevel);
        } else if (focusProc) {
            wm.postMessage(focus, WM_ACTIVATE, WA_ACTIVE, prevActive >>> 0);
            wm.postMessage(focus, WM_SETFOCUS, prevActive >>> 0, 0);
            markActivationDelivered(focus); // queued counts as delivered
        }
        return prevActive;
    }

    wm.setActiveWindow(topLevel);
    postActivationTransition(topLevel, prevActive);
    if (focus !== topLevel && focusProc) {
        wm.postMessage(focus, WM_ACTIVATE, WA_ACTIVE, prevActive >>> 0);
        wm.postMessage(focus, WM_SETFOCUS, prevActive >>> 0, 0);
        markActivationDelivered(focus); // queued counts as delivered
    }
    Logger.verbose(LogCategory.USER32,
        `setForegroundWithFocus: top=0x${topLevel.toString(16)} focus=0x${focus.toString(16)} prev=0x${prevActive.toString(16)}`);
    return prevActive;
}

/**
 * Activate an owned (in-process) dialog: WM_ACTIVATE/focus transition WITHOUT
 * WM_ACTIVATEAPP. Windows only sends WM_ACTIVATEAPP when activation crosses
 * processes; for a game's own dialog over its fullscreen window, sending
 * WM_ACTIVATEAPP(0) to the main window would make the game believe it lost
 * the foreground (pause/minimize handlers fire). Used for dialogs created
 * visible over a DDraw flip chain (e.g. Tiberian Sun "Select Campaign").
 */
export function activateOwnedDialog(hwnd: number): number {
    const wm = System.getInstance().windowManager;
    const prevActive = wm.getActiveHwnd();
    if (!hwnd) return prevActive;

    const win = wm.getWindow(hwnd);
    if (!win || (win.style & WS_CHILD) !== 0) return prevActive;

    if (hwnd === prevActive) {
        if (needsActivationDelivery(hwnd)) {
            wm.postMessage(hwnd, WM_ACTIVATE, WA_ACTIVE, 0);
            wm.postMessage(hwnd, WM_SETFOCUS, 0, 0);
            markActivationDelivered(hwnd);
        }
        return prevActive;
    }

    wm.setActiveWindow(hwnd);
    if (prevActive) {
        wm.postMessage(prevActive, WM_ACTIVATE, WA_INACTIVE, hwnd >>> 0);
        wm.postMessage(prevActive, WM_KILLFOCUS, hwnd >>> 0, 0);
    }
    wm.postMessage(hwnd, WM_ACTIVATE, WA_ACTIVE, prevActive >>> 0);
    wm.postMessage(hwnd, WM_SETFOCUS, prevActive >>> 0, 0);
    markActivationDelivered(hwnd);
    Logger.verbose(LogCategory.USER32,
        `activateOwnedDialog: 0x${prevActive.toString(16)} -> 0x${hwnd.toString(16)} (no WM_ACTIVATEAPP)`);
    return prevActive;
}

export function activateTopLevelWindow(newHwnd: number): number {
    const system = System.getInstance();
    const wm = system.windowManager;
    const prevActive = wm.getActiveHwnd();
    if (!newHwnd) return prevActive;

    const win = wm.getWindow(newHwnd);
    if (!win || (win.style & 0x40000000) !== 0) {
        // WS_CHILD — cannot become active
        return prevActive;
    }

    if (newHwnd === prevActive) {
        // CreateDialog keeps hwnd active from createWindow, but WM_ACTIVATE may
        // not have been delivered yet (WM_INITDIALOG still running nested pump).
        if (!needsActivationDelivery(newHwnd)) return prevActive;
        const win = windows.get(newHwnd);
        if (win?.createInProgress || win?.dialogInitInProgress) {
            Logger.verbose(LogCategory.USER32,
                `activateTopLevelWindow: defer activation on 0x${newHwnd.toString(16)} ` +
                `(${win.createInProgress ? 'WM_CREATE' : 'WM_INITDIALOG'} in progress)`);
            return prevActive;
        }
        postInitialActivationMessages(newHwnd);
        Logger.verbose(LogCategory.USER32,
            `activateTopLevelWindow: queued pending activation on 0x${newHwnd.toString(16)}`);
        return prevActive;
    }

    wm.setActiveWindow(newHwnd);
    postActivationTransition(newHwnd, prevActive);
    Logger.verbose(LogCategory.USER32,
        `activateTopLevelWindow: 0x${prevActive.toString(16)} -> 0x${newHwnd.toString(16)}`);
    return prevActive;
}

/** After an owned popup closes, reactivate its owner (GetWindow(hWnd, GW_OWNER) semantics). */
export function reactivateOwnerIfNeeded(closedHwnd: number, ownerHwnd = 0): void {
    const wm = System.getInstance().windowManager;
    const owner = ownerHwnd || wm.getWindow(closedHwnd)?.parent || 0;
    if (!owner || !wm.getWindow(owner)) return;

    const active = wm.getActiveHwnd();
    // An owner cannot take activation while another visible owned popup is still above
    // it. Nested MFC pages commonly share the application's main window as their nominal
    // owner; closing the inner page must therefore return to the remaining outer page.
    const ownedSuccessor = wm.getZOrder().find(candidate => {
        if (candidate === closedHwnd) return false;
        const candidateInfo = windows.get(candidate);
        return candidateInfo?.parent === owner
            && candidateInfo.visible
            && !candidateInfo.pendingDestroy
            && (candidateInfo.style & 0x40000000 /* WS_CHILD */) === 0
            && (candidateInfo.style & 0x08000000 /* WS_DISABLED */) === 0;
    }) ?? 0;
    if (ownedSuccessor && active === owner) {
        activateTopLevelWindow(ownedSuccessor);
        return;
    }
    const ownerWin = windows.get(owner);
    if (ownerWin?.dialogInitInProgress || ownerWin?.createInProgress) {
        // Owner still in WM_INITDIALOG (e.g. intro modal closed via EndDialog) or
        // CreateWindowEx WM_CREATE (child HWNDs not registered yet). Restore active
        // hwnd only; defer WM_ACTIVATE/WM_SIZE/WM_PAINT until init/create completes.
        if (active === closedHwnd || active === 0) {
            wm.setActiveWindow(owner);
        }
        Logger.verbose(LogCategory.USER32,
            `reactivateOwnerIfNeeded: restore active owner=0x${owner.toString(16)} ` +
            `(defer wndproc — ${ownerWin.dialogInitInProgress ? 'WM_INITDIALOG' : 'WM_CREATE'} in progress)`);
        return;
    }
    // A pending activation on the owner is not permission to steal activation from
    // a different window. MFC restores its previously-active nested dialog between
    // EndDialog and DestroyWindow; the closed dialog's nominal parent may still be
    // the application's root window. Only deliver the owner's pending activation
    // when that owner is already active, or choose it when the closed window/NULL
    // still owns activation.
    if (active === closedHwnd || active === 0
        || (active === owner && needsActivationDelivery(owner))) {
        activateTopLevelWindow(owner);
    }
}
