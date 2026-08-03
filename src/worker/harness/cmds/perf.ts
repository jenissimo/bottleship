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
import { type FrameTail } from "../../core/frame-time-distribution";
import { dbg } from "../../core/debug/dbg-commands";
import { guestCodeInvalidationStats } from "../../core/memory/guest-code";
import { hypercallDataManager } from "../../core/cpu/hypercall-data";

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

/* ── window identity (the join seam to the trace) ──────────────────────────── */

const WINDOW_BEGIN_MARK = "bottleship.perfwindow.begin";
const WINDOW_END_MARK = "bottleship.perfwindow.end";

/** UserTiming marks are already in the trace category set (`blink.user_timing`), so a mark
 *  emitted here lands in a `bun tools/harness.ts trace` capture — that is the whole join. */
function mark(name: string): void {
    try { performance.mark(name); } catch { /* diagnostics must never break a read */ }
}

type RenderLike = {
    getFlipCadence?: (refreshMs?: number) => Record<string, unknown>;
    resetFlipCadence?: () => void;
    getPresentSerial?: () => number;
};

/** What the live depth structurally cannot see. Enumerated so a reader never concludes the
 *  absence of a cause from an instrument that never looked for it. */
const LIVE_BLIND_SPOTS: string[] = [
    "GC pauses: invisible worker-side. Only a trace shows them ('(garbage collector)' JS node in the worker profile).",
    "stack attribution (JS vs wasm vs v86 internals, bad codegen): trace-only — V86_ANNOTATIONS, high cpu::cycle_internal self-time = interpreting, wasm-function[N] = compiled blocks.",
    "which guest code: needs sampling, so it cannot be applied retroactively to a spike that already happened — run guestBlocks() while the behaviour is live.",
    "per-hypercall-id counts: they do not exist. Only a single wrapping 32-bit total (hypercallDataManager.getCallCount) — no breakdown is fabricated here.",
    "thunk time is summed ACROSS guest threads into the frame it landed in, so a parked audio thread inflates a frame's thunk category (park thunks are excluded from blame, not from the category).",
];

type CounterSnapshot = {
    atMs: number;
    presentSerial: number | null;
    sched: Record<string, number> | null;
    fastmem: { enabled: boolean; speculatedLoadsCompiled: number; readMapPages: number } | null;
    tier2: Record<string, number> | null;
    codeInvalidations: { wired: boolean; ranges: number; bytes: number; deferred: number };
    hypercalls: number;
};

let windowBaseline: CounterSnapshot | null = null;

function snapshotCounters(render: RenderLike | undefined): CounterSnapshot {
    const sched = sys().scheduler as unknown as {
        roundTripStats?: Record<string, number>; pinStarvationForced?: number;
    } | undefined;
    let fastmem: CounterSnapshot["fastmem"] = null;
    let tier2: CounterSnapshot["tier2"] = null;
    try {
        const f = dbg.fastmemStats?.() as CounterSnapshot["fastmem"] | null;
        if (f) fastmem = { enabled: f.enabled, speculatedLoadsCompiled: f.speculatedLoadsCompiled, readMapPages: f.readMapPages };
    } catch { /* wasm debug exports absent in this build */ }
    try {
        tier2 = (dbg.tier2Stats?.() as unknown as Record<string, number> | null) ?? null;
    } catch { /* same */ }
    return {
        atMs: Math.round(performance.now()),
        presentSerial: render?.getPresentSerial?.() ?? null,
        sched: sched?.roundTripStats
            ? { ...sched.roundTripStats, pinStarvationForced: sched.pinStarvationForced ?? -1 }
            : null,
        fastmem,
        tier2,
        codeInvalidations: guestCodeInvalidationStats(),
        hypercalls: hypercallDataManager.getCallCount(),
    };
}

const diffNumbers = (a: Record<string, number> | null, b: Record<string, number> | null) => {
    if (!a || !b) return null;
    const out: Record<string, number> = {};
    for (const k of Object.keys(b)) out[k] = (b[k] ?? 0) - (a[k] ?? 0);
    return out;
};

function counterDelta(base: CounterSnapshot | null, now: CounterSnapshot) {
    if (!base) {
        return {
            available: false as const,
            note: "no baseline — call frameReport({reset:true}) to arm one; a delta over an unknown window is not a measurement",
            current: { fastmemReadMapPages: now.fastmem?.readMapPages ?? null },
        };
    }
    const notes: string[] = [];
    const sched = diffNumbers(base.sched, now.sched);
    if (sched && sched.realSwitch === 0 && (sched.ticks ?? 0) > 0) {
        notes.push("scheduler made 0 REAL context switches over the window while ticking — the freeze signature (a pinned callback or an empty run queue).");
    }
    // 32-bit wrapping counter: a naive subtraction reads as 0 or negative. One wrap is
    // recoverable, more than one is not distinguishable — say so rather than imply precision.
    const hcDelta = (now.hypercalls - base.hypercalls) >>> 0;
    return {
        available: true as const,
        windowMs: now.atMs - base.atMs,
        presents: now.presentSerial !== null && base.presentSerial !== null ? now.presentSerial - base.presentSerial : null,
        sched,
        fastmem: {
            speculatedLoadsCompiled: now.fastmem && base.fastmem ? now.fastmem.speculatedLoadsCompiled - base.fastmem.speculatedLoadsCompiled : null,
            readMapPages: now.fastmem?.readMapPages ?? null,
        },
        tier2: diffNumbers(base.tier2, now.tier2),
        codeInvalidations: {
            ranges: now.codeInvalidations.ranges - base.codeInvalidations.ranges,
            bytes: now.codeInvalidations.bytes - base.codeInvalidations.bytes,
            wired: now.codeInvalidations.wired,
        },
        hypercalls: {
            delta: hcDelta,
            wrapCaveat: "32-bit wrapping total; delta is computed unsigned so ONE wrap is recovered. There are no per-id counters, so 'which hypercall' is not answerable today.",
        },
        ...(notes.length ? { notes } : {}),
    };
}

function joinInfo(render: RenderLike | undefined, base: CounterSnapshot | null, now: CounterSnapshot | null) {
    return {
        clock: "worker performance.now() ms. The trace's `ts` is a different base, which is why the window is published as UserTiming MARKS rather than numbers to compare.",
        markBegin: WINDOW_BEGIN_MARK,
        markEnd: WINDOW_END_MARK,
        beginNowMs: base?.atMs ?? null,
        endNowMs: now?.atMs ?? null,
        presentSerialBegin: base?.presentSerial ?? null,
        presentSerialEnd: (now ?? base)?.presentSerial ?? render?.getPresentSerial?.() ?? null,
        howTo: "record with `bun tools/harness.ts trace <sec>` ACROSS this window (it arms the bottleship.hotblocks mark itself), "
            + "then `bun tools/analyze-trace.ts <file> --thread worker` — it reports the perfwindow marks and the same p50/p95/p99 definition.",
    };
}

/** The independent instrument over the same window. Mean is compared because it is free of
 *  rank conventions; the percentile comparison allows for our bucket quantization and for
 *  getFlipCadence's one-rank-higher convention. Every check is published separately so a
 *  disagreement names itself instead of being averaged into a verdict. */
function crossCheckFlipCadence(render: RenderLike | undefined, tail: FrameTail, refreshMs: number) {
    const cadence = render?.getFlipCadence?.(refreshMs);
    if (!cadence) return { available: false, note: "render service unavailable (no game loaded?)" };
    if (!tail.ok) {
        return { available: false, note: `tail is ${tail.status}; nothing to compare against`, flipCadence: cadence };
    }
    const c = cadence as { count: number; avgMs: number; p50Ms: number; p99Ms: number; maxMs: number; vsyncHistogram: Record<string, number> };
    // `agrees: null` = WITHHELD, not disagreed: we refuse a percentile whose rank has no
    // observation behind it while getFlipCadence publishes one regardless. That is a policy
    // difference, not a measurement conflict, so it must not read as either "agrees" or "the
    // instruments disagree".
    const checks: Record<string, { ours: number | null; theirs: number; tolerance: number; agrees: boolean | null }> = {};
    const cmp = (key: string, ours: number | null, theirs: number, tolerance: number) => {
        checks[key] = { ours, theirs, tolerance, agrees: ours === null ? null : Math.abs(ours - theirs) <= tolerance };
    };
    cmp("count", tail.sampleCount, c.count, Math.max(2, c.count * 0.02));
    cmp("meanMs", tail.meanMs, c.avgMs, Math.max(0.5, c.avgMs * 0.02));
    cmp("p50Ms", tail.p50Ms, c.p50Ms, (tail.resolutionMs.p50 ?? 0.25) + 1);
    cmp("p99Ms", tail.p99Ms, c.p99Ms, (tail.resolutionMs.p99 ?? 0.25) + Math.max(1, c.p99Ms * 0.05));
    const disagreements = Object.entries(checks).filter(([, v]) => v.agrees === false).map(([k]) => k);
    const withheld = Object.entries(checks).filter(([, v]) => v.agrees === null).map(([k]) => k);
    const notes: string[] = [];
    if (withheld.length) {
        notes.push(
            `${withheld.join(", ")} withheld here (too few samples for the rank) while getFlipCadence still prints a value — `
            + "at n below 1/(1-p) its percentile IS the max. Not a disagreement between measurements.",
        );
    }
    if (c.count >= 1200) notes.push("flip-cadence ring is SATURATED at its 1200-interval cap: it describes the tail of the window, ours describes all of it.");
    if (disagreements.includes("count")) notes.push("interval counts differ: the cadence ring drops any gap >= 2000ms (we keep it), and either window may have been reset independently.");
    if (disagreements.includes("p99Ms")) notes.push("getFlipCadence indexes percentiles one rank higher (floor(n*p) 0-based), so at small n its p99 IS the max; ours is a bucket upper bound.");
    return {
        available: true,
        agrees: disagreements.length === 0,
        disagreements,
        withheld,
        checks,
        vsyncHistogram: c.vsyncHistogram,
        histogramReading: "clean {2,3} split = structural sub-refresh pulldown; spread across {2,3,4,5} = CPU jitter; rare huge buckets = micro-stalls.",
        ...(notes.length ? { notes } : {}),
    };
}

const boundariesAgree = (presents: number, marks: number) =>
    presents === 0 || marks === 0 ? false : Math.abs(presents - marks) <= Math.max(2, marks * 0.02);

/* ── guest-code attribution: two channels, labelled by what they weight ─────── */

type SampledBlocks = {
    available: boolean;
    note?: string;
    weighting?: string;
    runningSamples?: number;
    rows?: Array<{ block: string; module: string; samples: number; pct: string }>;
    topEips?: Array<{ eip: string; module: string; samples: number; pct: string }>;
};

async function sampledGuestBlocks(ms: number, intervalMs: number, top: number): Promise<SampledBlocks> {
    const fn = (globalThis as { dumpHotJitBlocks?: (a: number, b: number, c: number) => Promise<unknown> }).dumpHotJitBlocks;
    if (typeof fn !== "function") {
        return { available: false, note: "dumpHotJitBlocks unavailable (diagnostics-commands not loaded)" };
    }
    const rows = (await fn(ms, intervalMs, 99_999)) as (Array<{ wasm_fn: string; phys_addr: string; samples: number; pct: string; module: string }> & { topEips?: Array<{ eip: string; samples: number; pct: string; module: string }> }) | undefined;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return {
            available: false,
            note: "no rows: the JIT cache is empty or v86's snapshot exports are missing (rebuild vendor/v86). "
                + "Guest attribution is UNAVAILABLE — the wasm-function[N] -> guest-address mapping is established by sampling and is never computed.",
        };
    }
    const withSamples = rows.filter((r) => (r.samples ?? 0) > 0);
    return {
        available: true,
        weighting: "TIME-weighted (EIP samples): where the guest was when we looked. Sensitive to CPU contention.",
        runningSamples: withSamples.reduce((s, r) => s + r.samples, 0),
        rows: withSamples
            .sort((a, b) => b.samples - a.samples)
            .slice(0, top)
            .map((r) => ({ block: r.wasm_fn, module: r.module || r.phys_addr, samples: r.samples, pct: r.pct })),
        topEips: (rows.topEips ?? []).slice(0, top).map((e) => ({ eip: e.eip, module: e.module, samples: e.samples, pct: e.pct })),
    };
}

type TraceExports = Record<string, (...a: number[]) => number>;

/** A census is only a measurement if THIS process zeroed the recorder and knows when. The
 *  window is owned here rather than inferred, because a disarmed recorder still answers
 *  trace2_block_snapshot() with whatever it last held — a frozen ranking that reads as live. */
type CountedWindow = {
    armedAtMs: number;
    presentSerialBegin: number | null;
    watchedPages: number;
    tier2Total: number;
    requestedPages: number;
    armedRequested: string[];
};

let countedWindow: CountedWindow | null = null;

const traceExports = (): TraceExports | undefined =>
    (globalThis as { preemption?: { getWasmExports?: () => TraceExports | null } }).preemption?.getWasmExports?.() ?? undefined;

type ArmResult = { ok: true; window: CountedWindow } | { ok: false; reason: string };

/**
 * Zero the recorder, then instrument pages. `trace2_reset` is the only zeroing primitive
 * (it clears BLOCK_EXEC_COUNTS and de-instruments), and `trace2_watch_page` is what flips
 * ENABLED — so arming after resetting is the only order that yields a known-empty,
 * known-recording census.
 *
 * `requested` pages are armed FIRST so a named suspect is never crowded out. That matters
 * because of the selection defect documented on `coverage` below: v86's watch table holds
 * 64 pages, `tier2_pages` is a HashSet, and `jit_get_tier2_page_at` walks it with
 * `.iter().nth(i)` — hash order. Once the tier-2 set exceeds 64 the census therefore
 * instruments an ARBITRARY quarter that changes from boot to boot.
 */
function armCountedRecorder(render: RenderLike | undefined, maxPages: number, requested: number[]): ArmResult {
    const w = traceExports();
    if (!w?.trace2_reset || !w?.trace2_watch_page || !w?.trace2_enabled) {
        return { ok: false, reason: "trace2 control exports missing — rebuild vendor/v86 (build-wasm.sh)" };
    }
    if (!w.jit_get_tier2_page_at || !w.jit_get_tier2_page_count) {
        return { ok: false, reason: "tier2 page-enumeration exports missing — rebuild vendor/v86 (build-wasm.sh)" };
    }
    w.trace2_reset();
    let watched = 0;
    const armedRequested: string[] = [];
    for (const addr of requested) {
        if (watched >= maxPages) break;
        if (w.trace2_watch_page(addr >>> 0) >>> 0) { watched++; armedRequested.push("0x" + ((addr >>> 0) & ~0xfff).toString(16)); }
    }
    const tier2Total = w.jit_get_tier2_page_count() >>> 0;
    for (let i = 0; i < tier2Total && watched < maxPages; i++) {
        const addr = w.jit_get_tier2_page_at(i) >>> 0;
        if (!addr) break;
        if (w.trace2_watch_page(addr) >>> 0) watched++;
    }
    if (watched === 0) {
        return {
            ok: false,
            reason: `armed 0 pages (${tier2Total} tier-2 pages exist): the recorder only instruments tier-2-promoted pages, so `
                + "a cold or freshly-cleared JIT has nothing to record. Let the title run a few seconds of the behaviour you "
                + "want attributed, THEN call this — or name the pages you care about with {pages:[addr,…]}.",
        };
    }
    if ((w.trace2_enabled() >>> 0) !== 1) {
        return { ok: false, reason: `watched ${watched} pages but trace2_enabled()==0 — the recorder did not start; census would be stale` };
    }
    return {
        ok: true,
        window: {
            armedAtMs: performance.now(), presentSerialBegin: render?.getPresentSerial?.() ?? null,
            watchedPages: watched, tier2Total, requestedPages: requested.length, armedRequested,
        },
    };
}

function disarmCountedRecorder(): boolean {
    const w = traceExports();
    if (!w?.trace2_unwatch_all) return false;
    w.trace2_unwatch_all();   // stops recording + de-instruments; keeps the counters we just read
    return true;
}

type CountedBlocks = {
    available: boolean;
    note?: string;
    weighting?: string;
    window?: Record<string, unknown>;
    blocks?: number;
    totalWeightedIns?: number;
    saturated?: string[];
    rows?: Array<{ addr: string; module: string | null; exec: number; ins: number; weightedIns: number; sharePct: number; kind: string }>;
};

/**
 * trace2's per-block census ranked by `exec * instructions` — retired guest instructions per
 * block, which is the share of guest work a block owns. Count-weighted, so it is immune to the
 * CPU contention that makes every timing on a busy machine untrustworthy.
 *
 * REFUSES rather than reporting a ranking it cannot date: without a window this process armed
 * (`countedWindow`) the counters may predate anything the caller did, and without
 * `trace2_enabled()` still set at read time the window ended early. Both failure modes look
 * exactly like a valid answer in the numbers alone, so they are checked, never assumed.
 */
function countedGuestBlocks(top: number, window: CountedWindow | null, render: RenderLike | undefined): CountedBlocks {
    const w = traceExports();
    if (!w?.trace2_block_snapshot) {
        return { available: false, note: "trace2 snapshot exports missing — rebuild vendor/v86 (build-wasm.sh)" };
    }
    if (!window) {
        return {
            available: false,
            note: "REFUSED: no window this call armed. The recorder answers a snapshot request whether or not it is recording, "
                + "so counts without a known zero point are not a measurement. Use guestBlocks() (arms, waits, reads) or the "
                + "explicit pair guestBlocks({phase:'arm'}) -> drive the scene -> guestBlocks({phase:'read'}).",
        };
    }
    const stillRecording = w.trace2_enabled ? (w.trace2_enabled() >>> 0) === 1 : false;
    const watchedNow = w.trace2_watched_page_count ? w.trace2_watched_page_count() >>> 0 : -1;
    if (!stillRecording) {
        return {
            available: false,
            note: `REFUSED: recorder is disarmed at read time (trace2_enabled=0, watched=${watchedNow}) — something reset or `
                + "unwatched it mid-window (dbg.trace2Reset/trace2UnwatchAll, jitRegions, or a game switch), so these counts "
                + "cover an unknown prefix of the window rather than the window.",
            window: { ...window, disarmedMidWindow: true },
        };
    }
    const n = w.trace2_block_snapshot() >>> 0;
    const readAtMs = performance.now();
    const presentSerialEnd = render?.getPresentSerial?.() ?? null;
    const uncovered = Math.max(0, window.tier2Total - window.watchedPages);
    const windowOut = {
        armedAtMs: Math.round(window.armedAtMs),
        readAtMs: Math.round(readAtMs),
        elapsedMs: Math.round(readAtMs - window.armedAtMs),
        presents: presentSerialEnd !== null && window.presentSerialBegin !== null ? presentSerialEnd - window.presentSerialBegin : null,
        presentSerialBegin: window.presentSerialBegin,
        presentSerialEnd,
        watchedPages: window.watchedPages,
        watchedPagesNow: watchedNow,
        tier2Total: window.tier2Total,
        tier2PagesUnwatched: uncovered,
        requestedPages: window.requestedPages,
        armedRequestedPages: window.armedRequested,
        zeroedByThisCall: true,
        slotOverflow: w.trace2_slot_overflow ? w.trace2_slot_overflow() >>> 0 : null,
        coverage: `only the ${window.watchedPages} armed page(s) are counted; guest work anywhere else (interpreted code, `
            + "tier-1-only pages, pages promoted DURING the window) is absent, not zero. Shares are of the COUNTED total, "
            + "never of all guest instructions.",
        // The single most misread property of this channel. v86's watch table is 64 entries
        // and `tier2_pages` is a HashSet walked with .iter().nth(i), so past 64 tier-2 pages
        // the sample is arbitrary AND differs per boot. A share is then a share of a random
        // quarter, and an absent block may simply never have been instrumented.
        ...(uncovered > 0
            ? {
                selectionWarning:
                    `${uncovered} of ${window.tier2Total} tier-2 pages could NOT be armed (v86's watch table holds 64). `
                    + "The unarmed ones are not the cold ones: jit_get_tier2_page_at walks a HashSet in HASH order, so which "
                    + "pages get in is arbitrary and changes between boots. Consequences: (1) a `sharePct` here is a share of "
                    + "this arbitrary subset, so it can be several times the block's share of all guest work; (2) a block's "
                    + "ABSENCE is not evidence that it is cold; (3) the ranking is not reproducible across boots. To ask about "
                    + "specific code, name it: guestBlocks({pages:[0x…]}) arms those pages first and lists them in "
                    + "armedRequestedPages.",
            }
            : {}),
    };
    if (n === 0) {
        return {
            available: false,
            note: "recorder was armed and recording but observed 0 blocks: the armed pages did not execute during the window "
                + "(wrong scene, or the JIT re-promoted different pages after arming). Not a ranking — nothing ran.",
            window: windowOut,
        };
    }
    const kinds = ["normal", "cond", "indirect", "exit"];
    const mreg = (sys().process as { moduleRegistry?: { getModuleContainingAddress?: (a: number) => { name: string; baseAddress: number } | null } } | null)?.moduleRegistry;
    const rows: NonNullable<CountedBlocks["rows"]> = [];
    const saturated: string[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
        const addr = w.trace2_block_addr(i) >>> 0;
        const exec = w.trace2_block_exec(i) >>> 0;
        const ins = w.trace2_block_instructions(i) >>> 0;
        // trace2_block_exec SATURATES at u32::MAX rather than wrapping: a pegged counter is an
        // under-count of unknown size, so it is named instead of silently ranked.
        if (exec === 0xffffffff) saturated.push("0x" + addr.toString(16));
        const weightedIns = exec * ins;
        total += weightedIns;
        let module: string | null = null;
        try {
            const mod = mreg?.getModuleContainingAddress?.(addr);
            if (mod) module = `${mod.name}+0x${(addr - mod.baseAddress).toString(16)}`;
        } catch { /* unmapped address: report the raw one */ }
        rows.push({ addr: "0x" + addr.toString(16), module, exec, ins, weightedIns, sharePct: 0, kind: kinds[w.trace2_block_kind(i) >>> 0] ?? "?" });
    }
    rows.sort((a, b) => b.weightedIns - a.weightedIns);
    for (const r of rows) r.sharePct = total > 0 ? Math.round((r.weightedIns / total) * 1000) / 10 : 0;
    return {
        available: true,
        weighting: "COUNT-weighted (exec x static instructions = retired guest instructions): survives a noisy machine because it never looks at time.",
        window: windowOut,
        blocks: n,
        totalWeightedIns: total,
        ...(saturated.length ? { saturated } : {}),
        rows: rows.slice(0, top),
    };
}

/** The two channels answer different questions; when their top guest block differs that is a
 *  finding (time in few instructions = a slow op or a cache miss; instructions with little
 *  time = a cheap hot loop), so it is reported rather than reconciled. */
function crossCheckGuestChannels(sampled: SampledBlocks, counted: CountedBlocks) {
    if (!sampled.available || !counted.available) {
        return {
            comparable: false,
            note: `only ${sampled.available ? "the time-weighted" : counted.available ? "the count-weighted" : "neither"} channel produced data`,
        };
    }
    const topSampledModule = sampled.topEips?.[0]?.module || sampled.rows?.[0]?.module || null;
    const topCountedModule = counted.rows?.[0]?.module ?? null;
    const sameModule = !!topSampledModule && !!topCountedModule
        && topSampledModule.split("+")[0] === topCountedModule.split("+")[0];
    return {
        comparable: true,
        topTimeWeighted: topSampledModule,
        topCountWeighted: topCountedModule,
        sameModule,
        note: sameModule
            ? "both channels point at the same module — the ranking is not an artifact of either weighting"
            : "channels DISAGREE on the hottest module: time-weighted vs count-weighted are different questions "
              + "(few instructions costing much time vs many cheap instructions). Do not conclude 'the JIT is fine' from one axis.",
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

    /** perfStats() — latest + average frame sample, plus the frame-time TAIL summary.
     *  `averageWindow` is how many frames `average` covers (not the same as sampleCount);
     *  `spikesSeen` is the true count of capture-worthy frames (`spikeCount` is capped at the
     *  worst-N ring capacity). Use `frameReport` for the full budget verdict + spike classes. */
    svc.register("perfStats", () => {
        const snap = frameProfiler.getSnapshot();
        const tail = frameProfiler.getTail();
        return {
            enabled: snap.enabled,
            source: snap.source,
            sampleCount: snap.sampleCount,
            averageWindow: snap.averageWindow,
            latest: summarizeSample(snap.latest),
            average: summarizeSample(snap.average),
            spikeCount: (snap.badFrames ?? []).length,
            spikesSeen: snap.badFramesSeen ?? 0,
            tail: tail.ok
                ? {
                    samples: tail.sampleCount, p50Ms: tail.p50Ms, p95Ms: tail.p95Ms, p99Ms: tail.p99Ms,
                    maxMs: tail.maxMs, budget: tail.budget,
                }
                : { status: tail.status, note: tail.note },
        };
    });

    /**
     * frameReport({budgetMs?, refreshMs?=16.67, top?=8, reset?, maxBuckets?}) — the frame
     * instrument. One report, two depths.
     *
     * SHALLOW (this verb, always-on, cheap):
     *   - `tail`: fixed-bucket distribution over the window — p50/p95/p99 (UPPER BOUNDS, with
     *     the bucket width they came from), max, and frames over BUDGET. The budget is yours or
     *     is derived from the cadence the window observed; 16.7 is never assumed. A window that
     *     was not really measured returns a STATE (`disabled` / `no-samples` /
     *     `disarmed-mid-window` / `source-switched-mid-window`) and no percentiles at all.
     *   - `spikes`: every budget-missing frame COALESCED into (dominant category x top
     *     contributor) classes ranked by TOTAL MS LOST — 40 x 8ms beats one 120ms stall — each
     *     with one representative frame in full for drilling. `coverage` says whether the
     *     classes actually cover all over-budget frames.
     *   - `counters`: window deltas for the axes that need no new counters — scheduler
     *     round-trips, fastmem/JIT (generation bumps by source, deopt recompiles, thrash),
     *     tier-2, code invalidations, hypercall total. Needs a baseline: `{reset:true}` first.
     *   - `crossCheck`: the same window as read by the INDEPENDENT flip-cadence instrument.
     *   - `blindSpots`: what this depth structurally cannot see, enumerated so nobody reads
     *     "GC was not the cause" out of a tool that never looked.
     *
     * DEEP (trace): `join` carries the window identity as UserTiming marks, so a trace taken
     * across the window can be sliced to exactly it. GC, JS-vs-wasm and v86-internal
     * attribution live there; `guestBlocks` names the guest code.
     *
     * Flow: frameReport({reset:true, budgetMs:33.34}) -> play/tickFrames -> frameReport().
     */
    svc.register("frameReport", (args) => {
        const opts = (args[0] ?? {}) as {
            budgetMs?: number; refreshMs?: number; top?: number; reset?: boolean; maxBuckets?: number;
        };
        const render = sys().services?.render as RenderLike | undefined;

        if (opts.reset) {
            // Arm the classifier at the budget so it sees EVERY over-budget frame, not just
            // the ones past the (30fps-shaped) capture threshold.
            if (opts.budgetMs && opts.budgetMs > 0) frameProfiler.configureCapture({ classifyOverMs: opts.budgetMs });
            frameProfiler.setEnabled(true);
            frameProfiler.reset();
            profiler.setEnabled(true);
            profiler.reset();
            render?.resetFlipCadence?.();
            windowBaseline = snapshotCounters(render);
            mark(WINDOW_BEGIN_MARK);
            return {
                armed: true,
                join: joinInfo(render, windowBaseline, null),
                note: "window armed: frame profiler, flip cadence and counter baseline all start here. "
                    + "Take a Chrome trace across this window for the deep depth (GC / stacks / guest blocks).",
            };
        }

        const tail = frameProfiler.getTail({ budgetMs: opts.budgetMs, maxBuckets: opts.maxBuckets });
        const budgetMs = opts.budgetMs ?? (tail.ok && tail.budget ? tail.budget.ms : undefined);
        const spikes = frameProfiler.getSpikeClasses({ budgetMs, top: opts.top ?? 8 });
        const now = snapshotCounters(render);
        mark(WINDOW_END_MARK);

        return {
            boundary: {
                tail: "present (RenderService.notifyPresent — the same event as the bottleship.flip trace mark and getFlipCadence)",
                spikes: "markFrame (presenter-labelled; ddraw Flip's frameAlreadyMarked can skip it)",
                presentFrames: frameProfiler.getPresentFrameCount(),
                markFrames: frameProfiler.getMarkFrameCount(),
                agree: boundariesAgree(frameProfiler.getPresentFrameCount(), frameProfiler.getMarkFrameCount()),
                note: boundariesAgree(frameProfiler.getPresentFrameCount(), frameProfiler.getMarkFrameCount())
                    ? undefined
                    : "the two frame boundaries saw different counts — spike-class coverage is relative to markFrame frames, "
                      + "while the tail/budget verdict is relative to presents",
            },
            tail,
            spikes: {
                ...spikes,
                drill: {
                    thunks: "perfThunks({filter}) — session-wide per-call cost; avgUs is the contention-robust figure, frame counts are not",
                    subPhases: "profilerStats({filter}) — named-bucket sub-phase timings (maxMs = worst single call)",
                    guestCode: "guestBlocks() — sampled (time-weighted) + trace2 (count-weighted) guest-block attribution",
                },
            },
            counters: counterDelta(windowBaseline, now),
            crossCheck: crossCheckFlipCadence(render, tail, opts.refreshMs ?? 16.67),
            join: joinInfo(render, windowBaseline, now),
            blindSpots: LIVE_BLIND_SPOTS,
        };
    });

    /**
     * guestBlocks({ms?=2000, intervalMs?=5, top?=15, phase?, maxPages?=64, keepArmed?}) — WHICH
     * GUEST CODE, by two independent channels, labelled by what they weight:
     *
     *   - `sampled` (TIME-weighted): dumpHotJitBlocks' EIP sampling correlated to
     *     `module+rva`. This is the only sound wasm-function[N] -> guest-address route:
     *     v86's table indices do NOT match Chrome's numbering, so the mapping is established
     *     by sampling, never computed. No rows => attribution unavailable, said plainly.
     *   - `counted` (COUNT-weighted): the trace2 recorder's per-block `exec * static
     *     instructions`, resolved to `module+rva` — the ranking that survives a noisy machine
     *     because it never looks at time.
     *
     * The counted channel OWNS its window: this verb zeroes the recorder (trace2_reset), arms
     * the tier-2 pages, and publishes the window it covers (`counted.window`: elapsedMs,
     * presents, armed page count, slot overflow). If it cannot do that — no exports, 0 tier-2
     * pages, or the recorder disarmed mid-window — it REFUSES with the reason instead of
     * ranking counters of unknown age, because a stale census is numerically indistinguishable
     * from a live one.
     *
     * `phase` splits the window when the scene must be driven by hand:
     * `{phase:'arm'}` zeroes+arms and returns immediately, `{phase:'read'}` reads the census
     * against that window (and leaves it running unless `keepArmed:false`). Default (no phase)
     * is arm -> wait `ms` -> read -> disarm.
     *
     * TIMING BIAS: while armed, every block on an armed page pays a trace2_record_* increment,
     * so the guest is measurably slower. Take `frameReport`/`trace` numbers from a CLEAN
     * (disarmed) window and the counts from the armed one — never quote a tail measured under
     * arming.
     *
     * They answer subtly different questions, so a disagreement in the top block is REPORTED,
     * not reconciled. From an address: `bun tools/re/re.ts resolve <eip> --base <liveBase>`
     * and `tools/pe-disas.py func|range`.
     */
    svc.register("guestBlocks", async (args) => {
        const opts = (args[0] ?? {}) as {
            ms?: number; intervalMs?: number; top?: number; phase?: "arm" | "read";
            maxPages?: number; keepArmed?: boolean; pages?: Array<number | string>;
        };
        const ms = Math.max(200, Math.min(30_000, opts.ms ?? 2000));
        const intervalMs = Math.max(1, opts.intervalMs ?? 5);
        const top = opts.top ?? 15;
        const maxPages = Math.max(1, Math.min(64, opts.maxPages ?? 64));
        const pages = (opts.pages ?? [])
            .map((p) => (typeof p === "string" ? Number.parseInt(p, 16) : p) >>> 0)
            .filter((p) => p > 0);
        const render = sys().services?.render as RenderLike | undefined;

        const BIAS = "trace2 arming instruments every block on the armed pages (trace2_record_*), which SLOWS the guest. "
            + "Counts come from this armed window; any p50/p95/p99 or A/B timing must come from a disarmed one.";
        const RESET_NOTE = "trace2_reset also drops the indirect-target histograms that dbg.jitRegions consumes — re-collect "
            + "them if you were mid region-formation.";

        if (opts.phase === "arm") {
            const arm = armCountedRecorder(render, maxPages, pages);
            countedWindow = arm.ok ? arm.window : null;
            return arm.ok
                ? {
                    phase: "arm", armed: true, window: { ...arm.window, armedAtMs: Math.round(arm.window.armedAtMs) },
                    biasCaveat: BIAS, note: `${RESET_NOTE} Drive the scene, then guestBlocks({phase:'read'}).`,
                }
                : { phase: "arm", armed: false, refused: arm.reason };
        }

        if (opts.phase === "read") {
            const counted = countedGuestBlocks(top, countedWindow, render);
            if (opts.keepArmed === false) { disarmCountedRecorder(); countedWindow = null; }
            return {
                phase: "read",
                sampled: { available: false, note: "phase:'read' reads the counted census only — the time-weighted channel needs its own live sampling window (call guestBlocks() with no phase, disarmed, for that)." },
                counted,
                stillArmed: opts.keepArmed !== false,
                biasCaveat: BIAS,
            };
        }

        const arm = armCountedRecorder(render, maxPages, pages);
        countedWindow = arm.ok ? arm.window : null;
        // Both channels observe the same wall-clock window: the sampler's own duration IS the
        // counted window, so a disagreement between them cannot be blamed on different spans.
        const sampled = await sampledGuestBlocks(ms, intervalMs, top);
        const counted = countedGuestBlocks(top, countedWindow, render);
        if (opts.keepArmed !== true) { disarmCountedRecorder(); countedWindow = null; }
        return {
            window: { ms, intervalMs },
            armed: arm.ok,
            ...(arm.ok ? {} : { armRefused: arm.reason }),
            stillArmed: opts.keepArmed === true,
            biasCaveat: arm.ok
                ? `${BIAS} The \`sampled\` rows below were themselves collected under arming, so treat them as attribution, not cost. ${RESET_NOTE}`
                : BIAS,
            sampled,
            counted,
            crossCheck: crossCheckGuestChannels(sampled, counted),
        };
    });

    /**
     * hotBlocksMark({ms?=3000, intervalMs?=5}) — emit the `bottleship.hotblocks` UserTiming
     * mark INSIDE an active trace recording, which is what lets `analyze-trace.ts` resolve
     * `wasm-function[N]` frames to `module:rva` with no --map and no sidecar. `bun
     * tools/harness.ts trace` calls this automatically partway through its window; call it
     * directly only when driving Tracing yourself.
     */
    svc.register("hotBlocksMark", async (args) => {
        const opts = (args[0] ?? {}) as { ms?: number; intervalMs?: number };
        const ms = Math.max(200, Math.min(30_000, opts.ms ?? 3000));
        const intervalMs = Math.max(1, opts.intervalMs ?? 5);
        const fn = (globalThis as { captureHotBlocksMark?: (a: number, b: number) => Promise<number> }).captureHotBlocksMark;
        if (typeof fn !== "function") {
            throw new HarnessError("captureHotBlocksMark unavailable (diagnostics-commands not loaded)", HarnessErrorCode.INTERNAL);
        }
        const blocks = await fn(ms, intervalMs);
        return {
            blocks,
            marked: blocks > 0,
            mark: "bottleship.hotblocks",
            note: blocks > 0
                ? "mark emitted — analyze-trace will resolve wasm frames to module:rva from it"
                : "NO mark emitted (JIT cache empty or v86 snapshot exports missing): a trace taken now analyses shallow",
        };
    });

    /**
     * eipProfile({ms?=3000, intervalMs?=5, top?=15}) — where the GUEST burns CPU, as data.
     *
     * The frame/thunk profilers only see OUR side; when a stall is guest code (a level
     * load, a decode loop) they report a few hundred ms out of several seconds and the
     * Chrome trace attributes JIT blocks to opaque `wasm-function[N]`. This samples
     * cpu.instruction_pointer and symbolizes it against the loaded PE modules, so the
     * answer is "module+rva", which `re decompile` takes directly.
     *
     * `stoppedPct` is the instrument's own blind spot, reported rather than hidden: while
     * v86 is stopped (async park / intentional yield) the register holds the LAST executed
     * address, so those samples are counted separately instead of being charged to whatever
     * EIP happened to be frozen there. A high stoppedPct means the guest was NOT burning
     * CPU — read that before reading the histogram.
     */
    svc.register("eipProfile", async (args) => {
        const opts = (args[0] ?? {}) as { ms?: number; intervalMs?: number; top?: number };
        const durationMs = Math.max(50, Math.min(60_000, opts.ms ?? 3000));
        const intervalMs = Math.max(1, opts.intervalMs ?? 5);
        const top = opts.top ?? 15;

        const c = cpu();
        const ip = c?.instruction_pointer;
        if (!ip) throw new HarnessError("no guest CPU (load a game first)", HarnessErrorCode.NO_PROCESS);
        const scheduler: any = sys().scheduler;
        const v86: any = (sys().process as any)?.v86;

        const exact = new Map<number, number>();
        const pages = new Map<number, number>();
        let running = 0, stopped = 0;

        await new Promise<void>((resolve) => {
            const id = setInterval(() => {
                if (scheduler?.intentionalYield || v86?.running === false) { stopped++; return; }
                running++;
                const eip = ip[0] >>> 0;
                exact.set(eip, (exact.get(eip) ?? 0) + 1);
                const page = eip & ~0xfff;
                pages.set(page, (pages.get(page) ?? 0) + 1);
            }, intervalMs) as unknown as number;
            setTimeout(() => { clearInterval(id); resolve(); }, durationMs);
        });

        const rank = (m: Map<number, number>, denom: number) =>
            Array.from(m.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, top)
                .map(([addr, n]) => ({
                    addr: "0x" + addr.toString(16),
                    sym: symbolize(addr),
                    count: n,
                    pct: denom > 0 ? Math.round((n / denom) * 1000) / 10 : 0,
                }));

        const total = running + stopped;
        return {
            durationMs, intervalMs,
            samples: total,
            runningSamples: running,
            stoppedPct: total > 0 ? Math.round((stopped / total) * 1000) / 10 : 0,
            topPages: rank(pages, running),
            topEips: rank(exact, running),
        };
    });
}
