import {expect, test} from 'bun:test';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {System} from '../../src/worker/core/system';
import {registerFileIoPathExports} from '../../src/worker/modules/kernel32/file-io-path';
import type {ThunkImplementation} from '../../src/worker/core/thunking/thunk-dispatcher';

test('Unicode long paths report WCHAR capacity, preserve in-place input and fail missing names', () => {
    const mem = new Uint8Array(0x8000); Mem.bind(() => mem);
    const exports: Record<string, ThunkImplementation> = {};
    registerFileIoPathExports(exports);
    const system = System.getInstance(), vfs = system.fileSystem;
    const original = vfs.fileExists;
    const originalDir = vfs.directoryExists;
    const originalError = system.scheduler.setLastError;
    let error = 0;
    system.scheduler.setLastError = value => {error = value};
    const path = 'C:\\games\\日本.dat';
    vfs.fileExists = p => p === path;
    vfs.directoryExists = () => false;
    const call = (input: number, output: number, capacity: number) => exports.GetLongPathNameW(null as any, mem, [input, output, capacity]);
    const write = (s: string) => {for (let i = 0; i <= s.length; i++) Mem.writeUint16(0x1000 + 2 * i, i < s.length ? s.charCodeAt(i) : 0)};
    try {
        write(path); mem.fill(0xa5, 0x2000, 0x2100);
        expect(call(0x1000, 0, 0)).toBe(path.length + 1);
        expect(call(0x1000, 0x2000, path.length)).toBe(path.length + 1);
        expect(mem[0x2000]).toBe(0xa5);
        expect(call(0x1000, 0x1000, path.length + 1)).toBe(path.length);
        expect(Mem.readUint16(0x1000 + 2 * path.length)).toBe(0);
        write('C:\\missing.dat');
        expect(call(0x1000, 0x2000, 128)).toBe(0);
        expect(error).toBe(2);
    } finally {vfs.fileExists = original; vfs.directoryExists = originalDir; system.scheduler.setLastError = originalError}
});

test('A/W full path names distinguish drive-relative C:. from an absolute path', () => {
    const mem = new Uint8Array(0x8000); Mem.bind(() => mem);
    const exports: Record<string, ThunkImplementation> = {};
    registerFileIoPathExports(exports);
    const vfs = System.getInstance().fileSystem, original = vfs.currentDir;
    vfs.currentDir = 'C:\\games\\';
    try {
        for (const wide of [false, true]) {
            for (const [input, expected] of [['C:.', 'C:\\games'], ['C:..\\save.dat', 'C:\\save.dat'], ['C:\\abs\\save.dat', 'C:\\abs\\save.dat'], ['D:.', 'D:\\']]) {
                for (let i = 0; i <= input.length; i++) {
                    const c = i < input.length ? input.charCodeAt(i) : 0;
                    if (wide) Mem.writeUint16(0x1000 + i * 2, c); else Mem.writeUint8(0x1000 + i, c);
                }
                const name = wide ? 'GetFullPathNameW' : 'GetFullPathNameA';
                expect(exports[name](null as any, mem, [0x1000, 256, 0x2000, 0])).toBe(expected.length);
                let result = '';
                for (let i = 0; i < expected.length; i++) result += String.fromCharCode(wide ? Mem.readUint16(0x2000 + i * 2) : Mem.readUint8(0x2000 + i));
                expect(result).toBe(expected);
            }
        }
    } finally {vfs.currentDir = original}
});
