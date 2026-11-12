/**
 * User32 Input functions
 *
 * Atomic implementation for input operations
 */

import { type HleDispatcher, FastPathImplementation, ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import {
    clampToCursorClip, getCapture, getCursorClipRect, getVirtualScreenRect, setCursorClipRect, warpGuestCursorTo, windows,
    getWindowByHandle,
} from './shared-state';
import { GUEST_INPUT_FLAG } from '../../../input/sab-layout';

const WS_DISABLED_ACCEL = 0x08000000;
const WS_MINIMIZE_ACCEL = 0x20000000;
import { savestateParticipants, savestatesEnabled, stateKeys } from '../../savestate/participant';
import type { SaveValue } from '../../savestate/value-codec';
import { ACCEL_WM_COMMAND, copyAccelerators, createAccelerators, destroyAcceleratorTable, findAcceleratorFor, loadAccelerators, registerAcceleratorParticipant } from './accelerators';
import { isSentinelWndProc } from './dialog';
import { invokeGuestWndProcSync } from './message';

// The three polled key readers are the hottest thunks any title issues (a per-frame
// input poll, millions of calls over a session), so each has a fast path. The bodies
// live here, once, so the two tiers cannot answer differently.

/** GetAsyncKeyState: SAB level + the poll()-maintained pressed-since edge bit. */
function readAsyncKeyState(vKey: number): number {
    const inputManager = System.getInstance().inputManager;
    // Level read straight from the SAB bitfield (fresh-at-call, no poll() lag);
    // the pressed-since edge bit stays poll()-maintained.
    const isPressed = inputManager.readKeyLevelFromSab(vKey);
    const wasPressedSince = inputManager.consumeKeyPressedSince(vKey);
    const result = (isPressed ? 0x8000 : 0) | (wasPressedSince ? 0x0001 : 0);

    inputManager.noteGuestKeyRead(vKey, isPressed);
    return result;
}

/** GetKeyState: synchronous level + toggle bit. */
function readKeyState(nVirtKey: number): number {
    const inputManager = System.getInstance().inputManager;
    const result = inputManager.getKeyState(nVirtKey);
    inputManager.noteGuestKeyRead(nVirtKey, (result & 0x8000) !== 0);
    return result;
}

// Reused across calls: the packed table is host-side scratch handed straight to
// Mem.writeBytes, never retained by anyone.
// @transient(host scratch refilled by every GetKeyboardState)
const packedKeyboardState = new Uint8Array(256);

/** GetKeyboardState: 256 packed VK bytes into a guest buffer. Returns BOOL. */
function readKeyboardState(lpKeyState: number): number {
    const inputManager = System.getInstance().inputManager;
    for (let vk = 0; vk < 256; vk++) {
        const state = inputManager.getKeyState(vk);
        packedKeyboardState[vk] = ((state & 0x8000) ? 0x80 : 0) | (state & 0x01);
    }

    inputManager.noteGuestInputFlag(GUEST_INPUT_FLAG.bulkKeyboard);
    const written = Mem.writeBytes(lpKeyState, packedKeyboardState);
    return written === packedKeyboardState.length ? 1 : 0;
}

export interface User32InputState {
    windowProperties: Array<[number, Array<[string, number]>]>;
    nextDdeInstance: number;
    nextDdeStringHandle: number;
    nextDdeConv: number;
    ddeStrings: Array<[number, string]>;
    ddeServices: Array<[string, number[]]>;
    ddeLastError: Array<[number, number]>;
    ddeClientOnly: number[];
    heldKeys: number[];
    heldButtons: number;
    ddeInstances: number[];
    ddeConversations: number[];
}

export function createInputExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const ERROR_INVALID_WINDOW_HANDLE = 1400;
    const DMLERR_NO_ERROR = 0x0000;
    const DMLERR_INVALIDPARAMETER = 0x4006;
    const DMLERR_NO_CONV_ESTABLISHED = 0x400a;

    // @participant(user32-input)
    const windowProperties: Map<number, Map<string, number>> = new Map();
    // @participant(user32-input)
    let nextDdeInstance = 1;
    // @participant(user32-input)
    let nextDdeStringHandle = 1;
    // @participant(user32-input)
    let nextDdeConv = 1;
    // @participant(user32-input)
    const ddeInstances = new Set<number>();
    // @participant(user32-input)
    const ddeLastError = new Map<number, number>();
    // @participant(user32-input)
    const ddeStrings = new Map<number, string>();
    // @participant(user32-input)
    const ddeServices = new Map<string, Set<number>>();
    // @participant(user32-input)
    const ddeConversations = new Set<number>();
    // @participant(user32-input)
    const ddeClientOnly = new Set<number>();
    if (savestatesEnabled()) savestateParticipants.add({
        id: 'user32-input', version: 4, order: 42,
        schema: stateKeys<User32InputState>({
            windowProperties: true, nextDdeInstance: true, nextDdeStringHandle: true, nextDdeConv: true,
            ddeStrings: true, ddeServices: true, ddeLastError: true, ddeClientOnly: true, heldKeys: true, heldButtons: true,
            ddeInstances: true, ddeConversations: true,
        }),
        capture: () => {
            const state: User32InputState = {
                windowProperties: [...windowProperties].map(([h, props]) => [h, [...props]]),
                nextDdeInstance, nextDdeStringHandle, nextDdeConv,
                ddeStrings: [...ddeStrings],
                ddeServices: [...ddeServices].map(([name, insts]) => [name, [...insts]]),
                ddeLastError: [...ddeLastError],
                ddeClientOnly: [...ddeClientOnly],
                heldKeys: System.getInstance().inputManager.captureHeldKeys(),
                heldButtons: System.getInstance().inputManager.captureHeldButtons(),
                ddeInstances: [...ddeInstances],
                ddeConversations: [...ddeConversations],
            };
            return state as unknown as SaveValue;
        },
        restore: (saved) => {
            const s = saved as unknown as User32InputState;
            System.getInstance().inputManager.restoreHeldKeys(s.heldKeys);
            System.getInstance().inputManager.restoreHeldButtons(s.heldButtons);
            windowProperties.clear();
            for (const [h, props] of s.windowProperties) windowProperties.set(h, new Map(props));
            nextDdeInstance = s.nextDdeInstance;
            nextDdeStringHandle = s.nextDdeStringHandle;
            nextDdeConv = s.nextDdeConv;
            ddeInstances.clear();
            for (const inst of s.ddeInstances) ddeInstances.add(inst);
            ddeConversations.clear();
            for (const conv of s.ddeConversations) ddeConversations.add(conv);
            ddeClientOnly.clear();
            for (const inst of s.ddeClientOnly) ddeClientOnly.add(inst);
            ddeLastError.clear();
            for (const [inst, err] of s.ddeLastError) ddeLastError.set(inst, err);
            ddeStrings.clear();
            for (const [h, text] of s.ddeStrings) ddeStrings.set(h, text);
            ddeServices.clear();
            for (const [name, insts] of s.ddeServices) ddeServices.set(name, new Set(insts));
        },
    });
    // Wine's shell32 DDE server registers Progman, Shell and Folders, and also accepts
    // AppProperties as a service; it answers the Progman and Shell topics.
    // @transient(constant name table)
    const ddeShellServices = new Set(['progman', 'shell', 'folders', 'appproperties']);
    // @transient(constant name table)
    const ddeShellTopics = new Set(['progman', 'shell']);
    const DNS_REGISTER = 0x0001;
    const DNS_UNREGISTER = 0x0002;
    const APPCMD_CLIENTONLY = 0x00000010;
    const DMLERR_DLL_USAGE = 0x4004;
    const ddeServiceKey = (hsz: number): string | null => {
        const name = ddeStrings.get(hsz);
        return name === undefined ? null : name.toLowerCase();
    };
    const ddeDropInstanceServices = (idInst: number): void => {
        for (const [key, owners] of ddeServices) {
            owners.delete(idInst);
            if (owners.size === 0) ddeServices.delete(key);
        }
    };
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
        Logger.verboseLazy(LogCategory.USER32, () => `GetAsyncKeyState(${vKey})`);
        return readAsyncKeyState(vKey);
    };

    exports['GetKeyState'] = (ctx, mem, args) => {
        const nVirtKey = args[0] & 0xFF;
        Logger.verboseLazy(LogCategory.USER32, () => `GetKeyState(${nVirtKey})`);
        return readKeyState(nVirtKey);
    };

    exports['GetKeyboardState'] = (_ctx, _mem, args) => {
        const lpKeyState = args[0] >>> 0;
        Logger.verboseLazy(LogCategory.USER32, () => `GetKeyboardState(0x${lpKeyState.toString(16)})`);

        if (!lpKeyState) {
            return 0;
        }
        return readKeyboardState(lpKeyState);
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

    registerAcceleratorParticipant();

    exports['LoadAcceleratorsA'] = (ctx, mem, args) => {
        const name = args[1] >>> 0;
        return loadAccelerators(mem, args[0] >>> 0, name < 0x10000 ? name : Marshaler.readString(mem, name));
    };

    exports['LoadAcceleratorsW'] = (ctx, mem, args) => {
        const name = args[1] >>> 0;
        return loadAccelerators(mem, args[0] >>> 0, name < 0x10000 ? name : Marshaler.readWideString(mem, name));
    };

    exports['CopyAcceleratorTableA'] = (ctx, mem, args) =>
        copyAccelerators(mem, args[0] >>> 0, args[1] >>> 0, args[2] | 0);

    exports['CreateAcceleratorTableA'] = (ctx, mem, args) =>
        createAccelerators(mem, args[0] >>> 0, args[1] | 0);

    exports['TranslateAcceleratorA'] = exports['TranslateAcceleratorW'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const hit = hWnd ? findAcceleratorFor(mem, args[1] >>> 0, args[2] >>> 0) : null;
        if (!hit) return 0;
        const win = windows.get(hWnd);
        if (!win || getCapture() || (win.style & (WS_DISABLED_ACCEL | WS_MINIMIZE_ACCEL)) !== 0) return 1;
        const wParam = ((1 << 16) | hit.cmd) >>> 0;
        if (win.wndProc && !isSentinelWndProc(win.wndProc) && !(win.isSystemControl && !win.wndProcSubclassed)) {
            const sent = invokeGuestWndProcSync(ctx, mem, win.wndProc, hWnd, ACCEL_WM_COMMAND, wParam, 0, 12,
                'TranslateAccelerator', () => 1);
            if (sent) return sent;
        }
        System.getInstance().windowManager.postMessage(hWnd, ACCEL_WM_COMMAND, wParam, 0);
        System.getInstance().scheduler.wakeMessageWaiters();
        return 1;
    };

    exports['DestroyAcceleratorTable'] = (ctx, mem, args) => (destroyAcceleratorTable(args[0] >>> 0) ? 1 : 0);

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
        if ((args[2] >>> 0) & APPCMD_CLIENTONLY) ddeClientOnly.add(inst);
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
        ddeClientOnly.delete(idInst);
        ddeDropInstanceServices(idInst);
        return 1;
    };

    // HDDEDATA DdeNameService(DWORD idInst, HSZ hsz1, HSZ hsz2, UINT afCmd)
    exports['DdeNameService'] = (ctx, mem, args) => {
        const idInst = args[0] >>> 0;
        const hsz1 = args[1] >>> 0;
        const afCmd = args[3] >>> 0;
        if (!ddeInstances.has(idInst)) {
            return 0;
        }
        if (ddeClientOnly.has(idInst)) {
            ddeLastError.set(idInst, DMLERR_DLL_USAGE);
            return 0;
        }
        if (afCmd & DNS_UNREGISTER) {
            if (hsz1 === 0) {
                ddeDropInstanceServices(idInst);
            } else {
                const key = ddeServiceKey(hsz1);
                const owners = key === null ? undefined : ddeServices.get(key);
                owners?.delete(idInst);
                if (key !== null && owners && owners.size === 0) ddeServices.delete(key);
            }
        } else if (afCmd & DNS_REGISTER) {
            const key = ddeServiceKey(hsz1);
            if (key === null) {
                ddeLastError.set(idInst, DMLERR_INVALIDPARAMETER);
                return 0;
            }
            let owners = ddeServices.get(key);
            if (!owners) ddeServices.set(key, owners = new Set());
            owners.add(idInst);
        }
        ddeLastError.set(idInst, DMLERR_NO_ERROR);
        return 1;
    };

    // BOOL DdeDisconnect(HCONV hConv)
    exports['DdeDisconnect'] = (ctx, mem, args) => {
        return ddeConversations.delete(args[0] >>> 0) ? 1 : 0;
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
        if (!ddeInstances.has(idInst)) {
            return 0;
        }
        // A NULL service or topic is a wildcard: any server, or any topic the server
        // supports. Registration alone accepts the connection here; real DDEML also asks
        // the server's callback (XTYP_CONNECT, refused under CBF_FAIL_CONNECTIONS). The
        // service table is per process, while DDEML's is system-wide, so a service a
        // parent process registered is not visible to its child.
        const service = hszService === 0 ? null : ddeServiceKey(hszService);
        const topic = hszTopic === 0 ? null : ddeServiceKey(hszTopic);
        const connectable = hszService === 0
            ? ddeServices.size > 0 || hszTopic === 0 || (topic !== null && ddeShellTopics.has(topic))
            : service !== null && (ddeServices.has(service) || ddeShellServices.has(service));
        if (!connectable) {
            ddeLastError.set(idInst, DMLERR_NO_CONV_ESTABLISHED);
            return 0;
        }
        ddeLastError.set(idInst, DMLERR_NO_ERROR);
        const hConv = (0xD0000000 | (nextDdeConv++ & 0x0FFFFFFF)) >>> 0;
        ddeConversations.add(hConv);
        return hConv;
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
export function registerFastPathInputFunctions(dispatcher: HleDispatcher): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;
    const clipCursorNoop: FastPathImplementation = (esp: number, view: DataView, mem8: Uint8Array) => {
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

    // The polled key readers. `trivial` is safe for all three: they only read the input
    // SAB and OR bookkeeping bits into it — no wait, no acquire, no path that can park or
    // switch a thread — and the busy-wait detector they skip tracks only the three time
    // thunks, so no yield decision is lost.
    const asyncKeyState: FastPathImplementation = (esp: number, view: DataView, mem8: Uint8Array) => {
        if (esp + 8 > mem8.length) return null;
        return readAsyncKeyState(view.getUint32(esp + 4, true) & 0xFF);
    };
    dispatcher.registerFastPath('user32', 'GetAsyncKeyState', asyncKeyState, { trivial: true });

    const keyState: FastPathImplementation = (esp: number, view: DataView, mem8: Uint8Array) => {
        if (esp + 8 > mem8.length) return null;
        return readKeyState(view.getUint32(esp + 4, true) & 0xFF);
    };
    dispatcher.registerFastPath('user32', 'GetKeyState', keyState, { trivial: true });

    const keyboardState: FastPathImplementation = (esp: number, view: DataView, mem8: Uint8Array) => {
        if (esp + 8 > mem8.length) return null;
        const lpKeyState = view.getUint32(esp + 4, true) >>> 0;
        if (!lpKeyState) return 0;
        // The whole 256-byte extent must fit before anything is observed: declining has
        // to happen ahead of the bookkeeping bit readKeyboardState sets, or the slow path
        // would set it a second time. The write itself is region-validated by Mem.
        if (lpKeyState + 256 > mem8.length) return null;
        return readKeyboardState(lpKeyState);
    };
    dispatcher.registerFastPath('user32', 'GetKeyboardState', keyboardState, { trivial: true });
}
