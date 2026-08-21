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
    ST_IDLE, ST_REQ, ST_ERR, WAIT_TIMEOUT_MS,
    readIoWorkerStats,
} from "./sab-io-protocol";
import type { IoWorkerStats } from "./sab-io-protocol";

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
    /** Waits that hit WAIT_TIMEOUT_MS. */
    waitsTimedOut: number;
    timeouts: number;
    /** Wall-clock ms spent inside Atomics.wait, summed. EXCLUDES the postMessage
     *  marshalling before it and the copy-out after, so it reads slightly BELOW the
     *  self-time a profiler attributes to `request`. */
    waitMs: number;
    /** Per-request block time, lifetime, quantized to WAIT_BUCKETS_MS. */
    histogram: number[];
    bucketsMs: number[];
    recent: { n: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
}

export class SabIoSource implements ZipSource {
    readonly size: number;

    private readonly worker: Worker;
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

    private constructor(worker: Worker, sab: SharedArrayBuffer, size: number) {
        this.worker = worker;
        this.ctl = new Int32Array(sab, 0, CTL_WORDS);
        this.meta = new Float64Array(sab, META_OFFSET_BYTES, META_WORDS);
        this.data = new Uint8Array(sab, DATA_OFFSET_BYTES, DATA_BYTES);
        this.size = size;
    }

    /**
     * Spawn the I/O worker, hand it the SAB + URL, and resolve once it has the
     * bundle size (a Range/HEAD probe). Throws if SharedArrayBuffer isn't
     * available (page not cross-origin isolated) or the worker fails to init —
     * the caller then falls back to SyncHttpRangeSource / OPFS staging.
     */
    static async create(url: string): Promise<SabIoSource> {
        if ((globalThis as unknown as { __wgbForceNoSab?: boolean }).__wgbForceNoSab) {
            throw new Error("SAB I/O disabled (__wgbForceNoSab)"); // dev A/B knob
        }
        if (typeof SharedArrayBuffer === "undefined" || !(globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
            throw new Error("SAB I/O unavailable: not cross-origin isolated");
        }
        const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
        const worker = new Worker(new URL("./io-worker.ts", import.meta.url), { type: "module" });

        const size = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("io-worker init timeout")), 15_000);
            worker.onmessage = (e: MessageEvent) => {
                const msg = e.data;
                if (msg?.type === "ready") { clearTimeout(timer); resolve(msg.size as number); }
                else if (msg?.type === "error") { clearTimeout(timer); reject(new Error(String(msg.message))); }
                else if (msg?.type === "log") { Logger.log(LogCategory.SYSTEM, `[io-worker] ${msg.msg}`); }
            };
            worker.onerror = (e: ErrorEvent) => { clearTimeout(timer); reject(new Error(`io-worker error: ${e.message}`)); };
            // Dev-only I/O tuning knob (prefetch window / concurrency / cache MB).
            const tune = (globalThis as unknown as { __wgbIoTune?: unknown }).__wgbIoTune;
            worker.postMessage({ type: "init", sab, url, tune });
        });

        // Keep forwarding I/O-worker logs after init.
        worker.onmessage = (e: MessageEvent) => {
            if (e.data?.type === "log") Logger.log(LogCategory.SYSTEM, `[io-worker] ${e.data.msg}`);
        };

        return new SabIoSource(worker, sab, size);
    }

    readRangeSync(start: number, end: number): Uint8Array {
        const s = Math.max(0, Math.min(Math.floor(start), this.size));
        const e = Math.max(s, Math.min(Math.floor(end), this.size));
        if (e <= s) return new Uint8Array(0);

        const total = e - s;
        if (total <= DATA_BYTES) return this.request(s, total);

        // A read larger than the SAB payload arena (rare — oversized central
        // directory): satisfy it in DATA_BYTES-sized pieces.
        const out = new Uint8Array(total);
        let off = 0;
        while (off < total) {
            const chunk = Math.min(DATA_BYTES, total - off);
            out.set(this.request(s + off, chunk), off);
            off += chunk;
        }
        return out;
    }

    /** Async read (used by ZipArchive.init and non-sync consumers). In a worker
     *  the sync round-trip is available, so reuse it — init is a short, serial
     *  prelude, so briefly blocking there is fine. */
    async readRange(start: number, end: number): Promise<Uint8Array> {
        return this.readRangeSync(start, end);
    }

    /** Monotonic request tag; 0 is reserved as "no response yet". */
    private nextSeq(): number {
        this._seq = (this._seq + 1) | 0;
        if (this._seq === 0) this._seq = 1;
        return this._seq;
    }

    /** One SAB request/response round-trip. `len` must be ≤ DATA_BYTES. */
    private request(off: number, len: number): Uint8Array {
        this._requests++;
        const seq = this.nextSeq();
        this.meta[META_REQ_OFF] = off;
        this.meta[META_REQ_LEN] = len;
        this.meta[META_REQ_SEQ] = seq;
        Atomics.store(this.ctl, CTL_ERRNO, 0);
        Atomics.store(this.ctl, CTL_STATE, ST_REQ);
        this.worker.postMessage({ type: "req" });

        // Park on the SEQUENCE word, not on STATE: STATE only says "a response exists",
        // and after an abandoned request that can be someone else's. Re-loading the
        // observed value before each wait closes the lost-wakeup race — if the worker
        // published between the load and the wait, Atomics.wait returns "not-equal".
        // Bracket the BLOCK, not the loop: `_waitCalls` is what the old `waits` counted
        // and it can never fall below `requests`, so only the bracketed time and the
        // wait's own return value say whether the guest actually stopped.
        let blockedMs = 0;
        for (;;) {
            const seen = Atomics.load(this.ctl, CTL_RESP_SEQ);
            if (seen === seq) break;
            this._waitCalls++;
            const t0 = performance.now();
            const r = Atomics.wait(this.ctl, CTL_RESP_SEQ, seen, WAIT_TIMEOUT_MS);
            blockedMs += performance.now() - t0;
            if (r === "ok") this._waitsBlocked++;
            else if (r === "not-equal") this._waitsNotEqual++;
            else this._waitsTimedOut++;
            if (r === "timed-out" && Atomics.load(this.ctl, CTL_RESP_SEQ) !== seq) {
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
    stats(): { wait: SabWaitStats; io: IoWorkerStats } {
        const n = this._recentN;
        const sorted = Array.prototype.slice.call(this._recent, 0, n).sort((a: number, b: number) => a - b) as number[];
        const q = (p: number) => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(p * n))]);
        return {
            wait: {
                requests: this._requests,
                waitCalls: this._waitCalls,
                waitsBlocked: this._waitsBlocked,
                waitsNotEqual: this._waitsNotEqual,
                waitsTimedOut: this._waitsTimedOut,
                timeouts: this._timeouts,
                waitMs: this._waitMs,
                histogram: Array.from(this._hist),
                bucketsMs: Array.from(WAIT_BUCKETS_MS),
                recent: { n, p50Ms: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: n ? sorted[n - 1] : 0 },
            },
            io: readIoWorkerStats(this.ctl),
        };
    }

    close(): void {
        try { this.worker.terminate(); } catch { /* best-effort */ }
    }
}
