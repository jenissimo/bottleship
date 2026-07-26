/**
 * User32 System functions
 *
 * Atomic implementation for system information
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { parseBMPHeader, parseBMPPixels } from '../gdi32/gdi-raster';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { EMU_NATIVE_VIDEO_DLLS } from '../../core/cpu/emulator-config';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { encodeAnsi, getAnsiCodePage, getCodePageDecoder, decodeAnsiString, readAnsiFromGuest, writeAnsiToGuest, encodeAnsiString } from '../codepage-utils';
import { findResourceInPE } from '../kernel32/resource';
import { loadBitmapFromPeResource } from '../kernel32/bitmap-extractor';
import { loadIconFromPeResource } from '../kernel32/icon-extractor';
import {
    clipboardDataByFormat,
    isClipboardOpen,
    openClipboard as openClipboardState,
    closeClipboard as closeClipboardState,
    emptyClipboard as emptyClipboardState,
    setCapture as setCaptureState,
    releaseCapture as releaseCaptureState,
    getCapture as getCaptureState,
    noteLoadStringForDialog,
    windows,
    getAbsoluteWindowPosition,
    installCursorAndUpdateHostVisibility,
    warpGuestCursorTo,
} from './shared-state';
import { getSystemCursorHandle } from './system-cursors';
import { registerDeviceNotification, unregisterDeviceNotification } from './device-notify';

// System color table (COLORREF: 0x00BBGGRR) — mutable via SetSysColors
const sysColors = new Map<number, number>([
    [0,  0xC0C0C0],  // COLOR_SCROLLBAR
    [1,  0xC0DCC0],  // COLOR_BACKGROUND / COLOR_DESKTOP
    [5,  0xFFFFFF],  // COLOR_WINDOW
    [8,  0x000000],  // COLOR_WINDOWTEXT
    [15, 0xC0C0C0],  // COLOR_BTNFACE
    [16, 0x808080],  // COLOR_BTNSHADOW
    [17, 0xFFFFFF],  // COLOR_GRAYTEXT (disabled text)
    [18, 0x000080],  // COLOR_HIGHLIGHT
    [19, 0xFFFFFF],  // COLOR_HIGHLIGHTTEXT
]);

export function createSystemExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    let mouseButtonsSwapped = false;
    let doubleClickTimeMs = 500;
    const registeredClipboardFormats = new Map<string, number>();
    let nextRegisteredClipboardFormat = 0xC000;

    // System metrics constants
    const SM_CXSCREEN = 0;       // Width of screen
    const SM_CYSCREEN = 1;       // Height of screen
    const SM_CXVSCROLL = 2;      // Width of vertical scrollbar
    const SM_CYHSCROLL = 3;      // Height of horizontal scrollbar
    const SM_CYCAPTION = 4;      // Height of caption
    const SM_CXBORDER = 5;       // Width of window border
    const SM_CYBORDER = 6;       // Height of window border
    const SM_CXDLGFRAME = 7;     // Width of dialog frame
    const SM_CYDLGFRAME = 8;     // Height of dialog frame
    const SM_CYVTHUMB = 9;       // Height of vertical scrollbar thumb
    const SM_CXHTHUMB = 10;      // Width of horizontal scrollbar thumb
    const SM_CXICON = 11;        // Icon width
    const SM_CYICON = 12;        // Icon height
    const SM_CXCURSOR = 13;      // Cursor width
    const SM_CYCURSOR = 14;      // Cursor height
    const SM_CYMENU = 15;        // Height of menu bar
    const SM_CXFULLSCREEN = 16;  // Full screen width
    const SM_CYFULLSCREEN = 17;  // Full screen height
    const SM_CYKANJIWINDOW = 18; // Kanji window height
    const SM_MOUSEPRESENT = 19;  // Mouse present
    const SM_CYVSCROLL = 20;     // Height of vertical scrollbar arrow
    const SM_CXHSCROLL = 21;     // Width of horizontal scrollbar arrow
    const SM_DEBUG = 22;         // Debug version
    const SM_SWAPBUTTON = 23;    // Swap mouse buttons
    const SM_CXMIN = 28;         // Minimum window width
    const SM_CYMIN = 29;         // Minimum window height
    const SM_CXSIZE = 30;        // Width of title bar button
    const SM_CYSIZE = 31;        // Height of title bar button
    const SM_CXFRAME = 32;       // Sizing frame width
    const SM_CYFRAME = 33;       // Sizing frame height
    const SM_CXMINTRACK = 34;    // Minimum tracking width
    const SM_CYMINTRACK = 35;    // Minimum tracking height
    const SM_CXDOUBLECLK = 36;   // Double-click width
    const SM_CYDOUBLECLK = 37;   // Double-click height
    const SM_CXICONSPACING = 38; // Icon horizontal spacing
    const SM_CYICONSPACING = 39; // Icon vertical spacing
    const SM_MENUDROPALIGNMENT = 40;
    const SM_PENWINDOWS = 41;
    const SM_DBCSENABLED = 42;
    const SM_CMOUSEBUTTONS = 43; // Number of mouse buttons
    const SM_CXSMICON = 49;      // Small icon width
    const SM_CYSMICON = 50;      // Small icon height
    const SM_CYSMCAPTION = 51;   // Small caption height
    const SM_CXSMSIZE = 52;      // Small caption button width
    const SM_CYSMSIZE = 53;      // Small caption button height
    const SM_CXMENUSIZE = 54;    // Menu bar button width
    const SM_CYMENUSIZE = 55;    // Menu bar button height
    const SM_IMMENABLED = 74;    // IME enabled
    const SM_CXFOCUSBORDER = 75; // Focus border width
    const SM_XVIRTUALSCREEN = 76; // Virtual screen origin X (single monitor = 0)
    const SM_YVIRTUALSCREEN = 77;
    const SM_CXVIRTUALSCREEN = 78;
    const SM_CYVIRTUALSCREEN = 79;
    const SM_CMONITORS = 80;

    const DEFAULT_DISPLAY_REFRESH_RATE = 60;
    type DisplayMode = { width: number; height: number; bpp: number; refreshRate: number };

    const normalizeRefreshRate = (refreshRate: number | undefined): number => {
        const hz = Number(refreshRate);
        return Number.isFinite(hz) && hz > 0 ? Math.trunc(hz) : DEFAULT_DISPLAY_REFRESH_RATE;
    };

    const getCurrentScreenMode = (): DisplayMode => {
        const ddraw = System.getInstance().ddrawContext;
        const cfg = EmulatorConfig.getInstance().screenResolution;
        return {
            width: ddraw?.display?.width || cfg.width,
            height: ddraw?.display?.height || cfg.height,
            bpp: ddraw?.display?.bpp || cfg.bpp || 16,
            refreshRate: normalizeRefreshRate(ddraw?.display?.refresh || cfg.refreshRate),
        };
    };

    exports['GetSystemMetrics'] = (ctx, mem, args) => {
        const nIndex = args[0];

        Logger.verbose(LogCategory.USER32, `GetSystemMetrics(${nIndex})`);

        // Use DDraw display mode if set (games call SetDisplayMode to change resolution).
        // On real Windows, GetSystemMetrics reflects the current display mode.
        const { width: screenW, height: screenH } = getCurrentScreenMode();

        switch (nIndex) {
            case SM_CXSCREEN:       return screenW;
            case SM_CYSCREEN:       return screenH;
            case SM_CXVSCROLL:      return 16;   // Vertical scrollbar width
            case SM_CYHSCROLL:      return 16;   // Horizontal scrollbar height
            case SM_CYCAPTION:      return 19;   // Caption height
            case SM_CXBORDER:       return 1;    // Border width
            case SM_CYBORDER:       return 1;    // Border height
            case SM_CXDLGFRAME:     return 3;    // Dialog frame width
            case SM_CYDLGFRAME:     return 3;    // Dialog frame height
            case SM_CYVTHUMB:       return 16;   // VScroll thumb height
            case SM_CXHTHUMB:       return 16;   // HScroll thumb width
            case SM_CXICON:         return 32;   // Icon width
            case SM_CYICON:         return 32;   // Icon height
            case SM_CXCURSOR:       return 32;   // Cursor width
            case SM_CYCURSOR:       return 32;   // Cursor height
            case SM_CYMENU:         return 19;   // Menu bar height
            case SM_CXFULLSCREEN:   return screenW;  // Full screen width
            case SM_CYFULLSCREEN:   return screenH;  // Full screen height
            case SM_CYKANJIWINDOW:  return 0;    // No Kanji window
            case SM_MOUSEPRESENT:   return 1;    // Mouse present
            case SM_CYVSCROLL:      return 16;   // VScroll arrow height
            case SM_CXHSCROLL:      return 16;   // HScroll arrow width
            case SM_DEBUG:          return 0;    // Not debug version
            case SM_SWAPBUTTON:     return mouseButtonsSwapped ? 1 : 0;
            case SM_CXMIN:          return 112;  // Min window width
            case SM_CYMIN:          return 27;   // Min window height
            case SM_CXSIZE:         return 18;   // Title bar button width
            case SM_CYSIZE:         return 18;   // Title bar button height
            case SM_CXFRAME:        return 4;    // Sizing frame width
            case SM_CYFRAME:        return 4;    // Sizing frame height
            case SM_CXMINTRACK:     return 112;  // Min tracking width
            case SM_CYMINTRACK:     return 27;   // Min tracking height
            case SM_CXDOUBLECLK:    return 4;    // Double-click width
            case SM_CYDOUBLECLK:    return 4;    // Double-click height
            case SM_CXICONSPACING:  return 75;   // Icon horizontal spacing
            case SM_CYICONSPACING:  return 75;   // Icon vertical spacing
            case SM_MENUDROPALIGNMENT: return 0; // Menu drops aligned left
            case SM_PENWINDOWS:     return 0;    // No pen support
            case SM_DBCSENABLED:    return 0;    // No DBCS
            case SM_CMOUSEBUTTONS:  return 3;    // 3 mouse buttons
            case SM_CXSMICON:       return 16;   // Small icon width
            case SM_CYSMICON:       return 16;   // Small icon height
            case SM_CYSMCAPTION:    return 15;   // Small caption height
            case SM_CXSMSIZE:       return 12;   // Small caption button width
            case SM_CYSMSIZE:       return 14;   // Small caption button height
            case SM_CXMENUSIZE:     return 18;   // Menu bar button width
            case SM_CYMENUSIZE:     return 18;   // Menu bar button height
            case SM_IMMENABLED:     return 0;    // No IME
            case SM_CXFOCUSBORDER:  return 1;    // Focus border width
            case SM_XVIRTUALSCREEN: return 0;    // Single monitor, origin 0
            case SM_YVIRTUALSCREEN: return 0;
            case SM_CXVIRTUALSCREEN: return screenW;
            case SM_CYVIRTUALSCREEN: return screenH;
            case SM_CMONITORS:      return 1;    // Single monitor
            default:
                Logger.warn(LogCategory.USER32, `GetSystemMetrics: unknown index ${nIndex}`);
                return 0;
        }
    };

    // GetActiveWindow - return handle of the active window (NULL if none)
    exports['GetActiveWindow'] = () => {
        return System.getInstance().windowManager.getActiveHwnd();
    };

    exports['GetForegroundWindow'] = () => {
        return System.getInstance().windowManager.getActiveHwnd();
    };

    // BOOL AttachThreadInput(DWORD idAttach, DWORD idAttachTo, BOOL fAttach)
    // Attaches/detaches one thread's input-processing mechanism to another's,
    // making them share a single input queue (focus/active/capture/key state).
    // Our HLE already routes all input through one global queue, so the two
    // threads are effectively always attached — the call is a semantic no-op
    // that must simply report success (games gate focus-stealing on the BOOL).
    exports['AttachThreadInput'] = (_ctx, _mem, args) => {
        const idAttach = args[0] >>> 0;
        const idAttachTo = args[1] >>> 0;
        const fAttach = args[2] >>> 0;
        Logger.verbose(
            LogCategory.USER32,
            `AttachThreadInput(${idAttach}, ${idAttachTo}, ${fAttach ? 'attach' : 'detach'}) -> TRUE`,
        );
        return 1;
    };

    exports['GetCursorPos'] = (ctx, mem, args) => {
        const lpPoint = args[0];
        if (lpPoint && lpPoint + 8 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // Get actual mouse position from InputManager
            const mouseState = System.getInstance().inputManager.getMouseState();
            view.setInt32(lpPoint, mouseState.x, true);
            view.setInt32(lpPoint + 4, mouseState.y, true);
        }
        return 1;
    };

    exports['SetCursorPos'] = (ctx, mem, args) => {
        const x = args[0] | 0;
        const y = args[1] | 0;
        warpGuestCursorTo(x, y);
        Logger.verbose(LogCategory.USER32, `SetCursorPos(${x}, ${y})`);
        return 1;
    };

    exports['MessageBeep'] = () => 1;

    exports['GetKeyboardType'] = (ctx, mem, args) => {
        const typeFlag = args[0] | 0;
        // 0 = keyboard type, 1 = subtype, 2 = number of function keys
        if (typeFlag === 0) return 4;  // 101-key
        if (typeFlag === 1) return 0;  // subtype
        if (typeFlag === 2) return 12; // F1..F12
        return 0;
    };

    exports['GetKeyboardLayout'] = (ctx, mem, args) => {
        const idThread = args[0] >>> 0;
        // Return a stable US-English HKL: LOWORD = LANGID 0x0409, HIWORD = layout handle 0x0409.
        const hkl = 0x04090409;
        Logger.verbose(LogCategory.USER32, `GetKeyboardLayout(thread=${idThread}) -> 0x${hkl.toString(16)}`);
        return hkl;
    };

    exports['ActivateKeyboardLayout'] = (ctx, mem, args) => {
        // HKL ActivateKeyboardLayout(HKL hkl, UINT Flags)
        // Stub: return the requested layout as if activation succeeded.
        const hkl = args[0] >>> 0;
        return hkl !== 0 ? hkl : 0x04090409;
    };

    exports['UnloadKeyboardLayout'] = (ctx, mem, args) => {
        // BOOL UnloadKeyboardLayout(HKL hkl)
        // Stub: pretend success.
        return 1;
    };

    // BOOL GetKeyboardLayoutNameA(LPSTR pwszKLID) — KLID is 8 hex digits + NUL (KL_NAMELENGTH = 9)
    exports['GetKeyboardLayoutNameA'] = (ctx, mem, args) => {
        const psz = args[0] >>> 0;
        if (!psz || psz + 9 > mem.length) return 0;
        const langId = EmulatorConfig.getInstance().lcid & 0xffff;
        const name = langId.toString(16).padStart(8, '0');
        for (let i = 0; i < 8; i++) {
            mem[psz + i] = name.charCodeAt(i);
        }
        mem[psz + 8] = 0;
        return 1;
    };

    // int GetKeyboardLayoutList(int nBuff, HKL *lpList)
    exports['GetKeyboardLayoutList'] = (ctx, mem, args) => {
        const nBuff = args[0] | 0;
        const lpList = args[1] >>> 0;
        const langId = EmulatorConfig.getInstance().lcid & 0xffff;
        const hkl = (langId << 16) | langId;
        if (nBuff === 0) return 1;
        if (!lpList) return 0;
        if (lpList + 4 > mem.length) return 0;
        Mem.writeUint32(lpList, hkl);
        return 1;
    };

    exports['keybd_event'] = (ctx, mem, args) => {
        const bVk = args[0] & 0xff;
        const bScan = args[1] & 0xff;
        const dwFlags = args[2] >>> 0;
        const KEYEVENTF_KEYUP = 0x0002;
        const msg = (dwFlags & KEYEVENTF_KEYUP) !== 0 ? 0x0101 : 0x0100; // WM_KEYUP/WM_KEYDOWN
        const lParam = 1 | (bScan << 16);
        const hwnd = System.getInstance().windowManager.getInputTargetWindow()?.hwnd ?? 0;
        if (hwnd) {
            System.getInstance().windowManager.postMessage(hwnd, msg, bVk, lParam);
        }
        return 0;
    };

    exports['mouse_event'] = (ctx, mem, args) => {
        const dwFlags = args[0] >>> 0;
        const dx = args[1] | 0;
        const dy = args[2] | 0;
        const dwData = args[3] >>> 0;

        const MOUSEEVENTF_MOVE = 0x0001;
        const MOUSEEVENTF_LEFTDOWN = 0x0002;
        const MOUSEEVENTF_LEFTUP = 0x0004;
        const MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const MOUSEEVENTF_RIGHTUP = 0x0010;
        const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const MOUSEEVENTF_MIDDLEUP = 0x0040;
        const MOUSEEVENTF_WHEEL = 0x0800;
        const MOUSEEVENTF_ABSOLUTE = 0x8000;

        Logger.verbose(LogCategory.USER32,
            `mouse_event(flags=0x${dwFlags.toString(16)}, dx=${dx}, dy=${dy}, data=${dwData})`);

        const system = System.getInstance();
        const wm = system.windowManager;
        const inputManager = system.inputManager;
        const target = wm.getInputTargetWindow();
        const hwnd = target?.hwnd ?? 0;
        if (!hwnd) {
            return 0;
        }

        if (dwFlags & MOUSEEVENTF_ABSOLUTE) {
            const screen = EmulatorConfig.getInstance().screenResolution;
            const screenW = Math.max(1, screen.width);
            const screenH = Math.max(1, screen.height);
            const absX = Math.round((dx * screenW) / 65535);
            const absY = Math.round((dy * screenH) / 65535);
            inputManager.setMousePosition(absX, absY);
            self.postMessage({ type: "set_cursor_pos", x: absX, y: absY });
        } else if (dwFlags & MOUSEEVENTF_MOVE) {
            const pos = inputManager.getMouseState();
            const nextX = pos.x + dx;
            const nextY = pos.y + dy;
            inputManager.setMousePosition(nextX, nextY);
            self.postMessage({ type: "set_cursor_pos", x: nextX, y: nextY });
        }

        const pos = inputManager.getMouseState();
        const lParam = ((pos.y & 0xffff) << 16) | (pos.x & 0xffff);
        const post = (msg: number, wParam = 0) => wm.postMessage(hwnd, msg, wParam, lParam);

        if (dwFlags & MOUSEEVENTF_LEFTDOWN) post(0x0201, 0x0001);
        if (dwFlags & MOUSEEVENTF_LEFTUP) post(0x0202, 0);
        if (dwFlags & MOUSEEVENTF_RIGHTDOWN) post(0x0204, 0x0002);
        if (dwFlags & MOUSEEVENTF_RIGHTUP) post(0x0205, 0);
        if (dwFlags & MOUSEEVENTF_MIDDLEDOWN) post(0x0207, 0x0010);
        if (dwFlags & MOUSEEVENTF_MIDDLEUP) post(0x0208, 0);
        if (dwFlags & MOUSEEVENTF_WHEEL) post(0x020a, (dwData & 0xffff) << 16);
        if ((dwFlags & MOUSEEVENTF_MOVE) && !(dwFlags & 0x00fe)) {
            post(0x0200, 0);
        }

        return 0;
    };

    let nextInputDesktop = 0xd0000001;
    const openInputDesktops = new Set<number>();

    exports['OpenInputDesktop'] = (ctx, mem, args) => {
        const dwFlags = args[0] >>> 0;
        const fInherit = args[1];
        const dwDesiredAccess = args[2] >>> 0;
        const handle = nextInputDesktop++;
        openInputDesktops.add(handle);
        Logger.verbose(LogCategory.USER32,
            `OpenInputDesktop(flags=0x${dwFlags.toString(16)}, inherit=${fInherit}, access=0x${dwDesiredAccess.toString(16)}) -> 0x${handle.toString(16)}`);
        return handle;
    };

    exports['CloseDesktop'] = (ctx, mem, args) => {
        const hDesktop = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `CloseDesktop(0x${hDesktop.toString(16)})`);
        if (!openInputDesktops.delete(hDesktop)) {
            return 0;
        }
        return 1;
    };

    // void SetLastErrorEx(DWORD dwErrCode, DWORD dwType)
    // On real Windows this just calls SetLastError, ignoring dwType.
    exports['SetLastErrorEx'] = (ctx, mem, args) => {
        const system = System.getInstance();
        if (system.process) system.process.lastError = args[0] >>> 0;
        return 0;
    };

    exports['CharUpperA'] = (ctx, mem, args) => {
        const lpStr = args[0] >>> 0;
        const cp = EmulatorConfig.getInstance().ansiCodePage;
        const decoder = getCodePageDecoder(cp);
        if (lpStr <= 0xFFFF) {
            const ch = decoder.decode(new Uint8Array([lpStr & 0xFF]));
            const encoded = encodeAnsi(ch.toUpperCase());
            return encoded.length > 0 ? encoded[0] : (lpStr & 0xFF);
        }

        let i = 0;
        while (lpStr + i < mem.length) {
            const c = mem[lpStr + i];
            if (c === 0) break;
            const ch = decoder.decode(new Uint8Array([c]));
            const encoded = encodeAnsi(ch.toUpperCase());
            mem[lpStr + i] = encoded.length > 0 ? encoded[0] : c;
            i++;
        }
        return lpStr;
    };

    exports['CharLowerA'] = (_ctx, mem, args) => {
        const lpStr = args[0] >>> 0;
        const cp = EmulatorConfig.getInstance().ansiCodePage;
        const decoder = getCodePageDecoder(cp);
        if (lpStr <= 0xFFFF) {
            const ch = decoder.decode(new Uint8Array([lpStr & 0xFF]));
            const encoded = encodeAnsi(ch.toLowerCase());
            return encoded.length > 0 ? encoded[0] : (lpStr & 0xFF);
        }

        let i = 0;
        while (lpStr + i < mem.length) {
            const c = mem[lpStr + i];
            if (c === 0) break;
            const ch = decoder.decode(new Uint8Array([c]));
            const encoded = encodeAnsi(ch.toLowerCase());
            mem[lpStr + i] = encoded.length > 0 ? encoded[0] : c;
            i++;
        }
        return lpStr;
    };

    // LPWSTR CharUpperW(LPWSTR lpsz)
    // If lpsz <= 0xFFFF it is a single wide character passed as atom; return uppercased code point.
    // Otherwise it is a pointer to a null-terminated UTF-16LE string; upper-case in-place.
    exports['CharUpperW'] = (_ctx, mem, args) => {
        const lpStr = args[0] >>> 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (lpStr <= 0xFFFF) {
            const ch = String.fromCharCode(lpStr & 0xFFFF).toUpperCase();
            return ch.charCodeAt(0);
        }
        let off = 0;
        while (lpStr + off + 1 < mem.length) {
            const code = view.getUint16(lpStr + off, true);
            if (code === 0) break;
            const upper = String.fromCharCode(code).toUpperCase().charCodeAt(0);
            view.setUint16(lpStr + off, upper, true);
            off += 2;
        }
        return lpStr;
    };

    // LPWSTR CharLowerW(LPWSTR lpsz)
    // Same contract as CharUpperW but lower-cases.
    exports['CharLowerW'] = (_ctx, mem, args) => {
        const lpStr = args[0] >>> 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (lpStr <= 0xFFFF) {
            const ch = String.fromCharCode(lpStr & 0xFFFF).toLowerCase();
            return ch.charCodeAt(0);
        }
        let off = 0;
        while (lpStr + off + 1 < mem.length) {
            const code = view.getUint16(lpStr + off, true);
            if (code === 0) break;
            const lower = String.fromCharCode(code).toLowerCase().charCodeAt(0);
            view.setUint16(lpStr + off, lower, true);
            off += 2;
        }
        return lpStr;
    };

    // GetLastActivePopup - return last active popup for the given window (minimal: return hwnd or NULL)
    exports['GetLastActivePopup'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `GetLastActivePopup(0x${hWnd.toString(16)})`);
        return { value: hWnd || 0, stackCleanup: 4 };
    };

    // ReleaseCapture - release mouse capture
    exports['ReleaseCapture'] = (ctx, mem, args) => {
        const prev = releaseCaptureState();
        // Win32: the window losing capture receives WM_CAPTURECHANGED (lParam = hwnd gaining
        // capture, here NULL). Faithful capture transfer — UE1 SetMouseCapture gates on this.
        if (prev) {
            System.getInstance().windowManager.postMessage(prev, 0x0215 /* WM_CAPTURECHANGED */, 0, 0);
        }
        Logger.verbose(LogCategory.USER32, `ReleaseCapture() prev=0x${prev.toString(16)}`);
        return { value: 1, stackCleanup: 0 };
    };

    // SetCapture - set mouse capture to window
    exports['SetCapture'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const prev = setCaptureState(hWnd);
        // The previously-capturing window (if any, and different) loses capture →
        // WM_CAPTURECHANGED with lParam = the window gaining capture (hWnd).
        if (prev && prev !== (hWnd >>> 0)) {
            System.getInstance().windowManager.postMessage(prev, 0x0215 /* WM_CAPTURECHANGED */, 0, hWnd >>> 0);
        }
        Logger.verbose(LogCategory.USER32, `SetCapture(0x${hWnd.toString(16)}) prev=0x${prev.toString(16)}`);
        return { value: prev, stackCleanup: 4 };
    };

    const loadCursorCommon = (apiName: string, hInstance: number, lpCursorName: number): number => {
        // Ordinal ids resolve to the system cursor theme (system-cursors.ts).
        // App PE-resource cursors (hInstance != 0 or a name string) are not
        // decoded yet — they share the arrow shape so the pointer stays visible.
        const handle = getSystemCursorHandle(lpCursorName < 0x10000 ? lpCursorName : 0);
        Logger.verbose(LogCategory.USER32, `${apiName}(0x${hInstance.toString(16)}, ${lpCursorName}) -> 0x${handle.toString(16)}`);
        return handle;
    };

    exports['LoadCursorA'] = (ctx, mem, args) => loadCursorCommon('LoadCursorA', args[0], args[1] >>> 0);

    exports['LoadCursorW'] = (ctx, mem, args) => loadCursorCommon('LoadCursorW', args[0], args[1] >>> 0);

    let nextIconHandle = 0x200;

    const loadIconCommon = (mem: Uint8Array, hInstance: number, lpIconName: number, isWide: boolean): number => {
        if (!lpIconName) {
            Logger.verbose(LogCategory.USER32, `LoadIcon${isWide ? "W" : "A"}(0x${hInstance.toString(16)}, NULL)`);
            return 0;
        }

        if (lpIconName > 0 && lpIconName < 0x10000) {
            const id = lpIconName & 0xffff;
            Logger.verbose(LogCategory.USER32, `LoadIcon${isWide ? "W" : "A"}(0x${hInstance.toString(16)}, #${id})`);
            return nextIconHandle++ | 0;
        }

        const name = isWide ? Marshaler.readWideString(mem, lpIconName) : Marshaler.readString(mem, lpIconName);
        Logger.verbose(LogCategory.USER32, `LoadIcon${isWide ? "W" : "A"}(0x${hInstance.toString(16)}, "${name}")`);
        if (!name) return 0;
        return nextIconHandle++ | 0;
    };

    exports['LoadIconA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpIconName = args[1];
        return loadIconCommon(mem, hInstance, lpIconName, false);
    };

    exports['LoadIconW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpIconName = args[1];
        return loadIconCommon(mem, hInstance, lpIconName, true);
    };

    // wsprintfA/W - variadic string formatting (direct-write: no JS string concat, no TextEncoder).
    // `wide` selects the code-unit size of BOTH the format string and the output buffer; the
    // h/l/w length modifiers then select the width of each %s/%c argument independently, per
    // the WPRINTF_ParseFormat{A,W} tables (wine dlls/user32/wsprintf.c).
    const wsprintfCore = (mem: Uint8Array, args: number[], wide: boolean): number => {
        const lpOut = args[0] >>> 0;
        const lpFmt = args[1] >>> 0;

        if (!lpOut || !lpFmt) {
            Logger.warn(LogCategory.USER32, `wsprintf${wide ? 'W' : 'A'}: NULL pointer`);
            return -1;
        }

        const unit = wide ? 2 : 1;
        const memEnd = mem.length;
        // Real wsprintf formats through wvsnprintf with a hard 1024 code-unit budget INCLUDING
        // the terminator, and reports 1024 when it overflows. Callers size their buffer to that
        // documented maximum, so an unbounded formatter writes past a correctly-sized buffer.
        // This bounds WRITES only — the format string and %s arguments may live anywhere.
        const WSPRINTF_MAX_UNITS = 1024;
        const outEnd = Math.min(memEnd, lpOut + (WSPRINTF_MAX_UNITS - 1) * unit);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Write cursor into guest memory
        let out = lpOut;

        // Helper: read one code unit of the format string
        const fmtAt = (p: number): number =>
            wide ? (p + 2 <= memEnd ? view.getUint16(p, true) : 0) : (p < memEnd ? mem[p] : 0);

        // Helper: write a single output code unit
        const writeUnit = (c: number): void => {
            if (out + unit > outEnd) return;
            if (wide) { view.setUint16(out, c & 0xFFFF, true); out += 2; }
            else mem[out++] = c & 0xFF;
        };

        // Helper: write a JS string directly to mem in the output's code-unit width
        const writeStr = (s: string): void => {
            if (wide) {
                for (let i = 0; i < s.length; i++) writeUnit(s.charCodeAt(i));
                return;
            }
            const encoded = encodeAnsi(s);
            const writeLen = Math.min(encoded.length, outEnd - out);
            if (writeLen > 0) {
                mem.set(encoded.subarray(0, writeLen), out);
                out += writeLen;
            }
        };

        // Helper: length of a guest string in its own code units, bounded by precision
        const guestStrLen = (addr: number, srcWide: boolean, maxChars: number): number => {
            let n = 0;
            if (srcWide) {
                while (n < maxChars && addr + n * 2 + 2 <= memEnd && view.getUint16(addr + n * 2, true) !== 0) n++;
            } else {
                while (n < maxChars && addr + n < memEnd && mem[addr + n] !== 0) n++;
            }
            return n;
        };

        // Helper: copy a guest string; same-width stays mem-to-mem (no decode round-trip)
        const writeGuestStr = (addr: number, srcWide: boolean, len: number): void => {
            if (srcWide === wide) {
                if (wide) {
                    const n = Math.min(len, (outEnd - out) >> 1, (memEnd - addr) >> 1);
                    for (let j = 0; j < n; j++) view.setUint16(out + j * 2, view.getUint16(addr + j * 2, true), true);
                    out += n * 2;
                } else {
                    const n = Math.min(len, outEnd - out, memEnd - addr);
                    if (n > 0) { mem.set(mem.subarray(addr, addr + n), out); out += n; }
                }
                return;
            }
            writeStr(srcWide
                ? Marshaler.readWideString(mem, addr).slice(0, len)
                : readAnsiFromGuest(mem, addr, len));
        };

        // Helper: format a number and write directly
        const writeNumber = (
            raw: number, base: number, uppercase: boolean, signed: boolean,
            width: number, precision: number | null, zeroPad: boolean
        ): void => {
            let sign = 0; // 0 = none, 0x2D = '-'
            let value: number;
            if (signed) {
                const sv = raw | 0;
                if (sv < 0) { sign = 0x2D; value = -sv; } else { value = sv; }
            } else {
                value = raw >>> 0;
            }

            let str = value.toString(base);
            if (uppercase) str = str.toUpperCase();

            if (precision !== null) {
                str = str.padStart(precision, '0');
                zeroPad = false;
            }

            if (zeroPad && width > 0) {
                str = str.padStart(Math.max(width - (sign ? 1 : 0), 0), '0');
            }

            const totalLen = (sign ? 1 : 0) + str.length;
            // Right-align with spaces if needed
            if (width > totalLen) {
                for (let p = totalLen; p < width; p++) writeUnit(0x20);
            }
            if (sign) writeUnit(sign);
            writeStr(str);
        };

        // Helper: write one character argument, converting if its width differs from the output's
        const writeChar = (raw: number, srcWide: boolean): void => {
            if (srcWide === wide) { writeUnit(srcWide ? raw & 0xFFFF : raw & 0xFF); return; }
            writeStr(srcWide
                ? String.fromCharCode(raw & 0xFFFF)
                : getCodePageDecoder(getAnsiCodePage()).decode(Uint8Array.of(raw & 0xFF)));
        };

        // Parse format string directly from guest memory
        let fi = lpFmt;
        let argIndex = 2;

        while (fi + unit <= memEnd) {
            const ch = fmtAt(fi);
            if (ch === 0) break;

            if (ch !== 0x25 /* '%' */) {
                writeUnit(ch);
                fi += unit;
                continue;
            }

            fi += unit; // skip '%'
            if (fmtAt(fi) === 0) break;

            if (fmtAt(fi) === 0x25) { // %%
                writeUnit(0x25);
                fi += unit;
                continue;
            }

            let zeroPad = false;
            let width = 0;
            let precision: number | null = null;

            if (fmtAt(fi) === 0x30) { // '0'
                zeroPad = true;
                fi += unit;
            }

            while (fmtAt(fi) >= 0x30 && fmtAt(fi) <= 0x39) {
                width = (width * 10) + (fmtAt(fi) - 0x30);
                fi += unit;
            }

            if (fmtAt(fi) === 0x2E) { // '.'
                fi += unit;
                precision = 0;
                while (fmtAt(fi) >= 0x30 && fmtAt(fi) <= 0x39) {
                    precision = (precision * 10) + (fmtAt(fi) - 0x30);
                    fi += unit;
                }
            }

            // Length modifiers: they pick the argument width for %s/%S/%c/%C
            let modShort = false, modLong = false, modWide = false;
            const mod = fmtAt(fi);
            if (mod === 0x68 || mod === 0x6C) { // 'h' or 'l'
                if (mod === 0x68) modShort = true; else modLong = true;
                fi += unit;
                if (fmtAt(fi) === mod) fi += unit; // hh, ll
            } else if (mod === 0x4C || mod === 0x77) { // 'L' or 'w'
                if (mod === 0x77) modWide = true;
                fi += unit;
            } else if (mod === 0x49) { // 'I'
                fi += unit;
                if (fmtAt(fi) === 0x33 || fmtAt(fi) === 0x36) { // '3' or '6'
                    fi += unit;
                    if (fmtAt(fi) >= 0x30 && fmtAt(fi) <= 0x39) fi += unit;
                }
            }

            const spec = fmtAt(fi);
            if (spec === 0) break;
            fi += unit;

            switch (spec) {
                case 0x73: // 's'
                case 0x53: // 'S' — the opposite width of the function's own
                    if (argIndex < args.length) {
                        const isBigS = spec === 0x53;
                        const srcWide = wide
                            ? (isBigS ? (modLong || modWide) : !(modShort && !modWide))
                            : (isBigS ? !(modShort || modWide) : (modLong || modWide));
                        const strAddr = args[argIndex++] >>> 0;
                        if (strAddr) {
                            const slen = guestStrLen(strAddr, srcWide, precision !== null ? precision : 0x7FFFFFFF);
                            if (width > slen) {
                                for (let p = slen; p < width; p++) writeUnit(0x20);
                            }
                            writeGuestStr(strAddr, srcWide, slen);
                        }
                    }
                    break;
                case 0x64: // 'd'
                case 0x69: // 'i'
                    if (argIndex < args.length) {
                        writeNumber(args[argIndex++], 10, false, true, width, precision, zeroPad);
                    }
                    break;
                case 0x75: // 'u'
                    if (argIndex < args.length) {
                        writeNumber(args[argIndex++], 10, false, false, width, precision, zeroPad);
                    }
                    break;
                case 0x78: // 'x'
                    if (argIndex < args.length) {
                        writeNumber(args[argIndex++], 16, false, false, width, precision, zeroPad);
                    }
                    break;
                case 0x58: // 'X'
                    if (argIndex < args.length) {
                        writeNumber(args[argIndex++], 16, true, false, width, precision, zeroPad);
                    }
                    break;
                case 0x63: // 'c'
                case 0x43: // 'C' — the opposite width of the function's own
                    if (argIndex < args.length) {
                        const isBigC = spec === 0x43;
                        const srcWide = wide ? (isBigC ? modLong : !modShort) : (isBigC ? !modShort : modLong);
                        const charVal = args[argIndex++];
                        if (width > 1) {
                            for (let p = 1; p < width; p++) writeUnit(0x20);
                        }
                        writeChar(charVal, srcWide);
                    }
                    break;
                case 0x25: // '%'
                    writeUnit(0x25);
                    break;
                default:
                    writeUnit(0x25);
                    writeUnit(spec);
            }
        }

        // Null terminator — memEnd reserves the slot for it, so this always fits unless the
        // caller's buffer was already past the end of guest memory.
        if (out + unit <= mem.length) {
            if (wide) view.setUint16(out, 0, true); else mem[out] = 0;
        }
        const charsWritten = (out - lpOut) / unit;
        const truncated = charsWritten >= WSPRINTF_MAX_UNITS - 1;

        Logger.verbose(LogCategory.USER32, `wsprintf${wide ? 'W' : 'A'}: ${charsWritten} chars written to 0x${lpOut.toString(16)}`);
        return truncated ? WSPRINTF_MAX_UNITS : charsWritten;
    };

    exports['wsprintfA'] = (_ctx, mem, args) => wsprintfCore(mem, args, false);
    exports['wsprintfW'] = (_ctx, mem, args) => wsprintfCore(mem, args, true);

    // wvsprintfA - va_list variant of wsprintfA
    // Hot path: called thousands of times per frame by some games.
    // Pre-read only 16 args (wsprintfA max is ~10 in practice), avoid spread operator.
    exports['wvsprintfA'] = (ctx, mem, args) => {
        const lpOut = args[0] >>> 0;
        const lpFmt = args[1] >>> 0;
        const lpArgList = args[2] >>> 0;

        if (!lpOut || !lpFmt) return -1;

        // Build args array inline: [lpOut, lpFmt, varArg0, varArg1, ...]
        const syntheticArgs: number[] = [lpOut, lpFmt];
        if (lpArgList) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const limit = Math.min(16, (mem.byteLength - lpArgList) >> 2);
            for (let i = 0; i < limit; i++) {
                syntheticArgs.push(view.getUint32(lpArgList + i * 4, true) >>> 0);
            }
        }

        return exports['wsprintfA']!(ctx, mem, syntheticArgs) as number;
    };

    // MapVirtualKeyA - convert virtual key code to scan code or character
    exports['MapVirtualKeyA'] = (ctx, mem, args) => {
        const uCode = args[0];
        const uMapType = args[1];
        
        Logger.verbose(LogCategory.USER32, `MapVirtualKeyA(uCode=${uCode}, uMapType=${uMapType})`);
        
        // uMapType: 0 = virtual key to scan code, 1 = scan code to virtual key,
        //           2 = virtual key to unshifted character, 3 = scan code to VK (distinguishes L/R)
        if (uMapType === 0 || uMapType === 3) {
            // Virtual key to scan code (Set 1 / AT keyboard)
            // Letters A-Z
            if (uCode >= 0x41 && uCode <= 0x5A) return uCode - 0x41 + 0x1E;
            // Digits: '1'-'9' → 0x02-0x0A, '0' → 0x0B
            if (uCode >= 0x31 && uCode <= 0x39) return uCode - 0x30 + 1;
            if (uCode === 0x30) return 0x0B;
            // Common keys
            const vkToScan: Record<number, number> = {
                0x08: 0x0E, 0x09: 0x0F, 0x0D: 0x1C, 0x10: 0x2A, 0x11: 0x1D,
                0x12: 0x38, 0x13: 0x45, 0x14: 0x3A, 0x1B: 0x01, 0x20: 0x39,
                // Navigation
                0x21: 0x49, 0x22: 0x51, 0x23: 0x4F, 0x24: 0x47,
                // Arrows
                0x25: 0x4B, 0x26: 0x48, 0x27: 0x4D, 0x28: 0x50,
                0x2C: 0x37, 0x2D: 0x52, 0x2E: 0x53,
                // Numpad
                0x60: 0x52, 0x61: 0x4F, 0x62: 0x50, 0x63: 0x51,
                0x64: 0x4B, 0x65: 0x4C, 0x66: 0x4D, 0x67: 0x48,
                0x68: 0x49, 0x69: 0x49,
                0x6A: 0x37, 0x6B: 0x4E, 0x6D: 0x4A, 0x6E: 0x53, 0x6F: 0x35,
                // F-keys
                0x70: 0x3B, 0x71: 0x3C, 0x72: 0x3D, 0x73: 0x3E,
                0x74: 0x3F, 0x75: 0x40, 0x76: 0x41, 0x77: 0x42,
                0x78: 0x43, 0x79: 0x44, 0x7A: 0x57, 0x7B: 0x58,
                0x90: 0x45, 0x91: 0x46,
                // OEM keys (US layout)
                0xBA: 0x27, 0xBB: 0x0D, 0xBC: 0x33, 0xBD: 0x0C,
                0xBE: 0x34, 0xBF: 0x35, 0xC0: 0x29,
                0xDB: 0x1A, 0xDC: 0x2B, 0xDD: 0x1B, 0xDE: 0x28,
            };
            return vkToScan[uCode] ?? 0;
        } else if (uMapType === 1) {
            // Scan code to virtual key
            const scanToVk: Record<number, number> = {
                0x01: 0x1B, 0x02: 0x31, 0x03: 0x32, 0x04: 0x33, 0x05: 0x34,
                0x06: 0x35, 0x07: 0x36, 0x08: 0x37, 0x09: 0x38, 0x0A: 0x39,
                0x0B: 0x30, 0x0C: 0xBD, 0x0D: 0xBB, 0x0E: 0x08, 0x0F: 0x09,
                // Q-P row
                0x10: 0x51, 0x11: 0x57, 0x12: 0x45, 0x13: 0x52, 0x14: 0x54,
                0x15: 0x59, 0x16: 0x55, 0x17: 0x49, 0x18: 0x4F, 0x19: 0x50,
                0x1A: 0xDB, 0x1B: 0xDD, 0x1C: 0x0D,
                0x1D: 0x11, // Ctrl
                // A-L row
                0x1E: 0x41, 0x1F: 0x53, 0x20: 0x44, 0x21: 0x46, 0x22: 0x47,
                0x23: 0x48, 0x24: 0x4A, 0x25: 0x4B, 0x26: 0x4C,
                0x27: 0xBA, 0x28: 0xDE, 0x29: 0xC0,
                0x2A: 0x10, // LShift
                0x2B: 0xDC,
                // Z-M row
                0x2C: 0x5A, 0x2D: 0x58, 0x2E: 0x43, 0x2F: 0x56, 0x30: 0x42,
                0x31: 0x4E, 0x32: 0x4D, 0x33: 0xBC, 0x34: 0xBE, 0x35: 0xBF,
                0x36: 0x10, // RShift → VK_SHIFT
                0x37: 0x6A, // Numpad *
                0x38: 0x12, // Alt
                0x39: 0x20, // Space
                0x3A: 0x14, // CapsLock
                // F-keys
                0x3B: 0x70, 0x3C: 0x71, 0x3D: 0x72, 0x3E: 0x73,
                0x3F: 0x74, 0x40: 0x75, 0x41: 0x76, 0x42: 0x77,
                0x43: 0x78, 0x44: 0x79, 0x57: 0x7A, 0x58: 0x7B,
                0x45: 0x90, 0x46: 0x91,
                // Numpad / navigation
                0x47: 0x24, 0x48: 0x26, 0x49: 0x21, 0x4A: 0x6D,
                0x4B: 0x25, 0x4C: 0x0C, 0x4D: 0x27, 0x4E: 0x6B,
                0x4F: 0x23, 0x50: 0x28, 0x51: 0x22, 0x52: 0x2D, 0x53: 0x2E,
            };
            return scanToVk[uCode] ?? 0;
        } else if (uMapType === 2) {
            // Virtual key to unshifted character
            if (uCode >= 0x30 && uCode <= 0x39) return uCode; // 0-9
            if (uCode >= 0x41 && uCode <= 0x5A) return uCode + 32; // a-z (lowercase)
            if (uCode === 0x20) return 0x20; // Space
            const oemChar: Record<number, number> = {
                0xBA: 0x3B, 0xBB: 0x3D, 0xBC: 0x2C, 0xBD: 0x2D,
                0xBE: 0x2E, 0xBF: 0x2F, 0xC0: 0x60,
                0xDB: 0x5B, 0xDC: 0x5C, 0xDD: 0x5D, 0xDE: 0x27,
            };
            return oemChar[uCode] ?? 0;
        }

        return 0;
    };

    // MapVirtualKeyW has the same ABI/behavior as MapVirtualKeyA for VK/scan translation.
    exports['MapVirtualKeyW'] = (ctx, mem, args) => {
        return exports['MapVirtualKeyA']!(ctx, mem, args) as number;
    };

    // int ToAscii(UINT uVirtKey, UINT uScanCode, const BYTE *lpKeyState, LPWORD lpChar, UINT uFlags)
    exports['ToAscii'] = (ctx, mem, args) => {
        const uVirtKey = args[0];
        const uScanCode = args[1];
        const lpKeyState = args[2] >>> 0;
        const lpChar = args[3] >>> 0;

        Logger.verbose(LogCategory.USER32, `ToAscii(vk=0x${uVirtKey.toString(16)}, scan=0x${uScanCode.toString(16)})`);

        if (!lpChar) return 0;

        // Check shift state from keyboard state array
        const shiftDown = lpKeyState ? (mem[lpKeyState + 0x10] & 0x80) !== 0 : false;
        const capsLock = lpKeyState ? (mem[lpKeyState + 0x14] & 0x01) !== 0 : false;

        let ch = 0;
        // Letters
        if (uVirtKey >= 0x41 && uVirtKey <= 0x5A) {
            const upper = shiftDown !== capsLock; // XOR
            ch = upper ? uVirtKey : uVirtKey + 32;
        }
        // Digits 0-9
        else if (uVirtKey >= 0x30 && uVirtKey <= 0x39) {
            if (shiftDown) {
                const shifted = ')!@#$%^&*(';
                ch = shifted.charCodeAt(uVirtKey - 0x30);
            } else {
                ch = uVirtKey;
            }
        }
        // Space, Enter, Tab, Escape
        else if (uVirtKey === 0x20) ch = 0x20;
        else if (uVirtKey === 0x0D) ch = 0x0D;
        else if (uVirtKey === 0x09) ch = 0x09;
        else if (uVirtKey === 0x1B) ch = 0x1B;
        else if (uVirtKey === 0x08) ch = 0x08;
        // OEM keys (US layout)
        else {
            const oemUnshifted: Record<number, number> = {
                0xBA: 0x3B, 0xBB: 0x3D, 0xBC: 0x2C, 0xBD: 0x2D,
                0xBE: 0x2E, 0xBF: 0x2F, 0xC0: 0x60,
                0xDB: 0x5B, 0xDC: 0x5C, 0xDD: 0x5D, 0xDE: 0x27,
            };
            const oemShifted: Record<number, number> = {
                0xBA: 0x3A, 0xBB: 0x2B, 0xBC: 0x3C, 0xBD: 0x5F,
                0xBE: 0x3E, 0xBF: 0x3F, 0xC0: 0x7E,
                0xDB: 0x7B, 0xDC: 0x7C, 0xDD: 0x7D, 0xDE: 0x22,
            };
            ch = shiftDown ? (oemShifted[uVirtKey] ?? 0) : (oemUnshifted[uVirtKey] ?? 0);
        }

        if (ch === 0) return 0;

        mem[lpChar] = ch & 0xFF;
        mem[lpChar + 1] = (ch >> 8) & 0xFF;
        return 1; // one character produced
    };

    // ToUnicode is semantically similar to ToAscii for basic Latin keyboard paths.
    // Reuse ToAscii conversion and write one UTF-16 code unit at pwszBuff.
    exports['ToUnicode'] = (ctx, mem, args) => {
        const pwszBuff = args[3] >>> 0;
        const cchBuff = args[4] | 0;
        if (!pwszBuff || cchBuff <= 0) {
            return 0;
        }

        return exports['ToAscii']!(ctx, mem, [
            args[0],
            args[1],
            args[2],
            pwszBuff,
            args[5] >>> 0,
        ]) as number;
    };

    // Decode a WM_KEYDOWN-style lParam into a Set 1 / US-layout key name.
    // Bit 24 = extended, bit 25 = "don't care about left vs. right" (nt5 xlate.c _GetKeyNameText):
    // right Shift folds onto left Shift, and the extended bit is dropped for Ctrl/Alt only —
    // Win95 compatibility keeps it for the other extended keys (cursor pad, numpad Enter).
    const resolveKeyName = (lParam: number): { name: string; scanCode: number; extended: number } => {
        let scanCode = (lParam >> 16) & 0xFF;
        let extended = (lParam >> 24) & 0x01;

        if (lParam & 0x02000000) {
            if (scanCode === 0x36) scanCode = 0x2A;
            if (extended && (scanCode === 0x1D || scanCode === 0x38)) extended = 0;
        }

        // DirectInput games (Max Payne et al.) pass DIK_* scan codes where the
        // extended keys are folded as 0x80|base (DIK_UP=0xC8, DIK_RCONTROL=0x9D…).
        // Recover the base make code + extended flag so the table below names them.
        if (scanCode & 0x80) {
            extended = 1;
            scanCode &= 0x7F;
        }

        // Scan code to key name (Set 1, US layout)
        const keyNames: Record<number, string> = {
            0x01: 'Esc', 0x02: '1', 0x03: '2', 0x04: '3', 0x05: '4',
            0x06: '5', 0x07: '6', 0x08: '7', 0x09: '8', 0x0A: '9', 0x0B: '0',
            0x0C: '-', 0x0D: '=', 0x0E: 'Backspace', 0x0F: 'Tab',
            0x10: 'Q', 0x11: 'W', 0x12: 'E', 0x13: 'R', 0x14: 'T',
            0x15: 'Y', 0x16: 'U', 0x17: 'I', 0x18: 'O', 0x19: 'P',
            0x1A: '[', 0x1B: ']', 0x1C: extended ? 'Num Enter' : 'Enter',
            0x1D: extended ? 'Right Ctrl' : 'Ctrl',
            0x1E: 'A', 0x1F: 'S', 0x20: 'D', 0x21: 'F', 0x22: 'G',
            0x23: 'H', 0x24: 'J', 0x25: 'K', 0x26: 'L',
            0x27: ';', 0x28: "'", 0x29: '`', 0x2A: 'Shift',
            0x2B: '\\', 0x2C: 'Z', 0x2D: 'X', 0x2E: 'C', 0x2F: 'V',
            0x30: 'B', 0x31: 'N', 0x32: 'M', 0x33: ',', 0x34: '.', 0x35: extended ? 'Num /' : '/',
            0x36: 'Right Shift', 0x37: extended ? 'Print Screen' : 'Num *',
            0x38: extended ? 'Right Alt' : 'Alt', 0x39: 'Space', 0x3A: 'Caps Lock',
            0x3B: 'F1', 0x3C: 'F2', 0x3D: 'F3', 0x3E: 'F4', 0x3F: 'F5',
            0x40: 'F6', 0x41: 'F7', 0x42: 'F8', 0x43: 'F9', 0x44: 'F10',
            0x45: extended ? 'Pause' : 'Num Lock', 0x46: 'Scroll Lock',
            0x47: extended ? 'Home' : 'Num 7', 0x48: extended ? 'Up' : 'Num 8',
            0x49: extended ? 'Page Up' : 'Num 9', 0x4A: 'Num -',
            0x4B: extended ? 'Left' : 'Num 4', 0x4C: 'Num 5',
            0x4D: extended ? 'Right' : 'Num 6', 0x4E: 'Num +',
            0x4F: extended ? 'End' : 'Num 1', 0x50: extended ? 'Down' : 'Num 2',
            0x51: extended ? 'Page Down' : 'Num 3',
            0x52: extended ? 'Insert' : 'Num 0', 0x53: extended ? 'Delete' : 'Num Del',
            0x57: 'F11', 0x58: 'F12',
        };

        return { name: keyNames[scanCode] ?? `Scan ${scanCode}`, scanCode, extended };
    };

    // int GetKeyNameTextA(LONG lParam, LPSTR lpString, int cchSize)
    // int GetKeyNameTextW(LONG lParam, LPWSTR lpString, int cchSize)
    // cchSize is the buffer size INCLUDING the terminator; the name is truncated to cchSize-1 and
    // the return value is the character count written, excluding the terminator.
    const getKeyNameText = (mem: Uint8Array, args: number[], wide: boolean): number => {
        const lParam = args[0];
        const lpString = args[1] >>> 0;
        const cchSize = args[2] | 0;

        if (!lpString) return 0;

        // cchSize < 1 makes the kernel bail without touching the buffer, but the ANSI client
        // wrapper terminates its output unconditionally afterwards (nt5 client/ntcftxt.h), so A
        // still stores a NUL where W leaves the caller's buffer alone.
        if (cchSize <= 0) {
            if (!wide) Marshaler.writeString(mem, lpString, '', 1);
            return 0;
        }

        const { name, scanCode, extended } = resolveKeyName(lParam);
        const text = name.slice(0, cchSize - 1);
        if (wide) Marshaler.writeWideString(mem, lpString, text, cchSize);
        else Marshaler.writeString(mem, lpString, text, cchSize);

        Logger.verbose(LogCategory.USER32, `GetKeyNameText${wide ? 'W' : 'A'}(scan=0x${scanCode.toString(16)}, ext=${extended}) -> "${text}"`);
        return text.length;
    };

    exports['GetKeyNameTextA'] = (_ctx, mem, args) => getKeyNameText(mem, args, false);
    exports['GetKeyNameTextW'] = (_ctx, mem, args) => getKeyNameText(mem, args, true);

    const loadImageCommon = async (
        ctx: any,
        mem: Uint8Array,
        args: number[],
        isWide: boolean
    ): Promise<number> => {
        const [hInst, name, type, cx, cy, fuLoad] = args;
        const apiName = isWide ? "LoadImageW" : "LoadImageA";

        // IMAGE_BITMAP = 0, IMAGE_ICON = 1, IMAGE_CURSOR = 2
        const IMAGE_BITMAP = 0;
        const IMAGE_ICON = 1;
        const IMAGE_CURSOR = 2;

        // LR_LOADFROMFILE = 0x0010
        const LR_LOADFROMFILE = 0x0010;

        let filename = "";
        if (name > 0xFFFF) {
            try {
                filename = isWide ? Marshaler.readWideString(mem, name) : Marshaler.readString(mem, name);
                Logger.verbose(LogCategory.USER32, `${apiName}: Read filename="${filename}" from ptr=0x${name.toString(16)}`);
            } catch (e) {
                filename = `ptr=0x${name.toString(16)}`;
                Logger.warn(LogCategory.USER32, `${apiName}: Failed to read filename from ptr=0x${name.toString(16)}: ${e}`);
            }
        } else {
            filename = `id=${name}`;
            Logger.verbose(LogCategory.USER32, `${apiName}: name is resource ID=${name}, not a filename`);
        }

        const isBmp = filename.toLowerCase().endsWith('.bmp');
        if (isBmp || type === IMAGE_BITMAP) {
            Logger.verbose(LogCategory.USER32, `${apiName}: "${filename}" type=${type} size=${cx}x${cy} fuLoad=0x${fuLoad.toString(16)} isBmp=${isBmp}`);
        } else {
            Logger.verbose(LogCategory.USER32, `${apiName}: name=${filename}, type=${type}, size=${cx}x${cy} (not BMP)`);
        }

        const moduleBase = hInst || 0x00400000;

        // PE resource — load synchronously from module resources. The resource may be
        // identified by a numeric MAKEINTRESOURCE id (name <= 0xFFFF) OR by a string
        // resource name (name is a pointer to e.g. "IDB_PLAYU"). A genuine file load is
        // signalled by LR_LOADFROMFILE (handled further below). loadBitmapFromPeResource /
        // loadIconFromPeResource accept either a numeric id or a string name.
        // NOTE: the Morrowind launcher (re)loads its menu-button bitmaps via LoadImageA
        // with string resource names, then STM_SETIMAGEs them onto the statics — without
        // this branch those handles have no pixels and the buttons paint blank.
        const isFileLoad = (fuLoad & LR_LOADFROMFILE) !== 0;
        const peResName: number | string | null =
            (name > 0 && name <= 0xFFFF) ? name
            : (name > 0xFFFF && !isFileLoad && !isBmp) ? filename
            : null;
        if (peResName !== null) {
            if (type === IMAGE_BITMAP) {
                const hBmp = loadBitmapFromPeResource(mem, moduleBase, peResName);
                if (hBmp) {
                    Logger.verbose(LogCategory.USER32, `${apiName}: PE RT_BITMAP ${JSON.stringify(peResName)} -> 0x${hBmp.toString(16)}`);
                    return hBmp;
                }
            } else if (type === IMAGE_ICON) {
                const hIcon = loadIconFromPeResource(mem, moduleBase, peResName);
                if (hIcon) {
                    Logger.verbose(LogCategory.USER32, `${apiName}: PE RT_ICON ${JSON.stringify(peResName)} -> 0x${hIcon.toString(16)}`);
                    return hIcon;
                }
            }
        }
        
        const system = System.getInstance();
        const resourceData: any = {
            type: type === IMAGE_BITMAP ? 'BITMAP' : type === IMAGE_ICON ? 'ICON' : 'CURSOR',
            name: name,
            width: cx || 0,
            height: cy || 0,
            loading: true,
            pixels: null
        };

        const handle = system.resourceProvider.registerUserObject(resourceData);
        Logger.verbose(LogCategory.USER32, `${apiName}: Registered handle=0x${handle.toString(16)} for "${filename}"`);
        
        // Only attempt to load if it's a bitmap and we have a filename
        if (type !== IMAGE_BITMAP || name <= 0xFFFF || !filename || !isBmp) {
            Logger.verbose(LogCategory.USER32, `${apiName}: Skipping load - type=${type} name<=0xFFFF=${name <= 0xFFFF} filename="${filename}" isBmp=${isBmp}`);
            resourceData.loading = false;
            return handle;
        }

        const normalizedFilename = filename.replace(/\\/g, '/');
        const isSpru = normalizedFilename.toLowerCase().includes("spru");
        let spruLog: { fileOpened: boolean; path?: string; source?: string; loaded: boolean; updateTextureFromBitmapCalled: boolean; error?: string } | null = isSpru ? { fileOpened: false, loaded: false, updateTextureFromBitmapCalled: false } : null;

        Logger.verbose(LogCategory.USER32, `${apiName}: Attempting to load "${normalizedFilename}"`);
        try {
            const fileHandle = await system.fileSystem.open(normalizedFilename, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
            if (!fileHandle) {
                Logger.warn(LogCategory.USER32, `${apiName}: File not found: "${normalizedFilename}"`);
                if (spruLog) spruLog.fileOpened = false;
                return handle;
            }
            if (spruLog) {
                spruLog.fileOpened = true;
                spruLog.path = fileHandle.path;
                spruLog.source = fileHandle.source;
            }
            Logger.verbose(LogCategory.USER32, `${apiName}: File opened, handle path="${fileHandle.path}" source=${fileHandle.source}`);

            const fileSize = system.fileSystem.getFileSize(normalizedFilename);
            Logger.verbose(LogCategory.USER32, `${apiName}: File size=${fileSize} bytes`);
            if (fileSize <= 0 || fileSize > 50 * 1024 * 1024) {
                throw new Error(`Invalid file size: ${fileSize}`);
            }

            const data = await system.fileSystem.read(fileHandle, fileSize);
            if (!data || data.length === 0) {
                Logger.warn(LogCategory.USER32, `${apiName}: Failed to read file data`);
                throw new Error("Failed to read file");
            }
            Logger.verbose(LogCategory.USER32, `${apiName}: Read ${data.length} bytes from file`);

            const header = parseBMPHeader(data);
            Logger.verbose(LogCategory.USER32, `${apiName}: BMP header parsed: ${header ? `width=${header.width} height=${header.height}` : 'null'}`);
            const pixels = header ? parseBMPPixels(data, header) : null;
            Logger.verbose(LogCategory.USER32, `${apiName}: BMP pixels parsed: ${pixels ? `${pixels.length} bytes` : 'null'}`);

            if (pixels && header) {
                if (spruLog) spruLog.loaded = true;
                resourceData.width = header.width;
                resourceData.height = header.height;
                resourceData.pixels = pixels;
                resourceData.isTopDown = header.isTopDown;
                // Save palette for 8-bit BMPs (needed for GetDIBColorTable)
                if (header.palette) {
                    resourceData.palette = header.palette;
                    Logger.verbose(LogCategory.USER32, `${apiName} BMP: Saved ${header.palette.length}-color palette for 8-bit BMP`);
                }
                // Preserve the raw palettized DIB rows so GetObject can expose a real
                // DIBSECTION (biBitCount==8, bmBits→8-bit data). Sprite loaders that pass
                // LR_CREATEDIBSECTION and require an 8-bit source (e.g. WA's frontend
                // FUN_00426290: GetObjectA(h,0x54) then reads dsBmih.biBitCount==8) need this;
                // the 32bpp `pixels` above is for GPU upload, not for guest bmBits reads.
                if (header.bitsPerPixel <= 8) {
                    resourceData.bitCount = header.bitsPerPixel;
                    resourceData.dibStride = header.rowSize;
                    resourceData.dibTopDown = header.isTopDown;
                    resourceData.dibBits = data.slice(header.offset, header.offset + header.rowSize * header.height);
                }
                resourceData.loading = false;
                Logger.verbose(LogCategory.USER32, `${apiName} BMP: Successfully loaded "${normalizedFilename}" ${header.width}x${header.height} -> handle=0x${handle.toString(16)}`);

                // Notify ddraw module if it exists to cache this texture
                const ddraw = system.process?.getModule("ddraw") as any;
                if (ddraw?.updateTextureFromBitmap) {
                    if (spruLog) spruLog.updateTextureFromBitmapCalled = true;
                    Logger.verbose(LogCategory.USER32, `${apiName}: Calling ddraw.updateTextureFromBitmap(handle=0x${handle.toString(16)})`);
                    ddraw.updateTextureFromBitmap(handle, resourceData);
                } else {
                    Logger.verbose(LogCategory.USER32, `${apiName}: ddraw module not found or updateTextureFromBitmap not available`);
                }
            } else {
                Logger.warn(LogCategory.USER32, `${apiName}: Failed to parse BMP - header=${!!header} pixels=${!!pixels}`);
            }
        } catch (e) {
            const err = (e as Error).message;
            if (spruLog) spruLog.error = err;
            Logger.warn(LogCategory.USER32, `${apiName} BMP: Error loading "${normalizedFilename}": ${e}`);
        } finally {
            resourceData.loading = false;
        }

        return handle;
    };

    // LoadImageA - load image, cursor, or icon
    exports["LoadImageA"] = async (ctx, mem, args) => loadImageCommon(ctx, mem, args, false);

    // LoadImageW - load image, cursor, or icon (wide)
    exports["LoadImageW"] = async (ctx, mem, args) => loadImageCommon(ctx, mem, args, true);

    // SetCursor - set cursor shape
    exports['SetCursor'] = (ctx, mem, args) => {
        const hCursor = args[0] >>> 0;
        // SetCursor(NULL) hides the pointer (SDL2 hides its cursor this way, never
        // calling ShowCursor). A non-NULL cursor is DRAWN by the system on real
        // Windows — custom images are forwarded to the host for rendering.
        const prev = installCursorAndUpdateHostVisibility(hCursor);
        Logger.verbose(LogCategory.USER32, `SetCursor(0x${hCursor.toString(16)}) -> prev=0x${prev.toString(16)}`);
        return prev;
    };

    // SystemParametersInfo - retrieves or sets system-wide parameters
    exports['SystemParametersInfoA'] = (ctx, mem, args) => {
        const uiAction = args[0];
        const uiParam = args[1];
        const pvParam = args[2];
        const fWinIni = args[3];
        Logger.verbose(LogCategory.USER32, `SystemParametersInfoA(action=0x${uiAction.toString(16)}, param=${uiParam}, pvParam=0x${pvParam.toString(16)}, fWinIni=0x${fWinIni.toString(16)})`);
        // Return TRUE for most queries to indicate success
        return 1;
    };
    exports['SystemParametersInfoW'] = exports['SystemParametersInfoA'];

    // ==================== Rect Functions ====================

    // IntersectRect - computes the intersection of two source rectangles
    // Returns TRUE if intersection is non-empty, FALSE otherwise
    exports['IntersectRect'] = (ctx, mem, args) => {
        const lprcDst = args[0];   // LPRECT - destination
        const lprcSrc1 = args[1];  // const RECT* - first source
        const lprcSrc2 = args[2];  // const RECT* - second source

        Logger.verbose(LogCategory.USER32, `IntersectRect(lprcDst=0x${lprcDst.toString(16)}, lprcSrc1=0x${lprcSrc1.toString(16)}, lprcSrc2=0x${lprcSrc2.toString(16)})`);

        if (!lprcDst || !lprcSrc1 || !lprcSrc2) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Read source rectangles (RECT: left, top, right, bottom - each 4 bytes)
        const left1 = view.getInt32(lprcSrc1, true);
        const top1 = view.getInt32(lprcSrc1 + 4, true);
        const right1 = view.getInt32(lprcSrc1 + 8, true);
        const bottom1 = view.getInt32(lprcSrc1 + 12, true);

        const left2 = view.getInt32(lprcSrc2, true);
        const top2 = view.getInt32(lprcSrc2 + 4, true);
        const right2 = view.getInt32(lprcSrc2 + 8, true);
        const bottom2 = view.getInt32(lprcSrc2 + 12, true);

        // Compute intersection
        const left = Math.max(left1, left2);
        const top = Math.max(top1, top2);
        const right = Math.min(right1, right2);
        const bottom = Math.min(bottom1, bottom2);

        // Check if intersection is valid (non-empty)
        if (left < right && top < bottom) {
            // Write intersection to destination
            view.setInt32(lprcDst, left, true);
            view.setInt32(lprcDst + 4, top, true);
            view.setInt32(lprcDst + 8, right, true);
            view.setInt32(lprcDst + 12, bottom, true);
            return 1; // TRUE - non-empty intersection
        } else {
            // Empty intersection - set destination to empty rect
            view.setInt32(lprcDst, 0, true);
            view.setInt32(lprcDst + 4, 0, true);
            view.setInt32(lprcDst + 8, 0, true);
            view.setInt32(lprcDst + 12, 0, true);
            return 0; // FALSE - empty intersection
        }
    };

    exports['SubtractRect'] = (ctx, mem, args) => {
        const lprcDst = args[0];
        const lprcSrc1 = args[1];
        const lprcSrc2 = args[2];

        Logger.verbose(LogCategory.USER32,
            `SubtractRect(lprcDst=0x${lprcDst.toString(16)}, lprcSrc1=0x${lprcSrc1.toString(16)}, lprcSrc2=0x${lprcSrc2.toString(16)})`);

        if (!lprcDst || !lprcSrc1 || !lprcSrc2) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const readRect = (ptr: number) => ({
            left: view.getInt32(ptr, true),
            top: view.getInt32(ptr + 4, true),
            right: view.getInt32(ptr + 8, true),
            bottom: view.getInt32(ptr + 12, true),
        });
        const writeRect = (ptr: number, r: { left: number; top: number; right: number; bottom: number }) => {
            view.setInt32(ptr, r.left, true);
            view.setInt32(ptr + 4, r.top, true);
            view.setInt32(ptr + 8, r.right, true);
            view.setInt32(ptr + 12, r.bottom, true);
        };
        const rectArea = (r: { left: number; top: number; right: number; bottom: number }) => {
            const w = r.right - r.left;
            const h = r.bottom - r.top;
            return w > 0 && h > 0 ? w * h : 0;
        };
        const emptyRect = { left: 0, top: 0, right: 0, bottom: 0 };

        const r1 = readRect(lprcSrc1);
        if (rectArea(r1) === 0) {
            writeRect(lprcDst, emptyRect);
            return 0;
        }

        const r2 = readRect(lprcSrc2);
        const overlapLeft = Math.max(r1.left, r2.left);
        const overlapTop = Math.max(r1.top, r2.top);
        const overlapRight = Math.min(r1.right, r2.right);
        const overlapBottom = Math.min(r1.bottom, r2.bottom);

        if (overlapLeft >= overlapRight || overlapTop >= overlapBottom) {
            writeRect(lprcDst, r1);
            return 1;
        }

        if (overlapLeft <= r1.left && overlapTop <= r1.top &&
            overlapRight >= r1.right && overlapBottom >= r1.bottom) {
            writeRect(lprcDst, emptyRect);
            return 0;
        }

        const candidates = [
            { left: r1.left, top: r1.top, right: r1.right, bottom: overlapTop },
            { left: r1.left, top: overlapBottom, right: r1.right, bottom: r1.bottom },
            { left: r1.left, top: overlapTop, right: overlapLeft, bottom: overlapBottom },
            { left: overlapRight, top: overlapTop, right: r1.right, bottom: overlapBottom },
        ];

        let best = emptyRect;
        let bestArea = 0;
        for (const candidate of candidates) {
            const area = rectArea(candidate);
            if (area > bestArea) {
                bestArea = area;
                best = candidate;
            }
        }

        if (bestArea === 0) {
            writeRect(lprcDst, emptyRect);
            return 0;
        }

        writeRect(lprcDst, best);
        return 1;
    };

    // CopyRect - copies the coordinates of one rectangle to another
    exports['CopyRect'] = (ctx, mem, args) => {
        const lprcDst = args[0];  // LPRECT - destination
        const lprcSrc = args[1];  // const RECT* - source

        Logger.verbose(LogCategory.USER32, `CopyRect(lprcDst=0x${lprcDst.toString(16)}, lprcSrc=0x${lprcSrc.toString(16)})`);

        if (!lprcDst || !lprcSrc) {
            return 0;
        }

        // Copy 16 bytes (4 ints)
        for (let i = 0; i < 16; i++) {
            mem[lprcDst + i] = mem[lprcSrc + i];
        }
        return 1; // TRUE
    };

    // SetRect - sets the coordinates of the specified rectangle
    exports['SetRect'] = (ctx, mem, args) => {
        const lprc = args[0];    // LPRECT
        const xLeft = args[1];   // int
        const yTop = args[2];    // int
        const xRight = args[3];  // int
        const yBottom = args[4]; // int

        Logger.verbose(LogCategory.USER32, `SetRect(lprc=0x${lprc.toString(16)}, left=${xLeft}, top=${yTop}, right=${xRight}, bottom=${yBottom})`);

        if (!lprc) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(lprc, xLeft, true);
        view.setInt32(lprc + 4, yTop, true);
        view.setInt32(lprc + 8, xRight, true);
        view.setInt32(lprc + 12, yBottom, true);
        return 1; // TRUE
    };

    // SetRectEmpty - creates an empty rectangle
    exports['SetRectEmpty'] = (ctx, mem, args) => {
        const lprc = args[0]; // LPRECT

        Logger.verbose(LogCategory.USER32, `SetRectEmpty(lprc=0x${lprc.toString(16)})`);

        if (!lprc) {
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(lprc, 0, true);
        view.setInt32(lprc + 4, 0, true);
        view.setInt32(lprc + 8, 0, true);
        view.setInt32(lprc + 12, 0, true);
        return 1; // TRUE
    };

    // LoadString - loads a string resource from the executable
    // RT_STRING resources are stored in bundles of 16 strings.
    // Bundle ID = (uID / 16) + 1. String index within bundle = uID % 16.
    // Each bundle entry: WORD length (in chars), WCHAR string[length].
    function loadStringFromPE(mem: Uint8Array, hInstance: number, uID: number): string | null {
        const moduleBase = hInstance || 0x00400000;
        const bundleId = ((uID >>> 0) >> 4) + 1;
        const stringIndex = (uID >>> 0) & 0xF;

        const entry = findResourceInPE(mem, moduleBase, 6 /* RT_STRING */, bundleId);
        if (!entry) return null;

        const dataAddr = entry.moduleBase + entry.dataRVA;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let pos = dataAddr;
        const endAddr = dataAddr + entry.size;

        for (let i = 0; i < 16 && pos + 2 <= endAddr; i++) {
            const len = view.getUint16(pos, true);
            pos += 2;
            if (i === stringIndex) {
                if (len === 0) return '';
                let str = '';
                for (let j = 0; j < len && pos + 2 <= endAddr; j++) {
                    str += String.fromCharCode(view.getUint16(pos, true));
                    pos += 2;
                }
                return str;
            }
            pos += len * 2; // skip this string's chars
        }
        return null;
    }

    exports['LoadStringA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const uID = args[1];
        const lpBuffer = args[2];
        const cchBufferMax = args[3];

        if (!lpBuffer || cchBufferMax <= 0) {
            return { value: 0, stackCleanup: 16 };
        }

        // Check if this is MSS32.DLL requesting string resource ID 1 (version string)
        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        let versionString: string | null = null;

        if (moduleRegistry && hInstance !== 0) {
            const module = moduleRegistry.getByBase(hInstance);
            if (module && module.name.toLowerCase().includes('mss') && uID === 1) {
                versionString = EMU_NATIVE_VIDEO_DLLS ? "3.50F" : "3.00";
                Logger.log(LogCategory.USER32, `LoadStringA: MSS32 version query (ID=${uID}) -> "${versionString}"`);
            }
        }

        // Try PE resource if no special override
        if (versionString === null) {
            versionString = loadStringFromPE(mem, hInstance, uID);
        }

        if (versionString === null || versionString.length === 0) {
            mem[lpBuffer] = 0;
            Logger.log(LogCategory.USER32, `LoadStringA(hInst=0x${hInstance.toString(16)}, uID=${uID}) -> 0 (not found)`);
            return { value: 0, stackCleanup: 16 };
        }

        const encoded = encodeAnsi(versionString);
        const writeLen = Math.min(encoded.length, cchBufferMax - 1);
        mem.set(encoded.subarray(0, writeLen), lpBuffer);
        mem[lpBuffer + writeLen] = 0;

        Logger.log(LogCategory.USER32, `LoadStringA(hInst=0x${hInstance.toString(16)}, uID=${uID}) -> ${writeLen} "${versionString.slice(0, 40)}"`);
        noteLoadStringForDialog(versionString);
        return { value: writeLen, stackCleanup: 16 };
    };

    exports['LoadStringW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const uID = args[1];
        const lpBuffer = args[2];
        const cchBufferMax = args[3];

        if (!lpBuffer || cchBufferMax <= 0) {
            return { value: 0, stackCleanup: 16 };
        }

        const str = loadStringFromPE(mem, hInstance, uID);
        if (str === null || str.length === 0) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(lpBuffer, 0, true);
            Logger.verbose(LogCategory.USER32, `LoadStringW(hInst=0x${hInstance.toString(16)}, uID=${uID}) -> 0 (not found)`);
            return { value: 0, stackCleanup: 16 };
        }

        const writeLen = Math.min(str.length, cchBufferMax - 1);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < writeLen; i++) {
            view.setUint16(lpBuffer + i * 2, str.charCodeAt(i), true);
        }
        view.setUint16(lpBuffer + writeLen * 2, 0, true);

        Logger.verbose(LogCategory.USER32, `LoadStringW(hInst=0x${hInstance.toString(16)}, uID=${uID}) -> ${writeLen} "${str.slice(0, 40)}"`);
        return { value: writeLen, stackCleanup: 16 };
    };

    exports['OpenClipboard'] = (ctx, mem, args) => {
        const hWndNewOwner = args[0] >>> 0;
        const ok = openClipboardState(hWndNewOwner);
        if (!ok) {
            System.getInstance().scheduler.setLastError(5); // ERROR_ACCESS_DENIED
            return 0;
        }
        System.getInstance().scheduler.setLastError(0);
        return 1;
    };

    exports['CloseClipboard'] = (ctx, mem, args) => {
        const ok = closeClipboardState();
        if (!ok) {
            System.getInstance().scheduler.setLastError(1418); // ERROR_CLIPBOARD_NOT_OPEN
            return 0;
        }
        System.getInstance().scheduler.setLastError(0);
        return 1;
    };

    // Bumped on every clipboard content change (EmptyClipboard/SetClipboardData),
    // mirroring the real counter's "changed since last check" contract.
    let clipboardSequence = 1;

    exports['EmptyClipboard'] = (ctx, mem, args) => {
        if (!isClipboardOpen()) {
            System.getInstance().scheduler.setLastError(1418); // ERROR_CLIPBOARD_NOT_OPEN
            return 0;
        }
        emptyClipboardState();
        clipboardSequence++;
        System.getInstance().scheduler.setLastError(0);
        return 1;
    };

    exports['SetClipboardData'] = (ctx, mem, args) => {
        const uFormat = args[0] >>> 0;
        const hMem = args[1] >>> 0;

        if (!isClipboardOpen()) {
            System.getInstance().scheduler.setLastError(1418); // ERROR_CLIPBOARD_NOT_OPEN
            return 0;
        }

        clipboardDataByFormat.set(uFormat, hMem);
        clipboardSequence++;
        System.getInstance().scheduler.setLastError(0);
        return hMem;
    };

    exports['GetClipboardSequenceNumber'] = () => clipboardSequence;

    exports['GetClipboardData'] = (ctx, mem, args) => {
        const uFormat = args[0] >>> 0;

        if (!isClipboardOpen()) {
            System.getInstance().scheduler.setLastError(1418); // ERROR_CLIPBOARD_NOT_OPEN
            return 0;
        }

        const value = clipboardDataByFormat.get(uFormat) ?? 0;
        if (!value) {
            System.getInstance().scheduler.setLastError(0);
            return 0;
        }

        System.getInstance().scheduler.setLastError(0);
        return value >>> 0;
    };

    exports['IsClipboardFormatAvailable'] = (ctx, mem, args) => {
        const uFormat = args[0] >>> 0;
        return clipboardDataByFormat.has(uFormat) ? 1 : 0;
    };

    exports['CountClipboardFormats'] = (ctx, mem, args) => {
        const count = clipboardDataByFormat.size;
        Logger.verbose(LogCategory.USER32, `CountClipboardFormats() -> ${count}`);
        return count;
    };

    const registerClipboardFormatByName = (formatName: string): number => {
        const normalized = formatName.trim().toLowerCase();
        if (!normalized) {
            System.getInstance().scheduler.setLastError(87); // ERROR_INVALID_PARAMETER
            return 0;
        }

        const existing = registeredClipboardFormats.get(normalized);
        if (existing) {
            System.getInstance().scheduler.setLastError(0);
            return existing >>> 0;
        }

        if (nextRegisteredClipboardFormat > 0xFFFF) {
            System.getInstance().scheduler.setLastError(8); // ERROR_NOT_ENOUGH_MEMORY
            return 0;
        }

        const id = nextRegisteredClipboardFormat++ >>> 0;
        registeredClipboardFormats.set(normalized, id);
        System.getInstance().scheduler.setLastError(0);
        return id;
    };

    exports['RegisterClipboardFormatA'] = (ctx, mem, args) => {
        const lpszFormat = args[0] >>> 0;
        const formatName = lpszFormat ? Marshaler.readString(mem, lpszFormat) : '';
        const id = registerClipboardFormatByName(formatName);
        Logger.verbose(LogCategory.USER32, `RegisterClipboardFormatA("${formatName}") -> 0x${id.toString(16)}`);
        return id;
    };

    exports['RegisterClipboardFormatW'] = (ctx, mem, args) => {
        const lpszFormat = args[0] >>> 0;
        const formatName = lpszFormat ? Marshaler.readWideString(mem, lpszFormat) : '';
        const id = registerClipboardFormatByName(formatName);
        Logger.verbose(LogCategory.USER32, `RegisterClipboardFormatW("${formatName}") -> 0x${id.toString(16)}`);
        return id;
    };

    exports['GetSysColor'] = (ctx, mem, args) => {
        const nIndex = args[0];
        const color = sysColors.get(nIndex) ?? 0xFFFFFF; // default white
        Logger.verbose(LogCategory.USER32, `GetSysColor(${nIndex}) -> 0x${color.toString(16)}`);
        return color;
    };

    exports['GetSysColorBrush'] = (ctx, mem, args) => {
        const nIndex = args[0];
        Logger.verbose(LogCategory.USER32, `GetSysColorBrush(${nIndex})`);
        return 0x1000 + nIndex; // Return a dummy brush handle
    };

    // BOOL SetSysColors(int cElements, const INT *lpaElements, const COLORREF *lpaRgbValues)
    // Updates the system color table. Returns TRUE on success.
    exports['SetSysColors'] = (ctx, mem, args) => {
        const cElements    = args[0] | 0;
        const lpaElements  = args[1] >>> 0;
        const lpaRgbValues = args[2] >>> 0;

        if (cElements <= 0 || !lpaElements || !lpaRgbValues) {
            return { value: 1, stackCleanup: 12 }; // Nothing to do, still TRUE
        }

        if (lpaElements  + cElements * 4 > mem.length ||
            lpaRgbValues + cElements * 4 > mem.length) {
            return { value: 0, stackCleanup: 12 }; // Bad pointers
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < cElements; i++) {
            const index = view.getInt32(lpaElements  + i * 4, true);
            const color = view.getUint32(lpaRgbValues + i * 4, true) & 0x00FFFFFF;
            sysColors.set(index, color);
            Logger.verbose(LogCategory.USER32,
                `SetSysColors: index=${index} color=0x${color.toString(16).padStart(6, '0')}`);
        }

        return { value: 1, stackCleanup: 12 }; // TRUE
    };

    exports['ChangeDisplaySettingsA'] = (_ctx, mem, args) => {
        const lpDevMode = args[0] >>> 0;
        const dwFlags = args[1] >>> 0;
        Logger.log(LogCategory.USER32, `ChangeDisplaySettingsA(0x${lpDevMode.toString(16)}, 0x${dwFlags.toString(16)})`);
        return applyChangeDisplaySettings(mem, lpDevMode, dwFlags, DEVMODEA_OFFSETS, "ChangeDisplaySettingsA");
    };

    exports['ChangeDisplaySettingsW'] = (_ctx, mem, args) => {
        const lpDevMode = args[0] >>> 0;
        const dwFlags = args[1] >>> 0;
        Logger.log(LogCategory.USER32, `ChangeDisplaySettingsW(0x${lpDevMode.toString(16)}, 0x${dwFlags.toString(16)})`);
        return applyChangeDisplaySettings(mem, lpDevMode, dwFlags, DEVMODEW_OFFSETS, "ChangeDisplaySettingsW");
    };

    exports['ChangeDisplaySettingsExA'] = (_ctx, mem, args) => {
        const lpszDeviceName = args[0] >>> 0;
        const lpDevMode = args[1] >>> 0;
        const hwnd = args[2] >>> 0;
        const dwFlags = args[3] >>> 0;
        const lParam = args[4] >>> 0;
        void hwnd; void lParam;
        Logger.verbose(LogCategory.USER32, `ChangeDisplaySettingsExA(dev=0x${lpszDeviceName.toString(16)}, dm=0x${lpDevMode.toString(16)}, flags=0x${dwFlags.toString(16)})`);
        return applyChangeDisplaySettings(mem, lpDevMode, dwFlags, DEVMODEA_OFFSETS, "ChangeDisplaySettingsExA");
    };

    exports['ChangeDisplaySettingsExW'] = (_ctx, mem, args) => {
        const lpszDeviceName = args[0] >>> 0;
        const lpDevMode = args[1] >>> 0;
        const hwnd = args[2] >>> 0;
        const dwFlags = args[3] >>> 0;
        const lParam = args[4] >>> 0;
        void hwnd; void lParam;
        Logger.verbose(LogCategory.USER32, `ChangeDisplaySettingsExW(dev=0x${lpszDeviceName.toString(16)}, dm=0x${lpDevMode.toString(16)}, flags=0x${dwFlags.toString(16)})`);
        return applyChangeDisplaySettings(mem, lpDevMode, dwFlags, DEVMODEW_OFFSETS, "ChangeDisplaySettingsExW");
    };

    const DEVMODEA_OFFSETS = {
        dmSpecVersion: 32,
        dmDriverVersion: 34,
        dmSize: 36,
        dmFields: 40,
        dmBitsPerPel: 104,
        dmPelsWidth: 108,
        dmPelsHeight: 112,
        dmDisplayFlags: 116,
        dmDisplayFrequency: 120,
        minSize: 124,
    };
    const DEVMODEW_OFFSETS = {
        dmSpecVersion: 64,
        dmDriverVersion: 66,
        dmSize: 68,
        dmFields: 72,
        dmBitsPerPel: 168,
        dmPelsWidth: 172,
        dmPelsHeight: 176,
        dmDisplayFlags: 180,
        dmDisplayFrequency: 184,
        minSize: 188,
    };
    type DevModeOffsets = typeof DEVMODEA_OFFSETS;
    const DM_BITSPERPEL = 0x00040000;
    const DM_PELSWIDTH  = 0x00080000;
    const DM_PELSHEIGHT = 0x00100000;
    const DM_DISPLAYFREQUENCY = 0x00400000;
    const DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001;
    const DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004;

    const fillDevMode = (lpDevMode: number, mode: DisplayMode, offsets: DevModeOffsets): boolean => {
        const existingSize = Mem.readUint16(lpDevMode + offsets.dmSize) ?? 0;
        if (existingSize === 0 && !Mem.writeUint16(lpDevMode + offsets.dmSize, offsets.minSize)) {
            return false;
        }

        return (
            Mem.writeUint16(lpDevMode + offsets.dmSpecVersion, 0x0401) &&
            Mem.writeUint16(lpDevMode + offsets.dmDriverVersion, 0x0401) &&
            Mem.writeUint32(lpDevMode + offsets.dmFields, DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY) &&
            Mem.writeUint32(lpDevMode + offsets.dmBitsPerPel, mode.bpp >>> 0) &&
            Mem.writeUint32(lpDevMode + offsets.dmPelsWidth, mode.width >>> 0) &&
            Mem.writeUint32(lpDevMode + offsets.dmPelsHeight, mode.height >>> 0) &&
            Mem.writeUint32(lpDevMode + offsets.dmDisplayFlags, 0) &&
            Mem.writeUint32(lpDevMode + offsets.dmDisplayFrequency, normalizeRefreshRate(mode.refreshRate))
        );
    };

    const getDisplayModes = (): DisplayMode[] => {
        const configuredModes = EmulatorConfig.getInstance().supportedResolutions;
        if (!configuredModes || configuredModes.length === 0) {
            return [
                { width: 640, height: 480, bpp: 16, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 640, height: 480, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 800, height: 600, bpp: 16, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 800, height: 600, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1024, height: 768, bpp: 16, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1024, height: 768, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1152, height: 864, bpp: 16, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1152, height: 864, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1280, height: 960, bpp: 16, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1280, height: 960, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1280, height: 1024, bpp: 16, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1280, height: 1024, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1600, height: 1200, bpp: 16, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1600, height: 1200, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1280, height: 720, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
                { width: 1920, height: 1080, bpp: 32, refreshRate: DEFAULT_DISPLAY_REFRESH_RATE },
            ];
        }
        return configuredModes.map((mode) => ({
            width: mode.width,
            height: mode.height,
            bpp: mode.bpp,
            refreshRate: normalizeRefreshRate(mode.refreshRate),
        }));
    };

    const enumDisplaySettings = (mem: Uint8Array, args: number[], offsets: DevModeOffsets, apiName: string): number => {
        const lpszDeviceName = args[0];
        const iModeNum = args[1] >>> 0;
        const lpDevMode = args[2];

        Logger.log(LogCategory.USER32, `${apiName}(dev=0x${lpszDeviceName.toString(16)}, mode=${iModeNum}, dm=0x${lpDevMode.toString(16)})`);

        const ENUM_CURRENT_SETTINGS = 0xFFFFFFFF;
        const ENUM_REGISTRY_SETTINGS = 0xFFFFFFFE;
        if (!lpDevMode || lpDevMode + offsets.minSize > mem.length) return 0;

        if (iModeNum === ENUM_CURRENT_SETTINGS || iModeNum === ENUM_REGISTRY_SETTINGS) {
            const currentMode = getCurrentScreenMode();
            const ok = fillDevMode(lpDevMode, currentMode, offsets);
            Logger.log(
                LogCategory.USER32,
                `${apiName}: current -> ${currentMode.width}x${currentMode.height}x${currentMode.bpp} ${normalizeRefreshRate(currentMode.refreshRate)}Hz ${ok ? 'OK' : 'FAIL'}`
            );
            return ok ? 1 : 0;
        }

        const displayModes = getDisplayModes();
        if (iModeNum < displayModes.length) {
            const mode = displayModes[iModeNum];
            const ok = fillDevMode(lpDevMode, mode, offsets);
            Logger.log(
                LogCategory.USER32,
                `${apiName}: mode[${iModeNum}] -> ${mode.width}x${mode.height}x${mode.bpp} ${normalizeRefreshRate(mode.refreshRate)}Hz ${ok ? 'OK' : 'FAIL'}`
            );
            return ok ? 1 : 0;
        }

        return 0; // FALSE - no more modes
    };

    // ChangeDisplaySettings flags / return codes.
    const CDS_TEST = 0x00000002;
    const DISP_CHANGE_SUCCESSFUL = 0;
    const DISP_CHANGE_BADMODE = -2;

    const isSupportedMode = (width: number, height: number, bpp: number): boolean => {
        return getDisplayModes().some((m) =>
            m.width === width &&
            m.height === height &&
            (bpp === 0 || m.bpp === bpp)
        );
    };

    /**
     * Apply a display-mode change requested via ChangeDisplaySettings*. Faithful contract:
     *  - lpDevMode == NULL  → restore to the desktop (registry) mode.
     *  - CDS_TEST           → validate against supported modes, return BADMODE/SUCCESSFUL,
     *                         WITHOUT applying.
     *  - otherwise apply: update the DDraw display mode, resize the host, and broadcast
     *    WM_DISPLAYCHANGE (so EnumDisplaySettings(ENUM_CURRENT_SETTINGS)/SM_CXSCREEN reflect it).
     */
    const applyChangeDisplaySettings = (
        mem: Uint8Array,
        lpDevMode: number,
        dwFlags: number,
        offsets: DevModeOffsets,
        apiName: string
    ): number => {
        const system = System.getInstance();
        const ddraw = system.ddrawContext;

        const applyMode = (width: number, height: number, bpp: number, refresh: number, isRestore: boolean): void => {
            if (ddraw) {
                if (width > 0 && height > 0) {
                    ddraw.display.width = width;
                    ddraw.display.height = height;
                }
                if (bpp > 0) ddraw.display.bpp = bpp;
                if (refresh > 0) ddraw.display.refresh = refresh;
                if (isRestore) {
                    ddraw.cooperative.exclusive = false;
                }
            }
            const w = ddraw?.display.width ?? width;
            const h = ddraw?.display.height ?? height;
            const b = ddraw?.display.bpp ?? bpp;
            system.requestHostResize(w, h);
            system.windowManager.postDisplayChange(w, h, b);
            Logger.log(LogCategory.USER32, `${apiName}: applied ${w}x${h}x${b} (restore=${isRestore})`);
        };

        // lpDevMode == NULL → restore to the desktop mode.
        if (!lpDevMode) {
            const desktop = ddraw
                ? { width: ddraw.desktopMode.width, height: ddraw.desktopMode.height, bpp: ddraw.desktopMode.bpp, refreshRate: ddraw.desktopMode.refresh }
                : getCurrentScreenMode();
            if ((dwFlags & CDS_TEST) !== 0) return DISP_CHANGE_SUCCESSFUL;
            applyMode(desktop.width, desktop.height, desktop.bpp, normalizeRefreshRate(desktop.refreshRate), true);
            return DISP_CHANGE_SUCCESSFUL;
        }

        if (lpDevMode + offsets.minSize > mem.length) return DISP_CHANGE_BADMODE;

        const dmFields = Mem.readUint32(lpDevMode + offsets.dmFields) ?? 0;
        const reqWidth  = (dmFields & DM_PELSWIDTH)  ? (Mem.readUint32(lpDevMode + offsets.dmPelsWidth) ?? 0) : 0;
        const reqHeight = (dmFields & DM_PELSHEIGHT) ? (Mem.readUint32(lpDevMode + offsets.dmPelsHeight) ?? 0) : 0;
        const reqBpp    = (dmFields & DM_BITSPERPEL) ? (Mem.readUint32(lpDevMode + offsets.dmBitsPerPel) ?? 0) : 0;
        const reqHz     = (dmFields & DM_DISPLAYFREQUENCY) ? (Mem.readUint32(lpDevMode + offsets.dmDisplayFrequency) ?? 0) : 0;

        Logger.log(LogCategory.USER32,
            `${apiName}: request fields=0x${dmFields.toString(16)} ${reqWidth}x${reqHeight}x${reqBpp} ${reqHz}Hz`);

        // Fall back to the current mode for any unspecified dimension so validation is sane.
        const cur = getCurrentScreenMode();
        const effWidth  = reqWidth  || cur.width;
        const effHeight = reqHeight || cur.height;
        const effBpp    = reqBpp    || cur.bpp;

        if (!isSupportedMode(effWidth, effHeight, reqBpp)) {
            Logger.warn(LogCategory.USER32, `${apiName}: unsupported mode ${effWidth}x${effHeight}x${reqBpp} -> DISP_CHANGE_BADMODE`);
            return DISP_CHANGE_BADMODE;
        }

        if ((dwFlags & CDS_TEST) !== 0) {
            // Validate only — do NOT apply.
            return DISP_CHANGE_SUCCESSFUL;
        }

        applyMode(effWidth, effHeight, effBpp, normalizeRefreshRate(reqHz || cur.refreshRate), false);
        return DISP_CHANGE_SUCCESSFUL;
    };

    exports['EnumDisplaySettingsA'] = (_ctx, mem, args) => {
        return enumDisplaySettings(mem, args, DEVMODEA_OFFSETS, "EnumDisplaySettingsA");
    };

    exports['EnumDisplaySettingsW'] = (_ctx, mem, args) => {
        return enumDisplaySettings(mem, args, DEVMODEW_OFFSETS, "EnumDisplaySettingsW");
    };

    exports['EnumDisplaySettingsExA'] = (ctx, mem, args) => {
        const lpszDeviceName = args[0];
        const iModeNum = args[1];
        const lpDevMode = args[2];
        const dwFlags = args[3];

        Logger.log(LogCategory.USER32, `EnumDisplaySettingsExA(dev=0x${lpszDeviceName.toString(16)}, mode=${iModeNum}, dm=0x${lpDevMode.toString(16)}, flags=0x${dwFlags.toString(16)})`);

        // flags are ignored in our single-display model.
        return enumDisplaySettings(mem, [lpszDeviceName, iModeNum, lpDevMode], DEVMODEA_OFFSETS, "EnumDisplaySettingsExA");
    };

    exports['EnumDisplaySettingsExW'] = (_ctx, mem, args) => {
        const lpszDeviceName = args[0];
        const iModeNum = args[1];
        const lpDevMode = args[2];
        const dwFlags = args[3];

        Logger.log(LogCategory.USER32, `EnumDisplaySettingsExW(dev=0x${lpszDeviceName.toString(16)}, mode=${iModeNum}, dm=0x${lpDevMode.toString(16)}, flags=0x${dwFlags.toString(16)})`);

        return enumDisplaySettings(mem, [lpszDeviceName, iModeNum, lpDevMode], DEVMODEW_OFFSETS, "EnumDisplaySettingsExW");
    };

    exports['EnumDisplayDevicesA'] = (ctx, mem, args) => {
        const lpDevice = args[0] >>> 0;
        const iDevNum = args[1] >>> 0;
        const lpDisplayDevice = args[2] >>> 0;
        const dwFlags = args[3] >>> 0;

        Logger.verbose(LogCategory.USER32,
            `EnumDisplayDevicesA(dev=0x${lpDevice.toString(16)}, index=${iDevNum}, dd=0x${lpDisplayDevice.toString(16)}, flags=0x${dwFlags.toString(16)})`);

        if (!lpDisplayDevice || lpDisplayDevice + 4 > mem.length) return 0;
        if (iDevNum !== 0) return 0; // single display model

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cb = view.getUint32(lpDisplayDevice, true) >>> 0;
        if (cb < 168) return 0;

        const maxSize = Math.min(cb, mem.length - lpDisplayDevice);
        mem.fill(0, lpDisplayDevice, lpDisplayDevice + maxSize);
        view.setUint32(lpDisplayDevice, cb, true); // preserve caller-declared size

        // DISPLAY_DEVICEA layout:
        // 0: cb, 4: DeviceName[32], 36: DeviceString[128], 164: StateFlags,
        // 168: DeviceID[128], 296: DeviceKey[128]
        Marshaler.writeString(mem, lpDisplayDevice + 4, "\\\\.\\DISPLAY1", 32);
        Marshaler.writeString(mem, lpDisplayDevice + 36, "BottleShip Display Adapter", 128);
        view.setUint32(
            lpDisplayDevice + 164,
            DISPLAY_DEVICE_ATTACHED_TO_DESKTOP | DISPLAY_DEVICE_PRIMARY_DEVICE,
            true
        );
        if (cb >= 296) {
            Marshaler.writeString(mem, lpDisplayDevice + 168, "PCI\\VEN_1414&DEV_008C", 128);
        }
        if (cb >= 424) {
            Marshaler.writeString(
                mem,
                lpDisplayDevice + 296,
                "\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{BOTTLESHIP}\\0000",
                128
            );
        }

        return 1;
    };

    exports['EnumDisplayDevicesW'] = (ctx, mem, args) => {
        const lpDevice = args[0] >>> 0;
        const iDevNum = args[1] >>> 0;
        const lpDisplayDevice = args[2] >>> 0;
        const dwFlags = args[3] >>> 0;

        Logger.verbose(LogCategory.USER32,
            `EnumDisplayDevicesW(dev=0x${lpDevice.toString(16)}, index=${iDevNum}, dd=0x${lpDisplayDevice.toString(16)}, flags=0x${dwFlags.toString(16)})`);

        if (!lpDisplayDevice || lpDisplayDevice + 4 > mem.length) return 0;
        if (iDevNum !== 0) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cb = view.getUint32(lpDisplayDevice, true) >>> 0;
        if (cb < 328) return 0;

        const maxSize = Math.min(cb, mem.length - lpDisplayDevice);
        mem.fill(0, lpDisplayDevice, lpDisplayDevice + maxSize);
        view.setUint32(lpDisplayDevice, cb, true);

        // DISPLAY_DEVICEW layout:
        // 0: cb, 4: DeviceName[32], 68: DeviceString[128], 324: StateFlags,
        // 328: DeviceID[128], 584: DeviceKey[128]
        Marshaler.writeWideString(mem, lpDisplayDevice + 4, "\\\\.\\DISPLAY1", 32);
        Marshaler.writeWideString(mem, lpDisplayDevice + 68, "BottleShip Display Adapter", 128);
        view.setUint32(
            lpDisplayDevice + 324,
            DISPLAY_DEVICE_ATTACHED_TO_DESKTOP | DISPLAY_DEVICE_PRIMARY_DEVICE,
            true
        );
        if (cb >= 584) {
            Marshaler.writeWideString(mem, lpDisplayDevice + 328, "PCI\\VEN_1414&DEV_008C", 128);
        }
        if (cb >= 840) {
            Marshaler.writeWideString(
                mem,
                lpDisplayDevice + 584,
                "\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{BOTTLESHIP}\\0000",
                128
            );
        }

        return 1;
    };

    exports['GetMessageTime'] = (ctx, mem, args) => {
        const system = System.getInstance();
        const time = system.windowManager.getLastMessageTime();
        Logger.verbose(LogCategory.USER32, `GetMessageTime() -> ${time}`);
        return time;
    };

    exports['GetMessagePos'] = (ctx, mem, args) => {
        const system = System.getInstance();
        const pos = system.windowManager.getLastMessagePos();
        Logger.verbose(LogCategory.USER32, `GetMessagePos() -> x=${pos & 0xFFFF}, y=${(pos >>> 16) & 0xFFFF}`);
        return pos;
    };

    exports['RegisterWindowMessageA'] = (ctx, mem, args) => {
        const lpString = args[0];
        const msgName = lpString ? Marshaler.readString(mem, lpString) : '';
        Logger.verbose(LogCategory.USER32, `RegisterWindowMessageA("${msgName}")`);
        // Return a unique message ID (0xC000-0xFFFF range for registered messages)
        const hash = msgName.length > 0 ? (msgName.charCodeAt(0) % 0x4000) : 0;
        return 0xC000 + hash;
    };

    exports['RegisterWindowMessageW'] = (ctx, mem, args) => {
        const lpString = args[0];
        const msgName = lpString ? Marshaler.readWideString(mem, lpString) : '';
        Logger.verbose(LogCategory.USER32, `RegisterWindowMessageW("${msgName}")`);
        const hash = msgName.length > 0 ? (msgName.charCodeAt(0) % 0x4000) : 0;
        return 0xC000 + hash;
    };

    exports['CharNextA'] = (_ctx, _mem, args) => {
        const lpsz = args[0];
        // Simple: advance by 1 byte unless at NUL terminator (no DBCS support)
        return (lpsz && lpsz < _mem.length && _mem[lpsz] !== 0) ? lpsz + 1 : lpsz;
    };

    // DWORD CharUpperBuffA(LPSTR lpsz, DWORD cchLength)
    exports['CharUpperBuffA'] = (ctx, mem, args) => {
        const lpsz = args[0] >>> 0;
        const cchLength = args[1] >>> 0;
        if (!lpsz || lpsz + cchLength > mem.length) return 0;
        let processed = 0;
        for (let i = 0; i < cchLength; i++) {
            const ch = mem[lpsz + i];
            if (ch >= 0x61 && ch <= 0x7A) { // a-z
                mem[lpsz + i] = ch - 0x20;
            }
            processed++;
        }
        return processed;
    };

    // DWORD CharLowerBuffA(LPSTR lpsz, DWORD cchLength)
    exports['CharLowerBuffA'] = (ctx, mem, args) => {
        const lpsz = args[0] >>> 0;
        const cchLength = args[1] >>> 0;
        if (!lpsz || lpsz + cchLength > mem.length) return 0;
        let processed = 0;
        for (let i = 0; i < cchLength; i++) {
            const ch = mem[lpsz + i];
            if (ch >= 0x41 && ch <= 0x5A) { // A-Z
                mem[lpsz + i] = ch + 0x20;
            }
            processed++;
        }
        return processed;
    };

    // BOOL CharToOemBuffA(LPCSTR lpszSrc, LPSTR lpszDst, DWORD cchDstLength)
    // For ASCII range, OEM and ANSI are identical (code page 437 ≈ Latin-1 for 0x00-0x7F)
    exports['CharToOemBuffA'] = (ctx, mem, args) => {
        const lpszSrc = args[0] >>> 0;
        const lpszDst = args[1] >>> 0;
        const cchDstLength = args[2] >>> 0;
        if (!lpszSrc || !lpszDst) return 0;
        // Simple copy — for games using ASCII range this is sufficient
        for (let i = 0; i < cchDstLength; i++) {
            mem[lpszDst + i] = mem[lpszSrc + i];
        }
        return 1; // TRUE
    };

    // BOOL CharToOemA(LPCSTR lpszSrc, LPSTR lpszDst)
    exports['CharToOemA'] = (ctx, mem, args) => {
        const lpszSrc = args[0] >>> 0;
        const lpszDst = args[1] >>> 0;
        if (!lpszSrc || !lpszDst) return 0;
        const cfg = EmulatorConfig.getInstance();
        let srcLen = 0;
        while (lpszSrc + srcLen < mem.length && mem[lpszSrc + srcLen] !== 0) srcLen++;
        const text = decodeAnsiString(mem, lpszSrc, srcLen, cfg.ansiCodePage);
        const encoded = encodeAnsiString(text, cfg.oemCodePage);
        if (lpszDst + encoded.length + 1 > mem.length) return 0;
        mem.set(encoded, lpszDst);
        mem[lpszDst + encoded.length] = 0;
        return 1;
    };

    // BOOL OemToCharA(LPCSTR lpszSrc, LPSTR lpszDst)
    exports['OemToCharA'] = (ctx, mem, args) => {
        const lpszSrc = args[0] >>> 0;
        const lpszDst = args[1] >>> 0;
        if (!lpszSrc || !lpszDst) return 0;
        const cfg = EmulatorConfig.getInstance();
        let srcLen = 0;
        while (lpszSrc + srcLen < mem.length && mem[lpszSrc + srcLen] !== 0) srcLen++;
        const text = decodeAnsiString(mem, lpszSrc, srcLen, cfg.oemCodePage);
        writeAnsiToGuest(mem, lpszDst, text);
        return 1;
    };

    // BOOL TrackMouseEvent(LPTRACKMOUSEEVENT lpEventTrack)
    // struct TRACKMOUSEEVENT { DWORD cbSize; DWORD dwFlags; HWND hwndTrack; DWORD dwHoverTime; }
    exports['TrackMouseEvent'] = (ctx, mem, args) => {
        const lpEventTrack = args[0] >>> 0;
        if (lpEventTrack && lpEventTrack + 16 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const cbSize = view.getUint32(lpEventTrack + 0, true);
            if (cbSize >= 16) {
                const dwFlags    = view.getUint32(lpEventTrack + 4,  true);
                const hwndTrack  = view.getUint32(lpEventTrack + 8,  true);
                const dwHoverTime = view.getUint32(lpEventTrack + 12, true);
                System.getInstance().inputManager.trackMouseEvent(hwndTrack, dwFlags, dwHoverTime);
            }
        }
        return 1; // TRUE
    };

    // BOOL SwapMouseButton(BOOL fSwap)
    exports['SwapMouseButton'] = (ctx, mem, args) => {
        const previous = mouseButtonsSwapped ? 1 : 0;
        mouseButtonsSwapped = (args[0] >>> 0) !== 0;
        return previous;
    };

    exports['GetGUIThreadInfo'] = (ctx, mem, args) => {
        const lpgui = args[1] >>> 0;
        if (lpgui && lpgui + 48 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const active = System.getInstance().windowManager.getActiveHwnd() >>> 0;
            view.setUint32(lpgui + 0, 48, true); // cbSize
            view.setUint32(lpgui + 4, 0, true);  // flags
            view.setUint32(lpgui + 8, active, true); // hwndActive
            view.setUint32(lpgui + 12, active, true); // hwndFocus
            view.setUint32(lpgui + 16, getCaptureState(), true); // hwndCapture
            view.setUint32(lpgui + 20, 0, true); // hwndMenuOwner
            view.setUint32(lpgui + 24, 0, true); // hwndMoveSize
            view.setUint32(lpgui + 28, 0, true); // hwndCaret
            view.setInt32(lpgui + 32, 0, true); // rcCaret.left
            view.setInt32(lpgui + 36, 0, true); // rcCaret.top
            view.setInt32(lpgui + 40, 0, true); // rcCaret.right
            view.setInt32(lpgui + 44, 0, true); // rcCaret.bottom
        }
        return 1;
    };

    exports['SetWinEventHook'] = () => 1;
    exports['NotifyWinEvent'] = () => 0;
    exports['GetCaretBlinkTime'] = () => 530;
    exports['GetDoubleClickTime'] = () => doubleClickTimeMs;
    exports['SetDoubleClickTime'] = (ctx, mem, args) => {
        const interval = args[0] >>> 0;
        if (interval < 4 || interval > 5000) return 0;
        doubleClickTimeMs = interval;
        return 1;
    };
    exports['EnumWindows'] = () => 1;
    exports['WindowFromDC'] = () => 0;
    exports['DisableProcessWindowsGhosting'] = () => 0;

    exports['GetCursorInfo'] = (ctx, mem, args) => {
        const pci = args[0] >>> 0;
        if (pci && pci + 20 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const mouseState = System.getInstance().inputManager.getMouseState();
            view.setUint32(pci + 0, 20, true); // cbSize
            view.setUint32(pci + 4, 1, true); // flags (CURSOR_SHOWING)
            view.setUint32(pci + 8, 0x100, true); // hCursor
            view.setInt32(pci + 12, mouseState.x, true);
            view.setInt32(pci + 16, mouseState.y, true);
        }
        return 1;
    };

    exports['CreateCursor'] = () => 0x100;
    exports['GetCursor'] = () => 0x100;
    exports['DestroyCursor'] = () => 1;
    exports['DestroyIcon'] = () => 1;

    exports['GetClipCursor'] = (ctx, mem, args) => {
        const lpRect = args[0] >>> 0;
        if (lpRect && lpRect + 16 <= mem.length) {
            const mode = getCurrentScreenMode();
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpRect + 0, 0, true);
            view.setInt32(lpRect + 4, 0, true);
            view.setInt32(lpRect + 8, mode.width, true);
            view.setInt32(lpRect + 12, mode.height, true);
        }
        return 1;
    };

    exports['GetDCEx'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const gdi = System.getInstance().gdiContext;
        const win = hWnd ? windows.get(hWnd) : undefined;
        if (!win) {
            return gdi.createDC();
        }
        const { x, y } = getAbsoluteWindowPosition(win);
        const hdc = gdi.createSizedMemoryDC(win.width, win.height);
        if (!hdc) return 0;
        gdi.attachWindowBlit(hdc, x, y, win.width, win.height);
        gdi.seedMemoryDCFromOverlay(hdc);
        Logger.verbose(LogCategory.USER32,
            `GetDCEx(0x${hWnd.toString(16)}) -> 0x${hdc.toString(16)}`);
        return hdc;
    };

    exports['MonitorFromWindow'] = () => 1;
    exports['MonitorFromPoint'] = () => 1;
    exports['MonitorFromRect'] = () => 1;

    const writeMonitorInfo = (mem: Uint8Array, pmi: number, wide: boolean): boolean => {
        if (!pmi || pmi + 40 > mem.length) return false;
        const mode = getCurrentScreenMode();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cbSize = view.getUint32(pmi, true);
        if (cbSize < 40) return false;
        view.setInt32(pmi + 4, 0, true);    // rcMonitor.left
        view.setInt32(pmi + 8, 0, true);    // rcMonitor.top
        view.setInt32(pmi + 12, mode.width, true); // rcMonitor.right
        view.setInt32(pmi + 16, mode.height, true);  // rcMonitor.bottom
        view.setInt32(pmi + 20, 0, true);    // rcWork.left
        view.setInt32(pmi + 24, 0, true);    // rcWork.top
        view.setInt32(pmi + 28, mode.width, true); // rcWork.right
        view.setInt32(pmi + 32, mode.height, true);  // rcWork.bottom
        view.setUint32(pmi + 36, 1, true);   // MONITORINFOF_PRIMARY
        if (cbSize >= (wide ? 72 : 40 + 32)) {
            const name = "\\\\.\\DISPLAY1";
            if (wide) {
                Marshaler.writeWideString(mem, pmi + 40, name, 32);
            } else {
                Marshaler.writeString(mem, pmi + 40, name, 32);
            }
        }
        return true;
    };

    exports['GetMonitorInfoA'] = (ctx, mem, args) => writeMonitorInfo(mem, args[1] >>> 0, false) ? 1 : 0;
    exports['GetMonitorInfoW'] = (ctx, mem, args) => writeMonitorInfo(mem, args[1] >>> 0, true) ? 1 : 0;

    // BOOL EnumDisplayMonitors(HDC hdc, LPCRECT lprcClip, MONITORENUMPROC lpfnEnum, LPARAM dwData)
    exports['EnumDisplayMonitors'] = (ctx, mem, args) => {
        const hdc = args[0] >>> 0;
        const lprcClip = args[1] >>> 0;
        const lpfnEnum = args[2] >>> 0;
        const dwData = args[3] >>> 0;
        if (!lpfnEnum) return 0;

        const process = System.getInstance().process;
        const callbackManager = process?.dispatcher?.callbackManager;
        if (!callbackManager) return 0;

        const mode = getCurrentScreenMode();
        let left = 0;
        let top = 0;
        let right = mode.width;
        let bottom = mode.height;
        if (lprcClip && lprcClip + 16 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const cl = view.getInt32(lprcClip, true);
            const ct = view.getInt32(lprcClip + 4, true);
            const cr = view.getInt32(lprcClip + 8, true);
            const cb = view.getInt32(lprcClip + 12, true);
            if (cr > cl && cb > ct) {
                left = Math.max(left, cl);
                top = Math.max(top, ct);
                right = Math.min(right, cr);
                bottom = Math.min(bottom, cb);
            }
        }

        const rectPtr = process!.memory.alloc(16);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(rectPtr, left, true);
        view.setInt32(rectPtr + 4, top, true);
        view.setInt32(rectPtr + 8, right, true);
        view.setInt32(rectPtr + 12, bottom, true);

        const STACK_CLEANUP = 16;
        const CALLBACK_CLEANUP = 16;
        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP);
        const { callbackId } = callbackManager.invokeCallback(
            lpfnEnum,
            [1, hdc, rectPtr, dwData],
            CALLBACK_CLEANUP,
            () => {
                process!.memory.free(rectPtr);
                return 1;
            },
            false,
            'EnumDisplayMonitors',
        );

        return { value: 1, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP };
    };

    exports['GetLayeredWindowAttributes'] = (ctx, mem, args) => {
        const pcrKey = args[1] >>> 0;
        const pbAlpha = args[2] >>> 0;
        const pdwFlags = args[3] >>> 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (pcrKey && pcrKey + 4 <= mem.length) view.setUint32(pcrKey, 0, true);
        if (pbAlpha && pbAlpha < mem.length) mem[pbAlpha] = 255;
        if (pdwFlags && pdwFlags + 4 <= mem.length) view.setUint32(pdwFlags, 0x2, true); // LWA_ALPHA
        return 1;
    };

    exports['SetProcessDPIAware'] = () => 1;
    exports['IsProcessDPIAware'] = () => 1;

    // UINT GetDpiForSystem(VOID) — the virtual desktop is unscaled, so this must agree with
    // the LOGPIXELSX/Y that gdi32 GetDeviceCaps reports (USER_DEFAULT_SCREEN_DPI).
    exports['GetDpiForSystem'] = () => 96;

    // HDEVNOTIFY RegisterDeviceNotificationA/W(HANDLE hRecipient, LPVOID NotificationFilter, DWORD Flags)
    exports['RegisterDeviceNotificationA'] = (ctx, mem, args) =>
        registerDeviceNotification(mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, false);
    exports['RegisterDeviceNotificationW'] = (ctx, mem, args) =>
        registerDeviceNotification(mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, true);

    // BOOL UnregisterDeviceNotification(HDEVNOTIFY Handle)
    exports['UnregisterDeviceNotification'] = (_ctx, _mem, args) =>
        unregisterDeviceNotification(args[0] >>> 0) ? 1 : 0;

    return exports;
}
