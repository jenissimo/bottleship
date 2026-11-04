/**
 * Per-window invalid (update) regions for faithful InvalidateRect / BeginPaint.
 * Win32 uses complex regions; we track up to MAX_REGION_RECTS axis-aligned rects
 * and merge to a bounding box when the list grows too large.
 */
import { windows, type WindowInfo } from './shared-state';

export interface ClientRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface WindowUpdateState {
    rects: ClientRect[];
    needsErase: boolean;
}

const MAX_REGION_RECTS = 8;
// @participant(user32)
const updates = new Map<number, WindowUpdateState>();

function normalizeClientRect(win: WindowInfo, rect: ClientRect): ClientRect | null {
    const left = Math.max(0, Math.min(rect.left, win.width));
    const top = Math.max(0, Math.min(rect.top, win.height));
    const right = Math.max(left, Math.min(rect.right, win.width));
    const bottom = Math.max(top, Math.min(rect.bottom, win.height));
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
}

function fullClientRect(win: WindowInfo): ClientRect {
    return { left: 0, top: 0, right: win.width, bottom: win.height };
}

function rectsOverlap(a: ClientRect, b: ClientRect): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function rectContains(outer: ClientRect, inner: ClientRect): boolean {
    return outer.left <= inner.left && outer.top <= inner.top
        && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

function boundingBox(rects: ClientRect[]): ClientRect {
    let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    for (const r of rects) {
        minL = Math.min(minL, r.left);
        minT = Math.min(minT, r.top);
        maxR = Math.max(maxR, r.right);
        maxB = Math.max(maxB, r.bottom);
    }
    return { left: minL, top: minT, right: maxR, bottom: maxB };
}

function mergeUpdateRects(rects: ClientRect[]): ClientRect[] {
    if (rects.length <= MAX_REGION_RECTS) return rects;
    return [boundingBox(rects)];
}

function unionIntoState(state: WindowUpdateState, rect: ClientRect): void {
    state.rects.push(rect);
    if (state.rects.length > 1) {
        state.rects = [boundingBox(state.rects)];
    }
}

function subtractRect(src: ClientRect, sub: ClientRect): ClientRect[] {
    if (!rectsOverlap(src, sub)) return [src];
    if (rectContains(sub, src)) return [];

    const out: ClientRect[] = [];
    if (sub.top > src.top) {
        out.push({ left: src.left, top: src.top, right: src.right, bottom: sub.top });
    }
    if (sub.bottom < src.bottom) {
        out.push({ left: src.left, top: sub.bottom, right: src.right, bottom: src.bottom });
    }
    const midTop = Math.max(src.top, sub.top);
    const midBottom = Math.min(src.bottom, sub.bottom);
    if (midBottom > midTop) {
        if (sub.left > src.left) {
            out.push({ left: src.left, top: midTop, right: sub.left, bottom: midBottom });
        }
        if (sub.right < src.right) {
            out.push({ left: sub.right, top: midTop, right: src.right, bottom: midBottom });
        }
    }
    return out.filter(r => r.right > r.left && r.bottom > r.top);
}

export function invalidateWindow(hwnd: number, lpRect: ClientRect | null, bErase: boolean): void {
    const win = windows.get(hwnd);
    if (!win) return;

    let state = updates.get(hwnd);
    if (!state) {
        state = { rects: [], needsErase: false };
        updates.set(hwnd, state);
    }

    const rect = lpRect ? normalizeClientRect(win, lpRect) : fullClientRect(win);
    if (!rect) return;
    unionIntoState(state, rect);
    if (bErase) state.needsErase = true;
}

export function validateWindow(hwnd: number, lpRect: ClientRect | null): void {
    const state = updates.get(hwnd);
    if (!state || state.rects.length === 0) return;

    const win = windows.get(hwnd);
    if (!win) return;

    if (!lpRect) {
        updates.delete(hwnd);
        return;
    }

    const valid = normalizeClientRect(win, lpRect);
    if (!valid) return;

    const remaining: ClientRect[] = [];
    for (const ir of state.rects) {
        if (rectContains(valid, ir)) continue;
        if (!rectsOverlap(valid, ir)) {
            remaining.push(ir);
            continue;
        }
        remaining.push(...subtractRect(ir, valid));
    }

    state.rects = mergeUpdateRects(remaining);
    if (state.rects.length === 0) updates.delete(hwnd);
}

export function hasPendingUpdate(hwnd: number): boolean {
    const state = updates.get(hwnd);
    return !!state && state.rects.length > 0;
}

export function getWindowUpdateBounds(hwnd: number): ClientRect | null {
    const state = updates.get(hwnd);
    if (!state || state.rects.length === 0) return null;
    return boundingBox(state.rects);
}

export function getWindowUpdateRects(hwnd: number): ClientRect[] {
    const state = updates.get(hwnd);
    return state ? [...state.rects] : [];
}

/** The update region as flat left,top,right,bottom quads — the input a GDI region is built from. */
export function getWindowUpdateQuads(hwnd: number): number[] {
    const quads: number[] = [];
    for (const r of updates.get(hwnd)?.rects ?? []) quads.push(r.left, r.top, r.right, r.bottom);
    return quads;
}

/** Win32 BeginPaint: fErase reflects whether background should be erased. */
export function consumeNeedsErase(hwnd: number): boolean {
    const state = updates.get(hwnd);
    if (!state) return false;
    const v = state.needsErase;
    state.needsErase = false;
    return v;
}

/** BeginPaint validates (clears) the update region. */
export function clearWindowUpdate(hwnd: number): void {
    updates.delete(hwnd);
}

export function removeWindowUpdate(hwnd: number): void {
    updates.delete(hwnd);
}

export function readClientRectFromMem(mem: Uint8Array, lpRect: number): ClientRect | null {
    if (!lpRect || lpRect + 16 > mem.length) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        left: view.getInt32(lpRect, true),
        top: view.getInt32(lpRect + 4, true),
        right: view.getInt32(lpRect + 8, true),
        bottom: view.getInt32(lpRect + 12, true),
    };
}

export function writeClientRectToMem(mem: Uint8Array, lpRect: number, rect: ClientRect): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setInt32(lpRect, rect.left, true);
    view.setInt32(lpRect + 4, rect.top, true);
    view.setInt32(lpRect + 8, rect.right, true);
    view.setInt32(lpRect + 12, rect.bottom, true);
}

export type SavedUpdateRegion = [hwnd: number, rects: ClientRect[], needsErase: boolean];

export function capturePaintRegions(): SavedUpdateRegion[] {
    return [...updates].map(([h, u]) => [h, u.rects.map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })), u.needsErase]);
}

export function restorePaintRegions(rows: readonly SavedUpdateRegion[]): void {
    updates.clear();
    for (const [h, rects, needsErase] of rows) updates.set(h, { rects: rects.map(r => ({ ...r })), needsErase });
}
