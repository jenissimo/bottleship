/**
 * The part of IDirect3DResource9 that is shared by every D3D9 resource.
 *
 * Keep this store independent from resource-registry.ts.  The registry owns
 * GPU/resource metadata and imports shared-state, while this file only owns
 * COM private-data references; keeping the direction one-way avoids adding a
 * module cycle to the resource creation hot path.
 */

import { Mem } from '../../core/memory/mem-accessor';
import { addComRef, releaseComRef } from './com-refs';

export const D3D_OK = 0;
export const D3DERR_INVALIDCALL = 0x8876086c;
export const D3DERR_NOTFOUND = 0x88760866;
export const D3DERR_MOREDATA = 0x88760867;

const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DPOOL_SYSTEMMEM = 2;
const D3DPOOL_SCRATCH = 3;
const D3DUSAGE_RENDERTARGET = 0x00000001;
const D3DUSAGE_DEPTHSTENCIL = 0x00000002;
const D3DUSAGE_WRITEONLY = 0x00000008;
const D3DUSAGE_DYNAMIC = 0x00000200;
const D3DUSAGE_AUTOGENMIPMAP = 0x00000400;

/** D3DSPD_IUNKNOWN: pData is an IUnknown pointer, not a byte buffer. */
export const D3DSPD_IUNKNOWN = 0x00000001;

type PrivateData = {
    bytes: Uint8Array;
    flags: number;
    /** The object held by a D3DSPD_IUNKNOWN entry, when our COM registry knows it. */
    unknownPtr: number;
    retainedUnknown: boolean;
};

const privateData = new Map<number, Map<string, PrivateData>>();
const priorities = new Map<number, number>();
/**
 * References to guest IUnknowns which are not one of our COM allocations.
 * We cannot safely call an arbitrary guest vtable from an HLE thunk, but we
 * still retain the ownership edge so replacing/clearing private data balances
 * the reference we accepted and tests can observe the contract.
 */
const opaqueUnknownRefs = new Map<number, number>();

function guidKey(mem: Uint8Array, ptr: number): string | null {
    if (!ptr || ptr < 0 || ptr + 16 > mem.length) return null;
    let key = '';
    for (let i = 0; i < 16; i++) key += mem[ptr + i]!.toString(16).padStart(2, '0');
    return key;
}

function releaseEntry(entry: PrivateData | undefined): void {
    if (!entry?.unknownPtr || !entry.retainedUnknown) return;
    if (releaseComRef(entry.unknownPtr) !== undefined) return;
    const key = entry.unknownPtr >>> 0;
    const count = opaqueUnknownRefs.get(key) ?? 0;
    if (count <= 1) opaqueUnknownRefs.delete(key);
    else opaqueUnknownRefs.set(key, count - 1);
}

function retainUnknown(ptr: number): boolean {
    if (!ptr) return false;
    if (addComRef(ptr) !== undefined) return true;
    const key = ptr >>> 0;
    opaqueUnknownRefs.set(key, (opaqueUnknownRefs.get(key) ?? 0) + 1);
    return true;
}

function entryMap(ptr: number, create: boolean): Map<string, PrivateData> | undefined {
    const key = ptr >>> 0;
    let map = privateData.get(key);
    if (!map && create) {
        map = new Map();
        privateData.set(key, map);
    }
    return map;
}

export function clearResourceContract(ptr: number): void {
    const key = ptr >>> 0;
    const map = privateData.get(key);
    if (map) {
        for (const entry of map.values()) releaseEntry(entry);
        privateData.delete(key);
    }
    priorities.delete(key);
}

export function resetResourceContract(): void {
    for (const key of privateData.keys()) clearResourceContract(key);
    privateData.clear();
    priorities.clear();
    opaqueUnknownRefs.clear();
}

/** D3DPOOL/D3DUSAGE matrix shared by 2-D, cube and volume texture creation. */
export function isValidTextureUsagePool(usage: number, pool: number): boolean {
    const u = usage >>> 0;
    const p = pool >>> 0;
    if (p !== D3DPOOL_DEFAULT && p !== D3DPOOL_MANAGED
        && p !== D3DPOOL_SYSTEMMEM && p !== D3DPOOL_SCRATCH) return false;
    if ((u & (D3DUSAGE_RENDERTARGET | D3DUSAGE_DEPTHSTENCIL)) !== 0
        && p !== D3DPOOL_DEFAULT) return false;
    if ((u & D3DUSAGE_DYNAMIC) !== 0
        && (p === D3DPOOL_MANAGED || p === D3DPOOL_SCRATCH)) return false;
    if ((u & D3DUSAGE_AUTOGENMIPMAP) !== 0
        && (p === D3DPOOL_SYSTEMMEM || p === D3DPOOL_SCRATCH)) return false;
    // The runtime rejects a dynamic render/depth target rather than silently
    // choosing one of the two incompatible storage contracts.
    if ((u & D3DUSAGE_DYNAMIC) !== 0
        && (u & (D3DUSAGE_RENDERTARGET | D3DUSAGE_DEPTHSTENCIL)) !== 0) return false;
    // WRITEONLY is a vertex/index-buffer usage, never a texture usage.
    if ((u & D3DUSAGE_WRITEONLY) !== 0) return false;
    return true;
}

/** D3DUSAGE_DYNAMIC is valid for DEFAULT and SYSTEMMEM buffers, not MANAGED/SCRATCH. */
export function isValidBufferUsagePool(usage: number, pool: number): boolean {
    const p = pool >>> 0;
    if (p !== D3DPOOL_DEFAULT && p !== D3DPOOL_MANAGED
        && p !== D3DPOOL_SYSTEMMEM && p !== D3DPOOL_SCRATCH) return false;
    return (usage & D3DUSAGE_DYNAMIC) === 0
        || p === D3DPOOL_DEFAULT || p === D3DPOOL_SYSTEMMEM;
}

export function resourceSetPrivateData(
    mem: Uint8Array,
    args: number[],
    isLive: (ptr: number) => boolean,
): number {
    const ptr = args[0] >>> 0;
    const guid = guidKey(mem, args[1] >>> 0);
    const dataPtr = args[2] >>> 0;
    const size = args[3] >>> 0;
    const flags = args[4] >>> 0;
    if (!isLive(ptr) || !guid) return D3DERR_INVALIDCALL;
    if ((flags & ~D3DSPD_IUNKNOWN) !== 0) return D3DERR_INVALIDCALL;
    if ((flags & D3DSPD_IUNKNOWN) !== 0 && size !== 4) return D3DERR_INVALIDCALL;
    if (size !== 0 && !dataPtr) return D3DERR_INVALIDCALL;

    let unknownPtr = 0;
    let retainedUnknown = false;
    if ((flags & D3DSPD_IUNKNOWN) !== 0) {
        // D3D9's private-data ABI receives the interface pointer itself as
        // pData (the pointed-to value is not an extra level of indirection).
        unknownPtr = dataPtr;
        if (!unknownPtr) return D3DERR_INVALIDCALL;
        // Known local COM objects receive a real registry AddRef. Opaque guest
        // IUnknowns are accepted as well; rejecting them breaks the standard
        // effect/private-data pattern used by D3DX.
        retainedUnknown = retainUnknown(unknownPtr);
    }
    const bytes = (flags & D3DSPD_IUNKNOWN) !== 0
        ? new Uint8Array(4)
        : (size === 0 ? new Uint8Array(0) : (() => {
            const source = Mem.readBytes(dataPtr, size);
            return source ? new Uint8Array(source) : null;
        })());
    if (!bytes) {
        if (retainedUnknown) releaseEntry({ bytes: new Uint8Array(0), flags, unknownPtr, retainedUnknown });
        return D3DERR_INVALIDCALL;
    }
    if ((flags & D3DSPD_IUNKNOWN) !== 0) {
        new DataView(bytes.buffer).setUint32(0, unknownPtr, true);
    }

    const map = entryMap(ptr, true)!;
    releaseEntry(map.get(guid));
    map.set(guid, { bytes, flags, unknownPtr, retainedUnknown });
    return D3D_OK;
}

export function resourceGetPrivateData(
    mem: Uint8Array,
    args: number[],
    isLive: (ptr: number) => boolean,
): number {
    const ptr = args[0] >>> 0;
    const guid = guidKey(mem, args[1] >>> 0);
    const dataPtr = args[2] >>> 0;
    const sizePtr = args[3] >>> 0;
    if (!isLive(ptr) || !guid || !sizePtr) return D3DERR_INVALIDCALL;
    const entry = entryMap(ptr, false)?.get(guid);
    if (!entry) return D3DERR_NOTFOUND;
    const requested = Mem.readUint32(sizePtr);
    if (requested === null) return D3DERR_INVALIDCALL;
    // NULL pData is the documented size-query form.  It is not a short-buffer
    // error; callers use this as the first half of the GetPrivateData idiom.
    if (!dataPtr) {
        if (!Mem.writeUint32(sizePtr, entry.bytes.length)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    }
    if (requested < entry.bytes.length) {
        if (!Mem.writeUint32(sizePtr, entry.bytes.length)) return D3DERR_INVALIDCALL;
        return D3DERR_MOREDATA;
    }
    if (entry.bytes.length && Mem.writeBytes(dataPtr, entry.bytes) !== entry.bytes.length) {
        return D3DERR_INVALIDCALL;
    }
    if (!Mem.writeUint32(sizePtr, entry.bytes.length)) return D3DERR_INVALIDCALL;
    if (entry.unknownPtr && (entry.flags & D3DSPD_IUNKNOWN) !== 0) retainUnknown(entry.unknownPtr);
    return D3D_OK;
}

export function resourceFreePrivateData(
    mem: Uint8Array,
    args: number[],
    isLive: (ptr: number) => boolean,
): number {
    const ptr = args[0] >>> 0;
    const guid = guidKey(mem, args[1] >>> 0);
    if (!isLive(ptr) || !guid) return D3DERR_INVALIDCALL;
    const map = entryMap(ptr, false);
    const entry = map?.get(guid);
    if (!entry) return D3DERR_NOTFOUND;
    releaseEntry(entry);
    map!.delete(guid);
    if (map!.size === 0) privateData.delete(ptr);
    return D3D_OK;
}

export function resourceSetPriority(
    args: number[],
    isLive: (ptr: number) => boolean,
    getPool?: (ptr: number) => number | null,
): number {
    const ptr = args[0] >>> 0;
    if (!isLive(ptr)) return 0;
    const old = priorities.get(ptr) ?? 0;
    // D3D9 only stores priority for MANAGED resources.  SetPriority still
    // succeeds for DEFAULT/SYSTEMMEM/SCRATCH, but the value is ignored and the
    // previous priority is returned (DXVK's D3D9Resource contract does the
    // same).  Ex DEFAULT resources are a separate contract and are deliberately
    // not inferred here; their handlers can supply a policy when available.
    if (getPool && getPool(ptr) !== 1) return old >>> 0;
    priorities.set(ptr, args[1] >>> 0);
    return old >>> 0;
}

export function resourceGetPriority(args: number[], isLive: (ptr: number) => boolean): number {
    const ptr = args[0] >>> 0;
    return isLive(ptr) ? (priorities.get(ptr) ?? 0) >>> 0 : 0;
}

export function resourcePreLoad(args: number[], isLive: (ptr: number) => boolean): number {
    // Native PreLoad is void.  The generated thunk still carries a u32 return
    // slot for the legacy descriptor ABI; callers must ignore it.
    return isLive(args[0] >>> 0) ? D3D_OK : D3DERR_INVALIDCALL;
}

/** Used by tests and teardown code without exposing the backing maps. */
export function getResourcePrivateDataSize(ptr: number, guid: string): number {
    return privateData.get(ptr >>> 0)?.get(guid)?.bytes.length ?? 0;
}

/** Test/diagnostic visibility for the opaque-IUnknown ownership seam. */
export function getOpaqueUnknownReferenceCount(ptr: number): number {
    return opaqueUnknownRefs.get(ptr >>> 0) ?? 0;
}
