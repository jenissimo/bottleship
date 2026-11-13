/**
 * Kernel32 FLS (Fiber Local Storage) functions
 *
 * Slot indices are process-global, but VALUES are per-fiber — per-THREAD here
 * (no fiber support): the UCRT stores each thread's _ptd in one shared slot
 * index. The values live in the thread's RTL_FLS_DATA block (TEB+0xFB4), the same
 * storage the trap-free guest stubs (teb-stubs.ts) read and write; Get/Set follow NT
 * and never consult the allocation bitmap. FlsFree callbacks are not invoked.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { hypercallDataManager } from '../../core/cpu/hypercall-data';
import { FLS_INDEX_LIMIT } from '../../core/teb-manager';

const FLS_OUT_OF_INDEXES = 0xffffffff;
const ERROR_INVALID_PARAMETER = 87;

// @participant(kernel32)
const allocated = new Set<number>();
// @participant(kernel32)
let nextSlot = 1;
// @transient(identity of the owning process object)
let flsOwnerProcess: unknown = null;

// @transient(identity of the owning process object)
let flsOwnerResetGeneration = -1;

function ensureProcessLocalFls(): void {
    const process = System.getInstance().process;
    // Process.reset() reuses the same Process object — key on resetGeneration too.
    const gen = process?.resetGeneration ?? 0;
    if (process === flsOwnerProcess && gen === flsOwnerResetGeneration) return;
    flsOwnerProcess = process;
    flsOwnerResetGeneration = gen;
    allocated.clear();
    nextSlot = 1;
    hypercallDataManager.clearFlsSlots();
}

/** Explicit clear for System.reset → Kernel32.reset (before resetGeneration bumps). */
export function resetFlsState(): void {
    flsOwnerProcess = null;
    flsOwnerResetGeneration = -1;
    allocated.clear();
    nextSlot = 1;
    hypercallDataManager.clearFlsSlots();
}

/** Values are guest memory (the per-thread FLS blocks) and travel with it; `values` is kept
 *  only so the kernel32 schema stays put, and is always empty. */
export function captureFls(): { allocated: number[]; values: Array<[number, Array<[number, number]>]>; nextSlot: number } {
    return { allocated: [...allocated], values: [], nextSlot };
}

export function restoreFls(state: { allocated: number[]; values: Array<[number, Array<[number, number]>]>; nextSlot: number }): void {
    const process = System.getInstance().process;
    flsOwnerProcess = process;
    flsOwnerResetGeneration = process?.resetGeneration ?? 0;
    allocated.clear();
    for (const slot of state.allocated) allocated.add(slot);
    nextSlot = state.nextSlot;
}

function currentTid(): number {
    return System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
}

export const exports: Record<string, ThunkImplementation> = {
    FlsAlloc(ctx, mem, args) {
        ensureProcessLocalFls();
        if (nextSlot >= FLS_INDEX_LIMIT) return FLS_OUT_OF_INDEXES;
        const index = nextSlot++;
        allocated.add(index);
        hypercallDataManager.ensureFlsCurrentThread(currentTid());
        hypercallDataManager.setFlsSlot(index, true, 0, currentTid());
        return index;
    },

    FlsGetValue(ctx, mem, args) {
        ensureProcessLocalFls();
        const scheduler = System.getInstance().scheduler;
        const value = scheduler.flsGetValue(args[0] >>> 0);
        // As NT: success clears LastError so a NULL value is distinguishable from failure.
        scheduler.setLastError(value === undefined ? ERROR_INVALID_PARAMETER : 0);
        return value ?? 0;
    },

    FlsSetValue(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0] >>> 0;
        const lpFlsData = args[1] >>> 0;
        const scheduler = System.getInstance().scheduler;
        if (!scheduler.flsSetValue(dwFlsIndex, lpFlsData)) {
            scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        // The WASM FlsGetValue serves allocated indices from the page cache.
        if (allocated.has(dwFlsIndex)) {
            const tid = currentTid();
            hypercallDataManager.ensureFlsCurrentThread(tid);
            hypercallDataManager.setFlsSlot(dwFlsIndex, true, lpFlsData, tid);
        }
        return 1;
    },

    FlsFree(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0] >>> 0;
        if (!allocated.delete(dwFlsIndex)) return 0;
        System.getInstance().scheduler.flsClearSlotAllThreads(dwFlsIndex);
        hypercallDataManager.setFlsSlot(dwFlsIndex, false, 0);
        return 1;
    },
};
