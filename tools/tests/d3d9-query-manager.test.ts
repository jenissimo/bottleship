import { describe, expect, test } from "bun:test";
import {
    D3D9_QUERYTYPE_OCCLUSION,
    D3D9_QUERYTYPE_TIMESTAMP,
    D3D9QueryManager,
    QUERY_MANAGER_BUFFER_USAGE,
    type QueryManagerDevice,
    type QueryManagerQueue,
    type QueryPassEncoder,
    type QueryCommandEncoder,
} from "../../src/worker/modules/d3d9/query-manager";

type QuerySetDesc = { type: "occlusion" | "timestamp"; count: number; label?: string };

class FakeQuerySet {
    readonly type: QuerySetDesc["type"];
    readonly count: number;
    destroyed = false;

    constructor(desc: QuerySetDesc) {
        this.type = desc.type;
        this.count = desc.count;
    }

    destroy(): void {
        this.destroyed = true;
    }
}

class FakeBuffer {
    readonly size: number;
    readonly usage: number;
    readonly bytes: ArrayBuffer;
    destroyed = false;
    mapped = false;

    constructor(desc: { size: number; usage: number }) {
        this.size = desc.size;
        this.usage = desc.usage;
        this.bytes = new ArrayBuffer(desc.size);
    }

    mapAsync(): Promise<void> {
        this.mapped = true;
        return Promise.resolve();
    }

    getMappedRange(): ArrayBuffer {
        return this.bytes;
    }

    unmap(): void {
        this.mapped = false;
    }

    destroy(): void {
        this.destroyed = true;
    }
}

class FakeDevice {
    readonly features: ReadonlySet<string>;
    readonly querySets: FakeQuerySet[] = [];
    readonly buffers: FakeBuffer[] = [];

    constructor(features: readonly string[] = []) {
        this.features = new Set(features);
    }

    createQuerySet(desc: QuerySetDesc): FakeQuerySet {
        const querySet = new FakeQuerySet(desc);
        this.querySets.push(querySet);
        return querySet;
    }

    createBuffer(desc: { size: number; usage: number }): FakeBuffer {
        const buffer = new FakeBuffer(desc);
        this.buffers.push(buffer);
        return buffer;
    }
}

class FakeQueue {
    readonly submissions: unknown[][] = [];
    private resolveDone: (() => void) | null = null;
    private readonly done: Promise<void>;

    constructor() {
        this.done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    }

    submit(commandBuffers: unknown[]): void {
        this.submissions.push(commandBuffers);
    }

    onSubmittedWorkDone(): Promise<void> {
        return this.done;
    }

    complete(): void {
        this.resolveDone?.();
        this.resolveDone = null;
    }
}

class FakeCommandEncoder {
    readonly calls: Array<{ name: string; args: unknown[] }> = [];

    writeTimestamp(querySet: FakeQuerySet, index: number): void {
        this.calls.push({ name: "writeTimestamp", args: [querySet, index] });
    }

    resolveQuerySet(querySet: FakeQuerySet, firstQuery: number, queryCount: number, destination: FakeBuffer, destinationOffset: number): void {
        this.calls.push({ name: "resolveQuerySet", args: [querySet, firstQuery, queryCount, destination, destinationOffset] });
    }

    copyBufferToBuffer(source: FakeBuffer, sourceOffset: number, destination: FakeBuffer, destinationOffset: number, size: number): void {
        this.calls.push({ name: "copyBufferToBuffer", args: [source, sourceOffset, destination, destinationOffset, size] });
    }

    finish(): object {
        this.calls.push({ name: "finish", args: [] });
        return {};
    }
}

class FakePassEncoder {
    readonly calls: Array<{ name: string; index?: number }> = [];

    beginOcclusionQuery(index: number): void {
        this.calls.push({ name: "beginOcclusionQuery", index });
    }

    endOcclusionQuery(): void {
        this.calls.push({ name: "endOcclusionQuery" });
    }
}

function makeManager(
    device: FakeDevice,
    queue = new FakeQueue(),
    querySetCapacity = 4,
): { manager: D3D9QueryManager; queue: FakeQueue } {
    const manager = new D3D9QueryManager({
        device: device as unknown as QueryManagerDevice,
        queue: queue as unknown as QueryManagerQueue,
        querySetCapacity,
    });
    return { manager, queue };
}

describe("D3D9 WebGPU query manager", () => {
    test("allocates query sets lazily and keeps occlusion/timestamp pools separate", () => {
        const device = new FakeDevice(["timestamp-query"]);
        const { manager } = makeManager(device);

        expect(device.querySets).toHaveLength(0);
        const occlusion = manager.acquire(1, {
            type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 1,
        });
        expect(occlusion.mode).toBe("gpu");
        expect(occlusion.index).toBe(0);
        expect(occlusion.querySet?.type).toBe("occlusion");
        expect(device.querySets).toHaveLength(1);
        expect(device.buffers).toHaveLength(0);

        const timestamp = manager.acquire(2, {
            type: D3D9_QUERYTYPE_TIMESTAMP, begun: false, issued: true, issueSerial: 1,
        });
        expect(timestamp.mode).toBe("gpu");
        expect(timestamp.querySet?.type).toBe("timestamp");
        expect(device.querySets).toHaveLength(2);
        expect(device.querySets.map((set) => set.type)).toEqual(["occlusion", "timestamp"]);
    });

    test("returns an explicit deterministic fallback when timestamp-query is unavailable", () => {
        const device = new FakeDevice();
        const queue = new FakeQueue();
        const manager = new D3D9QueryManager({
            device: device as unknown as QueryManagerDevice,
            queue: queue as unknown as QueryManagerQueue,
            fallback: { value: (kind) => kind === "timestamp" ? 123_000n : null },
        });
        expect(manager.getCapability("timestamp")).toEqual({
            kind: "timestamp", supported: false, reason: "timestamp-query-feature-missing",
        });

        const handle = manager.acquire("timestamp-1", {
            type: D3D9_QUERYTYPE_TIMESTAMP, begun: false, issued: true, issueSerial: 4,
        });
        expect(handle.mode).toBe("fallback");
        expect(device.querySets).toHaveLength(0);
        expect(manager.poll("timestamp-1")).toEqual({
            state: "fallback", reason: "timestamp-query-feature-missing", value: 123_000n,
        });
    });

    test("turns query-set allocation failure into a stable occlusion fallback", () => {
        const device = new FakeDevice();
        device.createQuerySet = () => { throw new Error("occlusion-query unsupported"); };
        const { manager } = makeManager(device);
        const handle = manager.acquire("occlusion-failed", {
            type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 1,
        });
        expect(handle).toMatchObject({
            mode: "fallback", kind: "occlusion", reason: "create-query-set-failed",
        });
        expect(manager.poll("occlusion-failed")).toEqual({
            state: "fallback", reason: "create-query-set-failed",
        });
    });

    test("records, resolves, submits and exposes a GPU result only after readback", async () => {
        const device = new FakeDevice(["timestamp-query"]);
        const queue = new FakeQueue();
        const { manager } = makeManager(device, queue);
        const encoder = new FakeCommandEncoder();
        const record = { type: D3D9_QUERYTYPE_TIMESTAMP, begun: false, issued: true, issueSerial: 7 };
        const handle = manager.acquire(7, record);
        manager.notifySubmitted(2);
        manager.notifySubmitted(1);
        expect(manager.getSubmittedSerial()).toBe(2);
        expect(manager.writeTimestamp(7, encoder as unknown as QueryCommandEncoder, record)).toEqual({
            ok: true, mode: "gpu", index: handle.index!,
        });

        const batch = manager.encodeResolves(encoder as unknown as QueryCommandEncoder, [7], 7);
        expect(batch.status).toBe("encoded");
        expect(device.buffers).toHaveLength(2);
        expect(device.buffers[0]!.usage).toBe(
            QUERY_MANAGER_BUFFER_USAGE.QUERY_RESOLVE | QUERY_MANAGER_BUFFER_USAGE.COPY_SRC,
        );
        expect(device.buffers[1]!.usage).toBe(
            QUERY_MANAGER_BUFFER_USAGE.COPY_DST | QUERY_MANAGER_BUFFER_USAGE.MAP_READ,
        );
        expect(encoder.calls.map((call) => call.name)).toEqual([
            "writeTimestamp", "resolveQuerySet", "copyBufferToBuffer",
        ]);
        expect(manager.poll(7)).toEqual({ state: "pending", submissionSerial: 7 });

        const readback = device.buffers[1]!;
        new DataView(readback.bytes).setBigUint64(0, 0x1234_5678_9abcn, true);
        manager.submit(encoder as unknown as QueryCommandEncoder, batch);
        expect(queue.submissions).toHaveLength(1);
        expect(manager.poll(7)).toEqual({ state: "pending", submissionSerial: 7 });
        queue.complete();
        await manager.waitForBatch(batch);
        expect(manager.poll(7)).toEqual({
            state: "ready", submissionSerial: 7, value: 0x1234_5678_9abcn,
        });
        expect(readback.destroyed).toBe(true);
        expect(device.buffers[0]!.destroyed).toBe(true);
    });

    test("abandon retires an encoded batch that never reaches markSubmitted", () => {
        const device = new FakeDevice(["timestamp-query"]);
        const { manager } = makeManager(device, new FakeQueue());
        const encoder = new FakeCommandEncoder();
        const record = { type: D3D9_QUERYTYPE_TIMESTAMP, begun: false, issued: true, issueSerial: 4 };
        manager.acquire("abandoned", record);
        expect(manager.writeTimestamp("abandoned", encoder as unknown as QueryCommandEncoder, record).ok).toBe(true);
        const batch = manager.encodeResolves(encoder as unknown as QueryCommandEncoder, ["abandoned"], 4);
        expect(batch.status).toBe("encoded");

        manager.abandon(batch, "frame-encode-failed");
        expect(batch.status).toBe("rejected");
        expect(manager.poll("abandoned")).toEqual({ state: "fallback", reason: "frame-encode-failed" });
        expect(device.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    });

    test("submit failure retires the batch and makes the query retryable", () => {
        const device = new FakeDevice(["timestamp-query"]);
        const { manager } = makeManager(device);
        const encoder = new FakeCommandEncoder();
        const record = { type: D3D9_QUERYTYPE_TIMESTAMP, begun: false, issued: true, issueSerial: 1 };
        manager.acquire("submit-failed", record);
        manager.writeTimestamp("submit-failed", encoder as unknown as QueryCommandEncoder, record);
        const batch = manager.encodeResolves(encoder as unknown as QueryCommandEncoder, ["submit-failed"], 1);
        const throwingEncoder = {
            finish(): never { throw new Error("command encoder was discarded"); },
        } as unknown as QueryCommandEncoder;
        manager.submit(throwingEncoder, batch);
        expect(batch.status).toBe("rejected");
        expect(manager.poll("submit-failed")).toEqual({
            state: "fallback", reason: "query-submit-failed",
        });
        expect(device.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    });

    test("one serial domain detects a split occlusion pair and re-arms it for the next pass", () => {
        const device = new FakeDevice();
        const { manager } = makeManager(device);
        const pass = new FakePassEncoder();
        const record = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 1 };
        manager.acquire("split", record);

        expect(manager.beginOcclusion("split", pass as unknown as QueryPassEncoder, record).ok).toBe(true);
        const firstSerial = manager.allocateSubmissionSerial();
        manager.notifySubmitted(firstSerial);
        expect(manager.getSubmittedSerial()).toBe(firstSerial);
        expect(manager.needsRebegin("split")).toBe(true);

        expect(manager.rearm("split", record)).toMatchObject({ mode: "gpu" });
        expect(manager.needsRebegin("split")).toBe(false);
        expect(manager.beginOcclusion("split", pass as unknown as QueryPassEncoder, record).ok).toBe(true);
        expect(manager.endOcclusion("split", pass as unknown as QueryPassEncoder, record).ok).toBe(true);
        expect(pass.calls.map((call) => call.name)).toEqual([
            "beginOcclusionQuery", "beginOcclusionQuery", "endOcclusionQuery",
        ]);
    });

    test("does not reuse an in-flight slot and encodes nested occlusion ownership independently", () => {
        const device = new FakeDevice();
        const { manager } = makeManager(device, new FakeQueue(), 1);
        const pass = new FakePassEncoder();
        const outer = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 2 };
        const inner = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 2 };
        const outerHandle = manager.acquire("outer", outer);
        const innerHandle = manager.acquire("inner", inner);
        expect(outerHandle.index).toBe(0);
        expect(innerHandle.index).toBe(0);
        expect(device.querySets).toHaveLength(2);
        expect(outerHandle.querySet).not.toBe(innerHandle.querySet);

        expect(manager.beginOcclusion("outer", pass as unknown as QueryPassEncoder, outer)).toEqual({
            ok: true, mode: "gpu", index: 0,
        });
        // The low-level manager records the pass command; query.ts may commit its
        // QueryRecord.issued transition immediately before or after this hook.
        expect(manager.endOcclusion("outer", pass as unknown as QueryPassEncoder, outer)).toEqual({
            ok: true, mode: "gpu", index: 0,
        });
        expect(pass.calls.map((call) => call.name)).toEqual(["beginOcclusionQuery", "endOcclusionQuery"]);
    });

    test("exposes one render-pass occlusion set and refuses pool mixing", () => {
        const device = new FakeDevice();
        const { manager } = makeManager(device, new FakeQueue(), 1);
        const first = { type: D3D9_QUERYTYPE_OCCLUSION, begun: false, issued: true, issueSerial: 1 };
        const second = { type: D3D9_QUERYTYPE_OCCLUSION, begun: false, issued: true, issueSerial: 1 };
        const firstHandle = manager.acquire("pass-first", first);
        const secondHandle = manager.acquire("pass-second", second);
        expect(manager.getOcclusionQuerySet(["pass-first"])).toBe(firstHandle.querySet!);
        expect(manager.getOcclusionQuerySet(["pass-first", "pass-second"])).toBeNull();
        expect(secondHandle.querySet).not.toBe(firstHandle.querySet);
    });

    test("validation error scopes retire a non-throwing begin failure", async () => {
        const device = new FakeDevice() as FakeDevice & {
            pushErrorScope: (filter: "validation") => void;
            popErrorScope: () => Promise<{ message?: string } | null>;
        };
        device.pushErrorScope = () => undefined;
        device.popErrorScope = async () => ({ message: "query set is not attached to this pass" });
        const { manager } = makeManager(device);
        const record = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 1 };
        manager.acquire("scope-failed", record);
        const result = manager.beginOcclusion("scope-failed", new FakePassEncoder() as unknown as QueryPassEncoder, record);
        expect(result).toMatchObject({ ok: true, mode: "gpu" });
        await Promise.resolve();
        expect(manager.poll("scope-failed")).toMatchObject({
            state: "fallback",
            reason: "begin-occlusion-query-failed:query set is not attached to this pass",
        });
    });

    test("a synchronous popErrorScope failure still retires the operation", () => {
        const device = new FakeDevice() as FakeDevice & {
            pushErrorScope: (filter: "validation") => void;
            popErrorScope: () => Promise<{ message?: string } | null>;
        };
        device.pushErrorScope = () => undefined;
        device.popErrorScope = () => { throw new Error("scope stack unavailable"); };
        const { manager } = makeManager(device);
        const record = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 1 };
        manager.acquire("scope-throws", record);
        expect(manager.beginOcclusion(
            "scope-throws", new FakePassEncoder() as unknown as QueryPassEncoder, record,
        )).toMatchObject({ ok: true, mode: "gpu" });
        expect(manager.poll("scope-throws")).toEqual({
            state: "fallback", reason: "begin-occlusion-query-failed",
        });
    });

    test("resolve validation scopes retire a batch without relying on encoder exceptions", async () => {
        const device = new FakeDevice(["timestamp-query"]) as FakeDevice & {
            pushErrorScope: (filter: "validation") => void;
            popErrorScope: () => Promise<{ message?: string } | null>;
        };
        let scopeCount = 0;
        device.pushErrorScope = () => undefined;
        device.popErrorScope = async () => {
            scopeCount++;
            return scopeCount === 1 ? null : { message: "resolve destination is invalid" };
        };
        const queue = new FakeQueue();
        const { manager } = makeManager(device, queue);
        const encoder = new FakeCommandEncoder();
        const record = { type: D3D9_QUERYTYPE_TIMESTAMP, begun: false, issued: true, issueSerial: 1 };
        manager.acquire("resolve-scope", record);
        expect(manager.writeTimestamp("resolve-scope", encoder as unknown as QueryCommandEncoder, record).ok).toBe(true);
        const batch = manager.encodeResolves(encoder as unknown as QueryCommandEncoder, ["resolve-scope"], 1);
        manager.markSubmitted(batch);
        queue.complete();
        await manager.waitForBatch(batch);
        expect(manager.poll("resolve-scope")).toMatchObject({
            state: "fallback",
            reason: "query-resolve-validation-failed:resolve destination is invalid",
        });
    });

    test("device loss retires query state and exposes a loss reason", async () => {
        let lose!: (info: { reason: string }) => void;
        const lost = new Promise<{ reason: string }>((resolve) => { lose = resolve; });
        const device = new FakeDevice(["timestamp-query"]) as FakeDevice & {
            lost: Promise<{ reason: string }>;
        };
        device.lost = lost;
        const { manager } = makeManager(device);
        const record = { type: D3D9_QUERYTYPE_TIMESTAMP, begun: false, issued: true, issueSerial: 1 };
        manager.acquire("lost", record);
        lose({ reason: "destroyed" });
        await Promise.resolve();
        await Promise.resolve();
        expect(manager.isDeviceLost()).toBe(true);
        expect(manager.getDeviceLossReason()).toBe("device-lost:destroyed");
        expect(manager.poll("lost")).toMatchObject({ state: "fallback", reason: "device-lost:destroyed" });
    });

    test("does not let an old readback reclaim a recycled query id", async () => {
        const device = new FakeDevice();
        const queue = new FakeQueue();
        const { manager } = makeManager(device, queue);
        const oldRecord = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: true, issueSerial: 3 };
        manager.acquire("recycled", oldRecord);
        const pass = new FakePassEncoder();
        expect(manager.beginOcclusion("recycled", pass as unknown as QueryPassEncoder, oldRecord).ok).toBe(true);
        expect(manager.endOcclusion("recycled", pass as unknown as QueryPassEncoder, oldRecord).ok).toBe(true);
        const encoder = new FakeCommandEncoder();
        const batch = manager.encodeResolves(encoder as unknown as QueryCommandEncoder, ["recycled"], 3);
        expect(batch.status).toBe("encoded");
        manager.release("recycled", oldRecord);

        const replacement = { type: D3D9_QUERYTYPE_OCCLUSION, begun: false, issued: false, issueSerial: 0 };
        expect(manager.acquire("recycled", replacement)).toMatchObject({
            mode: "fallback", reason: "query-id-reused-before-retire",
        });
        queue.complete();
        await manager.waitForBatch(batch);
        expect(manager.poll("recycled")).toEqual({
            state: "fallback", reason: "query-id-reused-before-retire",
        });
    });
    test("reclaim is idempotent: a late scope failure cannot free a slot twice", async () => {
        const device = new FakeDevice() as FakeDevice & {
            pushErrorScope: (filter: "validation") => void;
            popErrorScope: () => Promise<{ message?: string } | null>;
        };
        const pendingScopes: Array<(value: { message?: string } | null) => void> = [];
        device.pushErrorScope = () => undefined;
        device.popErrorScope = () => new Promise((resolve) => { pendingScopes.push(resolve); });
        const { manager } = makeManager(device, new FakeQueue(), 2);
        const record = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: true, issueSerial: 1 };
        const pass = new FakePassEncoder();
        expect(manager.acquire("late", record).index).toBe(0);
        expect(manager.beginOcclusion("late", pass as unknown as QueryPassEncoder, record).ok).toBe(true);
        expect(manager.endOcclusion("late", pass as unknown as QueryPassEncoder, record).ok).toBe(true);
        const encoder = new FakeCommandEncoder();
        const batch = manager.encodeResolves(encoder as unknown as QueryCommandEncoder, ["late"], 1);
        expect(batch.status).toBe("encoded");

        // Released while encoded: the slot is retired by whoever finishes the batch.
        manager.release("late", record);
        manager.abandon(batch);

        // The begin-scope continuation lands afterwards and reports the failure.
        pendingScopes[0]!({ message: "late validation" });
        await Promise.resolve();
        await Promise.resolve();

        // Two fresh queries must get two distinct slots — one slot was retired, once.
        const first = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 2 };
        const second = { type: D3D9_QUERYTYPE_OCCLUSION, begun: true, issued: false, issueSerial: 2 };
        const a = manager.acquire("a", first);
        const b = manager.acquire("b", second);
        expect(a.mode).toBe("gpu");
        expect(b.mode).toBe("gpu");
        expect(a.querySet === b.querySet && a.index === b.index).toBe(false);
    });
});
