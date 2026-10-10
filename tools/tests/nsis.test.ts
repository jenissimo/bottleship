import {expect, test} from 'bun:test';
import {deflateRawSync} from 'node:zlib';
import {BufferSource} from '@bottleship/formats/unpack/source';
import {Crc32} from '@bottleship/formats/unpack';
import {extractNsisFile, findNsis, parseNsis} from '@bottleship/formats/nsis';
import {inflateNsisSync, inflateRawSync} from '../../packages/formats/src/zip/inflate';

const text = (s: string) => new TextEncoder().encode(s);
const variable = (n: number) => String.fromCharCode(253, 128 | (n & 127), 128 | (n >> 7));
function fixture(options: {name?: string; compressed?: boolean; branch?: boolean; dynamic?: boolean} = {}): Uint8Array {
    const strings: number[] = [0];
    const str = (s: string) => {const offset = strings.length; strings.push(...Array.from(s, c => c.charCodeAt(0)), 0); return offset};
    const entries = [
        [11, str(variable(21)), 1, 0, 0, 0, 0],
        [25, 31, str(variable(options.dynamic ? 0 : 22)), 0, 0, 0, 0],
        [11, str(variable(31) + '\\Data'), 1, 0, 0, 0, 0],
        ...(options.branch ? [[2, 1, 0, 0, 0, 0, 0]] : []),
        [20, 0, str(options.name ?? 'demo.exe'), 0, 0, 0, 0],
        [20, 0, str('copy.exe'), 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0],
    ];
    const entriesOffset = 68 + 1048, stringsOffset = entriesOffset + entries.length * 28;
    const header = new Uint8Array(stringsOffset + strings.length), hd = new DataView(header.buffer);
    hd.setUint32(12, 68, true); hd.setUint32(16, 1, true);
    hd.setUint32(20, entriesOffset, true); hd.setUint32(24, entries.length, true);
    hd.setUint32(28, stringsOffset, true); hd.setUint32(36, header.length, true);
    hd.setUint32(68 + 16, entries.length, true);
    entries.forEach((entry, i) => entry.forEach((value, j) => hd.setInt32(entriesOffset + i * 28 + j * 4, value, true)));
    header.set(strings, stringsOffset);
    const body = text('MZ-original-guest-image'), payload = options.compressed ? deflateRawSync(body) : body;
    const result = new Uint8Array(512 + 32 + header.length + 4 + payload.length + 4), dv = new DataView(result.buffer);
    result.set(text('MZ')); dv.setUint32(20, 0xdeadbeef, true); // A code constant is not a header.
    dv.setUint32(516, 0xdeadbeef, true); result.set(text('NullsoftInst'), 520);
    dv.setUint32(532, header.length, true); dv.setUint32(536, result.length - 512, true);
    dv.setUint32(540, header.length, true); result.set(header, 544);
    const data = 544 + header.length;
    dv.setUint32(data, (payload.length | (options.compressed ? 0x80000000 : 0)) >>> 0, true); result.set(payload, data + 4);
    const crc = new Crc32(); crc.update(result, 512, result.length - 4); dv.setUint32(result.length - 4, crc.finalize(), true);
    return result;
}

test('NSIS follows static OUTDIR aliases and deduplicated block references', () => {
    for (const compressed of [false, true]) {
        const source = new BufferSource(fixture({compressed})), archive = parseNsis(source);
        expect(findNsis(source)).toBe(512);
        expect(archive.files.map(f => f.path)).toEqual(['Data/demo.exe', 'Data/copy.exe']);
        expect(archive.directories).toEqual(['Data']);
        for (const file of archive.files) expect(extractNsisFile(source, archive, file)).toEqual(text('MZ-original-guest-image'));
    }
});
test('NSIS rejects corrupt checksums, truncated installers and escaping paths', () => {
    const corrupt = fixture(); corrupt[corrupt.length - 5] ^= 1;
    expect(() => parseNsis(new BufferSource(corrupt))).toThrow('CRC');
    expect(() => parseNsis(new BufferSource(fixture().subarray(0, -5)))).toThrow();
    expect(() => parseNsis(new BufferSource(fixture({name: '../../escape.exe'})))).toThrow('Unsafe');
});
test('NSIS refuses conditional or dynamically computed file destinations', () => {
    expect(() => parseNsis(new BufferSource(fixture({branch: true})))).toThrow('Conditional');
    expect(() => parseNsis(new BufferSource(fixture({dynamic: true})))).toThrow('dynamic');
});
test('forced CRC overrides NO_CRC and Unicode headers are refused', () => {
    const forced = fixture(), fd = new DataView(forced.buffer);
    fd.setUint32(512, 4 | 8, true);
    const crc = new Crc32(); crc.update(forced, 512, forced.length - 4);
    fd.setUint32(forced.length - 4, crc.finalize(), true);
    expect(parseNsis(new BufferSource(forced)).files).toHaveLength(2);
    forced[forced.length - 5] ^= 1;
    expect(() => parseNsis(new BufferSource(forced))).toThrow('CRC');
    const unicode = fixture(), ud = new DataView(unicode.buffer);
    const strings = 544 + ud.getUint32(544 + 28, true);
    unicode[strings + 1] = 0;
    const unicodeCrc = new Crc32(); unicodeCrc.update(unicode, 512, unicode.length - 4);
    ud.setUint32(unicode.length - 4, unicodeCrc.finalize(), true);
    expect(() => parseNsis(new BufferSource(unicode))).toThrow('Unicode');
});
test('NSIS file ranges must stay within the archive', () => {
    const source = new BufferSource(fixture()), archive = parseNsis(source);
    expect(() => extractNsisFile(source, archive, {...archive.files[0], dataOffset: -1})).toThrow();
    expect(() => extractNsisFile(source, archive, {...archive.files[0], dataOffset: source.size})).toThrow();
});
test('NSIS stored blocks omit NLEN without weakening ordinary DEFLATE validation', () => {
    const payload = text('a stored block');
    const stream = new Uint8Array(3 + payload.length); stream[0] = 1;
    new DataView(stream.buffer).setUint16(1, payload.length, true); stream.set(payload, 3);
    const out = new Uint8Array(payload.length);
    expect(inflateNsisSync(stream, out).status).toBe('ok'); expect(out).toEqual(payload);
    expect(inflateRawSync(stream, out).status).toBe('data-error');
    expect(inflateNsisSync(stream.subarray(0, -1), out).status).toBe('truncated');
    expect(inflateNsisSync(stream, new Uint8Array(2)).status).toBe('output-full');
});
