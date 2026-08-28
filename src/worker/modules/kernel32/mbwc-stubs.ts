// Trap-free inline x86 stubs for kernel32!MultiByteToWideChar / WideCharToMultiByte.
//
// The MSVC CRT converts ANSI<->UTF-16 around every locale-aware string operation, so a
// title that compares filenames case-insensitively issues these by the million (House of
// 1,000 Doors: ~1.45M combined over a load). Both are already answered by JS fast paths;
// what is left to remove is the OUT trap itself.
//
// The two LUTs come from codepage-lut.ts — the SAME arrays locale.ts's fast path indexes,
// serialised into guest RAM — so stub and thunk cannot translate a byte differently.
// Everything outside the covered contract JMPs to the original OUT trap: another code
// page, any flag, lpDefaultChar/lpUsedDefaultChar, a non-representable code point, a
// negative or zero length, a destination too small (Win32 sets ERROR_INSUFFICIENT_BUFFER,
// and last-error is JS-side state a stub must not fake), NULL or out-of-range pointers.
//
// The table holds exactly ONE code page. A per-call LUT base costs a register, and the
// copy loop has none to spare once source, destination, count and the scratch byte are
// live; an absolute disp32 LUT is what keeps the loop inside EAX/ECX/EDX plus the three
// callee-saved registers pushed after the last bail. CP_OEMCP is accepted only when it
// resolves to the same page.
//
// No non-preemptible range: like the GetLocaleInfoW stub this touches no shared mutable
// state (the LUTs are read-only; the counters are plain increments whose exactness is not
// load-bearing), so a thread switch mid-stub is harmless.
//
// Codegen pinned by tools/tests/thunk-stub-emitters.test.ts; the emitted bytes are
// EXECUTED against the real tables and differenced against the JS fast path by
// tools/tests/mbwc-inline-stub.test.ts.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';
import {
    MBWC_ANSWERED_MBTWC_OFF, MBWC_ANSWERED_WCTMB_OFF, MBWC_MEMLIMIT_OFF, MBWC_DESTLIMIT_OFF,
    MBWC_MBTWC_BAIL_OFF, MBWC_WCTMB_BAIL_OFF, MBWC_FWD_OFF, MBWC_REV_OFF,
    MBTWC_BAIL_REASONS, WCTMB_BAIL_REASONS, MBWC_UNREPRESENTABLE,
} from './codepage-lut';

export interface MbwcInlineStubs {
    mbToWcStub: number;
    wcToMbStub: number;
    tableAddr: number;
    codePage: number;
    regionBase: number;
    regionEnd: number;
}

/** The installed stubs, for the `mbwcStubStats` harness verb. An inline stub answers
 *  inside guest code, so it is invisible to slowPathThunks / apiCensus / breakOnApi —
 *  "the count went to zero" and "the stub was never installed" look identical from every
 *  instrument we own. These counters are the only thing that tells them apart. */
let installed: MbwcInlineStubs | null = null;

export function getMbwcInlineStubs(): MbwcInlineStubs | null {
    return installed;
}

export function resetMbwcInlineStubs(): void {
    installed = null;
}

/** Longest NUL-terminated source (in BYTES) either stub will scan for a length. A scan is
 *  the one unbounded loop here; past this the call goes to JS, which has the whole address
 *  space to look at rather than a stub's fixed window. */
const SCAN_LIMIT_BYTES = 0x1000;

/** MB_PRECOMPOSED — the DEFAULT flag, and a no-op on a single-byte code page: there are no
 *  combining sequences to precompose. Every other flag bails. */
const MB_PRECOMPOSED = 0x0001;

/**
 * Emit both conversion stubs.
 *
 * `int MultiByteToWideChar(UINT, DWORD, LPCCH, int, LPWSTR, int)`  — stdcall, RET 24.
 * `int WideCharToMultiByte(UINT, DWORD, LPCWCH, int, LPSTR, int, LPCCH, LPBOOL)` — RET 32.
 *
 * @param allocator  Narrow THUNK_CODE allocator (ThunkMemoryManager.stubAllocator)
 * @param getMemory  Callback returning current guest memory (refetched after alloc)
 * @param tableAddr  Guest addr of the serialised table (serializeMbwcStubTable), already written
 * @param codePage   The one code page the table holds (the configured ANSI page)
 * @param alsoOem    Accept CP_OEMCP too — only when it resolves to the same page
 * @param mbToWcTrap Slow-path target: the original kernel32!MultiByteToWideChar OUT-trap stub
 * @param wcToMbTrap Slow-path target: the original kernel32!WideCharToMultiByte OUT-trap stub
 */
export function writeMbwcStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    tableAddr: number,
    codePage: number,
    alsoOem: boolean,
    mbToWcTrap: number,
    wcToMbTrap: number,
): MbwcInlineStubs {
    const REGION_SIZE = 1536;
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    // Bounds live INSIDE the emitters: a check after the fact is a check after the bytes
    // it was meant to stop have already landed in whatever follows the region.
    const limit = base + REGION_SIZE;
    const room = (n: number) => {
        if (off + n > limit) throw new Error(`[mbwc-stub] emit past the ${REGION_SIZE}B region`);
    };
    const w8 = (v: number) => { room(1); mem[off++] = v & 0xFF; };
    const w16 = (v: number) => { room(2); dv.setUint16(off, v & 0xFFFF, true); off += 2; };
    const w32 = (v: number) => { room(4); dv.setUint32(off, v >>> 0, true); off += 4; };

    const MEMLIMIT_ABS = tableAddr + MBWC_MEMLIMIT_OFF;
    const DESTLIMIT_ABS = tableAddr + MBWC_DESTLIMIT_OFF;
    const FWD_ABS = tableAddr + MBWC_FWD_OFF;
    const REV_ABS = tableAddr + MBWC_REV_OFF;

    // --- shared emit helpers -------------------------------------------------
    // A label is a list of rel32 patch sites; every forward jump records one and the
    // target address back-patches them all.
    type Label = { sites: number[] };
    const mkLabel = (): Label => ({ sites: [] });
    const jcc = (cc: number, l: Label) => { w8(0x0F); w8(cc); l.sites.push(off); w32(0); };
    const jmp = (l: Label) => { w8(0xE9); l.sites.push(off); w32(0); };
    const place = (l: Label) => { for (const s of l.sites) dv.setInt32(s, off - (s + 4), true); };
    const jbackNZ = (target: number) => { w8(0x0F); w8(0x85); w32(target - (off + 4)); };
    const jbackB = (target: number) => { w8(0x0F); w8(0x82); w32(target - (off + 4)); };

    const movEaxStack = (disp: number) => { w8(0x8B); w8(0x44); w8(0x24); w8(disp); };
    const movEcxStack = (disp: number) => { w8(0x8B); w8(0x4C); w8(0x24); w8(disp); };
    const movEdxStack = (disp: number) => { w8(0x8B); w8(0x54); w8(0x24); w8(disp); };
    const movEsiStack = (disp: number) => { w8(0x8B); w8(0x74); w8(0x24); w8(disp); };
    const cmpEaxImm = (v: number) => { w8(0x3D); w32(v); };
    const cmpRegAbs = (modrm: number, addr: number) => { w8(0x3B); w8(modrm); w32(addr); };
    const incAbs = (addr: number) => { w8(0xFF); w8(0x05); w32(addr); };
    const ret = (n: number) => { w8(0xC2); w16(n); };

    /**
     * Emit one direction. The two stubs differ only in element widths, the flag/default-char
     * preamble and the LUT they index, so they are ONE emitter parameterised by that —
     * a second hand-written copy is where the two would drift apart.
     */
    const emitDirection = (opts: {
        wideSource: boolean;
        trapAddr: number;
        answeredAbs: number;
        bailBaseAbs: number;
        reasons: readonly string[];
        retBytes: number;
        /** stack displacements, no pushes in effect */
        argCp: number; argFlags: number; argSrc: number; argSrcLen: number;
        argDst: number; argDstLen: number;
    }): number => {
        const entry = off;
        const bailLabels = new Map<string, Label>();
        const bail = (reason: string) => {
            if (!opts.reasons.includes(reason)) throw new Error(`[mbwc-stub] unknown bail reason ${reason}`);
            let l = bailLabels.get(reason);
            if (!l) { l = mkLabel(); bailLabels.set(reason, l); }
            return l;
        };
        const JZ = 0x84, JNZ = 0x85, JS = 0x88, JA = 0x87, JB = 0x82, JC = 0x82;

        // ---- flags ----
        movEaxStack(opts.argFlags);
        if (opts.wideSource) {
            // WideCharToMultiByte: the fast path declines every flag, so this does too.
            w8(0x85); w8(0xC0);                              // TEST EAX, EAX
            jcc(JNZ, bail('flags'));
            // lpDefaultChar / lpUsedDefaultChar are an out-of-band contract (substitution
            // reporting) that only the JS path implements; either one present is a bail.
            movEaxStack(opts.argDstLen + 4);                 // lpDefaultChar
            w8(0x0B); w8(0x44); w8(0x24); w8(opts.argDstLen + 8); // OR EAX, [ESP+lpUsedDefaultChar]
            jcc(JNZ, bail('defaultChar'));
        } else {
            w8(0x25); w32(~MB_PRECOMPOSED >>> 0);            // AND EAX, ~MB_PRECOMPOSED
            jcc(JNZ, bail('flags'));
        }

        // ---- code page: the one the table holds, plus its CP_ACP (and maybe CP_OEMCP) alias ----
        const cpOk = mkLabel();
        movEaxStack(opts.argCp);
        cmpEaxImm(0); jcc(JZ, cpOk);                          // CP_ACP
        cmpEaxImm(codePage); jcc(JZ, cpOk);
        if (alsoOem) { cmpEaxImm(1); jcc(JZ, cpOk); }         // CP_OEMCP, same page
        jmp(bail('otherCodePage'));
        place(cpOk);

        // ---- source pointer + length ----
        movEcxStack(opts.argSrc);
        w8(0x85); w8(0xC9);                                   // TEST ECX, ECX
        jcc(JZ, bail('nullSrc'));
        movEdxStack(opts.argSrcLen);
        const scan = mkLabel(), haveLen = mkLabel();
        w8(0x81); w8(0xFA); w32(0xFFFFFFFF);                  // CMP EDX, -1
        jcc(JZ, scan);
        w8(0x85); w8(0xD2);                                   // TEST EDX, EDX
        jcc(JS, bail('negativeLength'));
        jcc(JZ, bail('zeroLength'));
        // EAX = src + length*elemSize, bounded against guest RAM.
        w8(0x89); w8(0xD0);                                   // MOV EAX, EDX
        // A wide count is an int32 proven non-negative above, so doubling it cannot carry;
        // only adding the base can, and srcRangeWraps below is where that lands.
        if (opts.wideSource) { w8(0x01); w8(0xC0); }           // ADD EAX, EAX
        w8(0x01); w8(0xC8);                                   // ADD EAX, ECX
        jcc(JC, bail('srcRangeWraps'));
        cmpRegAbs(0x05, MEMLIMIT_ABS);                        // CMP EAX, [memLimit]
        jcc(JA, bail('srcPastMemory'));
        jmp(haveLen);

        // .scan — NUL-terminated source. EDX becomes the scan limit, EAX walks.
        place(scan);
        w8(0x89); w8(0xCA);                                   // MOV EDX, ECX
        w8(0x81); w8(0xC2); w32(SCAN_LIMIT_BYTES);            // ADD EDX, SCAN_LIMIT
        jcc(JC, bail('srcScanWraps'));
        cmpRegAbs(0x15, MEMLIMIT_ABS);                        // CMP EDX, [memLimit]
        jcc(JA, bail('srcScanPastMemory'));
        w8(0x89); w8(0xC8);                                   // MOV EAX, ECX
        const scanTop = off;
        const found = mkLabel();
        if (opts.wideSource) { w8(0x66); w8(0x83); w8(0x38); w8(0x00); } // CMP word [EAX], 0
        else { w8(0x80); w8(0x38); w8(0x00); }                           // CMP byte [EAX], 0
        jcc(JZ, found);
        w8(0x83); w8(0xC0); w8(opts.wideSource ? 2 : 1);      // ADD EAX, elemSize
        w8(0x39); w8(0xD0);                                   // CMP EAX, EDX
        jbackB(scanTop);
        jmp(bail('srcTooLong'));
        place(found);
        w8(0x29); w8(0xC8);                                   // SUB EAX, ECX
        if (opts.wideSource) { w8(0xD1); w8(0xE8); }          // SHR EAX, 1
        w8(0x40);                                             // INC EAX  (the terminator converts too)
        w8(0x89); w8(0xC2);                                   // MOV EDX, EAX

        // ECX = source, EDX = element count (> 0). One element in, one out: a single-byte
        // page is 1 byte <-> 1 WCHAR in both directions, which is why the count is the
        // answer to a size query and the loop trip count alike.
        place(haveLen);

        if (opts.wideSource) {
            // Every code point must be representable BEFORE anything is written — a
            // substitution is the default-char contract, which lives in JS. EAX walks,
            // EDX is the end, ECX is the scratch (the source pointer is re-read after).
            w8(0x89); w8(0xD0);                               // MOV EAX, EDX
            w8(0x01); w8(0xC0);                               // ADD EAX, EAX
            w8(0x01); w8(0xC8);                               // ADD EAX, ECX
            w8(0x89); w8(0xC2);                               // MOV EDX, EAX   (end)
            w8(0x89); w8(0xC8);                               // MOV EAX, ECX   (walk)
            const chkTop = off;
            w8(0x0F); w8(0xB7); w8(0x08);                     // MOVZX ECX, word [EAX]
            w8(0x66); w8(0x81); w8(0x3C); w8(0x4D); w32(REV_ABS); w16(MBWC_UNREPRESENTABLE);
            jcc(JZ, bail('unrepresentable'));
            w8(0x83); w8(0xC0); w8(0x02);                     // ADD EAX, 2
            w8(0x39); w8(0xD0);                               // CMP EAX, EDX
            jbackB(chkTop);
            // Back to (ECX = source, EDX = count).
            movEcxStack(opts.argSrc);
            w8(0x29); w8(0xCA);                               // SUB EDX, ECX
            w8(0xD1); w8(0xEA);                               // SHR EDX, 1
        }

        // ---- destination length ----
        movEaxStack(opts.argDstLen);
        w8(0x85); w8(0xC0);                                   // TEST EAX, EAX
        jcc(JS, bail(opts.wideSource ? 'negativeCb' : 'negativeCch'));
        const haveBuf = mkLabel();
        jcc(JNZ, haveBuf);
        // Size query: the count, nothing written.
        w8(0x89); w8(0xD0);                                   // MOV EAX, EDX
        incAbs(opts.answeredAbs);
        ret(opts.retBytes);

        place(haveBuf);
        w8(0x39); w8(0xC2);                                   // CMP EDX, EAX
        jcc(JA, bail('bufferTooSmall'));                      // truncation is the caller's
        movEcxStack(opts.argDst);                             // error path, not ours
        w8(0x85); w8(0xC9);                                   // TEST ECX, ECX
        jcc(JZ, bail('nullDest'));
        w8(0x89); w8(0xD0);                                   // MOV EAX, EDX
        if (!opts.wideSource) { w8(0x01); w8(0xC0); }         // ADD EAX, EAX (WCHAR dest)
        w8(0x01); w8(0xC8);                                   // ADD EAX, ECX
        jcc(JC, bail('destWraps'));
        // The DESTINATION bound, not the source one: it also stops below the stubs' own
        // LUT, so no address they accept can rewrite the table they translate out of.
        cmpRegAbs(0x05, DESTLIMIT_ABS);                       // CMP EAX, [destLimit]
        jcc(JA, bail('destPastMemory'));

        // Every bail is behind us, so the callee-saved registers can be spent without an
        // unwind path — the same shape the GetLocaleInfoW stub uses.
        w8(0x56);                                             // PUSH ESI
        w8(0x57);                                             // PUSH EDI
        w8(0x53);                                             // PUSH EBX
        movEsiStack(12 + opts.argSrc);                        // source (args moved by 3 pushes)
        w8(0x89); w8(0xCF);                                   // MOV EDI, ECX   destination
        w8(0x89); w8(0xD3);                                   // MOV EBX, EDX   count, for EAX
        w8(0x89); w8(0xD1);                                   // MOV ECX, EDX
        const loopTop = off;
        if (opts.wideSource) {
            w8(0x0F); w8(0xB7); w8(0x16);                     // MOVZX EDX, word [ESI]
            w8(0x8A); w8(0x14); w8(0x55); w32(REV_ABS);       // MOV DL, [REV + EDX*2]
            w8(0x88); w8(0x17);                               // MOV [EDI], DL
            w8(0x83); w8(0xC6); w8(0x02);                     // ADD ESI, 2
            w8(0x47);                                         // INC EDI
        } else {
            w8(0x0F); w8(0xB6); w8(0x16);                     // MOVZX EDX, byte [ESI]
            w8(0x66); w8(0x8B); w8(0x14); w8(0x55); w32(FWD_ABS); // MOV DX, [FWD + EDX*2]
            w8(0x66); w8(0x89); w8(0x17);                     // MOV [EDI], DX
            w8(0x46);                                         // INC ESI
            w8(0x83); w8(0xC7); w8(0x02);                     // ADD EDI, 2
        }
        w8(0x49);                                             // DEC ECX
        jbackNZ(loopTop);
        w8(0x89); w8(0xD8);                                   // MOV EAX, EBX
        w8(0x5B);                                             // POP EBX
        w8(0x5F);                                             // POP EDI
        w8(0x5E);                                             // POP ESI
        incAbs(opts.answeredAbs);
        ret(opts.retBytes);

        // One landing pad per reason: count it, then hand the call to the OUT trap with the
        // stack untouched, so the JS thunk sees exactly the frame the guest built.
        opts.reasons.forEach((reason, i) => {
            const l = bailLabels.get(reason);
            if (!l) return;   // a reason with no site emits no pad
            place(l);
            incAbs(opts.bailBaseAbs + i * 4);
            w8(0xE9); w32(opts.trapAddr - (off + 4));
        });
        return entry;
    };

    const mbToWcStub = emitDirection({
        wideSource: false,
        trapAddr: mbToWcTrap,
        answeredAbs: tableAddr + MBWC_ANSWERED_MBTWC_OFF,
        bailBaseAbs: tableAddr + MBWC_MBTWC_BAIL_OFF,
        reasons: MBTWC_BAIL_REASONS,
        retBytes: 24,
        argCp: 4, argFlags: 8, argSrc: 12, argSrcLen: 16, argDst: 20, argDstLen: 24,
    });
    const wcToMbStub = emitDirection({
        wideSource: true,
        trapAddr: wcToMbTrap,
        answeredAbs: tableAddr + MBWC_ANSWERED_WCTMB_OFF,
        bailBaseAbs: tableAddr + MBWC_WCTMB_BAIL_OFF,
        reasons: WCTMB_BAIL_REASONS,
        retBytes: 32,
        argCp: 4, argFlags: 8, argSrc: 12, argSrcLen: 16, argDst: 20, argDstLen: 24,
    });

    Logger.log(LogCategory.SYSTEM,
        `Inline MultiByteToWideChar/WideCharToMultiByte stubs emitted: ` +
        `0x${mbToWcStub.toString(16)} / 0x${wcToMbStub.toString(16)} ` +
        `(cp=${codePage}${alsoOem ? '+oem' : ''}, table=0x${tableAddr.toString(16)}, ` +
        `traps=0x${mbToWcTrap.toString(16)}/0x${wcToMbTrap.toString(16)})`);

    installed = {
        mbToWcStub, wcToMbStub, tableAddr, codePage,
        regionBase: base, regionEnd: base + REGION_SIZE,
    };
    return installed;
}
