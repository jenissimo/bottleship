import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { dbg } from '../../src/worker/core/debug/dbg-commands';

describe('dbg.opStatsSnapshot provenance', () => {
    let oldPreemption: unknown;

    beforeEach(() => {
        const g = globalThis as any;
        oldPreemption = g.preemption;
        delete g.__jitOpStatsPrevious;
    });

    afterEach(() => {
        const g = globalThis as any;
        g.preemption = oldPreemption;
        delete g.__jitOpStatsPrevious;
    });

    it('refuses when the census switch is off instead of returning a zero table', () => {
        // The census is a runtime switch now, so a shipping build carries the real reader.
        // A zero table from it would read as "this workload runs no x87" — the exact claim
        // the roadmap's postmortem traced back to an unfalsifiable stub.
        (globalThis as any).preemption = {
            getWasmExports: () => ({
                dbg_enable: () => {},
                get_opstats_buffer: (_a: boolean, _b: boolean, _c: boolean, _d: boolean,
                    _op: number, _f: boolean, _m: boolean, _g: number) => 0,
                get_opstats: () => 0,
            }),
        };
        const snapshot = dbg.opStatsSnapshot();
        expect(snapshot.available).toBe(false);
        expect(snapshot.reason).toBe('census-switch-off');
    });

    it('marks a pre-switch zero stub unavailable instead of returning a zero census', () => {
        const releaseStub = function () { return 0; };
        (globalThis as any).preemption = {
            getWasmExports: () => ({ dbg_enable: () => {}, get_opstats_buffer: releaseStub }),
        };

        const snapshot = dbg.opStatsSnapshot();

        expect(snapshot.available).toBe(false);
        expect(snapshot.phase).toBe('unavailable');
        expect(snapshot.reason).toBe('legacy-stub-build');
        expect(snapshot.provenance.arity).toBe(0);
    });

    it('requires a nonzero profiler census and records its provenance before deltas', () => {
        let runtime = 7;
        function profilerGet(
            compiled: boolean, _jitExit: boolean, _unguarded: boolean, _wasmSize: boolean,
            opcode: number, is0f: boolean, isMem: boolean, fixedG: number,
        ): number {
            if (opcode !== 0x90 || is0f || isMem || fixedG !== 0) return 0;
            return compiled ? 1 : runtime;
        }
        (globalThis as any).preemption = {
            getWasmExports: () => ({ dbg_enable: () => {}, get_opstats_buffer: profilerGet }),
        };

        const baseline = dbg.opStatsSnapshot();
        expect(baseline.available).toBe(true);
        expect(baseline.phase).toBe('baseline');
        expect(baseline.provenance).toMatchObject({ profilerSignature: true, arity: 8, censusTotal: 7, compiledTotal: 1 });

        runtime = 12;
        const delta = dbg.opStatsSnapshot();
        expect(delta.available).toBe(true);
        expect(delta.phase).toBe('delta');
        expect(delta.total).toBe(5);
        expect(delta.top[0]).toMatchObject({ opcode: '90', count: 5 });
    });
});
