/**
 * Walk a shipped split-D3D9 queue in order: ring entries go to their handlers by function id,
 * the split record id goes to the replayer. Every handler sees `ptr` at the entry's first word
 * after the id — the same contract as the dispatcher's drain.
 */

import { wbufEntryStride } from "../core/thunking/wbuf-format";

export type QueueHandler = (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => void;

export interface QueueWalkResult {
    entries: number;
    records: number;
    unknown: number;
    /** Offset of an entry with no usable stride; the rest of the batch cannot be parsed. */
    malformedAt: number;
    handlerThrows: number;
    firstThrow: string | null;
}

export function walkSplitQueue(
    u8: Uint8Array,
    u32: Uint32Array,
    end: number,
    handlers: ReadonlyArray<QueueHandler | null>,
    argCounts: Int32Array,
    splitRecordId: number,
    onRecord: QueueHandler,
): QueueWalkResult {
    const out: QueueWalkResult = { entries: 0, records: 0, unknown: 0, malformedAt: -1, handlerThrows: 0, firstThrow: null };
    let off = 0;
    while (off < end) {
        const id = u32[off >> 2]! >>> 0;
        const argCount = id < argCounts.length ? argCounts[id]! : 0;
        const stride = argCount > 0 ? wbufEntryStride(u32, 0, off, argCount) : -1;
        if (stride <= 0 || off + stride > end) {
            out.malformedAt = off;
            break;
        }
        out.entries++;
        try {
            if (id === splitRecordId) {
                out.records++;
                onRecord(u8, u32, off + 4);
            } else {
                const handler = handlers[id];
                if (handler) handler(u8, u32, off + 4);
                else out.unknown++;
            }
        } catch (e) {
            if (out.handlerThrows++ === 0) out.firstThrow = `entry ${id} at +${off}: ${String(e)}`;
        }
        off += stride;
    }
    return out;
}
