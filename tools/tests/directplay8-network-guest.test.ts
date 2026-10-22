import { beforeEach, afterEach, test, expect } from "bun:test";
import { DirectPlay8NetworkApi } from "../../src/worker/modules/dpnet/network-api";
import { DirectPlayAddressApi } from "../../src/worker/modules/dpnet/address-api";
import { DirectPlayAddress } from "../../src/worker/modules/dpnet/address";
import { DPN, DP8_PEER, DP8_TCPIP, guidBytes, utf16 } from "../../src/worker/modules/dpnet/constants";
import { registerLobbyPeerProvider } from "../../src/worker/modules/dpnlobby/peer-bridge";
import { dpnetModule } from "../../src/worker/api/dpnet.api";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { BaseComObject, ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { allocateComObject } from "../../src/worker/core/com/com-memory";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { LanNetwork } from "../../src/worker/net/lan-network";
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
let calls: { args: number[]; done: (hr: number) => number }[];
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
            callbackManager: { saveSuspendedThunkContext: () => 1, abandonSuspendedFrame() {}, getPendingCallback: () => undefined,
                invokeCallback: (_routine: number, args: number[], _cleanup: number, done: (hr: number) => number) => {
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
async function host() {
    initialize(); write(0x3000, 24); write(0x3004, 1); write(0x3008, 0x3100); ram.set(utf16("Host\0"), 0x3100);
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
    callbacks(message => { expect(message).toBe(2); return 0; });
    await Bun.sleep(8); const completed: number[] = [];
    callbacks((message, ptr) => { expect(message).toBe(0x14); expect(read(ptr + 12)).toBe(0); completed.push(read(ptr + 4)); return 0; });
    expect(completed).toEqual(admitted); expect(new Set(completed).size).toBe(256); expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0);
    await Bun.sleep(8); callbacks(() => { throw Error("Duplicated completion"); });
    expect(call("SendTo", [0, 0x3400, 1, 0, 1000, 0x3600, 0x20])).toBe(DPN.PENDING); await Bun.sleep(8); let last = 0;
    callbacks((message, ptr) => { expect(message).toBe(0x14); expect(read(ptr + 8)).toBe(1000); last++; return 0; }); expect(last).toBe(1);
});
test("Close and reset retire blocked send completions before a fresh initialization", async () => {
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
            expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0);
            callbacks(message => { expect(message === 2 || message === 9).toBe(true); return 0; });
            const result = await close; expect(result.value).toBe(0); result.startCallbackChain?.({ esp: 0x9000, returnAddr: 0x7000 });
        } else { api.reset(); expect(state.sendRecords.size).toBe(0); expect(state.sends.reservedJobs).toBe(0); }
        state.sends.retryCompletions(); await Bun.sleep(8); expect(state.sends.pendingBytes).toBe(0);
        if (closing) { await host(); expect(call("SendTo", [0, 0x3400, 1, 0, 999, 0x3600, 0x20])).toBe(DPN.PENDING); await Bun.sleep(8);
            let completed = 0; callbacks((message, ptr) => { expect(message).toBe(0x14); expect(read(ptr + 8)).toBe(999); completed++; return 0; }); expect(completed).toBe(1); api.reset(); }
    }
});
test("native SEND_COMPLETE only returns NOCOPY descriptors and self queue errors preserve outputs", async () => {
    const id = await host(); ram.set([7, 0, 9], 0x3500); write(0x3400, 1); write(0x3404, 0x3500); write(0x3408, 2); write(0x340c, 0x3501);
    write(0x3700, 999); write(0x3704, 999); expect(call("GetSendQueueInfo", [id, 0x3700, 0x3704, 0])).toBe(DPN.INVALIDPLAYER); expect(read(0x3700)).toBe(999); expect(read(0x3704)).toBe(999);
    for (const flags of [0, 1, 8, 9]) {
        expect(call("SendTo", [id, 0x3400, 2, 0, flags + 100, 0x3600, flags])).toBe(DPN.PENDING); const handle = read(0x3600); await Bun.sleep(8); let completed = 0;
        callbacks((message, ptr) => { if (message === 0x11) return 0; expect(message).toBe(0x14); completed++;
            expect(read(ptr)).toBe(40); expect(read(ptr + 4)).toBe(handle); expect(read(ptr + 8)).toBe(flags + 100); expect(read(ptr + 12)).toBe(0); expect(read(ptr + 28)).toBe(flags & 8 ? 1 : 0);
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
        write(0x3600, 0xcccccccc); expect(await call("SendTo", [id, 0x3400, 1, 100, 0, handle ? 0x3600 : 0, flags])).toBe(expected);
        expect(read(0x3600) !== 0xcccccccc).toBe(handle && expected === DPN.PENDING);
        await Bun.sleep(1); let count = 0; callbacks(message => { if (message === 0x11) count++; return 0; }); expect(count).toBe(receives);
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
