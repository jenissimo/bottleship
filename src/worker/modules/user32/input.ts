/**
 * User32 Input functions
 *
 * Atomic implementation for input operations
 */

import { FastPathImplementation, ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import {
    clampToCursorClip, getCapture, getCursorClipRect, getVirtualScreenRect, setCursorClipRect, warpGuestCursorTo, windows,
    getWindowByHandle,
} from './shared-state';
import { GUEST_INPUT_FLAG } from '../../../input/sab-layout';

export function createInputExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const ERROR_INVALID_WINDOW_HANDLE = 1400;
    const DMLERR_NO_ERROR = 0x0000;
    const DMLERR_INVALIDPARAMETER = 0x4006;
    const DMLERR_NO_CONV_ESTABLISHED = 0x400a;

    const windowProperties: Map<number, Map<string, number>> = new Map();
    let nextDdeInstance = 1;
    let nextDdeStringHandle = 1;
    let nextDdeConv = 1;
    const ddeInstances = new Set<number>();
    const ddeLastError = new Map<number, number>();
    const ddeStrings = new Map<number, string>();
    function resolvePropertyKey(mem: Uint8Array, lpString: number, wide: boolean): string | null {
        if (lpString === 0) {
            return null;
        }
        if ((lpString >>> 16) === 0) {
            return `atom:${lpString & 0xffff}`;
        }
        const str = wide ? Marshaler.readWideString(mem, lpString) : Marshaler.readString(mem, lpString);
        if (str.length === 0) {
            return `ptr:${lpString >>> 0}`;
        }
        return `str:${str}`;
    }

    function getPropertyMapForWindow(hwnd: number, create: boolean): Map<string, number> | undefined {
        let map = windowProperties.get(hwnd);
        if (!map && create) {
            map = new Map<string, number>();
            windowProperties.set(hwnd, map);
        }
        return map;
    }

    exports['GetAsyncKeyState'] = (ctx, mem, args) => {
        const vKey = args[0] & 0xFF;

        Logger.verbose(LogCategory.USER32, `GetAsyncKeyState(${vKey})`);

        const inputManager = System.getInstance().inputManager;
        // Level read straight from the SAB bitfield (fresh-at-call, no poll() lag);
        // the pressed-since edge bit stays poll()-maintained.
        const isPressed = inputManager.readKeyLevelFromSab(vKey);
        const wasPressedSince = inputManager.consumeKeyPressedSince(vKey);
        const result = (isPressed ? 0x8000 : 0) | (wasPressedSince ? 0x0001 : 0);

        inputManager.noteGuestKeyRead(vKey, isPressed);
        return result;
    };

    exports['GetKeyState'] = (ctx, mem, args) => {
        const nVirtKey = args[0] & 0xFF;

        Logger.verbose(LogCategory.USER32, `GetKeyState(${nVirtKey})`);

        const inputManager = System.getInstance().inputManager;
        const result = inputManager.getKeyState(nVirtKey);
        inputManager.noteGuestKeyRead(nVirtKey, (result & 0x8000) !== 0);
        return result;
    };

    exports['GetKeyboardState'] = (_ctx, _mem, args) => {
        const lpKeyState = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `GetKeyboardState(0x${lpKeyState.toString(16)})`);

        if (!lpKeyState) {
            return 0;
        }

        const inputManager = System.getInstance().inputManager;
        const packed = new Uint8Array(256);
        for (let vk = 0; vk < 256; vk++) {
            const state = inputManager.getKeyState(vk);
            packed[vk] = ((state & 0x8000) ? 0x80 : 0) | (state & 0x01);
        }

        inputManager.noteGuestInputFlag(GUEST_INPUT_FLAG.bulkKeyboard);
        const written = Mem.writeBytes(lpKeyState, packed);
        return written === packed.length ? 1 : 0;
    };

    exports['SetKeyboardState'] = (_ctx, mem, args) => {
        const lpKeyState = args[0] >>> 0;
        Logger.verbose(LogCategory.USER32, `SetKeyboardState(0x${lpKeyState.toString(16)})`);

        if (!lpKeyState) {
            return 0;
        }

        const packed = new Uint8Array(256);
        const toRead = Math.min(256, mem.length - lpKeyState);
        if (toRead <= 0) {
            return 0;
        }
        packed.set(mem.subarray(lpKeyState, lpKeyState + toRead));
        System.getInstance().inputManager.applyQueuedKeyState(packed);
        return 1;
    };

    exports['VkKeyScanA'] = (_ctx, _mem, args) => {
        const ch = args[0] & 0xff;
        Logger.verbose(LogCategory.USER32, `VkKeyScanA(0x${ch.toString(16)})`);

        const VK_SHIFT = 1;
        if (ch >= 0x41 && ch <= 0x5a) {
            return ch | (VK_SHIFT << 8);
        }
        if (ch >= 0x61 && ch <= 0x7a) {
            return (ch - 32);
        }
        if (ch >= 0x30 && ch <= 0x39) {
            return ch;
        }
        if (ch === 0x20) {
            return 0x20;
        }

        const shifted: Record<number, [number, number]> = {
            0x21: [0x31, VK_SHIFT], 0x40: [0x32, VK_SHIFT], 0x23: [0x33, VK_SHIFT],
            0x24: [0x34, VK_SHIFT], 0x25: [0x35, VK_SHIFT], 0x5e: [0x36, VK_SHIFT],
            0x26: [0x37, VK_SHIFT], 0x2a: [0x38, VK_SHIFT], 0x28: [0x39, VK_SHIFT],
            0x29: [0x30, VK_SHIFT], 0x5f: [0xbd, VK_SHIFT], 0x2b: [0xbb, VK_SHIFT],
            0x7b: [0xdb, VK_SHIFT], 0x7d: [0xdd, VK_SHIFT], 0x3a: [0xba, VK_SHIFT],
            0x22: [0xde, VK_SHIFT], 0x7c: [0xdc, VK_SHIFT], 0x3c: [0xbc, VK_SHIFT],
            0x3e: [0xbe, VK_SHIFT], 0x3f: [0xbf, VK_SHIFT], 0x7e: [0xc0, VK_SHIFT],
        };
        const shiftedEntry = shifted[ch];
        if (shiftedEntry) {
            return shiftedEntry[0] | (shiftedEntry[1] << 8);
        }

        const unshifted: Record<number, number> = {
            0x0d: 0x0d, 0x09: 0x09, 0x08: 0x08, 0x1b: 0x1b,
            0x2d: 0xbd, 0x3d: 0xbb, 0x5b: 0xdb, 0x5d: 0xdd,
            0x3b: 0xba, 0x27: 0xde, 0x5c: 0xdc, 0x2c: 0xbc,
            0x2e: 0xbe, 0x2f: 0xbf, 0x60: 0xc0,
        };
        const vk = unshifted[ch];
        return vk !== undefined ? vk : -1;
    };

    // JS fallback for the Tier 1 hypercall (HANDLER_GET_CAPTURE) — a pure read of
    // the capture owner, which WindowManager mirrors into HYPERCALL_PAGE.
    exports['GetCapture'] = (ctx, mem, args) => {
        const hwnd = getCapture();
        Logger.verboseLazy(LogCategory.USER32, () => `GetCapture() -> 0x${hwnd.toString(16)}`);
        return hwnd;
    };

    // BOOL ClipCursor(const RECT *lpRect) — confines the pointer to lpRect (NULL
    // releases). The rect is clamped to the virtual screen and an inverted one is
    // rejected, as in wineserver set_clip_rectangle / NtUserClipCursor; a pointer
    // already outside the new rect is warped into it there and then.
    exports['ClipCursor'] = (ctx, mem, args) => {
        const lpRect = args[0] >>> 0;
        if (!lpRect) {
            setCursorClipRect(null);
            Logger.verbose(LogCategory.USER32, `ClipCursor(NULL)`);
            return 1;
        }
        if (lpRect + 16 > mem.length) return 0;
        const left = Mem.readInt32(lpRect);
        const top = Mem.readInt32(lpRect + 4);
        const right = Mem.readInt32(lpRect + 8);
        const bottom = Mem.readInt32(lpRect + 12);
        if (left === null || top === null || right === null || bottom === null) return 0;
        if (left > right || top > bottom) return 0;
        const screen = getVirtualScreenRect();
        const rect = {
            left: Math.max(left, screen.left),
            top: Math.max(top, screen.top),
            right: Math.min(right, screen.right),
            bottom: Math.min(bottom, screen.bottom),
        };
        setCursorClipRect(rect.left > rect.right || rect.top > rect.bottom ? screen : rect);
        // wineserver set_clip_rectangle warps only when the new rect actually excludes
        // the pointer — an unchanged confinement is not a mouse event.
        const pos = System.getInstance().inputManager.getMouseState();
        const confined = clampToCursorClip(pos.x, pos.y);
        if (confined.x !== pos.x || confined.y !== pos.y) warpGuestCursorTo(confined.x, confined.y);
        Logger.verbose(LogCategory.USER32,
            `ClipCursor(${rect.left},${rect.top},${rect.right},${rect.bottom})`);
        return 1;
    };

    exports['WindowFromPoint'] = (ctx, mem, args) => {
        // POINT passed by value = 2 DWORDs on the stack (args[0]=x, args[1]=y).
        const x = args[0] | 0;
        const y = args[1] | 0;
        // Faithful Win32: walk the top-level Z-order front→back (skip invisible /
        // WS_DISABLED), first containing window wins, then descend into its children.
        const found = System.getInstance().windowManager.windowFromPoint(x, y);
        Logger.verbose(LogCategory.USER32, `WindowFromPoint(${x}, ${y}) -> 0x${found.toString(16)}`);
        return found;
    };

    // HWND ChildWindowFromPoint(HWND hWndParent, POINT pt)
    // POINT passed by value = 2 DWORDs on stack (args[1]=x, args[2]=y)
    // Returns child window at point, or parent if no child, or NULL if outside parent
    exports['ChildWindowFromPoint'] = (ctx, mem, args) => {
        const hWndParent = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;

        const parent = windows.get(hWndParent);
        if (!parent) return 0;

        // Check children (iterate all windows whose parent matches)
        for (const [hwnd, win] of windows) {
            if (win.parent !== hWndParent) continue;
            if (x >= win.x && x < win.x + win.width &&
                y >= win.y && y < win.y + win.height) {
                return hwnd;
            }
        }

        // No child found — return parent itself
        return hWndParent;
    };

    exports['ChildWindowFromPointEx'] = (ctx, mem, args) => {
        const hWndParent = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const uFlags = args[3] >>> 0;
        const CWP_SKIPINVISIBLE = 0x0001;
        const CWP_SKIPDISABLED = 0x0002;
        const WS_DISABLED = 0x08000000;

        const parent = windows.get(hWndParent);
        if (!parent) return 0;

        const childMatches = (win: typeof parent): boolean => {
            if ((uFlags & CWP_SKIPINVISIBLE) && !win.visible) return false;
            if ((uFlags & CWP_SKIPDISABLED) && ((win.style >>> 0) & WS_DISABLED)) return false;
            return true;
        };

        for (const [hwnd, win] of windows) {
            if (win.parent !== hWndParent) continue;
            if (!childMatches(win)) continue;
            if (x >= win.x && x < win.x + win.width &&
                y >= win.y && y < win.y + win.height) {
                return hwnd;
            }
        }

        return hWndParent;
    };

    exports['DestroyCaret'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `DestroyCaret()`);
        return 1; // TRUE
    };

    exports['ShowCaret'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `ShowCaret(0x${hWnd.toString(16)})`);
        return 1; // TRUE
    };

    exports['HideCaret'] = (ctx, mem, args) => {
        const hWnd = args[0];
        Logger.verbose(LogCategory.USER32, `HideCaret(0x${hWnd.toString(16)})`);
        return 1; // TRUE
    };

    exports['LoadAcceleratorsA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpTableName = args[1];
        Logger.verbose(LogCategory.USER32, `LoadAcceleratorsA(0x${hInstance.toString(16)}, 0x${lpTableName.toString(16)})`);
        return 0; // NULL - accelerator table not found
    };

    exports['CopyAcceleratorTableA'] = (ctx, mem, args) => {
        const hAccelSrc = args[0];
        const lpAccelDst = args[1];
        const cAccelEntries = args[2];
        Logger.verbose(LogCategory.USER32, `CopyAcceleratorTableA(0x${hAccelSrc.toString(16)}, 0x${lpAccelDst.toString(16)}, ${cAccelEntries})`);
        // No real accelerator tables — return 0 entries copied
        return 0;
    };

    exports['CreateAcceleratorTableA'] = (ctx, mem, args) => {
        const lpAccel = args[0];
        const cAccel = args[1];
        Logger.verbose(LogCategory.USER32, `CreateAcceleratorTableA(0x${lpAccel.toString(16)}, ${cAccel})`);
        // Return a non-zero dummy handle so callers don't treat it as failure
        return 0x1ACC;
    };

    exports['TranslateAcceleratorA'] = exports['TranslateAcceleratorW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const hAccTable = args[1];
        const lpMsg = args[2];
        Logger.verbose(LogCategory.USER32, `TranslateAccelerator(0x${hWnd.toString(16)}, 0x${hAccTable.toString(16)}, 0x${lpMsg.toString(16)})`);
        return 0; // Message not translated
    };

    exports['DestroyAcceleratorTable'] = (ctx, mem, args) => {
        const hAccel = args[0];
        Logger.verbose(LogCategory.USER32, `DestroyAcceleratorTable(0x${hAccel.toString(16)})`);
        return 1; // TRUE - success
    };

    exports['SetPropA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const hData = args[2];
        const system = System.getInstance();
        const key = resolvePropertyKey(mem, lpString, false);
        Logger.verbose(LogCategory.USER32, `SetPropA(0x${hWnd.toString(16)}, 0x${lpString.toString(16)}, 0x${hData.toString(16)})`);

        if (!getWindowByHandle(hWnd) || key === null) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const props = getPropertyMapForWindow(hWnd, true)!;
        props.set(key, hData >>> 0);
        system.scheduler.setLastError(0);
        return 1;
    };
    exports['SetPropW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const hData = args[2];
        const system = System.getInstance();
        const key = resolvePropertyKey(mem, lpString, true);
        Logger.verbose(LogCategory.USER32, `SetPropW(0x${hWnd.toString(16)}, 0x${lpString.toString(16)}, 0x${hData.toString(16)})`);

        if (!getWindowByHandle(hWnd) || key === null) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const props = getPropertyMapForWindow(hWnd, true)!;
        props.set(key, hData >>> 0);
        system.scheduler.setLastError(0);
        return 1;
    };

    exports['GetPropA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const system = System.getInstance();
        const key = resolvePropertyKey(mem, lpString, false);
        Logger.verbose(LogCategory.USER32, `GetPropA(0x${hWnd.toString(16)}, 0x${lpString.toString(16)})`);

        if (!getWindowByHandle(hWnd) || key === null) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const props = getPropertyMapForWindow(hWnd, false);
        const value = props?.get(key) ?? 0;
        system.scheduler.setLastError(0);
        return value >>> 0;
    };
    exports['GetPropW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const system = System.getInstance();
        const key = resolvePropertyKey(mem, lpString, true);
        Logger.verbose(LogCategory.USER32, `GetPropW(0x${hWnd.toString(16)}, 0x${lpString.toString(16)})`);

        if (!getWindowByHandle(hWnd) || key === null) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const props = getPropertyMapForWindow(hWnd, false);
        const value = props?.get(key) ?? 0;
        system.scheduler.setLastError(0);
        return value >>> 0;
    };

    exports['RemovePropA'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const system = System.getInstance();
        const key = resolvePropertyKey(mem, lpString, false);
        Logger.verbose(LogCategory.USER32, `RemovePropA(0x${hWnd.toString(16)}, 0x${lpString.toString(16)})`);

        if (!getWindowByHandle(hWnd) || key === null) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const props = getPropertyMapForWindow(hWnd, false);
        if (!props) {
            system.scheduler.setLastError(0);
            return 0;
        }

        const existing = props.get(key);
        if (existing === undefined) {
            system.scheduler.setLastError(0);
            return 0;
        }

        props.delete(key);
        if (props.size === 0) {
            windowProperties.delete(hWnd);
        }
        system.scheduler.setLastError(0);
        return existing >>> 0;
    };
    exports['RemovePropW'] = (ctx, mem, args) => {
        const hWnd = args[0];
        const lpString = args[1];
        const system = System.getInstance();
        const key = resolvePropertyKey(mem, lpString, true);
        Logger.verbose(LogCategory.USER32, `RemovePropW(0x${hWnd.toString(16)}, 0x${lpString.toString(16)})`);

        if (!getWindowByHandle(hWnd) || key === null) {
            system.scheduler.setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }

        const props = getPropertyMapForWindow(hWnd, false);
        if (!props) {
            system.scheduler.setLastError(0);
            return 0;
        }

        const existing = props.get(key);
        if (existing === undefined) {
            system.scheduler.setLastError(0);
            return 0;
        }

        props.delete(key);
        if (props.size === 0) {
            windowProperties.delete(hWnd);
        }
        system.scheduler.setLastError(0);
        return existing >>> 0;
    };

    exports['ReuseDDElParam'] = (ctx, mem, args) => {
        const msgIn = args[0];
        const msgOut = args[1];
        const uiLo = args[2];
        const uiHi = args[3];
        Logger.verbose(LogCategory.USER32, `ReuseDDElParam(0x${msgIn.toString(16)}, 0x${msgOut.toString(16)}, ...)`);
        return 0; // NULL - failed
    };

    // UINT DdeInitializeA(LPDWORD pidInst, PFNCALLBACK pfnCallback, DWORD afCmd, DWORD ulRes)
    exports['DdeInitializeA'] = (ctx, mem, args) => {
        const pidInst = args[0] >>> 0;
        if (!pidInst || pidInst + 4 > mem.length) {
            return DMLERR_INVALIDPARAMETER;
        }
        const inst = nextDdeInstance++;
        ddeInstances.add(inst);
        ddeLastError.set(inst, DMLERR_NO_ERROR);
        Mem.writeUint32(pidInst, inst >>> 0);
        return DMLERR_NO_ERROR;
    };

    // BOOL DdeUninitialize(DWORD idInst)
    exports['DdeUninitialize'] = (ctx, mem, args) => {
        const idInst = args[0] >>> 0;
        if (!ddeInstances.has(idInst)) {
            return 0;
        }
        ddeInstances.delete(idInst);
        ddeLastError.delete(idInst);
        return 1;
    };

    // UINT DdeGetLastError(DWORD idInst)
    exports['DdeGetLastError'] = (ctx, mem, args) => {
        const idInst = args[0] >>> 0;
        if (!ddeInstances.has(idInst)) {
            return DMLERR_INVALIDPARAMETER;
        }
        return ddeLastError.get(idInst) ?? DMLERR_NO_ERROR;
    };

    // HSZ DdeCreateStringHandleA(DWORD idInst, LPCSTR psz, int iCodePage)
    exports['DdeCreateStringHandleA'] = (ctx, mem, args) => {
        const idInst = args[0] >>> 0;
        const psz = args[1] >>> 0;
        if (!ddeInstances.has(idInst) || !psz) {
            if (ddeInstances.has(idInst)) {
                ddeLastError.set(idInst, DMLERR_INVALIDPARAMETER);
            }
            return 0;
        }
        const value = Marshaler.readString(mem, psz);
        const hsz = nextDdeStringHandle++;
        ddeStrings.set(hsz, value);
        ddeLastError.set(idInst, DMLERR_NO_ERROR);
        return hsz >>> 0;
    };

    // DWORD DdeQueryStringA(DWORD idInst, HSZ hsz, LPSTR psz, DWORD cchMax, int iCodePage)
    exports['DdeQueryStringA'] = (ctx, mem, args) => {
        const idInst = args[0] >>> 0;
        const hsz = args[1] >>> 0;
        const psz = args[2] >>> 0;
        const cchMax = args[3] >>> 0;
        if (!ddeInstances.has(idInst)) {
            return 0;
        }
        const text = ddeStrings.get(hsz) ?? '';
        if (!psz || cchMax === 0) {
            ddeLastError.set(idInst, DMLERR_NO_ERROR);
            return text.length >>> 0;
        }
        const bytes = new TextEncoder().encode(text);
        const toCopy = Math.min(bytes.length, Math.max(0, cchMax - 1));
        if (psz + toCopy + 1 > mem.length) {
            ddeLastError.set(idInst, DMLERR_INVALIDPARAMETER);
            return 0;
        }
        if (toCopy > 0) {
            Mem.writeBytes(psz, bytes.slice(0, toCopy));
        }
        mem[psz + toCopy] = 0;
        ddeLastError.set(idInst, DMLERR_NO_ERROR);
        return toCopy >>> 0;
    };

    // HCONV DdeConnect(DWORD idInst, HSZ hszService, HSZ hszTopic, PCONVCONTEXT pCC)
    exports['DdeConnect'] = (ctx, mem, args) => {
        const idInst = args[0] >>> 0;
        const hszService = args[1] >>> 0;
        const hszTopic = args[2] >>> 0;
        if (!ddeInstances.has(idInst) || hszService === 0 || hszTopic === 0) {
            if (ddeInstances.has(idInst)) {
                ddeLastError.set(idInst, DMLERR_NO_CONV_ESTABLISHED);
            }
            return 0;
        }
        ddeLastError.set(idInst, DMLERR_NO_ERROR);
        return (0xD0000000 | (nextDdeConv++ & 0x0FFFFFFF)) >>> 0;
    };

    // HDDEDATA DdeClientTransaction(...)
    exports['DdeClientTransaction'] = (ctx, mem, args) => {
        const hConv = args[2] >>> 0;
        const pdwResult = args[7] >>> 0;
        if (pdwResult && pdwResult + 4 <= mem.length) {
            Mem.writeUint32(pdwResult, 0);
        }
        if (!hConv) {
            return 0;
        }
        return hConv; // non-NULL success token for compatibility
    };

    // ── Raw Input (WM_INPUT) ────────────────────────────────────────────────
    // Modern OldUnreal WinDrv initializes a "Raw Input" mouse handler and enumerates
    // / queries raw-input devices. These were previously argcount-only stubs (no
    // handler), so their OUT count/size params (puiNumDevices / pcbSize) were left
    // UNINITIALISED — the engine then fed that garbage to appMalloc → _aligned_malloc
    // returned NULL → `check(Ptr)` (FMallocAnsi.h:33) → "Critical: UInput::ReadInput".
    // We report "no raw-input devices / no data", always writing 0 to the OUT params.
    const writeU32 = (mem: Uint8Array, addr: number, value: number): void => {
        if (addr && addr + 4 <= mem.length) Mem.writeUint32(addr >>> 0, value >>> 0);
    };

    // UINT GetRawInputDeviceList(PRAWINPUTDEVICELIST, PUINT puiNumDevices, UINT cbSize)
    exports['GetRawInputDeviceList'] = (ctx, mem, args) => {
        const puiNumDevices = args[1] >>> 0;
        Logger.verbose(LogCategory.USER32, `GetRawInputDeviceList(0x${(args[0] >>> 0).toString(16)}, 0x${puiNumDevices.toString(16)}, ${args[2] >>> 0})`);
        writeU32(mem, puiNumDevices, 0); // zero devices
        return 0; // count copied / required = 0
    };

    // BOOL RegisterRawInputDevices(PCRAWINPUTDEVICE, UINT uiNumDevices, UINT cbSize)
    // Must FAIL: we never deliver WM_INPUT, and claiming success makes SDL2 (2.0.18+)
    // switch focused-window mouse motion to the raw-input path and ignore
    // WM_MOUSEMOVE coordinates — frozen in-game cursor. A failed registration is
    // the honest contract; callers fall back to normal window messages.
    exports['RegisterRawInputDevices'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `RegisterRawInputDevices(uiNumDevices=${args[1] >>> 0}) -> FALSE (no WM_INPUT delivery)`);
        System.getInstance().scheduler.setLastError(120); // ERROR_CALL_NOT_IMPLEMENTED
        return 0;
    };

    // UINT GetRegisteredRawInputDevices(PRAWINPUTDEVICE, PUINT puiNumDevices, UINT cbSize)
    exports['GetRegisteredRawInputDevices'] = (ctx, mem, args) => {
        const puiNumDevices = args[1] >>> 0;
        Logger.verbose(LogCategory.USER32, `GetRegisteredRawInputDevices(0x${puiNumDevices.toString(16)})`);
        writeU32(mem, puiNumDevices, 0);
        return 0;
    };

    // UINT GetRawInputData(HRAWINPUT, UINT uiCommand, LPVOID pData, PUINT pcbSize, UINT cbSizeHeader)
    exports['GetRawInputData'] = (ctx, mem, args) => {
        const pData = args[2] >>> 0;
        const pcbSize = args[3] >>> 0;
        Logger.verbose(LogCategory.USER32, `GetRawInputData(cmd=0x${(args[1] >>> 0).toString(16)}, pData=0x${pData.toString(16)})`);
        // pData==NULL → size query: report 0 bytes required. pData!=NULL → 0 bytes copied.
        if (pData === 0) writeU32(mem, pcbSize, 0);
        return 0;
    };

    // UINT GetRawInputBuffer(PRAWINPUT pData, PUINT pcbSize, UINT cbSizeHeader)
    exports['GetRawInputBuffer'] = (ctx, mem, args) => {
        const pData = args[0] >>> 0;
        const pcbSize = args[1] >>> 0;
        Logger.verbose(LogCategory.USER32, `GetRawInputBuffer(pData=0x${pData.toString(16)})`);
        if (pData === 0) writeU32(mem, pcbSize, 0);
        return 0; // zero messages
    };

    // UINT GetRawInputDeviceInfoW/A(HANDLE hDevice, UINT uiCommand, LPVOID pData, PUINT pcbSize)
    exports['GetRawInputDeviceInfoW'] = exports['GetRawInputDeviceInfoA'] = (ctx, mem, args) => {
        const pcbSize = args[3] >>> 0;
        Logger.verbose(LogCategory.USER32, `GetRawInputDeviceInfo(hDevice=0x${(args[0] >>> 0).toString(16)}, cmd=0x${(args[1] >>> 0).toString(16)})`);
        writeU32(mem, pcbSize, 0);
        return 0;
    };

    // LRESULT DefRawInputProc(PRAWINPUT* paRawInput, INT nInput, UINT cbSizeHeader)
    exports['DefRawInputProc'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `DefRawInputProc(nInput=${args[1] | 0})`);
        return 0;
    };

    exports['UnpackDDElParam'] = (ctx, mem, args) => {
        const msg = args[0];
        const lParam = args[1];
        const puiLo = args[2];
        const puiHi = args[3];
        Logger.verbose(LogCategory.USER32, `UnpackDDElParam(0x${msg.toString(16)}, 0x${lParam.toString(16)}, ...)`);
        if (puiLo) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(puiLo, lParam & 0xFFFF, true);
        }
        if (puiHi) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(puiHi, (lParam >>> 16) & 0xFFFF, true);
        }
        return 1; // TRUE
    };

    return exports;
}

/** Fast no-op path for the identical ClipCursor rect reasserted by launcher idle loops. */
export function registerFastPathInputFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;
    const clipCursorNoop: FastPathImplementation = (cpu: any, mem8: Uint8Array, _mem32: Uint32Array, view: DataView) => {
        const esp = cpu.reg32[4] >>> 0;
        const ptr = view.getUint32(esp + 4, true);
        const current = getCursorClipRect();
        if (!ptr) return current === null ? 1 : null;
        if (ptr + 16 > mem8.length) return 0;
        const left = view.getInt32(ptr, true);
        const top = view.getInt32(ptr + 4, true);
        const right = view.getInt32(ptr + 8, true);
        const bottom = view.getInt32(ptr + 12, true);
        if (left > right || top > bottom) return 0;
        const screen = getVirtualScreenRect();
        const clipped = {
            left: Math.max(left, screen.left), top: Math.max(top, screen.top),
            right: Math.min(right, screen.right), bottom: Math.min(bottom, screen.bottom),
        };
        const next = clipped.left > clipped.right || clipped.top > clipped.bottom ? screen : clipped;
        return current && current.left === next.left && current.top === next.top
            && current.right === next.right && current.bottom === next.bottom ? 1 : null;
    };
    dispatcher.registerFastPath('user32', 'ClipCursor', clipCursorNoop, { trivial: true });
}
