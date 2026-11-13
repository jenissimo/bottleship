/**
 * eipProfile's exit-site window. The switch shapes generated code, so a window that forgets
 * to clear the JIT cache samples modules compiled without the store (a slot that never moves),
 * and one that forgets to restore leaves every later module paying for it. The engine side —
 * that the slot names the right code — is vendor/v86/tests/jit-exit-site-sampling.mjs.
 */
import { describe, expect, it } from 'bun:test';
import { exitSiteSupported, withExitSiteSampling } from '../../src/worker/harness/cmds/perf';

function fakeEngine(initial = 0) {
    const log: string[] = [];
    let on = initial;
    return {
        log,
        ex: {
            set_jit_exit_site_sampling: (v: number) => { on = v; log.push(`set ${v}`); return 0; },
            get_jit_exit_site_sampling: () => on,
            jit_exit_site_eip: () => 0x401000,
            jit_clear_cache_js: () => { log.push(`clear (on=${on})`); return 0; },
        },
        isOn: () => on,
    };
}

describe('eipProfile exit-site window', () => {
    it('turns the switch on and recompiles before sampling, then restores and recompiles', async () => {
        const e = fakeEngine();
        const seen = await withExitSiteSampling(e.ex, 0, async () => { e.log.push('sample'); return e.isOn(); });
        expect(seen).toBe(1);
        expect(e.log).toEqual(['set 1', 'clear (on=1)', 'sample', 'set 0', 'clear (on=0)']);
    });

    it('leaves an already-on engine alone', async () => {
        const e = fakeEngine(1);
        await withExitSiteSampling(e.ex, 0, async () => { e.log.push('sample'); });
        expect(e.log).toEqual(['sample']);
        expect(e.isOn()).toBe(1);
    });

    it('restores the switch when sampling throws', async () => {
        const e = fakeEngine();
        await expect(withExitSiteSampling(e.ex, 0, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(e.isOn()).toBe(0);
        expect(e.log.at(-1)).toBe('clear (on=0)');
    });

    it('refuses a second window while one is open', async () => {
        const e = fakeEngine();
        let release!: () => void;
        const first = withExitSiteSampling(e.ex, 0, () => new Promise<void>((r) => { release = r; }));
        await expect(withExitSiteSampling(e.ex, 0, async () => {})).rejects.toThrow('already open');
        release();
        await first;
        expect(e.isOn()).toBe(0);
        // The refused call must not have closed the first window's lock early.
        await withExitSiteSampling(e.ex, 0, async () => {});
    });

    it('reports an engine without the exports as unsupported', () => {
        expect(exitSiteSupported(undefined)).toBe(false);
        expect(exitSiteSupported({ jit_clear_cache_js: () => 0 })).toBe(false);
        expect(exitSiteSupported(fakeEngine().ex)).toBe(true);
    });
});
