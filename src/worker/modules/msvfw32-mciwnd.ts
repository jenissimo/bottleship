/**
 * MCIWnd (msvfw32) — the window class that owns one MCI device and turns window
 * messages into MCI commands. MCIWndCreate opens the file, points the device's output at
 * the window and sizes the window to the movie; the application then drives playback with
 * MCI_PLAY / MCI_STOP / MCIWNDM_GETMODE through SendMessage.
 *
 * The device itself is winmm's: this file only speaks the MCI string interface to it.
 */

import { Logger, LogCategory } from "../core/logger";
import { Marshaler } from "../core/memory/marshaler";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";
import type { ThunkResult, X86Context } from "../core/thunking/thunk-dispatcher";
import { registerBuiltinClass } from "./user32/class";
import { windows, type WindowInfo } from "./user32/shared-state";
import { getWindowFrameMetrics } from "./user32/window-geometry";
import type { WinmmMci } from "./winmm-mci";

export const MCIWND_CLASS_NAME = "MCIWndClass";

const WM_USER = 0x0400;
const MCI_CLOSE = 0x0804;
const MCI_PLAY = 0x0806;
const MCI_STOP = 0x0808;
const MCI_PAUSE = 0x0809;
const MCI_RESUME = 0x0855;

const MCIWNDM_GETDEVICEID = WM_USER + 100;
const MCIWNDM_GETMODEA = WM_USER + 106;
const MCIWNDM_GETERRORA = WM_USER + 128;
const MCIWNDM_GETSTYLES = WM_USER + 136;
const MCIWNDM_OPENA = WM_USER + 153;
const MCIWNDM_GETMODEW = WM_USER + 206;
const MCIWNDM_GETERRORW = WM_USER + 228;
const MCIWNDM_OPENW = WM_USER + 252;

const MCIWNDF_NOAUTOSIZEWINDOW = 0x0001;

const MCI_MODE_NOT_READY = 524;
const MCI_MODE_STOP = 525;
const MCI_MODE_PLAY = 526;
const MCI_MODE_PAUSE = 529;

const MCIERR_INVALID_DEVICE_ID = 257;
const MCIERR_NULL_PARAMETER_BLOCK = 286;

const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;

interface MciWndState {
    /** Alias of the open device; empty while the window holds none. */
    alias: string;
    lastError: number;
}

const states = new Map<number, MciWndState>();

export function readMciWndFileName(mem: Uint8Array, ptr: number, wide: boolean): string | null {
    if (!ptr) return "";
    const width = wide ? 2 : 1;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    for (let i = 0; i < 32768; i++) {
        const at = ptr + i * width;
        if (at + width > mem.length || !isValidAddress(mem, at, width, "r")) return null;
        if ((wide ? view.getUint16(at, true) : mem[at]) === 0) {
            return wide ? Marshaler.readWideString(mem, ptr) : Marshaler.readString(mem, ptr);
        }
    }
    return null;
}

export function ensureMciWndClass(): void {
    registerBuiltinClass(MCIWND_CLASS_NAME, {
        cbWndExtra: 4,
        controlClass: MCIWND_CLASS_NAME,
        externalPaintManaged: true,
    });
}

export function isMciWndWindow(win: WindowInfo | undefined): boolean {
    if (!win) return false;
    return (win.nativeClassName ?? win.systemControlClass ?? "").toLowerCase() === MCIWND_CLASS_NAME.toLowerCase();
}

function mci(): WinmmMci | null {
    const winmm = System.getInstance().process?.getModule("winmm") as { getMci?: () => WinmmMci | null } | undefined;
    return winmm?.getMci?.() ?? null;
}

function closeDevice(hwnd: number): void {
    const st = states.get(hwnd);
    if (!st?.alias) return;
    mci()?.executeString(`close ${st.alias}`);
    st.alias = "";
}

/**
 * Size the window so its client area is exactly the movie, as MCIWnd does on open, and
 * put the picture inside the frame rather than stretched under it.
 */
function sizeWindowToMovie(
    ctx: X86Context, mem: Uint8Array, win: WindowInfo, alias: string, width: number, height: number,
): void {
    const frame = getWindowFrameMetrics(win.style >>> 0, (win.exStyle ?? 0) >>> 0, false);
    const setWindowPos = System.getInstance().process?.getModule("user32")?.exports["SetWindowPos"];
    setWindowPos?.(ctx, mem, [
        win.handle, 0, 0, 0,
        width + frame.padSide * 2, height + frame.padTop + frame.padBottom,
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
    ]);
    // A child's stored rectangle includes its border; a top-level window's is its client area.
    const child = ((win.style >>> 0) & 0x40000000) !== 0;
    mci()?.executeString(
        `put ${alias} destination at ${child ? frame.padSide : 0} ${child ? frame.padTop : 0} ${width} ${height}`);
}

/** MCIWNDM_OPEN: returns 0 or the MCI error, which is also what MCIWNDM_GETERROR reports. */
export function openMciWndFile(ctx: X86Context, mem: Uint8Array, hwnd: number, path: string): number {
    const win = windows.get(hwnd);
    const device = mci();
    if (!win || !device) return MCIERR_INVALID_DEVICE_ID;

    const st = states.get(hwnd) ?? { alias: "", lastError: 0 };
    states.set(hwnd, st);
    closeDevice(hwnd);
    if (!path) return 0;   // a NULL name closes the current file

    const alias = `mciwnd${hwnd}`;
    st.lastError = device.executeString(`open "${path}" alias ${alias}`).error;
    if (st.lastError) {
        Logger.warn(LogCategory.SYSTEM, `[MCIWnd] open "${path}" failed: MCI error ${st.lastError}`);
        return st.lastError;
    }
    st.alias = alias;
    device.executeString(`window ${alias} handle ${hwnd}`);

    const where = device.executeString(`where ${alias} source`);
    const rect = where.error ? [] : where.value.split(" ").map((n) => parseInt(n, 10));
    if (rect.length === 4 && rect[2] > 0 && rect[3] > 0 && !(win.style & MCIWNDF_NOAUTOSIZEWINDOW)) {
        sizeWindowToMovie(ctx, mem, win, alias, rect[2], rect[3]);
    }
    Logger.log(LogCategory.SYSTEM,
        `[MCIWnd] hwnd=0x${hwnd.toString(16)} opened "${path}" as ${alias} movie=${rect[2] ?? 0}x${rect[3] ?? 0}`);
    return 0;
}

function deviceMode(st: MciWndState | undefined): { code: number; text: string } {
    if (!st?.alias) return { code: MCI_MODE_NOT_READY, text: "not ready" };
    const text = mci()?.executeString(`status ${st.alias} mode`).value ?? "";
    if (text === "playing") return { code: MCI_MODE_PLAY, text };
    if (text === "paused") return { code: MCI_MODE_PAUSE, text };
    return { code: MCI_MODE_STOP, text: "stopped" };
}

/** Messages an MCIWnd answers itself. Returns null for everything else. */
export function handleMciWndMessage(
    ctx: X86Context,
    hwnd: number,
    msg: number,
    wParam: number,
    lParam: number,
    mem: Uint8Array,
): number | null {
    if (!isMciWndWindow(windows.get(hwnd))) return null;
    const st = states.get(hwnd);
    const device = mci();

    const command = (verb: string): number => {
        if (!st?.alias || !device) return MCIERR_INVALID_DEVICE_ID;
        st.lastError = device.executeString(`${verb} ${st.alias}`).error;
        return st.lastError;
    };

    switch (msg) {
        case MCIWNDM_OPENA:
        case MCIWNDM_OPENW: {
            const file = readMciWndFileName(mem, lParam >>> 0, msg === MCIWNDM_OPENW);
            return file === null ? MCIERR_NULL_PARAMETER_BLOCK : openMciWndFile(ctx, mem, hwnd, file);
        }
        case MCI_PLAY: return command("play");
        case MCI_STOP: return command("stop");
        case MCI_PAUSE: return command("pause");
        case MCI_RESUME: return command("resume");
        case MCI_CLOSE:
            closeDevice(hwnd);
            return 0;
        case MCIWNDM_GETDEVICEID:
            return st?.alias && device ? device.deviceIdOf(st.alias) : 0;
        case MCIWNDM_GETSTYLES:
            return (windows.get(hwnd)?.style ?? 0) & 0xFFFF;
        case MCIWNDM_GETERRORA:
        case MCIWNDM_GETERRORW:
            return st?.lastError ?? 0;
        case MCIWNDM_GETMODEA:
        case MCIWNDM_GETMODEW: {
            const mode = deviceMode(st);
            if (lParam && wParam > 0) {
                const width = msg === MCIWNDM_GETMODEW ? 2 : 1;
                const size = Math.min(wParam >>> 0, mode.text.length + 1) * width;
                if ((lParam >>> 0) + size > mem.length || !isValidAddress(mem, lParam >>> 0, size, "rw")) {
                    if (st) st.lastError = MCIERR_NULL_PARAMETER_BLOCK;
                    return 0;
                }
                if (msg === MCIWNDM_GETMODEW) Marshaler.writeWideString(mem, lParam, mode.text, wParam);
                else Marshaler.writeString(mem, lParam, mode.text, wParam);
            }
            return mode.code;
        }
        default:
            return null;
    }
}

export function clearMciWndState(hwnd: number): void {
    if (!states.has(hwnd)) return;
    closeDevice(hwnd);
    states.delete(hwnd);
}

export function resetMciWndState(): void {
    for (const hwnd of states.keys()) closeDevice(hwnd);
    states.clear();
}

/**
 * MCIWndCreate(hwndParent, hInstance, dwStyle, szFile). The class adds the styles the
 * real one does (a child is bordered, a top-level window gets a caption; both are born
 * visible) and opens `szFile` when one is given.
 */
export function createMciWnd(
    ctx: X86Context,
    mem: Uint8Array,
    hwndParent: number,
    hInstance: number,
    dwStyle: number,
    file: string,
    classNamePtr: number,
): number | ThunkResult {
    const WS_VISIBLE = 0x10000000;
    const WS_BORDER = 0x00800000;
    const WS_CAPTION = 0x00C00000;
    const WS_SYSMENU = 0x00080000;
    const WS_MINIMIZEBOX = 0x00020000;
    const WS_MAXIMIZEBOX = 0x00010000;
    const WS_CLIPSIBLINGS = 0x04000000;
    const WS_CLIPCHILDREN = 0x02000000;

    ensureMciWndClass();
    const style = (dwStyle
        | (hwndParent ? WS_VISIBLE | WS_BORDER : WS_VISIBLE | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
        | WS_CLIPSIBLINGS | WS_CLIPCHILDREN) >>> 0;

    const createWindowEx = System.getInstance().process?.getModule("user32")?.exports["CreateWindowExA"];
    if (!createWindowEx) return 0;
    const created = createWindowEx(ctx, mem, [0, classNamePtr, 0, style, 0, 0, 300, 0, hwndParent, 0, hInstance, 0]);
    const hwnd = typeof created === "number" ? created >>> 0 : 0;
    if (!hwnd) return created as number | ThunkResult;

    states.set(hwnd, { alias: "", lastError: 0 });
    if (file) openMciWndFile(ctx, mem, hwnd, file);
    return hwnd;
}
