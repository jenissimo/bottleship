/**
 * Memory Event Ring Buffer for Observability
 *
 * Tracks memory-related events (allocations, locks, blits) in a circular buffer
 * for debugging and fault analysis.
 */

import { Logger, LogCategory } from '../logger';

export enum MemoryEventType {
    ALLOC = "alloc",
    FREE = "free",
    LOCK = "lock",
    UNLOCK = "unlock",
    BLT = "blt",
    FLIP = "flip",
    THUNK_ENTER = "thunk_enter",
    THUNK_EXIT = "thunk_exit",
}

export interface MemoryEvent {
    timestamp: number;
    type: MemoryEventType;
    address: number;
    size: number;
    context?: string;
}

const RING_BUFFER_SIZE = 4096;

export class MemoryEventBuffer {
    private events: MemoryEvent[] = new Array(RING_BUFFER_SIZE);
    private writeIndex = 0;
    private count = 0;

    /** Clear the ring (game switch — no cross-game event bleed). */
    reset(): void {
        this.events = new Array(RING_BUFFER_SIZE);
        this.writeIndex = 0;
        this.count = 0;
    }

    record(event: MemoryEvent): void {
        this.events[this.writeIndex] = event;
        this.writeIndex = (this.writeIndex + 1) % RING_BUFFER_SIZE;
        if (this.count < RING_BUFFER_SIZE) this.count++;
    }

    getRecent(n: number): MemoryEvent[] {
        // Walk back from the WRITE INDEX in both cases. Anchoring an unwrapped ring at 0
        // walked backwards off the front into the tail the ring has never written, so
        // getRecent handed out undefined entries — and dump() then threw while reporting a
        // memory fault, turning a diagnosable fault into an opaque exception exactly when
        // the ring was still short, i.e. early in a session.
        const result: MemoryEvent[] = [];
        for (let i = 0; i < Math.min(n, this.count); i++) {
            const idx = (this.writeIndex - 1 - i + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            const e = this.events[idx];
            if (e) result.push(e);
        }
        return result.reverse();
    }

    dump(): void {
        const recent = this.getRecent(20);
        Logger.log(LogCategory.SYSTEM,
            "Recent memory events:\n" +
            recent.map(e =>
                `[${(e.timestamp / 1000).toFixed(3)}s] ${e.type} ` +
                `addr=0x${e.address.toString(16)} size=0x${e.size.toString(16)} ${e.context || ""}`
            ).join("\n")
        );
    }
}

export const memoryEventBuffer = new MemoryEventBuffer();
