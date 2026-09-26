/**
 * Split D3D9, render-worker side of IDirect3DQuery9 (plan/d3d9-threaded/P2-PLAN.md, Stage B).
 *
 * The front's query.ts owns the guest-visible state machine and answers GetData; this host
 * owns the half that needs the GPU. It receives the query's boundaries in stream order
 * (twinQuery records), drives the twin's D3D9QueryManager through the same acquire / re-arm /
 * re-begin sequence query.ts runs against a local manager, and reports each END generation's
 * result once, tagged with the token the front minted for it.
 *
 * Only OCCLUSION/TIMESTAMP generations are reported, once their resolve readback landed: the
 * front answers EVENT/TIMESTAMPDISJOINT at the ship of the batch holding their END (query.ts),
 * so a result for one would only ever arrive for a superseded generation.
 */

import type { D3D9QueryManager, QueryRecordContract } from "../../../modules/d3d9/query-manager";
import type { SplitQueryResult } from "../../../render/d3d9-remote-state";

const D3DQUERYTYPE_EVENT = 8;
const D3DQUERYTYPE_OCCLUSION = 9;
const D3DQUERYTYPE_TIMESTAMP = 10;
const D3DQUERYTYPE_TIMESTAMPDISJOINT = 11;

export interface SplitQueryHostDevice {
    getQueryManager(): D3D9QueryManager | null;
    recordQueryBegin(queryPtr: number): void;
    recordQueryEnd(queryPtr: number): void;
    recordQueryTimestamp(queryPtr: number): void;
}

interface HostQuery {
    type: number;
    record: QueryRecordContract;
    /** The manager this query was acquired on; a recreated device brings a new one. */
    manager: D3D9QueryManager | null;
    gpuMode: boolean;
    /** The generation the front waits for (0: none). */
    token: number;
    posted: boolean;
}

export interface SplitQueryHostCounters {
    created: number;
    ends: number;
    flushes: number;
    posted: number;
    /** A boundary for a query this host never saw created. */
    unknown: number;
    rearmFailed: number;
    /** ENDs by D3DQUERYTYPE: which families this title actually fences. */
    endsByType: Record<number, number>;
}

function needsSubmission(type: number): boolean {
    return type === D3DQUERYTYPE_EVENT || type === D3DQUERYTYPE_OCCLUSION
        || type === D3DQUERYTYPE_TIMESTAMP || type === D3DQUERYTYPE_TIMESTAMPDISJOINT;
}

function managerNeedsRebegin(manager: D3D9QueryManager | null, id: number): boolean {
    return manager !== null && manager.needsRebegin(id);
}

export class SplitQueryHost {
    private readonly queries = new Map<number, HostQuery>();
    private ready: SplitQueryResult[] = [];
    readonly counters: SplitQueryHostCounters = {
        created: 0, ends: 0, flushes: 0, posted: 0, unknown: 0, rearmFailed: 0, endsByType: {},
    };

    constructor(private readonly device: SplitQueryHostDevice) {}

    apply(op: string, queryPtr: number, arg: number): void {
        const ptr = queryPtr >>> 0;
        switch (op) {
            case "create": this.create(ptr, arg >>> 0); return;
            case "begin": this.begin(ptr); return;
            case "end": this.end(ptr, arg >>> 0); return;
            case "flush": this.flush(ptr, arg >>> 0); return;
            case "release": this.release(ptr); return;
            default: throw new Error(`split query host: unknown op ${op}`);
        }
    }

    private create(ptr: number, type: number): void {
        const stale = this.queries.get(ptr);
        if (stale) stale.manager?.release(ptr, stale.record);
        const q: HostQuery = {
            type, record: { type, begun: false, issued: false, issueSerial: 0 },
            manager: null, gpuMode: false, token: 0, posted: false,
        };
        this.queries.set(ptr, q);
        this.counters.created++;
        this.bind(ptr, q);
    }

    /** The current manager, (re)acquiring the query on it when the device was recreated. */
    private bind(ptr: number, q: HostQuery): D3D9QueryManager | null {
        const manager = this.device.getQueryManager();
        if (manager !== q.manager) {
            q.manager = manager;
            q.gpuMode = manager ? manager.acquire(ptr, q.record).mode === "gpu" : false;
        }
        return manager;
    }

    private lookup(ptr: number): HostQuery | null {
        const q = this.queries.get(ptr);
        if (!q) this.counters.unknown++;
        return q ?? null;
    }

    private rearm(ptr: number, q: HostQuery, manager: D3D9QueryManager): boolean {
        const handle = manager.rearm(ptr, q.record);
        if (!handle) { this.counters.rearmFailed++; return false; }
        q.gpuMode = handle.mode === "gpu";
        return true;
    }

    private begin(ptr: number): void {
        const q = this.lookup(ptr);
        if (!q) return;
        const manager = this.bind(ptr, q);
        q.token = 0;
        if (q.type !== D3DQUERYTYPE_OCCLUSION && q.type !== D3DQUERYTYPE_TIMESTAMPDISJOINT) return;
        // A refused re-arm leaves the query in its old state; the END that follows tries again.
        if (manager && q.record.issued && !this.rearm(ptr, q, manager)) return;
        q.record.begun = true;
        q.record.issued = false;
        q.record.issueSerial = 0;
        if (q.type === D3DQUERYTYPE_OCCLUSION) this.device.recordQueryBegin(ptr);
    }

    private end(ptr: number, token: number): void {
        const q = this.lookup(ptr);
        if (!q) {
            this.ready.push({ token, state: "unavailable", reason: "query-not-created" });
            return;
        }
        const manager = this.bind(ptr, q);
        this.counters.ends++;
        this.counters.endsByType[q.type] = (this.counters.endsByType[q.type] ?? 0) + 1;
        q.token = token;
        q.posted = false;
        if (!manager) {
            this.post(q, { token, state: "unavailable", reason: "no-device" });
            return;
        }
        if (q.type === D3DQUERYTYPE_OCCLUSION && !q.record.begun) {
            // END without BEGIN is an implicit zero-width interval; WebGPU still wants a pair.
            if ((q.record.issued || managerNeedsRebegin(manager, ptr)) && !this.rearm(ptr, q, manager)) {
                this.post(q, { token, state: "unavailable", reason: "query-rearm-failed" });
                return;
            }
            this.device.recordQueryBegin(ptr);
        } else if (q.type === D3DQUERYTYPE_OCCLUSION && managerNeedsRebegin(manager, ptr)) {
            // BEGIN was submitted in an earlier command buffer: a fresh local pair.
            if (!this.rearm(ptr, q, manager)) {
                this.post(q, { token, state: "unavailable", reason: "query-rearm-failed" });
                return;
            }
            q.record.begun = false;
            this.device.recordQueryBegin(ptr);
        }
        q.record.begun = false;
        q.record.issued = true;
        const serial = manager.getSubmittedSerial();
        q.record.issueSerial = needsSubmission(q.type) ? serial + 1 : serial;
        if (q.type === D3DQUERYTYPE_OCCLUSION) this.device.recordQueryEnd(ptr);
        else if (q.type === D3DQUERYTYPE_TIMESTAMP && q.gpuMode) this.device.recordQueryTimestamp(ptr);
    }

    /** D3DGETDATA_FLUSH: the same submission-domain advance query.ts makes on a local manager. */
    private flush(ptr: number, token: number): void {
        const q = this.lookup(ptr);
        if (!q || q.token !== token || !q.manager) return;
        this.counters.flushes++;
        q.manager.notifySubmitted(q.record.issueSerial);
    }

    private release(ptr: number): void {
        const q = this.lookup(ptr);
        if (!q) return;
        q.manager?.release(ptr, q.record);
        this.queries.delete(ptr);
    }

    private post(q: HostQuery, result: SplitQueryResult): void {
        q.posted = true;
        if (q.type === D3DQUERYTYPE_OCCLUSION || q.type === D3DQUERYTYPE_TIMESTAMP) this.ready.push(result);
    }

    /** Every generation that became answerable since the last call, each exactly once. */
    collect(): SplitQueryResult[] {
        for (const [ptr, q] of this.queries) {
            if (!q.token || q.posted) continue;
            const manager = q.manager;
            if (!manager || manager.isDeviceLost()) {
                this.post(q, { token: q.token, state: "unavailable", reason: manager?.getDeviceLossReason() ?? "no-device" });
                continue;
            }
            if (q.record.issueSerial > manager.getSubmittedSerial()) continue;
            if (q.type !== D3DQUERYTYPE_OCCLUSION && q.type !== D3DQUERYTYPE_TIMESTAMP) {
                this.post(q, { token: q.token, state: "ready" });
                continue;
            }
            const gpu = manager.poll(ptr);
            if (!q.gpuMode) {
                // No query set behind it: query.ts answers NOTAVAILABLE rather than a made-up count.
                this.post(q, {
                    token: q.token, state: "fallback",
                    reason: gpu.state === "fallback" || gpu.state === "unavailable" ? gpu.reason : "not-gpu",
                });
                continue;
            }
            if (gpu.state === "pending") continue;
            if (gpu.state === "ready") {
                this.post(q, {
                    token: q.token, state: "ready", value: gpu.value,
                    ...(gpu.sampleScale === undefined ? {} : { sampleScale: gpu.sampleScale }),
                    ...(gpu.sampleScaleMixed ? { sampleScaleMixed: true } : {}),
                });
            } else if (gpu.state === "fallback") {
                this.post(q, {
                    token: q.token, state: "fallback", reason: gpu.reason,
                    ...(gpu.value === undefined ? {} : { value: gpu.value }),
                });
            } else {
                this.post(q, { token: q.token, state: "unavailable", reason: gpu.reason });
            }
        }
        const out = this.ready;
        this.ready = [];
        this.counters.posted += out.length;
        return out;
    }

    /** A readback is still in flight for some awaited generation: collect() again once settled. */
    async inflight(): Promise<boolean> {
        const managers = new Set<D3D9QueryManager>();
        for (const q of this.queries.values()) {
            if (q.token && !q.posted && q.manager?.hasInflight()) managers.add(q.manager);
        }
        if (managers.size === 0) return false;
        await Promise.all([...managers].map((m) => m.settled()));
        return true;
    }
}
