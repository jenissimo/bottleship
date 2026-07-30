/**
 * Shared state for D3D9 module
 * 
 * Provides singleton access to vtables and device registry
 */

import { System } from '../../core/system';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { d3d9Module } from '../../api/d3d9.api';
import { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import { Logger, LogCategory } from '../../core/logger';
import { clearResourceRegistry } from './resource-registry';
import type { D3D9StateBlockData } from '../../backends/webgpu/d3d9/d3d9-state-block';
import { clearD3D9ComObjectRegistries } from '../../backends/webgpu/d3d9/d3d9-com-objects';
import { resetShaderValidators } from './shader-validator';
import { resetD3D9Perf } from './d3d9-perf';
import { d3d9WasmArena } from '../../backends/webgpu/d3d9/d3d9-wasm-arena';

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
 * Helper to create a COM object in guest memory
 */
export function createComObject(vtableAddress: number): number {
    const system = System.getInstance();
    const process = system.process;
    if (!process) {
        throw new Error('Process not initialized');
    }

    // Allocate 4 bytes for COM object (vtable pointer)
    const objPtr = process.memory.alloc(4);
    const mem = process.getCurrentMemory();
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    
    // Write vtable pointer to memory (first field of COM object)
    view.setUint32(objPtr, vtableAddress, true);

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
        dev.resetSubsystemPerf();
    }
    resetD3D9Perf();
    vtables = null;
    devices.clear();
    deviceToD3D9.clear();
    deviceCreationParams.clear();
    deviceBackBufferInfo.clear();
    resourceToDevice.clear();
    stateBlocks.clear();
    d3d9WasmArena.resetBlockSlots(); // every block ptr just dropped — slot ownership resets with them
    clearD3D9ComObjectRegistries();
    clearResourceRegistry();
    resetShaderValidators();
    Logger.log(LogCategory.D3D9, 'D3D9 shared state reset');
}
