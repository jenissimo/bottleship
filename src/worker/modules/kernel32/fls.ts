/**
 * Kernel32 FLS (Fiber Local Storage) functions
 *
 * Slot indices are process-global, but VALUES are per-fiber — per-THREAD here
 * (no fiber support): the UCRT stores each thread's _ptd in one shared slot
 * index, so a process-global value table would hand thread A's _ptd to
 * thread B. FlsFree callbacks are not invoked (callback ignored).
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { hypercallDataManager } from '../../core/cpu/hypercall-data';

const FLS_OUT_OF_INDEXES = 0xffffffff;
const MAX_SLOTS = 128;

const allocated = new Set<number>();
const valuesByThread = new Map<number, Map<number, number>>();
let nextSlot = 1;
let flsOwnerProcess: unknown = null;

function ensureProcessLocalFls(): void {
    const process = System.getInstance().process;
    if (process === flsOwnerProcess) return;
    flsOwnerProcess = process;
    allocated.clear();
    valuesByThread.clear();
    nextSlot = 1;
    hypercallDataManager.clearFlsSlots();
}

function currentTid(): number {
    return System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
}

export const exports: Record<string, ThunkImplementation> = {
    FlsAlloc(ctx, mem, args) {
        ensureProcessLocalFls();
        if (nextSlot > MAX_SLOTS) return FLS_OUT_OF_INDEXES;
        const index = nextSlot++;
        allocated.add(index);
        hypercallDataManager.setFlsSlot(index, true, 0, currentTid());
        return index;
    },

    FlsGetValue(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0];
        if (!allocated.has(dwFlsIndex)) return 0;
        return valuesByThread.get(currentTid())?.get(dwFlsIndex) ?? 0;
    },

    FlsSetValue(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0];
        const lpFlsData = args[1];
        if (!allocated.has(dwFlsIndex)) return 0;
        const tid = currentTid();
        let values = valuesByThread.get(tid);
        if (!values) { values = new Map(); valuesByThread.set(tid, values); }
        values.set(dwFlsIndex, lpFlsData >>> 0);
        hypercallDataManager.setFlsSlot(dwFlsIndex, true, lpFlsData >>> 0, tid);
        return 1;
    },

    FlsFree(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0];
        if (!allocated.delete(dwFlsIndex)) return 0;
        for (const values of valuesByThread.values()) values.delete(dwFlsIndex);
        hypercallDataManager.setFlsSlot(dwFlsIndex, false, 0);
        return 1;
    },
};
