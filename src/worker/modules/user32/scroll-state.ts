/** Per-window scroll bar state shared by user32 and comctl32 FlatSB. */

import { isValidAddress } from '../../core/memory/address-guard';

export type ScrollBarState = {
    min: number;
    max: number;
    page: number;
    pos: number;
    enabled: boolean;
    visible: boolean;
    /** EnableScrollBar: the two arrows disable independently (ESB_DISABLE_LTUP/RTDN). */
    upEnabled: boolean;
    downEnabled: boolean;
};

const scrollBarState = new Map<string, ScrollBarState>();

export const SIF_RANGE = 0x1;
export const SIF_PAGE = 0x2;
export const SIF_POS = 0x4;
export const SIF_DISABLENOSCROLL = 0x8;
export const SIF_TRACKPOS = 0x10;

// nBar selectors
export const SB_HORZ = 0;
export const SB_VERT = 1;
export const SB_CTL = 2;
export const SB_BOTH = 3;

// EnableScrollBar flags
export const ESB_ENABLE_BOTH = 0x0;
export const ESB_DISABLE_LTUP = 0x1;
export const ESB_DISABLE_RTDN = 0x2;
export const ESB_DISABLE_BOTH = 0x3;

function scrollBarKey(hwnd: number, bar: number): string {
    return `${hwnd >>> 0}:${bar | 0}`;
}

export function getScrollBarState(hwnd: number, bar: number): ScrollBarState {
    // A bar nobody configured has an empty range — Win32 draws that greyed, with no
    // thumb. Inventing a 0..100 range here would paint a live-looking bar over a
    // control the guest never gave a range to.
    return scrollBarState.get(scrollBarKey(hwnd, bar)) ?? {
        min: 0,
        max: 0,
        page: 0,
        pos: 0,
        enabled: true,
        visible: true,
        upEnabled: true,
        downEnabled: true,
    };
}

/** EnableScrollBar(hwnd, bar, flags). Returns TRUE when the state changed. */
export function enableScrollBar(hwnd: number, bar: number, flags: number): boolean {
    const bars = bar === SB_BOTH ? [SB_HORZ, SB_VERT] : [bar];
    let changed = false;
    for (const b of bars) {
        const state = getScrollBarState(hwnd, b);
        const up = (flags & ESB_DISABLE_LTUP) === 0;
        const down = (flags & ESB_DISABLE_RTDN) === 0;
        if (state.upEnabled !== up || state.downEnabled !== down) changed = true;
        state.upEnabled = up;
        state.downEnabled = down;
        setScrollBarState(hwnd, b, state);
    }
    return changed;
}

/** ShowScrollBar(hwnd, bar, show). */
export function showScrollBar(hwnd: number, bar: number, show: boolean): void {
    const bars = bar === SB_BOTH ? [SB_HORZ, SB_VERT] : [bar];
    for (const b of bars) {
        const state = getScrollBarState(hwnd, b);
        state.visible = show;
        setScrollBarState(hwnd, b, state);
    }
}

export function setScrollBarState(hwnd: number, bar: number, state: ScrollBarState): void {
    scrollBarState.set(scrollBarKey(hwnd, bar), state);
}

export function getScrollPos(hwnd: number, bar: number): number {
    return getScrollBarState(hwnd, bar).pos;
}

export function setScrollPos(hwnd: number, bar: number, pos: number): number {
    const state = getScrollBarState(hwnd, bar);
    const prev = state.pos;
    state.pos = pos | 0;
    setScrollBarState(hwnd, bar, state);
    return prev;
}

export function setScrollRange(hwnd: number, bar: number, min: number, max: number): void {
    const state = getScrollBarState(hwnd, bar);
    state.min = min | 0;
    state.max = max | 0;
    setScrollBarState(hwnd, bar, state);
}

export function getScrollRange(mem: Uint8Array, hwnd: number, bar: number, lpMin: number, lpMax: number): boolean {
    // The whole extent, region-checked: a bounds test alone would let a LPINT into
    // THUNK_CODE or a read-only region through.
    if (!lpMin || !lpMax) return false;
    if (!isValidAddress(mem, lpMin, 4, 'rw') || !isValidAddress(mem, lpMax, 4, 'rw')) return false;
    const state = getScrollBarState(hwnd, bar);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setInt32(lpMin, state.min, true);
    view.setInt32(lpMax, state.max, true);
    return true;
}

export function readScrollInfo(mem: Uint8Array, hwnd: number, bar: number, lpsi: number): boolean {
    // The extent the caller declared is validated up front, not bounds-tested: only the
    // region map can tell a guest struct from THUNK_CODE or read-only memory.
    if (!lpsi || !isValidAddress(mem, lpsi, 24, 'rw')) return false;
    const state = getScrollBarState(hwnd, bar);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const cbSize = view.getUint32(lpsi, true);
    if (cbSize < 20) return false;
    const fMask = view.getUint32(lpsi + 4, true);
    if (fMask & SIF_RANGE) {
        view.setInt32(lpsi + 8, state.min, true);
        view.setInt32(lpsi + 12, state.max, true);
    }
    if (fMask & SIF_PAGE) {
        view.setUint32(lpsi + 16, state.page >>> 0, true);
    }
    if (fMask & SIF_POS) {
        view.setInt32(lpsi + 20, state.pos, true);
    }
    if (cbSize >= 28 && fMask & 0x10 && isValidAddress(mem, lpsi + 24, 4, 'rw')) {
        view.setInt32(lpsi + 24, state.pos, true);
    }
    return true;
}

export function applyScrollInfo(mem: Uint8Array, hwnd: number, bar: number, lpsi: number): number {
    if (!lpsi || lpsi + 24 > mem.length) return 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const cbSize = view.getUint32(lpsi, true);
    if (cbSize < 20) return 0;
    const fMask = view.getUint32(lpsi + 4, true);
    const state = getScrollBarState(hwnd, bar);
    const prevPos = state.pos;
    if (fMask & SIF_RANGE) {
        state.min = view.getInt32(lpsi + 8, true);
        state.max = view.getInt32(lpsi + 12, true);
    }
    if (fMask & SIF_PAGE) {
        state.page = view.getUint32(lpsi + 16, true);
    }
    if (fMask & SIF_POS) {
        state.pos = view.getInt32(lpsi + 20, true);
    }
    setScrollBarState(hwnd, bar, state);
    return prevPos;
}

export function resetScrollState(): void {
    scrollBarState.clear();
}
