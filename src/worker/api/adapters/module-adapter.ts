import { ModuleDescriptor } from "../types";
import { generateModuleVTables } from "../codegen";
import { Process } from "../../core/process";
import { Logger, LogCategory } from "../../core/logger";
import { writeGuestCode } from "../../core/memory/guest-code";

export type VTableInfo = {
    address: number;
    size: number;
};

/**
 * Build COM vtables for a module descriptor and write stub code into memory.
 */
export function createVTablesFromDescriptor(
    process: Process,
    module: ModuleDescriptor
): Record<string, VTableInfo> {
    const thunkGenerator = process.thunkGenerator;
    const vtables: Record<string, VTableInfo> = {};
    
    Logger.verbose(LogCategory.COM, `createVTablesFromDescriptor called for module ${module.name}`);

    for (const vtableSpec of generateModuleVTables(module)) {
        // Get fresh memory reference to ensure consistency
        const currentMemory = process.getCurrentMemory();

        const stubDll = thunkGenerator.generateStubDll(
            module.name,
            vtableSpec.methods.map((method) => ({
                name: method.name,
                argCount: method.argCount,
                stackCleanupBytes: method.stackCleanup,
            }))
        );

        // Use the base address managed by ThunkGenerator for consistency
        const stubAddress = stubDll.baseAddress;
        
        // Reserve the memory in MemoryManager to prevent overlap with heap
        try {
            process.memory.allocAt(stubAddress, stubDll.stubCode.length);
        } catch (e) {
            // Already reserved or overlapping - ThunkGenerator should handle its own space
        }
        
        writeGuestCode(currentMemory, stubDll.stubCode, stubAddress);

        // Update export table with addresses (exportTable already has correct addresses from thunkGenerator)
        const updatedExportTable = stubDll.exportTable;

        // Allocate vtable in protected thunk region, NOT in heap!
        // Heap allocations by the game were overwriting vtable contents.
        const vtableSize = vtableSpec.methods.length * 4;
        const vtableAddr = thunkGenerator.allocateVTableMemory(vtableSize);
        const view = new DataView(currentMemory.buffer, currentMemory.byteOffset, currentMemory.byteLength);
        
        // Log export table for debugging
        Logger.verbose(LogCategory.COM, `Creating vtable ${vtableSpec.name} with ${vtableSpec.methods.length} methods`);
        Logger.verbose(LogCategory.COM, `Export table has ${updatedExportTable.size} entries`);
        if (updatedExportTable.size > 0) {
            const sampleKeys = Array.from(updatedExportTable.keys()).slice(0, 3);
            Logger.verbose(LogCategory.COM, `Sample export keys: ${sampleKeys.join(", ")}`);
        }
        
        vtableSpec.methods.forEach((method, index) => {
            const methodKey = method.name.toLowerCase();
            const stubAddr = updatedExportTable.get(methodKey);
            if (!stubAddr) {
                Logger.error(LogCategory.COM, `Missing stub for ${vtableSpec.name}:${method.name} (key: ${methodKey})`);
                Logger.error(LogCategory.COM, `Available keys: ${Array.from(updatedExportTable.keys()).join(", ")}`);
                throw new Error(`Missing stub for ${vtableSpec.name}:${method.name}`);
            }

            Logger.verbose(LogCategory.COM, `VTable[${index}] = ${method.name} -> 0x${stubAddr.toString(16)}`);
            view.setUint32(vtableAddr + index * 4, stubAddr, true);
        });

        // Log vtable creation for debugging
        const firstMethodName = vtableSpec.methods[0]?.name.toLowerCase() || '';
        const firstMethodAddr = updatedExportTable.get(firstMethodName);
        Logger.verbose(LogCategory.COM, `Created vtable ${vtableSpec.name} at 0x${vtableAddr.toString(16)}, first method (${firstMethodName}) at 0x${firstMethodAddr?.toString(16) || 'unknown'}`);

        vtables[vtableSpec.name] = { address: vtableAddr, size: vtableSpec.methods.length };
    }

    // Apply any pending registrations now that stubs are created
    // NOTE: This is called BEFORE exports are registered in dispatcher (emulator.worker.ts:556)
    // So pending registrations won't be applied here - they'll be applied later when exports are registered
    if (process.dispatcher) {
        const pendingCount = (process.dispatcher as any).pendingRegistrations?.size ?? 0;
        if (pendingCount > 0) {
            // Logger.warn(LogCategory.COM, `[DIAG] applyPendingRegistrations called with ${pendingCount} pending registrations (exports not yet registered!)`);
        }
        process.dispatcher.applyPendingRegistrations();
    }

    return vtables;
}
