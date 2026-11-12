import { describe, expect, test, afterEach } from 'bun:test';
import { PathPolicy } from '../../src/worker/runtime/filesystem/path-policy';

const g = globalThis as { __pathPolicyMemo?: boolean };

describe('path policy classification memo', () => {
    afterEach(() => { delete g.__pathPolicyMemo; });

    test('repeated classification returns the same answer as the uncached path', () => {
        const p = new PathPolicy({ ephemeral: ['*.log', 'temp/**'] });
        const paths = ['C:\\GAME\\debug.log', 'C:\\GAME\\save\\slot1.sav', 'c:/game/temp/a/b.bin', 'C:\\GAME\\debug.log'];
        const cached = paths.map((x) => p.classify(x));
        g.__pathPolicyMemo = false;
        const plain = paths.map((x) => p.classify(x));
        expect(cached).toEqual(plain);
        expect(cached).toEqual(['ephemeral', 'persist', 'ephemeral', 'ephemeral']);
    });

    test('memo skips the rule scan on a repeated path', () => {
        const p = new PathPolicy({ ephemeral: ['*.log'] });
        let tests = 0;
        const orig = RegExp.prototype.test;
        RegExp.prototype.test = function (this: RegExp, s: string) { tests++; return orig.call(this, s); };
        try {
            p.classify('C:\\GAME\\x.log');
            const first = tests;
            p.classify('C:\\GAME\\x.log');
            expect(tests).toBe(first);
            g.__pathPolicyMemo = false;
            p.classify('C:\\GAME\\x.log');
            expect(tests).toBeGreaterThan(first);
        } finally {
            RegExp.prototype.test = orig;
        }
    });

    test('persist-only policies stay correct through the memo', () => {
        const p = new PathPolicy({ persistOnly: true, persist: ['save/**'] });
        expect(p.classify('C:\\G\\save\\a.sav')).toBe('persist');
        expect(p.classify('C:\\G\\save\\a.sav')).toBe('persist');
        expect(p.classify('C:\\G\\cache\\a.bin')).toBe('ephemeral');
    });
});
