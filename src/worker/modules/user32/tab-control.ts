/**
 * SysTabControl32 (comctl32 v4.7x/v5): TCM_* protocol, tab-row layout, hit test
 * and the TCN_* parent notifications. Painting lives in controls.ts with the
 * other system controls; the geometry both it and the hit test read is computed
 * here so a drawn tab and a clicked tab cannot disagree.
 *
 * Layout follows comctl32's own model (see Wine dlls/comctl32/tab.c): a tab's
 * stored rect is (left,right) in pixels along its row and (top) = the ROW INDEX,
 * expanded to a pixel rect only by tabItemRect().
 */

import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import { encodeAnsi } from '../codepage-utils';
import { gdiTextMetrics } from '../win32-text';
import { WindowInfo, registerControlStatePurger, windows } from './shared-state';
import { postNotify } from './control-notify';

// ---- Messages (TCM_FIRST = 0x1300) ----
export const TCM_FIRST = 0x1300;
const TCM_GETIMAGELIST = TCM_FIRST + 2;
const TCM_SETIMAGELIST = TCM_FIRST + 3;
const TCM_GETITEMCOUNT = TCM_FIRST + 4;
const TCM_GETITEMA = TCM_FIRST + 5;
const TCM_SETITEMA = TCM_FIRST + 6;
const TCM_INSERTITEMA = TCM_FIRST + 7;
const TCM_DELETEITEM = TCM_FIRST + 8;
const TCM_DELETEALLITEMS = TCM_FIRST + 9;
const TCM_GETITEMRECT = TCM_FIRST + 10;
const TCM_GETCURSEL = TCM_FIRST + 11;
const TCM_SETCURSEL = TCM_FIRST + 12;
const TCM_HITTEST = TCM_FIRST + 13;
const TCM_SETITEMEXTRA = TCM_FIRST + 14;
const TCM_ADJUSTRECT = TCM_FIRST + 40;
const TCM_SETITEMSIZE = TCM_FIRST + 41;
const TCM_REMOVEIMAGE = TCM_FIRST + 42;
const TCM_SETPADDING = TCM_FIRST + 43;
const TCM_GETROWCOUNT = TCM_FIRST + 44;
const TCM_GETTOOLTIPS = TCM_FIRST + 45;
const TCM_SETTOOLTIPS = TCM_FIRST + 46;
const TCM_GETCURFOCUS = TCM_FIRST + 47;
const TCM_SETCURFOCUS = TCM_FIRST + 48;
const TCM_SETMINTABWIDTH = TCM_FIRST + 49;
const TCM_DESELECTALL = TCM_FIRST + 50;
const TCM_HIGHLIGHTITEM = TCM_FIRST + 51;
const TCM_SETEXTENDEDSTYLE = TCM_FIRST + 52;
const TCM_GETEXTENDEDSTYLE = TCM_FIRST + 53;
const TCM_GETITEMW = TCM_FIRST + 60;
const TCM_SETITEMW = TCM_FIRST + 61;
const TCM_INSERTITEMW = TCM_FIRST + 62;
const CCM_SETUNICODEFORMAT = 0x2000 + 5;
const CCM_GETUNICODEFORMAT = 0x2000 + 6;

const WM_GETDLGCODE = 0x0087;
const WM_KEYDOWN = 0x0100;
const WM_SETFONT = 0x0030;
const WM_SIZE = 0x0005;

const DLGC_WANTARROWS = 0x0001;

// ---- Item mask / state bits ----
export const TCIF_TEXT = 0x0001;
export const TCIF_IMAGE = 0x0002;
export const TCIF_RTLREADING = 0x0004;
export const TCIF_PARAM = 0x0008;
export const TCIF_STATE = 0x0010;

const TCIS_HIGHLIGHTED = 0x0002;

// ---- Hit-test flags ----
export const TCHT_NOWHERE = 0x01;
export const TCHT_ONITEMICON = 0x02;
export const TCHT_ONITEMLABEL = 0x04;
export const TCHT_ONITEM = TCHT_ONITEMICON | TCHT_ONITEMLABEL;

// ---- Styles ----
export const TCS_BOTTOM = 0x0002;
export const TCS_FLATBUTTONS = 0x0008;
export const TCS_VERTICAL = 0x0080;
export const TCS_BUTTONS = 0x0100;
export const TCS_MULTILINE = 0x0200;
export const TCS_FIXEDWIDTH = 0x0400;
export const TCS_RAGGEDRIGHT = 0x0800;
export const TCS_OWNERDRAWFIXED = 0x2000;
export const TCS_FOCUSNEVER = 0x8000;

// ---- Notifications (TCN_FIRST = -550) ----
export const TCN_KEYDOWN = (0 - 550) >>> 0;
export const TCN_SELCHANGE = (0 - 551) >>> 0;
export const TCN_SELCHANGING = (0 - 552) >>> 0;
export const TCN_FOCUSCHANGE = (0 - 554) >>> 0;

// ---- Geometry constants (comctl32 tab.c) ----
export const SELECTED_TAB_OFFSET = 2;
export const DISPLAY_AREA_PADDING = 2;
export const CONTROL_BORDER_SIZE = 2;
const BUTTON_SPACINGX = 3;
const BUTTON_SPACINGY = 3;
const FLAT_BTN_SPACINGX = 8;
const MIN_CHAR_LENGTH = 6;

/** TCITEM/TC_ITEM: mask, dwState, dwStateMask, pszText, cchTextMax, iImage, lParam. */
const TCITEM_SIZE = 28;

export interface TabItem {
    text: string;
    iImage: number;
    lParam: number;
    state: number;
    /** Pixel span along the item's row, client-relative. */
    left: number;
    right: number;
    /** Row index; 0 is the row nearest the display area's edge. */
    row: number;
}

export interface TabControlState {
    items: TabItem[];
    curSel: number;
    curFocus: number;
    himl: number;
    /** Per-item extra bytes requested through TCM_SETITEMEXTRA. */
    itemExtra: number;
    padX: number;
    padY: number;
    /** TCM_SETITEMSIZE overrides; fWidthSet/fHeightSet mirror comctl32's latches. */
    tabWidth: number;
    tabHeight: number;
    fWidthSet: boolean;
    fHeightSet: boolean;
    minTabWidth: number;
    rowCount: number;
    exStyle: number;
    toolTips: number;
    unicodeFormat: boolean;
    /** Cleared by anything that can change layout; recomputed on next read. */
    layoutValid: boolean;
    /** Layout inputs the cache was built from — a font or width change invalidates. */
    layoutWidth: number;
    layoutFont: string;
}

const tabStates = new Map<number, TabControlState>();

let purgerRegistered = false;
function ensurePurger(): void {
    if (purgerRegistered) return;
    purgerRegistered = true;
    registerControlStatePurger((hwnd) => tabStates.delete(hwnd));
}

export function getOrCreateTabState(hwnd: number): TabControlState {
    ensurePurger();
    let state = tabStates.get(hwnd);
    if (!state) {
        state = {
            items: [],
            curSel: -1,
            curFocus: -1,
            himl: 0,
            itemExtra: 0,
            padX: 6,
            padY: 3,
            tabWidth: 0,
            tabHeight: 0,
            fWidthSet: false,
            fHeightSet: false,
            minTabWidth: -1,
            rowCount: 0,
            exStyle: 0,
            toolTips: 0,
            unicodeFormat: false,
            layoutValid: false,
            layoutWidth: -1,
            layoutFont: '',
        };
        tabStates.set(hwnd, state);
    }
    return state;
}

export function getTabState(hwnd: number): TabControlState | undefined {
    return tabStates.get(hwnd);
}

export function isTabControl(win: WindowInfo | undefined): boolean {
    return (win?.systemControlClass ?? '').trim().toLowerCase() === 'systabcontrol32';
}

export function resetTabStatesForTests(): void {
    tabStates.clear();
    measureCtx = null;
}

// ---------------------------------------------------------------------------
// Text measurement
//
// Layout is asked for outside any paint (TCM_ADJUSTRECT during the sheet's own
// sizing, hit tests from the pump), so it cannot borrow the overlay DC. A 1x1
// scratch context measures with the same font string the painter selects.
// ---------------------------------------------------------------------------

const CONTROL_FONT = '11px "MS Sans Serif", Tahoma, sans-serif';

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

function getMeasureCtx(): OffscreenCanvasRenderingContext2D | null {
    if (measureCtx) return measureCtx;
    try {
        measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    } catch {
        measureCtx = null;
    }
    return measureCtx;
}

/** Same resolution order as controls.ts getWindowFont (control, else parent). */
export function tabFontCss(win: WindowInfo): string {
    const parent = win.parent !== undefined ? windows.get(win.parent) : undefined;
    const hFont = win.fontHandle || parent?.fontHandle || 0;
    if (!hFont) return CONTROL_FONT;
    return System.getInstance().gdiContext.getFontCss(hFont) ?? CONTROL_FONT;
}

export interface TabTextMetrics {
    textWidth(text: string): number;
    avgCharWidth: number;
    fontHeight: number;
}

function fontPixelHeight(font: string): number {
    const m = /(\d+(?:\.\d+)?)px/.exec(font);
    return m ? Math.round(parseFloat(m[1])) : 11;
}

function makeMetrics(font: string): TabTextMetrics {
    const ctx = getMeasureCtx();
    if (!ctx) {
        // No canvas (unit tests / headless): a fixed-pitch estimate keeps layout
        // deterministic instead of collapsing every tab to zero width.
        const px = fontPixelHeight(font);
        const avg = Math.max(4, Math.round(px * 0.5));
        return { textWidth: (t) => t.length * avg, avgCharWidth: avg, fontHeight: px };
    }
    ctx.font = font;
    const avg = Math.max(1, ctx.measureText('0123456789').width / 10);
    return {
        textWidth: (t) => ctx.measureText(t).width,
        avgCharWidth: avg,
        // comctl32 sizes the row from tmHeight, which is ascent+descent — NOT the
        // font's point/px size. Taking the px size instead makes every tab row two
        // pixels short, so the same helper the control painters use answers here.
        fontHeight: gdiTextMetrics(ctx).height,
    };
}

/** Text as it is drawn/measured: '&' is a mnemonic prefix, '&&' a literal. */
export function stripMnemonic(text: string): string {
    return text.replace(/&(.)/g, '$1');
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function invalidateTabLayout(hwnd: number): void {
    const state = tabStates.get(hwnd);
    if (state) state.layoutValid = false;
}

/**
 * Assign each item its row and pixel span, and derive rowCount/tabHeight.
 * Mirrors comctl32's TAB_SetItemBounds: items flow left to right and wrap to a
 * new row only for TCS_MULTILINE (a single-line control just overflows, which is
 * where the real control would scroll).
 */
export function ensureTabLayout(win: WindowInfo, state: TabControlState = getOrCreateTabState(win.handle)): TabControlState {
    const font = tabFontCss(win);
    const clientWidth = Math.max(1, win.width);
    if (state.layoutValid && state.layoutWidth === clientWidth && state.layoutFont === font) {
        return state;
    }

    const style = win.style >>> 0;
    const metrics = makeMetrics(font);
    const buttons = (style & TCS_BUTTONS) !== 0;
    const multiline = (style & (TCS_MULTILINE | TCS_VERTICAL)) !== 0;

    if (!state.fHeightSet) {
        const itemHeight = metrics.fontHeight + 2;
        state.tabHeight = itemHeight + (buttons ? 2 : 1) * state.padY;
    }

    const defaultMinWidth = metrics.avgCharWidth * MIN_CHAR_LENGTH + state.padX * 2;
    const wrapLimit = clientWidth - CONTROL_BORDER_SIZE - DISPLAY_AREA_PADDING;

    let left = 0;
    let row = state.items.length > 0 ? 1 : 0;

    for (const item of state.items) {
        item.left = left;
        let width: number;
        if ((style & TCS_FIXEDWIDTH) !== 0 && state.fWidthSet) {
            width = state.tabWidth;
        } else if (!item.text) {
            width = state.minTabWidth < 0 ? defaultMinWidth : state.minTabWidth;
        } else {
            width = metrics.textWidth(stripMnemonic(item.text)) + 2 * state.padX;
            width = Math.max(width, state.minTabWidth < 0 ? defaultMinWidth : state.minTabWidth);
        }
        item.right = item.left + Math.ceil(width);

        if (multiline && item.left > 0 && item.right > wrapLimit) {
            item.right -= item.left;
            item.left = 0;
            row++;
        }
        item.row = row - 1;

        left = item.right;
        if (buttons) {
            left += BUTTON_SPACINGX;
            if ((style & TCS_FLATBUTTONS) !== 0) left += FLAT_BTN_SPACINGX;
        }
    }

    state.rowCount = Math.max(row, state.items.length > 0 ? 1 : 0);
    state.layoutValid = true;
    state.layoutWidth = clientWidth;
    state.layoutFont = font;
    return state;
}

export interface TabRect { left: number; top: number; right: number; bottom: number }

/**
 * Client-relative pixel rect of one tab (unselected geometry).
 *
 * The row is inset by SELECTED_TAB_OFFSET on both axes: comctl32 leaves that gap
 * so the SELECTED tab, which is this rect inflated by the same offset, still fits
 * inside the client (TAB_InternalGetItemRect's OffsetRect + the row's top bias).
 */
export function tabItemRect(win: WindowInfo, index: number): TabRect | null {
    const state = ensureTabLayout(win);
    const item = state.items[index];
    if (!item) return null;
    const style = win.style >>> 0;
    const buttons = (style & TCS_BUTTONS) !== 0;
    const rowSpan = state.tabHeight + (buttons ? BUTTON_SPACINGY : 0);
    const height = Math.max(1, win.height);
    const left = item.left + SELECTED_TAB_OFFSET;
    const right = item.right + SELECTED_TAB_OFFSET;

    if ((style & TCS_BOTTOM) !== 0) {
        const bottom = height - item.row * rowSpan - (buttons ? 0 : SELECTED_TAB_OFFSET);
        return { left, top: bottom - state.tabHeight, right, bottom };
    }
    const top = item.row * rowSpan + (buttons ? 0 : SELECTED_TAB_OFFSET);
    return { left, top, right, bottom: top + state.tabHeight };
}

/** Total pixel height the tab rows occupy, including button spacing. */
export function tabRowsHeight(win: WindowInfo, state: TabControlState = ensureTabLayout(win)): number {
    const buttons = (win.style & TCS_BUTTONS) !== 0;
    return state.tabHeight * state.rowCount + (buttons ? BUTTON_SPACINGY * Math.max(0, state.rowCount - 1) : 0);
}

/**
 * TCM_ADJUSTRECT. fLarger=false maps the control's window rect to its display
 * area; fLarger=true goes the other way.
 */
export function adjustTabRect(win: WindowInfo, larger: boolean, rc: TabRect): TabRect {
    const state = ensureTabLayout(win);
    const rows = tabRowsHeight(win, state);
    const bottomTabs = (win.style & TCS_BOTTOM) !== 0;
    const out = { ...rc };
    if (larger) {
        if (bottomTabs) out.bottom += rows; else out.top -= rows;
        out.left -= DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        out.top -= DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        out.right += DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        out.bottom += DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
    } else {
        out.left += DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        out.top += DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        out.right -= DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        out.bottom -= DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        if (bottomTabs) out.bottom -= rows; else out.top += rows;
    }
    return out;
}

/**
 * TAB_InvalidateTabArea: the client rect a selection or focus change damages.
 *
 * It is the tab ROWS only — bounded by the display area on the side the pane is on,
 * and, while there is a single row, by the last tab plus the selected tab's inflation
 * on the other axis. The pane and everything a sibling drew inside it are NOT in it,
 * which is why a tab click in Win32 leaves a property page's content untouched:
 * comctl32 never asks for those pixels back, so nothing repaints over them.
 */
export function tabInvalidateRect(win: WindowInfo): TabRect | null {
    const state = ensureTabLayout(win);
    if (state.items.length === 0 || state.rowCount < 1) return null;
    const style = win.style >>> 0;
    const client: TabRect = { left: 0, top: 0, right: Math.max(1, win.width), bottom: Math.max(1, win.height) };
    const display = adjustTabRect(win, false, { ...client });
    const lastTab = tabItemRect(win, state.items.length - 1);
    const singleRow = state.rowCount === 1 && lastTab !== null;
    const out = { ...client };
    const vertical = (style & TCS_VERTICAL) !== 0;
    const bottom = (style & TCS_BOTTOM) !== 0;

    if (vertical) {
        if (bottom) out.left = display.right; else out.right = display.left;
        if (singleRow) out.bottom = lastTab!.bottom + 2 * SELECTED_TAB_OFFSET;
    } else {
        if (bottom) out.top = display.bottom; else out.bottom = display.top;
        if (singleRow) out.right = lastTab!.right + 2 * SELECTED_TAB_OFFSET;
    }
    out.right = Math.min(out.right, client.right);
    out.bottom = Math.min(out.bottom, client.bottom);
    if (out.right <= out.left || out.bottom <= out.top) return null;
    return out;
}

/** Index of the tab under a control-client point, or -1. */
export function hitTestTab(win: WindowInfo, clientX: number, clientY: number): number {
    const state = ensureTabLayout(win);
    for (let i = 0; i < state.items.length; i++) {
        const r = tabItemRect(win, i);
        if (!r) continue;
        if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) {
            return i;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** NMTCKEYDOWN { NMHDR hdr; WORD wVKey; UINT flags; } */
function postTabKeyDown(win: WindowInfo, vKey: number, flags: number): void {
    postNotify(win, TCN_KEYDOWN, (ptr, mem) => {
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        v.setUint16(ptr + 12, vKey & 0xffff, true);
        v.setUint32(ptr + 16, flags >>> 0, true);
    });
}

/**
 * Change the selection as the USER would (click / keyboard), emitting the
 * documented TCN_SELCHANGING → TCN_SELCHANGE pair.
 *
 * Boundary: TCN_SELCHANGING's veto is NOT honoured. Both notifications are
 * posted, because the paths that reach here (the modal pump's hit test, the
 * control's key handler) hold no thunk context to suspend into the parent's
 * wndproc with, so no LRESULT can come back. Real comctl32's own property sheet
 * does not rely on the veto either — PROPSHEET_DialogProc answers TCN_SELCHANGE
 * and puts the tab back when PSN_KILLACTIVE refuses.
 */
export function selectTabFromUser(win: WindowInfo, index: number): boolean {
    const state = ensureTabLayout(win);
    if (index < 0 || index >= state.items.length) return false;
    if (index === state.curSel) return false;
    postNotify(win, TCN_SELCHANGING);
    state.curSel = index;
    state.curFocus = index;
    postNotify(win, TCN_SELCHANGE);
    return true;
}

/** Keyboard navigation inside the tab row. Returns true when consumed. */
export function handleTabKey(win: WindowInfo, vKey: number): boolean {
    const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
    const VK_HOME = 0x24, VK_END = 0x23;
    const state = ensureTabLayout(win);
    if (state.items.length === 0) return false;

    postTabKeyDown(win, vKey, 0);

    const cur = state.curSel >= 0 ? state.curSel : 0;
    let next = cur;
    switch (vKey) {
        case VK_LEFT:
        case VK_UP:
            next = cur - 1;
            break;
        case VK_RIGHT:
        case VK_DOWN:
            next = cur + 1;
            break;
        case VK_HOME:
            next = 0;
            break;
        case VK_END:
            next = state.items.length - 1;
            break;
        default:
            return false;
    }
    if (next < 0 || next >= state.items.length) return true; // consumed, no move
    selectTabFromUser(win, next);
    return true;
}

// ---------------------------------------------------------------------------
// TCM_* message handling
// ---------------------------------------------------------------------------

function readGuestText(mem: Uint8Array, ptr: number, wide: boolean): string {
    if (!ptr) return '';
    return wide ? Marshaler.readWideString(mem, ptr) : Marshaler.readString(mem, ptr);
}

function writeGuestText(
    mem: Uint8Array, ptr: number, cchMax: number, text: string, wide: boolean,
): void {
    if (!ptr || cchMax <= 0) return;
    if (wide) {
        const chars = Math.min(text.length, cchMax - 1);
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < chars; i++) v.setUint16(ptr + i * 2, text.charCodeAt(i), true);
        v.setUint16(ptr + chars * 2, 0, true);
        return;
    }
    const bytes = encodeAnsi(text);
    const n = Math.min(bytes.length, cchMax - 1);
    for (let i = 0; i < n; i++) mem[ptr + i] = bytes[i];
    mem[ptr + n] = 0;
}

function readTabItem(
    mem: Uint8Array, ptr: number, wide: boolean,
): { mask: number; state: number; stateMask: number; text: string; iImage: number; lParam: number } {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const mask = v.getUint32(ptr, true) >>> 0;
    const pszText = v.getUint32(ptr + 12, true) >>> 0;
    return {
        mask,
        state: v.getUint32(ptr + 4, true) >>> 0,
        stateMask: v.getUint32(ptr + 8, true) >>> 0,
        text: (mask & TCIF_TEXT) ? readGuestText(mem, pszText, wide) : '',
        iImage: v.getInt32(ptr + 20, true),
        lParam: v.getUint32(ptr + 24, true) >>> 0,
    };
}

function applyTabItem(item: TabItem, src: ReturnType<typeof readTabItem>): void {
    if (src.mask & TCIF_TEXT) item.text = src.text;
    if (src.mask & TCIF_IMAGE) item.iImage = src.iImage;
    if (src.mask & TCIF_PARAM) item.lParam = src.lParam;
    if (src.mask & TCIF_STATE) {
        item.state = ((item.state & ~src.stateMask) | (src.state & src.stateMask)) >>> 0;
    }
}

function writeRect(mem: Uint8Array, ptr: number, r: TabRect): void {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    v.setInt32(ptr, r.left, true);
    v.setInt32(ptr + 4, r.top, true);
    v.setInt32(ptr + 8, r.right, true);
    v.setInt32(ptr + 12, r.bottom, true);
}

function readRect(mem: Uint8Array, ptr: number): TabRect {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        left: v.getInt32(ptr, true),
        top: v.getInt32(ptr + 4, true),
        right: v.getInt32(ptr + 8, true),
        bottom: v.getInt32(ptr + 12, true),
    };
}

/** TCM_* that change what is on screen, so the parent must repaint. */
export function isTabContentMessage(msg: number): boolean {
    switch (msg) {
        case TCM_SETIMAGELIST:
        case TCM_SETITEMA:
        case TCM_SETITEMW:
        case TCM_INSERTITEMA:
        case TCM_INSERTITEMW:
        case TCM_DELETEITEM:
        case TCM_DELETEALLITEMS:
        case TCM_SETCURSEL:
        case TCM_SETCURFOCUS:
        case TCM_SETITEMSIZE:
        case TCM_SETPADDING:
        case TCM_SETMINTABWIDTH:
        case TCM_DESELECTALL:
        case TCM_HIGHLIGHTITEM:
        case TCM_REMOVEIMAGE:
        case WM_SETFONT:
        case WM_SIZE:
        case WM_KEYDOWN:
            return true;
        default:
            return false;
    }
}

/**
 * Handle a message for a SysTabControl32. Returns null when the message is not
 * ours, so the shared WM_* path still runs (WM_SETFONT, WM_ENABLE, …).
 */
export function handleTabMessage(
    child: WindowInfo, msg: number, wParam: number, lParam: number, mem: Uint8Array,
): number | null {
    if (!isTabControl(child)) return null;

    if (msg === WM_GETDLGCODE) return DLGC_WANTARROWS;
    if (msg === WM_KEYDOWN) return handleTabKey(child, wParam & 0xff) ? 0 : null;
    if (msg === WM_SETFONT || msg === WM_SIZE) {
        invalidateTabLayout(child.handle);
        return null; // shared path still applies the font / size
    }
    if (msg < TCM_FIRST || msg > TCM_FIRST + 0x100) {
        if (msg !== CCM_SETUNICODEFORMAT && msg !== CCM_GETUNICODEFORMAT) return null;
    }

    const state = getOrCreateTabState(child.handle);
    const index = wParam | 0;

    switch (msg) {
        case TCM_GETITEMCOUNT:
            return state.items.length;

        case TCM_GETCURSEL:
            return state.curSel;

        case TCM_SETCURSEL: {
            const prev = state.curSel;
            if (index < 0 || index >= state.items.length) {
                // comctl32 clears the selection for an out-of-range index.
                state.curSel = -1;
                return prev;
            }
            state.curSel = index;
            state.curFocus = index;
            return prev;
        }

        case TCM_GETCURFOCUS:
            return state.curFocus;

        case TCM_SETCURFOCUS: {
            if (index < 0 || index >= state.items.length) return 0;
            state.curFocus = index;
            // Without TCS_BUTTONS the focus follows the selection (comctl32).
            if ((child.style & TCS_BUTTONS) === 0) {
                selectTabFromUser(child, index);
            } else {
                postNotify(child, TCN_FOCUSCHANGE);
            }
            return 0;
        }

        case TCM_INSERTITEMA:
        case TCM_INSERTITEMW: {
            if (!lParam) return -1;
            const wide = msg === TCM_INSERTITEMW;
            const src = readTabItem(mem, lParam, wide);
            const item: TabItem = {
                text: '', iImage: -1, lParam: 0, state: 0, left: 0, right: 0, row: 0,
            };
            applyTabItem(item, src);
            const at = Math.max(0, Math.min(index, state.items.length));
            state.items.splice(at, 0, item);
            if (state.curSel >= at) state.curSel++;
            if (state.items.length === 1) {
                // First tab selects itself, silently (comctl32 sends no TCN_*).
                state.curSel = 0;
                state.curFocus = 0;
            }
            state.layoutValid = false;
            return at;
        }

        case TCM_SETITEMA:
        case TCM_SETITEMW: {
            const item = state.items[index];
            if (!item || !lParam) return 0;
            applyTabItem(item, readTabItem(mem, lParam, msg === TCM_SETITEMW));
            state.layoutValid = false;
            return 1;
        }

        case TCM_GETITEMA:
        case TCM_GETITEMW: {
            const item = state.items[index];
            if (!item || !lParam) return 0;
            const wide = msg === TCM_GETITEMW;
            const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const mask = v.getUint32(lParam, true) >>> 0;
            if (mask & TCIF_TEXT) {
                writeGuestText(mem, v.getUint32(lParam + 12, true) >>> 0,
                    v.getInt32(lParam + 16, true), item.text, wide);
            }
            if (mask & TCIF_IMAGE) v.setInt32(lParam + 20, item.iImage, true);
            if (mask & TCIF_PARAM) v.setUint32(lParam + 24, item.lParam >>> 0, true);
            if (mask & TCIF_STATE) {
                const stateMask = v.getUint32(lParam + 8, true) >>> 0;
                v.setUint32(lParam + 4, (item.state & stateMask) >>> 0, true);
            }
            return 1;
        }

        case TCM_DELETEITEM: {
            if (index < 0 || index >= state.items.length) return 0;
            state.items.splice(index, 1);
            if (state.curSel === index) state.curSel = -1;
            else if (state.curSel > index) state.curSel--;
            if (state.curFocus >= state.items.length) state.curFocus = state.items.length - 1;
            state.layoutValid = false;
            return 1;
        }

        case TCM_DELETEALLITEMS:
            state.items.length = 0;
            state.curSel = -1;
            state.curFocus = -1;
            state.layoutValid = false;
            return 1;

        case TCM_GETITEMRECT: {
            const r = tabItemRect(child, index);
            if (!r || !lParam) return 0;
            writeRect(mem, lParam, r);
            return 1;
        }

        case TCM_ADJUSTRECT: {
            if (!lParam) return -1;
            writeRect(mem, lParam, adjustTabRect(child, wParam !== 0, readRect(mem, lParam)));
            return 0;
        }

        case TCM_HITTEST: {
            if (!lParam) return -1;
            const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const x = v.getInt32(lParam, true);
            const y = v.getInt32(lParam + 4, true);
            const hit = hitTestTab(child, x, y);
            v.setUint32(lParam + 8, hit >= 0 ? TCHT_ONITEMLABEL : TCHT_NOWHERE, true);
            return hit;
        }

        case TCM_GETROWCOUNT:
            return ensureTabLayout(child, state).rowCount;

        case TCM_SETITEMSIZE: {
            const prev = ((state.tabHeight & 0xffff) << 16) | (state.tabWidth & 0xffff);
            state.tabWidth = lParam & 0xffff;
            state.tabHeight = (lParam >>> 16) & 0xffff;
            state.fWidthSet = true;
            state.fHeightSet = true;
            state.layoutValid = false;
            return prev >>> 0;
        }

        case TCM_SETPADDING:
            state.padX = lParam & 0xffff;
            state.padY = (lParam >>> 16) & 0xffff;
            state.layoutValid = false;
            return 0;

        case TCM_SETMINTABWIDTH: {
            const prev = state.minTabWidth;
            state.minTabWidth = lParam | 0;
            state.layoutValid = false;
            return prev;
        }

        case TCM_SETIMAGELIST: {
            const prev = state.himl;
            state.himl = lParam >>> 0;
            state.layoutValid = false;
            return prev;
        }

        case TCM_GETIMAGELIST:
            return state.himl;

        case TCM_REMOVEIMAGE: {
            for (const item of state.items) {
                if (item.iImage === index) item.iImage = -1;
                else if (item.iImage > index) item.iImage--;
            }
            state.layoutValid = false;
            return 0;
        }

        case TCM_SETITEMEXTRA:
            if (state.items.length > 0) return 0; // comctl32 refuses once items exist
            state.itemExtra = Math.max(0, wParam | 0);
            return 1;

        case TCM_SETTOOLTIPS:
            state.toolTips = wParam >>> 0;
            return 0;

        case TCM_GETTOOLTIPS:
            return state.toolTips;

        case TCM_DESELECTALL:
            for (const item of state.items) item.state &= ~TCIS_HIGHLIGHTED;
            return 0;

        case TCM_HIGHLIGHTITEM: {
            const item = state.items[index];
            if (!item) return 0;
            if (lParam & 0xffff) item.state |= TCIS_HIGHLIGHTED;
            else item.state &= ~TCIS_HIGHLIGHTED;
            return 1;
        }

        case TCM_SETEXTENDEDSTYLE: {
            const prev = state.exStyle;
            const mask = wParam >>> 0;
            state.exStyle = mask
                ? (((state.exStyle & ~mask) | (lParam & mask)) >>> 0)
                : (lParam >>> 0);
            return prev;
        }

        case TCM_GETEXTENDEDSTYLE:
            return state.exStyle;

        case CCM_SETUNICODEFORMAT: {
            const prev = state.unicodeFormat ? 1 : 0;
            state.unicodeFormat = wParam !== 0;
            return prev;
        }

        case CCM_GETUNICODEFORMAT:
            return state.unicodeFormat ? 1 : 0;

        default:
            // An unhandled TCM_* in range: comctl32 answers 0 rather than falling
            // through to DefWindowProc, which would treat it as an app message.
            Logger.verbose(LogCategory.USER32,
                `SysTabControl32: unhandled TCM 0x${msg.toString(16)} hwnd=0x${child.handle.toString(16)}`);
            return 0;
    }
}

/** Sanity dump for the harness. */
export function formatTabDiagnostic(hwnd: number): string {
    const win = windows.get(hwnd);
    const state = tabStates.get(hwnd);
    if (!win || !state) return `tab 0x${hwnd.toString(16)}: none`;
    ensureTabLayout(win, state);
    const items = state.items.map((it, i) =>
        `${i === state.curSel ? '*' : ''}${JSON.stringify(it.text)}@r${it.row}[${it.left},${it.right})`).join(' ');
    return `tab 0x${hwnd.toString(16)} rows=${state.rowCount} h=${state.tabHeight} sel=${state.curSel} ${items}`;
}

export const TAB_ITEM_STRUCT_SIZE = TCITEM_SIZE;
