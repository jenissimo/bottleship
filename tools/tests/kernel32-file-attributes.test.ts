import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { VFS_FILETIME } from '../../src/worker/runtime/filesystem/file-time';
import { registerFileIoAttributeExports } from '../../src/worker/modules/kernel32/file-io-attributes';
import type { Process } from '../../src/worker/core/process';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';
import type { ZipArchive, ZipEntry } from '@bottleship/formats/zip';

const system = System.getInstance();
const originalProcess = system.process;
const originalVfs = system.fileSystem;
const originalSetError = system.scheduler.setLastError;
const memory = new Uint8Array(0x4000);
const exports: Record<string, ThunkImplementation> = {};
registerFileIoAttributeExports(exports);
let error = 0;
let writable = true;
beforeEach(() => {
    memory.fill(0x5a);
    error = 0;
    writable = true;
    const validate = (address: number, size: number, perms?: string) => address >= 0x1000
        && address + size <= memory.length && (perms !== 'rw' || writable);
    Mem.bind(() => memory, validate);
    system.process = { addressSpace: { validateRange: validate } } as unknown as Process;
    system.scheduler.setLastError = value => { error = value; };
    const vfs = new VirtualFileSystem();
    const name = 'bin/данные.dll';
    const entry = { name, uncompressedSize: 0x100000123, compressedSize: 0, compression: 0,
        localHeaderOffset: 0, isDirectory: false } as ZipEntry;
    vfs.mountRom(null as unknown as ZipArchive, '', new Map([[name, entry]]));
    system.fileSystem = vfs;
});
afterEach(() => {
    system.process = originalProcess;
    system.fileSystem = originalVfs;
    system.scheduler.setLastError = originalSetError;
});
function call(name: string, wide = true, level = 0, output = 0x2000) {
    if (wide) {
        for (let i = 0; i <= name.length; i++) {
            new DataView(memory.buffer).setUint16(0x1000 + i * 2, i < name.length ? name.charCodeAt(i) : 0, true);
        }
    } else memory.set(new TextEncoder().encode(name + '\0'), 0x1000);
    return exports[wide ? 'GetFileAttributesExW' : 'GetFileAttributesExA'](null as never, memory,
        [0x1000, level, output]);
}

test('Unicode file metadata has the full 64-bit size, common timestamps and exact struct extent', () => {
    expect(call('C:\\BIN\\ДАННЫЕ.DLL')).toBe(1);
    const view = new DataView(memory.buffer);
    expect(view.getUint32(0x2000, true)).toBe(0x20);
    for (const offset of [4, 12, 20]) expect(view.getBigUint64(0x2000 + offset, true)).toBe(VFS_FILETIME);
    expect(view.getUint32(0x201c, true)).toBe(1);
    expect(view.getUint32(0x2020, true)).toBe(0x123);
    expect(memory[0x1fff]).toBe(0x5a);
    expect(memory[0x2024]).toBe(0x5a);
});

test('ANSI directory metadata has the directory bit and zero size', () => {
    expect(call('C:\\bin', false)).toBe(1);
    expect(Mem.readUint32(0x2000)).toBe(0x10);
    expect(Mem.readUint32(0x201c)).toBe(0);
    expect(Mem.readUint32(0x2020)).toBe(0);
});

test('missing file and missing parent report distinct errors without modifying the output', () => {
    expect(call('C:\\bin\\absent.dll')).toBe(0);
    expect(error).toBe(2);
    expect(call('C:\\absent\\file.dll')).toBe(0);
    expect(error).toBe(3);
    expect(memory.subarray(0x2000, 0x2024).every(value => value === 0x5a)).toBe(true);
});

test('invalid info levels and invalid or protected output ranges fail before writing', () => {
    expect(call('C:\\bin', true, 1)).toBe(0);
    expect(error).toBe(87);
    expect(call('C:\\bin', true, 0, 0)).toBe(0);
    expect(error).toBe(998);
    expect(call('C:\\bin', true, 0, 0x3ff0)).toBe(0);
    expect(error).toBe(998);
    writable = false;
    expect(call('C:\\bin')).toBe(0);
    expect(error).toBe(998);
    expect(memory.subarray(0x2000, 0x2024).every(value => value === 0x5a)).toBe(true);
});
