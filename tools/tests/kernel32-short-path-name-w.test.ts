import {expect, test} from 'bun:test';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {System} from '../../src/worker/core/system';
import {registerFileIoPathExports} from '../../src/worker/modules/kernel32/file-io-path';
import type {ThunkImplementation} from '../../src/worker/core/thunking/thunk-dispatcher';

test('GetShortPathNameW echoes an existing path and fails a missing one', () => {
    const mem = new Uint8Array(0x8000); Mem.bind(() => mem);
    const exports: Record<string, ThunkImplementation> = {};
    registerFileIoPathExports(exports);
    const system = System.getInstance(), vfs = system.fileSystem;
    const original = vfs.fileExists, originalDir = vfs.directoryExists, originalError = system.scheduler.setLastError;
    let error = 0;
    system.scheduler.setLastError = value => {error = value};
    const path = 'C:\\Game\\Qfg2vga.exe';
    vfs.fileExists = p => p === path;
    vfs.directoryExists = () => false;
    const call = (input: number, output: number, capacity: number) => exports.GetShortPathNameW(null as any, mem, [input, output, capacity]);
    const write = (s: string) => {for (let i = 0; i <= s.length; i++) Mem.writeUint16(0x1000 + 2 * i, i < s.length ? s.charCodeAt(i) : 0)};
    const read = (at: number) => {let s = ''; for (let c; (c = Mem.readUint16(at + 2 * s.length));) s += String.fromCharCode(c); return s};
    try {
        write(path);
        expect(call(0x1000, 0, 0)).toBe(path.length + 1);
        expect(call(0x1000, 0x2000, 260)).toBe(path.length);
        expect(read(0x2000)).toBe(path);
        write('C:\\Game\\missing.exe');
        expect(call(0x1000, 0x2000, 260)).toBe(0);
        expect(error).toBe(2);
    } finally {vfs.fileExists = original; vfs.directoryExists = originalDir; system.scheduler.setLastError = originalError}
});
