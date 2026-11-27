import {expect, test} from 'bun:test';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {System} from '../../src/worker/core/system';
import {registerFileIoPathExports} from '../../src/worker/modules/kernel32/file-io-path';
import {exports as fileIo} from '../../src/worker/modules/kernel32/file-io';
import type {ThunkImplementation} from '../../src/worker/core/thunking/thunk-dispatcher';

const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_NAME = 123;

test('an empty name is not the current directory for GetFileAttributes and GetFullPathName', () => {
    const mem = new Uint8Array(0x8000); Mem.bind(() => mem);
    const pathExports: Record<string, ThunkImplementation> = {};
    registerFileIoPathExports(pathExports);
    const system = System.getInstance(), vfs = system.fileSystem;
    const originalCurrent = vfs.currentDir;
    const originalDir = vfs.directoryExists;
    const originalError = system.scheduler.setLastError;
    let error = 0;
    system.scheduler.setLastError = value => {error = value};
    vfs.currentDir = 'C:\\games\\';
    vfs.directoryExists = path => /^c:\\games\\?$/i.test(path);
    try {
        Mem.writeUint16(0x1000, 0);
        mem.fill(0xa5, 0x2000, 0x2100);
        for (const name of ['GetFileAttributesA', 'GetFileAttributesW']) {
            error = 0;
            expect(fileIo[name](null as any, mem, [0x1000]) >>> 0).toBe(INVALID_FILE_ATTRIBUTES);
            expect(error).toBe(ERROR_PATH_NOT_FOUND);
        }
        for (const name of ['GetFullPathNameA', 'GetFullPathNameW']) {
            error = 0;
            expect(pathExports[name](null as any, mem, [0x1000, 256, 0x2000, 0])).toBe(0);
            expect(error).toBe(ERROR_INVALID_NAME);
            expect(mem[0x2000]).toBe(0xa5);
        }
        Mem.writeUint8(0x1000, 0x2e); Mem.writeUint8(0x1001, 0);
        expect(fileIo.GetFileAttributesA(null as any, mem, [0x1000]) >>> 0).toBe(0x10);
        expect(pathExports.GetFullPathNameA(null as any, mem, [0x1000, 256, 0x2000, 0])).toBe('C:\\games'.length);
    } finally {
        vfs.currentDir = originalCurrent;
        vfs.directoryExists = originalDir;
        system.scheduler.setLastError = originalError;
    }
});
