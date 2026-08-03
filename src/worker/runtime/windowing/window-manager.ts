
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { MessageQueue } from './message-queue';
import type { Message } from './message-queue';
import { hypercallDataManager } from '../../core/cpu/hypercall-data';

// Pseudo-handle returned by GetDesktopWindow() when no top-level window is active.
// MUST be reserved out of the real window handle space (nextHwnd starts above it):
// if a real window were ever allocated this handle, a game that does
// CreateWindowEx(parent = GetDesktopWindow()) at startup (e.g. Montezuma) would make
// its own window its parent → self-cycle → getAbsoluteWindowPosition spins forever.
export const DESKTOP_HWND = 0x10000;

export interface WindowClass {
    name: string;
    wndProc: number;
    hInstance: number;
    style: number;
    hbrBackground: number;
}

export interface WindowObject {
    hwnd: number;
    wndClass: WindowClass;
    parent: number; // HWND
    rect: { x: number; y: number; w: number; h: number };
    style: number;
    exStyle: number;
    userData: number; // GWLP_USERDATA
    wndProc: number; // Current Window Procedure (supports subclassing)

    // HLE: Internal state
    visible: boolean;
    title: string;

    // Client area offset from window origin (accounts for title bar, borders)
    // For borderless/fullscreen: (0, 0). With frame: e.g., (3, 26) for classic theme
    clientOffsetX: number;
    clientOffsetY: number;

    // Thread that created this window (for message routing — PostMessage routes to owner thread)
    creatorThreadId: number;
}

export type { Message } from './message-queue';

// Window styles for frame detection
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00C00000;
const WS_BORDER = 0x00800000;
const WS_CHILD = 0x40000000;
const WS_THICKFRAME = 0x00040000;
const WS_DISABLED = 0x08000000;
const WS_EX_TOPMOST = 0x00000008;

// SetWindowPos / SetWindowZOrder special hWndInsertAfter values
const HWND_TOP = 0;
const HWND_BOTTOM = 1;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;

// Activation / capture messages (faithful Win32 delivery — same posting style as
// activation-messages.ts; posted here so destroy-successor activation and capture
// loss reach the guest WndProc without re-entering it synchronously).
const WM_ACTIVATE = 0x0006;
const WM_SETFOCUS = 0x0007;
const WM_KILLFOCUS = 0x0008;
const WM_ACTIVATEAPP = 0x001c;
const WM_NCACTIVATE = 0x0086;
const WM_CAPTURECHANGED = 0x0215;
const WM_DISPLAYCHANGE = 0x007e;
const WA_INACTIVE = 0;
const WA_ACTIVE = 1;

export class WindowManager {
    private windows: Map<number, WindowObject> = new Map();
    private classes: Map<string, WindowClass> = new Map();
    private messageQueue: MessageQueue = new MessageQueue();

    private nextHwnd = DESKTOP_HWND + 1; // reserve DESKTOP_HWND for the desktop pseudo-handle
    private activeHwnd = 0;     // Active top-level window (GetActiveWindow)
    private focusHwnd = 0;      // Focus window — may be a child (GetFocus)
    private foregroundHwnd = 0; // Foreground top-level window (GetForegroundWindow)
    private captureHwnd = 0;    // Mouse capture owner (GetCapture / SetCapture)

    /**
     * Top-level window Z-order, front (index 0) → back. Children are NOT in this list;
     * they z-order within their parent by creation order (children[] insertion). The
     * topmost group (WS_EX_TOPMOST) is kept ahead of the normal group inside this same
     * list: the first non-topmost entry marks the boundary.
     */
    private zOrder: number[] = [];

    /** Optional point-based mouse routing override (user32 dialog-overlay registers it
     *  to prefer live native dialogs over a DDraw flip chain). Returns hwnd or 0. */
    private mouseTargetResolver: ((screenX: number, screenY: number) => number) | null = null;

    constructor() { }

    registerMouseTargetResolver(resolver: (screenX: number, screenY: number) => number): void {
        this.mouseTargetResolver = resolver;
    }

    /**
     * Faithful mouse target for a screen point (Win32: capture → WindowFromPoint).
     * The Z-order WindowFromPoint walk is the primary, faithful path; the registered
     * dialog-overlay resolver remains only as a FALLBACK when WindowFromPoint finds
     * nothing (a dialog over a DDraw flip chain that is not yet first-class in the
     * Z-order — retired in a later phase). Capture is honored by callers (input-manager)
     * before this is consulted.
     */
    getMouseTargetWindow(screenX: number, screenY: number): WindowObject | undefined {
        const fromPoint = this.windowFromPoint(screenX, screenY);
        if (fromPoint) {
            const win = this.windows.get(fromPoint);
            if (win) return win;
        }
        // Fallback: dialog-overlay point router (Phase 5 will retire this).
        const hwnd = this.mouseTargetResolver?.(screenX, screenY) ?? 0;
        if (hwnd) {
            const win = this.windows.get(hwnd);
            if (win && win.visible) return win;
        }
        return undefined;
    }

    /**
     * Faithful WindowFromPoint: walk the top-level Z-order front→back, skipping
     * invisible / WS_DISABLED windows; the first whose rect contains the point wins.
     * Then descend into its visible, enabled children (deepest containing child).
     * Returns the resolved hwnd (0 if none).
     */
    windowFromPoint(screenX: number, screenY: number): number {
        for (const hwnd of this.zOrder) {
            const win = this.windows.get(hwnd);
            if (!win || !win.visible || (win.style & WS_DISABLED) !== 0) continue;
            if (!this.rectContains(win, screenX, screenY)) continue;
            // Descend into children (deepest hit wins). Child rects are parent-relative.
            return this.descendToChildAtPoint(hwnd, win.rect.x, win.rect.y, screenX, screenY);
        }
        return 0;
    }

    private rectContains(win: WindowObject, screenX: number, screenY: number): boolean {
        // Top-level rect.x/y is the on-surface origin (we render a single app surface).
        return screenX >= win.rect.x && screenX < win.rect.x + win.rect.w &&
            screenY >= win.rect.y && screenY < win.rect.y + win.rect.h;
    }

    /**
     * Walk children of `parentHwnd` (origin originX/originY in screen space), returning
     * the deepest visible+enabled child containing the point, or parentHwnd if none.
     * Child creation appends at HWND_BOTTOM, so insertion order is front to back.
     */
    private descendToChildAtPoint(parentHwnd: number, originX: number, originY: number, screenX: number, screenY: number): number {
        const children: WindowObject[] = [];
        for (const win of this.windows.values()) {
            if (win.parent === parentHwnd && (win.style & WS_CHILD) !== 0) children.push(win);
        }
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (!child.visible || (child.style & WS_DISABLED) !== 0) continue;
            const cx = originX + child.rect.x;
            const cy = originY + child.rect.y;
            if (screenX >= cx && screenX < cx + child.rect.w && screenY >= cy && screenY < cy + child.rect.h) {
                const deeper = this.descendToChildAtPoint(child.hwnd, cx, cy, screenX, screenY);
                // A non-transparent descendant under the point wins outright.
                if (deeper !== child.hwnd) return deeper;
                // Win32 WM_NCHITTEST: a Static control without SS_NOTIFY returns
                // HTTRANSPARENT, so the mouse falls through to the window beneath it
                // (a sibling lower in Z-order, else the parent). Launchers that use
                // SS_BITMAP statics as menu items (e.g. Morrowind) rely on this — they
                // hit-test at the dialog level via ChildWindowFromPointEx, so clicks
                // must reach the parent, not be swallowed by the static's DefWindowProc.
                if (this.isHitTransparent(child)) continue;
                return child.hwnd;
            }
        }
        return parentHwnd;
    }

    /** Win32 mouse hit-transparency (WM_NCHITTEST → HTTRANSPARENT default). */
    private isHitTransparent(win: WindowObject): boolean {
        const SS_NOTIFY = 0x0100;
        const BS_TYPEMASK = 0x000F;
        const BS_GROUPBOX = 0x0007;
        const cls = (win.wndClass?.name ?? '').toLowerCase();
        if (cls === 'static') return (win.style & SS_NOTIFY) === 0;
        // A BS_GROUPBOX never captures mouse input — real Windows' Button class
        // answers WM_NCHITTEST with HTTRANSPARENT for it, so clicks fall through to
        // whatever's underneath. Dialog templates routinely list a group box AFTER
        // the controls it visually contains (creation order = initial z-order), so
        // without this every control nested inside one is unclickable purely from
        // template ordering — e.g. TLJ's ComboBox/CheckBox controls precede their
        // enclosing group box.
        if (cls === 'button') return (win.style & BS_TYPEMASK) === BS_GROUPBOX;
        return false;
    }

    registerClass(wndClass: WindowClass): number {
        const atom = 0xC000 + this.classes.size; // Fake atom
        this.classes.set(wndClass.name.toLowerCase(), wndClass);
        return atom;
    }

    getClass(name: string): WindowClass | undefined {
        return this.classes.get(name.toLowerCase());
    }

    createWindow(
        className: string,
        windowName: string,
        style: number,
        exStyle: number,
        x: number,
        y: number,
        width: number,
        height: number,
        parent: number,
        menu: number,
        instance: number,
        param: number
    ): number {
        let wndClass = this.getClass(className);
        if (!wndClass) {
            // Fallback: register dummy class so input has a target window (guest may have called CreateWindowEx before RegisterClassEx, or class name mismatch)
            this.registerClass({
                name: className,
                wndProc: 0,
                hInstance: 0,
                style: 0,
                hbrBackground: 0
            });
            wndClass = this.getClass(className);
        }
        if (!wndClass) return 0;

        const hwnd = this.nextHwnd++;

        // Calculate client area offset based on window style
        // For HLE simplicity: popup/borderless = (0,0), framed windows get approximate offset
        let clientOffsetX = 0;
        let clientOffsetY = 0;
        const isPopup = (style & WS_POPUP) !== 0;
        const hasCaption = (style & WS_CAPTION) === WS_CAPTION;
        const hasBorder = (style & WS_BORDER) !== 0;
        const hasThickFrame = (style & WS_THICKFRAME) !== 0;

        if (!isPopup && (hasCaption || hasBorder || hasThickFrame)) {
            // Approximate classic Windows frame metrics
            const borderWidth = hasThickFrame ? 4 : (hasBorder ? 1 : 0);
            const captionHeight = hasCaption ? 23 : 0; // Classic caption height
            clientOffsetX = borderWidth;
            clientOffsetY = borderWidth + captionHeight;
        }

        // Resolve owning thread — on Windows, PostMessage routes to the thread that created the window
        const system = System.getInstance();
        const creatorThreadId = system.scheduler?.getCurrentThreadId() ?? 0;

        const window: WindowObject = {
            hwnd,
            wndClass,
            parent,
            rect: { x, y, w: width, h: height },
            style,
            exStyle,
            userData: 0,
            wndProc: wndClass.wndProc,
            visible: (style & 0x10000000) !== 0, // WS_VISIBLE
            title: windowName,
            clientOffsetX,
            clientOffsetY,
            creatorThreadId,
        };

        this.windows.set(hwnd, window);

        // Insert top-level windows into the Z-order. New visible top-level windows go to
        // the top of their group (topmost vs normal). Children are not in the top-level
        // Z-order (they z-order within their parent by creation order).
        if ((style & WS_CHILD) === 0) {
            this.insertIntoZOrder(hwnd, window.visible);
        }

        // Auto-activate first created visible top-level window (simplifies input routing).
        // (D12 auto-activate-on-create is deliberately kept for now — removed in a later phase.)
        // Child windows (WS_CHILD) can never be active — activation is a top-level concept.
        // Owned windows (hWndParent != 0 but no WS_CHILD) ARE top-level and can be active.
        if (this.activeHwnd === 0 && window.visible && (style & WS_CHILD) === 0) {
            this.activeHwnd = hwnd;
            this.foregroundHwnd = hwnd;
            this.focusHwnd = hwnd;
        }

        // HLE: Send WM_CREATE immediately (synchronous)
        // In a real loop this might be dispatched, but for simplified HLE we often direct call.
        // For now, we'll queue it if we want strict behavior, or return success.
        // Let's rely on the module logic to send WM_CREATE for now.

        return hwnd;
    }

    destroyWindow(hwnd: number): boolean {
        const dying = this.windows.get(hwnd);
        if (!dying) return false;

        const wasActive = this.activeHwnd === hwnd;
        const wasForeground = this.foregroundHwnd === hwnd;
        // Focus is lost if the destroyed window OR one of its descendants held it.
        const focusInSubtree = this.focusHwnd === hwnd || this.isDescendantOf(this.focusHwnd, hwnd);

        // Capture: release if the dying window (or a descendant) holds it (WM_CAPTURECHANGED).
        const captureHwnd = this.captureHwnd;
        const captureLost = captureHwnd !== 0 && (captureHwnd === hwnd || this.isDescendantOf(captureHwnd, hwnd));
        if (captureLost) this.captureHwnd = 0;

        this.windows.delete(hwnd);
        this.removeFromZOrder(hwnd);
        this.messageQueue.removeWindow(hwnd);

        // Post WM_CAPTURECHANGED AFTER purging the dying window's queue, so the
        // capture-loss notification survives (removeWindow above would otherwise drop it
        // when the dying window itself held capture). lParam = hwnd gaining capture (NULL).
        if (captureLost) this.postMessage(captureHwnd, WM_CAPTURECHANGED, 0, 0);

        if (wasActive || wasForeground) {
            // Win32: on destroy of the active/foreground window, activation transfers to
            // the next visible top-level window in Z-order — it gets the full activation
            // chain (instead of leaving activeHwnd=0 → no WM_ACTIVATE/WM_SETFOCUS, the
            // Unreal recreated-window dead-cursor class).
            const successor = this.topVisibleTopLevel();
            const prevActive = wasActive ? hwnd : this.activeHwnd;
            if (successor) {
                this.activeHwnd = successor;
                this.foregroundHwnd = successor;
                this.focusHwnd = successor;
                this.postActivationChain(successor, 0); // prev is gone; no deactivation target
            } else {
                if (wasActive) this.activeHwnd = 0;
                if (wasForeground) this.foregroundHwnd = 0;
            }
            void prevActive;
        }
        if (focusInSubtree && this.focusHwnd !== this.activeHwnd) {
            // Focus fell to the (possibly new) active window if it wasn't already retargeted.
            this.focusHwnd = this.activeHwnd;
        }
        return true;
    }

    /** True if `hwnd` is `ancestor` or a transitive child of `ancestor`. */
    private isDescendantOf(hwnd: number, ancestor: number): boolean {
        if (!hwnd || !ancestor) return false;
        let cur: number | undefined = hwnd;
        const guard = 64;
        for (let i = 0; i < guard && cur; i++) {
            if (cur === ancestor) return true;
            cur = this.windows.get(cur)?.parent || 0;
        }
        return false;
    }

    getWindow(hwnd: number): WindowObject | undefined {
        return this.windows.get(hwnd);
    }

    getAllWindows(): WindowObject[] {
        return Array.from(this.windows.values());
    }

    /**
     * Get the active window (receives keyboard/mouse input)
     */
    getActiveWindow(): WindowObject | undefined {
        return this.windows.get(this.activeHwnd);
    }

    getActiveHwnd(): number {
        return this.activeHwnd;
    }

    /** Resolve a child/control to its top-level ancestor. */
    getTopLevelAncestor(hwnd: number): number {
        let top = this.windows.get(hwnd);
        const seen = new Set<number>();
        while (top && (top.style & WS_CHILD) !== 0 && top.parent && !seen.has(top.parent)) {
            seen.add(top.parent);
            top = this.windows.get(top.parent);
        }
        if (!top || (top.style & WS_CHILD) !== 0) return 0;
        return top.hwnd;
    }

    /** Clear active/foreground/focus slots when a top-level window is hidden and no successor exists. */
    clearActiveWindow(hwnd: number): void {
        if (this.activeHwnd === hwnd) this.activeHwnd = 0;
        if (this.foregroundHwnd === hwnd) this.foregroundHwnd = 0;
        if (this.focusHwnd === hwnd || this.isDescendantOf(this.focusHwnd, hwnd)) this.focusHwnd = 0;
    }

    /** Focus window (GetFocus) — may be a child. */
    getFocusHwnd(): number {
        return this.focusHwnd;
    }

    /** Foreground top-level window (GetForegroundWindow). */
    getForegroundHwnd(): number {
        return this.foregroundHwnd;
    }

    setCapture(hwnd: number): number {
        const previous = this.captureHwnd;
        this.captureHwnd = hwnd >>> 0;
        return previous;
    }

    getCaptureHwnd(): number {
        return this.captureHwnd;
    }

    releaseCapture(): number {
        const previous = this.captureHwnd;
        this.captureHwnd = 0;
        return previous;
    }

    /**
     * Set the active (top-level) window. Updates the active + foreground slots, moves the
     * window to the top of the Z-order, and sets focus to it. Does NOT post WM_ACTIVATE
     * messages — activation message delivery is owned by activation-messages.ts (window.ts
     * SetActiveWindow routes through activateTopLevelWindow, which posts the chain). Keeping
     * this silent preserves the existing flow (input-manager click-activate must not
     * double-post). The destroy-successor path posts its own chain via postActivationChain.
     */
    setActiveWindow(hwnd: number): number {
        const prevActive = this.activeHwnd;
        const win = this.windows.get(hwnd);
        // Child windows (WS_CHILD) can never be active — SetActiveWindow on a child is a no-op.
        // Owned windows (parent != 0 but no WS_CHILD) ARE top-level and can be active.
        if (win && (win.style & WS_CHILD) === 0) {
            this.activeHwnd = hwnd;
            this.foregroundHwnd = hwnd;
            this.focusHwnd = hwnd;
            this.bringToTop(hwnd);
            Logger.log(LogCategory.SYSTEM, `WindowManager: active window changed 0x${prevActive.toString(16)} -> 0x${hwnd.toString(16)}`);
        }
        return prevActive;
    }

    /**
     * Faithful SetFocus: set the focus window (a CHILD is allowed). Sends WM_KILLFOCUS to
     * the old focus and WM_SETFOCUS to the new one. Does NOT change the active/foreground
     * window. Returns the previous focus hwnd.
     */
    setFocus(hwnd: number): number {
        const prevFocus = this.focusHwnd;
        if (hwnd === prevFocus) return prevFocus;
        // hwnd === 0 is valid (SetFocus(NULL) releases focus).
        if (hwnd !== 0 && !this.windows.has(hwnd)) return prevFocus;
        this.focusHwnd = hwnd;
        if (prevFocus) this.postMessage(prevFocus, WM_KILLFOCUS, hwnd >>> 0, 0);
        if (hwnd) this.postMessage(hwnd, WM_SETFOCUS, prevFocus >>> 0, 0);
        return prevFocus;
    }

    /**
     * Get the best target window for input (active > topmost visible in Z-order > any).
     * Retained for legacy callers (GetCursorPos/keyboard fallback); mouse routing now
     * goes through getMouseTargetWindow (capture → WindowFromPoint).
     */
    getInputTargetWindow(): WindowObject | undefined {
        // 1. Active window (must be top-level — child windows can't be active)
        const active = this.windows.get(this.activeHwnd);
        if (active && active.visible && (active.style & WS_CHILD) === 0) {
            return active;
        }
        // 2. Topmost visible top-level window in Z-order.
        const top = this.topVisibleTopLevel();
        if (top) {
            // Auto-activate (legacy behavior preserved); keep foreground/focus in sync.
            this.activeHwnd = top;
            this.foregroundHwnd = top;
            this.focusHwnd = top;
            return this.windows.get(top);
        }
        // 3. Any top-level window (not WS_CHILD)
        for (const win of this.windows.values()) {
            if ((win.style & WS_CHILD) === 0) return win;
        }
        return undefined;
    }

    /**
     * Faithful keyboard target: the focus window (Win32 routes keystrokes to GetFocus()).
     * Falls back to the active window (and then the legacy topmost) when no focus is set.
     */
    getKeyboardTargetWindow(): WindowObject | undefined {
        const focus = this.windows.get(this.focusHwnd);
        if (focus && focus.visible) return focus;
        const active = this.windows.get(this.activeHwnd);
        if (active && active.visible && (active.style & WS_CHILD) === 0) return active;
        return this.getInputTargetWindow();
    }

    // ─── Z-order ──────────────────────────────────────────────────────────────

    /** First visible, enabled top-level window in Z-order (front→back), or 0. */
    private topVisibleTopLevel(): number {
        for (const hwnd of this.zOrder) {
            const win = this.windows.get(hwnd);
            if (win && win.visible && (win.style & WS_DISABLED) === 0) return hwnd;
        }
        return 0;
    }

    private isTopmost(hwnd: number): boolean {
        return ((this.windows.get(hwnd)?.exStyle ?? 0) & WS_EX_TOPMOST) !== 0;
    }

    /** Index of the first non-topmost entry (boundary between the topmost and normal groups). */
    private normalGroupStart(): number {
        for (let i = 0; i < this.zOrder.length; i++) {
            if (!this.isTopmost(this.zOrder[i])) return i;
        }
        return this.zOrder.length;
    }

    private insertIntoZOrder(hwnd: number, _visible: boolean): void {
        const i = this.zOrder.indexOf(hwnd);
        if (i >= 0) this.zOrder.splice(i, 1);
        if (this.isTopmost(hwnd)) {
            this.zOrder.unshift(hwnd);
        } else {
            this.zOrder.splice(this.normalGroupStart(), 0, hwnd);
        }
    }

    private removeFromZOrder(hwnd: number): void {
        const i = this.zOrder.indexOf(hwnd);
        if (i >= 0) this.zOrder.splice(i, 1);
    }

    /** Whether candidate is a top-level window owned, directly or transitively, by owner. */
    private isOwnedBy(candidate: number, owner: number): boolean {
        const seen = new Set<number>();
        let current = this.windows.get(candidate);
        while (current?.parent && !seen.has(current.parent)) {
            if (current.parent === owner) return true;
            seen.add(current.parent);
            current = this.windows.get(current.parent);
        }
        return false;
    }

    /**
     * Move hwnd to the top of its group (topmost stays above normal). Owned top-level
     * windows move with their owner and remain in front of it, as required by Win32.
     */
    private bringToTop(hwnd: number): void {
        if (!this.windows.has(hwnd)) return;
        const topmost = this.isTopmost(hwnd);
        const owned = this.zOrder.filter(candidate =>
            this.isTopmost(candidate) === topmost && this.isOwnedBy(candidate, hwnd));
        for (const candidate of owned) this.removeFromZOrder(candidate);
        this.removeFromZOrder(hwnd);
        const insertAt = topmost ? 0 : this.normalGroupStart();
        this.zOrder.splice(insertAt, 0, ...owned, hwnd);
    }

    /** BringWindowToTop — top-level window to the front of its group. */
    bringWindowToTop(hwnd: number): void {
        this.bringToTop(hwnd);
    }

    /**
     * SetWindowPos Z-order placement (SWP_NOZORDER callers skip this). `insertAfter` may be
     * HWND_TOP(0) / HWND_BOTTOM(1) / HWND_TOPMOST(-1) / HWND_NOTOPMOST(-2) or an explicit hwnd.
     */
    setWindowZOrder(hwnd: number, insertAfter: number): void {
        const win = this.windows.get(hwnd);
        if (!win || (win.style & WS_CHILD) !== 0) return; // children not in top-level Z-order
        // Normalize sentinels (they arrive as unsigned 0xFFFFFFFF / 0xFFFFFFFE from the guest).
        const ia = insertAfter | 0;

        if (ia === HWND_TOPMOST) {
            win.exStyle = (win.exStyle ?? 0) | WS_EX_TOPMOST;
            this.bringToTop(hwnd);
            return;
        }
        if (ia === HWND_NOTOPMOST) {
            win.exStyle = (win.exStyle ?? 0) & ~WS_EX_TOPMOST;
            this.bringToTop(hwnd);
            return;
        }
        if (ia === HWND_TOP) {
            this.bringToTop(hwnd);
            return;
        }
        if (ia === HWND_BOTTOM) {
            this.removeFromZOrder(hwnd);
            this.zOrder.push(hwnd);
            return;
        }
        // Explicit hwnd: place immediately behind it.
        const afterIdx = this.zOrder.indexOf(ia >>> 0);
        if (afterIdx < 0) return; // unknown reference window — leave unchanged
        this.removeFromZOrder(hwnd);
        const idx = this.zOrder.indexOf(ia >>> 0); // recompute (removeFromZOrder may shift)
        this.zOrder.splice(idx + 1, 0, hwnd);
    }

    /** Top-level Z-order snapshot, front→back (diagnostics / tests). */
    getZOrder(): number[] {
        return this.zOrder.slice();
    }

    /**
     * Post WM_DISPLAYCHANGE to every top-level window (faithful Win32: on a display-mode
     * change the system broadcasts WM_DISPLAYCHANGE to all top-level windows with
     * wParam = new bpp, lParam = MAKELPARAM(width, height)). The guest WinDrv / windowed
     * vs fullscreen reconciliation keys off this. Children are not notified (Windows only
     * broadcasts to top-level windows). Enumerates the Z-order list plus any tracked
     * top-level windows not yet in the Z-order, so newly-created hidden windows still hear it.
     */
    postDisplayChange(width: number, height: number, bpp: number): void {
        const lParam = (((height & 0xFFFF) << 16) | (width & 0xFFFF)) >>> 0;
        const count = this.broadcastToTopLevel(WM_DISPLAYCHANGE, bpp >>> 0, lParam);
        Logger.log(LogCategory.SYSTEM,
            `WindowManager: WM_DISPLAYCHANGE broadcast ${width}x${height}x${bpp} to ${count} top-level window(s)`);
    }

    /**
     * Post a message to every top-level window (the HWND_BROADCAST target set) and
     * return how many got it. Enumerates the Z-order list plus any tracked top-level
     * window not yet in it, so a newly-created hidden window still hears the broadcast.
     */
    broadcastToTopLevel(msg: number, wParam: number, lParam: number): number {
        const seen = new Set<number>();
        const broadcast = (hwnd: number): void => {
            if (seen.has(hwnd)) return;
            const win = this.windows.get(hwnd);
            if (!win || (win.style & WS_CHILD) !== 0) return;
            seen.add(hwnd);
            this.postMessage(hwnd, msg, wParam, lParam);
        };
        for (const hwnd of this.zOrder) broadcast(hwnd);
        for (const win of this.windows.values()) broadcast(win.hwnd);
        return seen.size;
    }

    /**
     * Post the full activation chain to a newly activated top-level window (and the
     * deactivation chain to prevHwnd if any). Same posting style as activation-messages.ts;
     * used by the destroy-successor activation path.
     */
    private postActivationChain(newHwnd: number, prevHwnd: number): void {
        if (prevHwnd && prevHwnd !== newHwnd && this.windows.has(prevHwnd)) {
            this.postMessage(prevHwnd, WM_NCACTIVATE, 0, 0);
            this.postMessage(prevHwnd, WM_ACTIVATEAPP, 0, 0);
            this.postMessage(prevHwnd, WM_ACTIVATE, WA_INACTIVE, newHwnd >>> 0);
            this.postMessage(prevHwnd, WM_KILLFOCUS, newHwnd >>> 0, 0);
        }
        if (newHwnd && this.windows.has(newHwnd)) {
            this.postMessage(newHwnd, WM_NCACTIVATE, 1, 0);
            this.postMessage(newHwnd, WM_ACTIVATEAPP, 1, 0);
            this.postMessage(newHwnd, WM_ACTIVATE, WA_ACTIVE, prevHwnd >>> 0);
            this.postMessage(newHwnd, WM_SETFOCUS, prevHwnd >>> 0, 0);
        }
    }

    /**
     * Get the thread that owns a window (the thread that called CreateWindowEx).
     * On Windows, PostMessage routes to the owning thread's queue.
     */
    getWindowOwnerThread(hwnd: number): number {
        return this.windows.get(hwnd)?.creatorThreadId ?? 0;
    }

    // Message Pump / Queue
    postMessage(
        hwnd: number,
        msg: number,
        wParam: number,
        lParam: number,
        ptX = 0,
        ptY = 0,
        targetThreadId = 0,
        keyStatePacked?: Uint8Array
    ): void {
        // Auto-resolve thread targeting from window ownership (matches Windows behavior:
        // PostMessage routes to the thread that created the window)
        if (targetThreadId === 0 && hwnd > 0) {
            targetThreadId = this.getWindowOwnerThread(hwnd);
        }
        const discrete = this.messageQueue.enqueue(hwnd, msg, wParam, lParam, ptX, ptY, targetThreadId, keyStatePacked);
        if (discrete) {
            // Eagerly update shared flag so WASM PeekMessage sees new messages immediately.
            // Coalesced WM_MOUSEMOVE does NOT set the flag (starvation / spin avoidance).
            // WM_PAINT sets the flag so guest launcher WM_PAINT is delivered under WASM fast path.
            hypercallDataManager.updateMessageQueueFlag(true);
            // Wake threads blocked in WaitMessage (scheduler MESSAGE wait). Internal callers
            // (InvalidateRect, Quartz frame notify, etc.) route through postMessage, not the
            // user32 PostMessage export — without this, WaitMessage never returns while v86 is
            // stopped (GOG video player / Delphi apps using WaitMessage+InvalidateRect loops).
            System.getInstance().scheduler.wakeMessageWaiters(
                targetThreadId > 0 ? targetThreadId : undefined,
            );
        }
    }

    // Get message from queue (with priority handling built into MessageQueue)
    getMessage(): Message | null {
        return this.messageQueue.dequeue();
    }

    waitForMessage(callerThreadId = 0): Promise<Message> {
        return this.messageQueue.waitForMessage(callerThreadId);
    }

    /**
     * Set callback for input polling during message wait
     */
    setInputPollCallback(callback: () => void): void {
        this.messageQueue.setInputPollCallback(callback);
    }

    /**
     * Wake up all waiting message handlers (e.g., when pausing)
     */
    wakeWaiters(): void {
        this.messageQueue.wakeWaiters();
    }

    hasMessages(msgMin = 0, msgMax = 0, callerThreadId = 0): boolean {
        return this.messageQueue.hasMessages(msgMin, msgMax, callerThreadId);
    }

    /** MAKELONG(x, y) from the last dequeued message — for GetMessagePos(). */
    clearPaintMessage(hwnd: number): boolean {
        const removed = this.messageQueue.clearPaint(hwnd);
        hypercallDataManager.updateMessageQueueFlag(this.messageQueue.hasMessages());
        return removed;
    }

    getLastMessagePos(): number {
        const x = this.messageQueue.lastDequeuedPtX & 0xFFFF;
        const y = this.messageQueue.lastDequeuedPtY & 0xFFFF;
        return (y << 16) | x;
    }

    /** Timestamp from the last dequeued message — for GetMessageTime(). */
    getLastMessageTime(): number {
        return this.messageQueue.lastDequeuedTime;
    }

    /** True when a thread is blocking in GetMessage (waitForMessage). */
    hasWaiters(): boolean {
        return this.messageQueue.hasWaiters();
    }

    // Legacy compatibility
    peekMessage(remove: boolean, msgMin = 0, msgMax = 0, callerThreadId = 0): Message | undefined {
        if (remove) {
            return this.messageQueue.dequeue(msgMin, msgMax, callerThreadId) ?? undefined;
        }
        return this.messageQueue.peek(msgMin, msgMax, callerThreadId) ?? undefined;
    }

    /**
     * Reset window manager state - clear all windows, classes, and message queue
     */
    reset(): void {
        this.windows.clear();
        this.classes.clear();
        this.messageQueue.clear();
        this.nextHwnd = DESKTOP_HWND + 1;
        this.activeHwnd = 0;
        this.focusHwnd = 0;
        this.foregroundHwnd = 0;
        this.captureHwnd = 0;
        this.zOrder = [];
        Logger.log(LogCategory.SYSTEM, 'WindowManager reset');
    }
}
