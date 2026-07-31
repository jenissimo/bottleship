/**
 * D3D9 Resource functions
 *
 * Atomic implementation for Direct3D resource operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
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
    computeMipLevelCount,
    getTextureLevelDims,
    ensureTextureLevelSurface,
    ensureCubeFaceSurface,
    precreateTextureLevelSurfaces,
    precreateCubeFaceSurfaces,
    clearTextureSubresourceSurfaces,
    releaseSurfaceMetadata,
    type SurfaceMeta,
} from './resource-registry';
import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';
import {
    initReturnPtr,
    D3DFMT_UNKNOWN,
    normalizePalettizedTexturePool,
} from '../../backends/webgpu/shared/dx-com-helpers';
import { isDxExclusiveFormat, isDxRenderableFormat } from '../../backends/webgpu/shared/dx-format-support';

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
const D3DUSAGE_RENDERTARGET = 0x00000001;
const E_NOINTERFACE = 0x80004002;
/** IID_IDirect3DSwapChain9 {794950F2-ADFC-458A-905E-10A10B0B503B} as raw guest bytes. */
const IID_IDIRECT3DSWAPCHAIN9 = 'f2504979fcad8a45905e10a10b0b503b';

/** Canonical key for a REFGUID argument (16 raw bytes → hex). */
function readGuidKey(mem: Uint8Array, addr: number): string | null {
    if (!addr || addr + 16 > mem.length) return null;
    let key = '';
    for (let i = 0; i < 16; i++) key += mem[addr + i]!.toString(16).padStart(2, '0');
    return key;
}

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

    const registerBufferFinalizer = (ptr: number, devicePtr: number, kind: 'vertex' | 'index'): void => {
        registerDeviceChildFinalizer(ptr, devicePtr, () => {
            const device = resourceToDevice.get(ptr);
            if (kind === 'vertex') {
                device?.releaseVertexBuffer(ptr);
                vertexBufferMeta.delete(ptr);
            } else {
                device?.releaseIndexBuffer(ptr);
                indexBufferMeta.delete(ptr);
            }
            resourceToDevice.delete(ptr);
        });
    };

    const registerTextureFinalizer = (ptr: number, devicePtr: number): void => {
        registerDeviceChildFinalizer(ptr, devicePtr, () => {
            const device = resourceToDevice.get(ptr);
            clearTextureSubresourceSurfaces(ptr);
            device?.releaseTexture(ptr);
            textureMeta.delete(ptr);
            resourceToDevice.delete(ptr);
        });
    };

    const registerStandaloneSurfaceFinalizer = (ptr: number, devicePtr: number): void => {
        registerDeviceChildFinalizer(ptr, devicePtr, () => releaseSurfaceMetadata(ptr));
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
        });
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
        });
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
        if (guestPtr === 0) {
            releaseComRef(texPtr);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(texPtr, device);
        textureMeta.set(texPtr, { width, height, levels: 1, usage: 0, pool, format });
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
        const width = Math.max(1, args[1] >>> 0);
        const height = Math.max(1, args[2] >>> 0);
        const format = args[3] >>> 0;
        const multiSampleType = args[4] >>> 0;
        const multiSampleQuality = args[5] >>> 0;
        const ppSurface = args[7];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);
        if (format === D3DFMT_UNKNOWN || isDxExclusiveFormat(format, 9)) return D3DERR_INVALIDCALL;
        if (!isDxRenderableFormat(format, 9)) return D3DERR_NOTAVAILABLE;

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const texVt = vtables['IDirect3DTexture9']?.address;
        const surfVt = vtables['IDirect3DSurface9']?.address;
        if (!texVt || !surfVt) return D3DERR_INVALIDCALL;

        const texPtr = createComObject(texVt);
        if (device.createTexture(texPtr, width, height, 1, format, D3DUSAGE_RENDERTARGET) === 0) {
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

        if (!Mem.writeUint32(ppSurfaceLevel, surfacePtr)) return D3DERR_INVALIDCALL;
        addComRef(pTexture);
        return D3D_OK;
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

        const src = textureMeta.get(pSrc);
        const dst = textureMeta.get(pDst);
        if (!src || !dst) return D3DERR_INVALIDCALL;
        if (src.format !== dst.format) return D3DERR_INVALIDCALL;
        // Real D3D9: source must be SYSTEMMEM, destination must not be.
        if (src.pool !== D3DPOOL_SYSTEMMEM || dst.pool === D3DPOOL_SYSTEMMEM) return D3DERR_INVALIDCALL;
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

        let copied = 0;
        for (let i = levels - 1; i >= 0; i--) {
            const px = device.getTextureLevelPixels(pSrc, srcBase + i);
            if (!px) continue;
            if (device.setTextureLevelPixels(pDst, i, px.data, px.pitch)) copied++;
        }
        if (copied === 0) return D3DERR_INVALIDCALL;

        Logger.verbose(LogCategory.D3D9,
            `UpdateTexture(0x${pSrc.toString(16)} -> 0x${pDst.toString(16)}): ${copied}/${levels} levels ` +
            `from src level ${srcBase}`);
        return D3D_OK;
    };

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
    exports['IDirect3DVolumeTexture9_GetDevice'] = resourceGetDevice;
    exports['IDirect3DVertexBuffer9_GetDevice'] = resourceGetDevice;
    exports['IDirect3DIndexBuffer9_GetDevice'] = resourceGetDevice;

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

        if (!Mem.writeUint32(ppDevice, devicePtr)) return D3DERR_INVALIDCALL;
        addComRef(devicePtr);
        return D3D_OK;
    };

    /**
     * GetContainer(riid, ppContainer) — the object that OWNS the surface: the parent
     * texture for a mip level / cube face, and the DEVICE for a standalone surface
     * (CreateDepthStencilSurface, CreateRenderTarget). Real D3D9 answers the swap chain
     * for a backbuffer; we expose no IDirect3DSwapChain9 object, so that IID is the one
     * request we must refuse rather than hand back a differently-shaped interface.
     */
    exports['IDirect3DSurface9_GetContainer'] = (_ctx, mem, args) => {
        const pSurface = args[0] >>> 0;
        const riid = args[1] >>> 0;
        const ppContainer = args[2];
        if (!ppContainer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppContainer);

        if (riid && readGuidKey(mem, riid) === IID_IDIRECT3DSWAPCHAIN9) return E_NOINTERFACE;

        const texturePtr = surfaceMeta.get(pSurface)?.texturePtr ?? 0;
        let containerPtr = texturePtr;
        if (!containerPtr) {
            const device = resourceToDevice.get(pSurface);
            containerPtr = device ? resolveDevicePtr(device) : 0;
        }
        if (!containerPtr) return D3DERR_INVALIDCALL;
        if (!Mem.writeUint32(ppContainer, containerPtr)) return D3DERR_INVALIDCALL;
        addComRef(containerPtr);
        return D3D_OK;
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
