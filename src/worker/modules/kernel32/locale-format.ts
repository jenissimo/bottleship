// GetDateFormat* / GetTimeFormat* picture-string formatting — one implementation for the
// LCID (A/W) and locale-name (Ex) entry points, reading the requested locale's pictures
// and names through the same lookup GetLocaleInfoW answers from. Pure: the handlers own
// guest memory and last-error; this returns either the formatted string or the error.

import { LOCALE_RETURN_GENITIVE_NAMES, localeText } from './locale-data';
import { localeString } from './locale-db';
import { LocaleField } from './locale-db-schema';
import type { LocaleEntry } from './locale-names';

export const ERROR_INVALID_PARAMETER = 87;
export const ERROR_INSUFFICIENT_BUFFER = 122;
export const ERROR_INVALID_FLAGS = 1004;

export const LOCALE_NOUSEROVERRIDE = 0x80000000;
export const LOCALE_USE_CP_ACP = 0x40000000;

export const DATE_SHORTDATE = 0x01;
export const DATE_LONGDATE = 0x02;
export const DATE_USE_ALT_CALENDAR = 0x04;
export const DATE_YEARMONTH = 0x08;
export const DATE_MONTHDAY = 0x80;

export const TIME_NOMINUTESORSECONDS = 0x1;
export const TIME_NOSECONDS = 0x2;
export const TIME_NOTIMEMARKER = 0x4;
export const TIME_FORCE24HOURFORMAT = 0x8;

const LOCALE_SSHORTDATE = 0x1f;
const LOCALE_SLONGDATE = 0x20;
const LOCALE_S1159 = 0x28;
const LOCALE_S2359 = 0x29;
const LOCALE_SDAYNAME1 = 0x2a;
const LOCALE_SABBREVDAYNAME1 = 0x31;
const LOCALE_SMONTHNAME1 = 0x38;
const LOCALE_SABBREVMONTHNAME1 = 0x44;
const LOCALE_STIMEFORMAT = 0x1003;
const LOCALE_SYEARMONTH = 0x1006;
const LOCALE_SMONTHDAY = 0x78;

/** SYSTEMTIME, field for field. */
export interface SystemTimeFields {
    year: number;
    month: number;
    dayOfWeek: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    milliseconds: number;
}

export type FormatResult = { ok: true; text: string } | { ok: false; error: number };

export function localSystemTimeNow(): SystemTimeFields {
    const d = new Date();
    return {
        year: d.getFullYear(), month: d.getMonth() + 1, dayOfWeek: d.getDay(), day: d.getDate(),
        hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), milliseconds: d.getMilliseconds(),
    };
}

function daysInMonth(year: number, month: number): number {
    if (month === 2) return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
    return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** get_pattern_len: a quoted run, or a run of one repeated pattern letter from `accept`. */
function patternLen(fmt: string, pos: number, accept: string): number {
    if (fmt[pos] === "'") {
        let i = 1;
        for (; pos + i < fmt.length; i++) {
            if (fmt[pos + i] !== "'") continue;
            if (fmt[pos + ++i] !== "'") return i;
        }
        return i;
    }
    if (!accept.includes(fmt[pos]!)) return 1;
    let i = 1;
    while (pos + i < fmt.length && fmt[pos + i] === fmt[pos]) i++;
    return i;
}

function num(value: number, minDigits: number): string {
    return String(value).padStart(minDigits, '0');
}

/**
 * get_date_format. The time-of-day fields are ignored; the date goes through the same
 * validation SystemTimeToFileTime applies, and the day of week is recomputed from it —
 * the caller's wDayOfWeek is not trusted, as on Windows.
 */
export function formatDate(
    locale: LocaleEntry, flags: number, systime: SystemTimeFields | null, format: string | null,
): FormatResult {
    const override = flags & LOCALE_NOUSEROVERRIDE;
    let fmt: string;
    if (format === null) {
        let type: number;
        switch (flags & (DATE_SHORTDATE | DATE_LONGDATE | DATE_YEARMONTH | DATE_MONTHDAY)) {
            case 0:
            case DATE_SHORTDATE: type = LOCALE_SSHORTDATE; break;
            case DATE_LONGDATE: type = LOCALE_SLONGDATE; break;
            case DATE_YEARMONTH: type = LOCALE_SYEARMONTH; break;
            case DATE_MONTHDAY: type = LOCALE_SMONTHDAY; break;
            default: return { ok: false, error: ERROR_INVALID_FLAGS };
        }
        fmt = localeText(locale, type) ?? '';
    } else if (override || (flags & (DATE_SHORTDATE | DATE_LONGDATE | DATE_YEARMONTH | DATE_MONTHDAY))) {
        return { ok: false, error: ERROR_INVALID_FLAGS };
    } else {
        fmt = format;
    }

    const t = systime ?? localSystemTimeNow();
    if (t.year < 1601 || t.year > 30827 || t.month < 1 || t.month > 12
        || t.day < 1 || t.day > daysInMonth(t.year, t.month)) {
        return { ok: false, error: ERROR_INVALID_PARAMETER };
    }
    const dayOfWeek = dayOfWeekOf(t.year, t.month, t.day);

    // A month NAME next to a day NUMBER takes the genitive form where the locale has one
    // ("10 марта", not "10 март"); a day name ends that.
    let genitive = 0;
    let out = '';
    for (let pos = 0; pos < fmt.length;) {
        const count = patternLen(fmt, pos, 'yMd');
        const ch = fmt[pos]!;
        switch (ch) {
            case "'":
                for (let i = 1; i < count; i++) {
                    if (fmt[pos + i] === "'") i++;
                    if (i < count) out += fmt[pos + i];
                }
                break;
            case 'y':
                out += num(count <= 2 ? t.year % 100 : t.year, 2);
                break;
            case 'M':
                if (count <= 2) {
                    out += num(t.month, count);
                    break;
                }
                if (!genitive) {
                    for (let i = pos + count; i < fmt.length; i += patternLen(fmt, i, 'yMd')) {
                        if (fmt[i] !== 'd') continue;
                        if (fmt[i + 1] !== 'd' || fmt[i + 2] !== 'd') genitive = LOCALE_RETURN_GENITIVE_NAMES;
                        break;
                    }
                }
                out += localeText(locale,
                    ((count === 3 ? LOCALE_SABBREVMONTHNAME1 : LOCALE_SMONTHNAME1) + t.month - 1) | genitive) ?? '';
                break;
            case 'd':
                if (count <= 2) {
                    genitive = LOCALE_RETURN_GENITIVE_NAMES;
                    out += num(t.day, count);
                    break;
                }
                genitive = 0;
                out += localeText(locale, (count === 3 ? LOCALE_SABBREVDAYNAME1 : LOCALE_SDAYNAME1) + (dayOfWeek + 6) % 7) ?? '';
                break;
            case 'g':
                // "g" and "gg" are both CAL_SERASTRING, per the picture-string contract.
                out += localeString(locale.locale, LocaleField.SEraString);
                break;
            default:
                out += ch;
                break;
        }
        pos += count;
    }
    return { ok: true, text: out };
}

/** 0 = Sunday, proleptic Gregorian (the calendar FILETIME counts in). */
function dayOfWeekOf(year: number, month: number, day: number): number {
    const d = new Date(Date.UTC(2000, month - 1, day));
    d.setUTCFullYear(year);
    return d.getUTCDay();
}

/**
 * get_time_format. A suppressed field (TIME_NOSECONDS etc.) also takes the separator
 * before it and every literal up to the next field, which is how "h:mm:ss tt" becomes
 * "h:mm tt" rather than "h:mm: tt".
 */
export function formatTime(
    locale: LocaleEntry, flags: number, systime: SystemTimeFields | null, format: string | null,
): FormatResult {
    const override = flags & LOCALE_NOUSEROVERRIDE;
    let fmt: string;
    if (format === null) fmt = localeText(locale, LOCALE_STIMEFORMAT) ?? '';
    else if (override) return { ok: false, error: ERROR_INVALID_FLAGS };
    else fmt = format;

    const t = systime ?? localSystemTimeNow();
    if (t.milliseconds > 999 || t.second > 59 || t.minute > 59 || t.hour > 23) {
        return { ok: false, error: ERROR_INVALID_PARAMETER };
    }

    let out = '';
    let last = 0;
    let skip = false;
    for (let pos = 0; pos < fmt.length;) {
        const count = patternLen(fmt, pos, 'Hhmst');
        const ch = fmt[pos]!;
        pos += count;
        let val: number;
        switch (ch) {
            case "'": {
                const start = pos - count;
                for (let i = 1; i < count; i++) {
                    if (fmt[start + i] === "'") i++;
                    if (!skip && i < count) out += fmt[start + i];
                }
                continue;
            }
            case 'H':
                val = t.hour;
                break;
            case 'h':
                val = t.hour;
                if (!(flags & TIME_FORCE24HOURFORMAT)) {
                    val %= 12;
                    if (!val) val = 12;
                }
                break;
            case 'm':
                if (flags & TIME_NOMINUTESORSECONDS) { out = out.slice(0, last); skip = true; continue; }
                val = t.minute;
                break;
            case 's':
                if (flags & (TIME_NOMINUTESORSECONDS | TIME_NOSECONDS)) { out = out.slice(0, last); skip = true; continue; }
                val = t.second;
                break;
            case 't': {
                if (flags & TIME_NOTIMEMARKER) { out = out.slice(0, last); skip = true; continue; }
                const marker = localeText(locale, t.hour < 12 ? LOCALE_S1159 : LOCALE_S2359) ?? '';
                out += count > 1 ? marker : marker.slice(0, 1);
                skip = false;
                continue;
            }
            default:
                if (!skip || ch === ' ') out += ch;
                continue;
        }
        out += num(val, Math.min(2, count));
        last = out.length;
        skip = false;
    }
    return { ok: true, text: out };
}
