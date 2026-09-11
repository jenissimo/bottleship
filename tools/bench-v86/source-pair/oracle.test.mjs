import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reference, compare, schedule} from './oracle.mjs';

test('same data work across service kinds, with independent operation and boundary counts', () => {
    for (const operations of [1, 17, 4097]) for (const burst of [1, 31, 8192]) for (const variable of [0, 1]) {
        const c = {seed: 0xffffffff, operations, burst, variable, mode: 0};
        const base = reference(c), lengths = schedule(c).runs;
        assert.equal(lengths.reduce((a,b)=>a+b,0), operations);
        assert.equal(base[4], lengths.length);
        for (let mode = 1; mode <= 3; mode++) {
            const s = reference({...c, mode});
            assert.equal(s[5], lengths.length);
            s[5] = 0;
            assert.deepEqual(s, base);
        }
    }
});
test('oracle rejects skipped work, omitted boundary mutation, corrupted payload and malformed inputs', () => {
    const c = {seed: 73, operations: 800, burst: 37, variable: 1, mode: 2};
    for (const word of [0, 3, 4, 5, 7, 8, 512, 1032]) {
        const s = reference(c); s[word] ^= 1;
        assert.throws(()=>compare(s,c), /State word/);
    }
    assert.throws(()=>compare(reference({...c, operations:799}), c));
    assert.throws(()=>reference({...c, burst:0}));
    assert.throws(()=>reference({...c, seed:NaN}));
    assert.throws(()=>reference({...c, mode:4}));
});
