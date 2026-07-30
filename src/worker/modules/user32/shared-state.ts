import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { getActiveDeviceCursor } from "../../core/device-cursor";
import { IDC_ARROW, getSystemCursorHandle } from "./system-cursors";

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
    // Handles are pool-reused: a retained client image left behind would be restored under
    // a DIFFERENT window that later gets this handle.
    System.getInstance().gdiContext?.dropWindowClientBacking?.(hwnd >>> 0);
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

/**
 * Screen-space intersection of the client rects of a window's WS_CHILD ANCESTORS —
 * the clip Win32 applies to a child window's pixels (a child never draws outside its
 * parent's client area, and a nested child is clipped by every ancestor in turn).
 * null when the window has no child ancestor, i.e. it is top-level and unclipped.
 *
 * Deliberately excludes the window's OWN rect: our DLU→px conversion is approximate,
 * so a template-laid-out control can come out a couple of pixels past its own
 * dialog's edge, and clipping to self would erase content real Windows shows (the
 * same reason paintDialogBackground fills the rect ∪ children union).
 */
export function getAncestorClipRect(
    win: WindowInfo,
): { x: number; y: number; w: number; h: number } | null {
    const WS_CHILD = 0x40000000;
    let clip: { x: number; y: number; w: number; h: number } | null = null;
    const visited = new Set<number>([win.handle]);
    let cur: WindowInfo | undefined = win;
    while (cur && (cur.style & WS_CHILD) !== 0 && cur.parent && !visited.has(cur.parent)) {
        visited.add(cur.parent);
        const parent = windows.get(cur.parent);
        if (!parent) break;
        const origin = getAbsoluteWindowPosition(parent);
        const rect = { x: origin.x, y: origin.y, w: parent.width, h: parent.height };
        if (!clip) {
            clip = rect;
        } else {
            const x = Math.max(clip.x, rect.x);
            const y = Math.max(clip.y, rect.y);
            clip = {
                x, y,
                w: Math.min(clip.x + clip.w, rect.x + rect.w) - x,
                h: Math.min(clip.y + clip.h, rect.y + rect.h) - y,
            };
        }
        cur = parent;
    }
    return clip;
}

/**
 * Screen rects of the visible child WINDOWS that own their own pixels — child dialogs
 * and app-class windows, i.e. everything that paints ITSELF rather than being drawn by
 * us as default control chrome.
 *
 * The complement of getAncestorClipRect. A child window's pixels belong to the CHILD on
 * Windows — a parent's paint cannot reach them, which is what a separate HWND means. Our
 * overlay is one flat canvas with no such ownership, so a parent flushing its whole
 * client rect blits straight over a child dialog that legitimately drew there, and
 * nothing repaints the child afterwards (it is not in the parent's owner-draw chain).
 *
 * System controls are deliberately NOT excluded: those we draw ON TOP of the parent's
 * background, so the background must reach under them — a Static with a transparent
 * background shows the dialog face through it.
 */
export function getChildWindowExclusions(
    hwnd: number,
): { x: number; y: number; w: number; h: number }[] {
    const out: { x: number; y: number; w: number; h: number }[] = [];
    const visited = new Set<number>([hwnd]);
    // DESCENDANTS, not just children: a system control owns no pixels of its own (we
    // draw it), so a paint may reach through one — but the guest-owned windows nested
    // BELOW it are still theirs. A page dialog hosted in a placeholder Static is a
    // grandchild of the frame, and a children-only walk lets the frame's flush erase it.
    const walk = (parentHwnd: number): void => {
        const parent = windows.get(parentHwnd);
        if (!parent?.children.length) return;
        for (const childHwnd of parent.children) {
            if (visited.has(childHwnd)) continue;
            visited.add(childHwnd);
            const child = windows.get(childHwnd);
            if (!child || !child.visible) continue;
            if (child.isSystemControl) { walk(childHwnd); continue; }
            if (child.width <= 0 || child.height <= 0) continue;
            const origin = getAbsoluteWindowPosition(child);
            let rect = { x: origin.x, y: origin.y, w: child.width, h: child.height };
            // Exclude only the pixels the child can ACTUALLY paint: its own paint is clipped
            // to its ancestors' client areas (getAncestorClipRect), and a page template is
            // routinely taller than the placeholder hosting it. Holing out the full rect left
            // the un-paintable remainder showing whatever was under it — the grey dialog face
            // in a band below the page.
            const clip = getAncestorClipRect(child);
            if (clip) {
                const x0 = Math.max(rect.x, clip.x);
                const y0 = Math.max(rect.y, clip.y);
                const x1 = Math.min(rect.x + rect.w, clip.x + clip.w);
                const y1 = Math.min(rect.y + rect.h, clip.y + clip.h);
                if (x1 <= x0 || y1 <= y0) continue;
                rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
            }
            // No descent past a guest-owned window: it owns everything inside its rect.
            out.push(rect);
        }
    };
    walk(hwnd);
    return out;
}

/**
 * Win32 IsWindowVisible: a window is on screen only if it AND every WS_CHILD ancestor
 * carry WS_VISIBLE. Hiding a parent does NOT clear the children's bit — Windows just
 * stops drawing them — so a painter that consults only `win.visible` happily draws the
 * children of a hidden page. On the flat overlay that resurrects a page that was switched
 * away, which is why erasing a hidden window's pixels was unsafe without this.
 */
export function isEffectivelyVisible(win: WindowInfo | undefined): boolean {
    const WS_CHILD = 0x40000000;
    let cur = win;
    const visited = new Set<number>();
    while (cur) {
        if (!cur.visible) return false;
        if ((cur.style & WS_CHILD) === 0 || cur.parent === undefined) return true;
        if (visited.has(cur.parent)) return true; // cycle guard
        visited.add(cur.parent);
        cur = windows.get(cur.parent);
    }
    return true;
}

export let cursorDisplayCount = 0;

/** Screen-space cursor bounds; right/bottom are EXCLUSIVE (Win32 RECT). */
export interface CursorClipRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

// Cursor confinement (ClipCursor). null = unconfined. The rect is the whole of the
// state: the pointer is genuinely clamped to it (see clampToCursorClip), so
// confinement needs nothing from the host transport.
let cursorClipRect: CursorClipRect | null = null;

/** Bounds the clip rect itself is confined to (wineserver set_clip_rectangle clamps
 *  the requested rect to the virtual screen). */
export function getVirtualScreenRect(): CursorClipRect {
    const sys = System.getInstance();
    const cfg = EmulatorConfig.getInstance().screenResolution;
    return {
        left: 0,
        top: 0,
        right: sys.emulatedDisplayMode?.width || sys.ddrawContext?.display?.width || cfg.width,
        bottom: sys.emulatedDisplayMode?.height || sys.ddrawContext?.display?.height || cfg.height,
    };
}

export function setCursorClipRect(rect: CursorClipRect | null): void {
    cursorClipRect = rect;
    publishCursorConfinementSignal();
}

export function getCursorClipRect(): CursorClipRect | null {
    return cursorClipRect;
}

export function isCursorClipped(): boolean {
    return cursorClipRect !== null;
}

/**
 * Confine a screen point to the clip rect. Right/bottom are exclusive, so the
 * pointer bounds to right-1/bottom-1 (NT5 BoundCursor; wineserver
 * update_desktop_cursor_pos does the same max/min).
 */
export function clampToCursorClip(x: number, y: number): { x: number; y: number } {
    const clip = cursorClipRect;
    if (!clip) return { x, y };
    return {
        x: Math.max(Math.min(x, clip.right - 1), clip.left),
        y: Math.max(Math.min(y, clip.bottom - 1), clip.top),
    };
}

// ClipCursor is confinement, NOT an intent to steer by motion: a windowed game that
// clips to its own client rect is ordinary and keeps a visible pointer. What marks
// relative-mouse emulation is confinement with a HIDDEN pointer, so that is what the
// host is told — the confinement itself we enforce ourselves and it needs no transport.
let lastPublishedClipSignal = false;

function publishCursorConfinementSignal(): void {
    const relative = cursorClipRect !== null && !isHostPointerShown();
    if (relative === lastPublishedClipSignal) return;
    lastPublishedClipSignal = relative;
    self.postMessage({ type: "clip_cursor", clip: relative });
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
    /**
     * Keyboard-focus item (LB_GETCARETINDEX / iSelBase). A single-select
     * list normally moves this together with selectedIndex, but Win32 keeps
     * it as distinct state after the selection is cleared.
     */
    caretIndex: number;
    /** First visible item (listbox scrolling, LB_SETTOPINDEX). */
    topIndex: number;
    /** Combobox dropdown is open (painted + hit-tested over the dialog). */
    dropdownOpen?: boolean;
}
export const listControlStates: Map<number, ListControlState> = new Map();

export function getOrCreateListState(hwnd: number): ListControlState {
    let state = listControlStates.get(hwnd);
    if (!state) {
        state = { items: [], selectedIndex: -1, caretIndex: 0, topIndex: 0 };
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
// A thread starts with the arrow installed. Held as a sentinel and resolved on
// first read because the resource provider does not exist at module init; a raw
// placeholder handle would resolve to no user object, and the host would be asked
// to show a cursor it has no image for.
const DEFAULT_CURSOR = -1;
let currentCursorHandle = DEFAULT_CURSOR;

function resolveCursorHandle(handle: number): number {
    if (handle === DEFAULT_CURSOR) return getSystemCursorHandle(IDC_ARROW);
    // A handle whose object is gone (the guest destroyed it, or it outlived a reset of the
    // user-object table) cannot be what Windows still shows: a destroyed cursor never stays
    // current. Fall back to the arrow so "visible" always comes with a shape to draw.
    if (handle !== 0 && !System.getInstance().resourceProvider.getUserObject?.(handle)) {
        return getSystemCursorHandle(IDC_ARROW);
    }
    return handle;
}

export function setCurrentCursorHandle(hCursor: number): number {
    const prev = currentCursorHandle;
    currentCursorHandle = hCursor >>> 0;
    return resolveCursorHandle(prev);
}

export function getCurrentCursorHandle(): number {
    return resolveCursorHandle(currentCursorHandle);
}

/** Effective host-cursor visibility: display count ≥ 0 AND a non-NULL cursor set. */
export function isGuestCursorVisible(): boolean {
    return cursorDisplayCount >= 0 && currentCursorHandle !== 0;
}

/** Whether a pointer is drawn at all — the D3D device cursor outranks the Win32 one. */
function isHostPointerShown(): boolean {
    return !!getActiveDeviceCursor() || isGuestCursorVisible();
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
    // The D3D device cursor is composited by the runtime over the frame, independent
    // of the Win32 pointer: an app that enables it hides the Win32 one and still
    // expects a pointer, so while it is on it IS the pointer.
    const deviceCursor = getActiveDeviceCursor();
    // Whether a pointer is drawn is half of the confinement signal (see
    // publishCursorConfinementSignal), so re-derive it wherever visibility changes.
    publishCursorConfinementSignal();
    if (deviceCursor) {
        sys.requestHostCursorVisible(true);
        if (lastForwardedCursorImageObj !== deviceCursor) {
            lastForwardedCursorImageObj = deviceCursor;
            sys.requestHostCursorImage(deviceCursor);
        }
        return;
    }
    sys.requestHostCursorVisible(isGuestCursorVisible());
    const obj = sys.resourceProvider.getUserObject?.(getCurrentCursorHandle());
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

// RECENTRE detection — the faithful "this app steers by motion" signal. A
// relative-mouse emulator consumes motion by warping the pointer back to a FIXED
// target: recentre, let the pointer drift off, recentre again (AGS mouse-speed,
// UE warpers). The MECHANISM is the signal, not the call rate — an app that
// mirrors its own pointer position warps just as often and means nothing. So a
// warp counts only when it (a) displaces the pointer at all, (b) targets the same
// spot as the previous warp, and (c) had drift away from that spot to consume.
// One-shot warps (dialog snap-to-default, level-start centring) never chain.
const RECENTRE_BURST_COUNT = 3;
const RECENTRE_WINDOW_MS = 1500;
/** A recentre target is fixed; a few px of slack covers odd/rounded client rects. */
const RECENTRE_TOLERANCE_PX = 4;
// A recentring app pauses whenever it is not steering (menu, cutscene, loading) and
// resumes in the same mode, so the claim outlives a long gap.
const RECENTRE_RELEASE_MS = 10000;
let recentreTimes: number[] = [];
let lastWarpTarget: { x: number; y: number } | null = null;
let warpModeActive = false;
let warpReleaseTimer: ReturnType<typeof setTimeout> | null = null;

function nearTarget(ax: number, ay: number, bx: number, by: number): boolean {
    return Math.abs(ax - bx) <= RECENTRE_TOLERANCE_PX && Math.abs(ay - by) <= RECENTRE_TOLERANCE_PX;
}

function noteCursorRecentre(fromX: number, fromY: number, toX: number, toY: number): void {
    const prev = lastWarpTarget;
    lastWarpTarget = { x: toX, y: toY };
    // A moving target is a pointer FOLLOWER (or an unrelated one-shot), not a recentre —
    // whatever run was in progress is over.
    if (!prev || !nearTarget(toX, toY, prev.x, prev.y)) {
        recentreTimes.length = 0;
        return;
    }
    // Same target, but nothing drifted off it since the last warp: no motion was
    // consumed, so this is evidence neither way. Engines re-assert the centre several
    // times per poll; wiping the run on those would keep the count pinned at one.
    if (nearTarget(fromX, fromY, prev.x, prev.y)) return;
    const now = Date.now();
    recentreTimes.push(now);
    while (recentreTimes.length > 0 && now - recentreTimes[0] >= RECENTRE_WINDOW_MS) recentreTimes.shift();
    if (!warpModeActive && recentreTimes.length >= RECENTRE_BURST_COUNT) {
        warpModeActive = true;
        System.getInstance().requestHostCursorWarpMode(true);
    }
    if (warpReleaseTimer) clearTimeout(warpReleaseTimer);
    warpReleaseTimer = setTimeout(() => {
        warpReleaseTimer = null;
        if (warpModeActive) {
            warpModeActive = false;
            System.getInstance().requestHostCursorWarpMode(false);
        }
    }, RECENTRE_RELEASE_MS);
}

/**
 * Single sink for a guest-driven pointer warp: moves the pointer (confined, and
 * generating the mouse move the system generates), tells the host, and feeds the
 * recentre detector. Shared by user32 SetCursorPos and
 * IDirect3DDevice9::SetCursorPosition — both move the one real pointer on Windows
 * (wined3d's cursor-position path calls SetCursorPos for a hardware cursor, which
 * is the cursor kind D3DCAPS9.CursorCaps advertises).
 *
 * A warp onto the pointer's own position still generates its mouse event (that
 * happens inside moveCursorTo — Windows raises the moved flag without comparing
 * positions), but it moves no pointer, so it earns no host round-trip and counts as
 * no evidence. Those are the parts wined3d and NtUserSetCursorPos gate on position:
 * wined3d_device_set_cursor_position returns before SetCursorPos when x/y already
 * equal GetCursorPos, and NtUserSetCursorPos drives pSetCursorPos only when
 * prev != new.
 */
export function warpGuestCursorTo(x: number, y: number): void {
    const inputManager = System.getInstance().inputManager;
    const from = inputManager.getMouseState();
    if (!inputManager.moveCursorTo(x, y)) return;
    const to = inputManager.getMouseState();
    self.postMessage({ type: "set_cursor_pos", x: to.x, y: to.y });
    noteCursorRecentre(from.x, from.y, to.x, to.y);
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
    if (currentCursorHandle === 0) currentCursorHandle = DEFAULT_CURSOR;
    syncHostCursorToGuestState();
}

export function resetUser32SharedState(): void {
    windows.clear();
    nextWindowId = 1;
    cursorDisplayCount = 0;
    cursorClipRect = null;
    lastPublishedClipSignal = false;
    currentCursorHandle = DEFAULT_CURSOR;
    lastForwardedCursorImageObj = null;
    recentreTimes = [];
    lastWarpTarget = null;
    warpModeActive = false;
    if (warpReleaseTimer) { clearTimeout(warpReleaseTimer); warpReleaseTimer = null; }
    lastLoadStringHint = null;
    capturedHwnd = 0;
    buttonCheckStates.clear();
    listControlStates.clear();
    trackbarStates.clear();
    controlImageHandles.clear();
    clipboardDataByFormat.clear();
    clipboardOpenOwner = null;
    Logger.log(LogCategory.USER32, 'User32 shared state reset');
}
