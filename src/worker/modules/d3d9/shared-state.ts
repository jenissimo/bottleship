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
import { resetD3D9Perf, getD3D9PerfSnapshot, type D3D9PerfSnapshot } from './d3d9-perf';
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

/**
 * Device registry: COM object pointer -> D3D9Device. `lookup` is the per-call path of the
 * setter handlers, which read the device pointer out of guest memory: a pointer above 2^30
 * is not a Smi, so handing it to Map.get boxes a HeapNumber on every call. A one-entry cache
 * compares the raw number instead, and every mutation drops it, so a torn-down or
 * re-registered pointer can never alias a stale device.
 */
class DeviceRegistry extends Map<number, D3D9Device> {
    private lastPtr = -1;
    private lastDevice: D3D9Device | undefined = undefined;

    lookup(ptr: number): D3D9Device | undefined {
        let device: D3D9Device | undefined;
        if (ptr === this.lastPtr) device = this.lastDevice;
        else {
            device = super.get(ptr);
            this.lastPtr = ptr;
            this.lastDevice = device;
        }
        return splitReplayDepth === 0 || device === undefined ? device : (device.renderTwin ?? device);
    }

    override get(key: number): D3D9Device | undefined {
        const device = super.get(key);
        return splitReplayDepth === 0 || device === undefined ? device : (device.renderTwin ?? device);
    }

    override set(key: number, value: D3D9Device): this {
        this.forget();
        return super.set(key, value);
    }

    override delete(key: number): boolean {
        this.forget();
        return super.delete(key);
    }

    override clear(): void {
        this.forget();
        super.clear();
    }

    private forget(): void {
        this.lastPtr = -1;
        this.lastDevice = undefined;
    }
}

export const devices = new DeviceRegistry();

/**
 * Split D3D9 (modules/d3d9/split.ts): while the render twin replays the call stream, the
 * registries the ring handlers read answer with the twin's objects — the same handler code
 * then drives the twin. Outside a replay they are the front's, as always.
 */
let splitReplayDepth = 0;
export function beginD3D9SplitReplay(): void { splitReplayDepth++; }
export function endD3D9SplitReplay(): void { splitReplayDepth--; }
export function isD3D9SplitReplay(): boolean { return splitReplayDepth !== 0; }

/** The render twin's state blocks, by COM pointer (registered through the call stream). */
export const twinStateBlocks: Map<number, D3D9StateBlockData> = new Map();

class StateBlockRegistry extends Map<number, D3D9StateBlockData> {
    override get(key: number): D3D9StateBlockData | undefined {
        return splitReplayDepth === 0 ? super.get(key) : twinStateBlocks.get(key);
    }
}

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
export const stateBlocks: Map<number, D3D9StateBlockData> = new StateBlockRegistry();

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

/**
 * The D3D9 perf snapshot with the live per-device executor counters folded in.
 *
 * `d3d9-perf`'s own `backend` record declares names the executor also keeps —
 * `pipelineSets`, `bindGroupSets`, `drawCalls` and friends — but nothing ever writes them
 * there, so the bare snapshot answers a permanent zero for each while the executor's copy
 * counts in the millions. Both readers go through here so one name cannot have two answers.
 */
export function getD3D9PerfSnapshotWithDevices(): D3D9PerfSnapshot {
    const snap = getD3D9PerfSnapshot();
    const stateTracker: Record<string, number> = {};
    const backendExtra: Record<string, number> = {};
    for (const dev of devices.values()) {
        const sub = dev.collectSubsystemPerf();
        for (const [k, v] of Object.entries(sub.stateTracker)) {
            stateTracker[k] = (stateTracker[k] ?? 0) + v;
        }
        for (const [k, v] of Object.entries(sub.backend)) {
            backendExtra[k] = (backendExtra[k] ?? 0) + v;
        }
    }
    for (const [k, v] of Object.entries(backendExtra)) {
        snap.backend[k] = (snap.backend[k] ?? 0) + v;
    }
    snap.stateTracker = stateTracker;
    return snap;
}
