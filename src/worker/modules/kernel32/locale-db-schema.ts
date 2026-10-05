// Layout of the compiled locale database (locale-db.generated.ts), shared by its writer
// (tools/gen-locale-db.ts) and its reader (locale-db.ts) so the two cannot drift.
//
// The blob is little-endian and every section starts 4-byte aligned:
//   header    u32 × HEADER_WORDS            (HeaderWord order)
//   strLens   u16 × nStrings                UTF-16 lengths, in pool order; string 0 is ""
//   pool      u16 × poolChars
//   arrOffs   u32 × (nArrays + 1)           offsets into arrData; array 0 is "absent"
//   arrData   u16 × arrDataLen              string ids
//   records   u16 × (nLocales × FIELD_COUNT) one row per locale, LocaleField order
//   names     u32 × 2 × nNames              [nameStr | localeIdx << 16, id] in Wine's
//                                            compare_locale_names order; bit 31 of id = alias
//   lcids     u32 × 2 × nLcids              [lcid, localeIdx | nameStr << 16], ascending

export const LOCALE_DB_MAGIC = 0x444c5342; // 'BSLD'
export const LOCALE_DB_VERSION = 1;

export const enum HeaderWord {
    Magic, Version,
    NStrings, StrLensOff, PoolOff, PoolChars,
    NArrays, ArrOffsOff, ArrDataOff, ArrDataLen,
    NLocales, FieldCount, RecordsOff,
    NNames, NamesOff,
    NLcids, LcidsOff,
}
export const HEADER_WORDS = 17;

/** One u16 per field. S* = string id, A* = array id, everything else the number itself. */
export const enum LocaleField {
    // strings
    SName, SOpenTypeLanguageTag, SList, SDecimal, SThousand, SCurrency, SMonDecimalSep,
    SMonThousandSep, SPositiveSign, SNegativeSign, S1159, S2359, SAbbrevLangName,
    SIso639LangName, SEngLanguage, SNativeLangName, SEngCountry, SNativeCtryName,
    SAbbrevCtryName, SIso3166CtryName, SIntlSymbol, SEngCurrName, SNativeCurrName,
    FontSignature, SIso639LangName2, SIso3166CtryName2, SParent, SEngDisplayName,
    SNativeDisplayName, SPercent, SNan, SPosInfinity, SNegInfinity, SEraString,
    SAbbrevEraString, SConsoleFallbackName, SSortLocale, SKeyboardsToInstall, SScripts,
    SRelativeLongDate, SShortestAm, SShortestPm,
    /** Pre-rendered the way locale_return_grouping prints the binary grouping ("3;0"). */
    SGrouping, SMonGrouping,
    /** The digit array, concatenated (locale_return_strarray_concat). */
    SNativeDigits,
    // arrays
    ATimeFormat, AShortDate, ALongDate, AYearMonth, ADuration, AShortTime, AMonthDay,
    /** Sunday first, as stored; LCTYPE day 1 is Monday. */
    ADayName, AAbbrevDayName, AShortestDayName,
    /** Thirteen entries. */
    AMonthName, AAbbrevMonthName, AGenitiveMonth, AAbbrevGenitiveMonth,
    // numbers
    ILanguage, IDigits, INegNumber, ICurrDigits, ICurrency, INegCurr, ILZero, INotNeutral,
    /** Monday = 0, as stored; LOCALE_IFIRSTDAYOFWEEK reports it shifted. */
    IFirstDayOfWeek, IFirstWeekOfYear, ICountry, IMeasure, IDigitSubstitution,
    IDefaultLanguage, IDefaultAnsiCodePage, IDefaultCodePage, IDefaultMacCodePage,
    IDefaultEbcdicCodePage, IPaperSize, ICalendarType, IOptionalCalendar,
    INegativePercent, IPositivePercent, IReadingLayout, IGeoIdLo, IGeoIdHi,
    Count,
}
export const FIELD_COUNT = LocaleField.Count;

/** Array id 0: the field is absent (Wine's offset 0) — distinct from a present, empty array. */
export const ARRAY_ABSENT = 0;
