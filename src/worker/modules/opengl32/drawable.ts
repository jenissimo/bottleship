/**
 * The GL drawable — the extent of the default framebuffer.
 *
 * It is the CLIENT area of the window the WGL context's DC was obtained for, in GUEST
 * pixels, exactly like a DDraw primary or the window plane. glViewport only maps NDC onto a
 * rectangle inside it, so a sub-rect viewport must not shrink it; and the host canvas is the
 * PRESENT TARGET, a different space — a drawable sized from the canvas leaves a guest that
 * viewports its own mode drawing into a corner of it.
 */

import { System } from "../../core/system";
import { getVirtualScreenRect, windows } from "../user32/shared-state";

export function guestDrawableSize(drawableDC: number): { width: number; height: number } {
    const hwnd = drawableDC ? System.getInstance().gdiContext.getDCWindow(drawableDC) >>> 0 : 0;
    const win = hwnd ? windows.get(hwnd) : undefined;
    // WindowInfo.width/height IS the client size (what GetClientRect answers with).
    if (win && win.width > 0 && win.height > 0) return { width: win.width, height: win.height };
    // A DC that names no window (a memory DC, or none current yet) draws to the desktop.
    const r = getVirtualScreenRect();
    return {
        width: Math.max(1, Math.round(r.right - r.left)),
        height: Math.max(1, Math.round(r.bottom - r.top)),
    };
}
