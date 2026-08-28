// Trap-free inline x86 stub for kernel32!GetLocaleInfoW.
//
// The MSVC CRT rebuilds `lconv` on every setlocale(), and titles that switch locale
// per string comparison (House of 1,000 Doors: ~82K times over a load) turn that into
// millions of GetLocaleInfoW calls. Every one of them is already answered by a JS fast
// path — what is left to remove is the OUT trap itself, so the answer comes out of guest
// code with no boundary crossing at all.
//
// The table this reads is serialised from the JS answer cache (locale-data.ts,
// serializeLocaleStubTable), so stub and thunk cannot answer differently. Every case the
// stub does not cover — LOCALE_RETURN_NUMBER, an unknown LCTYPE, a negative or too-small
// cchData, a NULL destination, a destination past guest RAM — JMPs to the original OUT
// trap, which keeps last-error and the odd cases JS-side where they belong.
//
// No non-preemptible range: unlike the heap slab stubs this touches no shared mutable
// state (the table is read-only; the two counters are plain increments whose exactness
// is not load-bearing), so a thread switch mid-stub is harmless.
//
// Codegen pinned by tools/tests/thunk-stub-emitters.test.ts.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';
import {
    LOCALE_CACHE_SIZE, LOCALE_STUB_ANSWERED_OFF, LOCALE_STUB_BAIL_OFF,
    LOCALE_STUB_BAIL_REASONS, LOCALE_STUB_DESTLIMIT_OFF, LOCALE_STUB_INDEX_OFF,
    LOCALE_STUB_BLOB_OFF,
} from './locale-data';

export interface LocaleInlineStubs {
    getLocaleInfoWStub: number;
    tableAddr: number;
    regionBase: number;
    regionEnd: number;
}

/** The installed stub, for the `localeStubStats` harness verb. An inline stub answers
 *  inside guest code, so it is invisible to slowPathThunks / apiCensus / breakOnApi —
 *  "the count went to zero" and "the stub was never installed" look identical from every
 *  instrument we own. These counters are the only thing that tells them apart. */
let installed: LocaleInlineStubs | null = null;

export function getLocaleInlineStubs(): LocaleInlineStubs | null {
    return installed;
}

export function resetLocaleInlineStubs(): void {
    installed = null;
}

/**
 * Emit the inline GetLocaleInfoW stub.
 *
 * `int GetLocaleInfoW(LCID, LCTYPE lcType, LPWSTR lpLCData, int cchData)` — stdcall,
 * RET 16. LCID is ignored, exactly as the JS fast path ignores it (we serve one locale).
 *
 * @param allocator  Narrow THUNK_CODE allocator (ThunkMemoryManager.stubAllocator)
 * @param getMemory  Callback returning current guest memory (refetched after alloc)
 * @param tableAddr  Guest addr of the serialised table (serializeLocaleStubTable), already written
 * @param trapAddr   Slow-path target — the original kernel32!GetLocaleInfoW OUT-trap stub
 */
export function writeLocaleStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    tableAddr: number,
    trapAddr: number,
): LocaleInlineStubs {
    const REGION_SIZE = 384;
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    // Bounds live INSIDE the emitters: a check after the fact is a check after the bytes
    // it was meant to stop have already landed in whatever follows the region.
    const limit = base + REGION_SIZE;
    const room = (n: number) => {
        if (off + n > limit) throw new Error(`[locale-stub] emit past the ${REGION_SIZE}B region`);
    };
    const w8 = (v: number) => { room(1); mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { room(4); dv.setUint32(off, v >>> 0, true); off += 4; };

    const INDEX_ABS = tableAddr + LOCALE_STUB_INDEX_OFF;
    const BLOB_ABS = tableAddr + LOCALE_STUB_BLOB_OFF;
    const ANSWERED_ABS = tableAddr + LOCALE_STUB_ANSWERED_OFF;
    const DESTLIMIT_ABS = tableAddr + LOCALE_STUB_DESTLIMIT_OFF;

    const getLocaleInfoWStub = off;
    // One landing pad per bail site, so the census says WHICH case declined — a single
    // total cannot tell "RETURN_NUMBER, as designed" from "the table is missing the types
    // this caller asks for", and those want opposite work.
    const bailPatches: number[][] = LOCALE_STUB_BAIL_REASONS.map(() => []);
    const bail = (reason: typeof LOCALE_STUB_BAIL_REASONS[number]) => {
        bailPatches[LOCALE_STUB_BAIL_REASONS.indexOf(reason)].push(off); w32(0);
    };
    const haveBufPatches: number[] = [];

    // MOV EAX, [ESP+8]            ; 8B 44 24 08   lcType
    w8(0x8B); w8(0x44); w8(0x24); w8(0x08);
    // TEST EAX, LOCALE_RETURN_NUMBER ; A9 imm32   (out-param is a DWORD, not a string)
    w8(0xA9); w32(0x20000000);
    // JNZ .bail                   ; 0F 85 rel32
    w8(0x0F); w8(0x85); bail('returnNumber');
    // MOVZX EAX, AX               ; 0F B7 C0      cleanType = lcType & 0xFFFF (as the JS path)
    w8(0x0F); w8(0xB7); w8(0xC0);
    // CMP EAX, LOCALE_CACHE_SIZE  ; 3D imm32
    w8(0x3D); w32(LOCALE_CACHE_SIZE);
    // JAE .bail                   ; 0F 83 rel32
    w8(0x0F); w8(0x83); bail('typeOutOfTable');
    // MOV EAX, [EAX*4 + INDEX_ABS]; 8B 04 85 disp32
    w8(0x8B); w8(0x04); w8(0x85); w32(INDEX_ABS);
    // TEST EAX, EAX               ; 85 C0         entry 0 = unknown LCTYPE
    w8(0x85); w8(0xC0);
    // JZ .bail                    ; 0F 84 rel32
    w8(0x0F); w8(0x84); bail('unknownType');

    // MOV ECX, [ESP+16]           ; 8B 4C 24 10   cchData
    w8(0x8B); w8(0x4C); w8(0x24); w8(0x10);
    // TEST ECX, ECX               ; 85 C9
    w8(0x85); w8(0xC9);
    // JS .bail                    ; 0F 88 rel32   cchData < 0
    w8(0x0F); w8(0x88); bail('negativeCch');
    // JNZ .haveBuf                ; 0F 85 rel32
    w8(0x0F); w8(0x85); haveBufPatches.push(off); w32(0);

    // Size query (cchData == 0): return the WCHAR count, write nothing. The cheap half
    // of the CRT's pattern — it sizes, then reads.
    // SHR EAX, 17                 ; C1 E8 11      (entry >> 16) >> 1 = chars incl. NUL
    w8(0xC1); w8(0xE8); w8(0x11);
    // INC dword [ANSWERED_ABS]    ; FF 05 disp32
    w8(0xFF); w8(0x05); w32(ANSWERED_ABS);
    // RET 16                      ; C2 10 00
    w8(0xC2); w8(0x10); w8(0x00);

    // .haveBuf:
    const haveBufAddr = off;
    // MOV EDX, EAX                ; 89 C2
    w8(0x89); w8(0xC2);
    // SHR EDX, 17                 ; C1 EA 11      required WCHARs
    w8(0xC1); w8(0xEA); w8(0x11);
    // CMP ECX, EDX                ; 39 D1
    w8(0x39); w8(0xD1);
    // JB .bail                    ; 0F 82 rel32   too small — Win32 sets ERROR_INSUFFICIENT_BUFFER,
    w8(0x0F); w8(0x82); bail('bufferTooSmall');          // and last-error is JS-side state.
    // MOV ECX, [ESP+12]           ; 8B 4C 24 0C   lpLCData
    w8(0x8B); w8(0x4C); w8(0x24); w8(0x0C);
    // TEST ECX, ECX               ; 85 C9
    w8(0x85); w8(0xC9);
    // JZ .bail                    ; 0F 84 rel32   NULL destination with a non-zero count
    w8(0x0F); w8(0x84); bail('nullDest');
    // MOV EDX, EAX                ; 89 C2
    w8(0x89); w8(0xC2);
    // SHR EDX, 16                 ; C1 EA 10      byteLen
    w8(0xC1); w8(0xEA); w8(0x10);
    // ADD EDX, ECX                ; 01 CA         end of the write
    w8(0x01); w8(0xCA);
    // JC .bail                    ; 0F 82 rel32   wrapped past 4GB
    w8(0x0F); w8(0x82); bail('destWraps');
    // CMP EDX, [DESTLIMIT_ABS]    ; 3B 15 disp32
    w8(0x3B); w8(0x15); w32(DESTLIMIT_ABS);
    // JA .bail                    ; 0F 87 rel32   past guest RAM, or into the stub's own table
    w8(0x0F); w8(0x87); bail('destPastMemory');

    // Every bail is behind us, so ESI/EDI can be spent without an unwind path.
    // PUSH ESI                    ; 56
    w8(0x56);
    // PUSH EDI                    ; 57
    w8(0x57);
    // MOVZX ESI, AX               ; 0F B7 F0      blob offset
    w8(0x0F); w8(0xB7); w8(0xF0);
    // ADD ESI, BLOB_ABS           ; 81 C6 imm32
    w8(0x81); w8(0xC6); w32(BLOB_ABS);
    // MOV EDI, ECX                ; 89 CF
    w8(0x89); w8(0xCF);
    // SHR EAX, 16                 ; C1 E8 10      byteLen
    w8(0xC1); w8(0xE8); w8(0x10);
    // MOV ECX, EAX                ; 89 C1
    w8(0x89); w8(0xC1);
    // SHR EAX, 1                  ; D1 E8         return value = WCHARs written
    w8(0xD1); w8(0xE8);
    // REP MOVSB                   ; F3 A4         DF is clear per the Win32 ABI
    w8(0xF3); w8(0xA4);
    // POP EDI                     ; 5F
    w8(0x5F);
    // POP ESI                     ; 5E
    w8(0x5E);
    // INC dword [ANSWERED_ABS]    ; FF 05 disp32
    w8(0xFF); w8(0x05); w32(ANSWERED_ABS);
    // RET 16                      ; C2 10 00
    w8(0xC2); w8(0x10); w8(0x00);

    // One landing pad per reason: count it, then hand the call to the OUT trap with the
    // stack untouched, so the JS thunk sees exactly the frame the guest built.
    const firstBailAddr = off;
    LOCALE_STUB_BAIL_REASONS.forEach((_reason, i) => {
        const padAddr = off;
        // INC dword [BAIL_ABS + i*4]  ; FF 05 disp32
        w8(0xFF); w8(0x05); w32(tableAddr + LOCALE_STUB_BAIL_OFF + i * 4);
        // JMP rel32 trapAddr          ; E9 rel32
        w8(0xE9);
        const jmpRel = off;
        w32(trapAddr - (jmpRel + 4));
        for (const patchOff of bailPatches[i]) dv.setInt32(patchOff, padAddr - (patchOff + 4), true);
    });
    for (const patchOff of haveBufPatches) dv.setInt32(patchOff, haveBufAddr - (patchOff + 4), true);

    Logger.log(LogCategory.SYSTEM,
        `Inline GetLocaleInfoW stub emitted: 0x${getLocaleInfoWStub.toString(16)} ` +
        `(${firstBailAddr - getLocaleInfoWStub}B body + ${LOCALE_STUB_BAIL_REASONS.length} bail pads, ` +
        `table=0x${tableAddr.toString(16)}, ` +
        `trap=0x${trapAddr.toString(16)})`);

    installed = { getLocaleInfoWStub, tableAddr, regionBase: base, regionEnd: base + REGION_SIZE };
    return installed;
}
