// Locale value tables and the pre-built UTF-16LE answer cache shared by every
// GetLocaleInfoW tier: the full thunk, the JS fast path, and the trap-free inline
// x86 stub (whose guest-RAM table is SERIALISED FROM THIS CACHE — see
// serializeLocaleStubTable, and locale-stubs.ts for the stub that reads it). One
// source of truth is why the stub and the JS handler cannot answer differently.
//
// Leaf module by design: it imports nothing but EmulatorConfig, so pe-loader can
// pull the serialiser in without dragging the kernel32 module graph behind it.

import { EmulatorConfig } from '../../core/emulator-config-manager';

// US English (0409) locale data, keyed by LCTYPE.
//
// LCTYPE values and en-US answers are taken from winnls.h and Wine's kernelbase/locale.c
// (the derived fields — IPOSSIGNPOSN/INEGSIGNPOSN/I*SYMPRECEDES/I*SEPBYSPACE — are what
// that file computes from ICURRENCY=0 / INEGCURR=0). The set is deliberately COMPLETE for
// the range the CRT walks: `setlocale()` rebuilds the whole of `lconv` from these. A type
// we do not hold is NOT answered with an empty string — that is a wrong answer the caller
// cannot detect (a missing SNEGATIVESIGN formats -1 as 1); it fails with
// ERROR_INVALID_FLAGS, exactly as GetLocaleInfoW does off the end of its own switch.
//
// Numeric types are stored in the spelling Wine's locale_return_number PRINTS them in
// (%04x for ILANGUAGE/IDEFAULTLANGUAGE, %03u for IDEFAULTEBCDICCODEPAGE, %u otherwise),
// so LOCALE_RETURN_NUMBER must parse them back with localeNumericValue's per-type radix.
const US_LOCALE_DATA: Record<number, string> = {
    0x0001: "0409",            // ILANGUAGE
    0x0002: "English (United States)", // SLANGUAGE
    0x0003: "ENU",             // SABBREVLANGNAME
    0x0004: "English",         // SNATIVELANGNAME
    0x0005: "1",               // ICOUNTRY
    0x0006: "United States",   // SCOUNTRY
    0x0007: "USA",             // SABBREVCTRYNAME
    0x0008: "United States",   // SNATIVECTRYNAME
    0x0009: "0409",            // IDEFAULTLANGUAGE
    0x000A: "1",               // IDEFAULTCOUNTRY
    0x000B: "437",             // IDEFAULTCODEPAGE     (overridden by the OEM code page)
    0x000C: ",",               // SLIST
    0x000D: "1",               // IMEASURE             (0 = metric, 1 = US)
    0x000E: ".",               // SDECIMAL
    0x000F: ",",               // STHOUSAND
    0x0010: "3;0",             // SGROUPING
    0x0011: "2",               // IDIGITS
    0x0012: "1",               // ILZERO
    0x0013: "0123456789",      // SNATIVEDIGITS
    0x0014: "$",               // SCURRENCY
    0x0015: "USD",             // SINTLSYMBOL
    0x0016: ".",               // SMONDECIMALSEP
    0x0017: ",",               // SMONTHOUSANDSEP
    0x0018: "3;0",             // SMONGROUPING
    0x0019: "2",               // ICURRDIGITS
    0x001A: "2",               // IINTLCURRDIGITS
    0x001B: "0",               // ICURRENCY
    0x001C: "0",               // INEGCURR
    0x001D: "/",               // SDATE
    0x001E: ":",               // STIME
    0x001F: "M/d/yyyy",        // SSHORTDATE
    0x0020: "dddd, MMMM dd, yyyy", // SLONGDATE
    0x0021: "0",               // IDATE                (MDY)
    0x0022: "0",               // ILDATE
    0x0023: "0",               // ITIME                (12-hour)
    0x0024: "0",               // ICENTURY
    0x0025: "0",               // ITLZERO
    0x0026: "0",               // IDAYLZERO
    0x0027: "0",               // IMONLZERO
    0x0028: "AM",              // S1159
    0x0029: "PM",              // S2359
    0x002A: "Monday",          // SDAYNAME1 (LCTYPE day 1 is MONDAY, not Sunday)
    0x002B: "Tuesday",
    0x002C: "Wednesday",
    0x002D: "Thursday",
    0x002E: "Friday",
    0x002F: "Saturday",
    0x0030: "Sunday",          // SDAYNAME7
    0x0031: "Mon",             // SABBREVDAYNAME1
    0x0032: "Tue",
    0x0033: "Wed",
    0x0034: "Thu",
    0x0035: "Fri",
    0x0036: "Sat",
    0x0037: "Sun",             // SABBREVDAYNAME7
    0x0038: "January",         // SMONTHNAME1
    0x0039: "February",
    0x003A: "March",
    0x003B: "April",
    0x003C: "May",
    0x003D: "June",
    0x003E: "July",
    0x003F: "August",
    0x0040: "September",
    0x0041: "October",
    0x0042: "November",
    0x0043: "December",        // SMONTHNAME12
    0x0044: "Jan",             // SABBREVMONTHNAME1
    0x0045: "Feb",
    0x0046: "Mar",
    0x0047: "Apr",
    0x0048: "May",
    0x0049: "Jun",
    0x004A: "Jul",
    0x004B: "Aug",
    0x004C: "Sep",
    0x004D: "Oct",
    0x004E: "Nov",
    0x004F: "Dec",             // SABBREVMONTHNAME12
    0x0050: "",                // SPOSITIVESIGN        (en-US has none)
    0x0051: "-",               // SNEGATIVESIGN
    0x0052: "3",               // IPOSSIGNPOSN         (from INEGCURR = 0)
    0x0053: "0",               // INEGSIGNPOSN
    0x0054: "1",               // IPOSSYMPRECEDES      (from ICURRENCY = 0)
    0x0055: "0",               // IPOSSEPBYSPACE
    0x0056: "1",               // INEGSYMPRECEDES
    0x0057: "0",               // INEGSEPBYSPACE
    0x0059: "en",              // SISO639LANGNAME
    0x005A: "US",              // SISO3166CTRYNAME
    0x1001: "English",         // SENGLANGUAGE
    0x1002: "United States",   // SENGCOUNTRY
    0x1003: "h:mm:ss tt",      // STIMEFORMAT
    0x1004: "1252",            // IDEFAULTANSICODEPAGE (overridden by the ANSI code page)
    0x1005: "0",               // ITIMEMARKPOSN
    0x1006: "MMMM yyyy",       // SYEARMONTH
    0x1007: "US Dollar",       // SENGCURRNAME
    0x1008: "US Dollar",       // SNATIVECURRNAME
    0x1009: "1",               // ICALENDARTYPE        (Gregorian)
    0x100A: "1",               // IPAPERSIZE           (letter)
    0x100B: "0",               // IOPTIONALCALENDAR
    0x100C: "6",               // IFIRSTDAYOFWEEK      (0 = Monday .. 6 = Sunday)
    0x100D: "0",               // IFIRSTWEEKOFYEAR
    0x1010: "1",               // INEGNUMBER
    0x1011: "10000",           // IDEFAULTMACCODEPAGE
    0x1012: "037",             // IDEFAULTEBCDICCODEPAGE (Wine prints this one %03u)
    0x1013: "Default",         // SSORTNAME
    0x1014: "1",               // IDIGITSUBSTITUTION   (none)
};

// Dynamic locale value lookup — overrides static table for codepage-dependent fields
export function getLocaleValue(cleanType: number): string | undefined {
    const config = EmulatorConfig.getInstance();
    // LOCALE_IDEFAULTCODEPAGE (0x000B) — OEM code page
    if (cleanType === 0x000B) return String(config.oemCodePage);
    // LOCALE_IDEFAULTANSICODEPAGE (0x1004) — ANSI code page
    if (cleanType === 0x1004) return String(config.ansiCodePage);
    return US_LOCALE_DATA[cleanType];
}

/**
 * The number LOCALE_RETURN_NUMBER must hand back for `value`.
 *
 * The radix is a property of the LCTYPE, not of the digits: Wine's locale_return_number
 * formats ILANGUAGE / IDEFAULTLANGUAGE as %04x, so "0409" is the LANGID 0x409 (1033) and
 * reading it as decimal answers 409 — a number no Windows ever returns.
 */
export function localeNumericValue(cleanType: number, value: string): number {
    const radix = (cleanType === 0x0001 || cleanType === 0x0009) ? 16 : 10;
    const n = parseInt(value, radix);
    return Number.isFinite(n) ? n >>> 0 : 0;
}

// Pre-built UTF-16LE byte buffers for GetLocaleInfoW (keyed by cleanType)
// Built lazily on first call to registerFastPathLocaleFunctions so EmulatorConfig is ready.
export let _localeWCache: Map<number, Uint8Array> | null = null;
/** RETURN_NUMBER values by cleanType. Uint32, not Uint16: a LANGID is 0x409 today but the
 *  out-param is a DWORD and a page number (10000) or a hex LCID must survive the store. */
export let _localeWNumCache: Uint32Array | null = null;
export const LOCALE_CACHE_SIZE = 0x1100;

export function ensureLocaleCache(): void {
    if (_localeWCache) return;
    _localeWCache = new Map();
    _localeWNumCache = new Uint32Array(LOCALE_CACHE_SIZE);
    const config = EmulatorConfig.getInstance();
    const entries: Record<number, string> = { ...US_LOCALE_DATA };
    entries[0x000B] = String(config.oemCodePage);
    entries[0x1004] = String(config.ansiCodePage);
    for (const [typeStr, value] of Object.entries(entries)) {
        const cleanType = parseInt(typeStr);
        const len = value.length + 1; // including null
        const buf = new Uint8Array(len * 2); // UTF-16LE
        for (let i = 0; i < value.length; i++) {
            buf[i * 2] = value.charCodeAt(i) & 0xFF;
            buf[i * 2 + 1] = 0; // ASCII locale strings are all BMP < 0x100
        }
        // null terminator is already 0
        _localeWCache.set(cleanType, buf);
        if (cleanType < LOCALE_CACHE_SIZE) {
            _localeWNumCache[cleanType] = localeNumericValue(cleanType, value);
        }
    }
}


// ============================================================================
// Guest-RAM table for the trap-free inline GetLocaleInfoW stub
// ============================================================================
// One THUNK_DATA blob the stub indexes with two loads and a copy:
//
//   +0x00  answered  u32       fast returns  (the stub's only visible instrument)
//   +0x04  destLimit u32       the stub's destination bound (see writeLocaleStubDestLimit)
//   +0x08  bail      u32 × 8   one per bail site, LOCALE_STUB_BAIL_REASONS order
//   +0x28  index     u32 × LOCALE_CACHE_SIZE, entry = (byteLen << 16) | blobOff
//                    0 = no such LCTYPE (the stub bails)
//   ...    blob      UTF-16LE strings, NUL-terminated, blobOff relative to blob base
//
// byteLen counts the NUL, so the stub's return value is byteLen >> 1 — exactly what
// the JS fast path returns for the same type.

export const LOCALE_STUB_ANSWERED_OFF = 0x00;
export const LOCALE_STUB_DESTLIMIT_OFF = 0x04;
export const LOCALE_STUB_BAIL_OFF = 0x08;
/** One counter per bail site, in emission order. A single "bailed" total says the stub
 *  declined; only the reason says whether that is the contract working (RETURN_NUMBER)
 *  or a table that is missing the types the caller actually asks for. */
export const LOCALE_STUB_BAIL_REASONS = [
    'returnNumber', 'typeOutOfTable', 'unknownType', 'negativeCch',
    'bufferTooSmall', 'nullDest', 'destWraps', 'destPastMemory',
] as const;
export const LOCALE_STUB_INDEX_OFF = LOCALE_STUB_BAIL_OFF + LOCALE_STUB_BAIL_REASONS.length * 4;
export const LOCALE_STUB_BLOB_OFF = LOCALE_STUB_INDEX_OFF + LOCALE_CACHE_SIZE * 4;

/**
 * The stub's destination bound, written once the table's own address is known.
 *
 * A length check against guest RAM is not validation (CLAUDE.md §3.1): the table lives in
 * writable THUNK_DATA, so a destination the stub accepts must stop BELOW it, or a wild
 * guest pointer rewrites the very blob both tiers answer out of — and an inline stub's
 * answers are invisible to every census we own. min(memLimit, tableAddr) puts the stub's
 * own data out of reach of every address it will accept.
 *
 * The serialised table ships with this field 0, which rejects every destination: a stub
 * whose bound was never installed declines rather than trusting a bare length check.
 */
export function writeLocaleStubDestLimit(mem: Uint8Array, tableAddr: number, memLimit: number): void {
    new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
        .setUint32(tableAddr + LOCALE_STUB_DESTLIMIT_OFF, Math.min(memLimit, tableAddr) >>> 0, true);
    installedLocaleStubTable = tableAddr >>> 0;
}

/** Guest address of the installed stub table, or 0 when no stub was emitted. */
let installedLocaleStubTable = 0;
export function localeStubTableAddr(): number { return installedLocaleStubTable; }

/**
 * The table bakes one ANSI code page (LOCALE_IDEFAULTANSICODEPAGE) and is answered out of
 * by guest code no census can see. `_setmbcp` can change that page at any point in a
 * title's life, and a stub that keeps answering from the old blob disagrees with the JS
 * tier silently — the one failure this three-tier design must not have. Zeroing destLimit
 * makes every stub call decline, so the answer comes from JS, which resolves live.
 */
export function retireLocaleStubTable(mem: Uint8Array): void {
    if (!installedLocaleStubTable) return;
    new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
        .setUint32(installedLocaleStubTable + LOCALE_STUB_DESTLIMIT_OFF, 0, true);
}

/** Drop the cached answers so the next call rebuilds them from the current config. */
export function invalidateLocaleCache(): void {
    _localeWCache = null;
    _localeWNumCache = null;
}

/**
 * Serialise the locale answer cache into the stub's guest-RAM layout.
 *
 * Generated FROM `_localeWCache`, the same map the JS fast path answers out of, so
 * the two tiers cannot disagree about a type's bytes or its length — a stronger
 * guarantee than any differential test, and the reason the stub needs none.
 *
 * The destination bound is left 0 here and installed by writeLocaleStubDestLimit once
 * the table's guest address is known.
 */
export function serializeLocaleStubTable(): Uint8Array {
    ensureLocaleCache();
    const cache = _localeWCache!;

    let blobBytes = 0;
    for (const [type, buf] of cache) {
        if (type >= LOCALE_CACHE_SIZE) continue;
        blobBytes += buf.length;
    }
    const out = new Uint8Array(LOCALE_STUB_BLOB_OFF + blobBytes);
    const dv = new DataView(out.buffer);

    let blobOff = 0;
    for (const [type, buf] of cache) {
        if (type >= LOCALE_CACHE_SIZE) continue;
        if (buf.length > 0xFFFF || blobOff > 0xFFFF) {
            // The entry packs both halves into one dword; a table that outgrew that is a
            // silently wrong stub, so refuse to build one.
            throw new Error(`[locale-stub] table entry does not fit: type=0x${type.toString(16)} len=${buf.length} off=${blobOff}`);
        }
        out.set(buf, LOCALE_STUB_BLOB_OFF + blobOff);
        dv.setUint32(LOCALE_STUB_INDEX_OFF + type * 4, ((buf.length << 16) | blobOff) >>> 0, true);
        blobOff += buf.length;
    }
    return out;
}
