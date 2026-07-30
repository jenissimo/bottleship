/**
 * PSX/VAG ADPCM inner-loop HLE — kernel unit tests.
 *
 * Three implementations must agree, which is what makes a one-LSB drift a test failure
 * rather than an audible artifact months later:
 *   - `decodeExact`  — the per-access transcription of the guest loop (the reference).
 *   - `decodeFast`   — the hoisted production path.
 *   - `reference()`  — written here straight from the SEMANTIC description in the
 *                      descriptor header, deliberately not from the x86 or from
 *                      kernel.ts, so a misread of the code cannot cancel out.
 *
 * Plus the two contractual oddities: the 1..27 remainder still costs a whole 28-sample
 * block and leaves `count` negative, and the filter nibble is NOT masked to 0..3.
 */

import { describe, expect, test } from 'bun:test';
import { LiveShadowView } from '../../src/worker/core/hle-lib/shadow-validator';
import {
    blocksFor,
    decodeExact,
    decodeFast,
    decodeSpans,
    isAliased,
    PSX_COEF_TABLE_X4,
    SAMPLES_PER_BLOCK,
    setCoefTable,
    ST_COUNT,
    ST_DST,
    ST_HIST1,
    ST_HIST2,
    ST_SRC,
    ST_SIZE,
} from '../../src/worker/core/hle-lib/libs/psx-adpcm/kernel';
import { __test as descriptorTest } from '../../src/worker/core/hle-lib/libs/psx-adpcm/descriptor';

const MEM = 0x20000;
const TBL = 0x1000;   // 16 filter entries, {i16,i16}
const CTX = 0x2000;
const SRC = 0x4000;
const DST = 0x8000;

/** Deterministic 32-bit LCG — the same stream for every implementation. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}

function mkMem(seed = 12345): Uint8Array {
    const mem = new Uint8Array(MEM);
    const dv = new DataView(mem.buffer);
    // The 4 canonical entries, then garbage in 4..15 — the guest indexes there when a
    // header's high nibble exceeds 3, so the tests must too.
    for (let i = 0; i < PSX_COEF_TABLE_X4.length; i++) {
        dv.setInt16(TBL + i * 4, PSX_COEF_TABLE_X4[i][0], true);
        dv.setInt16(TBL + i * 4 + 2, PSX_COEF_TABLE_X4[i][1], true);
    }
    const r = rng(seed ^ 0xbeef);
    for (let i = 4; i < 16; i++) {
        dv.setInt16(TBL + i * 4, (r() & 0xffff) - 32768, true);
        dv.setInt16(TBL + i * 4 + 2, (r() & 0xffff) - 32768, true);
    }
    return mem;
}

function setState(mem: Uint8Array, ctx: number, count: number, hist1: number, hist2: number, src: number, dst: number): void {
    const dv = new DataView(mem.buffer);
    dv.setInt32(ctx + ST_COUNT, count, true);
    dv.setInt16(ctx + ST_HIST1, hist1, true);
    dv.setInt16(ctx + ST_HIST2, hist2, true);
    dv.setUint32(ctx + ST_SRC, src, true);
    dv.setUint32(ctx + ST_DST, dst, true);
}

function readState(mem: Uint8Array, ctx: number) {
    const dv = new DataView(mem.buffer);
    return {
        count: dv.getInt32(ctx + ST_COUNT, true),
        hist1: dv.getInt16(ctx + ST_HIST1, true),
        hist2: dv.getInt16(ctx + ST_HIST2, true),
        src: dv.getUint32(ctx + ST_SRC, true),
        dst: dv.getUint32(ctx + ST_DST, true),
    };
}

/**
 * Independent reference, from the written semantics only:
 *   nib = (nibble << 28) >> shift; out = clamp((nib + h2*c2 + h1*c1) >> 8)
 * high nibble first, 14 data bytes per 15-byte block, 28 samples, `count -= 28`
 * before each block, loop while count > 0.
 */
function reference(mem: Uint8Array, ctx: number): { samples: number[]; state: ReturnType<typeof readState> } {
    const dv = new DataView(mem.buffer);
    const clamp = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
    let count = dv.getInt32(ctx + ST_COUNT, true);
    let h1 = dv.getInt16(ctx + ST_HIST1, true);
    let h2 = dv.getInt16(ctx + ST_HIST2, true);
    let src = dv.getUint32(ctx + ST_SRC, true);
    let dst = dv.getUint32(ctx + ST_DST, true);
    const samples: number[] = [];
    while (count > 0) {
        count -= SAMPLES_PER_BLOCK;
        const hdr = mem[src];
        const shift = (hdr & 0xf) + 8;
        const f = hdr >> 4;
        const c1 = dv.getInt16(TBL + f * 4, true);
        const c2 = dv.getInt16(TBL + f * 4 + 2, true);
        for (let k = 1; k <= 14; k++) {
            for (const nib of [mem[src + k] >> 4, mem[src + k] & 0xf]) {
                const t = ((nib << 28) >> shift) | 0;
                const out = clamp((((t + Math.imul(h2, c2)) | 0) + Math.imul(h1, c1)) >> 8);
                samples.push(out);
                h2 = h1; h1 = out;
            }
        }
        src += 15; dst += 56;
    }
    return { samples, state: { count, hist1: h1, hist2: h2, src, dst } };
}

/** History bookkeeping differs cosmetically between the reference (shift h1->h2) and
 *  the guest (two alternating slots); after a full pair they agree, which every block
 *  boundary is. */
function runBoth(count: number, seed: number) {
    const memA = mkMem(seed), memB = mkMem(seed), memC = mkMem(seed);
    const r = rng(seed);
    const nBytes = Math.max(15, blocksFor(count) * 15);
    for (const m of [memA, memB, memC]) {
        for (let i = 0; i < nBytes; i++) m[SRC + i] = r() & 0xff;
    }
    const r2 = rng(seed);
    for (let i = 0; i < nBytes; i++) { const v = r2() & 0xff; memA[SRC + i] = v; memB[SRC + i] = v; memC[SRC + i] = v; }
    const h1 = ((seed * 31) & 0xffff) - 32768, h2 = ((seed * 17) & 0xffff) - 32768;
    for (const m of [memA, memB, memC]) setState(m, CTX, count, h1, h2, SRC, DST);
    setCoefTable(TBL);
    const eaxA = decodeExact(new LiveShadowView(memA), CTX);
    const spans = decodeSpans(new LiveShadowView(memB), CTX, MEM)!;
    const eaxB = decodeFast(new LiveShadowView(memB), CTX, spans.blocks);
    const ref = reference(memC, CTX);
    return { memA, memB, eaxA, eaxB, ref, blocks: spans.blocks };
}

describe('blocksFor — the pre-decrement overshoot is contractual', () => {
    test('a positive remainder still costs a whole block', () => {
        expect(blocksFor(0)).toBe(0);
        expect(blocksFor(-5)).toBe(0);
        expect(blocksFor(1)).toBe(1);
        expect(blocksFor(27)).toBe(1);
        expect(blocksFor(28)).toBe(1);
        expect(blocksFor(29)).toBe(2);
        expect(blocksFor(1008)).toBe(36);
    });
});

describe('decodeExact vs decodeFast vs an independent reference', () => {
    for (const count of [28, 56, 1, 27, 29, 140, 1008, 1009]) {
        test(`count=${count}: all three agree on every sample and on the post-state`, () => {
            const { memA, memB, eaxA, eaxB, ref, blocks } = runBoth(count, count * 7 + 1);
            expect(eaxA).toBe(CTX);
            expect(eaxB).toBe(CTX);
            const bytes = blocks * 56;
            expect(Array.from(memB.slice(DST, DST + bytes))).toEqual(Array.from(memA.slice(DST, DST + bytes)));
            const dvA = new DataView(memA.buffer);
            for (let i = 0; i < ref.samples.length; i++) {
                expect(dvA.getInt16(DST + i * 2, true)).toBe(ref.samples[i]);
            }
            expect(ref.samples.length).toBe(blocks * SAMPLES_PER_BLOCK);
            const stA = readState(memA, CTX);
            expect(readState(memB, CTX)).toEqual(stA);
            expect(stA.count).toBe(ref.state.count);
            expect(stA.src).toBe(ref.state.src);
            expect(stA.dst).toBe(ref.state.dst);
            // hist1 = newest, hist2 = the one before it (the guest's two slots end a
            // block in that role; see kernel.ts).
            expect(stA.hist1).toBe(ref.state.hist1);
            expect(stA.hist2).toBe(ref.state.hist2);
        });
    }

    test('count <= 0 writes nothing and returns the state pointer', () => {
        for (const count of [0, -1, -28]) {
            const mem = mkMem(9);
            setState(mem, CTX, count, 111, -222, SRC, DST);
            const before = mem.slice(0, MEM);
            setCoefTable(TBL);
            expect(decodeExact(new LiveShadowView(mem), CTX)).toBe(CTX);
            expect(Array.from(mem)).toEqual(Array.from(before));
        }
    });

    test('a filter nibble above 3 indexes past the 4-entry table, unmasked', () => {
        const memA = mkMem(4), memC = mkMem(4);
        for (let i = 0; i < 15; i++) { const v = (i * 37 + 11) & 0xff; memA[SRC + i] = v; memC[SRC + i] = v; }
        memA[SRC] = 0xd3; memC[SRC] = 0xd3;      // filter 13, shift 3+8
        setState(memA, CTX, 28, 0, 0, SRC, DST);
        setState(memC, CTX, 28, 0, 0, SRC, DST);
        setCoefTable(TBL);
        decodeExact(new LiveShadowView(memA), CTX);
        const ref = reference(memC, CTX);
        const dv = new DataView(memA.buffer);
        for (let i = 0; i < 28; i++) expect(dv.getInt16(DST + i * 2, true)).toBe(ref.samples[i]);
        // Entry 13 is not {0,0}, so this actually exercised the out-of-range read.
        expect(PSX_COEF_TABLE_X4.length).toBe(4);
        expect(ref.samples.some(s => s !== 0)).toBe(true);
    });

    test('clamping saturates at both bounds, not modulo', () => {
        const mem = mkMem(5);
        // filter 1 ({240,0}) with the largest shift-scale and a full-negative history
        // drives the accumulator past both rails within a block.
        mem[SRC] = 0x10;
        for (let i = 1; i < 15; i++) mem[SRC + i] = 0x8f;   // nibbles 8 (=-8) and 15 (=-1)
        setState(mem, CTX, 28, -32768, -32768, SRC, DST);
        setCoefTable(TBL);
        decodeExact(new LiveShadowView(mem), CTX);
        const dv = new DataView(mem.buffer);
        const out: number[] = [];
        for (let i = 0; i < 28; i++) out.push(dv.getInt16(DST + i * 2, true));
        expect(Math.min(...out)).toBeGreaterThanOrEqual(-32768);
        expect(Math.max(...out)).toBeLessThanOrEqual(32767);
        expect(out).toContain(-32768);
    });
});

describe('aliasing', () => {
    test('destination overlapping the state struct is detected and routed to decodeExact', () => {
        const mem = mkMem(7);
        // The real caller's remainder path puts dst in a scratch that ABUTS the state
        // (this+0x14 .. this+0x4c, state at this+0x4c) — abutting must NOT read as aliased.
        setState(mem, CTX, 27, 0, 0, SRC, CTX - 56);
        const spans = decodeSpans(new LiveShadowView(mem), CTX, MEM)!;
        expect(spans.blocks).toBe(1);
        expect(isAliased(spans, CTX)).toBe(false);
        // One byte further and it does overlap.
        setState(mem, CTX, 27, 0, 0, SRC, CTX - 54);
        expect(isAliased(decodeSpans(new LiveShadowView(mem), CTX, MEM)!, CTX)).toBe(true);
    });

    test('destination overlapping the source is aliased', () => {
        const mem = mkMem(8);
        setState(mem, CTX, 28, 0, 0, SRC, SRC + 8);
        expect(isAliased(decodeSpans(new LiveShadowView(mem), CTX, MEM)!, CTX)).toBe(true);
    });

    test('a destination that writes its own loop bounds always terminates', () => {
        // dst overlapping the state means the decoded samples land on `count` and on the
        // cursors, i.e. the loop's own bounds. Every such call must return or throw one of
        // the two bound errors; a hang would be unrecoverable (no preemption inside JS).
        setCoefTable(TBL);
        const outcomes = new Set<string>();
        for (const dstOff of [0, 2, 4, 8, 0xc, -4, -16]) {
            for (const fill of [0x00, 0x1f, 0x7f, 0x88, 0xff]) {
                for (const count of [28, 28 * 4, 27]) {
                    const mem = mkMem(11);
                    for (let i = 0; i < 15 * 8; i++) mem[SRC + i] = fill;
                    setState(mem, CTX, count, 0, 0, SRC, CTX + dstOff);
                    try {
                        decodeExact(new LiveShadowView(mem), CTX);
                        outcomes.add('returned');
                    } catch (e) {
                        expect(String(e)).toMatch(/outran its (block|sample count)/);
                        outcomes.add('threw');
                    }
                }
            }
        }
        // Both outcomes must be reachable, or the bound is not doing anything.
        expect(outcomes.has('returned')).toBe(true);
        expect(outcomes.has('threw')).toBe(true);
    });

    test('out-of-envelope pointers yield no spans at all', () => {
        const mem = mkMem(10);
        setState(mem, CTX, 28, 0, 0, MEM - 4, DST);
        expect(decodeSpans(new LiveShadowView(mem), CTX, MEM)).toBeNull();
        setState(mem, CTX, 28, 0, 0, SRC, MEM - 4);
        expect(decodeSpans(new LiveShadowView(mem), CTX, MEM)).toBeNull();
        expect(decodeSpans(new LiveShadowView(mem), 0x10, MEM)).toBeNull();
    });
});

describe('descriptor', () => {
    test('pattern and mask are the same length and wildcard exactly the two disp32s', () => {
        const { DECODER_PATTERN, DECODER_MASK, COEF_DISP_LO, COEF_DISP_HI } = descriptorTest;
        expect(DECODER_MASK.length).toBe(DECODER_PATTERN.length);
        expect(DECODER_PATTERN.length).toBe(0x40);
        const wild = [...DECODER_MASK].map((c, i) => (c === 'x' ? -1 : i)).filter(i => i >= 0);
        expect(wild).toEqual([
            COEF_DISP_LO, COEF_DISP_LO + 1, COEF_DISP_LO + 2, COEF_DISP_LO + 3,
            COEF_DISP_HI, COEF_DISP_HI + 1, COEF_DISP_HI + 2, COEF_DISP_HI + 3,
        ]);
        // The wildcards sit right after the two `0F BF /r SIB` heads, which stay exact.
        expect(Array.from(DECODER_PATTERN.slice(COEF_DISP_LO - 4, COEF_DISP_LO))).toEqual([0x0f, 0xbf, 0x2c, 0x95]);
        expect(Array.from(DECODER_PATTERN.slice(COEF_DISP_HI - 4, COEF_DISP_HI))).toEqual([0x0f, 0xbf, 0x1c, 0x95]);
    });

    test('the declared prologue length is a valid, position-independent boundary', async () => {
        const { validatePrologueBytes } = await import('../../src/worker/core/hle-lib/lib-patcher');
        const { DECODER_PATTERN, PROLOGUE_LEN } = descriptorTest;
        expect(validatePrologueBytes(DECODER_PATTERN.slice(0, PROLOGUE_LEN))).toBeNull();
        // 4 would split `sub esp,8`; anything shorter cannot hold the JMP.
        expect(validatePrologueBytes(DECODER_PATTERN.slice(0, 5))).not.toBeNull();
    });

    test('overlapping state and destination collapse into one comparison range', () => {
        const { spansToRanges } = descriptorTest;
        expect(spansToRanges(CTX, { addr: DST, len: 56 })).toEqual([{ addr: CTX, len: ST_SIZE }, { addr: DST, len: 56 }]);
        expect(spansToRanges(CTX, { addr: CTX - 56, len: 56 })).toEqual([{ addr: CTX, len: ST_SIZE }, { addr: CTX - 56, len: 56 }]);
        // dst swallows the state entirely — the union is just dst.
        expect(spansToRanges(CTX, { addr: CTX - 8, len: 56 })).toEqual([{ addr: CTX - 8, len: 56 }]);
        // dst ends inside the state — the union stretches to the state's end.
        expect(spansToRanges(CTX, { addr: CTX - 48, len: 56 })).toEqual([{ addr: CTX - 48, len: 48 + ST_SIZE }]);
        expect(spansToRanges(CTX, { addr: DST, len: 0 })).toEqual([{ addr: CTX, len: ST_SIZE }]);
    });
});
