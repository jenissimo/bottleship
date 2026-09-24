/**
 * kernel32 locale-name APIs, the date/time formatters, and the DLL search order.
 *
 * Expected values are real-Windows answers (Wine's conformance tests pin most of them):
 * the neutral -> specific resolutions, ResolveLocaleName's prefix walk, the picture
 * strings, and the TIME_NOSECONDS separator elision. Locale data is the compiled database
 * (locale-db.generated.ts), so the per-locale strings are CLDR's as Wine compiles them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import {
    LOCALE_ALLOW_NEUTRAL_NAMES,
    LOCALE_ALTERNATE_SORTS,
    LOCALE_NEUTRALDATA,
    LOCALE_SPECIFICDATA,
    LOCALE_WINDOWS,
    enumSystemLcids,
    enumSystemLocalesEx,
    findLocaleByLcid,
    findLocaleByName,
    installedLocaleLcids,
    isValidLocaleName,
    localeFromLcid,
    localeFromName,
    localeNameToLcid,
    resolveLocaleName,
} from "../../src/worker/modules/kernel32/locale-names";
import { nameEntryCount, nameEntryId } from "../../src/worker/modules/kernel32/locale-db";
import {
    DATE_LONGDATE,
    DATE_SHORTDATE,
    DATE_YEARMONTH,
    ERROR_INVALID_FLAGS,
    ERROR_INVALID_PARAMETER,
    TIME_FORCE24HOURFORMAT,
    TIME_NOMINUTESORSECONDS,
    TIME_NOSECONDS,
    TIME_NOTIMEMARKER,
    formatDate,
    formatTime,
    type SystemTimeFields,
} from "../../src/worker/modules/kernel32/locale-format";
import { exports as localeEx } from "../../src/worker/modules/kernel32/locale-ex";
import { exports as localeExports } from "../../src/worker/modules/kernel32/locale";
import {
    LOAD_LIBRARY_SEARCH_APPLICATION_DIR,
    LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    LOAD_LIBRARY_SEARCH_SYSTEM32,
    LOAD_LIBRARY_SEARCH_USER_DIRS,
    LOAD_WITH_ALTERED_SEARCH_PATH,
    BASE_SEARCH_PATH_DISABLE_SAFE_SEARCHMODE,
    BASE_SEARCH_PATH_ENABLE_SAFE_SEARCHMODE,
    BASE_SEARCH_PATH_PERMANENT,
    addDllDirectory,
    dllSearchDirectories,
    removeDllDirectory,
    resetDllSearchState,
    searchPathSafeMode,
    setDefaultDllDirectories,
    setDllDirectory,
    setSearchPathMode,
    validLoadLibrarySearchFlags,
} from "../../src/worker/core/dll-search-order";

// Tuesday 2009-03-10 14:05:09.250 — the caller's wDayOfWeek deliberately wrong.
const ST: SystemTimeFields = {
    year: 2009, month: 3, dayOfWeek: 6, day: 10, hour: 14, minute: 5, second: 9, milliseconds: 250,
};

/** Run `body` with the manifest LCID set to `lcid`. */
function withLcid<T>(lcid: number, body: () => T): T {
    const cfg = EmulatorConfig.getInstance();
    const saved = cfg.lcid;
    cfg.lcid = lcid;
    try { return body(); } finally { cfg.lcid = saved; }
}

describe("locale identity", () => {
    test("specific names map both ways", () => {
        for (const [name, lcid] of [["en-US", 0x0409], ["ru-RU", 0x0419], ["de-DE", 0x0407],
            ["ja-JP", 0x0411], ["zh-CN", 0x0804], ["pt-BR", 0x0416], ["sr-Latn-RS", 0x241a]] as const) {
            expect(findLocaleByName(name)!.lcid).toBe(lcid);
            expect(findLocaleByLcid(lcid)!.name).toBe(name);
        }
    });

    test("names match case-insensitively and '_' equals '-'", () => {
        expect(findLocaleByName("EN-us")!.lcid).toBe(0x0409);
        expect(findLocaleByName("en_US")!.lcid).toBe(0x0409);
        expect(findLocaleByName("de-de_PHONEB")!.lcid).toBe(0x10407);
    });

    test("a neutral names its default specific locale", () => {
        expect(findLocaleByName("en")!.specific.name).toBe("en-US");
        expect(findLocaleByName("zh-Hant")!.specific.name).toBe("zh-HK");
        expect(findLocaleByName("sr")!.specific.name).toBe("sr-Latn-RS");
    });
});

describe("installed locales: every locale the database holds", () => {
    test("a locale other than en-US and the manifest's is installed", () => {
        withLcid(0x0409, () => {
            expect(isValidLocaleName("af-ZA")).toBe(true);
            expect(localeFromLcid(0x0436)!.name).toBe("af-ZA");
            expect(localeNameToLcid("af-ZA", 0)).toBe(0x0436);
            expect(enumSystemLcids(0)).toContain("00000436");
            expect(enumSystemLocalesEx(0).some((e) => e.name === "af-ZA")).toBe(true);
            expect(installedLocaleLcids()).toContain(0x0436);
            expect(installedLocaleLcids().length).toBeGreaterThan(400);
            // Nothing is invented: an LCID and a name the database lacks stay invalid.
            expect(localeFromLcid(0x0abc)).toBeUndefined();
            expect(isValidLocaleName("xx-YY")).toBe(false);
        });
    });

    test("defaults resolve to the manifest LCID", () => {
        withLcid(0x0419, () => {
            expect(isValidLocaleName("en-US")).toBe(true);
            expect(isValidLocaleName("RU-ru")).toBe(true);
            expect(localeFromLcid(0x0400)!.name).toBe("ru-RU");
            expect(localeFromLcid(0x0800)!.name).toBe("ru-RU");
            expect(localeFromLcid(0)!.name).toBe("ru-RU");
            expect(localeFromName(null)!.name).toBe("ru-RU");
            expect(localeFromName("!X-SYS-DEFAULT-LOCALE")!.name).toBe("ru-RU");
            expect(localeFromLcid(0x007f)!.name).toBe("");
            expect(localeNameToLcid("", 0)).toBe(0x007f);
        });
    });

    test("neutrals answer their default language unless neutral names are allowed", () => {
        expect(localeNameToLcid("en", 0)).toBe(0x0409);
        expect(localeNameToLcid("en", LOCALE_ALLOW_NEUTRAL_NAMES)).toBe(0x0009);
        expect(localeFromLcid(0x0009)!.name).toBe("en-US");
        expect(localeFromLcid(0x0009, LOCALE_ALLOW_NEUTRAL_NAMES)!.name).toBe("en");
        expect(localeNameToLcid("de", 0)).toBe(0x0407);
        // Wine's conformance test: zh-Hant is 0x7c04, but LocaleNameToLCID answers zh-HK's.
        expect(localeNameToLcid("zh-Hant", 0)).toBe(0x0c04);
        expect(localeFromLcid(0x7c04)!.name).toBe("zh-HK");
    });

    test("a locale with no LCID of its own answers LOCALE_CUSTOM_UNSPECIFIED; aliases name their locale", () => {
        expect(isValidLocaleName("aa-DJ")).toBe(true);
        expect(localeNameToLcid("aa-DJ", 0)).toBe(0x1000);
        expect(localeNameToLcid("de-DE_phoneb", 0)).toBe(0x10407);
        expect(localeNameToLcid("de-DE-u-co-phonebk", 0)).toBe(0x10407);
        expect(localeFromName("de-DE-u-co-phonebk")!.name).toBe("de-DE_phoneb");
    });

    test("ResolveLocaleName walks back to the longest prefix that is a locale", () => {
        const cases: Array<[string, string | undefined]> = [
            ["en-US", "en-US"], ["en", "en-US"], ["en-RR", "en-US"], ["EN-zz", "en-US"],
            ["en-GB", "en-GB"], ["de-DE_phoneb", "de-DE"], ["DE-de-phoneb", "de-DE"], ["fr-CHXX", "fr-FR"],
            ["zh", "zh-CN"], ["zz", ""], ["zzz-ZZZ", ""], ["", ""], ["zz+XX", undefined], ["zz.XX", undefined],
        ];
        for (const [name, want] of cases) expect([name, resolveLocaleName(name)]).toEqual([name, want]);
    });

    test("EnumSystemLocales*: every name and LCID in the database, flagged", () => {
        const all = enumSystemLocalesEx(0);
        // Every non-alias entry of the name index, in its order.
        let names = 0;
        for (let i = 0; i < nameEntryCount(); i++) if (!(nameEntryId(i) & 0x80000000)) names++;
        expect(all.length).toBe(names);
        expect(all.length).toBeGreaterThan(900);
        expect(all[0]).toEqual({ name: "", flags: LOCALE_WINDOWS | LOCALE_SPECIFICDATA });
        expect(all).toContainEqual({ name: "en", flags: LOCALE_WINDOWS | LOCALE_NEUTRALDATA });
        expect(all).toContainEqual({ name: "ru-RU", flags: LOCALE_WINDOWS | LOCALE_SPECIFICDATA });
        expect(all).toContainEqual({ name: "de-DE_phoneb", flags: LOCALE_ALTERNATE_SORTS });
        expect(all.some((e) => e.name === "de-DE-u-co-phonebk")).toBe(false);
        expect(enumSystemLocalesEx(LOCALE_NEUTRALDATA).every((e) => e.flags & LOCALE_NEUTRALDATA)).toBe(true);

        const lcids = enumSystemLcids(0);
        expect(lcids).toContain("00000409");
        expect(lcids).toContain("00000419");
        expect(lcids).toContain("00000411");
        for (const absent of ["0000007f", "00000009", "00001000", "00010407"]) expect(lcids).not.toContain(absent);
        expect(enumSystemLcids(4)).toContain("00010407");
        expect(enumSystemLcids(4)).not.toContain("00000409");
    });
});

describe("GetDateFormat / GetTimeFormat", () => {
    const text = (r: ReturnType<typeof formatDate>) => (r.ok ? r.text : `error ${r.error}`);
    const EN = () => localeFromLcid(0x0409)!;

    test("default pictures of the locale", () => {
        expect(text(formatDate(EN(), 0, ST, null))).toBe("3/10/2009");
        expect(text(formatDate(EN(), DATE_SHORTDATE, ST, null))).toBe("3/10/2009");
        expect(text(formatDate(EN(), DATE_LONGDATE, ST, null))).toBe("Tuesday, March 10, 2009");
        expect(text(formatDate(EN(), DATE_YEARMONTH, ST, null))).toBe("March 2009");
        expect(text(formatTime(EN(), 0, ST, null))).toBe("2:05:09 PM");
    });

    test("each locale formats with its own pictures and names", () => {
        const ru = localeFromLcid(0x0419)!;
        // The month takes its genitive form after a day number, and only there.
        expect(text(formatDate(ru, DATE_LONGDATE, ST, null))).toBe("вторник, 10 марта 2009 г.");
        expect(text(formatDate(ru, DATE_YEARMONTH, ST, null))).toBe("март 2009 г.");
        expect(text(formatDate(ru, DATE_SHORTDATE, ST, null))).toBe("10.03.2009");
        expect(text(formatTime(ru, 0, ST, null))).toBe("14:05:09");
        expect(text(formatDate(localeFromLcid(0x0407)!, DATE_SHORTDATE, ST, null))).toBe("10.3.2009");
        const ja = localeFromLcid(0x0411)!;
        expect(text(formatDate(ja, DATE_LONGDATE, ST, null))).toBe("2009年3月10日火曜日");
        expect(text(formatTime(ja, 0, ST, "tt h:mm"))).toBe("午後 2:05");
    });

    test("explicit pictures, quoting and the day-of-week recomputation", () => {
        expect(text(formatDate(EN(), 0, ST, "dd'.'MM'.'yy ddd MMM"))).toBe("10.03.09 Tue Mar");
        expect(text(formatDate(EN(), 0, ST, "'Today is' dddd"))).toBe("Today is Tuesday");
        // The era is the database's CAL_SERASTRING (CLDR "AD").
        expect(text(formatDate(EN(), 0, ST, "yyyy-M-d g"))).toBe("2009-3-10 AD");
        expect(text(formatTime(EN(), 0, ST, "HH:mm:ss"))).toBe("14:05:09");
        expect(text(formatTime(EN(), 0, ST, "h t"))).toBe("2 P");
    });

    test("time flags elide the field together with its separator", () => {
        expect(text(formatTime(EN(), TIME_NOSECONDS, ST, null))).toBe("2:05 PM");
        expect(text(formatTime(EN(), TIME_NOMINUTESORSECONDS, ST, null))).toBe("2 PM");
        expect(text(formatTime(EN(), TIME_NOTIMEMARKER, ST, null))).toBe("2:05:09");
        expect(text(formatTime(EN(), TIME_FORCE24HOURFORMAT, ST, null))).toBe("14:05:09 PM");
    });

    test("invalid input and flag combinations fail with Windows' errors", () => {
        expect(formatDate(EN(), 0, { ...ST, day: 31, month: 4 }, null)).toEqual({ ok: false, error: ERROR_INVALID_PARAMETER });
        expect(formatDate(EN(), 0, { ...ST, year: 1600 }, null)).toEqual({ ok: false, error: ERROR_INVALID_PARAMETER });
        expect(formatDate(EN(), DATE_SHORTDATE | DATE_LONGDATE, ST, null)).toEqual({ ok: false, error: ERROR_INVALID_FLAGS });
        expect(formatDate(EN(), DATE_SHORTDATE, ST, "yyyy")).toEqual({ ok: false, error: ERROR_INVALID_FLAGS });
        expect(formatTime(EN(), 0, { ...ST, hour: 24 }, null)).toEqual({ ok: false, error: ERROR_INVALID_PARAMETER });
        // Time formatting ignores the date half entirely.
        expect(text(formatTime(EN(), 0, { ...ST, month: 13 }, "H"))).toBe("14");
    });
});

describe("kernel32 handlers over guest memory", () => {
    let mem: Uint8Array;
    let err = 0;
    const scheduler = System.getInstance().scheduler as unknown as { setLastError(c: number): void };
    const original = scheduler.setLastError;
    const ctx = { esp: 0x8000 } as never;

    const putW = (addr: number, s: string) => {
        for (let i = 0; i < s.length; i++) { mem[addr + i * 2] = s.charCodeAt(i) & 0xff; mem[addr + i * 2 + 1] = s.charCodeAt(i) >> 8; }
        mem[addr + s.length * 2] = 0; mem[addr + s.length * 2 + 1] = 0;
    };
    const getW = (addr: number) => {
        let s = "";
        for (let a = addr; mem[a] || mem[a + 1]; a += 2) s += String.fromCharCode(mem[a]! | (mem[a + 1]! << 8));
        return s;
    };
    const putSt = (addr: number, st: SystemTimeFields) => {
        const v = new DataView(mem.buffer);
        [st.year, st.month, st.dayOfWeek, st.day, st.hour, st.minute, st.second, st.milliseconds]
            .forEach((x, i) => v.setUint16(addr + i * 2, x, true));
    };
    const call = (table: Record<string, unknown>, name: string, args: number[]) =>
        (table[name] as (c: unknown, m: Uint8Array, a: number[]) => number)(ctx, mem, args);

    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        Mem.bind(() => mem);
        err = 0;
        scheduler.setLastError = (c: number) => { err = c; };
    });
    afterEach(() => { scheduler.setLastError = original; });

    test("GetDateFormatEx / GetTimeFormatEx format a fixed SYSTEMTIME", () => {
        putW(0x100, "en-US"); putSt(0x200, ST); putW(0x300, "dddd d MMMM yyyy");
        expect(call(localeEx, "GetDateFormatEx", [0x100, 0, 0x200, 0x300, 0x1000, 64, 0])).toBe(22);
        expect(getW(0x1000)).toBe("Tuesday 10 March 2009");
        expect(call(localeEx, "GetTimeFormatEx", [0x100, TIME_NOSECONDS, 0x200, 0, 0x2000, 64])).toBe(8);
        expect(getW(0x2000)).toBe("2:05 PM");
        // Size query, then a short buffer: truncated copy, ERROR_INSUFFICIENT_BUFFER.
        expect(call(localeEx, "GetTimeFormatEx", [0x100, 0, 0x200, 0, 0, 0])).toBe(11);
        expect(call(localeEx, "GetTimeFormatEx", [0x100, 0, 0x200, 0, 0x3000, 4])).toBe(0);
        expect(err).toBe(122);
        expect(getW(0x3000)).toBe("2:0");
        // Unknown locale name, and a calendar argument.
        putW(0x400, "xx-YY");
        expect(call(localeEx, "GetDateFormatEx", [0x400, 0, 0x200, 0, 0x1000, 64, 0])).toBe(0);
        expect(err).toBe(87);
        expect(call(localeEx, "GetDateFormatEx", [0x100, 0, 0x200, 0, 0x1000, 64, 0x100])).toBe(0);
    });

    test("GetDateFormatA counts bytes and shares the formatter with W", () => {
        putSt(0x200, ST);
        const pic = "yyyy'-'MM'-'dd";
        for (let i = 0; i < pic.length; i++) mem[0x300 + i] = pic.charCodeAt(i);
        expect(call(localeEx, "GetDateFormatA", [0x0409, 0, 0x200, 0x300, 0x1000, 64])).toBe(11);
        expect(new TextDecoder().decode(mem.subarray(0x1000, 0x100a))).toBe("2009-03-10");
        expect(call(localeEx, "GetDateFormatW", [0x0400, 0, 0x200, 0, 0x2000, 64])).toBe(10);
        expect(getW(0x2000)).toBe("3/10/2009");
        expect(call(localeEx, "GetDateFormatW", [0x0abc, 0, 0x200, 0, 0x2000, 64])).toBe(0);
        expect(err).toBe(87);
    });

    test("IsValidLocaleName / LocaleNameToLCID / LCIDToLocaleName / IsValidLocale", () => {
        putW(0x100, "en-US"); putW(0x200, "xx-YY"); putW(0x300, "!x-sys-default-locale"); putW(0x400, "af-ZA");
        expect(call(localeEx, "IsValidLocaleName", [0x100])).toBe(1);
        expect(call(localeEx, "IsValidLocaleName", [0x400])).toBe(1);
        expect(call(localeEx, "IsValidLocaleName", [0x200])).toBe(0);
        expect(call(localeEx, "IsValidLocaleName", [0])).toBe(0);
        expect(call(localeEx, "IsValidLocaleName", [0x300])).toBe(0);
        expect(call(localeEx, "LocaleNameToLCID", [0x100, 0])).toBe(0x0409);
        expect(call(localeEx, "LocaleNameToLCID", [0x400, 0])).toBe(0x0436);
        expect(call(localeEx, "LocaleNameToLCID", [0x200, 0])).toBe(0);
        expect(err).toBe(87);
        expect(call(localeEx, "LCIDToLocaleName", [0x0409, 0, 0, 0])).toBe(6);
        expect(call(localeEx, "LCIDToLocaleName", [0x0409, 0x1000, 3, 0])).toBe(0);
        expect(err).toBe(122);
        expect(call(localeEx, "LCIDToLocaleName", [0x0409, 0x1000, 85, 0])).toBe(6);
        expect(getW(0x1000)).toBe("en-US");
        expect(call(localeEx, "LCIDToLocaleName", [0x0436, 0x1000, 85, 0])).toBe(6);
        expect(getW(0x1000)).toBe("af-ZA");
        expect(call(localeEx, "LCIDToLocaleName", [0x10407, 0x1000, 85, 0])).toBe(13);
        expect(getW(0x1000)).toBe("de-DE_phoneb");
        err = 0;
        expect(call(localeEx, "LCIDToLocaleName", [0x0abc, 0x1000, 85, 0])).toBe(0);
        expect(err).toBe(87);
        expect(call(localeExports, "IsValidLocale", [0x0409, 2])).toBe(1);
        expect(call(localeExports, "IsValidLocale", [0x0436, 2])).toBe(1);
        expect(call(localeExports, "IsValidLocale", [0x0abc, 2])).toBe(0);
        expect(call(localeExports, "IsValidLocale", [0x0400, 2])).toBe(0);
        withLcid(0x0419, () => {
            expect(call(localeExports, "IsValidLocale", [0x0419, 2])).toBe(1);
            expect(call(localeExports, "IsValidLocale", [0x0019, 2])).toBe(1);
        });
    });

    test("GetLocaleInfo* refuse an LCID or name the database lacks instead of answering en-US", () => {
        err = 0;
        expect(call(localeExports, "GetLocaleInfoW", [0x0abc, 0x0e, 0x2000, 85])).toBe(0);
        expect(err).toBe(87);
        err = 0;
        expect(call(localeExports, "GetLocaleInfoA", [0x0abc, 0x0e, 0x2000, 85])).toBe(0);
        expect(err).toBe(87);
        expect(call(localeExports, "GetLocaleInfoW", [0x0409, 0x0e, 0x2000, 85])).toBe(2);
        expect(call(localeExports, "GetLocaleInfoW", [0x0009, 0x0e, 0x2000, 85])).toBe(2);
        putW(0x100, "xx-YY");
        expect(call(localeExports, "GetLocaleInfoEx", [0x100, 0x0e, 0x2000, 85])).toBe(0);
        putSt(0x200, ST);
        expect(call(localeEx, "GetDateFormatW", [0x0abc, 0, 0x200, 0, 0x2000, 64])).toBe(0);
        expect(call(localeEx, "GetTimeFormatEx", [0x100, 0, 0x200, 0, 0x2000, 64])).toBe(0);
    });

    test("GetLocaleInfoW/A/Ex answer every locale with its own data", () => {
        const W = (lcid: number, type: number) => {
            const n = call(localeExports, "GetLocaleInfoW", [lcid, type, 0x2000, 85]);
            return n ? getW(0x2000) : `error ${err}`;
        };
        const LOCALE_SENGLANGUAGE = 0x1001, LOCALE_SNATIVELANGNAME = 0x04, LOCALE_SMONTHNAME1 = 0x38;
        const LOCALE_SSHORTDATE = 0x1f, LOCALE_SDECIMAL = 0x0e, LOCALE_IDEFAULTANSICODEPAGE = 0x1004;
        const GENITIVE = 0x10000000, RETURN_NUMBER = 0x20000000;
        withLcid(0x0409, () => {
            expect(W(0x0419, LOCALE_SENGLANGUAGE)).toBe("Russian");
            expect(W(0x0419, LOCALE_SNATIVELANGNAME)).toBe("русский");
            expect(W(0x0419, LOCALE_SMONTHNAME1)).toBe("январь");
            expect(W(0x0419, LOCALE_SMONTHNAME1 | GENITIVE)).toBe("января");
            expect(W(0x0419, LOCALE_SSHORTDATE)).toBe("dd.MM.yyyy");
            expect(W(0x0419, LOCALE_IDEFAULTANSICODEPAGE)).toBe("1251");
            expect(W(0x0407, LOCALE_SDECIMAL)).toBe(",");
            expect(W(0x0411, LOCALE_SNATIVELANGNAME)).toBe("日本語");
            expect(W(0x0411, LOCALE_SSHORTDATE)).toBe("yyyy/M/d");
            // RETURN_NUMBER has a DWORD form only for the numeric types.
            err = 0;
            expect(call(localeExports, "GetLocaleInfoW", [0x0419, LOCALE_SDECIMAL | RETURN_NUMBER, 0x2000, 85])).toBe(0);
            expect(err).toBe(1004);
            // A converts through the locale's own ANSI page (el-GR: 1253), not the process page.
            mem.fill(0, 0x3000, 0x3100);
            expect(call(localeExports, "GetLocaleInfoA", [0x0408, LOCALE_SNATIVELANGNAME, 0x3000, 64])).toBe(9);
            expect([...mem.subarray(0x3000, 0x3009)]).toEqual([0xc5, 0xeb, 0xeb, 0xe7, 0xed, 0xe9, 0xea, 0xdc, 0]);
            putW(0x100, "ja-JP");
            expect(call(localeExports, "GetLocaleInfoEx", [0x100, LOCALE_SSHORTDATE, 0x2000, 85])).toBe(9);
            expect(getW(0x2000)).toBe("yyyy/M/d");
            // A locale with no LCID of its own answers by name.
            putW(0x100, "aa-DJ");
            expect(call(localeExports, "GetLocaleInfoEx", [0x100, 0x5c, 0x2000, 85])).toBe(6);
            expect(getW(0x2000)).toBe("aa-DJ");
        });
        // The process locale's code pages are the manifest's, whatever the locale's own.
        withLcid(0x0419, () => {
            const cfg = EmulatorConfig.getInstance();
            expect(W(0x0419, LOCALE_IDEFAULTANSICODEPAGE)).toBe(String(cfg.ansiCodePage));
            expect(W(0x0400, 0x000b)).toBe(String(cfg.oemCodePage));
            expect(W(0x0409, LOCALE_IDEFAULTANSICODEPAGE)).toBe("1252");
        });
    });

    test("GetDateFormatEx formats a Russian long date with genitive month names", () => {
        putW(0x100, "ru-RU"); putSt(0x200, ST);
        expect(call(localeEx, "GetDateFormatEx", [0x100, DATE_LONGDATE, 0x200, 0, 0x1000, 64, 0])).toBe(26);
        expect(getW(0x1000)).toBe("вторник, 10 марта 2009 г.");
    });

    test("GetLocaleInfoEx answers LOCALE_SNAME from the name and the rest from the LCID", () => {
        putW(0x100, "EN-us");
        expect(call(localeExports, "GetLocaleInfoEx", [0x100, 0x5c, 0x1000, 85])).toBe(6);
        expect(getW(0x1000)).toBe("en-US");
        putW(0x100, "en");
        expect(call(localeExports, "GetLocaleInfoEx", [0x100, 0x5c, 0x1000, 85])).toBe(3);
        expect(getW(0x1000)).toBe("en");
        expect(call(localeExports, "GetLocaleInfoEx", [0, 0x0e, 0x2000, 85])).toBe(2);
        expect(getW(0x2000)).toBe(".");
        putW(0x200, "not-a-locale");
        expect(call(localeExports, "GetLocaleInfoEx", [0x200, 0x0e, 0x2000, 85])).toBe(0);
        expect(err).toBe(87);
    });

    test("the old CRT's setlocale(\"English_United States\") binds en-US whatever the manifest", () => {
        // __get_qualified_locale: EnumSystemLocalesA, then the first LCID whose
        // LOCALE_SENGLANGUAGE (and SENGCOUNTRY) match the request wins.
        const LOCALE_SENGLANGUAGE = 0x1001, LOCALE_SENGCOUNTRY = 0x1002;
        const readA = (lcid: number, type: number): string | null => {
            mem.fill(0, 0x4000, 0x4100);
            const n = call(localeExports, "GetLocaleInfoA", [lcid, type, 0x4000, 0x100]);
            return n ? new TextDecoder().decode(mem.subarray(0x4000, 0x4000 + n - 1)) : null;
        };
        for (const manifest of [0x0409, 0x0419, 0x0407]) {
            const picked = withLcid(manifest, () => enumSystemLcids(1)
                .map((h) => parseInt(h, 16))
                .find((lcid) => readA(lcid, LOCALE_SENGLANGUAGE) === "English"
                    && readA(lcid, LOCALE_SENGCOUNTRY) === "United States"));
            expect([manifest, picked]).toEqual([manifest, 0x0409]);
        }
    });

    test("GetUserPreferredUILanguages returns the UI language as a multi-string", () => {
        const v = new DataView(mem.buffer);
        v.setUint32(0x20, 0, true);
        expect(call(localeEx, "GetUserPreferredUILanguages", [0x8, 0x10, 0, 0x20])).toBe(1);
        expect(v.getUint32(0x20, true)).toBe(7);
        expect(call(localeEx, "GetUserPreferredUILanguages", [0x8, 0x10, 0x1000, 0x20])).toBe(1);
        expect(getW(0x1000)).toBe("en-US");
        expect(mem[0x1000 + 12] | mem[0x1000 + 13]!).toBe(0);
        expect(v.getUint32(0x10, true)).toBe(1);
        v.setUint32(0x20, 64, true);
        expect(call(localeEx, "GetThreadPreferredUILanguages", [0x4, 0x10, 0x1000, 0x20])).toBe(1);
        expect(getW(0x1000)).toBe("0409");
        expect(call(localeEx, "GetUserPreferredUILanguages", [0xc, 0x10, 0x1000, 0x20])).toBe(0);
        expect(err).toBe(87);
    });
});

describe("DLL search order", () => {
    const ctx = { appDir: "C:\\GAME\\", currentDir: "C:\\GAME\\DATA\\" };
    afterEach(() => resetDllSearchState());

    test("standard order: app dir, current dir, root, system dirs", () => {
        expect(dllSearchDirectories(ctx)).toEqual([
            "C:\\GAME\\", "C:\\GAME\\DATA\\", "C:\\", "C:\\WINDOWS\\SYSTEM32\\", "C:\\WINDOWS\\SYSTEM\\", "C:\\WINDOWS\\",
        ]);
    });

    test("SetDllDirectory takes the current directory's slot; \"\" removes it; NULL restores it", () => {
        setDllDirectory("D:\\Plugins");
        expect(dllSearchDirectories(ctx).slice(0, 3)).toEqual(["C:\\GAME\\", "D:\\Plugins\\", "C:\\"]);
        setDllDirectory("");
        expect(dllSearchDirectories(ctx)).not.toContain("C:\\GAME\\DATA\\");
        setDllDirectory(null);
        expect(dllSearchDirectories(ctx)[1]).toBe("C:\\GAME\\DATA\\");
    });

    test("LOAD_LIBRARY_SEARCH_* searches only the named dirs, never the current directory", () => {
        const a = addDllDirectory("C:\\A");
        const b = addDllDirectory("C:\\B");
        setDllDirectory("C:\\D");
        expect(dllSearchDirectories({ ...ctx, loadFlags: LOAD_LIBRARY_SEARCH_DEFAULT_DIRS })).toEqual([
            "C:\\GAME\\", "C:\\B\\", "C:\\A\\", "C:\\D\\", "C:\\WINDOWS\\SYSTEM32\\",
        ]);
        expect(dllSearchDirectories({ ...ctx, loadFlags: LOAD_LIBRARY_SEARCH_SYSTEM32 })).toEqual(["C:\\WINDOWS\\SYSTEM32\\"]);
        expect(removeDllDirectory(b)).toBe(true);
        expect(removeDllDirectory(b)).toBe(false);
        expect(dllSearchDirectories({ ...ctx, loadFlags: LOAD_LIBRARY_SEARCH_USER_DIRS })).toEqual(["C:\\A\\", "C:\\D\\"]);
        expect(a).not.toBe(0);
    });

    test("SetDefaultDllDirectories applies when the call names no search flags", () => {
        expect(setDefaultDllDirectories(0)).toBe(false);
        expect(setDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR)).toBe(false);
        expect(setDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)).toBe(true);
        expect(dllSearchDirectories(ctx)).toEqual(["C:\\GAME\\", "C:\\WINDOWS\\SYSTEM32\\"]);
        expect(dllSearchDirectories({ ...ctx, loadFlags: LOAD_LIBRARY_SEARCH_SYSTEM32 })).toEqual(["C:\\WINDOWS\\SYSTEM32\\"]);
        // ALTERED_SEARCH_PATH opts out of the default flags.
        expect(dllSearchDirectories({ ...ctx, loadFlags: LOAD_WITH_ALTERED_SEARCH_PATH })[1]).toBe("C:\\GAME\\DATA\\");
    });

    test("LoadLibraryEx flag validation", () => {
        expect(validLoadLibrarySearchFlags(LOAD_WITH_ALTERED_SEARCH_PATH | LOAD_LIBRARY_SEARCH_SYSTEM32, "x.dll")).toBe(false);
        expect(validLoadLibrarySearchFlags(LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, "x.dll")).toBe(false);
        expect(validLoadLibrarySearchFlags(LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, "C:\\GAME\\x.dll")).toBe(true);
        expect(validLoadLibrarySearchFlags(0, "x.dll")).toBe(true);
    });

    test("SetSearchPathMode: invalid values, and PERMANENT locks it", () => {
        expect(setSearchPathMode(0)).toBe("invalid");
        expect(setSearchPathMode(BASE_SEARCH_PATH_ENABLE_SAFE_SEARCHMODE)).toBe("ok");
        expect(searchPathSafeMode()).toBe(true);
        expect(setSearchPathMode(BASE_SEARCH_PATH_DISABLE_SAFE_SEARCHMODE)).toBe("ok");
        expect(searchPathSafeMode()).toBe(false);
        expect(setSearchPathMode(BASE_SEARCH_PATH_DISABLE_SAFE_SEARCHMODE | BASE_SEARCH_PATH_PERMANENT)).toBe("invalid");
        expect(setSearchPathMode(BASE_SEARCH_PATH_ENABLE_SAFE_SEARCHMODE | BASE_SEARCH_PATH_PERMANENT)).toBe("ok");
        expect(setSearchPathMode(BASE_SEARCH_PATH_DISABLE_SAFE_SEARCHMODE)).toBe("denied");
        expect(searchPathSafeMode()).toBe(true);
    });
});
