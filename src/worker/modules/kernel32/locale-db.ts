// Reader for the compiled locale database (locale-db.generated.ts, layout in
// locale-db-schema.ts). Inflated once, on first use; strings are materialised per id on
// first read, so a locale nobody asks about costs nothing beyond its share of the blob.
//
// Lookups mirror kernelbase's: the LCID index is bisected by value, the name index by
// compare_locale_names (ASCII case-insensitive, '_' equal to '-').

import { inflateRawSync } from '@bottleship/formats/zip/inflate';
import { LOCALE_DB_DEFLATED_BASE64, LOCALE_DB_INFLATED_SIZE } from './locale-db.generated';
import {
    ARRAY_ABSENT, FIELD_COUNT, HEADER_WORDS, HeaderWord, LOCALE_DB_MAGIC, LOCALE_DB_VERSION, LocaleField,
} from './locale-db-schema';

interface Tables {
    strStart: Uint32Array;
    pool: Uint16Array;
    strings: (string | undefined)[];
    arrOffs: Uint32Array;
    arrData: Uint16Array;
    records: Uint16Array;
    names: Uint32Array;
    lcids: Uint32Array;
    nLocales: number;
}

let tables: Tables | null = null;

function load(): Tables {
    const bin = atob(LOCALE_DB_DEFLATED_BASE64);
    const packed = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i);
    const blob = new Uint8Array(LOCALE_DB_INFLATED_SIZE);
    const res = inflateRawSync(packed, blob);
    if (res.status !== 'ok' || res.written !== LOCALE_DB_INFLATED_SIZE) {
        throw new Error(`[locale-db] inflate failed: ${res.status} ${res.message ?? ''} (${res.written} B)`);
    }
    const buf = blob.buffer;
    const h = new Uint32Array(buf, 0, HEADER_WORDS);
    if (h[HeaderWord.Magic] !== LOCALE_DB_MAGIC || h[HeaderWord.Version] !== LOCALE_DB_VERSION
        || h[HeaderWord.FieldCount] !== FIELD_COUNT) {
        throw new Error('[locale-db] blob does not match locale-db-schema.ts; rerun tools/gen-locale-db.ts');
    }
    const nStrings = h[HeaderWord.NStrings]!;
    const lens = new Uint16Array(buf, h[HeaderWord.StrLensOff]!, nStrings);
    const strStart = new Uint32Array(nStrings + 1);
    for (let i = 0; i < nStrings; i++) strStart[i + 1] = strStart[i]! + lens[i]!;
    const nArrays = h[HeaderWord.NArrays]!;
    const nLocales = h[HeaderWord.NLocales]!;
    return {
        strStart,
        pool: new Uint16Array(buf, h[HeaderWord.PoolOff]!, h[HeaderWord.PoolChars]!),
        strings: new Array(nStrings),
        arrOffs: new Uint32Array(buf, h[HeaderWord.ArrOffsOff]!, nArrays + 1),
        arrData: new Uint16Array(buf, h[HeaderWord.ArrDataOff]!, h[HeaderWord.ArrDataLen]!),
        records: new Uint16Array(buf, h[HeaderWord.RecordsOff]!, nLocales * FIELD_COUNT),
        names: new Uint32Array(buf, h[HeaderWord.NamesOff]!, h[HeaderWord.NNames]! * 2),
        lcids: new Uint32Array(buf, h[HeaderWord.LcidsOff]!, h[HeaderWord.NLcids]! * 2),
        nLocales,
    };
}

function db(): Tables {
    return tables ??= load();
}

/** String `id` of the pool. */
export function dbString(id: number): string {
    const t = db();
    let s = t.strings[id];
    if (s === undefined) {
        s = '';
        for (let i = t.strStart[id]!, end = t.strStart[id + 1]!; i < end; i++) s += String.fromCharCode(t.pool[i]!);
        t.strings[id] = s;
    }
    return s;
}

/** Raw field of locale row `locale`. */
export function localeField(locale: number, field: LocaleField): number {
    return db().records[locale * FIELD_COUNT + field]!;
}

export function localeString(locale: number, field: LocaleField): string {
    return dbString(localeField(locale, field));
}

export function arrayLength(array: number): number {
    const t = db();
    return t.arrOffs[array + 1]! - t.arrOffs[array]!;
}

/** locale_return_strarray: element `idx`, or "" past the end (Wine's string 0). */
export function arrayItem(array: number, idx: number): string {
    const t = db();
    const start = t.arrOffs[array]!;
    return idx < t.arrOffs[array + 1]! - start ? dbString(t.arrData[start + idx]!) : '';
}

export function arrayPresent(array: number): boolean {
    return array !== ARRAY_ABSENT;
}

// ---- the LCID index ------------------------------------------------------------------------

export function lcidEntryCount(): number { return db().lcids.length >> 1; }
export function lcidEntryLcid(i: number): number { return db().lcids[i * 2]!; }
export function lcidEntryLocale(i: number): number { return db().lcids[i * 2 + 1]! & 0xffff; }
export function lcidEntryName(i: number): string { return dbString(db().lcids[i * 2 + 1]! >>> 16); }

/** find_lcid_entry: the index entry for `lcid`, or -1. */
export function findLcidEntry(lcid: number): number {
    const t = db().lcids;
    const id = lcid >>> 0;
    let lo = 0, hi = (t.length >> 1) - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = t[mid * 2]!;
        if (id < v) hi = mid - 1;
        else if (id > v) lo = mid + 1;
        else return mid;
    }
    return -1;
}

// ---- the name index ------------------------------------------------------------------------

export function nameEntryCount(): number { return db().names.length >> 1; }
export function nameEntryName(i: number): string { return dbString(db().names[i * 2]! & 0xffff); }
export function nameEntryLocale(i: number): number { return db().names[i * 2]! >>> 16; }
/** The entry's LCID as stored: bit 31 marks an alias, 0x1000 a locale with no LCID. */
export function nameEntryId(i: number): number { return db().names[i * 2 + 1]!; }

function foldNameChar(c: number): number {
    if (c >= 0x61 && c <= 0x7a) return c - 0x20;
    return c === 0x5f ? 0x2d : c;
}

/** compare_locale_names: <0, 0, >0. */
export function compareLocaleNames(a: string, b: string): number {
    for (let i = 0; ; i++) {
        const ca = i < a.length ? foldNameChar(a.charCodeAt(i)) : 0;
        const cb = i < b.length ? foldNameChar(b.charCodeAt(i)) : 0;
        if (!ca || ca !== cb) return ca - cb;
    }
}

/** find_lcname_entry: the name-index entry for `name`, or -1. */
export function findNameEntry(name: string): number {
    let lo = 0, hi = nameEntryCount() - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = compareLocaleNames(name, nameEntryName(mid));
        if (r < 0) hi = mid - 1;
        else if (r > 0) lo = mid + 1;
        else return mid;
    }
    return -1;
}

export function localeCount(): number { return db().nLocales; }
