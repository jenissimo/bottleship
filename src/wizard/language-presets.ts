// "Language for non-Unicode programs": as on Windows, one choice sets the ANSI code page,
// the OEM code page and the locale together. Only single-byte ANSI pages are offered —
// those are the ones the worker can decode (emulator-config-manager CP_TO_ENCODING).
export interface LanguagePreset {
  id: string;
  label: string;
  v: { codepage: number; oemCodepage: number; lcid: number };
}

export const LANGUAGE_PRESETS: LanguagePreset[] = [
  { id: "ar-SA", label: "Arabic (Saudi Arabia)", v: { codepage: 1256, oemCodepage: 720, lcid: 0x0401 } },
  { id: "bg-BG", label: "Bulgarian", v: { codepage: 1251, oemCodepage: 866, lcid: 0x0402 } },
  { id: "hr-HR", label: "Croatian", v: { codepage: 1250, oemCodepage: 852, lcid: 0x041A } },
  { id: "cs-CZ", label: "Czech", v: { codepage: 1250, oemCodepage: 852, lcid: 0x0405 } },
  { id: "da-DK", label: "Danish", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0406 } },
  { id: "nl-NL", label: "Dutch", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0413 } },
  { id: "en-GB", label: "English (United Kingdom)", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0809 } },
  { id: "en-US", label: "English (United States)", v: { codepage: 1252, oemCodepage: 437, lcid: 0x0409 } },
  { id: "et-EE", label: "Estonian", v: { codepage: 1257, oemCodepage: 775, lcid: 0x0425 } },
  { id: "fi-FI", label: "Finnish", v: { codepage: 1252, oemCodepage: 850, lcid: 0x040B } },
  { id: "fr-FR", label: "French", v: { codepage: 1252, oemCodepage: 850, lcid: 0x040C } },
  { id: "de-DE", label: "German", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0407 } },
  { id: "el-GR", label: "Greek", v: { codepage: 1253, oemCodepage: 737, lcid: 0x0408 } },
  { id: "he-IL", label: "Hebrew", v: { codepage: 1255, oemCodepage: 862, lcid: 0x040D } },
  { id: "hu-HU", label: "Hungarian", v: { codepage: 1250, oemCodepage: 852, lcid: 0x040E } },
  { id: "it-IT", label: "Italian", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0410 } },
  { id: "lv-LV", label: "Latvian", v: { codepage: 1257, oemCodepage: 775, lcid: 0x0426 } },
  { id: "lt-LT", label: "Lithuanian", v: { codepage: 1257, oemCodepage: 775, lcid: 0x0427 } },
  { id: "nb-NO", label: "Norwegian", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0414 } },
  { id: "pl-PL", label: "Polish", v: { codepage: 1250, oemCodepage: 852, lcid: 0x0415 } },
  { id: "pt-BR", label: "Portuguese (Brazil)", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0416 } },
  { id: "pt-PT", label: "Portuguese (Portugal)", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0816 } },
  { id: "ro-RO", label: "Romanian", v: { codepage: 1250, oemCodepage: 852, lcid: 0x0418 } },
  { id: "ru-RU", label: "Russian", v: { codepage: 1251, oemCodepage: 866, lcid: 0x0419 } },
  { id: "sk-SK", label: "Slovak", v: { codepage: 1250, oemCodepage: 852, lcid: 0x041B } },
  { id: "sl-SI", label: "Slovenian", v: { codepage: 1250, oemCodepage: 852, lcid: 0x0424 } },
  { id: "es-ES", label: "Spanish", v: { codepage: 1252, oemCodepage: 850, lcid: 0x0C0A } },
  { id: "sv-SE", label: "Swedish", v: { codepage: 1252, oemCodepage: 850, lcid: 0x041D } },
  { id: "th-TH", label: "Thai", v: { codepage: 874, oemCodepage: 874, lcid: 0x041E } },
  { id: "tr-TR", label: "Turkish", v: { codepage: 1254, oemCodepage: 857, lcid: 0x041F } },
  { id: "uk-UA", label: "Ukrainian", v: { codepage: 1251, oemCodepage: 866, lcid: 0x0422 } },
  { id: "vi-VN", label: "Vietnamese", v: { codepage: 1258, oemCodepage: 1258, lcid: 0x042A } },
];

export type LanguageFields = { codepage?: number; oemCodepage?: number; lcid?: number };

/** Keep explicit values on an unchanged selection; changing it writes the complete preset. */
export function languageFieldsForSave(original: LanguageFields, selected: string): LanguageFields {
  if (selected === detectLanguagePreset(original)) {
    return Object.fromEntries(Object.entries(original).filter(([, value]) => value !== undefined));
  }
  return LANGUAGE_PRESETS.find((p) => p.id === selected)?.v ?? original;
}

/** The preset an emulator block selects (no fields = Windows' en-US default), or "" when
 *  its codepage/lcid match none. */
export function detectLanguagePreset(e: { codepage?: number; oemCodepage?: number; lcid?: number } | undefined): string {
  const lcid = e?.lcid ?? 0x0409;
  const codepage = e?.codepage ?? 1252;
  return LANGUAGE_PRESETS.find((p) => p.v.lcid === lcid && p.v.codepage === codepage && (e?.oemCodepage === undefined || p.v.oemCodepage === e.oemCodepage))?.id ?? "";
}
