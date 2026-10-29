/** Character conversion for text-mode wide stdio (fgetwc/fputwc).
 * The C locale maps bytes to wchar_t one-to-one rather than through the ANSI page;
 * other locales use the active page, and malformed or unrepresentable input is EILSEQ.
 */
import { getCodePageDecoder } from './codepage-utils';
import { asBufferSource } from '../../dom-buffer';

export function crtFileCharBytes(first: number, codePage: number): number {
    if (codePage === 65001) {
        if (first < 0x80) return 1;
        if (first >= 0xc2 && first <= 0xdf) return 2;
        if (first >= 0xe0 && first <= 0xef) return 3;
        return 0; // wchar_t cannot represent a supplementary Unicode scalar
    }
    if (codePage === 932) return (first >= 0x81 && first <= 0x9f) || (first >= 0xe0 && first <= 0xfc) ? 2 : 1;
    if ([936, 949, 950].includes(codePage)) return first >= 0x81 && first <= 0xfe ? 2 : 1;
    if (codePage === 1361) return (first >= 0x84 && first <= 0xd3) || (first >= 0xd8 && first <= 0xde) || (first >= 0xe0 && first <= 0xf9) ? 2 : 1;
    return 1;
}
export function decodeCrtFileChar(bytes: Uint8Array, codePage: number): number | null {
    if (codePage === 0) return bytes.length === 1 ? bytes[0] : null;
    if (codePage === 1361) return null; // Johab has no browser decoder; never substitute CP1252.
    const label = ({ 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 65001: 'utf-8' } as Record<number, string>)[codePage];
    let s: string;
    try {
        if (label) {
            let decoder = fileDecoders.get(label);
            if (!decoder) { decoder = new TextDecoder(label, { fatal: true, ignoreBOM: true }); fileDecoders.set(label, decoder); }
            s = decoder.decode(asBufferSource(bytes));
        } else s = getCodePageDecoder(codePage).decode(asBufferSource(bytes));
    } catch { return null; }
    if (s.length !== 1 || (s.charCodeAt(0) === 0xfffd && !(codePage === 65001 && bytes.length === 3 && bytes[0] === 0xef && bytes[1] === 0xbf && bytes[2] === 0xbd))) return null;
    return s.charCodeAt(0);
}
const fileDecoders = new Map<string, TextDecoder>();
const reversePages = new Map<number, Map<number, Uint8Array>>();
export function encodeCrtFileChar(ch: number, codePage: number): Uint8Array | null {
    if (codePage === 0) return ch <= 255 ? new Uint8Array([ch]) : null;
    if (codePage === 65001) return ch >= 0xd800 && ch <= 0xdfff ? null : new TextEncoder().encode(String.fromCharCode(ch));
    let table = reversePages.get(codePage);
    if (!table) {
        table = new Map();
        for (let first = 0; first < 256; first++) {
            const count = crtFileCharBytes(first, codePage);
            for (let second = 0; second < (count === 2 ? 256 : 1); second++) {
                const bytes = count === 2 ? new Uint8Array([first, second]) : new Uint8Array([first]);
                const decoded = decodeCrtFileChar(bytes, codePage);
                if (decoded !== null && !table.has(decoded)) table.set(decoded, bytes);
            }
        }
        reversePages.set(codePage, table);
    }
    return table.get(ch) ?? null;
}
