// Locale and string conversion functions for kernel32
// GetACP, GetOEMCP, WideCharToMultiByte, MultiByteToWideChar, etc.

import { ThunkImplementation, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import { EmulatorConfig, getCodePageDecoder, encodeAnsiString, isSingleByteCodePage } from '../../core/emulator-config-manager';
import { encodeAnsi } from '../codepage-utils';
import { asBufferSource } from '../../../dom-buffer';
import { borrowGuestMemory } from '../../core/memory/guest-memory';

// US English locale data lookup (shared between GetLocaleInfoA and GetLocaleInfoW)
const US_LOCALE_DATA: Record<number, string> = {
    0x0001: "0409",            // LOCALE_ILANGUAGE
    0x0002: "English (United States)", // LOCALE_SLANGUAGE
    0x0003: "ENU",             // LOCALE_SABBREVLANGNAME
    0x0004: "English",         // LOCALE_SNATIVELANGNAME
    0x0005: "1",               // LOCALE_ICOUNTRY
    0x0006: "United States",   // LOCALE_SCOUNTRY
    0x0007: "USA",             // LOCALE_SABBREVCTRYNAME
    0x0008: "United States",   // LOCALE_SNATIVECTRYNAME
    0x0009: "0409",            // LOCALE_IDEFAULTLANGUAGE
    0x000A: "1",               // LOCALE_IDEFAULTCOUNTRY
    0x000B: "437",             // LOCALE_IDEFAULTCODEPAGE
    0x000C: ",",               // LOCALE_SLIST
    0x000D: "0",               // LOCALE_IMEASURE
    0x000E: ".",               // LOCALE_SDECIMAL
    0x000F: ",",               // LOCALE_STHOUSAND
    0x0010: "3;0",             // LOCALE_SGROUPING
    0x0011: "2",               // LOCALE_IDIGITS
    0x0012: "1",               // LOCALE_ILZERO
    0x0013: "0123456789",      // LOCALE_SNATIVEDIGITS
    0x0014: "$",               // LOCALE_SCURRENCY
    0x0015: "USD",             // LOCALE_SINTLSYMBOL
    0x0016: ".",               // LOCALE_SMONDECIMALSEP
    0x0017: ",",               // LOCALE_SMONTHOUSANDSEP
    0x0018: "3;0",             // LOCALE_SMONGROUPING
    0x0019: "0",               // LOCALE_ICURRDIGITS
    0x001A: "0",               // LOCALE_IINTLCURRDIGITS
    0x001B: "0",               // LOCALE_ICURRENCY
    0x001C: "0",               // LOCALE_INEGCURR
    0x001D: "M/d/yyyy",        // LOCALE_SSHORTDATE
    0x001E: "dddd, MMMM dd, yyyy", // LOCALE_SLONGDATE
    0x001F: "h:mm:ss tt",      // LOCALE_STIMEFORMAT
    0x0020: "AM",              // LOCALE_S1159
    0x0021: "PM",              // LOCALE_S2359
    0x0023: ":",               // LOCALE_STIME (time separator)
    0x0024: "/",               // LOCALE_SDATE (date separator)
    0x0025: "0",               // LOCALE_IDATE (MDY order)
    0x0028: "0",               // LOCALE_ITIME (12-hour)
    0x0029: "0",               // LOCALE_ITIMEMARKPOSN
    0x002C: "0",               // LOCALE_IDAYLZERO
    0x002D: "0",               // LOCALE_IMONLZERO
    0x0037: "1",               // LOCALE_INEGNUMBER
    0x0059: "en",              // LOCALE_SISO639LANGNAME
    0x005A: "US",              // LOCALE_SISO3166CTRYNAME
    0x1001: "English",         // LOCALE_SENGLANGUAGE
    0x1002: "United States",   // LOCALE_SENGCOUNTRY
    0x1004: "1252",            // LOCALE_IDEFAULTANSICODEPAGE
    0x1010: "1",               // LOCALE_INEGNUMBER
    0x1011: "10000",           // LOCALE_IDEFAULTMACCODEPAGE
};

// Dynamic locale value lookup — overrides static table for codepage-dependent fields
function getLocaleValue(cleanType: number): string | undefined {
    const config = EmulatorConfig.getInstance();
    // LOCALE_IDEFAULTCODEPAGE (0x000B) — OEM code page
    if (cleanType === 0x000B) return String(config.oemCodePage);
    // LOCALE_IDEFAULTANSICODEPAGE (0x1004) — ANSI code page
    if (cleanType === 0x1004) return String(config.ansiCodePage);
    return US_LOCALE_DATA[cleanType];
}

// Gregorian calendar info strings (US English) keyed by CALTYPE.
const GREGORIAN_CAL_INFO: Record<number, string> = {
    0x00001001: "1",           // CAL_ICALINTYPE
    0x0000000b: "2029",        // CAL_ITWODIGITYEARMAX
    0x0000000c: "29",          // CAL_ITWODIGITYEARMIN
    0x0000000d: "Sunday",      // CAL_SDAYNAME1
    0x0000000e: "Monday",
    0x0000000f: "Tuesday",
    0x00000010: "Wednesday",
    0x00000011: "Thursday",
    0x00000012: "Friday",
    0x00000013: "Saturday",    // CAL_SDAYNAME7
    0x00000014: "Sun",         // CAL_SABBREVDAYNAME1
    0x00000015: "Mon",
    0x00000016: "Tue",
    0x00000017: "Wed",
    0x00000018: "Thu",
    0x00000019: "Fri",
    0x0000001a: "Sat",         // CAL_SABBREVDAYNAME7
    0x0000001d: "January",     // CAL_SMONTHNAME1
    0x0000001e: "February",
    0x0000001f: "March",
    0x00000020: "April",
    0x00000021: "May",
    0x00000022: "June",
    0x00000023: "July",
    0x00000024: "August",
    0x00000025: "September",
    0x00000026: "October",
    0x00000027: "November",
    0x00000028: "December",    // CAL_SMONTHNAME12
};

const GREGORIAN_CALENDAR_IDS = new Set([0, 1, 2, 9, 10, 11, 12]);

function resolveCalendarInfoString(calendar: number, calType: number): string | undefined {
    const cleanType = calType & 0x0fffffff;
    if (!GREGORIAN_CALENDAR_IDS.has(calendar)) return undefined;
    return GREGORIAN_CAL_INFO[cleanType];
}

function enumCalendarInfo(
    ctx: any,
    mem: Uint8Array,
    args: number[],
    wide: boolean
): number | ThunkResult {
    const lpCalInfoEnumProc = args[0];
    const locale = args[1];
    const calendar = args[2];
    const calType = args[3];
    const label = wide ? "EnumCalendarInfoW" : "EnumCalendarInfoA";

    if (!lpCalInfoEnumProc) return 0;

    const info = resolveCalendarInfoString(calendar, calType);
    if (info === undefined) {
        Logger.verbose(LogCategory.KERNEL32,
            `${label}(locale=0x${locale.toString(16)}, calendar=${calendar}, calType=0x${calType.toString(16)}) — no data`);
        return 1;
    }

    const system = System.getInstance();
    const process = system.process;
    if (!process || system.isExiting) return 1;
    if (process.dispatcher.hasActiveAsyncThunks()) return 1;

    const callbackManager = process.dispatcher.callbackManager;
    if (!callbackManager) return 1;

    const STACK_CLEANUP = 4 * 4;
    const CALLBACK_CLEANUP = 4;
    let infoPtr = 0;

    if (wide) {
        const bytes = (info.length + 1) * 2;
        infoPtr = process.memory.alloc(bytes);
        Marshaler.writeWideString(mem, infoPtr, info, info.length + 1);
    } else {
        const bytes = encodeAnsi(info + "\0");
        infoPtr = process.memory.alloc(bytes.length);
        mem.set(bytes, infoPtr);
    }

    Logger.verbose(LogCategory.KERNEL32,
        `${label}(locale=0x${locale.toString(16)}, calendar=${calendar}, calType=0x${calType.toString(16)}) -> "${info}"`);

    callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP);
    const { callbackId } = callbackManager.invokeCallback(
        lpCalInfoEnumProc,
        [infoPtr],
        CALLBACK_CLEANUP,
        () => {
            process.memory.free(infoPtr);
            return 1;
        },
        false,
        label
    );

    return {
        value: 1,
        suspendedForCallback: true,
        callbackId,
        stackCleanup: STACK_CLEANUP,
    };
}

export const exports: Record<string, ThunkImplementation> = {
    'GetSystemDefaultLangID': (ctx, mem, args) => {
        // LANGID = low word of LCID
        return EmulatorConfig.getInstance().lcid & 0xFFFF;
    },

    'GetSystemDefaultUILanguage': (_ctx, _mem, _args) => {
        return EmulatorConfig.getInstance().lcid & 0xFFFF;
    },

    'GetUserDefaultLangID': (ctx, mem, args) => {
        return EmulatorConfig.getInstance().lcid & 0xFFFF;
    },

    'GetUserDefaultUILanguage': (_ctx, _mem, _args) => {
        return EmulatorConfig.getInstance().lcid & 0xFFFF;
    },

    'GetThreadLocale': (_ctx, _mem, _args) => {
        return EmulatorConfig.getInstance().lcid;
    },

    'GetUserDefaultLCID': (ctx, mem, args) => {
        return EmulatorConfig.getInstance().lcid;
    },

    'GetSystemDefaultLCID': (ctx, mem, args) => {
        return EmulatorConfig.getInstance().lcid;
    },

    'ConvertDefaultLocale': (ctx, mem, args) => {
        const locale = args[0];
        const LOCALE_USE_CP_ACP = 0x02000000;
        if (locale & LOCALE_USE_CP_ACP) {
            return locale & ~LOCALE_USE_CP_ACP;
        }
        return locale | LOCALE_USE_CP_ACP;
    },

    'GetACP': (ctx, mem, args) => {
        return EmulatorConfig.getInstance().ansiCodePage;
    },

    'GetOEMCP': (ctx, mem, args) => {
        return EmulatorConfig.getInstance().oemCodePage;
    },

    'IsDBCSLeadByte': (ctx, mem, args) => {
        // For CP1252 (our default), there are no lead bytes — always return 0 (FALSE)
        return 0;
    },

    'IsDBCSLeadByteEx': (ctx, mem, args) => {
        // For all single-byte code pages we emulate, no lead bytes exist
        return 0;
    },

    'IsValidCodePage': (ctx, mem, args) => {
        const cp = args[0];
        // 1252, 437, 65001 (UTF-8) are valid
        return (cp === 1252 || cp === 437 || cp === 65001) ? 1 : 0;
    },

    'IsValidLocale': (ctx, mem, args) => {
        const locale = args[0];
        const dwFlags = args[1];
        // Stub: treat LOCALE_INVARIANT (0x007f) and English (0x0409) as valid
        return (locale === 0x007f || locale === 0x0409) ? 1 : 0;
    },

    'GetLocaleInfoA': (ctx, mem, args) => {
        const locale = args[0];
        const lcType = args[1];
        const lpLCData = args[2];
        const cchData = args[3];

        // Strip LOCALE_NOUSEROVERRIDE (0x80000000) and LOCALE_RETURN_NUMBER (0x20000000)
        const LOCALE_RETURN_NUMBER = 0x20000000;
        const returnNumber = (lcType & LOCALE_RETURN_NUMBER) !== 0;
        const cleanType = lcType & 0x0000FFFF;

        const value = getLocaleValue(cleanType);
        if (value === undefined) {
            Logger.verbose(LogCategory.KERNEL32,
                `GetLocaleInfoA(locale=0x${locale.toString(16)}, lcType=0x${cleanType.toString(16)}) — unknown, returning empty`);
            if (!lpLCData || cchData <= 0) return 0;
            mem[lpLCData] = 0;
            return 1;
        }

        // LOCALE_RETURN_NUMBER: write as DWORD, return sizeof(DWORD)/sizeof(char) = 4
        if (returnNumber) {
            if (cchData === 0) return 4;
            if (!lpLCData) return 0;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpLCData, parseInt(value, 10) || 0, true);
            return 4;
        }

        const required = value.length + 1; // include null terminator
        if (cchData === 0) return required;
        if (!lpLCData) return 0;

        const toWrite = Math.min(required, cchData);
        const valueBytes = encodeAnsi(value);
        mem.set(valueBytes.subarray(0, toWrite - 1), lpLCData);
        mem[lpLCData + toWrite - 1] = 0; // null terminator
        return toWrite;
    },

    'GetLocaleInfoW': (ctx, mem, args) => {
        const locale = args[0];
        const lcType = args[1];
        const lpLCData = args[2];
        const cchData = args[3];

        const LOCALE_RETURN_NUMBER = 0x20000000;
        const returnNumber = (lcType & LOCALE_RETURN_NUMBER) !== 0;
        const cleanType = lcType & 0x0000FFFF;

        const value = getLocaleValue(cleanType);
        if (value === undefined) {
            Logger.verbose(LogCategory.KERNEL32,
                `GetLocaleInfoW(locale=0x${locale.toString(16)}, lcType=0x${cleanType.toString(16)}) — unknown, returning empty`);
            if (!lpLCData || cchData <= 0) return 0;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(lpLCData, 0, true);
            return 1;
        }

        // LOCALE_RETURN_NUMBER: write as DWORD, return sizeof(DWORD)/sizeof(WCHAR) = 2
        if (returnNumber) {
            if (cchData === 0) return 2;
            if (!lpLCData) return 0;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpLCData, parseInt(value, 10) || 0, true);
            return 2;
        }

        const required = value.length + 1; // WCHARs including null
        if (cchData === 0) return required;
        if (!lpLCData) return 0;

        const toWrite = Math.min(required, cchData);
        return Marshaler.writeWideString(mem, lpLCData, value, toWrite) / 2;
    },

    'GetLocaleInfoEx': (ctx, mem, args) => {
        const lpLocaleName = args[0];
        const lcType = args[1] >>> 0;
        const lpLCData = args[2];
        const cchData = args[3] | 0;

        // Minimal practical responses for common LCType queries.
        const value = (() => {
            switch (lcType) {
                case 0x0000005c: return "en-US"; // LOCALE_SNAME
                case 0x00000002: return ".";     // LOCALE_SDECIMAL
                case 0x00000003: return ",";     // LOCALE_STHOUSAND
                default: return "";
            }
        })();

        if (cchData === 0) {
            return value.length + 1; // Required WCHAR count including null.
        }
        if (!lpLCData || cchData <= 0) {
            return 0;
        }

        const bytesWritten = Marshaler.writeWideString(mem, lpLCData, value, cchData);
        return Math.max(1, (bytesWritten / 2) | 0);
    },

    'EnumSystemLocalesA': (ctx, mem, args) => {
        const lpLocaleEnumProc = args[0];
        const dwFlags = args[1];
        // Stub: return TRUE without calling callback (no locales enumerated)
        return 1;
    },

    'EnumSystemLocalesW': (ctx, mem, args) => {
        // Conservative stub: report success without callback invocation.
        return 1;
    },

    'EnumCalendarInfoA': (ctx, mem, args) => enumCalendarInfo(ctx, mem, args, false),

    'EnumCalendarInfoW': (ctx, mem, args) => enumCalendarInfo(ctx, mem, args, true),

    'WideCharToMultiByte': (ctx, mem, args) => {
        const CodePage = args[0];
        const dwFlags = args[1];
        const lpWideCharStr = args[2];
        const cchWideChar = args[3] | 0;
        const lpMultiByteStr = args[4];
        const cbMultiByte = args[5] | 0;
        const lpDefaultChar = args[6];
        const lpUsedDefaultChar = args[7];

        if (lpWideCharStr === 0) return 0;

        const wideStr = (cchWideChar === -1) ? 
            Marshaler.readWideString(mem, lpWideCharStr) : 
            (() => {
                let s = "";
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const count = Math.min(cchWideChar, (mem.length - lpWideCharStr) / 2);
                for (let i = 0; i < count; i++) {
                    s += String.fromCharCode(view.getUint16(lpWideCharStr + i * 2, true));
                }
                return s;
            })();

        // Use requested code page (CP_ACP=0 → system ANSI, CP_OEMCP=1 → system OEM)
        const config = EmulatorConfig.getInstance();
        const effectiveCp = CodePage === 0 ? config.ansiCodePage : CodePage === 1 ? config.oemCodePage : CodePage;
        const strToEncode = wideStr + (cchWideChar === -1 ? "\0" : "");
        const encoded = encodeAnsiString(strToEncode, effectiveCp);
        
        if (cbMultiByte === 0) {
            return encoded.length;
        }

        const toWrite = Math.min(encoded.length, cbMultiByte);
        mem.set(encoded.slice(0, toWrite), lpMultiByteStr);

        Logger.verbose(LogCategory.KERNEL32,
            `WideCharToMultiByte(cp=${CodePage}, wstr=0x${lpWideCharStr.toString(16)}) "${wideStr.slice(0, 120)}" -> ANSI len=${toWrite}`);

        return toWrite;
    },

    'MultiByteToWideChar': (ctx, mem, args) => {
        // Counted HERE, not only at the fast path's bail sites: a call that never reaches the
        // fast-path table at all (an unbound stub) would otherwise be invisible to both.
        localeFastPathStats.mbtwcThunk++;
        const CodePage = args[0];
        const dwFlags = args[1];
        const lpMultiByteStr = args[2];
        const cbMultiByte = args[3] | 0;
        const lpWideCharStr = args[4];
        const cchWideChar = args[5] | 0;

        if (lpMultiByteStr === 0) return 0;

        // Use requested code page (CP_ACP=0 → system ANSI, CP_OEMCP=1 → system OEM)
        const config = EmulatorConfig.getInstance();
        const effectiveCp = CodePage === 0 ? config.ansiCodePage : CodePage === 1 ? config.oemCodePage : CodePage;
        const decoder = getCodePageDecoder(effectiveCp);

        const decoded = (cbMultiByte === -1) ?
            Marshaler.readString(mem, lpMultiByteStr) :
            decoder.decode(asBufferSource(mem.subarray(lpMultiByteStr, lpMultiByteStr + cbMultiByte)));

        const wideStr = decoded + (cbMultiByte === -1 ? "\0" : "");

        if (cchWideChar === 0) {
            return wideStr.length;
        }

        // Per Win32 contract: when the source is explicitly sized (cbMultiByte != -1)
        // the output is NOT null-terminated. Marshaler.writeWideString reserves a slot
        // for a terminator (`maxChars - 1`) and would drop the last char — cchWideChar=1
        // then writes zero chars, which breaks games that use MultiByteToWideChar as a
        // single-char ANSI→WCHAR translator.
        const toWrite = Math.min(wideStr.length, cchWideChar);
        if (toWrite > 0 && lpWideCharStr > 0 && lpWideCharStr + toWrite * 2 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < toWrite; i++) {
                view.setUint16(lpWideCharStr + i * 2, wideStr.charCodeAt(i), true);
            }
        }
        return toWrite;
    },

    'GetStringTypeA': (ctx, mem, args) => {
        // BOOL GetStringTypeA(LCID Locale, DWORD dwInfoType, LPCSTR lpSrcStr, int cchSrc, LPWORD lpCharType)
        const locale = args[0];
        const dwInfoType = args[1];
        const lpSrcStr = args[2];
        const cchSrc = args[3] | 0;
        const lpCharType = args[4];

        if (!lpSrcStr || !lpCharType || cchSrc === 0) return 0;

        const count = (cchSrc === -1) ? (() => {
            let len = 0;
            while (lpSrcStr + len < mem.length && mem[lpSrcStr + len] !== 0) len++;
            return len + 1;
        })() : cchSrc;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        for (let i = 0; i < count; i++) {
            if (lpSrcStr + i >= mem.length) break;
            const ch = mem[lpSrcStr + i];
            let type = 0;

            if (dwInfoType === 1) { // CT_CTYPE1
                if (ch >= 0x41 && ch <= 0x5A) type |= 0x0001 | 0x0100; // C1_UPPER | C1_ALPHA
                if (ch >= 0x61 && ch <= 0x7A) type |= 0x0002 | 0x0100; // C1_LOWER | C1_ALPHA
                if (ch >= 0x30 && ch <= 0x39) type |= 0x0004 | 0x0080; // C1_DIGIT | C1_XDIGIT
                if (ch >= 0x41 && ch <= 0x46) type |= 0x0080; // C1_XDIGIT (A-F)
                if (ch >= 0x61 && ch <= 0x66) type |= 0x0080; // C1_XDIGIT (a-f)
                if (ch === 0x20 || ch === 0x09) type |= 0x0008 | 0x0040; // C1_SPACE | C1_BLANK
                if (ch === 0x0A || ch === 0x0D || ch === 0x0B || ch === 0x0C) type |= 0x0008; // C1_SPACE
                if (ch < 0x20 || ch === 0x7F) type |= 0x0020; // C1_CNTRL
                if ((ch >= 0x21 && ch <= 0x2F) || (ch >= 0x3A && ch <= 0x40) ||
                    (ch >= 0x5B && ch <= 0x60) || (ch >= 0x7B && ch <= 0x7E)) {
                    type |= 0x0010; // C1_PUNCT
                }
            }

            const dstAddr = lpCharType + i * 2;
            if (dstAddr + 1 < mem.length) {
                view.setUint16(dstAddr, type, true);
            }
        }

        return 1; // TRUE
    },

    'GetStringTypeW': (ctx, mem, args) => {
        const dwInfoType = args[0];
        const lpSrcStr = args[1];
        const cchSrc = args[2] | 0;
        const lpCharType = args[3];

        if (lpSrcStr === 0 || lpCharType === 0) return 0;

        const count = (cchSrc === -1) ? Marshaler.readWideString(mem, lpSrcStr).length + 1 : cchSrc;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        for (let i = 0; i < count; i++) {
            const addr = lpSrcStr + i * 2;
            if (addr + 1 >= mem.length) break;
            const charCode = view.getUint16(addr, true);
            let type = 0;

            if (dwInfoType === 1) { // CT_CTYPE1
                if (charCode >= 0x30 && charCode <= 0x39) type |= 0x0004; // C1_DIGIT
                if ((charCode >= 0x41 && charCode <= 0x5A) || (charCode >= 0x61 && charCode <= 0x7A)) type |= 0x0003; // C1_ALPHA
                if (charCode === 0x20 || (charCode >= 0x09 && charCode <= 0x0D)) type |= 0x0008; // C1_SPACE
            }
            // Add more types as needed, but this is often enough for CRT init
            
            const dstAddr = lpCharType + i * 2;
            if (dstAddr + 1 < mem.length) {
                view.setUint16(dstAddr, type, true);
            }
        }

        return 1; // TRUE
    },

    'LCMapStringW': (ctx, mem, args) => {
        const Locale = args[0];
        const dwMapFlags = args[1];
        const lpSrcStr = args[2];
        const cchSrc = args[3] | 0;
        const lpDestStr = args[4];
        const cchDest = args[5] | 0;

        if (lpSrcStr === 0) return 0;

        const LCMAP_SORTKEY = 0x00000400;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        const src = (cchSrc === -1) ?
            Marshaler.readWideString(mem, lpSrcStr) :
            (() => {
                let s = "";
                const count = Math.min(cchSrc, (mem.length - lpSrcStr) / 2);
                for (let i = 0; i < count; i++) {
                    s += String.fromCharCode(view.getUint16(lpSrcStr + i * 2, true));
                }
                return s;
            })();

        if (dwMapFlags & LCMAP_SORTKEY) {
            // Sort key is a BYTE array (not wide string), return value is byte count
            // Simple sort key: write low byte of each char + separator bytes + null
            const srcChars = (cchSrc === -1) ? src.length : cchSrc;
            const keyLen = srcChars + 3; // chars + 0x01 + 0x01 + 0x00
            if (cchDest === 0) return keyLen;
            if (!lpDestStr) return 0;

            const toWrite = Math.min(keyLen, cchDest);
            for (let i = 0; i < Math.min(srcChars, toWrite); i++) {
                const ch = src.charCodeAt(i);
                mem[lpDestStr + i] = (ch & 0xFF) || 0x01; // replace null bytes with 0x01
            }
            let pos = Math.min(srcChars, toWrite);
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x01;
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x01;
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x00;
            return toWrite;
        }

        let result = src;
        if (dwMapFlags & 0x00000100) { // LCMAP_LOWERCASE
            result = src.toLowerCase();
        } else if (dwMapFlags & 0x00000200) { // LCMAP_UPPERCASE
            result = src.toUpperCase();
        }

        if (cchDest === 0) {
            return result.length + (cchSrc === -1 ? 1 : 0);
        }

        return Marshaler.writeWideString(mem, lpDestStr, result, cchDest) / 2;
    },

    'LCMapStringA': (ctx, mem, args) => {
        const Locale = args[0];
        const dwMapFlags = args[1];
        const lpSrcStr = args[2];
        const cchSrc = args[3] | 0;
        const lpDestStr = args[4];
        const cchDest = args[5] | 0;

        if (lpSrcStr === 0) return 0;

        const LCMAP_SORTKEY = 0x00000400;

        // Read ANSI source string
        let srcLen: number;
        if (cchSrc === -1) {
            srcLen = 0;
            while (lpSrcStr + srcLen < mem.length && mem[lpSrcStr + srcLen] !== 0) srcLen++;
            srcLen++; // include null terminator
        } else {
            srcLen = cchSrc;
        }

        if (dwMapFlags & LCMAP_SORTKEY) {
            // Sort key is a byte array: copy bytes + add null terminator
            // Simple sort key: each byte as-is, terminated by 0x01, 0x01, 0x00
            const keyLen = srcLen + 3; // bytes + separator + separator + null
            if (cchDest === 0) return keyLen;
            if (!lpDestStr) return 0;

            const toWrite = Math.min(keyLen, cchDest);
            for (let i = 0; i < Math.min(srcLen, toWrite); i++) {
                mem[lpDestStr + i] = mem[lpSrcStr + i] || 0x01; // replace nulls with 0x01
            }
            // Append terminators if space allows
            let pos = Math.min(srcLen, toWrite);
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x01;
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x01;
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x00;
            return toWrite;
        }

        // Case mapping
        const src = getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage).decode(asBufferSource(mem.subarray(lpSrcStr, lpSrcStr + srcLen)));
        let result: string;
        if (dwMapFlags & 0x00000100) { // LCMAP_LOWERCASE
            result = src.toLowerCase();
        } else if (dwMapFlags & 0x00000200) { // LCMAP_UPPERCASE
            result = src.toUpperCase();
        } else {
            result = src;
        }

        const resultLen = cchSrc === -1 ? result.length : srcLen;
        if (cchDest === 0) return resultLen;
        if (!lpDestStr) return 0;

        const toWrite = Math.min(resultLen, cchDest);
        const resultBytes = encodeAnsi(result);
        mem.set(resultBytes.subarray(0, toWrite), lpDestStr);
        return toWrite;
    },

    'LCMapStringEx': (ctx, mem, args) => {
        const lpLocaleName = args[0];
        const dwMapFlags = args[1];
        const lpSrcStr = args[2];
        const cchSrc = args[3] | 0;
        const lpDestStr = args[4];
        const cchDest = args[5] | 0;
        const lpVersionInformation = args[6];
        const lpReserved = args[7];
        const sortHandle = args[8];

        const localeName = lpLocaleName ? Marshaler.readWideString(mem, lpLocaleName) : 'invariant';
        
        Logger.verbose(LogCategory.KERNEL32, `LCMapStringEx(locale="${localeName}", flags=0x${dwMapFlags.toString(16)}, src=0x${lpSrcStr.toString(16)}, cchSrc=${cchSrc}, dest=0x${lpDestStr.toString(16)}, cchDest=${cchDest})`);

        if (lpSrcStr === 0) return 0;

        const LCMAP_SORTKEY = 0x00000400;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        const src = (cchSrc === -1) ?
            Marshaler.readWideString(mem, lpSrcStr) :
            (() => {
                let s = "";
                const count = Math.min(cchSrc, (mem.length - lpSrcStr) / 2);
                for (let i = 0; i < count; i++) {
                    s += String.fromCharCode(view.getUint16(lpSrcStr + i * 2, true));
                }
                return s;
            })();

        if (dwMapFlags & LCMAP_SORTKEY) {
            const srcChars = (cchSrc === -1) ? src.length : cchSrc;
            const keyLen = srcChars + 3;
            if (cchDest === 0) return keyLen;
            if (!lpDestStr) return 0;
            const toWrite = Math.min(keyLen, cchDest);
            for (let i = 0; i < Math.min(srcChars, toWrite); i++) {
                const ch = src.charCodeAt(i);
                mem[lpDestStr + i] = (ch & 0xFF) || 0x01;
            }
            let pos = Math.min(srcChars, toWrite);
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x01;
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x01;
            if (pos < toWrite) mem[lpDestStr + pos++] = 0x00;
            return toWrite;
        }

        let result = src;
        if (dwMapFlags & 0x00000100) { // LCMAP_LOWERCASE
            result = src.toLowerCase();
        } else if (dwMapFlags & 0x00000200) { // LCMAP_UPPERCASE
            result = src.toUpperCase();
        }

        if (cchDest === 0) {
            return result.length + (cchSrc === -1 ? 1 : 0);
        }

        return Marshaler.writeWideString(mem, lpDestStr, result, cchDest) / 2;
    },

    'GetCPInfo': (ctx, mem, args) => {
        const CodePage = args[0];
        const lpCPInfo = args[1];

        if (lpCPInfo && lpCPInfo + 18 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // CPINFO structure: MaxCharSize depends on codepage
            // DBCS codepages (932=Shift-JIS, 936=GBK, 949=EUC-KR, 950=Big5) use 2
            // All single-byte codepages (1252, 437, 850, 28591, etc.) use 1
            const dbcsCodePages = new Set([932, 936, 949, 950]);
            const maxCharSize = dbcsCodePages.has(CodePage) ? 2 : 1;
            view.setUint32(lpCPInfo, maxCharSize, true); // MaxCharSize
            // DefaultChar (2 bytes)
            view.setUint8(lpCPInfo + 4, 0x3F); // '?'
            view.setUint8(lpCPInfo + 5, 0);
            // LeadByte (12 bytes) — empty for single-byte codepages
            mem.fill(0, lpCPInfo + 6, lpCPInfo + 18);
            return 1;
        }
        return 0;
    },

    // ==================== String Functions ====================

    'lstrlenA': (ctx, mem, args) => {
        const lpString = args[0];
        if (!lpString || lpString >= mem.length) return 0;
        let len = 0;
        while (lpString + len < mem.length && mem[lpString + len] !== 0) {
            len++;
        }
        return len;
    },

    'lstrlenW': (ctx, mem, args) => {
        const lpString = args[0];
        if (!lpString || lpString >= mem.length) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let len = 0;
        while (lpString + len * 2 + 1 < mem.length && view.getUint16(lpString + len * 2, true) !== 0) {
            len++;
        }
        return len;
    },

    'lstrcpyA': (ctx, mem, args) => {
        const lpString1 = args[0]; // destination
        const lpString2 = args[1]; // source
        if (!lpString1 || !lpString2) return 0;

        let i = 0;
        while (lpString2 + i < mem.length && lpString1 + i < mem.length) {
            const ch = mem[lpString2 + i];
            mem[lpString1 + i] = ch;
            if (ch === 0) break;
            i++;
        }
        // Ensure null termination
        if (lpString1 + i < mem.length) {
            mem[lpString1 + i] = 0;
        }
        return lpString1;
    },

    'lstrcpyW': (ctx, mem, args) => {
        const lpString1 = args[0]; // destination
        const lpString2 = args[1]; // source
        if (!lpString1 || !lpString2) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let i = 0;
        while (lpString2 + i * 2 + 1 < mem.length && lpString1 + i * 2 + 1 < mem.length) {
            const ch = view.getUint16(lpString2 + i * 2, true);
            view.setUint16(lpString1 + i * 2, ch, true);
            if (ch === 0) break;
            i++;
        }
        return lpString1;
    },

    'lstrcatA': (ctx, mem, args) => {
        const lpString1 = args[0]; // destination
        const lpString2 = args[1]; // source to append
        if (!lpString1 || !lpString2) return 0;

        // Find end of destination
        let destEnd = 0;
        while (lpString1 + destEnd < mem.length && mem[lpString1 + destEnd] !== 0) {
            destEnd++;
        }

        // Copy source
        let i = 0;
        while (lpString2 + i < mem.length && lpString1 + destEnd + i < mem.length) {
            const ch = mem[lpString2 + i];
            mem[lpString1 + destEnd + i] = ch;
            if (ch === 0) break;
            i++;
        }
        return lpString1;
    },

    'lstrcatW': (ctx, mem, args) => {
        const lpString1 = args[0];
        const lpString2 = args[1];
        if (!lpString1 || !lpString2) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let destEnd = 0;
        while (lpString1 + destEnd * 2 + 1 < mem.length && view.getUint16(lpString1 + destEnd * 2, true) !== 0) {
            destEnd++;
        }

        let i = 0;
        while (lpString2 + i * 2 + 1 < mem.length && lpString1 + (destEnd + i) * 2 + 1 < mem.length) {
            const ch = view.getUint16(lpString2 + i * 2, true);
            view.setUint16(lpString1 + (destEnd + i) * 2, ch, true);
            if (ch === 0) break;
            i++;
        }
        return lpString1;
    },

    'lstrcmpA': (ctx, mem, args) => {
        const lpString1 = args[0];
        const lpString2 = args[1];
        if (!lpString1 && !lpString2) return 0;
        if (!lpString1) return -1;
        if (!lpString2) return 1;

        // Helper to read C string
        const readCStr = (ptr: number, maxLen = 64): string => {
            if (!ptr || ptr >= mem.length) return '<null>';
            let s = '';
            for (let i = 0; i < maxLen && ptr + i < mem.length; i++) {
                const c = mem[ptr + i];
                if (c === 0) break;
                s += String.fromCharCode(c);
            }
            return s;
        };

        let i = 0;
        while (lpString1 + i < mem.length && lpString2 + i < mem.length) {
            const c1 = mem[lpString1 + i];
            const c2 = mem[lpString2 + i];
            if (c1 !== c2) {
                const s1 = readCStr(lpString1);
                const s2 = readCStr(lpString2);
                if (s1.toLowerCase().includes('genrltxt') || s2.toLowerCase().includes('genrltxt') ||
                    s1.toLowerCase().includes('.lod') || s2.toLowerCase().includes('.lod') ||
                    s1.toLowerCase().includes('.txt') || s2.toLowerCase().includes('.txt')) {
                    Logger.log(LogCategory.KERNEL32, `lstrcmpA("${s1}", "${s2}") => ${c1 - c2}`);
                }
                return c1 - c2;
            }
            if (c1 === 0) break;
            i++;
        }
        const s1 = readCStr(lpString1);
        const s2 = readCStr(lpString2);
        if (s1.toLowerCase().includes('genrltxt') || s2.toLowerCase().includes('genrltxt') ||
            s1.toLowerCase().includes('.lod') || s2.toLowerCase().includes('.lod')) {
            Logger.log(LogCategory.KERNEL32, `lstrcmpA("${s1}", "${s2}") => 0 (MATCH!)`);
        }
        return 0;
    },

    'lstrcmpW': (ctx, mem, args) => {
        const lpString1 = args[0];
        const lpString2 = args[1];
        if (!lpString1 && !lpString2) return 0;
        if (!lpString1) return -1;
        if (!lpString2) return 1;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let i = 0;
        while (lpString1 + i * 2 + 1 < mem.length && lpString2 + i * 2 + 1 < mem.length) {
            const c1 = view.getUint16(lpString1 + i * 2, true);
            const c2 = view.getUint16(lpString2 + i * 2, true);
            if (c1 !== c2) return c1 - c2;
            if (c1 === 0) break;
            i++;
        }
        return 0;
    },

    'lstrcmpiA': (ctx, mem, args) => {
        const lpString1 = args[0];
        const lpString2 = args[1];
        if (!lpString1 && !lpString2) return 0;
        if (!lpString1) return -1;
        if (!lpString2) return 1;

        // Helper to read C string
        const readCStr = (ptr: number, maxLen = 64): string => {
            if (!ptr || ptr >= mem.length) return '<null>';
            let s = '';
            for (let i = 0; i < maxLen && ptr + i < mem.length; i++) {
                const c = mem[ptr + i];
                if (c === 0) break;
                s += String.fromCharCode(c);
            }
            return s;
        };

        let i = 0;
        while (lpString1 + i < mem.length && lpString2 + i < mem.length) {
            let c1 = mem[lpString1 + i];
            let c2 = mem[lpString2 + i];
            // Convert to lowercase for comparison
            if (c1 >= 0x41 && c1 <= 0x5A) c1 += 0x20;
            if (c2 >= 0x41 && c2 <= 0x5A) c2 += 0x20;
            if (c1 !== c2) {
                const s1 = readCStr(lpString1);
                const s2 = readCStr(lpString2);
                if (s1.toLowerCase().includes('genrltxt') || s2.toLowerCase().includes('genrltxt') ||
                    s1.toLowerCase().includes('.lod') || s2.toLowerCase().includes('.lod') ||
                    s1.toLowerCase().includes('.txt') || s2.toLowerCase().includes('.txt')) {
                    Logger.log(LogCategory.KERNEL32, `lstrcmpiA("${s1}", "${s2}") => ${c1 - c2}`);
                }
                return c1 - c2;
            }
            if (c1 === 0) break;
            i++;
        }
        const s1 = readCStr(lpString1);
        const s2 = readCStr(lpString2);
        if (s1.toLowerCase().includes('genrltxt') || s2.toLowerCase().includes('genrltxt') ||
            s1.toLowerCase().includes('.lod') || s2.toLowerCase().includes('.lod')) {
            Logger.log(LogCategory.KERNEL32, `lstrcmpiA("${s1}", "${s2}") => 0 (MATCH!)`);
        }
        return 0;
    },

    'lstrcmpiW': (ctx, mem, args) => {
        const lpString1 = args[0];
        const lpString2 = args[1];
        if (!lpString1 && !lpString2) return 0;
        if (!lpString1) return -1;
        if (!lpString2) return 1;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let i = 0;
        while (lpString1 + i * 2 + 1 < mem.length && lpString2 + i * 2 + 1 < mem.length) {
            let c1 = view.getUint16(lpString1 + i * 2, true);
            let c2 = view.getUint16(lpString2 + i * 2, true);
            // Convert to lowercase for comparison
            if (c1 >= 0x41 && c1 <= 0x5A) c1 += 0x20;
            if (c2 >= 0x41 && c2 <= 0x5A) c2 += 0x20;
            if (c1 !== c2) return c1 - c2;
            if (c1 === 0) break;
            i++;
        }
        return 0;
    },

    // DisableThreadLibraryCalls - prevents DLL_THREAD_ATTACH/DETACH notifications
    'CompareStringA': (ctx, mem, args) => {
        const Locale = args[0];
        const dwCmpFlags = args[1];
        const lpString1 = args[2];
        const cchCount1 = args[3] | 0;
        const lpString2 = args[4];
        const cchCount2 = args[5] | 0;

        // CSTR_LESS_THAN = 1, CSTR_EQUAL = 2, CSTR_GREATER_THAN = 3
        if (lpString1 === 0 || lpString2 === 0) {
            Logger.warn(LogCategory.KERNEL32, 'CompareStringA: NULL string pointer');
            return 0; // Error
        }

        // Read strings
        const cpDecoder = getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage);
        const str1 = (cchCount1 === -1) ?
            Marshaler.readString(mem, lpString1) :
            cpDecoder.decode(asBufferSource(mem.subarray(lpString1, lpString1 + cchCount1)));
        const str2 = (cchCount2 === -1) ?
            Marshaler.readString(mem, lpString2) :
            cpDecoder.decode(asBufferSource(mem.subarray(lpString2, lpString2 + cchCount2)));

        Logger.verbose(LogCategory.KERNEL32, `CompareStringA(locale=0x${Locale.toString(16)}, flags=0x${dwCmpFlags.toString(16)}, str1="${str1}", str2="${str2}")`);

        // Apply flags
        const NORM_IGNORECASE = 0x00000001;
        let s1 = str1;
        let s2 = str2;
        if (dwCmpFlags & NORM_IGNORECASE) {
            s1 = str1.toLowerCase();
            s2 = str2.toLowerCase();
        }

        // Compare
        if (s1 < s2) return 1; // CSTR_LESS_THAN
        if (s1 > s2) return 3; // CSTR_GREATER_THAN
        return 2; // CSTR_EQUAL
    },

    'CompareStringW': (ctx, mem, args) => {
        const Locale = args[0];
        const dwCmpFlags = args[1];
        const lpString1 = args[2];
        const cchCount1 = args[3] | 0;
        const lpString2 = args[4];
        const cchCount2 = args[5] | 0;

        // CSTR_LESS_THAN = 1, CSTR_EQUAL = 2, CSTR_GREATER_THAN = 3
        if (lpString1 === 0 || lpString2 === 0) {
            Logger.warn(LogCategory.KERNEL32, 'CompareStringW: NULL string pointer');
            return 0; // Error
        }

        // Read wide strings
        const str1 = (cchCount1 === -1) ?
            Marshaler.readWideString(mem, lpString1) :
            (() => {
                let s = "";
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const count = Math.min(cchCount1, (mem.length - lpString1) / 2);
                for (let i = 0; i < count; i++) {
                    s += String.fromCharCode(view.getUint16(lpString1 + i * 2, true));
                }
                return s;
            })();
        const str2 = (cchCount2 === -1) ?
            Marshaler.readWideString(mem, lpString2) :
            (() => {
                let s = "";
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const count = Math.min(cchCount2, (mem.length - lpString2) / 2);
                for (let i = 0; i < count; i++) {
                    s += String.fromCharCode(view.getUint16(lpString2 + i * 2, true));
                }
                return s;
            })();

        Logger.verbose(LogCategory.KERNEL32, `CompareStringW(locale=0x${Locale.toString(16)}, flags=0x${dwCmpFlags.toString(16)}, str1="${str1}", str2="${str2}")`);

        // Apply flags
        const NORM_IGNORECASE = 0x00000001;
        let s1 = str1;
        let s2 = str2;
        if (dwCmpFlags & NORM_IGNORECASE) {
            s1 = str1.toLowerCase();
            s2 = str2.toLowerCase();
        }

        // Compare
        if (s1 < s2) return 1; // CSTR_LESS_THAN
        if (s1 > s2) return 3; // CSTR_GREATER_THAN
        return 2; // CSTR_EQUAL
    },

    'CompareStringEx': (ctx, mem, args) => {
        const lpLocaleName = args[0];
        const dwCmpFlags = args[1] >>> 0;
        const lpString1 = args[2];
        const cchCount1 = args[3] | 0;
        const lpString2 = args[4];
        const cchCount2 = args[5] | 0;
        if (!lpString1 || !lpString2) return 0;

        const str1 = cchCount1 === -1
            ? Marshaler.readWideString(mem, lpString1)
            : Marshaler.readWideString(mem, lpString1).slice(0, Math.max(0, cchCount1));
        const str2 = cchCount2 === -1
            ? Marshaler.readWideString(mem, lpString2)
            : Marshaler.readWideString(mem, lpString2).slice(0, Math.max(0, cchCount2));

        const NORM_IGNORECASE = 0x00000001;
        const s1 = (dwCmpFlags & NORM_IGNORECASE) ? str1.toLowerCase() : str1;
        const s2 = (dwCmpFlags & NORM_IGNORECASE) ? str2.toLowerCase() : str2;

        if (s1 < s2) return 1; // CSTR_LESS_THAN
        if (s1 > s2) return 3; // CSTR_GREATER_THAN
        return 2; // CSTR_EQUAL
    },

    'DisableThreadLibraryCalls': (ctx, mem, args) => {
        const hModule = args[0];
        Logger.verbose(LogCategory.KERNEL32, `DisableThreadLibraryCalls(hModule=0x${hModule.toString(16)})`);
        // No-op for emulation - we don't send thread notifications anyway
        return 1; // TRUE = success
    },

    // ==================== Profile (INI file) Functions ====================
    // Moved to kernel32/profile.ts with full INI parsing implementation

    // GetStringTypeExA - retrieves character type information for characters in a string
    'GetStringTypeExA': (ctx, mem, args) => {
        const locale = args[0];      // LCID - locale identifier
        const dwInfoType = args[1];  // DWORD - type of character type information
        const lpSrcStr = args[2];    // LPCSTR - source string
        const cchSrc = args[3];      // int - number of characters
        const lpCharType = args[4];  // LPWORD - buffer for character types

        Logger.verbose(LogCategory.KERNEL32,
            `GetStringTypeExA(locale=0x${locale.toString(16)}, infoType=${dwInfoType}, str=0x${lpSrcStr.toString(16)}, count=${cchSrc})`);

        if (!lpSrcStr || !lpCharType || cchSrc <= 0) {
            return 0; // FALSE
        }

        // Constants for dwInfoType
        const CT_CTYPE1 = 1; // Character types (letter, digit, space, etc.)
        const CT_CTYPE2 = 2; // Text layout (left-to-right, right-to-left)
        const CT_CTYPE3 = 4; // Text processing (symbol, alpha, etc.)

        // CT_CTYPE1 flags
        const C1_UPPER = 0x0001;   // Uppercase
        const C1_LOWER = 0x0002;   // Lowercase
        const C1_DIGIT = 0x0004;   // Digit
        const C1_SPACE = 0x0008;   // Space
        const C1_PUNCT = 0x0010;   // Punctuation
        const C1_CNTRL = 0x0020;   // Control character
        const C1_BLANK = 0x0040;   // Blank
        const C1_XDIGIT = 0x0080;  // Hexadecimal digit
        const C1_ALPHA = 0x0100;   // Alphabetic

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        for (let i = 0; i < cchSrc; i++) {
            if (lpSrcStr + i >= mem.length || lpCharType + i * 2 + 1 >= mem.length) {
                break;
            }

            const ch = mem[lpSrcStr + i];
            let charType = 0;

            if (dwInfoType === CT_CTYPE1) {
                // Basic character type classification
                if (ch >= 0x41 && ch <= 0x5A) charType |= C1_UPPER | C1_ALPHA;  // A-Z
                if (ch >= 0x61 && ch <= 0x7A) charType |= C1_LOWER | C1_ALPHA;  // a-z
                if (ch >= 0x30 && ch <= 0x39) charType |= C1_DIGIT | C1_XDIGIT; // 0-9
                if (ch >= 0x41 && ch <= 0x46) charType |= C1_XDIGIT;            // A-F
                if (ch >= 0x61 && ch <= 0x66) charType |= C1_XDIGIT;            // a-f
                if (ch === 0x20 || ch === 0x09) charType |= C1_SPACE | C1_BLANK; // Space, tab
                if (ch === 0x0A || ch === 0x0D) charType |= C1_SPACE;            // LF, CR
                if (ch < 0x20) charType |= C1_CNTRL;                             // Control chars
                if ((ch >= 0x21 && ch <= 0x2F) || (ch >= 0x3A && ch <= 0x40) ||
                    (ch >= 0x5B && ch <= 0x60) || (ch >= 0x7B && ch <= 0x7E)) {
                    charType |= C1_PUNCT; // Punctuation
                }
            } else {
                // For CT_CTYPE2 and CT_CTYPE3, return minimal info
                charType = 0;
            }

            view.setUint16(lpCharType + i * 2, charType, true);
        }

        return 1; // TRUE
    },

    // GetPrivateProfileSectionA - retrieves all key/value pairs from a section of an INI file
    'GetPrivateProfileSectionA': (ctx, mem, args) => {
        const lpAppName = args[0];        // LPCSTR - section name
        const lpReturnedString = args[1]; // LPSTR - buffer
        const nSize = args[2];            // DWORD - buffer size
        const lpFileName = args[3];       // LPCSTR - INI file name

        const appName = lpAppName ? Marshaler.readString(mem, lpAppName) : '';
        const fileName = lpFileName ? Marshaler.readString(mem, lpFileName) : '';

        Logger.verbose(LogCategory.KERNEL32,
            `GetPrivateProfileSectionA(section="${appName}", bufSize=${nSize}, file="${fileName}")`);

        if (!lpReturnedString || nSize < 2) {
            return 0;
        }

        // We don't parse INI files — return empty section (double-null terminated)
        mem[lpReturnedString] = 0;
        mem[lpReturnedString + 1] = 0;
        return 0;
    },

    // lstrcpynA - copies a string with length limit
    'lstrcpynA': (ctx, mem, args) => {
        const lpString1 = args[0];  // LPSTR - destination buffer
        const lpString2 = args[1];  // LPCSTR - source string
        const iMaxLength = args[2]; // int - maximum number of characters to copy

        if (!lpString1 || !lpString2 || iMaxLength <= 0) {
            return lpString1;
        }

        Logger.verbose(LogCategory.KERNEL32,
            `lstrcpynA(dest=0x${lpString1.toString(16)}, src=0x${lpString2.toString(16)}, maxLen=${iMaxLength})`);

        let i = 0;
        // Copy up to (iMaxLength - 1) characters
        while (i < iMaxLength - 1 && lpString2 + i < mem.length && lpString1 + i < mem.length) {
            const ch = mem[lpString2 + i];
            mem[lpString1 + i] = ch;
            if (ch === 0) {
                // Null terminator found
                return lpString1;
            }
            i++;
        }

        // Null terminate
        if (lpString1 + i < mem.length) {
            mem[lpString1 + i] = 0;
        }

        return lpString1;
    },

    // lstrcpynW - copies a wide string with a character limit
    // LPWSTR lstrcpynW(LPWSTR lpString1, LPCWSTR lpString2, int iMaxLength)
    // iMaxLength is in WCHARs (not bytes). Always null-terminates when iMaxLength > 0.
    'lstrcpynW': (ctx, mem, args) => {
        const lpString1 = args[0];  // LPWSTR - destination buffer
        const lpString2 = args[1];  // LPCWSTR - source string
        const iMaxLength = args[2]; // int - max WCHARs to write (including null terminator)

        if (!lpString1 || !lpString2 || iMaxLength <= 0) {
            return lpString1;
        }

        Logger.verbose(LogCategory.KERNEL32,
            `lstrcpynW(dest=0x${lpString1.toString(16)}, src=0x${lpString2.toString(16)}, maxLen=${iMaxLength})`);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let i = 0;
        // Copy up to (iMaxLength - 1) wide characters
        while (i < iMaxLength - 1 &&
               lpString2 + i * 2 + 1 < mem.length &&
               lpString1 + i * 2 + 1 < mem.length) {
            const ch = view.getUint16(lpString2 + i * 2, true);
            view.setUint16(lpString1 + i * 2, ch, true);
            if (ch === 0) {
                // Null terminator already written — done
                return lpString1;
            }
            i++;
        }

        // Always null-terminate
        if (lpString1 + i * 2 + 1 < mem.length) {
            view.setUint16(lpString1 + i * 2, 0, true);
        }

        return lpString1;
    },

    // GetStringTypeExW - retrieves character type information for a Unicode string
    // BOOL GetStringTypeExW(LCID Locale, DWORD dwInfoType, LPCWSTR lpSrcStr, int cchSrc, LPWORD lpCharType)
    //
    // This is a thin wrapper: it ignores Locale and delegates to GetStringTypeW with the
    // remaining four arguments unchanged. Windows itself implements it exactly this way —
    // the Locale parameter is documented as unused for the W variant.
    'GetStringTypeExW': (ctx, mem, args) => {
        const locale     = args[0]; // LCID   - ignored (Unicode classification is locale-independent)
        const dwInfoType = args[1]; // DWORD  - CT_CTYPE1 / CT_CTYPE2 / CT_CTYPE3
        const lpSrcStr   = args[2]; // LPCWSTR
        const cchSrc     = args[3]; // int    - character count, or -1 for null-terminated
        const lpCharType = args[4]; // LPWORD - output buffer

        Logger.verbose(LogCategory.KERNEL32,
            `GetStringTypeExW(locale=0x${locale.toString(16)}, infoType=${dwInfoType}, str=0x${lpSrcStr.toString(16)}, count=${cchSrc})`);

        if (lpSrcStr === 0 || lpCharType === 0) return 0;

        // Reuse the LUT-backed fast classification already built for GetStringTypeW.
        // cchSrc === -1 means null-terminated wide string.
        const count = (cchSrc === -1)
            ? Marshaler.readWideString(mem, lpSrcStr).length + 1  // +1 for terminator, matching GetStringTypeW contract
            : cchSrc;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        for (let i = 0; i < count; i++) {
            const addr = lpSrcStr + i * 2;
            if (addr + 1 >= mem.length) break;
            const charCode = view.getUint16(addr, true);
            let type = 0;

            if (dwInfoType === 1) { // CT_CTYPE1 — use the pre-built LUT for accuracy
                type = _ctype1LUT[charCode < 65536 ? charCode : 0];
            } else if (dwInfoType === 2) { // CT_CTYPE2 — bidirectional layout type
                // Minimal: left-to-right for standard Latin/ASCII, undefined (0) for others
                if (charCode >= 0x0041 && charCode <= 0x007A) type = 0x0001; // C2_LEFTTORIGHT
                else if (charCode >= 0x0030 && charCode <= 0x0039) type = 0x0003; // C2_EUROPENUMBER
                else if (charCode < 0x0020) type = 0x000B; // C2_OTHERNEUTRAL (control chars)
                else if (charCode === 0x0020) type = 0x000A; // C2_WHITESPACE
            } else if (dwInfoType === 4) { // CT_CTYPE3 — text processing
                // Minimal: mark known symbol/punctuation/alpha ranges
                if ((charCode >= 0x0041 && charCode <= 0x005A) ||
                    (charCode >= 0x0061 && charCode <= 0x007A) ||
                    (charCode >= 0x00C0 && charCode <= 0x00FF)) {
                    type = 0x8000; // C3_ALPHA
                }
            }

            const dstAddr = lpCharType + i * 2;
            if (dstAddr + 1 < mem.length) {
                view.setUint16(dstAddr, type, true);
            }
        }

        return 1; // TRUE
    },
};

// ============================================================================
// Pre-built fast-path caches (built once at module load time)
// ============================================================================

// CT_CTYPE1 LUT for all 65536 Unicode codepoints — avoids per-char branches in GetStringTypeW
const _ctype1LUT: Uint16Array = (() => {
    const t = new Uint16Array(65536);
    for (let c = 0; c < 65536; c++) {
        let v = 0;
        // ASCII block
        if (c >= 0x41 && c <= 0x5A) v |= 0x0101; // C1_UPPER | C1_ALPHA
        if (c >= 0x61 && c <= 0x7A) v |= 0x0102; // C1_LOWER | C1_ALPHA
        if (c >= 0x30 && c <= 0x39) v |= 0x0084; // C1_DIGIT | C1_XDIGIT
        if ((c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) v |= 0x0080; // C1_XDIGIT
        if (c === 0x20 || c === 0x09) v |= 0x0048; // C1_SPACE | C1_BLANK
        if (c >= 0x0A && c <= 0x0D) v |= 0x0008;  // C1_SPACE (LF/VT/FF/CR)
        if (c < 0x20 || c === 0x7F) v |= 0x0020;  // C1_CNTRL
        if ((c >= 0x21 && c <= 0x2F) || (c >= 0x3A && c <= 0x40) ||
            (c >= 0x5B && c <= 0x60) || (c >= 0x7B && c <= 0x7E)) v |= 0x0010; // C1_PUNCT
        // Latin-1 supplement (0xC0-0xFF)
        if ((c >= 0xC0 && c <= 0xD6) || (c >= 0xD8 && c <= 0xDE)) v |= 0x0101; // C1_UPPER
        if ((c >= 0xE0 && c <= 0xF6) || (c >= 0xF8 && c <= 0xFF) || c === 0xDF) v |= 0x0102; // C1_LOWER
        // Basic Multilingual Plane letter ranges
        if ((c >= 0x0100 && c <= 0x024F) || (c >= 0x0370 && c <= 0x03FF) ||
            (c >= 0x0400 && c <= 0x04FF)) v |= 0x0100; // C1_ALPHA (Latin Extended, Greek, Cyrillic)
        t[c] = v;
    }
    return t;
})();

/**
 * byte → UTF-16 table for a single-byte code page, cached per page.
 *
 * The fast path needs a table, not a decoder: a TextDecoder call per conversion allocates
 * a JS string (two, with the terminator concat) and that is the whole cost of the slow
 * path. Built from the decoder itself so a page's mapping has ONE definition. Null for any
 * multi-byte page (UTF-8, DBCS), which isSingleByteCodePage decides — a probe cannot, since
 * a decoder answers a lone lead byte with one U+FFFD.
 */
const _cpLutCache = new Map<number, Uint16Array | null>();

function codePageToUnicodeLut(codePage: number): Uint16Array | null {
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

/**
 * UTF-16 → byte table for a single-byte code page (0xffff = not representable on this page,
 * which is the caller's signal to take the slow path and its default-char rules). Derived
 * by inverting the same forward table, so the two cannot drift apart.
 */
const _cpRevLutCache = new Map<number, Uint16Array | null>();

function codePageToByteLut(codePage: number): Uint16Array | null {
    const cached = _cpRevLutCache.get(codePage);
    if (cached !== undefined) return cached;
    const forward = codePageToUnicodeLut(codePage);
    let rev: Uint16Array | null = null;
    if (forward) {
        rev = new Uint16Array(65536).fill(0xffff);
        // Ascending, so the LOWEST byte wins when a page maps two bytes to one code point —
        // matching the canonical encoding Windows picks.
        for (let b = 255; b >= 0; b--) rev[forward[b]!] = b;
    }
    _cpRevLutCache.set(codePage, rev);
    return rev;
}


/**
 * Simple 1:1 case-mapping tables for the BMP, derived from the same JS case mapping the
 * thunk uses so the two cannot disagree. A code point whose mapping is not one character
 * (Turkish dotted I, ligatures, ...) is left as 0xffff: the fast path declines the WHOLE
 * call there, because a length change is precisely what a table cannot express.
 */
const _caseLut: (Uint16Array | null)[] = [null, null];

function caseMapLut(upper: boolean): Uint16Array {
    const idx = upper ? 1 : 0;
    let lut = _caseLut[idx];
    if (lut) return lut;
    lut = new Uint16Array(65536);
    for (let c = 0; c < 65536; c++) {
        const ch = String.fromCharCode(c);
        const m = upper ? ch.toUpperCase() : ch.toLowerCase();
        lut[c] = m.length === 1 ? m.charCodeAt(0) : 0xffff;
    }
    // Surrogates map to themselves through String.prototype case mapping; keeping them
    // verbatim matches what the thunk's whole-string mapping does for an unpaired half.
    _caseLut[idx] = lut;
    return lut;
}

/** Why the MultiByteToWideChar fast path handed a call back to the full thunk. A thunk
 *  whose fast path silently never fires looks exactly like one that is inherently slow;
 *  these counters tell the two apart. Read via the `localeFastPath` harness verb. */
export const localeFastPathStats = {
    mbtwcFast: 0,
    mbtwcSlow: 0,
    /** Characters converted, and the length distribution. Cost per call is proportional to
     *  length, so "many short strings" (a per-call overhead problem, fixable only by moving
     *  the boundary) and "few long strings" (a loop problem, fixable by moving the loop into
     *  WASM) need opposite work — and a profiler's per-call average cannot tell them apart. */
    mbtwcChars: 0,
    mbtwcMaxChars: 0,
    /** Conversions whose destination could not hold the result. Win32 fails these with
     *  ERROR_INSUFFICIENT_BUFFER; a silently truncated string is a different program. */
    mbtwcTruncated: 0,
    /** Buckets: <=8, <=32, <=128, <=512, <=4096, more. */
    mbtwcLenHist: new Uint32Array(6),
    /** Return addresses seen at the fast path, counted. Armed on demand: a Map write per
     *  call is not something a hot path carries for free. */
    callerCensus: null as Map<number, number> | null,
    /** Full-thunk entries. mbtwcThunk - mbtwcSlow = calls that never reached the fast path. */
    mbtwcThunk: 0,
    /** Bail counts by reason. */
    mbtwcBail: { multiByteCodePage: 0, badRange: 0, negativeLength: 0 } as Record<string, number>,
    lastCodePage: 0,
    lcmapFast: 0,
    lcmapDeclined: 0,
    /** Flag words seen at LCMapStringW, counted — the fast path covers only plain
     *  lower/upper, and guessing which combination the CRT actually passes is how a fast
     *  path ends up never firing while looking implemented. */
    lcmapFlags: new Map<number, number>(),
    reset(): void {
        this.mbtwcFast = 0;
        this.mbtwcSlow = 0;
        this.mbtwcThunk = 0;
        this.mbtwcChars = 0;
        this.mbtwcMaxChars = 0;
        this.mbtwcTruncated = 0;
        this.mbtwcLenHist.fill(0);
        this.lcmapFast = 0;
        this.lcmapDeclined = 0;
        this.lcmapFlags.clear();
        this.callerCensus?.clear();
        for (const k of Object.keys(this.mbtwcBail)) this.mbtwcBail[k] = 0;
    },
};

// Pre-built UTF-16LE byte buffers for GetLocaleInfoW (keyed by cleanType)
// Built lazily on first call to registerFastPathLocaleFunctions so EmulatorConfig is ready.
let _localeWCache: Map<number, Uint8Array> | null = null;
let _localeWNumCache: Uint16Array | null = null; // RETURN_NUMBER values by cleanType (max type ~0x1011)
const LOCALE_CACHE_SIZE = 0x1100;

function ensureLocaleCache(): void {
    if (_localeWCache) return;
    _localeWCache = new Map();
    _localeWNumCache = new Uint16Array(LOCALE_CACHE_SIZE);
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
            _localeWNumCache[cleanType] = parseInt(value, 10) || 0;
        }
    }
}

// ============================================================================
// Fast path registrations for high-call-rate locale/string functions
// ============================================================================
export function registerFastPathLocaleFunctions(dispatcher: any): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    ensureLocaleCache();

    // -------------------------------------------------------------------------
    // GetLocaleInfoW — 850K calls/session (CRT reads ANSI CP, decimal sep, etc.)
    // Stack (stdcall @16): [esp+4]=locale [esp+8]=lcType [esp+12]=lpLCData [esp+16]=cchData
    // -------------------------------------------------------------------------
    dispatcher.registerFastPath('kernel32', 'GetLocaleInfoW', (cpu: any, rawMem8: Uint8Array, _m32: Uint32Array, dv: DataView): number | null => {
        // Leaf hot loop: index a PLAIN view, never v86's Proxy. The dispatcher must keep the
        // Proxy (it is how WASM growth is detected — see updateMemoryCache), so the unwrap
        // belongs here, once per call. Per-BYTE through the Proxy is ~13x slower, and these
        // paths walk tens of millions of bytes over a load.
        const mem8 = borrowGuestMemory(rawMem8);
        const esp = (cpu.reg32[4]) >>> 0;
        if (esp + 20 > mem8.length) return null;
        const view = dv ?? new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        const lcType   = view.getUint32(esp + 8, true);
        const lpLCData = view.getUint32(esp + 12, true);
        const cchData  = view.getInt32(esp + 16, true);

        const LOCALE_RETURN_NUMBER = 0x20000000;
        const returnNumber = (lcType & LOCALE_RETURN_NUMBER) !== 0;
        const cleanType = lcType & 0xFFFF;

        if (returnNumber) {
            if (cchData === 0) return 2;
            if (!lpLCData || lpLCData + 4 > mem8.length) return 0;
            const numVal = (cleanType < LOCALE_CACHE_SIZE) ? _localeWNumCache![cleanType] : 0;
            view.setUint32(lpLCData, numVal, true);
            return 2;
        }

        const cached = _localeWCache!.get(cleanType);
        if (cached === undefined) {
            // Unknown type: return empty string
            if (!lpLCData || cchData <= 0) return 0;
            if (lpLCData + 2 > mem8.length) return null;
            view.setUint16(lpLCData, 0, true);
            return 1;
        }

        const requiredChars = cached.length >>> 1; // WCHARs incl. null
        if (cchData === 0) return requiredChars;
        if (!lpLCData) return 0;

        const toWriteChars = Math.min(requiredChars, cchData);
        const toWriteBytes = toWriteChars << 1;
        if (lpLCData + toWriteBytes > mem8.length) return null;
        mem8.set(cached.subarray(0, toWriteBytes), lpLCData);
        return toWriteChars;
    }, { trivial: true });

    // -------------------------------------------------------------------------
    // GetLocaleInfoA — same as W but writes ANSI bytes
    // Stack (stdcall @16): [esp+4]=locale [esp+8]=lcType [esp+12]=lpLCData [esp+16]=cchData
    // -------------------------------------------------------------------------
    dispatcher.registerFastPath('kernel32', 'GetLocaleInfoA', (cpu: any, rawMem8: Uint8Array, _m32: Uint32Array, dv: DataView): number | null => {
        // Leaf hot loop: index a PLAIN view, never v86's Proxy. The dispatcher must keep the
        // Proxy (it is how WASM growth is detected — see updateMemoryCache), so the unwrap
        // belongs here, once per call. Per-BYTE through the Proxy is ~13x slower, and these
        // paths walk tens of millions of bytes over a load.
        const mem8 = borrowGuestMemory(rawMem8);
        const esp = (cpu.reg32[4]) >>> 0;
        if (esp + 20 > mem8.length) return null;
        const view = dv ?? new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        const lcType   = view.getUint32(esp + 8, true);
        const lpLCData = view.getUint32(esp + 12, true);
        const cchData  = view.getInt32(esp + 16, true);

        const LOCALE_RETURN_NUMBER = 0x20000000;
        const returnNumber = (lcType & LOCALE_RETURN_NUMBER) !== 0;
        const cleanType = lcType & 0xFFFF;

        if (returnNumber) {
            if (cchData === 0) return 4;
            if (!lpLCData || lpLCData + 4 > mem8.length) return 0;
            const numVal = (cleanType < LOCALE_CACHE_SIZE) ? _localeWNumCache![cleanType] : 0;
            view.setUint32(lpLCData, numVal, true);
            return 4;
        }

        const cached = _localeWCache!.get(cleanType);
        if (cached === undefined) {
            if (!lpLCData || cchData <= 0) return 0;
            if (lpLCData >= mem8.length) return null;
            mem8[lpLCData] = 0;
            return 1;
        }

        // Reuse cached UTF-16LE buffer — every char is ASCII so low byte = ANSI char
        const strLen = (cached.length >>> 1) - 1; // excludes null
        const required = strLen + 1;
        if (cchData === 0) return required;
        if (!lpLCData) return 0;

        const toWrite = Math.min(required, cchData);
        if (lpLCData + toWrite > mem8.length) return null;
        for (let i = 0; i < toWrite - 1; i++) mem8[lpLCData + i] = cached[i * 2]; // low byte = ANSI
        mem8[lpLCData + toWrite - 1] = 0;
        return toWrite;
    }, { trivial: true });

    // -------------------------------------------------------------------------
    // GetStringTypeW — 11K calls/session (CRT char classification)
    // Stack (stdcall @12): [esp+4]=dwInfoType [esp+8]=lpSrcStr [esp+12]=cchSrc [esp+16]=lpCharType
    // Note: 4 args = stdcall @16
    // -------------------------------------------------------------------------
    dispatcher.registerFastPath('kernel32', 'GetStringTypeW', (cpu: any, rawMem8: Uint8Array, _m32: Uint32Array, dv: DataView): number | null => {
        // Leaf hot loop: index a PLAIN view, never v86's Proxy. The dispatcher must keep the
        // Proxy (it is how WASM growth is detected — see updateMemoryCache), so the unwrap
        // belongs here, once per call. Per-BYTE through the Proxy is ~13x slower, and these
        // paths walk tens of millions of bytes over a load.
        const mem8 = borrowGuestMemory(rawMem8);
        const esp = (cpu.reg32[4]) >>> 0;
        if (esp + 20 > mem8.length) return null;
        const view = dv ?? new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        const dwInfoType = view.getUint32(esp + 4, true);
        const lpSrcStr   = view.getUint32(esp + 8, true);
        const cchSrc     = view.getInt32(esp + 12, true);
        const lpCharType = view.getUint32(esp + 16, true);

        if (!lpSrcStr || !lpCharType) return 0;
        // Only fast-path CT_CTYPE1 (most common); other types fall to slow path
        if (dwInfoType !== 1) return null;

        // Determine count
        let count: number;
        if (cchSrc === -1) {
            count = 0;
            while (lpSrcStr + count * 2 + 1 < mem8.length && view.getUint16(lpSrcStr + count * 2, true) !== 0) count++;
            count++; // include null terminator
        } else {
            count = cchSrc;
        }

        if (lpCharType + count * 2 > mem8.length || lpSrcStr + count * 2 > mem8.length) return null;

        for (let i = 0; i < count; i++) {
            const ch = view.getUint16(lpSrcStr + i * 2, true);
            view.setUint16(lpCharType + i * 2, _ctype1LUT[ch < 65536 ? ch : 0], true);
        }
        return 1; // TRUE
    }, { trivial: true });


    // -------------------------------------------------------------------------
    // LCMapStringW — the middle of the CRT's __crtLCMapStringA sandwich (A->W, map, W->A).
    // Only plain LCMAP_LOWERCASE / LCMAP_UPPERCASE, only where every character maps 1:1;
    // sort keys, normalisation and anything else go to the thunk.
    // -------------------------------------------------------------------------
    dispatcher.registerFastPath('kernel32', 'LCMapStringW', (cpu: any, rawMem8: Uint8Array, _m32: Uint32Array, dv: DataView): number | null => {
        const mem8 = borrowGuestMemory(rawMem8);
        const esp = (cpu.reg32[4]) >>> 0;
        if (esp + 28 > mem8.length) return null;
        const view = dv ?? new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        const dwMapFlags = view.getUint32(esp + 8, true);
        const lpSrcStr = view.getUint32(esp + 12, true);
        const cchSrc = view.getInt32(esp + 16, true);
        const lpDestStr = view.getUint32(esp + 20, true);
        const cchDest = view.getInt32(esp + 24, true);

        if (!lpSrcStr) return 0;
        localeFastPathStats.lcmapFlags.set(dwMapFlags, (localeFastPathStats.lcmapFlags.get(dwMapFlags) ?? 0) + 1);
        const LCMAP_LOWERCASE = 0x100, LCMAP_UPPERCASE = 0x200;
        if (dwMapFlags !== LCMAP_LOWERCASE && dwMapFlags !== LCMAP_UPPERCASE) { localeFastPathStats.lcmapDeclined++; return null; }
        if (cchSrc < -1 || cchDest < 0) return null;

        let srcLen: number;
        if (cchSrc === -1) {
            srcLen = 0;
            while (lpSrcStr + srcLen * 2 + 1 < mem8.length && view.getUint16(lpSrcStr + srcLen * 2, true) !== 0) srcLen++;
        } else {
            srcLen = Math.min(cchSrc, ((mem8.length - lpSrcStr) / 2) | 0);
        }
        if (lpSrcStr + srcLen * 2 > mem8.length) return null;

        const lut = caseMapLut(dwMapFlags === LCMAP_UPPERCASE);
        // Verify before writing: one non-1:1 character and the thunk owns the call.
        for (let i = 0; i < srcLen; i++) {
            if (lut[view.getUint16(lpSrcStr + i * 2, true)] === 0xffff) return null;
        }

        // Mirrors the thunk exactly, including writeWideString reserving a terminator slot.
        if (cchDest === 0) return srcLen + (cchSrc === -1 ? 1 : 0);
        if (lpDestStr <= 0 || lpDestStr >= mem8.length) return 0;
        const toWrite = Math.min(srcLen, cchDest - 1);
        if (toWrite < 0 || lpDestStr + (toWrite + 1) * 2 > mem8.length) return null;
        for (let i = 0; i < toWrite; i++) {
            view.setUint16(lpDestStr + i * 2, lut[view.getUint16(lpSrcStr + i * 2, true)]!, true);
        }
        view.setUint16(lpDestStr + toWrite * 2, 0, true);
        localeFastPathStats.lcmapFast++;
        return toWrite + 1;
    }, { trivial: true });

    // -------------------------------------------------------------------------
    // MultiByteToWideChar — 226K calls/session
    // Stack (stdcall @24): [+4]=CodePage [+8]=dwFlags [+12]=lpMB [+16]=cbMB [+20]=lpWC [+24]=cchWC
    // Fast path covers CP_ACP/CP_OEMCP/1252 with cbMB=-1 (null-terminated) or positive length.
    // -------------------------------------------------------------------------
    dispatcher.registerFastPath('kernel32', 'MultiByteToWideChar', (cpu: any, rawMem8: Uint8Array, _m32: Uint32Array, dv: DataView): number | null => {
        // Leaf hot loop: index a PLAIN view, never v86's Proxy. The dispatcher must keep the
        // Proxy (it is how WASM growth is detected — see updateMemoryCache), so the unwrap
        // belongs here, once per call. Per-BYTE through the Proxy is ~13x slower, and these
        // paths walk tens of millions of bytes over a load.
        const mem8 = borrowGuestMemory(rawMem8);
        const esp = (cpu.reg32[4]) >>> 0;
        if (esp + 28 > mem8.length) return null;
        const view = dv ?? new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        const codePage  = view.getUint32(esp + 4, true);
        // dwFlags at esp+8 — we don't act on them in fast path
        const lpMB      = view.getUint32(esp + 12, true);
        const cbMB      = view.getInt32(esp + 16, true);
        const lpWC      = view.getUint32(esp + 20, true);
        const cchWC     = view.getInt32(esp + 24, true);

        if (!lpMB) return 0;

        // Any single-byte code page is a 256-entry table (built once from that page's own
        // decoder); UTF-8 keeps its ASCII-subset path below. Naming individual pages here
        // is what left every non-Western title on the allocating slow path.
        const config = EmulatorConfig.getInstance();
        const effectiveCp = codePage === 0 ? config.ansiCodePage
                          : codePage === 1 ? config.oemCodePage
                          : codePage;
        localeFastPathStats.lastCodePage = effectiveCp;
        const cpLut = effectiveCp === 65001 ? null : codePageToUnicodeLut(effectiveCp);
        if (!cpLut && effectiveCp !== 65001) {
            localeFastPathStats.mbtwcBail.multiByteCodePage++;
            localeFastPathStats.mbtwcSlow++;
            return null;
        }

        // Determine byte count
        let byteLen: number;
        const includeNull = cbMB === -1;
        if (includeNull) {
            byteLen = 0;
            while (lpMB + byteLen < mem8.length && mem8[lpMB + byteLen] !== 0) byteLen++;
            byteLen++; // include null
        } else {
            if (cbMB < 0) { localeFastPathStats.mbtwcBail.negativeLength++; localeFastPathStats.mbtwcSlow++; return null; }
            byteLen = Math.min(cbMB, mem8.length - lpMB);
        }

        const outLen = byteLen; // for single-byte CPs, 1 byte → 1 wchar
        if (cchWC === 0) { localeFastPathStats.mbtwcFast++; return outLen; }
        if (!lpWC) return 0;

        if (outLen > cchWC) { localeFastPathStats.mbtwcTruncated++; }
        const toWrite = Math.min(outLen, cchWC);
        if (lpWC + toWrite * 2 > mem8.length) {
            localeFastPathStats.mbtwcBail.badRange++; localeFastPathStats.mbtwcSlow++; return null;
        }

        if (cpLut) {
            for (let i = 0; i < toWrite; i++) {
                view.setUint16(lpWC + i * 2, cpLut[mem8[lpMB + i]!]!, true);
            }
        } else {
            // UTF-8: only fast-path pure ASCII subset
            for (let i = 0; i < toWrite; i++) {
                const b = mem8[lpMB + i]!;
                if (b >= 0x80) { localeFastPathStats.mbtwcSlow++; return null; } // non-ASCII, fall to slow path
                view.setUint16(lpWC + i * 2, b, true);
            }
        }
        localeFastPathStats.mbtwcFast++;
        localeFastPathStats.mbtwcChars += toWrite;
        if (toWrite > localeFastPathStats.mbtwcMaxChars) localeFastPathStats.mbtwcMaxChars = toWrite;
        localeFastPathStats.mbtwcLenHist[
            toWrite <= 8 ? 0 : toWrite <= 32 ? 1 : toWrite <= 128 ? 2 : toWrite <= 512 ? 3 : toWrite <= 4096 ? 4 : 5
        ]!++;
        const census = localeFastPathStats.callerCensus;
        if (census !== null) {
            const ret = view.getUint32(esp, true);
            census.set(ret, (census.get(ret) ?? 0) + 1);
        }
        return toWrite;
    }, { trivial: true });

    // -------------------------------------------------------------------------
    // WideCharToMultiByte — 209K calls/session
    // Stack (stdcall @32): [+4]=CP [+8]=flags [+12]=lpWC [+16]=cchWC [+20]=lpMB [+24]=cbMB
    //                       [+28]=lpDefaultChar [+32]=lpUsedDefaultChar
    // Fast path: ASCII-only strings (all codepoints < 0x80), CP1252/OEMCP/ACP.
    // -------------------------------------------------------------------------
    dispatcher.registerFastPath('kernel32', 'WideCharToMultiByte', (cpu: any, rawMem8: Uint8Array, _m32: Uint32Array, dv: DataView): number | null => {
        // The slow path stays the source of truth for null-termination and code-page
        // semantics: this handles ONLY the plainly-representable case and hands back
        // anything else — a default char, a flag, or a code point the page cannot encode —
        // so it can never be the one that decides a subtle case.
        const mem8 = borrowGuestMemory(rawMem8);
        const esp = (cpu.reg32[4]) >>> 0;
        if (esp + 36 > mem8.length) return null;
        const view = dv ?? new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        const codePage = view.getUint32(esp + 4, true);
        const dwFlags = view.getUint32(esp + 8, true);
        const lpWC = view.getUint32(esp + 12, true);
        const cchWC = view.getInt32(esp + 16, true);
        const lpMB = view.getUint32(esp + 20, true);
        const cbMB = view.getInt32(esp + 24, true);
        const lpDefaultChar = view.getUint32(esp + 28, true);
        const lpUsedDefaultChar = view.getUint32(esp + 32, true);

        if (!lpWC) return 0;
        if (dwFlags !== 0 || lpDefaultChar !== 0 || lpUsedDefaultChar !== 0) return null;
        if (cbMB < 0 || (cchWC < 0 && cchWC !== -1)) return null;

        const config = EmulatorConfig.getInstance();
        const effectiveCp = codePage === 0 ? config.ansiCodePage
                          : codePage === 1 ? config.oemCodePage
                          : codePage;
        const rev = codePageToByteLut(effectiveCp);
        if (!rev) return null;

        // Source length in wchars, including the terminator when the guest passed -1.
        let count: number;
        if (cchWC === -1) {
            count = 0;
            while (lpWC + count * 2 + 1 < mem8.length && view.getUint16(lpWC + count * 2, true) !== 0) count++;
            count++; // the terminator is part of the conversion
        } else {
            count = cchWC;
        }
        if (lpWC + count * 2 > mem8.length) return null;

        // Every code point must be representable, or the default-char rules apply and this
        // is not our case. Checked before writing anything.
        for (let i = 0; i < count; i++) {
            if (rev[view.getUint16(lpWC + i * 2, true)] === 0xffff) return null;
        }
        if (cbMB === 0) return count;   // size query: single-byte page ⇒ one byte per wchar

        const toWrite = Math.min(count, cbMB);
        if (!lpMB || lpMB + toWrite > mem8.length) return null;
        for (let i = 0; i < toWrite; i++) {
            mem8[lpMB + i] = rev[view.getUint16(lpWC + i * 2, true)]!;
        }
        return toWrite;
    }, { trivial: true });
}
