import { beforeEach, afterEach, test, expect } from "bun:test";
import { NativeDirectPlayCore } from "../../src/worker/modules/dpnet/native-wire/core";
import { DirectPlay8Session, type DirectPlay8Event } from "../../src/worker/modules/dpnet/peer";
import type { SessionDesc } from "../../src/worker/modules/dplayx/session";
import { DirectPlay8NetworkApi } from "../../src/worker/modules/dpnet/network-api";
import { DirectPlaySendOperationPool } from "../../src/worker/modules/dpnet/send-operations";
import { DirectPlayCallbackExecutor } from "../../src/worker/modules/dpnet/executor";
import { DirectPlayAddressApi } from "../../src/worker/modules/dpnet/address-api";
import { DirectPlayAddress } from "../../src/worker/modules/dpnet/address";
import { DPN, DP8_PEER, DP8_CLIENT, DP8_TCPIP, guidBytes, utf16 } from "../../src/worker/modules/dpnet/constants";
import { registerLobbyPeerProvider } from "../../src/worker/modules/dpnlobby/peer-bridge";
import { dpnetModule } from "../../src/worker/api/dpnet.api";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { BaseComObject, ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { allocateComObject } from "../../src/worker/core/com/com-memory";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { LanNetwork, nodeToIpv4 } from "../../src/worker/net/lan-network";
import { DN, decodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { decodeNativeEnumQuery, encodeNativeEnumResponse } from "../../src/worker/modules/dpnet/native-wire/discovery-codec";
import type { Process } from "../../src/worker/core/process";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../src/worker/core/thunking/thunk-dispatcher";
import type { VTableInfo } from "../../src/worker/api/adapters/module-adapter";
const system = System.getInstance(), scheduler = system.scheduler, resource = SystemResourceProvider.getInstance();
const oldProcess = system.process, oldCreate = scheduler.createThread, oldThreadId = scheduler.getThreadIdByHandle;
let network: LanNetwork;
let ram: Uint8Array, process: Process, api: DirectPlay8NetworkApi, addresses: DirectPlayAddressApi, exports: Record<string, ThunkImplementation>;
let objects: BaseComObject[], allocated: number, primary: number, methods: Map<string, ThunkImplementation>, reset: Set<() => void>, freed: number[];
let calls: { args: number[]; done: (hr: number) => number | null; enumerationState?: { continueEnumeration(): void } }[];
const ctx = () => ({ esp: 0x9000, eip: 0x7000, eax: 0, ebx: 0, ecx: 0, edx: 0, edi: 0, esi: 0, ebp: 0, eflags: 0x202 }) as X86Context;
const write = (p: number, n: number) => new DataView(ram.buffer).setUint32(p, n >>> 0, true);
const read = (p: number) => new DataView(ram.buffer).getUint32(p, true);
const call = (method: string, args: number[] = [], iface = "IDirectPlay8Peer") => {
    const slots = [primary, ...args]; while (slots.length < 32) slots.push(0xdeadbeef);
    return exports[iface + "_" + method](ctx(), ram, slots);
};
function callbacks(handler: (message: number, ptr: number) => number = () => 0) {
    const state = [...(api as unknown as { states: Map<number, { callbacks?: { queue: { size: number } } }> }).states.values()][0];
    while (state?.callbacks?.queue.size) {
        const before = calls.length;
        const result = [...methods.values()].at(-1)!(ctx(), ram, []) as ThunkResult;
        expect(result.suspendedForCallback).toBe(true); expect(calls.length).toBe(before + 1);
        const invocation = calls.at(-1)!;
        expect(invocation.args[0]).toBe(0x1234);
        invocation.done(handler(invocation.args[1] & 0xffff, invocation.args[2]));
    }
}
beforeEach(() => {
    ram = new Uint8Array(8 << 20); Mem.bind(() => ram); objects = []; allocated = 0x600000; methods = new Map(); calls = []; reset = new Set(); freed = [];
    const alloc = (size: number) => { const p = allocated; allocated += (size + 15) & ~15; return p; };
    const generator = new ThunkGenerator(); generator.setBaseAddress(0x500000);
    process = { resetGeneration: 0, thunkGenerator: generator, getCurrentMemory: () => ram,
        memory: { alloc, allocSystemBlock: alloc, free: (p: number) => freed.push(p), freeSystemBlock() {} },
        addressSpace: { validateRange: (p: number, n: number, perms: string) => p >= 0x1000 && p + n <= ram.length && (!perms.includes("x") || (p >= 0x7000 && p < 0x8000)) },
        resourceProvider: { unregisterKernelObject() {} },
        onReset: (fn: () => void) => { reset.add(fn); return () => reset.delete(fn); },
        dispatcher: { register: (_dll: string, name: string, fn: ThunkImplementation) => methods.set(name, fn),
            callbackManager: { saveSuspendedThunkContext: () => 1, abandonSuspendedFrame() {}, getPendingCallback: (id: number) => calls[id - 1],
                invokeCallback: (_routine: number, args: number[], _cleanup: number, done: (hr: number) => number | null) => {
                    calls.push({ args, done }); return { callbackId: calls.length };
                } } },
    } as unknown as Process;
    system.process = process; scheduler.createThread = () => 0x1234; scheduler.getThreadIdByHandle = () => 52;
    const tables = Object.fromEntries(dpnetModule.interfaces!.map((i, n) => [i.name, { address: 0x20000 + n * 0x100, size: i.methods.length }])) as Record<string, VTableInfo>;
    for (const iface of dpnetModule.interfaces!) {
        if (!iface.iid) continue;
        const iid = iface.iid;
        ComObjectFactory.register(iid, class TestObject extends BaseComObject {
            constructor(vtable: number) { super(iid, vtable); objects.push(this); } protected destroy() {}
        });
    }
    network = new LanNetwork(new Uint8Array([2, 0, 0, 0, 0, 1]));
    addresses = new DirectPlayAddressApi(process, () => tables, network);
    api = new DirectPlay8NetworkApi(process, () => tables, addresses, network); exports = {}; addresses.install(exports); api.install(exports);
    const obj = ComObjectFactory.create(DP8_PEER, tables.IDirectPlay8Peer.address)!;
    primary = allocateComObject(process.memory, ram, tables.IDirectPlay8Peer.address); resource.mapAddressToHandle(primary, obj.handle);
});
afterEach(() => { api.reset(); addresses.reset(); for (const obj of objects) resource.unregisterComObject(obj.handle);
    system.process = oldProcess; scheduler.createThread = oldCreate; scheduler.getThreadIdByHandle = oldThreadId; });
function initialize() { expect(call("Initialize", [0x1234, 0x7000, 0])).toBe(DPN.OK); }
async function host(poolInitialized = false) {
    if (poolInitialized) { const result = await call("Initialize", [0x1234, 0x7000, 0]); expect(typeof result === "number" ? result : result.value).toBe(DPN.OK); }
    else initialize(); write(0x3000, 24); write(0x3004, 1); write(0x3008, 0x3100); ram.set(utf16("Host\0"), 0x3100);
    expect((await call("SetPeerInfo", [0x3000, 0, 0, 0x80000000]) as ThunkResult).value).toBe(DPN.OK);
    const address = new DirectPlayAddress(); address.setGuid("provider", DP8_TCPIP); write(0x2000, addresses.create(address));
    write(0x4000, 72); write(0x4028, 4); write(0x4030, 0x3100); ram.set(guidBytes(DP8_PEER), 0x4018);
    const hosted = call("Host", [0x4000, 0x2000, 1, 0, 0, 0x5678, 0]) as ThunkResult;
    expect(hosted.suspendedForCallback).toBe(true); expect(hosted.stackCleanup).toBe(32);
    const invocation = calls.at(-1)!; expect(invocation.args[1]).toBe(0xffff0007);
    const ptr = invocation.args[2]; expect(read(ptr)).toBe(12);
    const id = read(ptr + 4); expect(read(ptr + 8)).toBe(0x5678); write(ptr + 8, 0x4321);
    expect(invocation.done(0)).toBe(DPN.OK);
    return id;
}
test("DP8 RegisterLobby validates before Initialize, retains its COM application and unregisters exactly once", () => {
    let retains = 0, drops = 0;
    registerLobbyPeerProvider(process, { retain: () => { retains++; return () => { drops++; }; }, post: () => 0 });
    expect(call("RegisterLobby", [0, 0, 0])).toBe(DPN.INVALIDFLAGS);
    expect(call("RegisterLobby", [0, 0, 3])).toBe(DPN.INVALIDPARAM);
    expect(call("RegisterLobby", [0, 0, 4])).toBe(DPN.INVALIDFLAGS);
    expect(call("RegisterLobby", [0, 0x3000, 1])).toBe(DPN.INVALIDHANDLE);
    expect(call("RegisterLobby", [99, 0, 1])).toBe(DPN.INVALIDPOINTER);
    expect(call("RegisterLobby", [99, 0x3000, 1])).toBe(DPN.UNINITIALIZED);
    initialize();
    expect(call("RegisterLobby", [99, 0x3000, 1])).toBe(0); expect(retains).toBe(1);
    expect(call("RegisterLobby", [99, 0x3000, 1])).toBe(DPN.ALREADYREGISTERED);
    expect(call("RegisterLobby", [99, 0, 2])).toBe(DPN.INVALIDPARAM);
    expect(call("RegisterLobby", [0, 0x3000, 2])).toBe(DPN.INVALIDPARAM);
    expect(call("RegisterLobby", [0, 0, 2])).toBe(0); expect(drops).toBe(1);
    expect(call("RegisterLobby", [0, 0, 2])).toBe(DPN.NOTREGISTERED);
});
test("Peer TerminateSession validates data pointer and flags before object state", () => {
    expect(call("TerminateSession", [0xfffffff0, 3, 1])).toBe(DPN.INVALIDPOINTER);
    expect(call("TerminateSession", [0, 1, 0])).toBe(DPN.INVALIDPOINTER);
    expect(call("TerminateSession", [0xfffffff0, 0, 1])).toBe(DPN.INVALIDFLAGS);
    expect(call("TerminateSession", [0xfffffff0, 0, 0])).toBe(DPN.UNINITIALIZED);
    initialize();
    expect(call("TerminateSession", [0xfffffff0, 3, 1])).toBe(DPN.INVALIDPOINTER);
    expect(call("TerminateSession", [0xfffffff0, 0, 1])).toBe(DPN.INVALIDFLAGS);
    expect(call("TerminateSession", [0xfffffff0, 0, 0])).toBe(DPN.NOCONNECTION);
});

test("DP8 guest native caps, SetPeerInfo and Host callback structures preserve local player context", async () => {
    write(0x3000, 20); expect(call("GetCaps", [0x3000, 0])).toBe(DPN.UNINITIALIZED);
    const id = await host(); expect(id).toBeGreaterThan(0);
    write(0x3000, 48); expect(call("GetCaps", [0x3000, 0])).toBe(DPN.OK);
    expect(Array.from({ length: 12 }, (_, i) => read(0x3000 + i * 4))).toEqual([48, 0, 200, 14, 25000, 0xffffffff, 10, 5000, 7, 25, 3, 500]);
    write(0x3200, 0); expect(call("GetPeerInfo", [id, 0, 0x3200, 0])).toBe(DPN.BUFFERTOOSMALL); expect(read(0x3200)).toBe(34);
    write(0x3200, 128); write(0x3300, 24); expect(call("GetPeerInfo", [id, 0x3300, 0x3200, 0])).toBe(DPN.OK);
    expect(read(0x3314)).toBe(6); expect(read(0x3310)).toBe(0);
    expect(call("GetPlayerContext", [id, 0x3400, 0])).toBe(DPN.OK); expect(read(0x3400)).toBe(0x4321);
    write(0x3200, 0); expect(call("GetApplicationDesc", [0, 0x3200, 0])).toBe(DPN.BUFFERTOOSMALL); expect(read(0x3200)).toBe(82);
});
test("DP8 self-send retains RECEIVE buffer only on PENDING, ReturnBuffer releases it exactly once", async () => {
    const id = await host(); ram.set([10, 20, 30], 0x3500); write(0x3400, 3); write(0x3404, 0x3500);
    expect(await call("SendTo", [id, 0x3400, 1, 0, 0, 0, 0x80000008])).toBe(DPN.OK);
    let buffer = 0, allocation = 0;
    callbacks((message, ptr) => {
        expect(message).toBe(0x11); expect(read(ptr)).toBe(28); expect(read(ptr + 4)).toBe(id); expect(read(ptr + 8)).toBe(0x4321);
        expect([...ram.slice(read(ptr + 12), read(ptr + 12) + read(ptr + 16))]).toEqual([10, 20, 30]); expect(read(ptr + 24)).toBe(1);
        buffer = read(ptr + 20); allocation = ptr; return DPN.PENDING;
    });
    expect(freed.includes(allocation)).toBe(false);
    expect(call("ReturnBuffer", [buffer, 0])).toBe(DPN.OK); expect(freed.filter(p => p === allocation).length).toBe(1);
    expect(call("ReturnBuffer", [buffer, 0])).toBe(DPN.INVALIDHANDLE);
});
test("receive processing completion follows callback return even when its buffer is retained", async () => {
    await host(); const state = [...(api as unknown as { states: Map<number, { callbacks: { emit(event: unknown): boolean } }> }).states.values()][0]; let processed = 0, handle = 0;
    expect(state.callbacks.emit({ type: 0x11, id: 1, data: Uint8Array.of(4, 0, 8), processed: () => { processed++; } })).toBe(true);
    expect(processed).toBe(0); callbacks((message, ptr) => { expect(message).toBe(0x11); expect(processed).toBe(0); handle = read(ptr + 20); return DPN.PENDING; });
    expect(processed).toBe(1); expect(call("ReturnBuffer", [handle, 0])).toBe(0); expect(processed).toBe(1);
});

test("retained receive buffers have bounded admission and releasing one buffer resumes its capacity", async () => {
    await host(); const state = [...(api as unknown as { states: Map<number, { callbacks: { emit(event: unknown): boolean } }> }).states.values()][0]; const handles: number[] = [];
    for (let i = 0; i < 4096; i++) {
        expect(state.callbacks.emit({ type: 0x11, id: 1, data: new Uint8Array() })).toBe(true);
        callbacks((_message, ptr) => { handles.push(read(ptr + 20)); return DPN.PENDING; });
    }
    expect(state.callbacks.emit({ type: 0x11, id: 1, data: new Uint8Array() })).toBe(false);
    expect(call("ReturnBuffer", [handles[0], 0])).toBe(0);
    expect(state.callbacks.emit({ type: 0x11, id: 1, data: new Uint8Array() })).toBe(true);
    callbacks((_message, ptr) => { handles.push(read(ptr + 20)); return DPN.PENDING; });
    for (const handle of handles.slice(1)) expect(call("ReturnBuffer", [handle, 0])).toBe(0);
});

test("send admission preserves output handles under callback pressure and delivers every completion once after space returns", async () => {
    await host();
    const state = [...(api as unknown as { states: Map<number, {
        callbacks: { native(type: number, size: number): boolean };
        sends: { pending: unknown[]; reservedJobs: number; pendingBytes: number };
        sendRecords: Map<number, unknown>;
    }> }).states.values()][0];
    let filled = 0; while (state.callbacks.native(2, 0)) { filled++; if (filled > 3000) throw Error("Callback queue admission is unbounded"); }
    expect(filled).toBeGreaterThan(256);
    ram.set([9], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    const admitted: number[] = [];
    for (let i = 0; i < 256; i++) {
        expect(call("SendTo", [0, 0x3400, 1, 0, i, 0x3600, 0x20])).toBe(DPN.PENDING); admitted.push(read(0x3600));
    }
    write(0x3600, 0xcccccccc); expect(call("SendTo", [0, 0x3400, 1, 0, 999, 0x3600, 0x20])).toBe(DPN.OUTOFMEMORY); expect(read(0x3600)).toBe(0xcccccccc);
    const deadline = Date.now() + 2000; while (state.sends.pending.length) { if (Date.now() >= deadline) throw Error("Queued sends did not complete"); await Bun.sleep(1); }
    expect(state.sends.pendingBytes).toBe(0); expect(state.sends.reservedJobs).toBe(256); expect(state.sendRecords.size).toBe(256);
    const completed: number[] = [];
    callbacks((message, ptr) => { if (message === 2) return 0; expect(message).toBe(0x14); expect(read(ptr + 12)).toBe(0); completed.push(read(ptr + 4)); return 0; });
    expect(completed).toEqual(admitted); expect(new Set(completed).size).toBe(256); expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0);
    await Bun.sleep(8); callbacks(() => { throw Error("Duplicated completion"); });
    expect(call("SendTo", [0, 0x3400, 1, 0, 1000, 0x3600, 0x20])).toBe(DPN.PENDING); await Bun.sleep(8); let last = 0;
    callbacks((message, ptr) => { expect(message).toBe(0x14); expect(read(ptr + 8)).toBe(1000); last++; return 0; }); expect(last).toBe(1);
});
test("Close delivers blocked send completions while reset abandons the old lifetime before fresh initialization", async () => {
    for (const closing of [true, false]) {
        await host();
        const state = [...(api as unknown as { states: Map<number, {
            callbacks: { native(type: number, size: number): boolean };
            sends: { pending: unknown[]; reservedJobs: number; pendingBytes: number; retryCompletions(): void };
            sendRecords: Map<number, unknown>;
        }> }).states.values()][0];
        let filled = 0; while (state.callbacks.native(2, 0)) { if (++filled > 3000) throw Error("Unbounded callback admission"); }
        ram.set([7], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
        expect(call("SendTo", [0, 0x3400, 1, 0, 123, 0x3600, 0x20])).toBe(DPN.PENDING);
        const deadline = Date.now() + 2000; while (state.sends.pending.length) { if (Date.now() >= deadline) throw Error("Send completion timeout"); await Bun.sleep(1); }
        expect(state.sendRecords.size).toBe(1); expect(state.sends.reservedJobs).toBe(1);
        if (closing) {
            const close = call("Close", [0]) as Promise<ThunkResult>;
            expect(state.sendRecords.size).toBe(1); expect(state.sends.reservedJobs).toBe(1);
            let completed = 0; callbacks((message, ptr) => { expect([2, 9, 0x14]).toContain(message); if (message === 0x14) { completed++; expect(read(ptr + 12)).toBe(0); } return 0; }); expect(completed).toBe(1);
            const result = await close; expect(result.value).toBe(0); result.startCallbackChain?.({ esp: 0x9000, returnAddr: 0x7000 });
            expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0);
        } else { api.reset(); expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0); }
        state.sends.retryCompletions(); await Bun.sleep(8); expect(state.sends.pendingBytes).toBe(0);
        if (closing) { await host(); expect(call("SendTo", [0, 0x3400, 1, 0, 999, 0x3600, 0x20])).toBe(DPN.PENDING); await Bun.sleep(8);
            let completed = 0; callbacks((message, ptr) => { expect(message).toBe(0x14); expect(read(ptr + 8)).toBe(999); completed++; return 0; }); expect(completed).toBe(1); api.reset(); }
    }
});
interface LocalCompletion { flags: number; rtt: number; hr: number; }
async function manualHost() {
    const executor = DirectPlayCallbackExecutor.forProcess(process);
    if (!executor.initialized) expect(executor.initialize(0x7000, 0)).toBe(0);
    expect(await executor.setCount(0)).toBe(0); return host(true);
}
function finishManual(begin: number, handler: (message: number, ptr: number) => void) {
    for (let i = begin; i < calls.length; i++) {
        const invocation = calls[i]; handler(invocation.args[1] & 0xffff, invocation.args[2]);
        const result = invocation.done(0);
        if (result === null) invocation.enumerationState!.continueEnumeration();
    }
}
async function manualWork(handler: (message: number, ptr: number) => void) {
    for (let turn = 0; turn < 1000; turn++) {
        const begin = calls.length; DirectPlayCallbackExecutor.forProcess(process).run(ctx(), 0);
        finishManual(begin, handler); await Bun.sleep(1);
        const states = [...(api as unknown as { states: Map<number, { sends: { pending: unknown[] }; callbacks?: { pending: number } }> }).states.values()];
        if (states.every(state => !state.sends.pending.length && !state.callbacks?.pending)) return;
    }
    throw Error("Manual DirectPlay work did not settle");
}
function collectCompletion(completed: Map<number, LocalCompletion>, message: number, ptr: number) {
    if (message === 0x14) completed.set(read(ptr + 8), { hr: read(ptr + 12), rtt: read(ptr + 20), flags: read(ptr + 28) });
}
function localSend(id: number, flags: number, context: number, completed: Map<number, LocalCompletion>) {
    write(0x3400, 4); write(0x3404, 0x3500); write(0x3500, 0x12340000 + context);
    const begin = calls.length, result = call("SendTo", [id, 0x3400, 1, 0, context, 0x3600, flags]);
    finishManual(begin, (message, ptr) => collectCompletion(completed, message, ptr));
    expect(typeof result === "number" ? result : (result as ThunkResult).value).toBe(DPN.PENDING);
}
test("local COP metadata follows actual recycled operations across warmup and repeat batches", async () => {
    const id = await manualHost(), completed = new Map<number, LocalCompletion>();
    for (let batch = 0; batch < 2; batch++) {
        for (let i = 0; i < 2; i++) localSend(id, 13, batch * 10 + i, completed);
        await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
        expect([0, 1].map(i => completed.get(batch * 10 + i))).toEqual([
            { hr: 0, rtt: 0xffffffff, flags: 0 }, { hr: 0, rtt: 0xffffffff, flags: 1 },
        ]);
    }
    localSend(id, 8, 100, completed); await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
    localSend(id, 12, 101, completed); await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
    expect(completed.get(101)).toEqual({ hr: 0, rtt: 0xffffffff, flags: 1 });
});
test("manual local COP batches retire operations within each DoWork without host scheduling", async () => {
    const id = await manualHost(), completed = new Map<number, LocalCompletion>(); let context = 0;
    for (const size of [16, 2, 2]) {
        const first = context;
        for (let i = 0; i < size; i++) localSend(id, 13, context++, completed);
        const begin = calls.length; DirectPlayCallbackExecutor.forProcess(process).run(ctx(), 0);
        finishManual(begin, (message, ptr) => collectCompletion(completed, message, ptr));
        expect(Array.from({ length: size }, (_, i) => completed.get(first + i))).toEqual(
            Array.from({ length: size }, (_, i) => ({ hr: 0, rtt: 0xffffffff, flags: i ? 1 : 0 })));
        expect(DirectPlaySendOperationPool.forProcess(process).activeLeases).toBe(0);
    }
});
test("processing request union initialization survives a sixteen then two then two batch sequence", async () => {
    const id = await manualHost(), completed = new Map<number, LocalCompletion>(); let context = 0;
    for (const size of [16, 2, 2]) {
        const first = context;
        for (let i = 0; i < size; i++) localSend(id, 13, context++, completed);
        await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
        expect(Array.from({ length: size }, (_, i) => completed.get(first + i)?.flags)).toEqual([0, ...new Array(size - 1).fill(1)]);
    }
});
test("alternating unreliable delivery resets metadata inherited by guaranteed COP requests", async () => {
    const id = await manualHost(), completed = new Map<number, LocalCompletion>();
    for (let i = 0; i < 16; i++) localSend(id, i & 1 ? 13 : 1, i, completed);
    await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
    expect(Array.from({ length: 16 }, (_, i) => completed.get(i)?.flags)).toEqual(new Array(16).fill(0));
    expect(Array.from({ length: 8 }, (_, i) => completed.get(i * 2 + 1)?.rtt)).toEqual(new Array(8).fill(0xffffffff));
});
test("local send metadata survives peer replacement and retires on the process reset boundary", async () => {
    const completed = new Map<number, LocalCompletion>(); let id = await manualHost();
    localSend(id, 8, 0, completed); await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
    const table = read(primary);
    let begin = calls.length; call("Close", [0]); finishManual(begin, () => {}); expect(call("Release")).toBe(0);
    const object = ComObjectFactory.create(DP8_PEER, table)!;
    primary = allocateComObject(process.memory, ram, table); resource.mapAddressToHandle(primary, object.handle);
    id = await host(true); localSend(id, 13, 1, completed); await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
    expect(completed.get(1)).toEqual({ hr: 0, rtt: 0xffffffff, flags: 1 });
    api.reset(); for (const listener of [...reset]) listener(); (process as unknown as { resetGeneration: number }).resetGeneration++;
    id = await manualHost();
    localSend(id, 13, 2, completed); await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
    expect(completed.get(2)).toEqual({ hr: 0, rtt: 0xffffffff, flags: 0 });
});
test("aggregate operation pressure preserves guest outputs and Final Release retires pending leases", async () => {
    const id = await manualHost(), pool = new DirectPlaySendOperationPool(4, 3), completed = new Map<number, LocalCompletion>();
    (api as unknown as { sendOperations: DirectPlaySendOperationPool }).sendOperations = pool;
    localSend(id, 13, 1, completed); expect(pool.activeLeases).toBe(2);
    write(0x3600, 0xcccccccc);
    expect(call("SendTo", [id, 0x3400, 1, 0, 2, 0x3600, 13])).toBe(DPN.OUTOFMEMORY);
    expect(read(0x3600)).toBe(0xcccccccc); expect(pool.activeLeases).toBe(2);
    expect(call("Release")).toBe(0); expect(pool.activeLeases).toBe(0);
});
test("resetting another API wrapper cannot erase live process-owned operation leases", async () => {
    const id = await manualHost(), pool = DirectPlaySendOperationPool.forProcess(process), completed = new Map<number, LocalCompletion>();
    localSend(id, 13, 1, completed); expect(pool.activeLeases).toBe(2);
    const other = new DirectPlay8NetworkApi(process, api.tables, addresses, network); other.reset();
    expect(pool.activeLeases).toBe(2);
    await manualWork((message, ptr) => collectCompletion(completed, message, ptr));
    expect(completed.get(1)).toEqual({ hr: 0, rtt: 0xffffffff, flags: 0 }); expect(pool.activeLeases).toBe(0);
});
test("one synchronous DoWork completes self COP before any host microtask, including retained RECEIVE data", async () => {
    const id = await manualHost(), completed = new Map<number, LocalCompletion>();
    for (const flags of [12, 13]) {
        localSend(id, flags, flags, completed); write(0x3500, 0xabcd0000 + flags);
        const order: number[] = [], received: number[] = [], handles: number[] = [];
        const begin = calls.length, result = DirectPlayCallbackExecutor.forProcess(process).run(ctx(), 0);
        expect(typeof result !== "number" && result.suspendedForCallback).toBe(true);
        for (let i = begin; i < calls.length; i++) {
            const invocation = calls[i], message = invocation.args[1] & 0xffff, ptr = invocation.args[2];
            order.push(message); collectCompletion(completed, message, ptr);
            if (message === 0x11) { received.push(read(read(ptr + 12))); handles.push(read(ptr + 20)); }
            if (message === 0x14) {
                expect(read(ptr + 36)).toBe(flags & 1);
                if (flags & 1) { const descriptor = read(ptr + 32); expect(read(descriptor + 4)).toBe(0x3500); expect(read(0x3500)).toBe(0xabcd0000 + flags); }
            }
            const next = invocation.done(message === 0x11 ? DPN.PENDING : 0);
            if (next === null) invocation.enumerationState!.continueEnumeration();
        }
        // Deliberately no await/yield between returning from RECEIVE and inspecting completion.
        expect(order).toEqual([0x11, 0x14]); expect(received).toEqual([0x12340000 + flags]);
        expect(completed.get(flags)).toEqual({ hr: 0, rtt: 0xffffffff, flags: 0 });
        expect(DirectPlaySendOperationPool.forProcess(process).activeLeases).toBe(0);
        for (const handle of handles) expect(call("ReturnBuffer", [handle, 0])).toBe(0);
    }
});
test("self COP snapshots COPY and NOCOPY data before SendTo returns while retaining original descriptors", async () => {
    const id = await manualHost(), completed = new Map<number, LocalCompletion>();
    for (const flags of [12, 13]) {
        localSend(id, flags, flags, completed); write(0x3500, 0xabcd0000 + flags);
        const received: number[] = [];
        await manualWork((message, ptr) => {
            collectCompletion(completed, message, ptr);
            if (message === 0x11) received.push(read(read(ptr + 12)));
            if (message === 0x14 && flags & 1) {
                const descriptor = read(ptr + 32); expect(read(descriptor + 4)).toBe(0x3500);
                expect(read(read(descriptor + 4))).toBe(0xabcd0000 + flags);
            }
        });
        expect(received).toEqual([0x12340000 + flags]);
    }
});
for (const [flags, cancelFirst] of [[12, false], [13, false], [12, true], [13, true]] as const)
test(`manual Close drains sixteen cancelled COP completions, flags ${flags}, cancel ${cancelFirst}`, async () => {
        const executor = DirectPlayCallbackExecutor.forProcess(process);
        if (!executor.initialized) expect(executor.initialize(0x7000, 0)).toBe(0);
        expect(executor.setCount(0)).toBe(0); const id = await host(true);
        const state = [...(api as unknown as { states: Map<number, { sends: { pending: unknown[]; pendingBytes: number; reservedJobs: number }; sendRecords: Map<number, unknown> }> }).states.values()][0];
        const handles: number[] = []; ram.set([7, 0, 9], 0x3500); write(0x3400, 3); write(0x3404, 0x3500);
        for (let i = 0; i < 16; i++) { expect(call("SendTo", [id, 0x3400, 1, 0, 0x2000 + i, 0x3600, flags])).toBe(DPN.PENDING); handles.push(read(0x3600)); }
        await Bun.sleep(5); expect(state.sends.pending.length).toBe(16);
        if (cancelFirst) expect(call("CancelAsyncOperation", [0, 4])).toBe(0);
        const before = calls.length, result = call("Close", [0]) as ThunkResult; expect(result.suspendedForCallback).toBe(true);
        const messages: number[] = [], completed: number[] = [];
        for (let i = before; i < calls.length; i++) {
            const invocation = calls[i], message = invocation.args[1] & 0xffff, ptr = invocation.args[2]; messages.push(message);
            if (message === 0x14) {
                expect(read(ptr)).toBe(40); expect(read(ptr + 12)).toBe(DPN.USERCANCEL);
                const index = read(ptr + 8) - 0x2000;
                expect(read(ptr + 20)).toBe(0xffffffff); expect(read(ptr + 24)).toBe(0); expect(read(ptr + 28)).toBe([0, ...new Array(15).fill(1)][index]);
                expect(read(ptr + 4)).toBe(handles[index]); expect(read(ptr + 36)).toBe(flags & 1 ? 1 : 0);
                const descriptor = read(ptr + 32); if (flags & 1) { expect(read(descriptor)).toBe(3); expect(read(descriptor + 4)).toBe(0x3500); } else expect(descriptor).toBe(0); completed.push(index);
            } else { expect(message).toBe(9); expect(read(ptr + 12)).toBe(1); }
            const value = invocation.done(0); if (value === null) invocation.enumerationState!.continueEnumeration(); else expect(value).toBe(0);
        }
        expect(messages).toEqual([...new Array(16).fill(0x14), 9]); expect(completed).toEqual(Array.from({ length: 16 }, (_, i) => i));
        expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0); expect(state.sends.pendingBytes).toBe(0);
        const ended = calls.length; await Bun.sleep(8); expect(calls.length).toBe(ended);
});
test("manual Close refills a full callback lane without dropping any of 256 cancelled completions", async () => {
    const executor = DirectPlayCallbackExecutor.forProcess(process); expect(executor.initialize(0x7000, 0)).toBe(0); expect(executor.setCount(0)).toBe(0);
    const id = await host(true), state = [...(api as unknown as { states: Map<number, { callbacks: { native(type: number, size: number): boolean }; sends: { reservedJobs: number }; sendRecords: Map<number, unknown> }> }).states.values()][0];
    let filled = 0; while (state.callbacks.native(2, 0)) { if (++filled > 3000) throw Error("Unbounded callback queue"); } expect(filled).toBe(2304);
    ram.set([1], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    for (let i = 0; i < 256; i++) expect(call("SendTo", [id, 0x3400, 1, 0, i, 0x3600, 13])).toBe(DPN.PENDING);
    const begin = calls.length, result = call("Close", [0]) as ThunkResult; expect(result.suspendedForCallback).toBe(true);
    const completed: number[] = []; let destroyed = 0;
    for (let i = begin; i < calls.length; i++) {
        const invocation = calls[i], message = invocation.args[1] & 0xffff, ptr = invocation.args[2];
        if (message === 0x14) { expect(read(ptr + 12)).toBe(DPN.USERCANCEL); completed.push(read(ptr + 8)); }
        else if (message === 9) { destroyed++; expect(completed.length).toBe(256); } else expect(message).toBe(2);
        const value = invocation.done(0); if (value === null) invocation.enumerationState!.continueEnumeration(); else expect(value).toBe(0);
    }
    expect(completed).toEqual(Array.from({ length: 256 }, (_, i) => i)); expect(destroyed).toBe(1); expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0);
});
test("SYNC self COP preserves a real quota failure while older callbacks are pending", async () => {
    const id = await host(), state = [...(api as unknown as { states: Map<number, { session: { send(id: number, flags: number, data: Uint8Array): number | Promise<number> } }> }).states.values()][0];
    const pending: (number | Promise<number>)[] = [];
    for (let i = 0; i < 256; i++) pending.push(state.session.send(id, 12, Uint8Array.of(i)));
    ram.set([1], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    expect(await call("SendTo", [id, 0x3400, 1, 0, 0, 0, 0x8000000c])).toBe(DPN.TABLEFULL);
    callbacks(message => { expect(message).toBe(0x11); return 0; }); expect((await Promise.all(pending)).every(hr => hr === 0)).toBe(true);
});
test("reset inside a manual Close callback returns cancellation and cannot finish the old lifetime successfully", async () => {
    const executor = DirectPlayCallbackExecutor.forProcess(process); expect(executor.initialize(0x7000, 0)).toBe(0); expect(executor.setCount(0)).toBe(0);
    const id = await host(true); ram.set([1], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    expect(call("SendTo", [id, 0x3400, 1, 0, 1, 0x3600, 13])).toBe(DPN.PENDING); await Bun.sleep(5);
    expect((call("Close", [0]) as ThunkResult).suspendedForCallback).toBe(true);
    const invocation = calls.at(-1)!; expect(invocation.args[1] & 0xffff).toBe(0x14); api.reset();
    expect(invocation.done(0)).toBe(DPN.USERCANCEL); await host(true);
});
test("reset during Close cannot finalize or clear a freshly initialized lifetime", async () => {
    await host(); const pending = call("Close", [0]) as Promise<ThunkResult>;
    api.reset(); await host();
    ram.set([1], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    expect(call("SendTo", [0, 0x3400, 1, 0, 789, 0x3600, 0x20])).toBe(DPN.PENDING);
    const stale = await pending; expect(stale.value).toBe(DPN.USERCANCEL); expect(stale.startCallbackChain?.({ esp: 0x9000, returnAddr: 0x7000 })).toBe(false);
    await Bun.sleep(8); let completed = 0; callbacks((message, ptr) => { expect(message).toBe(0x14); expect(read(ptr + 8)).toBe(789); completed++; return 0; }); expect(completed).toBe(1);
    expect(call("GetCaps", [0x3000, 0])).toBe(DPN.INVALIDPARAM);
});
test("native SEND_COMPLETE only returns NOCOPY descriptors and self queue errors preserve outputs", async () => {
    const id = await host(); ram.set([7, 0, 9], 0x3500); write(0x3400, 1); write(0x3404, 0x3500); write(0x3408, 2); write(0x340c, 0x3501);
    write(0x3700, 999); write(0x3704, 999); expect(call("GetSendQueueInfo", [id, 0x3700, 0x3704, 0])).toBe(DPN.INVALIDPLAYER); expect(read(0x3700)).toBe(999); expect(read(0x3704)).toBe(999);
    for (const flags of [0, 1, 8, 9]) {
        expect(call("SendTo", [id, 0x3400, 2, 0, flags + 100, 0x3600, flags])).toBe(DPN.PENDING); const handle = read(0x3600); await Bun.sleep(8); let completed = 0;
        callbacks((message, ptr) => { if (message === 0x11) return 0; expect(message).toBe(0x14); completed++;
            expect(read(ptr)).toBe(40); expect(read(ptr + 4)).toBe(handle); expect(read(ptr + 8)).toBe(flags + 100); expect(read(ptr + 12)).toBe(0); expect(read(ptr + 20)).toBe(0); expect(read(ptr + 24)).toBe(0); expect(read(ptr + 28)).toBe(flags & 8 ? 1 : 0);
            expect(read(ptr + 36)).toBe(flags & 1 ? 2 : 0);
            if (flags & 1) { const descriptors = read(ptr + 32); expect(descriptors).toBeGreaterThan(0); expect([read(descriptors), read(descriptors + 4), read(descriptors + 8), read(descriptors + 12)]).toEqual([1, 0x3500, 2, 0x3501]); } else expect(read(ptr + 32)).toBe(0);
            return 0;
        }); expect(completed).toBe(1);
    }
});
test("DP8 NOCOMPLETE releases all send reservations while the guest callback queue stays full", async () => {
    await host(); const state = [...(api as unknown as { states: Map<number, { callbacks: { native(type: number, size: number): boolean }; sends: { pending: unknown[]; reservedJobs: number }; sendRecords: Map<number, unknown> }> }).states.values()][0];
    let filled = 0; while (state.callbacks.native(2, 0)) { if (++filled > 3000) throw Error("Unbounded callback admission"); }
    ram.set([9], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 256; i++) expect(call("SendTo", [0, 0x3400, 1, 0, i, 0x3600, 0x22])).toBe(DPN.PENDING);
        const deadline = Date.now() + 2000; while (state.sends.pending.length) { if (Date.now() >= deadline) throw Error("NOCOMPLETE delivery stalled"); await Bun.sleep(1); }
        expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0);
    }
    callbacks(message => { expect(message).toBe(2); return 0; });
});
test("last COM Release abandons blocked completion storage and prevents old callbacks", async () => {
    await host(); const state = [...(api as unknown as { states: Map<number, { callbacks: { native(type: number, size: number): boolean }; sends: { pending: unknown[]; reservedJobs: number; retryCompletions(): void }; sendRecords: Map<number, unknown> }> }).states.values()][0];
    let filled = 0; while (state.callbacks.native(2, 0)) { if (++filled > 3000) throw Error("Unbounded callback admission"); }
    ram.set([9], 0x3500); write(0x3400, 1); write(0x3404, 0x3500); expect(call("SendTo", [0, 0x3400, 1, 0, 5, 0x3600, 0x20])).toBe(DPN.PENDING);
    const deadline = Date.now() + 2000; while (state.sends.pending.length) { if (Date.now() >= deadline) throw Error("Send completion stalled"); await Bun.sleep(1); }
    expect(state.sendRecords.size).toBe(1); expect(call("Release")).toBe(0); expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0);
    const before = calls.length; state.sends.retryCompletions(); await Bun.sleep(8); expect(calls.length).toBe(before);
});
test("cancel while external Connect DNS is pending cannot bind UDP or revive the cancelled request", async () => {
    initialize(); let finish!: (result: { addresses: { family: 4; address: string }[] }) => void;
    network.resolve = () => new Promise(resolve => { finish = resolve; });
    const address = new DirectPlayAddress(); address.buildHost("native.test", 2309); const addressPtr = addresses.create(address);
    write(0x4000, 72); ram.set(guidBytes(DP8_PEER), 0x4018);
    expect(call("Connect", [0x4000, addressPtr, 0, 0, 0, 0, 0, 0x4321, 0, 0x4200, 0])).toBe(DPN.PENDING);
    await Promise.resolve(); const handle = read(0x4200); expect(call("CancelAsyncOperation", [handle, 0])).toBe(0);
    finish({ addresses: [{ family: 4, address: "198.18.0.61" }] }); await Bun.sleep(1);
    expect(network.isBound(2302, PROTO_UDP)).toBe(false); let completed = 0;
    callbacks((message, ptr) => { expect(message).toBe(5); expect(read(ptr + 4)).toBe(handle); expect(read(ptr + 12)).toBe(DPN.USERCANCEL); completed++; return 0; });
    expect(completed).toBe(1);
});

test("DP8 send flags and async-handle preservation match the native 22-case oracle", async () => {
    const id = await host(); ram.set([1], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    const cases: [number, boolean, number, number][] = [
        [0,false,DPN.INVALIDPARAM,0],[0,true,DPN.PENDING,1],[2,false,DPN.INVALIDPARAM,0],[2,true,DPN.PENDING,1],
        [8,false,DPN.INVALIDPARAM,0],[8,true,DPN.PENDING,1],[10,true,DPN.INVALIDFLAGS,0],[4,true,DPN.INVALIDFLAGS,0],[12,true,DPN.PENDING,1],
        [0x80000000,false,0,1],[0x80000001,false,0,1],[0x80000002,false,0,1],[0x80000004,false,DPN.INVALIDFLAGS,0],
        [0x80000008,false,0,1],[0x8000000c,false,0,1],[0x80000010,false,0,1],[0x80000020,false,DPN.INVALIDPARAM,0],
        [0x8000000a,false,0,1],[0x100,true,DPN.PENDING,1],[0x80000100,false,0,1],[0x80000080,false,0,1],[0x800000c0,false,DPN.INVALIDFLAGS,0],
    ];
    for (const [flags, handle, expected, receives] of cases) {
        write(0x3600, 0xcccccccc); const result = await call("SendTo", [id, 0x3400, 1, 100, 0, handle ? 0x3600 : 0, flags]); let count = 0;
        if (typeof result !== "number" && result.suspendedForCallback) { const invocation = calls.at(-1)!; expect(invocation.args[1] & 0xffff).toBe(0x11); count++; expect(invocation.done(0)).toBe(expected); }
        else expect(result).toBe(expected);
        expect(read(0x3600) !== 0xcccccccc).toBe(handle && expected === DPN.PENDING);
        await Bun.sleep(1); callbacks(message => { if (message === 0x11) count++; return 0; }); expect(count).toBe(receives);
    }
    write(0x3400, 0); expect(await call("SendTo", [id, 0x3400, 1, 100, 0, 0, 0x80000000])).toBe(DPN.INVALIDPARAM);
});

test("DP8 async send handles stay distinct when the caller reuses one opaque context", async () => {
    const id = await host(); ram.set([1, 2], 0x3500); write(0x3400, 1); write(0x3404, 0x3500);
    expect(call("SendTo", [id, 0x3400, 1, 0, 0, 0x3600, 8])).toBe(DPN.PENDING); const a = read(0x3600);
    write(0x3404, 0x3501); expect(call("SendTo", [id, 0x3400, 1, 0, 0, 0x3600, 8])).toBe(DPN.PENDING); const b = read(0x3600);
    expect(a).not.toBe(b); await Bun.sleep(10);
    const completed: number[] = [], received: number[] = [];
    callbacks((message, ptr) => { if (message === 0x14) { completed.push(read(ptr + 4)); expect(read(ptr + 8)).toBe(0); expect(read(ptr + 12)).toBe(0); } else if (message === 0x11) received.push(ram[read(ptr + 12)]); return 0; });
    expect(completed).toEqual([a, b]); expect(received).toEqual([1, 2]);
});
test("DP8 Close waits for destroy callbacks and owner-safe finalization permits re-initialize", async () => {
    await host(); const pending = call("Close", [0]) as Promise<ThunkResult>;
    expect(call("GetCaps", [0x3000, 0])).toBe(DPN.ALREADYCLOSING);
    callbacks((message, ptr) => { expect(message).toBe(9); expect(read(ptr + 8)).toBe(0x4321); return 0; });
    const result = await pending; expect(result.value).toBe(0);
    expect(result.startCallbackChain?.({ esp: 0x9000, mem: ram })).toBe(false);
    expect(call("GetCaps", [0x3000, 0])).toBe(DPN.UNINITIALIZED); initialize();
});

test("guest EnumHosts uses native UDP for an external TCPIP host and packs callbacks only at the owner safe point", async () => {
    initialize(); const source = Uint8Array.of(2, 1, 198, 18, 0, 61); let sends = 0;
    network.attach({ send(frame) {
        const dg = decodeDatagram(frame)!; expect(dg.proto).toBe(PROTO_UDP); expect(dg.dstPort).toBe(2309); sends++;
        const query = decodeNativeEnumQuery(dg.payload)!; expect([...query.data]).toEqual([6, 0, 8]);
        const response = encodeNativeEnumResponse({ token: query.token, application: query.application!, instance: "c".repeat(32),
            flags: 0, maxPlayers: 7, players: 1, name: "WireЖ", password: null, reserved: new Uint8Array(), applicationData: Uint8Array.of(3, 5, 7), data: Uint8Array.of(0xaa, 0, 0xbb) });
        network.receiveFrame(encodeDatagram(PROTO_UDP, source, dg.srcPort, 2309, response)); return true;
    }, close() {} });
    const host = new DirectPlayAddress(); host.buildHost("198.18.0.61", 2309); const hostPtr = addresses.create(host);
    write(0x4000, 72); ram.set(guidBytes(DP8_PEER), 0x4018); ram.set([6, 0, 8], 0x4100);
    let callbackAllocations = 0; const allocate = process.memory.alloc.bind(process.memory);
    process.memory.alloc = (size, tag, perms) => { if (tag !== "THUNK_DATA") callbackAllocations++; return allocate(size, tag, perms); };
    const result = await call("EnumHosts", [0x4000, hostPtr, 0, 0x4100, 3, 1, 1, 1, 0, 0, 0x80000000]) as ThunkResult;
    expect(result.value).toBe(DPN.OK); expect(sends).toBe(1); expect(callbackAllocations).toBe(0); // Callback structures stay unallocated while the owner is suspended.
    let seen = 0; const temporaryAddresses: number[] = [];
    callbacks((message, ptr) => {
        temporaryAddresses.push(read(ptr + 4), read(ptr + 8));
        expect(message).toBe(0xb); seen++; expect(read(ptr)).toBe(32);
        const sender = addresses.address(read(ptr + 4))!, device = addresses.address(read(ptr + 8))!;
        expect(sender.text("hostname")).toBe("198.18.0.61"); expect(sender.dword("port")).toBe(2309); expect(device.dword("port")).toBe(2302);
        const desc = read(ptr + 12); expect(read(desc)).toBe(72); expect(read(desc + 40)).toBe(7); expect(read(desc + 44)).toBe(1);
        expect([...ram.slice(read(desc + 48), read(desc + 48) + 12)]).toEqual([...utf16("WireЖ\0")]);
        expect([...ram.slice(read(desc + 64), read(desc + 64) + read(desc + 68))]).toEqual([3, 5, 7]);
        expect([...ram.slice(read(ptr + 16), read(ptr + 16) + read(ptr + 20))]).toEqual([0xaa, 0, 0xbb]);
        expect(network.isBound(2302, PROTO_UDP)).toBe(true); api.reset(); return 0;
    });
    expect(seen).toBe(1); expect(temporaryAddresses.length).toBe(2);
    for (const ptr of temporaryAddresses) expect(resource.getComObjectByAddress(ptr)).toBeNull();
    expect(network.isBound(2302, PROTO_UDP)).toBe(false); network.attach(null);
});
test("reset during external EnumHosts DNS resolution cannot bind a socket or queue old callbacks", async () => {
    initialize(); let finish!: (result: { addresses: { family: 4; address: string }[] }) => void;
    network.resolve = () => new Promise(resolve => { finish = resolve; });
    const host = new DirectPlayAddress(); host.buildHost("native.test", 2309); const hostPtr = addresses.create(host);
    write(0x4000, 72); ram.set(guidBytes(DP8_PEER), 0x4018);
    const pending = call("EnumHosts", [0x4000, hostPtr, 0, 0, 0, 1, 1, 1, 0, 0, 0x80000000]) as Promise<ThunkResult>;
    api.reset(); finish({ addresses: [{ family: 4, address: "198.18.0.61" }] });
    expect((await pending).value).toBe(DPN.USERCANCEL); expect(network.isBound(2302, PROTO_UDP)).toBe(false); expect(calls.length).toBe(0);
});

function nativeHostCall() {
    initialize(); network.attach({ send: () => true, close() {} });
    network.configureDirectPlay8({ provider: "native", hostListener: "test-host" });
    const device = new DirectPlayAddress(); device.setGuid("provider", DP8_TCPIP); device.setDword("port", 2308);
    write(0x2000, addresses.create(device)); write(0x4000, 72); write(0x4028, 2); ram.set(guidBytes(DP8_PEER), 0x4018);
    let opened = 0, released = 0, finish!: (lease: any) => void;
    const lease = { address: { node: [2,1,127,0,0,1], port: 45001 }, allowedNodes: [[2,1,127,0,0,1]],
        isLive: () => true, closed: new Promise<never>(() => {}), release() { released++; } };
    network.openUdpHost = (port, id, signal) => {
        expect(port).toBe(2308); expect(id).toBe("test-host"); expect(signal?.aborted).toBe(false); opened++;
        return new Promise(resolve => finish = resolve);
    };
    const result = call("Host", [0x4000, 0x2000, 1, 0, 0, 0x5678, 0]);
    return { result, finish: () => finish(lease), get opened() { return opened; }, get released() { return released; } };
}
test("explicit native COM Host waits for READY and starts CREATE only through the issuing owner continuation", async () => {
    const own = ram, h = nativeHostCall(); expect(h.opened).toBe(1); expect(calls).toEqual([]);
    expect(network.isBound(2308, PROTO_UDP)).toBe(true);
    ram = new Uint8Array(own.length).fill(0xa5); h.finish();
    const result = await h.result as ThunkResult;
    expect(result.resumeOnOwner).toBeFunction(); expect(calls).toEqual([]);
    expect(ram.every(n => n === 0xa5)).toBe(true);
    ram = own;
    const owner = result.resumeOnOwner!({ esp: 0x9000, returnAddr: 0x7100, mem: ram }) as ThunkResult;
    expect(owner.value).toBe(DPN.GENERIC); expect(calls).toEqual([]);
    expect(owner.startCallbackChain!({ esp: 0x9000, returnAddr: 0x7100, mem: ram })).toBe(true);
    const invocation = calls.at(-1)!; expect(invocation.args[1]).toBe(0xffff0007);
    const msg = invocation.args[2], id = read(msg + 4); expect(read(msg)).toBe(12); expect(read(msg + 8)).toBe(0x5678);
    write(msg + 8, 0x4321); expect(invocation.done(0)).toBe(0);
    expect(call("GetPlayerContext", [id, 0x3400, 0])).toBe(0); expect(read(0x3400)).toBe(0x4321);
    write(0x3400, 1); expect(call("GetLocalHostAddresses", [0x3500, 0x3400, 0])).toBe(0);
    const address = addresses.address(read(0x3500))!; expect(address.text("hostname")).toBe("127.0.0.1"); expect(address.dword("port")).toBe(45001);
    api.reset(); expect(h.released).toBe(1);
});
test("native Host READY rejection returns a failure without CREATE or virtual session fallback", async () => {
    const h = nativeHostCall(); expect(h.opened).toBe(1);
    network.setConnected(false, "listener unavailable"); h.finish();
    const result = await h.result as ThunkResult;
    const owner = result.resumeOnOwner!({ esp: 0x9000, returnAddr: 0x7100, mem: ram });
    expect(typeof owner === "number" ? owner : owner.value).not.toBe(0); expect(calls).toEqual([]);
    expect(h.released).toBe(1); expect(network.isBound(2308, PROTO_UDP)).toBe(false);
});
test("old native Host completion cannot allocate callbacks after API or process reset", async () => {
    const h = nativeHostCall(); expect(h.opened).toBe(1); api.reset(); (process as any).resetGeneration++;
    const next = new Uint8Array(ram.length).fill(0xa5); ram = next; h.finish();
    const result = await h.result as ThunkResult;
    const owner = result.resumeOnOwner!({ esp: 0x9000, returnAddr: 0x7100, mem: ram });
    expect(typeof owner === "number" ? owner : owner.value).toBe(DPN.USERCANCEL);
    expect(calls).toEqual([]); expect(ram.every(n => n === 0xa5)).toBe(true); expect(h.released).toBe(1);
});

test("measured SetPeerInfo ignores SYNC async context and validates masked-out fields without mutation",async()=>{
 initialize();write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("Host\0"),0x3100);
 expect((await call("SetPeerInfo",[0x3000,0xb002,0,0x80000000]) as ThunkResult).value).toBe(0);
 write(0x300c,0x3500);write(0x3010,1);ram[0x3500]=7;
 expect(await call("SetPeerInfo",[0x3000,0,0,0x80000000])).toBe(DPN.INVALIDPARAM);
 write(0x3004,2);
 expect(await call("SetPeerInfo",[0x3000,0,0,0x80000000])).toBe(0x80158440);
 write(0x3008,0);write(0x3004,4);
 expect(await call("SetPeerInfo",[0x3000,0,0,0x80000000])).toBe(DPN.INVALIDFLAGS);
});

test("native Host async SetPeerInfo dispatches INFO and completion before return without a host microtask",async()=>{
 const h=nativeHostCall();h.finish();const ready=await h.result as ThunkResult;
 const owner=ready.resumeOnOwner!({esp:0x9000,returnAddr:0x7100,mem:ram}) as ThunkResult;
 expect(owner.startCallbackChain!({esp:0x9000,returnAddr:0x7100,mem:ram})).toBe(true);
 const create=calls.at(-1)!,id=read(create.args[2]+4);write(create.args[2]+8,0xa100);expect(create.done(0)).toBe(0);
 write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("host-\u0416\0"),0x3100);write(0x3600,0xeeeeeeee);
 const result=call("SetPeerInfo",[0x3000,0xb006,0x3600,0]) as ThunkResult;
 expect(result.suspendedForCallback).toBe(true);
 const info=calls.at(-1)!;expect(info.args[1]).toBe(0xffff0010);expect(read(info.args[2])).toBe(12);expect(read(info.args[2]+4)).toBe(id);expect(read(info.args[2]+8)).toBe(0xa100);
 write(0x3200,128);write(0x3300,24);expect(call("GetPeerInfo",[id,0x3300,0x3200,0])).toBe(0);
 expect(read(0x3308)).toBeGreaterThan(0);expect(info.done(0)).toBeNull();info.enumerationState!.continueEnumeration();
 const completion=calls.at(-1)!;expect(completion.args[1]).toBe(0xffff0003);expect(read(completion.args[2])).toBe(16);expect(read(completion.args[2]+4)).toBe(read(0x3600));expect(read(completion.args[2]+8)).toBe(0xb006);expect(read(completion.args[2]+12)).toBe(0);
 expect(completion.done(0)).toBe(DPN.PENDING);
});

test("native Host SetPeerInfo keeps NULL name separate from an empty UTF16 string and preserves selected data",async()=>{
 const h=nativeHostCall();h.finish();const ready=await h.result as ThunkResult,owner=ready.resumeOnOwner!({esp:0x9000,returnAddr:0x7100,mem:ram}) as ThunkResult;
 expect(owner.startCallbackChain!({esp:0x9000,returnAddr:0x7100,mem:ram})).toBe(true);const create=calls.at(-1)!,id=read(create.args[2]+4);expect(create.done(0)).toBe(0);
 write(0x3000,24);write(0x3004,3);write(0x3008,0x3100);ram.set(utf16("initial\0"),0x3100);write(0x300c,0x3500);write(0x3010,4);ram.set([0x20,0,0x40,0],0x3500);
 const first=call("SetPeerInfo",[0x3000,0xb002,0,0x80000000]) as ThunkResult;expect(first.suspendedForCallback).toBe(true);expect(calls.at(-1)!.done(0)).toBe(0);
 for(const [pointer,size]of[[0,28],[0x3100,30]]){
  write(0x3004,1);write(0x3008,pointer);write(0x300c,0);write(0x3010,0);ram.set(utf16("\0"),0x3100);
  const result=call("SetPeerInfo",[0x3000,0xb004,0,0x80000000]) as ThunkResult;expect(result.suspendedForCallback).toBe(true);
  const info=calls.at(-1)!;expect(info.args[1]).toBe(0xffff0010);write(0x3200,128);write(0x3300,24);expect(call("GetPeerInfo",[id,0x3300,0x3200,0])).toBe(0);
  expect(read(0x3200)).toBe(size);expect(read(0x3308)!==0).toBe(!!pointer);expect(read(0x3310)).toBe(4);expect([...ram.slice(read(0x330c),read(0x330c)+4)]).toEqual([0x20,0,0x40,0]);expect(info.done(0)).toBe(0);
 }
});

test("native Host SetPeerInfo refuses callback saturation before mutation or async HANDLE output",async()=>{
 const h=nativeHostCall();h.finish();const ready=await h.result as ThunkResult,owner=ready.resumeOnOwner!({esp:0x9000,returnAddr:0x7100,mem:ram}) as ThunkResult;
 owner.startCallbackChain!({esp:0x9000,returnAddr:0x7100,mem:ram});const create=calls.at(-1)!,id=read(create.args[2]+4);create.done(0);
 const state=[...(api as any).states.values()][0],cb=state.callbacks,resume=cb.queue.pause();
 for(let n=0;n<256;n++)expect(cb.native(2,0)).toBe(true);
 write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("blocked\0"),0x3100);write(0x3600,0xeeeeeeee);
 expect(call("SetPeerInfo",[0x3000,0xb006,0x3600,0])).toBe(DPN.TABLEFULL);expect(read(0x3600)).toBe(0xeeeeeeee);
 expect(state.session.engine.entities.get(id).name.short).not.toBe("blocked");resume();
});

test("nested native Host SetPeerInfo completes the inner INFO before publishing the outer async HANDLE",async()=>{
 const h=nativeHostCall();h.finish();const ready=await h.result as ThunkResult,owner=ready.resumeOnOwner!({esp:0x9000,returnAddr:0x7100,mem:ram}) as ThunkResult;
 owner.startCallbackChain!({esp:0x9000,returnAddr:0x7100,mem:ram});calls.at(-1)!.done(0);
 write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("outer\0"),0x3100);write(0x3600,0xeeeeeeee);write(0x3604,0xdddddddd);
 const outer=call("SetPeerInfo",[0x3000,0xb006,0x3600,0]) as ThunkResult;expect(outer.suspendedForCallback).toBe(true);const info1=calls.at(-1)!;
 expect(read(0x3600)).toBe(0xeeeeeeee);
 ram.set(utf16("inner\0"),0x3100);const inner=call("SetPeerInfo",[0x3000,0xb007,0x3604,0]) as ThunkResult;expect(inner.suspendedForCallback).toBe(true);
 const info2=calls.at(-1)!;expect(info2.args[1]).toBe(0xffff0010);expect(read(0x3604)).toBe(0xdddddddd);
 expect(info2.done(0)).toBeNull();info2.enumerationState!.continueEnumeration();const done2=calls.at(-1)!;expect(done2.args[1]).toBe(0xffff0003);expect(read(done2.args[2]+8)).toBe(0xb007);expect(done2.done(0)).toBe(DPN.PENDING);expect(read(0x3600)).toBe(0xeeeeeeee);
 expect(info1.done(0)).toBeNull();info1.enumerationState!.continueEnumeration();const done1=calls.at(-1)!;expect(read(done1.args[2]+8)).toBe(0xb006);expect(done1.done(0)).toBe(DPN.PENDING);
});

test("reentrant callback pressure cannot steal the native Host completion reservation",async()=>{
 const h=nativeHostCall();h.finish();const ready=await h.result as ThunkResult,owner=ready.resumeOnOwner!({esp:0x9000,returnAddr:0x7100,mem:ram}) as ThunkResult;
 owner.startCallbackChain!({esp:0x9000,returnAddr:0x7100,mem:ram});calls.at(-1)!.done(0);
 write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("reserved\0"),0x3100);
 const outer=call("SetPeerInfo",[0x3000,0xb006,0x3600,0]) as ThunkResult;expect(outer.suspendedForCallback).toBe(true);const info=calls.at(-1)!;
 const cb=[...(api as any).states.values()][0].callbacks;for(let n=0;n<254;n++)expect(cb.native(2,0)).toBe(true);
 expect(cb.queue.size).toBe(255);expect(info.done(0)).toBeNull();info.enumerationState!.continueEnumeration();const done=calls.at(-1)!;expect(done.args[1]).toBe(0xffff0003);expect(done.done(0)).toBe(DPN.PENDING);
});

for(const [iface,method]of[["IDirectPlay8Client","SetClientInfo"],["IDirectPlay8Server","SetServerInfo"]]){
 test(iface+" preserves its existing SYNC-context rejection without relaxing measured PeerInfo",()=>{
  expect(call("Initialize",[0x1234,0x7000,0],iface)).toBe(0);
  write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("unchanged\0"),0x3100);
  expect(call(method,[0x3000,0xb002,0,0x80000000],iface)).toBe(DPN.INVALIDPARAM);
  const state=[...(api as any).states.values()][0];expect(state.session.localInfo.name).toBe("");
 });
}

async function readyNativeGroupHost() {
 const h=nativeHostCall();h.finish();const ready=await h.result as ThunkResult;
 const owner=ready.resumeOnOwner!({esp:0x9000,returnAddr:0x7100,mem:ram}) as ThunkResult;
 expect(owner.startCallbackChain!({esp:0x9000,returnAddr:0x7100,mem:ram})).toBe(true);
 const create=calls.at(-1)!;const id=read(create.args[2]+4);
 write(create.args[2]+8,0xa100);expect(create.done(0)).toBe(0);return id;
}
test("native Host CreateGroup reads context back before inline async completion and ignores handler HRESULT",async()=>{
 const hostId=await readyNativeGroupHost();
 write(0x3000,24);write(0x3004,3);write(0x3008,0x3100);ram.set(utf16("group-Ж\0"),0x3100);
 write(0x300c,0x3500);write(0x3010,3);ram.set([7,0,9],0x3500);write(0x3600,0xeeeeeeee);
 const result=call("CreateGroup",[0x3000,0x1111,0xb001,0x3600,0]) as ThunkResult;
 expect(result.suspendedForCallback).toBe(true);expect(result.stackCleanup).toBe(24);
 const create=calls.at(-1)!,ptr=create.args[2],id=read(ptr+4);
 expect(create.args[1]).toBe(0xffff0006);expect(read(ptr)).toBe(20);expect(id).not.toBe(hostId);
 expect(read(ptr+8)).toBe(0);expect(read(ptr+12)).toBe(0x1111);expect(read(ptr+16)).toBe(0);
 expect(read(0x3600)).toBe(0xeeeeeeee);
 write(0x3400,0xdddddddd);expect(call("GetGroupContext",[id,0x3400,0])).toBe(DPN.NOTREADY);
 expect(read(0x3400)).toBe(0xdddddddd);write(ptr+12,0x2222);
 expect(create.done(DPN.GENERIC)).toBeNull();create.enumerationState!.continueEnumeration();
 const complete=calls.at(-1)!;expect(complete.args[1]).toBe(0xffff0003);
 const handle=read(0x3600);expect(handle).not.toBe(0);expect(handle).not.toBe(0xeeeeeeee);
 expect([read(complete.args[2]+4),read(complete.args[2]+8),read(complete.args[2]+12)]).toEqual([handle,0xb001,0]);
 expect(call("GetGroupContext",[id,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x2222);
 expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.INVALIDHANDLE);
 expect(complete.done(0)).toBe(DPN.PENDING);
});
test("native SYNC CreateGroup has no async completion and AUTODESTRUCT exposes its real owner context",async()=>{
 const hostId=await readyNativeGroupHost();write(0x3000,24);write(0x3014,1);
 const before=calls.length,result=call("CreateGroup",[0x3000,0x3333,0xbeef,0,0x80000000]) as ThunkResult;
 expect(result.suspendedForCallback).toBe(true);const create=calls.at(-1)!,ptr=create.args[2],id=read(ptr+4);
 expect(read(ptr+8)).toBe(hostId);expect(read(ptr+12)).toBe(0x3333);expect(read(ptr+16)).toBe(0xa100);
 write(ptr+12,0x4444);expect(create.done(DPN.PENDING)).toBe(0);expect(calls.length).toBe(before+1);
 expect(call("GetGroupContext",[id,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x4444);
});
test("CreateGroup rejects invalid handle/info and callback quota without creating a group",async()=>{
 await readyNativeGroupHost();write(0x3000,24);
 const state=[...(api as any).states.values()][0],count=state.session.engine.entities.size;
 expect(call("CreateGroup",[0x3000,0,0,0,0])).toBe(DPN.INVALIDPARAM);
 expect(call("CreateGroup",[0x3000,0,0,0x3600,0x80000000])).toBe(DPN.INVALIDPARAM);
 write(0x3004,4);expect(call("CreateGroup",[0x3000,0,0,0x3600,0])).toBe(DPN.INVALIDPARAM);write(0x3004,0);
 const cb=state.callbacks,resume=cb.queue.pause();for(let n=0;n<256;n++)expect(cb.native(2,0)).toBe(true);
 write(0x3600,0xeeeeeeee);expect(call("CreateGroup",[0x3000,0,0,0x3600,0])).toBe(DPN.TABLEFULL);
 expect(read(0x3600)).toBe(0xeeeeeeee);expect(state.session.engine.entities.size).toBe(count);resume();
});

test("SetGroupInfo reenters a held CREATE_GROUP using stored context before CREATE context writeback",async()=>{
 await readyNativeGroupHost();write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("before\0"),0x3100);
 const outer=call("CreateGroup",[0x3000,0x1111,0,0,0x80000000]) as ThunkResult;
 expect(outer.suspendedForCallback).toBe(true);const create=calls.at(-1)!,ptr=create.args[2],id=read(ptr+4);
 write(ptr+12,0x2222);ram.set(utf16("inside\0"),0x3100);
 const nested=call("SetGroupInfo",[id,0x3000,0,0,0x80000000]) as ThunkResult;
 expect(nested.suspendedForCallback).toBe(true);expect(nested.stackCleanup).toBe(24);
 const info=calls.at(-1)!;expect(info.args[1]).toBe(0xffff000c);
 expect([read(info.args[2]+4),read(info.args[2]+8)]).toEqual([id,0x1111]);
 expect(info.done(DPN.GENERIC)).toBe(0);
 expect(call("GetGroupContext",[id,0x3400,0])).toBe(DPN.NOTREADY);
 expect(create.done(0)).toBe(0);expect(call("GetGroupContext",[id,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x2222);
 write(0x3200,128);expect(call("GetGroupInfo",[id,0x3300,0x3200,0])).toBe(0);
 expect([...ram.slice(read(0x3308),read(0x3308)+14)]).toEqual([...utf16("inside\0")]);
});

test("nested native CreateGroup retains independent messages, contexts and inline completion ownership",async()=>{
 await readyNativeGroupHost();write(0x3000,24);write(0x3600,0xeeeeeeee);write(0x3604,0xdddddddd);
 const outer=call("CreateGroup",[0x3000,0x1111,0xb001,0x3600,0]) as ThunkResult;
 expect(outer.suspendedForCallback).toBe(true);const first=calls.at(-1)!,firstId=read(first.args[2]+4);
 const inner=call("CreateGroup",[0x3000,0x2222,0xb002,0x3604,0]) as ThunkResult;
 expect(inner.suspendedForCallback).toBe(true);const second=calls.at(-1)!,secondId=read(second.args[2]+4);
 expect(secondId).not.toBe(firstId);expect(read(second.args[2]+12)).toBe(0x2222);
 expect(read(first.args[2]+12)).toBe(0x1111);write(second.args[2]+12,0x2223);
 expect(second.done(0)).toBeNull();second.enumerationState!.continueEnumeration();
 const innerDone=calls.at(-1)!;expect(innerDone.args[1]).toBe(0xffff0003);expect(read(innerDone.args[2]+8)).toBe(0xb002);
 expect(read(0x3600)).toBe(0xeeeeeeee);expect(innerDone.done(0)).toBe(DPN.PENDING);
 write(first.args[2]+12,0x1112);expect(first.done(0)).toBeNull();first.enumerationState!.continueEnumeration();
 const outerDone=calls.at(-1)!;expect(outerDone.args[1]).toBe(0xffff0003);expect(read(outerDone.args[2]+8)).toBe(0xb001);
 expect(read(0x3600)).not.toBe(read(0x3604));expect(outerDone.done(0)).toBe(DPN.PENDING);
 expect(call("GetGroupContext",[firstId,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x1112);
 expect(call("GetGroupContext",[secondId,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x2223);
});

test("real remote CreateGroup keeps its pending public handle uncancellable and waits for both guest returns",async()=>{
 initialize();const remoteNet=new LanNetwork(Uint8Array.of(2,0,0,0,0,2)),server=new DirectPlay8Session(remoteNet);
 const nets=[network,remoteNet];for(const[i,net]of nets.entries())net.attach({send(frame){
  const d=decodeDatagram(frame)!;nets[1-i].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;},close(){}});
 let held:DirectPlay8Event|undefined;
 const desc:SessionDesc={instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",name:"groups",password:"",flags:0,maxPlayers:2,user:[0,0,0,0],extended:{flags:0,reserved:[],application:[]}};
 try{
  expect(server.initialize()).toBe(0);server.onEvent=e=>{if(e.type===6)held=e;else e.processed?.();};server.onNativeIndicate=()=>({hr:0});
  expect(await server.hostNative(desc,0,{prepare:async r=>({address:{node:[2,1,127,0,0,2],port:r.localPort},
   allowIncoming:()=>true,url:a=>"x-directplay:/hostname=127.0.0.2;port="+a.port,release(){}})},2308,[20,0,2,14,500])).toBe(0);
  const state=[...(api as any).states.values()][0],session=state.session as DirectPlay8Session;
  expect(await session.connectNative({node:[...remoteNet.node],port:2308},desc,0,new Uint8Array(),0,[20,0,2,14,500])).toBe(0);callbacks();
  write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("requester\0"),0x3100);
  expect(call("CreateGroup",[0x3000,0x1111,0xb001,0x3600,0])).toBe(DPN.PENDING);
  const handle=read(0x3600);for(let n=0;n<16;n++)await Promise.resolve();expect(held).toBeDefined();
  expect(held!.context).toBe(0);expect(session.engine.entities.has(held!.id!)).toBe(false);
  expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.CANNOTCANCEL);
  expect(call("CancelAsyncOperation",[0,0x8000])).toBe(0);expect(state.operations.has(handle)).toBe(true);
  held!.processed!();for(let n=0;n<16;n++)await Promise.resolve();
  let creates=0,completions=0,id=0;callbacks((message,ptr)=>{
   expect(message).toBe(6);creates++;id=read(ptr+4);expect(read(ptr+12)).toBe(0x1111);write(ptr+12,0x2222);return DPN.GENERIC;});
  expect(creates).toBe(1);expect(state.operations.has(handle)).toBe(true);
  for(let n=0;n<16;n++)await Promise.resolve();callbacks((message,ptr)=>{
   expect(message).toBe(3);expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([handle,0xb001,0]);completions++;return 0;});
  expect(completions).toBe(1);expect(call("GetGroupContext",[id,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x2222);
  expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.INVALIDHANDLE);
 }finally{api.reset();server.dispose();network.attach(null);remoteNet.attach(null);}
});

test("AUTO DESTROY_GROUP keeps group information and rewritten context queryable until guest return",async()=>{
 initialize();const remoteNet=new LanNetwork(Uint8Array.of(2,0,0,0,0,2)),creator=new NativeDirectPlayCore(remoteNet,"peer",500,2);
 const nets=[network,remoteNet];for(const[i,net]of nets.entries())net.attach({send(frame){
  const d=decodeDatagram(frame)!;nets[1-i].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;},close(){}});
 const session=[...(api as any).states.values()][0].session as DirectPlay8Session;
 const desc:SessionDesc={instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",name:"retired query",password:"",flags:0,maxPlayers:2,user:[0,0,0,0],extended:{flags:0,reserved:[],application:[]}};
 try{
  session.onNativeIndicate=()=>({hr:0});
  expect(await session.hostNative(desc,0,{prepare:async r=>({address:r.localAddress,allowIncoming:()=>true,
   url:a=>"x-directplay:/hostname=127.0.0.1;port="+a.port,release(){}})},2308,[20,0,2,14,500])).toBe(0);callbacks();
  expect(await creator.connect({node:[...network.node],port:2308},desc,{name:{short:"owner",long:""},data:[],flags:0},new Uint8Array())).toBe(0);callbacks();
  const pending=creator.mutate({op:"mutate",action:"create",group:true,flags:1,name:{short:"retained",long:""},data:[7,0,9]});
  for(let n=0;n<16;n++)await Promise.resolve();
  callbacks((message,ptr)=>{expect(message).toBe(6);write(ptr+12,0xa070);return 0;});
  const group=await pending;expect(group.hr).toBe(0);const id=group.id!;
  expect(await creator.shutdown()).toBe(0);let destroyed=0;
  callbacks((message,ptr)=>{
   if(message===8){
    destroyed++;expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([id,0xa070,2]);
    expect(call("GetGroupContext",[id,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0xa070);
    write(0x3200,128);expect(call("GetGroupInfo",[id,0x3300,0x3200,0])).toBe(0);
    expect(read(0x3310)).toBe(3);expect([...ram.slice(read(0x330c),read(0x330c)+3)]).toEqual([7,0,9]);
   }else expect(message).toBe(9);
   return DPN.GENERIC;// DESTROY callback result does not reject cleanup.
  });
  expect(destroyed).toBe(1);expect(call("GetGroupContext",[id,0x3400,0])).toBe(DPN.INVALIDGROUP);
 }finally{api.reset();creator.dispose();network.attach(null);remoteNet.attach(null);}
});

async function readyNativeOrdinaryGroup() {
 await readyNativeGroupHost();
 write(0x3000,24);write(0x3004,3);write(0x3008,0x3100);ram.set(utf16("destroy-idle\0"),0x3100);
 write(0x300c,0x3500);write(0x3010,3);ram.set([6,0,9],0x3500);
 const result=call("CreateGroup",[0x3000,0x6161,0,0,0x80000000]) as ThunkResult;
 expect(result.suspendedForCallback).toBe(true);const create=calls.at(-1)!,id=read(create.args[2]+4);
 write(create.args[2]+12,0x6262);expect(create.done(0)).toBe(0);return id;
}
test("native Host DestroyGroup keeps idle query lifetime and finishes async inline after the actual return",async()=>{
 const id=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0],version=state.session.engine.host.version;
 write(0x3600,0xeeeeeeee);
 const result=call("DestroyGroup",[id,0xb008,0x3600,0]) as ThunkResult;
 expect(result.suspendedForCallback).toBe(true);expect(result.stackCleanup).toBe(20);
 const destroy=calls.at(-1)!,ptr=destroy.args[2];expect(destroy.args[1]).toBe(0xffff0008);
 expect([read(ptr),read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([16,id,0x6262,1]);
 expect(read(0x3600)).toBe(0xeeeeeeee);expect(state.session.engine.host.version).toBe(version);
 expect(call("GetGroupContext",[id,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x6262);
 write(0x3200,128);expect(call("GetGroupInfo",[id,0x3300,0x3200,0])).toBe(0);
 expect(read(0x3310)).toBe(3);expect([...ram.slice(read(0x330c),read(0x330c)+3)]).toEqual([6,0,9]);
 expect(call("DestroyGroup",[id,0,0,0x80000000])).toBe(DPN.INVALIDGROUP);
 expect(call("SetGroupInfo",[id,0x3000,0,0,0x80000000])).toBe(DPN.INVALIDGROUP);
 expect(destroy.done(DPN.GENERIC)).toBeNull();destroy.enumerationState!.continueEnumeration();
 const done=calls.at(-1)!,handle=read(0x3600);expect(done.args[1]).toBe(0xffff0003);
 expect([read(done.args[2]+4),read(done.args[2]+8),read(done.args[2]+12)]).toEqual([handle,0xb008,0]);
 expect(handle).not.toBe(0);expect(handle).not.toBe(0xeeeeeeee);
 expect(state.session.engine.host.version).toBe(version+1);
 expect(call("GetGroupContext",[id,0x3400,0])).toBe(DPN.INVALIDGROUP);
 expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.INVALIDHANDLE);
 expect(done.done(0)).toBe(DPN.PENDING);
});
test("DestroyGroup validates async handles and allows ignored SYNC context without a completion",async()=>{
 const id=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0],version=state.session.engine.host.version;
 expect(call("DestroyGroup",[0,0,0x3600,0])).toBe(DPN.INVALIDGROUP);
 expect(call("DestroyGroup",[id,0,0,0])).toBe(DPN.INVALIDPARAM);
 expect(call("DestroyGroup",[id,0,0x3600,0x80000000])).toBe(DPN.INVALIDPARAM);
 expect(call("DestroyGroup",[id,0,0xffffffff,0])).toBe(DPN.INVALIDPOINTER);
 expect(call("DestroyGroup",[id,0,0x3600,1])).toBe(DPN.INVALIDFLAGS);
 expect(call("DestroyGroup",[state.session.localId,0,0x3600,0])).toBe(DPN.INVALIDGROUP);
 expect(state.session.engine.host.version).toBe(version);expect(state.session.engine.entities.has(id)).toBe(true);
 const before=calls.length,result=call("DestroyGroup",[id,0xbeef,0,0x80000000]) as ThunkResult;
 expect(result.suspendedForCallback).toBe(true);const destroy=calls.at(-1)!;
 expect(destroy.args[1]).toBe(0xffff0008);expect(destroy.done(DPN.PENDING)).toBe(0);
 expect(calls.length).toBe(before+1);expect(state.session.engine.entities.has(id)).toBe(false);
});
test("remote DestroyGroup can remove another owner's group and keeps its public handle uncancellable until requester return",async()=>{
 initialize();const remoteNet=new LanNetwork(Uint8Array.of(2,0,0,0,0,2)),server=new DirectPlay8Session(remoteNet);
 const nets=[network,remoteNet];for(const[i,net]of nets.entries())net.attach({send(frame){
  const d=decodeDatagram(frame)!;nets[1-i].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;},close(){}});
 let held:DirectPlay8Event|undefined;
 const desc:SessionDesc={instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",name:"destroy",password:"",flags:0,maxPlayers:2,user:[0,0,0,0],extended:{flags:0,reserved:[],application:[]}};
 try{
  expect(server.initialize()).toBe(0);server.onEvent=e=>{if(e.type===8)held=e;else e.processed?.();};server.onNativeIndicate=()=>({hr:0});
  expect(await server.hostNative(desc,0,{prepare:async r=>({address:r.localAddress,allowIncoming:()=>true,
   url:a=>"x-directplay:/hostname=127.0.0.2;port="+a.port,release(){}})},2308,[20,0,2,14,500])).toBe(0);
  const made=await server.createGroup({name:"host-owned",data:[8,0,7],flags:0},0xa080);expect(made.hr).toBe(0);const id=made.id!;
  const state=[...(api as any).states.values()][0],session=state.session as DirectPlay8Session;
  expect(await session.connectNative({node:[...remoteNet.node],port:2308},desc,0,new Uint8Array(),0,[20,0,2,14,500])).toBe(0);
  callbacks((message,ptr)=>{if(message===6)write(ptr+12,0xc080);return 0;});
  expect(session.engine.entities.get(id)?.groupOwner).toBe(server.localId);expect(server.localId).not.toBe(session.localId);
  expect(call("DestroyGroup",[id,0xb080,0x3600,0])).toBe(DPN.PENDING);const handle=read(0x3600);
  for(let n=0;n<16;n++)await Promise.resolve();expect(held).toBeDefined();
  expect(held).toMatchObject({type:8,id,reason:1,context:0xa080});expect(session.engine.entities.has(id)).toBe(true);
  // The requester has not received D8 yet; the Host already marks the entry disconnecting.
  const duplicate=await call("DestroyGroup",[id,0xbeef,0,0x80000000]) as ThunkResult;
  expect(duplicate.value).toBe(DPN.GENERIC);
  expect(call("DestroyGroup",[id,0xb081,0x3604,0])).toBe(DPN.PENDING);const rejectedHandle=read(0x3604);
  expect(rejectedHandle).not.toBe(handle);for(let n=0;n<16;n++)await Promise.resolve();
  let rejected=0;callbacks((message,ptr)=>{
   expect(message).toBe(3);expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([rejectedHandle,0xb081,DPN.INVALIDGROUP]);rejected++;return 0;
  });
  expect(rejected).toBe(1);expect(state.operations.has(handle)).toBe(true);
  expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.CANNOTCANCEL);
  expect(call("CancelAsyncOperation",[0,0x8000])).toBe(0);expect(state.operations.has(handle)).toBe(true);
  held!.processed!();for(let n=0;n<16;n++)await Promise.resolve();
  let destroyed=0;callbacks((message,ptr)=>{
   expect(message).toBe(8);destroyed++;expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([id,0xc080,1]);
   expect(call("GetGroupContext",[id,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0xc080);return DPN.GENERIC;
  });
  expect(destroyed).toBe(1);expect(state.operations.has(handle)).toBe(true);
  for(let n=0;n<16;n++)await Promise.resolve();let completed=0;callbacks((message,ptr)=>{
   expect(message).toBe(3);expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([handle,0xb080,0]);completed++;return 0;
  });
  expect(completed).toBe(1);expect(call("GetGroupContext",[id,0x3400,0])).toBe(DPN.INVALIDGROUP);
  expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.INVALIDHANDLE);
 }finally{api.reset();server.dispose();network.attach(null);remoteNet.attach(null);}
});

test("native Host DestroyGroup callback quota failure leaves the group and public output untouched",async()=>{
 const id=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0],version=state.session.engine.host.version;
 const resume=state.callbacks.queue.pause();for(let n=0;n<256;n++)expect(state.callbacks.native(2,0)).toBe(true);
 write(0x3600,0xeeeeeeee);expect(call("DestroyGroup",[id,0xb008,0x3600,0])).toBe(DPN.TABLEFULL);
 expect(read(0x3600)).toBe(0xeeeeeeee);expect(state.session.engine.entities.has(id)).toBe(true);
 expect(state.session.engine.host.version).toBe(version);expect(state.session.groupContexts.get(id)).toBe(0x6262);resume();
});

function expectNativeMembers(group: number, members: number[]) {
 write(0x3700,8);expect(call("EnumGroupMembers",[group,0x3740,0x3700,0])).toBe(0);
 expect(read(0x3700)).toBe(members.length);
 expect(members.map((_,i)=>read(0x3740+4*i))).toEqual(members);
}
test("native membership commits enumeration before actual guest return and completes async on its owner",async()=>{
 const group=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0];
 const player=state.session.localId,version=state.session.engine.host.version;write(0x3600,0xeeeeeeee);
 const added=call("AddPlayerToGroup",[group,player,0xb101,0x3600,0]) as ThunkResult;
 expect(added.suspendedForCallback).toBe(true);expect(added.stackCleanup).toBe(24);
 const add=calls.at(-1)!,ptr=add.args[2];expect(add.args[1]).toBe(0xffff0001);
 expect([read(ptr),read(ptr+4),read(ptr+8),read(ptr+12),read(ptr+16)]).toEqual([20,group,0x6262,player,0xa100]);
 expectNativeMembers(group,[player]);expect(state.session.engine.host.version).toBe(version+1);
 expect(read(0x3600)).toBe(0xeeeeeeee);
 expect(add.done(DPN.GENERIC)).toBeNull();add.enumerationState!.continueEnumeration();
 const done=calls.at(-1)!,handle=read(0x3600);expect(done.args[1]).toBe(0xffff0003);
 expect([read(done.args[2]+4),read(done.args[2]+8),read(done.args[2]+12)]).toEqual([handle,0xb101,0]);
 expect(handle).not.toBe(0);expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.INVALIDHANDLE);
 expect(done.done(0)).toBe(DPN.PENDING);
 const before=calls.length,removed=call("RemovePlayerFromGroup",[group,player,0xbeef,0,0x80000000]) as ThunkResult;
 expect(removed.suspendedForCallback).toBe(true);expect(removed.stackCleanup).toBe(24);
 const remove=calls.at(-1)!;expect(remove.args[1]).toBe(0xffff0012);
 expect([read(remove.args[2]+4),read(remove.args[2]+8),read(remove.args[2]+12),read(remove.args[2]+16)]).toEqual([group,0x6262,player,0xa100]);
 expectNativeMembers(group,[]);expect(state.session.engine.host.version).toBe(version+2);
 expect(remove.done(DPN.GENERIC)).toBe(0);expect(calls.length).toBe(before+1);
});
test("membership validates asymmetric zero player and rejects quota before linkage or output mutation",async()=>{
 const group=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0],player=state.session.localId;
 const version=state.session.engine.host.version;write(0x3600,0xeeeeeeee);
 expect(call("AddPlayerToGroup",[group,0,0,0x3600,0])).toBe(DPN.INVALIDPLAYER);
 expect(call("RemovePlayerFromGroup",[group,0,0,0x3600,0])).toBe(DPN.INVALIDPARAM);
 expect(call("AddPlayerToGroup",[0,player,0,0x3600,0])).toBe(DPN.INVALIDGROUP);
 expect(call("AddPlayerToGroup",[group,player,0,0,0])).toBe(DPN.INVALIDPARAM);
 expect(call("AddPlayerToGroup",[group,player,0,0x3600,0x80000000])).toBe(DPN.INVALIDPARAM);
 expect(call("AddPlayerToGroup",[group,player,0,0xffffffff,0])).toBe(DPN.INVALIDPOINTER);
 expect(call("AddPlayerToGroup",[group,player,0,0x3600,1])).toBe(DPN.INVALIDFLAGS);
 const resume=state.callbacks.queue.pause();for(let n=0;n<256;n++)expect(state.callbacks.native(2,0)).toBe(true);
 expect(call("AddPlayerToGroup",[group,player,0,0x3600,0])).toBe(DPN.TABLEFULL);
 expect(read(0x3600)).toBe(0xeeeeeeee);expect(state.session.engine.host.version).toBe(version);
 expect(state.session.engine.entities.get(group).members).toEqual([]);resume();
});
test("DestroyGroup waits its own implicit REMOVE and DESTROY callbacks without an extra membership version",async()=>{
 const group=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0],player=state.session.localId;
 const add=call("AddPlayerToGroup",[group,player,0,0,0x80000000]) as ThunkResult;
 expect(add.suspendedForCallback).toBe(true);expect(calls.at(-1)!.done(0)).toBe(0);
 const version=state.session.engine.host.version;
 const destroy=call("DestroyGroup",[group,0xbeef,0,0x80000000]) as ThunkResult;
 expect(destroy.suspendedForCallback).toBe(true);const remove=calls.at(-1)!;
 expect(remove.args[1]).toBe(0xffff0012);expectNativeMembers(group,[]);
 write(0x3700,8);expect(call("EnumPlayersAndGroups",[0x3740,0x3700,0x10])).toBe(0);expect(read(0x3700)).toBe(0);
 expect(state.session.engine.host.version).toBe(version);
 expect(call("GetGroupContext",[group,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x6262);
 expect(remove.done(DPN.GENERIC)).toBeNull();remove.enumerationState!.continueEnumeration();
 const last=calls.at(-1)!;expect(last.args[1]).toBe(0xffff0008);
 expect(state.session.engine.host.version).toBe(version);
 expect(last.done(DPN.GENERIC)).toBe(0);expect(state.session.engine.host.version).toBe(version+1);
 expect(call("GetGroupContext",[group,0x3400,0])).toBe(DPN.INVALIDGROUP);
});
test("an external held REMOVE lets Destroy commit first and retains query until deferred DESTROY returns",async()=>{
 const group=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0],player=state.session.localId;
 const add=call("AddPlayerToGroup",[group,player,0,0,0x80000000]) as ThunkResult;
 expect(add.suspendedForCallback).toBe(true);expect(calls.at(-1)!.done(0)).toBe(0);
 const version=state.session.engine.host.version;
 const removing=call("RemovePlayerFromGroup",[group,player,0xbeef,0,0x80000000]) as ThunkResult;
 expect(removing.suspendedForCallback).toBe(true);const remove=calls.at(-1)!;
 expect(remove.args[1]).toBe(0xffff0012);expectNativeMembers(group,[]);
 const before=calls.length,destroy=call("DestroyGroup",[group,0xbeef,0,0x80000000]);
 expect(destroy).toBe(0);expect(calls.length).toBe(before);
 expect(state.session.engine.host.version).toBe(version+2);
 expect(state.session.engine.entities.has(group)).toBe(false);
 expect(call("GetGroupContext",[group,0x3400,0])).toBe(0);expect(read(0x3400)).toBe(0x6262);
 expect(call("EnumGroupMembers",[group,0x3740,0x3700,0])).toBe(DPN.CONNECTIONLOST);
 expect(call("DestroyGroup",[group,0,0,0x80000000])).toBe(DPN.CONNECTIONLOST);
 expect(remove.done(DPN.GENERIC)).toBeNull();remove.enumerationState!.continueEnumeration();
 const deferred=calls.at(-1)!;expect(deferred.args[1]).toBe(0xffff0008);
 expect([read(deferred.args[2]+4),read(deferred.args[2]+8),read(deferred.args[2]+12)]).toEqual([group,0x6262,1]);
 expect(call("GetGroupContext",[group,0x3400,0])).toBe(0);
 expect(deferred.done(DPN.GENERIC)).toBe(0);expect(call("GetGroupContext",[group,0x3400,0])).toBe(DPN.INVALIDGROUP);
 expect(state.session.engine.host.version).toBe(version+2);
});

test("an excluded callback cannot capture and reuse another operation's released reservation",async()=>{
 await readyNativeOrdinaryGroup();const state=[...(api as any).states.values()][0],cb=state.callbacks;
 const reservation=cb.reserveNative(1,84);expect(reservation).toBeDefined();
 let returned=0;
 expect(cb.usingNative(reservation,()=>cb.emit({type:6,id:0xf100,context:0x1111,processed(){
  returned++;expect(cb.native(1,20)).toBe(true);
 }}),[1])).toBe(true);
 reservation.release();
 const observed:number[]=[];callbacks(message=>{observed.push(message);return 0;});
 expect(returned).toBe(1);expect(observed).toEqual([6,1]);
});

test("remote membership has no owner ACL and completes only after Host and requester actual returns",async()=>{
 initialize();const remoteNet=new LanNetwork(Uint8Array.of(2,0,0,0,0,2)),server=new DirectPlay8Session(remoteNet);
 const nets=[network,remoteNet];for(const[i,net]of nets.entries())net.attach({send(frame){
  const d=decodeDatagram(frame)!;nets[1-i].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;},close(){}});
 let held:DirectPlay8Event|undefined;
 const desc:SessionDesc={instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",name:"members",password:"",flags:0,maxPlayers:2,user:[0,0,0,0],extended:{flags:0,reserved:[],application:[]}};
 try{
  expect(server.initialize()).toBe(0);server.onEvent=e=>{if(e.type===1||e.type===0x12)held=e;else e.processed?.();};server.onNativeIndicate=()=>({hr:0});
  expect(await server.hostNative(desc,0,{prepare:async r=>({address:r.localAddress,allowIncoming:()=>true,
   url:a=>"x-directplay:/hostname=127.0.0.2;port="+a.port,release(){}})},2308,[20,0,2,14,500])).toBe(0);
  const made=await server.createGroup({name:"host-members",data:[],flags:0},0xa180);expect(made.hr).toBe(0);const group=made.id!;
  const state=[...(api as any).states.values()][0],session=state.session as DirectPlay8Session;
  expect(await session.connectNative({node:[...remoteNet.node],port:2308},desc,0xc181,new Uint8Array(),0,[20,0,2,14,500])).toBe(0);
  callbacks((message,ptr)=>{if(message===6)write(ptr+12,0xc180);return 0;});
  const player=session.localId;expect(session.engine.entities.get(group)?.groupOwner).toBe(server.localId);
  expect(call("AddPlayerToGroup",[group,player,0xb180,0x3600,0])).toBe(DPN.PENDING);const handle=read(0x3600);
  for(let n=0;n<16;n++)await Promise.resolve();expect(held).toMatchObject({type:1,id:group,player});
  expect(server.engine.entities.get(group)?.members).toContain(player);expectNativeMembers(group,[]);
  expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.CANNOTCANCEL);
  expect(call("CancelAsyncOperation",[0,0x8000])).toBe(0);expect(state.operations.has(handle)).toBe(true);
  held!.processed!();for(let n=0;n<16;n++)await Promise.resolve();
  let members=0;callbacks((message,ptr)=>{
   expect(message).toBe(1);members++;
   expect([read(ptr),read(ptr+4),read(ptr+8),read(ptr+12),read(ptr+16)]).toEqual([20,group,0xc180,player,0xc181]);
   expectNativeMembers(group,[player]);return DPN.GENERIC;
  });
  expect(members).toBe(1);expect(state.operations.has(handle)).toBe(true);
  for(let n=0;n<16;n++)await Promise.resolve();let completed=0;callbacks((message,ptr)=>{
   expect(message).toBe(3);expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([handle,0xb180,0]);completed++;return 0;
  });
  expect(completed).toBe(1);expect(call("CancelAsyncOperation",[handle,0])).toBe(DPN.INVALIDHANDLE);
  const duplicate=await call("AddPlayerToGroup",[group,player,0xbeef,0,0x80000000]) as ThunkResult;
  expect(duplicate.value).toBe(DPN.GENERIC);
  expect(call("AddPlayerToGroup",[group,player,0xb181,0x3604,0])).toBe(DPN.PENDING);const rejected=read(0x3604);
  for(let n=0;n<16;n++)await Promise.resolve();let failures=0;callbacks((message,ptr)=>{
   expect(message).toBe(3);expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([rejected,0xb181,DPN.PLAYERALREADYINGROUP]);failures++;return 0;
  });expect(failures).toBe(1);
  held=undefined;expect(call("RemovePlayerFromGroup",[group,player,0xb182,0x3608,0])).toBe(DPN.PENDING);const removing=read(0x3608);
  for(let n=0;n<16;n++)await Promise.resolve();expect(held).toMatchObject({type:0x12,id:group,player});
  expect(server.engine.entities.get(group)?.members).toEqual([]);expectNativeMembers(group,[player]);
  held!.processed!();for(let n=0;n<16;n++)await Promise.resolve();
  let removed=0;callbacks((message,ptr)=>{expect(message).toBe(0x12);expect(read(ptr+12)).toBe(player);expectNativeMembers(group,[]);removed++;return DPN.GENERIC;});
  expect(removed).toBe(1);for(let n=0;n<16;n++)await Promise.resolve();let finished=0;callbacks((message,ptr)=>{
   expect(message).toBe(3);expect([read(ptr+4),read(ptr+8),read(ptr+12)]).toEqual([removing,0xb182,0]);finished++;return 0;
  });expect(finished).toBe(1);
 }finally{api.reset();server.dispose();network.attach(null);remoteNet.attach(null);}
});

test("membership owner chain leaves another queued async completion on its original callback lane",async()=>{
 const group=await readyNativeOrdinaryGroup(),state=[...(api as any).states.values()][0],cb=state.callbacks;
 const resume=cb.queue.pause();expect(cb.native(3,16,(ptr:number)=>{write(ptr+4,0xface);write(ptr+8,0xdead);write(ptr+12,0);})).toBe(true);
 const own=call("AddPlayerToGroup",[group,state.session.localId,0xb190,0x3600,0]) as ThunkResult;
 expect(own.suspendedForCallback).toBe(true);const add=calls.at(-1)!;expect(add.args[1]).toBe(0xffff0001);
 expect(add.done(0)).toBeNull();add.enumerationState!.continueEnumeration();
 const complete=calls.at(-1)!;expect(complete.args[1]).toBe(0xffff0003);expect(read(complete.args[2]+8)).toBe(0xb190);
 expect(complete.done(0)).toBe(DPN.PENDING);expect(cb.queue.size).toBe(1);
 resume();const observed:number[]=[];callbacks((message,ptr)=>{expect(message).toBe(3);expect(read(ptr+4)).toBe(0xface);observed.push(read(ptr+8));return 0;});
 expect(observed).toEqual([0xdead]);
});


/** Public guest Client routed through a real binary carrier to a separate Server. */
async function nativeClientGuest(early = Uint8Array.of(0x53, 0, 0x43, 0xff)) {
    const clientTable = 0x20000 + dpnetModule.interfaces!.findIndex(i => i.name === "IDirectPlay8Client") * 0x100;
    const obj = ComObjectFactory.create(DP8_CLIENT, clientTable)!;
    primary = allocateComObject(process.memory, ram, clientTable); resource.mapAddressToHandle(primary, obj.handle);
    const initialized = await call("Initialize", [0x1234, 0x7000, 0], "IDirectPlay8Client");
    expect(typeof initialized === "number" ? initialized : initialized.value).toBe(DPN.OK);
    write(0x3800, 20); [0, 2, 14, 500].forEach((n, i) => write(0x3804 + i * 4, n));
    expect(call("SetCaps", [0x3800, 0], "IDirectPlay8Client")).toBe(DPN.OK);
    const remoteNet = new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 2)), alias = Uint8Array.of(2, 1, 198, 18, 0, 2);
    network.attach({ send(frame) {
        const d = decodeDatagram(frame)!; expect([...d.node]).toEqual([...alias]);
        remoteNet.receiveFrame(encodeDatagram(d.proto, network.node, d.dstPort, d.srcPort, d.payload)); return true;
    }, close() {} });
    remoteNet.attach({ send(frame) {
        const d = decodeDatagram(frame)!; expect([...d.node]).toEqual([...network.node]);
        network.receiveFrame(encodeDatagram(d.proto, alias, d.dstPort, d.srcPort, d.payload)); return true;
    }, close() {} });
    const application = [...guidBytes(DP8_PEER)].map(n => n.toString(16).padStart(2, "0")).join("");
    const desc: SessionDesc = { instance: "0".repeat(32), application, name: "guest Client Server", password: "",
        flags: 0, maxPlayers: 2, user: [0, 0, 0, 0], extended: { flags: 1, reserved: [], application: [] } };
    const server = new DirectPlay8Session(remoteNet, "server"), received: { data: number[]; id?: number; context?: number }[] = [];
    let joined!: () => void, sent: Promise<number> | undefined;
    const created = new Promise<void>(resolve => { joined = resolve; }), reply = Uint8Array.of(0x52, 0, 0x59);
    server.onNativeIndicate = () => ({ hr: DPN.OK, context: 0x5a01, data: reply });
    server.onEvent = event => {
        if (event.type === 0x11) received.push({ data: [...event.data!], id: event.id, context: event.context });
        event.processed?.();
        if (event.type === 7 && event.id !== server.localId) { sent = Promise.resolve(server.send(event.id!, 8, early)); joined(); }
    };
    expect(server.initialize()).toBe(DPN.OK);
    expect(await server.hostNative(desc, 0, { prepare: async request => ({ address: { node: [...alias], port: request.localPort },
        allowIncoming: () => true, url: address => "x-directplay:/hostname=198.18.0.2;port=" + address.port, release() {} }) },
        2308, [20, 0, 2, 14, 500])).toBe(DPN.OK);
    const address = new DirectPlayAddress(); address.buildHost("198.18.0.2", 2308);
    const addressPtr = addresses.create(address); write(0x4000, 72); write(0x4004, 1); write(0x4028, 2);
    ram.set(guidBytes(DP8_PEER), 0x4018);
    const connect = (sync: boolean, handle = 0) => call("Connect",
        [0x4000, addressPtr, 0, 0, 0, 0, 0, 0xb006, handle, sync ? 0x80000000 : 0], "IDirectPlay8Client");
    const state = [...(api as any).states.values()][0];
    return { server, remoteNet, desc, reply, state, received, connect, async earlySent() {
        await created; expect(await sent).toBe(DPN.OK);
    }, dispose() { server.dispose(); network.attach(null); remoteNet.attach(null); } };
}

test("public Client SYNC Connect runs its actual completion before early RECEIVE and excludes unrelated queued work", async () => {
    const h = await nativeClientGuest();
    try {
        const resume = h.state.callbacks.queue.pause();
        expect(h.state.callbacks.native(3, 16, (ptr: number) => { write(ptr + 4, 0xface); write(ptr + 8, 0xdead); })).toBe(true);
        const pending = h.connect(true) as Promise<ThunkResult>; resume();
        const ready = await pending; await h.earlySent();
        expect(calls).toEqual([]);
        expect(h.connect(true)).toBe(DPN.CONNECTING);
        h.reply.fill(0xee);
        const owner = ready.resumeOnOwner!({ esp: 0x9000, returnAddr: 0x7100, mem: ram }) as ThunkResult;
        expect(owner.value).toBe(DPN.GENERIC);
        expect(owner.startCallbackChain!({ esp: 0x9000, returnAddr: 0x7100, mem: ram })).toBe(true);
        const completion = calls.at(-1)!, ptr = completion.args[2];
        expect(completion.args[1]).toBe(0xffff0005);
        expect([read(ptr), read(ptr + 4), read(ptr + 8), read(ptr + 12)]).toEqual([28, 0, 0, DPN.OK]);
        expect([...ram.slice(read(ptr + 16), read(ptr + 16) + read(ptr + 20))]).toEqual([0x52, 0, 0x59]);
        expect(h.connect(true)).toBe(DPN.ALREADYCONNECTED);
        expect(calls.filter(c => (c.args[1] & 0xffff) === 0x11)).toHaveLength(0);
        ram.set([0x43, 0, 0x53, 0x91], 0x3500); write(0x3400, 4); write(0x3404, 0x3500);
        expect(await call("Send", [0x3400, 1, 0, 0, 0, 0x80000008], "IDirectPlay8Client")).toBe(DPN.OK);
        expect(h.received).toEqual([{ data: [0x43, 0, 0x53, 0x91], id: h.state.session.localId, context: 0x5a01 }]);
        expect(completion.done(0x80004005)).toBeNull();
        completion.enumerationState!.continueEnumeration();
        const receive = calls.at(-1)!, receivedPtr = receive.args[2];
        expect(receive.args[1]).toBe(0xffff0011);
        expect([read(receivedPtr + 4), read(receivedPtr + 8)]).toEqual([0, 0]);
        expect([...ram.slice(read(receivedPtr + 12), read(receivedPtr + 12) + read(receivedPtr + 16))]).toEqual([0x53, 0, 0x43, 0xff]);
        const buffer = read(receivedPtr + 20);
        expect(receive.done(DPN.PENDING)).toBe(DPN.OK);
        expect(calls.some(c => (c.args[1] & 0xffff) === 3)).toBe(false);
        expect(call("ReturnBuffer", [buffer, 0], "IDirectPlay8Client")).toBe(DPN.OK);
        expect(call("ReturnBuffer", [buffer, 0], "IDirectPlay8Client")).toBe(DPN.INVALIDHANDLE);
        let ordinary = 0; callbacks((message, p) => { expect(message).toBe(3); expect([read(p + 4), read(p + 8)]).toEqual([0xface, 0xdead]); ordinary++; return 0; });
        expect(ordinary).toBe(1);
    } finally { h.dispose(); }
});

test("public Client completion entry turns a vanished original Server into NOCONNECTION", async () => {
    const executor = DirectPlayCallbackExecutor.forProcess(process);
    expect(executor.initialize(0x7000, 0)).toBe(DPN.OK); expect(executor.setCount(0)).toBe(DPN.OK);
    const h = await nativeClientGuest();
    try {
        write(0x4200, 0xeeeeeeee);
        expect(h.connect(false, 0x4200)).toBe(DPN.PENDING);
        const handle = read(0x4200); expect(handle).not.toBe(0xeeeeeeee); expect(handle).not.toBe(0);
        await h.earlySent(); for (let n = 0; n < 16; n++) await Promise.resolve();
        expect(h.state.operations.has(handle)).toBe(false);
        expect(h.connect(true)).toBe(DPN.CONNECTING);
        network.setConnected(false, "original carrier lost before notification prepare");
        let complete = 0, receives = 0;
        expect(h.state.callbacks.pending).toBe(1);
        const begin = calls.length, pumped = executor.run(ctx(), 0) as ThunkResult;
        expect(pumped.suspendedForCallback).toBe(true);
        finishManual(begin, (message, p) => {
            if (message === 0x11) { receives++; return 0; }
            expect(message).toBe(5); complete++;
            expect([read(p + 4), read(p + 8), read(p + 12), read(p + 16), read(p + 20), read(p + 24)])
                .toEqual([handle, 0xb006, DPN.NOCONNECTION, 0, 0, 0]);
            return 0;
        });
        expect(complete).toBe(1); expect(receives).toBe(0);
    } finally { h.dispose(); }
});

/** Public Server object: factory/vtable and callback-return paths, not a native CPU observation. */
async function nativeServerGroupGuest(attachLocal = true) {
    if (attachLocal) network.attach({ send() { return false; }, close() {} });
    const descriptor = dpnetModule.interfaces!.find(i => i.name === "IDirectPlay8Server")!;
    ram.set(guidBytes(descriptor.iid!), 0x1800);
    expect(exports.directplay8create(ctx(), ram, [0x1800, 0x1840, 0])).toBe(DPN.OK);
    primary = read(0x1840);
    const serverCall = (method: string, args: number[] = []) => call(method, args, "IDirectPlay8Server");
    const initialized = await serverCall("Initialize", [0x1234, 0x7000, 0]);
    expect(typeof initialized === "number" ? initialized : initialized.value).toBe(DPN.OK);
    const state = [...(api as any).states.values()][0], session = state.session as DirectPlay8Session;
    expect(session.role).toBe("server");
    const desc: SessionDesc = { instance: "0".repeat(32), application: "11223344556677889900aabbccddeeff",
        name: "public Server groups", password: "", flags: 0, maxPlayers: 2, user: [0, 0, 0, 0],
        extended: { flags: 1, reserved: [], application: [] } };
    expect(await session.hostNative(desc, 0xa201, { prepare: async r => ({ address: r.localAddress,
        allowIncoming: () => true, url() { throw Error("Server must not request Peer URL"); }, release() {} }) },
        2308, [20, 0, 2, 14, 500])).toBe(DPN.OK);
    callbacks(message => { expect(message).toBe(7); return 0; });
    return { state, session, serverCall, desc };
}

test("public native Server SetGroupInfo completes asynchronously without a local GROUP_INFO", async () => {
    const s = await nativeServerGroupGuest();
    write(0x3000, 24); write(0x3004, 1); write(0x3008, 0x3100); ram.set(utf16("before\0"), 0x3100);
    const made = s.serverCall("CreateGroup", [0x3000, 0xc201, 0, 0, 0x80000000]) as ThunkResult;
    expect(made.suspendedForCallback).toBe(true);
    const create = calls.at(-1)!; expect(create.args[1]).toBe(0xffff0006);
    const group = read(create.args[2] + 4);
    write(create.args[2] + 12, 0xc202); expect(create.done(DPN.GENERIC)).toBe(DPN.OK);
    const version = s.state.session.engine.host.version, beforeCalls = calls.length;
    ram.set(utf16("after\0"), 0x3100); write(0x3600, 0xeeeeeeee);
    const result = s.serverCall("SetGroupInfo", [group, 0x3000, 0xb201, 0x3600, 0]) as ThunkResult;
    // Source common3990-3998 releases the successful local handle; request2807
    // suppresses local group notification but never suppresses async completion.
    expect(result.suspendedForCallback).toBe(true);
    expect(result.stackCleanup).toBe(24); expect(calls.length).toBe(beforeCalls + 1);
    const complete = calls.at(-1)!, handle = read(0x3600);
    expect(complete.args[1]).toBe(0xffff0003);
    expect([read(complete.args[2] + 4), read(complete.args[2] + 8), read(complete.args[2] + 12)]).toEqual([handle, 0xb201, DPN.OK]);
    expect(handle).not.toBe(0); expect(handle).not.toBe(0xeeeeeeee);
    expect(s.state.session.engine.host.version).toBe(version + 1);
    expect(s.session.groupEntity(group)?.name.short).toBe("after");
    expect(s.serverCall("CancelAsyncOperation", [handle, 0])).toBe(DPN.INVALIDHANDLE);
    expect(complete.done(DPN.GENERIC)).toBe(DPN.PENDING);
    expect(s.state.callbacks.queue.size).toBe(0);
});

test("public native Server group methods retain actual return, contexts, versions and local async completion", async () => {
    const s = await nativeServerGroupGuest(), sc = s.serverCall;
    write(0x3000, 24); write(0x3004, 3); write(0x3008, 0x3100); ram.set(utf16("Server group\0"), 0x3100);
    write(0x300c, 0x3500); write(0x3010, 3); ram.set([7, 0, 9], 0x3500);
    const initialVersion = s.state.session.engine.host.version;
    write(0x3600, 0xeeeeeeee);
    const made = sc("CreateGroup", [0x3000, 0xc210, 0xb210, 0x3600, 0]) as ThunkResult;
    expect(made.suspendedForCallback).toBe(true); expect(made.stackCleanup).toBe(24);
    const create = calls.at(-1)!, group = read(create.args[2] + 4);
    expect(create.args[1]).toBe(0xffff0006);
    expect([read(create.args[2] + 8), read(create.args[2] + 12)]).toEqual([0, 0xc210]);
    expect(read(0x3600)).toBe(0xeeeeeeee);
    expect(sc("GetGroupContext", [group, 0x3400, 0])).toBe(DPN.NOTREADY);
    write(create.args[2] + 12, 0xc211);
    expect(create.done(DPN.GENERIC)).toBeNull(); create.enumerationState!.continueEnumeration();
    let complete = calls.at(-1)!, handle = read(0x3600);
    expect(complete.args[1]).toBe(0xffff0003);
    expect([read(complete.args[2] + 4), read(complete.args[2] + 8), read(complete.args[2] + 12)]).toEqual([handle, 0xb210, 0]);
    expect(handle).not.toBe(0); expect(handle).not.toBe(0xeeeeeeee);
    expect(complete.done(0)).toBe(DPN.PENDING);
    expect(sc("GetGroupContext", [group, 0x3400, 0])).toBe(0); expect(read(0x3400)).toBe(0xc211);
    write(0x3700, 8); expect(sc("EnumPlayersAndGroups", [0x3740, 0x3700, 0x10])).toBe(0);
    expect(read(0x3700)).toBe(1); expect(read(0x3740)).toBe(group);

    write(0x3604, 0xdddddddd);
    const add = sc("AddPlayerToGroup", [group, s.session.localId, 0xb211, 0x3604, 0]) as ThunkResult;
    expect(add.suspendedForCallback).toBe(true); expect(add.stackCleanup).toBe(24);
    let event = calls.at(-1)!; expect(event.args[1]).toBe(0xffff0001);
    expect([read(event.args[2] + 4), read(event.args[2] + 8), read(event.args[2] + 12), read(event.args[2] + 16)])
        .toEqual([group, 0xc211, s.session.localId, 0xa201]);
    write(0x3700, 8); expect(sc("EnumGroupMembers", [group, 0x3740, 0x3700, 0])).toBe(0);
    expect(read(0x3700)).toBe(1); expect(read(0x3740)).toBe(s.session.localId);
    expect(s.state.session.engine.host.version).toBe(initialVersion + 2);
    expect(read(0x3604)).toBe(0xdddddddd);
    expect(event.done(DPN.GENERIC)).toBeNull(); event.enumerationState!.continueEnumeration();
    complete = calls.at(-1)!; handle = read(0x3604); expect(complete.args[1]).toBe(0xffff0003);
    expect([read(complete.args[2] + 4), read(complete.args[2] + 8), read(complete.args[2] + 12)]).toEqual([handle, 0xb211, 0]);
    expect(complete.done(0)).toBe(DPN.PENDING);

    const beforeRemove = calls.length, remove = sc("RemovePlayerFromGroup", [group, s.session.localId, 0xbeef, 0, 0x80000000]) as ThunkResult;
    expect(remove.suspendedForCallback).toBe(true);
    event = calls.at(-1)!; expect(event.args[1]).toBe(0xffff0012);
    expect([read(event.args[2] + 4), read(event.args[2] + 8), read(event.args[2] + 12), read(event.args[2] + 16)])
        .toEqual([group, 0xc211, s.session.localId, 0xa201]);
    write(0x3700, 8); expect(sc("EnumGroupMembers", [group, 0x3740, 0x3700, 0])).toBe(0); expect(read(0x3700)).toBe(0);
    expect(s.state.session.engine.host.version).toBe(initialVersion + 3);
    expect(event.done(DPN.GENERIC)).toBe(DPN.OK); expect(calls.length).toBe(beforeRemove + 1);

    write(0x3608, 0xcccccccc);
    const destroyed = sc("DestroyGroup", [group, 0xb212, 0x3608, 0]) as ThunkResult;
    expect(destroyed.suspendedForCallback).toBe(true); expect(destroyed.stackCleanup).toBe(20);
    event = calls.at(-1)!; expect(event.args[1]).toBe(0xffff0008);
    expect([read(event.args[2] + 4), read(event.args[2] + 8), read(event.args[2] + 12)]).toEqual([group, 0xc211, 1]);
    expect(read(0x3608)).toBe(0xcccccccc); expect(s.state.session.engine.host.version).toBe(initialVersion + 3);
    expect(sc("GetGroupContext", [group, 0x3400, 0])).toBe(0); expect(read(0x3400)).toBe(0xc211);
    write(0x3200, 128); expect(sc("GetGroupInfo", [group, 0x3300, 0x3200, 0])).toBe(0);
    expect([...ram.slice(read(0x330c), read(0x330c) + 3)]).toEqual([7, 0, 9]);
    expect(event.done(DPN.GENERIC)).toBeNull(); event.enumerationState!.continueEnumeration();
    complete = calls.at(-1)!; handle = read(0x3608); expect(complete.args[1]).toBe(0xffff0003);
    expect([read(complete.args[2] + 4), read(complete.args[2] + 8), read(complete.args[2] + 12)]).toEqual([handle, 0xb212, 0]);
    expect(s.state.session.engine.host.version).toBe(initialVersion + 4);
    expect(sc("GetGroupContext", [group, 0x3400, 0])).toBe(DPN.INVALIDGROUP);
    expect(sc("CancelAsyncOperation", [handle, 0])).toBe(DPN.INVALIDHANDLE);
    expect(complete.done(DPN.GENERIC)).toBe(DPN.PENDING); expect(s.state.callbacks.queue.size).toBe(0);
});

test("silent native Server group info stays silent when a later real Client joins", async () => {
    const remote = new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 2));
    const client = new NativeDirectPlayCore(remote, "client", 500, 2);
    const nets = [network, remote];
    for (const [i, net] of nets.entries()) net.attach({ send(frame) {
        const d = decodeDatagram(frame)!;
        nets[1 - i].receiveFrame(encodeDatagram(d.proto, net.node, d.dstPort, d.srcPort, d.payload)); return true;
    }, close() {} });
    try {
        const s = await nativeServerGroupGuest(false);
        write(0x3000, 24); write(0x3004, 1); write(0x3008, 0x3100); ram.set(utf16("before\0"), 0x3100);
        const made = s.serverCall("CreateGroup", [0x3000, 0xc220, 0, 0, 0x80000000]) as ThunkResult;
        expect(made.suspendedForCallback).toBe(true); const create = calls.at(-1)!;
        expect(create.args[1]).toBe(0xffff0006); const group = read(create.args[2] + 4);
        expect(create.done(0)).toBe(0);
        ram.set(utf16("silent\0"), 0x3100);
        const before = calls.length;
        expect(s.serverCall("SetGroupInfo", [group, 0x3000, 0xbeef, 0, 0x80000000])).toBe(DPN.OK);
        expect(calls.length).toBe(before); expect(s.state.callbacks.queue.size).toBe(0);
        expect(s.session.groupEntity(group)?.name.short).toBe("silent");
        s.session.onNativeIndicate = () => ({ hr: DPN.OK, context: 0xa221 });
        expect(await client.connect({ node: [...network.node], port: 2308 }, s.desc,
            { name: { short: "later Client", long: "" }, data: [], flags: 0 }, new Uint8Array())).toBe(DPN.OK);
        let creates = 0;
        callbacks(message => { expect(message).toBe(7); creates++; return 0; });
        expect(creates).toBe(1);
        const lease = client.connectCompletionLease()!; expect(lease.current()).toBe(true); lease.enter(); lease.complete();
        expect(client.entities.has(group)).toBe(false); expect(s.state.callbacks.queue.size).toBe(0);
    } finally { client.dispose(); api.reset(); network.attach(null); remote.attach(null); }
}, 15000);

test("silent native Server group metadata cannot resurface when another group is destroyed", async () => {
    const s = await nativeServerGroupGuest(), sc = s.serverCall;
    write(0x3000, 24); write(0x3004, 1); write(0x3008, 0x3100); ram.set(utf16("first\0"), 0x3100);
    const first = sc("CreateGroup", [0x3000, 0xc230, 0, 0, 0x80000000]) as ThunkResult;
    expect(first.suspendedForCallback).toBe(true);
    let event = calls.at(-1)!; expect(event.args[1]).toBe(0xffff0006); const group = read(event.args[2] + 4);
    expect(event.done(0)).toBe(0);
    ram.set(utf16("silent first\0"), 0x3100);
    expect(sc("SetGroupInfo", [group, 0x3000, 0xbeef, 0, 0x80000000])).toBe(0);
    expect(s.state.callbacks.queue.size).toBe(0);
    ram.set(utf16("second\0"), 0x3100);
    const second = sc("CreateGroup", [0x3000, 0xc231, 0, 0, 0x80000000]) as ThunkResult;
    expect(second.suspendedForCallback).toBe(true);
    event = calls.at(-1)!; expect(event.args[1]).toBe(0xffff0006); const other = read(event.args[2] + 4);
    expect(other).not.toBe(group); expect(event.done(0)).toBe(0);
    const before = calls.length, destroy = sc("DestroyGroup", [other, 0, 0, 0x80000000]) as ThunkResult;
    expect(destroy.suspendedForCallback).toBe(true); event = calls.at(-1)!;
    expect(event.args[1]).toBe(0xffff0008); expect(read(event.args[2] + 4)).toBe(other);
    expect(event.done(DPN.GENERIC)).toBe(0); expect(calls.length).toBe(before + 1);
    expect(s.session.groupEntity(group)?.name.short).toBe("silent first");
    // Destroy's real notifyChange synchronizes every remaining entry. An old
    // silent info mutation must not turn into a delayed local GROUP_INFO.
    expect(s.state.callbacks.queue.size).toBe(0);
});

test("native SetGroupInfo source precedence rejects ALL_PLAYERS before flags and object state", () => {
    write(0x3000, 24); write(0x3600, 0xeeeeeeee);
    const before = calls.length;
    expect(call("SetGroupInfo", [0, 0x3000, 0xb301, 0x3600, 1])).toBe(DPN.INVALIDGROUP);
    expect(read(0x3600)).toBe(0xeeeeeeee); expect(calls.length).toBe(before);
});

test("native SetGroupInfo source errors retain info HRESULTs and parameter precedence", async () => {
    const s = await nativeServerGroupGuest(), sc = s.serverCall;
    write(0x3000, 24);
    const made = sc("CreateGroup", [0x3000, 0xc301, 0, 0, 0x80000000]) as ThunkResult;
    expect(made.suspendedForCallback).toBe(true);
    const create = calls.at(-1)!; const group = read(create.args[2] + 4); expect(create.done(0)).toBe(0);
    const version = s.state.session.engine.host.version, before = calls.length;
    const cases = [
        { info: 0, mask: 0, name: 0, data: 0, size: 0, groupFlags: 0, handle: 0x3600, flags: 1, hr: DPN.INVALIDPOINTER },
        { info: 0x3000, mask: 4, name: 0, data: 0, size: 0, groupFlags: 0, handle: 0, flags: 0x80000000, hr: DPN.INVALIDFLAGS },
        { info: 0x3000, mask: 0, name: 0x3100, data: 0, size: 0, groupFlags: 0, handle: 0, flags: 0x80000000, hr: DPN.INVALIDSTRING },
        { info: 0x3000, mask: 3, name: 0xfffffff0, data: 0xfffffff0, size: 3, groupFlags: 0, handle: 0, flags: 0x80000000, hr: DPN.INVALIDSTRING },
        { info: 0x3000, mask: 0, name: 0, data: 0x3500, size: 0, groupFlags: 0, handle: 0, flags: 0x80000000, hr: DPN.INVALIDPARAM },
        { info: 0x3000, mask: 2, name: 0, data: 0xfffffff0, size: 3, groupFlags: 0, handle: 0, flags: 0x80000000, hr: DPN.INVALIDPOINTER },
        { info: 0x3000, mask: 0, name: 0, data: 0, size: 0, groupFlags: 2, handle: 0, flags: 0x80000000, hr: DPN.INVALIDFLAGS },
        { info: 0x3000, mask: 0, name: 0, data: 0, size: 0, groupFlags: 0, handle: 0, flags: 1, hr: DPN.INVALIDPARAM },
        { info: 0x3000, mask: 0, name: 0, data: 0, size: 0, groupFlags: 0, handle: 0xfffffff0, flags: 1, hr: DPN.INVALIDPOINTER },
    ];
    for (const c of cases) {
        write(0x3000, 24); write(0x3004, c.mask); write(0x3008, c.name); write(0x300c, c.data);
        write(0x3010, c.size); write(0x3014, c.groupFlags); write(0x3600, 0xeeeeeeee);
        expect(sc("SetGroupInfo", [group, c.info, 0xb302, c.handle, c.flags])).toBe(c.hr);
        expect(read(0x3600)).toBe(0xeeeeeeee); expect(calls.length).toBe(before);
        expect(s.state.session.engine.host.version).toBe(version); expect(s.state.callbacks.queue.size).toBe(0);
    }
});

test("native SetGroupInfo source ignores unused size, zero sized data pointer and AUTO metadata flag", async () => {
    const s = await nativeServerGroupGuest(), sc = s.serverCall;
    write(0x3000, 24);
    const made = sc("CreateGroup", [0x3000, 0xc303, 0, 0, 0x80000000]) as ThunkResult;
    expect(made.suspendedForCallback).toBe(true);
    const create = calls.at(-1)!, group = read(create.args[2] + 4); expect(create.done(0)).toBe(0);
    const version = s.state.session.engine.host.version, before = calls.length;
    write(0x3010, 0xffffffff); write(0x3014, 1);
    expect(sc("SetGroupInfo", [group, 0x3000, 0xbeef, 0, 0x80000000])).toBe(0);
    expect(s.session.groupEntity(group)?.flags).toBe(0);
    write(0x3004, 2); write(0x300c, 0xfffffff0); write(0x3010, 0);
    expect(sc("SetGroupInfo", [group, 0x3000, 0xbeef, 0, 0x80000000])).toBe(0);
    expect(s.session.groupEntity(group)?.data).toEqual([]);
    expect(s.state.session.engine.host.version).toBe(version + 2);
    expect(calls.length).toBe(before); expect(s.state.callbacks.queue.size).toBe(0);
});

test("retained deleted Server group SetGroupInfo reports CONNECTIONLOST until actual DESTROY return", async () => {
    const s = await nativeServerGroupGuest(), sc = s.serverCall;
    write(0x3000, 24); write(0x3004, 1); write(0x3008, 0x3100); ram.set(utf16("retained\0"), 0x3100);
    const made = sc("CreateGroup", [0x3000, 0xc310, 0, 0, 0x80000000]) as ThunkResult;
    expect(made.suspendedForCallback).toBe(true);
    let event = calls.at(-1)!, group = read(event.args[2] + 4); expect(event.done(0)).toBe(0);
    const added = sc("AddPlayerToGroup", [group, s.session.localId, 0, 0, 0x80000000]) as ThunkResult;
    expect(added.suspendedForCallback).toBe(true); expect(calls.at(-1)!.done(0)).toBe(0);
    const removing = sc("RemovePlayerFromGroup", [group, s.session.localId, 0xbeef, 0, 0x80000000]) as ThunkResult;
    expect(removing.suspendedForCallback).toBe(true); const remove = calls.at(-1)!;
    expect(remove.args[1]).toBe(0xffff0012);
    const before = calls.length, version = s.state.session.engine.host.version;
    expect(sc("DestroyGroup", [group, 0xbeef, 0, 0x80000000])).toBe(0);
    expect(calls.length).toBe(before);
    expect(s.state.session.engine.entities.has(group)).toBe(false);
    expect(s.state.session.engine.host.version).toBe(version + 1);
    expect(sc("GetGroupContext", [group, 0x3400, 0])).toBe(0); expect(read(0x3400)).toBe(0xc310);
    write(0x3200, 128); expect(sc("GetGroupInfo", [group, 0x3300, 0x3200, 0])).toBe(0);
    ram.set(utf16("forbidden\0"), 0x3100);
    // Executor size includes the original active REMOVE callback. Snapshot its
    // identity so a rejected update cannot add a notification or retire its owner.
    const executor = s.state.callbacks.queue.executor as { jobs: { task: { message?: number }; active: boolean; prepared: boolean; done: boolean }[] };
    const heldJobs = executor.jobs.filter(job => !job.done);
    expect(heldJobs.map(job => [job.task.message, job.active, job.prepared])).toEqual([[0x12, true, true]]);
    expect(sc("SetGroupInfo", [group, 0x3000, 0xbeef, 0, 0x80000000])).toBe(DPN.CONNECTIONLOST);
    expect(s.state.session.engine.host.version).toBe(version + 1);
    expect(s.session.groupEntity(group)?.name.short).toBe("retained");
    expect(s.state.callbacks.queue.size).toBe(1); expect(calls.length).toBe(before);
    const after = executor.jobs.filter(job => !job.done);
    expect(after).toHaveLength(1); expect(after[0]).toBe(heldJobs[0]);
    expect([after[0].task.message, after[0].active, after[0].prepared]).toEqual([0x12, true, true]);
    expect(remove.done(DPN.GENERIC)).toBeNull(); remove.enumerationState!.continueEnumeration();
    event = calls.at(-1)!; expect(event.args[1]).toBe(0xffff0008);
    expect([read(event.args[2] + 4), read(event.args[2] + 8)]).toEqual([group, 0xc310]);
    expect(sc("SetGroupInfo", [group, 0x3000, 0, 0, 0x80000000])).toBe(DPN.CONNECTIONLOST);
    expect(event.done(DPN.GENERIC)).toBe(0);
    expect(sc("SetGroupInfo", [group, 0x3000, 0, 0, 0x80000000])).toBe(DPN.INVALIDGROUP);
    expect(s.state.session.engine.host.version).toBe(version + 1); expect(s.state.callbacks.queue.size).toBe(0);
});

test("public native Server DestroyClient validates target and buffer before flags without mutating host", async () => {
    const s = await nativeServerGroupGuest(), sc = s.serverCall;
    const version = s.state.session.engine.host.version, before = calls.length;
    expect(sc("DestroyClient", [0, 0xfffffff0, 3, 1])).toBe(DPN.INVALIDPLAYER);
    expect(sc("DestroyClient", [s.session.localId, 0xfffffff0, 3, 1])).toBe(DPN.INVALIDPOINTER);
    expect(sc("DestroyClient", [s.session.localId, 0, 0, 1])).toBe(DPN.INVALIDFLAGS);
    expect(sc("DestroyClient", [s.session.localId, 0xfffffff0, 0, 0])).toBe(DPN.INVALIDPLAYER);
    expect(s.state.session.engine.host.version).toBe(version);
    expect(s.state.session.engine.entities.has(s.session.localId)).toBe(true);
    expect(calls.length).toBe(before); expect(s.state.callbacks.queue.size).toBe(0);
});

test("public Client retains native termination until the actual guest callback returns", async () => {
    const h = await nativeClientGuest();
    try {
        const ready = await h.connect(true) as ThunkResult; await h.earlySent();
        const owner = ready.resumeOnOwner!({ esp: 0x9000, returnAddr: 0x7100, mem: ram }) as ThunkResult;
        expect(owner.startCallbackChain!({ esp: 0x9000, returnAddr: 0x7100, mem: ram })).toBe(true);
        const connect = calls.at(-1)!; expect(connect.args[1]).toBe(0xffff0005);
        expect(connect.done(0)).toBeNull(); connect.enumerationState!.continueEnumeration();
        const receive = calls.at(-1)!; expect(receive.args[1]).toBe(0xffff0011);
        expect(receive.done(0)).toBe(DPN.OK);

        const client = h.state.session.engine as any, clientChannel = client.channel;
        const host = (h.server.engine as any).host;
        const connection = [...host.connections.values()].find((c: any) => c.id === h.state.session.localId) as any;
        expect(connection?.channel).toBeDefined(); expect(clientChannel.link.state).toBe("connected");
        const packet = Uint8Array.of(0xdf, 0, 0, 0, 8, 0, 0, 0, 3, 0, 0, 0, 0x74, 0, 0x71);
        expect(await connection.channel.link.sendReliable(packet)).toBe(DPN.OK);
        packet.fill(0xee);
        expect(client.desc).not.toBeNull(); expect(client.entities.has(h.state.session.localId)).toBe(true);

        const before = calls.length;
        const pumped = [...methods.values()].at(-1)!(ctx(), ram, []) as ThunkResult;
        expect(pumped.suspendedForCallback).toBe(true); expect(calls.length).toBe(before + 1);
        const terminate = calls.at(-1)!, ptr = terminate.args[2];
        expect(terminate.args[1]).toBe(0xffff0016);
        expect([read(ptr), read(ptr + 4), read(ptr + 12)]).toEqual([16, DPN.HOSTTERMINATEDSESSION, 3]);
        expect([...ram.slice(read(ptr + 8), read(ptr + 8) + 3)]).toEqual([0x74, 0, 0x71]);
        expect(client.desc).not.toBeNull(); expect(client.entities.has(h.state.session.localId)).toBe(true);
        terminate.done(DPN.GENERIC);
        // Logical teardown follows the guest RET synchronously, independently of carrier drain.
        expect(client.desc).toBeNull(); expect(client.entities.size).toBe(0);
        await clientChannel.closed;
        for (let n = 0; n < 16; n++) await Promise.resolve();
        expect(client.desc).toBeNull(); expect(client.entities.size).toBe(0);
        expect(h.state.callbacks.queue.size).toBe(0);
        expect(calls.filter(item => (item.args[1] & 0xffff) === 0x16)).toHaveLength(1);
    } finally { h.dispose(); }
}, 15000);

test("closing a native Client discards a queued termination before guest callback entry", async () => {
    const h = await nativeClientGuest();
    try {
        const ready = await h.connect(true) as ThunkResult; await h.earlySent();
        const owner = ready.resumeOnOwner!({ esp: 0x9000, returnAddr: 0x7100, mem: ram }) as ThunkResult;
        expect(owner.startCallbackChain!({ esp: 0x9000, returnAddr: 0x7100, mem: ram })).toBe(true);
        const connect = calls.at(-1)!; expect(connect.done(0)).toBeNull(); connect.enumerationState!.continueEnumeration();
        const receive = calls.at(-1)!; expect(receive.args[1]).toBe(0xffff0011); expect(receive.done(0)).toBe(DPN.OK);
        const client = h.state.session.engine as any, host = (h.server.engine as any).host;
        const connection = [...host.connections.values()].find((c: any) => c.id === h.state.session.localId) as any;
        const packet = Uint8Array.of(0xdf, 0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 0, 0x44);
        expect(await connection.channel.link.sendReliable(packet)).toBe(DPN.OK);
        expect(client.desc).not.toBeNull(); expect(h.state.callbacks.queue.size).toBe(1);
        const count = calls.length;
        expect(h.state.session.close()).toBe(DPN.OK);
        expect(client.desc).toBeNull(); expect(h.state.callbacks.queue.size).toBe(0);
        expect(calls.length).toBe(count);
        expect(calls.filter(item => (item.args[1] & 0xffff) === 0x16)).toHaveLength(0);
    } finally { h.dispose(); }
}, 15000);

test("public native Peer TerminateSession waits for its local callback and fans out copied payload", async () => {
    initialize();
    const remote = [new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 2)), new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 3))];
    const nets = [network, ...remote], received: { peer: number; data: number[]; reason: number }[] = [];
    const wire: { to: number; data: Uint8Array }[] = [];
    for (const [from, net] of nets.entries()) net.attach({ send(frame) {
        const d = decodeDatagram(frame)!, to = nets.findIndex(other => other.node.every((n, i) => n === d.node[i]));
        if (to < 0 || d.proto !== PROTO_UDP) return false;
        const decoded = decodeNativeProtocolFrame(d.payload);
        if (from === 0 && decoded?.kind === "data" && (decoded.command & DN.USER1) &&
            (decoded.command & DN.NEW_MESSAGE) && (decoded.command & DN.END_MESSAGE)) wire.push({ to, data: decoded.payload.slice() });
        nets[to].receiveFrame(encodeDatagram(d.proto, net.node, d.dstPort, d.srcPort, d.payload));
        return true;
    }, close() {} });
    const peers = remote.map(net => new NativeDirectPlayCore(net, "peer", 500, 2));
    const state = [...(api as any).states.values()][0], session = state.session as DirectPlay8Session;
    const app: SessionDesc = { instance: "0".repeat(32), application: "11223344556677889900aabbccddeeff",
        name: "public Peer termination", password: "", flags: 0, maxPlayers: 3, user: [0, 0, 0, 0],
        extended: { flags: 0, reserved: [], application: [] } };
    session.onNativeIndicate = () => ({ hr: DPN.OK });
    try {
        expect(await session.hostNative(app, 0xc401, { prepare: async request => ({
            address: request.localAddress, allowIncoming: () => true,
            url: address => "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=" +
                [...nodeToIpv4(Uint8Array.from(address.node))].join(".") + ";port=" + address.port,
            release() {},
        }) }, 2308, [20, 0, 2, 14, 500])).toBe(DPN.OK);
        const expectedContexts = new Map<number, number>();
        const establishContext = (expectedId: number, context: number) => (message: number, ptr: number) => {
            if (message === 7) {
                expect(read(ptr + 4)).toBe(expectedId);
                write(ptr + 8, context); expectedContexts.set(expectedId, context);
            }
            return 0;
        };
        callbacks(establishContext(session.localId, 0xc410));
        expect(expectedContexts.get(session.localId)).toBe(0xc410);
        for (const [index, peer] of peers.entries()) {
            peer.onNativeTermination = (data, reason, returned) => {
                received.push({ peer: index + 1, data: [...data], reason }); returned();
            };
            expect(await peer.connect({ node: [...network.node], port: 2308 }, app,
                { name: { short: "peer" + index, long: "" }, data: [], flags: 0 }, new Uint8Array())).toBe(DPN.OK);
            callbacks(establishContext(peer.localId, 0xc420 + index));
            expect(expectedContexts.get(peer.localId)).toBe(0xc420 + index);
        }
        expect(session.engine.currentPlayers).toBe(3);
        expect(expectedContexts.size).toBe(3);
        for (const [id, context] of expectedContexts) expect(session.contexts.get(id)).toBe(context);
        wire.length = 0;
        ram.set([0x74, 0, 0x71], 0x3500);
        const before = calls.length;
        const result = call("TerminateSession", [0x3500, 3, 0]) as ThunkResult;
        // Primary RED: current native Host returns UNSUPPORTED instead of
        // suspending the issuing guest call for its local TERMINATE callback.
        expect(result.suspendedForCallback).toBe(true);
        expect(calls.length).toBe(before + 1);
        const local = calls.at(-1)!, ptr = local.args[2];
        expect(local.args[1]).toBe(0xffff0016);
        expect([read(ptr), read(ptr + 4), read(ptr + 8), read(ptr + 12)]).toEqual([16, DPN.HOSTTERMINATEDSESSION, 0x3500, 3]);
        expect([...ram.slice(read(ptr + 8), read(ptr + 8) + 3)]).toEqual([0x74, 0, 0x71]);
        expect(session.engine.desc).not.toBeNull();
        ram.fill(0xee, 0x3500, 0x3503);
        const destroyed: { id: number; context: number; reason: number }[] = [];
        const observeCleanup = (message: number, ptr: number) => {
            expect(message).toBe(9);
            expect(read(ptr)).toBe(16);
            destroyed.push({ id: read(ptr + 4), context: read(ptr + 8), reason: read(ptr + 12) });
        };
        const completion = local.done(DPN.GENERIC);
        if (completion === null) {
            local.enumerationState!.continueEnumeration();
            finishManual(before + 1, observeCleanup);
        } else expect(completion).toBe(DPN.OK);
        // The queued worker may fan out before or after the local callback.
        for (let i = 0; i < 500 && (received.length < 2 || session.engine.desc); i++) await Bun.sleep(1);
        callbacks((message, ptr) => { observeCleanup(message, ptr); return 0; });
        expect(received.sort((a, b) => a.peer - b.peer)).toEqual([
            { peer: 1, data: [0x74, 0, 0x71], reason: DPN.HOSTTERMINATEDSESSION },
            { peer: 2, data: [0x74, 0, 0x71], reason: DPN.HOSTTERMINATEDSESSION },
        ]);
        const df = wire.filter(row => row.data.length === 15 &&
            new DataView(row.data.buffer, row.data.byteOffset, row.data.byteLength).getUint32(0, true) === 0xdf);
        expect(df.map(row => row.to).sort()).toEqual([1, 2]);
        for (const row of df) expect([...row.data]).toEqual([0xdf, 0, 0, 0, 8, 0, 0, 0, 3, 0, 0, 0, 0x74, 0, 0x71]);
        expect(session.engine.desc).toBeNull();
        expect(destroyed.slice().sort((a, b) => a.id - b.id)).toEqual(
            [...expectedContexts].map(([id, context]) => ({ id, context, reason: 3 })).sort((a, b) => a.id - b.id));
        expect(calls.filter(item => (item.args[1] & 0xffff) === 0x16)).toHaveLength(1);
    } finally {
        peers.forEach(peer => peer.dispose()); session.dispose(); nets.forEach(net => net.attach(null));
    }
}, 15000);

test("public native Peer TerminateSession preserves a nonnull zero-size pointer in its local callback", async () => {
    const hostId = await readyNativeGroupHost();
    const state = [...(api as any).states.values()][0], session = state.session as DirectPlay8Session;
    const before = calls.length, pointer = 0xfffffff0;
    const result = call("TerminateSession", [pointer, 0, 0]) as ThunkResult;
    expect(result.suspendedForCallback).toBe(true);
    expect(calls.length).toBe(before + 1);
    const local = calls.at(-1)!, ptr = local.args[2];
    expect(local.args[1]).toBe(0xffff0016);
    expect([read(ptr), read(ptr + 4), read(ptr + 8), read(ptr + 12)])
        .toEqual([16, DPN.HOSTTERMINATEDSESSION, pointer, 0]);
    expect(session.engine.entities.has(hostId)).toBe(true);
    const completion = local.done(DPN.GENERIC);
    if (completion === null) {
        local.enumerationState!.continueEnumeration();
        finishManual(before + 1, message => { expect(message).toBe(9); });
    } else expect(completion).toBe(DPN.OK);
    for (let i = 0; i < 500 && session.engine.desc; i++) await Bun.sleep(1);
    expect(session.engine.desc).toBeNull();
    callbacks(message => { expect(message).toBe(9); return 0; });
    expect(calls.filter(item => (item.args[1] & 0xffff) === 0x16)).toHaveLength(1);
}, 15000);

test("failed native Peer TerminateSession frame save cancels its queued callback and leaves Host usable", async () => {
    const hostId = await readyNativeGroupHost();
    const state = [...(api as any).states.values()][0], session = state.session as DirectPlay8Session;
    const manager = process.dispatcher.callbackManager as any, originalSave = manager.saveSuspendedThunkContext;
    const before = calls.length, engine = session.engine;
    try {
        manager.saveSuspendedThunkContext = () => 0;
        expect(call("TerminateSession", [0x3500, 0, 0])).toBe(DPN.GENERIC);
    } finally { manager.saveSuspendedThunkContext = originalSave; }
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(calls.length).toBe(before);
    expect(state.callbacks.pending).toBe(0);
    expect(session.engine).toBe(engine);
    expect(engine.desc).not.toBeNull();
    expect(engine.entities.has(hostId)).toBe(true);
    expect(session.error).toBe(DPN.OK);

    // A fresh call must own a new notification; the abandoned one cannot fire.
    const result = call("TerminateSession", [0x3500, 0, 0]) as ThunkResult;
    expect(result.suspendedForCallback).toBe(true);
    expect(calls.length).toBe(before + 1);
    const local = calls.at(-1)!;
    expect(local.args[1]).toBe(0xffff0016);
    expect([read(local.args[2] + 8), read(local.args[2] + 12)]).toEqual([0x3500, 0]);
    const completion = local.done(0);
    if (completion === null) {
        local.enumerationState!.continueEnumeration();
        finishManual(before + 1, message => { expect(message).toBe(9); });
    } else expect(completion).toBe(DPN.OK);
    for (let i = 0; i < 500 && engine.desc; i++) await Bun.sleep(1);
    expect(engine.desc).toBeNull();
    callbacks(message => { expect(message).toBe(9); return 0; });
    expect(calls.filter(item => (item.args[1] & 0xffff) === 0x16)).toHaveLength(1);
}, 15000);

test("Peer TerminateSession waits for held CREATE return before destroying that player only", async () => {
    initialize();
    const remote = [new LanNetwork(Uint8Array.of(2,0,0,0,0,2)), new LanNetwork(Uint8Array.of(2,0,0,0,0,3))];
    const nets = [network, ...remote], peers = remote.map(net => new NativeDirectPlayCore(net, "peer", 500, 2));
    for (const net of nets) net.attach({ send(frame) {
        const d = decodeDatagram(frame)!, target = nets.find(other => other.node.every((n, i) => n === d.node[i]));
        if (!target || d.proto !== PROTO_UDP) return false;
        target.receiveFrame(encodeDatagram(d.proto, net.node, d.dstPort, d.srcPort, d.payload)); return true;
    }, close() {} });
    const state = [...(api as any).states.values()][0], session = state.session as DirectPlay8Session;
    const app: SessionDesc = { instance: "0".repeat(32), application: "11223344556677889900aabbccddeeff",
        name: "held CREATE termination", password: "", flags: 0, maxPlayers: 3, user: [0,0,0,0],
        extended: { flags: 0, reserved: [], application: [] } };
    const remoteReturns: ((result?: number) => void)[] = [];
    for (const peer of peers) peer.onNativeTermination = (_data, _reason, returned) => { remoteReturns.push(returned); };
    session.onNativeIndicate = () => ({ hr: DPN.OK, context: 0xa501 });
    try {
        expect(await session.hostNative(app, 0xc500, { prepare: async request => ({
            address: request.localAddress, allowIncoming: () => true,
            url: address => "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=" +
                [...nodeToIpv4(Uint8Array.from(address.node))].join(".") + ";port=" + address.port,
            release() {},
        }) }, 2308, [20,0,2,14,500])).toBe(DPN.OK);
        callbacks((message, ptr) => { expect(message).toBe(7); write(ptr + 8, 0xc510); return 0; });
        const hostId = session.localId, address = { node: [...network.node], port: 2308 };
        expect(await peers[0].connect(address, app, { name: { short: "other", long: "" }, data: [], flags: 0 }, new Uint8Array())).toBe(DPN.OK);
        const otherId = peers[0].localId;
        callbacks((message, ptr) => { expect(message).toBe(7); expect(read(ptr + 4)).toBe(otherId); write(ptr + 8, 0xc520); return 0; });
        expect(await peers[1].connect(address, app, { name: { short: "held", long: "" }, data: [], flags: 0 }, new Uint8Array())).toBe(DPN.OK);
        const heldId = peers[1].localId;
        const createStart = calls.length;
        const pump = [...methods.values()].at(-1)!(ctx(), ram, []) as ThunkResult;
        expect(pump.suspendedForCallback).toBe(true); expect(calls.length).toBe(createStart + 1);
        const create = calls.at(-1)!, createPtr = create.args[2];
        expect(create.args[1]).toBe(0xffff0007); expect(read(createPtr + 4)).toBe(heldId);

        // CREATE stays entered on the worker while the original caller runs
        // TERMINATE on its own frame; neither event is fabricated by the test.
        const terminateStart = calls.length;
        const terminating = call("TerminateSession", [0,0,0]) as ThunkResult;
        expect(terminating.suspendedForCallback).toBe(true); expect(calls.length).toBe(terminateStart + 1);
        const termination = calls.at(-1)!; expect(termination.args[1]).toBe(0xffff0016);
        expect(session.engine.desc).not.toBeNull();
        const finish = termination.done(DPN.GENERIC);
        if (finish === null) termination.enumerationState!.continueEnumeration(); else expect(finish).toBe(DPN.OK);
        for (let i = 0; i < 500 && session.engine.desc; i++) await Bun.sleep(1);
        expect(session.engine.desc).toBeNull();

        const destroyed: {id:number;context:number;reason:number}[] = [];
        const collect = (message:number, ptr:number) => {
            expect(message).toBe(9);
            destroyed.push({ id:read(ptr+4), context:read(ptr+8), reason:read(ptr+12) });
        };
        // The real executor may dispatch another eligible callback while its
        // worker remains occupied by CREATE; this is a separate owning frame.
        const executor = DirectPlayCallbackExecutor.forProcess(process), begin = calls.length;
        const other = executor.run({...ctx(),esp:0xa000}, 0) as ThunkResult;
        expect(other.suspendedForCallback).toBe(true);
        finishManual(begin, collect);
        expect(destroyed).toContainEqual({id:otherId,context:0xc520,reason:3});
        expect(destroyed).toContainEqual({id:hostId,context:0xc510,reason:3});
        expect(destroyed.some(event=>event.id===heldId)).toBe(false);

        write(createPtr+8,0xc530);
        create.done(DPN.GENERIC);
        callbacks((message,ptr)=>{collect(message,ptr);return 0;});
        expect(destroyed.filter(event=>event.id===heldId)).toEqual([{id:heldId,context:0xc530,reason:3}]);
        expect(destroyed.filter(event=>event.id===otherId)).toHaveLength(1);
        expect(calls.filter(item=>(item.args[1]&0xffff)===0x16)).toHaveLength(1);
        remoteReturns.forEach(returned=>returned());
    } finally { peers.forEach(peer=>peer.dispose()); session.dispose(); nets.forEach(net=>net.attach(null)); }
}, 15000);

test("Peer TerminateSession defers a member's DESTROY until its held REMOVE callback returns", async () => {
    initialize();
    const remote = new LanNetwork(Uint8Array.of(2,0,0,0,0,2)), nets = [network, remote];
    for (const [from, net] of nets.entries()) net.attach({send(frame) {
        const d = decodeDatagram(frame)!;
        if (d.proto !== PROTO_UDP || !nets[1-from].node.every((n,i)=>n===d.node[i])) return false;
        nets[1-from].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload)); return true;
    },close(){}});
    const peer = new NativeDirectPlayCore(remote, "peer", 500, 2);
    const state = [...(api as any).states.values()][0], session = state.session as DirectPlay8Session;
    const app: SessionDesc = { instance:"0".repeat(32), application:"11223344556677889900aabbccddeeff",
        name:"held REMOVE termination", password:"", flags:0, maxPlayers:2, user:[0,0,0,0],
        extended:{flags:0,reserved:[],application:[]} };
    let remoteReturn: ((result?: number) => void) | undefined;
    peer.onNativeTermination = (_data,_reason,returned) => { remoteReturn = returned; };
    session.onNativeIndicate = () => ({hr:DPN.OK,context:0xa601});
    try {
        expect(await session.hostNative(app,0xc600,{prepare:async request=>({
            address:request.localAddress,allowIncoming:()=>true,
            url:address=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname="+
                [...nodeToIpv4(Uint8Array.from(address.node))].join(".")+";port="+address.port,
            release(){},
        })},2308,[20,0,2,14,500])).toBe(DPN.OK);
        callbacks((message,ptr)=>{expect(message).toBe(7);write(ptr+8,0xc610);return 0;});
        const hostId=session.localId;
        expect(await peer.connect({node:[...network.node],port:2308},app,
            {name:{short:"member",long:""},data:[],flags:0},new Uint8Array())).toBe(DPN.OK);
        const player=peer.localId;
        callbacks((message,ptr)=>{expect(message).toBe(7);expect(read(ptr+4)).toBe(player);write(ptr+8,0xc620);return 0;});
        expect(session.contexts.get(player)).toBe(0xc620);

        write(0x3000,24);write(0x3004,1);write(0x3008,0x3100);ram.set(utf16("stable member\0"),0x3100);
        const made=call("CreateGroup",[0x3000,0xc630,0,0,0x80000000]) as ThunkResult;
        expect(made.suspendedForCallback).toBe(true);
        const create=calls.at(-1)!, group=read(create.args[2]+4);
        expect(create.args[1]).toBe(0xffff0006);write(create.args[2]+12,0xc631);
        expect(create.done(0)).toBe(DPN.OK);
        const added=call("AddPlayerToGroup",[group,player,0,0,0x80000000]) as ThunkResult;
        expect(added.suspendedForCallback).toBe(true);
        const add=calls.at(-1)!;expect(add.args[1]).toBe(0xffff0001);
        expect([read(add.args[2]+4),read(add.args[2]+8),read(add.args[2]+12),read(add.args[2]+16)])
            .toEqual([group,0xc631,player,0xc620]);
        expect(add.done(DPN.GENERIC)).toBe(DPN.OK);
        expect(session.engine.entities.get(group)?.members).toEqual([player]);

        const removeResult=call("RemovePlayerFromGroup",[group,player,0,0,0x80000000]) as ThunkResult;
        expect(removeResult.suspendedForCallback).toBe(true);
        const remove=calls.at(-1)!, removePtr=remove.args[2];
        expect(remove.args[1]).toBe(0xffff0012);
        expect([read(removePtr+4),read(removePtr+8),read(removePtr+12),read(removePtr+16)])
            .toEqual([group,0xc631,player,0xc620]);
        expect(session.engine.entities.get(group)?.members).toEqual([]);

        // The actual REMOVE frame stays entered while the separate caller owns TERMINATE.
        const terminationResult=call("TerminateSession",[0,0,0]) as ThunkResult;
        expect(terminationResult.suspendedForCallback).toBe(true);
        const termination=calls.at(-1)!;expect(termination.args[1]).toBe(0xffff0016);
        const done=termination.done(DPN.GENERIC);
        if(done===null)termination.enumerationState!.continueEnumeration();else expect(done).toBe(DPN.OK);
        for(let i=0;i<500&&session.engine.desc;i++)await Bun.sleep(1);
        expect(session.engine.desc).toBeNull();

        const destroyed:{id:number;context:number;reason:number}[]=[];
        const destroyedGroups:{id:number;context:number;reason:number}[]=[];
        const cleanupOrder:{type:number;id:number}[]=[];
        const collect=(message:number,ptr:number)=>{
            expect([8,9]).toContain(message);
            const event={id:read(ptr+4),context:read(ptr+8),reason:read(ptr+12)};
            cleanupOrder.push({type:message,id:event.id});
            if(message===8)destroyedGroups.push(event);else destroyed.push(event);
        };
        // The held inline REMOVE pauses its lane. Run eligible work on a
        // separate owner frame through the executor, as in the held CREATE test.
        for(let i=0;i<16&&state.callbacks.pending>1;i++){
            const before=calls.length;
            const pumped=DirectPlayCallbackExecutor.forProcess(process).run({...ctx(),esp:0xa000},0) as ThunkResult;
            expect(pumped.suspendedForCallback).toBe(true);
            finishManual(before,collect);
        }
        expect(destroyed).toContainEqual({id:hostId,context:0xc610,reason:3});
        expect(destroyed.some(event=>event.id===player)).toBe(false);
        expect(destroyedGroups.some(event=>event.id===group)).toBe(false);

        const before=calls.length;
        const removeDone=remove.done(DPN.GENERIC);
        if(removeDone===null){remove.enumerationState!.continueEnumeration();finishManual(before,collect);}
        else expect(removeDone).toBe(DPN.OK);
        callbacks((message,ptr)=>{collect(message,ptr);return 0;});
        expect(destroyed.filter(event=>event.id===player)).toEqual([{id:player,context:0xc620,reason:3}]);
        expect(destroyedGroups.filter(event=>event.id===group)).toEqual([{id:group,context:0xc631,reason:3}]);
        // NT5 Remove releases the group notification reference before the player.
        expect(cleanupOrder.findIndex(event=>event.type===8&&event.id===group)).toBeLessThan(
            cleanupOrder.findIndex(event=>event.type===9&&event.id===player));
        expect(destroyed.filter(event=>event.id===hostId)).toHaveLength(1);
        expect(calls.filter(item=>(item.args[1]&0xffff)===0x16)).toHaveLength(1);
        remoteReturn?.();
    } finally {peer.dispose();session.dispose();nets.forEach(net=>net.attach(null));}
},15000);

test("Peer DestroyPeer retains deleted player context across actual CREATE and DESTROY returns", async () => {
    initialize();
    const remote = new LanNetwork(Uint8Array.of(2,0,0,0,0,2)), nets = [network, remote];
    for (const [from,net] of nets.entries()) net.attach({send(frame) {
        const d=decodeDatagram(frame)!;
        if(d.proto!==PROTO_UDP||!nets[1-from].node.every((n,i)=>n===d.node[i]))return false;
        nets[1-from].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;
    },close(){}});
    const target=new NativeDirectPlayCore(remote,"peer",500,2);
    const state=[...(api as any).states.values()][0], session=state.session as DirectPlay8Session;
    const app:SessionDesc={instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",
        name:"retained player context",password:"",flags:0,maxPlayers:2,user:[0,0,0,0],
        extended:{flags:0,reserved:[],application:[]}};
    let remoteReturn:((result?:number)=>void)|undefined;
    target.onNativeTermination=(_data,_reason,returned)=>{remoteReturn=returned;};
    session.onNativeIndicate=()=>({hr:DPN.OK,context:0xa701});
    const query=(id:number,expected:number,context?:number)=>{
        write(0x3600,0xeeeeeeee);
        expect(call("GetPlayerContext",[id,0x3600,0])).toBe(expected);
        expect(read(0x3600)).toBe(context===undefined?0xeeeeeeee:context);
    };
    try {
        expect(await session.hostNative(app,0xc700,{prepare:async request=>({
            address:request.localAddress,allowIncoming:()=>true,
            url:address=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname="+
                [...nodeToIpv4(Uint8Array.from(address.node))].join(".")+";port="+address.port,
            release(){},
        })},2308,[20,0,2,14,500])).toBe(DPN.OK);
        callbacks();
        expect(await target.connect({node:[...network.node],port:2308},app,
            {name:{short:"target",long:""},data:[],flags:0},new Uint8Array())).toBe(DPN.OK);
        const id=target.localId, before=calls.length;
        const pumped=[...methods.values()].at(-1)!(ctx(),ram,[]) as ThunkResult;
        expect(pumped.suspendedForCallback).toBe(true);expect(calls.length).toBe(before+1);
        const create=calls.at(-1)!, createPtr=create.args[2];
        expect(create.args[1]).toBe(0xffff0007);
        expect([read(createPtr+4),read(createPtr+8)]).toEqual([id,0xa701]);

        // FindEntry sees an available but not-yet-Created player.
        query(id,DPN.NOTREADY);
        expect(call("DestroyPeer",[id,0,0,0])).toBe(DPN.OK);
        // FindDeletedEntry sees unavailable and not-yet-Created.
        query(id,DPN.INVALIDPLAYER);
        expect(calls.filter(item=>(item.args[1]&0xffff)===9)).toHaveLength(0);

        write(createPtr+8,0xc701);
        create.done(DPN.GENERIC);
        // CREATE wrote back the context; retained deleted entry remains queryable.
        query(id,DPN.OK,0xc701);
        const destroyStart=calls.length;
        const destroyPump=[...methods.values()].at(-1)!(ctx(),ram,[]) as ThunkResult;
        expect(destroyPump.suspendedForCallback).toBe(true);expect(calls.length).toBe(destroyStart+1);
        const destroy=calls.at(-1)!, destroyPtr=destroy.args[2];
        expect(destroy.args[1]).toBe(0xffff0009);
        expect([read(destroyPtr),read(destroyPtr+4),read(destroyPtr+8),read(destroyPtr+12)])
            .toEqual([16,id,0xc701,4]);
        query(id,DPN.OK,0xc701);
        destroy.done(DPN.GENERIC);
        query(id,DPN.INVALIDPLAYER);
        expect(calls.filter(item=>(item.args[1]&0xffff)===9)).toHaveLength(1);
        remoteReturn?.();
    } finally {target.dispose();session.dispose();nets.forEach(net=>net.attach(null));}
},15000);

test("Peer GetPlayerContext validates ID, output and flags before initialized state", () => {
    write(0x3600,0xeeeeeeee);
    // NT5 DN_ValidateGetPlayerContext: ALL_PLAYERS, writable output, flags.
    expect(call("GetPlayerContext",[0,0xfffffff0,1])).toBe(DPN.INVALIDPLAYER);
    expect(call("GetPlayerContext",[1,0xfffffff0,1])).toBe(DPN.INVALIDPOINTER);
    expect(call("GetPlayerContext",[1,0,1])).toBe(DPN.INVALIDPOINTER);
    expect(call("GetPlayerContext",[1,0x3600,1])).toBe(DPN.INVALIDFLAGS);
    expect(read(0x3600)).toBe(0xeeeeeeee);
    expect(call("GetPlayerContext",[1,0x3600,0])).toBe(DPN.UNINITIALIZED);
    expect(read(0x3600)).toBe(0xeeeeeeee);
    initialize();
    expect(call("GetPlayerContext",[1,0x3600,0])).toBe(DPN.NOCONNECTION);
    expect(read(0x3600)).toBe(0xeeeeeeee);
});

test("public Server GetPlayerContext waits for the Client CREATE return", async () => {
    const remote=new LanNetwork(Uint8Array.of(2,0,0,0,0,2));
    const client=new NativeDirectPlayCore(remote,"client",500,2), nets=[network,remote];
    for(const [from,net] of nets.entries())net.attach({send(frame){
        const d=decodeDatagram(frame)!;
        if(d.proto!==PROTO_UDP||!nets[1-from].node.every((n,i)=>n===d.node[i]))return false;
        nets[1-from].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;
    },close(){}});
    try{
        const s=await nativeServerGroupGuest(false);
        s.session.onNativeIndicate=()=>({hr:DPN.OK,context:0xa801});
        expect(await client.connect({node:[...network.node],port:2308},s.desc,
            {name:{short:"Client",long:""},data:[],flags:0},new Uint8Array())).toBe(DPN.OK);
        const id=client.localId,before=calls.length;
        const pumped=[...methods.values()].at(-1)!(ctx(),ram,[]) as ThunkResult;
        expect(pumped.suspendedForCallback).toBe(true);expect(calls.length).toBe(before+1);
        const create=calls.at(-1)!, ptr=create.args[2];
        expect(create.args[1]).toBe(0xffff0007);
        expect([read(ptr+4),read(ptr+8)]).toEqual([id,0xa801]);
        write(0x3600,0xeeeeeeee);
        expect(s.serverCall("GetPlayerContext",[id,0x3600,0])).toBe(DPN.NOTREADY);
        expect(read(0x3600)).toBe(0xeeeeeeee);
        write(ptr+8,0xc801);create.done(DPN.GENERIC);
        expect(s.serverCall("GetPlayerContext",[id,0x3600,0])).toBe(DPN.OK);
        expect(read(0x3600)).toBe(0xc801);
        const lease=client.connectCompletionLease()!;expect(lease.current()).toBe(true);lease.enter();lease.complete();
        expect(s.state.callbacks.queue.size).toBe(0);
    }finally{client.dispose();api.reset();network.attach(null);remote.attach(null);}
},15000);
