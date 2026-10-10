import { describe, expect, test } from "bun:test";
import { ZipArchive, type ZipEntry } from "@bottleship/formats/zip";
import { SabIoSource, type SabWorkerLike } from "../../src/worker/runtime/filesystem/sab-io-source";
import * as P from "../../src/worker/runtime/filesystem/sab-io-protocol";
import { withIoReadPolicy } from "../../src/worker/runtime/filesystem/io-read-policy";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";

class WorkerStub implements SabWorkerLike {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    messages: unknown[] = [];
    constructor(readonly sab: SharedArrayBuffer) {}
    postMessage(message: unknown): void {
        this.messages.push(message);
        const msg = message as { type: string };
        if (msg.type === "close") queueMicrotask(() => this.onmessage?.({ data: { type: "closed" } } as MessageEvent));
        if (msg.type !== "req") return;
        const ctl = new Int32Array(this.sab, 0, P.CTL_WORDS);
        const meta = new Float64Array(this.sab, P.META_OFFSET_BYTES, P.META_WORDS);
        const bytes = Uint8Array.from({ length: meta[P.META_REQ_LEN] }, (_, i) => (meta[P.META_REQ_OFF] + i) & 255);
        P.publishResponse(ctl, new Uint8Array(this.sab, P.DATA_OFFSET_BYTES, P.DATA_BYTES),
            meta[P.META_REQ_SEQ], Atomics.load(ctl, P.CTL_REQ_SEQ), bytes);
    }
    terminate(): void {}
}

function source() {
    const sab = new SharedArrayBuffer(P.SAB_TOTAL_BYTES), residency = new SharedArrayBuffer(4);
    const worker = new WorkerStub(sab);
    return { worker, bits: new Int32Array(residency), src: SabIoSource.attachForTest(worker, sab, 256, residency, 64) };
}

describe("streamed read boundaries", () => {
    test("cold park-preferred reads issue no blocking request, durable bits permit warm reads", async () => {
        const { worker, bits, src } = source();
        expect(withIoReadPolicy("park-preferred", () => src.readRangeSync(64, 70))).toBeNull();
        expect(worker.messages.length).toBe(0);
        Atomics.or(bits, 0, 1 << 1);
        expect(withIoReadPolicy("park-preferred", () => src.readRangeSync(64, 70))).toEqual(new Uint8Array([64, 65, 66, 67, 68, 69]));
        expect(withIoReadPolicy("must-not-block", () => src.readRangeSync(64, 70))).toBeNull();
        expect(worker.messages.length).toBe(1);
        await src.closeAsync();
    });

    test("may-block callers retain their synchronous contract on cold ranges", async () => {
        const { src } = source();
        expect(src.readRangeSync(0, 4)).toEqual(new Uint8Array([0, 1, 2, 3]));
        await src.closeAsync();
    });

    test("a short async answer fails and does not count as completed work", async () => {
        const { worker, src } = source();
        const reading = src.readRange(0, 8);
        worker.onmessage?.({ data: { type: "aresp", id: 1, ok: true, buf: new ArrayBuffer(4) } } as MessageEvent);
        await expect(reading).rejects.toThrow("short response");
        expect(src.stats().async.completed).toBe(0);
        expect(src.stats().async.failed).toBe(1);
        await src.closeAsync();
    });

    test("worker failure settles every pending read and ignores late answers", async () => {
        const { worker, src } = source();
        const result = Promise.allSettled([src.readRange(0, 8), src.readRange(64, 72)]);
        worker.onerror?.({ message: "lost worker" } as ErrorEvent);
        expect((await result).map(r => r.status)).toEqual(["rejected", "rejected"]);
        worker.onmessage?.({ data: { type: "aresp", id: 1, ok: true, buf: new ArrayBuffer(8) } } as MessageEvent);
        expect(src.stats().async.inFlight).toBe(0);
        expect(src.stats().async.completed).toBe(0);
        await expect(src.readRange(0, 8)).rejects.toThrow("lost worker");
        await src.closeAsync();
    });

    test("async ZIP reads never enter a sync transport, and preload leaves timers runnable", async () => {
        const bytes = new Uint8Array(80), view = new DataView(bytes.buffer);
        for (const offset of [0, 40]) {
            view.setUint32(offset, 0x04034b50, true);
            bytes.set([1, 2, 3, 4, 5, 6, 7, 8], offset + 30);
        }
        let release!: () => void, outstanding = 0;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const archive = new ZipArchive({ size: bytes.length,
            readRangeSync: () => { throw new Error("blocking preload"); },
            readRange: async (start, end) => { outstanding++; await gate; return bytes.slice(start, end); },
        });
        const entry = (offset: number): ZipEntry => ({ name: `rom/${offset}`, compression: 0,
            compressedSize: 8, uncompressedSize: 8, isDirectory: false, localHeaderOffset: offset });
        const reads = [archive.readEntry(entry(0)), archive.readEntry(entry(40))];
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(outstanding).toBe(2);
        release();
        expect(await Promise.all(reads)).toEqual([bytes.slice(30, 38), bytes.slice(70, 78)]);
    });

    test("one version-checked restart replays pending async reads, then a second crash fails", async () => {
        const nativeWorker = globalThis.Worker;
        const isolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
        const workers: RecoveryWorker[] = [];
        class RecoveryWorker implements SabWorkerLike {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;
            onmessageerror: ((event: MessageEvent) => void) | null = null;
            pending: Array<{ id: number; off: number; len: number }> = [];
            expected: unknown;
            constructor() { workers.push(this); }
            postMessage(value: unknown): void {
                const msg = value as any;
                if (msg.type === "init") {
                    this.expected = msg.expected;
                    queueMicrotask(() => this.onmessage?.({ data: { type: "ready", size: 256,
                        chunkBytes: 64, residencySab: new SharedArrayBuffer(4), etag: '"v1"' } } as MessageEvent));
                } else if (msg.type === "areq") this.pending.push(msg);
                else if (msg.type === "close") queueMicrotask(() => this.onmessage?.({ data: { type: "closed" } } as MessageEvent));
            }
            answer(): void {
                for (const msg of this.pending.splice(0)) this.onmessage?.({ data: { type: "aresp", id: msg.id, ok: true,
                    buf: Uint8Array.from({ length: msg.len }, (_, i) => msg.off + i).buffer } } as MessageEvent);
            }
            terminate(): void {}
        }
        globalThis.Worker = RecoveryWorker as unknown as typeof Worker;
        Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
        let src: SabIoSource | undefined;
        try {
            src = await SabIoSource.create("/apps/test.wgb");
            const reads = [src.readRange(0, 4), src.readRange(64, 68)];
            workers[0].onerror?.({ message: "crash" } as ErrorEvent);
            await src.restartWorker();
            expect(workers.length).toBe(2);
            expect(workers[1].expected).toEqual({ size: 256, etag: '"v1"' });
            expect(workers[1].pending.length).toBe(2);
            workers[1].answer();
            expect(await Promise.all(reads)).toEqual([new Uint8Array([0, 1, 2, 3]), new Uint8Array([64, 65, 66, 67])]);
            const failed = src.readRange(128, 132);
            workers[1].onerror?.({ message: "second crash" } as ErrorEvent);
            await expect(failed).rejects.toThrow("second crash");
            expect(workers.length).toBe(2);
        } finally {
            await src?.closeAsync();
            globalThis.Worker = nativeWorker;
            if (isolation) Object.defineProperty(globalThis, "crossOriginIsolated", isolation);
            else delete (globalThis as any).crossOriginIsolated;
        }
    });
});

test("_lread parks a cold read and writes into current memory after growth; EOF stays zero", async () => {
    let memory = new Uint8Array(0x8000);
    Mem.bind(() => memory);
    const stale = memory;
    const provider = System.getInstance().resourceProvider, original = provider.getFileHandle;
    let resolve!: (bytes: Uint8Array) => void;
    const reading = new Promise<Uint8Array>(r => { resolve = r; });
    provider.getFileHandle = (() => ({ readIntoSync: () => null, read: () => reading })) as typeof original;
    try {
        const pending = fileIo._lread(null as any, memory, [42, 0x1000, 4]);
        expect(pending).toBeInstanceOf(Promise);
        memory = new Uint8Array(0x10000);
        resolve(new Uint8Array([9, 8, 7, 6]));
        expect(await pending).toEqual({ value: 4 });
        expect(memory.slice(0x1000, 0x1004)).toEqual(new Uint8Array([9, 8, 7, 6]));
        expect(stale.slice(0x1000, 0x1004)).toEqual(new Uint8Array(4));
        provider.getFileHandle = (() => ({ readIntoSync: () => null, read: async () => new Uint8Array(0) })) as typeof original;
        expect(await fileIo._lread(null as any, memory, [42, 0x1000, 4])).toEqual({ value: 0 });
    } finally { provider.getFileHandle = original; }
});
