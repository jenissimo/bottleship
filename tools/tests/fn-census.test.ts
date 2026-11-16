/**
 * The function census readout (#105 M1): refusals first, then the attribution arithmetic.
 * Snapshots are synthetic rows in v86's fn_census layout, so a wrong field index is a wrong
 * answer here before it is a wrong answer about a game.
 */

import { describe, test, expect } from "bun:test";
import {
    summarizeFnCensus, candidatePages, ROW, FN_CENSUS_ROW_WORDS, STAT_NAMES,
    type FnCensusSnapshot, type CountedSample,
} from "../../src/worker/harness/cmds/fn-census";

function row(fields: Partial<Record<keyof typeof ROW, number>>): Uint32Array {
    const r = new Uint32Array(FN_CENSUS_ROW_WORDS);
    for (const [k, v] of Object.entries(fields)) r[ROW[k as keyof typeof ROW]] = v! >>> 0;
    return r;
}

function snap(over: Partial<FnCensusSnapshot> = {}, rows: Uint32Array[] = [], stats: Partial<Record<(typeof STAT_NAMES)[number], number>> = {}): FnCensusSnapshot {
    return {
        atMs: 0, armEpoch: 1, kernelGeneration: 7, exportsId: 1, enabled: 1,
        rows: new Map(rows.map(r => [r[ROW.entryVirt]!, r])),
        stats: STAT_NAMES.map(n => stats[n] ?? 0),
        retiredTotal: 0, fingerprint: "0x1:0x2", caps: [3, 2048, 512, 12288, 3], counted: null,
        ...over,
    };
}

const LEAF = 0x401000, CALLER = 0x402000, ALIGN = 0x403000;
const leaf = (entries: number, extra: Partial<Record<keyof typeof ROW, number>> = {}) =>
    row({ entryVirt: LEAF, entryPhys: LEAF, entries, frameLo: -12, frameHi: 8, x87Ops: 2, windowAdmitted: entries, codePage0: LEAF >>> 12, ...extra });
const caller = (entries: number) => row({ entryVirt: CALLER, entryPhys: CALLER, entries, unit: 1, windowStatic: 16, outCalls: 1, p4: 32, codePage0: CALLER >>> 12 });
const align = (entries: number) => row({ entryVirt: ALIGN, entryPhys: ALIGN, entries, windowStatic: 2, p4: 32, windowRefused: entries, windowRefusedSeen: 1 << 10, codePage0: ALIGN >>> 12 });

describe("refusals", () => {
    const before = snap({ atMs: 1 }, [leaf(10)], { calls: 10 });
    const ok = (o: Partial<FnCensusSnapshot>) => snap({ atMs: 2, ...o }, [leaf(20)], { calls: 20 });

    test("empty window", () => {
        expect(summarizeFnCensus(before, { ...before }).ok).toBe(false);
    });
    test("re-arm inside the window", () => {
        const r = summarizeFnCensus(before, ok({ armEpoch: 2 }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.refuse).toContain("fnCensusArm");
    });
    test("kernel reset, re-enable or state restore inside the window", () => {
        const r = summarizeFnCensus(before, ok({ kernelGeneration: 8 }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.refuse).toContain("generation");
    });
    test("worker reload: another v86 instance", () => {
        const r = summarizeFnCensus(before, ok({ exportsId: 2 }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.refuse).toContain("reload");
    });
    test("census off is never a zero census", () => {
        expect(summarizeFnCensus({ ...before, enabled: 0 }, ok({ enabled: 0 })).ok).toBe(false);
    });
    test("fingerprint moved", () => {
        expect(summarizeFnCensus(before, ok({ fingerprint: "0x9:0x9" })).ok).toBe(false);
    });
    test("retired instructions with no recorded calls is an error, not an empty table", () => {
        const after = snap({ atMs: 2, retiredTotal: 5_000_000 }, [leaf(10)], { calls: 10 });
        const r = summarizeFnCensus(before, after);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.refuse).toContain("0 compiled direct calls");
    });
});

describe("readout", () => {
    test("population, eligibility kinds and entry weighting stay separate", () => {
        const before = snap({ atMs: 1 }, [leaf(100), caller(10)], { calls: 110 });
        const after = snap({ atMs: 2, retiredTotal: 1000 }, [leaf(400), caller(40), align(60)], { calls: 500 });
        const r = summarizeFnCensus(before, after);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const p = r.report.population as any;
        expect(p.candidates).toBe(3);
        expect(p.unitAdmitted).toBe(2);
        expect(p.windowEligible).toBe(1);
        expect(p.promotionEligible).toBe(1);
        expect(p.p4Eligible).toBe(1);
        expect(p.unitRefusals.guestCall).toEqual({ functions: 1, weight: 30 });
        expect(p.windowRefusals.espAlign).toEqual({ functions: 1, weight: 60 });
        const e = r.report.entryWeighted as any;
        expect(e.entries).toBe(390);
        expect(e.unitAdmittedPct).toBe(+((360 / 390) * 100).toFixed(2));
        const w = r.report.windowProbes as any;
        expect(w.admitted).toBe(300);
        expect(w.refused).toBe(0);
        expect(w.notProbedEntries).toBe(30 + 60);
        expect(w.refusedBy).toEqual({});
        expect((r.report.executed as any).available).toBe(false);
    });

    test("executed coverage: owned by admitted, owned by refused, unattributed and unknown add up", () => {

        const blocks: CountedSample[] = [
            { addr: LEAF, exec: 1000, ins: 9, owner: 1 },
            { addr: CALLER, exec: 100, ins: 5, owner: 2 },
            { addr: 0x500000, exec: 10, ins: 7, owner: 0 },
        ];
        const counted = { recording: true, watchedPages: 2, armedPages: 2, pagesNotArmed: 1, slotOverflow: 0, blocks };
        const before = snap({ atMs: 1, retiredTotal: 0 }, [leaf(0), caller(0)], { calls: 0 });
        const after = snap({ atMs: 2, retiredTotal: 20000, counted }, [leaf(100), caller(10)], { calls: 110 });
        const r = summarizeFnCensus(before, after);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const x = r.report.executed as any;
        expect(x.countedIns).toBe(9000 + 500 + 70);
        expect(x.admittedIns).toBe(9000);
        expect(x.refusedIns).toBe(500);
        expect(x.unattributedIns).toBe(70);
        expect(x.unknownIns).toBe(20000 - 9570);
        expect(x.admittedPctOfRetired).toBe(45);
        expect((r.report.dropped as any).countedPagesNotArmed).toBe(1);
        const top = r.report.top as any[];
        expect(top[0].entry).toBe("0x401000");
        expect(top[0].executedIns).toBe(9000);
        expect(top[0].frame).toEqual([-12, 8]);
    });

    test("a saturated counted block is named as dropped precision", () => {
        const counted = { recording: true, watchedPages: 1, armedPages: 1, pagesNotArmed: 0, slotOverflow: 0,
            blocks: [{ addr: LEAF, exec: 0xffffffff, ins: 1, owner: 1 }] };
        const r = summarizeFnCensus(snap({ atMs: 1 }, [leaf(0)]), snap({ atMs: 2, counted }, [leaf(5)], { calls: 5 }));
        expect(r.ok && (r.report.dropped as any).countedSaturatedBlocks).toBe(1);
    });
});

describe("candidate pages for the counted channel", () => {
    test("hottest candidates first, every code page once, capped", () => {
        const a = row({ entryVirt: 1, entries: 5, codePage0: 0x401 });
        const b = row({ entryVirt: 2, entries: 50, codePage0: 0x402 });
        b[ROW.codePage0 + 1] = 0x403;
        const c = row({ entryVirt: 3, entries: 20, codePage0: 0x402 });
        const out = candidatePages([a, b, c], 2);
        expect(out.pages).toEqual([0x402, 0x403]);
        expect(out.wanted).toBe(3);
    });
});
