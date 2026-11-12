// SBCS behaviour of the msvcrt _mbs*/_mbc* helpers against Wine dlls/msvcrt/mbcs.c and the
// MS CRT reference: under a single-byte code page every one of them is its str*/is* twin.
import { beforeEach, expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { registerCrtMbExports } from '../../src/worker/modules/crt-mb';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { msvcrtModule } from '../../src/worker/api/msvcrt.api';

let memory: Uint8Array;
let exports: Record<string, ThunkImplementation>;
let codepage = 0;
const calls: Array<[number, number]> = [];
const call = (name: string, ...args: number[]) => exports[name]!(null as never, memory, args) as number;
// "C" locale ctype for the bytes this test classifies: letters are _ALPHA|_UPPER/_LOWER.
const ctype = (ch: number): number => {
    if (ch >= 0x41 && ch <= 0x5a) return 0x0101;
    if (ch >= 0x61 && ch <= 0x7a) return 0x0102;
    if (ch >= 0x30 && ch <= 0x39) return 0x0004;
    return 0;
};
beforeEach(() => {
    memory = new Uint8Array(4096);
    Mem.bind(() => memory);
    exports = {};
    codepage = 0;
    calls.length = 0;
    registerCrtMbExports(exports, {
        readCString: () => { throw new Error('not used'); },
        compareCString: () => { throw new Error('not used'); },
        ischartype: (ch, mask) => { calls.push([ch, mask]); return (ctype(ch & 0xff) & mask) !== 0 ? 1 : 0; },
        setMbcp: cp => { codepage = cp; return 0; }, getMbcp: () => codepage,
    });
    memory.set([0x41, 0xe9, 0], 256);
});

test('_ismbcalpha is bound as a cdecl one-argument export', () => {
    const r = APIRegistry.getInstance(); r.registerModule(msvcrtModule);
    expect(r.getCallingConvention('msvcrt', '_ismbcalpha')).toBe('cdecl');
    expect(r.getArgCount('msvcrt', '_ismbcalpha')).toBe(1);
});

test('_ismbcalpha classifies a single byte like isalpha (_ALPHA)', () => {
    expect(call('_ismbcalpha', 0x41)).toBe(1);
    expect(call('_ismbcalpha', 0x7a)).toBe(1);
    expect(call('_ismbcalpha', 0x35)).toBe(0);
    expect(call('_ismbcalpha', 0x20)).toBe(0);
    expect(calls[0]).toEqual([0x41, 0x0103]);
});

test('_ismbcalpha: no SBCS code page has a double-byte character', () => {
    // 0x141 must not be truncated to 'A'.
    expect(call('_ismbcalpha', 0x141)).toBe(0);
    codepage = 932;
    expect(() => call('_ismbcalpha', 0x8260)).toThrow('DBCS');
    expect(call('_ismbcalpha', 0x41)).toBe(1);
});

test('_mbsinc steps one byte, the terminator included (str + _mbclen(str))', () => {
    expect(call('_mbsinc', 256)).toBe(257);
    expect(call('_mbsinc', 257)).toBe(258);
    expect(call('_mbsinc', 258)).toBe(259);
    expect(call('_mbsinc', 0)).toBe(0);
});

test('_mbclen is 1 for every single byte, NUL included', () => {
    expect(call('_mbclen', 256)).toBe(1);
    expect(call('_mbclen', 257)).toBe(1);
    expect(call('_mbclen', 258)).toBe(1);
});

test('_mbsninc never steps past the terminator, unlike _mbsinc', () => {
    expect(call('_mbsninc', 256, 1)).toBe(257);
    expect(call('_mbsninc', 256, 3)).toBe(258);
    expect(call('_mbsninc', 258, 5)).toBe(258);
});
