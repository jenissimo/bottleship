import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { stopChildProcesses, type ChildBoot } from '../../src/worker/core/child-process';
import { closeProcessNetworkNamespace } from '../../src/worker/core/process-network';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { exports as processApi } from '../../src/worker/modules/kernel32/process/process';
import { exports as vistaSystem } from '../../src/worker/modules/kernel32/process/vista-system';
import { getVirtualProcessManager } from '../../src/worker/modules/kernel32/process/virtual-process-manager';
import type { ZipArchive, ZipEntry } from '@bottleship/formats/zip';

describe('CreateProcess image lookup for a bare command line', () => {
    const system = System.getInstance();
    let savedVfs: VirtualFileSystem;
    let savedProcess: typeof system.process;
    let savedExecutablePath: string;
    let lastError = 0;
    let errorDescriptor: PropertyDescriptor | undefined;
    const memory = new Uint8Array(8192);
    const hostGlobals = new Map<string, PropertyDescriptor | undefined>();
    const memProperties = new Map<string, PropertyDescriptor | undefined>();
    const workers: FakeWorker[] = [];
    let autoReady = true;
    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: unknown;
        onmessageerror: unknown;
        boot: ChildBoot | null = null;
        messages: any[] = [];
        terminated = false;
        constructor() { workers.push(this); }
        postMessage(message: any) {
            this.messages.push(message);
            if (message.type === 'child_boot') {
                this.boot = message;
                if (autoReady) queueMicrotask(() => this.ready());
            }
        }
        ready() { this.onmessage?.({ data: { type: 'child_ready', bootId: this.boot!.bootId, processId: this.boot!.processIdentity!.pid } }); }
        terminate() { this.terminated = true; }
        exit(code: number) { this.onmessage?.({ data: { type: 'process_exit', exitCode: code } }); }
    }
    function text(value: string, at = 512) {
        memory.set(new TextEncoder().encode(value), at);
        return at;
    }
    function peEntry(name: string, at = 0): ZipEntry {
        const bytes = new Uint8Array(256), header = new DataView(bytes.buffer);
        header.setUint16(0, 0x5a4d, true); header.setUint32(0x3c, 64, true);
        header.setUint32(64, 0x4550, true); header.setUint16(68, 0x14c, true);
        header.setUint32(64 + 24 + 28, 0x400000, true); header.setUint32(64 + 24 + 56, 0x2000, true);
        return { name, uncompressedSize: bytes.length, compressedSize: bytes.length,
            compression: 0, localHeaderOffset: at, isDirectory: false } as ZipEntry;
    }
    function mountRom(index: Map<string, ZipEntry>): void {
        system.fileSystem.mountRom({ readEntryRangeSync: (_: unknown, off: number, size: number) => new Uint8Array(256).slice(off, off + size),
            readEntryRange: async (_: unknown, off: number, size: number) => new Uint8Array(256).slice(off, off + size),
        } as unknown as ZipArchive, 'rom', index);
    }
    async function booted() {
        for (let i = 0; i < 100 && !workers[0]?.boot; i++) await Bun.sleep(1);
        expect(workers).toHaveLength(1);
        expect(workers[0]!.boot).not.toBeNull();
        return workers[0]!;
    }
    beforeEach(() => {
        savedVfs = system.fileSystem; savedProcess = system.process;
        savedExecutablePath = system.executablePath;
        errorDescriptor = Object.getOwnPropertyDescriptor(system.scheduler, 'setLastError');
        const setLastError = system.scheduler.setLastError;
        system.scheduler.setLastError = code => { lastError = code; setLastError.call(system.scheduler, code); };
        memory.fill(0); workers.length = 0; autoReady = true;
        for (const key of ['Worker', 'self']) hostGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        const RealWorker = globalThis.Worker;
        class WorkerBoundary extends FakeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
                if (String(url).includes('wsa-actor-worker')) return new RealWorker(url, options) as unknown as WorkerBoundary;
                super();
            }
        }
        Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: WorkerBoundary });
        Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: { location: { href: 'file:///guest-worker.js' } } });
        for (const key of ['memoryGetter', 'validateRange', 'getRegion']) memProperties.set(key, Object.getOwnPropertyDescriptor(Mem, key));
        Mem.bind(() => memory);
        system.process = undefined as never;
        system.fileSystem = new VirtualFileSystem();
        mountRom(new Map<string, ZipEntry>([
            ['system/helper.exe', peEntry('system/helper.exe')],
            ['prog files/tool.exe', peEntry('prog files/tool.exe', 512)],
            ['prog  files/deep tool.exe', peEntry('prog  files/deep tool.exe', 512)],
            ['data/helper.exe', peEntry('data/helper.exe')],
            ['system/my.app/helper.exe', peEntry('system/my.app/helper.exe', 768)],
        ]));
    });
    afterEach(async () => {
        for (const [key, descriptor] of hostGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await stopChildProcesses(); await closeProcessNetworkNamespace();
        system.fileSystem = savedVfs; system.process = savedProcess;
        system.executablePath = savedExecutablePath;
        if (errorDescriptor) Object.defineProperty(system.scheduler, 'setLastError', errorDescriptor);
        else Reflect.deleteProperty(system.scheduler, 'setLastError');
        for (const [key, descriptor] of memProperties) {
            if (descriptor) Object.defineProperty(Mem, key, descriptor);
            else Reflect.deleteProperty(Mem, key);
        }
    });

    test('WinExec appends .exe to an extensionless image name', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        const result = await processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper -probe'), 1]);
        expect((typeof result === 'number' ? result : result.value) >>> 0).toBeGreaterThan(31);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe('c:\\system\\helper.exe');
        expect(worker.boot!.commandLine).toBe('-probe');
    });

    test('WinExec finds a pathless image through PATH', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: new Map([['PATH', 'C:\\System']]) } as never;
        const result = await processApi.WinExec!(undefined as never, memory, [text('helper -probe'), 1]);
        expect((typeof result === 'number' ? result : result.value) >>> 0).toBeGreaterThan(31);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe('c:\\system\\helper.exe');
        expect(worker.boot!.commandLine).toBe('-probe');
    });

    test('CreateProcess with lpApplicationName = NULL finds a pathless image through PATH', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: new Map([['PATH', 'C:\\System']]) } as never;
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('helper.exe'), 0, 0, 0, 0, 0, 0, 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe('c:\\system\\helper.exe');
        expect(worker.boot!.commandLine).toBe('');
    });

    test('an unquoted path with spaces is tried prefix by prefix', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        const result = await processApi.WinExec!(undefined as never, memory, [text('C:\\prog files\\tool.exe -run'), 1]);
        expect((typeof result === 'number' ? result : result.value) >>> 0).toBeGreaterThan(31);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe('c:\\prog files\\tool.exe');
        expect(worker.boot!.commandLine).toBe('-run');
    });

    test('WinExec reports a missing directory as ERROR_PATH_NOT_FOUND', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        const result = await processApi.WinExec!(undefined as never, memory, [text('C:\\Missing\\Dir\\x.exe'), 1]);
        expect(typeof result === 'number' ? result : result.value).toBe(3);
        expect(lastError).toBe(3);
        expect(workers).toHaveLength(0);
    });

    test('WinExec treats a switch argument as an argument, not a path', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        // "setup /S" has no setup.exe anywhere, so the answer is ERROR_FILE_NOT_FOUND.
        // Deciding path-vs-file from every prefix would read the "/S" prefix as the
        // path "setup " and report ERROR_PATH_NOT_FOUND instead.
        const result = await processApi.WinExec!(undefined as never, memory, [text('setup /S'), 1]);
        expect(typeof result === 'number' ? result : result.value).toBe(2);
        expect(lastError).toBe(2);
        expect(workers).toHaveLength(0);
    });

    test('lpCurrentDirectory is passed to the child but is not part of the image search', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        // helper.exe exists only in C:\System, which is where lpCurrentDirectory
        // points. Searching it would start the child; Windows searches the parent's
        // current directory instead and reports ERROR_FILE_NOT_FOUND.
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('helper.exe', 600), 0, 0, 0, 0, 0, text('C:\\System', 700), 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(0);
        expect(lastError).toBe(2);
        expect(workers).toHaveLength(0);
    });

    test('a pathless image is searched in the parent current directory and the child still gets lpCurrentDirectory', async () => {
        system.fileSystem.currentDir = 'C:\\Data';
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('helper.exe', 600), 0, 0, 0, 0, 0, text('C:\\Nowhere', 700), 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe('c:\\data\\helper.exe');
        // lpCurrentDirectory only travels through to the child.
        expect(worker.boot!.currentDirectory).toBe('C:\\Nowhere');
    });

    test('a failed child start maps the recorded error instead of always ERROR_BAD_FORMAT', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        autoReady = false;
        const pending = Promise.resolve(processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper.exe'), 1]));
        const worker = await booted();
        worker.onmessage?.({ data: { type: 'error', message: 'child loader failed' } });
        const result = await pending;
        expect(typeof result === 'number' ? result : result.value).toBe(11); // ERROR_BAD_FORMAT, from the child's 193
        await stopChildProcesses();
        expect(worker.terminated).toBe(true);
    });

    test('a failed child start that reports its own code has that code mapped', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        autoReady = false;
        const pending = Promise.resolve(processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper.exe'), 1]));
        const worker = await booted();
        // The child knows its failure was a missing directory, not a bad image.
        // Hard-coding ERROR_BAD_FORMAT would turn this into 11; mapping the
        // recorded code keeps WinExec's answer equal to CreateProcess's.
        worker.onmessage?.({ data: { type: 'error', message: 'child loader failed', win32Error: 3 } });
        const result = await pending;
        expect(typeof result === 'number' ? result : result.value).toBe(3); // ERROR_PATH_NOT_FOUND
        expect(lastError).toBe(3);
        await stopChildProcesses();
        expect(worker.terminated).toBe(true);
    });

    test('a failure code below 32 is WinExec’s answer as it is', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        autoReady = false;
        const pending = Promise.resolve(processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper.exe'), 1]));
        const worker = await booted();
        // Access denied is a failure WinExec passes through unchanged: the docs read any
        // value under 32 as the GetLastError of the failed CreateProcess, so reporting
        // 0 ("out of memory or resources") would name a cause that never happened.
        worker.onmessage?.({ data: { type: 'error', message: 'child loader failed', win32Error: 5 } });
        const result = await pending;
        expect(typeof result === 'number' ? result : result.value).toBe(5); // ERROR_ACCESS_DENIED
        expect(lastError).toBe(5);
        await stopChildProcesses();
    });

    test('a failure code of 32 or more is not a WinExec answer and becomes ERROR_BAD_FORMAT', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        autoReady = false;
        const pending = Promise.resolve(processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper.exe'), 1]));
        const worker = await booted();
        // A code of 32 or more would read as success, so WinExec substitutes its own
        // ERROR_BAD_FORMAT for it, as Wine's WinExec does.
        worker.onmessage?.({ data: { type: 'error', message: 'child loader failed', win32Error: 87 } });
        const result = await pending;
        expect(typeof result === 'number' ? result : result.value).toBe(11);
        expect(lastError).toBe(87);
        await stopChildProcesses();
    });

    test('a failure code that is not a reported Win32 error is not adopted as one', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        autoReady = false;
        const pending = Promise.resolve(processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper.exe'), 1]));
        const worker = await booted();
        // A DOMException carries a legacy numeric `code` (NotFoundError is 8). Reading
        // a duck-typed field would report GetLastError 8 for a VFS failure that never
        // was a Win32 error; only the dedicated field counts, so this stays 193.
        worker.onmessage?.({ data: { type: 'error', message: 'child loader failed', code: 8 } });
        const result = await pending;
        expect(typeof result === 'number' ? result : result.value).toBe(11); // ERROR_BAD_FORMAT, from 193
        expect(lastError).toBe(193);
        await stopChildProcesses();
        worker.terminated = false;
    });

    test('a child that reports code 0 falls back instead of failing with GetLastError 0', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        autoReady = false;
        const pending = Promise.resolve(processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper.exe'), 1]));
        const worker = await booted();
        // 0 is not a report: CreateProcess cannot fail with GetLastError 0, so a
        // failure that reports nothing usable reads as the bad-image code.
        worker.onmessage?.({ data: { type: 'error', message: 'child loader failed', win32Error: 0 } });
        const result = await pending;
        expect(typeof result === 'number' ? result : result.value).toBe(11);
        expect(lastError).toBe(193);
        await stopChildProcesses();
    });

    test('a directory written with a run of spaces is tried as written', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        // The two spaces are part of the directory name: Windows takes the prefix from
        // the line as written. Rebuilding it with a single separator would probe
        // `c:\prog files\deep tool.exe` and miss the file that is actually there.
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('C:\\prog  files\\deep tool.exe -x'), 0, 0, 0, 0, 0, 0, 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe('c:\\prog  files\\deep tool.exe');
        expect(worker.boot!.commandLine).toBe('-x');
    });

    test('a process is named after the image the lookup resolved, not the first word', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('C:\\prog files\\tool.exe -x'), 0, 0, 0, 0, 0, 0, 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        await booted();
        // `C:\prog` is only the first prefix the walk tried; the process runs tool.exe,
        // and that is the name a task list has to show.
        const handle = Mem.readUint32(2048);
        expect(getVirtualProcessManager().describeProcessHandle(handle)?.imageName).toBe('tool.exe');
    });

    test('QueryFullProcessImageNameW reports the image the lookup resolved', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('C:\\prog files\\tool.exe -x'), 0, 0, 0, 0, 0, 0, 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        await booted();
        // The Toolhelp snapshot calls this child tool.exe, so the query that names its
        // image has to agree with it instead of re-reading the line's first word.
        Mem.writeUint32(3000, 260);
        const ok = vistaSystem.QueryFullProcessImageNameW!(undefined as never, memory,
            [Mem.readUint32(2048), 0, 3400, 3000]);
        expect(typeof ok === 'number' ? ok : ok.value).toBe(1);
        let named = '';
        for (let i = 0; i < 260; i++) {
            const c = Mem.readUint16(3400 + i * 2);
            if (!c) break;
            named += String.fromCharCode(c);
        }
        expect(named).toBe('C:\\prog files\\tool.exe');
    });

    test('an extensionless module after a dotted directory gets .exe appended', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        // `C:/System/my.app/helper` has no extension on the module name, but the dot
        // in the directory reads as one when only a backslash ends the search.
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('C:/System/my.app/helper'), 0, 0, 0, 0, 0, 0, 0, 2048]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        const worker = await booted();
        expect(worker.boot!.imagePath.toLowerCase()).toBe('c:\\system\\my.app\\helper.exe');
    });

    test('an image that exists but holds nothing fails the launch instead of waiting', async () => {
        system.process = { memory: { alloc: () => 3072, free: () => {} }, environment: [] } as never;
        mountRom(new Map<string, ZipEntry>([
            ['system/empty.exe', { name: 'system/empty.exe', uncompressedSize: 0, compressedSize: 0,
                compression: 0, localHeaderOffset: 0, isDirectory: false } as ZipEntry],
        ]));
        const result = await processApi.WinExec!(undefined as never, memory, [text('C:\\System\\empty.exe'), 1]);
        // CreateProcess records 193 for a file that is not a Win32 image; WinExec's own
        // answer for it is ERROR_BAD_FORMAT, and the thread sees the 193 it recorded.
        expect(typeof result === 'number' ? result : result.value).toBe(11);
        expect(lastError).toBe(193);
        expect(workers).toHaveLength(0);
    });
});
