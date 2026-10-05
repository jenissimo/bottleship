/**
 * Split D3D9, emulator-worker side of the render worker (plan/d3d9-threaded/P2-PLAN.md, Stage B).
 *
 * The front device records into the WBUF queue as in the in-process split; at every fence the
 * queue's bytes go here instead of being executed, and the render worker replays them into its
 * own D3D9Device on its own GPUDevice. The worker has no guest memory: everything it needs rides
 * in the stream (payloads, recorded calls) or in the handler table sent alongside.
 */

import type { RemoteTwinScreen, SplitRemote } from "../modules/d3d9/split";
import type { D3D9Device } from "../backends/webgpu/d3d9/d3d9-device";
import { D3D9ScreenLayer, type D3D9ScreenLayerStats } from "../backends/webgpu/d3d9/d3d9-screen-layer";
import type { D3D9FrameMeta } from "../backends/webgpu/d3d9/d3d9-frame-handoff";
import type { WebGPUBackend } from "../backends/webgpu/webgpu-backend";
import { System } from "../core/system";
import type { SplitReplayStats } from "../backends/webgpu/d3d9/split-replay";
import { Logger, LogCategory } from "../core/logger";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { recordGpuError, type GpuErrorKind } from "../core/gpu-error-log";
import {
    RemoteGpuLifecycle, SplitQueryResultTable, type RemoteGpuStatus, type SplitQueryResult,
} from "./d3d9-remote-state";

export interface RenderHandlerSource {
    getWbufHandlerGeneration(): number;
    describeTransportSafeHandlers(): { generation: number; entries: Array<[number, string, number]> };
}

export function d3d9SplitWorkerWanted(): boolean {
    // On unless a boot opts out with `false`; CreateDevice still falls back when the worker cannot start.
    return (globalThis as { __d3d9SplitWorker?: boolean }).__d3d9SplitWorker !== false;
}

/** Every primitive `__flag` on the worker's globalThis: the render worker's own switches must
 *  read what this worker's do, or an A/B measures one arm on one side only. */
function snapshotFlags(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(globalThis)) {
        if (!key.startsWith("__")) continue;
        const v = (globalThis as Record<string, unknown>)[key];
        if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") out[key] = v;
    }
    return out;
}

export interface RenderWorkerCounters {
    batches: number;
    bytes: number;
    retiredBatch: number;
    maxInFlight: number;
    /** Most Present-bearing batches unretired as a Present let the guest go (<= depth). */
    maxPresentsInFlight: number;
    backpressureWaits: number;
    /** Batches shipped in a buffer the worker handed back (no fresh allocation). */
    recycledBatches: number;
}

/**
 * Queue bytes [0, end) for one shipped batch: in a buffer the worker returned with an earlier
 * batch when one is large enough, else a new one with headroom so later batches can reuse it.
 * `recycle` off is the per-batch copy into an exact-size fresh buffer.
 */
export function fillSplitBatchBuffer(pool: ArrayBuffer[], queue: Uint8Array, end: number, recycle: boolean,
    counters: { recycledBatches: number }): Uint8Array {
    if (!recycle) {
        pool.length = 0;
        return queue.slice(0, end);
    }
    while (pool.length) {
        const buf = pool.pop()!;
        if (buf.byteLength < end) continue;
        const out = new Uint8Array(buf);
        out.set(queue.subarray(0, end));
        counters.recycledBatches++;
        return out;
    }
    const out = new Uint8Array(end + (end >> 2) + 4096);
    out.set(queue.subarray(0, end));
    return out;
}

/** Shipped batches that carry a Present and are not retired yet: the frames in flight. */
export class SplitPresentBacklog {
    private readonly serials: number[] = [];

    /** A Present just shipped in batch `batch` (the latest), unless that batch already retired. */
    notePresent(batch: number, retiredBatch: number): void {
        if (batch <= retiredBatch || this.serials[this.serials.length - 1] === batch) return;
        this.serials.push(batch);
    }

    retire(retiredBatch: number): void {
        while (this.serials.length && this.serials[0]! <= retiredBatch) this.serials.shift();
    }

    inFlight(): number { return this.serials.length; }
}

let client: D3D9RenderClient | null = null;

/** The one render worker, started by the first split device. */
export function getD3D9RenderClient(handlers?: RenderHandlerSource): D3D9RenderClient | null {
    if (!client && handlers && !renderWorkerFailed) client = new D3D9RenderClient(handlers);
    return client;
}

/** Set once the render worker failed to come up: every later device stays single. */
let renderWorkerFailed = false;

/**
 * The render client, once its worker holds a GPU device — or null, and the caller keeps a single
 * device. A GPU-less front with no twin would present nothing and report a lost device forever.
 */
export async function acquireD3D9RenderClient(handlers: RenderHandlerSource, timeoutMs = 10_000): Promise<D3D9RenderClient | null> {
    const c = getD3D9RenderClient(handlers);
    if (!c) return null;
    if (await c.whenReady(timeoutMs)) return c;
    renderWorkerFailed = true;
    client = null;
    c.terminate();
    Logger.warn(LogCategory.D3D9, `[split] render worker unavailable (${c.lastError ?? "timeout"}); D3D9 stays on one device`);
    return null;
}

export class D3D9RenderClient implements SplitRemote {
    private readonly worker: Worker;
    private sentHandlerGeneration = -1;
    private sentMethodCount = 0;
    private batch = 0;
    private lastStats: SplitReplayStats | null = null;
    private readonly pending = new Map<number, (value: unknown) => void>();
    private readonly retireWaiters: Array<() => void> = [];
    private readonly screens = new Map<number, D3D9ScreenLayer>();
    /** Frames that arrived for a slot with no screen (closed unshown). */
    orphanFrames = 0;
    private nextRequest = 1;
    private targetWidth = 0;
    private targetHeight = 0;
    private targetQuality: unknown = null;
    readonly counters: RenderWorkerCounters = {
        batches: 0, bytes: 0, retiredBatch: 0, maxInFlight: 0, maxPresentsInFlight: 0, backpressureWaits: 0, recycledBatches: 0,
    };
    private readonly presents = new SplitPresentBacklog();
    /** Batch buffers the worker returned on `retired`, for the next ships to fill. */
    private readonly returnedBuffers: ArrayBuffer[] = [];
    lastError: string | null = null;
    readonly queryResults = new SplitQueryResultTable();
    readonly gpuLifecycle = new RemoteGpuLifecycle();
    /** The worker device's timestamp-query feature, once it reported in. */
    private workerTimestampQuery: boolean | null = null;
    private readyState: boolean | null = null;
    private readonly readyWaiters: Array<(ok: boolean) => void> = [];

    constructor(private readonly handlers: RenderHandlerSource) {
        this.worker = new Worker(new URL("./d3d9-render-worker.ts", import.meta.url), { type: "module", name: "d3d9-render" });
        this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
        this.worker.onerror = (e: ErrorEvent) => {
            this.lastError = `${e.message} @ ${e.filename}:${e.lineno}`;
            Logger.error(LogCategory.D3D9, `[split] render worker error: ${this.lastError}`);
            this.settleReady(false);
        };
        this.worker.postMessage({ type: "init", flags: snapshotFlags() });
    }

    /** True once the worker reported a live GPU device; false on an init failure or timeout. */
    whenReady(timeoutMs: number): Promise<boolean> {
        if (this.readyState !== null) return Promise.resolve(this.readyState);
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.settleReady(false), timeoutMs);
            this.readyWaiters.push((ok) => { clearTimeout(timer); resolve(ok); });
        });
    }

    terminate(): void { this.worker.terminate(); }

    private settleReady(ok: boolean): void {
        if (this.readyState !== null) return;
        this.readyState = ok;
        for (const wake of this.readyWaiters.splice(0)) wake(ok);
    }

    createTwin(slot: number, isExtended: boolean, front: D3D9Device): RemoteTwinScreen {
        this.worker.postMessage({ type: "twin", slot, isExtended });
        const backend = System.getInstance().services.render.getBackend() as WebGPUBackend;
        const layer = new D3D9ScreenLayer(backend, front);
        this.screens.set(slot, layer);
        return {
            repaintLastFrame: () => layer.repaintLastFrame(),
            getLastPresentDrawCount: () => layer.getLastPresentDrawCount(),
            capturePresentedLayer: async () => {
                const png = await this.request("capture", { slot }) as Uint8Array | null;
                return png && png.length ? new Blob([png.slice()], { type: "image/png" }) : null;
            },
            readPresentedRgba: async () =>
                await this.request("presentedRgba", { slot }) as { rgba: Uint8Array; width: number; height: number } | null,
        };
    }

    screenStats(): Record<number, D3D9ScreenLayerStats> {
        const out: Record<number, D3D9ScreenLayerStats> = {};
        for (const [slot, layer] of this.screens) out[slot] = layer.getStats();
        return out;
    }

    /** Until the worker reports its device, this worker's own answers: both request their
     *  device through the same WebGPUBackend code from the same adapter. */
    timestampQuerySupported(): boolean {
        if (this.workerTimestampQuery !== null) return this.workerTimestampQuery;
        const backend = System.getInstance().services.render.getBackend() as WebGPUBackend | null;
        return backend?.getDevice()?.features.has("timestamp-query") === true;
    }

    async fetchTexture(slot: number, texPtr: number, method: string): Promise<{ data: Uint8Array | null; answer: unknown }> {
        const reply = await this.request("textureData", { slot, texPtr, method }) as { data?: Uint8Array | null; answer?: unknown } | null;
        return { data: reply?.data ?? null, answer: reply?.answer };
    }

    /** The render worker picks the internal scale from the present target and quality, both
     *  owned here; it gets them again whenever either changes, ahead of the batch they affect. */
    private syncPresentTarget(): void {
        const backend = System.getInstance().services.render.getBackend() as WebGPUBackend | null;
        const size = backend?.getCanvasSize();
        const quality = EmulatorConfig.getInstance().quality;
        if (!size || size.width <= 0 || size.height <= 0) return;
        if (size.width === this.targetWidth && size.height === this.targetHeight && quality === this.targetQuality) return;
        this.targetWidth = size.width;
        this.targetHeight = size.height;
        this.targetQuality = quality;
        this.worker.postMessage({ type: "target", width: size.width, height: size.height, quality });
    }

    ship(queue: Uint8Array, end: number, splitRecordId: number, methodNames: readonly string[]): void {
        this.syncPresentTarget();
        const generation = this.handlers.getWbufHandlerGeneration();
        const table = generation !== this.sentHandlerGeneration ? this.handlers.describeTransportSafeHandlers() : null;
        if (table) this.sentHandlerGeneration = table.generation;
        const bytes = this.batchBuffer(queue, end);
        const newNames = methodNames.slice(this.sentMethodCount);
        const methodBase = this.sentMethodCount;
        this.sentMethodCount = methodNames.length;
        const batch = ++this.batch;
        this.counters.batches++;
        this.counters.bytes += end;
        const inFlight = batch - this.counters.retiredBatch;
        if (inFlight > this.counters.maxInFlight) this.counters.maxInFlight = inFlight;
        this.worker.postMessage({
            type: "queue", batch, bytes: bytes.buffer, end, splitRecordId, methodBase, methodNames: newNames,
            handlers: table?.entries ?? null,
        }, [bytes.buffer]);
    }

    private batchBuffer(queue: Uint8Array, end: number): Uint8Array {
        const recycle = !(globalThis as { __d3d9SplitNoQueueRecycle?: boolean }).__d3d9SplitNoQueueRecycle;
        return fillSplitBatchBuffer(this.returnedBuffers, queue, end, recycle, this.counters);
    }

    /** The last replay statistics the worker reported; a fresh report is requested each call. */
    replayStats(reset: boolean): SplitReplayStats | null {
        void this.request("stats", { reset }).then((s) => { this.lastStats = (s as { replay: SplitReplayStats }).replay; });
        return this.lastStats;
    }

    /** Ask the render worker something; answered in stream order, after everything shipped. */
    request(kind: string, payload: Record<string, unknown> = {}): Promise<unknown> {
        const id = this.nextRequest++;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.worker.postMessage({ type: "request", id, kind, ...payload });
        });
    }

    /**
     * Resolve once no more than `depth` shipped FRAMES are still being replayed. Awaited by the
     * front's Present after it shipped its frame: the guest may run at most `depth` frames ahead
     * of the pixels, and the queue stays bounded when the render worker is the slower side.
     * Counted in Present-bearing batches, not batches: mid-frame ships (GetData FLUSH, readback
     * fences) would otherwise shrink the window to a fraction of a frame.
     */
    async waitForBacklog(depth: number): Promise<void> {
        await null; // the Present's own batch ships in the same turn, after this was called
        this.presents.notePresent(this.batch, this.counters.retiredBatch);
        while (this.presents.inFlight() > depth) {
            this.counters.backpressureWaits++;
            await new Promise<void>((resolve) => this.retireWaiters.push(resolve));
        }
        // Taken as the guest is let go: above `depth` only if the gate itself failed.
        const frames = this.presents.inFlight();
        if (frames > this.counters.maxPresentsInFlight) this.counters.maxPresentsInFlight = frames;
    }

    private applyGpu([status, generation]: [RemoteGpuStatus, number]): void {
        const before = this.gpuLifecycle.status();
        this.gpuLifecycle.apply(status, generation);
        if (before !== status) {
            Logger[status === "ok" ? "log" : "error"](LogCategory.D3D9,
                `[split] render worker GPU device ${status} (generation ${generation}): D3D9 devices follow it`);
        }
    }

    setFlag(name: string, value: unknown): void {
        this.worker.postMessage({ type: "flags", flags: { [name]: value } });
    }

    private onMessage(msg: {
        type: string; id?: number; batch?: number; value?: unknown; message?: string;
        slot?: number; bitmap?: ImageBitmap; meta?: D3D9FrameMeta;
        gpuErrors?: Array<[string, string, string, number]>;
        queryResults?: SplitQueryResult[];
        gpu?: [RemoteGpuStatus, number];
        timestampQuery?: boolean;
        bytes?: ArrayBuffer;
    }): void {
        switch (msg.type) {
            case "d3d9Frame": {
                const layer = this.screens.get(msg.slot ?? -1);
                if (layer && msg.bitmap && msg.meta) layer.presentFrame(msg.bitmap, msg.meta);
                else { this.orphanFrames++; msg.bitmap?.close(); }
                return;
            }
            case "ready":
                this.workerTimestampQuery = msg.timestampQuery === true;
                if (msg.gpu) this.gpuLifecycle.apply(msg.gpu[0], msg.gpu[1]);
                this.settleReady(!msg.gpu || msg.gpu[0] === "ok");
                return;
            case "gpuLifecycle":
                if (msg.gpu) this.applyGpu(msg.gpu);
                return;
            case "queryResults":
                if (msg.queryResults) this.queryResults.accept(msg.queryResults);
                return;
            case "retired":
                this.counters.retiredBatch = msg.batch ?? this.counters.retiredBatch;
                this.presents.retire(this.counters.retiredBatch);
                if (msg.bytes && this.returnedBuffers.length < 4) this.returnedBuffers.push(msg.bytes);
                if (msg.gpu) this.applyGpu(msg.gpu);
                if (msg.queryResults) this.queryResults.accept(msg.queryResults);
                if (msg.gpuErrors) {
                    for (const [kind, site, message, count] of msg.gpuErrors) {
                        recordGpuError(kind as GpuErrorKind, `renderWorker:${site}`, message, count);
                    }
                }
                if (this.retireWaiters.length) for (const wake of this.retireWaiters.splice(0)) wake();
                return;
            case "reply": {
                const resolve = this.pending.get(msg.id!);
                this.pending.delete(msg.id!);
                resolve?.(msg.value);
                return;
            }
            case "error":
                this.lastError = msg.message ?? "unknown";
                // A worker that never got a device renders nothing: that is a lost device.
                if (msg.message?.startsWith("init:")) {
                    this.applyGpu(["unavailable", this.gpuLifecycle.generation()]);
                    this.settleReady(false);
                }
                Logger.error(LogCategory.D3D9, `[split] render worker: ${this.lastError}`);
                return;
        }
    }
}
