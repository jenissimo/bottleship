// Locale identity: which name or LCID denotes which locale-database row, and the default
// locale the manifest configures. The rules are kernelbase's (NlsValidateLocale,
// get_locale_by_name, LocaleNameToLCID, ResolveLocaleName, EnumSystemLocales*), applied to
// the one database every locale answer comes from (locale-db.ts) — so the set of locales
// that exist is the set the database holds, exactly as on a Windows installation.

import { EmulatorConfig } from '../../core/emulator-config-manager';
import {
    compareLocaleNames, findLcidEntry, findNameEntry, lcidEntryLocale, lcidEntryLcid, lcidEntryCount,
    lcidEntryName, localeField, localeString, nameEntryCount, nameEntryId, nameEntryLocale, nameEntryName,
} from './locale-db';
import { LocaleField } from './locale-db-schema';

export const LCID_EN_US = 0x0409;
export const LOCALE_CUSTOM_UNSPECIFIED = 0x1000;

/** The default pseudo-LCIDs (LOCALE_NEUTRAL, USER/SYSTEM/CUSTOM defaults): each stands for
 *  the configured locale. */
export const DEFAULT_PSEUDO_LCIDS: readonly number[] = [0x0000, 0x0400, 0x0800, 0x0c00, 0x1000, 0x1400];

export const LOCALE_NAME_SYSTEM_DEFAULT = '!x-sys-default-locale';
export const LOCALE_SYSTEM_DEFAULT = 0x0800;
export const LOCALE_USER_DEFAULT = 0x0400;
export const LOCALE_ALLOW_NEUTRAL_NAMES = 0x08000000;

// EnumSystemLocalesEx flags.
export const LOCALE_WINDOWS = 0x01;
export const LOCALE_ALTERNATE_SORTS = 0x04;
export const LOCALE_NEUTRALDATA = 0x10;
export const LOCALE_SPECIFICDATA = 0x20;

// EnumSystemLocalesA/W flags.
export const LCID_INSTALLED = 0x1;
export const LCID_SUPPORTED = 0x2;
export const LCID_ALTERNATE_SORTS = 0x4;

/** Bit 31 of a name-index id marks an alias name (a BCP-47 spelling of another locale). */
const ALIAS_BIT = 0x80000000;

const sortIdOf = (lcid: number) => (lcid >>> 16) & 0xf;

/**
 * A locale argument, resolved: the LCID the answer is FOR (a sort variant keeps its sort,
 * a default pseudo-LCID becomes the configured LCID) and the database row that answers.
 */
export interface LocaleEntry {
    /** What LOCALE_SNAME answers: "de-DE_phoneb" for a sort variant, "" for the invariant. */
    readonly name: string;
    readonly lcid: number;
    /** locale-db row. */
    readonly locale: number;
    /** The row is a neutral locale ("en"): LOCALE_INEUTRAL. */
    readonly neutral: boolean;
    /** A sort-order variant ("de-DE_phoneb": an LCID with a non-zero SORTID). */
    readonly alternateSort: boolean;
    /** The specific locale a neutral one stands for (its SSORTLOCALE); itself when specific. */
    readonly specific: LocaleEntry;
}

function isNeutralRow(row: number): boolean {
    return localeField(row, LocaleField.INotNeutral) === 0;
}

/** get_locale_info(LOCALE_SNAME): a sort LCID names its own sort entry. */
function snameFor(lcid: number, row: number): string {
    if (sortIdOf(lcid)) {
        const e = findLcidEntry(lcid & ~ALIAS_BIT);
        if (e >= 0) return lcidEntryName(e);
    }
    return localeString(row, LocaleField.SName);
}

function makeEntry(lcid: number, row: number, name = snameFor(lcid, row)): LocaleEntry {
    const neutral = isNeutralRow(row);
    const entry = {
        name, lcid, locale: row, neutral,
        alternateSort: sortIdOf(lcid) !== 0 || name.includes('_'),
    } as { -readonly [K in keyof LocaleEntry]: LocaleEntry[K] };
    entry.specific = entry;
    if (neutral) {
        const s = findNameEntry(localeString(row, LocaleField.SSortLocale));
        if (s >= 0) {
            const id = nameEntryId(s) & ~ALIAS_BIT;
            entry.specific = makeEntry(id, nameEntryLocale(s), nameEntryName(s));
        }
    }
    return entry;
}

/** The row an LCID-index entry answers with: a neutral stands for its SSORTLOCALE row. */
function specificRow(row: number): number {
    if (!isNeutralRow(row)) return row;
    const s = findNameEntry(localeString(row, LocaleField.SSortLocale));
    return s >= 0 ? nameEntryLocale(s) : row;
}

/** Name-index lookup (ASCII case-insensitive, '_' == '-'), aliases included. */
export function findLocaleByName(name: string): LocaleEntry | undefined {
    const i = findNameEntry(name);
    if (i < 0) return undefined;
    return makeEntry(nameEntryId(i) & ~ALIAS_BIT, nameEntryLocale(i), nameEntryName(i));
}

/** LCID-index lookup: the LCID as the index spells it, neutral or not. */
export function findLocaleByLcid(lcid: number): LocaleEntry | undefined {
    const i = findLcidEntry(lcid);
    return i < 0 ? undefined : makeEntry(lcidEntryLcid(i), lcidEntryLocale(i), lcidEntryName(i));
}

let userDefault: { lcid: number; entry: LocaleEntry } | null = null;

/**
 * The user default locale: the manifest LCID (EmulatorConfig.lcid). A configured LCID the
 * database does not hold still names a primary language, and failing that en-US.
 */
export function userDefaultLocale(): LocaleEntry {
    const lcid = EmulatorConfig.getInstance().lcid >>> 0;
    if (userDefault?.lcid === lcid) return userDefault.entry;
    let i = findLcidEntry(lcid);
    let id = lcid;
    if (i < 0) { i = findLcidEntry(lcid & 0x3ff); id = lcid & 0x3ff; }
    if (i < 0) { i = findLcidEntry(LCID_EN_US); id = LCID_EN_US; }
    userDefault = { lcid, entry: makeEntry(id, specificRow(lcidEntryLocale(i))) };
    return userDefault.entry;
}

/** We model one machine: the system locale is the user locale. */
export function systemDefaultLocale(): LocaleEntry {
    return userDefaultLocale();
}

/** The installed LCIDs: every one the database knows, ascending, as on a real installation. */
export function installedLocaleLcids(): number[] {
    const out: number[] = [];
    for (let i = 0, n = lcidEntryCount(); i < n; i++) out.push(lcidEntryLcid(i));
    return out;
}

/**
 * NlsValidateLocale: the locale an LCID argument denotes. The default pseudo-LCIDs (and the
 * configured LCID itself, whatever it is) resolve to the configured locale; a neutral LCID
 * answers with its default specific locale's data unless the caller allows neutral names.
 */
export function localeFromLcid(lcid: number, flags = 0): LocaleEntry | undefined {
    const id = lcid >>> 0;
    if (DEFAULT_PSEUDO_LCIDS.includes(id) || id === (EmulatorConfig.getInstance().lcid >>> 0)) {
        return userDefaultLocale();
    }
    const i = findLcidEntry(id);
    if (i < 0) return undefined;
    const row = (flags & LOCALE_ALLOW_NEUTRAL_NAMES) ? lcidEntryLocale(i) : specificRow(lcidEntryLocale(i));
    return makeEntry(id, row);
}

/**
 * get_locale_by_name: NULL (`null`) is the user default, LOCALE_NAME_SYSTEM_DEFAULT the
 * system default, anything else must be a name the database holds.
 */
export function localeFromName(name: string | null): LocaleEntry | undefined {
    if (name === null) return userDefaultLocale();
    if (name.startsWith('!') && compareLocaleNames(name, LOCALE_NAME_SYSTEM_DEFAULT) === 0) {
        return systemDefaultLocale();
    }
    const i = findNameEntry(name);
    if (i < 0) return undefined;
    return makeEntry(nameEntryId(i), nameEntryLocale(i));
}

/** IsValidLocaleName: a real name (not NULL, not the system-default alias) of a locale. */
export function isValidLocaleName(name: string | null): boolean {
    return name !== null && findNameEntry(name) >= 0;
}

/**
 * LocaleNameToLCID's answer, or 0 for a name that denotes no locale. A neutral answers its
 * IDEFAULTLANGUAGE unless neutral names are allowed ("zh-Hant" -> 0x0c04, not 0x7c04); a
 * locale with no LCID of its own answers LOCALE_CUSTOM_UNSPECIFIED. The alias marker is
 * ours, never part of an LCID.
 */
export function localeNameToLcid(name: string | null, flags: number): number {
    const entry = localeFromName(name);
    if (!entry) return 0;
    if (!(flags & LOCALE_ALLOW_NEUTRAL_NAMES) && entry.neutral) {
        return localeField(entry.locale, LocaleField.IDefaultLanguage);
    }
    return (entry.lcid & ~ALIAS_BIT) >>> 0;
}

const RESOLVABLE = /^[A-Za-z0-9_-]*$/;
const LOCALE_NAME_MAX_LENGTH = 85;

/**
 * ResolveLocaleName: the best specific locale for a name — the name itself when it is one,
 * else its longest '-'/'_' prefix that is; a neutral answers its default specific locale
 * (SSORTLOCALE) and a sort variant the locale it sorts; "" when nothing matches.
 * `undefined` when the name holds a character no locale name can contain
 * (ERROR_INVALID_PARAMETER).
 */
export function resolveLocaleName(name: string | null): string | undefined {
    let entry = localeFromName(name);
    if (!entry && name !== null) {
        if (!RESOLVABLE.test(name)) return undefined;
        let tmp = name.slice(0, LOCALE_NAME_MAX_LENGTH - 1);
        while (!entry) {
            const cut = Math.max(tmp.lastIndexOf('-'), tmp.lastIndexOf('_'));
            if (cut <= 0) break;
            tmp = tmp.slice(0, cut);
            entry = localeFromName(tmp);
        }
    }
    if (!entry) return '';
    return localeString(entry.locale, entry.neutral ? LocaleField.SSortLocale : LocaleField.SName);
}

/** EnumSystemLocalesEx's per-name flags. */
function enumLocaleFlags(id: number, name: string, row: number): number {
    if (sortIdOf(id) || name.includes('_')) return LOCALE_ALTERNATE_SORTS;
    return LOCALE_WINDOWS | (isNeutralRow(row) ? LOCALE_NEUTRALDATA : LOCALE_SPECIFICDATA);
}

/** What EnumSystemLocalesEx reports for `wantedFlags` (0 = everything), in name order. */
export function enumSystemLocalesEx(wantedFlags: number): Array<{ name: string; flags: number }> {
    const out: Array<{ name: string; flags: number }> = [];
    for (let i = 0, n = nameEntryCount(); i < n; i++) {
        const id = nameEntryId(i);
        if (id & ALIAS_BIT) continue;
        const name = nameEntryName(i);
        const flags = enumLocaleFlags(id, name, nameEntryLocale(i));
        if (wantedFlags && !(flags & wantedFlags)) continue;
        out.push({ name, flags });
    }
    return out;
}

/**
 * What EnumSystemLocalesA/W report, as "%08x", in name order: LCIDs of specific locales —
 * no invariant, no neutrals, no aliases, no locale without an LCID of its own.
 */
export function enumSystemLcids(flags: number): string[] {
    if (!flags) flags = LCID_SUPPORTED;
    const out: string[] = [];
    for (let i = 0, n = nameEntryCount(); i < n; i++) {
        const id = nameEntryId(i);
        if (!nameEntryName(i) || id === LOCALE_CUSTOM_UNSPECIFIED || (id & ALIAS_BIT)) continue;
        if (isNeutralRow(nameEntryLocale(i))) continue;
        const alt = sortIdOf(id) !== 0;
        if (alt && !(flags & LCID_ALTERNATE_SORTS)) continue;
        if (!alt && !(flags & (LCID_INSTALLED | LCID_SUPPORTED))) continue;
        out.push(id.toString(16).padStart(8, '0'));
    }
    return out;
}
