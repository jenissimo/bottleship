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
import { windows as sharedWindows } from "../../modules/user32/shared-state";

const WM_SIZE = 0x0005;
const SIZE_RESTORED = 0;

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

    // The app updates its viewport/projection from this, exactly as it does for a real
    // fullscreen switch.
    system.windowManager?.postMessage(hwnd, WM_SIZE, SIZE_RESTORED,
        ((width & 0xFFFF) | ((height & 0xFFFF) << 16)) >>> 0);
    Logger.log(LogCategory.SYSTEM,
        `${source}: fullscreen window resize hwnd=0x${hwnd.toString(16)} -> ${width}x${height}`);
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
 * Null when neither window map knows the handle: inventing an extent for a window we never
 * tracked would be a guess, and the caller's own fallback is at least visible.
 */
export function deviceWindowClientExtent(hwnd: number): { width: number; height: number } | null {
    if (!hwnd) return null;
    const shared = sharedWindows.get(hwnd >>> 0);
    if (shared && shared.width > 0 && shared.height > 0) {
        return { width: shared.width | 0, height: shared.height | 0 };
    }
    const winObj = System.getInstance().windowManager?.getWindow(hwnd >>> 0);
    if (winObj && winObj.rect.w > 0 && winObj.rect.h > 0) {
        return { width: winObj.rect.w | 0, height: winObj.rect.h | 0 };
    }
    return null;
}
