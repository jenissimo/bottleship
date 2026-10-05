/**
 * D3D8 device lifecycle helpers — implicit depth-stencil on CreateDevice/Reset.
 */

import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';
import { resizeFullscreenWindowToMode } from '../../runtime/windowing/fullscreen-window';
import {
    createComObject,
    deviceBackBufferSurfaces,
    deviceBoundDepthStencil,
    deviceRenderTargetOverride,
    devices,
    forgetComObject,
    getVTables,
    implicitDepthStencils,
    resourceToDevice,
    surfaceInfo,
} from './shared-state';
import type { D3D8SurfaceInfo } from './shared-state';
import { D3D8DeviceAdapter } from '../../backends/webgpu/d3d8/d3d8-device-adapter';
import { createTextureSurface } from '../../backends/webgpu/shared/surface-factory';
import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';
import { isD3D8DepthStencilFormat } from './format-support';

const D3DFMT_D24S8 = 75;
const D3DFMT_X8R8G8B8 = 22;

/**
 * Return the stable IDirect3DSurface8 COM wrapper for a device's swap-chain back buffer.
 * The wrapper is cached per device; LockRect resolves the live GPU render target via role.
 */
export function ensureBackBufferSurface(devicePtr: number, device: D3D8DeviceAdapter): number {
    const existing = deviceBackBufferSurfaces.get(devicePtr >>> 0);
    if (existing !== undefined && surfaceInfo.has(existing)) {
        return existing;
    }

    const vtableAddr = getVTables()['IDirect3DSurface8']?.address;
    if (!vtableAddr) return 0;

    const rt = device.renderTarget;
    const surfPtr = createComObject(vtableAddr);
    deviceBackBufferSurfaces.set(devicePtr >>> 0, surfPtr);
    resourceToDevice.set(surfPtr, device);
    surfaceInfo.set(surfPtr, {
        texturePtr: 0,
        level: 0,
        surface: rt,
        d3dFormat: D3DFMT_X8R8G8B8,
        role: 'backbuffer',
    });
    Logger.log(LogCategory.SYSTEM,
        `D3D8 back buffer surface ${rt.width}x${rt.height} -> 0x${surfPtr.toString(16)}`);
    return surfPtr;
}

/** Drop cached presentation-surface state after Reset (back buffer is reallocated). */
export function invalidateDevicePresentationSurfaces(devicePtr: number): void {
    deviceRenderTargetOverride.delete(devicePtr >>> 0);
    const bb = deviceBackBufferSurfaces.get(devicePtr >>> 0);
    if (bb !== undefined) {
        surfaceInfo.delete(bb);
        resourceToDevice.delete(bb);
        forgetComObject(bb);
        deviceBackBufferSurfaces.delete(devicePtr >>> 0);
    }
}

/**
 * Release the implicit depth-stencil we previously created for this device, if any.
 * The implicit DS is device-owned and recreated on every CreateDevice/Reset; without
 * this, each Reset leaks a surfaceInfo/COM/resourceToDevice entry. Only ptrs we created
 * are destroyed — an app-set DS (via SetRenderTarget) is never touched.
 */
function destroyImplicitDepthStencil(devicePtr: number): void {
    const prev = deviceBoundDepthStencil.get(devicePtr) ?? 0;
    if (prev !== 0 && implicitDepthStencils.has(prev)) {
        surfaceInfo.delete(prev);
        resourceToDevice.delete(prev);
        forgetComObject(prev);
        implicitDepthStencils.delete(prev);
    }
}

/**
 * Creating a device with Windowed==FALSE puts the focus window into the device's display
 * mode, and apps read that back (GetClientRect on the now-fullscreen window) to size their
 * render targets. Shared with D3D9 and DDraw — see resizeFullscreenWindowToMode.
 */
export function resizeFullscreenDeviceWindow(hwnd: number, width: number, height: number): void {
    resizeFullscreenWindowToMode(hwnd, width, height, "D3D8");
}

// BeginScene/EndScene pairing (wined3d dlls/wined3d/device.c:3718-3743): real D3D8
// rejects a second BeginScene without an intervening EndScene, and an EndScene with no
// open scene, both with D3DERR_INVALIDCALL. The actual thunk handlers live in device.ts
// (owned by another agent for this pass) — these helpers are the complete mechanism;
// device.ts's BeginScene/EndScene need a two-line call into them (see the parity report).
const deviceInScene = new Map<number, boolean>();

/** Returns false (D3DERR_INVALIDCALL) if a scene is already open for this device. */
export function tryBeginScene(devicePtr: number): boolean {
    if (deviceInScene.get(devicePtr) === true) return false;
    deviceInScene.set(devicePtr, true);
    return true;
}

/** Returns false (D3DERR_INVALIDCALL) if no scene is open for this device. */
export function tryEndScene(devicePtr: number): boolean {
    if (deviceInScene.get(devicePtr) !== true) return false;
    deviceInScene.set(devicePtr, false);
    return true;
}

/** Device teardown: drop tracked scene state so a recycled COM pointer starts clean. */
export function clearSceneState(devicePtr: number): void {
    deviceInScene.delete(devicePtr);
}

/** Bind the implicit depth-stencil surface when EnableAutoDepthStencil is set. */
export function bindAutoDepthStencil(devicePtr: number, mem: Uint8Array, pPresentationParameters: number): void {
    if (!pPresentationParameters) return;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const enableAutoDS = view.getUint32(pPresentationParameters + 32, true);
    const device = devices.get(devicePtr);
    if (!device) return;

    destroyImplicitDepthStencil(devicePtr);

    if (!enableAutoDS) {
        device.depthStencilSurfacePtr = 0;
        deviceBoundDepthStencil.delete(devicePtr);
        return;
    }

    const vtableAddr = getVTables()['IDirect3DSurface8']?.address;
    if (!vtableAddr) {
        Logger.error(LogCategory.SYSTEM, 'D3D8 auto depth-stencil: IDirect3DSurface8 vtable not found');
        return;
    }

    const w = Math.max(1, view.getUint32(pPresentationParameters + 0, true) || 800);
    const h = Math.max(1, view.getUint32(pPresentationParameters + 4, true) || 600);
    let format = view.getUint32(pPresentationParameters + 36, true) >>> 0;
    if (!isD3D8DepthStencilFormat(format)) format = D3DFMT_D24S8;

    const process = System.getInstance().process;
    if (!process) return;

    const surface = createTextureSurface(w, h, format);
    surface.surfacePtr = process.memory.alloc(getD3DTextureLayout(format, w, h).bytes);

    const surfPtr = createComObject(vtableAddr);
    resourceToDevice.set(surfPtr, device);
    const info: D3D8SurfaceInfo = {
        texturePtr: 0,
        level: 0,
        surface,
        d3dFormat: format,
    };
    surfaceInfo.set(surfPtr, info);

    device.depthStencilSurfacePtr = surfPtr;
    deviceBoundDepthStencil.set(devicePtr, surfPtr);
    implicitDepthStencils.add(surfPtr);
    Logger.log(LogCategory.SYSTEM, `D3D8 auto depth-stencil ${w}x${h} fmt=${format} -> 0x${surfPtr.toString(16)}`);
}
