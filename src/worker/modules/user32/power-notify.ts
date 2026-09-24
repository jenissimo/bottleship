/**
 * RegisterPowerSettingNotification / UnregisterPowerSettingNotification: the registry of
 * HPOWERNOTIFY handles. No power setting ever changes on this machine (no battery, no
 * display timeout), so no PBT_POWERSETTINGCHANGE is delivered after registration.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { isValidAddress } from '../../core/memory/address-guard';
import { windows } from './shared-state';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

const DEVICE_NOTIFY_WINDOW_HANDLE = 0x0;
const DEVICE_NOTIFY_SERVICE_HANDLE = 0x1;
const GUID_SIZE = 16;

const registrations = new Set<number>();
let nextHandle = 0x00023000;

export function resetPowerNotifications(): void {
    registrations.clear();
}

const setLastError = (code: number): void => { System.getInstance().scheduler?.setLastError(code); };

export function createPowerNotifyExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // HPOWERNOTIFY RegisterPowerSettingNotification(HANDLE hRecipient, LPCGUID PowerSettingGuid, DWORD Flags)
    exports['RegisterPowerSettingNotification'] = (_ctx, mem, args) => {
        const recipient = args[0] >>> 0;
        const pGuid = args[1] >>> 0;
        const flags = args[2] >>> 0;
        if (flags !== DEVICE_NOTIFY_WINDOW_HANDLE && flags !== DEVICE_NOTIFY_SERVICE_HANDLE) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        if (!pGuid || !isValidAddress(mem, pGuid, GUID_SIZE, 'r')) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        if (flags === DEVICE_NOTIFY_WINDOW_HANDLE && !windows.has(recipient)) {
            setLastError(ERROR_INVALID_WINDOW_HANDLE);
            return 0;
        }
        if (flags === DEVICE_NOTIFY_SERVICE_HANDLE && !recipient) {
            setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const handle = nextHandle++;
        registrations.add(handle);
        return handle;
    };

    // BOOL UnregisterPowerSettingNotification(HPOWERNOTIFY)
    exports['UnregisterPowerSettingNotification'] = (_ctx, _mem, args) => {
        if (!registrations.delete(args[0] >>> 0)) {
            setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        return 1;
    };

    return exports;
}
