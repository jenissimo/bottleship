/**
 * SyncObjectManager — Event/Mutex/Semaphore management.
 * Provides create/signal/check/consume for kernel synchronization objects.
 */

import { Logger, LogCategory } from '../logger';
import { SystemResourceProvider } from '../resources/system-resource-provider';
import { hypercallDataManager } from '../cpu/hypercall-data';
import {
    KernelEventObject,
    KernelSemaphoreObject,
    KernelMutexObject,
    KernelThreadObject,
    KernelObject,
    WaitDecision,
    ThreadState,
    WAIT_OBJECT_0,
    WAIT_ABANDONED,
    WAIT_FAILED,
} from './types';

export type ThreadLookupFn = (threadId: number) => { state: ThreadState } | null;

/**
 * Ring of signal/wait transitions on kernel sync objects.
 *
 * A deadlock's state — "T1 waits on an unsignalled event" — never says WHY: the signal may
 * have been lost, consumed by the wrong waiter, or reset from under the waiter. Only the
 * ORDER answers that, and by the time the hang is observable the order is gone. Costs one
 * array store per recorded transition; the ring is fixed-size and never grows.
 *
 * NOT A COMPLETE HISTORY, and it says so in its own readout: SetEvent on an event with no
 * waiters, and an auto-reset consume, are served entirely inside the WASM hypercall tier and
 * never reach JS. That is exactly the lost-signal shape (signal before the waiter parks), so
 * an ABSENT entry must never be read as "the signal was never sent".
 */
export const SYNC_RING_NOTE =
    "incomplete by construction: SetEvent with no waiters and auto-reset consumes are served "
    + "in the WASM hypercall tier and never reach JS — a missing entry is not proof of a missing signal";
const SYNC_RING_SIZE = 512;
interface SyncRingEntry { t: number; op: string; handle: number; tid: number; detail?: string; repeat?: number }
const syncRing: SyncRingEntry[] = [];
let syncRingWrite = 0;

export function recordSyncEvent(op: string, handle: number, tid: number, detail?: string): void {
    // Coalesce an immediately-repeating transition into a count. A guest that polls an event
    // in a 10 Hz reset+timed-wait loop otherwise floods the ring within seconds and scrolls
    // out the one submission that explains the hang — the repetition is the least
    // informative part of the history and must not cost the most space.
    const prevIdx = (syncRingWrite - 1 + SYNC_RING_SIZE) % SYNC_RING_SIZE;
    const prev = syncRing.length > 0 ? syncRing[Math.min(prevIdx, syncRing.length - 1)] : undefined;
    if (prev && prev.op === op && prev.handle === (handle >>> 0) && prev.tid === (tid >>> 0) && prev.detail === detail) {
        prev.repeat = (prev.repeat ?? 1) + 1;
        prev.t = performance.now();
        return;
    }
    const entry: SyncRingEntry = { t: performance.now(), op, handle: handle >>> 0, tid: tid >>> 0, detail };
    if (syncRing.length < SYNC_RING_SIZE) syncRing.push(entry);
    else syncRing[syncRingWrite] = entry;
    syncRingWrite = (syncRingWrite + 1) % SYNC_RING_SIZE;
}

/** Oldest-first copy of the sync ring. */
export function describeSyncRing(limit = SYNC_RING_SIZE): SyncRingEntry[] {
    const ordered = syncRing.length < SYNC_RING_SIZE
        ? syncRing.slice()
        : syncRing.slice(syncRingWrite).concat(syncRing.slice(0, syncRingWrite));
    return ordered.slice(-limit);
}

export class SyncObjectManager {
    private resourceProvider = SystemResourceProvider.getInstance();
    private eventHandles = new Set<number>();
    private semaphoreHandles = new Set<number>();
    private mutexHandles = new Set<number>();

    /**
     * Every event/semaphore/mutex with its live state — the other half of a thread dump's
     * waitHandles. A deadlock is only readable as the PAIR: who waits on which handle, and
     * whether that handle is signalled.
     */
    describeAll(): Array<Record<string, unknown>> {
        const out: Array<Record<string, unknown>> = [];
        for (const h of this.eventHandles) {
            const e = this._getEvent(h);
            if (e) out.push({ handle: h, kind: "event", manualReset: e.manualReset, signaled: e.signaled, pendingWake: e.pendingWake ?? false });
        }
        for (const h of this.semaphoreHandles) {
            const s = this._getSemaphore(h);
            if (s) out.push({ handle: h, kind: "semaphore", count: s.count, max: s.max });
        }
        for (const h of this.mutexHandles) {
            const m = this._getMutex(h);
            if (m) out.push({ handle: h, kind: "mutex", owner: m.ownerThreadId, recursion: m.recursion });
        }
        return out;
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    createEvent(manualReset: boolean, initialState: boolean): number {
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'event', manualReset, signaled: initialState,
        } as KernelEventObject);
        this.eventHandles.add(handle);
        hypercallDataManager.registerEventMirror(handle, manualReset, initialState);
        return handle;
    }

    setEvent(handle: number): boolean {
        const event = this._getEvent(handle);
        if (!event) return false;
        event.signaled = true;
        if (event.manualReset) {
            event.pendingWake = true;
        }
        hypercallDataManager.writeEventMirrorSignaled(handle, true, event.manualReset);
        return true;
    }

    resetEvent(handle: number): boolean {
        const event = this._getEvent(handle);
        if (!event) return false;
        event.signaled = false;
        event.pendingWake = false;
        hypercallDataManager.writeEventMirrorSignaled(handle, false, event.manualReset);
        return true;
    }

    // ─── Semaphores ─────────────────────────────────────────────────────────

    createSemaphore(initialCount: number, maxCount: number): number {
        const count = Math.max(0, initialCount | 0);
        const max = Math.max(1, maxCount | 0);
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'semaphore', count: Math.min(count, max), max,
        } as KernelSemaphoreObject);
        this.semaphoreHandles.add(handle);
        return handle;
    }

    releaseSemaphore(handle: number, releaseCount: number): { ok: boolean; previousCount: number } {
        const sem = this._getSemaphore(handle);
        if (!sem) return { ok: false, previousCount: 0 };
        const rc = releaseCount | 0;
        if (rc <= 0) return { ok: false, previousCount: sem.count };
        const prev = sem.count;
        if (sem.count + rc > sem.max) return { ok: false, previousCount: prev };
        sem.count += rc;
        return { ok: true, previousCount: prev };
    }

    // ─── Mutexes ────────────────────────────────────────────────────────────

    createMutex(initialOwner: boolean, ownerThreadId: number): number {
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'mutex',
            ownerThreadId: initialOwner ? ownerThreadId : null,
            recursion: initialOwner ? 1 : 0,
            abandoned: false,
        } as KernelMutexObject);
        this.mutexHandles.add(handle);
        hypercallDataManager.registerMutexMirror(
            handle,
            initialOwner ? ownerThreadId : null,
            initialOwner ? 1 : 0,
        );
        return handle;
    }

    releaseMutex(handle: number, ownerThreadId: number): boolean {
        const mutex = this._getMutex(handle);
        if (!mutex) return false;
        const mirrored = hypercallDataManager.readMutexMirrorState(handle);
        // A valid mirror with owner === null means the mutex is FREE (e.g. a WASM
        // fast-path Release already ran) — `mirrored?.owner ?? ...` would misread
        // that as "no mirror" and fall back to the stale JS owner, letting a
        // second Release succeed on an already-free mutex.
        const owner = mirrored ? mirrored.owner : mutex.ownerThreadId;
        if (owner !== ownerThreadId) {
            Logger.warn(LogCategory.KERNEL32,
                `ReleaseMutex: T${ownerThreadId} not owner (owner=${owner === null ? 'none' : `T${owner}`})`);
            return false;
        }
        const recursion = mirrored ? mirrored.recursion : mutex.recursion;
        if (recursion > 0) mutex.recursion = recursion - 1;
        else mutex.recursion = 0;
        if (mutex.recursion === 0) mutex.ownerThreadId = null;
        hypercallDataManager.writeMutexMirror(handle, mutex.ownerThreadId, mutex.recursion);
        return true;
    }

    releaseAllMutexesForThread(ownerThreadId: number): number[] {
        const released: number[] = [];
        for (const handle of this.mutexHandles) {
            const mutex = this._getMutex(handle);
            if (!mutex) continue;
            const owner = this._mutexOwner(mutex, handle);
            if (owner !== ownerThreadId) continue;
            mutex.ownerThreadId = null;
            mutex.recursion = 0;
            mutex.abandoned = true;
            // Preserve the live has-waiters bit (pass undefined, not false): an abandoned mutex
            // may still have real waiters, and clearing the bit would let a later WASM fast-path
            // ReleaseMutex skip the JS wake. syncHandleWaiters keeps the bit accurate otherwise.
            hypercallDataManager.writeMutexMirror(handle, null, 0, undefined, true);
            released.push(handle);
        }
        return released;
    }

    // ─── Wait checking ──────────────────────────────────────────────────────

    validateHandles(handles: number[]): boolean {
        if (handles.length === 0) return false;
        for (const h of handles) {
            const obj = this.resourceProvider.getKernelObject(h) as KernelObject | null;
            if (!obj) return false;
            if (obj.kind !== 'thread' && obj.kind !== 'event' &&
                obj.kind !== 'semaphore' && obj.kind !== 'mutex') return false;
        }
        return true;
    }

    checkWait(handles: number[], waitAll: boolean, threadId: number, threadLookup: ThreadLookupFn): WaitDecision {
        if (handles.length === 0) {
            return { ready: true, result: WAIT_FAILED, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
        }
        return waitAll
            ? this._checkWaitAll(handles, threadId, threadLookup)
            : this._checkWaitAny(handles, threadId, threadLookup);
    }

    consumeWait(decision: WaitDecision, threadId: number): void {
        for (const h of decision.consumeAutoReset) {
            const e = this._getEvent(h);
            if (e && !e.manualReset) {
                recordSyncEvent("consume", h, threadId);
                e.signaled = false;
                hypercallDataManager.writeEventMirrorSignaled(h, false, false);
            }
        }
        for (const h of decision.consumePendingWake ?? []) {
            const e = this._getEvent(h);
            if (e?.manualReset) {
                e.pendingWake = false;
                hypercallDataManager.clearEventMirrorPendingWake(h);
            }
        }
        for (const h of decision.consumeSemaphores) {
            const s = this._getSemaphore(h);
            if (s && s.count > 0) s.count--;
        }
        for (const h of decision.consumeMutexes) {
            const m = this._getMutex(h);
            if (m) {
                const mirrored = hypercallDataManager.readMutexMirrorState(h);
                if (mirrored) {
                    m.ownerThreadId = mirrored.owner;
                    m.recursion = mirrored.recursion;
                }
                m.abandoned = false;
                if (m.ownerThreadId === null) { m.ownerThreadId = threadId; m.recursion = 1; }
                else if (m.ownerThreadId === threadId) m.recursion++;
                hypercallDataManager.writeMutexMirror(h, m.ownerThreadId, m.recursion, undefined, false);
            }
        }
    }

    isSignaled(handle: number, threadId: number, threadLookup: ThreadLookupFn): boolean {
        const obj = this.resourceProvider.getKernelObject(handle) as KernelObject | null;
        if (!obj) return false;
        switch (obj.kind) {
            case 'thread': { const t = threadLookup((obj as KernelThreadObject).threadId); return t !== null && t.state === ThreadState.TERMINATED; }
            case 'event': return this._eventReady(obj as KernelEventObject, handle);
            case 'semaphore': return (obj as KernelSemaphoreObject).count > 0;
            case 'mutex': { const m = obj as KernelMutexObject; const owner = this._mutexOwner(m, handle); return owner === null || owner === threadId; }
        }
        return false;
    }

    describeHandle(handle: number): string {
        const obj = this.resourceProvider.getKernelObject(handle) as KernelObject | null;
        if (!obj) return 'INVALID';
        switch (obj.kind) {
            case 'event': { const e = obj as KernelEventObject; return `event(sig=${e.signaled ? 1 : 0},manual=${e.manualReset ? 1 : 0},wake=${e.pendingWake ? 1 : 0})`; }
            case 'semaphore': { const s = obj as KernelSemaphoreObject; return `sem(${s.count}/${s.max})`; }
            case 'mutex': { const m = obj as KernelMutexObject; return `mutex(owner=${m.ownerThreadId ?? 'none'})`; }
            case 'thread': return `thread(${(obj as KernelThreadObject).threadId})`;
        }
    }

    reset(): void {
        for (const h of this.eventHandles) this.resourceProvider.unregisterKernelObject(h);
        for (const h of this.semaphoreHandles) this.resourceProvider.unregisterKernelObject(h);
        for (const h of this.mutexHandles) this.resourceProvider.unregisterKernelObject(h);
        this.eventHandles.clear();
        this.semaphoreHandles.clear();
        this.mutexHandles.clear();
        hypercallDataManager.clearEventMirrors();
    }

    private _mutexOwner(m: KernelMutexObject, handle: number): number | null {
        const mirrored = hypercallDataManager.readMutexMirrorState(handle);
        if (mirrored) return mirrored.owner;
        return m.ownerThreadId;
    }

    private _mutexAbandoned(m: KernelMutexObject, handle: number): boolean {
        const mirrored = hypercallDataManager.readMutexMirrorState(handle);
        if (mirrored) return mirrored.abandoned;
        return m.abandoned;
    }

    // ─── Private ────────────────────────────────────────────────────────────

    private _getEvent(h: number): KernelEventObject | null {
        const o = this.resourceProvider.getKernelObject(h) as KernelObject | null;
        return o && o.kind === 'event' ? o as KernelEventObject : null;
    }
    private _getSemaphore(h: number): KernelSemaphoreObject | null {
        const o = this.resourceProvider.getKernelObject(h) as KernelObject | null;
        return o && o.kind === 'semaphore' ? o as KernelSemaphoreObject : null;
    }
    private _getMutex(h: number): KernelMutexObject | null {
        const o = this.resourceProvider.getKernelObject(h) as KernelObject | null;
        return o && o.kind === 'mutex' ? o as KernelMutexObject : null;
    }

    private _eventReady(e: KernelEventObject, handle: number): boolean {
        const st = this._getEventState(e, handle);
        return st.signaled || !!(st.manualReset && st.pendingWake);
    }

    private _getEventState(e: KernelEventObject, handle: number): { signaled: boolean; manualReset: boolean; pendingWake: boolean } {
        const mirrored = hypercallDataManager.readEventMirrorState(handle);
        if (mirrored) return mirrored;
        return { signaled: e.signaled, manualReset: e.manualReset, pendingWake: !!e.pendingWake };
    }

    private _eventWaitConsume(h: number, e: KernelEventObject): { consumeAutoReset: number[]; consumePendingWake?: number[] } {
        const st = this._getEventState(e, h);
        if (!st.manualReset) return { consumeAutoReset: [h] };
        if (st.pendingWake) return { consumeAutoReset: [], consumePendingWake: [h] };
        return { consumeAutoReset: [] };
    }

    private _checkWaitAll(handles: number[], threadId: number, tl: ThreadLookupFn): WaitDecision {
        const autoReset: number[] = [];
        const pendingWake: number[] = [];
        const sems: number[] = [];
        const mutexes: number[] = [];
        let anyAbandoned = false;
        for (const h of handles) {
            const obj = this.resourceProvider.getKernelObject(h) as KernelObject | null;
            if (!obj) return { ready: true, result: WAIT_FAILED, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
            switch (obj.kind) {
                case 'thread': { const t = tl((obj as KernelThreadObject).threadId); if (!t || t.state !== ThreadState.TERMINATED) return _notReady; break; }
                case 'event': {
                    const e = obj as KernelEventObject;
                    const st = this._getEventState(e, h);
                    if (!this._eventReady(e, h)) return _notReady;
                    if (!st.manualReset) autoReset.push(h);
                    else if (st.pendingWake) pendingWake.push(h);
                    break;
                }
                case 'semaphore': { const s = obj as KernelSemaphoreObject; if (s.count <= 0) return _notReady; sems.push(h); break; }
                case 'mutex': { const m = obj as KernelMutexObject; const owner = this._mutexOwner(m, h); if (owner !== null && owner !== threadId) return _notReady; if (this._mutexAbandoned(m, h)) anyAbandoned = true; mutexes.push(h); break; }
            }
        }
        return {
            ready: true,
            result: anyAbandoned ? WAIT_ABANDONED : WAIT_OBJECT_0,
            consumeAutoReset: autoReset,
            consumePendingWake: pendingWake.length ? pendingWake : undefined,
            consumeSemaphores: sems,
            consumeMutexes: mutexes,
        };
    }

    private _checkWaitAny(handles: number[], threadId: number, tl: ThreadLookupFn): WaitDecision {
        for (let i = 0; i < handles.length; i++) {
            const h = handles[i];
            const obj = this.resourceProvider.getKernelObject(h) as KernelObject | null;
            if (!obj) return { ready: true, result: WAIT_FAILED, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
            switch (obj.kind) {
                case 'thread': { const t = tl((obj as KernelThreadObject).threadId); if (t && t.state === ThreadState.TERMINATED) return { ready: true, result: WAIT_OBJECT_0 + i, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] }; break; }
                case 'event': {
                    const e = obj as KernelEventObject;
                    if (this._eventReady(e, h)) {
                        const consume = this._eventWaitConsume(h, e);
                        return {
                            ready: true,
                            result: WAIT_OBJECT_0 + i,
                            consumeAutoReset: consume.consumeAutoReset ?? [],
                            consumePendingWake: consume.consumePendingWake,
                            consumeSemaphores: [],
                            consumeMutexes: [],
                        };
                    }
                    break;
                }
                case 'semaphore': { const s = obj as KernelSemaphoreObject; if (s.count > 0) return { ready: true, result: WAIT_OBJECT_0 + i, consumeAutoReset: [], consumeSemaphores: [h], consumeMutexes: [] }; break; }
                case 'mutex': { const m = obj as KernelMutexObject; const owner = this._mutexOwner(m, h); if (owner === null || owner === threadId) return { ready: true, result: (this._mutexAbandoned(m, h) ? WAIT_ABANDONED : WAIT_OBJECT_0) + i, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [h] }; break; }
            }
        }
        return _notReady;
    }
}

const _notReady: WaitDecision = { ready: false, result: 0, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
