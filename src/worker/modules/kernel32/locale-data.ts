// The single source of every locale answer: getLocaleValue(lcid, lctype), backed by the
// compiled locale database (locale-db.ts), and the pre-built answer caches the fast
// GetLocaleInfo tiers serve for the process locale — the JS fast path and the trap-free
// inline x86 stub, whose guest-RAM table is SERIALISED FROM THE SAME CACHE (see
// serializeLocaleStubTable, and locale-stubs.ts for the stub that reads it). The caches are
// filled through localeInfo, the function the thunk answers with, so no tier can differ.
//
// The LCTYPE -> field mapping, including the derived fields (SDATE/IDATE/... parsed out of
// the date and time pictures, the sign positions computed from ICURRENCY and INEGCURR),
// follows kernelbase's get_locale_info.
//
// Kept free of the kernel32 module graph (EmulatorConfig and the locale-db/-names leaves
// only) so pe-loader can pull the serialiser in cheaply.

import { EmulatorConfig, encodeAnsiString } from '../../core/emulator-config-manager';
import { arrayItem, arrayPresent, localeField, localeString } from './locale-db';
import { LocaleField as F } from './locale-db-schema';
import { DEFAULT_PSEUDO_LCIDS, type LocaleEntry, localeFromLcid, userDefaultLocale } from './locale-names';

export const LOCALE_NOUSEROVERRIDE = 0x80000000;
export const LOCALE_USE_CP_ACP = 0x40000000;
export const LOCALE_RETURN_NUMBER = 0x20000000;
export const LOCALE_RETURN_GENITIVE_NAMES = 0x10000000;
/** Binary: 16 WCHARs with no terminator, returned by count, never as a string. */
export const LOCALE_FONTSIGNATURE = 0x0058;
export const LOCALE_SSHORTTIME = 0x0079;

const CP_ACP = 0, CP_OEMCP = 1, CP_MACCP = 2, CP_UTF8 = 65001;

// ---------------------------------------------------------------------------------------
// Picture scanning (find_format) for the fields derived from SSHORTDATE / STIMEFORMAT
// ---------------------------------------------------------------------------------------

/** find_format: the first format character from `accept` at or after `from`, skipping
 *  quoted runs and "ddd"/"dddd" (a day name is not a day field); -1 when there is none. */
function findFormat(s: string, from: number, accept: string): number {
    for (let i = from; i < s.length; i++) {
        const c = s[i]!;
        if (c === "'") {
            i = s.indexOf("'", i + 1);
            if (i < 0) return -1;
        } else if (accept.includes(c)) {
            if (c !== 'd' || s[i + 1] !== 'd' || s[i + 2] !== 'd') return i;
            i += 2;
            while (s[i + 1] === 'd') i++;
        }
    }
    return -1;
}

/** LOCALE_SDATE / LOCALE_STIME: what separates the picture's first two fields. */
function pictureSeparator(pic: string, accept: string): string | undefined {
    let i = findFormat(pic, 0, accept);
    if (i < 0) return undefined;
    while (pic[i + 1] === pic[i]) i++;
    const end = findFormat(pic, i + 1, accept);
    return end < 0 ? undefined : pic.slice(i + 1, end);
}

/** IDATE / ILDATE: 0 = MDY, 1 = DMY, 2 = YMD — whichever of d/y last precedes the month. */
function dateOrder(pic: string): number {
    let val = 0;
    for (let i = findFormat(pic, 0, 'dMy'); i >= 0; i = findFormat(pic, i + 1, 'dMy')) {
        if (pic[i] === 'M') break;
        val = pic[i] === 'y' ? 2 : 1;
    }
    return val;
}

/** A property of the first `accept` field of a picture, or undefined when it has none. */
function pictureFlag(pic: string, accept: string, test: (pic: string, i: number) => boolean): number | undefined {
    const i = findFormat(pic, 0, accept);
    return i < 0 ? undefined : +test(pic, i);
}

const IPOSSIGNPOSN = [3, 3, 4, 2, 1, 1, 3, 4, 1, 3, 4, 2, 4, 3, 3, 1];
const INEGSIGNPOSN = [0, 3, 4, 2, 0, 1, 3, 4, 1, 3, 4, 2, 4, 3, 0, 0];
const INEGSYMPRECEDES = [1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0];

/** get_locale_sortname: the sort's display name is keyed by the LCID, not the locale row. */
function sortName(lcid: number): string {
    const primary = lcid & 0x3ff, sub = (lcid >>> 10) & 0x3f, sort = (lcid >>> 16) & 0xf;
    switch (primary) {
        case 0x04: // LANG_CHINESE
            switch (sort) {
                case 0: return (sub === 0x01 || sub === 0x03 || sub === 0x1f) ? 'Stroke Count' : 'Pronunciation';
                case 1: return 'Unicode';
                case 2: return 'Stroke Count';
                case 3: return 'Bopomofo';
                case 4: return 'Radical/Stroke';
                case 5: return 'Surname';
            }
            break;
        case 0x37: return sort === 1 ? 'Modern' : 'Traditional';               // LANG_GEORGIAN
        case 0x07:                                                             // LANG_GERMAN
            if (sub === 0 || sub === 1) return sort === 1 ? 'Phone Book (DIN)' : 'Dictionary';
            break;
        case 0x0e: if (sort === 1) return 'Technical'; break;                  // LANG_HUNGARIAN
        case 0x7f: return sort === 0 ? 'Default' : 'Maths Alphanumerics';      // LANG_INVARIANT
        case 0x11:                                                             // LANG_JAPANESE
            if (sort === 1) return 'XJIS';
            if (sort === 2) return 'Unicode';
            if (sort === 4) return 'Radical/Stroke';
            break;
        case 0x12: return sort === 1 ? 'Unicode' : 'Dictionary';              // LANG_KOREAN
        case 0x0a:                                                             // LANG_SPANISH
            if (sub === 0 || sub === 3) return 'International';
            if (sub === 1) return 'Traditional';
            break;
    }
    return 'Default';
}

// ---------------------------------------------------------------------------------------
// get_locale_info
// ---------------------------------------------------------------------------------------

/** A locale answer: a string, or a number for the types locale_return_number serves. */
export type LocaleValue = string | number;

/** The process (user = system) default locale, where the manifest's code pages apply. */
function isDefaultRow(entry: LocaleEntry): boolean {
    return entry.locale === userDefaultLocale().locale;
}

/** Month names honour LOCALE_RETURN_GENITIVE_NAMES when the locale has genitive forms. */
function monthName(row: number, lctype: number, abbrev: boolean, idx: number): string {
    const genitive = localeField(row, abbrev ? F.AAbbrevGenitiveMonth : F.AGenitiveMonth);
    const arr = (lctype & LOCALE_RETURN_GENITIVE_NAMES) && arrayPresent(genitive)
        ? genitive
        : localeField(row, abbrev ? F.AAbbrevMonthName : F.AMonthName);
    return arrayItem(arr, idx);
}

/**
 * get_locale_info for a resolved locale: the answer for `lctype` (flags in the high word
 * honoured where Windows honours them), or `undefined` for an LCTYPE Windows fails with
 * ERROR_INVALID_FLAGS.
 */
export function localeInfo(entry: LocaleEntry, lctype: number): LocaleValue | undefined {
    const row = entry.locale;
    const s = (f: F) => localeString(row, f);
    const n = (f: F) => localeField(row, f);
    const first = (f: F) => arrayItem(localeField(row, f), 0);
    const type = lctype & 0xffff;
    switch (type) {
        case 0x0001: return n(F.INotNeutral) ? n(F.ILanguage) : n(F.IDefaultLanguage);   // ILANGUAGE
        case 0x0002: return s(F.SEngDisplayName);            // SLOCALIZEDDISPLAYNAME
        case 0x0003: return s(F.SAbbrevLangName);
        case 0x0004: return s(F.SNativeLangName);
        case 0x0005: return n(F.ICountry);
        case 0x0006: return s(F.SEngCountry);                // SLOCALIZEDCOUNTRYNAME
        case 0x0007: return s(F.SAbbrevCtryName);
        case 0x0008: return s(F.SNativeCtryName);
        case 0x0009: return n(F.IDefaultLanguage);
        case 0x000A: return n(F.ICountry);                   // IDEFAULTCOUNTRY
        case 0x000B: {                                       // IDEFAULTCODEPAGE (OEM)
            if (isDefaultRow(entry)) return EmulatorConfig.getInstance().oemCodePage;
            const cp = n(F.IDefaultCodePage);
            return cp === CP_UTF8 ? CP_OEMCP : cp;
        }
        case 0x000C: return s(F.SList);
        case 0x000D: return n(F.IMeasure);
        case 0x000E: return s(F.SDecimal);
        case 0x000F: return s(F.SThousand);
        case 0x0010: return s(F.SGrouping);
        case 0x0011: return n(F.IDigits);
        case 0x0012: return n(F.ILZero);
        case 0x0013: return s(F.SNativeDigits);
        case 0x0014: return s(F.SCurrency);
        case 0x0015: return s(F.SIntlSymbol);
        case 0x0016: return s(F.SMonDecimalSep);
        case 0x0017: return s(F.SMonThousandSep);
        case 0x0018: return s(F.SMonGrouping);
        case 0x0019:                                         // ICURRDIGITS
        case 0x001A: return n(F.ICurrDigits);                // IINTLCURRDIGITS
        case 0x001B: return n(F.ICurrency);
        case 0x001C: return n(F.INegCurr);
        case 0x001D: return pictureSeparator(first(F.AShortDate), 'dMy');     // SDATE
        case 0x001E: return pictureSeparator(first(F.ATimeFormat), 'Hhms');   // STIME
        case 0x001F: return first(F.AShortDate);
        case 0x0020: return first(F.ALongDate);
        case 0x0021: return dateOrder(first(F.AShortDate));                  // IDATE
        case 0x0022: return dateOrder(first(F.ALongDate));                   // ILDATE
        case 0x0023: return pictureFlag(first(F.ATimeFormat), 'Hh', (p, i) => p[i] === 'H');        // ITIME
        case 0x0024: return pictureFlag(first(F.AShortDate), 'y', (p, i) => p.startsWith('yyyy', i)); // ICENTURY
        case 0x0025: return pictureFlag(first(F.ATimeFormat), 'Hh', (p, i) => p[i + 1] === p[i]);   // ITLZERO
        case 0x0026: return pictureFlag(first(F.AShortDate), 'd', (p, i) => p[i + 1] === 'd');      // IDAYLZERO
        case 0x0027: return pictureFlag(first(F.AShortDate), 'M', (p, i) => p[i + 1] === 'M');      // IMONLZERO
        case 0x0028: return s(F.S1159);
        case 0x0029: return s(F.S2359);
        case 0x0050: return s(F.SPositiveSign);
        case 0x0051: return s(F.SNegativeSign);
        case 0x0052: return IPOSSIGNPOSN[n(F.INegCurr) & 15];
        case 0x0053: return INEGSIGNPOSN[n(F.INegCurr) & 15];
        case 0x0054: return +!(n(F.ICurrency) & 1);         // IPOSSYMPRECEDES
        case 0x0055: return +!!(n(F.ICurrency) & 2);        // IPOSSEPBYSPACE
        case 0x0056: return INEGSYMPRECEDES[n(F.INegCurr) & 15];
        case 0x0057: return +(n(F.INegCurr) >= 8);          // INEGSEPBYSPACE
        case LOCALE_FONTSIGNATURE: return s(F.FontSignature);
        case 0x0059: return s(F.SIso639LangName);
        case 0x005A: return s(F.SIso3166CtryName);
        case 0x005B: return (n(F.IGeoIdLo) | (n(F.IGeoIdHi) << 16)) >>> 0;      // IGEOID
        case 0x005C: return entry.name;                                      // SNAME
        case 0x005D: return first(F.ADuration);
        case 0x005E: return s(F.SKeyboardsToInstall);
        case 0x0067: return s(F.SIso639LangName2);
        case 0x0068: return s(F.SIso3166CtryName2);
        case 0x0069: return s(F.SNan);
        case 0x006A: return s(F.SPosInfinity);
        case 0x006B: return s(F.SNegInfinity);
        case 0x006C: return s(F.SScripts);
        case 0x006D: return s(F.SParent);
        case 0x006E: return s(F.SConsoleFallbackName);
        case 0x006F: return s(F.SEngLanguage);               // SLOCALIZEDLANGUAGENAME
        case 0x0070: return n(F.IReadingLayout);
        case 0x0071: return +!n(F.INotNeutral);              // INEUTRAL
        case 0x0072: return s(F.SEngDisplayName);
        case 0x0073: return s(F.SNativeDisplayName);
        case 0x0074: return n(F.INegativePercent);
        case 0x0075: return n(F.IPositivePercent);
        case 0x0076: return s(F.SPercent);
        case 0x0077: return '‰';                        // SPERMILLE
        case 0x0078: return first(F.AMonthDay);
        case LOCALE_SSHORTTIME: return first(F.AShortTime);
        case 0x007A: return s(F.SOpenTypeLanguageTag);
        case 0x007B: return entry.alternateSort ? entry.name : s(F.SSortLocale);  // SSORTLOCALE
        case 0x007C: return s(F.SRelativeLongDate);
        case 0x007D: return 0;                               // undocumented; always 0
        case 0x007E: return s(F.SShortestAm);
        case 0x007F: return s(F.SShortestPm);
        case 0x1001: return s(F.SEngLanguage);
        case 0x1002: return s(F.SEngCountry);
        case 0x1003: return first(F.ATimeFormat);
        case 0x1004: {                                       // IDEFAULTANSICODEPAGE
            if (isDefaultRow(entry)) return EmulatorConfig.getInstance().ansiCodePage;
            const cp = n(F.IDefaultAnsiCodePage);
            return cp === CP_UTF8 ? CP_ACP : cp;
        }
        case 0x1005: return pictureFlag(first(F.ATimeFormat), 'Hhmst', (p, i) => p[i] === 't');    // ITIMEMARKPOSN
        case 0x1006: return first(F.AYearMonth);
        case 0x1007: return s(F.SEngCurrName);
        case 0x1008: return s(F.SNativeCurrName);
        case 0x1009: return n(F.ICalendarType);
        case 0x100A: return n(F.IPaperSize);
        case 0x100B: return n(F.IOptionalCalendar);
        case 0x100C: return (n(F.IFirstDayOfWeek) + 6) % 7;  // stored Monday = 0
        case 0x100D: return n(F.IFirstWeekOfYear);
        case 0x100E: return monthName(row, lctype, false, 12);
        case 0x100F: return monthName(row, lctype, true, 12);
        case 0x1010: return n(F.INegNumber);
        case 0x1011: {                                       // IDEFAULTMACCODEPAGE
            const cp = n(F.IDefaultMacCodePage);
            return cp === CP_UTF8 ? CP_MACCP : cp;
        }
        case 0x1012: return n(F.IDefaultEbcdicCodePage);
        case 0x1013: return sortName(entry.lcid);
        case 0x1014: return n(F.IDigitSubstitution);
    }
    // LCTYPE day 1 is Monday; the stored arrays start on Sunday.
    if (type >= 0x002A && type <= 0x0030) return arrayItem(n(F.ADayName), (type - 0x002A + 1) % 7);
    if (type >= 0x0031 && type <= 0x0037) return arrayItem(n(F.AAbbrevDayName), (type - 0x0031 + 1) % 7);
    if (type >= 0x0060 && type <= 0x0066) return arrayItem(n(F.AShortestDayName), (type - 0x0060 + 1) % 7);
    if (type >= 0x0038 && type <= 0x0043) return monthName(row, lctype, false, type - 0x0038);
    if (type >= 0x0044 && type <= 0x004F) return monthName(row, lctype, true, type - 0x0044);
    return undefined;
}

/** locale_return_number's text: %04x for the two LANGID types, %03u for the EBCDIC page. */
export function localeNumberText(lctype: number, value: number): string {
    const type = lctype & 0xffff;
    if (type === 0x0001 || type === 0x0009) return value.toString(16).padStart(4, '0');
    if (type === 0x1012) return String(value).padStart(3, '0');
    return String(value);
}

/**
 * The WCHARs GetLocaleInfoW writes for an answer: the text plus its NUL — except
 * LOCALE_FONTSIGNATURE, which is binary and returned by exact count.
 */
export function localeWideData(lctype: number, value: LocaleValue): string {
    if (typeof value === 'number') return localeNumberText(lctype, value) + '\0';
    return (lctype & 0xffff) === LOCALE_FONTSIGNATURE ? value : value + '\0';
}

/** getLocaleValue for an already-resolved locale: the answer as text, NUL excluded. */
export function localeText(entry: LocaleEntry, lctype: number): string | undefined {
    const v = localeInfo(entry, lctype);
    return typeof v === 'number' ? localeNumberText(lctype, v) : v;
}

/**
 * THE locale lookup: what GetLocaleInfoW answers for `lcid` (any LCID argument, the
 * pseudo-LCIDs included) and `lctype`, as text; `undefined` when the LCID denotes no
 * locale or Windows has no answer for the type.
 */
export function getLocaleValue(lcid: number, lctype: number): string | undefined {
    const entry = localeFromLcid(lcid);
    return entry ? localeText(entry, lctype) : undefined;
}

/**
 * get_locale_codepage: the page GetLocaleInfoA converts through — the locale's own ANSI
 * page (for the default locale that is the manifest's, as its IDEFAULTANSICODEPAGE says),
 * or the process page under LOCALE_USE_CP_ACP and for a Unicode-only locale.
 */
export function localeAnsiCodePage(entry: LocaleEntry, lctype: number): number {
    const acp = EmulatorConfig.getInstance().ansiCodePage;
    if ((lctype & LOCALE_USE_CP_ACP) || isDefaultRow(entry)) return acp;
    const cp = localeField(entry.locale, F.IDefaultAnsiCodePage);
    return cp === CP_UTF8 ? acp : cp;
}

/** GetLocaleInfoA's conversion. Every ANSI page a locale names is ASCII below 0x80, so an
 *  ASCII answer (most of them) needs no code-page table at all. */
export function encodeLocaleAnsi(text: string, codePage: number): Uint8Array {
    let ascii = true;
    for (let i = 0; i < text.length && ascii; i++) ascii = text.charCodeAt(i) < 0x80;
    if (!ascii) return encodeAnsiString(text, codePage);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
}

// ---------------------------------------------------------------------------------------
// The fast tiers' answer caches — the process locale only
// ---------------------------------------------------------------------------------------

/** The LCID arguments the fast tiers (JS fast path, inline stub) may answer without asking
 *  the thunk: the pseudo-LCIDs and the configured LCID verbatim, each of which means the
 *  process locale. Any other LCID goes to the thunk, which answers every installed one. */
export function fastPathLcids(): number[] {
    return [...new Set([...DEFAULT_PSEUDO_LCIDS, EmulatorConfig.getInstance().lcid >>> 0])];
}

/** GetLocaleInfoW's bytes (UTF-16LE, NUL included) for the process locale, by cleanType. */
export let _localeWCache: Map<number, Uint8Array> | null = null;
/** GetLocaleInfoA's bytes (NUL included) for the same types in the process ANSI page.
 *  FONTSIGNATURE and SSHORTTIME are absent: A answers the first by count and refuses the
 *  second. */
export let _localeACache: Map<number, Uint8Array> | null = null;
/** RETURN_NUMBER values by cleanType. Uint32, not Uint16: the out-param is a DWORD and a
 *  page number (10000) or a GEOID must survive the store. */
export let _localeWNumCache: Uint32Array | null = null;
/** 1 where the type is numeric; RETURN_NUMBER on any other type is ERROR_INVALID_FLAGS. */
export let _localeIsNumber: Uint8Array | null = null;
/** fastPathLcids(), frozen with the answer cache it gates. */
export let _localeFastLcids: Set<number> | null = null;
export const LOCALE_CACHE_SIZE = 0x1100;

export function ensureLocaleCache(): void {
    if (_localeWCache) return;
    const wCache = new Map<number, Uint8Array>();
    const aCache = new Map<number, Uint8Array>();
    const nums = new Uint32Array(LOCALE_CACHE_SIZE);
    const isNum = new Uint8Array(LOCALE_CACHE_SIZE);
    const entry = userDefaultLocale();
    const acp = EmulatorConfig.getInstance().ansiCodePage;
    for (let type = 0; type < LOCALE_CACHE_SIZE; type++) {
        const value = localeInfo(entry, type);
        if (value === undefined) continue;
        const wide = localeWideData(type, value);
        const buf = new Uint8Array(wide.length * 2);
        for (let i = 0; i < wide.length; i++) {
            const c = wide.charCodeAt(i);
            buf[i * 2] = c & 0xff;
            buf[i * 2 + 1] = c >> 8;
        }
        wCache.set(type, buf);
        if (typeof value === 'number') {
            nums[type] = value >>> 0;
            isNum[type] = 1;
        }
        if (type !== LOCALE_FONTSIGNATURE && type !== LOCALE_SSHORTTIME) {
            aCache.set(type, encodeLocaleAnsi(wide, acp));
        }
    }
    _localeFastLcids = new Set(fastPathLcids());
    _localeWNumCache = nums;
    _localeIsNumber = isNum;
    _localeACache = aCache;
    _localeWCache = wCache;
}

// ============================================================================
// Guest-RAM table for the trap-free inline GetLocaleInfoW stub
// ============================================================================
// One THUNK_DATA blob the stub indexes with two loads and a copy:
//
//   +0x00  answered  u32       fast returns  (the stub's only visible instrument)
//   +0x04  destLimit u32       the stub's destination bound (see writeLocaleStubDestLimit)
//   +0x08  bail      u32 × 9   one per bail site, LOCALE_STUB_BAIL_REASONS order
//   +0x2C  lcids     u32 × LOCALE_STUB_LCID_SLOTS   the LCIDs the stub may answer for
//   ...    index     u32 × LOCALE_CACHE_SIZE, entry = (byteLen << 16) | blobOff
//                    0 = no such LCTYPE (the stub bails)
//   ...    blob      the W cache's bytes, blobOff relative to blob base
//
// byteLen is the W cache entry's length (NUL included, FONTSIGNATURE excepted), so the
// stub's return value is byteLen >> 1 — exactly what the JS fast path returns for the type.

export const LOCALE_STUB_ANSWERED_OFF = 0x00;
export const LOCALE_STUB_DESTLIMIT_OFF = 0x04;
export const LOCALE_STUB_BAIL_OFF = 0x08;
/** One counter per bail site, in emission order. A single "bailed" total says the stub
 *  declined; only the reason says whether that is the contract working (RETURN_NUMBER or
 *  RETURN_GENITIVE_NAMES: 'returnFlags') or a table missing the types callers ask for. */
export const LOCALE_STUB_BAIL_REASONS = [
    'lcid', 'returnFlags', 'typeOutOfTable', 'unknownType', 'negativeCch',
    'bufferTooSmall', 'nullDest', 'destWraps', 'destPastMemory',
] as const;
/** LCTYPE flags the stub hands to JS: a DWORD out-param, and names the cache does not hold. */
export const LOCALE_STUB_DECLINED_FLAGS = LOCALE_RETURN_NUMBER | LOCALE_RETURN_GENITIVE_NAMES;
/** Fixed so the emitted compare chain has a fixed shape; unused slots repeat a real LCID. */
export const LOCALE_STUB_LCID_SLOTS = 10;
export const LOCALE_STUB_LCIDS_OFF = LOCALE_STUB_BAIL_OFF + LOCALE_STUB_BAIL_REASONS.length * 4;
export const LOCALE_STUB_INDEX_OFF = LOCALE_STUB_LCIDS_OFF + LOCALE_STUB_LCID_SLOTS * 4;
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
    _localeACache = null;
    _localeWNumCache = null;
    _localeIsNumber = null;
    _localeFastLcids = null;
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

    const lcids = [..._localeFastLcids!];
    if (lcids.length > LOCALE_STUB_LCID_SLOTS) {
        throw new Error(`[locale-stub] ${lcids.length} fast-path LCIDs do not fit ${LOCALE_STUB_LCID_SLOTS} slots`);
    }
    for (let i = 0; i < LOCALE_STUB_LCID_SLOTS; i++) {
        dv.setUint32(LOCALE_STUB_LCIDS_OFF + i * 4, lcids[Math.min(i, lcids.length - 1)]! >>> 0, true);
    }

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
