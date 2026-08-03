/**
 * User32 window geometry / placement handlers: rect/coordinate queries
 * (GetClientRect, GetWindowRect, ClientToScreen, MapWindowPoints), frame-metric
 * math (AdjustWindowRect/Ex, GetWindowInfo) and the WINDOWPLACEMENT store.
 * Z-order / focus / capture / SetWindowPos core stays in window.ts.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { WindowInfo, windows, getAbsoluteWindowPosition } from './shared-state';
import { invalidateWindow } from './paint-region';
import { repaintDialogOverlayIfVisible } from './dialog-paint';

/** Callbacks back into window.ts (avoids an import cycle). */
export interface WindowGeometryHost {
    /** Repaint dialog overlay when a system child (static/logo) moves or resizes. */
    repaintParentDialogIfSystemControlGeometryChanged(
        window: WindowInfo,
        moved: boolean,
        resized: boolean,
    ): void;
    applyWindowPlacement(
        ctx: any,
        mem: Uint8Array,
        hWnd: number,
        showCmd: number,
        normalRect: { left: number; top: number; right: number; bottom: number } | null,
    ): any;
}

const WM_PAINT = 0x000F;

const SIZEOF_WINDOWPLACEMENT = 44;
const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const SW_SHOW = 5;
const SW_RESTORE = 9;

interface StoredWindowPlacement {
    flags: number;
    showCmd: number;
    ptMinX: number;
    ptMinY: number;
    ptMaxX: number;
    ptMaxY: number;
    normalLeft: number;
    normalTop: number;
    normalRight: number;
    normalBottom: number;
}
const windowPlacements = new Map<number, StoredWindowPlacement>();

/** Drop a window's stored placement (called from window.ts finalizeDestroy). */
export function removeWindowPlacement(hWnd: number): void {
    windowPlacements.delete(hWnd);
}

function writeInt32(address: number, value: number): boolean {
    return Mem.writeUint32(address, value >>> 0);
}

function writeRect(address: number, left: number, top: number, right: number, bottom: number): boolean {
    return (
        writeInt32(address + 0, left) &&
        writeInt32(address + 4, top) &&
        writeInt32(address + 8, right) &&
        writeInt32(address + 12, bottom)
    );
}

function adjustWindowRectCore(mem: Uint8Array, lpRect: number, dwStyle: number, bMenu: number, dwExStyle: number): number {
    if (!lpRect || lpRect + 16 > mem.length) return 0;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const left = view.getInt32(lpRect, true);
    const top = view.getInt32(lpRect + 4, true);
    const right = view.getInt32(lpRect + 8, true);
    const bottom = view.getInt32(lpRect + 12, true);

    const WS_POPUP = 0x80000000;
    const WS_CAPTION = 0x00C00000;
    const WS_THICKFRAME = 0x00040000;
    const WS_BORDER = 0x00800000;

    const WS_EX_DLGMODALFRAME = 0x00000001;
    const WS_EX_WINDOWEDGE = 0x00000100;
    const WS_EX_CLIENTEDGE = 0x00000200;
    const WS_EX_STATICEDGE = 0x00020000;

    const hasExEdge = (dwExStyle & (WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE)) !== 0;
    if ((dwStyle & WS_POPUP) !== 0 && !hasExEdge) {
        // Borderless popup: no adjustment.
        return 1;
    }

    const borderWidth = (dwStyle & WS_THICKFRAME) ? 4 : ((dwStyle & WS_BORDER) ? 1 : 0);
    const captionHeight = (dwStyle & WS_CAPTION) ? 23 : 0;
    const menuHeight = bMenu ? 19 : 0;
    const exBorder =
        ((dwExStyle & WS_EX_CLIENTEDGE) ? 2 : 0) +
        ((dwExStyle & WS_EX_WINDOWEDGE) ? 1 : 0) +
        ((dwExStyle & WS_EX_DLGMODALFRAME) ? 1 : 0) +
        ((dwExStyle & WS_EX_STATICEDGE) ? 1 : 0);

    const padTop = captionHeight + menuHeight + exBorder;
    const padSide = borderWidth + exBorder;
    const padBottom = borderWidth + exBorder;

    view.setInt32(lpRect, left - padSide, true);
    view.setInt32(lpRect + 4, top - padTop, true);
    view.setInt32(lpRect + 8, right + padSide, true);
    view.setInt32(lpRect + 12, bottom + padBottom, true);
    return 1;
}

function getWindowFrameMetrics(dwStyle: number, dwExStyle: number, hasMenu: boolean): {
    padTop: number;
    padSide: number;
    padBottom: number;
    borderX: number;
    borderY: number;
} {
    const WS_POPUP_STYLE = 0x80000000;
    const WS_CAPTION_STYLE = 0x00C00000;
    const WS_THICKFRAME_STYLE = 0x00040000;
    const WS_BORDER_STYLE = 0x00800000;

    const WS_EX_DLGMODALFRAME = 0x00000001;
    const WS_EX_WINDOWEDGE = 0x00000100;
    const WS_EX_CLIENTEDGE = 0x00000200;
    const WS_EX_STATICEDGE = 0x00020000;

    const hasExEdge = (dwExStyle & (WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE)) !== 0;
    if ((dwStyle & WS_POPUP_STYLE) !== 0 && !hasExEdge) {
        return { padTop: 0, padSide: 0, padBottom: 0, borderX: 0, borderY: 0 };
    }

    const borderWidth = (dwStyle & WS_THICKFRAME_STYLE) ? 4 : ((dwStyle & WS_BORDER_STYLE) ? 1 : 0);
    const captionHeight = (dwStyle & WS_CAPTION_STYLE) ? 23 : 0;
    const menuHeight = hasMenu ? 19 : 0;
    const exBorder =
        ((dwExStyle & WS_EX_CLIENTEDGE) ? 2 : 0) +
        ((dwExStyle & WS_EX_WINDOWEDGE) ? 1 : 0) +
        ((dwExStyle & WS_EX_DLGMODALFRAME) ? 1 : 0) +
        ((dwExStyle & WS_EX_STATICEDGE) ? 1 : 0);

    const padTop = captionHeight + menuHeight + exBorder;
    const padSide = borderWidth + exBorder;
    const padBottom = borderWidth + exBorder;

    return {
        padTop,
        padSide,
        padBottom,
        borderX: padSide,
        borderY: borderWidth + exBorder,
    };
}

function getWindowScreenOrigin(window: WindowInfo): { x: number; y: number } {
    const WS_CHILD_STYLE = 0x40000000;

    let x = window.x;
    let y = window.y;
    let current: WindowInfo | undefined = window;

    while (current?.parent && ((current.style >>> 0) & WS_CHILD_STYLE) !== 0) {
        const parent = windows.get(current.parent);
        if (!parent) break;
        x += parent.x;
        y += parent.y;
        current = parent;
    }

    return { x, y };
}

function getWindowOuterRectScreen(window: WindowInfo): {
    left: number;
    top: number;
    right: number;
    bottom: number;
} {
    const style = window.style >>> 0;
    const exStyle = (window.exStyle ?? 0) >>> 0;
    const { x: clientLeft, y: clientTop } = getWindowScreenOrigin(window);
    const clientRight = clientLeft + window.width;
    const clientBottom = clientTop + window.height;
    const hasMenu = ((style & 0x40000000) === 0) && !!window.hMenu;
    const frame = getWindowFrameMetrics(style, exStyle, hasMenu);
    return {
        left: clientLeft - frame.padSide,
        top: clientTop - frame.padTop,
        right: clientRight + frame.padSide,
        bottom: clientBottom + frame.padBottom,
    };
}

function writeWindowPlacement(
    lpwndpl: number,
    length: number,
    flags: number,
    showCmd: number,
    ptMinX: number,
    ptMinY: number,
    ptMaxX: number,
    ptMaxY: number,
    normalLeft: number,
    normalTop: number,
    normalRight: number,
    normalBottom: number,
): boolean {
    return (
        Mem.writeUint32(lpwndpl + 0, length) &&
        Mem.writeUint32(lpwndpl + 4, flags >>> 0) &&
        Mem.writeUint32(lpwndpl + 8, showCmd >>> 0) &&
        Mem.writeUint32(lpwndpl + 12, ptMinX >>> 0) &&
        Mem.writeUint32(lpwndpl + 16, ptMinY >>> 0) &&
        Mem.writeUint32(lpwndpl + 20, ptMaxX >>> 0) &&
        Mem.writeUint32(lpwndpl + 24, ptMaxY >>> 0) &&
        writeRect(lpwndpl + 28, normalLeft, normalTop, normalRight, normalBottom)
    );
}

export function registerWindowGeometryExports(
    exports: Record<string, ThunkImplementation>,
    host: WindowGeometryHost,
): void {
    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_INVALID_WINDOW_HANDLE = 1400;

    function applyOuterRectScreenToWindow(
        hWnd: number,
        window: WindowInfo,
        outerLeft: number,
        outerTop: number,
        outerRight: number,
        outerBottom: number,
        bRepaint: boolean,
    ): void {
        const style = window.style >>> 0;
        const exStyle = (window.exStyle ?? 0) >>> 0;
        const hasMenu = ((style & 0x40000000) === 0) && !!window.hMenu;
        const frame = getWindowFrameMetrics(style, exStyle, hasMenu);
        const clientW = Math.max(1, (outerRight - outerLeft) - frame.padSide * 2);
        const clientH = Math.max(1, (outerBottom - outerTop) - frame.padTop - frame.padBottom);
        const clientScreenX = outerLeft + frame.padSide;
        const clientScreenY = outerTop + frame.padTop;

        const oldOrigin = getWindowScreenOrigin(window);
        const moving = clientScreenX !== oldOrigin.x || clientScreenY !== oldOrigin.y;
        const resizing = clientW !== window.width || clientH !== window.height;

        const WS_CHILD = 0x40000000;
        if ((style & WS_CHILD) !== 0 && window.parent) {
            const parentOrigin = getWindowScreenOrigin(windows.get(window.parent)!);
            window.x = clientScreenX - parentOrigin.x;
            window.y = clientScreenY - parentOrigin.y;
        } else {
            window.x = clientScreenX;
            window.y = clientScreenY;
        }
        window.width = clientW;
        window.height = clientH;

        const wmWin = System.getInstance().windowManager.getWindow(hWnd);
        if (wmWin) {
            wmWin.rect.x = window.x;
            wmWin.rect.y = window.y;
            wmWin.rect.w = window.width;
            wmWin.rect.h = window.height;
        }

        if (bRepaint && window.visible) {
            invalidateWindow(hWnd, null, true);
            System.getInstance().windowManager.postMessage(hWnd, WM_PAINT, 0, 0);
        }

        if (moving || resizing) {
            host.repaintParentDialogIfSystemControlGeometryChanged(window, moving, resizing);
            if (window.visible && window.nativeClassName === '#32770') {
                repaintDialogOverlayIfVisible(hWnd);
            }
        }
    }

    exports['GetClientRect'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpRect = args[1];

        Logger.verbose(LogCategory.USER32, `GetClientRect(0x${hWnd.toString(16)}, 0x${lpRect.toString(16)})`);

        if (lpRect) {
            const window = windows.get(hWnd);
            if (window) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setInt32(lpRect, 0, true);      // left
                view.setInt32(lpRect + 4, 0, true);  // top
                view.setInt32(lpRect + 8, window.width, true);  // right
                view.setInt32(lpRect + 12, window.height, true); // bottom
                Logger.verbose(LogCategory.USER32, `GetClientRect(0x${hWnd.toString(16)}) -> (0, 0, ${window.width}, ${window.height})`);

                return 1; // TRUE
            }
        }

        return 0; // FALSE
    };

    exports['GetWindowRect'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpRect = args[1];

        Logger.verbose(LogCategory.USER32, `GetWindowRect(0x${hWnd.toString(16)}, 0x${lpRect.toString(16)})`);

        if (lpRect) {

            const window = windows.get(hWnd);
            if (window) {
                // GetWindowRect returns SCREEN coordinates (Win32 contract). For a child
                // window, window.x/y are parent-client-relative, so walk the parent chain
                // to the screen origin. Returning the raw local coords here makes the
                // common GetWindowRect → ScreenToClient → MoveWindow re-centering idiom
                // subtract the parent offset twice, shifting child controls off-position.
                const { x: absX, y: absY } = getAbsoluteWindowPosition(window);
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setInt32(lpRect, absX, true);                    // left
                view.setInt32(lpRect + 4, absY, true);                // top
                view.setInt32(lpRect + 8, absX + window.width, true);  // right
                view.setInt32(lpRect + 12, absY + window.height, true); // bottom

                return 1; // TRUE
            }
        }

        return 0; // FALSE
    };

    exports['GetWindowInfo'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const pwi = args[1] >>> 0;
        const system = System.getInstance();

        Logger.verbose(LogCategory.USER32, `GetWindowInfo(0x${hWnd.toString(16)}, 0x${pwi.toString(16)})`);

        if (!pwi) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const cbSize = Mem.readUint32(pwi);
        if (cbSize === null || cbSize < 60) {
            Logger.verbose(
                LogCategory.USER32,
                `GetWindowInfo: invalid WINDOWINFO.cbSize=${cbSize ?? 'null'} for hwnd=0x${hWnd.toString(16)}`,
            );
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const window = windows.get(hWnd);
        if (!window) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const style = window.style >>> 0;
        const exStyle = (window.exStyle ?? 0) >>> 0;
        const { x: clientLeft, y: clientTop } = getWindowScreenOrigin(window);
        const clientRight = clientLeft + window.width;
        const clientBottom = clientTop + window.height;
        const hasMenu = ((style & 0x40000000) === 0) && !!window.hMenu;
        const frame = getWindowFrameMetrics(style, exStyle, hasMenu);
        const windowLeft = clientLeft - frame.padSide;
        const windowTop = clientTop - frame.padTop;
        const windowRight = clientRight + frame.padSide;
        const windowBottom = clientBottom + frame.padBottom;
        const activeHwnd = System.getInstance().windowManager.getActiveHwnd() >>> 0;
        const dwWindowStatus = activeHwnd === hWnd ? 0x0001 : 0;

        const ok = (
            Mem.writeUint32(pwi + 0, cbSize) &&
            writeRect(pwi + 4, windowLeft, windowTop, windowRight, windowBottom) &&
            writeRect(pwi + 20, clientLeft, clientTop, clientRight, clientBottom) &&
            Mem.writeUint32(pwi + 36, style) &&
            Mem.writeUint32(pwi + 40, exStyle) &&
            Mem.writeUint32(pwi + 44, dwWindowStatus) &&
            Mem.writeUint32(pwi + 48, frame.borderX >>> 0) &&
            Mem.writeUint32(pwi + 52, frame.borderY >>> 0) &&
            Mem.writeUint16(pwi + 56, (window.classId ?? 0) & 0xFFFF) &&
            Mem.writeUint16(pwi + 58, 0)
        );
        system.scheduler.setLastError(ok ? 0 : ERROR_INVALID_PARAMETER);
        return ok ? 1 : 0;
    };

    exports['GetWindowPlacement'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const lpwndpl = args[1] >>> 0;
        const system = System.getInstance();

        Logger.verbose(LogCategory.USER32, `GetWindowPlacement(0x${hWnd.toString(16)}, 0x${lpwndpl.toString(16)})`);

        if (!lpwndpl) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const length = Mem.readUint32(lpwndpl);
        if (length === null || length < SIZEOF_WINDOWPLACEMENT) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const window = windows.get(hWnd);
        if (!window) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const stored = windowPlacements.get(hWnd);
        const outer = stored
            ? {
                left: stored.normalLeft,
                top: stored.normalTop,
                right: stored.normalRight,
                bottom: stored.normalBottom,
            }
            : getWindowOuterRectScreen(window);

        const showCmd = stored?.showCmd ?? (window.visible ? SW_SHOWNORMAL : SW_HIDE);
        const flags = stored?.flags ?? 0;
        const ptMinX = stored?.ptMinX ?? -1;
        const ptMinY = stored?.ptMinY ?? -1;
        const ptMaxX = stored?.ptMaxX ?? -1;
        const ptMaxY = stored?.ptMaxY ?? -1;

        const ok = writeWindowPlacement(
            lpwndpl,
            SIZEOF_WINDOWPLACEMENT,
            flags,
            showCmd,
            ptMinX,
            ptMinY,
            ptMaxX,
            ptMaxY,
            outer.left,
            outer.top,
            outer.right,
            outer.bottom,
        );
        system.scheduler.setLastError(ok ? 0 : ERROR_INVALID_PARAMETER);
        return ok ? 1 : 0;
    };

    exports['SetWindowPlacement'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const lpwndpl = args[1] >>> 0;
        const system = System.getInstance();

        Logger.verbose(LogCategory.USER32, `SetWindowPlacement(0x${hWnd.toString(16)}, 0x${lpwndpl.toString(16)})`);

        if (!lpwndpl) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const length = Mem.readUint32(lpwndpl);
        if (length === null || length < SIZEOF_WINDOWPLACEMENT) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const window = windows.get(hWnd);
        if (!window) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const flags = Mem.readUint32(lpwndpl + 4) ?? 0;
        const showCmd = Mem.readUint32(lpwndpl + 8) ?? SW_SHOWNORMAL;
        const ptMinX = Mem.readInt32(lpwndpl + 12) ?? -1;
        const ptMinY = Mem.readInt32(lpwndpl + 16) ?? -1;
        const ptMaxX = Mem.readInt32(lpwndpl + 20) ?? -1;
        const ptMaxY = Mem.readInt32(lpwndpl + 24) ?? -1;
        const normalLeft = Mem.readInt32(lpwndpl + 28);
        const normalTop = Mem.readInt32(lpwndpl + 32);
        const normalRight = Mem.readInt32(lpwndpl + 36);
        const normalBottom = Mem.readInt32(lpwndpl + 40);
        if (normalLeft === null || normalTop === null || normalRight === null || normalBottom === null) {
            system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        windowPlacements.set(hWnd, {
            flags,
            showCmd,
            ptMinX,
            ptMinY,
            ptMaxX,
            ptMaxY,
            normalLeft,
            normalTop,
            normalRight,
            normalBottom,
        });

        const applyNormalPosition =
            showCmd === SW_SHOWNORMAL ||
            showCmd === SW_RESTORE ||
            showCmd === SW_SHOW;

        return host.applyWindowPlacement(
            ctx,
            mem,
            hWnd,
            showCmd,
            applyNormalPosition
                ? { left: normalLeft, top: normalTop, right: normalRight, bottom: normalBottom }
                : null,
        );
    };

    exports['ClientToScreen'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpPoint = args[1];

        Logger.verbose(LogCategory.USER32, `ClientToScreen(0x${hWnd.toString(16)}, 0x${lpPoint.toString(16)})`);

        const hasPoint = !!lpPoint && (lpPoint + 8 <= mem.length);
        let inX = 0;
        let inY = 0;
        if (hasPoint) {
            const inView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            inX = inView.getInt32(lpPoint, true);
            inY = inView.getInt32(lpPoint + 4, true);
        }

        const window = windows.get(hWnd);
        if (!window || !hasPoint) {
            return 0;
        }

        // Wine get_windows_offset: the client→screen offset accumulates EVERY ancestor's
        // client origin, not just the window's own (parent-relative) x/y. Using the raw
        // x/y drops the offset of every grandparent, so a nested control's own x/y of
        // (0,0) mapped "to screen" stays (0,0) — and the standard
        // ClientToScreen/ScreenToClient → SetWindowPos re-positioning idiom then places
        // the window off by the grandparent chain's origin. GetWindowRect and
        // MapWindowPoints already walk the chain; these two must agree with them.
        const origin = getAbsoluteWindowPosition(window);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const ox = origin.x + inX;
        const oy = origin.y + inY;
        view.setInt32(lpPoint, ox, true);
        view.setInt32(lpPoint + 4, oy, true);
        Logger.verbose(LogCategory.USER32, `ClientToScreen(0x${hWnd.toString(16)}) (${inX},${inY}) + origin(${origin.x},${origin.y}) -> (${ox},${oy})`);
        return 1;
    };

    exports['ScreenToClient'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpPoint = args[1];
        const hasPoint = !!lpPoint && (lpPoint + 8 <= mem.length);
        if (!hasPoint) {
            return 0;
        }
        const win = windows.get(hWnd);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const sx = view.getInt32(lpPoint, true);
        const sy = view.getInt32(lpPoint + 4, true);
        if (!win) {
            return 0;
        }
        // Same full-ancestor-chain origin as ClientToScreen (Wine get_windows_offset).
        const origin = getAbsoluteWindowPosition(win);
        const ox = sx - origin.x;
        const oy = sy - origin.y;
        view.setInt32(lpPoint, ox, true);
        view.setInt32(lpPoint + 4, oy, true);
        Logger.verbose(LogCategory.USER32,
            `ScreenToClient(0x${hWnd.toString(16)}) (${sx},${sy}) - origin(${origin.x},${origin.y}) -> (${ox},${oy})`);
        return 1;
    };

    exports['AdjustWindowRect'] = (ctx, mem, args) => {
        const lpRect = args[0];
        const dwStyle = args[1];
        const bMenu = args[2];

        Logger.verbose(LogCategory.USER32, `AdjustWindowRect(0x${lpRect.toString(16)}, 0x${dwStyle.toString(16)}, ${bMenu})`);
        return adjustWindowRectCore(mem, lpRect, dwStyle, bMenu, 0);
    };

    exports['AdjustWindowRectEx'] = (ctx, mem, args) => {
        const lpRect = args[0];
        const dwStyle = args[1];
        const bMenu = args[2];
        const dwExStyle = args[3];

        Logger.verbose(
            LogCategory.USER32,
            `AdjustWindowRectEx(0x${lpRect.toString(16)}, 0x${dwStyle.toString(16)}, ${bMenu}, 0x${dwExStyle.toString(16)})`
        );
        return adjustWindowRectCore(mem, lpRect, dwStyle, bMenu, dwExStyle);
    };

    exports['MapWindowPoints'] = (ctx, mem, args) => {
        const hWndFrom = args[0];
        const hWndTo = args[1];
        const lpPoints = args[2];
        const cPoints = args[3];
        Logger.verbose(LogCategory.USER32, `MapWindowPoints(0x${hWndFrom.toString(16)}, 0x${hWndTo.toString(16)}, 0x${lpPoints.toString(16)}, ${cPoints})`);

        if (!lpPoints || cPoints <= 0 || lpPoints + cPoints * 8 > mem.length) return 0;

        const fromWin = hWndFrom ? windows.get(hWndFrom) : undefined;
        const toWin = hWndTo ? windows.get(hWndTo) : undefined;
        const fromAbs = fromWin ? getAbsoluteWindowPosition(fromWin) : { x: 0, y: 0 };
        const toAbs = toWin ? getAbsoluteWindowPosition(toWin) : { x: 0, y: 0 };
        const dx = fromAbs.x - toAbs.x;
        const dy = fromAbs.y - toAbs.y;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < cPoints; i++) {
            const off = lpPoints + i * 8;
            const x = view.getInt32(off, true);
            const y = view.getInt32(off + 4, true);
            view.setInt32(off, x + dx, true);
            view.setInt32(off + 4, y + dy, true);
        }
        return 0;
    };
}
