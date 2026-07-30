/**
 * Synchronous inflate (packages/formats/src/zip/inflate.ts) against Node's
 * zlib as the oracle: every stream zlib can produce we must decode
 * byte-identically, and every way a stream can be broken must land in the
 * status bucket zlib maps to the matching Z_* code.
 */

import { describe, expect, test } from 'bun:test';
import { constants, deflateSync, deflateRawSync } from 'node:zlib';
import { adler32, inflateRawSync, inflateZlibSync } from '../../packages/formats/src/zip/inflate';

/** Deterministic pseudo-random bytes with enough structure to compress. */
function sample(n: number, seed = 1): Uint8Array {
    const out = new Uint8Array(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) >>> 0;
        // Mix of repetition (matches) and noise (literals).
        out[i] = i % 7 === 0 ? (s >>> 24) & 0xff : out[i - (i % 61) - 1] ?? (s >>> 16) & 0xff;
    }
    return out;
}

const CASES: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['one byte', new Uint8Array([0x42])],
    ['tiny text', new TextEncoder().encode('the quick brown fox jumps over the lazy dog')],
    ['repetitive 64K', new Uint8Array(65536).fill(0xab)],
    ['mixed 200K', sample(200_000)],
];

describe('inflateZlibSync round-trips', () => {
    for (const [name, data] of CASES) {
        for (const level of [0, 1, 6, 9]) {
            test(`${name} @level ${level}`, () => {
                const comp = new Uint8Array(deflateSync(data, { level }));
                const out = new Uint8Array(data.length);
                const r = inflateZlibSync(comp, out);
                expect(r.status).toBe('ok');
                expect(r.written).toBe(data.length);
                expect(r.consumed).toBe(comp.length);
                expect(out).toEqual(data);
            });
        }
        test(`${name} @fixed-Huffman`, () => {
            const comp = new Uint8Array(deflateSync(data, { strategy: constants.Z_FIXED }));
            const out = new Uint8Array(data.length);
            const r = inflateZlibSync(comp, out);
            expect(r.status).toBe('ok');
            expect(out).toEqual(data);
        });
    }
});

test('raw deflate stream decodes without a wrapper', () => {
    const data = sample(50_000, 7);
    const comp = new Uint8Array(deflateRawSync(data));
    const out = new Uint8Array(data.length);
    const r = inflateRawSync(comp, out);
    expect(r.status).toBe('ok');
    expect(out).toEqual(data);
});

test('adler32 matches the value zlib stored', () => {
    const data = sample(30_000, 3);
    const comp = new Uint8Array(deflateSync(data));
    const stored = (comp[comp.length - 4] << 24 | comp[comp.length - 3] << 16 |
        comp[comp.length - 2] << 8 | comp[comp.length - 1]) >>> 0;
    expect(adler32(data, data.length)).toBe(stored);
});

describe('failure classification', () => {
    const data = sample(40_000, 11);
    const comp = new Uint8Array(deflateSync(data));

    test('destination too small → output-full, partial output retained', () => {
        const out = new Uint8Array(1000);
        const r = inflateZlibSync(comp, out);
        expect(r.status).toBe('output-full');
        expect(r.written).toBe(1000);
        expect(out).toEqual(data.subarray(0, 1000));
    });

    test('truncated input → truncated', () => {
        const out = new Uint8Array(data.length);
        const r = inflateZlibSync(comp.subarray(0, comp.length >> 1), out);
        expect(r.status).toBe('truncated');
    });

    test('missing adler trailer → truncated', () => {
        const out = new Uint8Array(data.length);
        const r = inflateZlibSync(comp.subarray(0, comp.length - 2), out);
        expect(r.status).toBe('truncated');
    });

    test('corrupt adler → data-error naming the checksum', () => {
        const bad = comp.slice();
        bad[bad.length - 1] ^= 0xff;
        const out = new Uint8Array(data.length);
        const r = inflateZlibSync(bad, out);
        expect(r.status).toBe('data-error');
        expect(r.message).toContain('data check');
        // The payload still decoded — that is what makes a checksum failure
        // distinguishable from a structural one.
        expect(r.written).toBe(data.length);
    });

    test('bad header check → data-error before any output', () => {
        const bad = comp.slice();
        bad[1] ^= 0x01;
        const r = inflateZlibSync(bad, new Uint8Array(data.length));
        expect(r.status).toBe('data-error');
        expect(r.message).toContain('header check');
        expect(r.written).toBe(0);
    });

    test('unknown compression method → data-error', () => {
        const r = inflateZlibSync(new Uint8Array([0x77, 0x8b]), new Uint8Array(16));
        expect(r.status).toBe('data-error');
        expect(r.message).toContain('compression method');
    });

    test('preset dictionary → need-dict', () => {
        const dict = new TextEncoder().encode('dictionary');
        const comp2 = new Uint8Array(deflateSync(data, { dictionary: dict }));
        const r = inflateZlibSync(comp2, new Uint8Array(data.length));
        expect(r.status).toBe('need-dict');
    });

    test('corrupt body → data-error or truncated, never a wrong "ok"', () => {
        let sawDataError = false;
        for (let i = 8; i < Math.min(comp.length - 8, 400); i += 7) {
            const bad = comp.slice();
            bad[i] ^= 0xff;
            const r = inflateZlibSync(bad, new Uint8Array(data.length * 2));
            expect(r.status === 'ok').toBe(false);
            if (r.status === 'data-error') sawDataError = true;
        }
        expect(sawDataError).toBe(true);
    });

    test('stored blocks with a broken length complement → data-error', () => {
        const stored = new Uint8Array(deflateSync(data, { level: 0 }));
        stored[4] ^= 0xff; // inside LEN of the first stored block
        const r = inflateZlibSync(stored, new Uint8Array(data.length));
        expect(r.status === 'data-error' || r.status === 'truncated').toBe(true);
    });
});

test('trailing garbage after the stream is ignored, as zlib does', () => {
    const data = sample(5000, 5);
    const comp = new Uint8Array(deflateSync(data));
    const padded = new Uint8Array(comp.length + 64);
    padded.set(comp);
    padded.fill(0xcc, comp.length);
    const out = new Uint8Array(data.length);
    const r = inflateZlibSync(padded, out);
    expect(r.status).toBe('ok');
    expect(r.consumed).toBe(comp.length);
    expect(out).toEqual(data);
});
