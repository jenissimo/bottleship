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
    CTL_IO_NET_FETCHES, CTL_IO_PREFETCHES, CTL_REQS,
    CTL_IO_CHUNKS_NEEDED, CTL_IO_CHUNKS_RESIDENT_HIT, CTL_IO_CHUNKS_JOINED_INFLIGHT,
    CTL_IO_CHUNKS_FETCHED_COLD, CTL_IO_CHUNKS_REFETCHED_AFTER_EVICT,
    CTL_IO_REQS_ALL_RESIDENT, CTL_IO_REQS_NO_NEW_FETCH,
    CTL_IO_EVICTIONS, CTL_IO_RESIDENT_KB, CTL_IO_ARMED,
    CTL_IO_NET_KB, CTL_IO_PREFETCH_EVICTED_UNREAD_KB, CTL_IO_ASYNC_REQS,
    CTL_IO_CFG_CHUNK_KB, CTL_IO_CFG_CACHE_MB, CTL_IO_CFG_PREFETCH_CHUNKS, CTL_IO_CFG_MAX_INFLIGHT,
    META_OFFSET_BYTES, META_REQ_OFF, META_REQ_LEN, META_REQ_SEQ, META_WORDS,
    DATA_OFFSET_BYTES, DATA_BYTES,
    publishResponse, layoutMismatch,
} from "./sab-io-protocol";
import type { ReadHint } from "@bottleship/formats/zip";

/** Network fetch granularity. Covering chunks are fetched IN PARALLEL, so this
 *  trades per-fetch overhead against how many bytes a BLOCKING read has to wait for:
 *  a 1 MiB guest read over 2 MiB chunks waits on up to 4 MiB of transfer it will not
 *  use. 1 MiB keeps the critical path close to what was asked for while still being
 *  a large enough range that per-fetch cost stays in the noise. */
const CHUNK_DEFAULT = 1 << 20;
let CHUNK = CHUNK_DEFAULT;
/** How far ahead of a HINTED sequential read to pull, in chunks, never past the
 *  entry's own end. 0 = off. EMPIRICAL, and deliberately the smallest window that
 *  still bridges the gap between two of the guest's runs: the guest's block cache is
 *  the working set and the layer that knows the cursor, so this one only keeps the
 *  pipe warm rather than being a second speculator. Trade: larger wins on a strictly
 *  sequential reader and costs bandwidth plus evictions on everything else — which is
 *  why it is bounded by the entry extent and only fires on a sequential hint, so a
 *  workload that disagrees loses the readahead rather than paying for it. */
let PREFETCH_AHEAD_CHUNKS = 2;
/** Max concurrent network fetches (cold + prefetch). Kept a couple below the
 *  browser's per-origin connection cap so a cold guest request is never queued
 *  behind a wall of prefetches. Tunable via init. */
const MAX_INFLIGHT_DEFAULT = 6;
let MAX_INFLIGHT = MAX_INFLIGHT_DEFAULT;
/** Fetch slots a SPECULATIVE request may occupy: DERIVED as half the transport
 *  budget, so a read someone is blocked on never queues behind more guesses than
 *  there are reserved slots. With one budget for both, a station switch's cold read
 *  waited behind a wall of prefetches and the guest paid the whole queue. */
function speculativeSlotLimit(): number { return Math.max(1, MAX_INFLIGHT >> 1); }

/** Resident chunk-cache budget in the I/O worker (LRU). DERIVED: the transport can
 *  have MAX_INFLIGHT × CHUNK bytes moving at once, and a staging buffer wants room
 *  for several such waves so a chunk survives long enough to be collected. It is a
 *  STAGING buffer, not a second working set — the guest's own block cache holds the
 *  working set in the same process, and sizing both at 256 MB had two LRUs thrashing
 *  over one set of bytes. Recomputed after `init` applies its tuning; an explicit
 *  cacheMB overrides it. */
const STAGING_WAVES = 8;
let MAX_CACHE_BYTES = MAX_INFLIGHT_DEFAULT * CHUNK_DEFAULT * STAGING_WAVES;

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
let requests = 0;
let asyncRequests = 0;
let evictions = 0;
/** Bytes pulled over the network, cold and speculative alike. */
let netBytes = 0;
/** Chunks fetched speculatively that no guest request has read yet. A chunk leaves
 *  this set the moment a request covers it — so what is still in it at eviction time
 *  was fetched and never read, which is the only honest thing to call it. */
const prefetchedUnread = new Set<number>();
let prefetchEvictedUnreadBytes = 0;

// Per-chunk accounting for the chunks a GUEST request needed. The three outcomes
// partition `chunksNeeded`, so the report can assert they add up — the check the
// counter these replace never had.
let chunksNeeded = 0;
let chunksResidentHit = 0;
let chunksJoinedInflight = 0;
let chunksFetchedCold = 0;
let requestsAllResident = 0;
let requestsNoNewFetch = 0;
let chunksRefetchedAfterEvict = 0;

/** Recently-evicted chunk indices, so a fetch of a chunk we already had (and threw
 *  away) is identifiable. A bounded ring: `evictedCount` is the multiset, `evictedRing`
 *  the eviction order, so an index that falls out of the window stops being counted
 *  rather than accumulating forever. Sized to ~one LRU's worth of 2 MiB chunks. */
const EVICTED_RING = 4096;
const evictedRing = new Int32Array(EVICTED_RING).fill(-1);
const evictedCount = new Map<number, number>();
let evictedPos = 0;

function noteEvicted(ci: number): void {
    const old = evictedRing[evictedPos];
    if (old >= 0) {
        const n = (evictedCount.get(old) ?? 1) - 1;
        if (n > 0) evictedCount.set(old, n); else evictedCount.delete(old);
    }
    evictedRing[evictedPos] = ci;
    evictedPos = (evictedPos + 1) % EVICTED_RING;
    evictedCount.set(ci, (evictedCount.get(ci) ?? 0) + 1);
}

/** Woken whenever a fetch settles, so a deferred speculative request can re-check
 *  the budget instead of polling. A fetch always settles (its catch deletes it too),
 *  so a waiter cannot be stranded. */
let slotWaiters: Array<() => void> = [];
function releaseSlot(): void {
    if (slotWaiters.length === 0) return;
    const woken = slotWaiters;
    slotWaiters = [];
    for (const w of woken) w();
}

/** Hold a speculative request until the transport has a slot to spare. */
async function awaitSpeculativeSlot(): Promise<void> {
    let guard = 0;
    while (inflight.size >= speculativeSlotLimit() && guard++ < 64) {
        await new Promise<void>((r) => slotWaiters.push(r));
    }
}

function touch(ci: number): void {
    const i = lru.indexOf(ci);
    if (i >= 0) lru.splice(i, 1);
    lru.push(ci);
}

function evictIfNeeded(): void {
    while (residentBytes > MAX_CACHE_BYTES && lru.length > 1) {
        const victim = lru.shift()!;
        const b = chunks.get(victim);
        if (b) {
            residentBytes -= b.byteLength; chunks.delete(victim); evictions++; noteEvicted(victim);
            if (prefetchedUnread.delete(victim)) prefetchEvictedUnreadBytes += b.byteLength;
        }
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
    if (evictedCount.has(ci)) chunksRefetchedAfterEvict++;
    if (prefetch) { prefetches++; prefetchedUnread.add(ci); } else netFetches++;
    const p = src.readRange(start, end)
        .then((buf) => {
            // A SHORT Range response must never be memoized: `serve` sizes its output from the
            // request, so a truncated chunk in the cache serves full length with a zero-filled
            // tail — silently corrupt, for the rest of the session, with no retry. Reject it
            // and let the request fail; the next read re-fetches.
            if (buf.byteLength !== end - start) {
                throw new Error(
                    `short range read for chunk ${ci}: got ${buf.byteLength} of ${end - start} bytes at ${start}`);
            }
            netBytes += buf.byteLength;
            if (!chunks.has(ci)) {
                chunks.set(ci, buf);
                lru.push(ci);
                residentBytes += buf.byteLength;
                evictIfNeeded();
            } else {
                touch(ci);
            }
            inflight.delete(ci);
            releaseSlot();
            return chunks.get(ci)!;
        })
        .catch((err) => { inflight.delete(ci); releaseSlot(); throw err; });
    inflight.set(ci, p);
    return p;
}

/** Assemble [off, off+len) from covering chunks, fetching missing ones in PARALLEL. */
async function serve(off: number, len: number, speculative = false): Promise<Uint8Array> {
    const src = source!;
    const e = Math.min(src.size, off + len);
    const first = Math.floor(off / CHUNK);
    const last = Math.floor((e - 1) / CHUNK);

    // Classify BEFORE fetching: once getChunk runs, a chunk it started is resident-or-
    // in-flight and the distinction the counters exist for is gone. A chunk already in
    // `inflight` is a prefetch this request rides on — the case the old `cacheServes`
    // scored as a miss.
    // A speculative request is readahead, not a request the guest is waiting on, so it
    // is deliberately absent from these counters: counting it would inflate
    // `chunksNeeded` with chunks nobody needed yet and make the outcome split describe
    // the prefetcher instead of the guest.
    if (!speculative) {
        let resident = 0, joined = 0, cold = 0;
        for (let c = first; c <= last; c++) {
            if (chunks.has(c)) resident++;
            else if (inflight.has(c)) joined++;
            else cold++;
            prefetchedUnread.delete(c);
        }
        chunksNeeded += last - first + 1;
        chunksResidentHit += resident;
        chunksJoinedInflight += joined;
        chunksFetchedCold += cold;
        if (cold === 0 && joined === 0) requestsAllResident++;
        if (cold === 0) requestsNoNewFetch++;
    }

    const need: Array<Promise<Uint8Array>> = [];
    for (let c = first; c <= last; c++) need.push(getChunk(c, speculative));
    const parts = await Promise.all(need);

    const out = new Uint8Array(e - off);
    let filled = 0;
    for (let c = first; c <= last; c++) {
        const b = parts[c - first];
        const cs = c * CHUNK;
        const copyS = Math.max(off, cs);
        const copyE = Math.min(e, cs + b.byteLength);
        if (copyE > copyS) { out.set(b.subarray(copyS - cs, copyE - cs), copyS - off); filled += copyE - copyS; }
    }
    // Any gap would ship as a zero-filled tail the guest cannot tell from real bytes.
    if (filled !== out.length) throw new Error(`assembled ${filled} of ${out.length} bytes for [${off}, ${e})`);
    return out;
}

/**
 * Read ahead of the just-served range — but ONLY on an explicit hint, and never past
 * the end of the entry the hint names.
 *
 * The blind linear version this replaces anchored on `off + len` and speculated on
 * every request. It could not know a STORED entry ended a few chunks away, so at a
 * file boundary it fetched bytes belonging to some unrelated file; it could not know
 * a seek had moved the cursor, so its whole window died at once; and because the
 * guest's own readahead run was already the next 8 MiB, it mostly duplicated it one
 * step ahead from a layer that knows strictly less. The hint carries what it was
 * missing: the entry extent and whether the caller is actually scanning.
 */
function prefetchAhead(fromOff: number, hint: ReadHint | undefined): void {
    if (!hint?.sequential) return;
    const src = source!;
    const limit = Math.min(src.size, hint.entryEnd);
    if (fromOff >= limit) return;
    const startChunk = Math.floor(fromOff / CHUNK);
    for (let i = 0; i < PREFETCH_AHEAD_CHUNKS; i++) {
        const ci = startChunk + i;
        if (ci * CHUNK >= limit) break;
        if (chunks.has(ci) || inflight.has(ci)) continue;
        if (inflight.size >= MAX_INFLIGHT) break;
        void getChunk(ci, true).catch(() => { /* re-fetched on demand */ });
    }
}

/** Publish the counters into the SAB. Called after each request completes, so a
 *  purely prefetch-driven change (an eviction, a speculative fetch) becomes visible
 *  at the next request rather than instantly — a report taken mid-idle can lag the
 *  worker's true state by one request. */
function publishStats(): void {
    if (!ctl) return;
    Atomics.store(ctl, CTL_IO_NET_FETCHES, netFetches | 0);
    Atomics.store(ctl, CTL_IO_PREFETCHES, prefetches | 0);
    Atomics.store(ctl, CTL_REQS, requests | 0);
    Atomics.store(ctl, CTL_IO_CHUNKS_NEEDED, chunksNeeded | 0);
    Atomics.store(ctl, CTL_IO_CHUNKS_RESIDENT_HIT, chunksResidentHit | 0);
    Atomics.store(ctl, CTL_IO_CHUNKS_JOINED_INFLIGHT, chunksJoinedInflight | 0);
    Atomics.store(ctl, CTL_IO_CHUNKS_FETCHED_COLD, chunksFetchedCold | 0);
    Atomics.store(ctl, CTL_IO_CHUNKS_REFETCHED_AFTER_EVICT, chunksRefetchedAfterEvict | 0);
    Atomics.store(ctl, CTL_IO_REQS_ALL_RESIDENT, requestsAllResident | 0);
    Atomics.store(ctl, CTL_IO_REQS_NO_NEW_FETCH, requestsNoNewFetch | 0);
    Atomics.store(ctl, CTL_IO_EVICTIONS, evictions | 0);
    Atomics.store(ctl, CTL_IO_RESIDENT_KB, (residentBytes / 1024) | 0);
    Atomics.store(ctl, CTL_IO_NET_KB, (netBytes / 1024) | 0);
    Atomics.store(ctl, CTL_IO_PREFETCH_EVICTED_UNREAD_KB, (prefetchEvictedUnreadBytes / 1024) | 0);
    Atomics.store(ctl, CTL_IO_ASYNC_REQS, asyncRequests | 0);
}

/** Sequence of the newest request the guest published. A completion for anything older
 *  is ABANDONED (the guest timed out on it and moved on) and must not be published: the
 *  DATA arena is a single slot, so writing it would corrupt the response the guest is
 *  currently waiting for or copying out. */
let currentSeq = 0;

async function handleRequest(hint: ReadHint | undefined): Promise<void> {
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
        prefetchAhead(off + len, hint);
    } catch (err) {
        publishStats();
        if (!publishResponse(c, d, seq, currentSeq, null)) return;
        (self as unknown as Worker).postMessage({ type: "log", msg: `io-worker read failed off=${off} len=${len}: ${err}` });
    }
}

/**
 * Async request: no SAB, no futex. The response is a fresh buffer TRANSFERRED back,
 * so many of these can be outstanding at once and none of them stops the guest — which
 * is the whole point of the channel: a prefetcher over this source is background work,
 * not another blocking read on the guest thread.
 */
async function handleAsyncRequest(id: number, off: number, len: number, hint: ReadHint | undefined): Promise<void> {
    asyncRequests++;
    const post = (self as unknown as Worker).postMessage.bind(self);
    try {
        if (hint?.speculative) await awaitSpeculativeSlot();
        const buf = await serve(off, len, hint?.speculative === true);
        publishStats();
        // Transfer, don't copy: the guest's block cache slices what it needs out of it.
        post({ type: "aresp", id, ok: true, buf: buf.buffer }, [buf.buffer]);
        prefetchAhead(off + len, hint);
    } catch (err) {
        publishStats();
        post({ type: "aresp", id, ok: false, message: String(err) });
    }
}

self.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === "init") {
        // Both sides import the layout from one module, so a disagreement means one of
        // them is a stale build — and the consequence is not a crash but bytes read from
        // the wrong offsets, forever, silently. Refuse instead.
        const mismatch = layoutMismatch(msg.layout);
        if (mismatch) {
            (self as unknown as Worker).postMessage({ type: "error", message: `SAB layout mismatch (${mismatch})` });
            return;
        }
        ctl = new Int32Array(msg.sab, 0, CTL_WORDS);
        meta = new Float64Array(msg.sab, META_OFFSET_BYTES, META_WORDS);
        data = new Uint8Array(msg.sab, DATA_OFFSET_BYTES, DATA_BYTES);
        const tune = msg.tune as { prefetchChunks?: number; maxInflight?: number; cacheMB?: number; chunkKB?: number } | undefined;
        if (tune) {
            if (typeof tune.chunkKB === "number") CHUNK = Math.max(64, tune.chunkKB | 0) * 1024;
            if (typeof tune.prefetchChunks === "number") PREFETCH_AHEAD_CHUNKS = Math.max(0, tune.prefetchChunks | 0);
            if (typeof tune.maxInflight === "number") MAX_INFLIGHT = Math.max(1, tune.maxInflight | 0);
            // Chunk size and concurrency are what the staging budget is derived from, so
            // re-derive after they are applied; an explicit cacheMB still wins.
            MAX_CACHE_BYTES = MAX_INFLIGHT * CHUNK * STAGING_WAVES;
            if (typeof tune.cacheMB === "number") MAX_CACHE_BYTES = Math.max(16, tune.cacheMB | 0) * 1024 * 1024;
        }
        // Echo the EFFECTIVE tuning and arm the counters, so a report can say what
        // configuration produced its numbers and distinguish "zero" from "not counting".
        Atomics.store(ctl, CTL_IO_CFG_CHUNK_KB, (CHUNK / 1024) | 0);
        Atomics.store(ctl, CTL_IO_CFG_CACHE_MB, (MAX_CACHE_BYTES / (1024 * 1024)) | 0);
        Atomics.store(ctl, CTL_IO_CFG_PREFETCH_CHUNKS, PREFETCH_AHEAD_CHUNKS | 0);
        Atomics.store(ctl, CTL_IO_CFG_MAX_INFLIGHT, MAX_INFLIGHT | 0);
        Atomics.store(ctl, CTL_IO_ARMED, 1);
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
        void handleRequest(msg.hint as ReadHint | undefined);
        return;
    }
    if (msg?.type === "areq") {
        void handleAsyncRequest(msg.id as number, msg.off as number, msg.len as number, msg.hint as ReadHint | undefined);
        return;
    }
};
