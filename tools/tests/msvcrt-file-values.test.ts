/** Wide stdio and word I/O at the ABI boundary: WEOF compares as 0xffff and _getw/_putw
 * move 32-bit words. Not native differential evidence. */
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import { Msvcrt } from '../../src/worker/modules/msvcrt';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { EmulatorConfig } from '../../src/worker/core/emulator-config-manager';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { msvcrtModule } from '../../src/worker/api/msvcrt.api';
import { installFakeOpfs } from './fixtures/fake-opfs';
import type { ZipArchive } from '@bottleship/formats/zip';

let crt: any, vfs: VirtualFileSystem, mem: Uint8Array, errno: number;
let saved: Record<string, unknown>, previousNavigator: unknown, previousCp: number;
let seq = 0;
const result = async (r: any) => { const x = await r; return typeof x === 'number' ? x : x.value; };
async function open(bytes: number[] = [], mode = 'w+b'): Promise<number> {
    const handle = vfs.openSync('C:\\values.bin', 0xc0000000, 2)!;
    if (bytes.length) vfs.writeSync(handle, Uint8Array.from(bytes));
    vfs.setPosition(handle, 0, 0);
    crt.fds.set(3, handle);
    return crt.createFileStream(3, handle, mode);
}
function contents(fp: number): number[] {
    const h = vfs.duplicateHandle(crt.fileStreams.get(fp).handle);
    vfs.setPosition(h, 0, 0);
    return Array.from(vfs.readSync(h, 4096)!);
}
beforeEach(async () => {
    const system = System.getInstance() as any;
    saved = { fileSystem: system.fileSystem, process: system.process, registry: system.registry, onProcessExit: system.onProcessExit, exitNotified: system.exitNotified, isReExecPending: system.isReExecPending };
    previousNavigator = globalThis.navigator;
    previousCp = EmulatorConfig.getInstance().ansiCodePage;
    installFakeOpfs();
    vfs = new VirtualFileSystem();
    vfs.mountRom(null as unknown as ZipArchive, 'rom', new Map());
    await vfs.initOverlay(`test:crt-values-${++seq}`);
    mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    let heap = 0x1000;
    errno = 0;
    crt = Object.create(Msvcrt.prototype);
    Object.assign(crt, { fileStreams: new Map(), temporaryFiles: new Map(), fds: new Map(),
        useRealFileStructs: false, currentLocale: 'C', tempnamCounter: 0, fdNext: 3,
        malloc: (n: number) => { const p = heap; heap += n; return p; },
        free: () => {}, setErrno: (n: number) => { errno = n; return true; },
        memset: (p: number, c: number, n: number) => mem.fill(c, p, p + n),
    });
    system.fileSystem = vfs;
    system.process = { modules: new Map([['msvcrt', crt]]) };
    system.registry = { flush: async () => {}, serialize: () => ({ gameId: null }), reset: () => {} };
    system.exitNotified = false;
    system.isReExecPending = false;
});
afterEach(async () => {
    await crt.cleanupProcessFiles();
    await vfs.flushAll();
    Object.assign(System.getInstance(), saved);
    (globalThis as any).navigator = previousNavigator;
    EmulatorConfig.getInstance().ansiCodePage = previousCp;
});

describe('CRT binary integers and wide stdio', () => {
    test('declarations are cdecl and use actual argument counts', () => {
        for (const [name, count] of Object.entries({ _getw: 1, _putw: 2, fgetwc: 1, fputwc: 2, ungetwc: 2, tmpfile: 0 })) {
            const f = msvcrtModule.functions.find(f => f.name === name)!;
            expect(f.callingConvention).toBe('cdecl');
            expect(f.params.length).toBe(count);
        }
    });
    test('_putw/_getw round-trip signed unaligned 32-bit integers and distinguish valid -1 from EOF', async () => {
        const fp = await open([0xaa]);
        crt.fseek(fp, 1, 0);
        expect(await result(crt.writeFileValue(0x12345678, fp, false))).toBe(0x12345678);
        expect(await result(crt.writeFileValue(-1, fp, false))).toBe(-1);
        expect(crt.ferror_fn(fp)).toBe(0);
        expect(contents(fp)).toEqual([0xaa, 0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff]);
        crt.fseek(fp, 1, 0);
        expect(await result(crt.readFileValue(fp, false))).toBe(0x12345678);
        expect(await result(crt.readFileValue(fp, false))).toBe(-1);
        expect(crt.ferror_fn(fp)).toBe(0);
        expect(await result(crt.readFileValue(fp, false))).toBe(-1);
        expect(crt.feof_fn(fp)).toBe(1);
        expect(crt.ferror_fn(fp)).toBe(0);
    });
    test('partial integer consumes remaining bytes and sets EOF', async () => {
        const fp = await open([1, 2, 3]);
        expect(await result(crt.readFileValue(fp, false))).toBe(-1);
        expect(crt.ftell(fp)).toBe(3);
        expect(crt.feof_fn(fp)).toBe(1);
    });
    test('wide binary mode uses little-endian 16-bit units including NUL and returns 16-bit WEOF', async () => {
        const fp = await open();
        for (const ch of [0x41, 0, 0x20ac, 0xd800]) expect(await result(crt.writeFileValue(ch, fp, true))).toBe(ch);
        expect(contents(fp)).toEqual([0x41, 0, 0, 0, 0xac, 0x20, 0, 0xd8]);
        crt.fseek(fp, 0, 0);
        for (const ch of [0x41, 0, 0x20ac, 0xd800]) expect(await result(crt.readFileValue(fp, true))).toBe(ch);
        expect(await result(crt.readFileValue(fp, true))).toBe(0xffff);
        expect(crt.feof_fn(fp)).toBe(1);
    });
    test('wide C text mode is byte identity, translates CRLF and observes Ctrl-Z', async () => {
        const fp = await open([0x80, 13, 10, 0x1a, 0x42], 'r+t');
        expect(await result(crt.readFileValue(fp, true))).toBe(0x80); // not Windows CP1252 euro
        expect(await result(crt.readFileValue(fp, true))).toBe(10);
        expect(await result(crt.readFileValue(fp, true))).toBe(0xffff);
        expect(crt.feof_fn(fp)).toBe(1);
        crt.fseek(fp, 0, 0);
        expect(await result(crt.writeFileValue(10, fp, true))).toBe(10);
        expect(contents(fp).slice(0, 2)).toEqual([13, 10]);
        expect(await result(crt.writeFileValue(0x20ac, fp, true))).toBe(0xffff);
        expect(errno).toBe(42);
        expect(crt.ferror_fn(fp)).toBe(1);
    });
    test('named CP932 wide text reads and writes a multibyte character', async () => {
        const fp = await open([0x82, 0xa0], 'r+t');
        crt.currentLocale = 'Japanese_Japan.932';
        EmulatorConfig.getInstance().ansiCodePage = 932;
        expect(await result(crt.readFileValue(fp, true))).toBe(0x3042);
        expect(await result(crt.writeFileValue(0x3044, fp, true))).toBe(0x3044);
        expect(contents(fp)).toEqual([0x82, 0xa0, 0x82, 0xa2]);
    });
    test('ungetwc clears EOF, leaves external storage unchanged, and seek discards pushback', async () => {
        const fp = await open([65, 0]);
        expect(crt.ungetwc(66, fp)).toBe(0xffff); // no read yet
        expect(await result(crt.readFileValue(fp, true))).toBe(65);
        expect(await result(crt.readFileValue(fp, true))).toBe(0xffff);
        expect(crt.ungetwc(0x20ac, fp)).toBe(0x20ac);
        expect(crt.feof_fn(fp)).toBe(0);
        expect(crt.ungetwc(67, fp)).toBe(0xffff);
        expect(await result(crt.readFileValue(fp, true))).toBe(0x20ac);
        expect(contents(fp)).toEqual([65, 0]);
        expect(crt.ungetwc(68, fp)).toBe(68);
        crt.fseek(fp, 0, 0);
        expect(await result(crt.readFileValue(fp, true))).toBe(65);
        expect(crt.ungetwc(0xffff, fp)).toBe(0xffff);
    });
    test('cold wide reads await data with cdecl cleanup; I/O errors set error instead of EOF', async () => {
        const fp = await open([0x34, 0x12]);
        const originalRead = vfs.readSync.bind(vfs);
        vfs.readSync = () => null;
        vfs.read = async (h, n) => originalRead(h, n)!;
        const pending = crt.readFileValue(fp, true);
        expect(pending).toBeInstanceOf(Promise);
        expect(await pending).toEqual({ value: 0x1234, stackCleanup: 0 });
        crt.fseek(fp, 0, 0);
        vfs.read = async () => { throw new Error('I/O failed'); };
        expect(await crt.readFileValue(fp, true)).toEqual({ value: 0xffff, stackCleanup: 0 });
        expect(crt.ferror_fn(fp)).toBe(1);
        expect(crt.feof_fn(fp)).toBe(0);
    });
    test('async writes report short writes as errors with cdecl cleanup', async () => {
        const fp = await open();
        vfs.writeSync = () => -1;
        vfs.write = async () => 1;
        expect(await crt.writeFileValue(0x1234, fp, true)).toEqual({ value: 0xffff, stackCleanup: 0 });
        expect(crt.ferror_fn(fp)).toBe(1);
        expect(errno).toBe(5);
    });
    test('fsetpos clears wide pushback and EOF while preserving stream errors', async () => {
        const fp = await open([65, 0]);
        expect(crt.fgetpos(fp, 0x100)).toBe(0);
        expect(await result(crt.readFileValue(fp, true))).toBe(65);
        expect(crt.ungetwc(90, fp)).toBe(90);
        expect(crt.fsetpos(fp, 0x100)).toBe(0);
        expect(await result(crt.readFileValue(fp, true))).toBe(65);
        expect(await result(crt.readFileValue(fp, true))).toBe(0xffff);
        crt.fileStreams.get(fp).err = true;
        expect(crt.fsetpos(fp, 0x100)).toBe(0);
        expect(crt.feof_fn(fp)).toBe(0);
        expect(crt.ferror_fn(fp)).toBe(1);
        expect(await result(crt.readFileValue(fp, true))).toBe(65);
    });
});

describe('tmpfile ownership and lifecycle', () => {
    test('unique CREATE_NEW binary streams preserve existing files and delete on close', async () => {
        const existing = vfs.openSync('C:\\s0.tmp', 0xc0000000, 2)!;
        vfs.writeSync(existing, new Uint8Array([99]));
        const fp = crt.tmpfile();
        const path = crt.fileStreams.get(fp).handle.path;
        expect(path).not.toBe('C:\\s0.tmp');
        expect(crt.fileStreams.get(fp).text).toBe(false);
        expect(await result(crt.writeFileValue(0x12345678, fp, false))).toBe(0x12345678);
        expect(vfs.fileExists(path)).toBe(true);
        expect(await crt.fclose(fp)).toEqual({ value: 0, stackCleanup: 0 });
        expect(vfs.fileExists(path)).toBe(false);
        vfs.setPosition(existing, 0, 0);
        expect(vfs.readSync(existing, 1)![0]).toBe(99);
    });
    test('close and shutdown cleanup can overlap without double deletion', async () => {
        const fp = crt.tmpfile(), path = crt.fileStreams.get(fp).handle.path;
        let release!: () => void, deletes = 0;
        const gate = new Promise<void>(r => { release = r; });
        const originalDelete = vfs.deleteFile.bind(vfs);
        vfs.deleteFile = async (p, identity) => { deletes++; await gate; return originalDelete(p, identity); };
        const close = crt.fclose(fp), cleanup = crt.cleanupProcessFiles();
        await Promise.resolve();
        release();
        expect(await result(close)).toBe(0);
        await cleanup;
        expect(deletes).toBe(1);
        expect(vfs.fileExists(path)).toBe(false);
    });
    test('deletion failure is reported and remains retryable', async () => {
        const fp = crt.tmpfile(), path = crt.fileStreams.get(fp).handle.path;
        const originalDelete = vfs.deleteFile.bind(vfs);
        vfs.deleteFile = async () => { throw new Error('synthetic denied delete'); };
        expect(await result(crt.fclose(fp))).toBe(-1);
        expect(errno).toBe(5);
        expect(crt.temporaryFiles.has(path)).toBe(true);
        vfs.deleteFile = originalDelete;
        await crt.cleanupProcessFiles();
        expect(vfs.fileExists(path)).toBe(false);
    });
    test('process-exit notification waits for tracked temporary deletion', async () => {
        const system = System.getInstance();
        const fp = crt.tmpfile(), path = crt.fileStreams.get(fp).handle.path;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const originalDelete = vfs.deleteFile.bind(vfs);
        vfs.deleteFile = async (p, identity) => { await gate; return originalDelete(p, identity); };
        let notified = false;
        let done!: () => void;
        const finished = new Promise<void>(r => { done = r; });
        system.onProcessExit = () => { notified = true; done(); };
        system.postProcessExitWhenDurable({ exitCode: 0 });
        await Promise.resolve(); await Promise.resolve();
        expect(notified).toBe(false);
        release();
        await finished;
        expect(vfs.fileExists(path)).toBe(false);
    });
    test('reset awaits module cleanup before unmounting VFS', async () => {
        const fp = crt.tmpfile(), path = crt.fileStreams.get(fp).handle.path;
        const unmount = vfs.reset;
        vfs.reset = () => {
            expect(vfs.fileExists(path)).toBe(false);
            throw new Error('test reached reset after cleanup');
        };
        await expect(System.getInstance().reset()).rejects.toThrow('test reached reset after cleanup');
        vfs.reset = unmount;
    });
    test('closing another stream at the temporary pathname does not inherit cleanup ownership', async () => {
        const original = crt.tmpfile();
        const path = crt.fileStreams.get(original).handle.path;
        const other = crt.fopenPath(path, 'rb');
        expect(other).not.toBe(0);
        expect(await result(crt.fclose(other))).toBe(0);
        expect(vfs.fileExists(path)).toBe(true);
        expect(await result(crt.writeFileValue(65, original, true))).toBe(65);
        expect(await result(crt.fclose(original))).toBe(0);
        expect(vfs.fileExists(path)).toBe(false);
    });
});
