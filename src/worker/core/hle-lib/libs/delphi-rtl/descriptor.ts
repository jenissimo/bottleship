/**
 * Delphi RTL record helpers — experimental, OFF by default.
 *
 * The Game Maker 5–8.1 runners are Delphi programs, and their interpreter creates and destroys
 * a small managed record (one long-string field) for every value it touches. Every such
 * record goes through the RTL's generic, RTTI-driven `_InitializeRecord` / `_FinalizeRecord`,
 * which call `_InitializeArray` / `_FinalizeArray` (and `_LStrClr`) for the one field: about
 * 45–50 guest instructions and four call/return block exits to write, or to find already
 * zero, one dword. Measured in one runner on its dungeon screen: ~74k such calls per frame,
 * 37 % of all retired guest instructions.
 *
 * This replaces neither helper. An entry filter in front of each handles exactly one shape —
 * a record type with ONE managed field whose type is a long string — and sends every other
 * call, unchanged, to the original body through the prologue trampoline:
 *
 *   _InitializeRecord(EAX=p, EDX=typeInfo):  [p + offset] := 0                     ; ret
 *   _FinalizeRecord  (EAX=p, EDX=typeInfo):  [p + offset] = 0 ? (EAX = p ; ret) : original
 *
 * which is what the original computes on that shape: `_InitializeArray` stores 0 for a long
 * string, and `_FinalizeArray` calls `_LStrClr`, which returns without a write when the
 * string is nil (both bodies are matched byte for byte below, so this is checked, not
 * assumed). A non-nil string — the refcount and free path — always runs the original.
 *
 * CONTRACT, against the matched helpers' register convention (EAX = record, EDX = type info;
 * EBX/ESI/EDI/EBP callee-saved; ESP restored by RET):
 *   - the same as the original: callee-saved registers, ESP and the return, DF, all x87 and SIMD
 *     state, the memory written (one zero store, or none), and EAX = p after _FinalizeRecord;
 *   - different, in registers the convention leaves clobbered: ECX holds the field offset
 *     (original: 0), EDX the record's type info (original: the field's type info), the
 *     arithmetic flags come from the filter's compares, and after _InitializeRecord EAX is p
 *     (original: p + offset with its low byte replaced by the field's kind; the procedure has no
 *     result);
 *   - a fault is the same access with the same error code and nothing written before it, but it
 *     is reported at an EIP inside the filter instead of inside the RTL body, and with ESP one
 *     return address deep instead of below the original's pushes and nested calls. The filter
 *     reads the record's type info in a different order than the original before the store
 *     (name length, field count, field type, offset), all of which the original also reads
 *     before its store.
 * On decline the filter has changed only ECX and the flags, neither of which is an input; EAX and
 * EDX reach the trampoline as the caller passed them. The filter writes no stack and touches no
 * shared state, so a quantum ending inside it is harmless.
 *
 * DETECTION is a whole-body match of all four helpers plus `_LStrClr`, with only the
 * relative call/jump operands that leave the group masked, and every internal call resolved:
 * `_InitializeRecord` must call the matched `_InitializeArray`, `_FinalizeRecord` the matched
 * `_FinalizeArray`, and that one's long-string call must reach the matched `_LStrClr`. The
 * `_InitializeRecord` and `_ClearRecord` bodies are identical up to their call target, which
 * is why the target is part of the match. Delphi 7 (`CODE`) and Delphi 2009-era (`.text`)
 * runners carry the same bytes.
 *
 * Opt in with `setWorkerFlag('__delphiRtlHle', true)` before the image loads.
 */

import { Logger, LogCategory } from '../../../logger';
import { writeGuestCode } from '../../../memory/guest-code';
import { Mem } from '../../../memory/mem-accessor';
import type { PESection } from '../../../module-registry';
import type { EntryFilterInfo, HookedFunctionMatch, LibDescriptor, ResolverModuleView } from '../../types';

export function delphiRtlEnabled(): boolean {
    return (globalThis as { __delphiRtlHle?: boolean }).__delphiRtlHle === true;
}

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map(b => parseInt(b, 16)));

interface Body { bytes: Uint8Array; mask: string }

export const BODIES = {
    InitializeRecord: {
        bytes: hex('31c9538a4a01565789c38d74110a8b7c11068b168b460401d88b12b901000000e80b00000083c6084f7fe75f5e5bc3'),
        mask: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx????xxxxxxxxxx',
    },
    InitializeArray: {
        bytes: hex('85c90f848a00000053565789c389d689cf31d28a068a560131c93c0a74223c0b741e3c0c74243c0d74333c0e74'
            + '4d3c0f740e3c11740ab0025f5e5be9d8ceffff890b83c3044f7ff8eb45890b894b04894b08894b0c83c3104f7fefeb32'
            + '5589d58b542e0a89d8035c2e028b4c2e068b12e88bffffff4f7fe85deb145589d589d8035c2e0289f2e845ffffff4f7f'
            + 'f05d5f5e5bc3'),
        mask: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx????xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
            + 'xxxxxxxxxxxxxxxxxxx????xxxxxxxxxxxxxxxxxx????xxxxxxxx',
    },
    FinalizeRecord: {
        bytes: hex('31c9538a4a01565789c38d74110a8b7c11068b168b460401d88b12b901000000e82700000083c6084f7fe789d85f5e5bc3'),
        mask: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx????xxxxxxxxxxxx',
    },
    FinalizeArray: {
        bytes: hex('83f9000f84e00000005053565789c389d689cf31d28a068a56013c0a74253c0b743e3c0c74513c0d745c3c0e7476'
            + '3c0f0f84840000003c110f848b000000e99700000083f90189d87f0ae8b5f4ffffe99100000089cae8cdf4ffffe98500'
            + '000083f90189d87f07e8ccfbffffeb7789cae8dbfbffffeb6e89d883c310e867ffffff4f7ff3eb5f5589d58b542e0a89d8'
            + '035c2e028b4c2e068b12e862ffffff4f7fe85deb415589d589d8035c2e0289f2e800ffffff4f7ff05deb2b89d883c304e8'
            + '301000004f7ff3eb1c89d889f283c304e8670900004f7ff1eb0b5f5e5b58b002e947cdffff5f5e5b58c3'),
        mask: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx????xxxxxxxx????x????xxx????x???'
            + '?xxxxxxxx????xxxxx????xxxxxxxx????xxxxxxxxxxxxxxxxxxxxxxxxx????xxxxxxxxxxxxxxxxxx????xxxxxxxxxxxx??'
            + '??xxxxxxxxxxxxx????xxxxxxxxxxxx????xxxxx',
    },
    LStrClr: {
        bytes: hex('8b1085d2741cc700000000008b4af8497c10f0ff4af8750a508d42f8e8cbd7ffff58c3'),
        mask: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxx????xx',
    },
} as const satisfies Record<string, Body>;

/** Body offsets of the internal rel32 calls the match must resolve. */
const INIT_RECORD_CALLS_ARRAY = 32;
const FINAL_RECORD_CALLS_ARRAY = 32;
const FINAL_ARRAY_CALLS_LSTRCLR = 0x4a;

/** Type-info kind byte of a Delphi long string (tkLString). */
export const TK_LSTRING = 0x0a;

const IMAGE_SCN_CNT_CODE = 0x20;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;

function matchesAt(mem: Uint8Array, at: number, body: Body): boolean {
    const { bytes, mask } = body;
    if (at < 0 || at + bytes.length > mem.length) return false;
    for (let k = 0; k < bytes.length; k++) {
        if (mask.charCodeAt(k) === 0x78 && mem[at + k] !== bytes[k]) return false;
    }
    return true;
}

function findAll(mem: Uint8Array, start: number, end: number, body: Body): number[] {
    const out: number[] = [];
    const b0 = body.bytes[0]!;
    const sec = mem.subarray(start, end);
    for (let i = sec.indexOf(b0); i !== -1 && i + body.bytes.length <= sec.length; i = sec.indexOf(b0, i + 1)) {
        if (matchesAt(mem, start + i, body)) out.push(start + i);
    }
    return out;
}

function callTarget(mem: Uint8Array, at: number): number | null {
    if (mem[at] !== 0xe8) return null;
    const rel = (mem[at + 1]! | (mem[at + 2]! << 8) | (mem[at + 3]! << 16) | (mem[at + 4]! << 24)) | 0;
    return (at + 5 + rel) >>> 0;
}

export interface DelphiRecordHelpers { initializeRecord: number; finalizeRecord: number }

/**
 * The record helpers in `mem[start, end)` (addresses are indices into `mem`), or null unless
 * every body matches exactly once (per role) and every internal call reaches its matched callee.
 */
export function findRecordHelpers(mem: Uint8Array, start = 0, end = mem.length): DelphiRecordHelpers | null {
    const s = Math.max(0, start), e = Math.min(end, mem.length);
    if (e <= s) return null;
    const arrays = findAll(mem, s, e, BODIES.InitializeArray);
    const finals = findAll(mem, s, e, BODIES.FinalizeArray);
    const clears = findAll(mem, s, e, BODIES.LStrClr);
    if (arrays.length !== 1 || finals.length !== 1 || clears.length !== 1) return null;
    const [initArray, finalArray, lstrClr] = [arrays[0]!, finals[0]!, clears[0]!];
    if (callTarget(mem, finalArray + FINAL_ARRAY_CALLS_LSTRCLR) !== lstrClr) return null;
    const inits = findAll(mem, s, e, BODIES.InitializeRecord)
        .filter(a => callTarget(mem, a + INIT_RECORD_CALLS_ARRAY) === initArray);
    const finRecs = findAll(mem, s, e, BODIES.FinalizeRecord)
        .filter(a => callTarget(mem, a + FINAL_RECORD_CALLS_ARRAY) === finalArray);
    if (inits.length !== 1 || finRecs.length !== 1) return null;
    return { initializeRecord: inits[0]!, finalizeRecord: finRecs[0]! };
}

/** First 8 bytes of both record helpers: xor ecx,ecx / push ebx / mov cl,[edx+1] / push esi / push edi. */
export const PROLOGUE_LEN = 8;

/**
 * The filter body. `finalize` adds the nil test and keeps EAX = p.
 *
 *   movzx ecx, byte [edx+1]          ; type name length
 *   cmp   dword [edx+ecx+6], 1       ; managed field count
 *   jne   .orig
 *   mov   ecx, [edx+ecx+0Ah]         ; field 0: PPTypeInfo
 *   mov   ecx, [ecx]
 *   cmp   byte [ecx], tkLString
 *   jne   .orig
 *   movzx ecx, byte [edx+1]
 *   mov   ecx, [edx+ecx+0Eh]         ; field 0: offset
 *   init:     mov dword [eax+ecx], 0 ; ret
 *   finalize: cmp dword [eax+ecx], 0 ; jne .orig ; ret
 * .orig:
 *   jmp   trampoline
 */
export function assembleRecordFilter(at: number, trampoline: number, finalize: boolean): Uint8Array {
    const head = [
        0x0f, 0xb6, 0x4a, 0x01,
        0x83, 0x7c, 0x0a, 0x06, 0x01,
        0x75, 0x00,
        0x8b, 0x4c, 0x0a, 0x0a,
        0x8b, 0x09,
        0x80, 0x39, TK_LSTRING,
        0x75, 0x00,
        0x0f, 0xb6, 0x4a, 0x01,
        0x8b, 0x4c, 0x0a, 0x0e,
    ];
    const tail = finalize
        ? [0x83, 0x3c, 0x08, 0x00, 0x75, 0x00, 0xc3]
        : [0xc7, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00, 0xc3];
    const code = [...head, ...tail];
    const orig = code.length;
    const patchJcc = (pos: number) => { code[pos + 1] = orig - (pos + 2); };
    patchJcc(9);
    patchJcc(20);
    if (finalize) patchJcc(head.length + 4);
    const rel = (trampoline - (at + orig + 5)) | 0;
    code.push(0xe9, rel & 0xff, (rel >>> 8) & 0xff, (rel >>> 16) & 0xff, (rel >>> 24) & 0xff);
    return Uint8Array.from(code);
}

function filterFor(finalize: boolean) {
    return (info: EntryFilterInfo): number | null => {
        const size = assembleRecordFilter(0, 0, finalize).length;
        const at = info.allocCode(size);
        if (!at || at + size > info.mem.length) return null;
        const code = assembleRecordFilter(at, info.trampolineAddress, finalize);
        if (!writeGuestCode(info.mem, code, at)) return null;
        return at;
    };
}

function codeSections(view: ResolverModuleView): PESection[] {
    return (view.module.sections ?? []).filter(s => (s.characteristics & (IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE)) !== 0);
}

function resolve(view: ResolverModuleView): HookedFunctionMatch[] {
    if (!delphiRtlEnabled()) return [];
    for (const s of codeSections(view)) {
        const base = view.module.baseAddress + s.virtualAddress;
        const bytes = Mem.readBytes(base, s.virtualSize);
        const rel = bytes ? findRecordHelpers(bytes) : null;
        if (!rel) continue;
        const found = { initializeRecord: base + rel.initializeRecord, finalizeRecord: base + rel.finalizeRecord };
        Logger.log(LogCategory.SYSTEM,
            `[HLE-lib] delphi-rtl: record helpers in ${view.module.name}: InitializeRecord=0x${found.initializeRecord.toString(16)} ` +
            `FinalizeRecord=0x${found.finalizeRecord.toString(16)}`);
        return [
            { name: 'InitializeRecord', address: found.initializeRecord },
            { name: 'FinalizeRecord', address: found.finalizeRecord },
        ];
    }
    return [];
}

/** The OUT stub is never the filter's target; reaching it means the filter was bypassed. */
function unreachable(): number {
    throw new Error('delphi-rtl: record helper stub reached; the entry filter routes every call');
}

const RTL_KEY = 'SOFTWARE\\Borland\\Delphi\\RTL';

export const delphiRtlDescriptor: LibDescriptor = {
    id: 'delphi-rtl',
    displayName: 'Delphi RTL record helpers (experimental)',
    minConfidence: 1,
    signatures: {
        rtlKeyCode: { kind: 'ascii', text: RTL_KEY, section: 'CODE', weight: 1 },
        rtlKeyText: { kind: 'ascii', text: RTL_KEY, section: '.text', weight: 1 },
    },
    functions: {
        InitializeRecord: {
            name: 'InitializeRecord',
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 0,
            required: false,
            prologueLen: PROLOGUE_LEN,
            entryFilter: filterFor(false),
        },
        FinalizeRecord: {
            name: 'FinalizeRecord',
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 0,
            required: false,
            prologueLen: PROLOGUE_LEN,
            entryFilter: filterFor(true),
        },
    },
    handlers: { InitializeRecord: unreachable, FinalizeRecord: unreachable },
    resolveAdditionalFunctions: resolve,
};
