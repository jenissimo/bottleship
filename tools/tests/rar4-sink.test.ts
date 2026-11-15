import { expect, test } from 'bun:test';
import { BufferSource, type RandomAccessSource } from '@bottleship/formats/unpack';
import { assertRar4Extractable, extractRar4, extractRar4ToSink, parseRar4 } from '@bottleship/formats/rar';
import { crc32 } from '../../packages/formats/src/installer/binary';
import { decodeRar29, decodeRar29Solid } from '../../packages/formats/src/rar/lz29';

const text = (s: string) => new TextEncoder().encode(s);
const u16 = (n: number) => [n & 255, (n >>> 8) & 255];
const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
class Bits {
    bits: number[] = [];
    put(value: number, count: number) { for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); return this; }
    tables() { this.put(0, 2); for (let i = 0; i < 20; i++) this.put(5, 4); for (let i = 0; i < 404; i++) this.put(i < 299 ? 9 : i < 359 ? 6 : 5, 5); return this; }
    end() { this.put(256, 9).put(0, 2); const out = new Uint8Array(Math.ceil(this.bits.length / 8)); this.bits.forEach((b, i) => out[i >>> 3] |= b << (7 - (i & 7))); return out; }
}
function literal(data: Uint8Array) { const bits = new Bits().tables(); for (const byte of data) bits.put(byte, 9); return bits.end(); }
const repeat = () => new Bits().put(271, 9).put(2, 6).put(258, 9).end();
interface Member { name: string; data?: Uint8Array; packed?: Uint8Array; flags?: number; method?: number; version?: number; size?: number; crc?: number; dir?: boolean; }
function archive(members: Member[], mainFlags = 0) {
    const block = (type: number, flags: number, body: number[]) => { const b = new Uint8Array([type, ...u16(flags), ...u16(body.length + 7), ...body]); return [...u16(crc32(b) & 65535), ...b]; };
    const files = members.flatMap(e => { const data = e.data ?? new Uint8Array(0), packed = e.packed ?? data, name = text(e.name); return [...block(0x74, 0x8000 | (e.flags ?? 0) | (e.dir ? 0xe0 : 0), [...u32(packed.length), ...u32(e.size ?? data.length), 2, ...u32(e.crc ?? crc32(data)), ...u32(0), e.version ?? 29, e.method ?? 0x30, ...u16(name.length), ...u32(e.dir ? 16 : 0), ...name]), ...packed]; });
    return new BufferSource(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0, ...block(0x73, mainFlags, [0, 0, 0, 0, 0, 0]), ...files, ...block(0x7b, 0, [])]));
}
const compressed = (name: string, value: string): Member => ({ name, data: text(value), packed: literal(text(value)), method: 0x35 });
function spy(source: RandomAccessSource) { const entries = parseRar4(source).entries, reads: string[] = []; return { reads, source: { size: source.size, readRangeSync(start: number, end: number) { const entry = entries.find(e => e.packedSize > 7 && start === e.dataOffset && end === e.dataOffset + e.packedSize); if (entry) reads.push(entry.name); return source.readRangeSync(start, end); } } }; }

 test('RAR4 sink preserves archive order, stored/empty bytes and empty directories', async () => {
    const source = archive([{ name: 'empty-dir', dir: true }, { name: 'stored', data: text('stored') }, { name: 'empty', data: text('') }, compressed('compressed', 'ABC')]);
    const seen: Array<[string, Uint8Array, boolean]> = [];
    await extractRar4ToSink(source, 0, {}, (name, data, entry) => { seen.push([name, data, entry.isDirectory]); });
    expect(seen.map(x => [x[0], new TextDecoder().decode(x[1]), x[2]])).toEqual([['empty-dir/', '', true], ['stored', 'stored', false], ['empty', '', false], ['compressed', 'ABC', false]]);
    expect([...extractRar4(source)]).toEqual(seen.map(([name, data]) => [name, data]));
});

test('RAR4 sink awaits the consumer before reading another independent group', async () => {
    const traced = spy(archive([compressed('a', 'ABC'), compressed('b', 'XYZ')]));
    const seen: string[] = [];
    await extractRar4ToSink(traced.source, 0, { maxOutputBytes: 3 }, async (name, data) => {
        if (name === 'a') { expect(traced.reads).toEqual(['a']); await Promise.resolve(); expect(traced.reads).toEqual(['a']); }
        seen.push(new TextDecoder().decode(data));
    });
    expect(seen).toEqual(['ABC', 'XYZ']); expect(traced.reads).toEqual(['a', 'b']);
});

test('RAR4 sink filtering retains solid history and directories in their original positions', async () => {
    const source = archive([compressed('first', 'ABC'), { name: 'between', dir: true }, { name: 'second', data: text('ABCABC'), packed: repeat(), flags: 16, method: 0x35 }]);
    const seen: Array<[string, string]> = [];
    await extractRar4ToSink(source, 0, { wantFile: e => e.name !== 'first' }, (name, data) => { seen.push([name, new TextDecoder().decode(data)]); });
    expect(seen).toEqual([['between/', ''], ['second', 'ABCABC']]);
});

test('RAR4 authenticates an entire solid group before any callback, including skipped history', async () => {
    for (const bad of ['first', 'second']) {
        const source = archive([{ ...compressed('first', 'ABC'), ...(bad === 'first' ? { crc: 0 } : {}) }, { name: 'between', dir: true }, { name: 'second', data: text('ABCABC'), packed: repeat(), flags: 16, method: 0x35, ...(bad === 'second' ? { crc: 0 } : {}) }]);
        const seen: string[] = [];
        await expect(extractRar4ToSink(source, 0, { wantFile: e => e.name !== 'first' }, name => { seen.push(name); })).rejects.toThrow('CRC mismatch');
        expect(seen).toEqual([]);
    }
});

test('RAR4 bad stored CRC is never published; a later independent error preserves only the verified prefix', async () => {
    const seen: string[] = [];
    await expect(extractRar4ToSink(archive([{ name: 'bad', data: text('bad'), crc: 0 }]), 0, {}, name => { seen.push(name); })).rejects.toThrow('CRC mismatch');
    expect(seen).toEqual([]);
    await expect(extractRar4ToSink(archive([compressed('good', 'ABC'), { ...compressed('bad', 'XYZ'), crc: 0 }]), 0, {}, name => { seen.push(name); })).rejects.toThrow('CRC mismatch');
    expect(seen).toEqual(['good']);
});

test('RAR4 global preflight refuses duplicate/encrypted/split/unsupported metadata before publishing a valid prefix', async () => {
    const invalid: Member[] = [{ name: 'GOOD', data: text('x') }, { name: 'bad', flags: 4 }, { name: 'bad', flags: 1 }, { name: 'bad', flags: 2 }, { name: 'bad', method: 0x36 }, { name: 'bad', method: 0x35, version: 20 }, { name: 'bad', method: 0x30, flags: 16 }];
    for (const member of invalid) {
        const source = archive([compressed('good', 'ABC'), member]); const seen: string[] = [];
        expect(() => assertRar4Extractable(parseRar4(source))).toThrow();
        await expect(extractRar4ToSink(source, 0, {}, name => { seen.push(name); })).rejects.toThrow(); expect(seen).toEqual([]);
    }
    expect(() => assertRar4Extractable(parseRar4(archive([], 1)))).toThrow('multi-volume');
    expect(() => assertRar4Extractable(parseRar4(archive([{ ...compressed('orphan', 'ABC'), flags: 16 }])))).toThrow('without preceding');
});

test('RAR4 output budgets apply to the solid group or stored member, not the cumulative archive', async () => {
    const solid = archive([compressed('first', 'ABC'), { name: 'second', data: text('ABCABC'), packed: repeat(), flags: 16, method: 0x35 }]);
    const seen: string[] = [];
    await expect(extractRar4ToSink(solid, 0, { maxOutputBytes: 8 }, name => { seen.push(name); })).rejects.toThrow('maxOutputBytes'); expect(seen).toEqual([]);
    await extractRar4ToSink(solid, 0, { maxOutputBytes: 9 }, name => { seen.push(name); }); expect(seen).toEqual(['first', 'second']);
    expect(() => extractRar4(archive([{ name: 'stored', data: text('abc') }]), 0, { maxOutputBytes: 2 })).toThrow('maxOutputBytes');
    expect(decodeRar29(literal(text('ABC')), 3, undefined, { maxOutputBytes: 3 })).toEqual(text('ABC'));
    expect(() => decodeRar29(literal(text('ABC')), 3, undefined, { maxOutputBytes: 2 })).toThrow('output size');
    expect(() => decodeRar29Solid([{ input: literal(text('ABC')), expectedSize: 3 }, { input: repeat(), expectedSize: 6 }], undefined, { maxOutputBytes: 8 })).toThrow('output size');
});

test('RAR4 retains the default 512MiB bound and validates a configurable positive int32 budget without large allocations', async () => {
    const largeHeader = archive([{ ...compressed('large', 'A'), size: 512 * 1024 * 1024 + 1 }]);
    expect(() => assertRar4Extractable(parseRar4(largeHeader))).toThrow('maxOutputBytes');
    expect(() => assertRar4Extractable(parseRar4(largeHeader), { maxOutputBytes: 1024 * 1024 * 1024 })).not.toThrow();
    const tiny = archive([compressed('tiny', 'ABC')]);
    expect(extractRar4(tiny, 0, { maxOutputBytes: 1024 * 1024 * 1024 }).get('tiny')).toEqual(text('ABC'));
    expect(decodeRar29(literal(text('ABC')), 3, undefined, { maxOutputBytes: 0x7fffffff })).toEqual(text('ABC'));
    for (const maxOutputBytes of [0, -1, 1.5, NaN, Infinity, 0x80000000, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => assertRar4Extractable(parseRar4(tiny), { maxOutputBytes })).toThrow('invalid maxOutputBytes');
        expect(() => decodeRar29Solid([], undefined, { maxOutputBytes })).toThrow('invalid maxOutputBytes');
        const seen: string[] = []; await expect(extractRar4ToSink(tiny, 0, { maxOutputBytes }, name => { seen.push(name); })).rejects.toThrow('invalid maxOutputBytes'); expect(seen).toEqual([]);
    }
});

test('RAR4 sink rejection closes iteration before reading the following independent payload', async () => {
    const traced = spy(archive([compressed('first', 'ABC'), compressed('second', 'XYZ')]));
    await expect(extractRar4ToSink(traced.source, 0, {}, () => { throw new Error('consumer refused'); })).rejects.toThrow('consumer refused');
    expect(traced.reads).toEqual(['first']);
});
