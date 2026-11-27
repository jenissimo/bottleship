import { expect, test } from 'bun:test';
import { charCodePages, codePageBit, FONTLINK_METHODS, MULTILANGUAGE_METHODS } from '../../src/worker/modules/ole32/mlang-codepages.mjs';

test('MLang ABI inherited slots include this and their real stack arity', () => {
    expect(MULTILANGUAGE_METHODS.length).toBe(18); expect(FONTLINK_METHODS.length).toBe(11);
    expect(FONTLINK_METHODS[3]).toEqual(['GetCharCodePages', 3]);
    expect(FONTLINK_METHODS[7]).toEqual(['GetFontCodePages', 4]);
    expect(FONTLINK_METHODS[8]).toEqual(['MapFont', 5]);
    expect(MULTILANGUAGE_METHODS[9]).toEqual(['ConvertString', 8]);
});
test('CP949 includes extension Hangul at low Latin-letter trails as well as KS X 1001 Hangul', () => {
    const bit = codePageBit(949); expect(bit).toBe(1 << 19);
    for (const ch of [0xac02, 0xac35, 0xac00]) expect(charCodePages(ch) & bit).toBe(bit);
    expect(charCodePages(0xd800) & bit).toBe(0);
    expect(codePageBit(123456)).toBe(0);
});
test('DBCS scan bounds cover every single-BMP decoding from all 65536 byte pairs', () => {
    for (const [page, label] of [[932,'shift_jis'],[936,'gbk'],[949,'euc-kr'],[950,'big5']] as const) {
        const decoder = new TextDecoder(label), chars = new Set<number>(), pair = new Uint8Array(2);
        for (let bytes = 0; bytes < 65536; bytes++) {
            pair[0] = bytes >>> 8; pair[1] = bytes & 255;
            const s = decoder.decode(pair);
            if (s.length === 1 && s.charCodeAt(0) !== 0xfffd) chars.add(s.charCodeAt(0));
        }
        const bit = codePageBit(page);
        for (const ch of chars) expect(charCodePages(ch) & bit).toBe(bit);
    }
});
