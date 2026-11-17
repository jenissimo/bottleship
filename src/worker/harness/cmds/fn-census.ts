/**
 * fnCensusArm / fnCensusMark / fnCensus — the admission census for a function tier (#105 M1).
 *
 * v86 owns every fact that needs its decoder, TLB or code-ownership graph: which direct-CALL
 * targets compiled code reached, whether each target is admissible as a start-entry-only,
 * guest-call-free unit (and why not), its stack-window shape, slot-promotion and P4
 * eligibility, its code-page dependencies, the window probe at every recorded entry and the
 * SMC/revocation events that touch it. This file owns the window, the labels and the report.
 * Executed weighting comes from the trace2 counted channel on the candidates' code pages;
 * sampled addresses are never used as coverage.
 *
 * Refusals follow the other census verbs: missing exports are "unavailable", never a zero
 * census; a report across a re-arm, a kernel reset, a state restore or a worker reload is
 * refused; a window with retired instructions and no recorded calls is refused. The census
 * changes generated code (a call hook per direct CALL), so its window is not an FPS sample.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { startRetiredAccumulator, peekRetiredTotal, stopRetiredAccumulator, countedWindowActive, type RetiredAccumulator } from "./perf";
import { cpu, symbolize } from "../serialize";
import { dbg } from "../../core/debug/dbg-commands";

export const FN_CENSUS_SCHEMA = 2;
export const FN_CENSUS_CALL_WORDS = 4;
export const FN_CENSUS_ROW_WORDS = 40;

export const ROW = {
    entryVirt: 0, entryPhys: 1, entries: 2, unit: 3, windowStatic: 4, promotion: 5, p4: 6,
    instructions: 7, blocks: 8, bytes: 9, codePages: 10, pageCrossing: 11, frameLo: 12, frameHi: 13,
    windowAdmitted: 14, windowRefused: 15, windowRefusedSeen: 16, windowMaxPages: 17, smcEvents: 18,
    frameAccesses: 19, otherAccesses: 20, x87Ops: 21, firstRefuseEip: 22, firstRefuseOp: 23,
    rangeStart: 24, rangeCount: 25, flags: 26, outCalls: 27, analyses: 28, codePage0: 29,
    firstWindowEip: 32, firstWindowOp: 33, callStart: 34, callCount: 35, retSummary: 36,
} as const;

export const UNIT_REASONS = [
    "guestCall", "guestCallIndirect", "indirectJump", "stateInstruction", "helperReentry",
    "codePageBudget", "instructionCap", "blockCap", "byteCap", "codeNotMapped", "pageCrossSplit", "addr16",
] as const;
export const WINDOW_STATIC_REASONS = ["espUntracked", "espAlign", "espMerge", "espUnbalanced", "outCall", "extentPages", "calleeEspUnknown"] as const;
export const PROMOTION_REASONS = ["slotEscapes", "unknownAlias", "noWindow"] as const;
export const P4_REASONS = ["fldcw", "x87DepthMerge", "x87DepthUnknown", "strictFpu", "fpuEnv", "noX87"] as const;
export const PROBE_REASONS = [
    "notResident", "readOnly", "noUser", "mappedRange", "hasCode", "notIdentity", "wrap",
    "ssNotFlat", "generationExhausted", "extentPages", "noStaticWindow",
] as const;
export const STAT_NAMES = [
    "calls", "callsTableFull", "analyses", "reanalyses", "tlbRevocations", "revocationsOnWindowPages",
    "smcDirties", "smcOnCandidates", "rangeOverflow", "callsNotFlat32", "exceptions", "windowProbes", "windowAdmitted", "callOverflow",
] as const;

const P4_BLOCKING = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 5);
const PROMOTION_BLOCKING = (1 << 0) | (1 << 2);

type Exports = Record<string, ((...a: number[]) => number) | undefined>;

const REQUIRED = [
    "fn_census_version", "fn_census_set_enabled", "fn_census_enabled", "fn_census_generation", "fn_census_reset",
    "fn_census_row_count", "fn_census_row_words", "fn_census_rows_ptr", "fn_census_stat", "fn_census_stat_count",
    "fn_census_owner_of", "fn_census_get_cap", "fn_census_call_count", "fn_census_calls_ptr", "jit_codegen_fingerprint_lo", "jit_codegen_fingerprint_hi",
] as const;

export interface CountedSample { addr: number; exec: number; ins: number; owner: number }

export interface FnCensusSnapshot {
    atMs: number;
    armEpoch: number;
    kernelGeneration: number;
    exportsId: number;
    enabled: number;
    rows: Map<number, Uint32Array>;
    /** Call-site pool, FN_CENSUS_CALL_WORDS per site: site EIP, direct target (0 = indirect), flags, callee ret imm16. */
    calls: Uint32Array;
    stats: number[];
    retiredTotal: number;
    fingerprint: string;
    caps: number[];
    counted: null | {
        recording: boolean;
        watchedPages: number;
        armedPages: number;
        pagesNotArmed: number;
        slotOverflow: number | null;
        blocks: CountedSample[];
    };
}

export type FnCensusResult =
    | { ok: false; refuse: string; code: string }
    | { ok: true; report: Record<string, unknown> };

const round = (v: number, d = 2): number => +v.toFixed(d);
const pct = (n: number, d: number): number | null => (d > 0 ? round((n / d) * 100, 2) : null);
const names = (bits: number, table: readonly string[]): string[] => table.filter((_, i) => bits & (1 << i));
const hex = (v: number): string => "0x" + (v >>> 0).toString(16);

function tally(rows: Uint32Array[], field: number, table: readonly string[], weight: (r: Uint32Array) => number) {
    const out: Record<string, { functions: number; weight: number }> = {};
    for (const r of rows) {
        for (const n of names(r[field]!, table)) {
            const t = (out[n] ??= { functions: 0, weight: 0 });
            t.functions++;
            t.weight += weight(r);
        }
    }
    return out;
}

/** Pure readout of two snapshots; every refusal has a test. */
export function summarizeFnCensus(before: FnCensusSnapshot, after: FnCensusSnapshot, top = 20): FnCensusResult {
    const bad = (refuse: string, code: string = HarnessErrorCode.BAD_ARGS): FnCensusResult => ({ ok: false, refuse, code });
    if (after.atMs <= before.atMs) return bad("census window is empty: mark and report in different turns");
    if (after.exportsId !== before.exportsId) {
        return bad("the v86 instance changed inside the window (worker reload): the rows belong to another engine");
    }
    if (after.armEpoch !== before.armEpoch) return bad("fnCensusArm() ran inside the window: re-mark after arming");
    if (after.kernelGeneration !== before.kernelGeneration) {
        return bad("the kernel census generation moved inside the window (re-enable, fn_census_reset, CPU reset or state "
            + "restore): rows were cleared or describe a different machine state");
    }
    if (!before.enabled || !after.enabled) {
        return bad("the census is off, so nothing was recorded. Call fnCensusArm() BEFORE the workload: it clears the JIT "
            + "cache so compiled code carries the call hook, then warm the scene up and mark.");
    }
    if (after.fingerprint !== before.fingerprint) return bad("the codegen fingerprint changed inside the window");
    const retired = after.retiredTotal - before.retiredTotal;
    const stat = (i: number) => after.stats[i]! - before.stats[i]!;
    const calls = stat(0);
    if (calls <= 0) {
        return {
            ok: false, code: HarnessErrorCode.INTERNAL,
            refuse: `the census recorded 0 compiled direct calls while the guest retired ${retired} instructions. `
                + "Either nothing ran, or the code that ran was compiled before fnCensusArm() cleared the cache.",
        };
    }

    type Row = { r: Uint32Array; entries: number; admitted: number; refused: number; executed: number };
    const changedVersion = (r: Uint32Array) => {
        const b = before.rows.get(r[ROW.entryVirt]!);
        if (b && b[ROW.flags] !== 0) return b[ROW.analyses] !== r[ROW.analyses] || b[ROW.smcEvents] !== r[ROW.smcEvents];
        // First analysed inside the window: its counts are cumulative over every body it had
        // since then, so any reanalysis or code write after that first analysis mixes versions.
        return r[ROW.analyses]! - (b?.[ROW.analyses] ?? 0) > 1 || r[ROW.smcEvents]! - (b?.[ROW.smcEvents] ?? 0) > 0;
    };
    const window: Row[] = [];
    const versionChanged: Row[] = [];
    for (const [virt, r] of after.rows) {
        const b = before.rows.get(virt);
        const entries = r[ROW.entries]! - (b?.[ROW.entries] ?? 0);
        if (entries <= 0) continue;
        (changedVersion(r) ? versionChanged : window).push({
            r, entries, executed: 0,
            admitted: r[ROW.windowAdmitted]! - (b?.[ROW.windowAdmitted] ?? 0),
            refused: r[ROW.windowRefused]! - (b?.[ROW.windowRefused] ?? 0),
        });
    }

    const counted = after.counted;
    let countedTotal = 0, ownedAdmitted = 0, ownedRefused = 0, unattributed = 0, saturated = 0, ownedChanged = 0;
    const byEntry = new Map(window.map(w => [w.r[ROW.entryVirt]!, w]));
    const rowsByIndex = [...after.rows.values()];
    if (counted) {
        for (const b of counted.blocks) {
            if (b.exec === 0xffffffff) saturated++;
            const w = b.exec * b.ins;
            countedTotal += w;
            const owner = b.owner > 0 ? rowsByIndex[b.owner - 1] : undefined;
            const row = owner ? byEntry.get(owner[ROW.entryVirt]!) : undefined;
            if (!owner) { unattributed += w; continue; }
            if (changedVersion(owner)) { ownedChanged += w; continue; }
            if (row) row.executed += w;
            if (owner[ROW.unit] === 0) ownedAdmitted += w; else ownedRefused += w;
        }
    }

    const admittedUnit = window.filter(w => w.r[ROW.unit] === 0);
    const windowEligible = admittedUnit.filter(w => w.r[ROW.windowStatic] === 0);
    const promotionEligible = windowEligible.filter(w => (w.r[ROW.promotion]! & PROMOTION_BLOCKING) === 0);
    const p4Eligible = admittedUnit.filter(w => (w.r[ROW.p4]! & P4_BLOCKING) === 0);
    const entriesTotal = window.reduce((s, w) => s + w.entries, 0);
    const sumEntries = (rows: Row[]) => rows.reduce((s, w) => s + w.entries, 0);
    const sumExec = (rows: Row[]) => rows.reduce((s, w) => s + w.executed, 0);
    const byEntries = (w: Row) => w.entries;
    const rows = window.map(w => w.r);
    const weightOf = new Map(window.map(w => [w.r, w.entries]));
    const ew = (r: Uint32Array) => weightOf.get(r) ?? 0;

    const probed = window.filter(w => w.r[ROW.windowStatic] === 0);
    const probesAdmitted = probed.reduce((s, w) => s + w.admitted, 0);
    const probesRefused = probed.reduce((s, w) => s + w.refused, 0);
    const notProbed = window.filter(w => w.r[ROW.windowStatic] !== 0).reduce((s, w) => s + w.entries, 0);
    const probeReasons: Record<string, { functions: number; refusedEntries: number }> = {};
    for (const w of probed) {
        if (!w.refused) continue;
        for (const n of names(w.r[ROW.windowRefusedSeen]!, PROBE_REASONS)) {
            const t = (probeReasons[n] ??= { functions: 0, refusedEntries: 0 });
            t.functions++;
            t.refusedEntries += w.refused;
        }
    }

    const execProblems = counted ? executedProblems(counted, countedTotal, retired, saturated, before)
        : ["the counted channel was not armed at fnCensusMark(); executed coverage is unknown, not zero"];
    const ranked = [...window].sort((a, b) => (b.executed - a.executed) || (b.entries - a.entries)).slice(0, top);
    return {
        ok: true,
        report: {
            schema: FN_CENSUS_SCHEMA,
            build: { fingerprint: after.fingerprint, caps: { codePages: after.caps[0], instructions: after.caps[1], blocks: after.caps[2], bytes: after.caps[3], windowPages: after.caps[4] } },
            window: { ms: round(after.atMs - before.atMs, 0), retiredIns: retired },
            population: {
                note: "static: one row per direct-CALL target entered from compiled code in the window. Interpreted "
                    + "calls, indirect calls and calls inside AOT units compiled without the hook are not candidates.",
                candidates: window.length,
                unitAdmitted: admittedUnit.length,
                windowEligible: windowEligible.length,
                promotionEligible: promotionEligible.length,
                p4Eligible: p4Eligible.length,
                unitRefusals: tally(rows, ROW.unit, UNIT_REASONS, ew),
                windowRefusals: tally(rows.filter(r => r[ROW.unit] === 0), ROW.windowStatic, WINDOW_STATIC_REASONS, ew),
                promotionFlags: tally(rows.filter(r => r[ROW.unit] === 0), ROW.promotion, PROMOTION_REASONS, ew),
                p4Flags: tally(rows.filter(r => r[ROW.unit] === 0), ROW.p4, P4_REASONS, ew),
            },
            entryWeighted: {
                note: "weighted by recorded entries; an entry is not an instruction, see `executed` for coverage",
                entries: entriesTotal,
                unitAdmittedPct: pct(sumEntries(admittedUnit), entriesTotal),
                windowEligiblePct: pct(sumEntries(windowEligible), entriesTotal),
                p4EligiblePct: pct(sumEntries(p4Eligible), entriesTotal),
            },
            windowProbes: {
                note: "one probe per recorded entry of a function with a static window (unit admission aside): "
                    + "resident TLB entries only, writable, permitted, RAM, no code, physical == linear for every page. "
                    + "Entries of functions without a static window are notProbedEntries.",
                admitted: probesAdmitted, refused: probesRefused,
                notProbedEntries: notProbed,
                admittedPct: pct(probesAdmitted, probesAdmitted + probesRefused),
                refusedBy: probeReasons,
            },
            executed: counted && execProblems.length
                ? {
                    available: false,
                    note: "executed coverage is unavailable for this window; the raw counts are kept as evidence",
                    problems: execProblems,
                    raw: { retiredIns: retired, countedIns: countedTotal, admittedIns: ownedAdmitted, refusedIns: ownedRefused,
                        unattributedIns: unattributed, changedVersionIns: ownedChanged, saturatedBlocks: saturated,
                        recording: counted.recording, watchedPages: counted.watchedPages, armedPages: counted.armedPages },
                }
                : counted
                ? {
                    note: "trace2 counted channel on the candidates' code pages: exec x instructions per block, a block "
                        + "attributed by its entry address to the function whose decoded range holds it",
                    retiredIns: retired,
                    countedIns: countedTotal,
                    admittedIns: ownedAdmitted,
                    refusedIns: ownedRefused,
                    unattributedIns: unattributed,
                    changedVersionIns: ownedChanged,
                    unknownIns: retired - countedTotal,
                    admittedPctOfRetired: pct(ownedAdmitted, retired),
                    admittedPctOfCounted: pct(ownedAdmitted, countedTotal),
                    windowEligiblePctOfRetired: pct(sumExec(windowEligible), retired),
                    p4EligiblePctOfRetired: pct(sumExec(p4Eligible), retired),
                    recording: counted.recording,
                }
                : { available: false, note: "the counted channel was not armed at fnCensusMark(); executed coverage is unknown, not zero" },
            versionChanged: {
                note: "functions re-analysed after a code write inside the window (including rows first seen after MARK): which body ran is not known, so their "
                    + "entries and counted instructions are left out of every share above",
                functions: versionChanged.length,
                entries: versionChanged.reduce((s, w) => s + w.entries, 0),
            },
            callContinuation: callContinuation(window, after, retired, countedTotal,
                { executedProblems: execProblems, unstable: changedVersion }),
            dropped: {
                rowTableFull: stat(1),
                rangePoolOverflow: stat(8),
                callSitePoolOverflow: stat(13),
                callsNotFlat32: stat(9),
                countedSlotOverflow: counted?.slotOverflow ?? null,
                countedPagesNotArmed: counted?.pagesNotArmed ?? null,
                countedSaturatedBlocks: saturated,
            },
            events: {
                analyses: stat(2), reanalysesAfterSmc: stat(3), smcDirties: stat(6), smcOnCandidates: stat(7),
                tlbRevocations: stat(4), revocationsOnWindowPages: stat(5), exceptions: stat(10),
            },
            top: ranked.map(w => {
                const r = w.r;
                return {
                    entry: hex(r[ROW.entryVirt]!), symbol: symbolize(r[ROW.entryVirt]!),
                    entries: w.entries, executedIns: w.executed,
                    unit: names(r[ROW.unit]!, UNIT_REASONS),
                    firstRefusal: r[ROW.unit] ? { eip: hex(r[ROW.firstRefuseEip]!), op: hex(r[ROW.firstRefuseOp]!) } : null,
                    window: names(r[ROW.windowStatic]!, WINDOW_STATIC_REASONS),
                    firstWindowRefusal: r[ROW.windowStatic] ? { eip: hex(r[ROW.firstWindowEip]!), op: hex(r[ROW.firstWindowOp]!) } : null,
                    frame: [r[ROW.frameLo]! | 0, r[ROW.frameHi]! | 0],
                    probes: { admitted: w.admitted, refused: w.refused, refusedBy: names(r[ROW.windowRefusedSeen]!, PROBE_REASONS) },
                    promotion: names(r[ROW.promotion]!, PROMOTION_REASONS),
                    p4: names(r[ROW.p4]!, P4_REASONS),
                    instructions: r[ROW.instructions], blocks: r[ROW.blocks], bytes: r[ROW.bytes],
                    codePages: r[ROW.codePages], pageCrossing: r[ROW.pageCrossing],
                    frameAccesses: r[ROW.frameAccesses], otherAccesses: r[ROW.otherAccesses], x87Ops: r[ROW.x87Ops],
                    outCalls: r[ROW.outCalls], smcEvents: r[ROW.smcEvents],
                };
            }),
        },
    };
}

/** Reasons a counted window cannot give exact shares; empty when it can. */
export function executedProblems(counted: NonNullable<FnCensusSnapshot["counted"]>, countedTotal: number, retired: number,
    saturated: number, before: FnCensusSnapshot): string[] {
    const out: string[] = [];
    if (!counted.recording) out.push("the counted recorder was disarmed during the window");
    if (counted.watchedPages !== counted.armedPages) {
        out.push(`the recorder watches ${counted.watchedPages} pages but this window armed ${counted.armedPages}: another observer changed it`);
    }
    if (!before.counted) out.push("the counted channel was not armed at fnCensusMark()");
    if (countedTotal > retired) out.push(`counted ${countedTotal} instructions exceed the ${retired} retired: inconsistent denominators`);
    if (saturated > 0) out.push(`${saturated} block counter(s) saturated: their weight is a lower bound of unknown size`);
    return out;
}

// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
const W_OUT_CALL = 1 << 4, W_ALIGN = 1 << 1, W_CALLEE_ESP = 1 << 6;
const U_CALL = 1 << 0, U_ICALL = 1 << 1;
const CALL_INDIRECT = 1, CALL_RET_KNOWN = 2;
export const INLINE_MAX_INSTRUCTIONS = 64;

type Weighted = { r: Uint32Array; entries: number; executed: number };

/**
 * What each continuation option would add, from the same rows: a function qualifies when the
 * option removes every reason it is refused for. Shares are cumulative (they include functions
 * M1 already admits) and executed shares are of the window's counted owners, so they are lower
 * bounds wherever the counted channel missed pages.
 */
export function callContinuation(window: Weighted[], after: FnCensusSnapshot, retired: number, counted: number,
    opts: { executedProblems?: string[]; unstable?: (r: Uint32Array) => boolean } = {}) {
    const problems = opts.executedProblems ?? [];
    const unstable = opts.unstable ?? (() => false);
    const byEntry = new Map<number, Uint32Array>();
    for (const r of after.rows.values()) byEntry.set(r[ROW.entryVirt]!, r);
    const sites = (r: Uint32Array) => {
        const out: Array<{ target: number; flags: number; imm: number }> = [];
        for (let i = 0; i < r[ROW.callCount]!; i++) {
            const o = (r[ROW.callStart]! + i) * FN_CENSUS_CALL_WORDS;
            if (o + FN_CENSUS_CALL_WORDS > after.calls.length) break;
            out.push({ target: after.calls[o + 1]!, flags: after.calls[o + 2]!, imm: after.calls[o + 3]! });
        }
        return out;
    };
    const sitesComplete = (r: Uint32Array) => {
        const s = sites(r);
        return s.length === r[ROW.callCount] && s.filter(x => !(x.flags & CALL_INDIRECT)).length === r[ROW.outCalls];
    };
    const calleeUnstable = (t: number) => {
        const c = byEntry.get(t);
        return !!c && unstable(c);
    };
    const inlinable = (t: number) => {
        const c = byEntry.get(t);
        return !!c && !unstable(c) && c[ROW.unit] === 0 && c[ROW.windowStatic] === 0 && c[ROW.outCalls] === 0
            && c[ROW.instructions]! <= INLINE_MAX_INSTRUCTIONS;
    };
    const inlineShape = (r: Uint32Array) => (r[ROW.unit]! & ~U_CALL) === 0 && (r[ROW.windowStatic]! & ~W_OUT_CALL) === 0;
    const inlineUnknown = (r: Uint32Array) => inlineShape(r)
        && (!sitesComplete(r) || sites(r).some(s => !(s.flags & CALL_INDIRECT) && calleeUnstable(s.target)));
    const variants: Record<string, (r: Uint32Array) => boolean> = {
        m1: r => r[ROW.unit] === 0 && r[ROW.windowStatic] === 0,
        inlineLeaves: r => inlineShape(r) && !inlineUnknown(r)
            && sites(r).every(s => !(s.flags & CALL_INDIRECT) && inlinable(s.target)),
        callChain: r => (r[ROW.unit]! & ~U_CALL) === 0 && (r[ROW.windowStatic]! & ~W_OUT_CALL) === 0,
        callChainAlignedFrames: r => (r[ROW.unit]! & ~U_CALL) === 0 && (r[ROW.windowStatic]! & ~(W_OUT_CALL | W_ALIGN)) === 0,
        callChainIndirectGuarded: r => (r[ROW.unit]! & ~(U_CALL | U_ICALL)) === 0
            && (r[ROW.windowStatic]! & ~(W_OUT_CALL | W_CALLEE_ESP)) === 0,
    };
    const entriesTotal = window.reduce((s, w) => s + w.entries, 0);
    const executedAvailable = problems.length === 0;
    const out: Record<string, unknown> = {};
    for (const [name, ok] of Object.entries(variants)) {
        const q = window.filter(w => ok(w.r));
        const ex = q.reduce((s, w) => s + w.executed, 0);
        out[name] = {
            functions: q.length,
            entriesPct: pct(q.reduce((s, w) => s + w.entries, 0), entriesTotal),
            executedPctOfRetired: executedAvailable ? pct(ex, retired) : null,
            executedPctOfCounted: executedAvailable ? pct(ex, counted) : null,
        };
    }
    const unknown = window.filter(w => inlineUnknown(w.r));
    (out.inlineLeaves as Record<string, unknown>).unknown = {
        note: "callers left out because a callee body changed inside the window or the call-site record is incomplete",
        functions: unknown.length,
        entriesPct: pct(unknown.reduce((s, w) => s + w.entries, 0), entriesTotal),
    };
    let direct = 0, indirect = 0, calleeRow = 0, calleeAdmitted = 0, calleeRetKnown = 0, calleeInlinable = 0;
    let calleeVersionChanged = 0, incompleteCallers = 0;
    for (const w of window) {
        if (!sitesComplete(w.r)) incompleteCallers++;
        for (const s of sites(w.r)) {
            if (s.flags & CALL_INDIRECT) { indirect++; continue; }
            direct++;
            if (s.flags & CALL_RET_KNOWN) calleeRetKnown++;
            const c = byEntry.get(s.target);
            if (!c) continue;
            calleeRow++;
            if (unstable(c)) { calleeVersionChanged++; continue; }
            if (c[ROW.unit] === 0) calleeAdmitted++;
            if (inlinable(s.target)) calleeInlinable++;
        }
    }
    return {
        note: "cumulative shares: each option includes what M1 admits. inlineLeaves = callChain restricted to callers whose "
            + `every call is direct to an admitted, call-free, window-clean callee of at most ${INLINE_MAX_INSTRUCTIONS} `
            + "instructions, with a complete call-site record and callees whose body did not change inside the window. "
            + "callChainIndirectGuarded assumes a guarded target supplies the callee's ESP effect. Entry shares are not "
            + "CPU time or achieved tier coverage.",
        executed: executedAvailable ? { available: true } : { available: false, problems },
        variants: out,
        sites: { direct, indirect, calleeWithRow: calleeRow, calleeAdmitted, calleeRetKnown, calleeInlinable,
            calleeVersionChanged, incompleteCallers },
    };
}

// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
let armEpoch = 0;
// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
let armedAtMs = -1;
// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
let mark: FnCensusSnapshot | null = null;
// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
let retiredAcc: RetiredAccumulator | null = null;
// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
let countedArmed: { pages: number; notArmed: number } | null = null;
// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
const exportsIds = new WeakMap<object, number>();
// @transient(harness census window; a reset or restore moves the kernel generation, which refuses the report)
let nextExportsId = 1;

function liveExports(): { w: Exports; buffer: ArrayBufferLike; id: number } {
    const c = cpu();
    const w = c?.wm?.exports as Exports | undefined;
    const buffer = c?.wasm_memory?.buffer as ArrayBufferLike | undefined;
    if (!w || !buffer) throw new HarnessError("v86 is not running", HarnessErrorCode.INTERNAL);
    const missing = REQUIRED.filter(n => typeof w[n] !== "function");
    if (missing.length) {
        throw new HarnessError(`the loaded v86 has no function census (${missing.join(", ")}): unavailable, not zero. `
            + "Rebuild vendor/v86 (build-wasm.sh)", HarnessErrorCode.INTERNAL);
    }
    const version = w.fn_census_version!() >>> 0;
    if (version !== FN_CENSUS_SCHEMA || (w.fn_census_row_words!() >>> 0) !== FN_CENSUS_ROW_WORDS) {
        throw new HarnessError(`v86 function census schema ${version} does not match this harness (${FN_CENSUS_SCHEMA})`,
            HarnessErrorCode.INTERNAL);
    }
    let id = exportsIds.get(w as object);
    if (id === undefined) { id = nextExportsId++; exportsIds.set(w as object, id); }
    return { w, buffer, id };
}

function readSnapshot(withCounted: boolean): FnCensusSnapshot {
    const { w, buffer, id } = liveExports();
    const n = w.fn_census_row_count!() >>> 0;
    const ptr = w.fn_census_rows_ptr!() >>> 0;
    const all = n ? new Uint32Array(buffer, ptr, n * FN_CENSUS_ROW_WORDS) : new Uint32Array(0);
    const rows = new Map<number, Uint32Array>();
    for (let i = 0; i < n; i++) {
        const r = all.slice(i * FN_CENSUS_ROW_WORDS, (i + 1) * FN_CENSUS_ROW_WORDS);
        rows.set(r[ROW.entryVirt]!, r);
    }
    const stats = Array.from({ length: STAT_NAMES.length }, (_, i) => Number(w.fn_census_stat!(i)));
    const nc = w.fn_census_call_count!() >>> 0;
    const calls = nc ? new Uint32Array(buffer, w.fn_census_calls_ptr!() >>> 0, nc * FN_CENSUS_CALL_WORDS).slice() : new Uint32Array(0);
    let counted: FnCensusSnapshot["counted"] = null;
    if (withCounted && countedArmed && typeof w.trace2_block_snapshot === "function") {
        const blocks: CountedSample[] = [];
        const k = w.trace2_block_snapshot() >>> 0;
        for (let i = 0; i < k; i++) {
            const addr = w.trace2_block_addr!(i) >>> 0;
            blocks.push({ addr, exec: w.trace2_block_exec!(i) >>> 0, ins: w.trace2_block_instructions!(i) >>> 0, owner: w.fn_census_owner_of!(addr) >>> 0 });
        }
        counted = {
            recording: (w.trace2_enabled?.() ?? 0) >>> 0 === 1,
            watchedPages: w.trace2_watched_page_count ? w.trace2_watched_page_count() >>> 0 : -1,
            armedPages: countedArmed.pages,
            pagesNotArmed: countedArmed.notArmed,
            slotOverflow: w.trace2_slot_overflow ? w.trace2_slot_overflow() >>> 0 : null,
            blocks,
        };
    }
    return {
        atMs: performance.now(), armEpoch, kernelGeneration: w.fn_census_generation!() >>> 0, exportsId: id,
        enabled: w.fn_census_enabled!() >>> 0, rows, calls, stats,
        retiredTotal: retiredAcc ? peekRetiredTotal(retiredAcc) : 0,
        fingerprint: hex(w.jit_codegen_fingerprint_hi!()) + ":" + hex(w.jit_codegen_fingerprint_lo!()),
        caps: [0, 1, 2, 3, 4].map(i => w.fn_census_get_cap!(i) >>> 0),
        counted,
    };
}

/** Code pages of the hottest candidates so far, by recorded entries, for the counted channel. */
export function candidatePages(rows: Iterable<Uint32Array>, maxPages: number): { pages: number[]; wanted: number } {
    const sorted = [...rows].sort((a, b) => b[ROW.entries]! - a[ROW.entries]!);
    const seen = new Set<number>();
    for (const r of sorted) {
        for (let i = 0; i < 3; i++) {
            const p = r[ROW.codePage0 + i]!;
            if (p) seen.add(p);
        }
    }
    const all = [...seen];
    return { pages: all.slice(0, maxPages), wanted: all.length };
}

/** Stop what this verb armed (retired ticker, counted recorder) without touching a recorder guestBlocks owns. */
function releaseOwnedObserver(w: Exports): void {
    if (retiredAcc) { stopRetiredAccumulator(retiredAcc); retiredAcc = null; }
    if (countedArmed && !countedWindowActive()) w.trace2_unwatch_all?.();
    countedArmed = null;
}

export function registerFnCensusCommands(svc: HarnessService): void {
    /**
     * fnCensusArm({on?, caps?}) — switch the census on (kernel reset + JIT cache clear through
     * dbg), so compiled direct calls carry the hook. Warm the scene up before fnCensusMark().
     */
    svc.register("fnCensusArm", (args) => {
        const opts = (args[0] ?? {}) as { on?: boolean; caps?: { codePages?: number; instructions?: number; blocks?: number; bytes?: number; windowPages?: number } };
        const { w } = liveExports();
        if (opts.caps) {
            const cur = [0, 1, 2, 3, 4].map(i => w.fn_census_get_cap!(i) >>> 0);
            const c = opts.caps;
            w.fn_census_set_caps?.(c.codePages ?? cur[0]!, c.instructions ?? cur[1]!, c.blocks ?? cur[2]!, c.bytes ?? cur[3]!, c.windowPages ?? cur[4]!);
        }
        releaseOwnedObserver(w);
        dbg.fnCensusEnable(opts.on ?? true);
        armEpoch++;
        armedAtMs = performance.now();
        mark = null;
        return {
            armed: opts.on ?? true, armEpoch, schema: FN_CENSUS_SCHEMA,
            caps: [0, 1, 2, 3, 4].map(i => w.fn_census_get_cap!(i) >>> 0),
            warning: "the JIT cache was cleared and the census zeroed. Warm the scene up before fnCensusMark(). The call "
                + "hook changes generated code: read shares from this window, never FPS.",
        };
    });

    /**
     * fnCensusMark({maxPages?=64, counted?=true}) — window baseline. Arms the trace2 counted
     * channel on the code pages of the candidates recorded so far (hottest first).
     */
    svc.register("fnCensusMark", (args) => {
        const opts = (args[0] ?? {}) as { maxPages?: number; counted?: boolean };
        const { w } = liveExports();
        releaseOwnedObserver(w);
        let counted: Record<string, unknown> = { armed: false };
        if (opts.counted ?? true) {
            if (countedWindowActive()) {
                counted = { armed: false, note: "guestBlocks owns an armed counted window; executed coverage will be unavailable" };
            }
            else if (typeof w.trace2_reset !== "function" || typeof w.trace2_watch_page !== "function") {
                counted = { armed: false, note: "trace2 exports missing: executed coverage will be reported unavailable" };
            }
            else {
                const pre = readSnapshot(false);
                const { pages, wanted } = candidatePages(pre.rows.values(), Math.min(64, opts.maxPages ?? 64));
                w.trace2_reset();
                let armed = 0;
                for (const p of pages) if (w.trace2_watch_page(p << 12) >>> 0) armed++;
                countedArmed = { pages: armed, notArmed: wanted - armed };
                counted = { armed: armed > 0, pages: armed, pagesNotArmed: wanted - armed };
            }
        }
        retiredAcc = startRetiredAccumulator();
        mark = readSnapshot(true);
        return {
            marked: true, armEpoch, kernelGeneration: mark.kernelGeneration, rows: mark.rows.size,
            sinceArmMs: armedAtMs < 0 ? null : round(mark.atMs - armedAtMs, 0), counted,
            note: "arming the counted channel recompiles those pages; let the scene run again before fnCensus()",
        };
    });

    /** fnCensus({top?=20}) — the admission census over the window since fnCensusMark(). */
    svc.register("fnCensus", (args) => {
        if (!mark) throw new HarnessError("fnCensus with no fnCensusMark", HarnessErrorCode.BAD_ARGS);
        const opts = (args[0] ?? {}) as { top?: number };
        const out = summarizeFnCensus(mark, readSnapshot(true), opts.top ?? 20);
        if (!out.ok) throw new HarnessError(out.refuse, out.code);
        return out.report;
    });
}
