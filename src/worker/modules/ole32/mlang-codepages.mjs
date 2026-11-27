export const CODEPAGES = [
    [1252, 0, 'windows-1252'], [1250, 1, 'windows-1250'], [1251, 2, 'windows-1251'],
    [1253, 3, 'windows-1253'], [1254, 4, 'windows-1254'], [1255, 5, 'windows-1255'],
    [1256, 6, 'windows-1256'], [1257, 7, 'windows-1257'], [1258, 8, 'windows-1258'],
    [874, 16, 'windows-874'], [932, 17, 'shift_jis'], [936, 18, 'gbk'],
    [949, 19, 'euc-kr'], [950, 20, 'big5'],
];
const repertoires = new Map();
function repertoire(page, label) {
    if (repertoires.has(page)) return repertoires.get(page);
    const decoder = new TextDecoder(label), set = new Set();
    const add = bytes => {
        const text = decoder.decode(bytes);
        if (text.length === 1 && text.charCodeAt(0) !== 0xfffd) set.add(text.charCodeAt(0));
    };
    for (let b = 0; b < 256; b++) add(Uint8Array.of(b));
    if ([932, 936, 949, 950].includes(page)) {
        for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) add(Uint8Array.of(lead, trail));
    }
    repertoires.set(page, set);
    return set;
}
export function charCodePages(ch) {
    let mask = 0;
    if (ch >= 0 && ch < 128) return CODEPAGES.reduce((n, [, bit]) => n | 2 ** bit, 0) >>> 0;
    for (const [page, bit, label] of CODEPAGES) if (repertoire(page, label).has(ch)) mask |= 2 ** bit;
    return mask >>> 0;
}
export function codePageBit(page) {
    const entry = CODEPAGES.find(([number]) => number === page);
    return entry ? 2 ** entry[1] : 0;
}
export const MULTILANGUAGE_METHODS = [
    ['QueryInterface', 3], ['AddRef', 1], ['Release', 1],
    ['GetNumberOfCodePageInfo', 2], ['GetCodePageInfo', 3], ['GetFamilyCodePage', 3],
    ['EnumCodePages', 3], ['GetCharsetInfo', 3], ['IsConvertible', 3], ['ConvertString', 8],
    ['ConvertStringToUnicode', 7], ['ConvertStringFromUnicode', 7], ['ConvertStringReset', 1],
    ['GetRfc1766FromLcid', 3], ['GetLcidFromRfc1766', 3], ['EnumRfc1766', 2],
    ['GetRfc1766Info', 3], ['CreateConvertCharset', 5],
];
export const FONTLINK_METHODS = [
    ['QueryInterface', 3], ['AddRef', 1], ['Release', 1], ['GetCharCodePages', 3],
    ['GetStrCodePages', 6], ['CodePageToCodePages', 3], ['CodePagesToCodePage', 4],
    ['GetFontCodePages', 4], ['MapFont', 5], ['ReleaseFont', 2], ['ResetFontMapping', 1],
];
