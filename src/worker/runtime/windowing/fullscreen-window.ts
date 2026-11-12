/**
 * A fullscreen mode-set resizes the window it owns — one implementation for every API
 * that can perform one (DirectDraw SetDisplayMode, D3D8/D3D9 CreateDevice and Reset).
 *
 * Faithful to real Windows: taking a window fullscreen puts its CLIENT area at the mode's
 * resolution and the app is then entitled to read that back. Engines do exactly that —
 * GTA III's RenderWare camera raster refuses a camera larger than GetClientRect(hwnd), so
 * a device created (or Reset) at a resolution the tracked window never learned about makes
 * RwCameraCreate return NULL, and the game's next rsCAMERASIZE dereferences it.
 *
 * The window rect lives in TWO places — WindowManager's WindowObject (hit-testing, Z-order)
 * and user32's WindowInfo (what GetClientRect/GetWindowRect answer) — so both move here, in
 * one place, rather than in one API's module and not another's.
 */

import { System } from "../../core/system";
import { Logger, LogCategory } from "../../core/logger";
import { Mem } from "../../core/memory/mem-accessor";
import { isValidAddress } from "../../core/memory/address-guard";
import { getAbsoluteWindowPosition, windows as sharedWindows } from "../../modules/user32/shared-state";
import { activateTopLevelWindow } from "../../modules/user32/activation-messages";

const WM_SIZE = 0x0005;
const WM_SHOWWINDOW = 0x0018;
const SIZE_RESTORED = 0;
const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;
const HWND_TOP = 0;

/**
 * Put `hwnd`'s client area at `width`x`height` and tell the guest about it.
 *
 * No-op for a window neither map knows — a mode-set for a window we never tracked has
 * nothing to resize, and posting WM_SIZE at it would invent a message no window can handle.
 * `source` names the caller in the log so the three mode-set paths stay distinguishable.
 */
export function resizeFullscreenWindowToMode(
    hwnd: number,
    width: number,
    height: number,
    source: string,
): void {
    if (!hwnd || width <= 0 || height <= 0) return;
    const system = System.getInstance();

    const winObj = system.windowManager?.getWindow(hwnd);
    if (winObj) {
        winObj.rect.x = 0;
        winObj.rect.y = 0;
        winObj.rect.w = width;
        winObj.rect.h = height;
    }

    const sharedWin = sharedWindows.get(hwnd);
    if (sharedWin) {
        sharedWin.x = 0;
        sharedWin.y = 0;
        sharedWin.width = width;
        sharedWin.height = height;
    }

    if (!winObj && !sharedWin) return;

    showFullscreenWindow(hwnd, source);

    // The app updates its viewport/projection from this, exactly as it does for a real
    // fullscreen switch.
    system.windowManager?.postMessage(hwnd, WM_SIZE, SIZE_RESTORED,
        ((width & 0xFFFF) | ((height & 0xFFFF) << 16)) >>> 0);
    Logger.log(LogCategory.SYSTEM,
        `${source}: fullscreen window resize hwnd=0x${hwnd.toString(16)} -> ${width}x${height}`);
}

/**
 * The client size of a device window as tracked right now, either dimension possibly zero,
 * or null when neither window map knows the handle.
 */
export function deviceWindowClientSize(hwnd: number): { width: number; height: number } | null {
    if (!hwnd) return null;
    const shared = sharedWindows.get(hwnd >>> 0);
    const winObj = System.getInstance().windowManager?.getWindow(hwnd >>> 0);
    if (shared && shared.width > 0 && shared.height > 0) {
        return { width: shared.width | 0, height: shared.height | 0 };
    }
    if (winObj && winObj.rect.w > 0 && winObj.rect.h > 0) {
        return { width: winObj.rect.w | 0, height: winObj.rect.h | 0 };
    }
    if (shared) return { width: Math.max(0, shared.width | 0), height: Math.max(0, shared.height | 0) };
    if (winObj) return { width: Math.max(0, winObj.rect.w | 0), height: Math.max(0, winObj.rect.h | 0) };
    return null;
}

/**
 * The CLIENT extent a device window gives a WINDOWED device whose present parameters
 * declare a zero back-buffer size.
 *
 * Zero is not "no size" in D3D9: it is legal only for a windowed device, and the runtime
 * fills BackBufferWidth/Height from the client area of the device window (else the focus
 * window) and writes the values back into the caller's struct. Reading zero as "the app
 * declared nothing" leaves the GUEST space undefined for the entire windowed regime, and
 * everything derived from it — the viewport, the XYZRHW divisor, the pointer inverse —
 * then falls back to the host canvas, which is two coordinate spaces conflated again.
 *
 * Null when neither window map knows the handle, and when the window is known but its
 * client area is empty in either dimension (deviceWindowClientSize tells the two apart).
 */
export function deviceWindowClientExtent(hwnd: number): { width: number; height: number } | null {
    const size = deviceWindowClientSize(hwnd);
    return size && size.width > 0 && size.height > 0 ? size : null;
}

/** What a zero back-buffer dimension becomes when the device window's client area is empty too. */
export const EMPTY_CLIENT_BACK_BUFFER_EXTENT = 8;

/**
 * The back-buffer extent a windowed device's present parameters declare, with a zero
 * dimension resolved from the device window's client area and written BACK into the
 * caller's struct (BackBufferWidth @ +0, BackBufferHeight @ +4 in both D3D8 and D3D9).
 *
 * wined3d does this for both generations (wined3d_swapchain_state_init at creation,
 * wined3d_swapchain_resize_buffers on Reset) and uses 8 for a dimension whose client size
 * is zero as well: a window that exists but has not been sized yet. A window nobody
 * tracks is a different case and is left alone, so the caller's own fallback stays
 * visible instead of an invented extent.
 *
 * A fullscreen device with a zero extent is malformed; it is left for the parameter
 * validator to refuse.
 */
export function resolveWindowedBackBufferExtent(
    mem: Uint8Array,
    pPresentationParameters: number,
    hwnd: number,
    fullscreen: boolean,
    source: string,
    category: LogCategory,
): { width: number; height: number } {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let width = view.getUint32(pPresentationParameters + 0, true) >>> 0;
    let height = view.getUint32(pPresentationParameters + 4, true) >>> 0;
    if (fullscreen || (width > 0 && height > 0)) return { width, height };

    const client = deviceWindowClientSize(hwnd);
    if (!client) {
        Logger.warn(category,
            `${source}: windowed device declares a ${width}x${height} back buffer and window `
            + `0x${hwnd.toString(16)} is not tracked — the guest render space stays undeclared`);
        return { width, height };
    }
    const empty = client.width <= 0 || client.height <= 0;
    width = width || client.width || EMPTY_CLIENT_BACK_BUFFER_EXTENT;
    height = height || client.height || EMPTY_CLIENT_BACK_BUFFER_EXTENT;
    // The runtime writes the resolved values back; an app is entitled to read them.
    if (isValidAddress(mem, pPresentationParameters, 8, "rw")) {
        Mem.writeUint32(pPresentationParameters + 0, width);
        Mem.writeUint32(pPresentationParameters + 4, height);
    }
    Logger.log(category,
        `${source}: windowed zero back buffer resolved to the client area of `
        + `hwnd=0x${hwnd.toString(16)} (${client.width}x${client.height}${empty ? ", empty" : ""}) -> ${width}x${height}`);
    return { width, height };
}

/**
 * A WINDOWED device's back buffer is shown where its device window's client area is: the
 * host view gets the back-buffer size at that window's screen origin, so the pointer,
 * which is reported as a screen position, lands on the picture. A fullscreen device is a
 * mode set and goes through System.requestHostResize instead.
 */
export function requestWindowedDeviceHostView(hwnd: number, width: number, height: number): void {
    const win = hwnd ? sharedWindows.get(hwnd >>> 0) : undefined;
    const origin = win ? getAbsoluteWindowPosition(win) : null;
    System.getInstance().requestHostViewAt(origin?.x ?? 0, origin?.y ?? 0, width, height);
}

/**
 * A fullscreen mode-set also SHOWS the window it takes over.
 *
 * The runtime does this itself — an app is entitled to create its window without
 * WS_VISIBLE, never call ShowWindow, and go straight to a fullscreen device; the
 * mode-set is what puts the window on screen, activates it and brings it to the
 * front (wined3d's setup_fullscreen_window does exactly this via SetWindowPos with
 * SWP_SHOWWINDOW). The Bard's Tale does precisely that.
 *
 * Leaving it hidden is not cosmetic: an invisible window cannot be the target of
 * WindowFromPoint, so mouse routing finds nothing and every click is dropped while
 * the game renders normally — dead input with a perfectly live frame.
 *
 * Visibility lives in the same two maps the rect does, and user32 owns the
 * authoritative copy, so both are written here rather than in one API's module.
 */
function showFullscreenWindow(hwnd: number, source: string): void {
    const system = System.getInstance();
    const sharedWin = sharedWindows.get(hwnd);
    const winObj = system.windowManager?.getWindow(hwnd);

    const alreadyVisible = sharedWin ? sharedWin.visible : winObj?.visible;
    if (alreadyVisible) return;

    // A child window is never the fullscreen target; showing one here would be inventing
    // a state change no mode-set performs.
    const style = sharedWin?.style ?? winObj?.style ?? 0;
    if ((style & WS_CHILD) !== 0) return;

    if (sharedWin) {
        sharedWin.visible = true;
        sharedWin.style |= WS_VISIBLE;
    }
    if (winObj) {
        winObj.visible = true;
        winObj.style |= WS_VISIBLE;
    }

    system.windowManager?.setWindowZOrder(hwnd, HWND_TOP);
    activateTopLevelWindow(hwnd);

    // A mode-set brings the device window up through ShowWindow, and ShowWindow is what
    // sends WM_SHOWWINDOW(TRUE) on a hidden->visible transition (SetWindowPos's
    // SWP_SHOWWINDOW does not — see tools/tests/setwindowpos-showwindow.test.ts). Apps hang
    // real work off it: HL's launcher loads the menu's background DIB and button strip in
    // OnShowWindow(bShow=TRUE), and without the message the menu paints on bare black.
    system.windowManager?.postMessage(hwnd, WM_SHOWWINDOW, 1, 0);

    Logger.log(LogCategory.SYSTEM,
        `${source}: fullscreen mode-set shows hwnd=0x${hwnd.toString(16)}`);
}
