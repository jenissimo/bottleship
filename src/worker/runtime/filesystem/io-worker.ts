// io-worker.ts
//
// Dedicated I/O worker: owns the network transport for a streamed WGB bundle and
// serves the guest worker's synchronous reads over the SAB protocol
// (sab-io-protocol.ts). Its event loop is NEVER blocked, so unlike the guest it
// can fetch many ranges in parallel and prefetch ahead of the guest's cursor —
// turning the guest's serial, latency-bound cold reads into a bandwidth-bound
// pipeline. Cold reads the guest asks for are usually already resident here
// (prefetched), so the guest wakes after ~a SAB round-trip, not a network one.
//
// Cache granularity is a large CHUNK (not the guest's 256 KiB block) so each
// network fetch is a big, few-round-trip transfer, and a guest readahead run is
// satisfied by fetching its covering chunks IN PARALLEL (Promise.all).

import { HttpRangeSource } from "@bottleship/formats/zip";
import type { ZipSource } from "@bottleship/formats/zip";
import {
    CTL_WORDS,
    CTL_IO_NET_FETCHES, CTL_IO_PREFETCHES, CTL_IO_CACHE_SERVES, CTL_REQS,
    META_OFFSET_BYTES, META_REQ_OFF, META_REQ_LEN, META_REQ_SEQ, META_WORDS,
    DATA_OFFSET_BYTES, DATA_BYTES,
    publishResponse,
} from "./sab-io-protocol";

/** Network fetch granularity. A guest readahead run (≤ 8 MiB) is fetched as its
 *  covering chunks IN PARALLEL, so the chunk size trades per-fetch overhead
 *  against within-request parallelism: too small (e.g. 1 MiB → 8 fetches/run)
 *  and fixed per-fetch cost dominates when the data is warm; 2 MiB keeps a run to
 *  ~4 concurrent fetches while roughly halving the fetch count. */
let CHUNK = 2 << 20;
/** Resident chunk-cache budget in the I/O worker (LRU). Sized to comfortably hold
 *  a boot working set plus the prefetch window without thrash. Tunable via init. */
let MAX_CACHE_BYTES = 256 * 1024 * 1024;
/** How far ahead of the last request offset to keep prefetched, in chunks. 0 =
 *  off (pure parallel cold fetch). Kept SMALL: a boot streams most of the bundle
 *  in SCATTERED order (measured — most requests jump to a new file), so a wide
 *  linear-ahead window mostly fetches chunks the guest never asks for, wasting
 *  bandwidth the critical cold fetches need and evicting live data. A small
 *  window still catches the immediate-continuation case cheaply. Tunable via init. */
let PREFETCH_AHEAD_CHUNKS = 4;
/** Max concurrent network fetches (cold + prefetch). Kept a couple below the
 *  browser's per-origin connection cap so a cold guest request is never queued
 *  behind a wall of prefetches. Tunable via init. */
let MAX_INFLIGHT = 6;

let ctl: Int32Array | null = null;
let meta: Float64Array | null = null;
let data: Uint8Array | null = null;
let source: ZipSource | null = null;

const chunks = new Map<number, Uint8Array>();
const inflight = new Map<number, Promise<Uint8Array>>();
const lru: number[] = [];
let residentBytes = 0;

let netFetches = 0;   // cold, on the guest's critical path
let prefetches = 0;   // speculative, ahead of the cursor
let cacheServes = 0;  // requests answered with zero cold fetch
let requests = 0;

function touch(ci: number): void {
    const i = lru.indexOf(ci);
    if (i >= 0) lru.splice(i, 1);
    lru.push(ci);
}

function evictIfNeeded(): void {
    while (residentBytes > MAX_CACHE_BYTES && lru.length > 1) {
        const victim = lru.shift()!;
        const b = chunks.get(victim);
        if (b) { residentBytes -= b.byteLength; chunks.delete(victim); }
    }
}

/** Fetch chunk `ci` (coalesced). `prefetch` flags a speculative fetch for stats. */
function getChunk(ci: number, prefetch: boolean): Promise<Uint8Array> {
    const have = chunks.get(ci);
    if (have) { touch(ci); return Promise.resolve(have); }
    const pending = inflight.get(ci);
    if (pending) return pending;

    const src = source!;
    const start = ci * CHUNK;
    const end = Math.min(src.size, start + CHUNK);
    if (prefetch) prefetches++; else netFetches++;
    const p = src.readRange(start, end)
        .then((buf) => {
            if (!chunks.has(ci)) {
                chunks.set(ci, buf);
                lru.push(ci);
                residentBytes += buf.byteLength;
                evictIfNeeded();
            } else {
                touch(ci);
            }
            inflight.delete(ci);
            return chunks.get(ci)!;
        })
        .catch((err) => { inflight.delete(ci); throw err; });
    inflight.set(ci, p);
    return p;
}

/** Assemble [off, off+len) from covering chunks, fetching missing ones in PARALLEL. */
async function serve(off: number, len: number): Promise<Uint8Array> {
    const src = source!;
    const e = Math.min(src.size, off + len);
    const first = Math.floor(off / CHUNK);
    const last = Math.floor((e - 1) / CHUNK);
    const allResident = (() => { for (let c = first; c <= last; c++) if (!chunks.has(c)) return false; return true; })();
    if (allResident) cacheServes++;

    const need: Array<Promise<Uint8Array>> = [];
    for (let c = first; c <= last; c++) need.push(getChunk(c, false));
    const parts = await Promise.all(need);

    const out = new Uint8Array(e - off);
    for (let c = first; c <= last; c++) {
        const b = parts[c - first];
        const cs = c * CHUNK;
        const copyS = Math.max(off, cs);
        const copyE = Math.min(e, cs + b.byteLength);
        if (copyE > copyS) out.set(b.subarray(copyS - cs, copyE - cs), copyS - off);
    }
    return out;
}

/** Speculatively pull chunks ahead of the just-served range, in parallel, bounded
 *  by MAX_INFLIGHT — anchored to the actual request offset so it follows the
 *  guest's real cursor (and re-anchors on a seek to a new file) rather than
 *  blindly linear-scanning a multi-GB archive. */
function prefetchAhead(fromOff: number): void {
    const src = source!;
    const startChunk = Math.floor(fromOff / CHUNK);
    for (let i = 0; i < PREFETCH_AHEAD_CHUNKS; i++) {
        const ci = startChunk + i;
        if (ci * CHUNK >= src.size) break;
        if (chunks.has(ci) || inflight.has(ci)) continue;
        if (inflight.size >= MAX_INFLIGHT) break;
        void getChunk(ci, true).catch(() => { /* re-fetched on demand */ });
    }
}

function publishStats(): void {
    if (!ctl) return;
    Atomics.store(ctl, CTL_IO_NET_FETCHES, netFetches | 0);
    Atomics.store(ctl, CTL_IO_PREFETCHES, prefetches | 0);
    Atomics.store(ctl, CTL_IO_CACHE_SERVES, cacheServes | 0);
    Atomics.store(ctl, CTL_REQS, requests | 0);
}

/** Sequence of the newest request the guest published. A completion for anything older
 *  is ABANDONED (the guest timed out on it and moved on) and must not be published: the
 *  DATA arena is a single slot, so writing it would corrupt the response the guest is
 *  currently waiting for or copying out. */
let currentSeq = 0;

async function handleRequest(): Promise<void> {
    const c = ctl!, m = meta!, d = data!;
    const off = m[META_REQ_OFF];
    const len = m[META_REQ_LEN];
    const seq = m[META_REQ_SEQ];
    currentSeq = seq;
    requests++;
    try {
        const buf = await serve(off, len);
        publishStats();
        if (!publishResponse(c, d, seq, currentSeq, buf)) return; // abandoned request
        // Keep the pipeline full ahead of where the guest just read.
        prefetchAhead(off + len);
    } catch (err) {
        publishStats();
        if (!publishResponse(c, d, seq, currentSeq, null)) return;
        (self as unknown as Worker).postMessage({ type: "log", msg: `io-worker read failed off=${off} len=${len}: ${err}` });
    }
}

self.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === "init") {
        ctl = new Int32Array(msg.sab, 0, CTL_WORDS);
        meta = new Float64Array(msg.sab, META_OFFSET_BYTES, META_WORDS);
        data = new Uint8Array(msg.sab, DATA_OFFSET_BYTES, DATA_BYTES);
        const tune = msg.tune as { prefetchChunks?: number; maxInflight?: number; cacheMB?: number; chunkKB?: number } | undefined;
        if (tune) {
            if (typeof tune.chunkKB === "number") CHUNK = Math.max(64, tune.chunkKB | 0) * 1024;
            if (typeof tune.prefetchChunks === "number") PREFETCH_AHEAD_CHUNKS = Math.max(0, tune.prefetchChunks | 0);
            if (typeof tune.maxInflight === "number") MAX_INFLIGHT = Math.max(1, tune.maxInflight | 0);
            if (typeof tune.cacheMB === "number") MAX_CACHE_BYTES = Math.max(16, tune.cacheMB | 0) * 1024 * 1024;
        }
        HttpRangeSource.create(msg.url)
            .then((s) => {
                source = s;
                (self as unknown as Worker).postMessage({ type: "ready", size: s.size });
            })
            .catch((err) => {
                (self as unknown as Worker).postMessage({ type: "error", message: String(err) });
            });
        return;
    }
    if (msg?.type === "req") {
        // Fire-and-forget: the guest is parked on Atomics.wait; handleRequest
        // always publishes a terminal STATE + notifies, even on error, so the
        // guest can never hang on a missed wakeup.
        void handleRequest();
        return;
    }
};
