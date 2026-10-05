/**
 * The perf instruments whose failure mode is a plausible number.
 *
 * Each block below pins one instrument to the shape it claims: the fastmem counters the frame
 * window projects (a field retired from the engine used to reach the report as NaN), the
 * wasm-tier share (0% over n=0 while the accounting that feeds it was never compiled in), and
 * the read-microTLB census (a cumulative-since-boot total handed back under a just-set label).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { dbg, type FastmemStats } from '../../src/worker/core/debug/dbg-commands';
import { projectFastmem, type FastmemCounters } from '../../src/worker/harness/cmds/perf';
import { System } from '../../src/worker/core/system';

type Exports = Record<string, unknown>;

let savedPreemption: unknown;
let savedProcess: unknown;

const install = (exports: Exports): void => {
    (globalThis as any).preemption = { getWasmExports: () => ({ dbg_enable: () => {}, ...exports }) };
};

beforeEach(() => {
    savedPreemption = (globalThis as any).preemption;
    savedProcess = (System.getInstance() as any).process;
});
afterEach(() => {
    (globalThis as any).preemption = savedPreemption;
    (System.getInstance() as any).process = savedProcess;
});

describe('dbg.fastmemStats / frameReport projection', () => {
    // Compile-time census of the type. Deleting a field from FastmemStats breaks this line,
    // and adding one breaks it too — which forces the decision "does the frame window report
    // this?" to be made here rather than discovered as a NaN in a report.
    const STATS_KEYS: Record<keyof FastmemStats, true> = {
        readsStatus: true, writesEnabled: true, speculatedStoresCompiled: true,
        writeMap: true, dispatchSlabs: true,
    };
    const COUNTER_KEYS: Record<keyof FastmemCounters, true> = {
        writesEnabled: true, speculatedStoresCompiled: true, writeMapAcceptPages: true,
    };

    it('answers exactly the fields its type declares', () => {
        install({
            get_jit_config: (i: number) => (i === 19 ? 1 : 0),
            fastmem_get_speculated_stores_compiled: () => 41,
            fastmem_write_map_count: (kind: number) => ({ 0: 7, 1: 3, 2: 2, 4: 1 } as Record<number, number>)[kind] ?? 0,
            fastmem_write_map_max_page: () => 0x1234,
            dispatch_slab_high_water: () => 5,
            dispatch_slab_overflows: () => 0,
        });
        const stats = dbg.fastmemStats();
        expect(stats).not.toBeNull();
        expect(Object.keys(stats!).sort()).toEqual(Object.keys(STATS_KEYS).sort());
        expect(stats!.readsStatus).toBe('retired');
        expect(stats!.writesEnabled).toBe(true);
        expect(stats!.writeMap?.acceptPages).toBe(7);
    });

    it('projects the frame-window counters without inventing a retired field', () => {
        install({
            get_jit_config: () => 0,
            fastmem_get_speculated_stores_compiled: () => 12,
            fastmem_write_map_count: () => 9,
            fastmem_write_map_max_page: () => 0,
        });
        const counters = projectFastmem(dbg.fastmemStats());
        expect(counters).not.toBeNull();
        expect(Object.keys(counters!).sort()).toEqual(Object.keys(COUNTER_KEYS).sort());
        // The exact failure this pins: a projected field that no longer exists is `undefined`,
        // and the window's subtraction publishes NaN under its name.
        for (const [k, v] of Object.entries(counters!)) {
            expect(v, `${k} must not be undefined/NaN`).not.toBeUndefined();
            if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false);
        }
        expect(counters!.speculatedStoresCompiled).toBe(12);
    });

    it('is null — not a zeroed record — when the engine has no debug exports', () => {
        (globalThis as any).preemption = { getWasmExports: () => null };
        expect(dbg.fastmemStats()).toBeNull();
        expect(projectFastmem(null)).toBeNull();
    });
});

describe('dbg.jitTierStats retired share', () => {
    const installEngine = (tier2Threshold: number): void => {
        install({
            get_jit_config: (i: number) => (i === 15 ? tier2Threshold : 0),
            jit_get_module_entry_total: () => 100,
            jit_get_module_retired_total: () => 0,
            jit_get_tier2_retired_total: () => 0,
            jit_get_tier2_promotions: () => 0,
        });
        (System.getInstance() as any).process = {
            v86: { cpu: { wm: { wasm_table: { get: (i: number) => (i === 1024 ? () => 0 : null) } } } },
        };
    };

    it('reports share=null with a reason when tier-2 accounting was never compiled in', () => {
        // jit.rs:6248 — an OFF module omits the retired-accounting calls, so the split is
        // structurally empty. "L=0% T=0% (n=0)" from that reads as a measured answer.
        installEngine(0);
        const out = dbg.jitTierStats();
        expect(out).not.toBeNull();
        expect(out.share).toBeNull();
        expect(out.shareReason).toBe('tier2-off');
        expect(out.tier2Threshold).toBe(0);
        // The always-valid half stays a number.
        expect(out.entryShare.liftoff + out.entryShare.turbofan + out.entryShare.unknown).toBeGreaterThanOrEqual(0);
    });

    it('reports a share once tiering is on and something retired', () => {
        install({
            get_jit_config: (i: number) => (i === 15 ? 19_200_000 : 0),
            jit_get_module_entry_total: () => 10,
            jit_get_module_retired_total: () => 500,
            jit_get_tier2_retired_total: () => 500,
            jit_get_tier2_promotions: () => 3,
        });
        (System.getInstance() as any).process = {
            v86: { cpu: { wm: { wasm_table: { get: (i: number) => (i === 1024 ? () => 0 : null) } } } },
        };
        for (const k of ['__jitTierPrev', '__jitTierRetiredPrev', '__jitTierFunctionPrev', '__jitTierGlobalRetiredPrev']) {
            delete (globalThis as any)[k];
        }
        dbg.jitTierStats();                       // baseline
        const out = dbg.jitTierStats();
        expect(out.shareReason).toBeNull();
        expect(out.share).not.toBeNull();
        expect(out.share.liftoff + out.share.turbofan + out.share.unknown).toBe(100);
        expect(out.totalRetired).toBeGreaterThan(0);
    });
});

describe('dbg.setReadTlbCache / readTlbCacheStats', () => {
    let hit = 0;
    let fill = 0;
    const installEngine = (mode: number, statsEnabled = 1): void => {
        let cfg29 = mode, cfg30 = 0x401;
        install({
            set_jit_config: (i: number, v: number) => { if (i === 29) cfg29 = v; if (i === 30) cfg30 = v; return 0; },
            get_jit_config: (i: number) => (i === 29 ? cfg29 : i === 30 ? cfg30 : 0),
            get_dispatch_stats: () => statsEnabled,
            jit_clear_cache_js: () => {},
            profiler_dispatch_stat_get: (i: number) => (i === 23 ? hit : i === 24 ? fill : 0),
        });
    };

    beforeEach(() => { hit = 0; fill = 0; });

    it('the mutation returns the applied configuration, not counters', () => {
        installEngine(0);
        hit = 5000; fill = 100;                   // cumulative traffic from before the call
        const applied = dbg.setReadTlbCache(2, 0x401)!;
        expect(applied.mode).toBe(2);
        expect(applied.codePage).toBe(0x401);
        expect(applied.cacheCleared).toBe(true);
        expect(Object.keys(applied)).not.toContain('hit');
        expect(Object.keys(applied)).not.toContain('hitPct');
    });

    it('refuses a window on the first call after a configuration change', () => {
        installEngine(0);
        hit = 5000; fill = 100;
        dbg.setReadTlbCache(2, 0x401);
        const first = dbg.readTlbCacheStats()!;
        expect(first.window).toBeNull();
        expect(String(first.windowReason)).toContain('MARKS the window');
        // The total is still reported — labelled as what it is.
        expect(first.cumulative).toEqual({ hit: 5000, fill: 100, hitPct: 98.04 });
    });

    it('reports the window as a difference, never the since-boot total', () => {
        installEngine(2);
        hit = 5000; fill = 100;
        dbg.readTlbCacheStats();                  // mark
        hit = 5300; fill = 200;
        const w = dbg.readTlbCacheStats()!;
        expect(w.windowReason).toBeNull();
        expect(w.window).toMatchObject({ hit: 300, fill: 100, hitPct: 75 });
        expect(w.cumulative).toMatchObject({ hit: 5300, fill: 200 });
    });

    it('refuses a window when nothing was counting, rather than reporting 0%', () => {
        installEngine(2, /* statsEnabled */ 0);
        dbg.readTlbCacheStats();
        const out = dbg.readTlbCacheStats()!;
        expect(out.window).toBeNull();
        expect(String(out.windowReason)).toContain('DISPATCH_STATS is off');
    });

    it('refuses a window in a mode that emits no census traffic', () => {
        installEngine(1);
        dbg.readTlbCacheStats();
        const out = dbg.readTlbCacheStats()!;
        expect(out.window).toBeNull();
        expect(String(out.windowReason)).toContain('no census traffic');
    });
});
