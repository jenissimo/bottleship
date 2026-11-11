import { describe, expect, test } from 'bun:test';
import { Marshaler } from '../../src/worker/core/memory/marshaler';

// GDI's text calls take a counted string. Reading it must cost the count, not the distance
// to the next NUL: a caller that measures each line of a large text buffer passes a pointer
// into the middle of it, and scanning to the end per call made a 30 KB debug log quadratic.
describe('Marshaler.readStringN', () => {
    const mem = new Uint8Array(1 << 20);
    const put = (at: number, s: string) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); };

    test('reads exactly count bytes out of an unterminated run', () => {
        mem.fill(0x41, 0x100, mem.length);
        put(0x100, 'line one\nline two');
        expect(Marshaler.readStringN(mem, 0x100, 8)).toBe('line one');
        expect(Marshaler.readStringN(mem, 0x109, 8)).toBe('line two');
    });

    test('stops at a NUL inside the count', () => {
        mem.fill(0, 0x200, 0x300);
        put(0x200, 'abc');
        expect(Marshaler.readStringN(mem, 0x200, 10)).toBe('abc');
    });

    test('a zero count, a null pointer and the end of memory read nothing past their bound', () => {
        expect(Marshaler.readStringN(mem, 0x100, 0)).toBe('');
        expect(Marshaler.readStringN(mem, 0, 5)).toBe('');
        mem.fill(0x42, mem.length - 3);
        expect(Marshaler.readStringN(mem, mem.length - 3, 10)).toBe('BBB');
    });

    test('decodes the ANSI code page like readString', () => {
        mem.fill(0, 0x400, 0x410);
        mem.set([0x47, 0x72, 0xfc, 0xdf, 0x65], 0x400);
        expect(Marshaler.readStringN(mem, 0x400, 5)).toBe(Marshaler.readString(mem, 0x400));
    });
});
