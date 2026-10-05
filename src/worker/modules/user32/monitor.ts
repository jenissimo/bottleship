/**
 * The one monitor of the emulated machine: its HMONITOR, its DPI, and the
 * MonitorFrom* resolution rule every monitor-returning API shares.
 *
 * The desktop is a single display covering the virtual screen at 100% scaling, so the
 * monitor DPI, the system DPI and gdi32's LOGPIXELSX/Y are all USER_DEFAULT_SCREEN_DPI.
 * Every DPI answer in user32/shcore reads these constants rather than restating 96.
 */

import { getVirtualScreenRect } from './shared-state';

export const USER_DEFAULT_SCREEN_DPI = 96;
/** Effective DPI of the one monitor, and so the system DPI a system-aware process sees. */
export const MONITOR_DPI = USER_DEFAULT_SCREEN_DPI;
export const SYSTEM_DPI = MONITOR_DPI;

/** HMONITOR of the primary (and only) monitor, as EnumDisplayMonitors reports it. */
export const PRIMARY_HMONITOR = 1;

export const MONITOR_DEFAULTTONULL = 0x00000000;
export const MONITOR_DEFAULTTOPRIMARY = 0x00000001;
export const MONITOR_DEFAULTTONEAREST = 0x00000002;

export function isMonitorHandle(hMonitor: number): boolean {
    return (hMonitor >>> 0) === PRIMARY_HMONITOR;
}

/**
 * MonitorFromRect: the monitor the rect intersects; failing that, the primary (or the
 * nearest — with one monitor, the same one) unless the caller asked for NULL. An empty
 * rect is treated as its 1x1 top-left point.
 */
export function monitorFromRect(left: number, top: number, right: number, bottom: number, flags: number): number {
    if (right <= left || bottom <= top) {
        right = left + 1;
        bottom = top + 1;
    }
    const screen = getVirtualScreenRect();
    const intersects = left < screen.right && right > screen.left && top < screen.bottom && bottom > screen.top;
    return intersects ? PRIMARY_HMONITOR : monitorFallback(flags);
}

/** What MonitorFrom* answers when nothing intersects (or there is no rect to test). */
export function monitorFallback(flags: number): number {
    return (flags & (MONITOR_DEFAULTTOPRIMARY | MONITOR_DEFAULTTONEAREST)) !== 0 ? PRIMARY_HMONITOR : 0;
}

/** Windows MulDiv: a*b/c rounded half away from zero. */
export function mulDiv(a: number, b: number, c: number): number {
    const product = a * b;
    const q = Math.floor((Math.abs(product) + Math.floor(c / 2)) / c);
    return product < 0 ? -q : q;
}

/** Scale a 96-DPI metric to `dpi` (0 means the system DPI), as win32u map_to_dpi. */
export function mapToDpi(value: number, dpi: number): number {
    return mulDiv(value, dpi || SYSTEM_DPI, USER_DEFAULT_SCREEN_DPI);
}
