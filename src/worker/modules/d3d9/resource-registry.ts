/**
 * D3D9 resource metadata shared between d3d9 HLE and d3dx9 helpers.
 */

import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import {
    devices,
    getVTables,
    createComObject,
    forgetComObject,
    registerDeviceChildFinalizer,
    releaseComRef,
    resourceToDevice,
    getComRefCount,
} from './shared-state';
import { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import { initReturnPtr, D3DFMT_UNKNOWN, normalizePalettizedTexturePool } from '../../backends/webgpu/shared/dx-com-helpers';
import { isDxExclusiveFormat } from '../../backends/webgpu/shared/dx-format-support';
import { resetDeviceCursor } from '../../core/device-cursor';
import { clearResourceContract, resetResourceContract } from './resource-contract';
import { volumeTextureResources } from './volume-resources';

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
    /** Guest return address of the CreateXxx call — who owns this resource. */
    createdBy?: number;
    /** Creation order among DEFAULT-pool buffers — pins WHEN a survivor was made. */
    seq?: number;
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
    /** Semantic owner for StretchRect legality; true only for an offscreen plain surface. */
    offscreenPlain?: boolean;
    /** One of the DEVICE's implicit swap-chain back buffers. Reset redeclares these, so they
     *  can never be what blocks it — and the identity has to live on the surface, because the
     *  device-side registry that used to answer this is itself torn down across a Reset. */
    implicitBackBuffer?: boolean;
    /** Surface was created by a device Create*Surface call and has no D3D9
     * resource parent, even if the implementation uses a hidden texture for
     * CPU/GPU storage. */
    standalone?: boolean;
    /** Whether the surface was explicitly created with CPU lockability. */
    lockable?: boolean;
};

/** sizeof(D3DSURFACE_DESC) — eight DWORDs. */
export const D3DSURFACE_DESC_SIZE = 32;

const surfaceDescWords = new Uint32Array(8);

/**
 * The D3DSURFACE_DESC field order, in one place: the thunk writes these words through Mem
 * and the fast path through a DataView, and neither may spell the layout itself. The
 * returned view is reused, so consume it before the next call.
 */
export function packSurfaceDesc(meta: SurfaceMeta): Uint32Array {
    surfaceDescWords[0] = meta.format >>> 0;
    surfaceDescWords[1] = meta.type >>> 0;
    surfaceDescWords[2] = meta.usage >>> 0;
    surfaceDescWords[3] = meta.pool >>> 0;
    surfaceDescWords[4] = meta.multiSampleType >>> 0;
    surfaceDescWords[5] = meta.multiSampleQuality >>> 0;
    surfaceDescWords[6] = meta.width >>> 0;
    surfaceDescWords[7] = meta.height >>> 0;
    return surfaceDescWords;
}

export const textureMeta: Map<number, TextureMeta> = new Map();
export const surfaceMeta: Map<number, SurfaceMeta> = new Map();
export const vertexBufferMeta: Map<number, BufferMeta> = new Map();
export const indexBufferMeta: Map<number, BufferMeta> = new Map();
/** Per-device bound depth/stencil surface COM pointer (0 = none). */
export const deviceBoundDepthStencil: Map<number, number> = new Map();
/** Per-device bound render-target surface COM pointers by render-target index. */
export const deviceBoundRenderTarget: Map<number, Map<number, number>> = new Map();
/**
 * Per-device binding slot ('ds', 'rt0'..'rt3') -> the COM ptr whose reference that
 * binding actually holds. Recorded at BIND time: a surface reference lands on the
 * parent texture when there is one, and that link can be gone by the time we
 * release (a texture teardown clears its subresource metadata), so re-deriving it
 * at release time decrements the wrong object and leaks the texture's binding ref.
 */
const deviceSlotRefs: Map<number, Map<string, number>> = new Map();

export function setDeviceSlotRef(devicePtr: number, slot: string, heldPtr: number): void {
    const pDevice = devicePtr >>> 0;
    let slots = deviceSlotRefs.get(pDevice);
    if (!slots) {
        slots = new Map();
        deviceSlotRefs.set(pDevice, slots);
    }
    slots.set(slot, heldPtr >>> 0);
}

/** Hand back (and forget) the reference a slot holds; 0 when it holds none. */
export function takeDeviceSlotRef(devicePtr: number, slot: string): number {
    const slots = deviceSlotRefs.get(devicePtr >>> 0);
    if (!slots) return 0;
    const held = slots.get(slot) ?? 0;
    slots.delete(slot);
    if (slots.size === 0) deviceSlotRefs.delete(devicePtr >>> 0);
    return held;
}

/** Hand back (and forget) every reference a device's binding slots hold. */
export function takeAllDeviceSlotRefs(devicePtr: number): number[] {
    const slots = deviceSlotRefs.get(devicePtr >>> 0);
    if (!slots) return [];
    const held = [...slots.values()];
    deviceSlotRefs.delete(devicePtr >>> 0);
    return held;
}

/**
 * Device COM ptr -> `${iSwapChain}:${iBackBuffer}` -> the ONE implicit backbuffer
 * surface object for that slot. Real D3D9 hands out the same object every time, so
 * `GetRenderTarget(0,&rt) == GetBackBuffer(0,0,&bb)` compares equal and a per-frame
 * Get/Release loop does not mint a new guest object each frame.
 */
const deviceBackBufferSurfaces: Map<number, Map<string, number>> = new Map();

/** True for the implicit swap-chain surfaces owned by the device.  They are recreated by
 * Reset and therefore must not make an otherwise clean device look like it still owns an
 * application-created D3DPOOL_DEFAULT resource. */
function isImplicitBackBufferSurface(surfacePtr: number): boolean {
    const ptr = surfacePtr >>> 0;
    for (const surfaces of deviceBackBufferSurfaces.values()) {
        for (const candidate of surfaces.values()) if ((candidate >>> 0) === ptr) return true;
    }
    return false;
}

export interface DefaultPoolResourceSummary {
    textures: number;
    volumes: number;
    vertexBuffers: number;
    indexBuffers: number;
    surfaces: number;
    total: number;
}

/**
 * Enumerate application-owned DEFAULT-pool resources for Reset's precondition.
 *
 * D3D9 Reset is not a convenient GPU-loss recovery shortcut: every DEFAULT resource
 * (apart from the implicit swap-chain attachments) must have been released first.  The
 * old path reset the presentation state while silently retaining those objects, so a
 * title that correctly waited for INVALIDCALL could never diagnose the real ownership
 * error.  Keep this census in the metadata authority rather than trying to infer pool
 * from the backend's CPU shadows.
 */
export function summarizeDefaultPoolResources(device: D3D9Device): DefaultPoolResourceSummary {
    const out: DefaultPoolResourceSummary = {
        textures: 0, volumes: 0, vertexBuffers: 0, indexBuffers: 0, surfaces: 0, total: 0,
    };
    for (const [ptr, meta] of textureMeta) {
        if (meta.pool === 0 && resourceToDevice.get(ptr) === device) out.textures++;
    }
    for (const [ptr, meta] of volumeTextureResources) {
        if (meta.pool === 0 && resourceToDevice.get(ptr) === device) out.volumes++;
    }
    for (const [ptr, meta] of vertexBufferMeta) {
        if (meta.pool === 0 && resourceToDevice.get(ptr) === device) out.vertexBuffers++;
    }
    for (const [ptr, meta] of indexBufferMeta) {
        if (meta.pool === 0 && resourceToDevice.get(ptr) === device) out.indexBuffers++;
    }
    const bound = new Set<number>();
    for (const ptr of deviceBoundDepthStencil.values()) bound.add(ptr >>> 0);
    for (const targets of deviceBoundRenderTarget.values()) {
        for (const ptr of targets.values()) bound.add(ptr >>> 0);
    }
    for (const [ptr, meta] of surfaceMeta) {
        if (meta.pool !== 0 || meta.texturePtr !== undefined || meta.implicitBackBuffer
            || isImplicitBackBufferSurface(ptr)) continue;
        if (bound.has(ptr >>> 0)) continue;
        if (resourceToDevice.get(ptr) === device) out.surfaces++;
    }
    out.total = out.textures + out.volumes + out.vertexBuffers + out.indexBuffers + out.surfaces;
    return out;
}

/**
 * Name the DEFAULT-pool resources that are blocking a Reset, not just how many.
 *
 * "1 vertex buffer is still live" is not actionable — WHICH buffer, created with what usage,
 * and how many references are still on it is what separates "the app really holds it" (real
 * D3D9 refuses too) from "our COM refcount never reached zero" (only we refuse). Capped,
 * because this runs on a failure path and the first few offenders are the diagnosis.
 */
/**
 * Lifetime tally for DEFAULT-pool buffers. A refused Reset needs to separate "the guest never
 * released this one" (created > finalized by the number still live) from "our Release did not
 * destroy it" — the live count alone reads the same either way.
 */
export const defaultPoolBufferTally = { created: 0, entered: 0, finalized: 0 };

export function describeDefaultPoolResources(device: D3D9Device, limit = 6): string[] {
    const out: string[] = [];
    const registry = (System.getInstance().process as { moduleRegistry?: { resolveAddress?(a: number): string | null } } | undefined)?.moduleRegistry;
    const who = (addr: number | undefined): string =>
        addr ? `,by=${registry?.resolveAddress?.(addr >>> 0) ?? `0x${(addr >>> 0).toString(16)}`}` : "";
    const push = (kind: string, ptr: number, extra: string): void => {
        if (out.length >= limit) return;
        out.push(`${kind}@0x${(ptr >>> 0).toString(16)}{${extra},refs=${getComRefCount(ptr) ?? "?"}}`);
    };
    for (const [ptr, meta] of vertexBufferMeta) {
        if (meta.pool === 0 && resourceToDevice.get(ptr) === device) {
            push("vb", ptr, `size=${meta.size},usage=0x${(meta.usage >>> 0).toString(16)},fvf=0x${((meta.fvf ?? 0) >>> 0).toString(16)},seq=${meta.seq ?? -1}${who(meta.createdBy)}`);
        }
    }
    for (const [ptr, meta] of indexBufferMeta) {
        if (meta.pool === 0 && resourceToDevice.get(ptr) === device) {
            push("ib", ptr, `size=${meta.size},usage=0x${(meta.usage >>> 0).toString(16)}${who(meta.createdBy)}`);
        }
    }
    for (const [ptr, meta] of textureMeta) {
        if (meta.pool === 0 && resourceToDevice.get(ptr) === device) {
            push("tex", ptr, `${meta.width}x${meta.height},levels=${meta.levels},usage=0x${(meta.usage >>> 0).toString(16)},fmt=${meta.format}`);
        }
    }
    // Surfaces use the SAME exemptions as the census above — a listing that showed the ones
    // the census already forgives would send the reader after the wrong object.
    const bound = new Set<number>();
    for (const p of deviceBoundDepthStencil.values()) bound.add(p >>> 0);
    for (const targets of deviceBoundRenderTarget.values()) for (const p of targets.values()) bound.add(p >>> 0);
    for (const [ptr, meta] of surfaceMeta) {
        if (meta.pool !== 0 || meta.texturePtr !== undefined || meta.implicitBackBuffer
            || isImplicitBackBufferSurface(ptr)) continue;
        if (bound.has(ptr >>> 0) || resourceToDevice.get(ptr) !== device) continue;
        push("surface", ptr, `${meta.width ?? "?"}x${meta.height ?? "?"},usage=0x${((meta.usage ?? 0) >>> 0).toString(16)},` +
            `fmt=${meta.format},standalone=${meta.standalone ? 1 : 0}`);
    }
    return out;
}

export function getDeviceBackBufferSurface(devicePtr: number, key: string): number {
    return deviceBackBufferSurfaces.get(devicePtr >>> 0)?.get(key) ?? 0;
}

/**
 * Is this surface one of the device's IMPLICIT back buffers?
 *
 * Those have no owning texture — they name the swap chain's own image, which lives in the
 * backend rather than the texture table. Anything that wants their pixels therefore cannot
 * go through the texture path and has to ask the presenter instead, and this is the test
 * that tells the two apart.
 */
export function isDeviceBackBufferSurface(devicePtr: number, surfacePtr: number): boolean {
    const ptr = surfacePtr >>> 0;
    if (!ptr) return false;
    const cache = deviceBackBufferSurfaces.get(devicePtr >>> 0);
    if (!cache) return false;
    for (const registered of cache.values()) if (registered === ptr) return true;
    return false;
}

export function setDeviceBackBufferSurface(devicePtr: number, key: string, surfacePtr: number): void {
    const pDevice = devicePtr >>> 0;
    let cache = deviceBackBufferSurfaces.get(pDevice);
    if (!cache) {
        cache = new Map();
        deviceBackBufferSurfaces.set(pDevice, cache);
    }
    cache.set(key, surfacePtr >>> 0);
}

export function dropDeviceBackBufferSurface(devicePtr: number, surfacePtr: number): void {
    const pDevice = devicePtr >>> 0;
    const cache = deviceBackBufferSurfaces.get(pDevice);
    if (!cache) return;
    for (const [key, ptr] of cache) {
        if (ptr === (surfacePtr >>> 0)) cache.delete(key);
    }
    if (cache.size === 0) deviceBackBufferSurfaces.delete(pDevice);
}

/** Hand back (and forget) every implicit backbuffer surface a device owns. */
export function takeDeviceBackBufferSurfaces(devicePtr: number): number[] {
    const pDevice = devicePtr >>> 0;
    const cache = deviceBackBufferSurfaces.get(pDevice);
    if (!cache) return [];
    const surfaces = [...cache.values()];
    deviceBackBufferSurfaces.delete(pDevice);
    return surfaces;
}

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
    clearResourceContract(pSurf);
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
    if (!device || !meta || meta.isCube || !Number.isInteger(level) || level < 0 || level >= meta.levels) return null;

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
    if (!device || !meta || !meta.isCube || !Number.isInteger(face) || face < 0 || face > 5
        || !Number.isInteger(level) || level < 0 || level >= meta.levels) return null;

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
    // Any private-data entry that belonged to a synthetic resource without a
    // registered child finalizer must still release an IUnknown reference on
    // module reset.  Normal resources clear this during their finalizer; this
    // is the defensive sweep for test/failure paths.
    resetResourceContract();
    textureMeta.clear();
    surfaceMeta.clear();
    vertexBufferMeta.clear();
    indexBufferMeta.clear();
    deviceBoundDepthStencil.clear();
    deviceBoundRenderTarget.clear();
    deviceSlotRefs.clear();
    deviceBackBufferSurfaces.clear();
    resetDeviceCursor();
    textureLevelSurfaces.clear();
    cubeFaceSurfaces.clear();
}

export function computeMipLevelCount(width: number, height: number): number {
    const maxDim = Math.max(1, width >>> 0, height >>> 0);
    return Math.floor(Math.log2(maxDim)) + 1;
}

/**
 * Validate the D3D9 `Levels` creation argument without manufacturing repeated
 * 1x1 subresources.  Zero requests the complete chain; an explicit value may
 * stop early, but cannot exceed the number of distinct dimensions in the
 * resource.  Callers use `null` as D3DERR_INVALIDCALL.
 */
export function resolveRequestedMipLevels(width: number, height: number, requestedLevels: number): number | null {
    const w = width >>> 0;
    const h = height >>> 0;
    const requested = requestedLevels >>> 0;
    if (w === 0 || h === 0) return null;
    const full = computeMipLevelCount(w, h);
    if (requested === 0) return full;
    return requested <= full ? requested : null;
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
    const pSurface = surfacePtr >>> 0;
    const meta = surfaceMeta.get(pSurface);
    const device = resourceToDevice.get(pSurface);
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
    const pTexture = texturePtr >>> 0;
    const meta = textureMeta.get(pTexture);
    const device = resourceToDevice.get(pTexture);
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

    const guestPtr = device.createTexture(texPtr, w, h, levelCount, fmt, usage >>> 0, normalizedPool);
    if (guestPtr === 0) {
        releaseComRef(texPtr);
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
    registerDeviceChildFinalizer(texPtr, devicePtr, () => {
        clearResourceContract(texPtr);
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
        if (!Mem.writeUint32(ppTexture, texPtr)) {
            releaseComRef(texPtr);
            return D3DERR_INVALIDCALL;
        }
    }

    return D3D_OK;
}

export { D3D_OK, D3DERR_INVALIDCALL, D3DFMT_A8R8G8B8 };
