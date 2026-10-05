export const STATE_WORDS = 1033;
export function validateConfig(c) {
    for (const name of ['seed', 'operations', 'burst', 'mode', 'variable']) {
        if (!Number.isInteger(c[name]) || c[name] < 0 || c[name] > 0xffffffff) throw Error(`Invalid ${name}`);
    }
    if (!c.operations || !c.burst || c.operations > 10000000 || c.burst > 10000000 || c.mode > 3 || c.variable > 1) throw Error('Invalid workload bounds');
    return c;
}
// Independent scalar interpreter, not a checksum copied from a compiled arm.
export function reference(config) {
    const {seed, operations, burst, mode, variable} = validateConfig(config);
    const s = new Uint32Array(STATE_WORDS), p = s.subarray(9);
    s.set([0x50414952, 1, seed, 0, 0, 0, 0, (seed ^ 0x9e3779b9) >>> 0, (seed | 1) >>> 0]);
    let x = seed;
    for (let i = 0; i < p.length; i++) p[i] = x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    let left = operations;
    while (left) {
        s[8] = (Math.imul(s[8], 1664525) + 1013904223) >>> 0;
        const n = Math.min(left, variable ? 1 + s[8] % burst : burst);
        for (let i = 0; i < n; i++) {
            const j = s[6] & 1023, a = p[j], b = p[(j + 37) & 1023];
            const rb = (((a & 0xff00ff) * 3 + (b & 0xff00ff)) >>> 2) & 0xff00ff;
            const g = (((a & 0xff00) * 3 + (b & 0xff00)) >>> 2) & 0xff00;
            const value = ((rb | g) ^ s[7]) >>> 0;
            p[j] = value;
            s[7] = ((s[7] << 5 | s[7] >>> 27) + value) >>> 0;
            s[6] += 17;
            s[3]++;
        }
        s[4]++;
        if (mode) s[5]++;
        const j = Math.imul(s[4], 13) & 1023;
        p[j] ^= (s[7] + s[4]) >>> 0;
        s[7] += p[j];
        left -= n;
    }
    return s;
}
export function compare(actual, config) {
    const expected = reference(config);
    if (actual.length !== expected.length) throw Error(`State length ${actual.length}, expected ${expected.length}`);
    for (let i = 0; i < expected.length; i++) if ((actual[i] >>> 0) !== expected[i]) {
        throw Error(`State word ${i}: actual ${actual[i] >>> 0}, expected ${expected[i]}`);
    }
    return {wordsCompared: expected.length, operations: expected[3], phases: expected[4], services: expected[5], carry: expected[7]};
}
export function schedule(config) {
    validateConfig(config);
    let x = (config.seed | 1) >>> 0, left = config.operations;
    const histogram = {}, runs = [];
    while (left) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        const n = Math.min(left, config.variable ? 1 + x % config.burst : config.burst);
        histogram[n] = (histogram[n] || 0) + 1;
        runs.push(n); left -= n;
    }
    return {unit: 'pixel updates (not x86 instructions)', histogram, runs};
}
