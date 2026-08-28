/**
 * D3D9 Resource functions
 *
 * Atomic implementation for Direct3D resource operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import {
    addComRef,
    devices,
    getVTables,
    createComObject,
    registerDeviceChildFinalizer,
    releaseComRef,
    resourceToDevice,
} from './shared-state';
import {
    textureMeta,
    surfaceMeta,
    vertexBufferMeta,
    indexBufferMeta,
    defaultPoolBufferTally,
    resolveRequestedMipLevels,
    getTextureLevelDims,
    ensureTextureLevelSurface,
    ensureCubeFaceSurface,
    precreateTextureLevelSurfaces,
    precreateCubeFaceSurfaces,
    clearTextureSubresourceSurfaces,
    releaseSurfaceMetadata,
    isDeviceBackBufferSurface,
    packSurfaceDesc,
    type SurfaceMeta,
} from './resource-registry';
import { getD3DTextureLayout, isD3DFloatFormat } from '../../backends/webgpu/shared/texture-formats';
import {
    initReturnPtr,
    D3DFMT_UNKNOWN,
    normalizePalettizedTexturePool,
} from '../../backends/webgpu/shared/dx-com-helpers';
import {
    isDxExclusiveFormat,
    isDxDepthStencilFormat,
    isDxRenderableFormat,
    isDxUnsupportedFormat,
} from '../../backends/webgpu/shared/dx-format-support';
import {
    D3DLOCK_DISCARD,
    decideLockFlags,
    noteLock,
    type LockRect,
} from '../d3d-common/lock-flags';
import { d3d9LockCounters } from './lock-stats';
import type { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import {
    clearResourceContract,
    resourceFreePrivateData,
    resourceGetPrivateData,
    resourceGetPriority,
    resourcePreLoad,
    resourceSetPrivateData,
    resourceSetPriority,
    isValidTextureUsagePool,
    isValidBufferUsagePool,
} from './resource-contract';
import { getSwapChainForSurface } from './swapchain';
import {
    volumeTextureResources,
    getVolumeLevel,
    getVolumeLevelDims,
} from './volume-resources';
import { generateD3D9AutogenMipLevel } from './mip-autogen';
import {
    IID_IUNKNOWN,
    IID_IDIRECT3DDEVICE9,
    IID_IDIRECT3DDEVICE9EX,
    IID_IDIRECT3DBASETEXTURE9,
    IID_IDIRECT3DRESOURCE9,
    IID_IDIRECT3DTEXTURE9,
    IID_IDIRECT3DCUBETEXTURE9,
    readD3D9GuidKey,
} from './object-contracts';

const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DFMT_A8R8G8B8 = 21;
const D3DRTYPE_UNKNOWN = 0;
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DPOOL_SYSTEMMEM = 2;
const D3DPOOL_SCRATCH = 3;
const D3DMULTISAMPLE_NONE = 0;
const D3DUSAGE_DEPTHSTENCIL = 0x00000002;
const D3DRTYPE_VERTEXBUFFER = 6;
const D3DRTYPE_INDEXBUFFER = 7;
const D3DFMT_VERTEXDATA = 100;
const D3DFMT_INDEX16 = 101;
const D3DFMT_INDEX32 = 102;
const D3DUSAGE_RENDERTARGET = 0x00000001;
const D3DUSAGE_DYNAMIC = 0x00000200;
const D3DUSAGE_AUTOGENMIPMAP = 0x00000400;
const D3DUSAGE_WRITEONLY = 0x00000008;
const E_NOINTERFACE = 0x80004002;

/** The formats GDI can describe: R8G8B8, A8R8G8B8, X8R8G8B8, R5G6B5, X1R5G5B5, A1R5G5B5. */
const GETDC_COMPATIBLE_FORMATS: ReadonlySet<number> = new Set([20, 21, 22, 23, 24, 25]);
const isGetDCCompatibleFormat = (format: number | undefined): boolean =>
    format !== undefined && GETDC_COMPATIBLE_FORMATS.has(format >>> 0);

const isValidD3D9Pool = (pool: number): boolean =>
    pool === D3DPOOL_DEFAULT || pool === D3DPOOL_MANAGED
    || pool === D3DPOOL_SYSTEMMEM || pool === D3DPOOL_SCRATCH;

/** D3DPOOL_SCRATCH is for image resources; D3D9 explicitly disallows it for
 * vertex and index buffers even though it is a valid enum value elsewhere. */
const isValidBufferPool = (pool: number): boolean =>
    pool === D3DPOOL_DEFAULT || pool === D3DPOOL_MANAGED || pool === D3DPOOL_SYSTEMMEM;
/** IID_IDirect3DSwapChain9 {794950F2-ADFC-458A-905E-10A10B0B503B} as raw guest bytes. */
const IID_IDIRECT3DSWAPCHAIN9 = 'f2504979fcad8a45905e10a10b0b503b';

function writeSurfaceDesc(pDesc: number, meta: SurfaceMeta): boolean {
    const words = packSurfaceDesc(meta);
    for (let i = 0; i < words.length; i++) {
        if (!Mem.writeUint32(pDesc + i * 4, words[i]!)) return false;
    }
    return true;
}

function resolveDevicePtr(deviceInstance: unknown): number {
    for (const [devicePtr, device] of devices.entries()) {
        if (device === deviceInstance) {
            return devicePtr >>> 0;
        }
    }
    return 0;
}

/**
 * The LockRect prologue, shared by Texture9 and Surface9.
 *
 * Our textures have SPLIT storage: a JS-side `data` copy that every GPU readback and
 * CPU-side writer lands in, and a separate guest HEAP buffer the app gets a pointer to.
 * The prologue decides which of the two must move before the pointer is handed out, and
 * starts the GPU round trip when the level is renderable — it is a Promise ONLY then, so
 * an ordinary texture-upload lock stays a synchronous thunk.
 */
interface D3D9LockPlan {
    /** A surviving D3DLOCK_DISCARD: do not produce the old contents at all. */
    discard: boolean;
    /** D3DLOCK_READONLY: UnlockRect must not copy the guest bytes back. */
    readOnly: boolean;
    /** D3DLOCK_NO_DIRTY_UPDATE: publish guest bytes but leave backend dirty state unchanged. */
    noDirtyUpdate: boolean;
    /** The GPU→CPU readback this lock needs, or null when it needs none. */
    pending: Promise<boolean> | null;
}

/** Whether the D3DLOCK_* algebra is consulted at all — off restores the pre-change behaviour
 *  of discarding the flag word. */
const lockFlagsHonoured = (): boolean =>
    (globalThis as { __noD3D9LockFlags?: boolean }).__noD3D9LockFlags !== true;

/**
 * READONLY reaches UnlockRect, which is handed no flags of its own. Keyed by the same
 * (texture, level) pair the lock is: a surface lock and its parent texture's lock are the
 * same subresource and must not each remember a different promise.
 */
const activeLockReadOnly = new Map<string, { readOnly: boolean; noDirtyUpdate: boolean }>();

/** Cube locks are not routed through the 2-D lock helper, so retain their
 * per-face state here as well.  This also prevents the backend's compatibility
 * path from handing a second LockRect the first call's scratch pointer. */
const activeCubeLocks = new Map<string, { readOnly: boolean; noDirtyUpdate: boolean }>();
const activeBufferLocks = new Map<number, 'vertex' | 'index'>();

function clearActiveTextureLocks(texturePtr: number): void {
    const prefix = `${texturePtr >>> 0}:`;
    for (const key of activeLockReadOnly.keys()) {
        if (key.startsWith(prefix)) activeLockReadOnly.delete(key);
    }
    for (const key of activeCubeLocks.keys()) {
        if (key.startsWith(prefix)) activeCubeLocks.delete(key);
    }
}

function clearActiveBufferLock(bufferPtr: number): void {
    activeBufferLocks.delete(bufferPtr >>> 0);
}

const readLockRect = (pRect: number): LockRect | null => {
    if (!pRect) return null;
    const left = Mem.readInt32(pRect);
    const top = Mem.readInt32(pRect + 4);
    const right = Mem.readInt32(pRect + 8);
    const bottom = Mem.readInt32(pRect + 12);
    if (left === null || top === null || right === null || bottom === null) return null;
    return {
        left,
        top,
        right,
        bottom,
    };
};

/** Resolve the flags and start the readback. Null means the combination is illegal. */
function planTextureLock(
    device: D3D9Device,
    texPtr: number,
    level: number,
    width: number,
    height: number,
    poolDefault: boolean,
    pRect: number,
    flags: number,
): D3D9LockPlan | null {
    if (!lockFlagsHonoured()) {
        return {
            discard: false,
            readOnly: false,
            noDirtyUpdate: false,
            pending: device.textureReadbackForLock(texPtr, level, false),
        };
    }
    const rect = readLockRect(pRect);
    if (pRect && !rect) return null;
    const decision = decideLockFlags(flags, rect, width, height, poolDefault);
    // A DISCARD honoured at the whole-surface extent when the app named a sub-rect is the
    // bug this switch reproduces on demand; see the d3d9 conformance scene.
    const discard = (globalThis as { __d3d9LockDiscardWholeSurface?: boolean })
        .__d3d9LockDiscardWholeSurface === true
        ? (flags & D3DLOCK_DISCARD) !== 0
        : decision.discard;
    noteLock(
        d3d9LockCounters,
        { width, height, splitStorage: device.isRenderTargetTexture(texPtr) },
        decision,
        { discard: (flags & D3DLOCK_DISCARD) !== 0, read: !discard, scopable: decision.readOnly },
    );
    if (decision.invalid) return null;
    return {
        discard,
        readOnly: decision.readOnly,
        noDirtyUpdate: decision.noDirtyUpdate,
        pending: device.textureReadbackForLock(texPtr, level, discard),
    };
}

/** Take the lock the plan decided on and fill the guest's D3DLOCKED_RECT. */
function completeTextureLock(
    device: D3D9Device,
    texPtr: number,
    level: number,
    plan: D3D9LockPlan,
    format: number,
    width: number,
    height: number,
    pRect: number,
    pLockedRect: number,
    mem: Uint8Array,
): number {
    const D3DERR_INVALIDCALL = 0x8876086c;
    const lockInfo = device.lockTexture(texPtr, level, plan.discard);
    if (!lockInfo) return D3DERR_INVALIDCALL;
    activeLockReadOnly.set(`${texPtr}:${level}`, {
        readOnly: plan.readOnly,
        noDirtyUpdate: plan.noDirtyUpdate,
    });

    let pBits = lockInfo.ptr >>> 0;
    if (pRect) {
        const left = Mem.readInt32(pRect) ?? 0;
        const top = Mem.readInt32(pRect + 4) ?? 0;
        pBits = (pBits + computeLockRectOffset(format, width, height, lockInfo.pitch, left, top)) >>> 0;
    }
    if (!Mem.writeUint32(pLockedRect, lockInfo.pitch >>> 0) || !Mem.writeUint32(pLockedRect + 4, pBits)) {
        finishTextureUnlock(device, texPtr, level, mem);
        return D3DERR_INVALIDCALL;
    }
    return 0;
}

/** UnlockRect for both interfaces: consumes the READONLY promise the lock recorded. */
function finishTextureUnlock(device: D3D9Device, texPtr: number, level: number, mem: Uint8Array): void {
    const key = `${texPtr}:${level}`;
    const lockFlags = activeLockReadOnly.get(key);
    const readOnly = lockFlags?.readOnly === true;
    const noDirtyUpdate = lockFlags?.noDirtyUpdate === true;
    activeLockReadOnly.delete(key);
    device.unlockTexture(texPtr, level, mem, { readOnly, noDirtyUpdate });
}

function computeLockRectOffset(format: number, width: number, height: number, pitch: number, left: number, top: number): number {
    const layout = getD3DTextureLayout(format, width, height);
    if (layout.compressed) {
        return ((top >> 2) * pitch + (left >> 2) * layout.blockBytes) >>> 0;
    }
    const bytesPerPixel = Math.max(1, Math.floor(layout.pitch / Math.max(1, width | 0)));
    return (top * pitch + left * bytesPerPixel) >>> 0;
}

/** Lock one cube-face subresource.  GetCubeMapSurface exposes the same native
 * pixels through Surface9, so both COM entry points must use the face-aware
 * backend path and share one active-lock key. */
function completeCubeFaceLock(
    device: D3D9Device,
    cubePtr: number,
    face: number,
    level: number,
    meta: { width: number; pool: number; format: number },
    pLockedRect: number,
    pRect: number,
    flags: number,
    mem: Uint8Array,
): number {
    const D3DERR_INVALIDCALL = 0x8876086c;
    if (!pLockedRect || !Number.isInteger(face) || face < 0 || face > 5
        || !Number.isInteger(level) || level < 0) return D3DERR_INVALIDCALL;
    const lockKey = `${cubePtr}:${face}:${level}`;
    if (activeCubeLocks.has(lockKey)) {
        Mem.writeUint32(pLockedRect, 0);
        return D3DERR_INVALIDCALL;
    }

    const dim = Math.max(1, meta.width >>> level);
    const rect = pRect ? readLockRect(pRect) : null;
    if (pRect && !rect) return D3DERR_INVALIDCALL;
    const decision = decideLockFlags(flags, rect, dim, dim, meta.pool === D3DPOOL_DEFAULT);
    if (decision.invalid) return D3DERR_INVALIDCALL;

    const lockInfo = device.lockCubeFace(cubePtr, face, level, {
        discard: decision.discard,
        readOnly: decision.readOnly,
        noDirtyUpdate: decision.noDirtyUpdate,
    });
    if (!lockInfo) return D3DERR_INVALIDCALL;
    activeCubeLocks.set(lockKey, {
        readOnly: decision.readOnly,
        noDirtyUpdate: decision.noDirtyUpdate,
    });

    let pBits = lockInfo.ptr >>> 0;
    if (decision.box) {
        pBits = (pBits + computeLockRectOffset(meta.format, dim, dim, lockInfo.pitch,
            decision.box.left, decision.box.top)) >>> 0;
    }
    if (!Mem.writeUint32(pLockedRect + 0, lockInfo.pitch >>> 0)
        || !Mem.writeUint32(pLockedRect + 4, pBits)) {
        device.unlockCubeFace(cubePtr, face, level, mem);
        activeCubeLocks.delete(lockKey);
        return D3DERR_INVALIDCALL;
    }
    return 0;
}

export function createResourcesExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;
    const D3DERR_NOTAVAILABLE = 0x8876086a;
    const D3DUSAGE_AUTOGENMIPMAP = 0x00000400;
    const D3DTEXF_LINEAR = 2;

    /** State which belongs to IDirect3DBaseTexture9 rather than the GPU texture store.
     * Keeping this beside the COM handlers makes SetLOD/GetLOD deterministic even when
     * the backend has only a one-level native image (the D3D9 API still exposes the full
     * declared mip chain). */
    const baseTextureState = new Map<number, { lod: number; autoGenFilterType: number }>();

    const ensureBaseTextureState = (ptr: number, levels: number, usage: number): { lod: number; autoGenFilterType: number } => {
        const key = ptr >>> 0;
        let state = baseTextureState.get(key);
        if (!state) {
            state = { lod: 0, autoGenFilterType: D3DTEXF_LINEAR };
            baseTextureState.set(key, state);
        }
        // SetLOD is clamped to the last declared mip level by the native runtime.
        state.lod = Math.min(state.lod >>> 0, Math.max(0, (levels >>> 0) - 1));
        void usage;
        return state;
    };

    const validAutoGenFilter = (filter: number): boolean =>
        filter === 1 || filter === 2 || filter === 3 || filter === 6 || filter === 7 || filter === 8;

    /** Formats whose bytes are independent UNORM channels, so POINT/LINEAR
     * filtering can operate directly on the CPU shadow without decoding a
     * packed word or compressed block. */
    const AUTOGEN_BYTE_FORMAT_BPP = new Map<number, number>([
        [20, 3], // R8G8B8 (B,G,R in memory)
        [21, 4], // A8R8G8B8
        [22, 4], // X8R8G8B8
        [28, 1], // A8
        [32, 4], // A8B8G8R8
        [33, 4], // X8B8G8R8
        [50, 1], // L8
        [51, 2], // A8L8 (L then A, independent UNORM bytes)
    ]);

    /** Downsample one uncompressed byte-addressable mip level.  Keep the format
     * list explicit: averaging encoded packed words (R3G3B2, RGB565, bump data,
     * float bits, etc.) is observably wrong even when the storage happens to be
     * one, two, or four bytes per texel. */
    const generateTextureMips = (device: D3D9Device, texturePtr: number, levels: number, filter: number): number => {
        if (levels <= 1) return D3D_OK;
        const meta = textureMeta.get(texturePtr);
        if (!meta) return D3DERR_INVALIDCALL;

        // A cube is six independent mip chains.  D3D9's GenerateMipSubLevels does
        // not cross-filter the seam between faces, so run the same codec per face
        // and preserve the subresource identity all the way through the device.
        const isCube = meta.isCube === true;
        const faceCount = isCube ? 6 : 1;
        for (let face = 0; face < faceCount; face++) {
            let source = isCube
                ? device.getCubeFacePixels?.(texturePtr, face, 0)
                : device.getTextureLevelPixels(texturePtr, 0);
            if (!source) return D3DERR_INVALIDCALL;
            const format = meta.format ?? D3DFMT_A8R8G8B8;
            const firstLayout = getD3DTextureLayout(format, source.width, source.height);
            // Derive the logical texel width from the format table rather than
            // dividing pitch by width: a 2-pixel R8G8B8 row is aligned to an
            // 8-byte pitch, which would otherwise be misread as 4 BPP.
            const bytesPerPixel = AUTOGEN_BYTE_FORMAT_BPP.get(format) ?? 0;
            if (firstLayout.compressed || bytesPerPixel === 0) {
                return D3DERR_NOTAVAILABLE;
            }

            for (let level = 1; level < levels; level++) {
                const width = Math.max(1, source.width >>> 1);
                const height = Math.max(1, source.height >>> 1);
                const layout = getD3DTextureLayout(format, width, height);
                const generated = generateD3D9AutogenMipLevel(source, bytesPerPixel, filter, layout.pitch);
                if (!generated) return D3DERR_NOTAVAILABLE;
                const stored = isCube
                    ? device.setCubeFacePixels?.(texturePtr, face, level, generated.data, generated.pitch)
                    : device.setTextureLevelPixels(texturePtr, level, generated.data, generated.pitch);
                if (!stored) return D3DERR_INVALIDCALL;
                source = generated;
            }
        }
        return D3D_OK;
    };

    const registerBufferFinalizer = (ptr: number, devicePtr: number, kind: 'vertex' | 'index'): void => {
        registerDeviceChildFinalizer(ptr, devicePtr, () => {
            // The REGISTRY drop is in a finally: a throw anywhere in the backend teardown used
            // to strand the metadata, and a stranded DEFAULT-pool entry makes Reset refuse
            // forever — which an app reads as a permanently lost device, not as a leak.
            defaultPoolBufferTally.entered++;
            const pool = (kind === 'vertex' ? vertexBufferMeta : indexBufferMeta).get(ptr)?.pool;
            try {
                clearResourceContract(ptr);
                clearActiveBufferLock(ptr);
                const device = resourceToDevice.get(ptr);
                if (kind === 'vertex') device?.releaseVertexBuffer(ptr);
                else device?.releaseIndexBuffer(ptr);
            } catch (e) {
                Logger.error(LogCategory.D3D9,
                    `${kind} buffer 0x${ptr.toString(16)} teardown threw, dropping it anyway: ${e}`);
            } finally {
                if (pool === 0) defaultPoolBufferTally.finalized++;
                if (kind === 'vertex') vertexBufferMeta.delete(ptr);
                else indexBufferMeta.delete(ptr);
                resourceToDevice.delete(ptr);
            }
        });
    };

    const registerTextureFinalizer = (ptr: number, devicePtr: number): void => {
        registerDeviceChildFinalizer(ptr, devicePtr, () => {
            clearResourceContract(ptr);
            baseTextureState.delete(ptr >>> 0);
            // Reset/release drains child finalizers before the global resource
            // registries are cleared.  Drop lock promises at the same boundary
            // so a reused COM pointer cannot inherit an old UnlockRect state.
            clearActiveTextureLocks(ptr);
            const device = resourceToDevice.get(ptr);
            clearTextureSubresourceSurfaces(ptr);
            device?.releaseTexture(ptr);
            textureMeta.delete(ptr);
            resourceToDevice.delete(ptr);
        });
    };

    const registerStandaloneSurfaceFinalizer = (ptr: number, devicePtr: number): void => {
        registerDeviceChildFinalizer(ptr, devicePtr, () => {
            clearResourceContract(ptr);
            resourceToDevice.get(ptr)?.releaseStandaloneDepthSurface?.(ptr);
            releaseSurfaceMetadata(ptr);
        });
    };

    exports['IDirect3DDevice9_CreateVertexBuffer'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Length = args[1];
        const Usage = args[2];
        const FVF = args[3];
        const Pool = args[4];
        const ppVertexBuffer = args[5];

        if (!ppVertexBuffer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppVertexBuffer);
        // D3D9 does not create zero-byte buffers; accepting one would leave a
        // canary-only allocation that appears valid to Lock/Draw callers.
        if ((Length >>> 0) === 0 || !isValidBufferPool(Pool >>> 0)
            || !isValidBufferUsagePool(Usage >>> 0, Pool >>> 0)) return D3DERR_INVALIDCALL;

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateVertexBuffer: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DVertexBuffer9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DVertexBuffer9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const vbPtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateVertexBuffer(Length=${Length}, FVF=0x${FVF.toString(16)}) -> 0x${vbPtr.toString(16)}`);

        const guestPtr = device.createVertexBuffer(vbPtr, Length, FVF, Pool >>> 0);
        if (guestPtr === 0) {
            releaseComRef(vbPtr);
            initReturnPtr(ppVertexBuffer);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(vbPtr, device);
        vertexBufferMeta.set(vbPtr, {
            size: Length >>> 0,
            usage: Usage >>> 0,
            pool: Pool >>> 0,
            fvf: FVF >>> 0,
            // [ESP] at thunk entry is the guest's return address: who owns this buffer.
            // A refused Reset otherwise names a pointer nobody can trace back to code.
            createdBy: Mem.readUint32(ctx.esp) ?? 0,
            seq: (Pool >>> 0) === 0 ? defaultPoolBufferTally.created : -1,
        });
        if ((Pool >>> 0) === 0) defaultPoolBufferTally.created++;
        registerBufferFinalizer(vbPtr, pDevice, 'vertex');

        if (!Mem.writeUint32(ppVertexBuffer, vbPtr)) {
            releaseComRef(vbPtr);
            return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    // GetDesc(pDesc) — D3DVERTEXBUFFER_DESC {Format, Type, Usage, Pool, Size, FVF}.
    exports['IDirect3DVertexBuffer9_GetDesc'] = (_ctx, _mem, args) => {
        const meta = vertexBufferMeta.get(args[0] >>> 0);
        const pDesc = args[1];
        if (!meta || !pDesc) return D3DERR_INVALIDCALL;
        const ok =
            Mem.writeUint32(pDesc + 0, D3DFMT_VERTEXDATA) &&
            Mem.writeUint32(pDesc + 4, D3DRTYPE_VERTEXBUFFER) &&
            Mem.writeUint32(pDesc + 8, meta.usage) &&
            Mem.writeUint32(pDesc + 12, meta.pool) &&
            Mem.writeUint32(pDesc + 16, meta.size) &&
            Mem.writeUint32(pDesc + 20, meta.fvf ?? 0);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_CreateIndexBuffer'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Length = args[1];
        const Usage = args[2];
        const Format = args[3];
        const Pool = args[4];
        const ppIndexBuffer = args[5];

        if (!ppIndexBuffer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppIndexBuffer);
        if ((Length >>> 0) === 0 || !isValidBufferPool(Pool >>> 0)
            || !isValidBufferUsagePool(Usage >>> 0, Pool >>> 0)) return D3DERR_INVALIDCALL;
        if ((Format >>> 0) !== D3DFMT_INDEX16 && (Format >>> 0) !== D3DFMT_INDEX32) {
            return D3DERR_INVALIDCALL;
        }

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateIndexBuffer: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DIndexBuffer9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DIndexBuffer9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const ibPtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateIndexBuffer(Length=${Length}, Format=${Format}) -> 0x${ibPtr.toString(16)}`);

        const guestPtr = device.createIndexBuffer(ibPtr, Length, Format, Pool >>> 0);
        if (guestPtr === 0) {
            releaseComRef(ibPtr);
            initReturnPtr(ppIndexBuffer);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(ibPtr, device);
        indexBufferMeta.set(ibPtr, {
            size: Length >>> 0,
            usage: Usage >>> 0,
            pool: Pool >>> 0,
            format: Format >>> 0,
            createdBy: Mem.readUint32(ctx.esp) ?? 0,
        });
        if ((Pool >>> 0) === 0) defaultPoolBufferTally.created++;
        registerBufferFinalizer(ibPtr, pDevice, 'index');

        if (!Mem.writeUint32(ppIndexBuffer, ibPtr)) {
            releaseComRef(ibPtr);
            return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    // GetDesc(pDesc) — D3DINDEXBUFFER_DESC {Format, Type, Usage, Pool, Size}: as
    // D3DVERTEXBUFFER_DESC without the trailing FVF.
    exports['IDirect3DIndexBuffer9_GetDesc'] = (_ctx, _mem, args) => {
        const meta = indexBufferMeta.get(args[0] >>> 0);
        const pDesc = args[1];
        if (!meta || !pDesc) return D3DERR_INVALIDCALL;
        const ok =
            Mem.writeUint32(pDesc + 0, meta.format ?? 0) &&
            Mem.writeUint32(pDesc + 4, D3DRTYPE_INDEXBUFFER) &&
            Mem.writeUint32(pDesc + 8, meta.usage) &&
            Mem.writeUint32(pDesc + 12, meta.pool) &&
            Mem.writeUint32(pDesc + 16, meta.size);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_CreateTexture'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Width = args[1];
        const Height = args[2];
        const Levels = args[3];
        const Usage = args[4];
        const Format = args[5] >>> 0;
        const Pool = args[6];
        const ppTexture = args[7];

        if (!ppTexture) return D3DERR_INVALIDCALL;
        initReturnPtr(ppTexture);
        if (!isValidD3D9Pool(Pool >>> 0)) return D3DERR_INVALIDCALL;
        if (!isValidTextureUsagePool(Usage >>> 0, Pool >>> 0)) return D3DERR_INVALIDCALL;

        if (Format === D3DFMT_UNKNOWN || isDxExclusiveFormat(Format, 9)) {
            return D3DERR_INVALIDCALL;
        }
        if (isDxUnsupportedFormat(Format, 9)) return D3DERR_NOTAVAILABLE;
        // The opt-in float seam is sampled 2-D storage only.  A texture created
        // as a render target would still be attached through the ordinary
        // backend-format path, so refuse it rather than silently quantizing it.
        if (isD3DFloatFormat(Format) && (Usage >>> 0) & D3DUSAGE_RENDERTARGET) {
            return D3DERR_NOTAVAILABLE;
        }

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateTexture: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DTexture9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DTexture9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const width = Width >>> 0;
        const height = Height >>> 0;
        const maxLevels = resolveRequestedMipLevels(width, height, Levels >>> 0);
        if (maxLevels === null) return D3DERR_INVALIDCALL;
        const levelCount = maxLevels;
        const normalizedPool = normalizePalettizedTexturePool(Format, Pool);

        const texPtr = createComObject(vtableAddr);
        // A module reset can reclaim a COM slot before an old lock thunk's
        // bookkeeping is observed.  Clear pointer-keyed state at allocation as
        // well as in the normal finalizer, so slot reuse starts from a clean
        // LockRect/LOD contract even in teardown or test paths without refs.
        clearActiveTextureLocks(texPtr);
        baseTextureState.delete(texPtr >>> 0);
        Logger.log(LogCategory.D3D9, `CreateTexture(${Width}x${Height}, Levels=${Levels}, Usage=0x${(Usage>>>0).toString(16)}, Format=${Format}, Pool=${normalizedPool}) -> 0x${texPtr.toString(16)}`);

        const guestPtr = device.createTexture(texPtr, width, height, levelCount, Format, Usage >>> 0, normalizedPool);
        if (guestPtr === 0) {
            releaseComRef(texPtr);
            initReturnPtr(ppTexture);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(texPtr, device);
        textureMeta.set(texPtr, {
            width,
            height,
            levels: maxLevels,
            usage: Usage >>> 0,
            pool: normalizedPool,
            format: Format,
        });
        ensureBaseTextureState(texPtr, maxLevels, Usage >>> 0);
        registerTextureFinalizer(texPtr, pDevice);

        if (!precreateTextureLevelSurfaces(texPtr, maxLevels)) {
            releaseComRef(texPtr);
            initReturnPtr(ppTexture);
            return D3DERR_INVALIDCALL;
        }

        if (!Mem.writeUint32(ppTexture, texPtr)) {
            releaseComRef(texPtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateCubeTexture'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const EdgeLength = args[1];
        const Levels = args[2];
        const Usage = args[3];
        const Format = args[4] >>> 0;
        const Pool = args[5];
        const ppCubeTexture = args[6];

        if (!ppCubeTexture) return D3DERR_INVALIDCALL;
        initReturnPtr(ppCubeTexture);
        if (!isValidD3D9Pool(Pool >>> 0)) return D3DERR_INVALIDCALL;
        if (!isValidTextureUsagePool(Usage >>> 0, Pool >>> 0)) return D3DERR_INVALIDCALL;

        if (Format === D3DFMT_UNKNOWN || isDxExclusiveFormat(Format, 9)) {
            return D3DERR_INVALIDCALL;
        }
        if (isDxUnsupportedFormat(Format, 9)) return D3DERR_NOTAVAILABLE;
        // The bounded float contract is currently a 2-D sampled-texture path;
        // cube uploads still use the legacy RGBA8 layer conversion and must not
        // claim fidelity for any float format.
        if (isD3DFloatFormat(Format)) return D3DERR_NOTAVAILABLE;

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateCubeTexture: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DCubeTexture9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DCubeTexture9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const edge = EdgeLength >>> 0;
        const maxLevels = resolveRequestedMipLevels(edge, edge, Levels >>> 0);
        if (maxLevels === null) return D3DERR_INVALIDCALL;
        const levelCount = maxLevels;
        const normalizedPool = normalizePalettizedTexturePool(Format, Pool);

        const cubePtr = createComObject(vtableAddr);
        clearActiveTextureLocks(cubePtr);
        baseTextureState.delete(cubePtr >>> 0);
        Logger.log(LogCategory.D3D9, `CreateCubeTexture(edge=${edge}, Levels=${maxLevels}, Usage=0x${(Usage>>>0).toString(16)}, Format=${Format}, Pool=${normalizedPool}) -> 0x${cubePtr.toString(16)}`);

        const guestPtr = device.createCubeTexture(cubePtr, edge, levelCount, Format, Usage >>> 0, normalizedPool);
        if (guestPtr === 0) {
            releaseComRef(cubePtr);
            initReturnPtr(ppCubeTexture);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(cubePtr, device);
        textureMeta.set(cubePtr, {
            width: edge,
            height: edge,
            levels: maxLevels,
            usage: Usage >>> 0,
            pool: normalizedPool,
            format: Format,
            isCube: true,
        });
        ensureBaseTextureState(cubePtr, maxLevels, Usage >>> 0);
        registerTextureFinalizer(cubePtr, pDevice);

        if (!precreateCubeFaceSurfaces(cubePtr, maxLevels)) {
            releaseComRef(cubePtr);
            initReturnPtr(ppCubeTexture);
            return D3DERR_INVALIDCALL;
        }

        if (!Mem.writeUint32(ppCubeTexture, cubePtr)) {
            releaseComRef(cubePtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateDepthStencilSurface'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const width = args[1] >>> 0;
        const height = args[2] >>> 0;
        const format = args[3] >>> 0;
        const multiSampleType = args[4] >>> 0;
        const multiSampleQuality = args[5] >>> 0;
        const _discard = args[6];
        const ppSurface = args[7];
        const _pSharedHandle = args[8];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);
        if (width === 0 || height === 0) return D3DERR_INVALIDCALL;

        if (!isDxDepthStencilFormat(format, 9)) return D3DERR_NOTAVAILABLE;
        // This backend advertises exactly one quality level for every
        // supported multisample type, so only quality zero is representable.
        if (multiSampleQuality !== 0) return D3DERR_NOTAVAILABLE;
        // The backend keeps the D3D9 surface metadata (including the requested
        // sample type) and pairs it with an adapter-probed multisample depth
        // attachment when the surface is bound.  The guest-facing surface itself
        // remains a control-plane object; its GPU depth attachment is owned by the
        // render-pass target cache.
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        if (!device.supportsD3D9MultisampleType(multiSampleType)) return D3DERR_NOTAVAILABLE;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DSurface9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'CreateDepthStencilSurface: IDirect3DSurface9 vtable not found');
            return D3DERR_INVALIDCALL;
        }

        const w = Math.max(1, width);
        const h = Math.max(1, height);
        const surfacePtr = createComObject(vtableAddr);
        resourceToDevice.set(surfacePtr, device);
        surfaceMeta.set(surfacePtr, {
            format,
            type: D3DRTYPE_SURFACE,
            usage: D3DUSAGE_DEPTHSTENCIL,
            pool: D3DPOOL_DEFAULT,
            multiSampleType,
            multiSampleQuality,
            width: w,
            height: h,
            lockable: false,
            standalone: true,
        });
        registerStandaloneSurfaceFinalizer(surfacePtr, pDevice);

        Logger.log(
            LogCategory.D3D9,
            `CreateDepthStencilSurface(${w}x${h}, Format=${format}, MS=${multiSampleType}) -> 0x${surfacePtr.toString(16)}`,
        );

        if (!Mem.writeUint32(ppSurface, surfacePtr)) {
            releaseComRef(surfacePtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    // Lockable CPU-side surface backed by a hidden 1-level texture so the existing
    // Surface9 LockRect/UnlockRect/GetDesc paths (which route via meta.texturePtr)
    // work unchanged. Used by games for GetRenderTargetData readback staging.
    exports['IDirect3DDevice9_CreateOffscreenPlainSurface'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const width = args[1] >>> 0;
        const height = args[2] >>> 0;
        const format = args[3] >>> 0;
        const pool = args[4] >>> 0;
        const ppSurface = args[5];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);
        if (width === 0 || height === 0 || !isValidD3D9Pool(pool)
            || pool === D3DPOOL_MANAGED) return D3DERR_INVALIDCALL;
        if (format === D3DFMT_UNKNOWN || isDxExclusiveFormat(format, 9)) return D3DERR_INVALIDCALL;
        // The float contract is intentionally limited to sampled 2-D textures.
        // An offscreen plain surface is a D3DRTYPE_SURFACE and would require a
        // separate attachment/readback proof; do not let a valid R16F texture
        // probe accidentally make this surface constructor succeed.
        if (isD3DFloatFormat(format)) return D3DERR_NOTAVAILABLE;
        if (isDxUnsupportedFormat(format, 9)) return D3DERR_NOTAVAILABLE;

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const texVt = vtables['IDirect3DTexture9']?.address;
        const surfVt = vtables['IDirect3DSurface9']?.address;
        if (!texVt || !surfVt) return D3DERR_INVALIDCALL;

        const texPtr = createComObject(texVt);
        const guestPtr = device.createTexture(texPtr, width, height, 1, format, 0, pool);
        if (guestPtr === 0) {
            releaseComRef(texPtr);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(texPtr, device);
        textureMeta.set(texPtr, { width, height, levels: 1, usage: 0, pool, format });
        ensureBaseTextureState(texPtr, 1, 0);
        registerTextureFinalizer(texPtr, pDevice);

        const surfacePtr = createComObject(surfVt);
        resourceToDevice.set(surfacePtr, device);
        surfaceMeta.set(surfacePtr, {
            format,
            type: D3DRTYPE_SURFACE,
            usage: 0,
            pool,
            multiSampleType: D3DMULTISAMPLE_NONE,
            multiSampleQuality: 0,
            width,
            height,
            texturePtr: texPtr,
            level: 0,
            offscreenPlain: true,
            standalone: true,
            lockable: true,
        });
        // The app owns the SURFACE, but its refcount IS the hidden texture's (surfaces with
        // a texturePtr alias their parent — see addD3D9ComRef), so releasing the texture
        // tears the pair down and clearTextureSubresourceSurfaces drops this surface.

        Logger.log(LogCategory.D3D9,
            `CreateOffscreenPlainSurface(${width}x${height}, Format=${format}, Pool=${pool}) -> 0x${surfacePtr.toString(16)}`);
        if (!Mem.writeUint32(ppSurface, surfacePtr)) {
            releaseComRef(texPtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    // CreateRenderTarget(Width, Height, Format, MultiSample, MultisampleQuality, Lockable,
    // ppSurface, pSharedHandle). Backed by a hidden 1-level RENDERTARGET texture, the same
    // shape GetSurfaceLevel produces — that is what SetRenderTarget resolves through, and
    // what makes the result usable as a texture source after the app renders into it.
    exports['IDirect3DDevice9_CreateRenderTarget'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const width = args[1] >>> 0;
        const height = args[2] >>> 0;
        const format = args[3] >>> 0;
        const multiSampleType = args[4] >>> 0;
        const multiSampleQuality = args[5] >>> 0;
        const lockable = (args[6] >>> 0) !== 0;
        const ppSurface = args[7];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);
        if (width === 0 || height === 0) return D3DERR_INVALIDCALL;
        if (multiSampleQuality !== 0) return D3DERR_NOTAVAILABLE;
        if (format === D3DFMT_UNKNOWN || isDxExclusiveFormat(format, 9)) return D3DERR_INVALIDCALL;
        if (isD3DFloatFormat(format)) return D3DERR_NOTAVAILABLE;
        if (!isDxRenderableFormat(format, 9)) return D3DERR_NOTAVAILABLE;
        // The texture below is the single-sample resolve/storage image exposed to
        // the guest.  When this surface is bound with 2x/4x, the executor renders
        // into its cached multisample color attachment and resolves into this
        // texture at pass end.
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        if (!device.supportsD3D9MultisampleType(multiSampleType)) return D3DERR_NOTAVAILABLE;

        const vtables = getVTables();
        const texVt = vtables['IDirect3DTexture9']?.address;
        const surfVt = vtables['IDirect3DSurface9']?.address;
        if (!texVt || !surfVt) return D3DERR_INVALIDCALL;

        const texPtr = createComObject(texVt);
        if (device.createTexture(texPtr, width, height, 1, format, D3DUSAGE_RENDERTARGET, D3DPOOL_DEFAULT) === 0) {
            releaseComRef(texPtr);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(texPtr, device);
        textureMeta.set(texPtr, {
            width, height, levels: 1,
            usage: D3DUSAGE_RENDERTARGET,
            pool: D3DPOOL_DEFAULT,
            format,
        });
        ensureBaseTextureState(texPtr, 1, D3DUSAGE_RENDERTARGET);
        registerTextureFinalizer(texPtr, pDevice);

        const surfacePtr = createComObject(surfVt);
        resourceToDevice.set(surfacePtr, device);
        surfaceMeta.set(surfacePtr, {
            format,
            type: D3DRTYPE_SURFACE,
            usage: D3DUSAGE_RENDERTARGET,
            pool: D3DPOOL_DEFAULT,
            multiSampleType,
            multiSampleQuality,
            width,
            height,
            texturePtr: texPtr,
            level: 0,
            standalone: true,
            lockable,
        });

        Logger.log(LogCategory.D3D9,
            `CreateRenderTarget(${width}x${height}, Format=${format}, MS=${multiSampleType}) -> 0x${surfacePtr.toString(16)}`);
        if (!Mem.writeUint32(ppSurface, surfacePtr)) {
            releaseComRef(texPtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    // UpdateSurface(pSourceSurface, pSourceRect, pDestinationSurface, pDestPoint): sub-rect copy
    // from a SYSTEMMEM surface into a DEFAULT one. The pool pair, the matching formats and the
    // non-multisampled requirement are the real runtime's contract, not our simplification.
    // Both surfaces must be texture-backed — that is the only pixel store we can address.
    exports['IDirect3DDevice9_UpdateSurface'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pSrcSurface = args[1] >>> 0;
        const pSrcRect = args[2] >>> 0;
        const pDstSurface = args[3] >>> 0;
        const pDstPoint = args[4] >>> 0;
        if (!device || !pSrcSurface || !pDstSurface) return D3DERR_INVALIDCALL;

        const src = surfaceMeta.get(pSrcSurface);
        const dst = surfaceMeta.get(pDstSurface);
        if (!src || !dst) return D3DERR_INVALIDCALL;
        if (src.format !== dst.format) return D3DERR_INVALIDCALL;
        if (src.multiSampleType !== D3DMULTISAMPLE_NONE || dst.multiSampleType !== D3DMULTISAMPLE_NONE) {
            return D3DERR_INVALIDCALL;
        }
        if (src.pool !== D3DPOOL_SYSTEMMEM || dst.pool !== D3DPOOL_DEFAULT) return D3DERR_INVALIDCALL;
        // A surface with no parent texture (the implicit backbuffer) has no CPU-side pixels.
        // Cube faces are valid SYSTEMMEM/DEFAULT subresources too, but their bytes live in a
        // separate per-face store and must not be accidentally copied from face zero.
        if (!src.texturePtr || !dst.texturePtr ||
            (src.face !== undefined) !== (dst.face !== undefined)) {
            Logger.warn(LogCategory.D3D9,
                `UpdateSurface: unsupported surface pair (src tex=0x${(src.texturePtr ?? 0).toString(16)} face=${src.face ?? -1}, ` +
                `dst tex=0x${(dst.texturePtr ?? 0).toString(16)} face=${dst.face ?? -1})`);
            return D3DERR_INVALIDCALL;
        }
        const srcTex = textureMeta.get(src.texturePtr);
        const dstTex = textureMeta.get(dst.texturePtr);
        if (!srcTex || !dstTex || (!!srcTex.isCube) !== (!!dstTex.isCube) ||
            (src.face !== undefined && (!srcTex.isCube || !dstTex.isCube))) {
            return D3DERR_INVALIDCALL;
        }

        let left = 0, top = 0, right = src.width, bottom = src.height;
        if (pSrcRect) {
            left = Mem.readInt32(pSrcRect) ?? 0;
            top = Mem.readInt32(pSrcRect + 4) ?? 0;
            right = Mem.readInt32(pSrcRect + 8) ?? 0;
            bottom = Mem.readInt32(pSrcRect + 12) ?? 0;
        }
        const dstX = pDstPoint ? (Mem.readInt32(pDstPoint) ?? 0) : 0;
        const dstY = pDstPoint ? (Mem.readInt32(pDstPoint + 4) ?? 0) : 0;

        const w = right - left;
        const h = bottom - top;
        if (left < 0 || top < 0 || w <= 0 || h <= 0) return D3DERR_INVALIDCALL;
        if (right > src.width || bottom > src.height) return D3DERR_INVALIDCALL;
        if (dstX < 0 || dstY < 0 || dstX + w > dst.width || dstY + h > dst.height) return D3DERR_INVALIDCALL;

        // Block-compressed surfaces move whole blocks; D3D9 rejects unaligned coordinates and
        // only tolerates a ragged extent when it is the full mip extent.
        const layout = getD3DTextureLayout(src.format, src.width, src.height);
        const blockW = layout.compressed ? 4 : 1;
        const blockH = layout.compressed ? 4 : 1;
        if (left % blockW || dstX % blockW || top % blockH || dstY % blockH) return D3DERR_INVALIDCALL;
        if ((w % blockW || h % blockH) && (w !== src.width || h !== src.height)) return D3DERR_INVALIDCALL;

        const srcLevel = src.level ?? 0;
        const dstLevel = dst.level ?? 0;
        const getPixels = (meta: SurfaceMeta): { data: Uint8Array; pitch: number; width: number; height: number } | null => {
            if (meta.face !== undefined) {
                const getCube = (device as D3D9Device & {
                    getCubeFacePixels?: (texture: number, face: number, level: number) => {
                        data: Uint8Array; pitch: number; width: number; height: number;
                    } | null;
                }).getCubeFacePixels;
                return typeof getCube === 'function'
                    ? getCube.call(device, meta.texturePtr!, meta.face, meta.level ?? 0)
                    : null;
            }
            return device.getTextureLevelPixels(meta.texturePtr!, meta.level ?? 0);
        };
        const setPixels = (meta: SurfaceMeta, data: Uint8Array, pitch: number): boolean => {
            if (meta.face !== undefined) {
                const setCube = (device as D3D9Device & {
                    setCubeFacePixels?: (texture: number, face: number, level: number, src: Uint8Array, srcPitch: number) => boolean;
                }).setCubeFacePixels;
                return typeof setCube === 'function'
                    ? setCube.call(device, meta.texturePtr!, meta.face, meta.level ?? 0, data, pitch)
                    : false;
            }
            return device.setTextureLevelPixels(meta.texturePtr!, meta.level ?? 0, data, pitch);
        };
        const srcPix = getPixels(src);
        const dstPix = getPixels(dst);
        if (!srcPix || !dstPix) return D3DERR_INVALIDCALL;

        const unitBytes = layout.compressed ? layout.blockBytes : layout.pitch / Math.max(1, src.width);
        const rowBytes = Math.ceil(w / blockW) * unitBytes;
        const srcCol = (left / blockW) * unitBytes;
        const dstCol = (dstX / blockW) * unitBytes;
        const rows = Math.ceil(h / blockH);
        for (let r = 0; r < rows; r++) {
            const s = (top / blockH + r) * srcPix.pitch + srcCol;
            const d = (dstY / blockH + r) * dstPix.pitch + dstCol;
            dstPix.data.set(srcPix.data.subarray(s, s + rowBytes), d);
        }
        if (!setPixels(dst, dstPix.data, dstPix.pitch)) {
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9,
            `UpdateSurface(${w}x${h} from ${left},${top} -> ${dstX},${dstY}) fmt=${src.format}`);
        return D3D_OK;
    };

    // GetRenderTargetData(pRenderTarget, pDestSurface): GPU→CPU readback into the
    // destination surface's guest store. Async (WebGPU map) — the dispatcher awaits.
    exports['IDirect3DDevice9_GetRenderTargetData'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pRenderTarget = args[1] >>> 0;
        const pDestSurface = args[2] >>> 0;

        const device = devices.get(pDevice);
        // Either pointer NULL is D3DERR_INVALIDCALL — Wine pins all three combinations
        // (dlls/d3d9/tests/device.c:12870-12877), and the runtime checks them first
        // (DXVK d3d9_device.cpp:1143-1144).
        if (!device || !pRenderTarget || !pDestSurface) return D3DERR_INVALIDCALL;
        // Copying a surface onto itself is a silent no-op, not an error (DXVK :1146-1147).
        if (pRenderTarget === pDestSurface) return D3D_OK;

        const srcMeta = surfaceMeta.get(pRenderTarget);
        const dstMeta = surfaceMeta.get(pDestSurface);
        // The IMPLICIT back buffer has no owning texture — it names the swap-chain image, which
        // lives in the presenter rather than the texture table. Requiring a texturePtr therefore
        // refused every readback of the back buffer, which is the one surface an app is most
        // likely to read (screenshots, post-processing, and any pixel self-check).
        // Belonging to a swap chain is the authoritative test: the implicit back buffer is
        // registered there, and only the fallback path also records it per device.
        const srcIsBackBuffer = !srcMeta?.texturePtr
            && (getSwapChainForSurface(pRenderTarget) !== null
                || isDeviceBackBufferSurface(pDevice >>> 0, pRenderTarget));
        if ((!srcMeta?.texturePtr && !srcIsBackBuffer) || !dstMeta?.texturePtr) return D3DERR_INVALIDCALL;
        if (!srcMeta) return D3DERR_INVALIDCALL;
        // GetRenderTargetData is a render-target → SYSTEMMEM readback.  Accepting a
        // DEFAULT destination or a sampled source would report success while leaving the
        // caller's intended CPU buffer untouched.
        if ((srcMeta.usage & D3DUSAGE_RENDERTARGET) === 0 ||
            dstMeta.pool !== D3DPOOL_SYSTEMMEM ||
            (dstMeta.usage & (D3DUSAGE_RENDERTARGET | D3DUSAGE_DEPTHSTENCIL)) !== 0) {
            return D3DERR_INVALIDCALL;
        }
        if ((srcMeta.face !== undefined && !srcIsBackBuffer && !(textureMeta.get(srcMeta.texturePtr!)?.isCube)) ||
            (dstMeta.face !== undefined || (dstMeta.level ?? 0) !== 0)) return D3DERR_INVALIDCALL;

        if ((globalThis as { __noD3D9GetRenderTargetDataChecks?: boolean })
            .__noD3D9GetRenderTargetDataChecks !== true) {
            // A multisampled source cannot be copied out this way — Wine returns
            // D3DERR_INVALIDCALL (dlls/d3d9/device.c:1956) and asserts it
            // (dlls/d3d9/tests/visual.c:17149-17150).
            if (srcMeta.multiSampleType !== D3DMULTISAMPLE_NONE) return D3DERR_INVALIDCALL;
            // Exact format and exact extent (DXVK :1152-1156). Answering D3D_OK for a
            // mismatch and then converting is a false capability: the app reads a buffer
            // laid out differently from the one it asked for and cannot tell.
            if (srcMeta.format !== dstMeta.format) return D3DERR_INVALIDCALL;
            if (srcMeta.width !== dstMeta.width || srcMeta.height !== dstMeta.height) {
                return D3DERR_INVALIDCALL;
            }
        }

        if (srcIsBackBuffer) return device.readBackbufferIntoGuestTexture(dstMeta.texturePtr);
        return device.readTextureIntoGuestTexture(
            srcMeta.texturePtr!,
            dstMeta.texturePtr,
            srcMeta.level ?? 0,
            srcMeta.face ?? -1,
        );
    };

    exports['IDirect3DVertexBuffer9_Lock'] = (ctx, mem, args) => {
        const pVertexBuffer = args[0];
        const OffsetToLock = args[1];
        const SizeToLock = args[2];
        const ppbData = args[3];
        const Flags = args[4];

        if (!ppbData || activeBufferLocks.has(pVertexBuffer >>> 0)) {
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }

        const device = resourceToDevice.get(pVertexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Lock: invalid buffer ${pVertexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `VertexBuffer::Lock(Offset=${OffsetToLock}, Size=${SizeToLock})`);

        const dataPtr = device.lockVertexBuffer(pVertexBuffer, OffsetToLock, SizeToLock, Flags);
        if (dataPtr === 0) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Lock failed for 0x${pVertexBuffer.toString(16)}`);
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }
        Logger.log(LogCategory.D3D9, `VertexBuffer::Lock -> guest ptr 0x${dataPtr.toString(16)}`);

        if (!Mem.writeUint32(ppbData, dataPtr)) {
            device.unlockVertexBuffer(pVertexBuffer, mem);
            return D3DERR_INVALIDCALL;
        }
        activeBufferLocks.set(pVertexBuffer >>> 0, 'vertex');

        return D3D_OK;
    };

    exports['IDirect3DVertexBuffer9_Unlock'] = (ctx, mem, args) => {
        const pVertexBuffer = args[0];

        const device = resourceToDevice.get(pVertexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Unlock: invalid buffer ${pVertexBuffer}`);
            return D3DERR_INVALIDCALL;
        }
        if (activeBufferLocks.get(pVertexBuffer >>> 0) !== 'vertex') return D3DERR_INVALIDCALL;

        Logger.verbose(LogCategory.D3D9, 'VertexBuffer::Unlock()');
        device.unlockVertexBuffer(pVertexBuffer, mem);
        clearActiveBufferLock(pVertexBuffer);
        return D3D_OK;
    };

    exports['IDirect3DIndexBuffer9_Lock'] = (ctx, mem, args) => {
        const pIndexBuffer = args[0];
        const OffsetToLock = args[1];
        const SizeToLock = args[2];
        const ppbData = args[3];
        const Flags = args[4];

        if (!ppbData || activeBufferLocks.has(pIndexBuffer >>> 0)) {
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }

        const device = resourceToDevice.get(pIndexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Lock: invalid buffer ${pIndexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `IndexBuffer::Lock(Offset=${OffsetToLock}, Size=${SizeToLock})`);

        const dataPtr = device.lockIndexBuffer(pIndexBuffer, OffsetToLock, SizeToLock, Flags);
        if (dataPtr === 0) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Lock failed for 0x${pIndexBuffer.toString(16)}`);
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }
        Logger.log(LogCategory.D3D9, `IndexBuffer::Lock -> guest ptr 0x${dataPtr.toString(16)}`);

        if (!Mem.writeUint32(ppbData, dataPtr)) {
            device.unlockIndexBuffer(pIndexBuffer, mem);
            return D3DERR_INVALIDCALL;
        }
        activeBufferLocks.set(pIndexBuffer >>> 0, 'index');

        return D3D_OK;
    };

    exports['IDirect3DIndexBuffer9_Unlock'] = (ctx, mem, args) => {
        const pIndexBuffer = args[0];

        const device = resourceToDevice.get(pIndexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Unlock: invalid buffer ${pIndexBuffer}`);
            return D3DERR_INVALIDCALL;
        }
        if (activeBufferLocks.get(pIndexBuffer >>> 0) !== 'index') return D3DERR_INVALIDCALL;

        Logger.verbose(LogCategory.D3D9, 'IndexBuffer::Unlock()');
        device.unlockIndexBuffer(pIndexBuffer, mem);
        clearActiveBufferLock(pIndexBuffer);
        return D3D_OK;
    };

    exports['IDirect3DTexture9_LockRect'] = (ctx, mem, args) => {
        const pTexture = args[0];
        const Level = args[1];
        const pLockedRect = args[2];
        const pRect = args[3];
        const Flags = args[4];

        const device = resourceToDevice.get(pTexture);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect: invalid texture ${pTexture}`);
            return D3DERR_INVALIDCALL;
        }
        if (!pLockedRect) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect: pLockedRect is NULL (tex=0x${pTexture.toString(16)})`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `Texture::LockRect(Level=${Level})`);

        const meta = textureMeta.get(pTexture);
        // D3D9 rejects levels outside the declared chain before touching the
        // backend.  Without this guard the compatibility mip scratch path can
        // allocate an unowned level (and even make UnlockRect appear valid).
        if (!meta || meta.isCube || (Level >>> 0) >= meta.levels) {
            if (pLockedRect) Mem.writeUint32(pLockedRect, 0);
            return D3DERR_INVALIDCALL;
        }
        if (activeLockReadOnly.has(`${pTexture}:${Level}`)) {
            // D3D9 locks are not re-entrant; returning the same scratch pointer
            // would let two UnlockRect calls publish an ambiguous write.
            if (pLockedRect) Mem.writeUint32(pLockedRect, 0);
            return D3DERR_INVALIDCALL;
        }
        const dims = meta ? getTextureLevelDims(meta.width, meta.height, Level) : { width: 1, height: 1 };
        const format = meta?.format ?? D3DFMT_A8R8G8B8;
        const plan = planTextureLock(
            device, pTexture, Level, dims.width, dims.height,
            (meta?.pool ?? D3DPOOL_DEFAULT) === D3DPOOL_DEFAULT, pRect, Flags);
        if (!plan) return D3DERR_INVALIDCALL;

        const finish = (): number => completeTextureLock(
            device, pTexture, Level, plan, format, dims.width, dims.height, pRect, pLockedRect, mem);
        // Async ONLY when a GPU round trip is genuinely pending; see planTextureLock.
        const pending: Promise<number> | null = plan.pending ? plan.pending.then(finish) : null;
        return pending ?? finish();
    };

    exports['IDirect3DTexture9_UnlockRect'] = (ctx, mem, args) => {
        const pTexture = args[0];
        const Level = args[1];

        const device = resourceToDevice.get(pTexture);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Texture::UnlockRect: invalid texture ${pTexture}`);
            return D3DERR_INVALIDCALL;
        }

        const meta = textureMeta.get(pTexture);
        const key = `${pTexture}:${Level}`;
        if (!meta || meta.isCube || (Level >>> 0) >= meta.levels || !activeLockReadOnly.has(key)) {
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `Texture::UnlockRect(Level=${Level})`);
        finishTextureUnlock(device, pTexture, Level, mem);
        return D3D_OK;
    };

    exports['IDirect3DTexture9_GetLevelCount'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        return textureMeta.get(pTexture)?.levels ?? 1;
    };

    exports['IDirect3DTexture9_GetLevelDesc'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        const level = args[1] >>> 0;
        const pDesc = args[2];
        if (!pDesc) return D3DERR_INVALIDCALL;

        const meta = textureMeta.get(pTexture);
        if (!meta || level >= meta.levels) {
            return D3DERR_INVALIDCALL;
        }

        const dims = getTextureLevelDims(meta.width, meta.height, level);
        const ok = writeSurfaceDesc(pDesc, {
            format: meta.format,
            type: D3DRTYPE_SURFACE,
            usage: meta.usage,
            pool: meta.pool,
            multiSampleType: D3DMULTISAMPLE_NONE,
            multiSampleQuality: 0,
            width: dims.width,
            height: dims.height,
        });
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DTexture9_GetSurfaceLevel'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        const level = args[1] >>> 0;
        const ppSurfaceLevel = args[2];
        if (!ppSurfaceLevel) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurfaceLevel);

        const meta = textureMeta.get(pTexture);
        if (!meta || meta.isCube || level >= meta.levels) {
            return D3DERR_INVALIDCALL;
        }

        const surfacePtr = ensureTextureLevelSurface(pTexture, level);
        if (!surfacePtr) return D3DERR_INVALIDCALL;

        if (!Mem.writeUint32(ppSurfaceLevel, surfacePtr)) return D3DERR_INVALIDCALL;
        addComRef(pTexture);
        return D3D_OK;
    };

    const readDirtyRect = (mem: Uint8Array, ptr: number): { left: number; top: number; right: number; bottom: number } | null => {
        if (!ptr) return null;
        const left = Mem.readInt32(ptr);
        const top = Mem.readInt32(ptr + 4);
        const right = Mem.readInt32(ptr + 8);
        const bottom = Mem.readInt32(ptr + 12);
        if (left === null || top === null || right === null || bottom === null) return null;
        return { left, top, right, bottom };
    };

    // SetLOD/GetLOD return a DWORD, never an HRESULT: an error code handed back as the
    // previous LOD makes `old = SetLOD(n); SetLOD(old)` clamp to the last mip. SetLOD is
    // also ignored outside D3DPOOL_MANAGED (both return 0 there) — the LOD only selects
    // which mips the managed-pool loader keeps resident.
    const setTextureLod = (_ctx: unknown, _mem: Uint8Array, args: number[]): number => {
        const ptr = args[0] >>> 0;
        const meta = textureMeta.get(ptr);
        if (!meta || meta.pool !== D3DPOOL_MANAGED) return 0;
        const state = ensureBaseTextureState(ptr, meta.levels, meta.usage);
        const previous = state.lod >>> 0;
        state.lod = Math.min(args[1] >>> 0, Math.max(0, meta.levels - 1));
        return previous;
    };
    const getTextureLod = (_ctx: unknown, _mem: Uint8Array, args: number[]): number => {
        const ptr = args[0] >>> 0;
        const meta = textureMeta.get(ptr);
        if (!meta || meta.pool !== D3DPOOL_MANAGED) return 0;
        return ensureBaseTextureState(ptr, meta.levels, meta.usage).lod >>> 0;
    };
    const setTextureAutoGenFilter = (_ctx: unknown, _mem: Uint8Array, args: number[]): number => {
        const ptr = args[0] >>> 0;
        const meta = textureMeta.get(ptr);
        if (!meta || (meta.usage & D3DUSAGE_AUTOGENMIPMAP) === 0) return D3DERR_INVALIDCALL;
        const filter = args[1] >>> 0;
        if (!validAutoGenFilter(filter)) return D3DERR_INVALIDCALL;
        ensureBaseTextureState(ptr, meta.levels, meta.usage).autoGenFilterType = filter;
        return D3D_OK;
    };
    const getTextureAutoGenFilter = (_ctx: unknown, _mem: Uint8Array, args: number[]): number => {
        const ptr = args[0] >>> 0;
        const meta = textureMeta.get(ptr);
        if (!meta || (meta.usage & D3DUSAGE_AUTOGENMIPMAP) === 0) return 0;
        return ensureBaseTextureState(ptr, meta.levels, meta.usage).autoGenFilterType >>> 0;
    };
    const generateTextureMipSubLevels = (_ctx: unknown, _mem: Uint8Array, args: number[]): number => {
        const ptr = args[0] >>> 0;
        const meta = textureMeta.get(ptr);
        const device = resourceToDevice.get(ptr);
        if (!meta || !device || (meta.usage & D3DUSAGE_AUTOGENMIPMAP) === 0) return D3DERR_INVALIDCALL;
        const state = ensureBaseTextureState(ptr, meta.levels, meta.usage);
        return generateTextureMips(device, ptr, meta.levels, state.autoGenFilterType);
    };
    const addTextureDirtyRect = (_ctx: unknown, mem: Uint8Array, args: number[]): number => {
        const ptr = args[0] >>> 0;
        const meta = textureMeta.get(ptr);
        if (!meta || meta.isCube) return D3DERR_INVALIDCALL;
        const rect = readDirtyRect(mem, args[1] >>> 0);
        if (args[1] && (!rect || rect.left < 0 || rect.top < 0 || rect.right <= rect.left
            || rect.bottom <= rect.top || rect.right > meta.width || rect.bottom > meta.height)) {
            return D3DERR_INVALIDCALL;
        }
        // Managed clients may keep using the LockRect pointer after UnlockRect
        // and rely on AddDirtyRect as the upload notification.  Mark the
        // backend shadow dirty here; the device method is optional for the
        // lightweight fake devices used by API tests.
        const device = resourceToDevice.get(ptr) as D3D9Device | undefined;
        // Render-target textures are GPU-authored; marking their CPU shadow
        // dirty would upload stale bytes over the next draw.  AddDirtyRect is
        // meaningful for CPU/managed texture data only.
        if ((meta.usage & D3DUSAGE_RENDERTARGET) === 0) device?.markTextureDirty?.(ptr);
        return D3D_OK;
    };

    exports['IDirect3DTexture9_SetLOD'] = setTextureLod;
    exports['IDirect3DTexture9_GetLOD'] = getTextureLod;
    exports['IDirect3DTexture9_SetAutoGenFilterType'] = setTextureAutoGenFilter;
    exports['IDirect3DTexture9_GetAutoGenFilterType'] = getTextureAutoGenFilter;
    exports['IDirect3DTexture9_GenerateMipSubLevels'] = generateTextureMipSubLevels;
    exports['IDirect3DTexture9_AddDirtyRect'] = addTextureDirtyRect;

    exports['IDirect3DCubeTexture9_SetLOD'] = setTextureLod;
    exports['IDirect3DCubeTexture9_GetLOD'] = getTextureLod;
    exports['IDirect3DCubeTexture9_SetAutoGenFilterType'] = setTextureAutoGenFilter;
    exports['IDirect3DCubeTexture9_GetAutoGenFilterType'] = getTextureAutoGenFilter;
    exports['IDirect3DCubeTexture9_GenerateMipSubLevels'] = generateTextureMipSubLevels;

    // ── IDirect3DCubeTexture9 ────────────────────────────────────────────────
    // A cube texture is one resource with 6 faces (CubeMapFace 0..5). GetCubeMapSurface
    // hands back a per-face IDirect3DSurface9 (used as a render target for reflection probes);
    // LockRect/UnlockRect take an extra FaceType selector vs the 2D texture methods.

    exports['IDirect3DCubeTexture9_GetCubeMapSurface'] = (_ctx, _mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;
        const ppSurface = args[3];
        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);

        const meta = textureMeta.get(pCube);
        if (!meta || !meta.isCube || faceType > 5 || level >= meta.levels) {
            return D3DERR_INVALIDCALL;
        }

        const surfacePtr = ensureCubeFaceSurface(pCube, faceType, level);
        if (!surfacePtr) return D3DERR_INVALIDCALL;

        if (!Mem.writeUint32(ppSurface, surfacePtr)) return D3DERR_INVALIDCALL;
        addComRef(pCube);
        return D3D_OK;
    };

    exports['IDirect3DCubeTexture9_LockRect'] = (_ctx, mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;
        const pLockedRect = args[3];
        const pRect = args[4];
        const flags = args[5] >>> 0;

        const device = resourceToDevice.get(pCube);
        const meta = textureMeta.get(pCube);
        if (!device || !meta?.isCube || !pLockedRect || faceType > 5 || level >= meta.levels) {
            return D3DERR_INVALIDCALL;
        }

        return completeCubeFaceLock(
            device,
            pCube,
            faceType,
            level,
            meta,
            pLockedRect,
            pRect,
            flags,
            mem,
        );
    };

    exports['IDirect3DCubeTexture9_UnlockRect'] = (_ctx, mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;

        const device = resourceToDevice.get(pCube);
        const meta = textureMeta.get(pCube);
        if (!device || !meta?.isCube || faceType > 5 || level >= meta.levels) return D3DERR_INVALIDCALL;

        const lockKey = `${pCube}:${faceType}:${level}`;
        if (!activeCubeLocks.has(lockKey)) return D3DERR_INVALIDCALL;
        const unlocked = device.unlockCubeFace(pCube, faceType, level, mem);
        if (unlocked) activeCubeLocks.delete(lockKey);
        return unlocked ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DCubeTexture9_GetLevelCount'] = (_ctx, _mem, args) => {
        return textureMeta.get(args[0])?.levels ?? 1;
    };

    exports['IDirect3DCubeTexture9_GetLevelDesc'] = (_ctx, _mem, args) => {
        const pCube = args[0];
        const level = args[1] >>> 0;
        const pDesc = args[2];
        if (!pDesc) return D3DERR_INVALIDCALL;

        const meta = textureMeta.get(pCube);
        if (!meta || !meta.isCube || level >= meta.levels) return D3DERR_INVALIDCALL;

        const dim = Math.max(1, meta.width >>> level);
        const ok = writeSurfaceDesc(pDesc, {
            format: meta.format,
            type: D3DRTYPE_SURFACE,
            usage: meta.usage,
            pool: meta.pool,
            multiSampleType: D3DMULTISAMPLE_NONE,
            multiSampleQuality: 0,
            width: dim,
            height: dim,
        });
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    /**
     * IDirect3DDevice9::UpdateTexture — the SYSTEMMEM -> VIDEO staging copy. Engines that
     * never lock a DEFAULT-pool texture (SS2/NewDark loads every world texture into a
     * SYSTEMMEM twin and pushes it across with this) get an entirely black world without
     * it: the video-memory texture is created, bound and sampled, but nothing ever writes
     * its pixels.
     *
     * Level matching is by DIMENSION, not by index: the destination may have a shorter
     * mip chain, in which case the copy starts at the source level whose extents equal
     * destination level 0. Level 0 is written LAST because that write is what marks the
     * texture dirty for re-upload.
     */
    exports['IDirect3DDevice9_UpdateTexture'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const pDst = args[2] >>> 0;
        const device = devices.get(pDevice);
        if (!device || !pSrc || !pDst) return D3DERR_INVALIDCALL;

        // Volume textures use the same SYSTEMMEM -> DEFAULT contract, but their
        // bytes live in D3DVOLUME_DESC-backed 3-D allocations rather than the
        // 2-D TextureStore. Handle the complete mip chain here before the
        // ordinary texture metadata path below.
        const srcVolume = volumeTextureResources.get(pSrc);
        const dstVolume = volumeTextureResources.get(pDst);
        if (srcVolume || dstVolume) {
            if (!srcVolume || !dstVolume || srcVolume.format !== dstVolume.format
                || srcVolume.pool !== D3DPOOL_SYSTEMMEM || dstVolume.pool === D3DPOOL_SYSTEMMEM
                || resourceToDevice.get(pSrc) !== device || resourceToDevice.get(pDst) !== device) {
                return D3DERR_INVALIDCALL;
            }
            let srcBase = -1;
            for (let l = 0; l < srcVolume.levels; l++) {
                const d = getVolumeLevelDims(srcVolume.width, srcVolume.height, srcVolume.depth, l);
                if (d.width === dstVolume.width && d.height === dstVolume.height && d.depth === dstVolume.depth) {
                    srcBase = l;
                    break;
                }
            }
            if (srcBase < 0) return D3DERR_INVALIDCALL;
            const levels = Math.min(dstVolume.levels, srcVolume.levels - srcBase);
            let copied = 0;
            for (let i = levels - 1; i >= 0; i--) {
                const srcLevel = getVolumeLevel(pSrc, srcBase + i);
                const dstLevel = getVolumeLevel(pDst, i);
                if (!srcLevel || !dstLevel || srcLevel.bytes !== dstLevel.bytes) return D3DERR_INVALIDCALL;
                const bytes = Mem.readBytes(srcLevel.ptr, srcLevel.bytes);
                if (!bytes || Mem.writeBytes(dstLevel.ptr, bytes) !== bytes.length) return D3DERR_INVALIDCALL;
                copied++;
            }
            if (copied > 0) (device as D3D9Device).markVolumeTextureDirty?.(pDst);
            return copied > 0 ? D3D_OK : D3DERR_INVALIDCALL;
        }

        const src = textureMeta.get(pSrc);
        const dst = textureMeta.get(pDst);
        if (!src || !dst) return D3DERR_INVALIDCALL;
        if (src.format !== dst.format || (!!src.isCube) !== (!!dst.isCube) || pSrc === pDst) {
            return D3DERR_INVALIDCALL;
        }
        // Real D3D9: source must be SYSTEMMEM, destination must not be.
        if (src.pool !== D3DPOOL_SYSTEMMEM || dst.pool === D3DPOOL_SYSTEMMEM) return D3DERR_INVALIDCALL;
        if ((src.usage & (D3DUSAGE_RENDERTARGET | D3DUSAGE_DEPTHSTENCIL)) !== 0 ||
            (dst.usage & D3DUSAGE_DEPTHSTENCIL) !== 0) return D3DERR_INVALIDCALL;
        if (resourceToDevice.get(pSrc) !== device || resourceToDevice.get(pDst) !== device) {
            return D3DERR_INVALIDCALL;
        }

        let srcBase = -1;
        for (let l = 0; l < src.levels; l++) {
            if (Math.max(1, src.width >>> l) === dst.width && Math.max(1, src.height >>> l) === dst.height) {
                srcBase = l;
                break;
            }
        }
        if (srcBase < 0) return D3DERR_INVALIDCALL;

        const levels = Math.min(dst.levels, src.levels - srcBase);
        if (levels <= 0) return D3DERR_INVALIDCALL;

        const copyLevel = (srcLevel: number, dstLevel: number, face?: number): boolean => {
            if (face !== undefined) {
                const cubeDevice = device as D3D9Device & {
                    getCubeFacePixels?: (texture: number, cubeFace: number, level: number) => {
                        data: Uint8Array; pitch: number; width: number; height: number;
                    } | null;
                    setCubeFacePixels?: (texture: number, cubeFace: number, level: number, src: Uint8Array, srcPitch: number) => boolean;
                };
                const source = cubeDevice.getCubeFacePixels?.call(device, pSrc, face, srcLevel);
                return !!source && !!cubeDevice.setCubeFacePixels?.call(device, pDst, face, dstLevel, source.data, source.pitch);
            }
            const source = device.getTextureLevelPixels(pSrc, srcLevel);
            return !!source && device.setTextureLevelPixels(pDst, dstLevel, source.data, source.pitch);
        };

        let copied = 0;
        for (let i = levels - 1; i >= 0; i--) {
            if (src.isCube) {
                let allFaces = true;
                for (let face = 0; face < 6; face++) {
                    if (!copyLevel(srcBase + i, i, face)) allFaces = false;
                }
                if (allFaces) copied++;
            } else if (copyLevel(srcBase + i, i)) copied++;
        }
        if (copied !== levels) return D3DERR_INVALIDCALL;

        Logger.verbose(LogCategory.D3D9,
            `UpdateTexture(0x${pSrc.toString(16)} -> 0x${pDst.toString(16)}): ${copied}/${levels} levels ` +
            `from src level ${srcBase}`);
        return D3D_OK;
    };

    // ── IDirect3DResource9 inherited contract ─────────────────────────────
    // Every concrete resource uses the same private-data/priority handlers.
    // Keep the liveness check strict: a successful HRESULT on a stale COM
    // pointer is worse than an explicit INVALIDCALL because callers commonly
    // immediately dereference the returned state.
    const isLiveResource = (ptr: number): boolean => {
        const p = ptr >>> 0;
        return resourceToDevice.has(p) && (
            vertexBufferMeta.has(p) || indexBufferMeta.has(p) ||
            textureMeta.has(p) || surfaceMeta.has(p)
        );
    };
    const resourcePool = (ptr: number): number | null => {
        const p = ptr >>> 0;
        return vertexBufferMeta.get(p)?.pool
            ?? indexBufferMeta.get(p)?.pool
            ?? textureMeta.get(p)?.pool
            ?? surfaceMeta.get(p)?.pool
            ?? null;
    };

    const resourceSetPrivateDataExport = (_ctx: unknown, mem: Uint8Array, args: number[]) =>
        resourceSetPrivateData(mem, args, isLiveResource);
    const resourceGetPrivateDataExport = (_ctx: unknown, mem: Uint8Array, args: number[]) =>
        resourceGetPrivateData(mem, args, isLiveResource);
    const resourceFreePrivateDataExport = (_ctx: unknown, mem: Uint8Array, args: number[]) =>
        resourceFreePrivateData(mem, args, isLiveResource);
    const resourceSetPriorityExport = (_ctx: unknown, _mem: Uint8Array, args: number[]) =>
        resourceSetPriority(args, isLiveResource, resourcePool);
    const resourceGetPriorityExport = (_ctx: unknown, _mem: Uint8Array, args: number[]) =>
        resourceGetPriority(args, isLiveResource);
    const resourcePreLoadExport = (_ctx: unknown, _mem: Uint8Array, args: number[]) =>
        resourcePreLoad(args, isLiveResource);
    const resourceGetTypeExport = (_ctx: unknown, _mem: Uint8Array, args: number[]): number => {
        const ptr = args[0] >>> 0;
        if (vertexBufferMeta.has(ptr)) return D3DRTYPE_VERTEXBUFFER;
        if (indexBufferMeta.has(ptr)) return D3DRTYPE_INDEXBUFFER;
        if (surfaceMeta.has(ptr)) return D3DRTYPE_SURFACE;
        const texture = textureMeta.get(ptr);
        if (texture?.isCube) return D3DRTYPE_CUBETEXTURE;
        if (texture) return D3DRTYPE_TEXTURE;
        return D3DRTYPE_UNKNOWN;
    };

    for (const prefix of [
        'IDirect3DVertexBuffer9', 'IDirect3DIndexBuffer9',
        'IDirect3DTexture9', 'IDirect3DCubeTexture9', 'IDirect3DSurface9',
    ]) {
        exports[`${prefix}_SetPrivateData`] = resourceSetPrivateDataExport;
        exports[`${prefix}_GetPrivateData`] = resourceGetPrivateDataExport;
        exports[`${prefix}_FreePrivateData`] = resourceFreePrivateDataExport;
        exports[`${prefix}_SetPriority`] = resourceSetPriorityExport;
        exports[`${prefix}_GetPriority`] = resourceGetPriorityExport;
        exports[`${prefix}_PreLoad`] = resourcePreLoadExport;
        exports[`${prefix}_GetType`] = resourceGetTypeExport;
    }

    // IDirect3DResource9::GetDevice — identical for every resource type, so one
    // implementation serves them all. An UNIMPLEMENTED GetDevice is not a benign gap:
    // the stub returns 0 (== D3D_OK) without touching *ppDevice, so the caller reads its
    // own uninitialised local as an IDirect3DDevice9* and calls through it. That is how
    // System Shock 2 died at level load — Texture9::GetDevice fed a garbage vtable into
    // the very next call and execution left the module entirely.
    const resourceGetDevice = (_ctx: unknown, _mem: unknown, args: number[]): number => {
        const pResource = args[0];
        const ppDevice = args[1];
        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);

        const device = resourceToDevice.get(pResource);
        if (!device) return D3DERR_INVALIDCALL;
        const devicePtr = resolveDevicePtr(device);
        if (!devicePtr) return D3DERR_INVALIDCALL;
        if (!Mem.writeUint32(ppDevice, devicePtr)) return D3DERR_INVALIDCALL;
        addComRef(devicePtr);
        return D3D_OK;
    };

    exports['IDirect3DCubeTexture9_GetDevice'] = resourceGetDevice;
    exports['IDirect3DTexture9_GetDevice'] = resourceGetDevice;
    exports['IDirect3DVertexBuffer9_GetDevice'] = resourceGetDevice;
    exports['IDirect3DIndexBuffer9_GetDevice'] = resourceGetDevice;

    exports['IDirect3DCubeTexture9_AddDirtyRect'] = (_ctx, mem, args) => {
        const ptr = args[0] >>> 0;
        const face = args[1] >>> 0;
        const meta = textureMeta.get(ptr);
        if (!meta?.isCube || face > 5) return D3DERR_INVALIDCALL;
        const rect = readDirtyRect(mem, args[2] >>> 0);
        if (args[2] && (!rect || rect.left < 0 || rect.top < 0 || rect.right <= rect.left
            || rect.bottom <= rect.top || rect.right > meta.width || rect.bottom > meta.height)) {
            return D3DERR_INVALIDCALL;
        }
        const device = resourceToDevice.get(ptr) as D3D9Device | undefined;
        if ((meta.usage & D3DUSAGE_RENDERTARGET) === 0) device?.markTextureDirty?.(ptr);
        return D3D_OK;
    };

    exports['IDirect3DSurface9_LockRect'] = (_ctx, mem, args) => {
        const pSurface = args[0];
        const pLockedRect = args[1];
        const pRect = args[2];
        const flags = args[3] >>> 0;

        const meta = surfaceMeta.get(pSurface);
        const device = resourceToDevice.get(pSurface);
        if (!meta || !device || !meta.texturePtr || meta.lockable === false || !pLockedRect) {
            return D3DERR_INVALIDCALL;
        }

        const level = meta.level ?? 0;
        const texPtr = meta.texturePtr;
        const texture = textureMeta.get(texPtr);
        if (texture?.isCube) {
            if (meta.face === undefined || !Number.isInteger(meta.face) || meta.face < 0 || meta.face > 5
                || level < 0 || level >= texture.levels) return D3DERR_INVALIDCALL;
            return completeCubeFaceLock(
                device,
                texPtr,
                meta.face,
                level,
                texture,
                pLockedRect,
                pRect,
                flags,
                mem,
            );
        }
        const lockKey = `${texPtr}:${level}`;
        if (!texture || level >= texture.levels || activeLockReadOnly.has(lockKey)) {
            Mem.writeUint32(pLockedRect, 0);
            return D3DERR_INVALIDCALL;
        }
        const plan = planTextureLock(
            device, texPtr, level, meta.width, meta.height,
            meta.pool === D3DPOOL_DEFAULT, pRect, flags);
        if (!plan) return D3DERR_INVALIDCALL;

        const finish = (): number => completeTextureLock(
            device, texPtr, level, plan, meta.format, meta.width, meta.height, pRect, pLockedRect, mem);
        // Async ONLY when a GPU round trip is genuinely pending; see planTextureLock.
        const pending: Promise<number> | null = plan.pending ? plan.pending.then(finish) : null;
        return pending ?? finish();
    };

    exports['IDirect3DSurface9_UnlockRect'] = (_ctx, mem, args) => {
        const pSurface = args[0];

        const meta = surfaceMeta.get(pSurface);
        const device = resourceToDevice.get(pSurface);
        if (!meta || !device || !meta.texturePtr) {
            return D3DERR_INVALIDCALL;
        }

        const level = meta.level ?? 0;
        const texture = textureMeta.get(meta.texturePtr);
        if (texture?.isCube) {
            if (meta.face === undefined || !Number.isInteger(meta.face) || meta.face < 0 || meta.face > 5
                || level < 0 || level >= texture.levels) return D3DERR_INVALIDCALL;
            const lockKey = `${meta.texturePtr}:${meta.face}:${level}`;
            if (!activeCubeLocks.has(lockKey)) return D3DERR_INVALIDCALL;
            const unlocked = device.unlockCubeFace(meta.texturePtr, meta.face, level, mem);
            if (unlocked) activeCubeLocks.delete(lockKey);
            return unlocked ? D3D_OK : D3DERR_INVALIDCALL;
        }
        if (!activeLockReadOnly.has(`${meta.texturePtr}:${level}`)) {
            return D3DERR_INVALIDCALL;
        }
        finishTextureUnlock(device, meta.texturePtr, level, mem);
        return D3D_OK;
    };

    exports['IDirect3DSurface9_GetDesc'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const pDesc = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDesc()');

        if (!pDesc) return D3DERR_INVALIDCALL;
        const liveMeta = surfaceMeta.get(pSurface);
        if (!liveMeta) return D3DERR_INVALIDCALL;

        // Fill D3DSURFACE_DESC structure
        if (!writeSurfaceDesc(pDesc, liveMeta)) return D3DERR_INVALIDCALL;

        return D3D_OK;
    };

    exports['IDirect3DSurface9_GetDevice'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const ppDevice = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDevice()');

        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);

        const device = resourceToDevice.get(pSurface);
        if (!device) return D3DERR_INVALIDCALL;

        const devicePtr = resolveDevicePtr(device);
        if (!devicePtr) return D3DERR_INVALIDCALL;

        if (!Mem.writeUint32(ppDevice, devicePtr)) return D3DERR_INVALIDCALL;
        addComRef(devicePtr);
        return D3D_OK;
    };

    /**
     * GetContainer(riid, ppContainer) — the object that OWNS the surface: the parent
     * texture for a mip level / cube face.  Device-created standalone surfaces
     * (CreateDepthStencilSurface, CreateRenderTarget) use the owning device as
     * their container. Real D3D9 answers the swap chain for a backbuffer; we
     * expose no IDirect3DSwapChain9 object, so that IID is the one request we
     * must refuse rather than hand back a differently-shaped interface.
     */
    exports['IDirect3DSurface9_GetContainer'] = (_ctx, mem, args) => {
        const pSurface = args[0] >>> 0;
        const riid = args[1] >>> 0;
        const ppContainer = args[2];
        if (!ppContainer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppContainer);

        // REFIID is a required input.  Treat a null or out-of-range GUID as an
        // invalid call instead of silently accepting it as IUnknown: callers use
        // this distinction to probe container identity and the latter would hand
        // out a pointer with an unverified vtable contract.
        if (!riid) return D3DERR_INVALIDCALL;
        const requested = readD3D9GuidKey(mem, riid);
        if (!requested) return D3DERR_INVALIDCALL;

        const swapChain = getSwapChainForSurface(pSurface);
        const meta = surfaceMeta.get(pSurface);
        // A device-created surface may use a hidden texture for storage, but
        // that implementation detail is not its COM container.
        const texturePtr = meta?.standalone ? 0 : (meta?.texturePtr ?? 0);
        let containerPtr = texturePtr;
        if (!containerPtr && swapChain) {
            containerPtr = swapChain.ptr;
        }
        if (!containerPtr) {
            const device = resourceToDevice.get(pSurface);
            containerPtr = device ? resolveDevicePtr(device) : 0;
        }
        if (!containerPtr) return D3DERR_INVALIDCALL;

        // A surface's container is either its parent texture/cube, its swap
        // chain, or its owning device. Refuse unrelated interface IDs instead
        // of returning a pointer with the wrong vtable shape.
        // The accepted IID set is determined by the actual owner, not merely by
        // the fact that the caller supplied a known D3D9 IID.  In particular, a
        // texture parent must never be returned for an IDirect3DDevice9 request.
        let accepts: ReadonlySet<string>;
        if (swapChain) {
            accepts = new Set([IID_IUNKNOWN, IID_IDIRECT3DSWAPCHAIN9]);
        } else if (texturePtr) {
            const isCube = textureMeta.get(texturePtr)?.isCube === true;
            accepts = new Set([
                IID_IUNKNOWN,
                IID_IDIRECT3DRESOURCE9,
                IID_IDIRECT3DBASETEXTURE9,
                isCube ? IID_IDIRECT3DCUBETEXTURE9 : IID_IDIRECT3DTEXTURE9,
            ]);
        } else {
            accepts = new Set([IID_IUNKNOWN, IID_IDIRECT3DDEVICE9]);
            // CreateDeviceEx upgrades the same COM pointer in place by swapping
            // its vtable.  Only that upgraded object may answer the Ex IID.
            if (requested === IID_IDIRECT3DDEVICE9EX) {
                const exVtable = getVTables()['IDirect3DDevice9Ex']?.address ?? 0;
                const objectVtable = Mem.readUint32(containerPtr) ?? 0;
                if (exVtable && objectVtable === exVtable) accepts = new Set([...accepts, IID_IDIRECT3DDEVICE9EX]);
            }
        }
        if (!accepts.has(requested)) return E_NOINTERFACE;
        if (!Mem.writeUint32(ppContainer, containerPtr)) return D3DERR_INVALIDCALL;
        addComRef(containerPtr);
        return D3D_OK;
    };

    exports['IDirect3DSurface9_GetDC'] = (ctx, mem, args) => {
        const phdc = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDC()');

        // Validated before the DC exists: a bad out-pointer must not leak an overlay DC
        // nobody can release.
        if (!phdc || !isValidAddress(mem, phdc, 4, "rw")) return D3DERR_INVALIDCALL;
        const pSurface = args[0] >>> 0;
        const meta = surfaceMeta.get(pSurface);
        const device = resourceToDevice.get(pSurface);
        // GetDC is gated by FORMAT (GDI must be able to describe the pixels), not by an
        // explicit lockable flag: back buffers and texture-level surfaces carry none, and
        // demanding one refuses the canonical GetBackBuffer()->GetDC() overlay path.
        // The lock rule is LockRect's: only an explicitly non-lockable surface is refused.
        if (!meta || !device || meta.lockable === false || !isGetDCCompatibleFormat(meta.format)) {
            return D3DERR_INVALIDCALL;
        }

        // Overlay should persist between frames and only be cleared on explicit Clear() calls
        // No need to clear overlay automatically here

        // Create a real DC on the overlay canvas for GDI compositing
        const gdiContext = System.getInstance().gdiContext;
        const hdc = gdiContext.createOverlayDC();

        if (hdc === 0) {
            Logger.error(LogCategory.D3D9, 'Surface::GetDC: Failed to create overlay DC');
            return D3DERR_INVALIDCALL;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(phdc, hdc, true);

        Logger.verbose(LogCategory.D3D9, `Surface::GetDC() -> HDC 0x${hdc.toString(16)}`);
        return D3D_OK;
    };

    exports['IDirect3DSurface9_ReleaseDC'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const hdc = args[1];

        Logger.verbose(LogCategory.D3D9, `Surface::ReleaseDC(HDC=0x${hdc.toString(16)})`);

        // Release the DC
        const gdiContext = System.getInstance().gdiContext;
        gdiContext.releaseDC(hdc);

        return D3D_OK;
    };

    return exports;
}
