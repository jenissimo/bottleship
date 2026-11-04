/**
 * GetCurrentThread, TlsSetValue and Nt/ZwQueryInformationThread FastPaths must be pure
 * accelerators of their slow-path bodies: for every case they answer, the return value,
 * LastError and guest-visible side effects (TLS slot, output buffers) match the slow path;
 * every case they do not answer returns null and leaves state untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { Ntdll } from '../../src/worker/modules/ntdll';
import { ntdllModule } from '../../src/worker/api/ntdll.api';
import { registerFastPathThreadInformation } from '../../src/worker/modules/ntdll/thread-information';
import {
    exports as processApi, registerFastPathProcessFunctions, resetProcessApiState,
} from '../../src/worker/modules/kernel32/process/process';
import { exports as tlsApi } from '../../src/worker/modules/kernel32/tls';
import { ThreadState, type Thread } from '../../src/worker/core/scheduler/types';
import type { FastPathImplementation, HleDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';

const system = System.getInstance(), scheduler = system.scheduler;
const internals = scheduler as unknown as { threads: Map<number, Thread>; currentThreadId: number | null };
const savedProcess = system.process;
const TID = 0x7ffd, ESP = 0x1000, OUT = 0x200, RETLEN = 0x300, LASTERROR_SENTINEL = 0x1234;
let memory: Uint8Array, view: DataView, ntdll: Ntdll, handle: number, savedCurrent: number | null;
const fast = new Map<string, FastPathImplementation>();

function call(name: string, args: number[]): number | null | undefined {
    for (let i = 0; i < args.length; i++) view.setUint32(ESP + 4 + i * 4, args[i] >>> 0, true);
    return fast.get(name)!(ESP, view, memory, new Uint32Array(memory.buffer), null);
}

function slowValue(result: unknown): number {
    return (typeof result === 'number' ? result : (result as { value: number }).value) >>> 0;
}

function outBytes(): number[] {
    return [...memory.slice(OUT, OUT + 28), ...memory.slice(RETLEN, RETLEN + 4)];
}

beforeEach(() => {
    savedCurrent = internals.currentThreadId;
    memory = new Uint8Array(0x2000); view = new DataView(memory.buffer);
    const validateRange = (p: number, n: number) => p > 0 && p + n <= memory.length;
    Mem.bind(() => memory, validateRange);
    system.process = { getCurrentMemory: () => memory, addressSpace: { validateRange } } as never;
    const object = { kind: 'thread', threadId: TID };
    handle = system.resourceProvider.registerKernelObject(object);
    internals.threads.set(TID, {
        id: TID, handle, kernelObject: object, state: ThreadState.READY, context: null, stackBase: 0, stackSize: 0,
        stackTop: 0, startAddress: 0x401000, parameter: 0, waitInfo: null, exitCode: null, tlsValues: new Map(),
        lastError: 0, suspendCount: 0, priority: 0, lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 4096,
        kernelPinCount: 0, apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    } as unknown as Thread);
    internals.currentThreadId = TID;
    resetProcessApiState();
    ntdll = new Ntdll(); ntdll.initialize(system.process!);
    fast.clear();
    const dispatcher = { registerFastPath: (_dll: string, name: string, impl: FastPathImplementation) => { fast.set(name, impl); } };
    registerFastPathProcessFunctions(dispatcher as unknown as HleDispatcher);
    registerFastPathThreadInformation(dispatcher);
    scheduler.setLastError(LASTERROR_SENTINEL);
});

afterEach(() => {
    internals.threads.delete(TID); internals.currentThreadId = savedCurrent;
    system.resourceProvider.unregisterKernelObject(handle);
    system.process = savedProcess; Mem.bind(() => savedProcess?.getCurrentMemory() ?? new Uint8Array());
    resetProcessApiState();
});

describe('GetCurrentThread fast path', () => {
    test('returns the slow path pseudo-handle and leaves LastError alone', () => {
        const slow = slowValue(processApi.GetCurrentThread!(null as never, memory, []));
        expect(call('GetCurrentThread', [])).toBe(slow);
        expect(scheduler.getLastError()).toBe(LASTERROR_SENTINEL);
    });
});

describe('TlsSetValue fast path', () => {
    test('allocated index: same result, slot value and LastError as the slow path', () => {
        const index = scheduler.tlsAlloc();
        try {
            expect(call('TlsSetValue', [index, 0xcafe0000])).toBe(1);
            const fastValue = scheduler.tlsGetValue(index), fastError = scheduler.getLastError();
            scheduler.tlsSetValue(index, 0);
            expect(slowValue(tlsApi.TlsSetValue!(null as never, memory, [index, 0xcafe0000]))).toBe(1);
            expect(scheduler.tlsGetValue(index)).toBe(fastValue);
            expect(fastValue).toBe(0xcafe0000);
            expect(fastError).toBe(LASTERROR_SENTINEL);
            expect(scheduler.getLastError()).toBe(LASTERROR_SENTINEL);
        } finally { scheduler.tlsFree(index); }
    });

    test('unallocated index defers to the slow path without side effects', () => {
        const index = scheduler.tlsAlloc();
        scheduler.tlsFree(index);
        expect(call('TlsSetValue', [index, 7])).toBeNull();
        expect(scheduler.getLastError()).toBe(LASTERROR_SENTINEL);
        expect(slowValue(tlsApi.TlsSetValue!(null as never, memory, [index, 7]))).toBe(0);
    });
});

describe('Nt/ZwQueryInformationThread fast path', () => {
    const cases: Array<[string, () => number[]]> = [
        ['own handle', () => [handle, 0, OUT, 28, RETLEN]],
        ['pseudo handle', () => [0xfffffffe, 0, OUT, 28, RETLEN]],
        ['no ReturnLength', () => [handle, 0, OUT, 28, 0]],
        ['invalid handle', () => [0xdead0, 0, OUT, 28, RETLEN]],
        ['length mismatch', () => [handle, 0, OUT, 16, RETLEN]],
        ['misaligned buffer', () => [handle, 0, OUT + 2, 28, RETLEN]],
        ['buffer outside memory', () => [handle, 0, 0x1ff0, 28, RETLEN]],
    ];
    for (const name of ['NtQueryInformationThread', 'ZwQueryInformationThread']) {
        for (const [label, args] of cases) test(`${name}: ${label} matches the slow path`, () => {
            memory.fill(0xcc, OUT, OUT + 28); memory.fill(0xcc, RETLEN, RETLEN + 4);
            const fastStatus = call(name, args());
            const fastOut = outBytes(), fastError = scheduler.getLastError();
            memory.fill(0xcc, OUT, OUT + 28); memory.fill(0xcc, RETLEN, RETLEN + 4);
            const slowStatus = slowValue(ntdll.exports[name](null, memory, args()));
            expect(fastStatus).toBe(slowStatus);
            expect(fastOut).toEqual(outBytes());
            expect(fastError).toBe(scheduler.getLastError());
        });

        test(`${name}: other information classes defer to the slow path untouched`, () => {
            memory.fill(0xcc, OUT, OUT + 28); memory.fill(0xcc, RETLEN, RETLEN + 4);
            const before = outBytes();
            expect(call(name, [handle, 1, OUT, 28, RETLEN])).toBeNull();
            expect(outBytes()).toEqual(before);
        });
    }

    test('both exports are declared as 5-argument stdcall', () => {
        for (const name of ['NtQueryInformationThread', 'ZwQueryInformationThread']) {
            const fn = ntdllModule.functions.find(f => f.name === name);
            expect(fn?.params).toHaveLength(5);
            expect(fn?.callingConvention).toBe('stdcall');
        }
    });
});
