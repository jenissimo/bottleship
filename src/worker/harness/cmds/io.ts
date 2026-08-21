/**
 * ioReport — the streamed-bundle I/O instruments (plan/streamed-io-architecture.md,
 * stage 0).
 *
 * The numbers this replaces were not wrong by a little: `waits` counted "entered the
 * wait loop" (a value that can never fall below `requests`) under a name that reads
 * as "blocked", and the I/O worker's `cacheServes` counted "every covering chunk had
 * fully landed" under a label saying "answered with zero cold fetch" — so a request
 * riding on a prefetch that was still in flight, the common case, scored as a miss.
 * Stages 1-3 are steered by these, so each one here is named for what it counts and
 * carries enough neighbours to be cross-checked (the chunk outcomes must sum to
 * chunksNeeded; waitMs must sit just below a profiler's self-time in `request`).
 *
 * `armed` is load-bearing: a bundle loaded from OPFS or a blob never creates a
 * SabIoSource, so a zero row means "nothing was counting", not "no I/O happened".
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import type { SabIoSource } from "../../runtime/filesystem/sab-io-source";
import type { IoWorkerStats } from "../../runtime/filesystem/sab-io-protocol";

type Snapshot = ReturnType<SabIoSource["stats"]>;
type BlockCacheStats = {
    syncHits: number; syncMisses: number; faults: number;
    blockingFaults: number; prefetchRuns: number; residentBytes: number; blocks: number;
};

interface Mark { at: number; io: Snapshot; cache: BlockCacheStats | null }

let mark: Mark | null = null;

function sabIo(): SabIoSource | null {
    return (globalThis as unknown as { __wgbSabIo?: SabIoSource }).__wgbSabIo ?? null;
}

function blockCache(): BlockCacheStats | null {
    const c = (globalThis as unknown as { __wgbBlockCache?: { stats?: () => BlockCacheStats } }).__wgbBlockCache;
    return typeof c?.stats === "function" ? c.stats() : null;
}

/** Percentile from bucket counts. Interpolates inside the bucket the rank lands in,
 *  so the value is exact only to the bucket width — which is why the bucket's own
 *  range is reported next to it and the last (unbounded) bucket reports no number. */
function histPercentile(hist: number[], edges: number[], p: number): { ms: number | null; bucket: string } {
    let total = 0;
    for (const h of hist) total += h;
    if (total === 0) return { ms: null, bucket: "n/a" };
    // A collapsed axis (every edge 0) would answer every percentile with a confident
    // 0 ms. Refuse rather than answer — the caller can see the axis is broken.
    if (!(edges[0] > 0)) return { ms: null, bucket: "bad-axis" };
    const rank = p * total;
    let cum = 0;
    for (let i = 0; i < hist.length; i++) {
        const next = cum + hist[i];
        if (next >= rank) {
            const lo = i === 0 ? 0 : edges[i - 1];
            const hi = edges[i];
            const label = `(${lo}, ${hi}]`;
            if (!Number.isFinite(hi)) return { ms: null, bucket: `(${lo}, inf)` };
            const frac = hist[i] > 0 ? (rank - cum) / hist[i] : 0;
            return { ms: +(lo + (hi - lo) * frac).toFixed(4), bucket: label };
        }
        cum = next;
    }
    return { ms: null, bucket: "n/a" };
}

/** Counter delta. Numbers subtract, equal-length number arrays (the histogram)
 *  subtract elementwise, anything else carries the current value through. */
function diffNumbers<T extends object>(now: T, base: T): T {
    const n = now as Record<string, unknown>, bs = base as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(n)) {
        const a = n[k], b = bs[k];
        if (typeof a === "number" && typeof b === "number") out[k] = a - b;
        else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && typeof a[0] === "number") {
            out[k] = (a as number[]).map((v, i) => v - (b as number[])[i]);
        } else out[k] = a;
    }
    return out as T;
}

export function registerIoCommands(svc: HarnessService): void {
    /** ioMark() — baseline for a windowed ioReport. The counters are monotonic, so a
     *  measurement over "the radio playing" is a difference, not a total; without this
     *  every A/B is polluted by the boot's own thousands of cold reads. */
    svc.register("ioMark", () => {
        const src = sabIo();
        if (!src) throw new HarnessError("no SAB I/O source (bundle not streamed)", HarnessErrorCode.NO_PROCESS);
        mark = { at: performance.now(), io: src.stats(), cache: blockCache() };
        return { marked: true, at: mark.at };
    });

    /** ioReport({since?: "mark"}) — guest wait time + I/O-worker chunk accounting.
     *
     *  `since:"mark"` reports the delta from the last ioMark. Percentiles in a windowed
     *  report come from the HISTOGRAM delta (bucket-quantized); the lifetime report also
     *  carries `recent`, which is exact but only over the last 4096 requests. If those
     *  two disagree wildly, the window and the recent ring are covering different
     *  activity — that is information, not a bug. */
    svc.register("ioReport", (args) => {
        const opts = (args[0] ?? {}) as { since?: string };
        const src = sabIo();
        if (!src) {
            return {
                armed: false,
                reason: "no SAB I/O source — this bundle is not streamed (OPFS cache, blob, or SAB unavailable). Nothing is counting.",
                source: "none",
            };
        }
        const now = src.stats();
        const cacheNow = blockCache();
        const windowed = opts.since === "mark";
        if (windowed && !mark) throw new HarnessError("ioReport since:\"mark\" with no ioMark", HarnessErrorCode.BAD_ARGS);

        // `bucketsMs` is the histogram's AXIS, not a counter — diffing it against itself
        // yields all-zero edges, and the percentile lookup then reports a confident 0 ms
        // for a 390 ms block. Restore it explicitly.
        const wait = windowed
            ? { ...diffNumbers(now.wait, mark!.io.wait), bucketsMs: now.wait.bucketsMs }
            : now.wait;
        // `config`, `armed` and `residentKB` are STATE, not counters — a delta of them
        // would be meaningless, so they carry through a windowed report unchanged.
        const io: IoWorkerStats = windowed
            ? {
                ...diffNumbers(now.io, mark!.io.io),
                config: now.io.config,
                armed: now.io.armed,
                residentKB: now.io.residentKB,
            }
            : now.io;
        const cache = windowed && cacheNow && mark!.cache
            ? { ...diffNumbers(cacheNow, mark!.cache), residentBytes: cacheNow.residentBytes, blocks: cacheNow.blocks }
            : cacheNow;

        const p = (q: number) => histPercentile(wait.histogram, wait.bucketsMs, q);
        const chunkSum = io.chunksResidentHit + io.chunksJoinedInflight + io.chunksFetchedCold;

        return {
            armed: true,
            source: "sab-io",
            window: windowed ? { sinceMs: +(performance.now() - mark!.at).toFixed(1) } : "lifetime",

            // What the guest thread actually paid, bracketed around Atomics.wait itself.
            // waitMs excludes the postMessage marshalling before the block and the
            // copy-out after, so it must read slightly BELOW a profiler's self-time in
            // `request`; an exact match would mean the bracket is not where it claims.
            guest: {
                requests: wait.requests,
                waitMs: +wait.waitMs.toFixed(2),
                msPerRequest: wait.requests ? +(wait.waitMs / wait.requests).toFixed(4) : 0,
                waitCalls: wait.waitCalls,
                waitsBlocked: wait.waitsBlocked,
                waitsNotEqual: wait.waitsNotEqual,
                waitsTimedOut: wait.waitsTimedOut,
                timeouts: wait.timeouts,
                p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99),
                histogram: wait.bucketsMs.map((e, i) => ({ upToMs: Number.isFinite(e) ? e : null, n: wait.histogram[i] }))
                    .filter((b) => b.n > 0),
                recentExact: windowed ? null : now.wait.recent,
            },

            // The I/O worker's view. `chunkOutcomesSumOk` is the cross-check: the three
            // outcomes partition every chunk a guest request needed, so a false here
            // means the accounting itself drifted and no number below it is usable.
            ioWorker: {
                armed: io.armed,
                requests: io.requests,
                chunksNeeded: io.chunksNeeded,
                chunksResidentHit: io.chunksResidentHit,
                chunksJoinedInflight: io.chunksJoinedInflight,
                chunksFetchedCold: io.chunksFetchedCold,
                chunkOutcomesSumOk: chunkSum === io.chunksNeeded,
                chunksRefetchedAfterEvict: io.chunksRefetchedAfterEvict,
                evictions: io.evictions,
                prefetches: io.prefetches,
                requestsAllResident: io.requestsAllResident,
                requestsNoNewFetch: io.requestsNoNewFetch,
                // The corrected hit rate. requestsAllResident is what `cacheServes` was
                // really counting; the gap between them is the prefetch-in-flight case it
                // scored as a miss.
                noNewFetchRate: io.requests ? +(io.requestsNoNewFetch / io.requests).toFixed(3) : 0,
                allResidentRate: io.requests ? +(io.requestsAllResident / io.requests).toFixed(3) : 0,
                residentKB: io.residentKB,
                config: io.config,
            },

            // The guest-local block cache in front of all of it: only its misses ever
            // become a SAB request, so `guest.requests` should track `blockingFaults`.
            blockCache: cache ?? { note: "__wgbBlockCache exposed in dev builds only" },
        };
    });
}
