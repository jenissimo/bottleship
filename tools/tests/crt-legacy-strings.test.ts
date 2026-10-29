import { beforeEach, afterEach, test, expect } from 'bun:test';
import { Msvcrt } from '../../src/worker/modules/msvcrt';
import { msvcrtModule } from '../../src/worker/api/msvcrt.api';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { System } from '../../src/worker/core/system';

let mem: Uint8Array, view: DataView, crt: any, process: any, thread: any, oldScheduler: any;
const main = { id: 1 },
    worker = { id: 2 };
const call = (name: string, ...args: number[]) => crt.exports[name]({}, mem, args);
function wide(text: string, pointer = 0x100): number {
    for (let i = 0; i < text.length; i++) view.setUint16(pointer + i * 2, text.charCodeAt(i), true);
    view.setUint16(pointer + text.length * 2, 0, true);
    return pointer;
}
function readWide(pointer: number): string {
    let out = '';
    for (let at = pointer; view.getUint16(at, true); at += 2)
        out += String.fromCharCode(view.getUint16(at, true));
    return out;
}
const narrow = (text: string, pointer = 0x400) => {
    mem.set(new TextEncoder().encode(text + '\0'), pointer);
    return pointer;
};
const readNarrow = (pointer: number) =>
    new TextDecoder().decode(mem.subarray(pointer, mem.indexOf(0, pointer)));
beforeEach(() => {
    const system = System.getInstance();
    oldScheduler = system.scheduler;
    thread = main;
    system.scheduler = { getCurrentThread: () => thread, isMainThread: (id: number) => id === 1 } as never;
    mem = new Uint8Array(0x20000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    let heap = 0x2000;
    process = {
        resetGeneration: 0,
        environment: new Map(),
        memory: {
            alloc: (size: number) => {
                const p = heap;
                heap += size;
                return p;
            },
        },
    };
    crt = new Msvcrt();
    crt.registerDataExports = () => {};
    crt.initialize(process);
});
afterEach(() => {
    System.getInstance().scheduler = oldScheduler;
});

test('original three imports have real cdecl implementations and correct argument counts', () => {
    for (const [name, count] of [
        ['_strerror', 1],
        ['wcsncat', 3],
        ['_ultow', 3],
    ] as const) {
        const entry = msvcrtModule.functions.find(f => f.name === name)!;
        expect(entry.callingConvention).toBe('cdecl');
        expect(entry.params).toHaveLength(count);
        expect(typeof crt.exports[name]).toBe('function');
    }
});
test('dmloader 260-WCHAR path append counts source characters and leaves one terminator', () => {
    const path = 'C:\\game\\',
        source = 'Data\\Music\\opening.sgt';
    wide(path);
    wide(source, 0x600);
    mem.fill(0xa5, 0x100 + (path.length + source.length + 1) * 2, 0x400);
    expect(call('wcsncat', 0x100, 0x600, 259 - path.length)).toBe(0x100);
    expect(readWide(0x100)).toBe(path + source);
    expect(mem[0x100 + (path.length + source.length + 1) * 2]).toBe(0xa5);
});
test('wcsncat reads no character beyond count and handles raw UTF16 code units', () => {
    wide('A');
    view.setUint16(0x600, 0xd83d, true);
    view.setUint16(0x602, 0xde00, true);
    Mem.bind(
        () => mem,
        (p, n, perms) => !(perms === 'r' && p < 0x606 && p + n > 0x602)
    );
    expect(call('wcsncat', 0x100, 0x600, 1)).toBe(0x100);
    expect(view.getUint16(0x102, true)).toBe(0xd83d);
    expect(view.getUint16(0x104, true)).toBe(0);
});
test('wcsncat zero count touches neither source nor destination, early NUL does not pad', () => {
    Mem.bind(
        () => mem,
        () => false
    );
    expect(call('wcsncat', 0x1234, 0, 0)).toBe(0x1234);
    Mem.bind(() => mem);
    wide('dest');
    wide('', 0x600);
    mem.fill(0xa5, 0x10a, 0x120);
    expect(call('wcsncat', 0x100, 0x600, 0xffffffff)).toBe(0x100);
    expect(readWide(0x100)).toBe('dest');
    expect(mem[0x10a]).toBe(0xa5);
});
test('wide operations reject inaccessible memory and insufficient actual destination memory', () => {
    wide('x');
    wide('y', 0x600);
    Mem.bind(
        () => mem,
        (p, n, perms) => !(perms === 'w' && p < 0x104 && p + n > 0x102)
    );
    expect(() => call('wcsncat', 0x100, 0x600, 1)).toThrow('invalid guest write');
    Mem.bind(() => mem);
    expect(() => call('wcsncat', 0x100, 0, 1)).toThrow('invalid guest read');
    view.setUint16(mem.length - 2, 0, true);
    expect(() => call('wcsncat', mem.length - 2, 0x600, 1)).toThrow('invalid guest write');
    expect(() => call('_ultow', 0xffffffff, mem.length - 2, 10)).toThrow('invalid guest write');
});
test('_ultow retains unsigned32 semantics in every supported radix and writes only result plus NUL', () => {
    for (const [value, radix, want] of [
        [-1, 10, '4294967295'],
        [-1, 16, 'ffffffff'],
        [0x80000000, 10, '2147483648'],
        [0, 2, '0'],
        [35, 36, 'z'],
        [-1, 2, '1'.repeat(32)],
    ] as const) {
        mem.fill(0xa5, 0x100, 0x200);
        expect(call('_ultow', value, 0x100, radix)).toBe(0x100);
        expect(readWide(0x100)).toBe(want);
        expect(mem[0x100 + (want.length + 1) * 2]).toBe(0xa5);
    }
    for (const radix of [0, 1, 37, -1])
        expect(() => call('_ultow', 1, 0x100, radix)).toThrow('invalid radix');
});
test('_strerror uses current errno, narrow byte prefix and the legacy newline', () => {
    crt.setErrno(2);
    const p = call('_strerror', 0);
    expect(readNarrow(p)).toBe('No such file or directory\n');
    expect(view.getInt32(call('_errno'), true)).toBe(2);
    expect(call('_strerror', narrow('load'))).toBe(p);
    expect(readNarrow(p)).toBe('load: No such file or directory\n');
    mem.set([0x80, 0xff, 0], 0x400);
    call('_strerror', 0x400);
    expect(Array.from(mem.slice(p, p + 4))).toEqual([0x80, 0xff, 58, 32]);
    call('_strerror', narrow(''));
    expect(readNarrow(p)).toBe('No such file or directory\n');
});
