#!/usr/bin/env bun
/**
 * Compile Wine's locale database into the worker's locale DB.
 *
 *   bun tools/gen-locale-db.ts [path/to/wine/nls/locale.nls]   (default G:/sources/wine/nls/locale.nls)
 *
 * Input: nls/locale.nls from the Wine tree — CLDR-derived locale DATA that Wine's
 * tools/make_unicode compiles into the layout kernelbase/locale.c reads (NLS_LOCALE_HEADER,
 * the LCID and name indexes, NLS_LOCALE_DATA rows, a length-prefixed UTF-16 string pool).
 * locale.c is the specification this parser follows; the output is our own format
 * (locale-db-schema.ts), deduplicated, raw-deflated and base64'd into
 * src/worker/modules/kernel32/locale-db.generated.ts.
 */

import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { deflateRawSync } from 'zlib';
import * as path from 'path';
import {
    ARRAY_ABSENT, FIELD_COUNT, HEADER_WORDS, HeaderWord, LOCALE_DB_MAGIC, LOCALE_DB_VERSION, LocaleField as F,
} from '../src/worker/modules/kernel32/locale-db-schema';

const SRC = process.argv[2] ?? 'G:/sources/wine/nls/locale.nls';
const OUT = path.join(import.meta.dir, '../src/worker/modules/kernel32/locale-db.generated.ts');

const file = readFileSync(SRC);
const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);

// ---- Wine's layout (winternl.h NLS_LOCALE_HEADER / NLS_LOCALE_DATA) ----------------------

const table = dv.getUint32(0x10, true);                  // file header: locales offset
const hu16 = (o: number) => dv.getUint16(table + o, true);
const hu32 = (o: number) => dv.getUint32(table + o, true);
if (hu32(0x0c) !== 0x5344534e) throw new Error(`${SRC}: not a locale.nls (magic 0x${hu32(0x0c).toString(16)})`);
const nbLcids = hu16(0x1e);
const nbLocales = hu16(0x20);
const localeSize = hu16(0x22);
const localesOff = hu32(0x24);
const nbLcnames = hu16(0x28);
const lcidsOff = hu32(0x2c);
const lcnamesOff = hu32(0x30);
const stringsOff = hu32(0x40);
if (localeSize < 0x148) throw new Error(`NLS_LOCALE_DATA is ${localeSize} bytes; expected at least 0x148`);

/** locale_strings[pos]: a WCHAR index into the pool. */
const w = (pos: number) => dv.getUint16(table + stringsOff + pos * 2, true);
/** A length-prefixed string at `pos`. */
function wineString(pos: number): string {
    const n = w(pos);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(w(pos + 1 + i));
    return s;
}
/** A string array: count, then DWORD string positions. */
function wineArray(pos: number): string[] {
    const n = w(pos);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(wineString(w(pos + 1 + i * 2) | (w(pos + 2 + i * 2) << 16)));
    return out;
}
/** locale_return_grouping's rendering of a binary grouping string. */
function wineGrouping(pos: number): string {
    const n = w(pos);
    let s = '';
    for (let i = 0; i < n; i++) {
        const g = w(pos + 1 + i);
        if (!g) return s.slice(0, -1);
        s += String.fromCharCode(0x30 + g) + ';';
    }
    return s + '0';
}
if (w(0) !== 0) throw new Error('string pool position 0 is not the empty string');

// ---- our pools --------------------------------------------------------------------------

const strings: string[] = [''];
const stringIds = new Map<string, number>([['', 0]]);
function sid(s: string): number {
    let id = stringIds.get(s);
    if (id === undefined) {
        id = strings.length;
        strings.push(s);
        stringIds.set(s, id);
    }
    return id;
}
const arrays: number[][] = [[]];                         // 0 = ARRAY_ABSENT
const arrayIds = new Map<string, number>();
function aid(winePos: number): number {
    if (!winePos) return ARRAY_ABSENT;
    const ids = wineArray(winePos).map(sid);
    const key = ids.join(',');
    let id = arrayIds.get(key);
    if (id === undefined) {
        id = arrays.length;
        arrays.push(ids);
        arrayIds.set(key, id);
    }
    return id;
}

const records = new Uint16Array(nbLocales * FIELD_COUNT);
for (let i = 0; i < nbLocales; i++) {
    const base = table + localesOff + i * localeSize;
    const u16 = (o: number) => dv.getUint16(base + o, true);
    const u32 = (o: number) => dv.getUint32(base + o, true);
    const str = (o: number) => sid(wineString(u32(o)));
    const row = new Uint16Array(FIELD_COUNT);
    const set = (f: F, v: number) => {
        if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`locale ${i}: field ${f} value ${v} does not fit u16`);
        row[f] = v;
    };

    set(F.SName, str(0x000));
    set(F.SOpenTypeLanguageTag, str(0x004));
    set(F.SList, str(0x02c));
    set(F.SDecimal, str(0x030));
    set(F.SThousand, str(0x034));
    set(F.SCurrency, str(0x038));
    set(F.SMonDecimalSep, str(0x03c));
    set(F.SMonThousandSep, str(0x040));
    set(F.SPositiveSign, str(0x044));
    set(F.SNegativeSign, str(0x048));
    set(F.S1159, str(0x04c));
    set(F.S2359, str(0x050));
    set(F.SAbbrevLangName, str(0x080));
    set(F.SIso639LangName, str(0x084));
    set(F.SEngLanguage, str(0x088));
    set(F.SNativeLangName, str(0x08c));
    set(F.SEngCountry, str(0x090));
    set(F.SNativeCtryName, str(0x094));
    set(F.SAbbrevCtryName, str(0x098));
    set(F.SIso3166CtryName, str(0x09c));
    set(F.SIntlSymbol, str(0x0a0));
    set(F.SEngCurrName, str(0x0a4));
    set(F.SNativeCurrName, str(0x0a8));
    set(F.FontSignature, str(0x0ac));
    set(F.SIso639LangName2, str(0x0b0));
    set(F.SIso3166CtryName2, str(0x0b4));
    set(F.SParent, str(0x0b8));
    set(F.SEngDisplayName, str(0x0ec));
    set(F.SNativeDisplayName, str(0x0f0));
    set(F.SPercent, str(0x0f4));
    set(F.SNan, str(0x0f8));
    set(F.SPosInfinity, str(0x0fc));
    set(F.SNegInfinity, str(0x100));
    set(F.SEraString, str(0x108));
    set(F.SAbbrevEraString, str(0x10c));
    set(F.SConsoleFallbackName, str(0x114));
    set(F.SSortLocale, str(0x124));
    set(F.SKeyboardsToInstall, str(0x128));
    set(F.SScripts, str(0x12c));
    set(F.SRelativeLongDate, str(0x130));
    set(F.SShortestAm, str(0x138));
    set(F.SShortestPm, str(0x13c));
    set(F.SGrouping, sid(wineGrouping(u32(0x024))));
    set(F.SMonGrouping, sid(wineGrouping(u32(0x028))));
    set(F.SNativeDigits, sid(wineArray(u32(0x054)).join('')));

    set(F.ATimeFormat, aid(u32(0x058)));
    set(F.AShortDate, aid(u32(0x05c)));
    set(F.ALongDate, aid(u32(0x060)));
    set(F.AYearMonth, aid(u32(0x064)));
    set(F.ADuration, aid(u32(0x068)));
    set(F.AShortTime, aid(u32(0x118)));
    set(F.AMonthDay, aid(u32(0x140)));
    set(F.ADayName, aid(u32(0x0bc)));
    set(F.AAbbrevDayName, aid(u32(0x0c0)));
    set(F.AShortestDayName, aid(u32(0x11c)));
    set(F.AMonthName, aid(u32(0x0c4)));
    set(F.AAbbrevMonthName, aid(u32(0x0c8)));
    set(F.AGenitiveMonth, aid(u32(0x0cc)));
    set(F.AAbbrevGenitiveMonth, aid(u32(0x0d0)));

    set(F.ILanguage, u16(0x008));
    set(F.IDigits, u16(0x00c));
    set(F.INegNumber, u16(0x00e));
    set(F.ICurrDigits, u16(0x010));
    set(F.ICurrency, u16(0x012));
    set(F.INegCurr, u16(0x014));
    set(F.ILZero, u16(0x016));
    set(F.INotNeutral, u16(0x018));
    set(F.IFirstDayOfWeek, u16(0x01a));
    set(F.IFirstWeekOfYear, u16(0x01c));
    set(F.ICountry, u16(0x01e));
    set(F.IMeasure, u16(0x020));
    set(F.IDigitSubstitution, u16(0x022));
    set(F.IDefaultLanguage, u16(0x06c));
    set(F.IDefaultAnsiCodePage, u16(0x06e));
    set(F.IDefaultCodePage, u16(0x070));
    set(F.IDefaultMacCodePage, u16(0x072));
    set(F.IDefaultEbcdicCodePage, u16(0x074));
    set(F.IPaperSize, u16(0x078));
    // scalendartype: a string whose characters are calendar ids; the first two are the
    // locale's calendar and its optional one (read positionally, as get_locale_info does).
    set(F.ICalendarType, w(u32(0x07c) + 1));
    set(F.IOptionalCalendar, w(u32(0x07c) + 2));
    set(F.INegativePercent, u16(0x0dc));
    set(F.IPositivePercent, u16(0x0de));
    set(F.IReadingLayout, u16(0x0e2));
    set(F.IGeoIdLo, u32(0x134) & 0xffff);
    set(F.IGeoIdHi, u32(0x134) >>> 16);
    records.set(row, i * FIELD_COUNT);
}

// Indexes, kept in Wine's order: the name index sorted by compare_locale_names (what
// EnumSystemLocales* walk), the LCID index ascending (what find_lcid_entry bisects).
const names = new Uint32Array(nbLcnames * 2);
for (let i = 0; i < nbLcnames; i++) {
    const e = table + lcnamesOff + i * 8;
    const nameId = sid(wineString(dv.getUint16(e, true)));
    names[i * 2] = (nameId | (dv.getUint16(e + 2, true) << 16)) >>> 0;
    names[i * 2 + 1] = dv.getUint32(e + 4, true);
}
const lcids = new Uint32Array(nbLcids * 2);
for (let i = 0; i < nbLcids; i++) {
    const e = table + lcidsOff + i * 8;
    lcids[i * 2] = dv.getUint32(e, true);
    const nameId = sid(wineString(dv.getUint16(e + 6, true)));
    lcids[i * 2 + 1] = (dv.getUint16(e + 4, true) | (nameId << 16)) >>> 0;
}
if (strings.length > 0xffff) throw new Error(`${strings.length} strings do not fit a u16 id`);

// ---- serialise --------------------------------------------------------------------------

// Lengths rather than offsets: they deflate to a quarter of the size, and the reader's
// prefix sum over them is a one-time pass.
const strLens = new Uint16Array(strings.length);
let poolChars = 0;
strings.forEach((s, i) => { strLens[i] = s.length; poolChars += s.length; });
const pool = new Uint16Array(poolChars);
{
    let p = 0;
    for (const s of strings) for (let j = 0; j < s.length; j++) pool[p++] = s.charCodeAt(j);
}

const arrOffs = new Uint32Array(arrays.length + 1);
let arrDataLen = 0;
arrays.forEach((a, i) => { arrOffs[i] = arrDataLen; arrDataLen += a.length; });
arrOffs[arrays.length] = arrDataLen;
const arrData = new Uint16Array(arrDataLen);
arrays.forEach((a, i) => arrData.set(a, arrOffs[i]!));

const sections: ArrayBufferView[] = [strLens, pool, arrOffs, arrData, records, names, lcids];
const header = new Uint32Array(HEADER_WORDS);
let off = HEADER_WORDS * 4;
const offsets: number[] = [];
for (const s of sections) {
    offsets.push(off);
    off = (off + s.byteLength + 3) & ~3;
}
const blob = new Uint8Array(off);
header[HeaderWord.Magic] = LOCALE_DB_MAGIC;
header[HeaderWord.Version] = LOCALE_DB_VERSION;
header[HeaderWord.NStrings] = strings.length;
header[HeaderWord.StrLensOff] = offsets[0]!;
header[HeaderWord.PoolOff] = offsets[1]!;
header[HeaderWord.PoolChars] = poolChars;
header[HeaderWord.NArrays] = arrays.length;
header[HeaderWord.ArrOffsOff] = offsets[2]!;
header[HeaderWord.ArrDataOff] = offsets[3]!;
header[HeaderWord.ArrDataLen] = arrDataLen;
header[HeaderWord.NLocales] = nbLocales;
header[HeaderWord.FieldCount] = FIELD_COUNT;
header[HeaderWord.RecordsOff] = offsets[4]!;
header[HeaderWord.NNames] = nbLcnames;
header[HeaderWord.NamesOff] = offsets[5]!;
header[HeaderWord.NLcids] = nbLcids;
header[HeaderWord.LcidsOff] = offsets[6]!;
// Typed arrays are host-endian; the blob is little-endian, as is every host we run on.
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('big-endian host');
blob.set(new Uint8Array(header.buffer), 0);
sections.forEach((s, i) => blob.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), offsets[i]!));

const packed = deflateRawSync(blob, { level: 9 });
const b64 = Buffer.from(packed).toString('base64');
const CHUNK = 4000;
const chunks: string[] = [];
for (let i = 0; i < b64.length; i += CHUNK) chunks.push(`    '${b64.slice(i, i + CHUNK)}',`);
const sourceHash = createHash('sha256').update(file).digest('hex').slice(0, 16);

writeFileSync(OUT, [
    '// GENERATED by tools/gen-locale-db.ts from Wine\'s nls/locale.nls (CLDR-derived locale data)',
    `// — do not edit. Source sha256 ${sourceHash}: ${nbLocales} locales, ${nbLcnames} names,`,
    `// ${nbLcids} LCIDs, ${strings.length} strings, ${arrays.length} arrays; ${blob.length} bytes inflated.`,
    '',
    `export const LOCALE_DB_INFLATED_SIZE = ${blob.length};`,
    '',
    '/** Raw-deflated blob, base64; layout in locale-db-schema.ts. */',
    'export const LOCALE_DB_DEFLATED_BASE64 = [',
    ...chunks,
    "].join('');",
    '',
].join('\n'));

console.log(`${path.relative(process.cwd(), OUT)}: ${nbLocales} locales, ${nbLcnames} names, ${nbLcids} LCIDs, `
    + `${strings.length} strings, ${arrays.length} arrays; ${blob.length} B -> ${packed.length} B deflated -> ${b64.length} B base64`);
