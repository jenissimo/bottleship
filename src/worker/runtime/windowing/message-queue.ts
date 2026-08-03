/**
 * High-performance message queue using ring buffer
 * - O(1) enqueue/dequeue
 * - Mouse move coalescing
 * - Priority-based retrieval (WM_TIMER last)
 */

import { TimeService } from "../time";

export interface Message {
    hwnd: number;
    message: number;
    wParam: number;
    lParam: number;
    time: number;
    ptX: number;  // screen coords for MSG.pt
    ptY: number;
    targetThreadId?: number;  // 0 or undefined = any thread; >0 = specific thread only
    keyStatePacked?: Uint8Array;
}

const WM_MOUSEMOVE = 0x0200;
const WM_PAINT = 0x000F;
const WM_TIMER = 0x0113;
let coalesceMouseMoveEnabled = true;

const QUEUE_SIZE = 256;
const KEY_STATE_BYTES = 256;

type PendingMessage = {
    wParam: number;
    lParam: number;
    time: number;
    ptX: number;
    ptY: number;
    targetThreadId: number;
    keyStatePacked?: Uint8Array;
};

(globalThis as Record<string, any>).h3QueueSetMouseMoveCoalescing = (enabled: boolean): boolean => {
    coalesceMouseMoveEnabled = !!enabled;
    return coalesceMouseMoveEnabled;
};

class RingBuffer {
    private capacity: number;
    private mask: number;
    private head = 0;
    private tail = 0;
    private count = 0;
    private hwnds: Uint32Array;
    private messages: Uint32Array;
    private wParams: Uint32Array;
    private lParams: Uint32Array;
    private times: Uint32Array;
    private ptXs: Int32Array;
    private ptYs: Int32Array;
    private targetThreadIds: Uint32Array;
    private keyStatePresent: Uint8Array;
    private keyStatesPacked: Uint8Array;

    constructor(capacity: number) {
        this.capacity = nextPowerOfTwo(capacity);
        this.mask = this.capacity - 1;
        this.hwnds = new Uint32Array(this.capacity);
        this.messages = new Uint32Array(this.capacity);
        this.wParams = new Uint32Array(this.capacity);
        this.lParams = new Uint32Array(this.capacity);
        this.times = new Uint32Array(this.capacity);
        this.ptXs = new Int32Array(this.capacity);
        this.ptYs = new Int32Array(this.capacity);
        this.targetThreadIds = new Uint32Array(this.capacity);
        this.keyStatePresent = new Uint8Array(this.capacity);
        this.keyStatesPacked = new Uint8Array(this.capacity * KEY_STATE_BYTES);
    }

    get length(): number {
        return this.count;
    }

    private setKeyStateSnapshot(idx: number, keyStatePacked?: Uint8Array): void {
        if (!keyStatePacked || keyStatePacked.length < KEY_STATE_BYTES) {
            this.keyStatePresent[idx] = 0;
            return;
        }
        this.keyStatePresent[idx] = 1;
        const offset = idx * KEY_STATE_BYTES;
        this.keyStatesPacked.set(keyStatePacked.subarray(0, KEY_STATE_BYTES), offset);
    }

    private getKeyStateSnapshot(idx: number): Uint8Array | undefined {
        if (this.keyStatePresent[idx] === 0) {
            return undefined;
        }
        const offset = idx * KEY_STATE_BYTES;
        return this.keyStatesPacked.slice(offset, offset + KEY_STATE_BYTES);
    }

    private matchesTargetThread(idx: number, callerThreadId: number): boolean {
        if (callerThreadId === 0) return true;
        const target = this.targetThreadIds[idx];
        return target === 0 || target === callerThreadId;
    }

    enqueue(
        hwnd: number,
        message: number,
        wParam: number,
        lParam: number,
        time: number,
        ptX = 0,
        ptY = 0,
        targetThreadId = 0,
        keyStatePacked?: Uint8Array
    ): void {
        if (this.count === this.capacity) {
            this.head = (this.head + 1) & this.mask;
            this.count--;
        }
        const idx = this.tail;
        this.hwnds[idx] = hwnd >>> 0;
        this.messages[idx] = message >>> 0;
        this.wParams[idx] = wParam >>> 0;
        this.lParams[idx] = lParam >>> 0;
        this.times[idx] = time >>> 0;
        this.ptXs[idx] = ptX | 0;
        this.ptYs[idx] = ptY | 0;
        this.targetThreadIds[idx] = targetThreadId >>> 0;
        this.setKeyStateSnapshot(idx, keyStatePacked);
        this.tail = (this.tail + 1) & this.mask;
        this.count++;
    }

    dequeue(callerThreadId = 0): Message | null {
        if (this.count === 0) return null;
        // If callerThreadId specified, scan for matching message (target=0 or target=caller)
        if (callerThreadId > 0) {
            for (let i = 0; i < this.count; i++) {
                const idx = (this.head + i) & this.mask;
                const target = this.targetThreadIds[idx];
                if (this.matchesTargetThread(idx, callerThreadId)) {
                    const result: Message = {
                        hwnd: this.hwnds[idx],
                        message: this.messages[idx],
                        wParam: this.wParams[idx],
                        lParam: this.lParams[idx],
                        time: this.times[idx],
                        ptX: this.ptXs[idx],
                        ptY: this.ptYs[idx],
                        targetThreadId: target,
                        keyStatePacked: this.getKeyStateSnapshot(idx),
                    };
                    // Remove by shifting earlier entries forward
                    for (let j = i; j > 0; j--) {
                        const dst = (this.head + j) & this.mask;
                        const src = (this.head + j - 1) & this.mask;
                        this.hwnds[dst] = this.hwnds[src];
                        this.messages[dst] = this.messages[src];
                        this.wParams[dst] = this.wParams[src];
                        this.lParams[dst] = this.lParams[src];
                        this.times[dst] = this.times[src];
                        this.ptXs[dst] = this.ptXs[src];
                        this.ptYs[dst] = this.ptYs[src];
                        this.targetThreadIds[dst] = this.targetThreadIds[src];
                        this.keyStatePresent[dst] = this.keyStatePresent[src];
                        if (this.keyStatePresent[src]) {
                            const dstOffset = dst * KEY_STATE_BYTES;
                            const srcOffset = src * KEY_STATE_BYTES;
                            this.keyStatesPacked.set(
                                this.keyStatesPacked.subarray(srcOffset, srcOffset + KEY_STATE_BYTES),
                                dstOffset
                            );
                        }
                    }
                    this.head = (this.head + 1) & this.mask;
                    this.count--;
                    return result;
                }
            }
            return null;
        }
        // No thread filter — take head
        const idx = this.head;
        this.head = (this.head + 1) & this.mask;
        this.count--;
        return {
            hwnd: this.hwnds[idx],
            message: this.messages[idx],
            wParam: this.wParams[idx],
            lParam: this.lParams[idx],
            time: this.times[idx],
            ptX: this.ptXs[idx],
            ptY: this.ptYs[idx],
            keyStatePacked: this.getKeyStateSnapshot(idx),
        };
    }

    peek(callerThreadId = 0): Message | null {
        if (this.count === 0) return null;
        if (callerThreadId > 0) {
            for (let i = 0; i < this.count; i++) {
                const idx = (this.head + i) & this.mask;
                if (!this.matchesTargetThread(idx, callerThreadId)) continue;
                return {
                    hwnd: this.hwnds[idx],
                    message: this.messages[idx],
                    wParam: this.wParams[idx],
                    lParam: this.lParams[idx],
                    time: this.times[idx],
                    ptX: this.ptXs[idx],
                    ptY: this.ptYs[idx],
                };
            }
            return null;
        }
        const idx = this.head;
        return {
            hwnd: this.hwnds[idx],
            message: this.messages[idx],
            wParam: this.wParams[idx],
            lParam: this.lParams[idx],
            time: this.times[idx],
            ptX: this.ptXs[idx],
            ptY: this.ptYs[idx],
        };
    }

    /**
     * Dequeue first message matching the filter range.
     * If msgMin=0 and msgMax=0, matches all (same as dequeue()).
     * Removes the matched entry by shifting earlier entries forward to close the gap.
     */
    dequeueFiltered(msgMin: number, msgMax: number, callerThreadId = 0): Message | null {
        if (this.count === 0) return null;
        if (msgMin === 0 && msgMax === 0) return this.dequeue(callerThreadId);

        for (let i = 0; i < this.count; i++) {
            const idx = (this.head + i) & this.mask;
            const msg = this.messages[idx];
            if (msg >= msgMin && msg <= msgMax && this.matchesTargetThread(idx, callerThreadId)) {
                const result: Message = {
                    hwnd: this.hwnds[idx],
                    message: msg,
                    wParam: this.wParams[idx],
                    lParam: this.lParams[idx],
                    time: this.times[idx],
                    ptX: this.ptXs[idx],
                    ptY: this.ptYs[idx],
                    keyStatePacked: this.getKeyStateSnapshot(idx),
                };
                // Shift earlier entries forward to close the gap
                for (let j = i; j > 0; j--) {
                    const dst = (this.head + j) & this.mask;
                    const src = (this.head + j - 1) & this.mask;
                    this.hwnds[dst] = this.hwnds[src];
                    this.messages[dst] = this.messages[src];
                    this.wParams[dst] = this.wParams[src];
                    this.lParams[dst] = this.lParams[src];
                    this.times[dst] = this.times[src];
                    this.ptXs[dst] = this.ptXs[src];
                    this.ptYs[dst] = this.ptYs[src];
                    this.targetThreadIds[dst] = this.targetThreadIds[src];
                    this.keyStatePresent[dst] = this.keyStatePresent[src];
                    if (this.keyStatePresent[src]) {
                        const dstOffset = dst * KEY_STATE_BYTES;
                        const srcOffset = src * KEY_STATE_BYTES;
                        this.keyStatesPacked.set(
                            this.keyStatesPacked.subarray(srcOffset, srcOffset + KEY_STATE_BYTES),
                            dstOffset
                        );
                    }
                }
                this.head = (this.head + 1) & this.mask;
                this.count--;
                return result;
            }
        }
        return null;
    }

    /**
     * Peek first message matching the filter range (no removal).
     */
    peekFiltered(msgMin: number, msgMax: number, callerThreadId = 0): Message | null {
        if (this.count === 0) return null;
        if (msgMin === 0 && msgMax === 0) return this.peek(callerThreadId);

        for (let i = 0; i < this.count; i++) {
            const idx = (this.head + i) & this.mask;
            const msg = this.messages[idx];
            if (msg >= msgMin && msg <= msgMax && this.matchesTargetThread(idx, callerThreadId)) {
                return {
                    hwnd: this.hwnds[idx],
                    message: msg,
                    wParam: this.wParams[idx],
                    lParam: this.lParams[idx],
                    time: this.times[idx],
                    ptX: this.ptXs[idx],
                    ptY: this.ptYs[idx],
                };
            }
        }
        return null;
    }

    /**
     * Check if any message matches the filter range.
     */
    hasFiltered(msgMin: number, msgMax: number, callerThreadId = 0): boolean {
        if (this.count === 0) return false;

        for (let i = 0; i < this.count; i++) {
            const idx = (this.head + i) & this.mask;
            const msg = this.messages[idx];
            const matchesFilter = (msgMin === 0 && msgMax === 0) || (msg >= msgMin && msg <= msgMax);
            if (matchesFilter && this.matchesTargetThread(idx, callerThreadId)) return true;
        }
        return false;
    }
}

function nextPowerOfTwo(value: number): number {
    let v = value | 0;
    v--;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v |= v >> 16;
    v++;
    return v > 0 ? v : 1;
}

export class MessageQueue {
    // Separate queues for different priority
    private inputQueue = new RingBuffer(QUEUE_SIZE);  // High priority: mouse, keyboard
    private paintPending: Map<number, PendingMessage> = new Map(); // hwnd -> pending paint
    // USER synthesizes at most one pending WM_TIMER per (thread, window, id).
    // Keeping ticks as ordinary posts can permanently starve a modal loop's idle path.
    private timerPending: Map<string, { hwnd: number; pending: PendingMessage }> = new Map();

    // Mouse coalescing - only keep latest per hwnd
    private lastMouseMove: Map<number, PendingMessage> = new Map();
    private waiters: Array<{ deliver: (msg: Message) => void; settled: boolean; threadId: number }> = [];

    // Wake-reason telemetry: classifies how each waitForMessage park ends —
    // a real message delivered via drainWaiters (by msg type), a coalesced/paint
    // flushed on timeout, or the bare 4ms WM_NULL idle poll. Headline question:
    // is the GetMessage idle "waiting for work that isn't coming" (WM_NULL-dominated
    // = inherent) or steadily woken by a real driver (e.g. WM_TIMER frame pacing)?
    private wakeStats = {
        since: performance.now(),
        parkCount: 0,
        sumLatencyMs: 0,
        maxLatencyMs: 0,
        timeoutNull: 0,
        deliverByMsg: new Map<number, number>(),
        timeoutPendingByMsg: new Map<number, number>(),
    };

    private recordWake(kind: 'deliver' | 'timeout-pending' | 'null', msgType: number, parkStartMs: number): void {
        const lat = performance.now() - parkStartMs;
        const s = this.wakeStats;
        s.parkCount++;
        s.sumLatencyMs += lat;
        if (lat > s.maxLatencyMs) s.maxLatencyMs = lat;
        if (kind === 'null') s.timeoutNull++;
        else if (kind === 'deliver') s.deliverByMsg.set(msgType, (s.deliverByMsg.get(msgType) ?? 0) + 1);
        else s.timeoutPendingByMsg.set(msgType, (s.timeoutPendingByMsg.get(msgType) ?? 0) + 1);
    }

    /** Snapshot wake-reason telemetry (for msgWakeReport() console helper). */
    getWakeStats(): {
        windowMs: number; parkCount: number; avgLatencyMs: number; maxLatencyMs: number;
        timeoutNull: number; deliverByMsg: Array<{ msg: string; count: number }>;
        timeoutPendingByMsg: Array<{ msg: string; count: number }>;
    } {
        const s = this.wakeStats;
        const fmt = (m: Map<number, number>) => [...m.entries()]
            .map(([msg, count]) => ({ msg: '0x' + msg.toString(16), count }))
            .sort((a, b) => b.count - a.count);
        return {
            windowMs: Math.round(performance.now() - s.since),
            parkCount: s.parkCount,
            avgLatencyMs: s.parkCount > 0 ? +(s.sumLatencyMs / s.parkCount).toFixed(2) : 0,
            maxLatencyMs: +s.maxLatencyMs.toFixed(1),
            timeoutNull: s.timeoutNull,
            deliverByMsg: fmt(s.deliverByMsg),
            timeoutPendingByMsg: fmt(s.timeoutPendingByMsg),
        };
    }

    /** Reset wake-reason telemetry window. */
    resetWakeStats(): void {
        this.wakeStats.since = performance.now();
        this.wakeStats.parkCount = 0;
        this.wakeStats.sumLatencyMs = 0;
        this.wakeStats.maxLatencyMs = 0;
        this.wakeStats.timeoutNull = 0;
        this.wakeStats.deliverByMsg.clear();
        this.wakeStats.timeoutPendingByMsg.clear();
    }

    // Input poll callback - called when waiting for messages
    private inputPollCallback: (() => void) | null = null;

    // Last dequeued message coordinates/time for GetMessagePos/GetMessageTime
    lastDequeuedPtX = 0;
    lastDequeuedPtY = 0;
    lastDequeuedTime = 0;

    /** Track coordinates/time from the last dequeued message. */
    private trackDequeued(msg: Message): void {
        this.lastDequeuedPtX = msg.ptX ?? 0;
        this.lastDequeuedPtY = msg.ptY ?? 0;
        this.lastDequeuedTime = msg.time ?? 0;
    }

    /**
     * Register a callback that will be called to poll for input when waiting
     */
    setInputPollCallback(callback: () => void): void {
        this.inputPollCallback = callback;
    }

    /**
     * @returns true if a discrete message was queued (callers should update the WASM queue flag).
     *          false for coalesced (WM_MOUSEMOVE) or deferred (WM_PAINT) messages.
     */
    enqueue(
        hwnd: number,
        msg: number,
        wParam: number,
        lParam: number,
        ptX = 0,
        ptY = 0,
        targetThreadId = 0,
        keyStatePacked?: Uint8Array
    ): boolean {
        const time = TimeService.getInstance().nowMs() | 0;

        if (msg === WM_MOUSEMOVE && coalesceMouseMoveEnabled) {
            // Coalesce mouse moves - replace previous.
            // Do NOT wake waiters here: coalesced mouse moves are low-priority
            // and will be delivered when the next discrete event flushes them,
            // or when the waiter's 16ms timeout fires.  Waking on every coalesce
            // caused ~125fps spin in games using GetMessage/WaitMessage loops.
            this.lastMouseMove.set(hwnd, {
                wParam,
                lParam,
                time,
                ptX,
                ptY,
                targetThreadId,
                keyStatePacked: keyStatePacked ? keyStatePacked.slice(0, KEY_STATE_BYTES) : undefined,
            });
            return false;
        } else if (msg === WM_PAINT) {
            // Only one WM_PAINT per window (lowest priority).
            this.paintPending.set(hwnd, {
                wParam,
                lParam,
                time,
                ptX,
                ptY,
                targetThreadId,
                keyStatePacked: keyStatePacked ? keyStatePacked.slice(0, KEY_STATE_BYTES) : undefined,
            });
            // Must wake waiters + set the WASM queue flag — otherwise PeekMessage fast path
            // spins in guest code forever while paint sits in paintPending (HL launcher).
            this.drainWaiters();
            return true;
        } else if (msg === WM_TIMER) {
            const key = `${targetThreadId >>> 0}:${hwnd >>> 0}:${wParam >>> 0}`;
            this.timerPending.set(key, {
                hwnd: hwnd >>> 0,
                pending: {
                    wParam,
                    lParam,
                    time,
                    ptX,
                    ptY,
                    targetThreadId,
                    keyStatePacked: keyStatePacked ? keyStatePacked.slice(0, KEY_STATE_BYTES) : undefined,
                },
            });
            this.drainWaiters();
            return true;
        } else {
            // Flush any pending mouse move before other input
            const pendingMouse = this.lastMouseMove.get(hwnd);
            if (pendingMouse) {
                this.inputQueue.enqueue(
                    hwnd,
                    WM_MOUSEMOVE,
                    pendingMouse.wParam,
                    pendingMouse.lParam,
                    pendingMouse.time,
                    pendingMouse.ptX,
                    pendingMouse.ptY,
                    0,
                    pendingMouse.keyStatePacked
                );
                this.lastMouseMove.delete(hwnd);
            }
            this.inputQueue.enqueue(hwnd, msg, wParam, lParam, time, ptX, ptY, targetThreadId, keyStatePacked);
        }
        this.drainWaiters();
        return true;
    }

    dequeue(msgMin = 0, msgMax = 0, callerThreadId = 0): Message | null {
        const noFilter = msgMin === 0 && msgMax === 0;

        // 1. Input queue (keyboard, buttons, etc)
        const queued = noFilter
            ? this.inputQueue.dequeue(callerThreadId)
            : this.inputQueue.dequeueFiltered(msgMin, msgMax, callerThreadId);
        if (queued) {
            this.trackDequeued(queued);
            return queued;
        }

        // 2. Pending mouse moves (coalesced) — filter by owning thread to prevent
        // other threads (e.g. Galaxy audio) from stealing mouse messages.
        if (this.lastMouseMove.size > 0 && (noFilter || (WM_MOUSEMOVE >= msgMin && WM_MOUSEMOVE <= msgMax))) {
            for (const [hwnd, pending] of this.lastMouseMove) {
                if (callerThreadId > 0 && pending.targetThreadId > 0
                    && pending.targetThreadId !== callerThreadId) {
                    continue; // belongs to another thread
                }
                this.lastMouseMove.delete(hwnd);
                const msg: Message = {
                    hwnd,
                    message: WM_MOUSEMOVE,
                    wParam: pending.wParam,
                    lParam: pending.lParam,
                    time: pending.time,
                    ptX: pending.ptX,
                    ptY: pending.ptY,
                    keyStatePacked: pending.keyStatePacked,
                };
                this.trackDequeued(msg);
                return msg;
            }
        }

        // 3. WM_PAINT precedes synthesized timers in USER's retrieval order.
        if (this.paintPending.size > 0 && (noFilter || (WM_PAINT >= msgMin && WM_PAINT <= msgMax))) {
            for (const [hwnd, pending] of this.paintPending) {
                if (callerThreadId > 0 && pending.targetThreadId > 0
                    && pending.targetThreadId !== callerThreadId) continue;
                this.paintPending.delete(hwnd);
                const msg: Message = {
                    hwnd, message: WM_PAINT,
                    wParam: pending.wParam, lParam: pending.lParam,
                    time: pending.time, ptX: pending.ptX, ptY: pending.ptY,
                    keyStatePacked: pending.keyStatePacked,
                };
                this.trackDequeued(msg);
                return msg;
            }
        }

        // 4. USER synthesizes WM_TIMER only when no higher-priority message is ready.
        if (this.timerPending.size > 0 && (noFilter || (WM_TIMER >= msgMin && WM_TIMER <= msgMax))) {
            for (const [key, entry] of this.timerPending) {
                const pending = entry.pending;
                if (callerThreadId > 0 && pending.targetThreadId > 0
                    && pending.targetThreadId !== callerThreadId) {
                    continue;
                }
                this.timerPending.delete(key);
                const msg: Message = {
                    hwnd: entry.hwnd,
                    message: WM_TIMER,
                    wParam: pending.wParam,
                    lParam: pending.lParam,
                    time: pending.time,
                    ptX: pending.ptX,
                    ptY: pending.ptY,
                    targetThreadId: pending.targetThreadId,
                    keyStatePacked: pending.keyStatePacked,
                };
                this.trackDequeued(msg);
                return msg;
            }
        }

        return null;
    }

    peek(msgMin = 0, msgMax = 0, callerThreadId = 0): Message | null {
        const noFilter = msgMin === 0 && msgMax === 0;

        const queued = noFilter
            ? this.inputQueue.peek(callerThreadId)
            : this.inputQueue.peekFiltered(msgMin, msgMax, callerThreadId);
        if (queued) {
            return queued;
        }
        if (this.lastMouseMove.size > 0 && (noFilter || (WM_MOUSEMOVE >= msgMin && WM_MOUSEMOVE <= msgMax))) {
            for (const [hwnd, pending] of this.lastMouseMove) {
                if (callerThreadId > 0 && pending.targetThreadId > 0
                    && pending.targetThreadId !== callerThreadId) {
                    continue;
                }
                return {
                    hwnd,
                    message: WM_MOUSEMOVE,
                    wParam: pending.wParam,
                    lParam: pending.lParam,
                    time: pending.time,
                    ptX: pending.ptX,
                    ptY: pending.ptY,
                    keyStatePacked: pending.keyStatePacked,
                };
            }
        }
        if (this.paintPending.size > 0 && (noFilter || (WM_PAINT >= msgMin && WM_PAINT <= msgMax))) {
            for (const [hwnd, pending] of this.paintPending) {
                if (callerThreadId > 0 && pending.targetThreadId > 0
                    && pending.targetThreadId !== callerThreadId) continue;
                return {
                    hwnd, message: WM_PAINT,
                    wParam: pending.wParam, lParam: pending.lParam,
                    time: pending.time, ptX: pending.ptX, ptY: pending.ptY,
                    keyStatePacked: pending.keyStatePacked,
                };
            }
        }
        if (this.timerPending.size > 0 && (noFilter || (WM_TIMER >= msgMin && WM_TIMER <= msgMax))) {
            for (const entry of this.timerPending.values()) {
                const pending = entry.pending;
                if (callerThreadId > 0 && pending.targetThreadId > 0
                    && pending.targetThreadId !== callerThreadId) {
                    continue;
                }
                return {
                    hwnd: entry.hwnd,
                    message: WM_TIMER,
                    wParam: pending.wParam,
                    lParam: pending.lParam,
                    time: pending.time,
                    ptX: pending.ptX,
                    ptY: pending.ptY,
                    targetThreadId: pending.targetThreadId,
                    keyStatePacked: pending.keyStatePacked,
                };
            }
        }
        return null;
    }

    hasMessages(msgMin = 0, msgMax = 0, callerThreadId = 0): boolean {
        const noFilter = msgMin === 0 && msgMax === 0;
        if (this.inputQueue.hasFiltered(msgMin, msgMax, callerThreadId)) return true;
        if (this.lastMouseMove.size > 0 && (noFilter || (WM_MOUSEMOVE >= msgMin && WM_MOUSEMOVE <= msgMax))) {
            for (const pending of this.lastMouseMove.values()) {
                if (callerThreadId === 0 || pending.targetThreadId === 0 || pending.targetThreadId === callerThreadId) {
                    return true;
                }
            }
        }
        if (this.timerPending.size > 0 && (noFilter || (WM_TIMER >= msgMin && WM_TIMER <= msgMax))) {
            for (const entry of this.timerPending.values()) {
                const pending = entry.pending;
                if (callerThreadId === 0 || pending.targetThreadId === 0 || pending.targetThreadId === callerThreadId) {
                    return true;
                }
            }
        }
        if (this.paintPending.size > 0 && (noFilter || (WM_PAINT >= msgMin && WM_PAINT <= msgMax))) {
            for (const pending of this.paintPending.values()) {
                if (callerThreadId === 0 || pending.targetThreadId === 0 || pending.targetThreadId === callerThreadId) {
                    return true;
                }
            }
        }
        return false;
    }

    /** True when someone is blocking in waitForMessage (e.g. GetMessage). */
    hasWaiters(): boolean {
        return this.waiters.length > 0;
    }

    waitForMessage(callerThreadId = 0): Promise<Message> {
        // Check all sources: discrete input, coalesced mouse moves, pending paint.
        // GetMessageW processes one message per call then returns to frame work —
        // no tight-spin risk from draining coalesced mouse moves here.
        const msg = this.dequeue(0, 0, callerThreadId);
        if (msg) {
            return Promise.resolve(msg);
        }

        // Force-poll input once before blocking — flushes any pending raw input
        // into the queue so GetMessage/WaitMessage sees it immediately.
        // Only poll once (not in a loop) to avoid WM_MOUSEMOVE spin.
        if (this.inputPollCallback) {
            this.inputPollCallback();
            const afterPoll = this.dequeue(0, 0, callerThreadId);
            if (afterPoll) {
                return Promise.resolve(afterPoll);
            }
        }

        // Truly empty — register waiter with 4ms timeout.
        // InputManager's setInterval polling will call enqueue→drainWaiters for
        // real input events (keys, clicks). Timeout returns WM_NULL as idle signal.
        const parkStart = performance.now();
        return new Promise(resolve => {
            const waiterObj: { deliver: (msg: Message) => void; settled: boolean; threadId: number } = {
                settled: false,
                threadId: callerThreadId,
                deliver: (msg: Message) => {
                    if (waiterObj.settled) return;
                    waiterObj.settled = true;
                    clearTimeout(timeoutId);
                    this.recordWake('deliver', msg.message, parkStart);
                    resolve(msg);
                },
            };

            const timeoutId = setTimeout(() => {
                if (waiterObj.settled) return;
                waiterObj.settled = true;
                // Remove from waiters
                const idx = this.waiters.indexOf(waiterObj);
                if (idx >= 0) {
                    this.waiters.splice(idx, 1);
                }
                // On timeout, deliver any coalesced mouse move or paint
                const pending = this.dequeue(0, 0, callerThreadId);
                if (pending) {
                    this.recordWake('timeout-pending', pending.message, parkStart);
                    resolve(pending);
                } else {
                    // Nothing at all — return WM_NULL as idle signal
                    this.recordWake('null', 0x0000, parkStart);
                    resolve({
                        hwnd: 0,
                        message: 0x0000, // WM_NULL
                        wParam: 0,
                        lParam: 0,
                        time: TimeService.getInstance().nowMs() | 0,
                        ptX: 0,
                        ptY: 0
                    });
                }
            }, 4); // 4ms timeout — browser setTimeout floor; faster coalesced delivery

            this.waiters.push(waiterObj);
        });
    }

    /**
     * Wake up all waiting message handlers with WM_NULL
     * Used when pausing the emulator to prevent blocking
     */
    wakeWaiters(): void {
        const wmNull: Message = {
            hwnd: 0,
            message: 0x0000, // WM_NULL
            wParam: 0,
            lParam: 0,
            time: TimeService.getInstance().nowMs() | 0,
            ptX: 0,
            ptY: 0
        };

        // Resolve all waiters with WM_NULL
        const waiters = this.waiters.slice(); // Copy array to avoid modification during iteration
        this.waiters = [];
        for (const waiter of waiters) {
            waiter.deliver(wmNull);
        }
    }

    /**
     * Remove all queued/coalesced messages for a destroyed window.
     */
    removeWindow(hwnd: number): void {
        this.lastMouseMove.delete(hwnd);
        this.paintPending.delete(hwnd);
        for (const [key, entry] of this.timerPending) {
            if (entry.hwnd === (hwnd >>> 0)) this.timerPending.delete(key);
        }
        // Drain inputQueue entries for this hwnd by dequeuing all and re-enqueuing non-matching
        // This is O(n) but only called on window destruction, not a hot path
        const kept: Message[] = [];
        let msg: Message | null;
        while ((msg = this.inputQueue.dequeue()) !== null) {
            if (msg.hwnd !== hwnd) {
                kept.push(msg);
            }
        }
        for (const m of kept) {
            this.inputQueue.enqueue(m.hwnd, m.message, m.wParam, m.lParam, m.time, m.ptX, m.ptY, m.targetThreadId ?? 0, m.keyStatePacked);
        }
    }

    clearPaint(hwnd: number): boolean {
        return this.paintPending.delete(hwnd);
    }

    clear(): void {
        while (this.inputQueue.dequeue()) {
            // drain
        }
        this.lastMouseMove.clear();
        this.timerPending.clear();
        this.paintPending.clear();
        this.waiters = []; // Clear any pending waiters
    }

    private drainWaiters(): void {
        // Purge stale waiters first (already resolved by timeout)
        while (this.waiters.length > 0 && this.waiters[0].settled) {
            this.waiters.shift();
        }
        // Deliver messages to live waiters, respecting thread targeting
        let i = 0;
        while (i < this.waiters.length) {
            const waiter = this.waiters[i];
            if (waiter.settled) { this.waiters.splice(i, 1); continue; }
            const msg = this.dequeue(0, 0, waiter.threadId);
            if (msg) {
                this.waiters.splice(i, 1);
                waiter.deliver(msg);
            } else {
                // No message available for this waiter's thread — skip
                i++;
            }
        }
    }
}
