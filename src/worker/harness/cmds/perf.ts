/**
 * perf — read the worker's own frame profiler (the same data behind the in-app
 * "System Profiler / Worst Frames" panel) directly over the harness RPC, so an
 * agent can capture and attribute stalls WITHOUT grepping the megabyte log
 * firehose or depending on which browser tab streams to the log server.
 *
 *  - perfProfile({enable?, reset?})  arm/disarm + clear the frame profiler.
 *  - perfSpikes({top?, minMs?})      worst frames (frameMs desc) with their
 *                                    category breakdown + hottest thunks — the
 *                                    POJO equivalent of the Worst-Frames UI.
 *  - perfStats()                     latest + average frame sample + spike count.
 *
 * Self-improvement: replaces ad-hoc PRESENT-DIAG/READBACK-DIAG log probes for
 * "what is the 185ms Flip/Blt spending its time on".
 */

import type { HarnessService } from "../service";
import { frameProfiler, type BadFrameCapture, type FrameSample } from "../../core/frame-profiler";
import { profiler } from "../../core/profiler";
import { readbackCounters } from "../../modules/ddraw/surface-sync";
import { drawCostProfiler } from "../../backends/webgpu/ddraw/draw-cost-profiler";
import { cpu, sys, symbolize } from "../serialize";
import { HarnessError, HarnessErrorCode } from "../rpc";

/** Compact a category record to ms (drop zero buckets) for terse output. */
function categoriesMs(categories: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(categories)) {
        if (v && v > 0.05) out[k] = Math.round(v * 100) / 100;
    }
    return out;
}

/** Worst-frame capture → terse POJO with the hottest thunks first. */
function summarizeBadFrame(bf: BadFrameCapture, topThunks: number) {
    const thunks = Object.entries(bf.thunkAggregates)
        .map(([name, agg]) => ({ name, count: agg.count, totalMs: Math.round(agg.totalMs * 100) / 100 }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, topThunks);
    return {
        id: bf.id,
        frameMs: Math.round(bf.frameMs * 100) / 100,
        reason: bf.reason,
        categories: categoriesMs(bf.categories),
        topThunks: thunks,
    };
}

function summarizeSample(s: FrameSample | undefined) {
    if (!s) return null;
    return {
        frameMs: Math.round(s.frameMs * 100) / 100,
        fps: Math.round(s.fps * 10) / 10,
        categories: categoriesMs(s.categories),
    };
}

export function registerPerfCommands(svc: HarnessService): void {
    /** perfProfile({enable?=true, reset?=false}) — arm/disarm + clear BOTH the frame
     *  profiler (worst-frames/thunk-level) and the named-bucket profiler (sub-phase
     *  timings like "Blt:mixedGpuPath:upload"), so perfSpikes + profilerStats line up. */
    svc.register("perfProfile", (args) => {
        const opts = (args[0] ?? {}) as { enable?: boolean; reset?: boolean };
        const enable = opts.enable ?? true;
        frameProfiler.setEnabled(enable);     // setEnabled(true) resets internally
        if (opts.reset) frameProfiler.reset();
        profiler.setEnabled(enable);          // setEnabled(false) resets internally
        if (enable && opts.reset) profiler.reset();
        return { enabled: enable };
    });

    /** profilerStats({filter?, top?=20, sort?='max'}) — named-bucket timings (avg/total/max/count).
     *  maxTime captures the WORST single call → e.g. profilerStats({filter:'Blt'}) names the
     *  exact sub-phase eating a ~175ms Blt spike. */
    svc.register("profilerStats", (args) => {
        const opts = (args[0] ?? {}) as { filter?: string; top?: number; sort?: "max" | "total" | "avg" };
        const top = opts.top ?? 20;
        const sortKey = opts.sort ?? "max";
        const raw = profiler.getStats() as Record<string, { avgTime: number; totalTime: number; count: number; maxTime: number }>;
        const rows = Object.entries(raw)
            .filter(([id]) => !opts.filter || id.toLowerCase().includes(opts.filter.toLowerCase()))
            .map(([id, s]) => ({
                id,
                maxMs: Math.round(s.maxTime * 100) / 100,
                avgMs: Math.round(s.avgTime * 100) / 100,
                totalMs: Math.round(s.totalTime * 100) / 100,
                count: s.count,
            }))
            .sort((a, b) => (sortKey === "total" ? b.totalMs - a.totalMs : sortKey === "avg" ? b.avgMs - a.avgMs : b.maxMs - a.maxMs))
            .slice(0, top);
        return { enabled: profiler.isEnabled(), bucketCount: Object.keys(raw).length, rows };
    });

    /** perfSpikes({top?=8, minMs?=0}) — worst frames with category + hot-thunk breakdown. */
    svc.register("perfSpikes", (args) => {
        const opts = (args[0] ?? {}) as { top?: number; minMs?: number };
        const topThunks = opts.top ?? 8;
        const minMs = opts.minMs ?? 0;
        const snap = frameProfiler.getSnapshot();
        const spikes = (snap.badFrames ?? [])
            .filter((bf) => bf.frameMs >= minMs)
            .sort((a, b) => b.frameMs - a.frameMs)
            .map((bf) => summarizeBadFrame(bf, topThunks));
        return {
            enabled: snap.enabled,
            source: snap.source,
            sampleCount: snap.sampleCount,
            average: summarizeSample(snap.average),
            spikeCount: spikes.length,
            spikes,
        };
    });

    /** perfThunks({top?=20, filter?}) — session-wide per-thunk cost (totalMs, avgUs,
     *  msPerFrame, share of the thunk slice), accumulated over every profiled frame
     *  rather than the 5-frame worst-frame ring. The instrument for an A/B on ONE
     *  thunk's cost: per-call figures survive CPU contention that makes FPS useless.
     *  `noBorrowMs`/`noBorrowAvgUs` isolate the calls that never took a plain guest-memory
     *  view — a big, slow noBorrow row is the signature of a leaf indexing v86's Proxy
     *  per element (guest-memory.ts), the ~140x class. Heuristic, not proof: sync thunks
     *  only, and one Mem.read* anywhere in the call clears the flag — it under-reports
     *  rather than cries wolf. Confirm a suspect with `dbg.memProxyBench` (A/B both arms in
     *  one session) and price the loop with `dbg.memBench` (ns per Proxy access here). */
    svc.register("perfThunks", (args) => {
        const opts = (args[0] ?? {}) as { top?: number; filter?: string };
        return frameProfiler.getThunkReport(opts.top ?? 20, opts.filter);
    });

    /** readbackStats({reset?}) — GPU→CPU surface readback accounting. Duration hides the
     *  cost model; the honest metric is `roundTrips` (one full CPU/GPU serialisation each)
     *  measured against `calls` (locks that wanted the pixels). `memoHits` counts the ones
     *  the cpuSyncedVersion memo removed; `redundant` MUST be 0 — it means two readbacks of
     *  the same surface at the same version both reached the GPU, i.e. the memo eroded.
     *  Per-frame rate: readbackStats({reset:true}) → tickFrames(N) → readbackStats(). */
    svc.register("readbackStats", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        const snapshot = {
            calls: readbackCounters.calls,
            roundTrips: readbackCounters.roundTrips,
            memoHits: readbackCounters.memoHits,
            scratchHits: readbackCounters.scratchHits,
            redundant: readbackCounters.redundant,
        };
        if (opts.reset) readbackCounters.reset();
        return snapshot;
    });

    /**
     * drawCost({enable?, reset?}) — per-draw CPU breakdown inside the ddraw draw handler
     * (resolve / prepare / vconvert / ringup / submit / tail), off by default and zero-cost
     * while off. `perfThunks` prices a draw thunk as one number; this says WHICH phase of it
     * is expensive, which is the difference between "the guest draws a lot" and "our
     * per-draw resolve work is the cost". Flow: drawCost({enable:true,reset:true}) →
     * tickFrames(N) → drawCost().
     */
    svc.register("drawCost", (args) => {
        const opts = (args[0] ?? {}) as { enable?: boolean; reset?: boolean };
        if (opts.enable === true) drawCostProfiler.enable();
        else if (opts.enable === false) drawCostProfiler.disable();
        else if (opts.reset) drawCostProfiler.reset();
        return { enabled: drawCostProfiler.isEnabled(), ...drawCostProfiler.report() };
    });

    /** perfStats() — latest + average frame sample (no per-frame thunk detail). */
    svc.register("perfStats", () => {
        const snap = frameProfiler.getSnapshot();
        return {
            enabled: snap.enabled,
            source: snap.source,
            sampleCount: snap.sampleCount,
            latest: summarizeSample(snap.latest),
            average: summarizeSample(snap.average),
            spikeCount: (snap.badFrames ?? []).length,
        };
    });
}
