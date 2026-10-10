import { describe, expect, test } from "bun:test";
import { ThunkDispatcher } from "../../src/worker/core/thunking/thunk-dispatcher";

const BATCH_LIMIT = 8 * 1024 * 1024;
const PAYLOAD_BYTES = 256 * 1024;
const UPLOADS = 96;

function run(flushEach: boolean) {
    const d = new ThunkDispatcher({ add_listener: () => {} } as never, {} as never) as any;
    d.cachedMem8 = new Uint8Array(64);
    d.cachedMem32 = new Uint32Array(d.cachedMem8.buffer);
    d.isDataViewValid = () => true;
    d.writeBufCapacity = 64;
    const id = d.registerQueuePayloadHandler(() => { throw new Error("remote queue replayed locally"); });
    const ledger: Array<{ kind: string; serial: number; bytes: number; sum: number }> = [];
    const batches: number[] = [];
    d.setWbufSplitClient({
        armed: () => true,
        ship: (bytes: Uint8Array, end: number) => {
            batches.push(end);
            const words = new Uint32Array(bytes.buffer, bytes.byteOffset, end / 4);
            for (let off = 0; off < end;) {
                if (words[off / 4] === 40) {
                    ledger.push({ kind: "ring", serial: words[off / 4 + 1]!, bytes: 0, sum: 0 });
                    off += 8;
                    continue;
                }
                expect(words[off / 4]).toBe(id);
                const serial = words[off / 4 + 1]!;
                const length = words[off / 4 + 5]!;
                let sum = 0;
                for (let i = off + 24; i < off + 24 + length; i++) sum += bytes[i]!;
                ledger.push({ kind: "upload", serial, bytes: length, sum });
                off += 24 + Math.ceil(length / 4) * 4;
            }
            return true;
        },
    });
    const source = new Uint8Array(PAYLOAD_BYTES);
    for (let serial = 1; serial <= UPLOADS; serial++) {
        if (serial % 7 === 0) {
            d.cachedMem32.set([40, serial], 0);
            d.appendRingBytes(0, 0, 8);
        }
        source.fill(serial);
        expect(d.enqueuePayloadById(id, serial, 0, 0, 0, source, 0, source.length)).toBe(true);
        source.fill(0);
        if (flushEach) d.executeWbufQueue();
        expect(d.getWbufDeferStats().pendingBytes).toBeLessThanOrEqual(BATCH_LIMIT);
    }
    // A large texture remains a single entry, including its three padding bytes.
    const large = new Uint8Array(BATCH_LIMIT + 1).fill(113);
    expect(d.enqueuePayloadById(id, UPLOADS + 1, 0, 0, 0, large, 0, large.length)).toBe(true);
    d.executeWbufQueue();
    return { ledger, batches, stats: d.getWbufDeferStats(), capacity: d.wbufQueueU8.length };
}

describe("WBUF upload batches without Present", () => {
    test("bounded batches consume the canonical mixed stream in order, matching per-call flushes", () => {
        const bounded = run(false);
        const immediate = run(true);
        const expected: typeof bounded.ledger = [];
        for (let serial = 1; serial <= UPLOADS; serial++) {
            if (serial % 7 === 0) expected.push({ kind: "ring", serial, bytes: 0, sum: 0 });
            expected.push({ kind: "upload", serial, bytes: PAYLOAD_BYTES, sum: serial * PAYLOAD_BYTES });
        }
        expected.push({ kind: "upload", serial: UPLOADS + 1, bytes: BATCH_LIMIT + 1, sum: 113 * (BATCH_LIMIT + 1) });
        expect(bounded.ledger).toEqual(expected);
        expect(bounded.ledger).toEqual(immediate.ledger);
        expect(bounded.stats.enqueuedCalls).toBe(UPLOADS + 1);
        expect(bounded.stats.payloadBytes).toBe(UPLOADS * PAYLOAD_BYTES + BATCH_LIMIT + 1);
        expect(bounded.stats.pendingBytes).toBe(0);
        expect(bounded.stats.executes).toBe(bounded.batches.length);
        expect(bounded.batches.slice(0, -1).every(bytes => bytes <= BATCH_LIMIT)).toBe(true);
        expect(bounded.batches.at(-1)).toBe(24 + BATCH_LIMIT + 4);
        expect(bounded.capacity).toBeLessThanOrEqual(2 * BATCH_LIMIT);
    });
});
