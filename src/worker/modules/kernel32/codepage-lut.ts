// Single-byte code-page translation tables, and their serialisation into the guest-RAM
// table the trap-free MultiByteToWideChar / WideCharToMultiByte stubs read.
//
// The LUTs are built from the code page's own decoder, so a page's mapping has ONE
// definition; the stub table is a copy of THOSE arrays, so the inline stub and the JS
// fast path in locale.ts cannot answer differently — the same guarantee locale-data.ts
// gives GetLocaleInfoW.
//
// Leaf module by design: it imports nothing but emulator-config, so pe-loader can pull
// the serialiser in without dragging the kernel32 module graph behind it.

import { EmulatorConfig, getCodePageDecoder, isSingleByteCodePage } from '../../core/emulator-config-manager';

const _cpLutCache = new Map<number, Uint16Array | null>();

/**
 * byte → UTF-16 table for a single-byte code page, cached per page.
 *
 * The fast path needs a table, not a decoder: a TextDecoder call per conversion allocates
 * a JS string (two, with the terminator concat) and that is the whole cost of the slow
 * path. Null for any multi-byte page (UTF-8, DBCS), which isSingleByteCodePage decides —
 * a probe cannot, since a decoder answers a lone lead byte with one U+FFFD.
 */
export function codePageToUnicodeLut(codePage: number): Uint16Array | null {
    const cached = _cpLutCache.get(codePage);
    if (cached !== undefined) return cached;
    let lut: Uint16Array | null = null;
    if (isSingleByteCodePage(codePage)) {
        try {
            // Constructing the decoder can throw on a label the host does not know; a fast
            // path must never be the thing that raises, so an unbuildable table is simply
            // "no fast path for this page".
            const decoder = getCodePageDecoder(codePage);
            const one = new Uint8Array(1);
            lut = new Uint16Array(256);
            for (let b = 0; b < 256; b++) {
                one[0] = b;
                const ch = decoder.decode(one);
                if (ch.length !== 1) { lut = null; break; }
                lut[b] = ch.charCodeAt(0);
            }
        } catch {
            lut = null;
        }
    }
    _cpLutCache.set(codePage, lut);
    return lut;
}

const _cpRevLutCache = new Map<number, Uint16Array | null>();

/**
 * UTF-16 → byte table for a single-byte code page (0xffff = not representable on this page,
 * which is the caller's signal to take the slow path and its default-char rules). Derived
 * by inverting the same forward table, so the two cannot drift apart.
 */
export function codePageToByteLut(codePage: number): Uint16Array | null {
    const cached = _cpRevLutCache.get(codePage);
    if (cached !== undefined) return cached;
    const forward = codePageToUnicodeLut(codePage);
    let rev: Uint16Array | null = null;
    if (forward) {
        rev = new Uint16Array(65536).fill(0xffff);
        // Descending, so the LOWEST byte is written LAST and wins when a page maps two
        // bytes to one code point — matching the canonical encoding Windows picks.
        for (let b = 255; b >= 0; b--) rev[forward[b]!] = b;
    }
    _cpRevLutCache.set(codePage, rev);
    return rev;
}

export const MBWC_UNREPRESENTABLE = 0xffff;

// ============================================================================
// Guest-RAM table for the trap-free MultiByteToWideChar / WideCharToMultiByte stubs
// ============================================================================
//
//   +0x00  answeredMbtwc u32
//   +0x04  answeredWctmb u32
//   +0x08  memLimit      u32      guest RAM size — the stubs' SOURCE bound
//   +0x0C  destLimit     u32      the stubs' DESTINATION bound (writeMbwcStubDestLimit)
//   +0x10  bailMbtwc     u32 × MBTWC_BAIL_REASONS.length
//   ...    bailWctmb     u32 × WCTMB_BAIL_REASONS.length
//   ...    fwd           u16 × 256      byte → UTF-16
//   ...    rev           u16 × 65536    UTF-16 → byte (0xffff = unrepresentable)
//
// Both LUTs are addressed by the stubs as absolute disp32 + index*2. That is what keeps
// the copy loop inside EAX/ECX/EDX plus the three saved registers — a per-call LUT base
// would cost a register the loop does not have, which is why the table holds exactly ONE
// code page (the ANSI one) and every other page bails to the JS fast path.

export const MBWC_ANSWERED_MBTWC_OFF = 0x00;
export const MBWC_ANSWERED_WCTMB_OFF = 0x04;
export const MBWC_MEMLIMIT_OFF = 0x08;
export const MBWC_DESTLIMIT_OFF = 0x0C;

/** One counter per bail SITE, in emission order. A single total says the stub declined;
 *  only the reason says whether that is the contract working (a flag, another code page)
 *  or a shape the stub should have covered. Two sites that mean the same thing to a
 *  reader still get distinct names — a shared counter lets a reordered check pass while
 *  the census points at the wrong cause. */
export const MBTWC_BAIL_REASONS = [
    'flags', 'otherCodePage', 'nullSrc', 'negativeLength', 'zeroLength',
    'srcRangeWraps', 'srcPastMemory', 'srcScanWraps', 'srcScanPastMemory', 'srcTooLong',
    'negativeCch', 'bufferTooSmall', 'nullDest', 'destWraps', 'destPastMemory',
] as const;

export const WCTMB_BAIL_REASONS = [
    'flags', 'defaultChar', 'otherCodePage', 'nullSrc', 'negativeLength', 'zeroLength',
    'srcRangeWraps', 'srcPastMemory', 'srcScanWraps',
    'srcScanPastMemory', 'srcTooLong', 'unrepresentable',
    'negativeCb', 'bufferTooSmall', 'nullDest', 'destWraps', 'destPastMemory',
] as const;

export const MBWC_MBTWC_BAIL_OFF = 0x10;
export const MBWC_WCTMB_BAIL_OFF = MBWC_MBTWC_BAIL_OFF + MBTWC_BAIL_REASONS.length * 4;
/** u16-aligned by construction (both bail arrays are dword-sized). */
export const MBWC_FWD_OFF = MBWC_WCTMB_BAIL_OFF + WCTMB_BAIL_REASONS.length * 4;
export const MBWC_REV_OFF = MBWC_FWD_OFF + 256 * 2;
export const MBWC_TABLE_SIZE = MBWC_REV_OFF + 65536 * 2;

export interface MbwcStubTable {
    bytes: Uint8Array;
    /** The one code page the stubs serve — the configured ANSI page. */
    codePage: number;
    /** CP_OEMCP resolves to the same page, so the stubs may accept CodePage == 1 too. */
    alsoOem: boolean;
}

/**
 * The stubs' destination bound, written once the table's own address is known.
 *
 * A length check against guest RAM is not validation (CLAUDE.md §3.1): the 128KB LUT lives
 * in writable THUNK_DATA, so a destination the stubs accept must stop BELOW it, or a wild
 * guest pointer rewrites the very table both tiers translate out of — after which the stub
 * tier answers differently from JS forever, invisibly, since an inline stub is outside
 * every census. min(memLimit, tableAddr) puts the stubs' own data out of reach of every
 * address they will accept. Sources keep the plain memLimit: they are read-only.
 *
 * The serialised table ships with this field 0, which rejects every destination: stubs
 * whose bound was never installed decline rather than trusting a bare length check.
 */
/** Guest address of the installed MBWC table, or 0 when no stub was emitted. */
let installedMbwcStubTable = 0;
export function mbwcStubTableAddr(): number { return installedMbwcStubTable; }

/**
 * The stubs translate with the LUT of ONE baked code page and accept CP_ACP, which the JS
 * tier resolves against the live `EmulatorConfig.ansiCodePage`. After a `_setmbcp` the two
 * tiers would translate the same byte differently, invisibly. Zeroing destLimit declines
 * every stub call, so conversions go back to the tier that can see the change.
 */
export function retireMbwcStubTable(mem: Uint8Array): void {
    if (!installedMbwcStubTable) return;
    new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
        .setUint32(installedMbwcStubTable + MBWC_DESTLIMIT_OFF, 0, true);
}

export function writeMbwcStubDestLimit(mem: Uint8Array, tableAddr: number, memLimit: number): void {
    new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
        .setUint32(tableAddr + MBWC_DESTLIMIT_OFF, Math.min(memLimit, tableAddr) >>> 0, true);
    installedMbwcStubTable = tableAddr >>> 0;
}

/**
 * Serialise the ANSI code page's translation tables into the stubs' guest-RAM layout.
 *
 * Null when that page is not single-byte (UTF-8, DBCS): there is no 1:1 table to emit and
 * the JS fast path declines those conversions for the same reason.
 *
 * @param memLimit Guest RAM size; the stubs refuse any SOURCE range reaching past it. The
 *                 destination bound is installed separately by writeMbwcStubDestLimit.
 */
export function serializeMbwcStubTable(memLimit: number): MbwcStubTable | null {
    const config = EmulatorConfig.getInstance();
    const codePage = config.ansiCodePage;
    const fwd = codePageToUnicodeLut(codePage);
    const rev = codePageToByteLut(codePage);
    if (!fwd || !rev) return null;

    const bytes = new Uint8Array(MBWC_TABLE_SIZE);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(MBWC_MEMLIMIT_OFF, memLimit >>> 0, true);
    // Written entry-by-entry through the DataView rather than as raw typed-array bytes:
    // the guest reads these as little-endian words regardless of what the host is.
    for (let i = 0; i < fwd.length; i++) dv.setUint16(MBWC_FWD_OFF + i * 2, fwd[i]!, true);
    for (let i = 0; i < rev.length; i++) dv.setUint16(MBWC_REV_OFF + i * 2, rev[i]!, true);
    return { bytes, codePage, alsoOem: config.oemCodePage === codePage };
}
