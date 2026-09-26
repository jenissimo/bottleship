/**
 * Split D3D9: what the render worker reports back that the front answers from SYNCHRONOUSLY —
 * query results and the lifecycle of the worker's GPUDevice. GetData and TestCooperativeLevel
 * are polled by the guest, so both are tables fed by messages and never awaited.
 */

import type { DeviceLossSource } from "../core/gpu/gpu-device-loss-contract";

/** One Issue(END) generation's result, as the render worker's query manager resolved it. */
export interface SplitQueryResult {
    /** The generation the front minted at END; a result for any other generation is stale. */
    token: number;
    /** `ready`: the fenced work was submitted and, for OCCLUSION/TIMESTAMP, `value` measured.
     *  `fallback`: the manager kept the query off the GPU (`value` only if it has one).
     *  `unavailable`: no result can exist (device lost, re-arm refused, never recorded). */
    state: "ready" | "fallback" | "unavailable";
    value?: bigint;
    sampleScale?: number;
    sampleScaleMixed?: boolean;
    reason?: string;
}

export interface SplitQueryCounters {
    /** ENDs whose generation the front is waiting on (OCCLUSION/TIMESTAMP: worker-measured). */
    ends: number;
    /** ENDs of EVENT/TIMESTAMPDISJOINT: ready at their ship, no worker result expected. */
    shipReadyEnds: number;
    /** Results the worker delivered for an awaited generation. */
    arrived: number;
    /** Results for a generation the front had already superseded or released. */
    stale: number;
    /** GetData answers taken from a worker result (the guest saw a GPU-side answer). */
    answered: number;
    /** GetData answers of a ship-ready generation (its END had shipped). */
    shipReadyAnswered: number;
    /** D3DGETDATA_FLUSH requests that shipped the stream. */
    flushes: number;
    /** Query boundaries the stream refused to record: that generation can never resolve. */
    unrecorded: number;
    /** Results by state. */
    ready: number;
    fallback: number;
    unavailable: number;
}

/**
 * The front's side of the query boundary. Generations are tokens minted here, unique for the
 * life of the render worker, so a recycled COM pointer or a re-issued query can never be
 * satisfied by an older generation's result.
 */
export class SplitQueryResultTable {
    private nextToken = 1;
    /** Awaited token -> its result, or null until it arrives. */
    private readonly awaited = new Map<number, SplitQueryResult | null>();
    readonly counters: SplitQueryCounters = {
        ends: 0, shipReadyEnds: 0, arrived: 0, stale: 0, answered: 0, shipReadyAnswered: 0,
        flushes: 0, unrecorded: 0, ready: 0, fallback: 0, unavailable: 0,
    };

    /** A new END: the generation GetData will wait for. */
    expect(): number {
        const token = this.nextToken++;
        this.awaited.set(token, null);
        this.counters.ends++;
        return token;
    }

    /** A generation nobody waits on a result for (ship-ready): still unique, never awaited, so
     *  a result arriving for it is stale. */
    mint(): number {
        this.counters.shipReadyEnds++;
        return this.nextToken++;
    }

    /** The generation will never be asked about again (re-issued, released). */
    forget(token: number): void {
        if (token) this.awaited.delete(token);
    }

    /** Settle a generation locally: its boundary never reached the worker. */
    settle(result: SplitQueryResult): void {
        if (!this.awaited.has(result.token)) return;
        this.awaited.set(result.token, result);
    }

    /** Results from the worker, in any order. Each generation is final once it has one. */
    accept(results: readonly SplitQueryResult[]): void {
        for (const r of results) {
            if (!this.awaited.has(r.token) || this.awaited.get(r.token) !== null) {
                this.counters.stale++;
                continue;
            }
            this.awaited.set(r.token, r);
            this.counters.arrived++;
            this.counters[r.state]++;
        }
    }

    /** undefined while the generation's result has not arrived. */
    result(token: number): SplitQueryResult | undefined {
        return this.awaited.get(token) ?? undefined;
    }

    noteAnswered(): void {
        this.counters.answered++;
    }

    noteShipReadyAnswered(): void {
        this.counters.shipReadyAnswered++;
    }

    /** Generations still waiting for a result. */
    outstanding(): number {
        let n = 0;
        for (const v of this.awaited.values()) if (v === null) n++;
        return n;
    }
}

/** What query.ts talks to on a front whose twin is in the render worker (built in split.ts). */
export interface SplitQueryChannel {
    /** CreateQuery(TIMESTAMP) support, as the worker's device answers it. */
    timestampSupported(): boolean;
    create(queryPtr: number, type: number): void;
    /** Issue(BEGIN); `previous` is the generation it supersedes (0 for none). */
    begin(queryPtr: number, previous: number): void;
    /** Issue(END), explicit or implicit; returns the generation's token. `shipReady`: GetData
     *  answers at the ship, so no worker result is awaited for it. */
    end(queryPtr: number, previous: number, shipReady: boolean): number;
    /** D3DGETDATA_FLUSH: ship the stream so the generation's work reaches the worker now. */
    flush(queryPtr: number, token: number): void;
    /** The ship that will carry everything recorded so far (taken right after `end`). */
    shipMark(): number;
    /** Has the ship `mark` named left for the worker? */
    shipped(mark: number): boolean;
    release(queryPtr: number, token: number): void;
    result(token: number): SplitQueryResult | undefined;
    noteAnswered(): void;
    noteShipReadyAnswered(): void;
}

export type RemoteGpuStatus = "ok" | "lost" | "unavailable";

export interface RemoteGpuObserver {
    onDeviceLost?(): void;
    onDeviceRecreated?(): void;
}

/**
 * The render worker's GPUDevice lifecycle, mirrored on the emulator worker: the loss source of
 * every split front (gpu-device-loss-contract.ts). Transitions fire the same two observer
 * phases gpuDeviceLifecycle does. A generation that moved while both snapshots were usable is a
 * loss and a recreation the front did not see separately, and is reported as both.
 */
export class RemoteGpuLifecycle implements DeviceLossSource {
    private state: RemoteGpuStatus = "ok";
    private gen = 0;
    losses = 0;
    recreations = 0;
    private readonly observers = new Set<RemoteGpuObserver>();

    generation(): number { return this.gen; }
    isUsable(): boolean { return this.state === "ok"; }
    status(): RemoteGpuStatus { return this.state; }

    subscribe(observer: RemoteGpuObserver): () => void {
        this.observers.add(observer);
        return () => { this.observers.delete(observer); };
    }

    apply(status: RemoteGpuStatus, generation: number): void {
        const wasUsable = this.isUsable();
        const moved = generation !== this.gen;
        this.state = status;
        this.gen = generation;
        const usable = this.isUsable();
        if (wasUsable && (!usable || moved)) {
            this.losses++;
            for (const o of [...this.observers]) o.onDeviceLost?.();
        }
        if (usable && (!wasUsable || moved)) {
            this.recreations++;
            for (const o of [...this.observers]) o.onDeviceRecreated?.();
        }
    }
}
