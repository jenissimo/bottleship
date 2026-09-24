/**
 * UIPI message filters (ChangeWindowMessageFilter / ChangeWindowMessageFilterEx).
 *
 * The filter only ever gates messages sent from a LOWER integrity level. Every sender
 * here is the guest process itself, at one level, so no message is ever filtered and
 * the calls change nothing observable — they validate and succeed, and the Ex form
 * reports MSGFLTINFO_NONE ("no filter change affected this message").
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { windows } from './shared-state';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

const MSGFLT_ADD = 1;
const MSGFLT_REMOVE = 2;
const MSGFLT_RESET = 0;
const MSGFLT_ALLOW = 1;
const MSGFLT_DISALLOW = 2;
const MSGFLTINFO_NONE = 0;
/** CHANGEFILTERSTRUCT { DWORD cbSize; DWORD ExtStatus; } */
const CHANGEFILTERSTRUCT_SIZE = 8;

const setLastError = (code: number): void => { System.getInstance().scheduler?.setLastError(code); };

export function createMessageFilterExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // BOOL ChangeWindowMessageFilter(UINT message, DWORD dwFlag)
    exports['ChangeWindowMessageFilter'] = (_ctx, _mem, args) => {
        const flag = args[1] >>> 0;
        if (flag !== MSGFLT_ADD && flag !== MSGFLT_REMOVE) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        return 1;
    };

    // BOOL ChangeWindowMessageFilterEx(HWND, UINT message, DWORD action, PCHANGEFILTERSTRUCT)
    exports['ChangeWindowMessageFilterEx'] = (_ctx, mem, args) => {
        const hwnd = args[0] >>> 0;
        const action = args[2] >>> 0;
        const pChange = args[3] >>> 0;
        if (!windows.has(hwnd)) {
            setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        if (action !== MSGFLT_RESET && action !== MSGFLT_ALLOW && action !== MSGFLT_DISALLOW) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        if (pChange) {
            if (!isValidAddress(mem, pChange, CHANGEFILTERSTRUCT_SIZE, 'rw')
                || Mem.readUint32(pChange) !== CHANGEFILTERSTRUCT_SIZE) {
                setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            Mem.writeUint32(pChange + 4, MSGFLTINFO_NONE);
        }
        return 1;
    };

    return exports;
}
