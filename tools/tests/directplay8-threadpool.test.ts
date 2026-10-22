import { afterEach, beforeEach, expect, test } from "bun:test";
import { DirectPlayCallbackExecutor } from "../../src/worker/modules/dpnet/executor";
import { DirectPlayThreadPoolApi, DP8_THREADPOOL } from "../../src/worker/modules/dpnet/threadpool-api";
import { dpnetModule } from "../../src/worker/api/dpnet.api";
import { DPN, guidBytes } from "../../src/worker/modules/dpnet/constants";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { BaseComObject, ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { allocateComObject } from "../../src/worker/core/com/com-memory";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import type { Process } from "../../src/worker/core/process";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../src/worker/core/thunking/thunk-dispatcher";
const system = System.getInstance(), scheduler = system.scheduler, resource = SystemResourceProvider.getInstance();
const original = { process: system.process, create: scheduler.createThread, id: scheduler.getThreadIdByHandle, current: scheduler.getCurrentThreadId };
interface Call { routine: number; args: number[]; thread: number; done(value: number): number | null; enumerationState?: { continueEnumeration(): void }; }
let process: Process, executor: DirectPlayCallbackExecutor, api: DirectPlayThreadPoolApi, exports: Record<string, ThunkImplementation>;
let ram: Uint8Array, cursor: number, current: number, handlers: ThunkImplementation[], calls: Call[], frames: { cleanup: number; thread: number; esp: number }[], reset: Set<() => void>;
let nextThread: number, objects: BaseComObject[], abandoned: number, frees: number[], primary: number;
const ctx = () => ({ eax: 0, ebx: 1, ecx: 2, edx: 3, edi: 4, esi: 5, ebp: 6, esp: 0x2000, eip: 0x7000, eflags: 0x202 }) as X86Context;
const read = (ptr: number) => Mem.readUint32(ptr)!;
const write = (ptr: number, value: number) => Mem.writeUint32(ptr, value);
function call(name: string, args: number[] = [], pointer = primary) {
    // The real dispatcher supplies a fixed 32-slot reusable array.
    const slots = [pointer, ...args]; while (slots.length < 32) slots.push(0xdeadbeef);
    return exports["IDirectPlay8ThreadPool_" + name](ctx(), ram, slots);
}
function worker(index: number) { current = 100 + index; return handlers[index](ctx(), ram, []); }
function complete(index: number, result = 0): number | null {
    const invocation = calls[index]; current = invocation.thread;
    const value = invocation.done(result);
    if (value === null) invocation.enumerationState?.continueEnumeration();
    return value;
}
function drain(start = 0) { for (let i = start; i < calls.length; i++) complete(i); }
beforeEach(() => {
    ram = new Uint8Array(8 << 20); Mem.bind(() => ram); cursor = 0x600000; current = 1; handlers = []; calls = []; frames = []; reset = new Set();
    nextThread = 100; objects = []; abandoned = 0; frees = [];
    const alloc = (size: number) => { const ptr = cursor; cursor += (size + 15) & ~15; return ptr; };
    const generator = new ThunkGenerator(); generator.setBaseAddress(0x500000);
    process = {
        resetGeneration: 0, thunkGenerator: generator, getCurrentMemory: () => ram,
        memory: { alloc, allocSystemBlock: alloc, free: (ptr: number) => frees.push(ptr), freeSystemBlock() {} },
        addressSpace: { validateRange: (ptr: number, size: number, perms: string) => ptr >= 0x1000 && ptr + size <= ram.length && (!perms.includes("x") || ptr === 0x7000) },
        resourceProvider: { unregisterKernelObject() {} },
        onReset: (listener: () => void) => { reset.add(listener); return () => reset.delete(listener); },
        dispatcher: { register: (_dll: string, _name: string, handler: ThunkImplementation) => handlers.push(handler),
            callbackManager: {
                saveSuspendedThunkContext: (context: X86Context, cleanup: number) => { frames.push({ esp: context.esp, cleanup, thread: current }); return frames.length; },
                abandonSuspendedFrame: () => { abandoned++; },
                getPendingCallback: (id: number) => calls[id - 1],
                invokeCallback: (routine: number, args: number[], _cleanup: number, done: (value: number) => number | null) => {
                    calls.push({ routine, args, done, thread: current }); return { callbackId: calls.length };
                },
            } },
    } as unknown as Process;
    system.process = process; scheduler.createThread = () => nextThread++; scheduler.getThreadIdByHandle = handle => handle;
    scheduler.getCurrentThreadId = () => current;
    ComObjectFactory.register(DP8_THREADPOOL, class TestPool extends BaseComObject {
        constructor(table: number) { super(DP8_THREADPOOL, table); objects.push(this); } protected destroy() {}
    });
    const tables = { IDirectPlay8ThreadPool: { address: 0x20000, size: 8 } };
    api = new DirectPlayThreadPoolApi(process, () => tables); exports = {}; api.install(exports); executor = api.executor;
    const object = ComObjectFactory.create(DP8_THREADPOOL, 0x20000)!;
    primary = allocateComObject(process.memory, ram, 0x20000); resource.mapAddressToHandle(primary, object.handle);
});
afterEach(() => {
    executor.reset(); for (const object of objects) resource.unregisterComObject(object.handle);
    scheduler.createThread = original.create; scheduler.getThreadIdByHandle = original.id; scheduler.getCurrentThreadId = original.current; system.process = original.process;
});
test("ThreadPool ABI shares initialization across distinct COM identities and preserves controlling unknown", () => {
    expect(dpnetModule.interfaces!.find(iface => iface.name === "IDirectPlay8ThreadPool")!.methods.map(method => method.params.length)).toEqual([3, 1, 1, 4, 2, 4, 4, 3]);
    write(0x3000, 99); expect(call("GetThreadCount", [0xffffffff, 0x3000, 0])).toBe(DPN.UNINITIALIZED); expect(read(0x3000)).toBe(99);
    expect(call("GetThreadCount", [0, 0, 1])).toBe(DPN.INVALIDPOINTER);
    expect(call("SetThreadCount", [0xfffffffe, 0, 1])).toBe(DPN.INVALIDPARAM);
    expect(call("Initialize", [0, 0, 1])).toBe(DPN.INVALIDPARAM);
    expect(call("Initialize", [0x1234, 0x7000, 0])).toBe(0);
    const object = ComObjectFactory.create(DP8_THREADPOOL, 0x20000)!;
    const second = allocateComObject(process.memory, ram, 0x20000); resource.mapAddressToHandle(second, object.handle);
    expect(second).not.toBe(primary); expect(call("Initialize", [0, 0x7000, 0], second)).toBe(DPN.ALREADYINITIALIZED);
    ram.set(guidBytes("00000000-0000-0000-c000-000000000046"), 0x3100);
    expect(call("QueryInterface", [0x3100, 0x3200])).toBe(0); const unknown = read(0x3200); expect(unknown).not.toBe(primary);
    expect(call("QueryInterface", [0x3100, 0x3200], unknown)).toBe(0); expect(read(0x3200)).toBe(unknown);
    expect(call("Close", [0], second)).toBe(0); expect(call("Close", [0])).toBe(DPN.UNINITIALIZED);
});
test("zero worker count keeps bounded callbacks unprepared until DoWork on the issuing thread with exact ABI", () => {
    expect(call("Initialize", [0x1234, 0x7000, 0])).toBe(0); expect(call("SetThreadCount", [0xffffffff, 0, 0])).toBe(0);
    const lane = executor.channel(3), seen: number[] = []; let discarded = 0;
    for (let i = 0; i < 3; i++) expect(lane.enqueue({ prepare: () => ({ routine: 0x7000, args: [i], onReturn: () => seen.push(i) }) })).toBe(true);
    expect(lane.enqueue({ prepare: () => ({ routine: 1, args: [] }), onDiscard: () => discarded++ })).toBe(false);
    expect(calls).toHaveLength(0); expect(handlers).toHaveLength(0); expect(discarded).toBe(0);
    current = 77; const result = call("DoWork", [0, 0]) as ThunkResult; expect(result.suspendedForCallback).toBe(true);
    expect(frames[0]).toEqual({ esp: 0x2000, cleanup: 12, thread: 77 });
    expect(call("DoWork", [0, 0])).toBe(DPN.NOTALLOWED); drain();
    expect(seen).toEqual([0, 1, 2]); expect(calls.every(entry => entry.thread === 77)).toBe(true); expect(lane.size).toBe(0);
});
test("real worker resize waits for CREATE and DESTROY callbacks and retains each worker context", async () => {
    call("Initialize", [0x1234, 0x7000, 0]);
    const growing = call("SetThreadCount", [0xffffffff, 2, 0]) as Promise<ThunkResult>; let finished = false; void growing.then(() => finished = true);
    expect(handlers).toHaveLength(2); expect(executor.count).toBe(2);
    for (let i = 0; i < 2; i++) {
        worker(i); const callback = calls.at(-1)!; expect(callback.thread).toBe(100 + i); expect(callback.args.slice(0, 2)).toEqual([0x1234, 0xffff0017]);
        expect(read(callback.args[2])).toBe(16);
        expect(call("DoWork", [0, 0])).toBe(DPN.NOTREADY);
        expect(call("Close", [0])).toBe(DPN.NOTALLOWED); expect(call("SetThreadCount", [0xffffffff, 0, 0])).toBe(DPN.NOTALLOWED);
        write(callback.args[2] + 12, 0x5678 + i); complete(calls.length - 1);
    }
    expect((await growing).value).toBe(0); expect(finished).toBe(true);
    current = 1; expect(call("DoWork", [0, 0])).toBe(DPN.NOTREADY);
    const shrinking = call("SetThreadCount", [0xffffffff, 0, 0]) as Promise<ThunkResult>;
    for (let i = 0; i < 2; i++) {
        worker(i); const callback = calls.at(-1)!; expect(callback.args[1]).toBe(0xffff0018);
        expect(read(callback.args[2])).toBe(12); expect(read(callback.args[2] + 8)).toBe(0x5678 + i); complete(calls.length - 1);
    }
    expect((await shrinking).value).toBe(0); expect(executor.count).toBe(0);
});
test("closing one channel cancels an assigned unprepared task while other channels keep their worker", () => {
    const first = executor.channel(), second = executor.channel(); let discarded = 0, prepared = 0, returned = 0;
    first.enqueue({ prepare: () => { prepared++; return { routine: 0x7000, args: [] }; }, onDiscard: () => discarded++ });
    second.enqueue({ prepare: () => ({ routine: 0x7000, args: [2], onReturn: () => returned++ }) });
    first.close(); expect(discarded).toBe(1); expect(prepared).toBe(0); expect(handlers).toHaveLength(1);
    worker(0); expect(calls[0].args).toEqual([2]); complete(0); expect(returned).toBe(1);
    expect(first.size).toBe(0); expect(second.size).toBe(0);
});
test("callback payload byte quota refuses ownership without discarding or preparing the rejected task", () => {
    call("Initialize", [0, 0x7000, 0]); call("SetThreadCount", [0xffffffff, 0, 0]);
    const lane = executor.channel(100); let prepared = 0, discarded = 0;
    for (let i = 0; i < 8; i++) expect(lane.enqueue({ storageBytes: 1 << 20, prepare: () => { prepared++; return { routine: 1, args: [] }; }, onDiscard: () => discarded++ })).toBe(true);
    expect(lane.enqueue({ storageBytes: 1, prepare: () => ({ routine: 1, args: [] }), onDiscard: () => discarded++ })).toBe(false);
    expect(prepared).toBe(0); expect(discarded).toBe(0); lane.close(); expect(discarded).toBe(8);
});
test("DoWork frees capacity synchronously and drains a refilled callback transcript in order", () => {
    call("Initialize", [0, 0x7000, 0]); call("SetThreadCount", [0xffffffff, 0, 0]);
    const lane = executor.channel(2); let next = 0, completed = 0;
    const refill = () => {
        while (next < 500) {
            const number = next;
            if (!lane.enqueue({ prepare: () => ({ routine: 0x7000, args: [number], onReturn: () => { expect(number).toBe(completed++); } }) })) break;
            next++;
        }
    };
    lane.onSpace = refill; refill();
    const result = call("DoWork", [0, 0]) as ThunkResult; expect(result.suspendedForCallback).toBe(true); drain();
    expect(completed).toBe(500); expect(lane.size).toBe(0); expect(call("DoWork", [0, 0])).toBe(0);
});
test("resize allocation failure rolls back the reported worker count and discards the failed queue", async () => {
    call("Initialize", [0, 0x7000, 0]); scheduler.createThread = () => 0;
    const answer = await call("SetThreadCount", [0xffffffff, 1, 0]) as ThunkResult;
    expect(answer.value).toBe(DPN.OUTOFMEMORY); expect(executor.count).toBe(0);
    expect(call("DoWork", [0, 0])).toBe(0);
});
test("last COM Release drains thread destruction and permits a fresh pool initialization", async () => {
    call("Initialize", [0x1234, 0x7000, 0]);
    const growing = call("SetThreadCount", [0xffffffff, 1, 0]) as Promise<ThunkResult>;
    worker(0); complete(0); await growing; current = 1;
    const released = call("Release") as Promise<ThunkResult>; expect(released).toBeInstanceOf(Promise);
    worker(0); expect(calls[1].args[1]).toBe(0xffff0018); complete(1);
    expect((await released).value).toBe(0); expect(executor.initialized).toBe(false); expect(executor.count).toBe(0);
});
test("reset cancels old worker notifications and promises and gives the new lifetime a fresh executor", async () => {
    call("Initialize", [0x1234, 0x7000, 0]);
    const growing = call("SetThreadCount", [0xffffffff, 1, 0]) as Promise<ThunkResult>; worker(0);
    process.resetGeneration++; for (const listener of [...reset]) listener();
    expect((await growing).value).toBe(DPN.USERCANCEL); expect(calls[0].done(0)).toBe(0);
    const fresh = DirectPlayCallbackExecutor.forProcess(process); expect(fresh).not.toBe(executor); expect(fresh.initialized).toBe(false); expect(fresh.count).toBe(0); fresh.reset();
});
test("reset reclaims an active DoWork invocation once and ignores its stale return", () => {
    call("Initialize", [0, 0x7000, 0]); call("SetThreadCount", [0xffffffff, 0, 0]);
    const lane = executor.channel(); let returned = 0, discarded = 0;
    lane.enqueue({ prepare: () => ({ routine: 0x7000, args: [], onReturn: () => returned++, onDiscard: () => discarded++ }) });
    expect((call("DoWork", [0, 0]) as ThunkResult).suspendedForCallback).toBe(true);
    process.resetGeneration++; for (const listener of [...reset]) listener();
    expect(discarded).toBe(1); complete(0); expect(returned).toBe(0); expect(discarded).toBe(1);
});
test("inline callback rejection reclaims its prepared storage and frame exactly once", () => {
    call("Initialize", [0, 0x7000, 0]); call("SetThreadCount", [0xffffffff, 0, 0]);
    const lane = executor.channel(); let discarded = 0;
    lane.enqueue({ prepare: () => ({ routine: 0x7000, args: [], onDiscard: () => discarded++ }) });
    process.dispatcher.callbackManager.invokeCallback = () => { throw new Error("no guest frame"); };
    expect(call("DoWork", [0, 0])).toBe(DPN.GENERIC); expect(discarded).toBe(1); expect(lane.size).toBe(0); expect(abandoned).toBe(1);
});
