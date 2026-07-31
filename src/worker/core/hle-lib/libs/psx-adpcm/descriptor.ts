/**
 * 4-bit ADPCM block decoder (PSX/VAG two-tap filter family) — Guarded Inner-Loop HLE
 * descriptor. Found statically linked into the Unreal Engine Core.dll shipped with
 * Harry Potter: Chamber of Secrets; the hook keys on the codec's own bytes, so any
 * image carrying this decoder is covered and none is named.
 *
 * It qualifies under §3.8: a pure-compute leaf with no calls and no state beyond its one
 * argument is exactly the shape that section sanctions. It is kept for being byte-exact,
 * self-validating and free when idle — not for a measured speedup (see
 * plan/hle-lib-measurements.md).
 *
 * THE FUNCTION (Core.dll static VA 0x1017ab80 .. 0x1017acab, cdecl, one argument,
 * `ret` with no immediate, ZERO calls in the body):
 *
 *   void* decode(State* st)        // returns st: EAX holds the argument throughout
 *
 *   State { i32 count; i16 hist1; i16 hist2; u8* src; i16* dst; }   // 16 bytes
 *
 * The layout is not inferred from the decoder alone — the caller pins every field. The
 * state is embedded in an audio-stream object at `this+0x4c`, preceded by a 56-byte
 * (28-sample) partial-block scratch at `this+0x14` that abuts it exactly:
 *   0x1017acd0  ctor zeroes this+0/4/8 and the two i16 at this+0x50/0x52 -> hist1/hist2
 *   0x1017acf0  stores the compressed pointer to this+0x54                -> src
 *   0x1017ad30  the streaming read: divides the request by 28 (imul 0x92492493, sar 4),
 *               calls the decoder once for `blocks*28` samples straight into the
 *               caller's buffer, then once more for the 1..27 remainder with dst
 *               pointing at the this+0x14 scratch, and reads `count` BACK afterwards
 *               to find how many samples it over-decoded.
 * That last part is why the overshoot is contractual: `count` is decremented by 28
 * before each block and the loop only tests `> 0`, so a remainder of 1..27 still
 * produces a whole 28-sample block and leaves `count` negative. The kernel reproduces
 * both the overshoot and the exact final `count`.
 *
 * Per-sample math, clamp bounds and shift order are transcribed in kernel.ts.
 *
 * DETECTION is byte-exact on the function's own first 64 bytes, with only the two
 * relocated coefficient-table disp32s wildcarded. That is also the identification: the
 * table address is read out of the matched instruction (`0F BF 2C 95 disp32`) and its
 * first four entries are checked against the canonical PSX/VAG filter set times four —
 * {0,0},{240,0},{460,-208},{392,-220}. A table that does not match is a different
 * codec wearing a similar loop, so the resolver refuses to hook rather than guess.
 * Nothing here keys on a module name, an image base or a title.
 */

import { Logger, LogCategory } from '../../../logger';
import { Mem } from '../../../memory/mem-accessor';
import type {
    HookedFunctionMatch,
    LibDescriptor,
    ResolverModuleView,
    ShadowSpec,
    ShadowView,
} from '../../types';
import {
    adpcmCounters,
    adpcmKernel,
    clearCoefTables,
    decodeSpans,
    getCoefTables,
    isAliased,
    PSX_COEF_TABLE_X4,
    setCoefTable,
    ST_SIZE,
    type AdpcmSpan,
} from './kernel';

const FN = 'adpcm_decode_blocks';

function hexPattern(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/**
 * First 64 bytes, byte-exact from the shipped image and verified instruction by
 * instruction. Relative branch displacements are load-base independent and stay
 * must-match; only the two absolute table pointers are wildcarded, because
 * applyRelocations rewrites them.
 *
 *   +00 8b442404  mov eax,[esp+4]          ; State*
 *   +04 83ec08    sub esp,8                ; (prologue ends here: 7 bytes)
 *   +07 8b08      mov ecx,[eax]            ; count
 *   +09 85c9      test ecx,ecx
 *   +0b 0f8e...   jle epilogue
 *   +11 53555657  push ebx/ebp/esi/edi
 *   +15 8b7008    mov esi,[eax+8]          ; src
 *   +18 83c1e4    add ecx,-0x1c            ; count -= 28
 *   +1b 8908      mov [eax],ecx
 *   +1d 8b780c    mov edi,[eax+0xc]        ; dst
 *   +20 33c9      xor ecx,ecx
 *   +22 8a0e      mov cl,[esi]             ; header byte
 *   +24 8bd1      mov edx,ecx
 *   +26 83e10f    and ecx,0xf
 *   +29 c1ea04    shr edx,4                ; filter nibble (unmasked)
 *   +2c 83c108    add ecx,8                ; shift = (hdr&0xf)+8
 *   +2f 0fbf2c95 <disp32>  movsx ebp,word [edx*4+coefTable]
 *   +37 0fbf1c95 <disp32>  movsx ebx,word [edx*4+coefTable+2]
 *   +3f 89        (mov [esp+0x1c],ecx)
 */
const DECODER_PATTERN = hexPattern(
    '8b44240483ec088b0885c90f8e17010000535556578b700883c1e489088b780c'
    + '33c98a0e8bd183e10fc1ea0483c1080fbf2c95000000000fbf1c950000000089');
const DECODER_MASK =
    'x'.repeat(0x33) + '????' + 'xxxx' + '????' + 'x';

/** Offsets of the two coefficient-table disp32s inside the pattern. */
const COEF_DISP_LO = 0x33;
const COEF_DISP_HI = 0x3b;
const PROLOGUE_LEN = 7;      // mov eax,[esp+4] ; sub esp,8 — instruction boundary

/**
 * Resolve the entry and, on the same pass, confirm the codec by its table. Discovery
 * lives here rather than in `entryProbe` so that a table mismatch can REFUSE the hook
 * instead of installing one whose arithmetic was never confirmed.
 */
function resolveDecoder(view: ResolverModuleView): HookedFunctionMatch[] {
    const hit = view.signatureHits.find(h => h.signatureId === FN);
    if (!hit) return [];
    const entry = hit.address;

    const lo = Mem.readUint32(entry + COEF_DISP_LO);
    const hi = Mem.readUint32(entry + COEF_DISP_HI);
    if (lo === null || hi === null) {
        Logger.warn(LogCategory.SYSTEM,
            `[psx-adpcm] ${view.module.name}: cannot read the table pointers at 0x${entry.toString(16)} — refusing to hook`);
        return [];
    }
    if (hi !== lo + 2) {
        Logger.warn(LogCategory.SYSTEM,
            `[psx-adpcm] ${view.module.name}: table pointers at 0x${entry.toString(16)} are not a `
            + `{i16,i16} pair (0x${lo.toString(16)} / 0x${hi.toString(16)}) — refusing to hook`);
        return [];
    }
    for (let i = 0; i < PSX_COEF_TABLE_X4.length; i++) {
        const a = Mem.readInt16(lo + i * 4);
        const b = Mem.readInt16(lo + i * 4 + 2);
        const [wantA, wantB] = PSX_COEF_TABLE_X4[i];
        if (a !== wantA || b !== wantB) {
            Logger.warn(LogCategory.SYSTEM,
                `[psx-adpcm] ${view.module.name}: filter table at 0x${lo.toString(16)} entry ${i} is `
                + `{${a},${b}}, expected {${wantA},${wantB}} — a different codec, refusing to hook`);
            return [];
        }
    }
    setCoefTable(entry, lo);
    Logger.log(LogCategory.SYSTEM,
        `[psx-adpcm] ${view.module.name}: decoder 0x${entry.toString(16)}, `
        + `PSX/VAG filter table 0x${lo.toString(16)} confirmed`);
    return [{ name: FN, address: entry }];
}

/** Merge the state span into the destination span when they overlap, so a scratch
 *  overlay never has two copies of the same byte to disagree about. */
function spansToRanges(ctx: number, dst: AdpcmSpan): AdpcmSpan[] {
    const st = { addr: ctx, len: ST_SIZE };
    if (dst.len === 0) return [st];
    if (dst.addr < st.addr + st.len && st.addr < dst.addr + dst.len) {
        const lo = Math.min(dst.addr, st.addr);
        const hi = Math.max(dst.addr + dst.len, st.addr + st.len);
        return [{ addr: lo, len: hi - lo }];
    }
    return [st, dst];
}

const memLength = (): number => Mem.getView()?.length ?? 0;

const shadow: ShadowSpec = {
    // The original runs through the trampoline for the first n calls and stays
    // authoritative; a single differing byte or a differing EAX permanently unpatches.
    // A pure leaf with no calls is the ideal shape for this round trip.
    validateInGame: true,
    // A call carries a few hundred blocks (~11k samples observed), so n=64 compares
    // ~700k samples byte-for-byte against the guest's own decoder before going live —
    // a one-LSB drift shows on the first block it occurs in, not after a long stream.
    n: 64,
    guard(args, view) {
        const spans = decodeSpans(view, args[0] >>> 0, memLength());
        if (spans === null) return false;
        return spans.count <= 1 << 20;
    },
    ranges(args, view) {
        const ctx = args[0] >>> 0;
        const spans = decodeSpans(view, ctx, memLength());
        if (spans === null) return [];
        return spansToRanges(ctx, spans.dst);
    },
    kernel: (view: ShadowView, args: number[], site) => adpcmKernel(view, args, memLength(), site.targetAddress),
};

export const psxAdpcmDescriptor: LibDescriptor = {
    id: 'psx-adpcm',
    displayName: 'PSX/VAG 4-bit ADPCM block decoder (inner-loop HLE)',
    minConfidence: 12,
    signatures: {
        [FN]: {
            kind: 'bytes',
            pattern: DECODER_PATTERN,
            mask: DECODER_MASK,
            section: '.text',
            weight: 12,
        },
    },
    functions: {
        [FN]: {
            name: FN,
            // Discovery + codec confirmation happen together in resolveDecoder so a
            // table mismatch can refuse; the probe is never consulted.
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 1,
            required: false,
            prologueLen: PROLOGUE_LEN,
            shadow,
        },
    },
    handlers: {},
    resolveAdditionalFunctions: resolveDecoder,
    onActivated() {
        // How much audio the title actually asks for — the denominator any instruction-share
        // claim has to be read against. `aliasedCalls` should stay 0: a non-zero count means
        // content exists that the hoisted path must not serve.
        (globalThis as Record<string, unknown>).__psxAdpcmStats = () => ({
            ...adpcmCounters,
            coefTables: getCoefTables().map(([entry, table]) =>
                `0x${entry.toString(16)}→0x${table.toString(16)}`),
        });
    },
    onReset() {
        clearCoefTables();
        adpcmCounters.reset();
    },
};

export const __test = { DECODER_PATTERN, DECODER_MASK, COEF_DISP_LO, COEF_DISP_HI, PROLOGUE_LEN, spansToRanges, isAliased };
