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

/**
 * Struct-of-arrays ring. Recording happens on every guest heap alloc/free, thousands of times a
 * second, and an event object per call lives exactly as long as the ring keeps it — long enough
 * to be promoted, so each one ends as old-generation garbage and paces full GCs. Only a READ
 * (fault dump, harness report) materialises objects.
 */
export class MemoryEventBuffer {
    private timestamps = new Float64Array(RING_BUFFER_SIZE);
    private types: MemoryEventType[] = new Array(RING_BUFFER_SIZE);
    private addresses = new Uint32Array(RING_BUFFER_SIZE);
    private sizes = new Float64Array(RING_BUFFER_SIZE);
    private contexts: (string | undefined)[] = new Array(RING_BUFFER_SIZE);
    private writeIndex = 0;
    private count = 0;

    /** Clear the ring (game switch — no cross-game event bleed). */
    reset(): void {
        this.types = new Array(RING_BUFFER_SIZE);
        this.contexts = new Array(RING_BUFFER_SIZE);
        this.writeIndex = 0;
        this.count = 0;
    }

    record(event: MemoryEvent): void {
        this.recordEvent(event.type, event.address, event.size, event.context, event.timestamp);
    }

    /** Allocation-free form for hot paths; `context` should be a literal, not a built string. */
    recordEvent(type: MemoryEventType, address: number, size: number, context?: string,
        timestamp: number = performance.now()): void {
        const i = this.writeIndex;
        this.timestamps[i] = timestamp;
        this.types[i] = type;
        this.addresses[i] = address >>> 0;
        this.sizes[i] = size;
        this.contexts[i] = context;
        this.writeIndex = (i + 1) % RING_BUFFER_SIZE;
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
            const type = this.types[idx];
            if (type === undefined) continue;
            result.push({
                timestamp: this.timestamps[idx], type, address: this.addresses[idx],
                size: this.sizes[idx], context: this.contexts[idx],
            });
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
