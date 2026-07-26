/**
 * WM_DEVICECHANGE wire format: DBT_* codes and the DEV_BROADCAST_* structs that
 * ride in lParam.
 *
 * Leaf module — no worker imports — so tools/validate-struct-offsets.ts can check
 * these offsets against the same table the implementation writes and reads.
 */

export const WM_DEVICECHANGE = 0x0219;

// wParam event codes
/** "The device tree changed" — broadcast to every top-level window, lParam = 0. */
export const DBT_DEVNODES_CHANGED = 0x0007;
export const DBT_DEVICEARRIVAL = 0x8000;
export const DBT_DEVICEREMOVECOMPLETE = 0x8004;

/** DEV_BROADCAST_HDR.dbch_devicetype — the only class we announce. */
export const DBT_DEVTYP_DEVICEINTERFACE = 0x00000005;

/** RegisterDeviceNotification Flags: subscribe to every interface class, so
 *  dbcc_classguid in the filter is ignored. */
export const DEVICE_NOTIFY_ALL_INTERFACE_CLASSES = 0x00000004;

export const DEV_BROADCAST_HDR_OFFSETS = {
    dbch_size: 0,
    dbch_devicetype: 4,
    dbch_reserved: 8,
} as const;
export const DEV_BROADCAST_HDR_SIZE = 12;

/** dbcc_name is a trailing variable-length string; 32 is sizeof() with the [1] stub. */
export const DEV_BROADCAST_DEVICEINTERFACE_OFFSETS = {
    dbcc_size: 0,
    dbcc_devicetype: 4,
    dbcc_reserved: 8,
    dbcc_classguid: 12, // GUID, 16 bytes
    dbcc_name: 28,
} as const;
export const DEV_BROADCAST_DEVICEINTERFACE_SIZE = 32;

/** GUID_DEVINTERFACE_HID {4D1E55B2-F16F-11CF-88CB-001111000030} in GUID memory order. */
export const GUID_DEVINTERFACE_HID = new Uint8Array([
    0xb2, 0x55, 0x1e, 0x4d, // Data1, LE DWORD
    0x6f, 0xf1,             // Data2, LE WORD
    0xcf, 0x11,             // Data3, LE WORD
    0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30, // Data4, byte order as written
]);

/** 32 lowercase hex chars of the 16 raw GUID bytes — an identity key, not a format. */
export function guidToHex(bytes: Uint8Array, offset = 0): string {
    let out = '';
    for (let i = 0; i < 16; i++) out += (bytes[offset + i] ?? 0).toString(16).padStart(2, '0');
    return out;
}

export interface DevBroadcastFilter {
    devicetype: number;
    /** null when the filter carries no class GUID (non-interface devicetype). */
    classGuid: string | null;
}

/** Parse the DEV_BROADCAST_HDR (+ DEVICEINTERFACE tail) a caller passed to
 *  RegisterDeviceNotification. Returns null when the buffer is short or malformed. */
export function readDevBroadcastFilter(mem: Uint8Array, ptr: number): DevBroadcastFilter | null {
    const H = DEV_BROADCAST_HDR_OFFSETS;
    if (!ptr || ptr + DEV_BROADCAST_HDR_SIZE > mem.length) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const size = view.getUint32(ptr + H.dbch_size, true);
    if (size < DEV_BROADCAST_HDR_SIZE) return null;
    const devicetype = view.getUint32(ptr + H.dbch_devicetype, true);
    const I = DEV_BROADCAST_DEVICEINTERFACE_OFFSETS;
    const hasGuid = devicetype === DBT_DEVTYP_DEVICEINTERFACE
        && size >= I.dbcc_classguid + 16
        && ptr + I.dbcc_classguid + 16 <= mem.length;
    return { devicetype, classGuid: hasGuid ? guidToHex(mem, ptr + I.dbcc_classguid) : null };
}

/**
 * Build the DEV_BROADCAST_DEVICEINTERFACE that rides in lParam of a
 * DBT_DEVICEARRIVAL / DBT_DEVICEREMOVECOMPLETE. dbcc_size covers the header plus
 * the whole NUL-terminated name, DWORD-rounded — recipients walk to dbcc_name and
 * read up to dbcc_size, so a size that stops short of the terminator truncates it.
 */
export function encodeDevBroadcastDeviceInterface(
    name: string,
    unicode: boolean,
    classGuid: Uint8Array = GUID_DEVINTERFACE_HID,
): Uint8Array {
    const I = DEV_BROADCAST_DEVICEINTERFACE_OFFSETS;
    const charSize = unicode ? 2 : 1;
    const size = (I.dbcc_name + (name.length + 1) * charSize + 3) & ~3;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(I.dbcc_size, size, true);
    view.setUint32(I.dbcc_devicetype, DBT_DEVTYP_DEVICEINTERFACE, true);
    view.setUint32(I.dbcc_reserved, 0, true);
    buf.set(classGuid.subarray(0, 16), I.dbcc_classguid);
    for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (unicode) view.setUint16(I.dbcc_name + i * 2, code & 0xffff, true);
        else buf[I.dbcc_name + i] = code & 0xff;
    }
    return buf;
}
