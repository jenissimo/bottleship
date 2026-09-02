/**
 * `dispatchReport`'s arithmetic and — the point of the file — its refusals
 * (roadmap 07).
 *
 * The counters this reads are zero in two completely different situations: the dispatch
 * tax really is small, and nobody was counting. A readout that cannot tell those apart is
 * worse than none, so every path that would produce a confident zero is asserted to
 * refuse instead: stats off, counters flat while the guest ran, a re-arm inside the
 * window, an empty window.
 */

import { describe, test, expect } from "bun:test";
import {
    summarizeDispatch, DISPATCH_STAT_NAMES,
    type DispatchCounters, type DispatchSnapshot, type EntryEipCensus,
} from "../../src/worker/harness/cmds/dispatch";

const NO_EIP: EntryEipCensus = {
    available: false, samples: 0, evictions: 0, evictionPct: null, attributed: 0, top: [],
    reason: "test fixture",
};

function counters(over: Partial<DispatchCounters> = {}): DispatchCounters {
    const c = {} as DispatchCounters;
    for (const k of DISPATCH_STAT_NAMES) c[k] = 0;
    return Object.assign(c, over);
}

function snap(over: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
    return {
        atMs: 0, counters: counters(), retiredCounter: 0,
        statsEnabled: 1, profilerEnabled: false, armEpoch: 1, entryEip: NO_EIP,
        ...over,
    };
}

function armed(s: ReturnType<typeof summarizeDispatch>): Record<string, any> {
    expect(s.ok).toBe(true);
    expect((s as any).armed).toBe(true);
    return (s as any).report;
}

describe("dispatch class split", () => {
    test("shares are of every module exit, chained ones included", () => {
        const before = snap();
        const after = snap({
            atMs: 1000, retiredCounter: 1_000_000,
            counters: counters({
                blockExecution: 5000, moduleReentry: 400, moduleChainedEdge: 600,
                moduleExitChainable: 100, moduleExitDynamic: 250, moduleExitIndirect: 40,
                abseipDispatch: 250, retMemoHit: 200, retMemoAlias: 30, retMemoCold: 15, retChainBudget: 5,
                retMetaHit: 45, retChainHit: 245, retChainMiss: 5,
            }),
        });
        const r = armed(summarizeDispatch(before, after));
        expect(r.moduleExits).toBe(1000);
        expect(r.classes.chained.pct).toBe(60);
        expect(r.classes.constantTargetUnchained.pct).toBe(10);
        expect(r.classes.dynamic.pct).toBe(25);
        expect(r.classes.indirect.pct).toBe(4);
        expect(r.classes.other.n).toBe(10);
        // 1000 exits per 1e6 instructions.
        expect(r.exitsPerKiloInsn).toBe(1);
        expect(r.absEip.probeOutcomesSumOk).toBe(true);
        expect(r.verdict.dominantClass).toBe("dynamic");
        expect(r.verdict.lever).toContain("memo");
    });

    test("a probe split that does not partition the dispatches says so", () => {
        const r = armed(summarizeDispatch(snap(), snap({
            atMs: 10, retiredCounter: 1000,
            counters: counters({
                blockExecution: 10, moduleReentry: 10, moduleExitDynamic: 10,
                abseipDispatch: 100, retMemoHit: 40, retMemoAlias: 5, retMemoCold: 5, retChainBudget: 0,
            }),
        })));
        expect(r.absEip.probeOutcomesSumOk).toBe(false);
        expect(r.absEip.unaccounted).toBe(50);
    });

    test("an indirect-dominated profile names the inline-cache lever", () => {
        const r = armed(summarizeDispatch(snap(), snap({
            atMs: 100, retiredCounter: 500_000,
            counters: counters({
                blockExecution: 900, moduleReentry: 800, moduleChainedEdge: 20,
                moduleExitIndirect: 600, moduleExitDynamic: 100, moduleExitChainable: 50,
            }),
        })));
        expect(r.verdict.dominantClass).toBe("indirect");
        expect(r.verdict.lever).toContain("inline cache");
    });

    test("cold memo misses steer AWAY from widening the memo", () => {
        const r = armed(summarizeDispatch(snap(), snap({
            atMs: 100, retiredCounter: 500_000,
            counters: counters({
                blockExecution: 900, moduleReentry: 800, moduleExitDynamic: 700,
                abseipDispatch: 700, retMemoHit: 100, retMemoAlias: 50, retMemoCold: 550,
            }),
        })));
        expect(r.verdict.dominantClass).toBe("dynamic");
        expect(r.verdict.lever).toContain("not the constraint");
    });

    test("a shipping build reports the profiler-only classes as absent, not zero", () => {
        const r = armed(summarizeDispatch(snap(), snap({
            atMs: 100, retiredCounter: 1000,
            counters: counters({ blockExecution: 10, moduleReentry: 10, moduleExitDynamic: 10 }),
        })));
        expect(r.profilerOnly.available).toBe(false);
        expect(r.profilerOnly.reason).toContain("Absent, not zero");
    });

    test("the retired counter is differenced wrap-safely", () => {
        const r = armed(summarizeDispatch(
            snap({ retiredCounter: 0xffff_f000 }),
            snap({
                atMs: 100, retiredCounter: 0x0000_1000,
                counters: counters({ blockExecution: 10, moduleReentry: 10 }),
            })));
        expect(r.retired).toBe(0x2000);
    });
});

describe("dispatchReport refuses rather than reporting a confident zero", () => {
    test("counters switched off", () => {
        const s = summarizeDispatch(snap({ statsEnabled: 0 }), snap({ atMs: 100, statsEnabled: 0 }));
        expect(s.ok).toBe(false);
        expect((s as any).refuse).toContain("DISPATCH_STATS is off");
    });

    test("counters flat while the guest retired instructions", () => {
        const s = summarizeDispatch(snap(), snap({ atMs: 100, retiredCounter: 5_000_000 }));
        expect(s.ok).toBe(false);
        expect((s as any).refuse).toContain("BLOCK_EXECUTION did not move");
    });

    test("a re-arm inside the window", () => {
        const s = summarizeDispatch(snap({ armEpoch: 1 }), snap({ atMs: 100, armEpoch: 2 }));
        expect(s.ok).toBe(false);
        expect((s as any).refuse).toContain("zeroed mid-flight");
    });

    test("an empty window", () => {
        const s = summarizeDispatch(snap({ atMs: 5 }), snap({ atMs: 5 }));
        expect(s.ok).toBe(false);
        expect((s as any).refuse).toContain("window is empty");
    });

    test("a guest that ran no instructions is armed:false, not a zero-tax report", () => {
        const s = summarizeDispatch(snap(), snap({ atMs: 100 }));
        expect(s.ok).toBe(true);
        expect((s as any).armed).toBe(false);
        expect((s as any).reason).toContain("retired no instructions");
    });

    test("a window past the retired counter's wrap period is flagged", () => {
        const r = armed(summarizeDispatch(snap(), snap({
            atMs: 45_000, retiredCounter: 1_000_000,
            counters: counters({ blockExecution: 10, moduleReentry: 10 }),
        })));
        expect(r.retiredWarning).toContain("wrap period");
    });
});

describe("the entry-EIP census carries its own completeness", () => {
    const withEip = (over: Partial<EntryEipCensus>): DispatchSnapshot => snap({
        atMs: 100, retiredCounter: 100_000,
        counters: counters({ blockExecution: 500, moduleReentry: 500, moduleExitDynamic: 500 }),
        entryEip: {
            available: true, samples: 1000, evictions: 0, evictionPct: 0, attributed: 1000,
            top: [{ eip: 0x00401000, hits: 700, symbol: null }, { eip: 0x00402abc, hits: 300, symbol: null }],
            ...over,
        },
    });

    test("a ranked table comes through with its eviction share", () => {
        const r = armed(summarizeDispatch(snap(), withEip({})));
        expect(r.entryEip.available).toBe(true);
        expect(r.entryEip.top[0].eip).toBe(0x00401000);
        expect(r.entryEip.evictionPct).toBe(0);
        expect(r.entryEip.note).toContain("not windowed");
    });

    test("a table that lost most of its samples says so instead of ranking confidently", () => {
        // The failure this guards: a direct-mapped table under collision pressure still
        // produces a plausible top-N, and without the eviction share a reader takes it for
        // the distribution rather than a sample of it.
        const r = armed(summarizeDispatch(snap(), withEip({ evictions: 900, evictionPct: 90, attributed: 100 })));
        expect(r.entryEip.evictionPct).toBe(90);
        expect(r.entryEip.note).toContain("sample of the distribution");
    });

    test("a build without the census reports unavailable rather than an empty ranking", () => {
        const r = armed(summarizeDispatch(snap(), snap({
            atMs: 100, retiredCounter: 100_000,
            counters: counters({ blockExecution: 10, moduleReentry: 10 }),
        })));
        expect(r.entryEip.available).toBe(false);
        expect(r.entryEip.top).toEqual([]);
        expect(r.entryEip.reason).toBeTruthy();
    });
});
