/**
 * Shared state for D3D9 module
 * 
 * Provides singleton access to vtables and device registry
 */

import { System } from '../../core/system';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { d3d9Module } from '../../api/d3d9.api';
import type { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import { Logger, LogCategory } from '../../core/logger';
import { clearResourceRegistry } from './resource-registry';
import { publishTexture9Vtable } from './guest-addref-stub';
import { publishTexture9ReleaseVtable } from './guest-release-stub';
import { clearVolumeResources } from './volume-resources';
import { resetResourceContract } from './resource-contract';
import type { D3D9StateBlockData } from '../../backends/webgpu/d3d9/d3d9-state-block';
import { clearD3D9ComObjectRegistries } from '../../backends/webgpu/d3d9/d3d9-com-objects';
import { resetShaderValidators } from './shader-validator';
import { resetQueryState } from './query';
import { resetD3D9Perf } from './d3d9-perf';
import { d3d9WasmArena } from '../../backends/webgpu/d3d9/d3d9-wasm-arena';
import { allocateComObject, freeComObject } from '../../core/com/com-memory';
import { drainComFinalizers, trackComObject } from './com-refs';

export {
    addComRef,
    forgetComObject,
    getComRefCount,
    registerComFinalizer,
    registerDeviceChildFinalizer,
    releaseComRef,
} from './com-refs';

// Shared vtables - created once and reused
let vtables: Record<string, VTableInfo> | null = null;

// Shared device registry - maps COM object pointer to D3D9Device instance
export const devices: Map<number, D3D9Device> = new Map();

// Parent relationship for IDirect3DDevice9::GetDirect3D
export const deviceToD3D9: Map<number, number> = new Map();

/**
 * What the game actually passed to IDirect3D9::CreateDevice, echoed verbatim by
 * IDirect3DDevice9::GetCreationParameters (keyed by device COM ptr). Engines read
 * hFocusWindow/BehaviorFlags back out of the device rather than tracking them, so
 * these must be the caller's own values, not a plausible-looking constant.
 */
export const deviceCreationParams: Map<number, {
    adapter: number;
    deviceType: number;
    hFocusWindow: number;
    behaviorFlags: number;
}> = new Map();

/**
 * The device's REAL backbuffer geometry, as given to CreateDevice/Reset (keyed by device
 * COM ptr). The authority for every geometry answer the runtime owes the app —
 * GetBackBuffer/GetRenderTarget surface descs and, for a fullscreen device,
 * GetDisplayMode. The emulator's configured screen resolution is NOT that authority: a
 * title whose backbuffer differs from it (System Shock 2 mode-sets 800x600 from its own
 * cam.cfg while the bundle declares 1024x768) is then told the backbuffer is the config
 * size, lays its fullscreen 2D quad out over that many pixels, and the quad overhangs
 * the real target — the visible top-left fraction reads as a cropped screen.
 * `windowed` decides whether GetDisplayMode reports this (fullscreen mode-set) or the
 * desktop mode (windowed, where the app is a guest of the desktop resolution).
 */
export const deviceBackBufferInfo: Map<number, {
    width: number;
    height: number;
    format: number;
    windowed: boolean;
}> = new Map();

// Shared resource registry - maps COM object pointer to its parent D3D9Device
export const resourceToDevice: Map<number, D3D9Device> = new Map();

// State block COM objects → captured/replayed state data
export const stateBlocks: Map<number, D3D9StateBlockData> = new Map();

/**
 * Device COM ptr → D3DCLIPSTATUS9 {ClipUnion, ClipIntersection}, as last written by
 * SetClipStatus. Absent = the device default, "nothing was clipped, full extents"
 * (ClipUnion 0 / ClipIntersection 0xFFFFFFFF — same as DXVK's D3D9State initializer).
 * Clip status is pure app-visible bookkeeping in D3D9 (it only ever reports what
 * ProcessVertices found), so store-and-return IS the faithful implementation.
 */
export const deviceClipStatus: Map<number, { clipUnion: number; clipIntersection: number }> = new Map();

/**
 * Create a COM object in guest memory. Guard-worded and drawn from the
 * system-object pool (as d3d8/ddraw do), and returned to that pool when the last
 * reference goes — a real refcount layer means these are no longer immortal.
 */
export function createComObject(vtableAddress: number): number {
    const system = System.getInstance();
    const process = system.process;
    if (!process) {
        throw new Error('Process not initialized');
    }

    const objPtr = allocateComObject(process.memory, process.getCurrentMemory(), vtableAddress);
    trackComObject(objPtr, () => freeComObject(process.memory, objPtr));

    return objPtr;
}

/**
 * Get or create D3D9 vtables (singleton)
 */
export function getVTables(): Record<string, VTableInfo> {
    if (!vtables) {
        const system = System.getInstance();
        const process = system.process;
        if (!process) {
            throw new Error('Process not initialized');
        }
        vtables = createVTablesFromDescriptor(process, d3d9Module);
        // The guest-side AddRef/Release stubs only trust a `this` whose vptr is this exact vtable;
        // publishing it here is what turns the stub on, and clearing it (below, on reset) is
        // what turns it off — a stub with no published vtable simply traps as it always did.
        publishTexture9Vtable(vtables['IDirect3DTexture9']?.address ?? 0);
        publishTexture9ReleaseVtable(vtables['IDirect3DTexture9']?.address ?? 0);
        Logger.verbose(LogCategory.D3D9, 'Created D3D9 vtables (shared)');
    }
    return vtables;
}

/**
 * Reset shared state - clear vtables and device registry.
 * Called during system reset to ensure fresh state for new applications.
 */
export function resetD3D9SharedState(): void {
    for (const dev of devices.values()) {
        // Test doubles and older device shims may not expose the optional
        // performance-reset hook; shared-state teardown must remain safe for
        // those callers while real devices still clear their counters.
        dev.resetSubsystemPerf?.();
    }
    // Before the registries the finalizers read are torn down: they own the GPU
    // textures, VB/IB and WASM block slots a reused WebGPU device would inherit.
    drainComFinalizers();
    resetD3D9Perf();
    vtables = null;
    publishTexture9Vtable(0);
    publishTexture9ReleaseVtable(0);
    devices.clear();
    deviceToD3D9.clear();
    deviceCreationParams.clear();
    deviceBackBufferInfo.clear();
    resourceToDevice.clear();
    stateBlocks.clear();
    deviceClipStatus.clear();
    d3d9WasmArena.resetBlockSlots(); // every block ptr just dropped — slot ownership resets with them
    clearD3D9ComObjectRegistries();
    clearResourceRegistry();
    clearVolumeResources();
    resetResourceContract();
    resetShaderValidators();
    resetQueryState();
    Logger.log(LogCategory.D3D9, 'D3D9 shared state reset');
}

/**
 * Geometry of the D3D9 texture lock whose staging buffer contains `addr`, or null.
 *
 * Bink's BinkCopyToBuffer destination is a bare pointer; on a GPU presenter, writing to
 * one is only visible when the guest itself uploads that memory. A LockRect staging
 * buffer is exactly that case — UnlockRect uploads it — so the video must go INTO it
 * and be composited by the game, not onto a video overlay that hides the game's own UI.
 */
/**
 * Monotonic count of level-0 texture write-backs (UnlockRect that publishes bytes).
 *
 * A video sink uses this to tell two shapes apart that look identical from the codec side:
 * an app that uploads the movie into its OWN texture every frame (so the movie is already
 * in the frame it presents), and one that leaves the movie stranded in a CPU buffer (where
 * the overlay is the only way it reaches the screen). The pointer-based test cannot see the
 * first shape when the app copies into a private buffer and locks the texture afterwards —
 * the two never coincide — but the upload itself is observable, and needs to know nothing
 * about the game.
 */
let d3d9TextureUploads = 0;

export function noteD3D9TextureUpload(): void {
    d3d9TextureUploads = (d3d9TextureUploads + 1) >>> 0;
}

export function d3d9TextureUploadSeq(): number {
    return d3d9TextureUploads;
}

export function resolveD3D9LockedTextureTarget(
    addr: number,
): { pitch: number; width: number; height: number } | null {
    const ptr = addr >>> 0;
    if (!ptr) return null;
    for (const device of devices.values()) {
        const hit = device.findLockedTextureByPointer?.(ptr);
        if (hit) return hit;
    }
    return null;
}
