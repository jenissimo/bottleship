/**
 * Stable D3D8/D3D9 adapter identifier values shared across HLE modules.
 * RenderWare titles (GTA III) compare adapter identity across sessions when
 * validating install texture cache (CAPS.DAT / txd.*).
 */

import { Mem } from '../../../core/memory/mem-accessor';
import { Marshaler } from '../../../core/memory/marshaler';

export const D3DENUM_WHQL_LEVEL = 0x00000002;

/** NVIDIA — matches DXVK d3d9_adapter.cpp GetDriverDLL path. */
export const DEFAULT_VENDOR_ID = 0x10de;
/**
 * GA102 — the SAME card d3d9/caps.ts dumps its D3DCAPS9 from. Identifier and caps are
 * one answer to "what hardware is this", and an engine may combine them: a pair that
 * never shipped puts it in a state no real machine produced. An older DeviceId is not
 * the safe conservative choice it looks like — PoP:SoT clears its occlusion-capability
 * bit for any NVIDIA DeviceId <= 0x24f, a 2003 blacklist aimed at GeForce 2/3/4 that
 * NV40's numerically low 0x0040 fell into.
 *
 * DeviceId is a stable cache key for RenderWare titles (GTA III CAPS.DAT / txd.*);
 * changing it forces a one-time texture-cache rebuild, not a correctness break.
 */
export const DEFAULT_DEVICE_ID = 0x2204;
/** UMD file version 31.0.15.3699, packed as D3D9 does: (major<<16|minor, build<<16|rev). */
export const DEFAULT_DRIVER_VERSION = 0x001f0000000f0e73n;
export const DEFAULT_DRIVER_DLL = 'nvd3dum.dll';
export const DEFAULT_DEVICE_DESC = 'NVIDIA GeForce RTX 3090';

export const D3DADAPTER_IDENTIFIER8_SIZE = 1068;

const D3DADAPTER_IDENTIFIER8_OFFSETS = {
    Driver: 0,
    Description: 512,
    DriverVersion: 1024,
    VendorId: 1032,
    DeviceId: 1036,
    SubSysId: 1040,
    Revision: 1044,
    DeviceIdentifier: 1048,
    WHQLLevel: 1064,
} as const;

export const D3DADAPTER_IDENTIFIER9_SIZE = 1100;

export const D3DADAPTER_IDENTIFIER9_OFFSETS = {
    Driver: 0,
    Description: 512,
    DeviceName: 1024,
    DriverVersion: 1056,
    VendorId: 1064,
    DeviceId: 1068,
    SubSysId: 1072,
    Revision: 1076,
    DeviceIdentifier: 1080,
    WHQLLevel: 1096,
} as const;

function writeStableAdapterIds(mem: Uint8Array, pIdentifier: number, offsets: {
    DriverVersion: number;
    VendorId: number;
    DeviceId: number;
    SubSysId: number;
    Revision: number;
    DeviceIdentifier: number;
    WHQLLevel: number;
}, flags: number): boolean {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setBigUint64(pIdentifier + offsets.DriverVersion, DEFAULT_DRIVER_VERSION, true);

    if (
        !Mem.writeUint32(pIdentifier + offsets.VendorId, DEFAULT_VENDOR_ID) ||
        !Mem.writeUint32(pIdentifier + offsets.DeviceId, DEFAULT_DEVICE_ID) ||
        !Mem.writeUint32(pIdentifier + offsets.SubSysId, 0) ||
        !Mem.writeUint32(pIdentifier + offsets.Revision, 1)
    ) {
        return false;
    }

    for (let i = 0; i < 16; i++) {
        if (!Mem.writeUint8(pIdentifier + offsets.DeviceIdentifier + i, i)) {
            return false;
        }
    }

    if (flags & D3DENUM_WHQL_LEVEL) {
        if (!Mem.writeUint32(pIdentifier + offsets.WHQLLevel, 0)) {
            return false;
        }
    }

    return true;
}

export function writeAdapterIdentifier8(mem: Uint8Array, pIdentifier: number, flags: number): boolean {
    if (Mem.writeBytes(pIdentifier, new Uint8Array(D3DADAPTER_IDENTIFIER8_SIZE)) !== D3DADAPTER_IDENTIFIER8_SIZE) {
        return false;
    }

    Marshaler.writeString(mem, pIdentifier + D3DADAPTER_IDENTIFIER8_OFFSETS.Driver, DEFAULT_DRIVER_DLL, 512);
    Marshaler.writeString(mem, pIdentifier + D3DADAPTER_IDENTIFIER8_OFFSETS.Description, DEFAULT_DEVICE_DESC, 512);

    return writeStableAdapterIds(mem, pIdentifier, D3DADAPTER_IDENTIFIER8_OFFSETS, flags);
}

export function writeAdapterIdentifier9(mem: Uint8Array, pIdentifier: number, flags: number): boolean {
    if (Mem.writeBytes(pIdentifier, new Uint8Array(D3DADAPTER_IDENTIFIER9_SIZE)) !== D3DADAPTER_IDENTIFIER9_SIZE) {
        return false;
    }

    Marshaler.writeString(mem, pIdentifier + D3DADAPTER_IDENTIFIER9_OFFSETS.Driver, DEFAULT_DRIVER_DLL, 512);
    Marshaler.writeString(mem, pIdentifier + D3DADAPTER_IDENTIFIER9_OFFSETS.Description, DEFAULT_DEVICE_DESC, 512);
    Marshaler.writeString(mem, pIdentifier + D3DADAPTER_IDENTIFIER9_OFFSETS.DeviceName, '\\\\.\\DISPLAY1', 32);

    return writeStableAdapterIds(mem, pIdentifier, D3DADAPTER_IDENTIFIER9_OFFSETS, flags);
}
