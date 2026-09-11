import { afterEach, describe, expect, test } from 'bun:test';
import { CHILD_IO_BYTES, createChildVfsServer } from '../../src/worker/core/child-vfs';
import {
    runChildProcess, startChildProcess, stopChildProcesses, pendingChildHandoff, ChildNeedsSession, type ChildBoot,
    setChildSessionPublisher, promoteChildSession, hasChildSession,
} from '../../src/worker/core/child-process';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import type { ZipArchive, ZipEntry } from '@bottleship/formats/zip';

afterEach(async () => { await stopChildProcesses(); setChildSessionPublisher(undefined); });

async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(predicate()).toBe(true);
}

function filesystem(bytes = Uint8Array.from([0x4d, 0x5a, 3, 4, 5])) {
    const entry = { name: 'rom/helper.exe', uncompressedSize: bytes.length, compressedSize: bytes.length,
        compression: 0, localHeaderOffset: 0, isDirectory: false } as ZipEntry;
    const vfs = new VirtualFileSystem();
    vfs.mountRom({
        readEntryRangeSync: (_entry: ZipEntry, offset: number, length: number) => bytes.slice(offset, offset + length),
        readEntryRange: async (_entry: ZipEntry, offset: number, length: number) => bytes.slice(offset, offset + length),
    } as unknown as ZipArchive, 'rom', new Map([['helper.exe', entry]]));
    return vfs;
}

class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    boot: ChildBoot | null = null;
    terminated = false;
    messages: any[] = [];
    postMessage(message: any) { this.messages.push(message); if (message.type === 'child_boot') this.boot = message; }
    terminate() { this.terminated = true; }
    exit(code: number) { this.onmessage?.({ data: { type: 'process_exit', exitCode: code } }); }
}

async function started(worker: FakeWorker) {
    for (let i = 0; i < 100 && !worker.boot; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(worker.boot).not.toBeNull();
}

describe('isolated child lifecycle', () => {
    const request = { imagePath: 'C:\\helper.exe', commandLine: '/generate result.dat', currentDirectory: 'C:\\' };

    test('exit waits for durability and destroys the child worker', async () => {
        const vfs = filesystem();
        let release!: () => void;
        vfs.flushAll = () => new Promise<void>(resolve => { release = resolve; });
        const worker = new FakeWorker();
        let done = false;
        const result = runChildProcess(vfs, request, () => worker as unknown as Worker).then(code => { done = true; return code; });
        await started(worker);
        expect([...worker.boot!.bytes]).toEqual([0x4d, 0x5a, 3, 4, 5]);
        worker.exit(17);
        await until(() => !!release);
        expect(done).toBe(false);
        expect(worker.terminated).toBe(true);
        release();
        expect(await result).toBe(17);
        expect(worker.terminated).toBe(true);
        expect(vfs.fileExists('C:\\helper.exe')).toBe(true);
    });

    test('a durability failure cannot become successful completion', async () => {
        const vfs = filesystem();
        vfs.flushAll = async () => { throw new Error('disk full'); };
        const worker = new FakeWorker();
        const result = runChildProcess(vfs, request, () => worker as unknown as Worker);
        const rejected = result.catch(error => error);
        await started(worker);
        worker.exit(0);
        expect(String(await rejected)).toContain('disk full');
        expect(worker.terminated).toBe(true);
    });

    test('session teardown cancels outstanding work instead of leaving CreateProcess parked', async () => {
        const worker = new FakeWorker();
        const result = runChildProcess(filesystem(), request, () => worker as unknown as Worker);
        const rejected = result.catch(error => error);
        await started(worker);
        stopChildProcesses();
        expect(String(await rejected)).toContain('Parent session ended');
        expect(worker.terminated).toBe(true);
    });

    test('worker failures clean up and preserve the parent VFS', async () => {
        const worker = new FakeWorker();
        const vfs = filesystem();
        const result = runChildProcess(vfs, request, () => worker as unknown as Worker);
        const rejected = result.catch(error => error);
        await started(worker);
        worker.onerror?.({ message: 'wasm failed' });
        expect(String(await rejected)).toContain('wasm failed');
        expect(worker.terminated).toBe(true);
        expect(vfs.fileExists('C:\\helper.exe')).toBe(true);
    });

    test('teardown during image I/O prevents a late worker from starting', async () => {
        const vfs = filesystem();
        let release!: (bytes: Uint8Array) => void;
        vfs.read = () => new Promise<Uint8Array>(resolve => { release = resolve; });
        let spawned = false;
        const result = runChildProcess(vfs, request, () => {
            spawned = true;
            return new FakeWorker() as unknown as Worker;
        }).catch(error => error);
        while (!release) await Promise.resolve();
        let drained = false;
        const stopped = stopChildProcesses().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        release(Uint8Array.from([0x4d, 0x5a, 3, 4, 5]));
        expect(String(await result)).toContain('Parent session ended');
        await stopped;
        expect(drained).toBe(true);
        expect(spawned).toBe(false);
    });
});

/**
 * The rule that decides whether a child is a helper or the session.
 *
 * It is never read off the image — the PE subsystem said "GUI" for WWP's Landgen, which is
 * a pure kernel32 computation, and would have said the same for a game. It is read off what
 * the guest DID: a helper delivers an exit code its parent came for; a session-owning child
 * either claims the screen (a titled top-level window) or is still there when the parent
 * walks away.
 */
describe('helper or session', () => {
    const request = { imagePath: 'C:\\helper.exe', commandLine: '/generate result.dat', currentDirectory: 'C:\\' };

    test.each(['window', 'parent-exit'])('live promotion on %s never reboots or repeats pre-window effects', async trigger => {
        const ports: MessagePort[] = [];
        setChildSessionPublisher(port => { ports.push(port); });
        const vfs = filesystem();
        let mutations = 0;
        vfs.deleteFile = async () => { mutations++; return true; };
        let spawns = 0;
        const worker = new FakeWorker();
        const task = startChildProcess(vfs, request, () => { spawns++; return worker as unknown as Worker; });
        const result = task.completion.catch(e => e);
        if (trigger === 'parent-exit') expect(promoteChildSession(task.record)).toBe(true);
        await started(worker);
        worker.onmessage!({ data: { type: 'child_io', request: { method: 'deleteFile', args: ['C:\\once.dat'] } } });
        worker.onmessage!({ data: { type: 'window_title', title: 'Live child' } });
        expect(hasChildSession()).toBe(true);
        expect(task.record.finished).toBeUndefined();
        expect(worker.terminated).toBe(false);
        await stopChildProcesses(true);
        expect(worker.terminated).toBe(false);
        expect(promoteChildSession(task.record)).toBe(true);
        expect(ports.length).toBe(1);
        expect(spawns).toBe(1);
        expect(mutations).toBe(1);
        expect(worker.messages.filter(m => m.type === 'child_boot').length).toBe(1);
        worker.exit(42);
        expect(await result).toBe(42);
        expect(hasChildSession()).toBe(false);
        for (const port of ports) port.close();
        for (const message of worker.messages) message.port?.close();
    });

    test('guest exit is delivered while its worker still serves a descendant', async () => {
        const worker = new FakeWorker();
        const task = startChildProcess(filesystem(), request, () => worker as unknown as Worker);
        const codes: number[] = [];
        task.onGuestExit = code => codes.push(code);
        await started(worker);
        worker.onmessage!({ data: { type: 'process_exit', exitCode: 31, broker: true } });
        expect(codes).toEqual([31]);
        expect(task.record.guestExitCode).toBe(31);
        expect(worker.terminated).toBe(false);
        expect(task.record.finished).toBeUndefined();
        worker.exit(31);
        expect(await task.completion).toBe(31);
        expect(worker.terminated).toBe(true);
    });

    test('an immediate parent exit sees the child before the image open resolves', async () => {
        const vfs = filesystem();
        let release!: () => void;
        vfs.open = () => new Promise(resolve => { release = () => resolve(null); });
        const task = startChildProcess(vfs, request);
        const rejected = task.completion.catch(e => e);
        expect(pendingChildHandoff()).toBe(task.record);
        release();
        expect(String(await rejected)).toContain('Cannot open child image');
        expect(pendingChildHandoff()).toBe(task.record);
        expect(task.record.finished).toBeNumber();
    });

    test('worker construction failure is recorded and remains eligible for handoff', async () => {
        const task = startChildProcess(filesystem(), request, () => { throw new Error('Worker refused'); });
        expect(String(await task.completion.catch(e => e))).toContain('Worker refused');
        expect(pendingChildHandoff()).toBe(task.record);
        expect(task.record.error).toContain('Worker refused');
    });

    test('terminating one child preserves another child and ignores late GUI messages', async () => {
        const first = new FakeWorker(), second = new FakeWorker();
        const a = startChildProcess(filesystem(), request, () => first as unknown as Worker);
        const b = startChildProcess(filesystem(), request, () => second as unknown as Worker);
        await Promise.all([started(first), started(second)]);
        const queuedMessage = second.onmessage!;
        b.terminate(71);
        queuedMessage({ data: { type: 'window_title', title: 'Too late' } });
        expect(second.terminated).toBe(true);
        expect(first.terminated).toBe(false);
        expect(await b.completion).toBe(71);
        expect(b.record.needsSession).toBeUndefined();
        expect(pendingChildHandoff()).toBe(a.record);
        first.exit(0);
        expect(await a.completion).toBe(0);
        expect(pendingChildHandoff()).toBeNull();
    });

    test('forced exit drains accepted writes and durability before publishing its code', async () => {
        const vfs = filesystem();
        let releaseWrite!: () => void;
        let releaseFlush!: () => void;
        let writes = 0;
        vfs.write = () => { writes++; return new Promise(resolve => { releaseWrite = () => resolve(1); }); };
        vfs.flushAll = () => new Promise(resolve => { releaseFlush = resolve; });
        const worker = new FakeWorker();
        const task = startChildProcess(vfs, request, () => worker as unknown as Worker);
        let done = false;
        const result = task.completion.then(code => { done = true; return code; });
        await started(worker);
        // Acquire a remote handle, then leave its write suspended in parent VFS I/O.
        worker.onmessage!({ data: { type: 'child_io', request: { method: 'open', args: [request.imagePath, 0x80000000, 3] } } });
        const control = new Int32Array(worker.boot!.io, 0, 2);
        await until(() => Atomics.load(control, 0) === 1);
        const reply = JSON.parse(new TextDecoder().decode(new Uint8Array(worker.boot!.io, 8, control[1]).slice()));
        const message = { data: { type: 'child_io', request: { method: 'write', args: [reply.value, [42]] } } };
        const queuedMessage = worker.onmessage!;
        queuedMessage(message);
        expect(writes).toBe(1);
        task.terminate(91);
        queuedMessage(message);
        expect(writes).toBe(1);
        expect(worker.terminated).toBe(true);
        expect(done).toBe(false);
        expect(releaseFlush).toBeUndefined();
        releaseWrite();
        await until(() => !!releaseFlush);
        expect(done).toBe(false);
        releaseFlush();
        expect(await result).toBe(91);
        expect(task.record.fileMutations).toBe(1);
        expect(task.record.mutationPaths).toEqual([request.imagePath]);
        expect(pendingChildHandoff()).toBeNull();
    });

    test('handoff preserves evidence of file mutations before the GUI request', async () => {
        const vfs = filesystem();
        let mutations = 0;
        vfs.deleteFile = async () => { mutations++; return true; };
        const worker = new FakeWorker();
        const task = startChildProcess(vfs, request, () => worker as unknown as Worker);
        const rejected = task.completion.catch(e => e);
        await started(worker);
        worker.onmessage!({ data: { type: 'child_io', request: { method: 'deleteFile', args: ['C:\\state.dat'] } } });
        worker.onmessage!({ data: { type: 'window_title', title: 'Game' } });
        expect(await rejected).toBeInstanceOf(ChildNeedsSession);
        expect(mutations).toBe(1);
        expect(pendingChildHandoff()?.mutationPaths).toEqual(['C:\\state.dat']);
        expect(task.record.fileMutations).toBe(1);
    });

    test('a delivered exit code retires the candidacy; nothing else does', async () => {
        stopChildProcesses();
        expect(pendingChildHandoff()).toBeNull();

        const worker = new FakeWorker();
        const result = runChildProcess(filesystem(), request, () => worker as unknown as Worker);
        await started(worker);
        // Running: this is what a launcher leaves behind when it exits.
        expect(pendingChildHandoff()?.imagePath).toBe('C:\\helper.exe');
        worker.exit(0);
        expect(await result).toBe(0);
        // Collected: the parent already has what it waited for.
        expect(pendingChildHandoff()).toBeNull();
    });

    test('a run that never produced an exit code stays the successor', async () => {
        stopChildProcesses();
        const vfs = filesystem();
        vfs.flushAll = async () => { throw new Error('disk full'); };
        const worker = new FakeWorker();
        const rejected = runChildProcess(vfs, request, () => worker as unknown as Worker).catch(e => e);
        await started(worker);
        worker.exit(0);
        expect(String(await rejected)).toContain('disk full');
        expect(pendingChildHandoff()?.imagePath).toBe('C:\\helper.exe');
    });

    test('a titled top-level window is the child saying it needs the screen', async () => {
        stopChildProcesses();
        const worker = new FakeWorker();
        const rejected = runChildProcess(filesystem(), request, () => worker as unknown as Worker).catch(e => e);
        await started(worker);
        worker.onmessage?.({ data: { type: 'window_title', title: 'Warcraft III' } });
        // Bounded, because the failure this pins is silence: a runner that ignores the
        // signal leaves the parent — and this test — waiting on a child that never exits.
        const error = await Promise.race([rejected, new Promise(resolve =>
            setTimeout(() => resolve(new Error('the child claimed the screen and nobody noticed')), 1000))]);
        expect(error).toBeInstanceOf(ChildNeedsSession);
        expect((error as ChildNeedsSession).record.imagePath).toBe('C:\\helper.exe');
        expect((error as ChildNeedsSession).record.needsSession).toContain('Warcraft III');
        expect(worker.terminated).toBe(true);
        // The hand-off runs off this record, so it must survive the rejection.
        expect(pendingChildHandoff()?.needsSession).toContain('Warcraft III');
    });

    test('teardown leaves nobody to hand the session to', async () => {
        const worker = new FakeWorker();
        const rejected = runChildProcess(filesystem(), request, () => worker as unknown as Worker).catch(e => e);
        await started(worker);
        stopChildProcesses();
        await rejected;
        expect(pendingChildHandoff()).toBeNull();
    });
});

describe('child filesystem ownership', () => {
    test('real worker transport preserves bytes, readInto guards, cursors and async contracts', async () => {
        const bytes = Uint8Array.from({ length: 150_000 }, (_, index) => index & 255);
        const vfs = filesystem(bytes);
        const buffer = new SharedArrayBuffer(CHILD_IO_BYTES);
        const serve = createChildVfsServer(vfs, buffer);
        const worker = new Worker(new URL('./fixtures/child-vfs-worker.ts', import.meta.url).href);
        try {
            const result = await new Promise<any>((resolve, reject) => {
                worker.onerror = event => reject(new Error(event.message));
                worker.onmessage = event => {
                    if (event.data.type === 'io') void serve(event.data.request);
                    else if (event.data.type === 'failed') reject(new Error(event.data.error));
                    else resolve(event.data);
                };
                worker.postMessage({ buffer });
            });
            expect(result).toEqual({ type: 'done', isPromise: true, size: 140_000, mismatch: -1,
                position: 140_000, duplicatePosition: 50, read: 8, cwd: 'C:\\',
                target: [0xee, 0xee, 42, 43, 44, 45, 46, 47, 48, 49, 0xee, 0xee] });
        } finally { worker.terminate(); }
    });

    test('child seek/read use an independent file object, including duplicate cursors', async () => {
        const vfs = filesystem();
        const parent = vfs.openSync('C:\\helper.exe', 0x80000000, 3)!;
        vfs.setPosition(parent, 4, 0);
        const buffer = new SharedArrayBuffer(CHILD_IO_BYTES);
        const serve = createChildVfsServer(vfs, buffer);
        const invoke = async (method: string, ...args: unknown[]) => {
            await serve({ method, args });
            const length = Atomics.load(new Int32Array(buffer), 1);
            return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length).slice()));
        };
        const child = (await invoke('openSync', 'C:\\helper.exe', 0x80000000, 3)).value;
        expect((await invoke('readSync', child, 2)).value.childBytes).toEqual([0x4d, 0x5a]);
        expect((await invoke('tell', child)).value).toBe(2);
        const duplicate = (await invoke('duplicateHandle', child, 0)).value;
        expect((await invoke('read', duplicate, 1)).value.childBytes).toEqual([0x4d]);
        expect((await invoke('tell', child)).value).toBe(2);
        expect(vfs.tell(parent)).toBe(4);
        expect((await invoke('reset')).error).toContain('Unsupported');
        expect((await invoke('read', { childHandle: 9999 }, 1)).error).toContain('Invalid child');
        expect(vfs.fileExists('C:\\helper.exe')).toBe(true);
    });
});
