/**
 * Split D3D9, render-worker arm: IDirect3DQuery9 answers come back from the worker.
 *
 * The front's query.ts sends each query boundary down the stream and answers GetData from the
 * result table; the worker's SplitQueryHost drives a real D3D9QueryManager. Here the "stream"
 * is an array the test delivers to the host by hand, so arrival order and timing are explicit.
 * Before the fix a worker-mode front completed EVENT on its own present counter and answered
 * OCCLUSION with the viewport-sized CPU fallback, whatever the GPU measured. EVENT then waited
 * for the worker's reply instead, one cross-worker round trip per frame; it now takes the base
 * arm's "submitted" contract at the ship of the batch holding its END.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createQueryExports, notifyDeviceSubmission, resetD3D9QueryLedger, tryFastGetData } from "../../src/worker/modules/d3d9/query";
import { devices, resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";
import {
    D3D9QueryManager, type QueryManagerDevice, type QueryManagerQueue, type QueryCommandEncoder, type QueryPassEncoder,
} from "../../src/worker/modules/d3d9/query-manager";
import { SplitQueryHost } from "../../src/worker/backends/webgpu/d3d9/split-query-host";
import { SplitQueryResultTable, type SplitQueryChannel } from "../../src/worker/render/d3d9-remote-state";

const D3D_OK = 0;
const S_FALSE = 1;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const EVENT = 8;
const OCCLUSION = 9;
const VCACHE = 4;
const ISSUE_BEGIN = 2;
const ISSUE_END = 1;
const FLUSH = 1;
const DEVICE = 0x100;
const QUERY_OUT = 0x300;
const QUERY_OUT2 = 0x304;
const DATA_OUT = 0x400;

class FakeBuffer {
    readonly bytes: ArrayBuffer;
    constructor(desc: { size: number }) { this.bytes = new ArrayBuffer(desc.size); }
    mapAsync(): Promise<void> { return Promise.resolve(); }
    getMappedRange(): ArrayBuffer { return this.bytes; }
    unmap(): void {}
    destroy(): void {}
}

class FakeGpu {
    readonly features = new Set<string>();
    readonly buffers: FakeBuffer[] = [];
    createQuerySet(desc: { count: number }): object { return { count: desc.count, destroy() {} }; }
    createBuffer(desc: { size: number }): FakeBuffer {
        const b = new FakeBuffer(desc);
        this.buffers.push(b);
        return b;
    }
}

const fakeQueue: QueryManagerQueue = { submit: () => undefined, onSubmittedWorkDone: () => Promise.resolve() };
const fakePass: QueryPassEncoder = { beginOcclusionQuery: () => undefined, endOcclusionQuery: () => undefined };
const fakeEncoder = {
    resolveQuerySet: () => undefined, copyBufferToBuffer: () => undefined, finish: () => ({}),
} as unknown as QueryCommandEncoder;

/** The render worker: a twin-side manager, the host, and the frame the host records into. */
class FakeWorker {
    readonly gpu = new FakeGpu();
    readonly manager = new D3D9QueryManager({ device: this.gpu as unknown as QueryManagerDevice, queue: fakeQueue });
    readonly frame: Array<[string, number]> = [];
    readonly host = new SplitQueryHost({
        getQueryManager: () => this.manager,
        recordQueryBegin: (q) => { this.frame.push(["begin", q]); },
        recordQueryEnd: (q) => { this.frame.push(["end", q]); },
        recordQueryTimestamp: (q) => { this.frame.push(["timestamp", q]); },
    });

    /** What the executor does at a submit: run the frame's query commands, resolve, submit. */
    async submitFrame(samples: Map<number, bigint>): Promise<void> {
        const serial = this.manager.allocateSubmissionSerial();
        const ids: number[] = [];
        for (const [op, q] of this.frame.splice(0)) {
            if (op === "begin") this.manager.beginOcclusion(q, fakePass);
            else if (op === "end") { this.manager.endOcclusion(q, fakePass); ids.push(q); }
        }
        const batch = this.manager.encodeResolves(fakeEncoder, ids, serial);
        if (batch.status === "encoded") {
            const view = new DataView(this.gpu.buffers[this.gpu.buffers.length - 1]!.bytes);
            batch.entries.forEach((e, i) => view.setBigUint64(i * 8, samples.get(Number(e.state.id)) ?? 0n, true));
            this.manager.markSubmitted(batch);
        } else {
            this.manager.notifySubmitted(serial);
        }
        await this.manager.settled();
    }
}

let memory: Uint8Array;
let originalProcess: unknown;
let exportsTable: Record<string, any>;
let table: SplitQueryResultTable;
let worker: FakeWorker;
/** Recorded boundaries not yet delivered to the worker. */
let stream: Array<[string, number, number]>;
let ships: number;
/** Batches that left for the worker (every `ship()`, FLUSH-driven or not). */
let shipSerial: number;

function call(name: string, ...args: number[]): number {
    return exportsTable[name]!({ esp: 0 }, memory, args) as number;
}

/** Deliver everything recorded so far to the worker (a ship), without collecting results. */
function ship(): void {
    shipSerial++;
    for (const [op, ptr, arg] of stream.splice(0)) worker.host.apply(op, ptr, arg);
}

/** The worker posts whatever became answerable; the front's table takes it. */
function deliverResults(): void {
    table.accept(worker.host.collect());
}

function channel(): SplitQueryChannel {
    return {
        timestampSupported: () => false,
        create: (q, type) => { stream.push(["create", q, type]); },
        begin: (q, previous) => { table.forget(previous); stream.push(["begin", q, 0]); },
        end: (q, previous, shipReady) => {
            table.forget(previous);
            const token = shipReady ? table.mint() : table.expect();
            stream.push(["end", q, token]);
            return token;
        },
        flush: (q, token) => { stream.push(["flush", q, token]); ships++; ship(); },
        shipMark: () => shipSerial + 1,
        shipped: (mark) => shipSerial >= mark,
        release: (q, token) => { table.forget(token); stream.push(["release", q, 0]); },
        result: (token) => table.result(token),
        noteAnswered: () => table.noteAnswered(),
        noteShipReadyAnswered: () => table.noteShipReadyAnswered(),
    };
}

beforeEach(() => {
    const system = System.getInstance();
    originalProcess = system.process;
    memory = new Uint8Array(0x200000);
    let next = 0x1f0000;
    const thunkGenerator = new ThunkGenerator();
    thunkGenerator.setBaseAddress(0x1000);
    const alloc = (size: number) => { const p = next; next += Math.max(16, size); return p; };
    system.process = {
        memory: { alloc, allocAt: () => undefined, allocSystemBlock: alloc, free: () => undefined, freeSystemBlock: () => undefined },
        dispatcher: { registerModule: () => undefined, applyPendingRegistrations: () => undefined },
        thunkGenerator,
        getCurrentMemory: () => memory,
    } as any;
    Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
    resetD3D9SharedState();
    table = new SplitQueryResultTable();
    worker = new FakeWorker();
    stream = [];
    ships = 0;
    shipSerial = 0;
    // A split front: no manager of its own, its queries answered through the channel.
    devices.set(DEVICE, {
        getQueryManager: () => null,
        splitQueries: channel(),
        getViewport: () => ({ width: 64, height: 32 }),
        getDrawCount: () => 0,
        resetSubsystemPerf: () => undefined,
    } as any);
    exportsTable = createQueryExports();
    resetD3D9QueryLedger();
});

afterEach(() => {
    resetD3D9SharedState();
    System.getInstance().process = originalProcess as any;
});

function createQuery(type: number, out = QUERY_OUT): number {
    expect(call("IDirect3DDevice9_CreateQuery", DEVICE, type, out)).toBe(D3D_OK);
    return Mem.readUint32(out)!;
}

describe("split D3D9 query results (render-worker arm)", () => {
    test("EVENT is S_FALSE until the batch holding its END ships, then ready without the worker's reply", () => {
        const q = createQuery(EVENT);
        expect(call("IDirect3DQuery9_Issue", q, ISSUE_END)).toBe(D3D_OK);
        // The front's own present counter does not satisfy it.
        notifyDeviceSubmission(DEVICE);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(tryFastGetData(q, DATA_OUT, 4, 0)).toBe(S_FALSE);

        ship();
        // No result delivered and no worker submit: the ship alone is the fence.
        expect(tryFastGetData(q, DATA_OUT, 4, 0)).toBeNull();
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(1);
        expect(table.counters.answered).toBe(0);
        expect(table.counters.shipReadyAnswered).toBe(1);
    });

    test("EVENT generations are never awaited and the worker posts no result for them: stale stays 0", async () => {
        const q = createQuery(EVENT);
        for (let i = 0; i < 3; i++) {
            call("IDirect3DQuery9_Issue", q, ISSUE_END);
            expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, FLUSH)).toBe(D3D_OK);
            await worker.submitFrame(new Map());
            const results = worker.host.collect();
            expect(results).toEqual([]);
            table.accept(results);
        }
        expect(worker.host.counters.endsByType[EVENT]).toBe(3);
        expect(table.counters).toMatchObject({ ends: 0, shipReadyEnds: 3, arrived: 0, stale: 0, answered: 0, shipReadyAnswered: 3 });
        expect(table.outstanding()).toBe(0);
    });

    test("a re-issued EVENT waits for the NEXT ship, not the one that carried its previous END", () => {
        const q = createQuery(EVENT);
        call("IDirect3DQuery9_Issue", q, ISSUE_END);
        ship();
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(D3D_OK);
        call("IDirect3DQuery9_Issue", q, ISSUE_END);
        expect(tryFastGetData(q, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(S_FALSE);
        ship();
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(D3D_OK);
    });

    test("OCCLUSION does NOT take ship readiness: shipped but unmeasured is still S_FALSE", async () => {
        const q = createQuery(OCCLUSION);
        call("IDirect3DQuery9_Issue", q, ISSUE_BEGIN);
        call("IDirect3DQuery9_Issue", q, ISSUE_END);
        ship();
        expect(tryFastGetData(q, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, FLUSH)).toBe(S_FALSE);
        await worker.submitFrame(new Map([[q, 55n]]));
        deliverResults();
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(55);
    });

    test("OCCLUSION answers the count the worker measured, not the CPU viewport fallback", async () => {
        const q = createQuery(OCCLUSION);
        expect(call("IDirect3DQuery9_Issue", q, ISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", q, ISSUE_END)).toBe(D3D_OK);
        ship();
        expect(worker.frame).toEqual([["begin", q], ["end", q]]);
        await worker.submitFrame(new Map([[q, 777n]]));
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(S_FALSE);
        deliverResults();
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(777);
    });

    test("results arriving out of order each answer their own query, and a stale generation answers nobody", async () => {
        const a = createQuery(OCCLUSION, QUERY_OUT);
        const b = createQuery(OCCLUSION, QUERY_OUT2);
        call("IDirect3DQuery9_Issue", a, ISSUE_BEGIN);
        call("IDirect3DQuery9_Issue", a, ISSUE_END);
        call("IDirect3DQuery9_Issue", b, ISSUE_BEGIN);
        call("IDirect3DQuery9_Issue", b, ISSUE_END);
        ship();
        await worker.submitFrame(new Map([[a, 100n], [b, 200n]]));
        const results = worker.host.collect();
        expect(results).toHaveLength(2);
        table.accept([...results].reverse());
        expect(call("IDirect3DQuery9_GetData", b, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(200);
        expect(call("IDirect3DQuery9_GetData", a, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(100);

        // A re-issued query waits for its NEW generation; the old result arriving again is stale.
        call("IDirect3DQuery9_Issue", a, ISSUE_BEGIN);
        call("IDirect3DQuery9_Issue", a, ISSUE_END);
        table.accept(results);
        expect(table.counters.stale).toBe(2);
        expect(call("IDirect3DQuery9_GetData", a, DATA_OUT, 4, 0)).toBe(S_FALSE);
        ship();
        await worker.submitFrame(new Map([[a, 300n]]));
        deliverResults();
        expect(call("IDirect3DQuery9_GetData", a, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(300);
    });

    test("GetData(FLUSH) on an EVENT ships the generation once and answers TRUE on that same call", () => {
        const q = createQuery(EVENT);
        call("IDirect3DQuery9_Issue", q, ISSUE_END);
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, FLUSH)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(1);
        expect(ships).toBe(1);
        // Polled again with FLUSH: nothing new to ship, still ready.
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, FLUSH)).toBe(D3D_OK);
        expect(ships).toBe(1);
        expect(worker.host.counters.flushes).toBe(1);
    });

    test("an implicit END (GetData before Issue) is recorded and ready once it ships", () => {
        const q = createQuery(EVENT);
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(stream.map(([op]) => op)).toContain("end");
        ship();
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(D3D_OK);
    });

    test("a worker manager with no query set answers NOTAVAILABLE, never a synthesized count", async () => {
        worker.gpu.createQuerySet = () => { throw new Error("no occlusion query sets"); };
        const q = createQuery(OCCLUSION);
        call("IDirect3DQuery9_Issue", q, ISSUE_BEGIN);
        call("IDirect3DQuery9_Issue", q, ISSUE_END);
        ship();
        await worker.submitFrame(new Map());
        deliverResults();
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 4, 0)).toBe(D3DERR_NOTAVAILABLE);
    });

    test("static information queries fence nothing and never reach the worker", () => {
        const q = createQuery(VCACHE);
        call("IDirect3DQuery9_Issue", q, ISSUE_END);
        expect(call("IDirect3DQuery9_GetData", q, DATA_OUT, 16, 0)).toBe(D3D_OK);
        expect(stream).toEqual([]);
    });
});

describe("split query result table", () => {
    test("a result is final, and an unknown token is counted stale", () => {
        const t = new SplitQueryResultTable();
        const a = t.expect();
        expect(t.result(a)).toBeUndefined();
        t.accept([{ token: a, state: "ready", value: 5n }]);
        t.accept([{ token: a, state: "ready", value: 9n }, { token: 999, state: "ready" }]);
        expect(t.result(a)?.value).toBe(5n);
        expect(t.counters.arrived).toBe(1);
        expect(t.counters.stale).toBe(2);
        t.forget(a);
        expect(t.result(a)).toBeUndefined();
    });
});
