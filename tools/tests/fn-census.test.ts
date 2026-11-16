/**
 * The function census readout (#105 M1): refusals first, then the attribution arithmetic.
 * Snapshots are synthetic rows in v86's fn_census layout, so a wrong field index is a wrong
 * answer here before it is a wrong answer about a game.
 */

import { describe, test, expect } from "bun:test";
import { System } from "../../src/worker/core/system";
import {
    summarizeFnCensus, candidatePages, registerFnCensusCommands, ROW, FN_CENSUS_ROW_WORDS, STAT_NAMES, FN_CENSUS_SCHEMA,
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
        const before = snap({ atMs: 1, retiredTotal: 0, counted: { ...counted, blocks: [] } }, [leaf(0), caller(0)], { calls: 0 });
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

    const ch = (blocks: CountedSample[], o: Partial<NonNullable<FnCensusSnapshot["counted"]>> = {}) =>
        ({ recording: true, watchedPages: 1, armedPages: 1, pagesNotArmed: 0, slotOverflow: 0, blocks, ...o });
    const exec = (before: FnCensusSnapshot, after: FnCensusSnapshot) => {
        const r = summarizeFnCensus(before, after);
        if (!r.ok) throw new Error(r.refuse);
        return r.report.executed as any;
    };

    test("a saturated counted block makes executed shares unavailable, raw evidence kept", () => {
        const x = exec(snap({ atMs: 1, counted: ch([]) }, [leaf(0)]),
            snap({ atMs: 2, retiredTotal: 1e12, counted: ch([{ addr: LEAF, exec: 0xffffffff, ins: 1, owner: 1 }]) }, [leaf(5)], { calls: 5 }));
        expect(x.available).toBe(false);
        expect(x.problems.join(" ")).toContain("saturated");
        expect(x.raw.saturatedBlocks).toBe(1);
        expect(x.admittedPctOfRetired).toBeUndefined();
    });

    test("counted above retired is inconsistent, not 200 %", () => {
        const x = exec(snap({ atMs: 1, counted: ch([]) }, [leaf(0)]),
            snap({ atMs: 2, retiredTotal: 100, counted: ch([{ addr: LEAF, exec: 100, ins: 2, owner: 1 }]) }, [leaf(5)], { calls: 5 }));
        expect(x.available).toBe(false);
        expect(x.raw.countedIns).toBe(200);
        expect(x.problems.join(" ")).toContain("exceed");
    });

    test("a recorder disarmed or changed during the window gives no shares", () => {
        const blocks = [{ addr: LEAF, exec: 10, ins: 2, owner: 1 }];
        const before = snap({ atMs: 1, counted: ch([]) }, [leaf(0)]);
        expect(exec(before, snap({ atMs: 2, retiredTotal: 1000, counted: ch(blocks, { recording: false }) }, [leaf(5)], { calls: 5 })).available).toBe(false);
        expect(exec(before, snap({ atMs: 2, retiredTotal: 1000, counted: ch(blocks, { watchedPages: 3 }) }, [leaf(5)], { calls: 5 })).available).toBe(false);
        expect(exec(before, snap({ atMs: 2, retiredTotal: 1000, counted: ch(blocks) }, [leaf(5)], { calls: 5 })).admittedIns).toBe(20);
    });

    test("a function re-analysed after SMC inside the window is attributed to neither version", () => {
        const before = snap({ atMs: 1, counted: ch([]) }, [caller(0) as Uint32Array]);
        before.rows.get(CALLER)![ROW.flags] = 2;
        before.rows.get(CALLER)![ROW.analyses] = 1;
        const now = leaf(50, { entryVirt: CALLER, entryPhys: CALLER, analyses: 2, flags: 2, smcEvents: 1 });
        const r = summarizeFnCensus(before, snap({ atMs: 2, retiredTotal: 10000, counted: ch([{ addr: CALLER, exec: 1000, ins: 9, owner: 1 }]) }, [now], { calls: 50 }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const x = r.report.executed as any;
        expect(x.admittedIns).toBe(0);
        expect(x.refusedIns).toBe(0);
        expect(x.changedVersionIns).toBe(9000);
        expect((r.report.versionChanged as any).functions).toBe(1);
        expect((r.report.population as any).unitAdmitted).toBe(0);
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

describe("command lifecycle", () => {
    test("off stops the ticker and unwatches the recorder this verb armed, and leaves guestBlocks' alone", () => {
        const rows = new Uint32Array(FN_CENSUS_ROW_WORDS);
        rows[ROW.entryVirt] = LEAF; rows[ROW.entries] = 10; rows[ROW.codePage0] = LEAF >>> 12; rows[ROW.flags] = 2;
        const log: string[] = [];
        let enabled = 0, watched = 0;
        const exp: Record<string, (...a: number[]) => number> = {
            fn_census_version: () => FN_CENSUS_SCHEMA, fn_census_row_words: () => FN_CENSUS_ROW_WORDS,
            fn_census_set_enabled: (on) => { enabled = on; return 0; }, fn_census_enabled: () => enabled,
            fn_census_generation: () => 1, fn_census_reset: () => 0, fn_census_row_count: () => 1, fn_census_rows_ptr: () => 0,
            fn_census_stat: () => 0, fn_census_stat_count: () => STAT_NAMES.length, fn_census_owner_of: () => 0,
            fn_census_get_cap: () => 1, jit_codegen_fingerprint_lo: () => 1, jit_codegen_fingerprint_hi: () => 2,
            trace2_reset: () => { watched = 0; log.push("reset"); return 0; },
            trace2_watch_page: () => { watched++; return 1; },
            trace2_unwatch_all: () => { watched = 0; log.push("unwatch"); return 0; },
            trace2_enabled: () => (watched ? 1 : 0), trace2_watched_page_count: () => watched,
            trace2_block_snapshot: () => 0, jit_clear_cache_js: () => 0,
        };
        const cpuObj = { wm: { exports: exp }, wasm_memory: { buffer: rows.buffer }, instruction_counter: new Int32Array(1) };
        const system = System.getInstance() as any;
        const saved = system.process;
        const g = globalThis as any;
        const savedPre = g.preemption;
        const timers: unknown[] = [];
        const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
        (globalThis as any).setInterval = (f: () => void, ms: number) => { const t = realSet(f, ms); timers.push(t); return t; };
        let cleared = 0;
        (globalThis as any).clearInterval = (t: any) => { cleared++; realClear(t); };
        try {
            system.process = { v86: { cpu: cpuObj } };
            g.preemption = { getWasmExports: () => ({ ...exp, dbg_enable: () => 0 }) };
            const handlers = new Map<string, (a: unknown[]) => unknown>();
            registerFnCensusCommands({ register: (n: string, f: (a: unknown[]) => unknown) => handlers.set(n, f) } as never);
            handlers.get("fnCensusArm")!([{}]);
            handlers.get("fnCensusMark")!([{}]);
            expect(watched).toBe(1);
            expect(timers.length).toBe(1);
            handlers.get("fnCensusArm")!([{ on: false }]);
            expect(enabled).toBe(0);
            expect(watched).toBe(0);
            expect(log).toContain("unwatch");
            expect(cleared).toBe(1);
        } finally {
            system.process = saved;
            g.preemption = savedPre;
            (globalThis as any).setInterval = realSet;
            (globalThis as any).clearInterval = realClear;
        }
    });
});
