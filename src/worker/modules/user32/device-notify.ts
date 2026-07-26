/**
 * Device-arrival/removal announcement: the RegisterDeviceNotification registry and
 * the WM_DEVICECHANGE senders.
 *
 * Windows announces a hot-plug through two independent mechanisms, and an app of
 * this era may listen to either:
 *   - DBT_DEVNODES_CHANGED, lParam 0, broadcast to every top-level window with no
 *     registration at all — the cheap "something changed, re-enumerate" ping.
 *   - DBT_DEVICEARRIVAL / DBT_DEVICEREMOVECOMPLETE with a DEV_BROADCAST_DEVICEINTERFACE
 *     in lParam, delivered ONLY to windows that registered for the matching interface
 *     class.
 */

import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import {
    DBT_DEVICEARRIVAL,
    DBT_DEVICEREMOVECOMPLETE,
    DBT_DEVNODES_CHANGED,
    DBT_DEVTYP_DEVICEINTERFACE,
    DEVICE_NOTIFY_ALL_INTERFACE_CLASSES,
    GUID_DEVINTERFACE_HID,
    WM_DEVICECHANGE,
    encodeDevBroadcastDeviceInterface,
    guidToHex,
    readDevBroadcastFilter,
} from './dev-broadcast';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

const HID_CLASS_GUID = guidToHex(GUID_DEVINTERFACE_HID);

/**
 * Interface path of the emulated pad. Shape matches a real HID device interface
 * (\\?\HID#VID_xxxx&PID_xxxx#instance#{class}); the IDs are the same neutral pair
 * JOYCAPS reports for the winmm port (wMid 0xFFFF / wPid 0x0001).
 */
const GAMEPAD_INTERFACE_NAME =
    '\\\\?\\HID#VID_FFFF&PID_0001#1&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}';

interface DeviceNotification {
    hRecipient: number;
    devicetype: number;
    /** null = DEVICE_NOTIFY_ALL_INTERFACE_CLASSES; dbcc_classguid is then ignored. */
    classGuid: string | null;
    unicode: boolean;
}

const registrations = new Map<number, DeviceNotification>();
let nextHandle = 0x00021000;

/**
 * The guest DEV_BROADCAST_DEVICEINTERFACE handed out as lParam, one per charset.
 * Its content is the same for every registration and every event, so it is
 * allocated once — a per-event struct would leak on a plug/unplug storm. Freed
 * only at process reset: a posted message may still be sitting in the queue
 * holding the pointer, so unregistering must not pull it out from under it.
 */
const payloads = { ansi: 0, wide: 0 };

/** HDEVNOTIFY RegisterDeviceNotificationA/W. Returns 0 (and sets last error) on failure. */
export function registerDeviceNotification(
    mem: Uint8Array,
    hRecipient: number,
    notificationFilter: number,
    flags: number,
    unicode: boolean,
): number {
    const setLastError = (code: number): void => {
        System.getInstance().scheduler?.setLastError(code);
    };
    if (!hRecipient) {
        setLastError(ERROR_INVALID_HANDLE);
        return 0;
    }
    const allClasses = (flags & DEVICE_NOTIFY_ALL_INTERFACE_CLASSES) !== 0;
    // With DEVICE_NOTIFY_ALL_INTERFACE_CLASSES the filter may still be supplied but
    // its class GUID is ignored; without it a filter is mandatory.
    const filter = notificationFilter ? readDevBroadcastFilter(mem, notificationFilter) : null;
    if (!filter && !allClasses) {
        setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }

    const handle = nextHandle++;
    registrations.set(handle, {
        hRecipient: hRecipient >>> 0,
        devicetype: filter?.devicetype ?? DBT_DEVTYP_DEVICEINTERFACE,
        classGuid: allClasses ? null : (filter?.classGuid ?? null),
        unicode,
    });
    Logger.log(LogCategory.SYSTEM,
        `RegisterDeviceNotification${unicode ? 'W' : 'A'}: hwnd=0x${(hRecipient >>> 0).toString(16)} ` +
        `type=${filter?.devicetype ?? '-'} class=${allClasses ? 'ALL' : (filter?.classGuid ?? 'none')} -> 0x${handle.toString(16)}`);
    return handle;
}

/** BOOL UnregisterDeviceNotification(HDEVNOTIFY). */
export function unregisterDeviceNotification(handle: number): boolean {
    if (!registrations.delete(handle >>> 0)) {
        System.getInstance().scheduler?.setLastError(ERROR_INVALID_HANDLE);
        return false;
    }
    return true;
}

/** Guest copy of the payload for `unicode`, allocated on first use. Returns 0 when
 *  there is no process to allocate from. */
function ensurePayload(unicode: boolean): number {
    const key = unicode ? 'wide' : 'ansi';
    if (payloads[key]) return payloads[key];
    const memory = System.getInstance().process?.memory;
    if (!memory) return 0;
    const bytes = encodeDevBroadcastDeviceInterface(GAMEPAD_INTERFACE_NAME, unicode);
    const ptr = memory.alloc(bytes.length);
    if (!ptr) return 0;
    Mem.writeBytes(ptr, bytes);
    payloads[key] = ptr;
    return ptr;
}

function matchesHidInterface(entry: DeviceNotification): boolean {
    if (entry.devicetype !== DBT_DEVTYP_DEVICEINTERFACE) return false;
    return entry.classGuid === null || entry.classGuid === HID_CLASS_GUID;
}

/**
 * Announce a gamepad hot-plug the way Windows does. `arrived` false is a removal.
 * The devnode ping brackets the interface notification on the side the real device
 * tree changes: the node appears before its interface is enabled, and the interface
 * is disabled before the node goes away.
 */
export function broadcastGamepadDeviceChange(arrived: boolean): void {
    const system = System.getInstance();
    const wm = system.windowManager;
    if (!wm) return;

    const postInterfaceEvent = (): number => {
        let delivered = 0;
        for (const entry of registrations.values()) {
            if (!matchesHidInterface(entry)) continue;
            if (!wm.getWindow(entry.hRecipient)) continue; // service handles / dead windows
            const payload = ensurePayload(entry.unicode);
            if (!payload) continue;
            wm.postMessage(entry.hRecipient, WM_DEVICECHANGE,
                arrived ? DBT_DEVICEARRIVAL : DBT_DEVICEREMOVECOMPLETE, payload);
            delivered++;
        }
        return delivered;
    };

    let delivered = 0;
    let broadcast = 0;
    if (arrived) {
        broadcast = wm.broadcastToTopLevel(WM_DEVICECHANGE, DBT_DEVNODES_CHANGED, 0);
        delivered = postInterfaceEvent();
    } else {
        delivered = postInterfaceEvent();
        broadcast = wm.broadcastToTopLevel(WM_DEVICECHANGE, DBT_DEVNODES_CHANGED, 0);
    }

    Logger.log(LogCategory.SYSTEM,
        `WM_DEVICECHANGE: gamepad ${arrived ? 'arrival' : 'removal'} — ` +
        `DBT_DEVNODES_CHANGED to ${broadcast} top-level window(s), ` +
        `${arrived ? 'DBT_DEVICEARRIVAL' : 'DBT_DEVICEREMOVECOMPLETE'} to ${delivered} registration(s)`);
}

/** Registered handles + their filters (diagnostics / harness). */
export function getDeviceNotifications(): Array<{ handle: number } & DeviceNotification> {
    return Array.from(registrations, ([handle, e]) => ({ handle, ...e }));
}

/** Drop every registration so a fresh process does not inherit the previous one's. */
export function resetDeviceNotifications(): void {
    const memory = System.getInstance().process?.memory;
    for (const key of ['ansi', 'wide'] as const) {
        if (payloads[key]) memory?.free(payloads[key]);
        payloads[key] = 0;
    }
    registrations.clear();
    nextHandle = 0x00021000;
}
