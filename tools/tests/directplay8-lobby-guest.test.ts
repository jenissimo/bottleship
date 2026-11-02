import { beforeEach, afterEach, expect, test } from "bun:test";
import type { Process } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { BaseComObject, ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../src/worker/core/thunking/thunk-dispatcher";
import type { VTableInfo } from "../../src/worker/api/adapters/module-adapter";
import { ProcessIpc } from "../../src/worker/core/process-ipc";
import { dpnlobbyModule } from "../../src/worker/api/dpnlobby.api";
import { dpnetModule } from "../../src/worker/api/dpnet.api";
import { DirectPlay8NetworkApi } from "../../src/worker/modules/dpnet/network-api";
import { allocateComObject } from "../../src/worker/core/com/com-memory";
import { DirectPlayAddressApi } from "../../src/worker/modules/dpnet/address-api";
import { DirectPlay8LobbyApi } from "../../src/worker/modules/dpnlobby/network-api";
import { DirectPlay8LobbyBroker, type Lobby8Request, type Lobby8Reply } from "../../src/worker/modules/dpnlobby/broker";
import { DPL8_CLIENT, DPL8_APP } from "../../src/worker/modules/dpnlobby/constants";
import { DPN, DP8_PEER, guidBytes, utf16, fromUtf16 } from "../../src/worker/modules/dpnet/constants";
import { settingsSize, type Lobby8Settings } from "../../src/worker/modules/dpnlobby/structures";
const system = System.getInstance(), resource = SystemResourceProvider.getInstance(), oldProcess = system.process;
let memory: Uint8Array, process: Process, addresses: DirectPlayAddressApi, api: DirectPlay8LobbyApi, exports: Record<string, ThunkImplementation>;
let objects: BaseComObject[], allocated: number, broker: DirectPlay8LobbyBroker, ipc: ProcessIpc;
let dispatch: (request: Lobby8Request) => Lobby8Reply | Promise<Lobby8Reply>;
const read = (ptr: number) => new DataView(memory.buffer).getUint32(ptr, true);
const write = (ptr: number, value: number) => new DataView(memory.buffer).setUint32(ptr, value, true);
const wide = (ptr: number, value: string) => memory.set(utf16(value + "\0"), ptr);
function call(pointer: number, method: string, args: number[] = [], app = false) {
    return exports[(app ? "IDirectPlay8LobbiedApplication_" : "IDirectPlay8LobbyClient_") + method]({ esp: 0x9000 } as X86Context, memory, [pointer, ...args]);
}
function create(iid: string): number {
    memory.set(guidBytes(iid), 0x2000);
    expect(exports.DirectPlay8LobbyCreate({} as X86Context, memory, [0x2000, 0x2100, 0])).toBe(0);
    return read(0x2100);
}
const apply = (result: any): number => {
    if (result.resumeOnOwner) result = result.resumeOnOwner({ mem: memory, esp: 0x9000, returnAddr: 0x401000 });
    if (typeof result === "number") return result;
    for (const write of result.deferredWrites ?? []) Mem.writeUint32(write.address, write.value);
    return result.value;
};
beforeEach(() => {
    memory = new Uint8Array(2 * 1024 * 1024); objects = []; allocated = 0x100000;
    const alloc = (size: number) => { const ptr = allocated; allocated += (size + 15) & ~15; return ptr; };
    process = { resetGeneration: 0, onReset: () => () => {}, resourceProvider: resource,
        getCurrentMemory: () => memory, memory: { alloc, allocSystemBlock: alloc, free() {}, freeSystemBlock() {} },
        addressSpace: { validateRange: (ptr: number, size: number) => ptr >= 0x1000 && ptr + size <= memory.length } } as unknown as Process;
    system.process = process; Mem.bind(() => memory);
    const descriptors = [...dpnlobbyModule.interfaces!, ...dpnetModule.interfaces!];
    const tables = Object.fromEntries(descriptors.map((iface, i) => [iface.name, { address: 0x6000 + i * 0x100, size: iface.methods.length }])) as Record<string, VTableInfo>;
    for (const iface of descriptors) if (iface.iid) {
        const iid = iface.iid;
        ComObjectFactory.register(iid, class TestLobbyCom extends BaseComObject {
            constructor(table: number) { super(iid, table); objects.push(this); } protected destroy() {}
        });
    }
    addresses = new DirectPlayAddressApi(process, () => tables); api = new DirectPlay8LobbyApi(process, () => tables, () => addresses);
    ipc = new ProcessIpc(9180); broker = new DirectPlay8LobbyBroker(ipc); dispatch = request => broker.dispatch(request, 9180);
    (api as any).endpoint = { call: (request: Lobby8Request) => dispatch(request), close() {} };
    exports = {}; api.install(exports);
});
afterEach(() => {
    api.reset(); addresses.reset(); broker.close(); ipc.close();
    for (const object of objects) resource.unregisterComObject(object.handle);
    system.process = oldProcess;
});
test("DP8 Lobby ABI has separate controlling IUnknown identity and exact initialization/singleton errors", () => {
    expect(dpnlobbyModule.interfaces![0].methods).toHaveLength(11);
    expect(dpnlobbyModule.interfaces![1].methods).toHaveLength(12);
    memory.set(guidBytes("00000000-0000-0000-c000-000000000046"), 0x2000); write(0x2100, 0xdeadbeef);
    expect(exports.DirectPlay8LobbyCreate({} as X86Context, memory, [0x2000, 0x2100, 0])).toBe(DPN.INVALIDPARAM); expect(read(0x2100)).toBe(0xdeadbeef);
    const client = create(DPL8_CLIENT), other = create(DPL8_CLIENT), app = create(DPL8_APP);
    expect(call(client, "Close", [0])).toBe(DPN.UNINITIALIZED);
    expect(call(client, "Initialize", [0, 0, 0])).toBe(DPN.INVALIDPOINTER);
    expect(call(client, "Initialize", [0, 0x4000, 2])).toBe(DPN.INVALIDFLAGS);
    expect(call(client, "Initialize", [0x1234, 0x4000, 0])).toBe(0);
    expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(DPN.ALREADYINITIALIZED);
    expect(call(other, "Initialize", [0, 0x4000, 0])).toBe(DPN.NOTALLOWED);
    write(0x2500, 0xdeadbeef); expect(call(app, "Initialize", [0, 0x4000, 0x2500, 0], true)).toBe(0); expect(read(0x2500)).toBe(0);
    memory.set(guidBytes("00000000-0000-0000-c000-000000000046"), 0x2000);
    expect(call(client, "QueryInterface", [0x2000, 0x2100])).toBe(0);
    const unknown = read(0x2100); expect(unknown).not.toBe(client);
    expect(resource.getComObjectByAddress(unknown)?.handle).toBe(resource.getComObjectByAddress(client)?.handle);
    expect(call(unknown, "QueryInterface", [0x2000, 0x2100])).toBe(0); expect(read(0x2100)).toBe(unknown);
    expect(call(client, "Close", [0])).toBe(0); expect(call(other, "Initialize", [0, 0x4000, 0])).toBe(0);
});
test("DP8 native parameter validation precedes initialization and supports empty ALLCONNECTIONS operations", () => {
    const client = create(DPL8_CLIENT), app = create(DPL8_APP);
    expect(call(client, "Close", [1])).toBe(DPN.INVALIDFLAGS);
    expect(call(client, "EnumLocalPrograms", [0, 0, 0, 0x2500, 0])).toBe(DPN.INVALIDPOINTER);
    expect(call(client, "Send", [0, 0, 0, 1])).toBe(DPN.INVALIDHANDLE);
    expect(call(app, "SetAppAvailable", [1, 2], true)).toBe(DPN.INVALIDFLAGS);
    expect(call(app, "UpdateStatus", [0, 1, 1], true)).toBe(DPN.INVALIDHANDLE);
    expect(call(client, "ReleaseApplication", [0, 1])).toBe(DPN.INVALIDHANDLE);
    expect(call(client, "GetConnectionSettings", [0, 0, 0, 1])).toBe(DPN.INVALIDHANDLE);
    expect(call(client, "SetConnectionSettings", [0, 0, 1])).toBe(DPN.INVALIDHANDLE);
    expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(0);
    memory[0x2500] = 9;
    expect(call(client, "Send", [0xffffffff, 0x2500, 1, 0])).toBe(0);
    expect(call(client, "ReleaseApplication", [0xffffffff, 0])).toBe(0);
    expect(call(client, "SetConnectionSettings", [0xffffffff, 0, 0])).toBe(0);
    expect(call(client, "GetConnectionSettings", [0xffffffff, 0, 0x2500, 0])).toBe(DPN.INVALIDHANDLE);
});
test("RegisterLobby owns a real application COM reference until unregister and then closes the final application state", () => {
    const app = create(DPL8_APP), application = resource.getComObjectByAddress(app)!;
    const tables = api.tables(), peerApi = new DirectPlay8NetworkApi(process, () => tables, addresses);
    const peer = ComObjectFactory.create(DP8_PEER, tables.IDirectPlay8Peer.address)!;
    const pointer = allocateComObject(process.memory, memory, tables.IDirectPlay8Peer.address);
    resource.mapAddressToHandle(pointer, peer.handle);
    const peerExports: Record<string, ThunkImplementation> = {}; peerApi.install(peerExports);
    const peerCall = (name: string, args: number[]) => peerExports["IDirectPlay8Peer_" + name]({} as X86Context, memory, [pointer, ...args]);
    expect(peerCall("Initialize", [0, 0x4000, 0])).toBe(0);
    expect(peerCall("RegisterLobby", [99, app, 1])).toBe(0);
    expect(call(app, "Release", [], true)).toBe(1); expect(resource.getComObjectByAddress(app)).toBe(application);
    expect(peerCall("RegisterLobby", [0, 0, 2])).toBe(0);
    expect(resource.getComObjectByAddress(app)).toBeNull(); expect((api as any).states.has(application.handle)).toBe(false);
    peerApi.reset();
});
test("DP8 Lobby EnumLocalPrograms preserves short-buffer item count and successful caller capacity", () => {
    const client = create(DPL8_CLIENT), app = create(DPL8_APP);
    const guid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    write(0x3000, 56); memory.set(guidBytes(guid), 0x3008);
    wide(0x3100, "BS DPL8 oracle"); write(0x3018, 0x3100);
    wide(0x3200, "game.exe"); write(0x3028, 0x3200);
    wide(0x3300, "C:\\"); write(0x302c, 0x3300);
    expect(call(app, "RegisterProgram", [0x3000, 0], true)).toBe(0);
    expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(0);
    memory.set(guidBytes(guid), 0x2000); write(0x2500, 0); write(0x2504, 99);
    expect(call(client, "EnumLocalPrograms", [0x2000, 0, 0x2500, 0x2504, 0])).toBe(DPN.BUFFERTOOSMALL);
    expect(read(0x2500)).toBe(62); expect(read(0x2504)).toBe(99);
    write(0x2500, 2048);
    expect(call(client, "EnumLocalPrograms", [0x2000, 0x5000, 0x2500, 0x2504, 0])).toBe(0);
    expect(read(0x2500)).toBe(2048); expect(read(0x2504)).toBe(1);
    expect(fromUtf16(memory.slice(read(0x5010), read(0x5010) + 30))).toBe("BS DPL8 oracle");
    expect(call(app, "UnRegisterProgram", [0x2000, 0], true)).toBe(0);
});
test("DP8 remote settings allocate COM references and select HRESULT only at the owner continuation", async () => {
    const client = create(DPL8_CLIENT); expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(0);
    const own: Lobby8Settings = { flags: 1, players: 3, desc: { application: "a".repeat(32), instance: "b".repeat(32),
        name: "Лан", password: "", maxPlayers: 8, flags: 0, user: [0, 0, 0, 0] }, player: "玩家", host: null,
        devices: [{ components: [], userData: new Uint8Array([1, 2]) }] };
    let resolve!: (value: Lobby8Reply) => void;
    const oldDispatch = dispatch; dispatch = request => request.op === "get" ? new Promise(done => { resolve = done; }) : oldDispatch(request);
    memory.fill(0xcc, 0x5000, 0x6000); write(0x2500, 4096);
    const pending = call(client, "GetConnectionSettings", [7, 0x5000, 0x2500, 0]) as Promise<ThunkResult>;
    const foreign = new Uint8Array(memory.length), allocatedBefore = allocated; Mem.bind(() => foreign);
    resolve({ hr: 0, settings: own }); const result = await pending;
    expect(result.resumeOnOwner).toBeDefined(); expect(allocated).toBe(allocatedBefore);
    expect(memory[0x5000]).toBe(0xcc); expect(foreign[0x5000]).toBe(0);
    Mem.bind(() => memory); expect(apply(result)).toBe(0);
    expect(read(0x5000)).toBe(96); expect(read(0x5034)).toBe(3); expect(read(0x5058)).toBe(1);
    expect(read(0x2500)).toBe(settingsSize(own));
    const device = read(read(0x5054)); expect(addresses.address(device)?.userData).toEqual(new Uint8Array([1, 2]));
    write(0x2500, settingsSize(own) - 1);
    const short = call(client, "GetConnectionSettings", [7, 0x5000, 0x2500, 0]) as Promise<ThunkResult>;
    resolve({ hr: 0, settings: own }); const shortResult = await short;
    expect(read(0x2500)).toBe(settingsSize(own) - 1); expect(apply(shortResult)).toBe(DPN.BUFFERTOOSMALL);
    expect(read(0x2500)).toBe(settingsSize(own));
});
test("DP8 Close and reinitialize replace a pending callback pump without losing the new pump", async () => {
    const client = create(DPL8_CLIENT), peeks: Array<(reply: Lobby8Reply) => void> = [];
    const oldDispatch = dispatch;
    dispatch = request => request.op === "peek" ? new Promise(resolve => { peeks.push(resolve); }) : oldDispatch(request);
    expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(0);
    const state = [...(api as any).states.values()][0] as { pumping: boolean };
    expect(state.pumping).toBe(true); expect(peeks).toHaveLength(1);
    expect(call(client, "Close", [0])).toBe(0); expect(state.pumping).toBe(false);
    expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(0); expect(peeks).toHaveLength(2);
    peeks[0]({ hr: 0 }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.pumping).toBe(true);
    peeks[1]({ hr: 0 }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.pumping).toBe(false);
});
test("DP8 pending settings replies after Close cannot allocate or write into a new object lifetime", async () => {
    const client = create(DPL8_CLIENT); expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(0);
    let resolve!: (reply: Lobby8Reply) => void;
    const oldDispatch = dispatch; dispatch = request => request.op === "get" ? new Promise(done => { resolve = done; }) : oldDispatch(request);
    write(0x2500, 0); const pending = call(client, "GetConnectionSettings", [7, 0, 0x2500, 0]) as Promise<ThunkResult>;
    expect(call(client, "Close", [0])).toBe(0);
    expect(call(client, "Initialize", [0, 0x4000, 0])).toBe(0);
    resolve({ hr: DPN.INVALIDHANDLE }); expect(apply(await pending)).toBe(DPN.UNINITIALIZED); expect(read(0x2500)).toBe(0);
});
