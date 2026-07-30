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
    CTL_IO_NET_FETCHES, CTL_IO_PREFETCHES, CTL_IO_CACHE_SERVES, CTL_REQS,
    META_OFFSET_BYTES, META_REQ_OFF, META_REQ_LEN, META_REQ_SEQ, META_WORDS,
    DATA_OFFSET_BYTES, DATA_BYTES,
    ST_IDLE, ST_REQ, ST_ERR, WAIT_TIMEOUT_MS,
} from "./sab-io-protocol";
import type { IoWorkerStats } from "./sab-io-protocol";

export class SabIoSource implements ZipSource {
    readonly size: number;

    private readonly worker: Worker;
    private readonly ctl: Int32Array;
    private readonly meta: Float64Array;
    private readonly data: Uint8Array;

    // Guest-side interplay counters (mirror CachedSource's for diagnostics).
    private _requests = 0;
    private _waits = 0;
    private _timeouts = 0;
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
        for (;;) {
            const seen = Atomics.load(this.ctl, CTL_RESP_SEQ);
            if (seen === seq) break;
            this._waits++;
            const r = Atomics.wait(this.ctl, CTL_RESP_SEQ, seen, WAIT_TIMEOUT_MS);
            if (r === "timed-out" && Atomics.load(this.ctl, CTL_RESP_SEQ) !== seq) {
                this._timeouts++;
                Atomics.store(this.ctl, CTL_STATE, ST_IDLE);
                throw new Error(`SabIoSource: read timed out (off=${off} len=${len} seq=${seq})`);
            }
        }

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

    /** Diagnostics: guest-side counters + the I/O worker's published counters
     *  (read straight off the SAB, no message round-trip). */
    stats(): { requests: number; waits: number; timeouts: number; io: IoWorkerStats } {
        return {
            requests: this._requests,
            waits: this._waits,
            timeouts: this._timeouts,
            io: {
                netFetches: Atomics.load(this.ctl, CTL_IO_NET_FETCHES),
                prefetches: Atomics.load(this.ctl, CTL_IO_PREFETCHES),
                cacheServes: Atomics.load(this.ctl, CTL_IO_CACHE_SERVES),
                requests: Atomics.load(this.ctl, CTL_REQS),
            },
        };
    }

    close(): void {
        try { this.worker.terminate(); } catch { /* best-effort */ }
    }
}
