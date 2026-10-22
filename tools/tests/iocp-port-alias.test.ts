import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Process } from '../../src/worker/core/process';
import { SystemResourceProvider } from '../../src/worker/core/resources/system-resource-provider';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { exports as sync, captureFileIoCompletion, hasIoCompletionAssociation, postFileIoCompletion, resetSyncState } from '../../src/worker/modules/kernel32/sync';
import { exports as fileIo } from '../../src/worker/modules/kernel32/file-io';
import { exports as processApi } from '../../src/worker/modules/kernel32/process/process';
import type { ThunkResult } from '../../src/worker/core/thunking/thunk-dispatcher';

const system = System.getInstance(), scheduler = system.scheduler, resources = system.resourceProvider;
const savedProcess = system.process;
const savedId = scheduler.getCurrentThreadId, savedError = scheduler.setLastError, savedOwnerError = scheduler.setLastErrorForThread;
const savedMem = Object.getOwnPropertyDescriptors(Mem);
let ram: Uint8Array, owner: Process, errors: number[], handles: number[];
const ctx = {} as never;
const get = (address: number) => new DataView(ram.buffer).getUint32(address, true);
function invoke(api: string, args: number[]) { return sync[api]!(ctx, ram, args); }
function port() {
    const file = resources.registerFileHandle({});
    const handle = invoke('CreateIoCompletionPort', [file, 0, 42, 0]) as number;
    handles.push(file, handle);
    return {file, handle, object: resources.getKernelObject(handle)};
}
function duplicate(handle: number, flags = 2) {
    const result = processApi.DuplicateHandle!(ctx, ram, [0xffffffff, handle, 0xffffffff, 32, 0, 0, flags]) as ThunkResult;
    expect(result.value).toBe(1);
    const copy = get(32); handles.push(copy);
    expect(copy).not.toBe(handle);
    return copy;
}
function close(handle: number) { return fileIo.CloseHandle!(ctx, ram, [handle]); }
function dequeue(handle: number, timeout = 0) { return invoke('GetQueuedCompletionStatus', [handle, 8, 12, 16, timeout]); }
beforeEach(() => {
    resetSyncState(); handles = []; errors = [];
    ram = new Uint8Array(4096); Mem.bind(() => ram);
    owner = Object.create(Process.prototype) as Process;
    Object.assign(owner, { resetGeneration: 0, getMemory: () => ram, addressSpace: {
        validateRange: (address: number, size: number) => address > 0 && address + size <= ram.length,
        write: (address: number, bytes: Uint8Array) => { ram.set(bytes, address); return bytes.length; },
    } });
    system.process = owner;
    scheduler.getCurrentThreadId = () => 7;
    scheduler.setLastError = code => { errors.push(code); };
    scheduler.setLastErrorForThread = (_thread, code) => { errors.push(code); };
});
afterEach(() => {
    resetSyncState();
    for (const handle of handles) {
        if (resources.getFileHandle(handle)) resources.unregisterFileHandle(handle);
        else resources.unregisterKernelObject(handle);
    }
    system.process = savedProcess; scheduler.getCurrentThreadId = savedId;
    scheduler.setLastError = savedError; scheduler.setLastErrorForThread = savedOwnerError;
    for (const key of ['memoryGetter', 'validateRange', 'getRegion']) Object.defineProperty(Mem, key, savedMem[key]!);
});
for (const closeBeforeCapture of [false, true]) {
    test('associated I/O survives original port close, capture before close=' + !closeBeforeCapture, () => {
        const {file, handle} = port(), copy = duplicate(handle);
        const target = closeBeforeCapture ? undefined : captureFileIoCompletion(file)!;
        expect(close(handle)).toBe(1);
        expect(resources.getKernelObject(handle)).toBeNull();
        expect((target ?? captureFileIoCompletion(file)!).post(3, 0x180)).toBe(true);
        expect((dequeue(copy) as ThunkResult).value).toBe(1);
        expect([get(8), get(12), get(16)]).toEqual([3, 42, 0x180]);
    });
}
test('queued packets and parked waiters use the shared port object across aliases', async () => {
    const {handle} = port(), copy = duplicate(handle);
    expect(invoke('PostQueuedCompletionStatus', [handle, 11, 22, 33])).toBe(1);
    expect((dequeue(copy) as ThunkResult).value).toBe(1);
    expect([get(8), get(12), get(16)]).toEqual([11,22,33]);
    const waiting = dequeue(handle, 1000) as Promise<ThunkResult>;
    expect(waiting).toBeInstanceOf(Promise);
    expect(close(handle)).toBe(1);
    expect(invoke('PostQueuedCompletionStatus', [copy, 44, 55, 66])).toBe(1);
    const result = await waiting;
    expect(result.value).toBe(1);
    expect(result.deferredWrites?.map(write => write.value)).toEqual([44,55,66]);
    expect(errors).not.toContain(735);
});
test('a waiter created through a copy can receive a packet posted through the original', async () => {
    const {handle} = port(), copy = duplicate(handle);
    const waiting = dequeue(copy, 1000) as Promise<ThunkResult>;
    invoke('PostQueuedCompletionStatus', [handle, 4, 5, 6]);
    expect((await waiting).value).toBe(1);
});
test('only the final alias close abandons all object waiters', async () => {
    const {file,handle} = port(), copy = duplicate(handle);
    const first = dequeue(handle, 1000) as Promise<ThunkResult>;
    const second = dequeue(copy, 1000) as Promise<ThunkResult>;
    close(handle);
    expect(postFileIoCompletion(file, 3, 0x180)).toBe(true);
    expect((await first).value).toBe(1);
    close(copy);
    expect((await second).value).toBe(0);
    expect(errors.at(-1)).toBe(735);
    expect(hasIoCompletionAssociation(file)).toBe(true);
    expect(captureFileIoCompletion(file)).toBeUndefined();
});
test('DUPLICATE_CLOSE_SOURCE transfers the port reference without closing the object', () => {
    const {file,handle,object} = port(), target = captureFileIoCompletion(file)!;
    const copy = duplicate(handle, 3);
    expect(resources.getKernelObject(handle)).toBeNull();
    expect(resources.getKernelObject(copy)).toBe(object);
    expect(target.post(7, 0x180)).toBe(true);
    expect((dequeue(copy) as ThunkResult).value).toBe(1);
    expect(get(8)).toBe(7);
});
test('bad output pointers do not allocate or leak a port alias', () => {
    const {handle} = port();
    const before = resources.getStatistics().kernel_object.count;
    for (const output of [0, ram.length - 1, 0xfffffff0]) {
        const result = processApi.DuplicateHandle!(ctx, ram, [0xffffffff,handle,0xffffffff,output,0,0,2]) as ThunkResult;
        expect(result.value).toBe(0);
        expect(resources.getStatistics().kernel_object.count).toBe(before);
    }
    expect(resources.getKernelObject(handle)).not.toBeNull();
});
test('IOCP duplicate rejects foreign/invalid process endpoints instead of inventing a local copy', () => {
    const {handle} = port();
    const before = resources.getStatistics().kernel_object.count;
    for (const [source,target] of [[0,0xffffffff],[0xffffffff,0],[0x12345,0xffffffff]]) {
        const result = processApi.DuplicateHandle!(ctx, ram, [source,handle,target,32,0,0,2]) as ThunkResult;
        expect(result.value).toBe(0);
        expect(resources.getStatistics().kernel_object.count).toBe(before);
    }
});
test('a closed port binding remains a tombstone rather than adopting a new port', () => {
    const {file,handle} = port(), copy = duplicate(handle), target = captureFileIoCompletion(file)!;
    close(handle); close(copy);
    const replacement = invoke('CreateIoCompletionPort',[0xffffffff,0,0,0]) as number; handles.push(replacement);
    expect(invoke('CreateIoCompletionPort',[file,replacement,99,0])).toBe(0);
    expect(errors.at(-1)).toBe(87);
    expect(target.post(1,0x180)).toBe(false);
    expect((dequeue(replacement) as ThunkResult).value).toBe(0);
    expect(errors.at(-1)).toBe(258);
});
test('owner reset fences captured targets while aliases and unrelated port objects stay separate', () => {
    const {file,handle} = port(), copy = duplicate(handle), target = captureFileIoCompletion(file)!;
    owner.resetGeneration++;
    expect(target.post(1,0x180)).toBe(false);
    const fresh = port();
    expect(postFileIoCompletion(fresh.file,2,0x184)).toBe(true);
    expect((dequeue(copy) as ThunkResult).value).toBe(0);
    expect((dequeue(fresh.handle) as ThunkResult).value).toBe(1);
    expect(get(8)).toBe(2);
});
test('kernel object reference counts track each alias, repeated close, and cleanup ABA', () => {
    const provider = new SystemResourceProvider(), oldObject = {kind:'iocp'};
    const first = provider.registerKernelObject(oldObject), second = provider.registerKernelObject(oldObject);
    expect(provider.kernelObjectReferenceCount(oldObject)).toBe(2);
    expect(provider.hasKernelObjectReference(oldObject)).toBe(true);
    provider.unregisterKernelObject(first);
    expect(provider.kernelObjectReferenceCount(oldObject)).toBe(1);
    provider.unregisterKernelObject(first);
    expect(provider.kernelObjectReferenceCount(oldObject)).toBe(1);
    provider.cleanup();
    const replacement = {kind:'iocp'}, reused = provider.registerKernelObject(replacement);
    expect(reused).toBe(first);
    expect(provider.hasKernelObjectReference(oldObject)).toBe(false);
    expect(provider.kernelObjectReferenceCount(replacement)).toBe(1);
    expect(provider.getKernelObject(second)).toBeNull();
    provider.unregisterKernelObject(reused);
    expect(provider.hasKernelObjectReference(replacement)).toBe(false);
});
