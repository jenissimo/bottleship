import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { stopChildProcesses, type ChildBoot } from '../../src/worker/core/child-process';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { exports as fileApi } from '../../src/worker/modules/kernel32/file-io';
import { exports as processApi } from '../../src/worker/modules/kernel32/process/process';
import { Shell32 } from '../../src/worker/modules/shell32';
import { getVirtualProcessManager } from '../../src/worker/modules/kernel32/process/virtual-process-manager';
import type { ZipArchive, ZipEntry } from '@bottleship/formats/zip';

describe('file and child-process API contracts', () => {
    const system = System.getInstance();
    const manager = getVirtualProcessManager();
    let savedVfs: VirtualFileSystem;
    let savedProcess: typeof system.process;
    let lastError = 0;
    let errorDescriptor: PropertyDescriptor | undefined;
    const memory = new Uint8Array(8192);
    const hostGlobals = new Map<string, PropertyDescriptor | undefined>();
    const memProperties = new Map<string, PropertyDescriptor | undefined>();
    const workers: FakeWorker[] = [];
    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: unknown;
        onmessageerror: unknown;
        boot: ChildBoot | null = null;
        constructor() { workers.push(this); }
        postMessage(message: any) { if (message.type === 'child_boot') this.boot = message; }
        terminate() {}
        exit(code: number) { this.onmessage?.({ data: { type: 'process_exit', exitCode: code } }); }
    }
    function text(value: string, wide = false, at = 512) {
        if (wide) for (let i = 0; i < value.length; i++) new DataView(memory.buffer).setUint16(at + 2 * i, value.charCodeAt(i), true);
        else memory.set(new TextEncoder().encode(value), at);
        return at;
    }
    async function booted() {
        for (let i = 0; i < 100 && !workers[0]?.boot; i++) await Bun.sleep(1);
        expect(workers).toHaveLength(1);
        expect(workers[0]!.boot).not.toBeNull();
        return workers[0]!;
    }
    beforeEach(() => {
        savedVfs = system.fileSystem; savedProcess = system.process;
        lastError = 0;
        errorDescriptor = Object.getOwnPropertyDescriptor(system.scheduler, 'setLastError');
        const setLastError = system.scheduler.setLastError;
        system.scheduler.setLastError = code => { lastError = code; setLastError.call(system.scheduler, code); };
        memory.fill(0); workers.length = 0;
        for (const key of ['Worker', 'self']) hostGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
        Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: { location: { href: 'file:///guest-worker.js' } } });
        for (const key of ['memoryGetter', 'validateRange', 'getRegion']) memProperties.set(key, Object.getOwnPropertyDescriptor(Mem, key));
        Mem.bind(() => memory);
        system.process = undefined as never;
        system.fileSystem = new VirtualFileSystem();
        const bytes = new Uint8Array(256), header = new DataView(bytes.buffer);
        header.setUint16(0, 0x5a4d, true); header.setUint32(0x3c, 64, true);
        header.setUint32(64, 0x4550, true); header.setUint16(68, 0x14c, true);
        const entry = { name: 'rom/System/helper.exe', uncompressedSize: bytes.length,
            compressedSize: bytes.length, compression: 0, localHeaderOffset: 0, isDirectory: false } as ZipEntry;
        system.fileSystem.mountRom({ readEntryRangeSync: (_: unknown, off: number, size: number) => bytes.slice(off, off + size),
            readEntryRange: async (_: unknown, off: number, size: number) => bytes.slice(off, off + size),
        } as unknown as ZipArchive, 'rom', new Map([['system/helper.exe', entry]]));
    });
    afterEach(async () => {
        await stopChildProcesses(); manager.reset();
        system.fileSystem = savedVfs; system.process = savedProcess;
        if (errorDescriptor) Object.defineProperty(system.scheduler, 'setLastError', errorDescriptor);
        else Reflect.deleteProperty(system.scheduler, 'setLastError');
        for (const [key, descriptor] of hostGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        for (const [key, descriptor] of memProperties) {
            if (descriptor) Object.defineProperty(Mem, key, descriptor);
            else Reflect.deleteProperty(Mem, key);
        }
    });
    for (const wide of [false, true]) test(`CreateFile${wide ? 'W' : 'A'} cannot create a missing detection output on read`, async () => {
        const path = 'C:\\System\\Detected.ini';
        const result = await fileApi[wide ? 'CreateFileW' : 'CreateFileA']!(undefined as never, memory,
            [text(path, wide), 0x80000000, 0, 0, 3, 0, 0]);
        expect((typeof result === 'number' ? result : result.value) >>> 0).toBe(0xffffffff);
        expect(lastError).toBe(2);
        expect(system.fileSystem.fileExists(path)).toBe(false);
    });
    test('CreateProcess fails with FILE_NOT_FOUND and zeroed handles for an absent image', async () => {
        memory.fill(0xff, 2048, 2064);
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [text('C:\\System\\absent.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(0);
        expect(lastError).toBe(2);
        expect([...memory.slice(2048, 2064)]).toEqual(Array(16).fill(0));
        expect(workers).toHaveLength(0);
    });
    test('CreateProcess executes a helper even when its arguments resemble a renderer probe', async () => {
        const image = 'C:\\System\\helper.exe';
        const parameters = 'testrendev=D3DDrv.D3DRenderDevice log=Detected.log';
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [text(image), text(parameters, false, 1024), 0, 0, 0, 0, 0, 0, 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe(image.toLowerCase());
        expect(worker.boot!.commandLine).toBe(parameters);
        expect(worker.boot!.bytes[0]).toBe(0x4d);
        expect(system.fileSystem.fileExists('C:\\System\\Detected.ini')).toBe(false);
        const handle = Mem.readUint32(2048)!;
        expect(system.resourceProvider.getKernelObject(handle)?.signaled).toBe(false);
        worker.exit(17);
        for (let i = 0; i < 100 && !system.resourceProvider.getKernelObject(handle)?.signaled; i++) await Bun.sleep(1);
        expect(system.resourceProvider.getKernelObject(handle)?.signaled).toBe(true);
        expect(manager.getExitCodeProcess(handle)).toBe(17);
    });
    test('ShellExecuteEx returns a waitable handle backed by the actual helper', async () => {
        const module = new Shell32(); module.initialize(undefined as never);
        const info = 2048;
        Mem.writeUint32(info, 60); Mem.writeUint32(info + 4, 0x40);
        Mem.writeUint32(info + 16, text('C:\\System\\helper.exe'));
        Mem.writeUint32(info + 20, text('testrendev=D3DDrv.D3DRenderDevice', false, 1024));
        const result = await module.exports.ShellExecuteExA!(undefined as never, memory, [info]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        const handle = Mem.readUint32(info + 56)!;
        expect(handle).not.toBe(0);
        const worker = await booted();
        expect(worker.boot!.commandLine).toBe('testrendev=D3DDrv.D3DRenderDevice');
        expect(manager.getExitCodeProcess(handle)).toBe(259);
        worker.exit(9);
        for (let i = 0; i < 100 && manager.getExitCodeProcess(handle) === 259; i++) await Bun.sleep(1);
        expect(manager.getExitCodeProcess(handle)).toBe(9);
    });
    test('ShellExecute cannot report a successful probe when the image is absent', async () => {
        const module = new Shell32(); module.initialize(undefined as never);
        const result = await module.exports.ShellExecuteA!(undefined as never, memory,
            [0, 0, text('C:\\System\\missing.exe'), text('testrendev=D3DDrv.D3DRenderDevice', false, 1024), 0, 0]);
        expect(typeof result === 'number' ? result : result.value).toBe(2);
        expect(workers).toHaveLength(0);
    });
});
