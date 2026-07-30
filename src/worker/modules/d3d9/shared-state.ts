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
import type { D3D9StateBlockData } from '../../backends/webgpu/d3d9/d3d9-state-block';
import { clearD3D9ComObjectRegistries } from '../../backends/webgpu/d3d9/d3d9-com-objects';
import { resetShaderValidators } from './shader-validator';
import { resetD3D9Perf } from './d3d9-perf';
import { d3d9WasmArena } from '../../backends/webgpu/d3d9/d3d9-wasm-arena';

// Shared vtables - created once and reused
let vtables: Record<string, VTableInfo> | null = null;
const comRefCounts: Map<number, number> = new Map();
const comFinalizers: Map<number, () => void> = new Map();

// Shared device registry - maps COM object pointer to D3D9Device instance
export const devices: Map<number, D3D9Device> = new Map();

// Parent relationship for IDirect3DDevice9::GetDirect3D
export const deviceToD3D9: Map<number, number> = new Map();

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
    comRefCounts.set(objPtr, 1);

    return objPtr;
}

export function addComRef(ptr: number): number | undefined {
    const key = ptr >>> 0;
    const current = comRefCounts.get(key);
    if (current === undefined) return undefined;
    const next = current + 1;
    comRefCounts.set(key, next);
    return next;
}

export function releaseComRef(ptr: number): number | undefined {
    const key = ptr >>> 0;
    const current = comRefCounts.get(key);
    if (current === undefined) return undefined;
    const next = current - 1;
    if (next > 0) {
        comRefCounts.set(key, next);
        return next;
    }

    comRefCounts.delete(key);
    const finalizer = comFinalizers.get(key);
    comFinalizers.delete(key);
    finalizer?.();
    return 0;
}

export function registerComFinalizer(ptr: number, finalizer: () => void): void {
    comFinalizers.set(ptr >>> 0, finalizer);
}

export function forgetComObject(ptr: number): void {
    const key = ptr >>> 0;
    comRefCounts.delete(key);
    comFinalizers.delete(key);
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
    resourceToDevice.clear();
    stateBlocks.clear();
    comRefCounts.clear();
    comFinalizers.clear();
    d3d9WasmArena.resetBlockSlots(); // every block ptr just dropped — slot ownership resets with them
    clearD3D9ComObjectRegistries();
    clearResourceRegistry();
    resetShaderValidators();
    Logger.log(LogCategory.D3D9, 'D3D9 shared state reset');
}
