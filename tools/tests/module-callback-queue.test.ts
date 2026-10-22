import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ModuleCallbackQueue } from '../../src/worker/core/module-callback-queue';
import { System } from '../../src/worker/core/system';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import type { Process } from '../../src/worker/core/process';
import type { ThunkImplementation, ThunkResult, X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';

const system = System.getInstance(), scheduler = system.scheduler;
const originalCreate = scheduler.createThread, originalId = scheduler.getThreadIdByHandle, originalProcess = system.process;
let process: Process, handlers: Map<string, ThunkImplementation>, resetListeners: Set<() => void>;
let calls: Array<{ args: number[]; done: (value: number) => number }>, frames: unknown[], ram: Uint8Array, allocated: number;
let queues: ModuleCallbackQueue[];
function queue(capacity = 2) { const q = new ModuleCallbackQueue(process, capacity); queues.push(q); return q; }
function pump(): ThunkImplementation { return [...handlers.values()][0]; }
function ctx(): X86Context { return { eax: 0, ebx: 1, ecx: 2, edx: 3, edi: 4, esi: 5, ebp: 6, esp: 0x2000, eip: 0x50000b, eflags: 0x202 }; }
beforeEach(() => {
    ram = new Uint8Array(8 << 20); Mem.bind(() => ram); allocated = 0x600000;
    handlers = new Map(); resetListeners = new Set(); calls = []; frames = []; queues = [];
    const generator = new ThunkGenerator(); generator.setBaseAddress(0x500000);
    process = {
        resetGeneration: 0, thunkGenerator: generator,
        getCurrentMemory: () => ram, memory: { alloc: (size: number) => { const p = allocated; allocated += size; return p; } },
        resourceProvider: { unregisterKernelObject() {} },
        onReset: (listener: () => void) => { resetListeners.add(listener); return () => resetListeners.delete(listener); },
        dispatcher: {
            register: (_dll: string, name: string, fn: ThunkImplementation) => handlers.set(name, fn),
            callbackManager: {
                saveSuspendedThunkContext: (frame: unknown) => { frames.push(frame); return 7; },
                invokeCallback: (_target: number, args: number[], _cleanup: number, done: (value: number) => number) => {
                    calls.push({ args, done }); return { callbackId: 1 };
                },
                abandonSuspendedFrame() {},
            },
        },
    } as unknown as Process;
    system.process = process;
    scheduler.createThread = () => 0x1234;
    scheduler.getThreadIdByHandle = () => 52;
});
afterEach(() => {
    for (const q of queues) q.close();
    scheduler.createThread = originalCreate; scheduler.getThreadIdByHandle = originalId; system.process = originalProcess;
});
describe('module callbacks execute through a guest worker safe point', () => {
    test('bounded enqueue never invokes a callback, retains refused task ownership, and returns guest result', () => {
        const q = queue(1); let prepared = 0, returned = 0, discarded = 0;
        expect(q.enqueue({ prepare: () => { prepared++; return { routine: 0x401000, args: [1, 2, 3], onReturn: value => returned = value }; } })).toBe(true);
        expect(q.threadId).toBe(52); expect(prepared).toBe(0); expect(calls).toHaveLength(0);
        expect(q.enqueue({ prepare: () => ({ routine: 1, args: [] }), onDiscard: () => discarded++ })).toBe(false);
        expect(discarded).toBe(0); expect(q.size).toBe(1);
        const result = pump()(ctx(), ram, []) as ThunkResult;
        expect(result.suspendedForCallback).toBe(true); expect(prepared).toBe(1);
        expect(calls[0].args).toEqual([1, 2, 3]); expect(q.size).toBe(1);
        expect(calls[0].done(0x80001001)).toBe(1); expect(returned).toBe(0x80001001); expect(q.size).toBe(0);
    });
    test('idle wake describes an async callback chain and keeps original reusable thunk frame', async () => {
        const q = queue();
        q.enqueue({ prepare: () => ({ routine: 0x401000, args: [] }) });
        pump()(ctx(), ram, []); calls[0].done(0);
        const context = ctx();
        const waiting = pump()(context, ram, []) as Promise<ThunkResult>;
        context.esp = 0xdeadbeef;
        let prepared = 0;
        expect(q.enqueue({ prepare: () => { prepared++; return { routine: 0x402000, args: [7] }; } })).toBe(true);
        const answer = await waiting;
        expect(prepared).toBe(0); expect(calls).toHaveLength(1);
        expect(answer.startCallbackChain?.({ esp: 0x2000, returnAddr: 0x600007, mem: ram })).toBe(true);
        expect(prepared).toBe(1); expect(calls[1].args).toEqual([7]);
        expect(frames[1]).toMatchObject({ esp: 0x2000, returnAddr: 0x600007 });
        calls[1].done(0);
    });
    test('normal close discards unprepared tasks and lets the active callback finish before thread exit', () => {
        const q = queue(3); let returned = 0, discarded = 0;
        q.enqueue({ prepare: () => ({ routine: 0x401000, args: [], onReturn: () => returned++ }) });
        q.enqueue({ prepare: () => ({ routine: 0x402000, args: [] }), onDiscard: () => discarded++ });
        pump()(ctx(), ram, []);
        q.close(); expect(discarded).toBe(1); expect(returned).toBe(0);
        expect(calls[0].done(0)).toBe(0); expect(returned).toBe(1);
        expect(q.enqueue({ prepare: () => ({ routine: 1, args: [] }) })).toBe(false);
    });
    test('reset discards prepared storage once and prevents callbacks against recycled memory', () => {
        const q = queue(); let discarded = 0, returned = 0;
        q.enqueue({ prepare: () => ({ routine: 0x401000, args: [],
            onReturn: () => returned++, onDiscard: () => discarded++ }) });
        pump()(ctx(), ram, []);
        process.resetGeneration++;
        for (const listener of [...resetListeners]) listener();
        expect(discarded).toBe(1); expect(returned).toBe(0);
        expect(q.size).toBe(0); expect(resetListeners.size).toBe(0);
    });
    test('a refused guest callback releases its prepared storage and suspended frame', () => {
        const q = queue(); let discarded = 0, abandoned = 0;
        process.dispatcher.callbackManager.invokeCallback = () => { throw new Error('callback unavailable'); };
        process.dispatcher.callbackManager.abandonSuspendedFrame = () => { abandoned++; return true; };
        q.enqueue({ prepare: () => ({ routine: 0x401000, args: [], onDiscard: () => discarded++ }) });
        expect(() => pump()(ctx(), ram, [])).toThrow('callback unavailable');
        expect(q.size).toBe(0); expect(discarded).toBe(1); expect(abandoned).toBe(1);
    });
    test('cancel only discards a pending identity and preserves the active guest frame', () => {
        const q = queue(3); let discarded = 0, returned = 0;
        const active = { prepare: () => ({ routine: 0x401000, args: [], onReturn: () => returned++ }) };
        const pending = { prepare: () => ({ routine: 0x402000, args: [] }), onDiscard: () => discarded++ };
        q.enqueue(active); q.enqueue(pending); pump()(ctx(), ram, []);
        expect(q.cancel(active)).toBe(false); expect(q.cancel(pending)).toBe(true);
        expect(q.cancel(pending)).toBe(false); expect(discarded).toBe(1); expect(q.size).toBe(1);
        calls[0].done(0); expect(returned).toBe(1); expect(q.size).toBe(0);
    });
    test('closing an idle worker wakes it to an ordinary zero return without starting guest code', async () => {
        const q = queue(); q.enqueue({ prepare: () => ({ routine: 0x401000, args: [] }) });
        pump()(ctx(), ram, []); calls[0].done(0);
        const waiting = pump()(ctx(), ram, []) as Promise<ThunkResult>;
        q.close();
        const answer = await waiting;
        expect(answer.value).toBe(0);
        expect(answer.startCallbackChain?.({ esp: 0x2000, returnAddr: 0x600007, mem: ram })).toBe(false);
        expect(calls).toHaveLength(1);
    });
});
