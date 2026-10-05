// Locale-name NLS APIs (the Vista+ *Ex / *LocaleName family) and the date/time formatters
// shared by their LCID twins. Names resolve through locale-names.ts; the locale DATA is the
// one database GetLocaleInfoW answers from, so "ru-RU" and 0x0419 format identically.

import type { ThunkImplementation, ThunkResult, X86Context } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import { EmulatorConfig, decodeAnsiString, encodeAnsiString } from '../../core/emulator-config-manager';
import {
    type LocaleEntry,
    LOCALE_ALLOW_NEUTRAL_NAMES,
    enumSystemLcids,
    enumSystemLocalesEx,
    isValidLocaleName,
    localeFromLcid,
    localeFromName,
    localeNameToLcid,
    resolveLocaleName,
    systemDefaultLocale,
    userDefaultLocale,
} from './locale-names';
import { localeAnsiCodePage } from './locale-data';
import {
    type FormatResult,
    type SystemTimeFields,
    ERROR_INSUFFICIENT_BUFFER,
    ERROR_INVALID_PARAMETER,
    formatDate,
    formatTime,
} from './locale-format';

function setLastError(code: number): void {
    System.getInstance().scheduler.setLastError(code);
}

/** A guest LPCWSTR; `null` for the NULL pointer (LOCALE_NAME_USER_DEFAULT). */
function readNameW(mem: Uint8Array, ptr: number): string | null {
    return ptr ? Marshaler.readStringW(mem, ptr) : null;
}

function writeWide(ptr: number, text: string): void {
    const data = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        data[i * 2] = c & 0xff;
        data[i * 2 + 1] = c >> 8;
    }
    Mem.writeBytes(ptr, data);
}

/**
 * locale_return_data: the answer is `value` plus its NUL. A zero count asks for the size;
 * a short buffer is ERROR_INSUFFICIENT_BUFFER with nothing written.
 */
function returnLocaleString(value: string, buf: number, count: number): number {
    const needed = value.length + 1;
    if (count === 0) return needed;
    if (needed > count) {
        setLastError(ERROR_INSUFFICIENT_BUFFER);
        return 0;
    }
    writeWide(buf, value + '\0');
    return needed;
}

/** lstrcpynW then the size check: a short buffer gets the truncated, terminated prefix. */
function returnTruncatingW(value: string, buf: number, count: number): number {
    const needed = value.length + 1;
    if (count === 0) return needed;
    writeWide(buf, value.slice(0, count - 1) + '\0');
    if (needed > count) {
        setLastError(ERROR_INSUFFICIENT_BUFFER);
        return 0;
    }
    return needed;
}

function readSystemTime(ptr: number): SystemTimeFields {
    const r = (off: number) => Mem.readUint16(ptr + off) ?? 0;
    return {
        year: r(0), month: r(2), dayOfWeek: r(4), day: r(6),
        hour: r(8), minute: r(10), second: r(12), milliseconds: r(14),
    };
}

type Formatter = (locale: LocaleEntry, flags: number, systime: SystemTimeFields | null, format: string | null) => FormatResult;

/** The W/Ex tail: validated locale in hand, format and copy out. */
function formatW(
    fn: Formatter, locale: LocaleEntry, flags: number, lpTime: number, format: string | null, buf: number, len: number,
): number {
    const result = fn(locale, flags, lpTime ? readSystemTime(lpTime) : null, format);
    if (!result.ok) {
        setLastError(result.error);
        return 0;
    }
    return returnTruncatingW(result.text, buf, len);
}

/** GetDateFormatW / GetTimeFormatW: (LCID, flags, SYSTEMTIME*, LPCWSTR, LPWSTR, int). */
function formatByLcidW(fn: Formatter, mem: Uint8Array, args: number[]): number {
    const [lcid, flags, lpTime, lpFormat, buf] = args as [number, number, number, number, number];
    const len = args[5]! | 0;
    const locale = localeFromLcid(lcid);
    if (len < 0 || (len && !buf) || !locale) {
        setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    return formatW(fn, locale, flags >>> 0, lpTime, lpFormat ? Marshaler.readStringW(mem, lpFormat) : null, buf, len);
}

/**
 * GetDateFormatA / GetTimeFormatA: the W call over the locale's ANSI code page
 * (get_lcid_codepage), its answer converted back — so the returned count is in BYTES, and
 * a short buffer holds what WideCharToMultiByte managed to write before failing.
 */
function formatByLcidA(fn: Formatter, mem: Uint8Array, args: number[]): number {
    const [lcid, flags, lpTime, lpFormat, buf] = args as [number, number, number, number, number];
    const len = args[5]! | 0;
    const locale = localeFromLcid(lcid);
    if (len < 0 || (len && !buf) || !locale) {
        setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    const cp = localeAnsiCodePage(locale, flags);
    let format: string | null = null;
    if (lpFormat) {
        let end = lpFormat;
        while (end < mem.length && mem[end] !== 0) end++;
        format = decodeAnsiString(mem, lpFormat, end - lpFormat, cp);
    }
    const result = fn(locale, flags >>> 0, lpTime ? readSystemTime(lpTime) : null, format);
    if (!result.ok) {
        setLastError(result.error);
        return 0;
    }
    const encoded = encodeAnsiString(result.text + '\0', cp);
    if (len === 0) return encoded.length;
    if (encoded.length > len) {
        Mem.writeBytes(buf, encoded.subarray(0, len));
        setLastError(ERROR_INSUFFICIENT_BUFFER);
        return 0;
    }
    Mem.writeBytes(buf, encoded);
    return encoded.length;
}

/** GetDateFormatEx / GetTimeFormatEx: the W call keyed by locale name. */
function formatByNameW(fn: Formatter, mem: Uint8Array, args: number[], calendar: number): number {
    const [lpName, flags, lpTime, lpFormat, buf] = args as [number, number, number, number, number];
    const len = args[5]! | 0;
    const locale = localeFromName(readNameW(mem, lpName));
    if (len < 0 || (len && !buf) || !locale || calendar) {
        setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    return formatW(fn, locale, flags >>> 0, lpTime, lpFormat ? Marshaler.readStringW(mem, lpFormat) : null, buf, len);
}

// ---------------------------------------------------------------------------------------
// Guest-callback enumeration
// ---------------------------------------------------------------------------------------

/**
 * Call `proc` once per string, stopping early on a FALSE return, then resume the caller
 * of the enumerating thunk with TRUE. One guest buffer holds each string in turn, the way
 * the real enumerators reuse one stack buffer; it is freed when the walk ends.
 */
function enumerateToGuest(
    ctx: X86Context,
    label: string,
    proc: number,
    items: ReadonlyArray<{ text: string; args: readonly number[] }>,
    wide: boolean,
    stackCleanup: number,
): number | ThunkResult {
    if (items.length === 0) return 1;
    const process = System.getInstance().process;
    const callbackManager = process?.dispatcher?.callbackManager;
    if (!process || !callbackManager) {
        Logger.error(LogCategory.KERNEL32, `${label}: no callback manager; enumeration not delivered`);
        return 0;
    }

    const cp = EmulatorConfig.getInstance().ansiCodePage;
    const encode = (s: string): Uint8Array => {
        if (!wide) return encodeAnsiString(s + '\0', cp);
        const out = new Uint8Array((s.length + 1) * 2);
        for (let i = 0; i < s.length; i++) {
            out[i * 2] = s.charCodeAt(i) & 0xff;
            out[i * 2 + 1] = s.charCodeAt(i) >> 8;
        }
        return out;
    };
    const encoded = items.map((it) => encode(it.text));
    const bufPtr = process.memory.alloc(Math.max(...encoded.map((e) => e.length)));
    if (!bufPtr) {
        setLastError(8); // ERROR_NOT_ENOUGH_MEMORY
        return 0;
    }

    const frameId = callbackManager.saveSuspendedThunkContext(ctx, stackCleanup, label);
    if (!frameId) {
        process.memory.free(bufPtr);
        Logger.error(LogCategory.KERNEL32, `${label}: could not suspend the caller; enumeration not delivered`);
        return 0;
    }

    const cbCleanup = (items[0]!.args.length + 1) * 4;
    let index = 0;
    const invokeAt = (i: number): number => {
        Mem.writeBytes(bufPtr, encoded[i]!);
        return callbackManager.invokeCallback(
            proc, [bufPtr, ...items[i]!.args], cbCleanup, next, false, label, frameId).callbackId;
    };
    const next = (ret: number): number | null => {
        index++;
        if (ret === 0 || index >= items.length) {
            process.memory.free(bufPtr);
            return 1;
        }
        invokeAt(index);
        return null;
    };
    const callbackId = invokeAt(0);
    return { value: 1, suspendedForCallback: true, callbackId, stackCleanup };
}

/** EnumSystemLocalesA/W: LOCALE_ENUMPROC(LPTSTR) per LCID, as "%08x". */
export function enumSystemLocalesByLcid(ctx: X86Context, args: number[], wide: boolean): number | ThunkResult {
    const [proc, flags] = args as [number, number];
    const label = wide ? 'EnumSystemLocalesW' : 'EnumSystemLocalesA';
    if (!proc) {
        setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    const items = enumSystemLcids(flags >>> 0).map((text) => ({ text, args: [] as number[] }));
    return enumerateToGuest(ctx, label, proc, items, wide, 8);
}

// ---------------------------------------------------------------------------------------
// Preferred UI languages
// ---------------------------------------------------------------------------------------

const MUI_LANGUAGE_ID = 0x4;
const MUI_LANGUAGE_NAME = 0x8;
const MUI_THREAD_FLAGS = 0x001 | MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME | 0x10 | 0x20 | 0x40 | 0x100 | 0x200;

/**
 * Get{Thread,User}PreferredUILanguages. We carry one UI language (the manifest LCID's
 * LANGID, what GetUserDefaultUILanguage reports), so the list is that language alone:
 * a double-NUL-terminated multi-string, sized in WCHARs.
 */
function preferredUiLanguages(mem: Uint8Array, args: number[], allowedFlags: number): number {
    const [flags, pCount, buf, pSize] = args as [number, number, number, number];
    if ((flags & ~allowedFlags) || ((flags & MUI_LANGUAGE_ID) && (flags & MUI_LANGUAGE_NAME))
        || !pCount || !pSize) {
        setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    const size = Mem.readUint32(pSize) ?? 0;
    if (size && !buf) {
        setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    const langId = EmulatorConfig.getInstance().lcid & 0xffff;
    const entry = localeFromLcid(langId) ?? userDefaultLocale();
    const name = (flags & MUI_LANGUAGE_ID)
        ? langId.toString(16).toUpperCase().padStart(4, '0')
        : entry.name;
    const needed = name.length + 2;
    if (buf) {
        if (needed > size) {
            Mem.writeUint32(pSize, needed);
            setLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        writeWide(buf, name + '\0\0');
    }
    Mem.writeUint32(pSize, needed);
    Mem.writeUint32(pCount, 1);
    return 1;
}

// ---------------------------------------------------------------------------------------

export const exports: Record<string, ThunkImplementation> = {
    // int GetUserDefaultLocaleName(LPWSTR lpLocaleName, int cchLocaleName)
    'GetUserDefaultLocaleName': (_ctx, _mem, args) =>
        returnLocaleString(userDefaultLocale().name, args[0]!, args[1]! | 0),

    // int GetSystemDefaultLocaleName(LPWSTR lpLocaleName, int cchLocaleName)
    'GetSystemDefaultLocaleName': (_ctx, _mem, args) =>
        returnLocaleString(systemDefaultLocale().name, args[0]!, args[1]! | 0),

    // BOOL IsValidLocaleName(LPCWSTR lpLocaleName) — an installed locale's name; NULL and
    // the system-default alias are not names of a locale.
    'IsValidLocaleName': (_ctx, mem, args) => {
        return isValidLocaleName(readNameW(mem, args[0]!)) ? 1 : 0;
    },

    // LCID LocaleNameToLCID(LPCWSTR lpName, DWORD dwFlags)
    'LocaleNameToLCID': (_ctx, mem, args) => {
        const lcid = localeNameToLcid(readNameW(mem, args[0]!), args[1]! >>> 0);
        if (!lcid) setLastError(ERROR_INVALID_PARAMETER);
        return lcid;
    },

    // int LCIDToLocaleName(LCID Locale, LPWSTR lpName, int cchName, DWORD dwFlags)
    'LCIDToLocaleName': (_ctx, _mem, args) => {
        const [lcid, buf] = args as [number, number];
        const count = args[2]! | 0;
        const entry = localeFromLcid(lcid, args[3]! & LOCALE_ALLOW_NEUTRAL_NAMES);
        if (!entry || (count > 0 && !buf)) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        return returnLocaleString(entry.name, buf, count);
    },

    // int ResolveLocaleName(LPCWSTR lpNameToResolve, LPWSTR lpLocaleName, int cchLocaleName)
    'ResolveLocaleName': (_ctx, mem, args) => {
        const resolved = resolveLocaleName(readNameW(mem, args[0]!));
        if (resolved === undefined) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        return returnTruncatingW(resolved, args[1]!, args[2]! | 0);
    },

    // BOOL EnumSystemLocalesEx(LOCALE_ENUMPROCEX, DWORD dwFlags, LPARAM lParam, LPVOID lpReserved)
    // The callback is BOOL CALLBACK(LPWSTR name, DWORD flags, LPARAM lParam).
    'EnumSystemLocalesEx': (ctx, _mem, args) => {
        const [proc, wanted, lParam, reserved] = args as [number, number, number, number];
        if (reserved || !proc) {
            setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const items = enumSystemLocalesEx(wanted >>> 0).map(({ name, flags }) => ({ text: name, args: [flags, lParam] }));
        return enumerateToGuest(ctx, 'EnumSystemLocalesEx', proc, items, true, 16);
    },

    'EnumSystemLocalesA': (ctx, _mem, args) => enumSystemLocalesByLcid(ctx, args, false),
    'EnumSystemLocalesW': (ctx, _mem, args) => enumSystemLocalesByLcid(ctx, args, true),

    // int GetDateFormat{A,W}(LCID, DWORD, const SYSTEMTIME*, LPCTSTR, LPTSTR, int)
    'GetDateFormatA': (_ctx, mem, args) => formatByLcidA(formatDate, mem, args),
    'GetDateFormatW': (_ctx, mem, args) => formatByLcidW(formatDate, mem, args),
    // int GetDateFormatEx(LPCWSTR, DWORD, const SYSTEMTIME*, LPCWSTR, LPWSTR, int, LPCWSTR lpCalendar)
    'GetDateFormatEx': (_ctx, mem, args) => formatByNameW(formatDate, mem, args, args[6]!),

    // int GetTimeFormat{A,W}(LCID, DWORD, const SYSTEMTIME*, LPCTSTR, LPTSTR, int)
    'GetTimeFormatA': (_ctx, mem, args) => formatByLcidA(formatTime, mem, args),
    'GetTimeFormatW': (_ctx, mem, args) => formatByLcidW(formatTime, mem, args),
    // int GetTimeFormatEx(LPCWSTR, DWORD, const SYSTEMTIME*, LPCWSTR, LPWSTR, int)
    'GetTimeFormatEx': (_ctx, mem, args) => formatByNameW(formatTime, mem, args, 0),

    // BOOL GetThreadPreferredUILanguages(DWORD, PULONG pulNumLanguages, PZZWSTR, PULONG pcch)
    'GetThreadPreferredUILanguages': (_ctx, mem, args) => preferredUiLanguages(mem, args, MUI_THREAD_FLAGS),
    // BOOL GetUserPreferredUILanguages(DWORD, PULONG pulNumLanguages, PZZWSTR, PULONG pcch)
    'GetUserPreferredUILanguages': (_ctx, mem, args) =>
        preferredUiLanguages(mem, args, MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME),
};
