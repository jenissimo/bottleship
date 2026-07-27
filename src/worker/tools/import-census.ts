/**
 * Static import census — cross-reference a bundle's PE imports against what we
 * implement, and rank what is missing into a work order.
 *
 * Pure functions over already-parsed data (no fs, no zip) so the classification and
 * the ranking are unit-testable from hand-built fixtures; `tools/api-census.ts` does
 * the IO.
 *
 * The statuses mirror what the PE loader will ACTUALLY do with each import, because
 * that is what makes the report actionable:
 *   implemented   → a real handler runs.
 *   silent-stub   → a handler runs, returns success, and does nothing. Worse than
 *                   missing: the guest is told it worked and reads back garbage.
 *   unimplemented → we know the ABI (descriptor or curated reference) but there is no
 *                   handler; the dispatcher answers ERROR_NOT_SUPPORTED. Stack-safe.
 *   guest-dll     → satisfied by a real PE shipped inside the bundle; guest code runs.
 *   no-hle        → the DLL has no HLE module at all and is not shipped. Every call
 *                   traps; usually a whole missing subsystem.
 *   delay-gap     → a DELAY-LOAD import with no implementation. Cannot affect load: the
 *                   loader never walks the delay directory (processImports reads data
 *                   directory 1 only), so the linker's thunk resolves it at FIRST USE via
 *                   LoadLibrary+GetProcAddress. A call-time risk on a path the title may
 *                   never take — and one the dynamic census observes directly, since that
 *                   lookup lands in our GetProcAddress.
 *   abi-gap       → a non-delay stdcall import whose stack cleanup no source supplies.
 *                   generateStubDll throws on one of these IF the importing image is
 *                   actually mapped and reached through the static import chain.
 *
 * WHAT THIS DOES NOT MEASURE — calibrated, not assumed. `abi-gap` began life as
 * "load-blocker", a predicted boot failure. Checked against 37 bundles known to run, it
 * fires on 12 of them (blackwell-legacy 182, thief-gold 76, morrowind 24, tiberian-sun 6,
 * homm3 3) — all of which boot — while quake2, which has a startup failure on record,
 * shows zero. It is anti-correlated with booting and must never be presented as a verdict:
 * a DLL reached via LoadLibrary has its throw caught by kernel32, a shipped DLL may never
 * be mapped at all, and the registry's resolution chain is wider than any static mirror.
 *
 * More broadly, NO count here separates "boots" from "does not boot": max-payne runs with
 * 57 unimplemented imports, and quake2's real startup failure was a page-table collision —
 * not an import-table property at all. So this file ranks REMAINING API WORK, weighted by
 * how heavily each export is used, and says nothing about whether a title starts.
 */

import type { ApiCoverageIndex } from './api-coverage';

export type ImportStatus =
    | 'implemented'
    | 'silent-stub'
    | 'unimplemented'
    | 'guest-dll'
    | 'no-hle'
    | 'delay-gap'
    | 'abi-gap';

/** One import-table entry of one PE inside the bundle. */
export interface ImportRef {
    /** DLL name exactly as the import descriptor spells it. */
    dll: string;
    /** Import-by-name; absent for import-by-ordinal. */
    name?: string;
    /** Import-by-ordinal value; absent for import-by-name. */
    ordinal?: number;
    /** Indirect call/jump sites through this IAT slot in the importing image. */
    callSites: number;
    /** Bundle-relative path of the PE that imports it. */
    fromPe: string;
    /** True when `fromPe` is the manifest entrypoint. */
    entrypoint: boolean;
    delayLoad: boolean;
}

/** Exports of a PE the bundle ships, keyed by lowercased DLL base name. */
export interface ShippedDll {
    /** Lowercased export names. */
    names: Set<string>;
    ordinals: Set<number>;
}

export interface CensusEntry {
    /** Canonical HLE module name (alias-resolved), e.g. "ddraw". */
    dll: string;
    /** DLL name as imported, when it differs from the canonical one (d3dx9_43 → d3dx9). */
    importedAs?: string;
    /** Export name, or `ord_N` for an import-by-ordinal. */
    name: string;
    status: ImportStatus;
    /** Ranking weight — see {@link scoreOf}. */
    score: number;
    /** Total indirect call sites across every importing PE. */
    callSites: number;
    /** Bundle-relative paths of the PEs that import it. */
    importers: string[];
    /** True when at least one importer is the entrypoint EXE. */
    fromEntrypoint: boolean;
    /** True when every importer takes it as a delay-load. */
    delayLoadOnly: boolean;
    /** Source location of the handler, for `silent-stub` / `implemented`. */
    impl?: { file: string; line: number; arity: number };
}

export interface BundleCensus {
    bundle: string;
    title?: string;
    entrypoint?: string;
    /** PEs whose imports were parsed. */
    analyzed: Array<{
        path: string; entrypoint: boolean; imports: number;
        packer?: string; hiddenImports?: boolean;
        /** Shipped but not reachable from the entrypoint — parsed, not ranked. */
        unreachable?: boolean;
        /** Shipped but shadowed by an HLE module, so it is never mapped. */
        shadowed?: boolean;
    }>;
    /** PEs we could not statically read (packed / truncated import table). */
    opaque: Array<{ path: string; reason: string }>;
    totals: Record<ImportStatus, number> & { distinct: number };
    /**
     * Imports with no derivable stdcall ABI. ADVISORY, not a verdict: titles that boot
     * fine carry hundreds of these (see the calibration note at the top of this file).
     */
    abiGaps: CensusEntry[];
    /** Handlers that return success without doing the work, ranked by use. */
    silentStubs: CensusEntry[];
    /** Everything unimplemented/absent, ranked — the work order. */
    workOrder: CensusEntry[];
    /** Per-DLL rollup of the work order, heaviest DLL first. */
    byDll: Array<{ dll: string; status: 'no-hle' | 'partial'; missing: number; score: number; top: string[] }>;
    /**
     * Share of distinct imports backed by a real handler or a shipped DLL, 0-100. This is
     * COVERAGE, not readiness-to-boot — the two are not the same thing and the ground-truth
     * check says so. `null` when the entrypoint hides its imports (packed/self-resolving),
     * because then the denominator is fiction.
     */
    covered: number | null;
    /**
     * Total weight of the remaining work: every actionable import scored by call sites ×
     * entrypoint weight. The honest cross-title ranking key — "how much API surface is
     * still missing", not "how far from working".
     */
    workScore: number;
    /** The entrypoint is packed or resolves its imports at runtime. */
    entrypointOpaque: boolean;
    /** Every EXE was analyzed because the entrypoint was opaque. */
    expandedFromPackedEntrypoint?: boolean;
}

/** Severity order for the work order — worse classes float to the top. */
/**
 * Work-order severity. `silent-stub` leads because it is the only class that actively
 * misleads the guest; `abi-gap` sits mid-table rather than on top, since the ground-truth
 * check above showed it does not predict failure.
 */
const SEVERITY: Record<ImportStatus, number> = {
    'silent-stub': 0,
    'no-hle': 1,
    'unimplemented': 2,
    'abi-gap': 3,
    'delay-gap': 4,
    'guest-dll': 5,
    'implemented': 6,
};

const ACTIONABLE: ImportStatus[] =
    ['silent-stub', 'no-hle', 'unimplemented', 'abi-gap', 'delay-gap'];

/**
 * Weight one importing PE's use of an export. Call sites are the real signal — an
 * import table names an export once no matter how often the code calls it — and the
 * entrypoint EXE outranks a bundled helper DLL.
 */
function scoreOf(ref: ImportRef): number {
    const uses = Math.max(1, ref.callSites);
    return uses * (ref.entrypoint ? 3 : 1);
}

function classify(
    index: ApiCoverageIndex,
    ref: ImportRef,
    exportName: string,
    shipped: Map<string, ShippedDll>,
): { status: ImportStatus; impl?: CensusEntry['impl'] } {
    const canonical = index.canonicalModule(ref.dll);

    const cov = ref.ordinal !== undefined
        ? index.lookupOrdinal(ref.dll, ref.ordinal)
        : index.lookup(ref.dll, exportName);
    if (cov) {
        const impl = cov.file && cov.line !== undefined
            ? { file: cov.file, line: cov.line, arity: cov.arity ?? 0 }
            : undefined;
        if (cov.status === 'implemented') return { status: 'implemented', impl };
        if (cov.status === 'silent-stub') return { status: 'silent-stub', impl };
        return { status: 'unimplemented' };
    }

    const ship = shipped.get(canonical);
    const shipHasIt = !!ship && (ref.ordinal !== undefined
        ? ship.ordinals.has(ref.ordinal)
        : ship.names.has(exportName.toLowerCase()));

    // Known ABI ⇒ ThunkGenerator can emit a correct RET N, so a stub exists even with no
    // handler and the load survives.
    const abiKnown = index.resolveAbi(ref.dll, exportName) !== null;

    // A delay-load import is never part of stub generation, so it can never block the
    // load however unknown its ABI is — it becomes a first-use GetProcAddress instead.
    const unresolved = (): { status: ImportStatus } =>
        ref.delayLoad ? { status: 'delay-gap' }
            : abiKnown ? { status: index.isThunked(ref.dll) ? 'unimplemented' : 'no-hle' }
                : { status: 'abi-gap' };

    if (index.isThunked(ref.dll)) {
        // A thunked module that does not name this export cannot generate a stub for it.
        // The loader's own escape hatch is per-DLL, not per-export: when the bundle ships
        // the real file it abandons the HLE module for the whole DLL and loads it natively
        // (how a side-by-side msvcr90 gets used). Anything else must be synthesized.
        if (ship) return { status: 'guest-dll' };
        return unresolved();
    }

    if (shipHasIt || ship) return { status: 'guest-dll' };
    return unresolved();
}

/**
 * Fold every import reference into a ranked census. `refs` may name the same export
 * many times (once per importing PE); they are merged and their weights summed.
 */
export function buildCensus(
    bundle: string,
    refs: ImportRef[],
    index: ApiCoverageIndex,
    shipped: Map<string, ShippedDll>,
    meta: { title?: string; entrypoint?: string;
            analyzed?: BundleCensus['analyzed']; opaque?: BundleCensus['opaque'] } = {},
): BundleCensus {
    const merged = new Map<string, CensusEntry>();

    for (const ref of refs) {
        const exportName = ref.name ?? `ord_${ref.ordinal ?? 0}`;
        const canonical = index.canonicalModule(ref.dll);
        const key = `${canonical}!${exportName.toLowerCase()}`;
        const { status, impl } = classify(index, ref, exportName, shipped);

        const existing = merged.get(key);
        if (existing) {
            existing.score += scoreOf(ref);
            existing.callSites += ref.callSites;
            if (!existing.importers.includes(ref.fromPe)) existing.importers.push(ref.fromPe);
            existing.fromEntrypoint ||= ref.entrypoint;
            existing.delayLoadOnly &&= ref.delayLoad;
            continue;
        }
        merged.set(key, {
            dll: canonical,
            importedAs: canonical === ref.dll.toLowerCase().replace(/\.dll$/, '') ? undefined : ref.dll,
            name: exportName,
            status,
            score: scoreOf(ref),
            callSites: ref.callSites,
            importers: [ref.fromPe],
            fromEntrypoint: ref.entrypoint,
            delayLoadOnly: ref.delayLoad,
            impl,
        });
    }

    const all = [...merged.values()];
    const totals = {
        implemented: 0, 'silent-stub': 0, unimplemented: 0, 'delay-gap': 0,
        'guest-dll': 0, 'no-hle': 0, 'abi-gap': 0, distinct: all.length,
    } as BundleCensus['totals'];
    for (const e of all) totals[e.status]++;

    const rank = (a: CensusEntry, b: CensusEntry): number =>
        SEVERITY[a.status] - SEVERITY[b.status] || b.score - a.score || a.name.localeCompare(b.name);

    const workOrder = all.filter(e => ACTIONABLE.includes(e.status)).sort(rank);

    // Per-DLL rollup: a DLL with no HLE module at all is a different kind of work item
    // than a module that is merely missing a few exports.
    const dllAgg = new Map<string, { dll: string; status: 'no-hle' | 'partial'; missing: number; score: number; top: CensusEntry[] }>();
    for (const e of workOrder) {
        const agg = dllAgg.get(e.dll) ?? { dll: e.dll, status: 'partial' as const, missing: 0, score: 0, top: [] };
        agg.missing++;
        agg.score += e.score;
        if (e.status === 'no-hle') agg.status = 'no-hle';
        agg.top.push(e);
        dllAgg.set(e.dll, agg);
    }
    const byDll = [...dllAgg.values()]
        .sort((a, b) => b.score - a.score)
        .map(a => ({
            dll: a.dll,
            status: a.status,
            missing: a.missing,
            score: a.score,
            top: a.top.sort(rank).slice(0, 6).map(e => e.name),
        }));

    const entrypointOpaque = (meta.analyzed ?? []).some(
        a => a.entrypoint && (a.packer !== undefined || a.hiddenImports === true));
    const backed = totals.implemented + totals['guest-dll'];
    const covered = entrypointOpaque ? null
        : all.length === 0 ? 100 : Math.round((backed / all.length) * 100);
    const workScore = workOrder.reduce((sum, e) => sum + e.score, 0);

    return {
        bundle,
        title: meta.title,
        entrypoint: meta.entrypoint,
        analyzed: meta.analyzed ?? [],
        opaque: meta.opaque ?? [],
        totals,
        abiGaps: all.filter(e => e.status === 'abi-gap').sort(rank),
        silentStubs: all.filter(e => e.status === 'silent-stub').sort((a, b) => b.score - a.score),
        workOrder,
        byDll,
        covered,
        workScore,
        entrypointOpaque,
    };
}

/**
 * One-line-per-bundle queue view, heaviest remaining API work first. Ranked on
 * `workScore` — call-site-weighted missing surface — because that is the measure the
 * ground-truth check supports. An unscorable (packed-entrypoint) bundle sorts to the very
 * top: "we cannot tell" needs a human before any number does.
 */
export function rankQueue(reports: BundleCensus[]): BundleCensus[] {
    return [...reports].sort((a, b) =>
        (a.covered === null ? 0 : 1) - (b.covered === null ? 0 : 1)
        || b.workScore - a.workScore
        || (a.covered ?? 0) - (b.covered ?? 0));
}
