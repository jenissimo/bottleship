/**
 * dispatchArm / dispatchMark / dispatchReport — WHICH class of transition pays the ~5% of
 * busy that the Far Cry trace attributes to dispatch
 * (docs/performance/sota-roadmap/07-dispatch-tax.md).
 *
 * `dbg.dispatchStats()` already reads these counters, but it reports lifetime totals, it
 * stops before the memo split (indices 18-22), and a build with the counters switched off
 * answers zero — a number indistinguishable from "the dispatch tax is small". Each of
 * those turns the readout into a plausible answer to the wrong question, so:
 *
 *   - the window is a DIFFERENCE of two snapshots, never a total;
 *   - `dispatchArm()` is a separate, loud step (it clears the JIT cache, so the window
 *     must contain a warm-up — a report over an unwarmed window is refused);
 *   - counters flat while the guest retired instructions is an ERROR, not a 0% tax;
 *   - counters the shipping build cannot produce are reported `null` with the reason,
 *     never 0.
 *
 * The verdict maps the dominant class onto the lever the roadmap names for it; fifteen
 * counters and no class is not an answer.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { retiredDelta } from "./perf";
import { cpu, symbolize } from "../serialize";
import { dbg } from "../../core/debug/dbg-commands";

/** Index order of `profiler_dispatch_stat_get`, mirrored from profiler.rs. */
export const DISPATCH_STAT_NAMES = [
    "blockExecution", "moduleReentry", "moduleExitChainable", "moduleExitDynamic",
    "moduleExitIndirect", "moduleChainedEdge", "moduleChainBudgetExit", "moduleChainMiss",
    "deadFlagCandidate", "deadFlagElided",
    "abseipDispatch", "retChainHit", "retChainMiss",
    "x87CacheHit", "x87CacheFill", "x87CacheInvalidate", "pushRunHit", "pushRunFill",
    "retMemoHit", "retMemoAlias", "retMemoCold", "retMetaHit", "retChainBudget",
    "readTlbCacheHit", "readTlbCacheFill",
] as const;

export type DispatchCounters = Record<(typeof DISPATCH_STAT_NAMES)[number], number>;

/** One row of the entry-EIP census: where the dispatcher re-entered the guest. */
export interface EntryEipRow { eip: number; hits: number; symbol: string | null }

export interface EntryEipCensus {
    available: boolean;
    reason?: string;
    samples: number;
    evictions: number;
    /** Share of samples the direct-mapped table could not attribute. A high value means
     *  `top` is a sample of a wider distribution, not the distribution. */
    evictionPct: number | null;
    attributed: number;
    top: EntryEipRow[];
}

export interface DispatchSnapshot {
    atMs: number;
    counters: DispatchCounters;
    /** cpu.instruction_counter, 32-bit and wrapping — differenced with retiredDelta. */
    retiredCounter: number;
    /** get_dispatch_stats(): 1 while the always-on counters are being emitted. */
    statsEnabled: number;
    /** profiler_is_enabled(): the feature-gated counters (INDIRECT_JUMP_NO_ENTRY,
     *  RUN_INTERPRETED_*, CYCLE_INTERNAL) exist only when this is true. */
    profilerEnabled: boolean;
    /** Ticks of dispatchArm() this snapshot belongs to — a re-arm inside the window
     *  zeroes the counters and would read as a huge negative delta. */
    armEpoch: number;
    /** Where the dispatcher re-entered the guest. Cumulative since the arm (a
     *  direct-mapped table cannot be differenced without losing which slot held what). */
    entryEip: EntryEipCensus;
}

type Exports = Record<string, ((...a: number[]) => number) | undefined>;

const exportsOf = (): Exports | null =>
    ((globalThis as { preemption?: { getWasmExports?: () => Exports | null } }).preemption?.getWasmExports?.() ?? null);

let armEpoch = 0;
let armedAtMs = -1;
let mark: DispatchSnapshot | null = null;

export function readDispatchSnapshot(): DispatchSnapshot {
    const w = exportsOf();
    const get = w?.["profiler_dispatch_stat_get"];
    if (typeof get !== "function") {
        throw new HarnessError(
            "profiler_dispatch_stat_get missing from the loaded v86 — rebuild vendor/v86 (build-wasm.sh)",
            HarnessErrorCode.INTERNAL);
    }
    const counters = {} as DispatchCounters;
    for (let i = 0; i < DISPATCH_STAT_NAMES.length; i++) {
        counters[DISPATCH_STAT_NAMES[i]!] = Number(get(i));
    }
    const enabledGet = w?.["get_dispatch_stats"];
    const profGet = w?.["profiler_is_enabled"];
    const ic = (cpu() as { instruction_counter?: Int32Array } | null)?.instruction_counter;
    return {
        atMs: performance.now(),
        counters,
        entryEip: readEntryEipCensus(w),
        retiredCounter: ic ? ic[0]! >>> 0 : 0,
        statsEnabled: typeof enabledGet === "function" ? enabledGet() >>> 0 : -1,
        profilerEnabled: typeof profGet === "function" ? !!profGet() : false,
        armEpoch,
    };
}

/**
 * The entry-EIP table. Read whole rather than sampled top-N: the eviction count is what
 * says how complete the table is, and a top-N without it reads as a full ranking.
 */
function readEntryEipCensus(w: Exports | null): EntryEipCensus {
    const slots = w?.["entry_eip_census_slots"];
    const addr = w?.["entry_eip_census_addr"];
    const hits = w?.["entry_eip_census_hits"];
    if (typeof slots !== "function" || typeof addr !== "function" || typeof hits !== "function") {
        return {
            available: false, samples: 0, evictions: 0, evictionPct: null, attributed: 0, top: [],
            reason: "the loaded v86 has no entry-EIP census — rebuild vendor/v86 (build-wasm.sh)",
        };
    }
    const n = slots() >>> 0;
    const rows: EntryEipRow[] = [];
    let attributed = 0;
    for (let i = 0; i < n; i++) {
        const h = Number(hits(i));
        if (h <= 0) continue;
        attributed += h;
        rows.push({ eip: addr(i) >>> 0, hits: h, symbol: null });
    }
    rows.sort((a, b) => b.hits - a.hits);
    const samples = Number(w?.["entry_eip_census_samples"]?.() ?? 0);
    const evictions = Number(w?.["entry_eip_census_evictions"]?.() ?? 0);
    return {
        available: true, samples, evictions,
        evictionPct: samples > 0 ? +((evictions / samples) * 100).toFixed(2) : null,
        attributed,
        top: rows.slice(0, 32),
    };
}

export type DispatchSummary =
    | { ok: false; refuse: string; code: string }
    | { ok: true; armed: false; reason: string; windowMs: number }
    | { ok: true; armed: true; report: Record<string, unknown> };

const round = (v: number, d = 2): number => +v.toFixed(d);
const pct = (n: number, d: number): number | null => (d > 0 ? round((n / d) * 100, 2) : null);

/**
 * The whole readout as a pure function of two snapshots, so every refusal has a test.
 *
 * The denominator for a share is MODULE_REENTRY + MODULE_CHAINED_EDGE: every module exit,
 * chained or not. Dividing by reentry alone would make the chained edges — the ones that
 * already cost nothing — invisible in the denominator and inflate every share.
 */
export function summarizeDispatch(before: DispatchSnapshot, after: DispatchSnapshot): DispatchSummary {
    const windowMs = after.atMs - before.atMs;
    if (windowMs <= 0) {
        return { ok: false, code: HarnessErrorCode.BAD_ARGS, refuse: "dispatchReport window is empty — mark and report in different turns" };
    }
    if (after.armEpoch !== before.armEpoch) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "dispatchArm() ran inside the window: the counters were zeroed mid-flight, so every delta below "
                + "would be a fragment of the window. Re-mark after arming.",
        };
    }
    if (after.statsEnabled === 0 || before.statsEnabled === 0) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "DISPATCH_STATS is off, so nothing was counting. A zero here would read as 'no dispatch tax'. "
                + "Call dispatchArm() BEFORE the workload (it clears the JIT cache; hot code must recompile with "
                + "the counter increments in it), then let the scene warm up.",
        };
    }

    const d = {} as DispatchCounters;
    for (const k of DISPATCH_STAT_NAMES) d[k] = after.counters[k] - before.counters[k];
    const retired = retiredDelta(before.retiredCounter, after.retiredCounter);

    if (retired === 0) {
        return { ok: true, armed: false, windowMs: round(windowMs), reason: "the guest retired no instructions in this window" };
    }
    // Counters flat while the guest ran: the hot blocks were compiled BEFORE the arm and
    // carry no increments. That is a broken measurement, not a small tax.
    if (d.blockExecution === 0) {
        return {
            ok: false, code: HarnessErrorCode.INTERNAL,
            refuse: `BLOCK_EXECUTION did not move while the guest retired ${retired} instructions. The code running `
                + "was compiled before dispatchArm() cleared the cache, so it carries no counter increments. "
                + "Arm, warm the scene up, THEN mark.",
        };
    }
    // A wrapped 32-bit retired counter over a long window is silently plausible; the
    // denominator would be ~4.3e9 too small. Ticking the accumulator is perf.ts's job, so
    // here the guard is a bound on the window rather than a correction.
    const suspectWrap = windowMs > 30_000;

    const exits = d.moduleReentry + d.moduleChainedEdge;
    const classes = {
        // Chained at compile time: the successor eip was a constant and a tail call took
        // it. These pay no dispatch, and they are in the denominator on purpose.
        chained: d.moduleChainedEdge,
        // A constant successor that was NOT chained: the target sat outside the region.
        // Lever: region formation (roadmap 06) / JIT_INDIRECT_REGION_MAX_PAGES.
        constantTargetUnchained: d.moduleExitChainable,
        // ret / iret / far jmp: the AbsoluteEip family the memo serves.
        dynamic: d.moduleExitDynamic,
        // Indirect jmp/call whose target left the module: the C++ virtual call.
        // Lever: a call-site inline cache.
        indirect: d.moduleExitIndirect,
    };
    const other = Math.max(0, d.moduleReentry - classes.constantTargetUnchained - classes.dynamic - classes.indirect);

    // Where an AbsoluteEip dispatch was actually served. `alias` is a capacity/conflict
    // miss the memo COULD have served (widen it); `cold` is a target the memo never had
    // (widening does nothing) — opposite conclusions, opposite fixes.
    const abseip = d.abseipDispatch;
    const memo = {
        hit: d.retMemoHit, alias: d.retMemoAlias, cold: d.retMemoCold,
        metaHit: d.retMetaHit, budget: d.retChainBudget,
        chainHit: d.retChainHit, chainMiss: d.retChainMiss,
    };
    const memoAccounted = memo.hit + memo.alias + memo.cold + memo.budget;

    let dominant: string, lever: string;
    const chainableShare = exits > 0 ? classes.constantTargetUnchained / exits : 0;
    const indirectShare = exits > 0 ? classes.indirect / exits : 0;
    const dynamicShare = exits > 0 ? classes.dynamic / exits : 0;
    if (indirectShare >= chainableShare && indirectShare >= dynamicShare) {
        dominant = "indirect";
        lever = "call-site inline cache: compare the computed target with the last one and br without a lookup";
    } else if (chainableShare >= dynamicShare) {
        dominant = "constantTargetUnchained";
        lever = "region formation — the target is a compile-time constant that fell outside the region "
            + "(roadmap 06, or JIT_INDIRECT_REGION_MAX_PAGES)";
    } else {
        dominant = "dynamic";
        lever = memo.alias > memo.cold
            ? "widen the ret memo: aliasing dominates, so these are conflict misses it could have served"
            : "the ret memo is not the constraint: cold misses dominate, meaning the target set is larger than "
            + "any memo, so raise N per unit (region formation) instead of widening the memo";
    }

    return {
        ok: true, armed: true,
        report: {
            armed: true,
            windowMs: round(windowMs),
            retired,
            ...(suspectWrap
                ? {
                    retiredWarning: "window longer than the ~40 s wrap period of cpu.instruction_counter; "
                        + "`retired` and every per-instruction rate below may be one wrap short",
                }
                : {}),

            // Every module exit, chained or not: the dispatch tax's denominator.
            moduleExits: exits,
            // Per KILO-instruction as cpu.instruction_counter counts them, which is a
            // block-credit, not an exact retired count: it runs ~1 per iteration ahead of a
            // tight loop's real length (measured on tools/guestbench). The rate is therefore
            // slightly LOW, and comparable between arms rather than absolute.
            exitsPerKiloInsn: round((exits / retired) * 1000, 3),
            blockExecutions: d.blockExecution,
            intraModuleEdges: Math.max(0, d.blockExecution - d.moduleReentry - d.moduleChainedEdge),

            classes: {
                chained: { n: classes.chained, pct: pct(classes.chained, exits) },
                constantTargetUnchained: { n: classes.constantTargetUnchained, pct: pct(classes.constantTargetUnchained, exits) },
                dynamic: { n: classes.dynamic, pct: pct(classes.dynamic, exits) },
                indirect: { n: classes.indirect, pct: pct(classes.indirect, exits) },
                other: { n: other, pct: pct(other, exits) },
            },

            absEip: {
                dispatches: abseip,
                perKiloInsn: round((abseip / retired) * 1000, 3),
                ...memo,
                // The three probe outcomes plus the budget bail partition every dispatch;
                // a mismatch means the split itself drifted and no share here is usable.
                probeOutcomesSumOk: abseip === 0 ? null : memoAccounted === abseip,
                unaccounted: abseip - memoAccounted,
            },

            chaining: { budgetExit: d.moduleChainBudgetExit, miss: d.moduleChainMiss },

            // Classes the shipping build genuinely cannot see. Reported as absent with the
            // reason rather than as zero, because a 0 here would read as "no interpreted
            // fallback, no missing indirect entries" — a conclusion nobody measured.
            profilerOnly: after.profilerEnabled
                ? { available: true, note: "profiler build: INDIRECT_JUMP_NO_ENTRY / RUN_INTERPRETED_* readable via profiler_stat_get" }
                : {
                    available: false,
                    reason: "shipping build (profiler feature off): INDIRECT_JUMP_NO_ENTRY, RUN_INTERPRETED_DIFFERENT_STATE_* "
                        + "and CYCLE_INTERNAL return 0 by construction. Absent, not zero.",
                },

            // WHERE the dispatcher keeps re-entering. The counters name a class; this names
            // the addresses, which is what `re resolve --base <liveBase>` turns into
            // functions. Lifetime since the last dispatchArm, not windowed — a direct-mapped
            // table cannot be differenced without losing which slot held what.
            entryEip: after.entryEip.available
                ? {
                    ...after.entryEip,
                    top: after.entryEip.top.map((r: EntryEipRow) => ({ ...r, symbol: symbolize(r.eip) })),
                    note: "cumulative since dispatchArm(), not windowed. `evictionPct` is the share of "
                        + "dispatcher entries the table could not attribute; above a few percent, `top` is a "
                        + "sample of the distribution rather than the distribution.",
                }
                : after.entryEip,

            verdict: { dominantClass: dominant, lever },
        },
    };
}

export function registerDispatchCommands(svc: HarnessService): void {
    /**
     * dispatchArm() — switch the always-on dispatch counters on and clear the JIT cache so
     * hot code recompiles WITH the increments. Destructive to the measurement it precedes:
     * the scene must warm up again before dispatchMark().
     */
    svc.register("dispatchArm", (args) => {
        const on = (args[0] as { on?: boolean } | undefined)?.on ?? true;
        if (typeof exportsOf()?.["set_dispatch_stats"] !== "function") {
            throw new HarnessError("set_dispatch_stats missing — rebuild vendor/v86 (build-wasm.sh)", HarnessErrorCode.INTERNAL);
        }
        // Through dbg, not directly: the JIT cache clear has one owner, and this verb is the
        // windowing layer on top of that switch rather than a second copy of it.
        dbg.dispatchStatsEnable(on);
        armEpoch++;
        armedAtMs = performance.now();
        return {
            armed: on, armEpoch,
            warning: "the JIT cache was cleared; blocks compiled before this call carry no counter increments. "
                + "Warm the scene up before dispatchMark(), or the report will refuse.",
        };
    });

    /** dispatchMark() — window baseline. */
    svc.register("dispatchMark", () => {
        mark = readDispatchSnapshot();
        return {
            marked: true, atMs: round(mark.atMs), armEpoch: mark.armEpoch,
            statsEnabled: mark.statsEnabled, profilerEnabled: mark.profilerEnabled,
            sinceArmMs: armedAtMs < 0 ? null : round(mark.atMs - armedAtMs),
        };
    });

    /** dispatchReport() — the class split over the window since dispatchMark(). */
    svc.register("dispatchReport", () => {
        if (!mark) throw new HarnessError("dispatchReport with no dispatchMark", HarnessErrorCode.BAD_ARGS);
        const out = summarizeDispatch(mark, readDispatchSnapshot());
        if (!out.ok) throw new HarnessError(out.refuse, out.code);
        return out.armed ? out.report : { armed: false, windowMs: out.windowMs, reason: out.reason };
    });
}
