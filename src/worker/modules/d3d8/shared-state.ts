/**
 * D3D8 shared state - vtable singleton and device registry.
 * Pattern matches d3d9/shared-state.ts.
 */

import { System } from '../../core/system';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { d3d8Module } from '../../api/d3d8.api';
import { D3D8DeviceAdapter } from '../../backends/webgpu/d3d8/d3d8-device-adapter';
import { Logger, LogCategory } from '../../core/logger';
import { allocateComObject as allocateGuardedComObject } from '../../core/com/com-memory';
import { resetDeviceCursor } from '../../core/device-cursor';
import type { BitmapTextureSurface, DirectDrawSurfaceState } from '../../modules/ddraw/com-objects';
import { registerDDrawSurfaceSource } from '../../modules/ddraw/surface-device-loss';

let vtables: Record<string, VTableInfo> | null = null;

export const devices: Map<number, D3D8DeviceAdapter> = new Map();
export const resourceToDevice: Map<number, D3D8DeviceAdapter> = new Map();
const comRefCounts: Map<number, number> = new Map();

/**
 * What the game actually passed to IDirect3D8::CreateDevice, echoed verbatim by
 * IDirect3DDevice8::GetCreationParameters (keyed by device COM ptr). The previous
 * hardcode 0x60 was an ILLEGAL flag combo (HARDWARE|SOFTWARE_VERTEXPROCESSING).
 */
export const deviceCreationParams: Map<number, {
    adapter: number;
    deviceType: number;
    hFocusWindow: number;
    behaviorFlags: number;
}> = new Map();

export interface D3D8TextureMeta {
    width: number;
    height: number;
    levels: number;
    usage: number;
    pool: number;
    format: number;
}

/** How a D3D8 surface COM object maps to backing storage. */
export type D3D8SurfaceRole = 'backbuffer' | 'texture_level' | 'standalone';

/** Info about a D3D8 surface obtained via GetSurfaceLevel or CreateImageSurface */
export interface D3D8SurfaceInfo {
    /** Parent texture COM ptr, or 0 for standalone (CreateImageSurface) */
    texturePtr: number;
    /** Mip level within parent texture */
    level: number;
    /** The actual surface state (pixels, format, dimensions) */
    surface: DirectDrawSurfaceState;
    /** Original D3DFMT number for GetDesc */
    d3dFormat: number;
    /** When set, resolveLockSurface() follows the live device back buffer. */
    role?: D3D8SurfaceRole;
}

/** Device COM ptr -> cached IDirect3DSurface8 back-buffer wrapper. */
export const deviceBackBufferSurfaces: Map<number, number> = new Map();

/** Device COM ptr -> D3DPRESENT_PARAMETERS.Windowed, as last declared by CreateDevice/Reset.
 *  Absent = fullscreen, which is what a device that never declared otherwise runs as. */
export const deviceWindowed: Map<number, boolean> = new Map();

/** Device COM ptr -> explicit SetRenderTarget color surface (0 = use back buffer). */
export const deviceRenderTargetOverride: Map<number, number> = new Map();

/** Resolve the live surface backing a LockRect/GetDesc call. */
export function resolveLockSurface(info: D3D8SurfaceInfo, device: D3D8DeviceAdapter | undefined): DirectDrawSurfaceState {
    if (info.role === 'backbuffer' && device) {
        return device.renderTarget;
    }
    return info.surface;
}

/** Surface COM ptr -> surface info */
export const surfaceInfo: Map<number, D3D8SurfaceInfo> = new Map();

// Device loss: these surface states are reachable from nowhere else (a D3D8 surface is not a
// ddraw COM object), so they need their own source or they keep a dead GPU texture.
registerDDrawSurfaceSource("d3d8-surfaces", function* () {
    for (const [comAddr, info] of surfaceInfo) yield { state: info.surface, comAddr };
});

/** Texture COM ptr -> original D3DFMT (for GetDesc on texture-owned surfaces) */
export const textureD3DFormat: Map<number, number> = new Map();
/** Texture COM ptr -> creation metadata */
export const textureMeta: Map<number, D3D8TextureMeta> = new Map();

/** Texture COM ptr -> mip level -> stable IDirect3DSurface8 COM ptr (Wine/DXVK cache). */
export const textureLevelSurfaces: Map<number, Map<number, number>> = new Map();

/** If any device has surfPtr bound as its SetRenderTarget override, restore the back buffer. */
export function clearRenderTargetOverrideForSurface(surfPtr: number): void {
    const ptr = surfPtr >>> 0;
    for (const [devPtr, boundSurf] of deviceRenderTargetOverride) {
        if (boundSurf === ptr) {
            deviceRenderTargetOverride.delete(devPtr);
            devices.get(devPtr)?.setRenderTargetOverride(null);
        }
    }
}

/** Tear down cached GetSurfaceLevel wrappers when the parent texture is destroyed. */
export function clearTextureLevelSurfaces(pTex: number): void {
    const levels = textureLevelSurfaces.get(pTex >>> 0);
    if (!levels) return;
    for (const surfPtr of levels.values()) {
        clearRenderTargetOverrideForSurface(surfPtr);
        surfaceInfo.delete(surfPtr);
        resourceToDevice.delete(surfPtr);
        forgetComObject(surfPtr);
    }
    textureLevelSurfaces.delete(pTex >>> 0);
}

/** Device COM ptr -> bound depth-stencil surface COM ptr (implicit or explicit). */
export const deviceBoundDepthStencil: Map<number, number> = new Map();

/** Surface ptrs of device-owned implicit depth-stencils we created (for teardown). */
export const implicitDepthStencils: Set<number> = new Set();

export function createComObject(vtableAddress: number): number {
    const system = System.getInstance();
    const process = system.process;
    if (!process) throw new Error('Process not initialized');

    const mem = process.getCurrentMemory();
    const objPtr = allocateGuardedComObject(process.memory, mem, vtableAddress);
    comRefCounts.set(objPtr, 1);
    return objPtr;
}

export function addComRef(ptr: number): number | undefined {
    const current = comRefCounts.get(ptr);
    if (current === undefined) return undefined;
    const next = current + 1;
    comRefCounts.set(ptr, next);
    return next;
}

export function releaseComRef(ptr: number): number | undefined {
    const current = comRefCounts.get(ptr);
    if (current === undefined) return undefined;
    const next = current - 1;
    if (next <= 0) {
        comRefCounts.delete(ptr);
        return 0;
    }
    comRefCounts.set(ptr, next);
    return next;
}

export function isComObjectLive(ptr: number): boolean {
    return comRefCounts.has(ptr >>> 0);
}

/** Drop a COM object's refcount entry outright (device-owned implicit resources). */
export function forgetComObject(ptr: number): void {
    comRefCounts.delete(ptr >>> 0);
}

export function getVTables(): Record<string, VTableInfo> {
    if (!vtables) {
        const system = System.getInstance();
        const process = system.process;
        if (!process) throw new Error('Process not initialized');
        vtables = createVTablesFromDescriptor(process, d3d8Module);
        Logger.verbose(LogCategory.SYSTEM, 'Created D3D8 vtables');
    }
    return vtables;
}

/** Resolve a D3D8 texture by COM handle or guest pixel pointer (LockRect pBits). */
export function resolveD3D8TextureSurface(addr: number): BitmapTextureSurface | null {
    const ptr = addr >>> 0;
    if (!ptr) return null;

    for (const device of devices.values()) {
        const byCom = device.texSurfaces.get(ptr);
        if (byCom?.surfaceType === "bitmap_texture") {
            return byCom;
        }
    }

    for (const info of surfaceInfo.values()) {
        if (info.surface.surfaceType !== "bitmap_texture") continue;
        if (info.texturePtr === ptr) return info.surface;
    }

    for (const device of devices.values()) {
        for (const surface of device.texSurfaces.values()) {
            if (surface.surfaceType !== "bitmap_texture" || !surface.surfacePtr) continue;
            const base = surface.surfacePtr >>> 0;
            const size = surface.pitch * surface.height;
            if (ptr === base || (ptr > base && ptr < base + size)) {
                return surface;
            }
        }
    }

    for (const info of surfaceInfo.values()) {
        const surface = info.surface;
        if (surface.surfaceType !== "bitmap_texture" || !surface.surfacePtr) continue;
        const base = surface.surfacePtr >>> 0;
        const size = surface.pitch * surface.height;
        if (ptr === base || (ptr > base && ptr < base + size)) {
            return surface;
        }
    }

    return null;
}

export function resetD3D8SharedState(): void {
    resetDeviceCursor();
    vtables = null;
    devices.clear();
    resourceToDevice.clear();
    surfaceInfo.clear();
    textureD3DFormat.clear();
    textureMeta.clear();
    textureLevelSurfaces.clear();
    deviceBoundDepthStencil.clear();
    implicitDepthStencils.clear();
    deviceBackBufferSurfaces.clear();
    deviceRenderTargetOverride.clear();
    deviceWindowed.clear();
    deviceCreationParams.clear();
    comRefCounts.clear();
}
