/**
 * 4-bit ADPCM block decoder with a two-tap predictor — the PSX/VAG filter family.
 * Pure and dependency-free so `bun test` can import it.
 *
 * SEMANTICS, read off the guest code (Core.dll 0x1017ab80, see descriptor.ts for the
 * disassembly walk). One 28-sample block is 15 bytes: a header byte carrying
 * `filter = hdr >> 4` and `shift = (hdr & 0xf) + 8`, then 14 data bytes, high nibble
 * first. Per sample:
 *
 *   nib   = (nibble << 28) >> shift          // sign-extended, scaled; NOT truncated to 16 bits
 *   acc   = nib + hist2 * coef2 + hist1 * coef1     // int32 wrap-around adds
 *   out   = clamp(acc >> 8, -32768, 32767)          // arithmetic shift, then signed clamp
 *
 * `coef1/coef2` are the two int16s at `coefTable + filter*4`. The scale is 256 (the
 * canonical PSX table times four), which is why the post-shift is 8 rather than 6.
 *
 * Two things the code does that a textbook decoder does not, and that must be
 * reproduced rather than tidied:
 *   - `filter` is a FULL nibble and is never masked, so 4..15 index past the 4-entry
 *     table into whatever follows it in .data. The table is therefore read from guest
 *     memory at the address baked into the guest instruction, never hardcoded here.
 *   - the sample count is decremented by 28 BEFORE each block and the loop only tests
 *     `> 0`, so a count of 1..27 still decodes a whole 28-sample block (the caller
 *     relies on this: it passes the remainder and catches the overshoot in a 56-byte
 *     scratch buffer).
 */

import type { ShadowView } from '../../types';

/** State struct field offsets — established from the caller (descriptor.ts). */
export const ST_COUNT = 0x00;  // i32 samples remaining
export const ST_HIST1 = 0x04;  // i16 most recent decoded sample
export const ST_HIST2 = 0x06;  // i16 the one before it
export const ST_SRC = 0x08;    // u8*  compressed cursor
export const ST_DST = 0x0c;    // i16* output cursor
export const ST_SIZE = 0x10;

export const SAMPLES_PER_BLOCK = 28;
export const SRC_BYTES_PER_BLOCK = 15;
export const DST_BYTES_PER_BLOCK = SAMPLES_PER_BLOCK * 2;

/** The canonical 4-filter PSX/VAG table, times four (the guest's 256 scale). */
export const PSX_COEF_TABLE_X4: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [240, 0], [460, -208], [392, -220],
];

/** Blocks a call decodes: the count is pre-decremented, so any positive remainder
 *  costs a full block. */
export function blocksFor(count: number): number {
    return count > 0 ? Math.ceil(count / SAMPLES_PER_BLOCK) : 0;
}

const clamp16 = (v: number): number => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

const si16 = (view: ShadowView, addr: number): number => (view.readU16(addr) << 16) >> 16;
const si32 = (view: ShadowView, addr: number): number => view.readU32(addr) | 0;

/**
 * Where the guest's two `movsx ..., word [edx*4 + disp32]` read their coefficients.
 * Extracted from the live image at detection time — see descriptor.ts.
 *
 * Keyed by the DECODER'S OWN ENTRY, not held as a module-level singleton: this codec is
 * routinely statically linked into more than one module of a process, and each copy has its
 * own relocated table. One shared slot would leave the first copy decoding through the
 * second's table.
 */
const coefTables = new Map<number, number>();
export const setCoefTable = (decoderEntry: number, addr: number): void => {
    coefTables.set(decoderEntry >>> 0, addr >>> 0);
};
export const getCoefTable = (decoderEntry: number): number => coefTables.get(decoderEntry >>> 0) ?? 0;
export const getCoefTables = (): Array<[number, number]> => Array.from(coefTables.entries());
export const clearCoefTables = (): void => { coefTables.clear(); };

export interface AdpcmSpan { addr: number; len: number }

/** Grow-only decode scratch: this runs at ~1k calls/s of ~1k samples each, so the
 *  buffer is reused rather than allocated per call (§3.1). */
let scratch = new Int16Array(0);
function scratchFor(samples: number): Int16Array {
    if (scratch.length < samples) scratch = new Int16Array(Math.max(samples, 2048));
    return scratch;
}

/** The spans a call touches, from the pre-call state. `null` when the pointers or the
 *  count fall outside the modelled envelope. */
export function decodeSpans(view: ShadowView, ctx: number, memLength: number): {
    count: number; blocks: number; src: AdpcmSpan; dst: AdpcmSpan;
} | null {
    if (ctx < 0x1000 || ctx + ST_SIZE > memLength) return null;
    const count = si32(view, ctx + ST_COUNT);
    const blocks = blocksFor(count);
    const src = { addr: view.readU32(ctx + ST_SRC), len: blocks * SRC_BYTES_PER_BLOCK };
    const dst = { addr: view.readU32(ctx + ST_DST), len: blocks * DST_BYTES_PER_BLOCK };
    if (blocks === 0) return { count, blocks, src, dst };
    // A pointer this far out is not a decode we model; the guest's own code would
    // fault on it and only the guest can raise that fault.
    if (src.addr < 0x1000 || src.addr + src.len > memLength) return null;
    if (dst.addr < 0x1000 || dst.addr + dst.len > memLength) return null;
    return { count, blocks, src, dst };
}

const overlaps = (a: AdpcmSpan, b: AdpcmSpan): boolean =>
    a.len > 0 && b.len > 0 && a.addr < b.addr + b.len && b.addr < a.addr + a.len;

/** True when the destination overlaps the source or the state struct. Such a call is
 *  still decoded exactly, but only by the per-access path — hoisting state into locals
 *  is observably different when a sample store can land on the state itself. */
export function isAliased(spans: { src: AdpcmSpan; dst: AdpcmSpan }, ctx: number): boolean {
    return overlaps(spans.dst, spans.src) || overlaps(spans.dst, { addr: ctx, len: ST_SIZE });
}

/**
 * Per-access transcription of the guest loop: every read and write goes through the
 * view in the guest's order and width, so aliasing between dst, src and the state
 * struct resolves exactly as it does on the CPU. This is the reference; `decodeFast`
 * is an optimisation of it that only applies when nothing aliases.
 */
export function decodeExact(view: ShadowView, ctx: number, coefTable: number): number {
    let count = si32(view, ctx + ST_COUNT);
    // Both loop bounds live in memory the loop can itself write when the destination
    // aliases the state, so they are capped at the structurally correct counts. Exceeding
    // one means the destination is steering the loop; that throws, which hands the call
    // back to the guest — the alternative is a JS loop the scheduler cannot preempt.
    let blocksLeft = blocksFor(count) + 1;
    while (count > 0) {
        if (--blocksLeft < 0) throw new Error('psx-adpcm: block loop outran its sample count');
        const src = view.readU32(ctx + ST_SRC);
        count = (count - SAMPLES_PER_BLOCK) | 0;
        view.writeU32(ctx + ST_COUNT, count);
        const dst = view.readU32(ctx + ST_DST);
        const hdr = view.readU8(src);
        const shift = (hdr & 0xf) + 8;
        const coef1 = si16(view, coefTable + (hdr >> 4) * 4);
        const coef2 = si16(view, coefTable + (hdr >> 4) * 4 + 2);
        const end = (dst + DST_BYTES_PER_BLOCK) >>> 0;
        let p = (src + 1) >>> 0;
        view.writeU32(ctx + ST_SRC, p);
        // `cmp edi, ecx / jae` — only an address-space wrap can take this branch, but
        // the comparison is unsigned and so is reproduced as such.
        let cur = dst >>> 0;
        let nibblePairs = SRC_BYTES_PER_BLOCK - 1;
        while (cur < end) {
            if (--nibblePairs < 0) throw new Error('psx-adpcm: sample loop outran its block');
            const b = view.readU8(p);
            let acc = ((b >> 4) << 28) >> shift;
            acc = (acc + Math.imul(si16(view, ctx + ST_HIST2), coef2)) | 0;
            acc = (acc + Math.imul(si16(view, ctx + ST_HIST1), coef1)) | 0;
            const out1 = clamp16(acc >> 8);
            view.writeU16(view.readU32(ctx + ST_DST), out1 & 0xffff);
            const srcAgain = view.readU32(ctx + ST_SRC);
            view.writeU16(ctx + ST_HIST2, out1 & 0xffff);
            const b2 = view.readU8(srcAgain);
            let acc2 = (b2 << 28) >> shift;
            acc2 = (acc2 + Math.imul(out1, coef1)) | 0;
            acc2 = (acc2 + Math.imul(si16(view, ctx + ST_HIST1), coef2)) | 0;
            const out2 = clamp16(acc2 >> 8);
            view.writeU16((view.readU32(ctx + ST_DST) + 2) >>> 0, out2 & 0xffff);
            const nextSrc = (view.readU32(ctx + ST_SRC) + 1) >>> 0;
            const nextDst = (view.readU32(ctx + ST_DST) + 4) >>> 0;
            view.writeU16(ctx + ST_HIST1, out2 & 0xffff);
            view.writeU32(ctx + ST_SRC, nextSrc);
            view.writeU32(ctx + ST_DST, nextDst);
            p = nextSrc;
            cur = nextDst;
        }
        count = si32(view, ctx + ST_COUNT);
    }
    return ctx >>> 0;
}

/**
 * Hoisted decoder for the non-aliased case: the state struct and the cursors live in
 * locals for the whole call and the block's 15 source bytes are fetched once, so the
 * per-sample cost is arithmetic plus one store. Identical to `decodeExact` by
 * construction — the loop reads only the source and the state fields it tracks, and
 * never reads the destination.
 */
export function decodeFast(view: ShadowView, ctx: number, blocks: number, coefTable: number): number {
    let count = si32(view, ctx + ST_COUNT);
    let src = view.readU32(ctx + ST_SRC);
    let dst = view.readU32(ctx + ST_DST);
    let hist1 = si16(view, ctx + ST_HIST1);
    let hist2 = si16(view, ctx + ST_HIST2);
    // The whole compressed span at once: it is read-only here, so one view crossing for
    // the call rather than one per block.
    const bytes = view.readBytes(src, blocks * SRC_BYTES_PER_BLOCK);
    const out = scratchFor(blocks * SAMPLES_PER_BLOCK);
    const dstBase = dst;
    let o = 0;
    let bo = 0;
    while (count > 0) {
        count = (count - SAMPLES_PER_BLOCK) | 0;
        const hdr = bytes[bo];
        const shift = (hdr & 0xf) + 8;
        const coef1 = si16(view, coefTable + (hdr >> 4) * 4);
        const coef2 = si16(view, coefTable + (hdr >> 4) * 4 + 2);
        for (let k = 1; k <= 14; k++) {
            const b = bytes[bo + k];
            let acc = ((b >> 4) << 28) >> shift;
            acc = (acc + Math.imul(hist2, coef2)) | 0;
            acc = (acc + Math.imul(hist1, coef1)) | 0;
            const s1 = clamp16(acc >> 8);
            out[o++] = s1;
            let acc2 = (b << 28) >> shift;
            acc2 = (acc2 + Math.imul(s1, coef1)) | 0;
            acc2 = (acc2 + Math.imul(hist1, coef2)) | 0;
            const s2 = clamp16(acc2 >> 8);
            out[o++] = s2;
            hist2 = s1;
            hist1 = s2;
        }
        bo += SRC_BYTES_PER_BLOCK;
        src = (src + SRC_BYTES_PER_BLOCK) >>> 0;
        dst = (dst + DST_BYTES_PER_BLOCK) >>> 0;
    }
    view.writeBytes(dstBase, new Uint8Array(out.buffer, 0, o * 2));
    view.writeU32(ctx + ST_COUNT, count);
    view.writeU16(ctx + ST_HIST1, hist1 & 0xffff);
    view.writeU16(ctx + ST_HIST2, hist2 & 0xffff);
    view.writeU32(ctx + ST_SRC, src);
    view.writeU32(ctx + ST_DST, dst);
    return ctx >>> 0;
}

/** How much audio the hook actually decodes, so the profile's instruction share can be
 *  read against a sample rate. Surfaced as `globalThis.__psxAdpcmStats()`. */
export const adpcmCounters = {
    calls: 0, blocks: 0, samples: 0, aliasedCalls: 0, emptyCalls: 0,
    reset(): void { this.calls = 0; this.blocks = 0; this.samples = 0; this.aliasedCalls = 0; this.emptyCalls = 0; },
};

/** The ShadowSpec kernel: picks the exact path when anything aliases, the hoisted one
 *  otherwise. Throws when the call is outside the modelled envelope — the framework
 *  treats that as "our ABI model is wrong" and hands the function back to the guest. */
export function adpcmKernel(view: ShadowView, args: number[], memLength: number, decoderEntry: number): number {
    const ctx = args[0] >>> 0;
    const spans = decodeSpans(view, ctx, memLength);
    if (spans === null) {
        throw new Error(`psx-adpcm: state 0x${ctx.toString(16)} outside the modelled envelope`);
    }
    const coefTable = getCoefTable(decoderEntry);
    adpcmCounters.calls++;
    if (spans.blocks === 0) { adpcmCounters.emptyCalls++; return decodeExact(view, ctx, coefTable); }
    adpcmCounters.blocks += spans.blocks;
    adpcmCounters.samples += spans.blocks * SAMPLES_PER_BLOCK;
    if (coefTable === 0) {
        throw new Error(`psx-adpcm: no coefficient table for decoder 0x${(decoderEntry >>> 0).toString(16)}`);
    }
    if (isAliased(spans, ctx)) { adpcmCounters.aliasedCalls++; return decodeExact(view, ctx, coefTable); }
    return decodeFast(view, ctx, spans.blocks, coefTable);
}
