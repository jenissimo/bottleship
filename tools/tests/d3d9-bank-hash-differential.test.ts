/**
 * The constant-bank hash cache, run against a recomputation of the same key.
 *
 * The cache is only as correct as its invalidation: a write path that skips
 * invalidateBankBlocks serves a STALE key, the capture cache hands back another draw's
 * slot, and the frame is wrong in a way no counter notices. §3.4 wants both paths run
 * over the same workload with their ledgers compared and gated from an independent
 * oracle. The oracle here is the key recomputed with every block forced stale — NOT the
 * `__d3d9NoBankHashCache` arm, which walks words instead of combining block hashes and
 * so answers a different (equally valid, differently derived) key. That flag is a
 * performance baseline, not a correctness oracle, and mistaking one for the other is
 * exactly the "instrument measuring something other than its label" trap.
 *
 * The last two tests are the positive controls: one bypasses the choke point on purpose
 * and asserts the verify hook REPORTS it, because a verify that silently never fires
 * reads exactly like a verify that always passes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

const BLOCK_WORDS = 16;
const INT_WORDS = 16 * 4;
const BANK_VECS = 32;
const BANK_WORDS = BANK_VECS * 4;

type Flags = {
    __d3d9NoBankHashCache?: boolean;
    __d3d9VerifyBankHash?: boolean;
};

type BankCache = { h1: Uint32Array; h2: Uint32Array; valid: Uint8Array };

interface Probe {
    vsConstants: Float32Array;
    psConstants: Float32Array;
    vsIntegerBits: Uint32Array;
    psIntegerBits: Uint32Array;
    vsBankHash: BankCache;
    psBankHash: BankCache;
    vsIntegerHash: { h1: number; h2: number; valid: boolean };
    psIntegerHash: { h1: number; h2: number; valid: boolean };
    bankHashMismatches: number;
    verifyingBankHash: boolean;
}

const proto = D3D9Device.prototype as unknown as {
    copyProgrammableBankWithKey: (
        this: Probe, dstBits: Uint32Array, cBits: Uint32Array, cLen: number,
        iBits: Uint32Array, boolMask: number, prefixBank?: Uint32Array, prefixWords?: number,
    ) => number;
    invalidateBankBlocks: (this: Probe, bank: Uint32Array, baseIdx: number, count: number) => void;
};

function makeCache(words: number): BankCache {
    const blocks = Math.ceil(words / BLOCK_WORDS);
    return { h1: new Uint32Array(blocks), h2: new Uint32Array(blocks), valid: new Uint8Array(blocks) };
}

function makeProbe(): Probe {
    // Built on the real prototype: the methods under test call their siblings
    // (bankHashCacheFor, integerHashCacheFor), so a bare object literal would only
    // exercise a stand-in of the cache lookup rather than the shipping one.
    return Object.assign(Object.create(D3D9Device.prototype) as Probe, {
        vsConstants: new Float32Array(BANK_WORDS),
        psConstants: new Float32Array(BANK_WORDS),
        vsIntegerBits: new Uint32Array(INT_WORDS),
        psIntegerBits: new Uint32Array(INT_WORDS),
        vsBankHash: makeCache(BANK_WORDS),
        psBankHash: makeCache(BANK_WORDS),
        vsIntegerHash: { h1: 0, h2: 0, valid: false },
        psIntegerHash: { h1: 0, h2: 0, valid: false },
        bankHashMismatches: 0,
        verifyingBankHash: false,
    });
}

function vsBits(p: Probe): Uint32Array {
    return new Uint32Array(p.vsConstants.buffer, 0, p.vsConstants.length);
}

/** The sanctioned write: touch the bank, then mark the blocks it covered. */
function writeConstants(p: Probe, startVec: number, values: number[]): void {
    const base = startVec * 4;
    const bits = vsBits(p);
    const src = new Float32Array(values);
    const srcBits = new Uint32Array(src.buffer, 0, src.length);
    for (let i = 0; i < srcBits.length; i++) bits[base + i] = srcBits[i]!;
    proto.invalidateBankBlocks.call(p, bits, base, srcBits.length);
}

function keyOf(p: Probe, boolMask = 0): number {
    const dst = new Uint32Array(BANK_WORDS + INT_WORDS + 4);
    return proto.copyProgrammableBankWithKey.call(
        p, dst, vsBits(p), BANK_WORDS, p.vsIntegerBits, boolMask);
}

/** The independent oracle: the same combine, with every cached block hash forced stale,
 *  so the key is rebuilt from the bank contents alone. A cached key that disagrees with
 *  this is a stale key, i.e. an invalidation that did not happen. */
function freshKeyOf(p: Probe, boolMask = 0): number {
    p.vsBankHash.valid.fill(0);
    p.vsIntegerHash.valid = false;
    return keyOf(p, boolMask);
}

/** The performance baseline arm: cache off, key derived by walking words. Used only to
 *  check that arm is itself content-determined — never as an oracle for the cached key. */
function uncachedKeyOf(p: Probe, boolMask = 0): number {
    const g = globalThis as Flags;
    const prev = g.__d3d9NoBankHashCache;
    g.__d3d9NoBankHashCache = true;
    try {
        return keyOf(p, boolMask);
    } finally {
        g.__d3d9NoBankHashCache = prev;
    }
}

/** A scripted run that dirties partial blocks, block boundaries and the integer bank. */
function runWorkload(p: Probe, observe: () => void): void {
    writeConstants(p, 0, [1, 2, 3, 4]);
    observe();
    writeConstants(p, 3, [9, 9, 9, 9]);              // mid-block
    observe();
    writeConstants(p, 4, [0.5, -0.5, 0, 1]);          // block boundary (word 16)
    observe();
    writeConstants(p, BANK_VECS - 1, [7, 7, 7, 7]);   // last block
    observe();
    writeConstants(p, 0, [1, 2, 3, 4]);               // back to a seen value
    observe();
    p.vsIntegerBits[0] = 42;
    p.vsIntegerHash.valid = false;                    // the integer setters' invalidation
    observe();
}

afterEach(() => {
    const g = globalThis as Flags;
    delete g.__d3d9NoBankHashCache;
    delete g.__d3d9VerifyBankHash;
});

describe("d3d9 constant-bank hash cache", () => {
    test("cached key matches a full recomputation at every step of a write workload", () => {
        const p = makeProbe();
        const mirror = makeProbe();
        let steps = 0;

        runWorkload(p, () => {
            const cached = keyOf(p);
            // Mirror holds identical bytes but has never cached anything, so its key is
            // computed from scratch by construction — an oracle that cannot inherit p's
            // staleness the way re-running on p alone could.
            mirror.vsConstants.set(p.vsConstants);
            mirror.vsIntegerBits.set(p.vsIntegerBits);
            expect(cached).toBe(freshKeyOf(mirror));
            steps++;
        });

        expect(steps).toBe(6);
        expect(p.bankHashMismatches).toBe(0);
    });

    test("the uncached baseline arm is content-determined too", () => {
        const a = makeProbe();
        const b = makeProbe();
        writeConstants(a, 1, [3, 1, 4, 1]);
        writeConstants(b, 1, [3, 1, 4, 1]);
        expect(uncachedKeyOf(a)).toBe(uncachedKeyOf(b));

        writeConstants(b, 1, [3, 1, 4, 2]);
        expect(uncachedKeyOf(b)).not.toBe(uncachedKeyOf(a));
    });

    test("identical content yields an identical key regardless of how it was reached", () => {
        const a = makeProbe();
        const b = makeProbe();

        writeConstants(a, 0, [1, 2, 3, 4]);
        writeConstants(a, 1, [5, 6, 7, 8]);

        // Same end state, reached by a different write order and an extra overwrite.
        writeConstants(b, 1, [0, 0, 0, 0]);
        writeConstants(b, 1, [5, 6, 7, 8]);
        writeConstants(b, 0, [1, 2, 3, 4]);

        expect(keyOf(a)).toBe(keyOf(b));
    });

    test("a changed constant changes the key", () => {
        const p = makeProbe();
        writeConstants(p, 2, [1, 1, 1, 1]);
        const before = keyOf(p);
        writeConstants(p, 2, [1, 1, 1, 2]);
        expect(keyOf(p)).not.toBe(before);
    });

    test("boolean mask and integer bank participate in the key", () => {
        const p = makeProbe();
        const base = keyOf(p, 0);
        expect(keyOf(p, 0b1011)).not.toBe(base);

        p.vsIntegerBits[5] = 123;
        p.vsIntegerHash.valid = false;
        expect(keyOf(p, 0)).not.toBe(base);
    });

    test("POSITIVE CONTROL: a write that skips invalidation is caught by the verify hook", () => {
        const g = globalThis as Flags;
        const p = makeProbe();
        writeConstants(p, 0, [1, 2, 3, 4]);
        const good = keyOf(p);

        // The bug this guards against: a new write path mutates the bank without going
        // through invalidateBankBlocks. The cache still holds the previous block hash.
        vsBits(p)[1] = 0x4048f5c3;
        expect(keyOf(p)).toBe(good);  // stale: the changed constant did not move the key

        g.__d3d9VerifyBankHash = true;
        const reported = keyOf(p);

        expect(p.bankHashMismatches).toBeGreaterThan(0);
        // The verify does not merely count: it returns the freshly recomputed key, so the
        // caller is handed the correct one rather than the stale cached one.
        expect(reported).not.toBe(good);
        const mirror = makeProbe();
        mirror.vsConstants.set(p.vsConstants);
        expect(reported).toBe(freshKeyOf(mirror));
    });

    test("POSITIVE CONTROL: the verify hook stays quiet when invalidation is honoured", () => {
        const g = globalThis as Flags;
        const p = makeProbe();
        g.__d3d9VerifyBankHash = true;
        runWorkload(p, () => { keyOf(p); });
        expect(p.bankHashMismatches).toBe(0);
    });
});
