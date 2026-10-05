/**
 * Touch (Win7 WM_TOUCH) and pointer (Win8 WM_POINTER) input on a machine whose only
 * pointing device is a mouse.
 *
 * With no digitizer, Windows still lets a window register for touch — the registration
 * is just a window attribute — and IsTouchWindow reports it, but no WM_TOUCH is ever
 * generated, so no HTOUCHINPUT exists for GetTouchInputInfo/CloseTouchInputHandle to
 * accept. The mouse is pointer id 1 once EnableMouseInPointer has turned it into a
 * pointer; before that no pointer id is valid.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { windows } from './shared-state';

const ERROR_INVALID_HANDLE = 6;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

const TWF_FINETOUCH = 0x1;
const TWF_WANTPALM = 0x2;

/** POINTER_INPUT_TYPE */
const PT_MOUSE = 4;
const MOUSE_POINTER_ID = 1;

/** EnableMouseInPointer latches on first call: -1 = never called. */
let mouseInPointer = -1;

export function resetTouchPointerState(): void {
    mouseInPointer = -1;
}

const setLastError = (code: number): void => { System.getInstance().scheduler?.setLastError(code); };

export function createTouchPointerExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // BOOL RegisterTouchWindow(HWND, ULONG ulFlags)
    exports['RegisterTouchWindow'] = (_ctx, _mem, args) => {
        const win = windows.get(args[0] >>> 0);
        const flags = args[1] >>> 0;
        if (!win) {
            setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        if ((flags & ~(TWF_FINETOUCH | TWF_WANTPALM)) !== 0) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        win.touchWindowFlags = flags;
        return 1;
    };

    // BOOL UnregisterTouchWindow(HWND)
    exports['UnregisterTouchWindow'] = (_ctx, _mem, args) => {
        const win = windows.get(args[0] >>> 0);
        if (!win) {
            setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        win.touchWindowFlags = undefined;
        return 1;
    };

    // BOOL IsTouchWindow(HWND, PULONG pulFlags) — pulFlags is optional.
    exports['IsTouchWindow'] = (_ctx, mem, args) => {
        const win = windows.get(args[0] >>> 0);
        const pulFlags = args[1] >>> 0;
        if (!win || win.touchWindowFlags === undefined) return 0;
        if (pulFlags && isValidAddress(mem, pulFlags, 4, 'rw')) Mem.writeUint32(pulFlags, win.touchWindowFlags);
        return 1;
    };

    // BOOL GetTouchInputInfo(HTOUCHINPUT, UINT cInputs, PTOUCHINPUT pInputs, int cbSize)
    exports['GetTouchInputInfo'] = () => {
        setLastError(ERROR_INVALID_HANDLE);
        return 0;
    };

    // BOOL CloseTouchInputHandle(HTOUCHINPUT)
    exports['CloseTouchInputHandle'] = () => {
        setLastError(ERROR_INVALID_HANDLE);
        return 0;
    };

    // BOOL EnableMouseInPointer(BOOL fEnable) — one setting per process: repeating it is
    // fine, changing it is refused.
    exports['EnableMouseInPointer'] = (_ctx, _mem, args) => {
        const enable = args[0] ? 1 : 0;
        if (mouseInPointer !== -1 && mouseInPointer !== enable) {
            setLastError(ERROR_ACCESS_DENIED);
            return 0;
        }
        mouseInPointer = enable;
        return 1;
    };

    // BOOL GetPointerType(UINT32 pointerId, POINTER_INPUT_TYPE *pointerType)
    exports['GetPointerType'] = (_ctx, mem, args) => {
        const pointerId = args[0] >>> 0;
        const pType = args[1] >>> 0;
        if (!pType || !isValidAddress(mem, pType, 4, 'rw')
            || pointerId !== MOUSE_POINTER_ID || mouseInPointer !== 1) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        Mem.writeUint32(pType, PT_MOUSE);
        return 1;
    };

    return exports;
}
