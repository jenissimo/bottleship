import { beforeEach, expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { registerCrtMbExports } from '../../src/worker/modules/crt-mb';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { msvcrtModule } from '../../src/worker/api/msvcrt.api';

let memory: Uint8Array;
let exports: Record<string, ThunkImplementation>;
let codepage = 0;
const call = (name: string, ...args: number[]) => exports[name]!(null as never, memory, args) as number;
beforeEach(() => {
    memory = new Uint8Array(4096);
    Mem.bind(() => memory);
    exports = {};
    codepage = 0;
    registerCrtMbExports(exports, {
        readCString: () => { throw new Error('not used'); },
        compareCString: () => { throw new Error('not used'); },
        ischartype: () => 0, setMbcp: cp => { codepage = cp; return 0; }, getMbcp: () => codepage,
    });
    memory.set([65, 0xe9, 90, 0, 88, 0], 256);
});

test('imported counted helpers have cdecl ABI', () => {
    const r = APIRegistry.getInstance(); r.registerModule(msvcrtModule);
    for (const [name, argc] of [['_mbslen', 1], ['_mbsnbcnt', 2], ['_mbsnccnt', 2],
        ['_mbsninc', 2], ['_mbsncpy', 3], ['_mbsncmp', 3], ['_mbsnbcat', 3]] as const) {
        expect(r.getCallingConvention('msvcrt', name)).toBe('cdecl');
        expect(r.getArgCount('msvcrt', name)).toBe(argc);
    }
});
test('SBCS counts include high bytes and stop at NUL and count boundaries', () => {
    expect(call('_mbslen', 256)).toBe(3);
    for (const name of ['_mbsnbcnt', '_mbsnccnt']) {
        expect(call(name, 256, 2)).toBe(2);
        expect(call(name, 256, 20)).toBe(3);
        expect(call(name, 0, 0)).toBe(0);
    }
    expect(call('_mbsninc', 256, 2)).toBe(258);
    expect(call('_mbsninc', 256, 20)).toBe(259);
    expect(call('_mbsninc', 0, 20)).toBe(0);
});
test('counted copy pads only the requested region; exact length does not terminate', () => {
    memory.fill(0xcc, 511, 521);
    expect(call('_mbsncpy', 512, 256, 2)).toBe(512);
    expect([...memory.slice(511, 516)]).toEqual([0xcc, 65, 0xe9, 0xcc, 0xcc]);
    expect(call('_mbsncpy', 512, 256, 6)).toBe(512);
    expect([...memory.slice(511, 519)]).toEqual([0xcc, 65, 0xe9, 90, 0, 0, 0, 0xcc]);
    call('_mbsncpy', 512, 0, 0);
    expect(memory[512]).toBe(65);
});
test('comparison is unsigned and bounded, including bytes after embedded NUL', () => {
    memory.set([65, 0xea, 90, 0], 512);
    expect(call('_mbsncmp', 256, 512, 1)).toBe(0);
    expect(call('_mbsncmp', 256, 512, 2)).toBeLessThan(0);
    expect(call('_mbsncmp', 512, 256, 2)).toBeGreaterThan(0);
    memory.set([65, 0xe9, 90, 0, 89], 512);
    expect(call('_mbsncmp', 256, 512, 8)).toBe(0);
    expect(call('_mbsncmp', 0, 0, 0)).toBe(0);
});
test('bounded concatenation always terminates and leaves following bytes untouched', () => {
    memory.fill(0xcc, 512, 530); memory.set([66, 0], 512);
    expect(call('_mbsnbcat', 512, 256, 2)).toBe(512);
    expect([...memory.slice(512, 518)]).toEqual([66, 65, 0xe9, 0, 0xcc, 0xcc]);
    call('_mbsnbcat', 512, 256, 20);
    expect([...memory.slice(512, 520)]).toEqual([66, 65, 0xe9, 65, 0xe9, 90, 0, 0xcc]);
});
test('unsupported DBCS cannot silently use SBCS semantics', () => {
    codepage = 932;
    for (const name of ['_mbslen', '_mbsnbcnt', '_mbsnccnt', '_mbsninc', '_mbsncpy', '_mbsncmp', '_mbsnbcat'])
        expect(() => call(name, 256, 512, 2)).toThrow('DBCS');
});
test('invalid guest ranges do not become successful truncation or false NUL', () => {
    expect(() => call('_mbslen', 0)).toThrow('invalid guest pointer');
    expect(() => call('_mbsncpy', 0, 256, 2)).toThrow('invalid guest destination');
    memory[4095] = 65;
    expect(() => call('_mbslen', 4095)).toThrow('invalid guest pointer');
    expect(() => call('_mbsnbcat', 4095, 256, 1)).toThrow('invalid guest pointer');
});
