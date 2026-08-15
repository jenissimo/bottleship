/**
 * D3D8 Resource methods - CreateTexture/VB/IB, Lock/Unlock, LockRect/UnlockRect
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import {
    addComRef,
    clearRenderTargetOverrideForSurface,
    clearTextureLevelSurfaces,
    devices,
    forgetComObject,
    getVTables,
    createComObject,
    releaseComRef,
    resourceToDevice,
    resolveLockSurface,
    surfaceInfo,
    textureD3DFormat,
    textureLevelSurfaces,
    textureMeta,
    deviceBoundDepthStencil,
} from './shared-state';
import { D3D8DeviceAdapter } from '../../backends/webgpu/d3d8/d3d8-device-adapter';
import { createRenderTarget, createTextureSurface, d3dFormatToSurfaceFormat } from '../../backends/webgpu/shared/surface-factory';
import {
    isD3D8DepthStencilFormat,
    isD3D8ExclusiveFormat,
    isD3D8RenderTargetFormat,
} from './format-support';
import {
    decodeD3DTextureToRgba8,
    getD3DTextureLayout,
} from '../../backends/webgpu/shared/texture-formats';
import type { BitmapTextureSurface, DirectDrawSurfaceState, RenderSurface } from '../../modules/ddraw/com-objects';
import { isBitmapTexture, isRenderSurface } from '../../modules/ddraw/com-objects';
import { surfaceSyncManager } from '../ddraw/surface-sync';

import {
    D3DFMT_UNKNOWN,
    initReturnPtr,
    normalizePalettizedTexturePool,
} from '../../backends/webgpu/shared/dx-com-helpers';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

const D3DERR_OUTOFVIDEOMEMORY = 0x8876017c;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_VERTEXDATA = 100;
const D3DRTYPE_UNKNOWN = 0;
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VERTEXBUFFER = 6;
const D3DRTYPE_INDEXBUFFER = 7;
const D3DPOOL_DEFAULT = 0;
const D3DMULTISAMPLE_NONE = 0;
// MultiSample types our WebGPU backend can resolve (MsaaColorManager/DepthManager: 2× and 4×).
// A guest RT/DS created with one of these is accepted; the effective device-global sample count
// is driven by the present-params MultiSampleType (see D3D8DeviceAdapter.reset / CreateDevice)
// folded with quality.msaa. Others (3/5/6/7/8/16) remain rejected, matching CheckDeviceMultiSampleType.
const isSupportedD3D8MultiSample = (t: number): boolean =>
    t === D3DMULTISAMPLE_NONE || t === 2 || t === 4;
const D3DLOCK_DISCARD = 0x00002000;
const D3DLOCK_READONLY = 0x00000010;
const D3DUSAGE_RENDERTARGET = 0x00000001;

export function validateLockRange(totalSize: number, offset: number, requestedSize: number): number | null {
    if (offset < 0 || offset > totalSize) return null;
    const lockSize = requestedSize === 0 ? (totalSize - offset) : requestedSize;
    if (lockSize < 0 || lockSize > totalSize - offset) return null;
    return lockSize;
}

type RectI = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};

function bytesPerPixelFromBpp(bpp: number): number {
    return Math.max(1, Math.floor(bpp / 8));
}

function computeMipLevelCount(width: number, height: number): number {
    const maxDim = Math.max(1, width >>> 0, height >>> 0);
    return Math.floor(Math.log2(maxDim)) + 1;
}

function getTextureLevelDims(width: number, height: number, level: number): { width: number; height: number } {
    const levelShift = Math.max(0, level | 0);
    return {
        width: Math.max(1, (width >>> levelShift) >>> 0),
        height: Math.max(1, (height >>> levelShift) >>> 0),
    };
}

function writeSurfaceDesc(
    mem: Uint8Array,
    pDesc: number,
    format: number,
    width: number,
    height: number,
    bytesPerPixel: number,
    usage: number = 0,
    pool: number = D3DPOOL_DEFAULT
): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(pDesc + 0, format >>> 0, true);                  // Format
    view.setUint32(pDesc + 4, D3DRTYPE_SURFACE, true);              // Type
    view.setUint32(pDesc + 8, usage >>> 0, true);                   // Usage
    view.setUint32(pDesc + 12, pool >>> 0, true);                   // Pool
    view.setUint32(pDesc + 16, (width * height * bytesPerPixel) >>> 0, true); // Size
    view.setUint32(pDesc + 20, D3DMULTISAMPLE_NONE, true);          // MultiSampleType
    view.setUint32(pDesc + 24, width >>> 0, true);                  // Width
    view.setUint32(pDesc + 28, height >>> 0, true);                 // Height
}

function writeVertexBufferDesc(
    pDesc: number,
    size: number,
    fvf: number,
    usage: number,
    pool: number
): boolean {
    return (
        Mem.writeUint32(pDesc + 0, D3DFMT_VERTEXDATA) &&
        Mem.writeUint32(pDesc + 4, D3DRTYPE_VERTEXBUFFER) &&
        Mem.writeUint32(pDesc + 8, usage >>> 0) &&
        Mem.writeUint32(pDesc + 12, pool >>> 0) &&
        Mem.writeUint32(pDesc + 16, size >>> 0) &&
        Mem.writeUint32(pDesc + 20, fvf >>> 0)
    );
}

function writeIndexBufferDesc(
    pDesc: number,
    size: number,
    format: number,
    usage: number,
    pool: number
): boolean {
    return (
        Mem.writeUint32(pDesc + 0, format >>> 0) &&
        Mem.writeUint32(pDesc + 4, D3DRTYPE_INDEXBUFFER) &&
        Mem.writeUint32(pDesc + 8, usage >>> 0) &&
        Mem.writeUint32(pDesc + 12, pool >>> 0) &&
        Mem.writeUint32(pDesc + 16, size >>> 0)
    );
}

function readRect(mem: Uint8Array, addr: number): RectI {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        left: view.getInt32(addr, true),
        top: view.getInt32(addr + 4, true),
        right: view.getInt32(addr + 8, true),
        bottom: view.getInt32(addr + 12, true),
    };
}

function clampRectToSurface(rect: RectI, width: number, height: number): RectI {
    const left = Math.max(0, Math.min(width, rect.left));
    const top = Math.max(0, Math.min(height, rect.top));
    const right = Math.max(left, Math.min(width, rect.right));
    const bottom = Math.max(top, Math.min(height, rect.bottom));
    return { left, top, right, bottom };
}

function syncBitmapSurfaceFromGuest(surface: BitmapTextureSurface): void {
    surface.gpuNeedsUpload = true;
    // The pixels changed — see BitmapTextureSurface.contentVersion. Bump BEFORE any
    // early return below: a caller that skips the decode still rewrote guest memory,
    // and a batch that keeps accumulating past that renders with the wrong upload.
    surface.contentVersion = (surface.contentVersion ?? 0) + 1;

    const process = System.getInstance().process;
    if (!process || !surface.surfacePtr) return;

    const guestMem = process.getCurrentMemory();

    // DXT/BC textures: the guest wrote compressed 4×4 blocks (declared as 32bpp by
    // the surface-format fallback). Decode them to RGBA via the shared dxt decoder —
    // reading the blocks as raw ARGB pixels produces horizontal/vertical stripes.
    const d3dFormat = surface.d3dFormat ?? surface.dxtFormat ?? D3DFMT_X8R8G8B8;
    const layout = getD3DTextureLayout(d3dFormat, surface.width, surface.height);
    const pitch = surface.pitch || layout.pitch;
    const rows = layout.compressed ? layout.rows : surface.height;
    const srcBytes = pitch * rows;
    const start = surface.surfacePtr;
    if (start + srcBytes > guestMem.length) return;

    const pixelSize = surface.width * surface.height * 4;

    if (surface.rgbaScratch.length !== pixelSize) {
        surface.rgbaScratch = new Uint8Array(pixelSize);
    }

    decodeD3DTextureToRgba8(guestMem, start, surface.width, surface.height, d3dFormat, {
        pitch,
        out: surface.rgbaScratch,
        surfaceFormat: surface.format,
        // P8/A8P8 textures decode against the device's current texture palette
        // (stamped onto the surface by the draw-time palette bake). Undefined on the
        // first upload before any SetCurrentTexturePalette → re-decoded at draw time.
        palette: surface.palette,
    });
}

function ensureRenderSurfaceGuestMemory(surface: RenderSurface): boolean {
    const process = System.getInstance().process;
    if (!process) return false;
    if (surface.surfacePtr > 0) return true;

    const bytesPerPixel = Math.max(1, Math.floor(surface.format.bpp / 8));
    const pitch = Math.max(surface.pitch, surface.width * bytesPerPixel);
    try {
        surface.surfacePtr = process.memory.alloc(pitch * surface.height);
        surface.pitch = pitch;
        return true;
    } catch {
        return false;
    }
}

function writeLockedRect(mem: Uint8Array, pLockedRect: number, pitch: number, pBits: number): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setInt32(pLockedRect + 0, pitch, true);
    view.setUint32(pLockedRect + 4, pBits >>> 0, true);
}

function lockRectOffsetBits(
    surface: DirectDrawSurfaceState,
    d3dFormat: number,
    basePtr: number,
    pRect: number,
    mem: Uint8Array,
): { pBits: number; pitch: number } | null {
    const layout = getD3DTextureLayout(d3dFormat, surface.width, surface.height);
    const bytesPerPixel = isRenderSurface(surface)
        ? Math.max(1, Math.floor(surface.format.bpp / 8))
        : Math.max(1, Math.floor(layout.pitch / Math.max(1, surface.width)));
    const pitch = surface.pitch || layout.pitch;
    let pBits = basePtr;

    if (pRect) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left = view.getInt32(pRect, true);
        const top = view.getInt32(pRect + 4, true);
        pBits += layout.compressed
            ? ((top >> 2) * pitch + (left >> 2) * layout.blockBytes)
            : (top * pitch + left * bytesPerPixel);
    }

    return { pBits: pBits >>> 0, pitch };
}

function lockRenderSurfaceRect(
    surface: RenderSurface,
    adapter: D3D8DeviceAdapter,
    pLockedRect: number,
    pRect: number,
    flags: number,
    mem: Uint8Array,
    d3dFormat: number,
): number | Promise<number> {
    const isDiscard = (flags & D3DLOCK_DISCARD) !== 0;
    // Tracks the lock Unlock will answer for. `undefined` means "no lock is outstanding",
    // so an Unlock that never had a Lock (or one whose Lock failed before this point)
    // takes the write path — the conservative one. A second, WRITABLE lock of the same
    // surface (D3D8 permits it for disjoint rects) latches false and keeps it: a read-only
    // Unlock arriving after a write lock must never suppress the write's CPU-dirty mark.
    if ((flags & D3DLOCK_READONLY) !== 0) surface.lastLockReadOnly ??= true;
    else surface.lastLockReadOnly = false;
    if (!ensureRenderSurfaceGuestMemory(surface)) return D3DERR_INVALIDCALL;

    const finish = (): number => {
        const offset = lockRectOffsetBits(surface, d3dFormat, surface.surfacePtr, pRect, mem);
        if (!offset) return D3DERR_INVALIDCALL;
        writeLockedRect(mem, pLockedRect, offset.pitch, offset.pBits);
        surface.everLocked = true;
        return D3D_OK;
    };

    if (isDiscard) {
        const rowBytes = Math.min(
            surface.width * Math.max(1, Math.floor(surface.format.bpp / 8)),
            surface.pitch,
        );
        for (let row = 0; row < surface.height; row++) {
            const rowStart = surface.surfacePtr + row * surface.pitch;
            mem.fill(0, rowStart, rowStart + rowBytes);
        }
        return finish();
    }

    if (surfaceSyncManager.syncToCPUFromScratch(surface, mem)) {
        return finish();
    }

    if (!surfaceSyncManager.needsCPUSync(surface).needed) {
        return finish();
    }

    return adapter.renderer.syncSurfaceToMemory(surface).then(() => finish());
}

/** Stable IDirect3DSurface8 per (texture, level); mirrors Wine pre-create + DXVK cache.
 *  A RENDERTARGET texture's level 0 is its RenderSurface; mips > 0 stay CPU bitmaps
 *  (only level 0 is renderable in this implementation). */
function ensureTextureLevelSurface(
    pTex: number,
    level: number,
    device: D3D8DeviceAdapter,
    parent: DirectDrawSurfaceState,
): number | null {
    let levelMap = textureLevelSurfaces.get(pTex);
    if (!levelMap) {
        levelMap = new Map();
        textureLevelSurfaces.set(pTex, levelMap);
    }
    const cached = levelMap.get(level);
    if (cached !== undefined) return cached;

    const vtableAddr = getVTables()['IDirect3DSurface8']?.address;
    if (!vtableAddr) return null;

    const process = System.getInstance().process;
    if (!process) return null;

    const d3dFmt = textureD3DFormat.get(pTex) ?? D3DFMT_X8R8G8B8;
    const meta = textureMeta.get(pTex);

    let levelSurface: DirectDrawSurfaceState;
    if (level === 0) {
        levelSurface = parent;
    } else {
        const dims = meta
            ? getTextureLevelDims(meta.width, meta.height, level)
            : getTextureLevelDims(parent.width, parent.height, level);
        try {
            levelSurface = createTextureSurface(dims.width, dims.height, d3dFmt);
            levelSurface.surfacePtr = process.memory.alloc(
                getD3DTextureLayout(d3dFmt, dims.width, dims.height).bytes,
            );
        } catch {
            return null;
        }
    }

    const surfPtr = createComObject(vtableAddr);
    resourceToDevice.set(surfPtr, device);
    surfaceInfo.set(surfPtr, {
        texturePtr: pTex,
        level,
        surface: levelSurface,
        d3dFormat: d3dFmt,
    });
    levelMap.set(level, surfPtr);
    return surfPtr;
}

export function createResourcesExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const releaseTextureStorage = (pTex: number): void => {
        clearTextureLevelSurfaces(pTex);

        const device = resourceToDevice.get(pTex);
        if (device) {
            const texSurface = device.texSurfaces.get(pTex);
            if (texSurface) {
                for (let i = 0; i < device.textures.length; i++) {
                    if (device.textures[i] === texSurface) {
                        device.textures[i] = null;
                    }
                }
            }
            device.texSurfaces.delete(pTex);
            device.invalidateTextureComPtr(pTex);
        }

        resourceToDevice.delete(pTex);
        textureD3DFormat.delete(pTex);
        textureMeta.delete(pTex);
    };

    // ---------------------------------------------------------------
    // CreateTexture (D3D8: 8 args - no pSharedHandle)
    // ---------------------------------------------------------------
    exports['IDirect3DDevice8_CreateTexture'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const Width = args[1];
        const Height = args[2];
        const Levels = args[3];
        const Usage = args[4];
        const Format = args[5] >>> 0;
        let Pool = args[6] >>> 0;
        const ppTexture = args[7];

        if (!ppTexture) return D3DERR_INVALIDCALL;
        initReturnPtr(ppTexture);

        // Wine/DXVK: D3DFMT_UNKNOWN is rejected before touching *ppTexture.
        if (Format === D3DFMT_UNKNOWN || isD3D8ExclusiveFormat(Format)) {
            return D3DERR_INVALIDCALL;
        }

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DTexture8']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;

        // DXVK placeP8InScratch: P8 uploads go through SCRATCH pool on real drivers.
        Pool = normalizePalettizedTexturePool(Format, Pool);

        const width = Math.max(1, Width >>> 0);
        const height = Math.max(1, Height >>> 0);
        const levelCount = Levels !== 0 ? (Levels >>> 0) : computeMipLevelCount(width, height);

        // D3DUSAGE_RENDERTARGET textures live GPU-side: the level-0 surface is a
        // GPU_ONLY RenderSurface so SetRenderTarget can attach it and a later
        // SetTexture samples the rendered pixels directly (no CPU round-trip).
        const isRenderTargetUsage = (Usage & D3DUSAGE_RENDERTARGET) !== 0;
        let surface: DirectDrawSurfaceState;
        if (isRenderTargetUsage) {
            surface = createRenderTarget(width, height, Format);
        } else {
            const bmp = createTextureSurface(width, height, Format);
            try {
                bmp.surfacePtr = process.memory.alloc(getD3DTextureLayout(Format, width, height).bytes);
            } catch {
                return D3DERR_OUTOFVIDEOMEMORY;
            }
            surface = bmp;
        }

        const texPtr = createComObject(vtableAddr);
        device.texSurfaces.set(texPtr, surface);
        resourceToDevice.set(texPtr, device);
        textureD3DFormat.set(texPtr, Format);
        textureMeta.set(texPtr, {
            width,
            height,
            levels: Math.max(1, levelCount),
            usage: Usage >>> 0,
            pool: Pool,
            format: Format,
        });

        // Wine: pre-create stable surface COM wrappers for every mip level.
        for (let level = 0; level < Math.max(1, levelCount); level++) {
            if (!ensureTextureLevelSurface(texPtr, level, device, surface)) {
                clearTextureLevelSurfaces(texPtr);
                device.texSurfaces.delete(texPtr);
                resourceToDevice.delete(texPtr);
                textureD3DFormat.delete(texPtr);
                textureMeta.delete(texPtr);
                forgetComObject(texPtr);
                initReturnPtr(ppTexture);
                return D3DERR_OUTOFVIDEOMEMORY;
            }
        }

        Mem.writeUint32(ppTexture, texPtr);

        const FMT_NAMES: Record<number, string> = {
            0: 'UNKNOWN', 20: 'R8G8B8', 21: 'A8R8G8B8', 22: 'X8R8G8B8',
            23: 'R5G6B5', 24: 'X1R5G5B5', 25: 'A1R5G5B5', 26: 'A4R4G4B4',
            28: 'A8', 41: 'P8', 50: 'L8', 51: 'A8L8',
            0x31545844: 'DXT1', 0x33545844: 'DXT3', 0x35545844: 'DXT5',
        };
        const fmtName = FMT_NAMES[Format] ?? `0x${Format.toString(16)}`;
        Logger.log(LogCategory.SYSTEM, `D3D8 CreateTexture(${Width}x${Height}, fmt=${fmtName}(${Format}), levels=${Levels}, usage=0x${Usage.toString(16)}, pool=${Pool}) -> 0x${texPtr.toString(16)} bpp=${surface.format.bpp} aMask=0x${(surface.format.aMask >>> 0).toString(16)}`);
        return D3D_OK;
    };

    // ---------------------------------------------------------------
    // CreateVertexBuffer (D3D8: 6 args - no pSharedHandle)
    // ---------------------------------------------------------------
    exports['IDirect3DDevice8_CreateVertexBuffer'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const Length = args[1];
        const Usage = args[2];
        const FVF = args[3];
        const Pool = args[4];
        const ppVB = args[5];

        if (!ppVB) return D3DERR_INVALIDCALL;
        initReturnPtr(ppVB);

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        // See CreateIndexBuffer: guard before alloc (alloc throws on 0, never returns 0).
        if (Length <= 0 || Length > 0x10000000) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DVertexBuffer8']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;

        let guestPtr: number;
        try {
            guestPtr = process.memory.alloc(Length);
        } catch {
            return D3DERR_OUTOFVIDEOMEMORY;
        }
        if (!guestPtr) return D3DERR_OUTOFVIDEOMEMORY;

        const vbPtr = createComObject(vtableAddr);
        device.vbData.set(vbPtr, {
            guestPtr,
            size: Length,
            fvf: FVF >>> 0,
            usage: Usage >>> 0,
            pool: Pool >>> 0,
        });
        resourceToDevice.set(vbPtr, device);

        Mem.writeUint32(ppVB, vbPtr);

        Logger.log(LogCategory.SYSTEM, `D3D8 CreateVertexBuffer(${Length}, FVF=0x${FVF.toString(16)}) -> 0x${vbPtr.toString(16)}`);
        return D3D_OK;
    };

    // ---------------------------------------------------------------
    // CreateIndexBuffer (D3D8: 6 args - no pSharedHandle)
    // ---------------------------------------------------------------
    exports['IDirect3DDevice8_CreateIndexBuffer'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const Length = args[1];
        const Usage = args[2];
        const Format = args[3];
        const Pool = args[4];
        const ppIB = args[5];

        if (!ppIB) return D3DERR_INVALIDCALL;
        initReturnPtr(ppIB);

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        // Real D3D8 rejects a zero/oversized buffer with D3DERR_INVALIDCALL. Without
        // this guard process.memory.alloc(0) THROWS (alloc never returns 0), taking the
        // whole thunk dispatch down instead of failing the call faithfully.
        if (Length <= 0 || Length > 0x10000000) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DIndexBuffer8']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;

        let guestPtr: number;
        try {
            guestPtr = process.memory.alloc(Length);
        } catch {
            return D3DERR_OUTOFVIDEOMEMORY;
        }
        if (!guestPtr) return D3DERR_OUTOFVIDEOMEMORY;

        const ibPtr = createComObject(vtableAddr);
        device.ibData.set(ibPtr, {
            guestPtr,
            size: Length,
            format: Format >>> 0,
            usage: Usage >>> 0,
            pool: Pool >>> 0,
        });
        resourceToDevice.set(ibPtr, device);

        Mem.writeUint32(ppIB, ibPtr);

        Logger.log(LogCategory.SYSTEM, `D3D8 CreateIndexBuffer(${Length}, fmt=${Format}) -> 0x${ibPtr.toString(16)}`);
        return D3D_OK;
    };

    // ---------------------------------------------------------------
    // VB Lock/Unlock
    // ---------------------------------------------------------------
    exports['IDirect3DVertexBuffer8_Lock'] = (_ctx, mem, args) => {
        const pVB = args[0];
        const Offset = args[1];
        const Size = args[2];
        const ppData = args[3];
        // const Flags = args[4];

        const device = resourceToDevice.get(pVB);
        if (!device || !ppData) return D3DERR_INVALIDCALL;

        const vb = device.vbData.get(pVB);
        if (!vb) return D3DERR_INVALIDCALL;
        if (validateLockRange(vb.size, Offset, Size) === null) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 VB Lock: out-of-range lock offset=${Offset} size=${Size} vbSize=${vb.size}`);
            return D3DERR_INVALIDCALL;
        }

        if (!Mem.writeUint32(ppData, vb.guestPtr + Offset)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DVertexBuffer8_Unlock'] = () => D3D_OK;
    exports['IDirect3DVertexBuffer8_GetType'] = (_ctx, _mem, args) => {
        return resourceToDevice.has(args[0]) ? D3DRTYPE_VERTEXBUFFER : D3DRTYPE_UNKNOWN;
    };
    exports['IDirect3DVertexBuffer8_PreLoad'] = () => D3D_OK;
    exports['IDirect3DVertexBuffer8_GetDesc'] = (_ctx, _mem, args) => {
        const pVB = args[0];
        const pDesc = args[1];
        if (!pDesc) return D3DERR_INVALIDCALL;

        const device = resourceToDevice.get(pVB);
        const vb = device?.vbData.get(pVB);
        if (!vb) return D3DERR_INVALIDCALL;

        return writeVertexBufferDesc(pDesc, vb.size, vb.fvf, vb.usage, vb.pool)
            ? D3D_OK
            : D3DERR_INVALIDCALL;
    };

    // ---------------------------------------------------------------
    // IB Lock/Unlock
    // ---------------------------------------------------------------
    exports['IDirect3DIndexBuffer8_Lock'] = (_ctx, mem, args) => {
        const pIB = args[0];
        const Offset = args[1];
        const Size = args[2];
        const ppData = args[3];

        const device = resourceToDevice.get(pIB);
        if (!device || !ppData) return D3DERR_INVALIDCALL;

        const ib = device.ibData.get(pIB);
        if (!ib) return D3DERR_INVALIDCALL;
        if (validateLockRange(ib.size, Offset, Size) === null) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 IB Lock: out-of-range lock offset=${Offset} size=${Size} ibSize=${ib.size}`);
            return D3DERR_INVALIDCALL;
        }

        if (!Mem.writeUint32(ppData, ib.guestPtr + Offset)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DIndexBuffer8_Unlock'] = () => D3D_OK;
    exports['IDirect3DIndexBuffer8_GetType'] = (_ctx, _mem, args) => {
        return resourceToDevice.has(args[0]) ? D3DRTYPE_INDEXBUFFER : D3DRTYPE_UNKNOWN;
    };
    exports['IDirect3DIndexBuffer8_PreLoad'] = () => D3D_OK;
    exports['IDirect3DIndexBuffer8_GetDesc'] = (_ctx, _mem, args) => {
        const pIB = args[0];
        const pDesc = args[1];
        if (!pDesc) return D3DERR_INVALIDCALL;

        const device = resourceToDevice.get(pIB);
        const ib = device?.ibData.get(pIB);
        if (!ib) return D3DERR_INVALIDCALL;

        return writeIndexBufferDesc(pDesc, ib.size, ib.format, ib.usage, ib.pool)
            ? D3D_OK
            : D3DERR_INVALIDCALL;
    };

    // ---------------------------------------------------------------
    // Texture LockRect/UnlockRect
    // ---------------------------------------------------------------

    // Scratch buffers for mip levels > 0 to prevent overwriting level 0 data.
    // Key: `${pTex}_${level}` → guest memory pointer
    const mipScratchBuffers = new Map<string, { ptr: number; pitch: number }>();

    exports['IDirect3DTexture8_LockRect'] = (ctx, mem, args) => {
        const pTex = args[0];
        const Level = args[1] >>> 0;
        const pLockedRect = args[2]; // D3DLOCKED_RECT*
        const pRect = args[3];
        const Flags = args[4];

        const device = resourceToDevice.get(pTex);
        if (!device || !pLockedRect) return D3DERR_INVALIDCALL;

        const parent = device.texSurfaces.get(pTex);
        if (!parent) return D3DERR_INVALIDCALL;

        const meta = textureMeta.get(pTex);
        const maxLevels = meta?.levels ?? computeMipLevelCount(parent.width, parent.height);
        if (Level >= maxLevels) return D3DERR_INVALIDCALL;

        const surfPtr = ensureTextureLevelSurface(pTex, Level, device, parent);
        if (!surfPtr) return D3DERR_INVALIDCALL;

        return exports['IDirect3DSurface8_LockRect'](ctx, mem, [surfPtr, pLockedRect, pRect, Flags]);
    };

    exports['IDirect3DTexture8_UnlockRect'] = (ctx, mem, args) => {
        const pTex = args[0];
        const Level = args[1] >>> 0;

        const device = resourceToDevice.get(pTex);
        if (!device) return D3DERR_INVALIDCALL;

        const parent = device.texSurfaces.get(pTex);
        if (!parent) return D3DERR_INVALIDCALL;

        const surfPtr = ensureTextureLevelSurface(pTex, Level, device, parent);
        if (!surfPtr) return D3DERR_INVALIDCALL;

        return exports['IDirect3DSurface8_UnlockRect'](ctx, mem, [surfPtr]);
    };
    exports['IDirect3DTexture8_GetType'] = (_ctx, _mem, args) => {
        return resourceToDevice.has(args[0]) ? D3DRTYPE_TEXTURE : D3DRTYPE_UNKNOWN;
    };
    // PreLoad (void): managed-texture VRAM residency hint. DXVK forwards to the D3D9
    // managed resource, which primes the driver's VRAM copy. Our direct-pointer model
    // keeps pixels in guest memory and uploads lazily on draw, so there is nothing to
    // stage — a faithful no-op. (Same for the VB/IB variants below.)
    exports['IDirect3DTexture8_PreLoad'] = () => D3D_OK;

    exports['IDirect3DTexture8_GetLevelCount'] = (_ctx, _mem, args) => {
        const pTex = args[0];
        const meta = textureMeta.get(pTex);
        if (meta) return meta.levels >>> 0;

        const device = resourceToDevice.get(pTex);
        const parent = device?.texSurfaces.get(pTex);
        if (!parent || (parent.surfaceType !== 'bitmap_texture' && parent.surfaceType !== 'render_surface')) return 1;
        return computeMipLevelCount(parent.width, parent.height) >>> 0;
    };

    exports['IDirect3DTexture8_GetLevelDesc'] = (_ctx, mem, args) => {
        const pTex = args[0];
        const level = args[1] >>> 0;
        const pDesc = args[2];
        if (!pDesc) return D3DERR_INVALIDCALL;

        const meta = textureMeta.get(pTex);
        if (!meta || level >= meta.levels) return D3DERR_INVALIDCALL;

        const dims = getTextureLevelDims(meta.width, meta.height, level);
        const bytesPerPixel = bytesPerPixelFromBpp(d3dFormatToSurfaceFormat(meta.format).bpp);
        writeSurfaceDesc(
            mem,
            pDesc,
            meta.format,
            dims.width,
            dims.height,
            bytesPerPixel,
            meta.usage,
            meta.pool
        );
        return D3D_OK;
    };
    exports['IDirect3DTexture8_GetSurfaceLevel'] = (_ctx, mem, args) => {
        const pTex = args[0];
        const Level = args[1] >>> 0;
        const ppSurface = args[2];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);

        const device = resourceToDevice.get(pTex);
        if (!device) return D3DERR_INVALIDCALL;

        const parent = device.texSurfaces.get(pTex);
        if (!parent || (parent.surfaceType !== 'bitmap_texture' && parent.surfaceType !== 'render_surface')) return D3DERR_INVALIDCALL;

        const meta = textureMeta.get(pTex);
        const maxLevels = meta?.levels ?? computeMipLevelCount(parent.width, parent.height);
        if (Level >= maxLevels) return D3DERR_INVALIDCALL;

        const surfPtr = ensureTextureLevelSurface(pTex, Level, device, parent);
        if (!surfPtr) return D3DERR_INVALIDCALL;

        // Wine: IDirect3DSurface8_AddRef on a texture sub-level forwards to the texture.
        if (addComRef(pTex) === undefined) return D3DERR_INVALIDCALL;

        Mem.writeUint32(ppSurface, surfPtr);
        return D3D_OK;
    };

    exports['IDirect3DTexture8_AddDirtyRect'] = () => D3D_OK;

    exports['IDirect3DSurface8_GetDesc'] = (_ctx, mem, args) => {
        const pSurf = args[0];
        const pDesc = args[1]; // D3DSURFACE_DESC*
        if (!pDesc) return D3D_OK;

        const info = surfaceInfo.get(pSurf);
        if (!info) return D3D_OK;

        const adapter = resourceToDevice.get(pSurf);
        const surface = resolveLockSurface(info, adapter);
        const meta = info.texturePtr ? textureMeta.get(info.texturePtr) : null;
        const bytesPerPixel = bytesPerPixelFromBpp(surface.format.bpp);
        writeSurfaceDesc(
            mem,
            pDesc,
            info.d3dFormat,
            surface.width,
            surface.height,
            bytesPerPixel,
            meta?.usage ?? 0,
            info.role === 'backbuffer' ? D3DPOOL_DEFAULT : (meta?.pool ?? D3DPOOL_DEFAULT)
        );
        return D3D_OK;
    };

    exports['IDirect3DSurface8_LockRect'] = (_ctx, mem, args): number | Promise<number> => {
        const pSurf = args[0];
        const pLockedRect = args[1]; // D3DLOCKED_RECT*
        const pRect = args[2];
        const Flags = args[3];

        const info = surfaceInfo.get(pSurf);
        if (!info || !pLockedRect) return D3DERR_INVALIDCALL;

        const adapter = resourceToDevice.get(pSurf);
        const surface = resolveLockSurface(info, adapter);

        if (isRenderSurface(surface)) {
            if (!adapter) return D3DERR_INVALIDCALL;
            return lockRenderSurfaceRect(surface, adapter, pLockedRect, pRect, Flags, mem, info.d3dFormat);
        }

        if (!isBitmapTexture(surface) || !surface.surfacePtr) return D3DERR_INVALIDCALL;

        const offset = lockRectOffsetBits(surface, info.d3dFormat, surface.surfacePtr, pRect, mem);
        if (!offset) return D3DERR_INVALIDCALL;
        writeLockedRect(mem, pLockedRect, offset.pitch, offset.pBits);
        return D3D_OK;
    };

    exports['IDirect3DSurface8_UnlockRect'] = (_ctx, _mem, args) => {
        const info = surfaceInfo.get(args[0]);
        if (!info) return D3D_OK;

        const adapter = resourceToDevice.get(args[0]);
        const surface = resolveLockSurface(info, adapter);
        if (isBitmapTexture(surface)) {
            syncBitmapSurfaceFromGuest(surface);
        } else if (isRenderSurface(surface)) {
            const wasReadOnly = surface.lastLockReadOnly === true;
            surface.lastLockReadOnly = undefined;   // no lock outstanding
            if (wasReadOnly) {
                // A READ-ONLY lock modifies nothing, so claiming CPU authority here would
                // upload the CPU copy over the GPU's own render target next frame. The
                // readback memo stays valid because every writer bumps `version`
                // (surface-sync setAuthorityGpu), so the next lock still re-reads.
                surface.everLocked = true;
                return D3D_OK;
            }
            surface.version++;
            surface.gpuDirty = true;
            surface.mode = 'CPU';
            surface.everLocked = true;
            Logger.log(LogCategory.SYSTEM, `D3D8 UnlockRect on render_surface 0x${args[0].toString(16)}: marked CPU-dirty, version=${surface.version}`);
        }
        return D3D_OK;
    };

    exports['IDirect3DSurface8_GetDevice'] = (_ctx, mem, args) => {
        const pSurf = args[0];
        const ppDevice = args[1]; // IDirect3DDevice8**
        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);

        const adapter = resourceToDevice.get(pSurf);
        if (!adapter) return D3DERR_INVALIDCALL;

        for (const [devPtr, dev] of devices) {
            if (dev === adapter) {
                Mem.writeUint32(ppDevice, devPtr);
                addComRef(devPtr);
                return D3D_OK;
            }
        }
        return D3DERR_INVALIDCALL;
    };

    exports['IDirect3DSurface8_GetContainer'] = (_ctx, mem, args) => {
        const pSurf = args[0];
        const _riid = args[1]; // REFIID - ignored, always return parent texture
        const ppContainer = args[2]; // void**
        if (!ppContainer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppContainer);

        const info = surfaceInfo.get(pSurf);
        if (!info || !info.texturePtr) return D3DERR_INVALIDCALL;

        Mem.writeUint32(ppContainer, info.texturePtr);
        addComRef(info.texturePtr);
        return D3D_OK;
    };

    // ---------------------------------------------------------------
    // Resource lifecycle cleanup overrides (override generic COM stubs)
    // ---------------------------------------------------------------
    exports['IDirect3DTexture8_AddRef'] = (_ctx, _mem, args) => {
        const refCount = addComRef(args[0]);
        return refCount ?? 2;
    };

    exports['IDirect3DTexture8_Release'] = (_ctx, _mem, args) => {
        const pTex = args[0];
        const refCount = releaseComRef(pTex);
        if (refCount === undefined) return 0;
        if (refCount > 0) return refCount;

        releaseTextureStorage(pTex);
        return 0;
    };

    exports['IDirect3DSurface8_AddRef'] = (_ctx, _mem, args) => {
        const pSurf = args[0];
        const info = surfaceInfo.get(pSurf);
        if (info?.texturePtr) {
            const refCount = addComRef(info.texturePtr);
            return refCount ?? 2;
        }
        const refCount = addComRef(pSurf);
        return refCount ?? 2;
    };

    exports['IDirect3DSurface8_Release'] = (_ctx, _mem, args) => {
        const pSurf = args[0];
        const info = surfaceInfo.get(pSurf);

        // Texture-owned sub-surfaces: refcount lives on the parent texture (Wine d3d8).
        if (info?.texturePtr) {
            const refCount = releaseComRef(info.texturePtr);
            if (refCount === undefined) return 0;
            if (refCount === 0) {
                releaseTextureStorage(info.texturePtr);
            }
            return refCount;
        }

        const refCount = releaseComRef(pSurf);
        if (refCount === undefined) return 0;
        if (refCount > 0) return refCount;

        const adapter = resourceToDevice.get(pSurf);
        if (adapter && (adapter.depthStencilSurfacePtr >>> 0) === (pSurf >>> 0)) {
            adapter.depthStencilSurfacePtr = 0;
            for (const [devPtr, dsPtr] of deviceBoundDepthStencil) {
                if (dsPtr === pSurf) {
                    deviceBoundDepthStencil.delete(devPtr);
                    break;
                }
            }
        }

        clearRenderTargetOverrideForSurface(pSurf);
        surfaceInfo.delete(pSurf);
        resourceToDevice.delete(pSurf);

        return 0;
    };

    // ---------------------------------------------------------------
    // Surface creation and utility methods
    // ---------------------------------------------------------------
    exports['IDirect3DDevice8_CreateRenderTarget'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const Width = args[1] >>> 0;
        const Height = args[2] >>> 0;
        const Format = args[3] >>> 0;
        const MultiSample = args[4] >>> 0;
        const Lockable = args[5];
        const ppSurface = args[6];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);

        if (Format === 0 || isD3D8ExclusiveFormat(Format) || !isD3D8RenderTargetFormat(Format)) {
            return D3DERR_INVALIDCALL;
        }
        if (!isSupportedD3D8MultiSample(MultiSample)) return D3DERR_INVALIDCALL;

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DSurface8']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;

        const w = Math.max(1, Width);
        const h = Math.max(1, Height);
        // GPU_ONLY RenderSurface — the executor attaches its GPU texture as the render
        // pass target. Lockable RTs get CPU backing so LockRect can read pixels back.
        const surface = createRenderTarget(w, h, Format);
        if (Lockable) {
            surface.surfacePtr = process.memory.alloc(getD3DTextureLayout(Format, w, h).bytes);
        }

        const surfPtr = createComObject(vtableAddr);
        resourceToDevice.set(surfPtr, device);
        surfaceInfo.set(surfPtr, {
            texturePtr: 0,
            level: 0,
            surface,
            d3dFormat: Format,
        });

        Mem.writeUint32(ppSurface, surfPtr);
        Logger.log(LogCategory.SYSTEM, `D3D8 CreateRenderTarget(${w}x${h}, fmt=${Format}) -> 0x${surfPtr.toString(16)}`);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_CreateDepthStencilSurface'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const Width = args[1] >>> 0;
        const Height = args[2] >>> 0;
        const Format = args[3] >>> 0;
        const MultiSample = args[4] >>> 0;
        const ppSurface = args[5];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);

        if (Format === 0 || isD3D8ExclusiveFormat(Format) || !isD3D8DepthStencilFormat(Format)) {
            return D3DERR_INVALIDCALL;
        }
        if (!isSupportedD3D8MultiSample(MultiSample)) return D3DERR_INVALIDCALL;

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DSurface8']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;

        const w = Math.max(1, Width);
        const h = Math.max(1, Height);
        const surface = createTextureSurface(w, h, Format);
        surface.surfacePtr = process.memory.alloc(getD3DTextureLayout(Format, w, h).bytes);

        const surfPtr = createComObject(vtableAddr);
        resourceToDevice.set(surfPtr, device);
        surfaceInfo.set(surfPtr, {
            texturePtr: 0,
            level: 0,
            surface,
            d3dFormat: Format,
        });

        Mem.writeUint32(ppSurface, surfPtr);
        Logger.log(LogCategory.SYSTEM, `D3D8 CreateDepthStencilSurface(${w}x${h}, fmt=${Format}) -> 0x${surfPtr.toString(16)}`);
        return D3D_OK;
    };
    exports['IDirect3DDevice8_CreateImageSurface'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const Width = args[1];
        const Height = args[2];
        const Format = args[3];
        const ppSurface = args[4];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DSurface8']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;

        const surface = createTextureSurface(Width, Height, Format);
        surface.surfacePtr = process.memory.alloc(getD3DTextureLayout(Format, Width, Height).bytes);

        const surfPtr = createComObject(vtableAddr);
        resourceToDevice.set(surfPtr, device);
        surfaceInfo.set(surfPtr, {
            texturePtr: 0,
            level: 0,
            surface,
            d3dFormat: Format,
        });

        Mem.writeUint32(ppSurface, surfPtr);
        return D3D_OK;
    };
    exports['IDirect3DDevice8_CopyRects'] = (_ctx, mem, args) => {
        const pSrc = args[1];
        const pSrcRects = args[2];
        const cRects = args[3] >>> 0;
        const pDst = args[4];
        const pDestPoints = args[5];

        const srcInfo = surfaceInfo.get(pSrc);
        const dstInfo = surfaceInfo.get(pDst);
        if (!srcInfo || !dstInfo) return D3DERR_INVALIDCALL;

        const srcSurface = srcInfo.surface;
        const dstSurface = dstInfo.surface;

        if (isRenderSurface(srcSurface)) {
            if (!ensureRenderSurfaceGuestMemory(srcSurface)) return D3DERR_INVALIDCALL;
        } else if (!isBitmapTexture(srcSurface)) {
            return D3DERR_INVALIDCALL;
        }

        if (isRenderSurface(dstSurface)) {
            if (!ensureRenderSurfaceGuestMemory(dstSurface)) return D3DERR_INVALIDCALL;
        } else if (!isBitmapTexture(dstSurface)) {
            return D3DERR_INVALIDCALL;
        }

        if (!srcSurface.surfacePtr || !dstSurface.surfacePtr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;
        const guestMem = process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        const srcBytesPerPixel = bytesPerPixelFromBpp(srcSurface.format.bpp);
        const dstBytesPerPixel = bytesPerPixelFromBpp(dstSurface.format.bpp);
        if (srcBytesPerPixel !== dstBytesPerPixel) return D3DERR_INVALIDCALL;
        const copyBytesPerPixel = srcBytesPerPixel;

        // Block-compressed (DXT/BC) surfaces are laid out as 4×4 blocks, not linear
        // pixels — copying them per-pixel at the fallback 32bpp overruns the source
        // by ~block-size× and corrupts neighbouring guest heap. Detect and copy blocks.
        const srcLayout = getD3DTextureLayout(srcInfo.d3dFormat, srcSurface.width, srcSurface.height);
        const dstLayout = getD3DTextureLayout(dstInfo.d3dFormat, dstSurface.width, dstSurface.height);
        const compressed = srcLayout.compressed || dstLayout.compressed;
        if (compressed && (!srcLayout.compressed || !dstLayout.compressed ||
            srcLayout.blockBytes !== dstLayout.blockBytes)) {
            return D3DERR_INVALIDCALL;
        }

        const rectCount = pSrcRects && cRects > 0 ? cRects : 1;
        for (let i = 0; i < rectCount; i++) {
            const srcRectRaw = pSrcRects
                ? readRect(mem, pSrcRects + i * 16)
                : { left: 0, top: 0, right: srcSurface.width, bottom: srcSurface.height };
            let srcRect = clampRectToSurface(srcRectRaw, srcSurface.width, srcSurface.height);
            if (srcRect.right <= srcRect.left || srcRect.bottom <= srcRect.top) continue;

            let dstX: number;
            let dstY: number;
            if (pDestPoints) {
                dstX = view.getInt32(pDestPoints + i * 8, true);
                dstY = view.getInt32(pDestPoints + i * 8 + 4, true);
            } else {
                dstX = srcRect.left;
                dstY = srcRect.top;
            }

            let copyWidth = srcRect.right - srcRect.left;
            let copyHeight = srcRect.bottom - srcRect.top;

            if (dstX < 0) {
                const shift = -dstX;
                srcRect.left += shift;
                copyWidth -= shift;
                dstX = 0;
            }
            if (dstY < 0) {
                const shift = -dstY;
                srcRect.top += shift;
                copyHeight -= shift;
                dstY = 0;
            }
            if (dstX + copyWidth > dstSurface.width) {
                copyWidth = dstSurface.width - dstX;
            }
            if (dstY + copyHeight > dstSurface.height) {
                copyHeight = dstSurface.height - dstY;
            }

            if (copyWidth <= 0 || copyHeight <= 0) continue;

            if (compressed) {
                // DXT/BC: copy whole 4×4 blocks. D3D requires block-aligned rects; round
                // the extent up to full blocks defensively so a stray sub-block rect can't
                // slice a block or overrun the allocation.
                const blockBytes = srcLayout.blockBytes;
                const srcPitchC = srcSurface.pitch || srcLayout.pitch;
                const dstPitchC = dstSurface.pitch || dstLayout.pitch;
                const bLeftSrc = srcRect.left >> 2;
                const bTopSrc = srcRect.top >> 2;
                const bLeftDst = dstX >> 2;
                const bTopDst = dstY >> 2;
                const blockRows = (copyHeight + 3) >> 2;
                const rowBytesC = ((copyWidth + 3) >> 2) * blockBytes;
                for (let br = 0; br < blockRows; br++) {
                    const srcRow = srcSurface.surfacePtr + (bTopSrc + br) * srcPitchC + bLeftSrc * blockBytes;
                    const dstRow = dstSurface.surfacePtr + (bTopDst + br) * dstPitchC + bLeftDst * blockBytes;
                    if (
                        srcRow < 0 || dstRow < 0 ||
                        srcRow + rowBytesC > guestMem.length ||
                        dstRow + rowBytesC > guestMem.length
                    ) {
                        return D3DERR_INVALIDCALL;
                    }
                    guestMem.set(guestMem.subarray(srcRow, srcRow + rowBytesC), dstRow);
                }
                continue;
            }

            const rowBytes = copyWidth * copyBytesPerPixel;
            for (let row = 0; row < copyHeight; row++) {
                const srcRow = srcSurface.surfacePtr +
                    (srcRect.top + row) * srcSurface.pitch +
                    srcRect.left * srcBytesPerPixel;
                const dstRow = dstSurface.surfacePtr +
                    (dstY + row) * dstSurface.pitch +
                    dstX * dstBytesPerPixel;
                if (
                    srcRow < 0 || dstRow < 0 ||
                    srcRow + rowBytes > guestMem.length ||
                    dstRow + rowBytes > guestMem.length
                ) {
                    return D3DERR_INVALIDCALL;
                }
                guestMem.set(guestMem.subarray(srcRow, srcRow + rowBytes), dstRow);
            }
        }

        if (isRenderSurface(dstSurface)) {
            dstSurface.version++;
            dstSurface.gpuDirty = true;
            dstSurface.mode = 'CPU';
            dstSurface.everLocked = true;
            Logger.log(LogCategory.SYSTEM, `D3D8 CopyRects to render_surface: marked CPU-dirty, version=${dstSurface.version}`);
        } else {
            syncBitmapSurfaceFromGuest(dstSurface);
        }
        return D3D_OK;
    };
    exports['IDirect3DDevice8_UpdateTexture'] = (_ctx, _mem, args) => {
        const pSrcTexture = args[1];
        const pDstTexture = args[2];

        const srcDevice = resourceToDevice.get(pSrcTexture);
        const dstDevice = resourceToDevice.get(pDstTexture);
        const srcSurface = srcDevice?.texSurfaces.get(pSrcTexture);
        const dstSurface = dstDevice?.texSurfaces.get(pDstTexture);
        if (!srcSurface || !dstSurface) return D3DERR_INVALIDCALL;
        if (srcSurface.surfaceType !== 'bitmap_texture' || dstSurface.surfaceType !== 'bitmap_texture') {
            return D3DERR_INVALIDCALL;
        }
        if (!srcSurface.surfacePtr || !dstSurface.surfacePtr) return D3DERR_INVALIDCALL;

        const process = System.getInstance().process;
        if (!process) return D3DERR_INVALIDCALL;
        const guestMem = process.getCurrentMemory();

        const srcFmt = srcSurface.d3dFormat ?? srcSurface.dxtFormat ?? D3DFMT_X8R8G8B8;
        const dstFmt = dstSurface.d3dFormat ?? dstSurface.dxtFormat ?? D3DFMT_X8R8G8B8;
        const srcLayout = getD3DTextureLayout(srcFmt, srcSurface.width, srcSurface.height);
        const dstLayout = getD3DTextureLayout(dstFmt, dstSurface.width, dstSurface.height);

        // Block-compressed (DXT/BC) textures are laid out as 4×4 blocks, not linear
        // pixels — copying them per-pixel at the fallback 32bpp over-reads the source
        // by ~block-size× and corrupts neighbouring guest heap. Copy whole block rows.
        if (srcLayout.compressed || dstLayout.compressed) {
            if (!srcLayout.compressed || !dstLayout.compressed ||
                srcLayout.blockBytes !== dstLayout.blockBytes) {
                return D3DERR_INVALIDCALL;
            }
            const srcPitch = srcSurface.pitch || srcLayout.pitch;
            const dstPitch = dstSurface.pitch || dstLayout.pitch;
            const blockRows = Math.min(srcLayout.rows, dstLayout.rows);
            const rowBytes = Math.min(srcLayout.pitch, dstLayout.pitch);
            for (let row = 0; row < blockRows; row++) {
                const srcRow = srcSurface.surfacePtr + row * srcPitch;
                const dstRow = dstSurface.surfacePtr + row * dstPitch;
                if (
                    srcRow < 0 || dstRow < 0 ||
                    srcRow + rowBytes > guestMem.length ||
                    dstRow + rowBytes > guestMem.length
                ) {
                    return D3DERR_INVALIDCALL;
                }
                guestMem.set(guestMem.subarray(srcRow, srcRow + rowBytes), dstRow);
            }
            syncBitmapSurfaceFromGuest(dstSurface);
            return D3D_OK;
        }

        const srcBytesPerPixel = bytesPerPixelFromBpp(srcSurface.format.bpp);
        const dstBytesPerPixel = bytesPerPixelFromBpp(dstSurface.format.bpp);
        if (srcBytesPerPixel !== dstBytesPerPixel) return D3DERR_INVALIDCALL;
        const copyBytesPerPixel = srcBytesPerPixel;
        const copyWidth = Math.min(srcSurface.width, dstSurface.width);
        const copyHeight = Math.min(srcSurface.height, dstSurface.height);
        const rowBytes = copyWidth * copyBytesPerPixel;

        for (let row = 0; row < copyHeight; row++) {
            const srcRow = srcSurface.surfacePtr + row * srcSurface.pitch;
            const dstRow = dstSurface.surfacePtr + row * dstSurface.pitch;
            if (
                srcRow < 0 || dstRow < 0 ||
                srcRow + rowBytes > guestMem.length ||
                dstRow + rowBytes > guestMem.length
            ) {
                return D3DERR_INVALIDCALL;
            }
            guestMem.set(guestMem.subarray(srcRow, srcRow + rowBytes), dstRow);
        }

        syncBitmapSurfaceFromGuest(dstSurface);
        return D3D_OK;
    };

    return exports;
}
