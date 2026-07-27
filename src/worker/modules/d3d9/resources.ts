/**
 * D3D9 Resource functions
 *
 * Atomic implementation for Direct3D resource operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { devices, getVTables, createComObject, resourceToDevice } from './shared-state';
import {
    textureMeta,
    surfaceMeta,
    vertexBufferMeta,
    indexBufferMeta,
    computeMipLevelCount,
    getTextureLevelDims,
    ensureTextureLevelSurface,
    ensureCubeFaceSurface,
    precreateTextureLevelSurfaces,
    precreateCubeFaceSurfaces,
    clearTextureSubresourceSurfaces,
    type SurfaceMeta,
} from './resource-registry';
import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';
import {
    initReturnPtr,
    D3DFMT_UNKNOWN,
    normalizePalettizedTexturePool,
} from '../../backends/webgpu/shared/dx-com-helpers';
import { isDxExclusiveFormat } from '../../backends/webgpu/shared/dx-format-support';

const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DFMT_A8R8G8B8 = 21;
const D3DRTYPE_UNKNOWN = 0;
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DPOOL_DEFAULT = 0;
const D3DPOOL_SYSTEMMEM = 2;
const D3DMULTISAMPLE_NONE = 0;
const D3DUSAGE_DEPTHSTENCIL = 0x00000002;
const D3DRTYPE_VERTEXBUFFER = 6;
const D3DRTYPE_INDEXBUFFER = 7;
const D3DFMT_VERTEXDATA = 100;

function writeSurfaceDesc(pDesc: number, meta: SurfaceMeta): boolean {
    return (
        Mem.writeUint32(pDesc + 0, meta.format >>> 0) &&
        Mem.writeUint32(pDesc + 4, meta.type >>> 0) &&
        Mem.writeUint32(pDesc + 8, meta.usage >>> 0) &&
        Mem.writeUint32(pDesc + 12, meta.pool >>> 0) &&
        Mem.writeUint32(pDesc + 16, meta.multiSampleType >>> 0) &&
        Mem.writeUint32(pDesc + 20, meta.multiSampleQuality >>> 0) &&
        Mem.writeUint32(pDesc + 24, meta.width >>> 0) &&
        Mem.writeUint32(pDesc + 28, meta.height >>> 0)
    );
}

function resolveDevicePtr(deviceInstance: unknown): number {
    for (const [devicePtr, device] of devices.entries()) {
        if (device === deviceInstance) {
            return devicePtr >>> 0;
        }
    }
    return 0;
}

function computeLockRectOffset(format: number, width: number, height: number, pitch: number, left: number, top: number): number {
    const layout = getD3DTextureLayout(format, width, height);
    if (layout.compressed) {
        return ((top >> 2) * pitch + (left >> 2) * layout.blockBytes) >>> 0;
    }
    const bytesPerPixel = Math.max(1, Math.floor(layout.pitch / Math.max(1, width | 0)));
    return (top * pitch + left * bytesPerPixel) >>> 0;
}

export function createResourcesExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;

    exports['IDirect3DDevice9_CreateVertexBuffer'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Length = args[1];
        const Usage = args[2];
        const FVF = args[3];
        const Pool = args[4];
        const ppVertexBuffer = args[5];

        if (!ppVertexBuffer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppVertexBuffer);

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

        const guestPtr = device.createVertexBuffer(vbPtr, Length, FVF);
        if (guestPtr === 0) {
            initReturnPtr(ppVertexBuffer);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(vbPtr, device);
        vertexBufferMeta.set(vbPtr, {
            size: Length >>> 0,
            usage: Usage >>> 0,
            pool: Pool >>> 0,
            fvf: FVF >>> 0,
        });

        Mem.writeUint32(ppVertexBuffer, vbPtr);

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

        const guestPtr = device.createIndexBuffer(ibPtr, Length, Format);
        if (guestPtr === 0) {
            initReturnPtr(ppIndexBuffer);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(ibPtr, device);
        indexBufferMeta.set(ibPtr, {
            size: Length >>> 0,
            usage: Usage >>> 0,
            pool: Pool >>> 0,
            format: Format >>> 0,
        });

        Mem.writeUint32(ppIndexBuffer, ibPtr);

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

        if (Format === D3DFMT_UNKNOWN || isDxExclusiveFormat(Format, 9)) {
            return D3DERR_INVALIDCALL;
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

        const width = Math.max(1, Width >>> 0);
        const height = Math.max(1, Height >>> 0);
        const levelCount = Levels !== 0 ? (Levels >>> 0) : computeMipLevelCount(width, height);
        const maxLevels = Math.max(1, levelCount);
        const normalizedPool = normalizePalettizedTexturePool(Format, Pool);

        const texPtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateTexture(${Width}x${Height}, Levels=${Levels}, Usage=0x${(Usage>>>0).toString(16)}, Format=${Format}, Pool=${normalizedPool}) -> 0x${texPtr.toString(16)}`);

        const guestPtr = device.createTexture(texPtr, width, height, levelCount, Format, Usage >>> 0);
        if (guestPtr === 0) {
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

        if (!precreateTextureLevelSurfaces(texPtr, maxLevels)) {
            clearTextureSubresourceSurfaces(texPtr);
            resourceToDevice.delete(texPtr);
            textureMeta.delete(texPtr);
            initReturnPtr(ppTexture);
            return D3DERR_INVALIDCALL;
        }

        Mem.writeUint32(ppTexture, texPtr);
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

        if (Format === D3DFMT_UNKNOWN || isDxExclusiveFormat(Format, 9)) {
            return D3DERR_INVALIDCALL;
        }

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

        const edge = Math.max(1, EdgeLength >>> 0);
        const levelCount = Levels !== 0 ? (Levels >>> 0) : computeMipLevelCount(edge, edge);
        const maxLevels = Math.max(1, levelCount);
        const normalizedPool = normalizePalettizedTexturePool(Format, Pool);

        const cubePtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateCubeTexture(edge=${edge}, Levels=${maxLevels}, Usage=0x${(Usage>>>0).toString(16)}, Format=${Format}, Pool=${normalizedPool}) -> 0x${cubePtr.toString(16)}`);

        const guestPtr = device.createCubeTexture(cubePtr, edge, levelCount, Format, Usage >>> 0);
        if (guestPtr === 0) {
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

        if (!precreateCubeFaceSurfaces(cubePtr, maxLevels)) {
            clearTextureSubresourceSurfaces(cubePtr);
            resourceToDevice.delete(cubePtr);
            textureMeta.delete(cubePtr);
            initReturnPtr(ppCubeTexture);
            return D3DERR_INVALIDCALL;
        }

        Mem.writeUint32(ppCubeTexture, cubePtr);
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

        const device = devices.get(pDevice);
        if (!device) {
            return D3DERR_INVALIDCALL;
        }

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
        });

        Logger.log(
            LogCategory.D3D9,
            `CreateDepthStencilSurface(${w}x${h}, Format=${format}, MS=${multiSampleType}) -> 0x${surfacePtr.toString(16)}`,
        );

        return Mem.writeUint32(ppSurface, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // Lockable CPU-side surface backed by a hidden 1-level texture so the existing
    // Surface9 LockRect/UnlockRect/GetDesc paths (which route via meta.texturePtr)
    // work unchanged. Used by games for GetRenderTargetData readback staging.
    exports['IDirect3DDevice9_CreateOffscreenPlainSurface'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const width = Math.max(1, args[1] >>> 0);
        const height = Math.max(1, args[2] >>> 0);
        const format = args[3] >>> 0;
        const pool = args[4] >>> 0;
        const ppSurface = args[5];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);
        if (format === D3DFMT_UNKNOWN || isDxExclusiveFormat(format, 9)) return D3DERR_INVALIDCALL;

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const texVt = vtables['IDirect3DTexture9']?.address;
        const surfVt = vtables['IDirect3DSurface9']?.address;
        if (!texVt || !surfVt) return D3DERR_INVALIDCALL;

        const texPtr = createComObject(texVt);
        const guestPtr = device.createTexture(texPtr, width, height, 1, format, 0);
        if (guestPtr === 0) return D3DERR_INVALIDCALL;
        resourceToDevice.set(texPtr, device);
        textureMeta.set(texPtr, { width, height, levels: 1, usage: 0, pool, format });

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
        });

        Logger.log(LogCategory.D3D9,
            `CreateOffscreenPlainSurface(${width}x${height}, Format=${format}, Pool=${pool}) -> 0x${surfacePtr.toString(16)}`);
        return Mem.writeUint32(ppSurface, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
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
        // Cube faces keep their pixels in a separate per-face store the level accessors below
        // cannot reach; a surface with no parent texture (the implicit backbuffer) has no
        // CPU-side pixels at all.
        if (!src.texturePtr || !dst.texturePtr || src.face !== undefined || dst.face !== undefined) {
            Logger.warn(LogCategory.D3D9,
                `UpdateSurface: unsupported surface pair (src tex=0x${(src.texturePtr ?? 0).toString(16)} face=${src.face ?? -1}, ` +
                `dst tex=0x${(dst.texturePtr ?? 0).toString(16)} face=${dst.face ?? -1})`);
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
        const srcPix = device.getTextureLevelPixels(src.texturePtr, srcLevel);
        const dstPix = device.getTextureLevelPixels(dst.texturePtr, dstLevel);
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
        if (!device.setTextureLevelPixels(dst.texturePtr, dstLevel, dstPix.data, dstPix.pitch)) {
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
        const srcMeta = surfaceMeta.get(pRenderTarget);
        const dstMeta = surfaceMeta.get(pDestSurface);
        if (!device || !srcMeta?.texturePtr || !dstMeta?.texturePtr) return D3DERR_INVALIDCALL;

        return device.readTextureIntoGuestTexture(srcMeta.texturePtr, dstMeta.texturePtr);
    };

    exports['IDirect3DDevice9_CreateQuery'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const _type = args[1];
        const ppQuery = args[2];

        const device = devices.get(pDevice);
        if (!device || !ppQuery) {
            return D3DERR_INVALIDCALL;
        }

        // Query objects are not implemented yet. Report as unavailable instead of thunk-missing.
        Mem.writeUint32(ppQuery, 0);
        return D3DERR_NOTAVAILABLE;
    };

    exports['IDirect3DVertexBuffer9_Lock'] = (ctx, mem, args) => {
        const pVertexBuffer = args[0];
        const OffsetToLock = args[1];
        const SizeToLock = args[2];
        const ppbData = args[3];
        const Flags = args[4];

        const device = resourceToDevice.get(pVertexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Lock: invalid buffer ${pVertexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `VertexBuffer::Lock(Offset=${OffsetToLock}, Size=${SizeToLock})`);

        const dataPtr = device.lockVertexBuffer(pVertexBuffer, OffsetToLock, SizeToLock);
        if (dataPtr === 0) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Lock failed for 0x${pVertexBuffer.toString(16)}`);
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }
        Logger.log(LogCategory.D3D9, `VertexBuffer::Lock -> guest ptr 0x${dataPtr.toString(16)}`);

        if (ppbData) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppbData, dataPtr, true);
        }

        return D3D_OK;
    };

    exports['IDirect3DVertexBuffer9_Unlock'] = (ctx, mem, args) => {
        const pVertexBuffer = args[0];

        const device = resourceToDevice.get(pVertexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Unlock: invalid buffer ${pVertexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'VertexBuffer::Unlock()');
        device.unlockVertexBuffer(pVertexBuffer, mem);
        return D3D_OK;
    };

    exports['IDirect3DIndexBuffer9_Lock'] = (ctx, mem, args) => {
        const pIndexBuffer = args[0];
        const OffsetToLock = args[1];
        const SizeToLock = args[2];
        const ppbData = args[3];
        const Flags = args[4];

        const device = resourceToDevice.get(pIndexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Lock: invalid buffer ${pIndexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `IndexBuffer::Lock(Offset=${OffsetToLock}, Size=${SizeToLock})`);

        const dataPtr = device.lockIndexBuffer(pIndexBuffer, OffsetToLock, SizeToLock);
        if (dataPtr === 0) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Lock failed for 0x${pIndexBuffer.toString(16)}`);
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }
        Logger.log(LogCategory.D3D9, `IndexBuffer::Lock -> guest ptr 0x${dataPtr.toString(16)}`);

        if (ppbData) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppbData, dataPtr, true);
        }

        return D3D_OK;
    };

    exports['IDirect3DIndexBuffer9_Unlock'] = (ctx, mem, args) => {
        const pIndexBuffer = args[0];

        const device = resourceToDevice.get(pIndexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Unlock: invalid buffer ${pIndexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'IndexBuffer::Unlock()');
        device.unlockIndexBuffer(pIndexBuffer, mem);
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

        const lockInfo = device.lockTexture(pTexture, Level);
        if (!lockInfo) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect failed for 0x${pTexture.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        let pBits = lockInfo.ptr >>> 0;
        if (pRect) {
            const meta = textureMeta.get(pTexture);
            const dims = meta
                ? getTextureLevelDims(meta.width, meta.height, Level)
                : { width: 1, height: 1 };
            const format = meta?.format ?? D3DFMT_A8R8G8B8;
            const left = Mem.readInt32(pRect) ?? 0;
            const top = Mem.readInt32(pRect + 4) ?? 0;
            pBits = (pBits + computeLockRectOffset(format, dims.width, dims.height, lockInfo.pitch, left, top)) >>> 0;
        }

        // Fill D3DLOCKED_RECT structure
        const wrotePitch = Mem.writeUint32(pLockedRect, lockInfo.pitch);
        const wroteBits = Mem.writeUint32(pLockedRect + 4, pBits);
        if (!wrotePitch || !wroteBits) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect: failed to write D3DLOCKED_RECT @0x${pLockedRect.toString(16)}`);
            device.unlockTexture(pTexture, Level, mem);
            return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    exports['IDirect3DTexture9_UnlockRect'] = (ctx, mem, args) => {
        const pTexture = args[0];
        const Level = args[1];

        const device = resourceToDevice.get(pTexture);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Texture::UnlockRect: invalid texture ${pTexture}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `Texture::UnlockRect(Level=${Level})`);
        device.unlockTexture(pTexture, Level, mem);
        return D3D_OK;
    };

    exports['IDirect3DTexture9_GetLevelCount'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        return textureMeta.get(pTexture)?.levels ?? 1;
    };

    exports['IDirect3DTexture9_GetType'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        return resourceToDevice.has(pTexture) ? D3DRTYPE_TEXTURE : D3DRTYPE_UNKNOWN;
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

        return Mem.writeUint32(ppSurfaceLevel, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

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

        return Mem.writeUint32(ppSurface, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DCubeTexture9_LockRect'] = (_ctx, mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;
        const pLockedRect = args[3];
        const pRect = args[4];

        const device = resourceToDevice.get(pCube);
        if (!device || !pLockedRect || faceType > 5) {
            return D3DERR_INVALIDCALL;
        }

        const lockInfo = device.lockCubeFace(pCube, faceType, level);
        if (!lockInfo) return D3DERR_INVALIDCALL;

        let pBits = lockInfo.ptr >>> 0;
        if (pRect) {
            const meta = textureMeta.get(pCube);
            const dim = Math.max(1, (meta?.width ?? 1) >>> level);
            const format = meta?.format ?? D3DFMT_A8R8G8B8;
            const left = Mem.readInt32(pRect) ?? 0;
            const top = Mem.readInt32(pRect + 4) ?? 0;
            pBits = (pBits + computeLockRectOffset(format, dim, dim, lockInfo.pitch, left, top)) >>> 0;
        }

        const wrotePitch = Mem.writeUint32(pLockedRect + 0, lockInfo.pitch >>> 0);
        const wroteBits = Mem.writeUint32(pLockedRect + 4, pBits);
        if (!wrotePitch || !wroteBits) {
            device.unlockCubeFace(pCube, faceType, level, mem);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DCubeTexture9_UnlockRect'] = (_ctx, mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;

        const device = resourceToDevice.get(pCube);
        if (!device || faceType > 5) return D3DERR_INVALIDCALL;

        device.unlockCubeFace(pCube, faceType, level, mem);
        return D3D_OK;
    };

    exports['IDirect3DCubeTexture9_GetLevelCount'] = (_ctx, _mem, args) => {
        return textureMeta.get(args[0])?.levels ?? 1;
    };

    exports['IDirect3DCubeTexture9_GetType'] = (_ctx, _mem, args) => {
        const meta = textureMeta.get(args[0]);
        return meta?.isCube ? D3DRTYPE_CUBETEXTURE : D3DRTYPE_UNKNOWN;
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

    exports['IDirect3DCubeTexture9_GetDevice'] = (_ctx, _mem, args) => {
        const pCube = args[0];
        const ppDevice = args[1];
        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);

        const device = resourceToDevice.get(pCube);
        if (!device) return D3DERR_INVALIDCALL;
        const devicePtr = resolveDevicePtr(device);
        if (!devicePtr) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(ppDevice, devicePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DCubeTexture9_AddDirtyRect'] = () => D3D_OK;

    exports['IDirect3DSurface9_LockRect'] = (_ctx, mem, args) => {
        const pSurface = args[0];
        const pLockedRect = args[1];
        const pRect = args[2];
        const _flags = args[3];

        const meta = surfaceMeta.get(pSurface);
        const device = resourceToDevice.get(pSurface);
        if (!meta || !device || !meta.texturePtr || !pLockedRect) {
            return D3DERR_INVALIDCALL;
        }

        const level = meta.level ?? 0;
        const lockInfo = device.lockTexture(meta.texturePtr, level);
        if (!lockInfo) {
            return D3DERR_INVALIDCALL;
        }

        let pBits = lockInfo.ptr >>> 0;
        if (pRect) {
            const left = Mem.readInt32(pRect) ?? 0;
            const top = Mem.readInt32(pRect + 4) ?? 0;
            pBits = (pBits + computeLockRectOffset(meta.format, meta.width, meta.height, lockInfo.pitch, left, top)) >>> 0;
        }

        const wrotePitch = Mem.writeUint32(pLockedRect + 0, lockInfo.pitch >>> 0);
        const wroteBits = Mem.writeUint32(pLockedRect + 4, pBits);
        if (!wrotePitch || !wroteBits) {
            device.unlockTexture(meta.texturePtr, level, mem);
            return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    exports['IDirect3DSurface9_UnlockRect'] = (_ctx, mem, args) => {
        const pSurface = args[0];

        const meta = surfaceMeta.get(pSurface);
        const device = resourceToDevice.get(pSurface);
        if (!meta || !device || !meta.texturePtr) {
            return D3DERR_INVALIDCALL;
        }

        const level = meta.level ?? 0;
        device.unlockTexture(meta.texturePtr, level, mem);
        return D3D_OK;
    };

    exports['IDirect3DSurface9_GetDesc'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const pDesc = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDesc()');

        // Fill D3DSURFACE_DESC structure
        if (pDesc) {
            const meta = surfaceMeta.get(pSurface);
            const ok = writeSurfaceDesc(pDesc, meta ?? {
                format: D3DFMT_A8R8G8B8,
                type: D3DRTYPE_SURFACE,
                usage: 0,
                pool: D3DPOOL_DEFAULT,
                multiSampleType: D3DMULTISAMPLE_NONE,
                multiSampleQuality: 0,
                width: 1024,
                height: 768,
            });
            if (!ok) return D3DERR_INVALIDCALL;
        }

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

        return Mem.writeUint32(ppDevice, devicePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DSurface9_GetDC'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const phdc = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDC()');

        // Overlay should persist between frames and only be cleared on explicit Clear() calls
        // No need to clear overlay automatically here

        // Create a real DC on the overlay canvas for GDI compositing
        const gdiContext = System.getInstance().gdiContext;
        const hdc = gdiContext.createOverlayDC();

        if (hdc === 0) {
            Logger.error(LogCategory.D3D9, 'Surface::GetDC: Failed to create overlay DC');
            return D3DERR_INVALIDCALL;
        }

        if (phdc) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(phdc, hdc, true);
        }

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
