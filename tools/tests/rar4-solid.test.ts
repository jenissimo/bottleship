import { expect, test } from 'bun:test';
import { BufferSource } from '@bottleship/formats/unpack';
import { extractRar4 } from '@bottleship/formats/rar';
import { decodeRar29, decodeRar29Solid } from '../../packages/formats/src/rar/lz29';
import { crc32 } from '../../packages/formats/src/installer/binary';

class Bits {
    private bits: number[] = [];
    put(value: number, count: number) {
        for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
        return this;
    }
    tables() {
        this.put(0, 2);
        for (let i = 0; i < 20; i++) this.put(5, 4);
        for (let i = 0; i < 404; i++) this.put(i < 299 ? 9 : i < 359 ? 6 : 5, 5);
        return this;
    }
    end(newTable = false) {
        this.put(256, 9).put(newTable ? 1 : 0, 2);
        const out = new Uint8Array(Math.ceil(this.bits.length / 8));
        this.bits.forEach((bit, i) => out[i >>> 3] |= bit << (7 - (i & 7)));
        return out;
    }
}
const text = (s: string) => new TextEncoder().encode(s);
const first = (newTable = false) => ({ input: new Bits().tables().put(65, 9).put(66, 9).put(67, 9).end(newTable), expectedSize: 3 });
const repeated = (tables = false) => {
    const bits = new Bits();
    if (tables) bits.tables();
    // The first three-byte match reaches the previous file, then repeats that match.
    return { input: bits.put(271, 9).put(2, 6).put(258, 9).end(), expectedSize: 6 };
};

test('RAR29 solid files retain dictionary, Huffman tables and repeated matches', () => {
    for (const newTable of [false, true]) {
        const decoded = decodeRar29Solid([first(newTable), repeated(newTable)]);
        expect(decoded).toEqual([text('ABC'), text('ABCABC')]);
    }
    expect(() => decodeRar29(repeated(true).input, 6)).toThrow('invalid match');
    // A fresh decode cannot inherit another archive's history.
    expect(decodeRar29(first().input, 3)).toEqual(text('ABC'));
});

test('RAR29 solid boundaries enforce each input and output extent', () => {
    const a = first(), b = repeated();
    expect(() => decodeRar29Solid([a, { ...b, expectedSize: 5 }])).toThrow('invalid match');
    expect(() => decodeRar29Solid([a, { ...b, expectedSize: 7 }])).toThrow('size mismatch');
    expect(() => decodeRar29Solid([{ ...a, input: a.input.subarray(0, a.input.length - 2) }, b])).toThrow('truncated');
    expect(() => decodeRar29Solid([{ input: a.input, expectedSize: -1 }])).toThrow('invalid output size');
});

function archive(secondFlags = 0x8010, secondCrc = crc32(text('ABCABC'))) {
    const u16 = (n: number) => [n & 255, (n >>> 8) & 255];
    const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
    const block = (type: number, flags: number, body: number[]) => {
        const bytes = new Uint8Array([type, ...u16(flags), ...u16(body.length + 7), ...body]);
        return [...u16(crc32(bytes) & 65535), ...bytes];
    };
    const file = (name: string, data: ReturnType<typeof first>, flags: number, crc: number) => [
        ...block(0x74, flags, [...u32(data.input.length), ...u32(data.expectedSize), 2, ...u32(crc),
            ...u32(0), 29, 0x35, ...u16(name.length), ...u32(0), ...text(name)]), ...data.input,
    ];
    return new BufferSource(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0,
        ...block(0x73, 8, [0, 0, 0, 0, 0, 0]),
        ...file('first.txt', first(), 0x8000, crc32(text('ABC'))),
        ...file('second.txt', repeated(), secondFlags, secondCrc),
        ...block(0x7b, 0, [])]));
}

test('RAR4 extracts solid members in order and checks each decoded CRC', () => {
    const files = extractRar4(archive());
    expect([...files.keys()]).toEqual(['first.txt', 'second.txt']);
    expect(files.get('first.txt')).toEqual(text('ABC'));
    expect(files.get('second.txt')).toEqual(text('ABCABC'));
    expect(() => extractRar4(archive(0x8010, 0))).toThrow('CRC mismatch for second.txt');
    expect(() => extractRar4(archive(0x8000))).toThrow();
});
