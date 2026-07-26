/**
 * Signature scanning engine. Reads guest memory via `Mem.readBytes` so the
 * TLB/paging layer is respected, but avoids allocating intermediate buffers
 * for big sections.
 */

import { Logger, LogCategory } from '../logger';
import { Mem } from '../memory/mem-accessor';
import type { LoadedPEModule, PESection } from '../module-registry';
import type {
    LibDescriptor,
    LibMatch,
    Signature,
    EntryProbe,
    HookedFunctionMatch,
    SignatureHit,
} from './types';

export function getSection(module: LoadedPEModule, name: string): PESection | undefined {
    return module.sections?.find(s => s.name === name);
}

/**
 * Scan a section for an ASCII string. Returns the first absolute address at
 * which the full sequence matches, or -1 if not found.
 */
function scanAscii(module: LoadedPEModule, section: PESection, text: string): number {
    const base = module.baseAddress + section.virtualAddress;
    const size = section.virtualSize;
    const bytes = Mem.readBytes(base, size);
    if (!bytes) return -1;

    const needle = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) needle[i] = text.charCodeAt(i) & 0xff;

    const limit = size - needle.length;
    for (let i = 0; i <= limit; i++) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
            if (bytes[i + j] !== needle[j]) {
                match = false;
                break;
            }
        }
        if (match) return base + i;
    }
    return -1;
}

/**
 * Scan for a sequence of little-endian uint32 constants. Typical use: zlib's
 * `lbase[]` / `lext[]` tables or other library-specific precomputed arrays.
 */
function scanU32Table(module: LoadedPEModule, section: PESection, values: number[]): number {
    const base = module.baseAddress + section.virtualAddress;
    const size = section.virtualSize;
    const bytes = Mem.readBytes(base, size);
    if (!bytes) return -1;
    const byteLen = values.length * 4;
    if (byteLen > size) return -1;

    const first = values[0] >>> 0;
    const f0 = first & 0xff;
    const f1 = (first >>> 8) & 0xff;
    const f2 = (first >>> 16) & 0xff;
    const f3 = (first >>> 24) & 0xff;

    const limit = size - byteLen;
    for (let off = 0; off <= limit; off += 4) {
        if (bytes[off] !== f0 || bytes[off + 1] !== f1 || bytes[off + 2] !== f2 || bytes[off + 3] !== f3) {
            continue;
        }
        let match = true;
        for (let k = 1; k < values.length; k++) {
            const v = values[k] >>> 0;
            const p = off + k * 4;
            if (bytes[p] !== (v & 0xff)) { match = false; break; }
            if (bytes[p + 1] !== ((v >>> 8) & 0xff)) { match = false; break; }
            if (bytes[p + 2] !== ((v >>> 16) & 0xff)) { match = false; break; }
            if (bytes[p + 3] !== ((v >>> 24) & 0xff)) { match = false; break; }
        }
        if (match) return base + off;
    }
    return -1;
}

/**
 * Scan for a masked byte pattern. `mask` must be same length as `pattern`;
 * 'x' means exact match, any other char (typically '?') is a wildcard.
 */
/**
 * Why the last scanBytes() call failed — the longest prefix it got and where.
 *
 * A byte-exact prologue probe that misses is otherwise a silent no-op: the hook
 * simply never installs, and nothing downstream can tell "this build differs" from
 * "these bytes were already patched" from "the pattern is wrong". The near-miss
 * address plus expected-vs-actual bytes distinguishes all three at a glance, and
 * costs one comparison per candidate position on a scan that runs once per module.
 */
export interface ScanMiss {
    bestLen: number;
    bestAddr: number;
    expected: Uint8Array;
    actual: Uint8Array | null;
    /** The section itself could not be read (paging) — not a pattern mismatch at all. */
    unreadable?: boolean;
}

let lastScanMiss: ScanMiss | null = null;

const hex = (b: Uint8Array | null) =>
    b ? Array.from(b).map(v => v.toString(16).padStart(2, '0')).join(' ') : '<unreadable>';

function scanBytes(module: LoadedPEModule, section: PESection, pattern: Uint8Array, mask: string): number {
    lastScanMiss = null;
    if (pattern.length !== mask.length) {
        Logger.error(LogCategory.SYSTEM, '[HLE-lib] scanBytes: pattern/mask length mismatch');
        return -1;
    }
    const base = module.baseAddress + section.virtualAddress;
    const size = section.virtualSize;
    const bytes = Mem.readBytes(base, size);
    if (!bytes) {
        // Distinct from a pattern mismatch: nothing was compared at all. Silently
        // treating this as "function absent" is how a paging/ordering hiccup turns
        // into a permanently missing hook.
        lastScanMiss = { bestLen: -1, bestAddr: base, expected: pattern, actual: null, unreadable: true };
        return -1;
    }

    const plen = pattern.length;
    const limit = size - plen;
    let bestLen = -1;
    let bestIdx = -1;
    for (let i = 0; i <= limit; i++) {
        let j = 0;
        for (; j < plen; j++) {
            if (mask[j] === 'x' && bytes[i + j] !== pattern[j]) break;
        }
        if (j === plen) return base + i;
        if (j > bestLen) { bestLen = j; bestIdx = i; }
    }
    lastScanMiss = {
        bestLen,
        bestAddr: bestIdx >= 0 ? base + bestIdx : 0,
        expected: pattern,
        actual: bestIdx >= 0 ? bytes.slice(bestIdx, bestIdx + plen) : null,
    };
    return -1;
}

/** Consume the near-miss record left by the most recent failed prologue scan. */
export function takeLastScanMiss(): ScanMiss | null {
    const m = lastScanMiss;
    lastScanMiss = null;
    return m;
}

function evaluateSignature(module: LoadedPEModule, id: string, sig: Signature): SignatureHit | null {
    const sectionName = (sig as any).section ?? (sig.kind === 'prologue' ? '.text' : '.rdata');
    const section = getSection(module, sectionName);
    if (!section) return null;

    let address = -1;
    switch (sig.kind) {
        case 'ascii':
            address = scanAscii(module, section, sig.text);
            break;
        case 'u32table':
            address = scanU32Table(module, section, sig.values);
            break;
        case 'bytes':
            address = scanBytes(module, section, sig.pattern, sig.mask);
            break;
        case 'prologue':
            address = scanBytes(module, section, sig.pattern, sig.mask);
            break;
    }
    if (address < 0) return null;
    return { signatureId: id, address, weight: sig.weight };
}

/**
 * Find every location in the given section where a 32-bit little-endian value
 * equal to `targetAddr` appears. For `.text` this catches common MSVC string
 * / table references (`push imm32`, `mov reg, imm32`). For `.rdata` this
 * catches entries of const pointer tables (e.g. `jpeg_std_message_table[]`).
 */
export function findImmediatesInSection(module: LoadedPEModule, section: PESection, targetAddr: number): number[] {
    const base = module.baseAddress + section.virtualAddress;
    const size = section.virtualSize;
    const bytes = Mem.readBytes(base, size);
    if (!bytes) return [];

    const b0 = targetAddr & 0xff;
    const b1 = (targetAddr >>> 8) & 0xff;
    const b2 = (targetAddr >>> 16) & 0xff;
    const b3 = (targetAddr >>> 24) & 0xff;
    const limit = size - 4;
    const hits: number[] = [];

    for (let i = 0; i <= limit; i++) {
        if (bytes[i] === b0 && bytes[i + 1] === b1 && bytes[i + 2] === b2 && bytes[i + 3] === b3) {
            hits.push(base + i);
        }
    }
    return hits;
}

/** Find direct near-call (`E8 rel32`) sites in `.text` that target `targetAddr`. */
export function findDirectCallsInText(module: LoadedPEModule, section: PESection, targetAddr: number): number[] {
    const base = module.baseAddress + section.virtualAddress;
    const size = section.virtualSize;
    const bytes = Mem.readBytes(base, size);
    if (!bytes) return [];

    const hits: number[] = [];
    const limit = size - 5;
    for (let i = 0; i <= limit; i++) {
        if (bytes[i] !== 0xe8) continue;
        let rel =
            bytes[i + 1] |
            (bytes[i + 2] << 8) |
            (bytes[i + 3] << 16) |
            (bytes[i + 4] << 24);
        rel |= 0;
        const dest = base + i + 5 + rel;
        if (dest === targetAddr) {
            hits.push(base + i);
        }
    }
    return hits;
}

/**
 * From a guest address inside a function body, walk backward until we hit
 * a byte sequence that looks like the start of a function.
 *
 * Returns the absolute address of the prologue start, or -1 on failure.
 */
export function backtrackToPrologue(module: LoadedPEModule, section: PESection, xrefAddr: number, maxBacktrack: number): number {
    const base = module.baseAddress + section.virtualAddress;
    const size = section.virtualSize;
    const bytes = Mem.readBytes(base, size);
    if (!bytes) return -1;

    const xrefOff = xrefAddr - base;
    if (xrefOff < 0 || xrefOff >= size) return -1;

    const stop = Math.max(0, xrefOff - maxBacktrack);
    for (let i = xrefOff; i >= stop; i--) {
        const b = bytes[i];
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        const b3 = bytes[i + 3];
        const b4 = bytes[i + 4];
        if (b === 0x8b && b1 === 0xff && b2 === 0x55 && b3 === 0x8b && b4 === 0xec) {
            return base + i;
        }
        if (b === 0x55 && b1 === 0x8b && b2 === 0xec) {
            return base + i;
        }
    }

    for (let i = xrefOff; i >= stop; i--) {
        const b = bytes[i];
        const b1 = bytes[i + 1];
        if ((b === 0x83 && b1 === 0xec) || (b === 0x81 && b1 === 0xec)) {
            const prev = i > 0 ? bytes[i - 1] : 0;
            if (prev === 0xc3 || prev === 0xc2 || prev === 0xcc || prev === 0x90) {
                return base + i;
            }
        }
    }

    // Fallback for small wrappers that start with preserved-register pushes
    // instead of an EBP frame, e.g. `push esi; mov esi, [esp+8]`.
    for (let i = xrefOff; i >= stop; i--) {
        const b = bytes[i];
        const b1 = bytes[i + 1];
        const prev = i > 0 ? bytes[i - 1] : 0;
        const startsWithPush = b === 0x53 || b === 0x56 || b === 0x57;
        const plausibleNext =
            b1 === 0x8b || // mov
            b1 === 0x83 || // sub/add cmp imm8 forms
            b1 === 0x81 || // sub/add cmp imm32 forms
            b1 === 0x85 || // test
            b1 === 0x53 || b1 === 0x56 || b1 === 0x57 || // more pushes
            b1 === 0x6a || b1 === 0x68; // push imm8/imm32
        if (startsWithPush && plausibleNext) {
            if (prev === 0xc3 || prev === 0xc2 || prev === 0xcc || prev === 0x90) {
                return base + i;
            }
        }
    }
    return -1;
}

interface CallerStackUsage {
    arg1: boolean;
    arg2: boolean;
    arg3: boolean;
    arg4: boolean;
}

function opcodeUsesModRmMemory(opcode: number): boolean {
    return (
        opcode === 0x8b || // mov reg, [mem]
        opcode === 0x89 || // mov [mem], reg
        opcode === 0x85 || // test [mem], reg
        opcode === 0x83 || // cmp/add/sub [mem], imm8
        opcode === 0x81 || // cmp/add/sub [mem], imm32
        opcode === 0xff || // call/jmp/push [mem]
        opcode === 0x39 || // cmp [mem], reg
        opcode === 0x3b || // cmp reg, [mem]
        opcode === 0xc7    // mov [mem], imm32
    );
}

function markArgByDisp(usage: CallerStackUsage, disp: number): void {
    switch (disp & 0xff) {
        case 0x08:
            usage.arg1 = true;
            break;
        case 0x0c:
            usage.arg2 = true;
            break;
        case 0x10:
            usage.arg3 = true;
            break;
        case 0x14:
            usage.arg4 = true;
            break;
    }
}

/**
 * Heuristic: public C wrappers on MSVC usually read args via [ebp+8], [ebp+0C], ...
 * Scan the opening window for those stack-slot references so xrefCaller can
 * prefer a 2-arg wrapper over adjacent 1-arg/3-arg helpers.
 */
function sniffCallerStackUsage(
    module: LoadedPEModule,
    section: PESection,
    entryAddr: number,
    maxBytes = 192,
): CallerStackUsage {
    const base = module.baseAddress + section.virtualAddress;
    const size = section.virtualSize;
    const entryOff = entryAddr - base;
    const usage: CallerStackUsage = { arg1: false, arg2: false, arg3: false, arg4: false };
    if (entryOff < 0 || entryOff >= size) return usage;

    const span = Math.min(maxBytes, size - entryOff);
    const bytes = Mem.readBytes(entryAddr, span);
    if (!bytes) return usage;

    for (let i = 0; i + 2 < bytes.length; i++) {
        const op = bytes[i];
        if ((op === 0xc3 || op === 0xc2) && i > 8) break;
        if (!opcodeUsesModRmMemory(op)) continue;

        const modrm = bytes[i + 1];
        // mod=01, rm=101 => [ebp+disp8], any reg/opcode extension
        if ((modrm & 0xc7) !== 0x45) continue;
        markArgByDisp(usage, bytes[i + 2]);
    }

    return usage;
}

function scoreCallerCandidate(
    module: LoadedPEModule,
    section: PESection,
    callerEntry: number,
): { score: number; incomingCalls: number; usage: CallerStackUsage } {
    const incomingCalls = findDirectCallsInText(module, section, callerEntry).length;
    const usage = sniffCallerStackUsage(module, section, callerEntry);

    let score = incomingCalls * 10;
    if (usage.arg2) score += 100;
    if (usage.arg1) score += 20;
    if (usage.arg3) score -= 40;
    if (usage.arg4) score -= 60;

    return { score, incomingCalls, usage };
}

function resolveXrefEntry(
    module: LoadedPEModule,
    section: PESection,
    signatureAddr: number,
    maxBacktrack: number,
): number {
    const xrefAddrs = findImmediatesInSection(module, section, signatureAddr);
    for (const xrefAddr of xrefAddrs) {
        const entry = backtrackToPrologue(module, section, xrefAddr, maxBacktrack);
        if (entry >= 0) return entry;
    }
    return -1;
}

function resolveXrefCallerEntry(
    module: LoadedPEModule,
    section: PESection,
    signatureAddr: number,
    maxBacktrack: number,
): number {
    const helperEntries: number[] = [];
    const helperSeen = new Set<number>();

    for (const xrefAddr of findImmediatesInSection(module, section, signatureAddr)) {
        const helperEntry = backtrackToPrologue(module, section, xrefAddr, maxBacktrack);
        if (helperEntry < 0 || helperSeen.has(helperEntry)) continue;
        helperSeen.add(helperEntry);
        helperEntries.push(helperEntry);
    }

    const callerSeen = new Set<number>();
    const candidates: Array<{
        entry: number;
        score: number;
        incomingCalls: number;
        usage: CallerStackUsage;
    }> = [];

    for (const helperEntry of helperEntries) {
        for (const callsite of findDirectCallsInText(module, section, helperEntry)) {
            const callerEntry = backtrackToPrologue(module, section, callsite, maxBacktrack);
            if (callerEntry < 0 || callerEntry === helperEntry || callerSeen.has(callerEntry)) continue;
            callerSeen.add(callerEntry);
            const ranked = scoreCallerCandidate(module, section, callerEntry);
            candidates.push({
                entry: callerEntry,
                score: ranked.score,
                incomingCalls: ranked.incomingCalls,
                usage: ranked.usage,
            });
        }
    }

    if (candidates.length === 0) return -1;

    candidates.sort((a, b) =>
        b.score - a.score ||
        b.incomingCalls - a.incomingCalls ||
        a.entry - b.entry,
    );

    if (candidates.length > 1) {
        const summary = candidates.map(c =>
            `0x${c.entry.toString(16)} score=${c.score} callers=${c.incomingCalls} ` +
            `args=[${c.usage.arg1 ? '1' : ''}${c.usage.arg2 ? '2' : ''}${c.usage.arg3 ? '3' : ''}${c.usage.arg4 ? '4' : ''}]`,
        ).join(' | ');
        Logger.log(LogCategory.SYSTEM, `[HLE-lib] xrefCaller candidates for 0x${signatureAddr.toString(16)}: ${summary}`);
    }

    return candidates[0].entry;
}

/**
 * Resolve a function's entry address via its EntryProbe. Probes either scan
 * `.text` for a byte pattern, chase a direct xref to a data signature, or
 * recover a caller-wrapper around a helper located via xref.
 */
function resolveEntry(
    module: LoadedPEModule,
    probe: EntryProbe,
    signatureHits: SignatureHit[],
): number {
    const section = getSection(module, probe.section ?? '.text');
    if (!section) return -1;

    if (probe.kind === 'prologue') {
        return scanBytes(module, section, probe.pattern, probe.mask);
    }

    const sigHit = signatureHits.find(h => h.signatureId === probe.fromSignature);
    if (!sigHit) return -1;

    const maxBacktrack = probe.maxBacktrack ?? 512;
    if (probe.kind === 'xref') {
        return resolveXrefEntry(module, section, sigHit.address, maxBacktrack);
    }

    return resolveXrefCallerEntry(module, section, sigHit.address, maxBacktrack);
}

/** Run a descriptor against a loaded PE module, returning either a match or null. */
export function runDetector(descriptor: LibDescriptor, module: LoadedPEModule): LibMatch | null {
    if (!module.sections || module.sections.length === 0) return null;

    const signatureHits: SignatureHit[] = [];
    let confidence = 0;
    for (const [id, sig] of Object.entries(descriptor.signatures)) {
        const hit = evaluateSignature(module, id, sig);
        if (hit) {
            signatureHits.push(hit);
            confidence += hit.weight;
        }
    }

    if (confidence < descriptor.minConfidence) return null;

    const functionMatches: HookedFunctionMatch[] = [];
    const missingFunctions: string[] = [];
    for (const [name, decl] of Object.entries(descriptor.functions)) {
        if (decl.externallyResolved) {
            // Address is supplied by `resolveAdditionalFunctions`; if that
            // doesn't produce an address, the entry stays in `missingFunctions`
            // unless `required: true` (which would abort).
            missingFunctions.push(name);
            continue;
        }
        const addr = resolveEntry(module, decl.entryProbe, signatureHits);
        if (addr >= 0) {
            functionMatches.push({ name, address: addr });
        } else {
            missingFunctions.push(name);
            // A miss silently removes a hook that may carry a large share of guest
            // exec-weight, so it must never be an invisible state — name it with the
            // evidence needed to tell a build difference from an already-patched
            // prologue (CLAUDE.md §3.4 observability).
            const miss = takeLastScanMiss();
            Logger.warn(LogCategory.SYSTEM,
                `[HLE-lib] ${descriptor.id}: function '${name}' NOT FOUND in ${module.name}` +
                `${decl.required ? ' (required — aborting)' : ' (optional — hook will NOT install)'}` +
                (!miss
                    ? ''
                    : miss.unreadable
                        ? `; SECTION UNREADABLE at 0x${miss.bestAddr.toString(16)} — nothing was compared (paging/ordering, not a build difference)`
                        : `; best prologue match ${miss.bestLen}/${miss.expected.length} bytes at ` +
                          `0x${miss.bestAddr.toString(16)}\n    expected: ${hex(miss.expected)}\n    actual:   ${hex(miss.actual)}`));
            if (decl.required) return null;
        }
    }

    if (descriptor.resolveAdditionalFunctions) {
        let extras: HookedFunctionMatch[] = [];
        try {
            extras = descriptor.resolveAdditionalFunctions({
                module,
                signatureHits,
                getSection: (name: string) => getSection(module, name),
            });
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[HLE-lib] ${descriptor.id}.resolveAdditionalFunctions threw: ${e}`);
        }
        const already = new Set(functionMatches.map(m => m.name));
        for (const m of extras) {
            if (already.has(m.name)) continue;
            if (!descriptor.functions[m.name]) {
                Logger.warn(LogCategory.SYSTEM, 
                    `[HLE-lib] ${descriptor.id}: resolver produced '${m.name}' but it is not declared in functions{}`,
                );
                continue;
            }
            functionMatches.push(m);
            already.add(m.name);
        }
        const resolvedNames = new Set(functionMatches.map(m => m.name));
        for (let i = missingFunctions.length - 1; i >= 0; i--) {
            if (resolvedNames.has(missingFunctions[i])) missingFunctions.splice(i, 1);
        }
    }

    return {
        descriptor,
        module,
        confidence,
        signatureHits,
        functionMatches,
        missingFunctions,
    };
}
