import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { Marshaler } from '../../src/worker/core/memory/marshaler';
import { stopChildProcesses, type ChildBoot } from '../../src/worker/core/child-process';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { exports as processApi } from '../../src/worker/modules/kernel32/process/process';
import {
    adoptProcessStartupInfo, resetProcessStartupInfo,
    STARTF_USESHOWWINDOW, STARTUPINFO_OFFSETS, STARTUPINFO_SIZE,
} from '../../src/worker/core/process-startup-info';
import type { ZipArchive, ZipEntry } from '@bottleship/formats/zip';

// STARTUPINFO carries the parent's window state to the child. These cases drive the
// real CreateProcessA/WinExec entry points and read the structure back the way a child
// does, through GetStartupInfoA on the message it received.
describe('STARTUPINFO across a process start', () => {
    const system = System.getInstance();
    const memory = new Uint8Array(16384);
    // Fixed addresses for the harness, all clear of each other.
    const COMMAND_LINE = 512;
    const TITLE = 700;
    const DESKTOP = 760;
    const PROCESS_INFO = 2048;
    const CALLER_INFO = 4096;
    const CHILD_INFO = 3600;
    let savedVfs: VirtualFileSystem;
    let savedProcess: typeof system.process;
    let savedExecutablePath: string;
    let nextAlloc = 0;
    const workers: FakeWorker[] = [];
    // The harness swaps the host worker boundary and binds Mem to its own image. Both
    // are process-wide, so they have to go back exactly as they were or the next file
    // to run sees a worker that cannot post and a memory that is not its own.
    const hostGlobals = new Map<string, PropertyDescriptor | undefined>();
    const memProperties = new Map<string, PropertyDescriptor | undefined>();

    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: unknown;
        onmessageerror: unknown;
        boot: ChildBoot | null = null;
        terminated = false;
        constructor() { workers.push(this); }
        postMessage(message: any) {
            if (message.type === 'child_boot') {
                this.boot = message;
                queueMicrotask(() => this.onmessage?.({ data: { type: 'child_ready', bootId: this.boot!.bootId, processId: this.boot!.processIdentity!.pid } }));
            }
        }
        terminate() { this.terminated = true; }
    }

    function text(value: string, at: number): number {
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

    /** The structure a caller builds: window state, with optional desktop/title strings. */
    function callerInfo(wShowWindow: number, strings: { title?: string; desktop?: string } = {}): number {
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        memory.fill(0, CALLER_INFO, CALLER_INFO + STARTUPINFO_SIZE);
        view.setUint32(CALLER_INFO + STARTUPINFO_OFFSETS.cb, STARTUPINFO_SIZE, true);
        view.setUint32(CALLER_INFO + STARTUPINFO_OFFSETS.dwFlags, STARTF_USESHOWWINDOW, true);
        view.setUint16(CALLER_INFO + STARTUPINFO_OFFSETS.wShowWindow, wShowWindow, true);
        if (strings.title) view.setUint32(CALLER_INFO + STARTUPINFO_OFFSETS.lpTitle, text(strings.title, TITLE), true);
        if (strings.desktop) view.setUint32(CALLER_INFO + STARTUPINFO_OFFSETS.lpDesktop, text(strings.desktop, DESKTOP), true);
        return CALLER_INFO;
    }

    async function booted(): Promise<ChildBoot> {
        for (let i = 0; i < 100 && !workers[0]?.boot; i++) await Bun.sleep(1);
        expect(workers).toHaveLength(1);
        expect(workers[0]!.boot).not.toBeNull();
        return workers[0]!.boot!;
    }

    beforeEach(() => {
        savedVfs = system.fileSystem; savedProcess = system.process;
        savedExecutablePath = system.executablePath;
        memory.fill(0); workers.length = 0; nextAlloc = 8000;
        resetProcessStartupInfo();
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
        // Every allocation is a distinct address: WinExec allocates two structures and
        // must not have them land on top of each other.
        system.process = { memory: { alloc: () => { const at = nextAlloc; nextAlloc += 256; return at; }, free: () => {} }, environment: [] } as never;
        system.fileSystem = new VirtualFileSystem();
        mountRom(new Map<string, ZipEntry>([['system/helper.exe', peEntry('system/helper.exe')]]));
    });

    afterEach(async () => {
        // Put the host boundary back first: tearing the child processes down can create
        // services, and those must not see the fake worker or the fake image.
        for (const [key, descriptor] of hostGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await stopChildProcesses();
        system.fileSystem = savedVfs; system.process = savedProcess;
        system.executablePath = savedExecutablePath;
        for (const [key, descriptor] of memProperties) {
            if (descriptor) Object.defineProperty(Mem, key, descriptor);
            else Reflect.deleteProperty(Mem, key);
        }
        resetProcessStartupInfo();
    });

    test('the child reads back the window state its parent passed', async () => {
        const info = callerInfo(7 /* SW_SHOWMINNOACTIVE */, { title: 'main window', desktop: 'winsta0\\default' });
        const result = await processApi.CreateProcessA!(undefined as never, memory,
            [0, text('C:\\System\\helper.exe -probe', COMMAND_LINE), 0, 0, 0, 0, 0, 0, info, PROCESS_INFO]);
        expect(typeof result === 'number' ? result : result.value).toBe(1);
        const boot = await booted();
        expect(boot.startupInfo?.dwFlags).toBe(STARTF_USESHOWWINDOW);
        expect(boot.startupInfo?.wShowWindow).toBe(7);
        // The strings travel as text, not as pointers into the parent's memory.
        expect(boot.startupInfo?.title).toBe('main window');
        expect(boot.startupInfo?.desktop).toBe('winsta0\\default');

        adoptProcessStartupInfo(boot.startupInfo);
        expect(processApi.GetStartupInfoA!(undefined as never, memory, [CHILD_INFO]).value).toBe(0);
        expect(Mem.readUint32(CHILD_INFO + STARTUPINFO_OFFSETS.cb)).toBe(STARTUPINFO_SIZE);
        expect(Mem.readUint32(CHILD_INFO + STARTUPINFO_OFFSETS.dwFlags)).toBe(STARTF_USESHOWWINDOW);
        expect(Mem.readUint16(CHILD_INFO + STARTUPINFO_OFFSETS.wShowWindow)).toBe(7);
        expect(Marshaler.readString(memory, Mem.readUint32(CHILD_INFO + STARTUPINFO_OFFSETS.lpTitle))).toBe('main window');
    });

    test('WinExec folds uCmdShow into the child STARTUPINFO', async () => {
        // SW_HIDE. The value is what a launcher passes to start a program silently.
        const result = await processApi.WinExec!(undefined as never, memory, [text('C:\\System\\helper.exe', COMMAND_LINE), 0]);
        expect((typeof result === 'number' ? result : result.value) >>> 0).toBe(33);
        const boot = await booted();
        expect(boot.startupInfo?.dwFlags).toBe(STARTF_USESHOWWINDOW);
        expect(boot.startupInfo?.wShowWindow).toBe(0);
    });

    test('a process booted directly still gets the zeroed structure', () => {
        resetProcessStartupInfo();
        expect(processApi.GetStartupInfoW!(undefined as never, memory, [CHILD_INFO]).value).toBe(0);
        // cb is filled in, as it is for an Explorer launch; nothing else is.
        expect(Mem.readUint32(CHILD_INFO + STARTUPINFO_OFFSETS.cb)).toBe(STARTUPINFO_SIZE);
        expect(Mem.readUint32(CHILD_INFO + STARTUPINFO_OFFSETS.dwFlags)).toBe(0);
        expect(Mem.readUint16(CHILD_INFO + STARTUPINFO_OFFSETS.wShowWindow)).toBe(0);
        expect(Mem.readUint32(CHILD_INFO + STARTUPINFO_OFFSETS.lpTitle)).toBe(0);
    });
});
