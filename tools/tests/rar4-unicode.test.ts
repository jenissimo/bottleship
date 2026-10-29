import { expect, test } from 'bun:test';
import { decodeRar4Name } from '../../packages/formats/src/rar/filename';
import { crc32 } from '../../packages/formats/src/installer/binary';
import { extractRar4, parseRar4 } from '@bottleship/formats/rar';
import { BufferSource } from '@bottleship/formats/unpack';

const ascii = (s: string) => [...new TextEncoder().encode(s)];
const name = (ansi: string, commands: number[]) => new Uint8Array([...ascii(ansi), 0, ...commands]);

test('RAR4 Unicode names decode all four commands, flag reloads and surrogate pairs', () => {
    // Low literal, common high byte, full UTF-16 literal, unmodified ANSI run.
    expect(decodeRar4Name(name('abcde', [4, 0x1b, 65, 0x16, 0x2d, 0x4e, 0]), true)).toBe('AЖ中de');
    // Corrected runs wrap the low byte and copy from the current output position.
    expect(decodeRar4Name(name('Az', [4, 0xc0, 0x80, 0xff]), true)).toBe('рѹ');
    // Four low literals consume one flag byte, then a second flag byte starts.
    expect(decodeRar4Name(name('abcde', [0, 0, 65, 66, 67, 68, 0, 69]), true)).toBe('ABCDE');
    expect(decodeRar4Name(name('xx', [0, 0xa0, 0x3d, 0xd8, 0x00, 0xde]), true)).toBe('😀');
});

test('RAR4 Unicode flag without a separator carries UTF-8; legacy names retain their encoding', () => {
    const utf8 = new TextEncoder().encode('Бука.iso');
    expect(decodeRar4Name(utf8, true)).toBe('Бука.iso');
    expect(decodeRar4Name(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), false)).toBe('café');
    expect(() => decodeRar4Name(new Uint8Array([0xc0, 0xaf]), true)).toThrow();
});

test('RAR4 Unicode names reject truncated commands and ANSI copy overruns', () => {
    for (const commands of [[], [4], [4, 0], [4, 0x40], [4, 0x80, 1], [4, 0xc0], [4, 0xc0, 0x80]]) {
        expect(() => decodeRar4Name(name('abc', commands), true)).toThrow();
    }
    expect(() => decodeRar4Name(name('x', [0, 0xc0, 0]), true)).toThrow('copy exceeds');
    expect(() => decodeRar4Name(name('x', [4, 0xc0, 0x80, 1]), true)).toThrow('copy exceeds');
});

function storedArchive(filename: Uint8Array, flags = 0x8200) {
    const u16 = (n: number) => [n & 255, (n >>> 8) & 255];
    const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
    const block = (type: number, flags: number, body: number[]) => {
        const tail = new Uint8Array([type, ...u16(flags), ...u16(body.length + 7), ...body]);
        return [...u16(crc32(tail) & 0xffff), ...tail];
    };
    const payload = new Uint8Array([1, 2, 3]);
    return new BufferSource(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0,
        ...block(0x73, 0, [0, 0, 0, 0, 0, 0]),
        ...block(0x74, flags, [...u32(payload.length), ...u32(payload.length), 2, ...u32(crc32(payload)),
            ...u32(0), 29, 0x30, ...u16(filename.length), ...u32(0), ...filename]),
        ...payload, ...block(0x7b, 0, [])]));
}

test('RAR4 extraction uses the Unicode destination and validates the decoded path', () => {
    const source = storedArchive(name('AB.iso', [4, 0x5c, 0x11, 0x12, 2]));
    expect(parseRar4(source).entries[0].name).toBe('БВ.iso');
    expect(extractRar4(source).get('БВ.iso')).toEqual(new Uint8Array([1, 2, 3]));
    const unsafe = ['../x', 'C:/x', '/x', 'a\0b'];
    for (const path of unsafe) {
        const codes: number[] = [0];
        for (let i = 0; i < path.length; i += 4) codes.push(0, ...ascii(path.slice(i, i + 4)));
        expect(() => parseRar4(storedArchive(name('safe', codes)))).toThrow('Unsafe');
    }
});
