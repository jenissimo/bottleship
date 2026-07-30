// cached-source.ts
//
// CachedSource — an LRU block-cache decorator over any ZipSource.
//
// WHY THIS EXISTS
// ---------------
// The guest's ReadFile is synchronous; our sync fast-path (vfs.readSync →
// ZipArchive.readEntryRangeSync → ZipSource.readRangeSync) only works when the
// underlying source can serve bytes synchronously. BufferSource (whole file in
// RAM) and SyncAccessHandleSource (OPFS SAH) can; BlobSource / HttpRangeSource
// cannot — they are async only, so every guest read falls to the expensive
// thunk-dispatcher async-park path. That is exactly why loading a bundle
// straight from a user's File/Blob was abandoned in favour of copying it into
// OPFS first (a hidden, evictable duplicate of the user's own file).
//
// CachedSource closes that gap WITHOUT a copy: it reads the underlying stream in
// fixed-size BLOCKS and keeps the most-recently-used ones in RAM (LRU, byte
// budgeted). The first touch of a block faults it in async; every later read
// that lands in a resident block is served SYNCHRONOUSLY. In other words it
// gives an async-only source a working `readRangeSync` for warm data — enough
// for the sync fast-path and the msvcrt buffered-getc refill to function over a
// plain Blob, so the game can stream from the user's real file with no OPFS copy.
//
// It is a pure decorator: same bytes in, same bytes out, just fewer (and
// coalesced) calls to the inner source. No worker/DOM dependencies — unit
// testable in isolation.

import type { ZipSource } from "@bottleship/formats/zip";

/** Default block granularity. Matches the msvcrt getc refill chunk (256 KiB),
 *  which is a good amortization point for async fault-ins. */
const DEFAULT_BLOCK_SIZE = 256 * 1024;

/** Minimum resident budget. Small bundles keep this floor; whole small entries
 *  are already cached one layer up (vfs romCache). */
export const MIN_CACHE_BYTES = 64 * 1024 * 1024;

/** Upper cap so a multi-GB no-copy blob does not monopolize worker RAM. */
export const MAX_CACHE_BYTES = 256 * 1024 * 1024;

/** Fraction of the archive size used to size the block-cache budget. */
export const CACHE_BUDGET_RATIO = 0.15;

const DEFAULT_MAX_BYTES = MIN_CACHE_BYTES;

/**
 * Scale the LRU byte budget with archive size: large no-copy blobs need more
 * resident blocks to avoid eviction churn on random ROM reads.
 */
export function computeAdaptiveMaxBytes(sourceSize: number): number {
    if (sourceSize <= 0) return MIN_CACHE_BYTES;
    const scaled = Math.floor(sourceSize * CACHE_BUDGET_RATIO);
    return Math.max(MIN_CACHE_BYTES, Math.min(MAX_CACHE_BYTES, scaled));
}

export interface CachedSourceOptions {
    /** Block size in bytes (power-of-two friendly, but any positive int works). */
    blockSize?: number;
    /** Max resident bytes before LRU eviction kicks in. */
    maxBytes?: number;
    /** On a cold SYNC miss, fault up to this many consecutive non-resident blocks
     *  in ONE inner read (default 1 = no readahead). For sources whose sync read
     *  has a high per-call cost (sync XHR roundtrip, FileReaderSync slice) this
     *  turns a sequential guest scan (msvcrt getc) from one inner call per block
     *  into one per run, while keeping block-granular LRU and random reads. */
    syncReadaheadBlocks?: number;
    /** Async prefetch RUN size: how many consecutive non-resident blocks each
     *  background fetch pulls PAST the read cursor (default 0 = prefetch off).
     *  Overlaps network/IO with the guest consuming already-resident blocks. */
    prefetchAheadBlocks?: number;
    /** How many prefetch runs to keep outstanding ahead of the guest's read
     *  cursor (default 1). >1 makes the pipeline self-sustaining and deep: the
     *  window is refilled on resident HITS (not just cold misses) and each
     *  completed run chains the next, so a sequential scan (msvcrt getc grind)
     *  stops hitting blocking sync faults instead of draining the pipeline one
     *  run deep. Doubles as the max concurrent prefetch fetch count, so keep it
     *  a couple below the browser's per-origin connection cap to leave a slot
     *  for the critical blocking sync read. */
    prefetchDepthRuns?: number;
    /** Optional label for diagnostics. */
    name?: string;
}

export class CachedSource implements ZipSource {
    readonly size: number;

    private readonly inner: ZipSource;
    private readonly blockSize: number;
    private readonly maxBytes: number;
    private readonly syncReadahead: number;
    private readonly prefetchAhead: number;
    private readonly prefetchDepthRuns: number;
    /** Number of prefetch runs currently in flight (bounded by prefetchDepthRuns). */
    private prefetchInflightCount = 0;
    /** Next block index the prefetcher will consider — everything below is
     *  resident or already scheduled. Advances with the read cursor; re-anchored
     *  forward on a cold sync fault (a seek / new file the prefetch didn't cover). */
    private prefetchFrontier = 0;
    /** Highest block the guest requested via the SYNC path — the prefetch window
     *  is kept `prefetchAhead * prefetchDepthRuns` blocks ahead of this. */
    private readCursorBlock = -1;
    private readonly name: string;

    /** blockIndex → resident block bytes (last block may be shorter at EOF). */
    private readonly blocks = new Map<number, Uint8Array>();
    /** blockIndex order, oldest at [0], most-recently-used at the end. */
    private readonly lru: number[] = [];
    private residentBytes = 0;

    /** In-flight fault-ins, coalesced so concurrent reads share one source call. */
    private readonly inflight = new Map<number, Promise<Uint8Array>>();

    // Lightweight counters for diagnostics / tests.
    private _syncHits = 0;
    private _syncMisses = 0;
    private _faults = 0;
    /** Cold sync reads that had to BLOCK on an inner sync read (each ≈ one worker
     *  stall — the getc↔streaming cost we minimize by keeping the prefetch ahead). */
    private _blockingFaults = 0;
    /** Background prefetch runs issued (the overlap work that keeps getc off the
     *  blocking path). */
    private _prefetchRuns = 0;

    constructor(inner: ZipSource, opts: CachedSourceOptions = {}) {
        this.inner = inner;
        this.size = inner.size;
        this.blockSize = Math.max(1, Math.floor(opts.blockSize ?? DEFAULT_BLOCK_SIZE));
        this.maxBytes = Math.max(this.blockSize, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES));
        this.syncReadahead = Math.max(1, Math.floor(opts.syncReadaheadBlocks ?? 1));
        this.prefetchAhead = Math.max(0, Math.floor(opts.prefetchAheadBlocks ?? 0));
        this.prefetchDepthRuns = Math.max(1, Math.floor(opts.prefetchDepthRuns ?? 1));
        this.name = opts.name ?? "cached";
    }

    // ---- ZipSource ----

    /** Synchronous read. Resident blocks are served from RAM; missing blocks are
     *  faulted in synchronously IF the inner source can read synchronously (e.g.
     *  BlobSource via FileReaderSync). Returns null only when a covering block is
     *  absent AND the inner source is async-only (HttpRangeSource) — then the
     *  caller falls back to async readRange. This block cache keeps hot streaming
     *  (msvcrt getc) off a per-byte inner read: one inner fault per 256 KiB block,
     *  the rest from RAM. */
    readRangeSync(start: number, end: number): Uint8Array | null {
        const [s, e] = this.clamp(start, end);
        if (e <= s) return new Uint8Array(0);

        const first = Math.floor(s / this.blockSize);
        const last = Math.floor((e - 1) / this.blockSize);

        const innerSync = this.inner.readRangeSync?.bind(this.inner);

        // Resolve every covering block, holding direct references so assembly is
        // immune to eviction that a later insert may trigger.
        const datas: Uint8Array[] = [];
        for (let b = first; b <= last; b++) {
            let data = this.blocks.get(b);
            if (data) {
                this.touch(b);
            } else {
                if (!innerSync) { this._syncMisses++; return null; }
                const buf = this.faultRunSync(b, innerSync);
                if (!buf) { this._syncMisses++; return null; }
                data = buf;
            }
            datas.push(data);
        }

        const out = this.assemble(datas, first, last, s, e);
        this._syncHits++;
        // Advance the read cursor and top the prefetch pipeline back up — done on
        // resident HITS too, so a sequential scan through already-prefetched blocks
        // keeps the window full instead of draining until the next cold fault.
        if (last > this.readCursorBlock) this.readCursorBlock = last;
        this.pumpPrefetch();
        return out;
    }

    /** Asynchronous read. Faults in any missing covering blocks (coalesced),
     *  caches them, then assembles. */
    async readRange(start: number, end: number): Promise<Uint8Array> {
        const [s, e] = this.clamp(start, end);
        if (e <= s) return new Uint8Array(0);

        const first = Math.floor(s / this.blockSize);
        const last = Math.floor((e - 1) / this.blockSize);

        // Hold direct references to every covering block's bytes so assembly is
        // immune to eviction that may happen as later blocks are inserted.
        const datas: Uint8Array[] = [];
        for (let b = first; b <= last; b++) {
            datas.push(await this.ensureBlock(b));
        }

        return this.assemble(datas, first, last, s, e);
    }

    /** Best-effort passthrough so wrapping a closable source (SAH) still cleans up. */
    close(): void {
        const inner = this.inner as ZipSource & { close?: () => void };
        if (typeof inner.close === "function") {
            try { inner.close(); } catch { /* best-effort */ }
        }
        this.blocks.clear();
        this.lru.length = 0;
        this.residentBytes = 0;
    }

    stats(): { syncHits: number; syncMisses: number; faults: number; blockingFaults: number; prefetchRuns: number; residentBytes: number; blocks: number } {
        return {
            syncHits: this._syncHits,
            syncMisses: this._syncMisses,
            faults: this._faults,
            blockingFaults: this._blockingFaults,
            prefetchRuns: this._prefetchRuns,
            residentBytes: this.residentBytes,
            blocks: this.blocks.size,
        };
    }

    // ---- internals ----

    private clamp(start: number, end: number): [number, number] {
        const s = Math.max(0, Math.min(Math.floor(start), this.size));
        const e = Math.max(s, Math.min(Math.floor(end), this.size));
        return [s, e];
    }

    private blockBounds(b: number): [number, number] {
        const blockStart = b * this.blockSize;
        const blockEnd = Math.min(this.size, blockStart + this.blockSize);
        return [blockStart, blockEnd];
    }

    /** Copy the overlap of block `b` (bytes `data`) into `out` which spans [s,e).
     *  Returns the FILE OFFSET the copy reached — short of the block's own end when the
     *  inner read was short, which the caller must propagate as a short result. */
    private copyBlockInto(out: Uint8Array, s: number, e: number, b: number, data: Uint8Array): number {
        const blockStart = b * this.blockSize;
        const copyStart = Math.max(s, blockStart);
        const copyEnd = Math.min(e, blockStart + data.length);
        if (copyEnd <= copyStart) return copyStart;
        out.set(
            data.subarray(copyStart - blockStart, copyEnd - blockStart),
            copyStart - s,
        );
        return copyEnd;
    }

    /** Assemble [s,e) from the covering blocks' bytes, STOPPING at the first block that
     *  came back short. Zero-filling the tail instead (while the caller advances its
     *  cursor by the full requested length) turns a short read into silent corruption
     *  that looks exactly like real data. */
    private assemble(datas: Uint8Array[], first: number, last: number, s: number, e: number): Uint8Array {
        const out = new Uint8Array(e - s);
        let reached = s;
        for (let b = first; b <= last; b++) {
            reached = this.copyBlockInto(out, s, e, b, datas[b - first]);
            // Expected end of this block's contribution to the request.
            if (reached < Math.min(e, (b + 1) * this.blockSize)) break;
        }
        return reached >= e ? out : out.subarray(0, Math.max(0, reached - s));
    }

    /** Synchronously fault block `b`, reading ahead through consecutive
     *  non-resident blocks (up to syncReadahead) in one inner call. Returns
     *  block `b`'s bytes, or null if the inner sync read failed. */
    private faultRunSync(
        b: number,
        innerSync: (start: number, end: number) => Uint8Array | null,
    ): Uint8Array | null {
        const lastBlock = Math.floor((this.size - 1) / this.blockSize);
        let endBlock = b;
        while (
            endBlock - b + 1 < this.syncReadahead &&
            endBlock < lastBlock &&
            !this.blocks.has(endBlock + 1)
        ) {
            endBlock++;
        }

        const runStart = b * this.blockSize;
        const runEnd = Math.min(this.size, (endBlock + 1) * this.blockSize);
        const buf = innerSync(runStart, runEnd);
        if (!buf) return null;
        this._faults++;
        this._blockingFaults++;

        // Re-anchor the prefetch frontier past this run. A cold sync fault means
        // the guest is reading HERE now (a forward seek / new file the prefetch
        // window didn't cover); Math.max keeps the frontier from being yanked
        // backward by a re-read of an evicted block still behind it. pumpPrefetch
        // itself is driven from readRangeSync after the whole read resolves.
        if (endBlock + 1 > this.prefetchFrontier) this.prefetchFrontier = endBlock + 1;

        if (endBlock === b) {
            this.insert(b, buf);
            return buf;
        }
        return this.insertRun(b, endBlock, buf);
    }

    /** Split a multi-block run buffer into per-block slices and cache them.
     *  Slices (not subarrays) so evicting one block frees its bytes instead of
     *  pinning the whole run's backing buffer in the LRU. Returns the first
     *  block's bytes. */
    private insertRun(b: number, endBlock: number, buf: Uint8Array): Uint8Array | null {
        let firstData: Uint8Array | null = null;
        for (let rb = b; rb <= endBlock; rb++) {
            const off = (rb - b) * this.blockSize;
            if (off >= buf.length) break;
            const [bs, be] = this.blockBounds(rb);
            const want = be - bs;
            const chunk = buf.slice(off, off + want);
            if (rb === b) firstData = chunk;
            if (chunk.length < want) break; // short inner read: don't cache ahead of it
            this.insert(rb, chunk);
        }
        return firstData;
    }

    /** Keep the prefetch pipeline full: issue background fetches for the next
     *  runs of consecutive non-resident blocks until either `prefetchDepthRuns`
     *  are in flight or the frontier reaches `prefetchAhead * prefetchDepthRuns`
     *  blocks past the read cursor. Driven from the sync read path on every hit
     *  and re-driven when each run lands, so a sequential scan stays fed off RAM
     *  instead of blocking on cold sync faults. The window is anchored to the
     *  cursor so it self-limits: once the guest stops advancing (idle / random
     *  access) the frontier catches the window edge and prefetch quiesces rather
     *  than speculatively pulling the rest of a multi-GB bundle. Errors are
     *  swallowed — the sync path re-faults on demand. */
    private pumpPrefetch(): void {
        if (!this.prefetchAhead || this.size === 0) return;
        const lastBlock = Math.floor((this.size - 1) / this.blockSize);
        const windowEnd = this.readCursorBlock + this.prefetchAhead * this.prefetchDepthRuns;

        while (this.prefetchInflightCount < this.prefetchDepthRuns) {
            // Skip blocks already resident (readahead / a prior prefetch covered them).
            while (this.prefetchFrontier <= lastBlock && this.blocks.has(this.prefetchFrontier)) {
                this.prefetchFrontier++;
            }
            if (this.prefetchFrontier > lastBlock || this.prefetchFrontier > windowEnd) return;

            const b = this.prefetchFrontier;
            let endBlock = b;
            while (
                endBlock - b + 1 < this.prefetchAhead &&
                endBlock < lastBlock &&
                endBlock + 1 <= windowEnd &&
                !this.blocks.has(endBlock + 1)
            ) {
                endBlock++;
            }

            const runStart = b * this.blockSize;
            const runEnd = Math.min(this.size, (endBlock + 1) * this.blockSize);
            this.prefetchFrontier = endBlock + 1;
            this.prefetchInflightCount++;
            this._faults++;
            this._prefetchRuns++;
            this.inner.readRange(runStart, runEnd)
                .then((buf) => { this.insertRun(b, endBlock, buf); })
                .catch(() => { /* re-fault on demand */ })
                .finally(() => {
                    this.prefetchInflightCount--;
                    this.pumpPrefetch();
                });
        }
    }

    private ensureBlock(b: number): Promise<Uint8Array> {
        const resident = this.blocks.get(b);
        if (resident) {
            this.touch(b);
            return Promise.resolve(resident);
        }
        const pending = this.inflight.get(b);
        if (pending) return pending;

        const [blockStart, blockEnd] = this.blockBounds(b);
        this._faults++;
        const p = this.inner.readRange(blockStart, blockEnd)
            .then((buf) => {
                this.insert(b, buf);
                this.inflight.delete(b);
                return buf;
            })
            .catch((err) => {
                this.inflight.delete(b);
                throw err;
            });
        this.inflight.set(b, p);
        return p;
    }

    private insert(b: number, data: Uint8Array): void {
        // Never cache a SHORT block. blockBounds already clamps the legitimate last block
        // to `size`, so anything below that width is a short inner read — caching it would
        // make every later hit on this block serve a zero-filled tail from RAM, with no
        // second chance to notice.
        const [bs, be] = this.blockBounds(b);
        if (data.length < be - bs) return;
        if (this.blocks.has(b)) {
            // Raced with another fault-in; keep the existing entry, refresh LRU.
            this.touch(b);
            return;
        }
        this.blocks.set(b, data);
        this.lru.push(b);
        this.residentBytes += data.byteLength;
        this.evictIfNeeded();
    }

    private touch(b: number): void {
        const i = this.lru.indexOf(b);
        if (i >= 0 && i !== this.lru.length - 1) {
            this.lru.splice(i, 1);
            this.lru.push(b);
        }
    }

    private evictIfNeeded(): void {
        while (this.residentBytes > this.maxBytes && this.lru.length > 1) {
            const victim = this.lru.shift()!;
            const data = this.blocks.get(victim);
            if (data) {
                this.residentBytes -= data.byteLength;
                this.blocks.delete(victim);
            }
        }
    }
}
