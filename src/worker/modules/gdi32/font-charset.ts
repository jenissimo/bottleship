/**
 * Font charsets and their FONTSIGNATURE — what GetTextCharsetInfo answers with.
 *
 * A charset is not decoration: it is how a Win32 app decides which byte→glyph mapping to
 * use for the text it is about to draw, and which of its own resources to load. Answering
 * a constant would make a Cyrillic build render its own strings through cp1252.
 *
 * DEFAULT_CHARSET is the interesting case. It is a REQUEST, not an answer — Windows
 * resolves it to the charset of the system ANSI code page at font-realisation time, and
 * that is what GetTextCharsetInfo reports back. So the resolution here reads the same
 * `EmulatorConfig.ansiCodePage` that GetACP and every A→W conversion read, rather than
 * introducing a second opinion about which code page the guest is running under.
 */

import { EmulatorConfig } from "../../core/emulator-config-manager";

export const ANSI_CHARSET = 0;
export const DEFAULT_CHARSET = 1;
export const SYMBOL_CHARSET = 2;
export const MAC_CHARSET = 77;
export const SHIFTJIS_CHARSET = 128;
export const HANGUL_CHARSET = 129;
export const JOHAB_CHARSET = 130;
export const GB2312_CHARSET = 134;
export const CHINESEBIG5_CHARSET = 136;
export const GREEK_CHARSET = 161;
export const TURKISH_CHARSET = 162;
export const VIETNAMESE_CHARSET = 163;
export const HEBREW_CHARSET = 177;
export const ARABIC_CHARSET = 178;
export const BALTIC_CHARSET = 186;
export const RUSSIAN_CHARSET = 204;
export const THAI_CHARSET = 222;
export const EASTEUROPE_CHARSET = 238;
export const OEM_CHARSET = 255;

/** charset → the code page a Win32 app would encode 8-bit text in for it. */
const CHARSET_TO_CODEPAGE = new Map<number, number>([
    [ANSI_CHARSET, 1252],
    [EASTEUROPE_CHARSET, 1250],
    [RUSSIAN_CHARSET, 1251],
    [GREEK_CHARSET, 1253],
    [TURKISH_CHARSET, 1254],
    [HEBREW_CHARSET, 1255],
    [ARABIC_CHARSET, 1256],
    [BALTIC_CHARSET, 1257],
    [VIETNAMESE_CHARSET, 1258],
    [THAI_CHARSET, 874],
    [SHIFTJIS_CHARSET, 932],
    [GB2312_CHARSET, 936],
    [HANGUL_CHARSET, 949],
    [CHINESEBIG5_CHARSET, 950],
    [JOHAB_CHARSET, 1361],
]);

/** The inverse, for resolving DEFAULT_CHARSET against the system ANSI code page. */
const CODEPAGE_TO_CHARSET = new Map<number, number>(
    [...CHARSET_TO_CODEPAGE].map(([charset, cp]) => [cp, charset]),
);

/** FONTSIGNATURE.fsCsb[0] bit per charset (the FS_* set from wingdi.h). */
const CHARSET_TO_FSCSB = new Map<number, number>([
    [ANSI_CHARSET, 0x00000001],       // FS_LATIN1
    [EASTEUROPE_CHARSET, 0x00000002], // FS_LATIN2
    [RUSSIAN_CHARSET, 0x00000004],    // FS_CYRILLIC
    [GREEK_CHARSET, 0x00000008],      // FS_GREEK
    [TURKISH_CHARSET, 0x00000010],    // FS_TURKISH
    [HEBREW_CHARSET, 0x00000020],     // FS_HEBREW
    [ARABIC_CHARSET, 0x00000040],     // FS_ARABIC
    [BALTIC_CHARSET, 0x00000080],     // FS_BALTIC
    [VIETNAMESE_CHARSET, 0x00000100], // FS_VIETNAMESE
    [THAI_CHARSET, 0x00010000],       // FS_THAI
    [SHIFTJIS_CHARSET, 0x00020000],   // FS_JISJAPAN
    [GB2312_CHARSET, 0x00040000],     // FS_CHINESESIMP
    [HANGUL_CHARSET, 0x00080000],     // FS_WANSUNG
    [CHINESEBIG5_CHARSET, 0x00100000],// FS_CHINESETRAD
    [JOHAB_CHARSET, 0x00200000],      // FS_JOHAB
    [SYMBOL_CHARSET, 0x80000000],     // FS_SYMBOL
    [OEM_CHARSET, 0x40000000],
]);

/**
 * fsUsb — the Unicode SUBSET bits. We report only what our renderer demonstrably covers:
 * Basic Latin always, plus the one block the charset names. Claiming a font's full
 * coverage map would be inventing data about a face we do not parse, and an app that
 * picks a font by fsUsb would then pick one that cannot draw the script it wanted.
 */
const USB_BASIC_LATIN = 0x00000001;      // bit 0
const USB_LATIN1_SUPPLEMENT = 0x00000002;// bit 1
const USB_LATIN_EXT_A = 0x00000004;      // bit 2
const USB_GREEK = 0x00000080;            // bit 7
const USB_CYRILLIC = 0x00000200;         // bit 9
const USB_HEBREW = 0x00000800;           // bit 11
const USB_ARABIC = 0x00002000;           // bit 13
const USB_THAI = 0x00010000;             // bit 16

const CHARSET_TO_USB0 = new Map<number, number>([
    [ANSI_CHARSET, USB_BASIC_LATIN | USB_LATIN1_SUPPLEMENT],
    [EASTEUROPE_CHARSET, USB_BASIC_LATIN | USB_LATIN1_SUPPLEMENT | USB_LATIN_EXT_A],
    [BALTIC_CHARSET, USB_BASIC_LATIN | USB_LATIN1_SUPPLEMENT | USB_LATIN_EXT_A],
    [TURKISH_CHARSET, USB_BASIC_LATIN | USB_LATIN1_SUPPLEMENT | USB_LATIN_EXT_A],
    [VIETNAMESE_CHARSET, USB_BASIC_LATIN | USB_LATIN1_SUPPLEMENT | USB_LATIN_EXT_A],
    [RUSSIAN_CHARSET, USB_BASIC_LATIN | USB_CYRILLIC],
    [GREEK_CHARSET, USB_BASIC_LATIN | USB_GREEK],
    [HEBREW_CHARSET, USB_BASIC_LATIN | USB_HEBREW],
    [ARABIC_CHARSET, USB_BASIC_LATIN | USB_ARABIC],
    [THAI_CHARSET, USB_BASIC_LATIN | USB_THAI],
]);

/** The system charset: what an unspecified (DEFAULT_CHARSET) font actually realises as. */
export function systemDefaultCharset(): number {
    const cp = EmulatorConfig.getInstance().ansiCodePage;
    return CODEPAGE_TO_CHARSET.get(cp) ?? ANSI_CHARSET;
}

/** DEFAULT_CHARSET resolves against the system code page; everything else is itself. */
export function resolveCharset(lfCharSet: number): number {
    return lfCharSet === DEFAULT_CHARSET ? systemDefaultCharset() : lfCharSet & 0xff;
}

export function charsetCodePage(charset: number): number | undefined {
    return CHARSET_TO_CODEPAGE.get(charset);
}

/** FONTSIGNATURE for a realised charset: [fsUsb0..3, fsCsb0, fsCsb1]. */
export function fontSignature(charset: number): [number, number, number, number, number, number] {
    const usb0 = CHARSET_TO_USB0.get(charset) ?? USB_BASIC_LATIN;
    const csb0 = CHARSET_TO_FSCSB.get(charset) ?? 0;
    // fsCsb[1] carries the OEM/DOS code pages, which we do not enumerate.
    return [usb0, 0, 0, 0, csb0, 0];
}
