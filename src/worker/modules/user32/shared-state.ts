import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { resetHooks } from "./hooks";
import { resetOwnerDrawScratch } from "./owner-draw";
import { resetSystemCursorHandles } from "./system-cursors";
import { resetUser32Classes } from "./class";

// Window storage
export interface WindowInfo {
    handle: number;
    classId?: number;
    title: string;
    style: number;
    exStyle?: number;
    x: number;
    y: number;
    width: number;
    height: number;
    parent?: number;
    children: number[];
    visible: boolean;
    wndProc: number;
    userData?: number;
    cbWndExtra?: number;
    extraBytes?: Uint32Array;
    hMenu?: number;
    controlId?: number;           // DLGITEMTEMPLATE.id (for dialog child controls)
    isSystemControl?: boolean;    // true for JS-handled Button/Static/Edit
    systemControlClass?: string;  // 'Button' | 'Static' | 'Edit' | etc.
    lastActivePopupHwnd?: number; // last activated owned popup (for GetLastActivePopup)
    /** Win32 class name (e.g. SysAnimate32) for common-control routing. */
    nativeClassName?: string;
    /** Client-area message drawn when the template has no Static control (e.g. HL MCI error). */
    clientMessage?: string;
    /** HFONT currently assigned by WM_SETFONT / dialog-template DS_SETFONT. */
    fontHandle?: number;
    /** Dialog default push button id (DM_GETDEFID / BM_SETSTYLE bookkeeping). */
    dialogDefaultId?: number;
    /** Per-dialog MapDialogRect base units (from template font / system font). */
    dialogBaseUnitX?: number;
    dialogBaseUnitY?: number;
    /** Guest WM_PAINT / GetDC drew client pixels; preserve that client area on repaint. */
    guestCustomPaint?: boolean;
    /** A system control whose wndProc the guest replaced via SetWindowLong(GWL_WNDPROC)
     *  — i.e. it paints itself (MFC subclassing). We deliver WM_PAINT to it instead of
     *  drawing default chrome, exactly like Windows runs the control's own window proc. */
    wndProcSubclassed?: boolean;
    /** WM_SHOWWINDOW/WM_SIZE were delivered synchronously inside CreateWindowEx
     *  (Win32 order); the post-create path must not queue duplicates. */
    createSyncVisibleDelivered?: boolean;
    /** False until WM_ACTIVATE is delivered (CreateDialog top-level); gates RDW_UPDATENOW paint. */
    activationDelivered?: boolean;
    /** True while WM_INITDIALOG callback is in flight (nested pump). */
    dialogInitInProgress?: boolean;
    /** True while CreateWindowEx WM_NCCREATE/WM_CREATE callbacks are in flight. */
    createInProgress?: boolean;
    /** DestroyWindow posted WM_DESTROY/WM_NCDESTROY; the window stays in the maps until
     *  WM_NCDESTROY is dispatched to its wndProc (so MFC's OnNcDestroy detaches the CWnd
     *  from afxMapHWND), then it is finalized/removed. See window.ts DestroyWindow. */
    pendingDestroy?: boolean;
    /** Native dialog shown while the DDraw flip chain owns the screen (exclusive
     *  fullscreen). The presenter composites these windows' rects from the GDI overlay
     *  on top of every flip, and mouse routing prefers them. See dialog-overlay.ts. */
    overlayOnFlipScreen?: boolean;
}

/** Recent LoadStringA result — consumed when the next dialog is created. */
export let lastLoadStringHint: { text: string; at: number } | null = null;

export function noteLoadStringForDialog(text: string): void {
    if (!text) return;
    lastLoadStringHint = { text, at: performance.now() };
}

export function consumeLoadStringHint(maxAgeMs = 5000): string | undefined {
    if (!lastLoadStringHint) return undefined;
    if (performance.now() - lastLoadStringHint.at > maxAgeMs) {
        lastLoadStringHint = null;
        return undefined;
    }
    const t = lastLoadStringHint.text;
    lastLoadStringHint = null;
    return t;
}

export function markGuestCustomPaint(hwnd: number): void {
    const win = windows.get(hwnd);
    if (win) win.guestCustomPaint = true;
}

// Win32: destroying a window destroys all timers it owns. The timer map lives in
// message.ts (createMessageExports closure), so it registers this killer and
// DestroyWindow (window.ts) calls killWindowTimers(hwnd). Without it, a SetTimer'd
// window that's destroyed (e.g. HL's owner-draw skill button with an active hover
// timer, destroyed by EndDialog) leaves an orphan timer posting WM_TIMER to
// the dead hwnd → MFC FromHandlePermanent returns its freed CWnd → garbage vtable
// call → crash.
let windowTimerKiller: ((hwnd: number) => void) | null = null;
export function registerWindowTimerKiller(fn: (hwnd: number) => void): void {
    windowTimerKiller = fn;
}
export function killWindowTimers(hwnd: number): void {
    windowTimerKiller?.(hwnd >>> 0);
}

// Deferred-destroy finalizer: window.ts registers the real teardown (remove from the
// user32 + WindowManager maps); message.ts DispatchMessageW calls it once WM_NCDESTROY
// has been delivered to the window's wndProc. Cross-module hook (same pattern as the
// timer killer). See window.ts DestroyWindow.
let windowDestroyFinalizer: ((hwnd: number) => void) | null = null;
export function registerWindowDestroyFinalizer(fn: (hwnd: number) => void): void {
    windowDestroyFinalizer = fn;
}
/** Extra per-HWND state stores (edit-control, ...) registered to avoid import cycles. */
const extraControlStatePurgers: Array<(hwnd: number) => void> = [];
export function registerControlStatePurger(fn: (hwnd: number) => void): void {
    extraControlStatePurgers.push(fn);
}

/** Purge per-HWND control state so HWND reuse cannot inherit stale check/list/dropdown. */
export function purgeControlState(hwnd: number): void {
    const h = hwnd >>> 0;
    buttonCheckStates.delete(h);
    listControlStates.delete(h);
    trackbarStates.delete(h);
    controlImageHandles.delete(h);
    for (const purge of extraControlStatePurgers) purge(h);
}

export function finalizeWindowDestroy(hwnd: number): void {
    purgeControlState(hwnd);
    windowDestroyFinalizer?.(hwnd >>> 0);
}

/**
 * Best-effort fallback for dialogs that load their body text via LoadStringA but
 * declare no control to host it (e.g. HL's MCI-error box, which paints the loaded
 * string into the bare client area). We stamp the most recent LoadStringA result
 * onto such a dialog so paintDialogClientMessage can render it.
 *
 * Deliberately narrow to avoid putting stray text into other games' dialogs:
 *   - skip if the dialog already declares a Static/text control (the normal place
 *     for body text) — only truly empty dialogs inherit the hint;
 *   - ANSI only (LoadStringW does not feed the hint) — the targeted path is A;
 *   - time-bounded (consumeLoadStringHint's maxAge) so an unrelated earlier
 *     LoadStringA can't leak into a much-later dialog.
 */
export function assignPendingClientMessage(win: WindowInfo): void {
    if (win.clientMessage) return;
    // If the dialog has a Static child, it has a proper home for body text — don't
    // grab the hint (prevents cross-game false positives on ordinary dialogs).
    for (const childHandle of win.children) {
        const child = windows.get(childHandle);
        if (child?.isSystemControl && /static/i.test(child.systemControlClass ?? '')) {
            return;
        }
    }
    const hint = consumeLoadStringHint();
    if (hint) win.clientMessage = hint;
}

export const windows: Map<number, WindowInfo> = new Map();
export let nextWindowId = 1;

/** HWND_TOP / HWND_BOTTOM sentinels for child Z-order (unsigned as guest passes them). */
const HWND_TOP = 0;
const HWND_BOTTOM = 1;

/**
 * Reorder a child within its parent's children[] (last entry = topmost / front).
 * Mirrors SetWindowPos Z-order for WS_CHILD windows.
 */
export function reorderChildInParent(childHwnd: number, insertAfter: number): void {
    const child = windows.get(childHwnd);
    if (!child?.parent) return;
    const parent = windows.get(child.parent);
    if (!parent) return;

    const children = parent.children;
    const idx = children.indexOf(childHwnd);
    if (idx < 0) return;
    children.splice(idx, 1);

    const ia = insertAfter | 0;
    if (ia === HWND_TOP || ia === -1) {
        children.push(childHwnd);
        return;
    }
    if (ia === HWND_BOTTOM || ia === 1) {
        children.unshift(childHwnd);
        return;
    }
    const afterIdx = children.indexOf(ia >>> 0);
    if (afterIdx >= 0) {
        children.splice(afterIdx + 1, 0, childHwnd);
    } else {
        children.push(childHwnd);
    }
}

/** GW_HWNDNEXT / GW_HWNDPREV sibling in parent's child Z-order. */
export function getChildZOrderSibling(hwnd: number, direction: 'next' | 'prev'): number {
    const win = windows.get(hwnd);
    if (!win?.parent) return 0;
    const parent = windows.get(win.parent);
    if (!parent) return 0;
    const idx = parent.children.indexOf(hwnd);
    if (idx < 0) return 0;
    if (direction === 'next') {
        return idx + 1 < parent.children.length ? parent.children[idx + 1] : 0;
    }
    return idx > 0 ? parent.children[idx - 1] : 0;
}

/** Children in paint order: back → front (topmost painted last). */
/** True when any direct child is a JS-driven system control. */
export function hasSystemControlChildren(win: WindowInfo): boolean {
    for (const h of win.children) {
        if (windows.get(h)?.isSystemControl) return true;
    }
    return false;
}

export function getChildrenInPaintOrder(parentHwnd: number): number[] {
    const parent = windows.get(parentHwnd);
    if (!parent) return [];
    return [...parent.children].reverse();
}

/** LockWindowUpdate: suppress overlay repaint while a subtree is locked. */
let lockWindowUpdateHwnd = 0;

export function setLockWindowUpdate(hwnd: number): number {
    const prev = lockWindowUpdateHwnd;
    lockWindowUpdateHwnd = hwnd >>> 0;
    return prev;
}

export function getLockWindowUpdate(): number {
    return lockWindowUpdateHwnd;
}

/** True if hwnd is the locked window or a descendant of it. */
export function isWindowUpdateLocked(hwnd: number): boolean {
    if (!lockWindowUpdateHwnd) return false;
    let cur = hwnd >>> 0;
    while (cur) {
        if (cur === lockWindowUpdateHwnd) return true;
        const w = windows.get(cur);
        cur = w?.parent ?? 0;
    }
    return false;
}

/** Sum parent chain offsets — canvas/screen space origin for a window. */
export function getAbsoluteWindowPosition(win: WindowInfo): { x: number; y: number } {
    const WS_CHILD = 0x40000000;
    let x = win.x;
    let y = win.y;
    // Only a WS_CHILD window's (x,y) is relative to its parent's CLIENT area — so accumulate
    // parent origins while walking up the child chain. A top-level window (WS_POPUP/overlapped,
    // including a modal #32770 whose `parent` is its OWNER, not a positional parent) already
    // stores SCREEN coordinates, so stop the instant we reach one. Blindly adding the owner's
    // origin onto a DS_CENTER-centered popup pushed launcher dialogs off-screen to the
    // bottom-right (Airfix Dogfighter setup: 372,298 + owner 440,361 = 812,659, clipped).
    //
    // Cycle guard: the window tree is a DAG in real Win32, so any cycle (a parent handle that
    // resolves back into the chain — see the desktop-handle collision fixed in window-manager.ts)
    // is our bug; without the guard it spins the worker forever (GetWindowRect → here → ∞).
    const visited = new Set<number>([win.handle]);
    let cur: WindowInfo | undefined = win;
    while (cur && (cur.style & WS_CHILD) !== 0 && cur.parent) {
        if (visited.has(cur.parent)) break;
        visited.add(cur.parent);
        const parent = windows.get(cur.parent);
        if (!parent) break;
        x += parent.x;
        y += parent.y;
        cur = parent;
    }
    return { x, y };
}
export let cursorDisplayCount = 0;

// Cursor confinement state (ClipCursor with a non-NULL rect). Tracks the faithful
// relative/captured-mouse signal alongside cursorDisplayCount; host engages pointer-lock
// on (cursor hidden) OR (cursor clipped).
export let cursorClipped = false;

export function setCursorClipped(clipped: boolean): void {
    cursorClipped = clipped;
}

export function isCursorClipped(): boolean {
    return cursorClipped;
}

// Mouse capture state
export let capturedHwnd: number = 0;

export function setCapture(hwnd: number): number {
    const prev = capturedHwnd;
    capturedHwnd = hwnd >>> 0;
    return prev;
}

export function getCapture(): number {
    return capturedHwnd;
}

export function releaseCapture(): number {
    const prev = capturedHwnd;
    capturedHwnd = 0;
    return prev;
}

// Clipboard storage
// Stores HGLOBAL-like handles by clipboard format (CF_* constants).
// Button check states for CheckDlgButton / IsDlgButtonChecked
export const buttonCheckStates: Map<number, number> = new Map();

// Combobox / Listbox item storage per control HWND
export interface ListControlItem {
    text: string;
    data: number;  // CB_SETITEMDATA / LB_SETITEMDATA
}
export interface ListControlState {
    items: ListControlItem[];
    selectedIndex: number;  // -1 = no selection
    /** First visible item (listbox scrolling, LB_SETTOPINDEX). */
    topIndex: number;
    /** Combobox dropdown is open (painted + hit-tested over the dialog). */
    dropdownOpen?: boolean;
}
export const listControlStates: Map<number, ListControlState> = new Map();

export function getOrCreateListState(hwnd: number): ListControlState {
    let state = listControlStates.get(hwnd);
    if (!state) {
        state = { items: [], selectedIndex: -1, topIndex: 0 };
        listControlStates.set(hwnd, state);
    }
    return state;
}

// Trackbar (msctls_trackbar32) state per control HWND
export interface TrackbarState {
    min: number;
    max: number;
    pos: number;
    lineSize: number;
    pageSize: number;
    ticFreq: number;
}
export const trackbarStates: Map<number, TrackbarState> = new Map();

export function getOrCreateTrackbarState(hwnd: number): TrackbarState {
    let state = trackbarStates.get(hwnd);
    if (!state) {
        state = { min: 0, max: 100, pos: 0, lineSize: 1, pageSize: 20, ticFreq: 1 };
        trackbarStates.set(hwnd, state);
    }
    return state;
}

// Static control bitmap associations (hwnd → hBitmap handle for SS_BITMAP / STM_SETIMAGE)
export const controlImageHandles: Map<number, number> = new Map();

export const clipboardDataByFormat: Map<number, number> = new Map();
export let clipboardOpenOwner: number | null = null;

export function getCursorDisplayCount(): number {
    return cursorDisplayCount;
}

// Current cursor handle (SetCursor). A NULL cursor hides the pointer over the
// window regardless of the ShowCursor display count — SDL2 hides its cursor
// this way (WIN_ShowCursor → SetCursor(NULL)), never touching ShowCursor.
let currentCursorHandle = 1;

export function setCurrentCursorHandle(hCursor: number): number {
    const prev = currentCursorHandle;
    currentCursorHandle = hCursor >>> 0;
    return prev;
}

/** Effective host-cursor visibility: display count ≥ 0 AND a non-NULL cursor set. */
export function isGuestCursorVisible(): boolean {
    return cursorDisplayCount >= 0 && currentCursorHandle !== 0;
}

// Last cursor user object forwarded to the host — identity dedup (handles are
// pool-reused, so dedup by handle value would go stale; see the ddraw
// GetAttachedSurface cache for the same failure mode).
let lastForwardedCursorImageObj: unknown = null;

/**
 * Single sync point for the guest pointer → host: pushes visibility and the
 * installed shape. Real Windows draws whatever image SetCursor installed
 * whenever the cursor is visible — a game that renders its own pointer hides
 * the system one first (SetCursor(NULL) or ShowCursor to a negative count), so
 * a visible custom cursor means the HOST renders its image. Every cursor-state
 * mutator (SetCursor, ShowCursor, dialog forcing) must end here — do not
 * re-derive visibility at call sites.
 */
export function syncHostCursorToGuestState(): void {
    const sys = System.getInstance();
    sys.requestHostCursorVisible(isGuestCursorVisible());
    const obj = sys.resourceProvider.getUserObject?.(currentCursorHandle);
    const image = (obj?.type === 'CURSOR'
        && obj.pixels instanceof Uint8Array
        && obj.width > 0 && obj.height > 0
        && obj.pixels.length >= obj.width * obj.height * 4)
        ? obj : null;
    if (lastForwardedCursorImageObj === image) return;
    lastForwardedCursorImageObj = image;
    sys.requestHostCursorImage(image ? {
        width: image.width,
        height: image.height,
        pixels: image.pixels,
        hotspotX: image.xHotspot ?? 0,
        hotspotY: image.yHotspot ?? 0,
    } : null);
}

/**
 * SetCursor semantics shared by user32 SetCursor and DefWindowProc WM_SETCURSOR:
 * install the handle and sync the host pointer. Returns the previous handle.
 */
export function installCursorAndUpdateHostVisibility(hCursor: number): number {
    const prev = setCurrentCursorHandle(hCursor);
    syncHostCursorToGuestState();
    return prev;
}

export function updateCursorDisplayCount(delta: number): number {
    cursorDisplayCount += delta;
    // Clamp to -1 minimum: on real Windows the counter can go deeply negative,
    // but our message pump runs faster than native, causing far more
    // ShowCursor(FALSE) calls than expected. Clamping ensures a single
    // ShowCursor(TRUE) can restore visibility (matching real-world game behavior).
    if (cursorDisplayCount < -1) cursorDisplayCount = -1;
    return cursorDisplayCount;
}

export function incrementNextWindowId(): number {
    return nextWindowId++;
}

export function isClipboardOpen(): boolean {
    return clipboardOpenOwner !== null;
}

export function openClipboard(owner: number): boolean {
    if (clipboardOpenOwner !== null) return false;
    clipboardOpenOwner = owner >>> 0;
    return true;
}

export function closeClipboard(): boolean {
    if (clipboardOpenOwner === null) return false;
    clipboardOpenOwner = null;
    return true;
}

export function emptyClipboard(): void {
    clipboardDataByFormat.clear();
}

/** GDI dialogs need a visible host cursor; games may leave ShowCursor count negative after DDraw init. */
export function ensureHostCursorForDialog(): void {
    if (cursorDisplayCount < 0) cursorDisplayCount = 0;
    if (currentCursorHandle === 0) currentCursorHandle = 1;
    syncHostCursorToGuestState();
}

export function resetUser32SharedState(): void {
    windows.clear();
    nextWindowId = 1;
    cursorDisplayCount = 0;
    cursorClipped = false;
    currentCursorHandle = 1;
    lastForwardedCursorImageObj = null;
    resetSystemCursorHandles();
    resetUser32Classes();
    lastLoadStringHint = null;
    capturedHwnd = 0;
    buttonCheckStates.clear();
    listControlStates.clear();
    trackbarStates.clear();
    controlImageHandles.clear();
    clipboardDataByFormat.clear();
    clipboardOpenOwner = null;
    resetOwnerDrawScratch();
    resetHooks();
    Logger.log(LogCategory.USER32, 'User32 shared state reset');
}
