import { beforeEach, afterEach, expect, test } from 'bun:test';
import { exports as fileIo } from '../../src/worker/modules/kernel32/file-io';
import { installReadFileEx, cancelFileReadEx } from '../../src/worker/modules/kernel32/file-io-ex';
import { Process } from '../../src/worker/core/process';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import type { ThunkImplementation, X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';
import type { VfsFileHandle } from '../../src/worker/runtime/filesystem/vfs';

const system = System.getInstance(), savedProcess = system.process, savedVfs = system.fileSystem;
const scheduler = system.scheduler, resources = system.resourceProvider;
const savedThread = scheduler.getCurrentThreadId, savedApc = scheduler.queueIoCompletionApc, savedError = scheduler.setLastError;
let ram: Uint8Array, owner: Process, methods: Record<string, ThunkImplementation>, handle: number, thread: number;
let callbacks: number[][], errors: number[], resets: Set<() => void>, reads: Array<{ cursor: VfsFileHandle; resolve(data: Uint8Array): void }>;
const word = (p: number) => new DataView(ram.buffer).getUint32(p, true);
const put = (p: number, value: number) => new DataView(ram.buffer).setUint32(p, value, true);
const call = (overlapped = 0x1000, size = 2) => methods.ReadFileEx({} as X86Context, ram, [handle, 0x2000, size, overlapped, 0x4000]);
const drain = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
    ram = new Uint8Array(0x10000); Mem.bind(() => ram); callbacks = []; errors = []; resets = new Set(); reads = []; thread = 7;
    owner = { resetGeneration: 0, getCurrentMemory: () => ram,
        addressSpace: {
            validateRange: (p: number, n: number) => p >= 0x1000 && p + n <= ram.length,
            write: (p: number, data: Uint8Array) => { ram.set(data, p); return data.length; },
        }, enqueueCompletion: Process.prototype.enqueueCompletion,
        onReset: (fn: () => void) => { resets.add(fn); return () => resets.delete(fn); },
    } as unknown as Process;
    system.process = owner;
    system.fileSystem = {
        duplicateHandle: (file: VfsFileHandle, position: number) => ({ ...file, position }),
        readSync: () => null,
        read: (cursor: VfsFileHandle) => new Promise<Uint8Array>(resolve => reads.push({ cursor, resolve })),
    } as typeof savedVfs;
    handle = resources.registerFileHandle({ vfsHandle: { kind: 'file', path: 'C:\\sample', position: 3, access: 0x80000000, source: 'rom' } });
    scheduler.getCurrentThreadId = () => thread;
    scheduler.queueIoCompletionApc = (...args: number[]) => { callbacks.push(args); return true; };
    scheduler.setLastError = error => { errors.push(error); };
    methods = {}; installReadFileEx(methods); put(0x1008, 1);
});
afterEach(() => {
    owner.resetGeneration++; for (const reset of resets) reset();
    resources.unregisterFileHandle(handle); system.process = savedProcess; system.fileSystem = savedVfs;
    scheduler.getCurrentThreadId = savedThread; scheduler.queueIoCompletionApc = savedApc; scheduler.setLastError = savedError;
});
test('asynchronous read submits immediately, owns its memory and queues only the issuing APC', async () => {
    expect(call()).toBe(1); expect(reads[0].cursor.position).toBe(1);
    const shared = (resources.getFileHandle(handle) as any).vfsHandle; expect(shared.position).toBe(3);
    const old = ram; ram = new Uint8Array(0x20000); ram.set(old);
    const foreign = new Uint8Array(ram.length); Mem.bind(() => foreign); thread = 11;
    reads[0].resolve(new Uint8Array([66, 67])); await drain();
    expect([...ram.slice(0x2000, 0x2002)]).toEqual([66, 67]); expect(old[0x2000]).toBe(0); expect(foreign[0x2000]).toBe(0);
    expect(word(0x1000)).toBe(0); expect(word(0x1004)).toBe(2);
    expect(callbacks).toEqual([[7, 0x4000, 0, 2, 0x1000]]); expect(errors).toEqual([]); expect(shared.position).toBe(3);
});
test('CancelIo selects one issuing thread and late file completion cannot overwrite cancellation', async () => {
    call(); thread = 11; call(0x1040);
    expect(cancelFileReadEx(owner, handle, 0, 7)).toBe(1);
    expect(cancelFileReadEx(owner, handle, 0x1000)).toBe(0);
    reads[0].resolve(new Uint8Array([99, 99])); reads[1].resolve(new Uint8Array([4, 5])); await drain();
    expect(callbacks).toEqual([[7, 0x4000, 995, 0, 0x1000], [11, 0x4000, 0, 2, 0x1040]]);
    expect(word(0x1000)).toBe(0xc0000120); expect(word(0x1004)).toBe(0);
    expect([...ram.slice(0x2000, 0x2002)]).toEqual([4, 5]);
});
test('reset discards a disk read and its unpublished APC', async () => {
    call(); owner.resetGeneration++; for (const reset of resets) reset();
    reads[0].resolve(new Uint8Array([66, 67])); await drain();
    expect(callbacks).toEqual([]); expect(ram[0x2000]).toBe(0); expect(word(0x1004)).toBe(0);
});
test('EOF reports native status and ERROR_HANDLE_EOF to the completion routine', async () => {
    call(); reads[0].resolve(new Uint8Array()); await drain();
    expect(callbacks).toEqual([[7, 0x4000, 38, 0, 0x1000]]);
    expect(word(0x1000)).toBe(0xc0000011); expect(word(0x1004)).toBe(0);
});
test('file API cancellation routes to pending file reads and reports not found after cancellation', async () => {
    call();
    const invoke = (name: string, args: number[]) => fileIo[name]({} as X86Context, ram, args);
    expect(invoke('CancelIoEx', [handle, 0x1040])).toMatchObject({ value: 0 });
    expect(errors).toEqual([1168]); errors = [];
    expect(invoke('CancelIo', [handle])).toBe(1); await drain();
    expect(callbacks).toEqual([[7, 0x4000, 995, 0, 0x1000]]);
    expect(invoke('CancelIoEx', [handle, 0])).toMatchObject({ value: 0 });
    expect(errors).toEqual([0, 1168]);
});
test('invalid guest range fails before creating a cursor or submitting an operation', () => {
    expect(call(ram.length - 4)).toBe(0); expect(errors).toEqual([998]); expect(reads).toEqual([]);
});
