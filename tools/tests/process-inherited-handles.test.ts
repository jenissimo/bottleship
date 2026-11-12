// CreateProcess(bInheritHandles = TRUE) across two real processes: this test is the parent
// (kernel32 in this realm), the child is a real worker (fixtures/inherited-handles-child.ts)
// with its own handle table, joined to the parent by the same process-IPC port a child
// worker gets at boot. The shape is the Reflexive Arcade monitor's (Alice Greenfingers):
// the launcher passes its own process handle and the game's process handle by VALUE,
// and the monitor waits on them.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { stopChildProcesses, type ChildBoot } from '../../src/worker/core/child-process';
import { closeProcessNetworkNamespace } from '../../src/worker/core/process-network';
import { currentProcessId } from '../../src/worker/core/process-identity';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { exports as processApi } from '../../src/worker/modules/kernel32/process/process';
import { exports as syncApi } from '../../src/worker/modules/kernel32/sync';
import { getVirtualProcessManager } from '../../src/worker/modules/kernel32/process/virtual-process-manager';
import { resetInheritedHandleState } from '../../src/worker/modules/kernel32/inherited-handles';
import type { ZipArchive, ZipEntry } from '@bottleship/formats/zip';

const WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x102;
const ctx = { esp: 0 } as never;
const value = (result: unknown) => (typeof result === 'number' ? result : (result as { value: number }).value) >>> 0;

describe('inherited handles across a real child process', () => {
    const system = System.getInstance();
    const manager = getVirtualProcessManager();
    const memory = new Uint8Array(8192);
    const view = new DataView(memory.buffer);
    const workers: FakeWorker[] = [];
    const hostGlobals = new Map<string, PropertyDescriptor | undefined>();
    const memProperties = new Map<string, PropertyDescriptor | undefined>();
    let savedVfs: VirtualFileSystem;
    let savedProcess: typeof system.process;
    let child: Worker | null = null;

    /** The parent's view of a child worker: it only needs to boot and, on demand, exit. */
    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: unknown; onmessageerror: unknown;
        boot: ChildBoot | null = null;
        terminated = false;
        constructor() { workers.push(this); }
        postMessage(message: any) {
            if (message.type !== 'child_boot') return;
            this.boot = message;
            queueMicrotask(() => this.onmessage?.({ data: { type: 'child_ready', bootId: message.bootId, processId: message.processIdentity.pid } }));
        }
        terminate() { this.terminated = true; }
        exit(code: number) { this.onmessage?.({ data: { type: 'process_exit', exitCode: code } }); }
    }

    function text(value: string, at = 512) { memory.set(new TextEncoder().encode(value + '\0'), at); return at; }
    /** SECURITY_ATTRIBUTES { nLength = 12, lpSecurityDescriptor = NULL, bInheritHandle } */
    function securityAttributes(at: number, inherit: boolean) {
        view.setUint32(at, 12, true); view.setUint32(at + 4, 0, true); view.setUint32(at + 8, inherit ? 1 : 0, true);
        return at;
    }
    async function createProcess(inheritHandles: boolean, processAttributes: number, at: number) {
        const ok = value(await processApi.CreateProcessA!(ctx, memory,
            [text('C:\\System\\helper.exe'), 0, processAttributes, 0, inheritHandles ? 1 : 0, 0, 0, 0, 0, at]));
        expect(ok).toBe(1);
        return { hProcess: view.getUint32(at, true), hThread: view.getUint32(at + 4, true), pid: view.getUint32(at + 8, true), worker: workers.at(-1)! };
    }
    /** One request/response round with the child worker. */
    function ask<T = any>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
        return new Promise((resolve, reject) => {
            child!.onmessage = event => event.data.type === 'failed' ? reject(new Error(event.data.error)) : resolve(event.data);
            child!.postMessage(message, transfer);
        });
    }

    beforeEach(() => {
        savedVfs = system.fileSystem; savedProcess = system.process;
        memory.fill(0); workers.length = 0;
        for (const key of ['Worker', 'self']) hostGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        const RealWorker = globalThis.Worker;
        class WorkerBoundary extends FakeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
                if (String(url).includes('wsa-actor-worker') || String(url).includes('inherited-handles-child')) {
                    return new RealWorker(url, options) as unknown as WorkerBoundary;
                }
                super();
            }
        }
        Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: WorkerBoundary });
        Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: { location: { href: 'file:///guest-worker.js' } } });
        for (const key of ['memoryGetter', 'validateRange', 'getRegion']) memProperties.set(key, Object.getOwnPropertyDescriptor(Mem, key));
        Mem.bind(() => memory);
        system.process = undefined as never;
        system.fileSystem = new VirtualFileSystem();
        const bytes = new Uint8Array(256), header = new DataView(bytes.buffer);
        header.setUint16(0, 0x5a4d, true); header.setUint32(0x3c, 64, true);
        header.setUint32(64, 0x4550, true); header.setUint16(68, 0x14c, true);
        header.setUint32(64 + 24 + 28, 0x400000, true); header.setUint32(64 + 24 + 56, 0x2000, true);
        const entry = { name: 'rom/System/helper.exe', uncompressedSize: bytes.length,
            compressedSize: bytes.length, compression: 0, localHeaderOffset: 0, isDirectory: false } as ZipEntry;
        system.fileSystem.mountRom({ readEntryRangeSync: (_: unknown, off: number, size: number) => bytes.slice(off, off + size),
            readEntryRange: async (_: unknown, off: number, size: number) => bytes.slice(off, off + size),
        } as unknown as ZipArchive, 'rom', new Map([['system/helper.exe', entry]]));
    });
    afterEach(async () => {
        child?.terminate(); child = null;
        for (const [key, descriptor] of hostGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await stopChildProcesses(); await closeProcessNetworkNamespace(); manager.reset(); resetInheritedHandleState();
        system.scheduler.syncObjects.reset();
        system.fileSystem = savedVfs; system.process = savedProcess;
        for (const [key, descriptor] of memProperties) {
            if (descriptor) Object.defineProperty(Mem, key, descriptor);
            else Reflect.deleteProperty(Mem, key);
        }
    });

    test('a child waits on an inherited event and process handles by value, and sees the parent signal them', async () => {
        const inheritable = securityAttributes(4000, true);
        // The objects the parent hands down. CreateEvent with bInheritHandle = TRUE ...
        const manual = value(syncApi.CreateEventA!(ctx, memory, [inheritable, 1, 0, 0]));
        const auto = value(syncApi.CreateEventA!(ctx, memory, [inheritable, 0, 0, 0]));
        // ... one it does not mark inheritable ...
        const privateEvent = value(syncApi.CreateEventA!(ctx, memory, [0, 1, 0, 0]));
        // ... its own process handle, the way a launcher passes "me" to a watchdog ...
        const self = value(processApi.OpenProcess!(ctx, memory, [0x1f0fff, 1, currentProcessId]));
        expect(self).not.toBe(0);
        // ... and one of its own threads (what DuplicateHandle(GetCurrentThread()) yields; the
        // Reflexive wrapper passes exactly that as WRAPPER_HANDLE).
        const mainThread = system.resourceProvider.registerKernelObject({ kind: 'thread', threadId: 1 },
            { grantedAccess: 0x1f03ff, flags: 1 });
        // ... and two children started with an inheritable process handle (lpProcessAttributes).
        const game = await createProcess(false, inheritable, 2048);
        const victim = await createProcess(false, inheritable, 2100);
        expect(game.worker.boot!.inheritedHandles ?? []).toEqual([]); // bInheritHandles = FALSE inherits nothing

        const monitor = await createProcess(true, 0, 2200);
        const specs = monitor.worker.boot!.inheritedHandles!;
        const carried = specs.map(spec => spec.handle).sort((a, b) => a - b);
        expect(carried).toEqual([manual, auto, self, mainThread, game.hProcess, victim.hProcess].sort((a, b) => a - b));
        expect(carried).not.toContain(privateEvent);
        expect(carried).not.toContain(monitor.hProcess); // the child never inherits its own handles

        child = new Worker(new URL('./fixtures/inherited-handles-child.ts', import.meta.url).href, { type: 'module' });
        const boot = monitor.worker.boot!;
        const adopted = await ask({ type: 'boot', identity: boot.processIdentity, port: boot.ipcPort, specs }, [boot.ipcPort!]);
        expect(adopted.adopted).toBe(specs.length);
        expect(adopted.valid).toEqual(specs.map(() => true)); // was ERROR_INVALID_HANDLE before
        expect(carried).not.toContain(adopted.own);

        // Parent -> child: SetEvent in the parent releases the child's wait.
        expect((await ask({ type: 'wait', handle: manual, timeout: 20 })).result).toBe(WAIT_TIMEOUT);
        const waiting = ask({ type: 'wait', handle: manual, timeout: 5000 });
        expect(value(syncApi.SetEvent!(ctx, memory, [manual]))).toBe(1);
        expect((await waiting).result).toBe(WAIT_OBJECT_0);

        // Child -> parent: the child's SetEvent on an auto-reset event reaches the parent's object.
        expect(system.scheduler.tryConsumeWait(auto, 1)).toBe(false);
        expect((await ask({ type: 'set', handle: auto })).result).toBe(1);
        let seen = false;
        for (let i = 0; i < 500 && !seen; i++) { seen = system.scheduler.tryConsumeWait(auto, 1) === true; if (!seen) await Bun.sleep(2); }
        expect(seen).toBe(true);

        // The game's process handle: signalled with its exit code when the game exits.
        expect((await ask({ type: 'wait', handle: game.hProcess, timeout: 20 })).result).toBe(WAIT_TIMEOUT);
        expect(await ask({ type: 'exitCode', handle: game.hProcess })).toMatchObject({ ok: 1, code: 259 });
        const gameWait = ask({ type: 'wait', handle: game.hProcess, timeout: 5000 });
        game.worker.exit(3);
        expect((await gameWait).result).toBe(WAIT_OBJECT_0);
        expect(await ask({ type: 'exitCode', handle: game.hProcess })).toMatchObject({ ok: 1, code: 3 });
        // An exited process cannot be terminated again.
        expect(await ask({ type: 'terminate', handle: game.hProcess, code: 9 })).toMatchObject({ ok: 0, lastError: 5 });

        // TerminateProcess on an inherited handle stops the process its owner runs.
        expect(victim.worker.terminated).toBe(false);
        expect(await ask({ type: 'terminate', handle: victim.hProcess, code: 7 })).toMatchObject({ ok: 1 });
        expect(victim.worker.terminated).toBe(true);
        expect((await ask({ type: 'wait', handle: victim.hProcess, timeout: 5000 })).result).toBe(WAIT_OBJECT_0);
        expect(value(processApi.GetExitCodeProcess!(ctx, memory, [victim.hProcess, 4200]))).toBe(1);
        expect(view.getUint32(4200, true)).toBe(7);

        // The parent itself is still running, so the handle naming it stays unsignalled.
        expect(boot.processIdentity!.parentPid).toBe(currentProcessId);
        expect((await ask({ type: 'wait', handle: self, timeout: 20 })).result).toBe(WAIT_TIMEOUT);
        expect((await ask({ type: 'wait', handle: mainThread, timeout: 20 })).result).toBe(WAIT_TIMEOUT);
        system.resourceProvider.unregisterKernelObject(mainThread);
    }, 20_000);

    test('without HANDLE_FLAG_INHERIT nothing is inherited, and SetHandleInformation adds it', async () => {
        const event = value(syncApi.CreateEventA!(ctx, memory, [0, 1, 0, 0]));
        expect((await createProcess(true, 0, 2048)).worker.boot!.inheritedHandles ?? []).toEqual([]);
        expect(value(processApi.SetHandleInformation!(ctx, memory, [event, 1, 1]))).toBe(1);
        const specs = (await createProcess(true, 0, 2100)).worker.boot!.inheritedHandles!;
        expect(specs).toMatchObject([{ handle: event, kind: 'event', manualReset: true, signaled: false }]);
    });
});
