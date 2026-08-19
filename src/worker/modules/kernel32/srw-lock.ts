/**
 * Slim reader/writer lock state for kernel32 SRW APIs.
 * Guest SRWLOCK is an opaque pointer-sized word; real state lives here.
 */

import { Mem } from "../../core/memory/mem-accessor";

export interface SrwEventFactory {
    createEvent(manualReset: boolean, initialState: boolean): number;
}

export type SrwMode = "free" | "exclusive" | "shared";

export interface SrwLockState {
    mode: SrwMode;
    exclusiveOwner: number;
    sharedHolders: Set<number>;
    waitEvent: number;
}

const locks = new Map<number, SrwLockState>();

export function resetSrwLock(lockPtr: number): void {
    if (!lockPtr) return;
    locks.delete(lockPtr);
    Mem.writeUint32(lockPtr, 0);
}

/** Drop every host-side SRWLOCK record on game switch (guest memory is rewound). */
export function resetAllSrwLocks(): void {
    locks.clear();
}

function getOrCreate(lockPtr: number): SrwLockState {
    let st = locks.get(lockPtr);
    if (!st) {
        st = { mode: "free", exclusiveOwner: 0, sharedHolders: new Set(), waitEvent: 0 };
        locks.set(lockPtr, st);
    }
    return st;
}

export function ensureSrwWaitEvent(lockPtr: number, sched: SrwEventFactory): number {
    const st = getOrCreate(lockPtr);
    if (!st.waitEvent) {
        st.waitEvent = sched.createEvent(false, false);
    }
    return st.waitEvent;
}

/**
 * The lock's lazily-created wait event, or 0 when nothing has ever blocked on it.
 * A release must consult this BEFORE applying itself — a release cannot be undone — to
 * learn whether it also owes the scheduler a wake.
 */
export function srwWaitEvent(lockPtr: number): number {
    return locks.get(lockPtr)?.waitEvent ?? 0;
}

export function tryAcquireSrwExclusive(lockPtr: number, threadId: number): boolean {
    if (!lockPtr) return false;
    const st = getOrCreate(lockPtr);
    if (st.mode !== "free") return false;
    st.mode = "exclusive";
    st.exclusiveOwner = threadId;
    Mem.writeUint32(lockPtr, 1);
    return true;
}

export function tryAcquireSrwShared(lockPtr: number, threadId: number): boolean {
    if (!lockPtr) return false;
    const st = getOrCreate(lockPtr);
    if (st.mode === "exclusive") return false;
    if (st.sharedHolders.has(threadId)) return false;
    st.mode = "shared";
    st.sharedHolders.add(threadId);
    Mem.writeUint32(lockPtr, st.sharedHolders.size);
    return true;
}

export function grantSrwOnWake(lockPtr: number, threadId: number, exclusive: boolean): boolean {
    return exclusive
        ? tryAcquireSrwExclusive(lockPtr, threadId)
        : tryAcquireSrwShared(lockPtr, threadId);
}

export function releaseSrwExclusive(lockPtr: number, threadId: number): number {
    if (!lockPtr) return 0;
    const st = locks.get(lockPtr);
    if (!st || st.mode !== "exclusive") return 0;
    if (st.exclusiveOwner !== 0 && st.exclusiveOwner !== threadId) return 0;
    st.mode = "free";
    st.exclusiveOwner = 0;
    Mem.writeUint32(lockPtr, 0);
    return st.waitEvent;
}

export function releaseSrwShared(lockPtr: number, threadId: number): number {
    if (!lockPtr) return 0;
    const st = locks.get(lockPtr);
    if (!st || st.mode !== "shared" || !st.sharedHolders.has(threadId)) return 0;
    st.sharedHolders.delete(threadId);
    if (st.sharedHolders.size === 0) {
        st.mode = "free";
        Mem.writeUint32(lockPtr, 0);
        return st.waitEvent;
    }
    Mem.writeUint32(lockPtr, st.sharedHolders.size);
    return 0;
}
