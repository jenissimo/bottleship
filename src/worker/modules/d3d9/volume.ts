/** D3D9 volume-texture and volume-subresource COM handlers. */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import {
    addComRef,
    devices,
    getVTables,
    createComObject,
    registerDeviceChildFinalizer,
    releaseComRef,
    resourceToDevice,
} from './shared-state';
import { initReturnPtr } from '../../backends/webgpu/shared/dx-com-helpers';
import {
    isDxExclusiveFormat,
    isDxUnsupportedFormat,
} from '../../backends/webgpu/shared/dx-format-support';
import {
    isD3D9VolumeExtentSupported,
    resolveD3D9VolumePolicy,
} from '../../backends/webgpu/shared/volume-policy';
import {
    resourceSetPrivateData,
    resourceGetPrivateData,
    resourceFreePrivateData,
    resourceSetPriority,
    resourceGetPriority,
    resourcePreLoad,
    clearResourceContract,
    isValidTextureUsagePool,
} from './resource-contract';
import {
    VolumeBox,
    computeVolumeMipLevelCount,
    createVolumeTextureResource,
    getVolumeLevel,
    getVolumeLevelDims,
    lockVolumeBox,
    releaseVolumeTextureResource,
    unlockVolumeBox,
    volumeLevelObjects,
    volumeLevelParents,
    volumeTextureResources,
} from './volume-resources';
import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';
import type { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import { IID_IDIRECT3DVOLUME9, IID_IUNKNOWN, readD3D9GuidKey } from './object-contracts';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_NOINTERFACE = 0x80004002;
const D3DFMT_UNKNOWN = 0;
const D3DRTYPE_UNKNOWN = 0;
const D3DRTYPE_VOLUME = 2;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DUSAGE_AUTOGENMIPMAP = 0x00000400;
const D3DTEXF_LINEAR = 2;
const D3DTEXF_POINT = 1;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DLOCK_READONLY = 0x0010;
const D3DLOCK_NOOVERWRITE = 0x1000;
const D3DLOCK_DISCARD = 0x2000;
const D3DLOCK_NO_DIRTY_UPDATE = 0x8000;

const volumeLockFlags = new Map<string, { readOnly: boolean; noDirtyUpdate: boolean }>();

function clearVolumeLockFlags(texturePtr: number): void {
    const prefix = `${texturePtr >>> 0}:`;
    for (const key of volumeLockFlags.keys()) {
        if (key.startsWith(prefix)) volumeLockFlags.delete(key);
    }
}

/** IID_IDirect3DVolumeTexture9 in guest-memory GUID byte order. */
const IID_IDIRECT3DVOLUMETEXTURE9 = '6c52182589e71141a7b947ef328d13e6';
const IID_IDIRECT3DRESOURCE9 = '5dc0ee057d8f6243b999d1baf357c704';
const IID_IDIRECT3DBASETEXTURE9 = '7ea80c583c1d544d991db7d3e3c298ce';

function resolveDevicePtr(deviceInstance: unknown): number {
    for (const [devicePtr, device] of devices.entries()) {
        if (device === deviceInstance) return devicePtr >>> 0;
    }
    return 0;
}

function writeVolumeDesc(pDesc: number, texturePtr: number, level: number): boolean {
    const resource = volumeTextureResources.get(texturePtr >>> 0);
    const dims = resource ? getVolumeLevelDims(resource.width, resource.height, resource.depth, level) : null;
    if (!resource || !dims || !pDesc) return false;
    // D3DVOLUME_DESC { Format, Type, Usage, Pool, Width, Height, Depth }.
    return Mem.writeUint32(pDesc + 0, resource.format >>> 0)
        && Mem.writeUint32(pDesc + 4, D3DRTYPE_VOLUME)
        && Mem.writeUint32(pDesc + 8, resource.usage >>> 0)
        && Mem.writeUint32(pDesc + 12, resource.pool >>> 0)
        && Mem.writeUint32(pDesc + 16, dims.width >>> 0)
        && Mem.writeUint32(pDesc + 20, dims.height >>> 0)
        && Mem.writeUint32(pDesc + 24, dims.depth >>> 0);
}

function readVolumeBox(mem: Uint8Array, pBox: number): VolumeBox | null {
    if (!pBox) return null;
    const values = [0, 4, 8, 12, 16, 20].map((offset) => Mem.readUint32(pBox + offset));
    if (values.some((value) => value === null)) return null;
    return {
        left: values[0]!, top: values[1]!, front: values[2]!,
        right: values[3]!, bottom: values[4]!, back: values[5]!,
    };
}

function getParentForVolumeLevel(volumePtr: number): { texturePtr: number; level: number } | null {
    return volumeLevelParents.get(volumePtr >>> 0) ?? null;
}

/** CPU fallback for AUTOGEN volume mips. Native WebGPU 3-D generation is not
 * available in every host, but the API-visible storage is guest memory, so a
 * deterministic 2x2x2 filter is still preferable to claiming success with
 * stale lower levels. Restrict this to the formats whose texel layout is
 * unambiguously four bytes; compressed/packed formats remain NOTAVAILABLE. */
function generateVolumeMips(texturePtr: number, filter: number): number {
    const resource = volumeTextureResources.get(texturePtr >>> 0);
    if (!resource || resource.levels < 2) return D3D_OK;
    // The CPU volume kernel below only implements the D3D9 POINT and LINEAR
    // footprints.  Do not silently map anisotropic/quad/convolution filters to
    // the linear box average: that would report success while producing a
    // different mip chain from the requested contract.
    if (filter !== D3DTEXF_POINT && filter !== D3DTEXF_LINEAR) return D3DERR_NOTAVAILABLE;
    const layout = getD3DTextureLayout(resource.format, resource.width, resource.height);
    // This kernel operates on exactly four byte channels.  A merely-large
    // enough pitch is not proof of that layout: 8/16-byte formats would pass
    // the old lower-bound check and then be indexed at x*4, corrupting mips.
    if (layout.compressed || layout.pitch !== resource.width * 4) return D3DERR_NOTAVAILABLE;
    for (let level = 1; level < resource.levels; level++) {
        const src = getVolumeLevel(texturePtr, level - 1);
        const dst = getVolumeLevel(texturePtr, level);
        if (!src || !dst) return D3DERR_INVALIDCALL;
        const srcBytes = Mem.readBytes(src.ptr, src.bytes);
        if (!srcBytes) return D3DERR_INVALIDCALL;
        const out = new Uint8Array(dst.bytes);
        const sx = (x: number, y: number, z: number, c: number): number => {
            const xx = Math.min(src.width - 1, x);
            const yy = Math.min(src.height - 1, y);
            const zz = Math.min(src.depth - 1, z);
            return srcBytes[zz * src.slicePitch + yy * src.pitch + xx * 4 + c] ?? 0;
        };
        for (let z = 0; z < dst.depth; z++) for (let y = 0; y < dst.height; y++) for (let x = 0; x < dst.width; x++) {
            const base = z * dst.slicePitch + y * dst.pitch + x * 4;
            for (let c = 0; c < 4; c++) {
                if (filter === D3DTEXF_POINT) {
                    out[base + c] = sx(x * 2, y * 2, z * 2, c);
                } else {
                    let sum = 0;
                    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                        sum += sx(x * 2 + dx, y * 2 + dy, z * 2 + dz, c);
                    }
                    out[base + c] = Math.round(sum / 8);
                }
            }
        }
        if (!Mem.writeBytes(dst.ptr, out)) return D3DERR_INVALIDCALL;
    }
    return D3D_OK;
}

export function createVolumeExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const baseTextureState = new Map<number, { lod: number; autoGenFilterType: number }>();

    const validAutoGenFilter = (filter: number): boolean =>
        filter === 1 || filter === 2 || filter === 3 || filter === 6 || filter === 7 || filter === 8;
    const ensureBaseTextureState = (ptr: number, levels: number): { lod: number; autoGenFilterType: number } => {
        const key = ptr >>> 0;
        let state = baseTextureState.get(key);
        if (!state) {
            state = { lod: 0, autoGenFilterType: D3DTEXF_LINEAR };
            baseTextureState.set(key, state);
        }
        state.lod = Math.min(state.lod >>> 0, Math.max(0, (levels >>> 0) - 1));
        return state;
    };

    const installComLifetime = (prefix: 'IDirect3DVolumeTexture9' | 'IDirect3DVolume9'): void => {
        exports[`${prefix}_QueryInterface`] = (_ctx, _mem, args) => {
            const objectPtr = args[0] >>> 0;
            const mem = _mem as Uint8Array;
            const ppObject = args[2] >>> 0;
            if (!ppObject) return 0x80004003; // E_POINTER
            const live = prefix === 'IDirect3DVolumeTexture9'
                ? volumeTextureResources.has(objectPtr)
                : volumeLevelParents.has(objectPtr);
            const key = readD3D9GuidKey(mem, args[1] >>> 0);
            const accepted = prefix === 'IDirect3DVolumeTexture9'
                ? new Set([IID_IUNKNOWN, IID_IDIRECT3DRESOURCE9, IID_IDIRECT3DBASETEXTURE9, IID_IDIRECT3DVOLUMETEXTURE9])
                : new Set([IID_IUNKNOWN, IID_IDIRECT3DVOLUME9]);
            if (!live || !key || !accepted.has(key)) {
                initReturnPtr(ppObject);
                return E_NOINTERFACE;
            }
            if (!Mem.writeUint32(ppObject, objectPtr)) return 0x80004003;
            const refTarget = prefix === 'IDirect3DVolume9'
                ? (volumeLevelParents.get(objectPtr)?.texturePtr ?? objectPtr)
                : objectPtr;
            addComRef(refTarget);
            return D3D_OK;
        };
        exports[`${prefix}_AddRef`] = (_ctx, _mem, args) => {
            const objectPtr = args[0] >>> 0;
            const refTarget = prefix === 'IDirect3DVolume9'
                ? (volumeLevelParents.get(objectPtr)?.texturePtr ?? objectPtr)
                : objectPtr;
            return addComRef(refTarget) ?? 0;
        };
        exports[`${prefix}_Release`] = (_ctx, _mem, args) => {
            const objectPtr = args[0] >>> 0;
            const refTarget = prefix === 'IDirect3DVolume9'
                ? (volumeLevelParents.get(objectPtr)?.texturePtr ?? objectPtr)
                : objectPtr;
            return releaseComRef(refTarget) ?? 0;
        };
    };
    installComLifetime('IDirect3DVolumeTexture9');
    installComLifetime('IDirect3DVolume9');

    const isLiveTexture = (ptr: number): boolean => volumeTextureResources.has(ptr >>> 0);
    const isLiveVolume = (ptr: number): boolean => volumeLevelParents.has(ptr >>> 0);
    const volumePool = (ptr: number): number | null => {
        const key = ptr >>> 0;
        const texture = volumeTextureResources.get(key);
        if (texture) return texture.pool;
        const parent = volumeLevelParents.get(key);
        return parent ? (volumeTextureResources.get(parent.texturePtr)?.pool ?? null) : null;
    };
    for (const [prefix, live] of [
        ['IDirect3DVolumeTexture9', isLiveTexture],
        ['IDirect3DVolume9', isLiveVolume],
    ] as const) {
        exports[`${prefix}_SetPrivateData`] = (_ctx, mem, args) => resourceSetPrivateData(mem, args, live);
        exports[`${prefix}_GetPrivateData`] = (_ctx, mem, args) => resourceGetPrivateData(mem, args, live);
        exports[`${prefix}_FreePrivateData`] = (_ctx, mem, args) => resourceFreePrivateData(mem, args, live);
        // IDirect3DVolume9 is not IDirect3DResource9.  Keep the resource
        // priority/preload entry points exclusive to VolumeTexture9; the
        // Volume9 descriptor has no such ABI slots.
        if (prefix === 'IDirect3DVolumeTexture9') {
            exports[`${prefix}_SetPriority`] = (_ctx, _mem, args) => resourceSetPriority(args, live, volumePool);
            exports[`${prefix}_GetPriority`] = (_ctx, _mem, args) => resourceGetPriority(args, live);
            exports[`${prefix}_PreLoad`] = (_ctx, _mem, args) => resourcePreLoad(args, live);
        }
    }

    const resourceGetDevice = (_ctx: unknown, _mem: unknown, args: number[]): number => {
        const pResource = args[0] >>> 0;
        const ppDevice = args[1] >>> 0;
        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);
        const device = resourceToDevice.get(pResource);
        const devicePtr = device ? resolveDevicePtr(device) : 0;
        if (!devicePtr || !Mem.writeUint32(ppDevice, devicePtr)) return D3DERR_INVALIDCALL;
        addComRef(devicePtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateVolumeTexture'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const width = args[1] >>> 0;
        const height = args[2] >>> 0;
        const depth = args[3] >>> 0;
        const requestedLevels = args[4] >>> 0;
        const usage = args[5] >>> 0;
        const format = args[6] >>> 0;
        const pool = args[7] >>> 0;
        const ppTexture = args[8] >>> 0;

        if (!ppTexture) return D3DERR_INVALIDCALL;
        initReturnPtr(ppTexture);
        if (!isValidTextureUsagePool(usage, pool)) return D3DERR_INVALIDCALL;
        if (!width || !height || !depth || format === D3DFMT_UNKNOWN || isDxExclusiveFormat(format, 9)) {
            return D3DERR_INVALIDCALL;
        }
        if (isDxUnsupportedFormat(format, 9)) return D3DERR_NOTAVAILABLE;
        // Keep creation coupled to the same explicit adapter contract used by
        // CheckDeviceFormat/GetDeviceCaps.  A CPU LockBox store alone is not
        // enough to advertise a D3D9 volume texture: the device must have
        // accepted the texture_3d format and dimensions that will be sampled.
        const volumePolicy = resolveD3D9VolumePolicy(9, format);
        if (!isD3D9VolumeExtentSupported(width, height, depth, volumePolicy)) {
            return D3DERR_NOTAVAILABLE;
        }
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        const ownerDevice = device;

        const vtableAddr = getVTables()['IDirect3DVolumeTexture9']?.address;
        const process = System.getInstance().process;
        if (!vtableAddr || !process) return D3DERR_INVALIDCALL;
        const fullLevels = computeVolumeMipLevelCount(width, height, depth);
        if (requestedLevels > fullLevels) return D3DERR_INVALIDCALL;
        const levels = requestedLevels || fullLevels;
        const allocator = {
            alloc: (size: number, _tag?: string): number => process.memory.alloc(size, 'HEAP'),
            free: (ptr: number): void => process.memory.free(ptr),
        };
        const texturePtr = createComObject(vtableAddr);
        clearVolumeLockFlags(texturePtr);
        baseTextureState.delete(texturePtr >>> 0);
        const resource = createVolumeTextureResource(width, height, depth, levels, usage, pool, format, allocator);
        if (!resource) {
            releaseComRef(texturePtr);
            return D3DERR_INVALIDCALL;
        }

        volumeTextureResources.set(texturePtr, resource);
        resourceToDevice.set(texturePtr, ownerDevice);
        (ownerDevice as D3D9Device).registerVolumeTexture(texturePtr);
        registerDeviceChildFinalizer(texturePtr, pDevice, () => {
            baseTextureState.delete(texturePtr >>> 0);
            // Reset/release drains finalizers before the volume registry is
            // cleared.  Forget any lock promise at that boundary so a reused
            // pointer cannot make a later UnlockBox publish with stale flags.
            clearVolumeLockFlags(texturePtr);
            // The texture holds the one reference each cached level object was created
            // with (AddRef/Release through a Volume9 land on the parent, so nothing else
            // ever drops it). Releasing it here is what runs each child's finalizer.
            const children = volumeLevelObjects.get(texturePtr);
            if (children) {
                for (const child of Array.from(children.values())) {
                    releaseComRef(child);
                    volumeLevelParents.delete(child);
                    resourceToDevice.delete(child);
                }
            }
            (ownerDevice as D3D9Device).releaseVolumeTexture(texturePtr);
            releaseVolumeTextureResource(texturePtr);
            clearResourceContract(texturePtr);
            resourceToDevice.delete(texturePtr);
        });
        Logger.log(LogCategory.D3D9,
            `CreateVolumeTexture(${width}x${height}x${depth}, Levels=${resource.levels}, Format=${format}) -> 0x${texturePtr.toString(16)}`);
        if (!Mem.writeUint32(ppTexture, texturePtr)) {
            releaseComRef(texturePtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DVolumeTexture9_GetDevice'] = resourceGetDevice;
    exports['IDirect3DVolume9_GetDevice'] = resourceGetDevice;

    exports['IDirect3DVolumeTexture9_GetLevelCount'] = (_ctx, _mem, args) => {
        return volumeTextureResources.get(args[0] >>> 0)?.levels ?? 1;
    };

    exports['IDirect3DVolumeTexture9_GetType'] = (_ctx, _mem, args) => {
        return volumeTextureResources.has(args[0] >>> 0) ? D3DRTYPE_VOLUMETEXTURE : D3DRTYPE_UNKNOWN;
    };

    // SetLOD/GetLOD are DWORD-returning and apply to D3DPOOL_MANAGED only; outside it both
    // report 0, and a stale pointer must not answer with an HRESULT posing as a LOD.
    exports['IDirect3DVolumeTexture9_SetLOD'] = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0;
        const resource = volumeTextureResources.get(ptr);
        if (!resource || resource.pool !== D3DPOOL_MANAGED) return 0;
        const state = ensureBaseTextureState(ptr, resource.levels);
        const previous = state.lod >>> 0;
        state.lod = Math.min(args[1] >>> 0, Math.max(0, resource.levels - 1));
        return previous;
    };
    exports['IDirect3DVolumeTexture9_GetLOD'] = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0;
        const resource = volumeTextureResources.get(ptr);
        if (!resource || resource.pool !== D3DPOOL_MANAGED) return 0;
        return ensureBaseTextureState(ptr, resource.levels).lod >>> 0;
    };
    exports['IDirect3DVolumeTexture9_SetAutoGenFilterType'] = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0;
        const resource = volumeTextureResources.get(ptr);
        if (!resource || (resource.usage & D3DUSAGE_AUTOGENMIPMAP) === 0) return D3DERR_INVALIDCALL;
        const filter = args[1] >>> 0;
        if (!validAutoGenFilter(filter)) return D3DERR_INVALIDCALL;
        ensureBaseTextureState(ptr, resource.levels).autoGenFilterType = filter;
        return D3D_OK;
    };
    exports['IDirect3DVolumeTexture9_GetAutoGenFilterType'] = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0;
        const resource = volumeTextureResources.get(ptr);
        if (!resource || (resource.usage & D3DUSAGE_AUTOGENMIPMAP) === 0) return 0;
        return ensureBaseTextureState(ptr, resource.levels).autoGenFilterType >>> 0;
    };
    exports['IDirect3DVolumeTexture9_GenerateMipSubLevels'] = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0;
        const resource = volumeTextureResources.get(ptr);
        if (!resource || (resource.usage & D3DUSAGE_AUTOGENMIPMAP) === 0) return D3DERR_INVALIDCALL;
        const state = ensureBaseTextureState(ptr, resource.levels);
        const hr = generateVolumeMips(ptr, state.autoGenFilterType);
        if (hr === D3D_OK) (resourceToDevice.get(ptr) as D3D9Device | undefined)?.markVolumeTextureDirty(ptr);
        return hr;
    };

    exports['IDirect3DVolumeTexture9_GetLevelDesc'] = (_ctx, _mem, args) => {
        const texturePtr = args[0] >>> 0;
        const level = args[1] >>> 0;
        const resource = volumeTextureResources.get(texturePtr);
        if (!resource || level >= resource.levels || !args[2]) return D3DERR_INVALIDCALL;
        return writeVolumeDesc(args[2] >>> 0, texturePtr, level) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DVolumeTexture9_GetVolumeLevel'] = (_ctx, _mem, args) => {
        const texturePtr = args[0] >>> 0;
        const level = args[1] >>> 0;
        const ppVolume = args[2] >>> 0;
        if (!ppVolume) return D3DERR_INVALIDCALL;
        initReturnPtr(ppVolume);
        const resource = volumeTextureResources.get(texturePtr);
        if (!resource || level >= resource.levels) return D3DERR_INVALIDCALL;

        let levels = volumeLevelObjects.get(texturePtr);
        if (!levels) {
            levels = new Map();
            volumeLevelObjects.set(texturePtr, levels);
        }
        let volumePtr = levels.get(level);
        if (!volumePtr) {
            const vtableAddr = getVTables()['IDirect3DVolume9']?.address;
            const device = resourceToDevice.get(texturePtr);
            const devicePtr = device ? resolveDevicePtr(device) : 0;
            if (!vtableAddr || !devicePtr || !device) return D3DERR_INVALIDCALL;
            const ownerDevice = device;
            // createComObject's initial reference belongs to the PARENT: it keeps the
            // child allocation alive for as long as the texture caches it, and the
            // texture's finalizer drops it. Caller references are parent references.
            volumePtr = createComObject(vtableAddr);
            resourceToDevice.set(volumePtr, ownerDevice);
            volumeLevelParents.set(volumePtr, { texturePtr, level });
            registerDeviceChildFinalizer(volumePtr, devicePtr, () => {
                volumeLevelParents.delete(volumePtr!);
                resourceToDevice.delete(volumePtr!);
                const map = volumeLevelObjects.get(texturePtr);
                if (map?.get(level) === volumePtr) map!.delete(level);
                if (map && map.size === 0) volumeLevelObjects.delete(texturePtr);
                clearResourceContract(volumePtr!);
            });
            levels.set(level, volumePtr);
        }
        // Volume9 is an alias of its parent resource for COM lifetime, so the
        // reference this call returns is a reference on the texture — whether the
        // child object was just created or came from the cache.
        addComRef(texturePtr);
        if (!Mem.writeUint32(ppVolume, volumePtr)) {
            releaseComRef(texturePtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    function lockTexture(texturePtr: number, level: number, pLocked: number, pBox: number, flags: number, mem: Uint8Array): number {
        if (!pLocked) return D3DERR_INVALIDCALL;
        const readonly = (flags & D3DLOCK_READONLY) !== 0;
        const noDirtyUpdate = (flags & D3DLOCK_NO_DIRTY_UPDATE) !== 0;
        // READONLY promises that UnlockBox will not publish guest writes; the
        // contradictory DISCARD combination is invalid in D3D9.
        if (readonly && (flags & D3DLOCK_DISCARD) !== 0) return D3DERR_INVALIDCALL;
        const resource = volumeTextureResources.get(texturePtr);
        if (!resource || level >= resource.levels) return D3DERR_INVALIDCALL;
        const box = pBox ? readVolumeBox(mem, pBox) : null;
        if (pBox && !box) return D3DERR_INVALIDCALL;

        const levelData = getVolumeLevel(texturePtr, level);
        if (!levelData) return D3DERR_INVALIDCALL;
        const poolDefault = resource.pool === D3DPOOL_DEFAULT;
        const requestedDiscard = (flags & D3DLOCK_DISCARD) !== 0;
        // Match the 2-D lock algebra: DISCARD|READONLY is illegal for a
        // DEFAULT resource, NOOVERWRITE wins over DISCARD, and a discard of a
        // sub-box cannot rename the complete mip.  A non-DEFAULT discard is
        // stripped rather than changing the old contents outside the box.
        if (requestedDiscard && readonly && poolDefault) return D3DERR_INVALIDCALL;
        const fullBox = !box || (box.left === 0 && box.top === 0 && box.front === 0
            && box.right === levelData.width && box.bottom === levelData.height
            && box.back === levelData.depth);
        const discard = requestedDiscard && poolDefault
            && (flags & D3DLOCK_NOOVERWRITE) === 0 && fullBox;
        const lock = lockVolumeBox(texturePtr, level, box);
        if (!lock) return D3DERR_INVALIDCALL;
        if (discard && Mem.writeBytes(levelData.ptr, new Uint8Array(levelData.bytes)) !== levelData.bytes) {
            unlockVolumeBox(texturePtr, level);
            return D3DERR_INVALIDCALL;
        }
        if (!Mem.writeUint32(pLocked + 0, lock.rowPitch)
            || !Mem.writeUint32(pLocked + 4, lock.slicePitch)
            || !Mem.writeUint32(pLocked + 8, lock.ptr)) {
            unlockVolumeBox(texturePtr, level);
            return D3DERR_INVALIDCALL;
        }
        volumeLockFlags.set(`${texturePtr}:${level}`, { readOnly: readonly, noDirtyUpdate });
        return D3D_OK;
    }

    function unlockTexture(texturePtr: number, level: number): number {
        const ok = unlockVolumeBox(texturePtr, level);
        const lockFlags = volumeLockFlags.get(`${texturePtr}:${level}`);
        const readonly = lockFlags?.readOnly === true;
        const noDirtyUpdate = lockFlags?.noDirtyUpdate === true;
        volumeLockFlags.delete(`${texturePtr}:${level}`);
        if (ok && !readonly && !noDirtyUpdate) {
            const device = resourceToDevice.get(texturePtr) as D3D9Device | undefined;
            device?.markVolumeTextureDirty(texturePtr);
        }
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    }

    exports['IDirect3DVolumeTexture9_LockBox'] = (_ctx, mem, args) =>
        lockTexture(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0, args[4] >>> 0, mem);
    exports['IDirect3DVolumeTexture9_UnlockBox'] = (_ctx, _mem, args) =>
        unlockTexture(args[0] >>> 0, args[1] >>> 0);
    exports['IDirect3DVolumeTexture9_AddDirtyBox'] = (_ctx, mem, args) => {
        const texturePtr = args[0] >>> 0;
        const resource = volumeTextureResources.get(texturePtr);
        if (!resource) return D3DERR_INVALIDCALL;
        const pBox = args[1] >>> 0;
        const device = resourceToDevice.get(texturePtr) as D3D9Device | undefined;
        if (!pBox) {
            device?.markVolumeTextureDirty(texturePtr);
            return D3D_OK;
        }
        const box = readVolumeBox(mem, pBox);
        const dims = getVolumeLevelDims(resource.width, resource.height, resource.depth, 0);
        if (!box || box.left < 0 || box.top < 0 || box.front < 0
            || box.right <= box.left || box.bottom <= box.top || box.back <= box.front
            || box.right > dims.width || box.bottom > dims.height || box.back > dims.depth) {
            return D3DERR_INVALIDCALL;
        }
        device?.markVolumeTextureDirty(texturePtr);
        return D3D_OK;
    };

    exports['IDirect3DVolume9_GetDesc'] = (_ctx, _mem, args) => {
        const parent = getParentForVolumeLevel(args[0] >>> 0);
        if (!parent || !args[1]) return D3DERR_INVALIDCALL;
        return writeVolumeDesc(args[1] >>> 0, parent.texturePtr, parent.level) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['IDirect3DVolume9_GetType'] = (_ctx, _mem, args) =>
        volumeLevelParents.has(args[0] >>> 0) ? D3DRTYPE_VOLUME : D3DRTYPE_UNKNOWN;
    exports['IDirect3DVolume9_LockBox'] = (_ctx, mem, args) => {
        const parent = getParentForVolumeLevel(args[0] >>> 0);
        if (!parent) return D3DERR_INVALIDCALL;
        return lockTexture(parent.texturePtr, parent.level, args[1] >>> 0, args[2] >>> 0, args[3] >>> 0, mem);
    };
    exports['IDirect3DVolume9_UnlockBox'] = (_ctx, _mem, args) => {
        const parent = getParentForVolumeLevel(args[0] >>> 0);
        return parent ? unlockTexture(parent.texturePtr, parent.level) : D3DERR_INVALIDCALL;
    };
    exports['IDirect3DVolume9_GetContainer'] = (_ctx, mem, args) => {
        const parent = getParentForVolumeLevel(args[0] >>> 0);
        const ppContainer = args[2] >>> 0;
        if (!ppContainer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppContainer);
        // REFIID is mandatory.  A malformed/null GUID is an invalid call, not
        // an implicit IUnknown request that could return the wrong vtable.
        if (!(args[1] >>> 0)) return D3DERR_INVALIDCALL;
        const requested = readD3D9GuidKey(mem, args[1] >>> 0);
        if (!requested) return D3DERR_INVALIDCALL;
        if (!parent || (requested !== IID_IDIRECT3DVOLUMETEXTURE9
            && requested !== IID_IDIRECT3DRESOURCE9
            && requested !== IID_IDIRECT3DBASETEXTURE9 && requested !== IID_IUNKNOWN)) {
            return E_NOINTERFACE;
        }
        if (!Mem.writeUint32(ppContainer, parent.texturePtr)) return D3DERR_INVALIDCALL;
        addComRef(parent.texturePtr);
        return D3D_OK;
    };

    return exports;
}
