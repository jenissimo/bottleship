/**
 * fnUnitEnable / fnUnitReset / fnUnitStatus — the function-unit baseline oracle (#105).
 *
 * v86 owns unit admission, compilation, entry, exits, the versioned unit table and the
 * lifetime of its code pages and table slots (`fn_unit.rs`). Admission reads census rows, so
 * units need an armed census. Writes from JS reach units through the existing guest-code path
 * (`writeGuestCode` -> `jit_dirty_cache`); nothing here dispatches or invalidates.
 *
 * Units keep canonical CPU state at every boundary: this is a correctness control arm, not a
 * performance mode. Missing exports are "unavailable", never zero.
 *
 * Chained calls (schema 2, default off): `chain` 1 is the mechanism control (state stored and
 * reloaded at every chained call), 2 keeps GPRs and the lazy-flag tuple private across direct
 * calls between units. `andEsp` admits `and esp, -N` frames, separately. `counting` makes the
 * generated code count chained calls, fallbacks by reason and RET outcomes (it costs a memory
 * increment per event; off for timing runs). Each switch frees every unit.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { cpu } from "../serialize";

export const FN_UNIT_SCHEMA = 2;

export const FN_UNIT_STAT_NAMES = [
    "entries", "matched", "exited", "compiles", "published", "writtenDuringCompile", "compileFailed", "invalidated",
    "refusedNotM1", "refusedReturnForm", "refusedShape", "refusedState", "refusedMapping", "staleCensusRow",
    "deferredBusy", "skippedStack", "skippedGeneration", "skippedMapping", "skippedState", "unitInstructions",
    "chainSites", "chainUnchainedSites", "chainDependantsDropped", "chainStaleAtPublish", "maxRetiredPerEntry",
] as const;

export const FN_UNIT_CHAIN_COUNTER_NAMES = [
    "calls", "fallbackDepth", "fallbackBudget", "fallbackToken", "fallbackMapping", "calleeExited", "callerTokenExit",
    "retMatched", "retMismatch",
] as const;

export const FN_UNIT_CHAIN_MODES = ["off", "canonical", "private"] as const;

type Exports = Record<string, ((...a: number[]) => number) | undefined>;

const REQUIRED = [
    "fn_unit_version", "fn_unit_set_enabled", "fn_unit_enabled", "fn_unit_reset", "fn_unit_stat", "fn_unit_stat_count",
    "fn_unit_count", "fn_unit_set_threshold", "fn_unit_get_threshold", "fn_census_enabled",
    "fn_unit_set_chain", "fn_unit_get_chain", "fn_unit_set_and_esp", "fn_unit_get_and_esp", "fn_unit_set_chain_counting",
    "fn_unit_chain_counter", "fn_unit_chain_counter_count", "fn_unit_chain_depth",
] as const;

// @transient(identifies the live v86 instance for the harness report; it holds no guest state)
const exportsIds = new WeakMap<object, number>();
// @transient(identifies the live v86 instance for the harness report; it holds no guest state)
let nextExportsId = 1;

function liveExports(): { w: Exports; id: number } {
    const w = cpu()?.wm?.exports as Exports | undefined;
    if (!w) throw new HarnessError("v86 is not running", HarnessErrorCode.INTERNAL);
    const missing = REQUIRED.filter(n => typeof w[n] !== "function");
    if (missing.length) {
        throw new HarnessError(`the loaded v86 has no function units (${missing.join(", ")}): unavailable, not zero. `
            + "Rebuild vendor/v86 (build-wasm.sh)", HarnessErrorCode.INTERNAL);
    }
    const version = w.fn_unit_version!() >>> 0;
    if (version !== FN_UNIT_SCHEMA || (w.fn_unit_stat_count!() >>> 0) !== FN_UNIT_STAT_NAMES.length
        || (w.fn_unit_chain_counter_count!() >>> 0) !== FN_UNIT_CHAIN_COUNTER_NAMES.length) {
        throw new HarnessError(`v86 function-unit schema ${version} does not match this harness (${FN_UNIT_SCHEMA})`,
            HarnessErrorCode.INTERNAL);
    }
    let id = exportsIds.get(w as object);
    if (id === undefined) { id = nextExportsId++; exportsIds.set(w as object, id); }
    return { w, id };
}

export interface FnUnitStatus {
    schema: number;
    exportsId: number;
    enabled: boolean;
    censusEnabled: boolean;
    threshold: number;
    chain: (typeof FN_UNIT_CHAIN_MODES)[number];
    andEsp: boolean;
    units: number;
    stats: Record<(typeof FN_UNIT_STAT_NAMES)[number], number>;
    /** Counted only while `counting` is on; zero otherwise. */
    chainCounters: Record<(typeof FN_UNIT_CHAIN_COUNTER_NAMES)[number], number>;
    /** Native chain depth; nonzero outside a unit means an unwinding bug. */
    chainDepth: number;
    /** MATCHED / entries; null without entries. */
    matchedShare: number | null;
    problems: string[];
}

export function summarizeFnUnit(raw: {
    exportsId: number; enabled: number; censusEnabled: number; threshold: number; units: number; stats: number[];
    chain?: number; andEsp?: number; counters?: number[]; depth?: number;
}): FnUnitStatus {
    const stats = Object.fromEntries(FN_UNIT_STAT_NAMES.map((n, i) => [n, raw.stats[i] ?? 0])) as FnUnitStatus["stats"];
    const chainCounters = Object.fromEntries(FN_UNIT_CHAIN_COUNTER_NAMES.map((n, i) => [n, raw.counters?.[i] ?? 0])) as
        FnUnitStatus["chainCounters"];
    const problems: string[] = [];
    const chain = FN_UNIT_CHAIN_MODES[raw.chain ?? 0];
    if (chain === undefined) problems.push(`unknown chain mode ${raw.chain}`);
    if ((raw.depth ?? 0) !== 0) problems.push(`chain depth ${raw.depth} outside a unit`);
    if (stats.matched + stats.exited !== stats.entries) problems.push("matched + exited != entries");
    if (stats.published + stats.writtenDuringCompile + stats.compileFailed > stats.compiles) {
        problems.push("more compiles finished than started");
    }
    if (raw.enabled && !raw.censusEnabled) problems.push("units are on but the census is off: no new unit can be admitted");
    return {
        schema: FN_UNIT_SCHEMA, exportsId: raw.exportsId, enabled: raw.enabled !== 0, censusEnabled: raw.censusEnabled !== 0,
        threshold: raw.threshold, chain: chain ?? "off", andEsp: (raw.andEsp ?? 0) !== 0, units: raw.units, stats,
        chainCounters, chainDepth: raw.depth ?? 0,
        matchedShare: stats.entries ? stats.matched / stats.entries : null, problems,
    };
}

function readStatus(): FnUnitStatus {
    const { w, id } = liveExports();
    return summarizeFnUnit({
        exportsId: id, enabled: w.fn_unit_enabled!() >>> 0, censusEnabled: w.fn_census_enabled!() >>> 0,
        threshold: w.fn_unit_get_threshold!() >>> 0, units: w.fn_unit_count!() >>> 0,
        stats: FN_UNIT_STAT_NAMES.map((_, i) => w.fn_unit_stat!(i)),
        chain: w.fn_unit_get_chain!() >>> 0, andEsp: w.fn_unit_get_and_esp!() >>> 0,
        counters: FN_UNIT_CHAIN_COUNTER_NAMES.map((_, i) => w.fn_unit_chain_counter!(i) >>> 0),
        depth: w.fn_unit_chain_depth!() >>> 0,
    });
}

export function registerFnUnitCommands(svc: HarnessService): void {
    /** fnUnitEnable({on?=true, threshold?, chain?, andEsp?, counting?}) — needs an armed census (fnCensusArm).
     *  Off frees every unit. `chain` is "off" | "canonical" | "private"; each chain/andEsp change frees every unit. */
    svc.register("fnUnitEnable", (args) => {
        const opts = (args[0] ?? {}) as {
            on?: boolean; threshold?: number; chain?: string; andEsp?: boolean; counting?: boolean;
        };
        const { w } = liveExports();
        const on = opts.on ?? true;
        if (on && !(w.fn_census_enabled!() >>> 0)) {
            throw new HarnessError("function units are admitted from census rows: arm fnCensusArm() first",
                HarnessErrorCode.BAD_ARGS);
        }
        if (opts.threshold !== undefined) {
            if (!Number.isInteger(opts.threshold) || opts.threshold < 1) {
                throw new HarnessError("threshold must be a positive integer", HarnessErrorCode.BAD_ARGS);
            }
            w.fn_unit_set_threshold!(opts.threshold);
        }
        if (opts.chain !== undefined) {
            const mode = FN_UNIT_CHAIN_MODES.indexOf(opts.chain as (typeof FN_UNIT_CHAIN_MODES)[number]);
            if (mode < 0) {
                throw new HarnessError(`chain must be one of ${FN_UNIT_CHAIN_MODES.join(", ")}`, HarnessErrorCode.BAD_ARGS);
            }
            if (mode !== (w.fn_unit_get_chain!() >>> 0)) w.fn_unit_set_chain!(mode);
        }
        if (opts.andEsp !== undefined && (opts.andEsp ? 1 : 0) !== (w.fn_unit_get_and_esp!() >>> 0)) {
            w.fn_unit_set_and_esp!(opts.andEsp ? 1 : 0);
        }
        if (opts.counting !== undefined) w.fn_unit_set_chain_counting!(opts.counting ? 1 : 0);
        w.fn_unit_set_enabled!(on ? 1 : 0);
        const status = readStatus();
        return {
            ...status,
            note: status.chain === "off"
                ? "a correctness control arm with canonical state at every boundary, not an FPS mode"
                : "chained calls between units; a measurement arm, default off",
        };
    });

    /** fnUnitReset() — free every unit and zero the counters; the switch stays as it is. */
    svc.register("fnUnitReset", () => {
        const { w } = liveExports();
        w.fn_unit_reset!();
        return readStatus();
    });

    /** fnUnitStatus() — switch, unit count and counters. */
    svc.register("fnUnitStatus", () => readStatus());
}
