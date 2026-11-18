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
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { cpu } from "../serialize";

export const FN_UNIT_SCHEMA = 1;

export const FN_UNIT_STAT_NAMES = [
    "entries", "matched", "exited", "compiles", "published", "writtenDuringCompile", "compileFailed", "invalidated",
    "refusedNotM1", "refusedReturnForm", "refusedShape", "refusedState", "refusedMapping", "staleCensusRow",
    "deferredBusy", "skippedStack", "skippedGeneration", "skippedMapping", "skippedState", "unitInstructions",
] as const;

type Exports = Record<string, ((...a: number[]) => number) | undefined>;

const REQUIRED = [
    "fn_unit_version", "fn_unit_set_enabled", "fn_unit_enabled", "fn_unit_reset", "fn_unit_stat", "fn_unit_stat_count",
    "fn_unit_count", "fn_unit_set_threshold", "fn_unit_get_threshold", "fn_census_enabled",
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
    if (version !== FN_UNIT_SCHEMA || (w.fn_unit_stat_count!() >>> 0) !== FN_UNIT_STAT_NAMES.length) {
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
    units: number;
    stats: Record<(typeof FN_UNIT_STAT_NAMES)[number], number>;
    /** MATCHED / entries; null without entries. */
    matchedShare: number | null;
    problems: string[];
}

export function summarizeFnUnit(raw: {
    exportsId: number; enabled: number; censusEnabled: number; threshold: number; units: number; stats: number[];
}): FnUnitStatus {
    const stats = Object.fromEntries(FN_UNIT_STAT_NAMES.map((n, i) => [n, raw.stats[i] ?? 0])) as FnUnitStatus["stats"];
    const problems: string[] = [];
    if (stats.matched + stats.exited !== stats.entries) problems.push("matched + exited != entries");
    if (stats.published + stats.writtenDuringCompile + stats.compileFailed > stats.compiles) {
        problems.push("more compiles finished than started");
    }
    if (raw.enabled && !raw.censusEnabled) problems.push("units are on but the census is off: no new unit can be admitted");
    return {
        schema: FN_UNIT_SCHEMA, exportsId: raw.exportsId, enabled: raw.enabled !== 0, censusEnabled: raw.censusEnabled !== 0,
        threshold: raw.threshold, units: raw.units, stats,
        matchedShare: stats.entries ? stats.matched / stats.entries : null, problems,
    };
}

function readStatus(): FnUnitStatus {
    const { w, id } = liveExports();
    return summarizeFnUnit({
        exportsId: id, enabled: w.fn_unit_enabled!() >>> 0, censusEnabled: w.fn_census_enabled!() >>> 0,
        threshold: w.fn_unit_get_threshold!() >>> 0, units: w.fn_unit_count!() >>> 0,
        stats: FN_UNIT_STAT_NAMES.map((_, i) => w.fn_unit_stat!(i)),
    });
}

export function registerFnUnitCommands(svc: HarnessService): void {
    /** fnUnitEnable({on?=true, threshold?}) — needs an armed census (fnCensusArm). Off frees every unit. */
    svc.register("fnUnitEnable", (args) => {
        const opts = (args[0] ?? {}) as { on?: boolean; threshold?: number };
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
        w.fn_unit_set_enabled!(on ? 1 : 0);
        return { ...readStatus(), note: "a correctness control arm with canonical state at every boundary, not an FPS mode" };
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
