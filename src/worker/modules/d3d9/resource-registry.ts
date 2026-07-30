/**
 * D3D9 resource metadata shared between d3d9 HLE and d3dx9 helpers.
 */

import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import { devices, getVTables, createComObject, forgetComObject, registerComFinalizer, releaseComRef, resourceToDevice } from './shared-state';
import { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import { initReturnPtr, D3DFMT_UNKNOWN, normalizePalettizedTexturePool } from '../../backends/webgpu/shared/dx-com-helpers';
import { isDxExclusiveFormat } from '../../backends/webgpu/shared/dx-format-support';
import { resetDeviceCursor } from '../../core/device-cursor';

export type TextureMeta = {
    width: number;
    height: number;
    levels: number;
    usage: number;
    pool: number;
    format: number;
    /** Cube texture: width === height === edge length; faces selected via CubeMapFace. */
    isCube?: boolean;
};

export type BufferMeta = {
    size: number;
    usage: number;
    pool: number;
    fvf?: number;
    format?: number;
};

export type SurfaceMeta = {
    format: number;
    type: number;
    usage: number;
    pool: number;
    multiSampleType: number;
    multiSampleQuality: number;
    width: number;
    height: number;
    texturePtr?: number;
    level?: number;
    /** Cube-face index (0..5, D3DCUBEMAP_FACES order) when this surface is a cube map face.
     *  Disambiguates a cube face from a plain 2D mip surface (which uses texturePtr+level only). */
    face?: number;
};

export const textureMeta: Map<number, TextureMeta> = new Map();
export const surfaceMeta: Map<number, SurfaceMeta> = new Map();
export const vertexBufferMeta: Map<number, BufferMeta> = new Map();
export const indexBufferMeta: Map<number, BufferMeta> = new Map();
/** Per-device bound depth/stencil surface COM pointer (0 = none). */
export const deviceBoundDepthStencil: Map<number, number> = new Map();
/** Per-device bound render-target surface COM pointers by render-target index. */
export const deviceBoundRenderTarget: Map<number, Map<number, number>> = new Map();
/** 2D texture COM ptr -> mip level -> stable IDirect3DSurface9 COM ptr. */
export const textureLevelSurfaces: Map<number, Map<number, number>> = new Map();
/** Cube texture COM ptr -> `${face}_${level}` -> stable IDirect3DSurface9 COM ptr. */
export const cubeFaceSurfaces: Map<number, Map<string, number>> = new Map();

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DFMT_A8R8G8B8 = 21;
const D3DRTYPE_SURFACE = 1;
const D3DMULTISAMPLE_NONE = 0;

export function releaseSurfaceMetadata(surfacePtr: number): void {
    const pSurf = surfacePtr >>> 0;
    for (const [devicePtr, surfPtr] of deviceBoundDepthStencil) {
        if ((surfPtr >>> 0) === pSurf) deviceBoundDepthStencil.delete(devicePtr);
    }
    for (const [devicePtr, targets] of deviceBoundRenderTarget) {
        for (const [index, surfPtr] of targets) {
            if ((surfPtr >>> 0) === pSurf) targets.delete(index);
        }
        if (targets.size === 0) deviceBoundRenderTarget.delete(devicePtr);
    }
    surfaceMeta.delete(pSurf);
    resourceToDevice.delete(pSurf);
    forgetComObject(pSurf);
}

export function getDeviceRenderTarget(devicePtr: number, index: number): number {
    return deviceBoundRenderTarget.get(devicePtr >>> 0)?.get(index >>> 0) ?? 0;
}

export function setDeviceRenderTarget(devicePtr: number, index: number, surfacePtr: number): void {
    const pDevice = devicePtr >>> 0;
    const slot = index >>> 0;
    const pSurf = surfacePtr >>> 0;
    let targets = deviceBoundRenderTarget.get(pDevice);
    if (pSurf === 0) {
        targets?.delete(slot);
        if (targets && targets.size === 0) deviceBoundRenderTarget.delete(pDevice);
        return;
    }
    if (!targets) {
        targets = new Map();
        deviceBoundRenderTarget.set(pDevice, targets);
    }
    targets.set(slot, pSurf);
}

export function getDeviceRenderTargets(devicePtr: number): number[] {
    return [...(deviceBoundRenderTarget.get(devicePtr >>> 0)?.values() ?? [])];
}

export function clearDeviceRenderTargets(devicePtr: number): void {
    deviceBoundRenderTarget.delete(devicePtr >>> 0);
}

export function clearTextureSubresourceSurfaces(texturePtr: number): void {
    const pTex = texturePtr >>> 0;
    const levels = textureLevelSurfaces.get(pTex);
    if (levels) {
        for (const surfPtr of levels.values()) {
            releaseSurfaceMetadata(surfPtr);
        }
        textureLevelSurfaces.delete(pTex);
    }
    const faces = cubeFaceSurfaces.get(pTex);
    if (faces) {
        for (const surfPtr of faces.values()) {
            releaseSurfaceMetadata(surfPtr);
        }
        cubeFaceSurfaces.delete(pTex);
    }
    for (const [surfPtr, meta] of surfaceMeta) {
        if ((meta.texturePtr ?? 0) === pTex) {
            releaseSurfaceMetadata(surfPtr);
        }
    }
}

export function ensureTextureLevelSurface(pTexture: number, level: number): number | null {
    const pTex = pTexture >>> 0;
    let levelMap = textureLevelSurfaces.get(pTex);
    if (!levelMap) {
        levelMap = new Map();
        textureLevelSurfaces.set(pTex, levelMap);
    }
    const cached = levelMap.get(level);
    if (cached !== undefined) return cached;

    const device = resourceToDevice.get(pTex);
    const meta = textureMeta.get(pTex);
    if (!device || !meta || meta.isCube || level >= meta.levels) return null;

    const vtableAddr = getVTables()['IDirect3DSurface9']?.address;
    if (!vtableAddr) return null;

    const dims = getTextureLevelDims(meta.width, meta.height, level);
    const surfacePtr = createComObject(vtableAddr);
    resourceToDevice.set(surfacePtr, device);
    surfaceMeta.set(surfacePtr, {
        format: meta.format,
        type: D3DRTYPE_SURFACE,
        usage: meta.usage,
        pool: meta.pool,
        multiSampleType: D3DMULTISAMPLE_NONE,
        multiSampleQuality: 0,
        width: dims.width,
        height: dims.height,
        texturePtr: pTex,
        level,
    });
    levelMap.set(level, surfacePtr);
    return surfacePtr;
}

export function ensureCubeFaceSurface(pCube: number, face: number, level: number): number | null {
    const pTex = pCube >>> 0;
    const key = `${face}_${level}`;
    let faceMap = cubeFaceSurfaces.get(pTex);
    if (!faceMap) {
        faceMap = new Map();
        cubeFaceSurfaces.set(pTex, faceMap);
    }
    const cached = faceMap.get(key);
    if (cached !== undefined) return cached;

    const device = resourceToDevice.get(pTex);
    const meta = textureMeta.get(pTex);
    if (!device || !meta || !meta.isCube || face > 5 || level >= meta.levels) return null;

    const vtableAddr = getVTables()['IDirect3DSurface9']?.address;
    if (!vtableAddr) return null;

    const dim = Math.max(1, meta.width >>> level);
    const surfacePtr = createComObject(vtableAddr);
    resourceToDevice.set(surfacePtr, device);
    surfaceMeta.set(surfacePtr, {
        format: meta.format,
        type: D3DRTYPE_SURFACE,
        usage: meta.usage,
        pool: meta.pool,
        multiSampleType: D3DMULTISAMPLE_NONE,
        multiSampleQuality: 0,
        width: dim,
        height: dim,
        texturePtr: pTex,
        level,
        face,
    });
    faceMap.set(key, surfacePtr);
    return surfacePtr;
}

export function precreateTextureLevelSurfaces(pTexture: number, levelCount: number): boolean {
    for (let level = 0; level < levelCount; level++) {
        if (!ensureTextureLevelSurface(pTexture, level)) return false;
    }
    return true;
}

export function precreateCubeFaceSurfaces(pCube: number, levelCount: number): boolean {
    for (let face = 0; face < 6; face++) {
        for (let level = 0; level < levelCount; level++) {
            if (!ensureCubeFaceSurface(pCube, face, level)) return false;
        }
    }
    return true;
}

export function clearResourceRegistry(): void {
    textureMeta.clear();
    surfaceMeta.clear();
    vertexBufferMeta.clear();
    indexBufferMeta.clear();
    deviceBoundDepthStencil.clear();
    deviceBoundRenderTarget.clear();
    resetDeviceCursor();
    textureLevelSurfaces.clear();
    cubeFaceSurfaces.clear();
}

export function computeMipLevelCount(width: number, height: number): number {
    const maxDim = Math.max(1, width >>> 0, height >>> 0);
    return Math.floor(Math.log2(maxDim)) + 1;
}

export function getTextureLevelDims(width: number, height: number, level: number): { width: number; height: number } {
    const lv = level >>> 0;
    return {
        width: Math.max(1, width >>> lv),
        height: Math.max(1, height >>> lv),
    };
}

export function resolveSurfaceInfo(surfacePtr: number): {
    device: D3D9Device;
    texturePtr: number;
    level: number;
    width: number;
    height: number;
    /** -1 for a plain 2D mip surface; 0..5 for a cube-map face. */
    face: number;
} | null {
    const meta = surfaceMeta.get(surfacePtr);
    const device = resourceToDevice.get(surfacePtr);
    if (!meta || !device || !meta.texturePtr) return null;
    const level = meta.level ?? 0;
    return {
        device,
        texturePtr: meta.texturePtr,
        level,
        width: meta.width,
        height: meta.height,
        face: meta.face ?? -1,
    };
}

export function resolveTextureInfo(texturePtr: number): {
    device: D3D9Device;
    meta: TextureMeta;
} | null {
    const meta = textureMeta.get(texturePtr);
    const device = resourceToDevice.get(texturePtr);
    if (!meta || !device) return null;
    return { device, meta };
}

export function createGuestTexture(
    devicePtr: number,
    width: number,
    height: number,
    levels: number,
    usage: number,
    format: number,
    pool: number,
    ppTexture: number,
): number {
    if (ppTexture) initReturnPtr(ppTexture);
    const fmt = format >>> 0;
    if (fmt === D3DFMT_UNKNOWN || isDxExclusiveFormat(fmt, 9)) {
        return D3DERR_INVALIDCALL;
    }

    const device = devices.get(devicePtr);
    if (!device) {
        Logger.error(LogCategory.D3D9, `createGuestTexture: invalid device ${devicePtr}`);
        return D3DERR_INVALIDCALL;
    }

    const vtables = getVTables();
    const vtableAddr = vtables['IDirect3DTexture9']?.address;
    if (!vtableAddr) return D3DERR_INVALIDCALL;

    const texPtr = createComObject(vtableAddr);
    const w = Math.max(1, width >>> 0);
    const h = Math.max(1, height >>> 0);
    const levelCount = levels !== 0 ? (levels >>> 0) : computeMipLevelCount(w, h);
    const normalizedPool = normalizePalettizedTexturePool(fmt, pool);

    const guestPtr = device.createTexture(texPtr, w, h, levelCount, fmt, usage >>> 0);
    if (guestPtr === 0) {
        if (ppTexture) initReturnPtr(ppTexture);
        return D3DERR_INVALIDCALL;
    }
    resourceToDevice.set(texPtr, device);
    const maxLevels = Math.max(1, levelCount);
    textureMeta.set(texPtr, {
        width: w,
        height: h,
        levels: maxLevels,
        usage: usage >>> 0,
        pool: normalizedPool,
        format: fmt,
    });
    registerComFinalizer(texPtr, () => {
        clearTextureSubresourceSurfaces(texPtr);
        device.releaseTexture(texPtr);
        textureMeta.delete(texPtr);
        resourceToDevice.delete(texPtr);
    });

    if (!precreateTextureLevelSurfaces(texPtr, maxLevels)) {
        releaseComRef(texPtr);
        if (ppTexture) initReturnPtr(ppTexture);
        return D3DERR_INVALIDCALL;
    }

    if (ppTexture) {
        if (!Mem.writeUint32(ppTexture, texPtr)) return D3DERR_INVALIDCALL;
    }

    return D3D_OK;
}

export { D3D_OK, D3DERR_INVALIDCALL, D3DFMT_A8R8G8B8 };
