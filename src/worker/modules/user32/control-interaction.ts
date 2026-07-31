/**
 * Shared mouse interaction for JS-managed system controls (Button / ListBox /
 * ComboBox / Trackbar). Used by BOTH message pumps:
 *   - DispatchMessageA/W (game pumps its own messages — e.g. Tiberian Sun's
 *     Select Campaign dialog runs under the game's modal loop), and
 *   - the HLE modal dialog pump in dialog.ts (DialogBoxParam*).
 *
 * All coordinates here are SCREEN (canvas) pixels; callers convert from the
 * client coords carried in mouse-message lParams.
 */

import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';
import {
    WindowInfo,
    windows,
    buttonCheckStates,
    listControlStates,
    getOrCreateListState,
    getOrCreateTrackbarState,
    getAbsoluteWindowPosition,
} from './shared-state';
import {
    repaintChildControls,
    isButtonSystemControl,
    isGroupBoxSystemControl,
    getComboDropdownRect,
    listVisibleCount,
    clampListTopIndex,
    LIST_ITEM_H,
    LIST_INSET,
    LIST_SCROLLBAR_W,
    COMBO_DROP_MAX_VISIBLE,
} from './controls';
import { setEditCaretFromPoint } from './edit-control';

const WM_MOUSEMOVE   = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP   = 0x0202;
const WM_COMMAND     = 0x0111;
const WM_HSCROLL     = 0x0114;
const WM_VSCROLL     = 0x0115;

const MK_LBUTTON = 0x0001;
const WS_DISABLED_CI = 0x08000000;

const BN_CLICKED    = 0;
const LBN_SELCHANGE = 1;
const CBN_SELCHANGE = 1;

// Trackbar WM_HSCROLL/WM_VSCROLL notification codes
const TB_THUMBPOSITION = 4;
const TB_THUMBTRACK    = 5;
const TB_ENDTRACK      = 8;

// BST_* / BS_* needed for button behavior
const BST_PUSHED = 4;

const TBS_VERT = 0x0002;
/** Track margin used by paintTrackbar (channel inset from control edges). */
const TRACKBAR_MARGIN = 8;

const BS_TYPEMASK = 0x000F;
const BS_CHECKBOX = 0x0002;
const BS_AUTOCHECKBOX = 0x0003;
const BS_RADIOBUTTON = 0x0004;
const BS_3STATE = 0x0005;
const BS_AUTO3STATE = 0x0006;
const BS_AUTORADIOBUTTON = 0x0009;
const WS_GROUP = 0x00020000;
const BST_UNCHECKED = 0;
const BST_CHECKED = 1;
const BST_INDETERMINATE = 2;

function getButtonType(button: WindowInfo): number {
    return button.style & BS_TYPEMASK;
}

/**
 * Wine/NT: BS_AUTORADIOBUTTON mutual exclusion is scoped to the WS_GROUP range
 * containing the clicked button (not every radio under the dialog).
 */
function getAutoradioGroupSiblings(parentHwnd: number, button: WindowInfo): WindowInfo[] {
    const parent = windows.get(parentHwnd);
    if (!parent) return [button];

    const siblings = parent.children
        .map((h) => windows.get(h))
        .filter((c): c is WindowInfo => !!c);
    const startIdx = siblings.findIndex((c) => c.handle === button.handle);
    if (startIdx < 0) return [button];

    let groupStart = 0;
    for (let i = 0; i <= startIdx; i++) {
        if ((siblings[i]!.style & WS_GROUP) !== 0) groupStart = i;
    }
    let groupEnd = siblings.length;
    for (let i = startIdx + 1; i < siblings.length; i++) {
        if ((siblings[i]!.style & WS_GROUP) !== 0) {
            groupEnd = i;
            break;
        }
    }

    return siblings.slice(groupStart, groupEnd).filter((s) =>
        isButtonSystemControl(s) && getButtonType(s) === BS_AUTORADIOBUTTON);
}

/** BM auto-state transitions for checkbox / 3-state / radio buttons on click. */
export function applyAutoButtonState(parentHwnd: number, button: WindowInfo): void {
    if (!isButtonSystemControl(button)) return;

    const buttonType = getButtonType(button);
    const currentState = (buttonCheckStates.get(button.handle) ?? BST_UNCHECKED) & ~BST_PUSHED;

    if (buttonType === BS_AUTOCHECKBOX) {
        buttonCheckStates.set(
            button.handle,
            currentState === BST_CHECKED ? BST_UNCHECKED : BST_CHECKED,
        );
        return;
    }

    if (buttonType === BS_AUTO3STATE) {
        const nextState = currentState === BST_UNCHECKED
            ? BST_CHECKED
            : currentState === BST_CHECKED
                ? BST_INDETERMINATE
                : BST_UNCHECKED;
        buttonCheckStates.set(button.handle, nextState);
        return;
    }

    if (buttonType === BS_AUTORADIOBUTTON) {
        for (const sibling of getAutoradioGroupSiblings(parentHwnd, button)) {
            buttonCheckStates.set(
                sibling.handle,
                sibling.handle === button.handle ? BST_CHECKED : BST_UNCHECKED,
            );
        }
    }
}

export function normalizedControlClass(win: WindowInfo | undefined): string {
    return (win?.systemControlClass ?? '').trim().toLowerCase();
}

function postCommand(parentHwnd: number, notifyCode: number, control: WindowInfo): void {
    const system = System.getInstance();
    const cmdWParam = ((notifyCode << 16) | ((control.controlId ?? 0) & 0xFFFF)) >>> 0;
    system.windowManager.postMessage(parentHwnd, WM_COMMAND, cmdWParam, control.handle);
    system.scheduler.wakeMessageWaiters();
}

function postScroll(control: WindowInfo, code: number, pos: number): void {
    const system = System.getInstance();
    const vertical = (control.style & TBS_VERT) !== 0 || control.height > control.width * 2;
    const msg = vertical ? WM_VSCROLL : WM_HSCROLL;
    const wParam = (((pos & 0xFFFF) << 16) | (code & 0xFFFF)) >>> 0;
    system.windowManager.postMessage(control.parent ?? 0, msg, wParam, control.handle);
    system.scheduler.wakeMessageWaiters();
}

/** Hit-test JS system controls under a screen point within hostHwnd's subtree. */
export function hitTestSystemControlAtScreenPoint(
    hostHwnd: number,
    screenX: number,
    screenY: number,
    visited: Set<number> = new Set<number>(),
): WindowInfo | undefined {
    if (visited.has(hostHwnd)) return undefined;
    visited.add(hostHwnd);

    const win = windows.get(hostHwnd);
    if (!win || !win.visible || !win.children.length) return undefined;

    for (let i = win.children.length - 1; i >= 0; i--) {
        const child = windows.get(win.children[i]);
        if (!child || !child.visible) continue;

        const { x: absX, y: absY } = getAbsoluteWindowPosition(child);
        if (screenX < absX || screenY < absY || screenX >= absX + child.width || screenY >= absY + child.height) {
            continue;
        }

        const deeper = hitTestSystemControlAtScreenPoint(child.handle, screenX, screenY, visited);
        if (deeper) return deeper;
        if (child.isSystemControl && !isGroupBoxSystemControl(child)) return child;
    }

    return undefined;
}

/** Find an open combobox dropdown in the host subtree (topmost / paint-order first). */
function findOpenCombo(hostHwnd: number, visited: Set<number> = new Set<number>()): WindowInfo | undefined {
    if (visited.has(hostHwnd)) return undefined;
    visited.add(hostHwnd);
    const win = windows.get(hostHwnd);
    if (!win) return undefined;
    // Reverse child order = topmost first (matches hit-test / paint z-order).
    for (let i = win.children.length - 1; i >= 0; i--) {
        const child = windows.get(win.children[i]!);
        if (!child) continue;
        if (child.isSystemControl
            && normalizedControlClass(child) === 'combobox'
            && listControlStates.get(child.handle)?.dropdownOpen) {
            return child;
        }
        const deeper = findOpenCombo(child.handle, visited);
        if (deeper) return deeper;
    }
    return undefined;
}

/** Close every open combobox under host except `exceptHwnd` (single-open invariant). */
export function closeOpenComboboxes(hostHwnd: number, exceptHwnd: number = 0): void {
    const win = windows.get(hostHwnd);
    if (!win) return;
    const gdi = System.getInstance().gdiContext;
    let closedAny = false;
    const walk = (hwnd: number, visited: Set<number>): void => {
        if (visited.has(hwnd)) return;
        visited.add(hwnd);
        const node = windows.get(hwnd);
        if (!node) return;
        for (const childHwnd of node.children) {
            const child = windows.get(childHwnd);
            if (!child) continue;
            if (child.handle !== exceptHwnd
                && child.isSystemControl
                && normalizedControlClass(child) === 'combobox') {
                const state = listControlStates.get(child.handle);
                if (state?.dropdownOpen) {
                    const drop = getComboDropdownRect(child);
                    state.dropdownOpen = false;
                    gdi.clearOverlayRect?.(drop.x - 1, drop.y - 1, drop.w + 2, drop.h + 2);
                    closedAny = true;
                }
            }
            walk(childHwnd, visited);
        }
    };
    walk(hostHwnd, new Set());
    if (closedAny) {
        requestFullDialogRepaint(rootDialogOf(windows.get(exceptHwnd) ?? win) ?? hostHwnd);
    }
}

function eraseAndCloseCombo(combo: WindowInfo, hostHwnd: number): void {
    const state = getOrCreateListState(combo.handle);
    if (!state.dropdownOpen) return;
    const drop = getComboDropdownRect(combo);
    state.dropdownOpen = false;
    const gdi = System.getInstance().gdiContext;
    gdi.clearOverlayRect?.(drop.x - 1, drop.y - 1, drop.w + 2, drop.h + 2);
    requestFullDialogRepaint(rootDialogOf(combo) ?? hostHwnd);
}

// --- Interaction state (single-cursor UI, module-level is fine) ---
let trackbarDragHwnd = 0;
let pressedButtonHwnd = 0;

export function resetControlInteractionState(): void {
    trackbarDragHwnd = 0;
    pressedButtonHwnd = 0;
}

function repaintHost(control: WindowInfo, hostHwnd: number): void {
    // A control inside a dialog composited over a DDraw flip chain needs the FULL
    // dialog repainted (gray face + all controls) — the overlay canvas can be wiped
    // between frames and a controls-only paint would lose the background. The full
    // repaint hook is registered by dialog.ts (avoids an import cycle).
    let cur: WindowInfo | undefined = control;
    const visited = new Set<number>();
    while (cur && !visited.has(cur.handle)) {
        if (cur.overlayOnFlipScreen) {
            fullDialogRepainter?.(cur.handle);
            return;
        }
        visited.add(cur.handle);
        cur = cur.parent ? windows.get(cur.parent) : undefined;
    }
    repaintChildControls(control.parent ?? hostHwnd);
}

function trackbarPosFromPoint(tb: WindowInfo, screenX: number, screenY: number): number {
    const state = getOrCreateTrackbarState(tb.handle);
    const { x: absX, y: absY } = getAbsoluteWindowPosition(tb);
    const vertical = (tb.style & TBS_VERT) !== 0 || tb.height > tb.width * 2;
    const trackLen = Math.max(1, (vertical ? tb.height : tb.width) - TRACKBAR_MARGIN * 2);
    const offset = vertical ? (screenY - absY - TRACKBAR_MARGIN) : (screenX - absX - TRACKBAR_MARGIN);
    const frac = Math.max(0, Math.min(1, offset / trackLen));
    return Math.round(state.min + frac * (state.max - state.min));
}

function updateTrackbar(tb: WindowInfo, hostHwnd: number, screenX: number, screenY: number, code: number): void {
    const state = getOrCreateTrackbarState(tb.handle);
    const pos = trackbarPosFromPoint(tb, screenX, screenY);
    const changed = pos !== state.pos;
    state.pos = pos;
    if (changed) repaintHost(tb, hostHwnd);
    postScroll(tb, code, pos);
}

/** Listbox: scrollbar interaction. Returns true if the point was in the scrollbar. */
function handleListScrollbarClick(list: WindowInfo, screenX: number, screenY: number): boolean {
    const state = getOrCreateListState(list.handle);
    const maxVisible = listVisibleCount(list.height);
    if (state.items.length <= maxVisible) return false;

    const { x: absX, y: absY } = getAbsoluteWindowPosition(list);
    const sbX = absX + list.width - LIST_INSET - LIST_SCROLLBAR_W;
    if (screenX < sbX || screenX >= absX + list.width - LIST_INSET) return false;

    const sbY = absY + LIST_INSET;
    const sbH = list.height - LIST_INSET * 2;
    const arrow = Math.min(14, Math.floor(sbH / 2));
    const maxTop = state.items.length - maxVisible;

    if (screenY < sbY + arrow) {
        state.topIndex -= 1;
    } else if (screenY >= sbY + sbH - arrow) {
        state.topIndex += 1;
    } else {
        const trackTop = sbY + arrow;
        const trackH = Math.max(1, sbH - arrow * 2);
        state.topIndex = Math.round(((screenY - trackTop) / trackH) * maxTop);
    }
    clampListTopIndex(state, list.height);
    return true;
}

/**
 * Handle a mouse message for hostHwnd's JS system controls (screen coordinates).
 * Returns true when consumed (caller should not forward to the guest wndProc).
 */
export function handleSystemControlMouseAtScreen(
    hostHwnd: number,
    message: number,
    wParam: number,
    screenX: number,
    screenY: number,
): boolean {
    // --- Active trackbar drag captures the mouse until release ---
    if (trackbarDragHwnd) {
        const tb = windows.get(trackbarDragHwnd);
        if (!tb || !tb.visible || tb.pendingDestroy) {
            trackbarDragHwnd = 0;
        } else if (message === WM_MOUSEMOVE) {
            if (wParam & MK_LBUTTON) {
                updateTrackbar(tb, hostHwnd, screenX, screenY, TB_THUMBTRACK);
                return true;
            }
            trackbarDragHwnd = 0; // button released outside our message stream
        } else if (message === WM_LBUTTONUP) {
            updateTrackbar(tb, hostHwnd, screenX, screenY, TB_THUMBPOSITION);
            postScroll(tb, TB_ENDTRACK, getOrCreateTrackbarState(tb.handle).pos);
            trackbarDragHwnd = 0;
            return true;
        }
    }

    // --- Open combobox dropdown eats clicks on its list / own box ---
    // Clicking elsewhere closes it, then the click falls through so another
    // combo/checkbox under the cursor can still receive the DOWN (multi-combo).
    let closedComboByClickAway = false;
    const openCombo = findOpenCombo(hostHwnd);
    if (openCombo && message === WM_LBUTTONDOWN) {
        const state = getOrCreateListState(openCombo.handle);
        const drop = getComboDropdownRect(openCombo);
        const { x: absX, y: absY } = getAbsoluteWindowPosition(openCombo);
        const inDrop = screenX >= drop.x && screenX < drop.x + drop.w
            && screenY >= drop.y && screenY < drop.y + drop.h;
        const inCombo = screenX >= absX && screenX < absX + openCombo.width
            && screenY >= absY && screenY < absY + openCombo.height;

        if (inDrop) {
            state.dropdownOpen = false;
            const idx = state.topIndex + Math.floor((screenY - drop.y - 1) / LIST_ITEM_H);
            if (idx >= 0 && idx < state.items.length && idx !== state.selectedIndex) {
                state.selectedIndex = idx;
                state.caretIndex = idx;
                // WM_GETTEXT/GetDlgItemText reads .title, not the list state — keep them
                // in sync or a combo that visibly shows the picked item still reads back
                // empty/stale text to the guest (see dialog.ts CB_SETCURSEL for the
                // programmatic-selection half of this fix).
                openCombo.title = state.items[idx].text;
                postCommand(openCombo.parent ?? hostHwnd, CBN_SELCHANGE, openCombo);
            }
            // Explicitly erase the dropdown's own rect BEFORE the general repaint below.
            // getWindowVisualBounds only extends a dialog's bounds to cover an open combo's
            // dropdown while dropdownOpen is still true (dialog-overlay.ts); by the time this
            // repaint runs dropdownOpen is already false above, so the bounds-based background
            // fill shrinks back and never touches the dropdown's leftover pixels.
            const gdi = System.getInstance().gdiContext;
            gdi.clearOverlayRect?.(drop.x - 1, drop.y - 1, drop.w + 2, drop.h + 2);
            requestFullDialogRepaint(rootDialogOf(openCombo) ?? hostHwnd);
            return true;
        }

        if (inCombo) {
            // Clicking the open combo's closed box closes it (toggle).
            eraseAndCloseCombo(openCombo, hostHwnd);
            return true;
        }

        // Click outside this combo — close, then fall through so the control under
        // the cursor (another combo, checkbox, …) still gets the DOWN.
        eraseAndCloseCombo(openCombo, hostHwnd);
        closedComboByClickAway = true;
    }

    const control = hitTestSystemControlAtScreenPoint(hostHwnd, screenX, screenY);

    cancelStalePress(message, control?.handle ?? 0, hostHwnd);

    if (!control) return closedComboByClickAway;

    // A subclassed control's wndproc IS the guest's: DispatchMessage has to reach it
    // before the class behavior runs, or a subclassed button gets a synthesized
    // BN_CLICKED and never sees the click. The class proc still runs — the guest's
    // forward to DefWindowProc lands in handleSystemControlClassMouse.
    if (control.wndProcSubclassed) return closedComboByClickAway;

    return applyControlClassMouse(control, hostHwnd, message, wParam, screenX, screenY);
}

/** A pressed pushbutton released anywhere but on itself: cancel the press (Wine
 *  button.c releases capture without notifying the parent). */
function cancelStalePress(message: number, hitHwnd: number, hostHwnd: number): void {
    if (message !== WM_LBUTTONUP || !pressedButtonHwnd || hitHwnd === pressedButtonHwnd) return;
    const pressed = windows.get(pressedButtonHwnd);
    pressedButtonHwnd = 0;
    if (!pressed) return;
    const cur = buttonCheckStates.get(pressed.handle) ?? 0;
    buttonCheckStates.set(pressed.handle, cur & ~BST_PUSHED);
    repaintHost(pressed, hostHwnd);
}

/**
 * Our stand-in for a control CLASS's own window procedure (Wine button.c
 * ButtonWndProc_common, listbox.c, combo.c): the class proc is what turns a
 * DOWN/UP pair into WM_COMMAND(BN_CLICKED) for the parent, opens a combo's
 * drop-down, moves a trackbar thumb. Reachable from every place a class proc would
 * run — the two message pumps' hit-test paths and DefWindowProc (which is where a
 * SUBCLASSED control forwards a message it did not handle).
 */
function applyControlClassMouse(
    control: WindowInfo,
    hostHwnd: number,
    message: number,
    wParam: number,
    screenX: number,
    screenY: number,
): boolean {
    const controlClass = normalizedControlClass(control);
    const parentHwnd = control.parent ?? hostHwnd;

    // Clicking an interactive control gives it focus (statics/groupboxes never take it).
    if (message === WM_LBUTTONDOWN
        && (control.style & WS_DISABLED_CI) === 0
        && (controlClass === 'edit' || controlClass === 'listbox' || controlClass === 'combobox'
            || (controlClass === 'button' && isButtonSystemControl(control)))) {
        System.getInstance().windowManager.setFocus(control.handle);
    }

    // Subclassing (SetWindowLong(GWL_WNDPROC) — MFC DDX_Control, UE1's WControl)
    // replaces a control's wndproc for message routing; it does NOT reimplement the
    // class's input behavior, so this switch must run subclassed or not.
    switch (controlClass) {
        case 'button': {
            if (!isButtonSystemControl(control)) return false;
            if (message === WM_LBUTTONDOWN) {
                const currentState = buttonCheckStates.get(control.handle) ?? 0;
                buttonCheckStates.set(control.handle, currentState | BST_PUSHED);
                pressedButtonHwnd = control.handle;
                repaintHost(control, hostHwnd);
                return true;
            }
            if (message === WM_LBUTTONUP) {
                // Real Win32: WM_LBUTTONDOWN on a button implicitly captures the mouse,
                // so only an UP received through that capture completes the click. A
                // button hit-tested at the UP position without having been the one
                // pressed (pressedButtonHwnd) isn't "its" click at all — e.g. the UP half
                // of a click whose DOWN landed on an open combobox dropdown (consumed
                // above, closing the dropdown) still falls through to whatever real
                // control now sits under the cursor once the dropdown is gone; without
                // this guard that stray UP fired a phantom BN_CLICKED on it too.
                if (control.handle !== pressedButtonHwnd) return false;
                pressedButtonHwnd = 0;
                const currentState = buttonCheckStates.get(control.handle) ?? 0;
                buttonCheckStates.set(control.handle, currentState & ~BST_PUSHED);
                applyAutoButtonState(parentHwnd, control);
                repaintHost(control, hostHwnd);
                Logger.log(LogCategory.USER32,
                    `controlMouse: Button click id=${control.controlId ?? 0} "${control.title}" -> WM_COMMAND parent=0x${parentHwnd.toString(16)}`);
                postCommand(parentHwnd, BN_CLICKED, control);
                return true;
            }
            return false;
        }

        case 'listbox': {
            if (message !== WM_LBUTTONDOWN) return message === WM_LBUTTONUP; // eat the matching UP
            const state = getOrCreateListState(control.handle);
            if (handleListScrollbarClick(control, screenX, screenY)) {
                repaintHost(control, hostHwnd);
                return true;
            }
            if (state.items.length > 0) {
                const { y: absY } = getAbsoluteWindowPosition(control);
                const idx = state.topIndex + Math.floor((screenY - absY - LIST_INSET) / LIST_ITEM_H);
                if (idx >= 0 && idx < state.items.length) {
                    state.selectedIndex = idx;
                    state.caretIndex = idx;
                    Logger.log(LogCategory.USER32,
                        `controlMouse: Listbox id=${control.controlId ?? 0} -> selected ${idx} "${state.items[idx].text}"`);
                    repaintHost(control, hostHwnd);
                    postCommand(parentHwnd, LBN_SELCHANGE, control);
                }
            }
            return true;
        }

        case 'combobox': {
            if (message !== WM_LBUTTONDOWN) return message === WM_LBUTTONUP;
            const state = getOrCreateListState(control.handle);
            if (state.dropdownOpen) {
                eraseAndCloseCombo(control, hostHwnd);
            } else {
                // Single-open invariant: close any other open combo first.
                closeOpenComboboxes(hostHwnd, control.handle);
                state.dropdownOpen = true;
                // Scroll only as much as needed to bring the selection into view — NOT
                // unconditionally to the top row. The previous version always set
                // topIndex = selectedIndex, so a 2-item list with item 1 selected opened
                // scrolled to show item 1 first and item 0 not at all, leaving a blank
                // row below it (the dropdown box is sized for min(items.length, 8) rows
                // regardless of scroll position). Real Windows only scrolls when the
                // selection wouldn't already fit in the visible window.
                const visibleCount = Math.max(1, Math.min(COMBO_DROP_MAX_VISIBLE, state.items.length));
                const sel = state.selectedIndex < 0 ? 0 : state.selectedIndex;
                const maxTop = Math.max(0, state.items.length - visibleCount);
                state.topIndex = Math.max(0, Math.min(sel - visibleCount + 1, maxTop));
                repaintHost(control, hostHwnd);
            }
            return true;
        }

        case 'edit': {
            if (message !== WM_LBUTTONDOWN) return message === WM_LBUTTONUP;
            const { x: absX } = getAbsoluteWindowPosition(control);
            setEditCaretFromPoint(control, screenX - absX);
            repaintHost(control, hostHwnd);
            return true;
        }

        case 'msctls_trackbar32': {
            if (message === WM_LBUTTONDOWN) {
                trackbarDragHwnd = control.handle;
                updateTrackbar(control, hostHwnd, screenX, screenY, TB_THUMBTRACK);
                return true;
            }
            return false;
        }

        default:
            return false;
    }
}

/**
 * Class-proc entry for a mouse message addressed to a KNOWN system control —
 * DefWindowProc's half of the contract. A subclassed control's guest wndproc ends
 * every message it does not consume with CallWindowProc/DefWindowProc to the proc it
 * replaced (UE1: WControl::CallDefaultProc; MFC: CWnd::DefWindowProc), and on real
 * Windows that IS the BUTTON/LISTBOX/COMBOBOX class proc, which is what sends
 * WM_COMMAND(BN_CLICKED) to the parent. Without this the click reaches the guest,
 * comes straight back to us, and dies.
 *
 * Takes the control directly instead of re-running the parent hit-test: the message
 * was already routed to this window, and re-hit-testing could pick an overlapping
 * sibling.
 */
export function handleSystemControlClassMouse(
    control: WindowInfo,
    message: number,
    wParam: number,
    lParam: number,
): boolean {
    if (!control.isSystemControl) return false;
    if (message !== WM_MOUSEMOVE && message !== WM_LBUTTONDOWN && message !== WM_LBUTTONUP) return false;

    // lParam holds SIGNED client coords relative to this control (they go negative
    // while the mouse is captured outside it).
    const clientX = (lParam << 16) >> 16;
    const clientY = lParam >> 16;
    const { x: absX, y: absY } = getAbsoluteWindowPosition(control);
    const hostHwnd = control.parent ?? control.handle;

    cancelStalePress(message, control.handle, hostHwnd);
    return applyControlClassMouse(control, hostHwnd, message, wParam, absX + clientX, absY + clientY);
}

/** Wheel scrolling for the listbox (or open combo dropdown) under the cursor. */
export function handleSystemControlWheel(
    hostHwnd: number,
    wheelDelta: number,
    screenX: number,
    screenY: number,
): boolean {
    const lines = wheelDelta > 0 ? -3 : 3;

    const openCombo = findOpenCombo(hostHwnd);
    if (openCombo) {
        const drop = getComboDropdownRect(openCombo);
        if (screenX >= drop.x && screenX < drop.x + drop.w && screenY >= drop.y && screenY < drop.y + drop.h) {
            const state = getOrCreateListState(openCombo.handle);
            state.topIndex += lines;
            clampListTopIndex(state, drop.h);
            repaintHost(openCombo, hostHwnd);
            return true;
        }
    }

    const control = hitTestSystemControlAtScreenPoint(hostHwnd, screenX, screenY);
    if (!control || normalizedControlClass(control) !== 'listbox') return false;
    const state = getOrCreateListState(control.handle);
    if (state.items.length <= listVisibleCount(control.height)) return true;
    state.topIndex += lines;
    clampListTopIndex(state, control.height);
    repaintHost(control, hostHwnd);
    return true;
}

/** Walk up to the top-level dialog window that hosts a control. */
function rootDialogOf(control: WindowInfo): number | undefined {
    let cur: WindowInfo | undefined = control;
    const visited = new Set<number>();
    while (cur?.parent && !visited.has(cur.handle)) {
        visited.add(cur.handle);
        cur = windows.get(cur.parent);
    }
    return cur?.handle;
}

// Full-dialog repaint hook — dialog.ts registers paintDialogToOverlay-based repaint
// (cross-module hook avoids a dialog.ts <-> control-interaction.ts import cycle).
let fullDialogRepainter: ((dialogHwnd: number) => void) | null = null;
export function registerFullDialogRepainter(fn: (dialogHwnd: number) => void): void {
    fullDialogRepainter = fn;
}
export function invokeFullDialogRepaint(dialogHwnd: number): void {
    fullDialogRepainter?.(dialogHwnd);
}

/** Overlay repair after clearOverlayRect — routes guest-painted menus to WM_PAINT. */
let overlayRepairRepainter: ((dialogHwnd: number) => void) | null = null;
export function registerOverlayRepairRepainter(fn: (dialogHwnd: number) => void): void {
    overlayRepairRepainter = fn;
}
export function invokeOverlayRepairRepaint(dialogHwnd: number): void {
    overlayRepairRepainter?.(dialogHwnd);
}

function requestFullDialogRepaint(dialogHwnd: number): void {
    invokeFullDialogRepaint(dialogHwnd);
}
