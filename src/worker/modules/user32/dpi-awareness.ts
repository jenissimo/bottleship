/**
 * DPI awareness (Vista SetProcessDPIAware through the Win10 context APIs) and the
 * *ForDpi metric variants.
 *
 * A DPI_AWARENESS_CONTEXT is an opaque value. The documented pseudo-handles (-1..-5)
 * are accepted everywhere, but what Windows hands BACK is the encoded form — awareness
 * in bits 0-3, version in 4-7, DPI in 8-16, plus the GDISCALED and "inherited from the
 * process" flags — which is why an app compares contexts with AreDpiAwarenessContextsEqual
 * rather than ==. Process awareness is set-once: every later attempt fails with
 * ERROR_ACCESS_DENIED. A thread may override it with SetThreadDpiAwarenessContext.
 *
 * The machine has one 96-DPI monitor (monitor.ts), so every awareness level SEES 96:
 * awareness changes which rule answers, never the number.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { windows } from './shared-state';
import { DESKTOP_HWND } from '../../runtime/windowing/window-manager';
import { MONITOR_DPI, SYSTEM_DPI, USER_DEFAULT_SCREEN_DPI, isMonitorHandle, mapToDpi } from './monitor';
import { systemMetricForDpi } from './dpi-metrics';
import { adjustWindowRectCore } from './window-geometry';

export const DPI_AWARENESS_INVALID = -1;
export const DPI_AWARENESS_UNAWARE = 0;
export const DPI_AWARENESS_SYSTEM_AWARE = 1;
export const DPI_AWARENESS_PER_MONITOR_AWARE = 2;

const CONTEXT_FLAG_GDISCALED = 0x40000000;
const CONTEXT_FLAG_PROCESS = 0x80000000;
const CONTEXT_FLAG_VALID_MASK = (CONTEXT_FLAG_GDISCALED | CONTEXT_FLAG_PROCESS) >>> 0;

const makeContext = (awareness: number, version: number, dpi: number, flags: number): number =>
    (awareness | (version << 4) | (dpi << 8) | flags) >>> 0;
const contextAwareness = (ctx: number): number => ctx & 0x0f;
const contextVersion = (ctx: number): number => (ctx & 0xf0) >>> 4;
const contextDpi = (ctx: number): number => (ctx & 0x1ff00) >>> 8;
const contextFlags = (ctx: number): number => (ctx & 0xfffe0000) >>> 0;

export const CONTEXT_UNAWARE = makeContext(DPI_AWARENESS_UNAWARE, 1, USER_DEFAULT_SCREEN_DPI, 0);
export const CONTEXT_SYSTEM_AWARE = makeContext(DPI_AWARENESS_SYSTEM_AWARE, 1, SYSTEM_DPI, 0);
export const CONTEXT_PER_MONITOR_AWARE = makeContext(DPI_AWARENESS_PER_MONITOR_AWARE, 1, 0, 0);
export const CONTEXT_PER_MONITOR_AWARE_V2 = makeContext(DPI_AWARENESS_PER_MONITOR_AWARE, 2, 0, 0);
export const CONTEXT_UNAWARE_GDISCALED =
    makeContext(DPI_AWARENESS_UNAWARE, 1, USER_DEFAULT_SCREEN_DPI, CONTEXT_FLAG_GDISCALED);

/** DPI_AWARENESS_CONTEXT_UNAWARE (-1) … DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED (-5). */
const PSEUDO_HANDLE_CONTEXTS: ReadonlyMap<number, number> = new Map([
    [0xffffffff, CONTEXT_UNAWARE],
    [0xfffffffe, CONTEXT_SYSTEM_AWARE],
    [0xfffffffd, CONTEXT_PER_MONITOR_AWARE],
    [0xfffffffc, CONTEXT_PER_MONITOR_AWARE_V2],
    [0xfffffffb, CONTEXT_UNAWARE_GDISCALED],
]);

/** A pseudo-handle maps to its encoding; anything else is taken as an encoding already. */
export function contextFromHandle(handle: number): number {
    const h = handle >>> 0;
    return PSEUDO_HANDLE_CONTEXTS.get(h) ?? h;
}

/** `dpi` = 0 accepts a system-aware context for any DPI (GetAwarenessFromDpiAwarenessContext). */
export function isValidContext(ctx: number, dpi: number): boolean {
    const flags = contextFlags(ctx);
    if ((flags & ~CONTEXT_FLAG_VALID_MASK) !== 0) return false;
    switch (contextAwareness(ctx)) {
        case DPI_AWARENESS_UNAWARE:
            return contextVersion(ctx) === 1 && contextDpi(ctx) === USER_DEFAULT_SCREEN_DPI;
        case DPI_AWARENESS_SYSTEM_AWARE:
            if (flags & CONTEXT_FLAG_GDISCALED) return false;
            if (contextVersion(ctx) !== 1) return false;
            return !dpi || contextDpi(ctx) === dpi;
        case DPI_AWARENESS_PER_MONITOR_AWARE:
            if (flags & CONTEXT_FLAG_GDISCALED) return false;
            if (contextVersion(ctx) !== 1 && contextVersion(ctx) !== 2) return false;
            return contextDpi(ctx) === 0;
        default:
            return false;
    }
}

/** 0 = never set: the process runs UNAWARE, and the first Set* still succeeds. */
let processContext = 0;
const threadContexts = new Map<number, number>();

export function resetDpiAwareness(): void {
    processContext = 0;
    threadContexts.clear();
}

const currentThreadId = (): number => System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
const setLastError = (code: number): void => { System.getInstance().scheduler?.setLastError(code); };

const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

export function getProcessDpiContext(): number {
    return processContext || CONTEXT_UNAWARE;
}

export function getThreadDpiContext(): number {
    return threadContexts.get(currentThreadId()) ?? getProcessDpiContext();
}

/** SetProcessDpiAwarenessContext's core. Returns the Win32 error, 0 on success. */
export function setProcessDpiContext(handle: number): number {
    const ctx = contextFromHandle(handle);
    if (!isValidContext(ctx, SYSTEM_DPI)) return ERROR_INVALID_PARAMETER;
    if (processContext !== 0) return ERROR_ACCESS_DENIED;
    processContext = (ctx & ~CONTEXT_FLAG_PROCESS) >>> 0;
    return 0;
}

/** PROCESS_DPI_AWARENESS / DPI_AWARENESS level 0..2 → the context SetProcessDpiAwareness sets. */
export function contextForAwarenessLevel(level: number): number | null {
    switch (level) {
        case DPI_AWARENESS_UNAWARE: return CONTEXT_UNAWARE;
        case DPI_AWARENESS_SYSTEM_AWARE: return CONTEXT_SYSTEM_AWARE;
        case DPI_AWARENESS_PER_MONITOR_AWARE: return CONTEXT_PER_MONITOR_AWARE;
        default: return null;
    }
}

export function getAwarenessFromContext(handle: number): number {
    const ctx = contextFromHandle(handle);
    return isValidContext(ctx, 0) ? contextAwareness(ctx) : DPI_AWARENESS_INVALID;
}

/** The DPI a thread's coordinates are expressed in: 96 unaware, system DPI system-aware,
 *  the monitor's own DPI per-monitor-aware. */
export function getThreadDpi(): number {
    switch (contextAwareness(getThreadDpiContext())) {
        case DPI_AWARENESS_UNAWARE: return USER_DEFAULT_SCREEN_DPI;
        case DPI_AWARENESS_SYSTEM_AWARE: return SYSTEM_DPI;
        default: return MONITOR_DPI;
    }
}

/** GetDpiForMonitor's core: the DPI of `hMonitor` as the calling thread sees it. */
export function getDpiForMonitorAsSeen(hMonitor: number): number | null {
    if (!isMonitorHandle(hMonitor)) return null;
    return getThreadDpi();
}

const isProcessDpiAware = (): boolean => contextAwareness(getThreadDpiContext()) !== DPI_AWARENESS_UNAWARE;

const isWindowHandle = (hwnd: number): boolean => hwnd === DESKTOP_HWND || windows.has(hwnd);

const SPI_GETICONTITLELOGFONT = 0x1f;
const SPI_GETNONCLIENTMETRICS = 0x29;
const SPI_GETICONMETRICS = 0x2d;
const LOGFONTW_SIZE = 92;
/** NONCLIENTMETRICSW: the int fields that are DPI-scaled, and the LOGFONTW offsets. */
const NCM_SCALED_INTS = [4, 8, 12, 16, 20, 116, 120, 216, 220];
const NCM_FONTS = [24, 124, 224, 316, 408];
const NCM_PADDED_BORDER = 500;
const ICONMETRICS_SCALED_INTS = [4, 8];
const ICONMETRICS_FONT = 16;

export function createDpiExports(base: Record<string, ThunkImplementation>): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const scaleInt = (addr: number, dpi: number): void => {
        const v = Mem.readInt32(addr) ?? 0;
        Mem.writeUint32(addr, mapToDpi(v, dpi) >>> 0);
    };

    // BOOL SetProcessDPIAware(void) — marks the process system-aware unless its awareness
    // is already set, and succeeds either way.
    exports['SetProcessDPIAware'] = () => {
        setProcessDpiContext(CONTEXT_SYSTEM_AWARE);
        return 1;
    };

    exports['IsProcessDPIAware'] = () => (isProcessDpiAware() ? 1 : 0);

    // UINT GetDpiForSystem(void) — 96 to an unaware caller, the system DPI otherwise; with a
    // 100%-scaled desktop both agree with gdi32's LOGPIXELSX/Y.
    exports['GetDpiForSystem'] = () => (isProcessDpiAware() ? SYSTEM_DPI : USER_DEFAULT_SCREEN_DPI);

    // BOOL SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT)
    exports['SetProcessDpiAwarenessContext'] = (_ctx, _mem, args) => {
        const error = setProcessDpiContext(args[0] >>> 0);
        if (error) {
            setLastError(error);
            return 0;
        }
        return 1;
    };

    exports['GetThreadDpiAwarenessContext'] = () => getThreadDpiContext();

    // DPI_AWARENESS_CONTEXT SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT) — returns the
    // previous context; one inherited from the process carries the PROCESS flag, and passing
    // such a value back drops the thread override.
    exports['SetThreadDpiAwarenessContext'] = (_ctx, _mem, args) => {
        const ctx = contextFromHandle(args[0] >>> 0);
        if (!isValidContext(ctx, SYSTEM_DPI)) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const tid = currentThreadId();
        const prev = threadContexts.get(tid) ?? ((getProcessDpiContext() | CONTEXT_FLAG_PROCESS) >>> 0);
        if (ctx & CONTEXT_FLAG_PROCESS) threadContexts.delete(tid);
        else threadContexts.set(tid, ctx);
        return prev;
    };

    exports['AreDpiAwarenessContextsEqual'] = (_ctx, _mem, args) => {
        const a = contextFromHandle(args[0] >>> 0);
        const b = contextFromHandle(args[1] >>> 0);
        if (!a || !b) return 0;
        return ((a & ~CONTEXT_FLAG_PROCESS) >>> 0) === ((b & ~CONTEXT_FLAG_PROCESS) >>> 0) ? 1 : 0;
    };

    exports['GetAwarenessFromDpiAwarenessContext'] = (_ctx, _mem, args) =>
        getAwarenessFromContext(args[0] >>> 0) >>> 0;

    // UINT GetDpiForWindow(HWND) — 0 for an invalid window. Every window lives on the one
    // monitor, and each awareness level resolves to its 96 DPI.
    exports['GetDpiForWindow'] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        if (!hwnd || !isWindowHandle(hwnd)) {
            setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        return MONITOR_DPI;
    };

    // BOOL EnableNonClientDpiScaling(HWND) — asks for the frame to track the window's DPI.
    // The DPI never changes from 96 here, so the request is honoured by construction.
    exports['EnableNonClientDpiScaling'] = (_ctx, _mem, args) => {
        const hwnd = args[0] >>> 0;
        if (!hwnd || !windows.has(hwnd)) {
            setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        return 1;
    };

    // BOOL AdjustWindowRectExForDpi(LPRECT, DWORD dwStyle, BOOL bMenu, DWORD dwExStyle, UINT dpi)
    exports['AdjustWindowRectExForDpi'] = (_ctx, mem, args) =>
        adjustWindowRectCore(mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0, args[4] >>> 0 || SYSTEM_DPI);

    // int GetSystemMetricsForDpi(int nIndex, UINT dpi)
    exports['GetSystemMetricsForDpi'] = (ctx, mem, args) => {
        const scaled = systemMetricForDpi(args[0] | 0, args[1] >>> 0);
        if (scaled !== null) return scaled >>> 0;
        return base['GetSystemMetrics']!(ctx, mem, [args[0]!]) as number;
    };

    // BOOL SystemParametersInfoForDpi(UINT uiAction, UINT uiParam, PVOID pvParam, UINT fWinIni, UINT dpi)
    // Only the three metric GETs exist in this form; they return the W structures with every
    // DPI-dependent size and font height rescaled.
    exports['SystemParametersInfoForDpi'] = (ctx, mem, args) => {
        const action = args[0] >>> 0;
        const pvParam = args[2] >>> 0;
        const dpi = args[4] >>> 0;
        if (action !== SPI_GETNONCLIENTMETRICS && action !== SPI_GETICONMETRICS && action !== SPI_GETICONTITLELOGFONT) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const ok = base['SystemParametersInfoW']!(ctx, mem, [action, args[1]!, pvParam, 0]) as number;
        if (!ok) return 0;
        const scaleFont = (addr: number) => scaleInt(addr, dpi);
        if (action === SPI_GETICONTITLELOGFONT) {
            if (!isValidAddress(mem, pvParam, LOGFONTW_SIZE, 'rw')) return 0;
            scaleFont(pvParam);
        } else if (action === SPI_GETNONCLIENTMETRICS) {
            const cb = Mem.readUint32(pvParam) ?? 0;
            for (const off of NCM_SCALED_INTS) scaleInt(pvParam + off, dpi);
            for (const off of NCM_FONTS) scaleFont(pvParam + off);
            if (cb > NCM_PADDED_BORDER) scaleInt(pvParam + NCM_PADDED_BORDER, dpi);
        } else {
            for (const off of ICONMETRICS_SCALED_INTS) scaleInt(pvParam + off, dpi);
            scaleFont(pvParam + ICONMETRICS_FONT);
        }
        return 1;
    };

    return exports;
}
