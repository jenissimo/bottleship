import {expect, test} from 'bun:test';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {Msvcrt} from '../../src/worker/modules/msvcrt';
import {System} from '../../src/worker/core/system';
import {msvcrtModule} from '../../src/worker/api/msvcrt.api';
import type {ZipArchive, ZipEntry} from '@bottleship/formats/zip';

test('_wopen preserves UTF-16 paths and uses the normal CRT descriptor lifecycle', () => {
    const mem = new Uint8Array(0x8000);
    Mem.bind(() => mem);
    const crt = new Msvcrt() as any;
    crt.process = {v86: {mem8: mem}};
    crt.errnoAddr = 0x200;
    const vfs = System.getInstance().fileSystem;
    vfs.reset();
    const path = 'C:\\save\\сохранение-日本.dat';
    const bytes = new Uint8Array([1, 2, 3]);
    const entry: ZipEntry = {name: path.slice(3).replaceAll('\\', '/'), compressedSize: 3,
        uncompressedSize: 3, compression: 0, localHeaderOffset: 0, isDirectory: false};
    const archive = {readEntryRangeSync: (_e: ZipEntry, off: number, len: number) => bytes.subarray(off, off + len)} as unknown as ZipArchive;
    vfs.mountRom(archive, 'rom', new Map([[entry.name.toLowerCase(), entry]]));
    for (let i = 0; i < path.length; i++) Mem.writeUint16(0x1000 + i * 2, path.charCodeAt(i));
    const fd = crt.open(0x1000, 0x8000, true); // O_RDONLY | O_BINARY
    expect(fd).toBeGreaterThan(2);
    const handle = crt.fds.get(fd);
    expect(handle.path.toLowerCase()).toBe(path.toLowerCase());
    expect(vfs.readSync(handle, 3)).toEqual(bytes);
    expect(crt.filelength(fd)).toBe(3);
    expect(crt.close(fd)).toBe(0);
    expect(crt.filelength(fd)).toBe(-1);
    expect(Mem.readUint32(0x200)).toBe(9); // EBADF
    Mem.writeUint16(0x1000, 'X'.charCodeAt(0));
    expect(crt.open(0x1000, 0x8000, true)).toBe(-1);
    expect(Mem.readUint32(0x200)).toBe(2); // ENOENT
    expect(msvcrtModule.functions.find(f => f.name === '_wopen')?.callingConvention).toBe('cdecl');
    vfs.reset();
});
