// sab-io-protocol.ts
//
// Shared-memory protocol between the GUEST worker (v86) and a dedicated I/O
// worker, used to serve the guest's SYNCHRONOUS file reads without blocking the
// guest thread on a network round-trip.
//
// WHY
// ---
// The guest's ReadFile/getc is synchronous, and our sync fast-path needs a
// synchronous ZipSource.readRangeSync. Backing that with a synchronous XHR on
// the guest worker freezes the whole guest for the full network round-trip AND
// forbids any overlap: while the worker is parked inside xhr.send() no async
// callback (prefetch, readahead) can run. So the guest is stuck doing hundreds
// of serial, latency-bound round-trips — measured ~260 for a Discworld Noir
// boot, ~44 ms each, ~11.5 s wall, at 1/10th of disk bandwidth.
//
// This protocol decouples the sync FACADE from the async I/O: the guest writes a
// request into a SharedArrayBuffer, wakes the I/O worker, and parks cheaply on
// Atomics.wait (NOT holding a network op). The I/O worker — whose event loop is
// never blocked — fetches in parallel, prefetches ahead, fills the SAB, and
// Atomics.notify()s the guest. Cold reads the I/O worker already prefetched
// return in ~a SAB round-trip; the guest's own block cache still serves hot
// reads with no crossing at all.
//
// The guest has at most one request it is still WAITING on, but a request it abandoned
// (timeout) may still be in flight on the I/O worker, so responses are tagged with a
// sequence number: the guest waits for its own, and the worker drops a completion whose
// sequence is no longer current BEFORE touching the shared payload arena (both sides are
// needed — the arena is single-slot, so a late writer would otherwise corrupt the bytes
// the guest is copying out).
//
// SAB LAYOUT (single outstanding request — the guest is single-threaded):
//   [0, 128)           control    Int32Array(32) — Atomics futex + counters
//   [128, 160)         meta       Float64Array(4) — 64-bit request offset/len
//   [160, 160+DATA)    data       Uint8Array     — response payload arena
//
// The control block is oversized on purpose: it is the only channel through which
// the I/O worker's diagnostics reach the guest without a message round-trip, and a
// counter that needs a round-trip to read is a counter nobody reads during a stall.

/** Max payload per request. The guest's largest single read is its block-cache
 *  readahead run (32 × 256 KiB = 8 MiB); 16 MiB leaves headroom (central
 *  directory reads, future larger runs). Requests past this are chunked. */
export const DATA_BYTES = 16 * 1024 * 1024;

export const CTL_BYTES = 128;
export const META_BYTES = 32;
export const META_OFFSET_BYTES = CTL_BYTES;          // 32
export const DATA_OFFSET_BYTES = CTL_BYTES + META_BYTES; // 64
export const SAB_TOTAL_BYTES = DATA_OFFSET_BYTES + DATA_BYTES;

// ---- control Int32Array indices (Atomics) ----
/** Futex word the guest waits on; the I/O worker stores a terminal state + notifies. */
export const CTL_STATE = 0;
/** Response byte count (≤ DATA_BYTES), written before STATE is published. */
export const CTL_RESP_LEN = 1;
/** Non-zero on a failed read (network error / short read). */
export const CTL_ERRNO = 2;
// Diagnostic counters the I/O worker publishes so the guest can read the
// getc↔streaming interplay synchronously (no extra message round-trip).
/** Cold network range fetches driven by a guest request (a real miss). */
export const CTL_IO_NET_FETCHES = 3;
/** Speculative prefetch fetches issued ahead of the guest cursor. */
export const CTL_IO_PREFETCHES = 4;
/** Guest requests whose covering chunks were ALL fully resident at entry — no fetch
 *  of any kind, not even a join. */
export const CTL_IO_REQS_ALL_RESIDENT = 5;
/** Total requests the I/O worker has answered. */
export const CTL_REQS = 6;
/**
 * Sequence number of the response currently in the DATA arena. The guest waits for its
 * OWN sequence here and ignores anything else: without an identity the two sides only
 * agree on "a response exists", so after one WAIT_TIMEOUT the guest abandons request A,
 * issues B, and consumes A's late answer as B's — right length, bytes from a different
 * offset, and the desync then persists for every later request.
 */
export const CTL_RESP_SEQ = 7;

// ---- I/O-worker chunk accounting (Stage 0 instruments) ----
// Every guest request is satisfied from a set of COVERING CHUNKS. Each of those
// chunks is in exactly one of three states when the request reaches it, so
// NEEDED == RESIDENT_HIT + JOINED_INFLIGHT + FETCHED_COLD is an invariant the
// reader can check — which is the point: the counter this replaces (cacheServes)
// had no such cross-check and was silently measuring something else.
/** Covering chunks looked up on behalf of a GUEST request (prefetch excluded). */
export const CTL_IO_CHUNKS_NEEDED = 8;
/** …of those, already fully resident in the I/O worker's cache. */
export const CTL_IO_CHUNKS_RESIDENT_HIT = 9;
/** …of those, already being fetched (usually by a prefetch) — the request joins that
 *  promise. Saves the extra round trip but still waits on the network. */
export const CTL_IO_CHUNKS_JOINED_INFLIGHT = 10;
/** …of those, neither resident nor in flight: the request started a network fetch. */
export const CTL_IO_CHUNKS_FETCHED_COLD = 11;
/** Fetches (guest or prefetch) of a chunk this worker had fetched and then EVICTED.
 *  Non-zero means the LRU is thrashing against its own speculation. */
export const CTL_IO_CHUNKS_REFETCHED_AFTER_EVICT = 12;
/** Guest requests that started NO new network fetch (every chunk resident or already
 *  in flight). This is the prefetch-effectiveness number `cacheServes` was labelled
 *  as. NOTE: "no new fetch" is not "no network wait" — a joined in-flight chunk still
 *  waits for that fetch to land. */
export const CTL_IO_REQS_NO_NEW_FETCH = 13;
/** Chunks dropped by the LRU. */
export const CTL_IO_EVICTIONS = 14;
/** Current resident cache size, KiB. */
export const CTL_IO_RESIDENT_KB = 15;
// Effective tuning, echoed so a report says what configuration produced its numbers.
export const CTL_IO_CFG_CHUNK_KB = 16;
export const CTL_IO_CFG_CACHE_MB = 17;
export const CTL_IO_CFG_PREFETCH_CHUNKS = 18;
export const CTL_IO_CFG_MAX_INFLIGHT = 19;
/** 1 once the I/O worker has installed the SAB and is counting. A zero row with
 *  ARMED=0 means "nothing was counting", not "nothing happened". */
export const CTL_IO_ARMED = 20;
/** Bytes actually pulled over the network by this worker (cold + speculative), KiB.
 *  The numerator of "cold network bytes per unique guest byte first touched" — the
 *  only ratio that cannot be improved by the guest merely re-reading warm data. */
export const CTL_IO_NET_KB = 21;
/** Bytes of SPECULATIVELY fetched chunks that were evicted without ever being read
 *  by a guest request, KiB. Named for what it counts: "never read", not "wasted" —
 *  a chunk consumed by a different read than the one that motivated it is not in here. */
export const CTL_IO_PREFETCH_EVICTED_UNREAD_KB = 22;
/** Async (non-blocking) requests served over the postMessage channel. */
export const CTL_IO_ASYNC_REQS = 23;

export const CTL_WORDS = 32;

/**
 * The shape of the shared arena, as the compiling side sees it. Both workers import
 * these constants from THIS file, so a mismatch can only come from a stale bundle —
 * and a stale bundle here does not fail, it serves bytes from the wrong offsets.
 * The guest ships its own view of the layout in `init` and the I/O worker refuses to
 * serve when it disagrees, so the failure is loud instead of silent.
 */
export interface SabLayout {
    ctlWords: number;
    metaOffsetBytes: number;
    metaWords: number;
    dataOffsetBytes: number;
    dataBytes: number;
    totalBytes: number;
}

export function sabLayout(): SabLayout {
    return {
        ctlWords: CTL_WORDS,
        metaOffsetBytes: META_OFFSET_BYTES,
        metaWords: META_WORDS,
        dataOffsetBytes: DATA_OFFSET_BYTES,
        dataBytes: DATA_BYTES,
        totalBytes: SAB_TOTAL_BYTES,
    };
}

/** null when `remote` matches this build's layout; otherwise the first field that
 *  differs, so the mismatch names itself in a log line. */
export function layoutMismatch(remote: Partial<SabLayout> | undefined | null): string | null {
    if (!remote) return "peer sent no layout";
    const mine = sabLayout() as unknown as Record<string, number>;
    const theirs = remote as unknown as Record<string, number>;
    for (const k of Object.keys(mine)) {
        if (theirs[k] !== mine[k]) return `${k}: peer ${String(theirs[k])} != ${mine[k]}`;
    }
    return null;
}

// ---- meta Float64Array indices (64-bit safe for >2 GB bundles) ----
export const META_REQ_OFF = 0;
export const META_REQ_LEN = 1;
/** Sequence number of the request being published (echoed back in CTL_RESP_SEQ). */
export const META_REQ_SEQ = 2;
export const META_WORDS = 4;

// ---- STATE values ----
export const ST_IDLE = 0;
export const ST_REQ = 1;
export const ST_DONE = 2;
export const ST_ERR = 3;

/** Guest Atomics.wait slice (ms). A missed notify degrades to a thrown timeout
 *  (caller can fall back) instead of a permanent hang. Generous: a genuine cold
 *  fetch over a slow link can take seconds. */
export const WAIT_TIMEOUT_MS = 30_000;

/**
 * Publish one completion into the shared slot, or DROP it.
 *
 * A completion whose `seq` is no longer `currentSeq` belongs to a request the guest
 * abandoned; the DATA arena is a single slot, so writing it would overwrite the response
 * the guest is waiting for — or the bytes it is copying out right now. Dropping here is
 * the half that a guest-side sequence check cannot cover.
 *
 * The sequence word is stored LAST because it is what the guest waits on: publishing it
 * orders every other field before the wakeup.
 */
export function publishResponse(
    ctl: Int32Array,
    data: Uint8Array,
    seq: number,
    currentSeq: number,
    payload: Uint8Array | null,
): boolean {
    if (seq !== currentSeq) return false;
    if (payload) {
        const n = Math.min(payload.byteLength, DATA_BYTES);
        data.set(payload.subarray(0, n), 0);
        Atomics.store(ctl, CTL_RESP_LEN, n);
        Atomics.store(ctl, CTL_ERRNO, 0);
        Atomics.store(ctl, CTL_STATE, ST_DONE);
    } else {
        Atomics.store(ctl, CTL_ERRNO, 1);
        Atomics.store(ctl, CTL_STATE, ST_ERR);
    }
    Atomics.store(ctl, CTL_RESP_SEQ, seq);
    Atomics.notify(ctl, CTL_RESP_SEQ, 1);
    return true;
}

export interface IoWorkerStats {
    /** 1 once the I/O worker installed the SAB; 0 = nothing was counting. */
    armed: boolean;
    netFetches: number;
    prefetches: number;
    requests: number;
    chunksNeeded: number;
    chunksResidentHit: number;
    chunksJoinedInflight: number;
    chunksFetchedCold: number;
    chunksRefetchedAfterEvict: number;
    requestsAllResident: number;
    requestsNoNewFetch: number;
    evictions: number;
    residentKB: number;
    netKB: number;
    prefetchEvictedUnreadKB: number;
    asyncRequests: number;
    config: { chunkKB: number; cacheMB: number; prefetchChunks: number; maxInflight: number };
}

/** Read the I/O worker's published counters straight off the SAB (no round-trip). */
export function readIoWorkerStats(ctl: Int32Array): IoWorkerStats {
    const g = (i: number) => Atomics.load(ctl, i);
    return {
        armed: g(CTL_IO_ARMED) === 1,
        netFetches: g(CTL_IO_NET_FETCHES),
        prefetches: g(CTL_IO_PREFETCHES),
        requests: g(CTL_REQS),
        chunksNeeded: g(CTL_IO_CHUNKS_NEEDED),
        chunksResidentHit: g(CTL_IO_CHUNKS_RESIDENT_HIT),
        chunksJoinedInflight: g(CTL_IO_CHUNKS_JOINED_INFLIGHT),
        chunksFetchedCold: g(CTL_IO_CHUNKS_FETCHED_COLD),
        chunksRefetchedAfterEvict: g(CTL_IO_CHUNKS_REFETCHED_AFTER_EVICT),
        requestsAllResident: g(CTL_IO_REQS_ALL_RESIDENT),
        requestsNoNewFetch: g(CTL_IO_REQS_NO_NEW_FETCH),
        evictions: g(CTL_IO_EVICTIONS),
        residentKB: g(CTL_IO_RESIDENT_KB),
        netKB: g(CTL_IO_NET_KB),
        prefetchEvictedUnreadKB: g(CTL_IO_PREFETCH_EVICTED_UNREAD_KB),
        asyncRequests: g(CTL_IO_ASYNC_REQS),
        config: {
            chunkKB: g(CTL_IO_CFG_CHUNK_KB),
            cacheMB: g(CTL_IO_CFG_CACHE_MB),
            prefetchChunks: g(CTL_IO_CFG_PREFETCH_CHUNKS),
            maxInflight: g(CTL_IO_CFG_MAX_INFLIGHT),
        },
    };
}
