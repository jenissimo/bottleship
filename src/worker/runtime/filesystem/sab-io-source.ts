// sab-io-source.ts
//
// Guest-side ZipSource whose synchronous readRangeSync is served by a dedicated
// I/O worker over a SharedArrayBuffer (see sab-io-protocol.ts). Replaces
// SyncHttpRangeSource: instead of a blocking network XHR on the guest thread,
// each cold read marshals a request into the SAB, wakes the I/O worker, and
// parks the guest cheaply on Atomics.wait until the I/O worker fills the buffer
// and notifies. The I/O worker fetches in parallel and prefetches ahead, so the
// wait is usually just the SAB round-trip, not a network round-trip.
//
// This source is wrapped one layer up by CachedSource (withBlockCache treats it
// as an "expensive sync" source), so the guest's hot reads are served from a
// local RAM block cache and only cold misses cross to the I/O worker.

import type { ZipSource } from "@bottleship/formats/zip";
import { Logger, LogCategory } from "../../core/logger";
import {
    SAB_TOTAL_BYTES, CTL_WORDS, CTL_STATE, CTL_RESP_LEN, CTL_ERRNO, CTL_RESP_SEQ,
    META_OFFSET_BYTES, META_REQ_OFF, META_REQ_LEN, META_REQ_SEQ, META_WORDS,
    DATA_OFFSET_BYTES, DATA_BYTES,
    ST_IDLE, ST_REQ, ST_ERR, WAIT_TIMEOUT_MS, CTL_IO_DEAD, CTL_REQ_SEQ, CTL_IO_HEARTBEAT,
    readIoWorkerStats, sabLayout,
} from "./sab-io-protocol";
import type { IoWorkerStats } from "./sab-io-protocol";
import type { ReadHint } from "@bottleship/formats/zip";
import { currentIoReadPolicy } from "./io-read-policy";

/**
 * Upper edges (ms) of the block-time histogram. Log-ish, because the two answers
 * this histogram has to separate are three orders of magnitude apart: a SAB
 * round-trip (tens of microseconds) and a cold network fetch (tens of ms).
 * A fat tail past 20 ms means bandwidth, not round-trip — which decides whether
 * parking the caller or fixing the prefetcher comes first.
 */
export const WAIT_BUCKETS_MS = [
    0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, Infinity,
] as const;

function bucketOf(ms: number): number {
    for (let i = 0; i < WAIT_BUCKETS_MS.length; i++) if (ms <= WAIT_BUCKETS_MS[i]) return i;
    return WAIT_BUCKETS_MS.length - 1;
}

/** Per-request block time, exact, over the most recent window. The histogram is
 *  lifetime but bucket-quantized; this is quantization-free but bounded. Both are
 *  reported, and they must broadly agree. */
const RECENT_SAMPLES = 4096;

export interface SabWaitStats {
    /** Requests issued (one SAB round-trip each). */
    requests: number;
    /** Atomics.wait CALLS. Note this is ≥ requests by construction: the first
     *  iteration cannot see a response published microseconds earlier in the same
     *  JS turn, because the I/O worker has not been scheduled yet. On its own it
     *  says nothing about blocking — that is `waitsBlocked`. */
    waitCalls: number;
    /** Waits that actually parked and were woken by the I/O worker's notify. */
    waitsBlocked: number;
    /** Waits that returned "not-equal" — the response landed between the load and
     *  the wait, so the guest never blocked. The only way this counter moves is a
     *  genuinely free round-trip. */
    waitsNotEqual: number;
    /** Wait slices that expire; `timeouts` counts exhausted request deadlines. */
    waitsTimedOut: number;
    timeouts: number;
    /** Responses shorter than the range asked for — each one is a read that failed. */
    shortReads: number;
    /** Wall-clock ms spent inside Atomics.wait, summed. EXCLUDES the postMessage
     *  marshalling before it and the copy-out after, so it reads slightly BELOW the
     *  self-time a profiler attributes to `request`. */
    waitMs: number;
    /** Per-request block time, lifetime, quantized to WAIT_BUCKETS_MS. */
    histogram: number[];
    bucketsMs: number[];
    recent: { n: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
}

/** The async channel's own numbers. `maxInFlight` is the one that means anything:
 *  wall time falls for free once a cache is warm, and a caller that awaits its reads
 *  one at a time gets a promise-shaped blocking channel and no overlap at all. */
export interface SabAsyncStats {
    requests: number;
    completed: number;
    failed: number;
    inFlight: number;
    maxInFlight: number;
    /** Summed request→response latency. Overlapped, so it exceeds wall time. */
    latencyMs: number;
    bytes: number;
}

/** The subset of `Worker` this source uses, so a test can drive the channel with a
 *  stub instead of spawning the real I/O worker (which needs fetch + a live URL). */
export interface SabWorkerLike {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    onmessage: ((e: MessageEvent) => void) | null;
    terminate(): void;
    onerror?: ((e: ErrorEvent) => void) | null;
    onmessageerror?: ((e: MessageEvent) => void) | null;
}

type Ready = { size: number; residencySab: SharedArrayBuffer; chunkBytes: number; etag: string | null };

export class SabIoSource implements ZipSource {
    readonly size: number;
    readonly syncFaultCapable = true;
    private failure: Error | null = null;
    private residency: Int32Array | null;
    private readonly url: string;
    readonly etag: string | null;
    readonly chunkBytes: number;
    private firstFrame: { at: number; waitMs: number } | null = null;
    private fillOrder: number[] | null = null;
    private closeTimer: ReturnType<typeof setTimeout> | null = null;

    private worker: SabWorkerLike;
    private readonly sab: SharedArrayBuffer;
    private recovery: Promise<void> | null = null;
    private recoveryController: AbortController | null = null;
    private restarted = false;
    private readonly ioCarry: Partial<Record<keyof IoWorkerStats, number>> = {};
    private readonly tune: unknown;
    private shutdownDone: (() => void) | null = null;
    private shutdownPromise: Promise<void> | null = null;
    private readonly ctl: Int32Array;
    private readonly meta: Float64Array;
    private readonly data: Uint8Array;

    // Guest-side interplay counters (mirror CachedSource's for diagnostics).
    private _requests = 0;
    private _waitCalls = 0;
    private _waitsBlocked = 0;
    private _waitsNotEqual = 0;
    private _waitsTimedOut = 0;
    private _timeouts = 0;
    private _shortReads = 0;
    /** Accumulated ms inside Atomics.wait. Two performance.now() calls per wait —
     *  ~100 ns each against a round-trip measured in tens of microseconds at best,
     *  so under 0.5% of the thing being measured, and zero cost on the warm path
     *  (CachedSource serves those without ever reaching here). */
    private _waitMs = 0;
    private readonly _hist = new Float64Array(WAIT_BUCKETS_MS.length);
    private readonly _recent = new Float64Array(RECENT_SAMPLES);
    private _recentN = 0;
    private _recentPos = 0;
    /** Request tag echoed back in CTL_RESP_SEQ — see sab-io-protocol. */
    private _seq = 0;

    // ---- async channel (postMessage + transferable response; no SAB, no wait) ----
    private _asyncId = 0;
    private readonly _pending = new Map<number, {
        resolve: (b: Uint8Array) => void; reject: (e: Error) => void; at: number; timer: ReturnType<typeof setTimeout>; len: number; off: number; hint?: ReadHint;
    }>();
    private _asyncRequests = 0;
    private _asyncCompleted = 0;
    private _asyncFailed = 0;
    private _asyncMaxInFlight = 0;
    private _asyncLatencyMs = 0;
    private _asyncBytes = 0;

    private constructor(worker: SabWorkerLike, sab: SharedArrayBuffer, size: number, residencySab?: SharedArrayBuffer, chunkBytes = 1 << 20, url = "", etag: string | null = null, tune?: unknown) {
        this.worker = worker;
        this.sab = sab;
        this.tune = tune ?? (globalThis as { __wgbIoTune?: unknown }).__wgbIoTune;
        this.ctl = new Int32Array(sab, 0, CTL_WORDS);
        this.meta = new Float64Array(sab, META_OFFSET_BYTES, META_WORDS);
        this.data = new Uint8Array(sab, DATA_OFFSET_BYTES, DATA_BYTES);
        this.size = size;
        this.residency = residencySab ? new Int32Array(residencySab) : null;
        this.chunkBytes = chunkBytes;
        this.url = url;
        this.etag = etag;
    }

    /**
     * Spawn the I/O worker, hand it the SAB + URL, and resolve once it has the
     * bundle size (a Range/HEAD probe). Throws if SharedArrayBuffer isn't
     * available (page not cross-origin isolated) or the worker fails to init —
     * the caller then stages a full local copy in OPFS.
     */
    static async create(url: string, tune?: { chunkKB?: number; maxInflight?: number; prefetchChunks?: number; cacheMB?: number; disk?: boolean }): Promise<SabIoSource> {
        if ((globalThis as unknown as { __wgbForceNoSab?: boolean }).__wgbForceNoSab) {
            throw new Error("SAB I/O disabled (__wgbForceNoSab)"); // dev A/B knob
        }
        if (typeof SharedArrayBuffer === "undefined" || !(globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
            throw new Error("SAB I/O unavailable: not cross-origin isolated");
        }
        const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
        const worker = new Worker(new URL("./io-worker.ts", import.meta.url), { type: "module" });

        let ready: Ready;
        try {
            ready = await this.initializeWorker(worker, sab, url, tune ?? (globalThis as { __wgbIoTune?: unknown }).__wgbIoTune);
        } catch (error) {
            worker.terminate();
            throw error;
        }
        const src = new SabIoSource(worker, sab, ready.size, ready.residencySab, ready.chunkBytes, url, ready.etag, tune);
        src.bindWorker();
        return src;
    }

    private static initializeWorker(worker: Worker, sab: SharedArrayBuffer, url: string, tune: unknown,
        expected?: { size: number; etag: string | null }, signal?: AbortSignal): Promise<Ready> {
        return new Promise<Ready>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); };
            const failed = (error: Error) => { cleanup(); reject(error); };
            const cancelled = () => failed(new Error("io-worker init cancelled"));
            const timer = setTimeout(() => failed(new Error("io-worker init timeout")), 60_000);
            signal?.addEventListener("abort", cancelled, { once: true });
            if (signal?.aborted) { cancelled(); return; }
            worker.onmessage = event => {
                const msg = event.data;
                if (msg?.type === "ready") { cleanup(); resolve(msg as Ready); }
                else if (msg?.type === "error") failed(new Error(String(msg.message)));
            };
            worker.onerror = event => failed(new Error(`io-worker error: ${event.message}`));
            worker.onmessageerror = () => failed(new Error("io-worker init message could not be decoded"));
            try { worker.postMessage({ type: "init", sab, url, tune, expected, layout: sabLayout() }); }
            catch (error) { failed(new Error(`io-worker init post failed: ${error}`)); }
        });
    }

    /** Bind a source to an already-created worker + SAB. `create` is the real entry
     *  point; this exists so the async channel can be exercised against a stub worker. */
    static attachForTest(worker: SabWorkerLike, sab: SharedArrayBuffer, size: number, residencySab?: SharedArrayBuffer, chunkBytes?: number): SabIoSource {
        const src = new SabIoSource(worker, sab, size, residencySab, chunkBytes);
        src.bindWorker();
        return src;
    }

    private bindWorker(): void {
        this.worker.onmessage = (event: MessageEvent) => this.onWorkerMessage(event.data);
        this.worker.onerror = (event: ErrorEvent) => this.recover(new Error(`SabIoSource: I/O worker crashed: ${event.message}`));
        this.worker.onmessageerror = () => this.recover(new Error("SabIoSource: I/O worker message could not be decoded"));
    }

    async restartWorker(): Promise<void> {
        this.recover(new Error("diagnostic restart"));
        await this.recovery;
        if (this.failure) throw this.failure;
    }

    private recover(error: Error): void {
        if (this.recovery || this.failure) return;
        if (this.restarted || !this.url || !this.etag) { this.fail(error); return; }
        this.restarted = true;
        const oldStats = readIoWorkerStats(this.ctl);
        for (const [key, value] of Object.entries(oldStats)) {
            if (typeof value === "number" && !["residentKB", "diskChunks"].includes(key)) this.ioCarry[key as keyof IoWorkerStats] = value;
        }
        this.worker.terminate();
        this.ctl.fill(0);
        try { this.worker = new Worker(new URL("./io-worker.ts", import.meta.url), { type: "module" }); }
        catch (error) { this.fail(new Error(`SabIoSource: restart spawn failed: ${error}`)); return; }
        this.recoveryController = new AbortController();
        this.recovery = SabIoSource.initializeWorker(this.worker as Worker, this.sab, this.url, this.tune, { size: this.size, etag: this.etag }, this.recoveryController.signal)
            .then(ready => {
                if (this.failure) { this.worker.terminate(); return; }
                this.residency = new Int32Array(ready.residencySab);
                this.bindWorker();
                for (const [id, pending] of this._pending) this.worker.postMessage({ type: "areq", id, off: pending.off, len: pending.len, hint: pending.hint });
                if (this.firstFrame && this.fillOrder) this.startFill(this.fillOrder);
            }).catch(error => this.fail(new Error(`SabIoSource: restart failed: ${error}`)))
            .finally(() => { this.recovery = null; this.recoveryController = null; });
    }

    private fail(error: Error): void {
        if (this.failure) return;
        this.failure = error;
        this.recoveryController?.abort();
        Atomics.store(this.ctl, CTL_IO_DEAD, 1);
        for (const [, pending] of this._pending) {
            clearTimeout(pending.timer);
            this._asyncFailed++;
            pending.reject(error);
        }
        this._pending.clear();
    }

    isResident(start: number, end: number): boolean {
        if (!this.residency) return false;
        for (let ci = Math.floor(start / this.chunkBytes); ci * this.chunkBytes < end; ci++) {
            if ((Atomics.load(this.residency, ci >> 5) & (1 << (ci & 31))) === 0) return false;
        }
        return true;
    }

    startFill(order: number[] = []): void {
        if (!this.failure) this.worker.postMessage({ type: "fill", order });
    }

    armFill(order: number[] = []): void { this.fillOrder = order; }

    async preloadChunks(order: number[]): Promise<void> {
        // Bound the caller's queue as well as the transport's active fetches.
        for (let i = 0; i < order.length; i += 2) {
            await Promise.all(order.slice(i, i + 2).map(ci => this.readRange(ci * this.chunkBytes, Math.min(this.size, (ci + 1) * this.chunkBytes))));
        }
    }

    async preloadFull(): Promise<void> {
        await this.preloadChunks(Array.from({ length: Math.ceil(this.size / this.chunkBytes) }, (_, ci) => ci));
    }

    markFirstFrame(): void {
        if (this.firstFrame) return;
        this.firstFrame = { at: performance.now(), waitMs: this._waitMs };
        if (this.fillOrder) this.startFill(this.fillOrder);
    }

    identity(): { url: string; etag: string | null; size: number; chunkBytes: number } {
        return { url: this.url, etag: this.etag, size: this.size, chunkBytes: this.chunkBytes };
    }

    private onWorkerMessage(msg: { type?: string; msg?: string; id?: number; ok?: boolean; buf?: ArrayBuffer; message?: string }): void {
        if (msg?.type === "closed") {
            if (this.closeTimer) clearTimeout(this.closeTimer);
            this.worker.terminate();
            this.shutdownDone?.();
            return;
        }
        if (msg?.type === "error") { this.fail(new Error(String(msg.message))); return; }
        if (msg?.type === "log") { Logger.log(LogCategory.SYSTEM, `[io-worker] ${msg.msg}`); return; }
        if (msg?.type !== "aresp") return;
        const p = this._pending.get(msg.id!);
        if (!p) return; // a response to a request that already timed out
        this._pending.delete(msg.id!);
        clearTimeout(p.timer);
        this._asyncLatencyMs += performance.now() - p.at;
        if (msg.ok && msg.buf && msg.buf.byteLength === p.len) {
            this._asyncCompleted++;
            this._asyncBytes += msg.buf.byteLength;
            p.resolve(new Uint8Array(msg.buf));
        } else {
            this._asyncFailed++;
            p.reject(new Error(`SabIoSource: async read failed: ${msg.message ?? "short response"}`));
        }
    }

    readRangeSync(start: number, end: number, hint?: ReadHint): Uint8Array | null {
        const s = Math.max(0, Math.min(Math.floor(start), this.size));
        const e = Math.max(s, Math.min(Math.floor(end), this.size));
        if (e <= s) return new Uint8Array(0);

        if (this.failure) throw this.failure;
        if (this.recovery) return null;
        const policy = currentIoReadPolicy();
        if (policy === "must-not-block" || (policy === "park-preferred" && !this.isResident(s, e))) return null;
        const total = e - s;
        if (total <= DATA_BYTES) {
            const response = this.request(s, total, hint);
            return response;
        }

        // A read larger than the SAB payload arena (rare — oversized central
        // directory): satisfy it in DATA_BYTES-sized pieces.
        const out = new Uint8Array(total);
        let off = 0;
        while (off < total) {
            const chunk = Math.min(DATA_BYTES, total - off);
            const response = this.request(s + off, chunk, hint);
            if (!response) return null;
            out.set(response, off);
            off += chunk;
        }
        return out;
    }

    /**
     * Async read. NOT the sync round-trip wearing a Promise: the request goes over
     * postMessage, the response comes back as a transferred ArrayBuffer, and nothing
     * on this path touches Atomics.wait — so many reads are in flight at once and the
     * guest's event loop (other threads, the audio pump, the frame loop) keeps running
     * while they land. This is what makes a background prefetcher over this source
     * background work rather than more blocking on the guest thread.
     */
    readRange(start: number, end: number, hint?: ReadHint): Promise<Uint8Array> {
        const s = Math.max(0, Math.min(Math.floor(start), this.size));
        const e = Math.max(s, Math.min(Math.floor(end), this.size));
        if (e <= s) return Promise.resolve(new Uint8Array(0));

        if (this.failure) return Promise.reject(this.failure);
        const id = ++this._asyncId;
        this._asyncRequests++;
        return new Promise<Uint8Array>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this._pending.delete(id)) return;
                this._asyncFailed++;
                reject(new Error(`SabIoSource: async read timed out (off=${s} len=${e - s})`));
            }, WAIT_TIMEOUT_MS);
            this._pending.set(id, { resolve, reject, at: performance.now(), timer, len: e - s, off: s, hint });
            if (this._pending.size > this._asyncMaxInFlight) this._asyncMaxInFlight = this._pending.size;
            try { if (!this.recovery) this.worker.postMessage({ type: "areq", id, off: s, len: e - s, hint }); }
            catch (error) { this.fail(new Error(`SabIoSource: post failed: ${error}`)); }
        });
    }

    /** Monotonic request tag; 0 is reserved as "no response yet". */
    private nextSeq(): number {
        this._seq = (this._seq + 1) | 0;
        if (this._seq === 0) this._seq = 1;
        return this._seq;
    }

    /** One SAB request/response round-trip. `len` must be ≤ DATA_BYTES. */
    private request(off: number, len: number, hint?: ReadHint): Uint8Array | null {
        if (this.failure) throw this.failure;
        this._requests++;
        const seq = this.nextSeq();
        this.meta[META_REQ_OFF] = off;
        this.meta[META_REQ_LEN] = len;
        this.meta[META_REQ_SEQ] = seq;
        Atomics.store(this.ctl, CTL_ERRNO, 0);
        Atomics.store(this.ctl, CTL_REQ_SEQ, seq);
        Atomics.store(this.ctl, CTL_STATE, ST_REQ);
        // The hint rides the wakeup message rather than the SAB: the request meta is a
        // single fixed slot and widening it is a wire-format change, while this message
        // is already sent per request and carries the same ordering.
        this.worker.postMessage({ type: "req", hint });

        // Park on the SEQUENCE word, not on STATE: STATE only says "a response exists",
        // and after an abandoned request that can be someone else's. Re-loading the
        // observed value before each wait closes the lost-wakeup race — if the worker
        // published between the load and the wait, Atomics.wait returns "not-equal".
        // Bracket the BLOCK, not the loop: `_waitCalls` is what the old `waits` counted
        // and it can never fall below `requests`, so only the bracketed time and the
        // wait's own return value say whether the guest actually stopped.
        let blockedMs = 0;
        const deadline = performance.now() + WAIT_TIMEOUT_MS;
        for (;;) {
            const seen = Atomics.load(this.ctl, CTL_RESP_SEQ);
            if (seen === seq) break;
            this._waitCalls++;
            const t0 = performance.now();
            const r = Atomics.wait(this.ctl, CTL_RESP_SEQ, seen, Math.min(500, Math.max(1, deadline - performance.now())));
            blockedMs += performance.now() - t0;
            if (r === "ok") this._waitsBlocked++;
            else if (r === "not-equal") this._waitsNotEqual++;
            else this._waitsTimedOut++;
            const heartbeat = Atomics.load(this.ctl, CTL_IO_HEARTBEAT);
            if (heartbeat && ((Date.now() | 0) - heartbeat | 0) > 4000) {
                this.recordBlock(blockedMs);
                this.recover(new Error("SabIoSource: I/O worker heartbeat stopped"));
                if (this.failure) throw this.failure;
                return null;
            }
            if (performance.now() >= deadline && Atomics.load(this.ctl, CTL_RESP_SEQ) !== seq) {
                this._timeouts++;
                this.recordBlock(blockedMs);
                Atomics.store(this.ctl, CTL_STATE, ST_IDLE);
                throw new Error(`SabIoSource: read timed out (off=${off} len=${len} seq=${seq})`);
            }
        }
        this.recordBlock(blockedMs);

        if (Atomics.load(this.ctl, CTL_STATE) === ST_ERR) {
            Atomics.store(this.ctl, CTL_STATE, ST_IDLE);
            throw new Error(`SabIoSource: I/O worker read error (off=${off} len=${len})`);
        }
        const rlen = Atomics.load(this.ctl, CTL_RESP_LEN);
        // Copy out of the shared arena before releasing the slot (the I/O worker
        // reuses it for the next request).
        const buf = this.data.slice(0, rlen);
        Atomics.store(this.ctl, CTL_STATE, ST_IDLE);
        // A SHORT answer is a failed read, not a small one: the range was already clamped to
        // the file, so every requested byte exists. Returning it would hand the caller zeros
        // where data belongs — an archive whose header table reads as empty, and a game that
        // reports its own assets missing, with nothing anywhere naming the read that failed.
        if (rlen !== len) {
            this._shortReads++;
            throw new Error(`SabIoSource: short read (off=${off} want=${len} got=${rlen})`);
        }
        return buf;
    }

    /** One request's total block time (0 when the response was already there). */
    private recordBlock(ms: number): void {
        this._waitMs += ms;
        this._hist[bucketOf(ms)]++;
        this._recent[this._recentPos] = ms;
        this._recentPos = (this._recentPos + 1) % RECENT_SAMPLES;
        if (this._recentN < RECENT_SAMPLES) this._recentN++;
    }

    /** Diagnostics: guest-side counters + the I/O worker's published counters
     *  (read straight off the SAB, no message round-trip). */
    stats(): { restarted: boolean; wait: SabWaitStats; async: SabAsyncStats; io: IoWorkerStats; gameplay: { elapsedMs: number; waitMs: number; stallMsPerMinute: number } | null } {
        const n = this._recentN;
        const sorted = Array.prototype.slice.call(this._recent, 0, n).sort((a: number, b: number) => a - b) as number[];
        const q = (p: number) => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(p * n))]);
        const io = readIoWorkerStats(this.ctl);
        for (const [key, value] of Object.entries(this.ioCarry)) (io as unknown as Record<string, number>)[key] += value;
        return {
            restarted: this.restarted,
            wait: {
                requests: this._requests,
                waitCalls: this._waitCalls,
                waitsBlocked: this._waitsBlocked,
                waitsNotEqual: this._waitsNotEqual,
                waitsTimedOut: this._waitsTimedOut,
                timeouts: this._timeouts,
                shortReads: this._shortReads,
                waitMs: this._waitMs,
                histogram: Array.from(this._hist),
                bucketsMs: Array.from(WAIT_BUCKETS_MS),
                recent: { n, p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: n ? sorted[n - 1] : 0 },
            },
            async: {
                requests: this._asyncRequests,
                completed: this._asyncCompleted,
                failed: this._asyncFailed,
                inFlight: this._pending.size,
                maxInFlight: this._asyncMaxInFlight,
                latencyMs: +this._asyncLatencyMs.toFixed(2),
                bytes: this._asyncBytes,
            },
            io,
            gameplay: this.firstFrame ? {
                elapsedMs: performance.now() - this.firstFrame.at,
                waitMs: this._waitMs - this.firstFrame.waitMs,
                stallMsPerMinute: (this._waitMs - this.firstFrame.waitMs) * 60_000 / Math.max(1, performance.now() - this.firstFrame.at),
            } : null,
        };
    }

    close(): void { void this.closeAsync(); }

    closeAsync(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shutdownPromise = new Promise<void>(resolve => { this.shutdownDone = resolve; });
        if (this.failure) { this.worker.terminate(); this.shutdownDone?.(); return this.shutdownPromise; }
        this.fail(new Error("SabIoSource: closed"));
        this.closeTimer = setTimeout(() => { this.worker.terminate(); this.shutdownDone?.(); }, 2000);
        try { this.worker.postMessage({ type: "close" }); }
        catch { this.worker.terminate(); this.shutdownDone?.(); }
        return this.shutdownPromise;
    }
}
