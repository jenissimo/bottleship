/**
 * SysListView32 (comctl32 v5.81): LVM_* protocol, selection, columns, and
 * parent WM_NOTIFY (NMLISTVIEW). Own ListViewState — not ListControlState.
 */

import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import { encodeAnsi } from '../codepage-utils';
import { WindowInfo, registerControlStatePurger } from './shared-state';
import { SB_WIDTH } from './scrollbar-paint';
import { controlClientInset } from './controls';

// ---- Messages (LVM_FIRST = 0x1000) ----
const LVM_FIRST = 0x1000;
const LVM_GETBKCOLOR = LVM_FIRST + 0;
const LVM_SETBKCOLOR = LVM_FIRST + 1;
const LVM_GETIMAGELIST = LVM_FIRST + 2;
const LVM_SETIMAGELIST = LVM_FIRST + 3;
const LVM_GETITEMCOUNT = LVM_FIRST + 4;
const LVM_GETITEMA = LVM_FIRST + 5;
const LVM_SETITEMA = LVM_FIRST + 6;
const LVM_INSERTITEMA = LVM_FIRST + 7;
const LVM_DELETEITEM = LVM_FIRST + 8;
const LVM_DELETEALLITEMS = LVM_FIRST + 9;
const LVM_GETNEXTITEM = LVM_FIRST + 12;
const LVM_GETITEMRECT = LVM_FIRST + 14;
const LVM_HITTEST = LVM_FIRST + 18;
const LVM_ENSUREVISIBLE = LVM_FIRST + 19;
const LVM_SCROLL = LVM_FIRST + 20;
const LVM_REDRAWITEMS = LVM_FIRST + 21;
const LVM_GETCOLUMNA = LVM_FIRST + 25;
const LVM_SETCOLUMNA = LVM_FIRST + 26;
const LVM_INSERTCOLUMNA = LVM_FIRST + 27;
const LVM_DELETECOLUMN = LVM_FIRST + 28;
const LVM_GETCOLUMNWIDTH = LVM_FIRST + 29;
const LVM_SETCOLUMNWIDTH = LVM_FIRST + 30;
const LVM_GETTEXTCOLOR = LVM_FIRST + 35;
const LVM_SETTEXTCOLOR = LVM_FIRST + 36;
const LVM_GETTEXTBKCOLOR = LVM_FIRST + 37;
const LVM_SETTEXTBKCOLOR = LVM_FIRST + 38;
const LVM_GETTOPINDEX = LVM_FIRST + 39;
const LVM_GETCOUNTPERPAGE = LVM_FIRST + 40;
const LVM_UPDATE = LVM_FIRST + 42;
const LVM_SETITEMSTATE = LVM_FIRST + 43;
const LVM_GETITEMSTATE = LVM_FIRST + 44;
const LVM_GETITEMTEXTA = LVM_FIRST + 45;
const LVM_SETITEMTEXTA = LVM_FIRST + 46;
const LVM_SETITEMCOUNT = LVM_FIRST + 47;
const LVM_GETSELECTEDCOUNT = LVM_FIRST + 50;
const LVM_SETEXTENDEDLISTVIEWSTYLE = LVM_FIRST + 54;
const LVM_GETEXTENDEDLISTVIEWSTYLE = LVM_FIRST + 55;
const LVM_SETHOTITEM = LVM_FIRST + 60;
const LVM_GETHOTITEM = LVM_FIRST + 61;
const LVM_GETSELECTIONMARK = LVM_FIRST + 66;
const LVM_SETSELECTIONMARK = LVM_FIRST + 67;
const LVM_GETITEMW = LVM_FIRST + 75;
const LVM_SETITEMW = LVM_FIRST + 76;
const LVM_INSERTITEMW = LVM_FIRST + 77;
const LVM_GETCOLUMNW = LVM_FIRST + 95;
const LVM_SETCOLUMNW = LVM_FIRST + 96;
const LVM_INSERTCOLUMNW = LVM_FIRST + 97;
const LVM_GETITEMTEXTW = LVM_FIRST + 115;
const LVM_SETITEMTEXTW = LVM_FIRST + 116;

// ---- Styles / flags ----
const LVS_ICON = 0x0000;
const LVS_REPORT = 0x0001;
const LVS_SMALLICON = 0x0002;
const LVS_LIST = 0x0003;
const LVS_TYPEMASK = 0x0003;
const LVS_SINGLESEL = 0x0004;
const LVS_SHOWSELALWAYS = 0x0008;
const LVS_NOCOLUMNHEADER = 0x4000;
const LVS_NOSCROLL = 0x2000;

const LVSIL_NORMAL = 0;
const LVSIL_SMALL = 1;
const LVSIL_STATE = 2;

const LVIF_TEXT = 0x0001;
const LVIF_IMAGE = 0x0002;
const LVIF_PARAM = 0x0004;
const LVIF_STATE = 0x0008;
const LVIF_INDENT = 0x0010;

const LVIS_FOCUSED = 0x0001;
const LVIS_SELECTED = 0x0002;
const LVIS_CUT = 0x0004;
const LVIS_DROPHILITED = 0x0008;
const LVIS_STATEIMAGEMASK = 0xF000;

const LVNI_ALL = 0x0000;
const LVNI_FOCUSED = 0x0001;
const LVNI_SELECTED = 0x0002;
const LVNI_CUT = 0x0004;
const LVNI_DROPHILITED = 0x0008;
const LVNI_STATEMASK = LVNI_FOCUSED | LVNI_SELECTED | LVNI_CUT | LVNI_DROPHILITED;
const LVNI_ABOVE = 0x0100;
const LVNI_BELOW = 0x0200;
const LVNI_TOLEFT = 0x0400;
const LVNI_TORIGHT = 0x0800;
const LVNI_DIRECTIONMASK = LVNI_ABOVE | LVNI_BELOW | LVNI_TOLEFT | LVNI_TORIGHT;

const LVCF_FMT = 0x0001;
const LVCF_WIDTH = 0x0002;
const LVCF_TEXT = 0x0004;
const LVCF_SUBITEM = 0x0008;
const LVCF_IMAGE = 0x0010;
const LVCF_ORDER = 0x0020;

const LVIR_BOUNDS = 0;
const LVIR_ICON = 1;
const LVIR_LABEL = 2;
const LVIR_SELECTBOUNDS = 3;

const LVHT_NOWHERE = 0x0001;
const LVHT_ONITEMICON = 0x0002;
const LVHT_ONITEMLABEL = 0x0004;
const LVHT_ONITEMSTATEICON = 0x0008;
const LVHT_ONITEM = LVHT_ONITEMICON | LVHT_ONITEMLABEL | LVHT_ONITEMSTATEICON;
const LVHT_ABOVE = 0x0008;
const LVHT_BELOW = 0x0010;
const LVHT_TORIGHT = 0x0020;
const LVHT_TOLEFT = 0x0040;

const CLR_NONE = 0xFFFFFFFF;
const CLR_DEFAULT = 0xFF000000;
const LPSTR_TEXTCALLBACK = 0xFFFFFFFF;

const WM_NOTIFY = 0x004E;
const WM_KEYDOWN = 0x0100;
const WM_GETDLGCODE = 0x0087;
const DLGC_WANTARROWS = 0x0001;
const DLGC_WANTCHARS = 0x0080;
const NM_CLICK = (0 - 2) >>> 0;
const NM_DBLCLK = (0 - 3) >>> 0;
const LVN_FIRST = (0 - 100) >>> 0;
const LVN_ITEMCHANGING = (LVN_FIRST - 0) >>> 0;
const LVN_ITEMCHANGED = (LVN_FIRST - 1) >>> 0;
const LVN_INSERTITEM = (LVN_FIRST - 2) >>> 0;
const LVN_DELETEITEM = (LVN_FIRST - 3) >>> 0;
const LVN_DELETEALLITEMS = (LVN_FIRST - 4) >>> 0;
const LVN_COLUMNCLICK = (LVN_FIRST - 8) >>> 0;
const LVN_KEYDOWN = (LVN_FIRST - 55) >>> 0;

const VK_UP = 0x26;
const VK_DOWN = 0x28;
const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;
const VK_HOME = 0x24;
const VK_END = 0x23;
const VK_SPACE = 0x20;
const VK_RETURN = 0x0D;
const MK_CONTROL = 0x0008;
const MK_SHIFT = 0x0004;

/**
 * Report-view row height / header — classic comctl metrics. A report row is one
 * text cell plus a pixel (tmHeight 13 + 1 for the classic UI font), measured off a
 * native capture: rows land on a 14 px pitch, so a 120 px list shows 7 of them.
 */
export const LV_ROW_H = 14;
export const LV_HEADER_H = 18;
export const LV_ICON_SIZE = 32;
export const LV_SMALL_ICON_SIZE = 16;
export const LV_ICON_PAD = 4;
export const LV_TEXT_INSET = 4;
export const LV_SCROLLBAR_W = SB_WIDTH;

export interface ListViewSubItem {
    text: string;
    iImage: number;
}

export interface ListViewItem {
    text: string;
    state: number;
    iImage: number;
    lParam: number;
    iIndent: number;
    subItems: ListViewSubItem[];
}

export interface ListViewColumn {
    fmt: number;
    cx: number;
    text: string;
    iSubItem: number;
    iImage: number;
    iOrder: number;
}

export interface ListViewState {
    items: ListViewItem[];
    columns: ListViewColumn[];
    himlNormal: number;
    himlSmall: number;
    himlState: number;
    exStyle: number;
    selectionMark: number;
    focusedItem: number;
    hotItem: number;
    topIndex: number;
    scrollX: number;
    bkColor: number;
    textColor: number;
    textBkColor: number;
}

const listViewStates = new Map<number, ListViewState>();

let purgerRegistered = false;

function ensurePurger(): void {
    if (purgerRegistered) return;
    purgerRegistered = true;
    registerControlStatePurger((hwnd) => listViewStates.delete(hwnd));
}

function emptyState(): ListViewState {
    return {
        items: [],
        columns: [],
        himlNormal: 0,
        himlSmall: 0,
        himlState: 0,
        exStyle: 0,
        selectionMark: -1,
        focusedItem: -1,
        hotItem: -1,
        topIndex: 0,
        scrollX: 0,
        bkColor: CLR_DEFAULT,
        textColor: CLR_DEFAULT,
        textBkColor: CLR_DEFAULT,
    };
}

export function isListViewControl(win: WindowInfo | undefined): boolean {
    if (!win) return false;
    const n = (win.systemControlClass ?? win.nativeClassName ?? '').trim().toLowerCase();
    return n === 'syslistview32';
}

export function getOrCreateListViewState(hwnd: number): ListViewState {
    ensurePurger();
    let state = listViewStates.get(hwnd);
    if (!state) {
        state = emptyState();
        listViewStates.set(hwnd, state);
    }
    return state;
}

export function getListViewState(hwnd: number): ListViewState | undefined {
    return listViewStates.get(hwnd);
}

/** Clear module state (unit tests). */
export function resetListViewStatesForTests(): void {
    listViewStates.clear();
    notifyScratchBase = 0;
    notifyScratchIndex = 0;
}

export function isListViewContentMessage(msg: number): boolean {
    switch (msg) {
        case LVM_SETBKCOLOR:
        case LVM_SETIMAGELIST:
        case LVM_SETITEMA:
        case LVM_SETITEMW:
        case LVM_INSERTITEMA:
        case LVM_INSERTITEMW:
        case LVM_DELETEITEM:
        case LVM_DELETEALLITEMS:
        case LVM_SETCOLUMNA:
        case LVM_SETCOLUMNW:
        case LVM_INSERTCOLUMNA:
        case LVM_INSERTCOLUMNW:
        case LVM_DELETECOLUMN:
        case LVM_SETCOLUMNWIDTH:
        case LVM_SETTEXTCOLOR:
        case LVM_SETTEXTBKCOLOR:
        case LVM_SETITEMSTATE:
        case LVM_SETITEMTEXTA:
        case LVM_SETITEMTEXTW:
        case LVM_SETITEMCOUNT:
        case LVM_SETEXTENDEDLISTVIEWSTYLE:
        case LVM_SCROLL:
        case LVM_ENSUREVISIBLE:
        case LVM_REDRAWITEMS:
        case LVM_UPDATE:
            return true;
        default:
            return false;
    }
}

export function listViewViewStyle(style: number): number {
    return style & LVS_TYPEMASK;
}

export function listViewHasHeader(child: WindowInfo): boolean {
    const view = listViewViewStyle(child.style);
    if (view !== LVS_REPORT) return false;
    return (child.style & LVS_NOCOLUMNHEADER) === 0;
}

export function listViewRowHeight(child: WindowInfo): number {
    const view = listViewViewStyle(child.style);
    if (view === LVS_ICON) return LV_ICON_SIZE + LV_ICON_PAD * 2 + 14;
    if (view === LVS_SMALLICON) return LV_SMALL_ICON_SIZE + 4;
    return LV_ROW_H;
}

export function listViewVisibleCount(child: WindowInfo): number {
    const header = listViewHasHeader(child) ? LV_HEADER_H : 0;
    const rowH = listViewRowHeight(child);
    return Math.max(1, Math.floor((child.height - header - 4) / rowH));
}

export function clampListViewTopIndex(child: WindowInfo, state: ListViewState): void {
    if ((child.style & LVS_NOSCROLL) !== 0) {
        state.topIndex = 0;
        return;
    }
    const maxTop = Math.max(0, state.items.length - listViewVisibleCount(child));
    state.topIndex = Math.max(0, Math.min(state.topIndex | 0, maxTop));
}

export function listViewSelectedCount(state: ListViewState): number {
    let n = 0;
    for (const it of state.items) {
        if (it.state & LVIS_SELECTED) n++;
    }
    return n;
}

// ---- Guest struct helpers (32-bit LVITEMA/W V1 layout) ----
// mask,iItem,iSubItem,state,stateMask,pszText,cchTextMax,iImage,lParam[,iIndent]

interface LvItemFields {
    mask: number;
    iItem: number;
    iSubItem: number;
    state: number;
    stateMask: number;
    pszText: number;
    cchTextMax: number;
    iImage: number;
    lParam: number;
    iIndent: number;
}

function readLvItem(mem: Uint8Array, ptr: number): LvItemFields | null {
    if (!ptr || ptr + 36 > mem.length) return null;
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        mask: v.getUint32(ptr, true),
        iItem: v.getInt32(ptr + 4, true),
        iSubItem: v.getInt32(ptr + 8, true),
        state: v.getUint32(ptr + 12, true),
        stateMask: v.getUint32(ptr + 16, true),
        pszText: v.getUint32(ptr + 20, true),
        cchTextMax: v.getInt32(ptr + 24, true),
        iImage: v.getInt32(ptr + 28, true),
        lParam: v.getUint32(ptr + 32, true),
        iIndent: ptr + 40 <= mem.length ? v.getInt32(ptr + 36, true) : 0,
    };
}

function writeLvItemOut(
    mem: Uint8Array, ptr: number, fields: Partial<LvItemFields>, mask: number,
): void {
    if (!ptr || ptr + 36 > mem.length) return;
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (mask & LVIF_STATE) {
        v.setUint32(ptr + 12, fields.state ?? 0, true);
    }
    if (mask & LVIF_IMAGE) {
        v.setInt32(ptr + 28, fields.iImage ?? -1, true);
    }
    if (mask & LVIF_PARAM) {
        v.setUint32(ptr + 32, fields.lParam ?? 0, true);
    }
    if (mask & LVIF_INDENT && ptr + 40 <= mem.length) {
        v.setInt32(ptr + 36, fields.iIndent ?? 0, true);
    }
}

interface LvColumnFields {
    mask: number;
    fmt: number;
    cx: number;
    pszText: number;
    cchTextMax: number;
    iSubItem: number;
    iImage: number;
    iOrder: number;
}

function readLvColumn(mem: Uint8Array, ptr: number): LvColumnFields | null {
    if (!ptr || ptr + 24 > mem.length) return null;
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        mask: v.getUint32(ptr, true),
        fmt: v.getInt32(ptr + 4, true),
        cx: v.getInt32(ptr + 8, true),
        pszText: v.getUint32(ptr + 12, true),
        cchTextMax: v.getInt32(ptr + 16, true),
        iSubItem: v.getInt32(ptr + 20, true),
        iImage: ptr + 28 <= mem.length ? v.getInt32(ptr + 24, true) : -1,
        iOrder: ptr + 32 <= mem.length ? v.getInt32(ptr + 28, true) : 0,
    };
}

function readGuestText(mem: Uint8Array, pszText: number, wide: boolean): string {
    if (!pszText || pszText === LPSTR_TEXTCALLBACK) return '';
    return wide ? Marshaler.readWideString(mem, pszText) : Marshaler.readString(mem, pszText);
}

function writeGuestText(
    mem: Uint8Array, pszText: number, cchTextMax: number, text: string, wide: boolean,
): void {
    if (!pszText || pszText === LPSTR_TEXTCALLBACK || cchTextMax <= 0) return;
    if (wide) {
        Marshaler.writeWideString(mem, pszText, text, cchTextMax);
    } else {
        const bytes = encodeAnsi(text);
        const max = Math.max(0, cchTextMax - 1);
        const n = Math.min(bytes.length, max);
        for (let i = 0; i < n; i++) mem[pszText + i] = bytes[i];
        mem[pszText + n] = 0;
    }
}

function itemText(item: ListViewItem, subItem: number): string {
    if (subItem <= 0) return item.text;
    const si = item.subItems[subItem - 1];
    return si?.text ?? '';
}

function setItemText(item: ListViewItem, subItem: number, text: string): void {
    if (subItem <= 0) {
        item.text = text;
        return;
    }
    while (item.subItems.length < subItem) {
        item.subItems.push({ text: '', iImage: -1 });
    }
    item.subItems[subItem - 1].text = text;
}

function setItemImage(item: ListViewItem, subItem: number, iImage: number): void {
    if (subItem <= 0) {
        item.iImage = iImage;
        return;
    }
    while (item.subItems.length < subItem) {
        item.subItems.push({ text: '', iImage: -1 });
    }
    item.subItems[subItem - 1].iImage = iImage;
}

// ---- WM_NOTIFY (posted; scratch valid until the parent's wndproc consumes it) ----
// Same constraint as edit EN_*: a sync LRESULT sink cannot suspend into a guest
// wndproc, so we post. A small ring of THUNK_DATA NMLISTVIEW buffers keeps the
// struct alive across the pump hop without reuse races on nested notifies.

const NMLISTVIEW_SIZE = 44;
const NMITEMACTIVATE_SIZE = 48;
const NMLVKEYDOWN_SIZE = 20;
const NOTIFY_SLOT_SIZE = 64;
const NOTIFY_RING = 8;

let notifyScratchBase = 0;
let notifyScratchIndex = 0;

function allocNotifySlot(): number {
    const process = System.getInstance().process;
    if (!process) return 0;
    if (!notifyScratchBase) {
        notifyScratchBase = process.memory.alloc(NOTIFY_SLOT_SIZE * NOTIFY_RING, 'THUNK_DATA', 'rw');
    }
    if (!notifyScratchBase) return 0;
    const slot = notifyScratchBase + (notifyScratchIndex % NOTIFY_RING) * NOTIFY_SLOT_SIZE;
    notifyScratchIndex++;
    return slot;
}

function writeNmHdr(mem: Uint8Array, ptr: number, hwndFrom: number, idFrom: number, code: number): void {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    v.setUint32(ptr, hwndFrom >>> 0, true);
    v.setUint32(ptr + 4, idFrom >>> 0, true);
    v.setUint32(ptr + 8, code >>> 0, true);
}

function postNotify(child: WindowInfo, code: number, fill: (ptr: number, mem: Uint8Array) => void): void {
    const parent = child.parent;
    if (!parent) return;
    const process = System.getInstance().process;
    const mem = process?.getCurrentMemory?.();
    if (!mem) return;
    const ptr = allocNotifySlot();
    if (!ptr) return;
    for (let i = 0; i < NOTIFY_SLOT_SIZE; i++) mem[ptr + i] = 0;
    writeNmHdr(mem, ptr, child.handle, (child.controlId ?? 0) >>> 0, code);
    fill(ptr, mem);
    const system = System.getInstance();
    system.windowManager.postMessage(parent, WM_NOTIFY, (child.controlId ?? 0) >>> 0, ptr);
    system.scheduler.wakeMessageWaiters();
}

function postNmListView(
    child: WindowInfo,
    code: number,
    iItem: number,
    iSubItem: number,
    uNewState: number,
    uOldState: number,
    uChanged: number,
    lParam: number,
    ptX = 0,
    ptY = 0,
): void {
    postNotify(child, code, (ptr, mem) => {
        if (ptr + NMLISTVIEW_SIZE > mem.length) return;
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        v.setInt32(ptr + 12, iItem, true);
        v.setInt32(ptr + 16, iSubItem, true);
        v.setUint32(ptr + 20, uNewState >>> 0, true);
        v.setUint32(ptr + 24, uOldState >>> 0, true);
        v.setUint32(ptr + 28, uChanged >>> 0, true);
        v.setInt32(ptr + 32, ptX, true);
        v.setInt32(ptr + 36, ptY, true);
        v.setUint32(ptr + 40, lParam >>> 0, true);
    });
}

export function postListViewClickNotify(
    child: WindowInfo,
    dblClick: boolean,
    iItem: number,
    iSubItem: number,
    clientX: number,
    clientY: number,
    keyFlags: number,
): void {
    const state = getOrCreateListViewState(child.handle);
    const item = iItem >= 0 && iItem < state.items.length ? state.items[iItem] : undefined;
    postNotify(child, dblClick ? NM_DBLCLK : NM_CLICK, (ptr, mem) => {
        if (ptr + NMITEMACTIVATE_SIZE > mem.length) return;
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        v.setInt32(ptr + 12, iItem, true);
        v.setInt32(ptr + 16, iSubItem, true);
        v.setUint32(ptr + 20, item?.state ?? 0, true);
        v.setUint32(ptr + 24, 0, true);
        v.setUint32(ptr + 28, 0, true);
        v.setInt32(ptr + 32, clientX, true);
        v.setInt32(ptr + 36, clientY, true);
        v.setUint32(ptr + 40, item?.lParam ?? 0, true);
        v.setUint32(ptr + 44, keyFlags >>> 0, true);
    });
}

export function postListViewKeyDown(child: WindowInfo, vKey: number): void {
    postNotify(child, LVN_KEYDOWN, (ptr, mem) => {
        if (ptr + NMLVKEYDOWN_SIZE > mem.length) return;
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        v.setUint16(ptr + 12, vKey & 0xFFFF, true);
        v.setUint32(ptr + 16, 0, true);
    });
}

function notifyItemStateChange(
    child: WindowInfo,
    iItem: number,
    oldState: number,
    newState: number,
    changedMask: number,
): void {
    if (oldState === newState) return;
    const item = getOrCreateListViewState(child.handle).items[iItem];
    const lParam = item?.lParam ?? 0;
    postNmListView(child, LVN_ITEMCHANGING, iItem, 0, newState, oldState, LVIF_STATE, lParam);
    postNmListView(child, LVN_ITEMCHANGED, iItem, 0, newState, oldState, changedMask | LVIF_STATE, lParam);
}

// ---- Selection ----

function clearFocus(state: ListViewState, child: WindowInfo, except = -1): void {
    for (let i = 0; i < state.items.length; i++) {
        if (i === except) continue;
        if (state.items[i].state & LVIS_FOCUSED) {
            const old = state.items[i].state;
            state.items[i].state &= ~LVIS_FOCUSED;
            notifyItemStateChange(child, i, old, state.items[i].state, LVIF_STATE);
        }
    }
}

function clearSelection(state: ListViewState, child: WindowInfo, except = -1): void {
    for (let i = 0; i < state.items.length; i++) {
        if (i === except) continue;
        if (state.items[i].state & LVIS_SELECTED) {
            const old = state.items[i].state;
            state.items[i].state &= ~LVIS_SELECTED;
            notifyItemStateChange(child, i, old, state.items[i].state, LVIF_STATE);
        }
    }
}

function applyItemState(
    child: WindowInfo,
    state: ListViewState,
    iItem: number,
    newBits: number,
    stateMask: number,
): boolean {
    if (iItem < 0 || iItem >= state.items.length) return false;
    const item = state.items[iItem];
    const oldState = item.state;
    let next = (oldState & ~stateMask) | (newBits & stateMask);

    if ((stateMask & LVIS_FOCUSED) && (next & LVIS_FOCUSED)) {
        clearFocus(state, child, iItem);
        state.focusedItem = iItem;
    } else if ((stateMask & LVIS_FOCUSED) && !(next & LVIS_FOCUSED) && state.focusedItem === iItem) {
        state.focusedItem = -1;
    }

    if ((stateMask & LVIS_SELECTED) && (next & LVIS_SELECTED) && (child.style & LVS_SINGLESEL)) {
        clearSelection(state, child, iItem);
    }

    if ((stateMask & LVIS_SELECTED) && (next & LVIS_SELECTED)) {
        state.selectionMark = iItem;
    }

    item.state = next;
    if (oldState !== next) {
        notifyItemStateChange(child, iItem, oldState, next, LVIF_STATE);
    }
    return true;
}

function setItemStateAll(
    child: WindowInfo,
    state: ListViewState,
    newBits: number,
    stateMask: number,
): boolean {
    if ((newBits & stateMask & LVIS_FOCUSED)) return false;
    if ((newBits & stateMask & LVIS_SELECTED) && (child.style & LVS_SINGLESEL)) return false;
    if (!(newBits & stateMask & LVIS_SELECTED) && (stateMask & LVIS_SELECTED) && listViewSelectedCount(state) === 0) {
        return true;
    }
    for (let i = 0; i < state.items.length; i++) {
        applyItemState(child, state, i, newBits, stateMask);
    }
    return true;
}

/**
 * Mouse / keyboard selection. `mods` uses MK_CONTROL / MK_SHIFT.
 * Returns the item index that received focus, or -1.
 */
export function selectListViewAtIndex(
    child: WindowInfo,
    index: number,
    mods: number = 0,
): number {
    const state = getOrCreateListViewState(child.handle);
    if (index < 0 || index >= state.items.length) return -1;

    const single = (child.style & LVS_SINGLESEL) !== 0;
    const ctrl = !single && (mods & MK_CONTROL) !== 0;
    const shift = !single && (mods & MK_SHIFT) !== 0;

    if (shift && state.selectionMark >= 0) {
        const a = Math.min(state.selectionMark, index);
        const b = Math.max(state.selectionMark, index);
        if (!ctrl) clearSelection(state, child, -1);
        for (let i = a; i <= b; i++) {
            applyItemState(child, state, i, LVIS_SELECTED, LVIS_SELECTED);
        }
        clearFocus(state, child, index);
        applyItemState(child, state, index, LVIS_FOCUSED, LVIS_FOCUSED);
        return index;
    }

    if (ctrl) {
        const cur = state.items[index].state;
        const sel = (cur & LVIS_SELECTED) ? 0 : LVIS_SELECTED;
        applyItemState(child, state, index, sel, LVIS_SELECTED);
        clearFocus(state, child, index);
        applyItemState(child, state, index, LVIS_FOCUSED, LVIS_FOCUSED);
        state.selectionMark = index;
        return index;
    }

    clearSelection(state, child, index);
    clearFocus(state, child, index);
    applyItemState(child, state, index, LVIS_SELECTED | LVIS_FOCUSED, LVIS_SELECTED | LVIS_FOCUSED);
    state.selectionMark = index;
    ensureListViewVisible(child, index, false);
    return index;
}

export function ensureListViewVisible(child: WindowInfo, index: number, _partialOk: boolean): boolean {
    const state = getOrCreateListViewState(child.handle);
    if (index < 0 || index >= state.items.length) return false;
    if ((child.style & LVS_NOSCROLL) !== 0) return true;
    const visible = listViewVisibleCount(child);
    if (index < state.topIndex) state.topIndex = index;
    else if (index >= state.topIndex + visible) state.topIndex = index - visible + 1;
    clampListViewTopIndex(child, state);
    return true;
}

export interface ListViewHitResult {
    flags: number;
    iItem: number;
    iSubItem: number;
}

/** Client-space hit test (x/y relative to the control). */
/**
 * Column under a client x in the HEADER. hitTestListView answers LVHT_NOWHERE there
 * (the header is not the item area), but a header click is still a click on a
 * column — this is the same left-to-right walk over cx, minus the row lookup.
 */
export function listViewColumnAtClientX(child: WindowInfo, clientX: number): number {
    const state = getOrCreateListViewState(child.handle);
    // The same origin the header painter starts at, so the hit test cannot sit a
    // pixel off a column drawn behind a client edge or border.
    let x = controlClientInset(child) - state.scrollX;
    for (let c = 0; c < state.columns.length; c++) {
        const cx = Math.max(0, state.columns[c].cx);
        if (clientX >= x && clientX < x + cx) return c;
        x += cx;
    }
    return -1;
}

/** LVN_COLUMNCLICK — what comctl32 sends when the user clicks a report header. */
export function postListViewColumnClick(child: WindowInfo, iSubItem: number): void {
    postNmListView(child, LVN_COLUMNCLICK, -1, iSubItem, 0, 0, 0, 0);
}

export function hitTestListView(
    child: WindowInfo,
    clientX: number,
    clientY: number,
): ListViewHitResult {
    const state = getOrCreateListViewState(child.handle);
    const view = listViewViewStyle(child.style);
    const headerH = listViewHasHeader(child) ? LV_HEADER_H : 0;
    const inset = 2;

    if (clientX < 0) return { flags: LVHT_TOLEFT, iItem: -1, iSubItem: 0 };
    if (clientY < 0) return { flags: LVHT_ABOVE, iItem: -1, iSubItem: 0 };
    if (clientX >= child.width) return { flags: LVHT_TORIGHT, iItem: -1, iSubItem: 0 };
    if (clientY >= child.height) return { flags: LVHT_BELOW, iItem: -1, iSubItem: 0 };

    if (clientY < headerH) {
        return { flags: LVHT_NOWHERE, iItem: -1, iSubItem: 0 };
    }

    const rowH = listViewRowHeight(child);
    const bodyY = clientY - headerH - inset;
    if (bodyY < 0) return { flags: LVHT_NOWHERE, iItem: -1, iSubItem: 0 };

    if (view === LVS_ICON) {
        const cellW = LV_ICON_SIZE + 40;
        const cellH = rowH;
        const cols = Math.max(1, Math.floor((child.width - inset * 2 - LV_SCROLLBAR_W) / cellW));
        const col = Math.floor((clientX - inset) / cellW);
        const row = Math.floor(bodyY / cellH);
        if (col < 0 || col >= cols) return { flags: LVHT_NOWHERE, iItem: -1, iSubItem: 0 };
        const idx = state.topIndex + row * cols + col;
        if (idx < 0 || idx >= state.items.length) return { flags: LVHT_NOWHERE, iItem: -1, iSubItem: 0 };
        return { flags: LVHT_ONITEM | LVHT_ONITEMLABEL, iItem: idx, iSubItem: 0 };
    }

    const idx = state.topIndex + Math.floor(bodyY / rowH);
    if (idx < 0 || idx >= state.items.length) {
        return { flags: LVHT_NOWHERE, iItem: -1, iSubItem: 0 };
    }

    let iSubItem = 0;
    if (view === LVS_REPORT && state.columns.length > 0) {
        let x = inset - state.scrollX;
        for (let c = 0; c < state.columns.length; c++) {
            const cx = Math.max(0, state.columns[c].cx);
            if (clientX >= x && clientX < x + cx) {
                iSubItem = c;
                break;
            }
            x += cx;
        }
    }

    const iconW = (view === LVS_SMALLICON || view === LVS_LIST || view === LVS_REPORT)
        ? LV_SMALL_ICON_SIZE + 2 : 0;
    const onIcon = iconW > 0 && clientX < inset + iconW;
    const flags = onIcon
        ? (LVHT_ONITEM | LVHT_ONITEMICON)
        : (LVHT_ONITEM | LVHT_ONITEMLABEL);
    return { flags, iItem: idx, iSubItem };
}

export function handleListViewKey(
    child: WindowInfo,
    vKey: number,
    mods: number,
): boolean {
    const state = getOrCreateListViewState(child.handle);
    if (state.items.length === 0) {
        postListViewKeyDown(child, vKey);
        return true;
    }

    postListViewKeyDown(child, vKey);

    let cur = state.focusedItem;
    if (cur < 0) cur = state.selectionMark;
    if (cur < 0) cur = 0;

    const page = listViewVisibleCount(child);
    let next = cur;
    switch (vKey) {
        case VK_UP: next = Math.max(0, cur - 1); break;
        case VK_DOWN: next = Math.min(state.items.length - 1, cur + 1); break;
        case VK_PRIOR: next = Math.max(0, cur - page); break;
        case VK_NEXT: next = Math.min(state.items.length - 1, cur + page); break;
        case VK_HOME: next = 0; break;
        case VK_END: next = state.items.length - 1; break;
        case VK_SPACE:
            selectListViewAtIndex(child, cur, mods);
            return true;
        case VK_RETURN:
            if (cur >= 0) {
                postListViewClickNotify(child, true, cur, 0, 0, 0, 0);
            }
            return true;
        default:
            return false;
    }

    if (next !== cur || !(state.items[next]?.state & LVIS_SELECTED)) {
        selectListViewAtIndex(child, next, mods & MK_SHIFT ? MK_SHIFT : 0);
    }
    return true;
}

// ---- Core item / column ops ----

function insertItem(child: WindowInfo, mem: Uint8Array, lParam: number, wide: boolean): number {
    const lv = readLvItem(mem, lParam);
    if (!lv || lv.iSubItem !== 0) return -1;
    const state = getOrCreateListViewState(child.handle);

    let nItem = lv.iItem;
    if (nItem < 0) nItem = state.items.length;
    if (nItem > state.items.length) nItem = state.items.length;

    const item: ListViewItem = {
        text: '',
        state: 0,
        iImage: -1,
        lParam: 0,
        iIndent: 0,
        subItems: [],
    };

    if (lv.mask & LVIF_TEXT) item.text = readGuestText(mem, lv.pszText, wide);
    if (lv.mask & LVIF_IMAGE) item.iImage = lv.iImage;
    if (lv.mask & LVIF_PARAM) item.lParam = lv.lParam >>> 0;
    if (lv.mask & LVIF_INDENT) item.iIndent = lv.iIndent;
    if (lv.mask & LVIF_STATE) {
        item.state = lv.state & lv.stateMask;
    }

    state.items.splice(nItem, 0, item);

    if (state.focusedItem >= nItem) state.focusedItem++;
    if (state.selectionMark >= nItem) state.selectionMark++;
    if (state.hotItem >= nItem) state.hotItem++;

    if (item.state & LVIS_FOCUSED) {
        clearFocus(state, child, nItem);
        state.focusedItem = nItem;
    }
    if ((item.state & LVIS_SELECTED) && (child.style & LVS_SINGLESEL)) {
        clearSelection(state, child, nItem);
    }
    if (item.state & LVIS_SELECTED) state.selectionMark = nItem;

    postNmListView(child, LVN_INSERTITEM, nItem, 0, item.state, 0, 0, item.lParam);
    if (item.state) {
        notifyItemStateChange(child, nItem, 0, item.state, LVIF_STATE);
    }

    Logger.log(LogCategory.USER32,
        `ListView INSERTITEM hwnd=0x${child.handle.toString(16)} idx=${nItem} text="${item.text}"`);
    return nItem;
}

function getItem(child: WindowInfo, mem: Uint8Array, lParam: number, wide: boolean): number {
    const lv = readLvItem(mem, lParam);
    if (!lv) return 0;
    const state = getOrCreateListViewState(child.handle);
    if (lv.iItem < 0 || lv.iItem >= state.items.length) return 0;
    const item = state.items[lv.iItem];

    if (lv.mask & LVIF_TEXT) {
        writeGuestText(mem, lv.pszText, lv.cchTextMax, itemText(item, lv.iSubItem), wide);
    }
    writeLvItemOut(mem, lParam, {
        state: item.state,
        iImage: lv.iSubItem <= 0 ? item.iImage : (item.subItems[lv.iSubItem - 1]?.iImage ?? -1),
        lParam: item.lParam,
        iIndent: item.iIndent,
    }, lv.mask);
    return 1;
}

function setItem(child: WindowInfo, mem: Uint8Array, lParam: number, wide: boolean): number {
    const lv = readLvItem(mem, lParam);
    if (!lv) return 0;
    const state = getOrCreateListViewState(child.handle);
    if (lv.iItem < 0 || lv.iItem >= state.items.length) return 0;
    const item = state.items[lv.iItem];

    if (lv.mask & LVIF_TEXT) setItemText(item, lv.iSubItem, readGuestText(mem, lv.pszText, wide));
    if (lv.mask & LVIF_IMAGE) setItemImage(item, lv.iSubItem, lv.iImage);
    if (lv.mask & LVIF_PARAM && lv.iSubItem === 0) item.lParam = lv.lParam >>> 0;
    if (lv.mask & LVIF_INDENT && lv.iSubItem === 0) item.iIndent = lv.iIndent;
    if (lv.mask & LVIF_STATE && lv.iSubItem === 0) {
        applyItemState(child, state, lv.iItem, lv.state, lv.stateMask);
    }
    return 1;
}

function setItemTextMsg(child: WindowInfo, mem: Uint8Array, wParam: number, lParam: number, wide: boolean): number {
    const lv = readLvItem(mem, lParam);
    if (!lv) return 0;
    const iItem = wParam | 0;
    const state = getOrCreateListViewState(child.handle);
    if (iItem < 0 || iItem >= state.items.length) return 0;
    setItemText(state.items[iItem], lv.iSubItem, readGuestText(mem, lv.pszText, wide));
    return 1;
}

function getItemTextMsg(child: WindowInfo, mem: Uint8Array, wParam: number, lParam: number, wide: boolean): number {
    const lv = readLvItem(mem, lParam);
    if (!lv) return 0;
    const iItem = wParam | 0;
    const state = getOrCreateListViewState(child.handle);
    if (iItem < 0 || iItem >= state.items.length) return 0;
    const text = itemText(state.items[iItem], lv.iSubItem);
    writeGuestText(mem, lv.pszText, lv.cchTextMax, text, wide);
    return text.length;
}

function insertColumn(child: WindowInfo, mem: Uint8Array, wParam: number, lParam: number, wide: boolean): number {
    const col = readLvColumn(mem, lParam);
    if (!col) return -1;
    const state = getOrCreateListViewState(child.handle);
    let index = wParam | 0;
    if (index < 0 || index > state.columns.length) index = state.columns.length;

    const entry: ListViewColumn = {
        fmt: 0,
        cx: 0,
        text: '',
        iSubItem: index,
        iImage: -1,
        iOrder: index,
    };
    if (col.mask & LVCF_FMT) entry.fmt = col.fmt;
    if (col.mask & LVCF_WIDTH) entry.cx = col.cx;
    if (col.mask & LVCF_TEXT) entry.text = readGuestText(mem, col.pszText, wide);
    if (col.mask & LVCF_SUBITEM) entry.iSubItem = col.iSubItem;
    if (col.mask & LVCF_IMAGE) entry.iImage = col.iImage;
    if (col.mask & LVCF_ORDER) entry.iOrder = col.iOrder;

    state.columns.splice(index, 0, entry);
    return index;
}

function getColumn(child: WindowInfo, mem: Uint8Array, wParam: number, lParam: number, wide: boolean): number {
    const col = readLvColumn(mem, lParam);
    if (!col) return 0;
    const state = getOrCreateListViewState(child.handle);
    const index = wParam | 0;
    if (index < 0 || index >= state.columns.length) return 0;
    const entry = state.columns[index];
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (col.mask & LVCF_FMT) v.setInt32(lParam + 4, entry.fmt, true);
    if (col.mask & LVCF_WIDTH) v.setInt32(lParam + 8, entry.cx, true);
    if (col.mask & LVCF_TEXT) writeGuestText(mem, col.pszText, col.cchTextMax, entry.text, wide);
    if (col.mask & LVCF_SUBITEM) v.setInt32(lParam + 20, entry.iSubItem, true);
    if ((col.mask & LVCF_IMAGE) && lParam + 28 <= mem.length) v.setInt32(lParam + 24, entry.iImage, true);
    if ((col.mask & LVCF_ORDER) && lParam + 32 <= mem.length) v.setInt32(lParam + 28, entry.iOrder, true);
    return 1;
}

function setColumn(child: WindowInfo, mem: Uint8Array, wParam: number, lParam: number, wide: boolean): number {
    const col = readLvColumn(mem, lParam);
    if (!col) return 0;
    const state = getOrCreateListViewState(child.handle);
    const index = wParam | 0;
    if (index < 0 || index >= state.columns.length) return 0;
    const entry = state.columns[index];
    if (col.mask & LVCF_FMT) entry.fmt = col.fmt;
    if (col.mask & LVCF_WIDTH) entry.cx = col.cx;
    if (col.mask & LVCF_TEXT) entry.text = readGuestText(mem, col.pszText, wide);
    if (col.mask & LVCF_SUBITEM) entry.iSubItem = col.iSubItem;
    if (col.mask & LVCF_IMAGE) entry.iImage = col.iImage;
    if (col.mask & LVCF_ORDER) entry.iOrder = col.iOrder;
    return 1;
}

function getNextItem(state: ListViewState, start: number, flags: number): number {
    const dir = flags & LVNI_DIRECTIONMASK;
    const stateFlags = flags & LVNI_STATEMASK;
    let i = start;

    const matches = (idx: number): boolean => {
        if (idx < 0 || idx >= state.items.length) return false;
        if (!stateFlags) return true;
        const st = state.items[idx].state;
        if ((stateFlags & LVNI_FOCUSED) && !(st & LVIS_FOCUSED)) return false;
        if ((stateFlags & LVNI_SELECTED) && !(st & LVIS_SELECTED)) return false;
        if ((stateFlags & LVNI_CUT) && !(st & LVIS_CUT)) return false;
        if ((stateFlags & LVNI_DROPHILITED) && !(st & LVIS_DROPHILITED)) return false;
        return true;
    };

    if (dir === LVNI_ABOVE || dir === LVNI_TOLEFT) {
        for (i = start - 1; i >= 0; i--) if (matches(i)) return i;
        return -1;
    }
    if (dir === LVNI_BELOW || dir === LVNI_TORIGHT) {
        for (i = start + 1; i < state.items.length; i++) if (matches(i)) return i;
        return -1;
    }

    // Forward search (default), starting after `start` (-1 = from beginning).
    const begin = start < 0 ? 0 : start + 1;
    for (i = begin; i < state.items.length; i++) if (matches(i)) return i;
    return -1;
}

function fillItemRect(
    child: WindowInfo,
    state: ListViewState,
    iItem: number,
    code: number,
    out: { left: number; top: number; right: number; bottom: number },
): boolean {
    if (iItem < 0 || iItem >= state.items.length) return false;
    const headerH = listViewHasHeader(child) ? LV_HEADER_H : 0;
    const rowH = listViewRowHeight(child);
    const inset = 2;
    const rel = iItem - state.topIndex;
    const top = headerH + inset + rel * rowH;
    const bottom = top + rowH;
    let left = inset;
    let right = child.width - inset;
    if (listViewViewStyle(child.style) === LVS_REPORT && state.columns.length > 0) {
        right = inset - state.scrollX;
        for (const c of state.columns) right += Math.max(0, c.cx);
        left = inset - state.scrollX;
    }
    const iconW = LV_SMALL_ICON_SIZE + 2;
    if (code === LVIR_ICON) {
        right = left + iconW;
    } else if (code === LVIR_LABEL || code === LVIR_SELECTBOUNDS) {
        left += iconW;
    }
    out.left = left;
    out.top = top;
    out.right = right;
    out.bottom = bottom;
    return true;
}

/**
 * Handle LVM_* for a SysListView32. Returns null if the message is not ours
 * (so the shared WM_* path can still run for WM_SETFONT etc.).
 */
export function handleListViewMessage(
    child: WindowInfo,
    msg: number,
    wParam: number,
    lParam: number,
    mem: Uint8Array,
): number | null {
    if (!isListViewControl(child)) return null;

    // Outside the LVM range: only claim keyboard / dlgcode we own.
    const isLvm = msg >= LVM_FIRST && msg < LVM_FIRST + 0x200;
    if (!isLvm && msg !== WM_KEYDOWN && msg !== WM_GETDLGCODE) return null;

    const state = getOrCreateListViewState(child.handle);

    if (msg === WM_GETDLGCODE) return DLGC_WANTARROWS | DLGC_WANTCHARS;
    if (msg === WM_KEYDOWN) {
        const mods = 0; // GetKeyState not wired here; interaction path passes MK_* 
        return handleListViewKey(child, wParam & 0xFFFF, mods) ? 0 : 0;
    }

    switch (msg) {
        case LVM_GETBKCOLOR:
            return state.bkColor >>> 0;
        case LVM_SETBKCOLOR:
            state.bkColor = lParam >>> 0;
            return 1;
        case LVM_GETTEXTCOLOR:
            return state.textColor >>> 0;
        case LVM_SETTEXTCOLOR:
            state.textColor = lParam >>> 0;
            return 1;
        case LVM_GETTEXTBKCOLOR:
            return state.textBkColor >>> 0;
        case LVM_SETTEXTBKCOLOR:
            state.textBkColor = lParam >>> 0;
            return 1;

        case LVM_GETIMAGELIST:
            if (wParam === LVSIL_NORMAL) return state.himlNormal;
            if (wParam === LVSIL_SMALL) return state.himlSmall;
            if (wParam === LVSIL_STATE) return state.himlState;
            return 0;
        case LVM_SETIMAGELIST: {
            const prev =
                wParam === LVSIL_NORMAL ? state.himlNormal
                    : wParam === LVSIL_SMALL ? state.himlSmall
                        : wParam === LVSIL_STATE ? state.himlState : 0;
            if (wParam === LVSIL_NORMAL) state.himlNormal = lParam >>> 0;
            else if (wParam === LVSIL_SMALL) state.himlSmall = lParam >>> 0;
            else if (wParam === LVSIL_STATE) state.himlState = lParam >>> 0;
            return prev;
        }

        case LVM_GETITEMCOUNT:
            return state.items.length;
        case LVM_SETITEMCOUNT: {
            const count = Math.max(0, wParam | 0);
            if (count < state.items.length) {
                state.items.length = count;
            } else {
                while (state.items.length < count) {
                    state.items.push({
                        text: '', state: 0, iImage: -1, lParam: 0, iIndent: 0, subItems: [],
                    });
                }
            }
            return 1;
        }

        case LVM_INSERTITEMA:
            return insertItem(child, mem, lParam, false);
        case LVM_INSERTITEMW:
            return insertItem(child, mem, lParam, true);
        case LVM_GETITEMA:
            return getItem(child, mem, lParam, false);
        case LVM_GETITEMW:
            return getItem(child, mem, lParam, true);
        case LVM_SETITEMA:
            return setItem(child, mem, lParam, false);
        case LVM_SETITEMW:
            return setItem(child, mem, lParam, true);

        case LVM_GETITEMTEXTA:
            return getItemTextMsg(child, mem, wParam, lParam, false);
        case LVM_GETITEMTEXTW:
            return getItemTextMsg(child, mem, wParam, lParam, true);
        case LVM_SETITEMTEXTA:
            return setItemTextMsg(child, mem, wParam, lParam, false);
        case LVM_SETITEMTEXTW:
            return setItemTextMsg(child, mem, wParam, lParam, true);

        case LVM_DELETEITEM: {
            const i = wParam | 0;
            if (i < 0 || i >= state.items.length) return 0;
            const removed = state.items[i];
            postNmListView(child, LVN_DELETEITEM, i, 0, 0, removed.state, 0, removed.lParam);
            state.items.splice(i, 1);
            if (state.focusedItem === i) state.focusedItem = -1;
            else if (state.focusedItem > i) state.focusedItem--;
            if (state.selectionMark === i) state.selectionMark = -1;
            else if (state.selectionMark > i) state.selectionMark--;
            if (state.hotItem === i) state.hotItem = -1;
            else if (state.hotItem > i) state.hotItem--;
            clampListViewTopIndex(child, state);
            return 1;
        }
        case LVM_DELETEALLITEMS: {
            postNmListView(child, LVN_DELETEALLITEMS, -1, 0, 0, 0, 0, 0);
            state.items.length = 0;
            state.focusedItem = -1;
            state.selectionMark = -1;
            state.hotItem = -1;
            state.topIndex = 0;
            return 1;
        }

        case LVM_GETITEMSTATE: {
            const i = wParam | 0;
            if (i < 0 || i >= state.items.length) return 0;
            return state.items[i].state & (lParam >>> 0);
        }
        case LVM_SETITEMSTATE: {
            const lv = readLvItem(mem, lParam);
            if (!lv) return 0;
            const i = wParam | 0;
            if (i === -1) return setItemStateAll(child, state, lv.state, lv.stateMask) ? 1 : 0;
            return applyItemState(child, state, i, lv.state, lv.stateMask) ? 1 : 0;
        }

        case LVM_GETSELECTEDCOUNT:
            return listViewSelectedCount(state);

        case LVM_GETNEXTITEM:
            return getNextItem(state, wParam | 0, lParam & 0xFFFF);

        case LVM_GETSELECTIONMARK:
            return state.selectionMark;
        case LVM_SETSELECTIONMARK: {
            const prev = state.selectionMark;
            state.selectionMark = lParam | 0;
            return prev;
        }

        case LVM_GETHOTITEM:
            return state.hotItem;
        case LVM_SETHOTITEM: {
            const prev = state.hotItem;
            state.hotItem = wParam | 0;
            return prev;
        }

        case LVM_GETEXTENDEDLISTVIEWSTYLE:
            return state.exStyle >>> 0;
        case LVM_SETEXTENDEDLISTVIEWSTYLE: {
            const prev = state.exStyle >>> 0;
            const mask = wParam >>> 0;
            const bits = lParam >>> 0;
            if (mask === 0) state.exStyle = bits;
            else state.exStyle = (state.exStyle & ~mask) | (bits & mask);
            return prev;
        }

        case LVM_INSERTCOLUMNA:
            return insertColumn(child, mem, wParam, lParam, false);
        case LVM_INSERTCOLUMNW:
            return insertColumn(child, mem, wParam, lParam, true);
        case LVM_GETCOLUMNA:
            return getColumn(child, mem, wParam, lParam, false);
        case LVM_GETCOLUMNW:
            return getColumn(child, mem, wParam, lParam, true);
        case LVM_SETCOLUMNA:
            return setColumn(child, mem, wParam, lParam, false);
        case LVM_SETCOLUMNW:
            return setColumn(child, mem, wParam, lParam, true);
        case LVM_DELETECOLUMN: {
            const i = wParam | 0;
            if (i < 0 || i >= state.columns.length) return 0;
            state.columns.splice(i, 1);
            return 1;
        }
        case LVM_GETCOLUMNWIDTH: {
            const i = wParam | 0;
            if (i < 0 || i >= state.columns.length) return 0;
            return state.columns[i].cx;
        }
        case LVM_SETCOLUMNWIDTH: {
            const i = wParam | 0;
            if (i < 0 || i >= state.columns.length) return 0;
            // LOWORD of lParam is the width; special values CX_AUTOSIZE ignored → keep.
            const cx = lParam << 16 >> 16;
            if (cx >= 0) state.columns[i].cx = cx;
            return 1;
        }

        case LVM_GETTOPINDEX:
            return state.topIndex;
        case LVM_GETCOUNTPERPAGE:
            return listViewVisibleCount(child);

        case LVM_ENSUREVISIBLE:
            return ensureListViewVisible(child, wParam | 0, (lParam | 0) !== 0) ? 1 : 0;

        case LVM_SCROLL: {
            if ((child.style & LVS_NOSCROLL) !== 0) return 0;
            const dx = wParam | 0;
            const dy = lParam | 0;
            state.scrollX = Math.max(0, state.scrollX + dx);
            if (dy) {
                const rowH = listViewRowHeight(child);
                state.topIndex += Math.trunc(dy / Math.max(1, rowH));
                clampListViewTopIndex(child, state);
            }
            return 1;
        }

        case LVM_REDRAWITEMS:
        case LVM_UPDATE:
            return 1;

        case LVM_HITTEST: {
            if (!lParam || lParam + 20 > mem.length) return -1;
            const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const x = v.getInt32(lParam, true);
            const y = v.getInt32(lParam + 4, true);
            const hit = hitTestListView(child, x, y);
            v.setUint32(lParam + 8, hit.flags >>> 0, true);
            v.setInt32(lParam + 12, hit.iItem, true);
            v.setInt32(lParam + 16, hit.iSubItem, true);
            return hit.iItem;
        }

        case LVM_GETITEMRECT: {
            if (!lParam || lParam + 16 > mem.length) return 0;
            const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const code = v.getInt32(lParam, true);
            const iItem = wParam | 0;
            const rect = { left: 0, top: 0, right: 0, bottom: 0 };
            if (!fillItemRect(child, state, iItem, code, rect)) return 0;
            v.setInt32(lParam, rect.left, true);
            v.setInt32(lParam + 4, rect.top, true);
            v.setInt32(lParam + 8, rect.right, true);
            v.setInt32(lParam + 12, rect.bottom, true);
            return 1;
        }

        default:
            // Unknown LVM_*: claim it (comctl returns 0) so generic control path
            // does not treat it as WM_USER fallthrough for another class.
            if (isLvm) return 0;
            return null;
    }
}

// Re-export constants tests / interaction need.
export {
    LVIS_SELECTED,
    LVIS_FOCUSED,
    LVS_SINGLESEL,
    LVS_REPORT,
    LVS_ICON,
    LVS_LIST,
    LVS_SMALLICON,
    LVS_TYPEMASK,
    LVS_SHOWSELALWAYS,
    LVS_NOCOLUMNHEADER,
    LVNI_SELECTED,
    LVNI_FOCUSED,
    LVIF_TEXT,
    LVIF_IMAGE,
    LVIF_PARAM,
    LVIF_STATE,
    LVCF_TEXT,
    LVCF_WIDTH,
    LVCF_FMT,
    LVCF_SUBITEM,
    LVM_INSERTITEMA,
    LVM_INSERTITEMW,
    LVM_GETITEMA,
    LVM_GETITEMW,
    LVM_SETITEMA,
    LVM_GETITEMCOUNT,
    LVM_GETSELECTEDCOUNT,
    LVM_SETITEMSTATE,
    LVM_GETITEMSTATE,
    LVM_GETNEXTITEM,
    LVM_DELETEALLITEMS,
    LVM_DELETEITEM,
    LVM_INSERTCOLUMNA,
    LVM_SETIMAGELIST,
    LVM_SETEXTENDEDLISTVIEWSTYLE,
    LVM_GETEXTENDEDLISTVIEWSTYLE,
    LVM_SETSELECTIONMARK,
    LVM_GETSELECTIONMARK,
    LVM_HITTEST,
    NM_CLICK,
    NM_DBLCLK,
    LVN_ITEMCHANGED,
    LVN_ITEMCHANGING,
    LVN_KEYDOWN,
    LVN_COLUMNCLICK,
    WM_NOTIFY,
    MK_CONTROL,
    MK_SHIFT,
    LVIR_BOUNDS,
};
