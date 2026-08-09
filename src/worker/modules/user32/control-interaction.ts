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
    setCapture,
    releaseCapture,
} from './shared-state';
import {
    repaintChildControls,
    isButtonSystemControl,
    isGroupBoxSystemControl,
    getComboDropdownRect,
    listVisibleCount,
    listVisibleCountOf,
    clampListTopIndex,
    clampListTopIndexOf,
    controlClientInset,
    LIST_ITEM_H,
    LIST_INSET,
    LIST_SCROLLBAR_W,
    COMBO_DROP_MAX_VISIBLE,
    COMBO_DROP_INSET,
    comboDropVisibleCount,
    comboDropTopIndex,
} from './controls';
import {
    setEditCaretFromPoint,
    setEditScrollTop,
    getEditVisualState,
    editLines,
    editVisibleLineCount,
    editHorizontalScrollRange,
    editHorizontalLineStep,
    setEditScrollX,
} from './edit-control';
import { setRichEditScrollTop, getRichEditVisualState, richEditScrollRange } from './rich-edit-control';
import {
    listScrollRange,
    scrollHitTest,
    scrollMetrics,
    scrollPosFromOffset,
    listBarRect,
    bottomBarRect,
    setScrollFeedbackProvider,
    type ScrollPart,
    type ScrollRange,
} from './scrollbar-paint';
import { getScrollBarState, SB_CTL, SB_VERT, SB_HORZ } from './scroll-state';
import {
    getOrCreateListViewState,
    hitTestListView,
    selectListViewAtIndex,
    postListViewClickNotify,
    postListViewColumnClick,
    listViewColumnAtClientX,
    clampListViewTopIndex,
    listViewVisibleCount,
    handleListViewKey,
    LV_SCROLLBAR_W,
    LV_HEADER_H,
    listViewHasHeader,
    MK_CONTROL as LV_MK_CONTROL,
    MK_SHIFT as LV_MK_SHIFT,
} from './list-view-control';

const WM_MOUSEMOVE   = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP   = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_COMMAND     = 0x0111;
const WM_HSCROLL     = 0x0114;
const WM_VSCROLL     = 0x0115;

const WM_KEYDOWN     = 0x0100;

const MK_LBUTTON = 0x0001;
const WS_DISABLED_CI = 0x08000000;
const WS_VSCROLL_CI = 0x00200000;
const WS_HSCROLL_CI = 0x00100000;
const ES_MULTILINE_CI = 0x0004;
const SBS_VERT = 0x0001;

// WM_VSCROLL / WM_HSCROLL notification codes. The horizontal spellings
// (SB_LINELEFT / SB_PAGERIGHT / …) are the same values.
const SB_LINEUP = 0;
const SB_LINEDOWN = 1;
const SB_PAGEUP = 2;
const SB_PAGEDOWN = 3;
const SB_THUMBPOSITION = 4;
const SB_THUMBTRACK = 5;
const SB_TOP = 6;
const SB_BOTTOM = 7;
const SB_ENDSCROLL = 8;

const VK_PRIOR = 0x21, VK_NEXT = 0x22, VK_END = 0x23, VK_HOME = 0x24;
const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
const VK_SPACE = 0x20;

const BN_CLICKED    = 0;
const LBN_SELCHANGE = 1;
const LBN_DBLCLK    = 2;
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

export interface PendingControlNotification {
    hwnd: number;
    msg: number;
    wParam: number;
    lParam: number;
}

let pendingControlNotification: PendingControlNotification | null = null;

export function takePendingControlNotification(): PendingControlNotification | null {
    const notification = pendingControlNotification;
    pendingControlNotification = null;
    return notification;
}

/**
 * Diagnostic tap. A control notification produced here is handed to the parent
 * SYNCHRONOUSLY by the pump that took the click (invokeGuestWndProcSync), never
 * through WindowManager.postMessage — so a probe that only wraps postMessage sees
 * the raw WM_LBUTTONDOWN/UP and nothing else, and "the click did nothing" and "the
 * click produced BN_CLICKED the guest ignored" look identical.
 */
let controlNotifyObserver: ((n: PendingControlNotification) => void) | null = null;
export function setControlNotifyObserver(fn: ((n: PendingControlNotification) => void) | null): void {
    controlNotifyObserver = fn;
}

function notifyCommand(parentHwnd: number, notifyCode: number, control: WindowInfo): void {
    const cmdWParam = ((notifyCode << 16) | ((control.controlId ?? 0) & 0xFFFF)) >>> 0;
    pendingControlNotification = {
        hwnd: parentHwnd,
        msg: WM_COMMAND,
        wParam: cmdWParam,
        lParam: control.handle,
    };
    controlNotifyObserver?.(pendingControlNotification);
}

/**
 * WM_VSCROLL / WM_HSCROLL to the control's parent. lParam is the control's handle
 * (Win32: 0 for a window's own bar, the HWND for a SCROLLBAR control / trackbar).
 */
function postScrollMessage(control: WindowInfo, vertical: boolean, code: number, pos: number): void {
    const system = System.getInstance();
    const msg = vertical ? WM_VSCROLL : WM_HSCROLL;
    // HIWORD carries a position only for the two thumb codes; Windows sends 0 for
    // every other one, and an app that reads it anyway must see what it would see
    // there — a plausible-looking number is worse than the zero it expects.
    const reported = (code === SB_THUMBPOSITION || code === SB_THUMBTRACK) ? pos : 0;
    const wParam = (((reported & 0xFFFF) << 16) | (code & 0xFFFF)) >>> 0;
    system.windowManager.postMessage(control.parent ?? 0, msg, wParam, control.handle);
    system.scheduler.wakeMessageWaiters();
}

function postScroll(control: WindowInfo, code: number, pos: number): void {
    const vertical = (control.style & TBS_VERT) !== 0 || control.height > control.width * 2;
    postScrollMessage(control, vertical, code, pos);
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

    for (let i = 0; i < win.children.length; i++) {
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
    for (let i = 0; i < win.children.length; i++) {
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
/** Listbox whose selection follows the cursor because its button is still down. */
let listboxDragHwnd = 0;

export function resetControlInteractionState(): void {
    trackbarDragHwnd = 0;
    pressedButtonHwnd = 0;
    listboxDragHwnd = 0;
    if (scrollPress || scrollDrag) releaseCapture();
    stopScrollRepeat();
    scrollDrag = null;
    pendingControlNotification = null;
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

// ---------------------------------------------------------------------------
// Scroll bars — one behaviour for every bar on screen
// ---------------------------------------------------------------------------

/**
 * A bar a control owns, in the ONE shape the SCROLLBAR class behaviour needs.
 *
 * A standalone SCROLLBAR control, a listbox's own bar and a multiline edit's bar
 * differ only in where the range lives and who hears about a change — the
 * arrow / track / thumb behaviour above them is identical, and on real Windows it
 * literally is the same code (scroll.c drives SB_CTL and SB_VERT/SB_HORZ alike).
 *
 * `applyPos` is null for a SCROLLBAR CONTROL: a real scroll bar control does not
 * move itself. It reports SB_* to its owner and the owner calls SetScrollInfo — an
 * app that ignores WM_VSCROLL gets a bar that visibly does not budge, which is the
 * behaviour games are written against.
 */
interface BarBinding {
    control: WindowInfo;
    /** SB_CTL for a SCROLLBAR control, SB_VERT/SB_HORZ for a control's own bar. */
    bar: number;
    vertical: boolean;
    /** Screen rect, matching what the painter drew. */
    x: number; y: number; w: number; h: number;
    range: ScrollRange;
    upEnabled: boolean;
    downEnabled: boolean;
    /** Commit a position (client bars own their state); null = report only. */
    applyPos: ((pos: number) => void) | null;
    /** Report SB_* to the parent through WM_VSCROLL/WM_HSCROLL. */
    notifies: boolean;
    /** Units one arrow click travels; >1 for a bar whose unit is pixels, not lines. */
    lineStep?: number;
}

function barExtent(b: BarBinding): number {
    return b.vertical ? b.h : b.w;
}

function barOffset(b: BarBinding, screenX: number, screenY: number): number {
    return b.vertical ? screenY - b.y : screenX - b.x;
}

function barContains(b: BarBinding, screenX: number, screenY: number): boolean {
    return screenX >= b.x && screenX < b.x + b.w && screenY >= b.y && screenY < b.y + b.h;
}

/** The client-area bar rect a list-shaped control paints at its right edge. */
function listClientBarRect(
    absX: number, absY: number, w: number, h: number, inset: number = LIST_INSET,
): { x: number; y: number; w: number; h: number } {
    return listBarRect(absX, absY, w, h, inset);
}

/** Every bar `control` currently paints, topmost-relevant first. */
function scrollBarsOf(control: WindowInfo): BarBinding[] {
    const cls = normalizedControlClass(control);
    const { x: absX, y: absY } = getAbsoluteWindowPosition(control);
    const w = control.width, h = control.height;

    switch (cls) {
        case 'scrollbar': {
            const st = getScrollBarState(control.handle, SB_CTL);
            // SBS_VERT decides orientation; a bar with neither style set is horizontal,
            // so the aspect ratio only breaks the tie (same rule as paintScrollBar).
            const vertical = (control.style & SBS_VERT) !== 0 || h > w;
            return [{
                control, bar: SB_CTL, vertical,
                x: absX, y: absY, w, h,
                range: { min: st.min, max: st.max, page: st.page, pos: st.pos },
                upEnabled: st.enabled && st.upEnabled,
                downEnabled: st.enabled && st.downEnabled,
                applyPos: null,
                notifies: true,
            }];
        }

        case 'listbox': {
            const state = getOrCreateListState(control.handle);
            const inset = controlClientInset(control);
            const visible = listVisibleCountOf(control);
            if (state.items.length <= visible) return [];
            return [{
                control, bar: SB_VERT, vertical: true,
                ...listClientBarRect(absX, absY, w, h, inset),
                range: listScrollRange(state.topIndex, visible, state.items.length),
                upEnabled: true, downEnabled: true,
                applyPos: (pos) => {
                    state.topIndex = pos;
                    clampListTopIndexOf(state, control);
                },
                notifies: false,
            }];
        }

        case 'combobox': {
            const state = getOrCreateListState(control.handle);
            if (!state.dropdownOpen) return [];
            const visible = comboDropVisibleCount(state.items.length);
            if (state.items.length <= visible) return [];
            const drop = getComboDropdownRect(control);
            return [{
                control, bar: SB_VERT, vertical: true,
                ...listClientBarRect(drop.x, drop.y, drop.w, drop.h, COMBO_DROP_INSET),
                range: listScrollRange(state.topIndex, visible, state.items.length),
                upEnabled: true, downEnabled: true,
                applyPos: (pos) => {
                    state.topIndex = pos;
                    clampListTopIndex(state, drop.h);
                },
                notifies: false,
            }];
        }

        case 'syslistview32': {
            const LV_INSET = controlClientInset(control);
            const state = getOrCreateListViewState(control.handle);
            const visible = listViewVisibleCount(control);
            if (state.items.length <= visible) return [];
            const headerH = listViewHasHeader(control) ? LV_HEADER_H : 0;
            return [{
                control, bar: SB_VERT, vertical: true,
                // The listview's bar starts BELOW the header, and its chrome is the
                // control's own — the painter uses the same two facts.
                x: absX + w - LV_INSET - LV_SCROLLBAR_W,
                y: absY + headerH + LV_INSET,
                w: LV_SCROLLBAR_W,
                h: Math.max(1, h - headerH - LV_INSET * 2),
                range: listScrollRange(state.topIndex, visible, state.items.length),
                upEnabled: true, downEnabled: true,
                applyPos: (pos) => {
                    state.topIndex = pos;
                    clampListViewTopIndex(control, state);
                },
                notifies: false,
            }];
        }

        case 'edit': {
            const multiline = (control.style & ES_MULTILINE_CI) !== 0;
            if (!multiline) return [];
            const vBar = (control.style & WS_VSCROLL_CI) !== 0;
            const hBar = (control.style & WS_HSCROLL_CI) !== 0;
            const inset = controlClientInset(control);
            // The bars sit INSIDE the client, so each shortens the other.
            const bodyH = h - (hBar ? LIST_SCROLLBAR_W : 0);
            const bodyW = w - (vBar ? LIST_SCROLLBAR_W : 0);
            const bars: BarBinding[] = [];
            if (vBar) {
                const lines = editLines(control).length;
                const page = editVisibleLineCount(control);
                const canScroll = lines > page;
                bars.push({
                    control, bar: SB_VERT, vertical: true,
                    ...listClientBarRect(absX, absY, w, bodyH, inset),
                    range: listScrollRange(getEditVisualState(control).scrollTop, page, lines),
                    upEnabled: canScroll, downEnabled: canScroll,
                    applyPos: (pos) => setEditScrollTop(control, pos),
                    notifies: false,
                });
            }
            if (hBar) {
                // Pixels of text, not lines — the unit the edit's own x offset uses.
                const range = editHorizontalScrollRange(control);
                const canScroll = range.max - range.min >= range.page;
                bars.push({
                    control, bar: SB_HORZ, vertical: false,
                    ...bottomBarRect(absX, absY, bodyW, h, inset),
                    range,
                    upEnabled: canScroll, downEnabled: canScroll,
                    applyPos: (pos) => setEditScrollX(control, pos),
                    notifies: false,
                    lineStep: editHorizontalLineStep(control),
                });
            }
            return bars;
        }

        case 'richedit': {
            if ((control.style & WS_VSCROLL_CI) === 0) return [];
            // The range comes from the painter: a rich edit's line count is a function
            // of the wrapped layout, which only the layout pass can compute.
            const layout = richEditScrollRange(control);
            if (!layout) return [];
            const canScroll = layout.lineCount > layout.visibleLines;
            return [{
                control, bar: SB_VERT, vertical: true,
                ...listClientBarRect(absX, absY, w, h, controlClientInset(control)),
                range: listScrollRange(layout.top, layout.visibleLines, layout.lineCount),
                upEnabled: canScroll, downEnabled: canScroll,
                applyPos: (pos) => setRichEditScrollTop(control, pos),
                notifies: false,
            }];
        }

        default:
            return [];
    }
}

/** Step a rich edit by whole lines (arrow buttons, wheel, keys). */
function richEditLineScroll(control: WindowInfo, lines: number, hostHwnd: number): boolean {
    if (!lines) return false;
    const top = getRichEditVisualState(control).scrollTop;
    if (top + lines < 0 && top === 0) return true;
    setRichEditScrollTop(control, Math.max(0, top + lines));
    repaintHost(control, hostHwnd);
    return true;
}

/** The bar under a screen point, if any. */
function barAtPoint(control: WindowInfo, screenX: number, screenY: number): BarBinding | undefined {
    for (const b of scrollBarsOf(control)) if (barContains(b, screenX, screenY)) return b;
    return undefined;
}

/** Wine scroll.c: the hold before an arrow/track starts repeating, then its period. */
const SCROLL_FIRST_DELAY_MS = 200;
const SCROLL_REPEAT_DELAY_MS = 50;

interface ScrollPress {
    hwnd: number;
    bar: number;
    part: ScrollPart;
    hostHwnd: number;
    /** Last cursor position — a repeat only fires while it is still over the part. */
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout> | null;
}

interface ScrollDrag {
    hwnd: number;
    bar: number;
    hostHwnd: number;
    /** Cursor offset INSIDE the thumb at grab time, so it does not jump under the cursor. */
    grab: number;
    /** Position the thumb is being dragged to (not yet committed by the owner). */
    trackPos: number;
    /** Position to snap back to while the cursor strays far off the bar (Win32). */
    snapBackPos: number;
    outside: boolean;
}

let scrollPress: ScrollPress | null = null;
let scrollDrag: ScrollDrag | null = null;

/**
 * Live scrollbar feedback the PAINTER needs and cannot derive: which part is held
 * down (drawn depressed) and, during a thumb drag, where the thumb is being dragged
 * to. A SCROLLBAR control's committed position only moves when its owner answers
 * WM_VSCROLL, so without the tracked position the thumb would sit still under the
 * cursor for the whole drag.
 */
export function getScrollFeedback(hwnd: number, bar: number): {
    pressed: ScrollPart | null;
    trackPos: number | null;
} {
    const pressed = scrollPress && scrollPress.hwnd === hwnd && scrollPress.bar === bar
        ? scrollPress.part : null;
    const trackPos = scrollDrag && scrollDrag.hwnd === hwnd && scrollDrag.bar === bar
        ? scrollDrag.trackPos : null;
    return { pressed, trackPos };
}

setScrollFeedbackProvider(getScrollFeedback);

function findBar(hwnd: number, bar: number): BarBinding | undefined {
    const control = windows.get(hwnd);
    if (!control || !control.visible || control.pendingDestroy) return undefined;
    return scrollBarsOf(control).find((b) => b.bar === bar);
}

function clampToRange(b: BarBinding, pos: number): number {
    const m = scrollMetrics(barExtent(b), b.range);
    const min = Math.min(b.range.min, b.range.max);
    return Math.max(min, Math.min(m.maxPos, pos));
}

/** One line/page step. Returns false when the part is disabled or already at the end. */
function stepScroll(b: BarBinding, part: ScrollPart, hostHwnd: number): boolean {
    // nMin == nMax is a bar with nothing to scroll: Win32 hit-tests it as NOWHERE and
    // the painter greys it, so no part of it may produce a line or page code.
    if (scrollMetrics(barExtent(b), b.range).empty) return false;
    const page = Math.max(1, b.range.page);
    const line = Math.max(1, b.lineStep ?? 1);
    let code: number;
    let pos = b.range.pos;
    switch (part) {
        case 'lineUp':   if (!b.upEnabled) return false;   code = SB_LINEUP;   pos -= line; break;
        case 'lineDown': if (!b.downEnabled) return false; code = SB_LINEDOWN; pos += line; break;
        case 'pageUp':   if (!b.upEnabled) return false;   code = SB_PAGEUP;   pos -= page; break;
        case 'pageDown': if (!b.downEnabled) return false; code = SB_PAGEDOWN; pos += page; break;
        case 'thumb':    return false;
    }
    return commitScroll(b, code, clampToRange(b, pos), hostHwnd);
}

/**
 * Report a scroll and, for a bar the control itself owns, move it. Returns false
 * when nothing changed, which is what stops an autorepeat at the end of the range.
 */
function commitScroll(b: BarBinding, code: number, pos: number, hostHwnd: number): boolean {
    const moved = pos !== b.range.pos;
    if (b.applyPos && moved) {
        b.applyPos(pos);
        repaintHost(b.control, hostHwnd);
    }
    if (b.notifies) {
        postScrollMessage(b.control, b.vertical, code, pos);
        // A control that reports instead of moving still redraws its held-down part.
        if (!b.applyPos) repaintHost(b.control, hostHwnd);
    }
    return moved || b.notifies;
}

function stopScrollRepeat(): void {
    if (scrollPress?.timer) clearTimeout(scrollPress.timer);
    scrollPress = null;
}

/**
 * The implicit capture a scroll bar takes on WM_LBUTTONDOWN, given back on the UP.
 * Leaving it held routes every later mouse message to this bar, and the next control
 * the user clicks is silently dead.
 */
function releaseScrollCapture(): void {
    const captured = releaseCapture();
    if (captured) {
        System.getInstance().windowManager.postMessage(
            captured, 0x0215 /* WM_CAPTURECHANGED */, 0, 0);
    }
}

function armScrollRepeat(delay: number): void {
    const press = scrollPress;
    if (!press) return;
    press.timer = setTimeout(() => {
        if (scrollPress !== press) return;
        press.timer = null;
        const b = findBar(press.hwnd, press.bar);
        if (!b) { stopScrollRepeat(); return; }
        // Windows suspends (but does not cancel) the repeat while the cursor leaves
        // the part it pressed — the button stays captured and it resumes on re-entry.
        const stillOn = barContains(b, press.x, press.y)
            && scrollHitTest(barExtent(b), barOffset(b, press.x, press.y),
                scrollMetrics(barExtent(b), b.range)) === press.part;
        if (stillOn && !stepScroll(b, press.part, press.hostHwnd)) {
            stopScrollRepeat();
            return;
        }
        armScrollRepeat(SCROLL_REPEAT_DELAY_MS);
    }, delay);
}

/**
 * Mouse on a scroll bar. Handles the whole gesture — the press, the autorepeat, the
 * thumb drag and the release — for every bar shape at once.
 * Returns true when the message belonged to a bar.
 */
function handleScrollBarMouse(
    control: WindowInfo | undefined,
    hostHwnd: number,
    message: number,
    wParam: number,
    screenX: number,
    screenY: number,
): boolean {
    // --- an active thumb drag owns the mouse until the button comes up ---
    if (scrollDrag) {
        const drag = scrollDrag;
        const b = findBar(drag.hwnd, drag.bar);
        if (!b) { scrollDrag = null; return false; }
        if (message === WM_MOUSEMOVE && (wParam & MK_LBUTTON) === 0) {
            // The release happened outside our message stream — finish the drag.
            message = WM_LBUTTONUP;
        }
        if (message === WM_MOUSEMOVE || message === WM_LBUTTONUP) {
            const m = scrollMetrics(barExtent(b), b.range);
            // Straying far to the SIDE of the bar snaps the thumb back to where the
            // drag started, exactly as Win32 does (the release then commits nothing).
            const across = b.vertical ? screenX - b.x : screenY - b.y;
            const slack = (b.vertical ? b.w : b.h) * 8;
            drag.outside = across < -slack || across > (b.vertical ? b.w : b.h) + slack;
            drag.trackPos = drag.outside
                ? drag.snapBackPos
                : clampToRange(b, scrollPosFromOffset(barOffset(b, screenX, screenY) - drag.grab, m, b.range));
            if (message === WM_MOUSEMOVE) {
                commitScroll(b, SB_THUMBTRACK, drag.trackPos, drag.hostHwnd);
                repaintHost(b.control, drag.hostHwnd);
                return true;
            }
            const finalPos = drag.trackPos;
            scrollDrag = null;
            releaseScrollCapture();
            commitScroll(b, SB_THUMBPOSITION, finalPos, drag.hostHwnd);
            if (b.notifies) postScrollMessage(b.control, b.vertical, SB_ENDSCROLL, finalPos);
            repaintHost(b.control, drag.hostHwnd);
            return true;
        }
        return false;
    }

    // --- release ends an autorepeat, wherever it lands ---
    if (message === WM_LBUTTONUP && scrollPress) {
        const press = scrollPress;
        stopScrollRepeat();
        releaseScrollCapture();
        const b = findBar(press.hwnd, press.bar);
        if (b?.notifies) postScrollMessage(b.control, b.vertical, SB_ENDSCROLL, b.range.pos);
        if (b) repaintHost(b.control, press.hostHwnd);
        return true;
    }

    if (message === WM_MOUSEMOVE && scrollPress) {
        scrollPress.x = screenX;
        scrollPress.y = screenY;
        return true;
    }

    if (message !== WM_LBUTTONDOWN || !control) return false;
    const b = barAtPoint(control, screenX, screenY);
    if (!b) return false;

    const extent = barExtent(b);
    const m = scrollMetrics(extent, b.range);
    const part = scrollHitTest(extent, barOffset(b, screenX, screenY), m);

    if (part === 'thumb') {
        scrollDrag = {
            hwnd: b.control.handle, bar: b.bar, hostHwnd,
            grab: barOffset(b, screenX, screenY) - m.thumbStart,
            trackPos: b.range.pos,
            snapBackPos: b.range.pos,
            outside: false,
        };
        setCapture(b.control.handle);
        return true;
    }

    scrollPress = {
        hwnd: b.control.handle, bar: b.bar, part, hostHwnd,
        x: screenX, y: screenY, timer: null,
    };
    setCapture(b.control.handle);
    if (!stepScroll(b, part, hostHwnd)) {
        // Disabled arrow / dead end: still show it depressed while held.
        repaintHost(b.control, hostHwnd);
    }
    armScrollRepeat(SCROLL_FIRST_DELAY_MS);
    return true;
}

/** Scroll a bar by whole lines (wheel, keyboard). Returns true when handled. */
function scrollBarByLines(b: BarBinding, lines: number, hostHwnd: number): boolean {
    if (lines === 0) return true;
    if (b.applyPos) {
        return commitScroll(b, lines < 0 ? SB_LINEUP : SB_LINEDOWN, clampToRange(b, b.range.pos + lines), hostHwnd);
    }
    // A SCROLLBAR control reports one SB_LINE* per line, then ends the sequence —
    // the owner is what turns those into movement.
    const code = lines < 0 ? SB_LINEUP : SB_LINEDOWN;
    for (let i = 0; i < Math.abs(lines); i++) {
        postScrollMessage(b.control, b.vertical, code, b.range.pos);
    }
    postScrollMessage(b.control, b.vertical, SB_ENDSCROLL, b.range.pos);
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

    // --- A held scroll bar (autorepeat or thumb drag) captures the mouse ---
    if ((scrollDrag || scrollPress)
        && handleScrollBarMouse(undefined, hostHwnd, message, wParam, screenX, screenY)) {
        return true;
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
            // The drop-down's own scroll bar is inside that rect: a click there scrolls
            // the list, it does not pick the item behind the bar and close.
            if (handleScrollBarMouse(openCombo, hostHwnd, message, wParam, screenX, screenY)) {
                return true;
            }
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
                notifyCommand(openCombo.parent ?? hostHwnd, CBN_SELCHANGE, openCombo);
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
    const captured = releaseCapture();
    if (captured) {
        System.getInstance().windowManager.postMessage(
            captured, 0x0215 /* WM_CAPTURECHANGED */, 0, 0);
    }
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

    // Wine button.c / listbox.c / scroll.c all open with the same test: a DISABLED
    // window's class proc ignores mouse input outright. Without this a greyed-out
    // button still completes a click and hands the parent a BN_CLICKED it has every
    // right to act on.
    if ((control.style & WS_DISABLED_CI) !== 0) return true;

    // Clicking an interactive control gives it focus (statics/groupboxes never take it).
    // Ahead of the bar handling: a click on a SCROLLBAR control is consumed there, and
    // a bar that never takes focus can never answer the keyboard.
    if (message === WM_LBUTTONDOWN
        && (controlClass === 'edit' || controlClass === 'listbox' || controlClass === 'combobox'
            || controlClass === 'syslistview32' || controlClass === 'scrollbar'
            || (controlClass === 'button' && isButtonSystemControl(control)))) {
        System.getInstance().windowManager.setFocus(control.handle);
    }

    // Every bar the control paints — its own or, for the SCROLLBAR class, itself.
    if (handleScrollBarMouse(control, hostHwnd, message, wParam, screenX, screenY)) return true;

    // Subclassing (SetWindowLong(GWL_WNDPROC) — MFC DDX_Control, UE1's WControl)
    // replaces a control's wndproc for message routing; it does NOT reimplement the
    // class's input behavior, so this switch must run subclassed or not.
    switch (controlClass) {
        case 'button': {
            if (!isButtonSystemControl(control)) return false;
            if (message === WM_LBUTTONDOWN) {
                const previous = setCapture(control.handle);
                if (previous && previous !== control.handle) {
                    System.getInstance().windowManager.postMessage(
                        previous, 0x0215 /* WM_CAPTURECHANGED */, 0, control.handle);
                }
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
                const captured = releaseCapture();
                if (captured) {
                    System.getInstance().windowManager.postMessage(
                        captured, 0x0215 /* WM_CAPTURECHANGED */, 0, 0);
                }
                const currentState = buttonCheckStates.get(control.handle) ?? 0;
                buttonCheckStates.set(control.handle, currentState & ~BST_PUSHED);
                applyAutoButtonState(parentHwnd, control);
                repaintHost(control, hostHwnd);
                Logger.log(LogCategory.USER32,
                    `controlMouse: Button click id=${control.controlId ?? 0} "${control.title}" -> WM_COMMAND parent=0x${parentHwnd.toString(16)}`);
                notifyCommand(parentHwnd, BN_CLICKED, control);
                return true;
            }
            return false;
        }

        case 'listbox': {
            const state = getOrCreateListState(control.handle);
            if (message === WM_LBUTTONUP) {
                listboxDragHwnd = 0;
                return true;
            }
            // Dragging with the button down keeps moving the selection, as Win32 does.
            if (message === WM_MOUSEMOVE) {
                if (listboxDragHwnd !== control.handle || (wParam & MK_LBUTTON) === 0) {
                    if ((wParam & MK_LBUTTON) === 0) listboxDragHwnd = 0;
                    return false;
                }
            } else if (message !== WM_LBUTTONDOWN && message !== WM_LBUTTONDBLCLK) {
                return false;
            }
            if (state.items.length > 0) {
                const { y: absY } = getAbsoluteWindowPosition(control);
                const idx = state.topIndex
                    + Math.floor((screenY - absY - controlClientInset(control)) / LIST_ITEM_H);
                if (idx >= 0 && idx < state.items.length && idx !== state.selectedIndex) {
                    state.selectedIndex = idx;
                    state.caretIndex = idx;
                    Logger.log(LogCategory.USER32,
                        `controlMouse: Listbox id=${control.controlId ?? 0} -> selected ${idx} "${state.items[idx].text}"`);
                    repaintHost(control, hostHwnd);
                    notifyCommand(parentHwnd, LBN_SELCHANGE, control);
                }
            }
            if (message === WM_LBUTTONDBLCLK) {
                notifyCommand(parentHwnd, LBN_DBLCLK, control);
            } else if (message === WM_LBUTTONDOWN) {
                listboxDragHwnd = control.handle;
            }
            return true;
        }

        case 'richedit':
            // Its bar was consumed by handleScrollBarMouse before class dispatch; a
            // click in the text area just goes to the control.
            return message === WM_LBUTTONDOWN || message === WM_LBUTTONUP;

        case 'syslistview32': {
            if (message !== WM_LBUTTONDOWN && message !== WM_LBUTTONDBLCLK && message !== WM_LBUTTONUP) {
                return false;
            }
            if (message === WM_LBUTTONUP) return true;
            const { x: absX, y: absY } = getAbsoluteWindowPosition(control);
            // The header is not part of the item area: a click there sorts, it does
            // not select (comctl32 forwards it as LVN_COLUMNCLICK).
            if (listViewHasHeader(control) && screenY - absY < LV_HEADER_H) {
                const col = listViewColumnAtClientX(control, screenX - absX);
                if (col >= 0) postListViewColumnClick(control, col);
                return true;
            }
            const hit = hitTestListView(control, screenX - absX, screenY - absY);
            if (hit.iItem >= 0) {
                const mods = (wParam & (LV_MK_CONTROL | LV_MK_SHIFT)) >>> 0;
                selectListViewAtIndex(control, hit.iItem, mods);
                const state = getOrCreateListViewState(control.handle);
                Logger.log(LogCategory.USER32,
                    `controlMouse: ListView id=${control.controlId ?? 0} -> item ${hit.iItem}`
                    + ` selCount=${state.items.filter((it) => it.state & 2).length}`
                    + ` "${state.items[hit.iItem]?.text ?? ''}"`);
                repaintHost(control, hostHwnd);
                postListViewClickNotify(
                    control,
                    message === WM_LBUTTONDBLCLK,
                    hit.iItem,
                    hit.iSubItem,
                    screenX - absX,
                    screenY - absY,
                    mods,
                );
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
                // The selection becomes the TOP row — verified against a native capture
                // (40 items, item 4 selected, drops showing "Choice 4" first). Clamping
                // to maxTop is what keeps a short list from opening scrolled past its
                // own end and leaving a blank row: 2 items with item 1 selected has
                // maxTop 0, so it still opens at the top.
                state.topIndex = comboDropTopIndex(state.items.length, state.selectedIndex);
                repaintHost(control, hostHwnd);
            }
            return true;
        }

        case 'edit': {
            if (message !== WM_LBUTTONDOWN) return message === WM_LBUTTONUP;
            const { x: absX, y: absY } = getAbsoluteWindowPosition(control);
            setEditCaretFromPoint(control, screenX - absX, screenY - absY);
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
    if (message !== WM_MOUSEMOVE && message !== WM_LBUTTONDOWN && message !== WM_LBUTTONUP
        && message !== WM_LBUTTONDBLCLK) {
        return false;
    }

    // lParam holds SIGNED client coords relative to this control (they go negative
    // while the mouse is captured outside it).
    const clientX = (lParam << 16) >> 16;
    const clientY = lParam >> 16;
    const { x: absX, y: absY } = getAbsoluteWindowPosition(control);
    const hostHwnd = control.parent ?? control.handle;

    cancelStalePress(message, control.handle, hostHwnd);
    return applyControlClassMouse(control, hostHwnd, message, wParam, absX + clientX, absY + clientY);
}

/**
 * Class-proc keyboard behaviour for a focused system control (Wine listbox.c
 * LISTBOX_HandleKeyDown, scroll.c SCROLL_HandleKbdEvent, button.c's VK_SPACE).
 *
 * This is the CONTROL's own keyboard, not the dialog manager's: Tab navigation,
 * Enter-activates-the-default-button and the arrow walk across a radio group belong
 * to IsDialogMessage and live in dialog.ts. A control keeps working under a plain
 * message loop that never calls it — which is exactly what a Win32 app expects.
 */
export function handleSystemControlKey(
    control: WindowInfo,
    message: number,
    vKey: number,
): boolean {
    if (!control.isSystemControl) return false;
    if ((control.style & WS_DISABLED_CI) !== 0) return false;

    const cls = normalizedControlClass(control);
    const hostHwnd = control.parent ?? control.handle;
    const parentHwnd = control.parent ?? control.handle;

    if (cls === 'button' && isButtonSystemControl(control) && vKey === VK_SPACE) {
        const state = buttonCheckStates.get(control.handle) ?? 0;
        if (message === WM_KEYDOWN) {
            buttonCheckStates.set(control.handle, state | BST_PUSHED);
            repaintHost(control, hostHwnd);
            return true;
        }
        buttonCheckStates.set(control.handle, state & ~BST_PUSHED);
        applyAutoButtonState(parentHwnd, control);
        repaintHost(control, hostHwnd);
        notifyCommand(parentHwnd, BN_CLICKED, control);
        return true;
    }

    if (message !== WM_KEYDOWN) return false;

    if (cls === 'listbox') {
        const state = getOrCreateListState(control.handle);
        if (state.items.length === 0) return false;
        const page = Math.max(1, listVisibleCountOf(control));
        const from = state.selectedIndex < 0 ? 0 : state.selectedIndex;
        let next = from;
        switch (vKey) {
            case VK_UP:    next = from - 1; break;
            case VK_DOWN:  next = from + 1; break;
            case VK_PRIOR: next = from - page; break;
            case VK_NEXT:  next = from + page; break;
            case VK_HOME:  next = 0; break;
            case VK_END:   next = state.items.length - 1; break;
            default: return false;
        }
        next = Math.max(0, Math.min(state.items.length - 1, next));
        if (next !== state.selectedIndex) {
            state.selectedIndex = next;
            state.caretIndex = next;
            notifyCommand(parentHwnd, LBN_SELCHANGE, control);
        }
        // Keyboard selection always scrolls the caret into view.
        if (next < state.topIndex) state.topIndex = next;
        else if (next >= state.topIndex + page) state.topIndex = next - page + 1;
        clampListTopIndexOf(state, control);
        repaintHost(control, hostHwnd);
        return true;
    }

    if (cls === 'syslistview32') {
        if (handleListViewKey(control, vKey, 0)) {
            repaintHost(control, hostHwnd);
            return true;
        }
        return false;
    }

    if (cls === 'scrollbar') {
        const bar = scrollBarsOf(control)[0];
        if (!bar) return false;
        const m = scrollMetrics(barExtent(bar), bar.range);
        const min = Math.min(bar.range.min, bar.range.max);
        switch (vKey) {
            case VK_UP: case VK_LEFT:
                return stepScroll(bar, 'lineUp', hostHwnd);
            case VK_DOWN: case VK_RIGHT:
                return stepScroll(bar, 'lineDown', hostHwnd);
            case VK_PRIOR:
                return stepScroll(bar, 'pageUp', hostHwnd);
            case VK_NEXT:
                return stepScroll(bar, 'pageDown', hostHwnd);
            case VK_HOME:
                return commitScroll(bar, SB_TOP, min, hostHwnd);
            case VK_END:
                return commitScroll(bar, SB_BOTTOM, m.maxPos, hostHwnd);
            default:
                return false;
        }
    }

    return false;
}

/**
 * WM_MOUSEWHEEL over any scrollable system control.
 *
 * SPI_GETWHEELSCROLLLINES lines per WHEEL_DELTA notch (3 by default), and the
 * documented WHEEL_PAGESCROLL setting means "a screenful per notch" — which is the
 * bar's own page size, so it costs nothing to honour.
 */
const WHEEL_DELTA = 120;
const WHEEL_PAGESCROLL = 0xFFFFFFFF;
let wheelScrollLines = 3;

/** SPI_SETWHEELSCROLLLINES. WHEEL_PAGESCROLL means one page per notch. */
export function setWheelScrollLines(lines: number): void {
    wheelScrollLines = lines >>> 0;
}
export function getWheelScrollLines(): number {
    return wheelScrollLines;
}

/** Lines one wheel message scrolls, signed (positive = toward the end). */
function wheelLines(wheelDelta: number, page: number): number {
    const notches = -wheelDelta / WHEEL_DELTA;
    if (wheelScrollLines === WHEEL_PAGESCROLL) {
        return Math.trunc(notches) * Math.max(1, page);
    }
    if (wheelScrollLines === 0) return 0; // wheel scrolling turned off
    return Math.round(notches * wheelScrollLines);
}

export function handleSystemControlWheel(
    hostHwnd: number,
    wheelDelta: number,
    screenX: number,
    screenY: number,
): boolean {
    // An open dropdown is above every sibling, so it takes the wheel first.
    const openCombo = findOpenCombo(hostHwnd);
    if (openCombo) {
        const drop = getComboDropdownRect(openCombo);
        if (screenX >= drop.x && screenX < drop.x + drop.w && screenY >= drop.y && screenY < drop.y + drop.h) {
            const bar = scrollBarsOf(openCombo)[0];
            const state = getOrCreateListState(openCombo.handle);
            const page = bar ? Math.max(1, bar.range.page) : COMBO_DROP_MAX_VISIBLE;
            state.topIndex += wheelLines(wheelDelta, page);
            clampListTopIndex(state, drop.h);
            repaintHost(openCombo, hostHwnd);
            return true;
        }
    }

    const control = hitTestSystemControlAtScreenPoint(hostHwnd, screenX, screenY);
    if (!control) return false;
    if ((control.style & WS_DISABLED_CI) !== 0) return true;

    // Rich Edit has no range here (see richEditLineScroll) — step it by lines.
    if (normalizedControlClass(control) === 'richedit') {
        return richEditLineScroll(control, wheelLines(wheelDelta, 1), hostHwnd);
    }

    const bar = scrollBarsOf(control).find((b) => b.vertical) ?? scrollBarsOf(control)[0];
    if (!bar) {
        // A control that owns no bar right now still swallows the wheel if it is one
        // of the scrollable classes — nothing under it should scroll instead.
        const cls = normalizedControlClass(control);
        return cls === 'listbox' || cls === 'syslistview32' || cls === 'edit';
    }
    return scrollBarByLines(bar, wheelLines(wheelDelta, Math.max(1, bar.range.page)), hostHwnd);
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
