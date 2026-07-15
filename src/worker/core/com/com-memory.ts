import { Logger, LogCategory } from '../logger';
import { Mem } from '../memory/mem-accessor';

export const COM_OBJECT_SIZE = 0x100;
export const COM_GUARD_SIZE = 16;
export const COM_GUARD_VALUE = 0xDEADBEEF;
const COM_TOTAL_SIZE = COM_GUARD_SIZE + COM_OBJECT_SIZE + COM_GUARD_SIZE;

interface ComMemoryFree {
    freeSystemBlock(addr: number, size: number): void;
}

/**
 * Allocates a COM object with guard bytes and proper layout.
 * Layout: [GUARD 16b] [VTABLE_PTR 4b] [DATA...] [GUARD 16b]
 * Returns the address of the VTable pointer (the object's 'this' pointer).
 *
 * COM objects live in the system-object pool (MemoryManager.allocSystemBlock),
 * NOT the game's HEAP bucket. On real Windows, system DLLs (ddraw etc.) allocate
 * from their own heap: a block the game frees keeps its contents until the GAME
 * reuses it, and a released COM object's memory survives until the next
 * same-class system allocation claims it. The pool reproduces both properties.
 */
export const allocateComObject = (
    memory: any,
    mem8: Uint8Array,
    vtableAddr: number,
): number => {
    const totalSize = COM_TOTAL_SIZE;
    const addr = memory.allocSystemBlock(totalSize);

    // Get fresh memory view after potential grow during alloc
    const freshMem8 = Mem.getView();
    if (!freshMem8) throw new Error("Mem.getView() failed during allocateComObject");

    // Fill with zero using fresh view
    freshMem8.fill(0, addr, addr + totalSize);

    // Write guards using Mem accessors
    for (let i = 0; i < COM_GUARD_SIZE; i += 4) {
        Mem.writeUint32(addr + i, COM_GUARD_VALUE);
        Mem.writeUint32(addr + totalSize - COM_GUARD_SIZE + i, COM_GUARD_VALUE);
    }

    // Object address is after the first guard
    const objAddr = addr + COM_GUARD_SIZE;
    Mem.writeUint32(objAddr, vtableAddr);

    // DIAGNOSTIC: Log COM object allocation with guard addresses
    Logger.verbose(LogCategory.COM, `[COM ALLOC] objAddr=0x${objAddr.toString(16)}, guardStart=0x${addr.toString(16)}, vtable=0x${vtableAddr.toString(16)}`);

    return objAddr;
};

/** Returns the backing block of a COM object to the system-object pool. */
export function freeComObject(memory: ComMemoryFree, objAddr: number): void {
    if (!objAddr) return;
    memory.freeSystemBlock((objAddr - COM_GUARD_SIZE) >>> 0, COM_TOTAL_SIZE);
};

/**
 * Verifies that the guard bytes around a COM object are intact.
 * Returns true if valid, false if corrupted.
 */
/** Thunk stub prologue: MOV EAX, imm32 */
export const COM_STUB_PROLOGUE = 0xb8;

/**
 * Verifies a vtable slot points at a valid OUT-trap stub (starts with MOV EAX).
 */
export const verifyComVtableSlot = (mem8: Uint8Array, stubAddr: number): boolean => {
    if (!stubAddr || stubAddr >= mem8.length) return false;
    return mem8[stubAddr] === COM_STUB_PROLOGUE;
};

export const checkComGuard = (mem8: Uint8Array, objAddr: number): boolean => {
    const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
    const addr = objAddr - COM_GUARD_SIZE;
    const totalSize = COM_GUARD_SIZE + COM_OBJECT_SIZE + COM_GUARD_SIZE;

    // Check bounds
    if (addr < 0 || addr + totalSize > mem8.length) {
        return false;
    }

    for (let i = 0; i < COM_GUARD_SIZE; i += 4) {
        if (view.getUint32(addr + i, true) !== COM_GUARD_VALUE) return false;
        if (view.getUint32(addr + totalSize - COM_GUARD_SIZE + i, true) !== COM_GUARD_VALUE) return false;
    }
    return true;
};
