/**
 * TimerWheel — Central min-heap for ALL timed operations.
 *
 * Every timer in the system goes through here:
 * - Sleep timeout, WaitFor* timeout
 * - SetTimer (user32), timeSetEvent (winmm)
 * - SetWaitableTimer (kernel32)
 * - IDirectSoundNotify cursor polling
 *
 * Sub-1ms timers are coalesced to 1ms to prevent timer storms.
 */

import { TimerKind } from './types';
import { Logger, LogCategory } from '../logger';

export interface TimerEntry {
    id: number;
    fireAt: number;        // Absolute time (ms)
    intervalMs: number;    // 0 = one-shot, >0 = periodic
    kind: TimerKind;
    owner: number;
    arg: number;
    cancelled: boolean;
    heapIndex: number;     // -1 while popped/active, otherwise index in heap
}

/** Minimum timer resolution — prevents timer storms */
const COALESCE_MS = 1;
const TIMER_KIND_COUNT = TimerKind.MIDI_SYNTH + 1;

export const TIMER_PHASE_EVERY = 0;
export const TIMER_PHASE_DUE = 1;

export type TimerHandler = (owner: number, arg: number, timerId: number) => void;

/** @transient(behaviour, not data: each kind's owner module installs its handler when it is created) */
const timerHandlers: (TimerHandler | undefined)[] = [];

/**
 * Install the one handler for `kind`. A kind has a single owner, so a second, different
 * handler is a bug (a factory that ran twice would silently strand the first one's
 * timers): it is logged and the first handler stays. Owners that are rebuilt on purpose
 * use replaceTimerHandler.
 */
export function setTimerHandler(kind: TimerKind, handler: TimerHandler): void {
    const current = timerHandlers[kind];
    if (current && current !== handler) {
        Logger.error(LogCategory.THREAD, `TimerWheel: kind ${kind} already has a handler; the new one is ignored`);
        return;
    }
    timerHandlers[kind] = handler;
}

export function replaceTimerHandler(kind: TimerKind, handler: TimerHandler): void {
    timerHandlers[kind] = handler;
}

/** Drop the handler of `kind` so a deliberately rebuilt owner (a test fixture) can install its own. */
export function clearTimerHandler(kind: TimerKind): void {
    timerHandlers[kind] = undefined;
}

export function getTimerHandler(kind: TimerKind): TimerHandler | undefined {
    return timerHandlers[kind];
}

function isWinmmPaced(kind: TimerKind): boolean {
    return kind === TimerKind.WINMM_TIMER || kind === TimerKind.JOYSTICK_CAPTURE
        || kind === TimerKind.WAVEOUT_COMPLETION;
}
/**
 * Coarser floor for winmm timeSetEvent timers (TimerKind.WINMM_TIMER).
 *
 * These re-arm aggressively: NFS Porsche's catch-up MM-timer recomputes
 * `uDelay = target - GetTickCount() - 1` each fire and clamps it to 1ms while the
 * emulator is "behind". During an all-threads-idle block the JS wall-pump
 * (scheduler.pollTimeouts) drives poll() at wall-rate, so a 1ms re-arm becomes a
 * ~1000Hz storm (~34% of worker CPU on one callback). Flooring WINMM timers to 5ms
 * caps that at ~200Hz — far above any software-mixer cadence need, and the games'
 * 16.16 fixed-point catch-up accumulators self-adjust to the coarser dt (real
 * Win9x/2000 winmm resolution is itself 10-15ms). Other timer kinds keep COALESCE_MS.
 */
const WINMM_COALESCE_MS = 5;

export class TimerWheel {
    private heap: TimerEntry[] = [];
    private entries = new Map<number, TimerEntry>();
    private activeCallbacks = new Map<number, TimerEntry>();
    private nextId = 1;
    private _firedCount = 0;
    private readonly boundHandlers: (TimerHandler | undefined)[] = [];

    bind(kind: TimerKind, handler: TimerHandler): void {
        this.boundHandlers[kind] = handler;
    }
    /** DIAG: per-kind fired tally (index by TimerKind). Confirms the WINMM storm. */
    private _firedByKind: number[] = new Array(TIMER_KIND_COUNT).fill(0);

    /**
     * Add a timer. Returns timer ID for cancellation.
     */
    add(delayMs: number, periodic: boolean, kind: TimerKind, owner: number, nowMs: number, arg = 0): number {
        const clamped = this.clampDelay(delayMs, kind);
        const id = this.nextId++;
        const entry: TimerEntry = {
            id,
            fireAt: nowMs + clamped,
            intervalMs: periodic ? clamped : 0,
            kind,
            owner,
            arg,
            cancelled: false,
            heapIndex: -1,
        };
        this.entries.set(id, entry);
        this._heapPush(entry);
        return id;
    }

    /**
     * Move an existing timer to a new deadline without allocating a new entry.
     * Used by subsystems that preserve a stable wheel entry while their public
     * API surface re-arms logically one-shot timers.
     */
    reschedule(timerId: number, delayMs: number, periodic: boolean, kind: TimerKind, nowMs: number): boolean {
        const clamped = this.clampDelay(delayMs, kind);
        const entry = this.entries.get(timerId);
        if (!entry || entry.cancelled) return false;

        entry.fireAt = nowMs + clamped;
        entry.intervalMs = periodic ? clamped : 0;
        entry.kind = kind;

        if (this.activeCallbacks.get(timerId) === entry) {
            return true;
        }

        if (entry.heapIndex >= 0 && this.heap[entry.heapIndex] === entry) {
            this._siftFrom(entry.heapIndex);
            return true;
        }

        return false;
    }

    /**
     * Cancel a timer by ID. Returns true if found.
     */
    cancel(timerId: number): boolean {
        const entry = this.entries.get(timerId);
        if (!entry) return false;
        entry.cancelled = true;
        this.entries.delete(timerId);
        return true;
    }

    /**
     * Fire all expired timers. Returns count of fired timers.
     * Periodic timers are re-added automatically.
     */
    poll(nowMs: number): number {
        let fired = 0;
        while (this.heap.length > 0) {
            const top = this.heap[0];

            // Skip cancelled entries
            if (top.cancelled) {
                const cancelled = this._heapPop();
                this.entries.delete(cancelled.id);
                continue;
            }

            if (top.fireAt > nowMs) break;

            this._heapPop();
            fired++;
            this._firedByKind[top.kind] = (this._firedByKind[top.kind] ?? 0) + 1;

            // Fire callback. Keep the popped entry addressable so a callback can
            // cancel its own periodic timer before the post-callback re-arm.
            // Isolate per-callback faults: all timer kinds now share this one poll
            // loop (DSound notify / user32 TimerProc are non-trivial), so a throw
            // must NOT abort the remaining due timers this tick or unwind into the
            // scheduler tick — log and continue, matching the old setInterval-per-
            // timer isolation.
            this.activeCallbacks.set(top.id, top);
            try {
                const handler = this.boundHandlers[top.kind] ?? timerHandlers[top.kind];
                if (handler) handler(top.owner, top.arg, top.id);
                else Logger.error(LogCategory.THREAD, `TimerWheel: no handler for kind=${top.kind} (id=${top.id})`);
            } catch (e) {
                Logger.error(LogCategory.THREAD, `TimerWheel: callback threw (kind=${top.kind}, id=${top.id}): ${e}`);
            } finally {
                this.activeCallbacks.delete(top.id);
            }

            // Re-add periodic timers
            if (top.intervalMs > 0 && !top.cancelled) {
                top.fireAt = nowMs + top.intervalMs;
                this.entries.set(top.id, top);
                this._heapPush(top);
            } else {
                this.entries.delete(top.id);
            }
        }
        this._firedCount += fired;
        return fired;
    }

    /**
     * Time until next timer fires (ms). Returns Infinity if empty.
     */
    nextFireIn(nowMs: number): number {
        // Skip cancelled entries at the top
        while (this.heap.length > 0 && this.heap[0].cancelled) {
            const cancelled = this._heapPop();
            this.entries.delete(cancelled.id);
        }
        if (this.heap.length === 0) return Infinity;
        return Math.max(0, this.heap[0].fireAt - nowMs);
    }

    /**
     * Number of active (non-cancelled) timers. O(n) — use sparingly.
     */
    get activeCount(): number {
        let count = 0;
        for (let i = 0; i < this.heap.length; i++) {
            if (!this.heap[i].cancelled) count++;
        }
        return count;
    }

    get totalFired(): number {
        return this._firedCount;
    }

    /** DIAG: per-kind fired counts snapshot (index by TimerKind). */
    get firedByKind(): readonly number[] {
        return this._firedByKind;
    }

    get size(): number {
        return this.heap.length;
    }

    captureState(): { nextId: number; entries: number[][] } {
        if (this.activeCallbacks.size > 0) throw new Error('timer wheel: captured while a timer callback runs');
        const entries: number[][] = [];
        for (const e of this.entries.values()) {
            if (!e.cancelled) entries.push([e.id, e.fireAt, e.intervalMs, e.kind, e.owner, e.arg]);
        }
        entries.sort((a, b) => a[0] - b[0]);
        return { nextId: this.nextId, entries };
    }

    restoreState(state: { nextId: number; entries: number[][] }): void {
        this.reset();
        for (const [id, fireAt, intervalMs, kind, owner, arg] of state.entries) {
            const entry: TimerEntry = { id, fireAt, intervalMs, kind: kind as TimerKind, owner, arg, cancelled: false, heapIndex: -1 };
            this.entries.set(id, entry);
            this._heapPush(entry);
        }
        this.nextId = state.nextId;
    }

    reset(): void {
        for (const entry of this.entries.values()) {
            entry.cancelled = true;
            entry.heapIndex = -1;
        }
        this.heap.length = 0;
        this.entries.clear();
        this.activeCallbacks.clear();
        this.nextId = 1;
        this._firedCount = 0;
        this._firedByKind = new Array(TIMER_KIND_COUNT).fill(0);
    }

    private clampDelay(delayMs: number, kind: TimerKind): number {
        const floor = isWinmmPaced(kind) ? WINMM_COALESCE_MS : COALESCE_MS;
        return Math.max(delayMs, floor);
    }

    // ─── Min-heap operations ────────────────────────────────────────────────

    /**
     * Ordering predicate: earlier fireAt first, ties broken by ascending id (FIFO,
     * since ids are monotonically assigned). Without the id tie-break, the pop order
     * among equal-fireAt timers depends on heap array layout / sift path and varies
     * run-to-run — a source of non-deterministic callback ordering when an idle
     * virtual-time jump makes several pumps (winmm / dsound / MSS / user32) come due
     * in the same poll. Deterministic order keeps SetEvent / TimerProc sequencing
     * reproducible.
     */
    private _before(a: TimerEntry, b: TimerEntry): boolean {
        return a.fireAt < b.fireAt || (a.fireAt === b.fireAt && a.id < b.id);
    }

    private _heapPush(entry: TimerEntry): void {
        entry.heapIndex = this.heap.length;
        this.heap.push(entry);
        this._siftUp(entry.heapIndex);
    }

    private _heapPop(): TimerEntry {
        const top = this.heap[0];
        const last = this.heap.pop()!;
        if (this.heap.length > 0) {
            this.heap[0] = last;
            last.heapIndex = 0;
            this._siftDown(0);
        }
        top.heapIndex = -1;
        return top;
    }

    private _siftFrom(i: number): void {
        const entry = this.heap[i];
        this._siftUp(i);
        this._siftDown(entry.heapIndex);
    }

    private _swap(i: number, j: number): void {
        const heap = this.heap;
        const tmp = heap[i];
        heap[i] = heap[j];
        heap[j] = tmp;
        heap[i].heapIndex = i;
        heap[j].heapIndex = j;
    }

    private _siftUp(i: number): void {
        const heap = this.heap;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this._before(heap[i], heap[parent])) break;
            this._swap(i, parent);
            i = parent;
        }
    }

    private _siftDown(i: number): void {
        const heap = this.heap;
        const n = heap.length;
        while (true) {
            let smallest = i;
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            if (left < n && this._before(heap[left], heap[smallest])) smallest = left;
            if (right < n && this._before(heap[right], heap[smallest])) smallest = right;
            if (smallest === i) break;
            this._swap(i, smallest);
            i = smallest;
        }
    }
}
