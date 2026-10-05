/**
 * Statically-linked zlib 1.1.x — Guarded Inner-Loop HLE descriptor.
 *
 * Hooks the one-shot `uncompress(dest, destLen, source, sourceLen)`: its whole
 * contract is its four arguments, which is exactly the shape §3.8 sanctions for
 * whole-function replacement. `inflate` itself is deliberately NOT a target —
 * it is the stateful half.
 *
 * Reading a shadow mismatch report:
 *   kind 'eax'   — the two disagree on the verdict. Ours 0 / guest negative
 *                  means the bytes were fine and the guest's execution was not.
 *   kind 'bytes' — same verdict, different output. On a shared FAILURE verdict
 *                  this is expected noise (zlib flushes its 32 KiB window in
 *                  chunks, so its partial output need not equal ours); the
 *                  kernel's own [zlib-hle] log line for that call states our
 *                  verdict and where it stopped. On a shared SUCCESS verdict it
 *                  means the kernel is wrong.
 *
 * DETECTION. Anchored on zlib's own `inflate_copyright` / `deflate_copyright`
 * arrays — the standard fingerprint for a statically linked zlib, and the only
 * thing in the image that names the library. Scoped to the 1.1 series because
 * that is the `uncompress` body verified below; 1.2.x is shaped the same but
 * unverified, and the 1.2.9+ rewrite loops over >4 GiB spans.
 *
 * ADDRESS RESOLUTION. `uncompress` has no string of its own, so a prologue
 * pattern would be one compiler's encoding. Instead the resolver chases
 * structure that survives codegen: the ZLIB_VERSION C string is pushed, and
 * three bytes of the call sequence pin which of its users this is —
 *   inflateInit_(strm, version, 0x38)   3 cdecl args → ADD ESP,0x0C
 *   inflate(strm, Z_FINISH=4)           2 cdecl args → ADD ESP,0x08, preceded by PUSH 4
 *   inflateEnd(strm)                    1 cdecl arg  → ADD ESP,0x04
 * `compress` is the near-twin and is excluded by the first line alone: it calls
 * deflateInit_, which takes a level argument and so cleans 0x10. The resolver
 * refuses to hook when more than one candidate survives.
 *
 * ABI, read off the disassembly rather than assumed: `uncompress` opens with
 * `SUB ESP,0x38` + `MOV ECX,[ESP+0x48]` (a 7-byte prologue, no frame pointer), and the
 * argument loads are [ESP+0x3c]→next_out, [ESP+0x40]→destLen, [ESP+0x44]→next_in,
 * [ESP+0x48]→avail_in, into a 0x38-byte z_stream. `inflateInit_` tail-calls
 * inflateInit2_(strm, 15, version, 0x38); `inflateEnd` returns Z_STREAM_ERROR when
 * state/zfree are NULL.
 */

import { inflateZlibSync } from '@bottleship/formats/zip/inflate';
import { Logger, LogCategory } from '../../../logger';
import { Mem } from '../../../memory/mem-accessor';
import { backtrackToPrologue, findImmediatesInSection } from '../../lib-detector';
import type {
    HookedFunctionMatch,
    LibDescriptor,
    ResolverModuleView,
    ShadowSpec,
} from '../../types';
import {
    MAX_SPAN,
    uncompressGuard,
    uncompressKernel,
    uncompressRanges,
    type UncompressTrace,
} from './kernel';

type Mode = 'off' | 'shadow' | 'live';

/**
 * Opt-in, and how: `setWorkerFlag('__zlibHle', 'shadow' | 'live')` BEFORE the
 * bundle loads (detection runs at PE load). Default OFF — this hook is a
 * diagnostic first, and its sync-original path (allowGuestImports, below) has
 * not been exercised in-game, so it must not arm itself under every title that
 * happens to link zlib.
 *   shadow — the guest's uncompress stays authoritative; ours is compared.
 *   live   — ours answers; the guest's code never runs.
 */
function mode(): Mode {
    const flag = (globalThis as Record<string, unknown>).__zlibHle;
    if (flag === 'live') return 'live';
    if (flag === true || flag === 'shadow') return 'shadow';
    return 'off';
}

// Body window scanned when shape-checking a candidate. Generous enough for the
// MSVC and GCC codegen of a ~40-line function; over-reading into the next
// function can only produce a false accept, which the shadow guard catches.
const BODY_WINDOW = 0x140;

/** Find `ADD ESP, imm8` with the given immediate within `window` bytes of `from`. */
function hasCleanup(bytes: Uint8Array, from: number, window: number, imm: number): boolean {
    const end = Math.min(bytes.length - 3, from + window);
    for (let p = from; p <= end; p++) {
        if (bytes[p] === 0x83 && bytes[p + 1] === 0xc4 && bytes[p + 2] === imm) return true;
    }
    return false;
}

/** `E8 rel32` sites inside [from, from+window) whose cdecl cleanup is `imm`. */
function callsWithCleanup(bytes: Uint8Array, from: number, window: number, imm: number): number[] {
    const out: number[] = [];
    const end = Math.min(bytes.length - 5, from + window);
    for (let p = from; p <= end; p++) {
        if (bytes[p] !== 0xe8) continue;
        if (hasCleanup(bytes, p + 5, 16, imm)) out.push(p);
    }
    return out;
}

function callTarget(bytes: Uint8Array, base: number, p: number): number {
    const rel = (bytes[p + 1] | (bytes[p + 2] << 8) | (bytes[p + 3] << 16) | (bytes[p + 4] << 24)) | 0;
    return (base + p + 5 + rel) >>> 0;
}

/** `PUSH imm8` of the given value anywhere in the window. */
function hasPushImm8(bytes: Uint8Array, from: number, window: number, imm: number): boolean {
    const end = Math.min(bytes.length - 2, from + window);
    for (let p = from; p <= end; p++) {
        if (bytes[p] === 0x6a && bytes[p + 1] === imm) return true;
    }
    return false;
}

interface Candidate {
    entry: number;
    inflateInit: number;
    inflate: number;
    inflateEnd: number;
}

/**
 * Confirm a function body is zlib's `uncompress`: it sets up a 0x38-byte
 * z_stream, drives inflate to Z_FINISH, and tears down — three calls whose
 * cdecl cleanups are 0x0C / 0x08 / 0x04 respectively.
 */
function classify(bytes: Uint8Array, base: number, entryOff: number): Candidate | null {
    if (!hasPushImm8(bytes, entryOff, BODY_WINDOW, 0x38)) return null;

    const initCalls = callsWithCleanup(bytes, entryOff, BODY_WINDOW, 0x0c);
    if (initCalls.length !== 1) return null;

    const finishCalls = callsWithCleanup(bytes, entryOff, BODY_WINDOW, 0x08)
        .filter(p => hasPushImm8(bytes, Math.max(entryOff, p - 8), 8, 0x04));
    if (finishCalls.length !== 1) return null;

    const initTarget = callTarget(bytes, base, initCalls[0]);
    const inflateTarget = callTarget(bytes, base, finishCalls[0]);
    // A cleanup search window wide enough for the codegen between a call and
    // its ADD ESP also sees the NEXT call's cleanup, so identify inflateEnd by
    // what it is not rather than by position.
    const endCalls = callsWithCleanup(bytes, entryOff, BODY_WINDOW, 0x04)
        .map(p => callTarget(bytes, base, p))
        .filter(t => t !== initTarget && t !== inflateTarget);
    if (endCalls.length === 0) return null;

    return {
        entry: base + entryOff,
        inflateInit: initTarget,
        inflate: inflateTarget,
        inflateEnd: endCalls[0],
    };
}

/** Absolute addresses of standalone "1.<n>.<n>" C strings in `.rdata`. */
function versionStrings(bytes: Uint8Array, base: number): number[] {
    const out: number[] = [];
    for (let i = 1; i + 6 < bytes.length; i++) {
        if (bytes[i] !== 0x31 || bytes[i + 1] !== 0x2e || bytes[i - 1] !== 0) continue;
        let j = i + 2;
        let dots = 1;
        let digits = 0;
        while (j < i + 12) {
            const c = bytes[j];
            if (c >= 0x30 && c <= 0x39) { digits++; j++; continue; }
            if (c === 0x2e) { dots++; j++; continue; }
            break;
        }
        if (bytes[j] === 0 && dots === 2 && digits >= 2) out.push(base + i);
    }
    return out;
}

function resolveUncompress(view: ResolverModuleView): HookedFunctionMatch[] {
    if (mode() === 'off') {
        Logger.log(LogCategory.SYSTEM,
            `[HLE-lib] zlib detected in ${view.module.name} but NOT armed — ` +
            `setWorkerFlag('__zlibHle', 'shadow') before the load to enable the differential`);
        return [];
    }
    const text = view.getSection('.text');
    const rdata = view.getSection('.rdata');
    if (!text || !rdata) return [];

    const module = view.module;
    const textBase = module.baseAddress + text.virtualAddress;
    const rdataBase = module.baseAddress + rdata.virtualAddress;
    const textBytes = Mem.readBytes(textBase, text.virtualSize);
    const rdataBytes = Mem.readBytes(rdataBase, rdata.virtualSize);
    if (!textBytes || !rdataBytes) {
        Logger.warn(LogCategory.SYSTEM, `[HLE-lib] zlib: .text/.rdata unreadable in ${module.name}`);
        return [];
    }

    const found = new Map<number, Candidate>();
    for (const versionAddr of versionStrings(rdataBytes, rdataBase)) {
        for (const site of findImmediatesInSection(module, text, versionAddr)) {
            const off = site - textBase;
            if (off < 1 || textBytes[off - 1] !== 0x68) continue; // PUSH imm32
            const entry = backtrackToPrologue(module, text, site, 512);
            if (entry < 0) continue;
            const cand = classify(textBytes, textBase, entry - textBase);
            if (cand) found.set(cand.entry, cand);
        }
    }

    if (found.size !== 1) {
        Logger.warn(LogCategory.SYSTEM,
            `[HLE-lib] zlib: ${found.size} uncompress candidates in ${module.name} ` +
            `[${Array.from(found.keys()).map(a => '0x' + a.toString(16)).join(', ')}] — refusing to hook ` +
            `(exactly one is required; more than one means the shape check is ambiguous in this build)`);
        return [];
    }

    const c = Array.from(found.values())[0];
    Logger.log(LogCategory.SYSTEM,
        `[HLE-lib] zlib: uncompress=0x${c.entry.toString(16)} inflateInit_=0x${c.inflateInit.toString(16)} ` +
        `inflate=0x${c.inflate.toString(16)} inflateEnd=0x${c.inflateEnd.toString(16)}`);
    return [{ name: 'uncompress', address: c.entry }];
}

// ── Diagnostic trace ────────────────────────────────────────────────────────

let traceCount = 0;

function logTrace(t: UncompressTrace): void {
    traceCount++;
    const failed = t.ret !== 0;
    // Every failure, plus a sparse heartbeat so a successful run still shows the
    // hook is live and what it is being fed.
    if (!failed && traceCount > 900 && (traceCount & 0x3f) !== 1) return;
    const line =
        `[zlib-hle] uncompress#${traceCount} src=0x${t.source.toString(16)}+${t.sourceLen} ` +
        `hdr=0x${(t.header >>> 0).toString(16)} dst=0x${t.dest.toString(16)} cap=${t.destCap} ` +
        `→ ${t.outcome.status} out=${t.outcome.written} in=${t.outcome.consumed} ret=${t.ret | 0}` +
        (t.outcome.message ? ` (${t.outcome.message})` : '');
    if (failed) Logger.warn(LogCategory.SYSTEM, line);
    else Logger.log(LogCategory.SYSTEM, line);
}

// A declined call runs the guest's own code uncompared, so "our kernel never failed"
// says nothing about it. Report declines or the differential has a blind spot exactly
// where the interesting calls may be.
let declineCount = 0;
function logDeclines(view: Parameters<typeof uncompressGuard>[0], args: number[]): boolean {
    const ok = uncompressGuard(view, args);
    if (!ok && declineCount < 40) {
        declineCount++;
        const src = args[2] >>> 0, srcLen = args[3] >>> 0;
        // The guest's requested size is garbage; inflating the source ourselves says
        // what the entry ACTUALLY is, which separates "the game computed the size
        // wrong" from "the game is pointing at the wrong bytes".
        let truth = "";
        if (src && srcLen && srcLen <= MAX_SPAN) {
            const bytes = Mem.readBytes(src, srcLen);
            if (bytes) {
                try {
                    const scratch = new Uint8Array(1 << 20);
                    const outcome = inflateZlibSync(bytes, scratch);
                    const head = Array.from(scratch.slice(0, 20))
                        .map((b) => b.toString(16).padStart(2, "0")).join(" ");
                    const raw = Array.from(bytes.slice(0, 16))
                        .map((b) => b.toString(16).padStart(2, "0")).join(" ");
                    truth = ` | src=[${raw}] real: status=${outcome.status} size=${outcome.written} head=[${head}]`;
                } catch (e) { truth = ` | real: threw ${e}`; }
            }
        }
        Logger.warn(LogCategory.SYSTEM,
            `[zlib-hle] DECLINED dest=0x${(args[0] >>> 0).toString(16)} destLenPtr=0x${(args[1] >>> 0).toString(16)} ` +
            `src=0x${src.toString(16)} srcLen=${srcLen} ` +
            `destCap=${args[1] ? view.readU32(args[1] >>> 0) : -1} (ceiling=${MAX_SPAN})${truth}`);
    }
    return ok;
}

const shadow: ShadowSpec = {
    // In-game differential against the guest's own uncompress. The original
    // allocates its 32 KiB window through the CRT, so the sync-original run
    // must tolerate the guest re-entering our import thunks.
    get validateInGame(): boolean { return mode() !== 'live'; },
    // Never promote: a diagnostic wants every call compared, and promotion
    // would silently swap the authority mid-session. `__zlibHle='live'` is the
    // explicit way to put the kernel in charge.
    n: 0x7fffffff,
    allowGuestImports: true,
    guard: (args, view) => logDeclines(view, args),
    ranges: (args, view) => uncompressRanges(view, args),
    kernel: (view, args) => uncompressKernel(view, args, logTrace),
};

export const zlibDescriptor: LibDescriptor = {
    id: 'zlib',
    displayName: 'zlib 1.1.x (static, inner-loop HLE)',
    minConfidence: 10,
    signatures: {
        inflate_copyright: { kind: 'ascii', text: ' inflate 1.1.', weight: 10 },
        deflate_copyright: { kind: 'ascii', text: ' deflate 1.1.', weight: 4 },
    },
    functions: {
        uncompress: {
            name: 'uncompress',
            // Never read: `externallyResolved` routes discovery through
            // resolveAdditionalFunctions, which needs more than a byte scan.
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 4,
            required: false,
            // MSVC: SUB ESP,0x38 + MOV ECX,[ESP+0x48]. A build whose first 7
            // bytes are not a clean instruction boundary is refused by
            // validatePrologueBytes rather than silently mis-relocated.
            prologueLen: 7,
            shadow,
        },
    },
    handlers: {},
    resolveAdditionalFunctions: resolveUncompress,
};

/** Exported for the unit test — resolution logic without a live module. */
export const __test = { classify, versionStrings };
