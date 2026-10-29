import { afterEach, beforeEach, expect, test } from "bun:test";
import { DirectPlayNetworkApi, packDirectPlayMessage } from "../../src/worker/modules/dplayx/network-api";
import { DP, DirectPlaySession } from "../../src/worker/modules/dplayx/session";
import { decodeDatagram, encodeDatagram, encodeTcpFrame, PROTO_TCP, PROTO_UDP, PROTO_DIRECTPLAY, SYN, DATA, TCP_WINDOW, isBroadcastNode } from "../../src/worker/net/netplay-wire";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { WsaSocketTable } from "../../src/worker/modules/wsa-network";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { BaseComObject, ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { allocateComObject } from "../../src/worker/core/com/com-memory";
import { dplayxModule, IDirectPlay, IDirectPlay2A, IDirectPlay3A, IDirectPlay4A } from "../../src/worker/api/dplayx.api";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../src/worker/core/thunking/thunk-dispatcher";
import type { Process } from "../../src/worker/core/process";
import type { VTableInfo } from "../../src/worker/api/adapters/module-adapter";

const system = System.getInstance(), resource = SystemResourceProvider.getInstance(), originalProcess = system.process;
let mem: Uint8Array, api: DirectPlayNetworkApi, exports: Record<string, ThunkImplementation>, process: Process;
let primary: number, allocated: number, callbacks: { args: number[]; done?: (value: number) => number | null; state?: unknown }[], saved: unknown[], freed: number[];
let objects: BaseComObject[], events: number[], originalSetEvent: typeof system.scheduler.setEvent;
class TestCom extends BaseComObject { constructor(vtable: number) { super("0ab1c531-4745-11d1-a7a1-0000f803abfc", vtable); objects.push(this); } protected destroy(): void {} }
function u32(ptr: number, n: number): void { new DataView(mem.buffer).setUint32(ptr, n >>> 0, true); }
function read(ptr: number): number { return new DataView(mem.buffer).getUint32(ptr, true); }
function bytes(ptr: number, text: string): void { mem.set(Uint8Array.from(text.match(/../g)!, n => parseInt(n, 16)), ptr); }
function call(method: string, args: number[] = [], iface = "IDirectPlay4A") {
    return exports[iface + "_" + method]({ esp: 0x9000 } as X86Context, mem, [primary, ...args]);
}
function object(): number {
    const obj = new TestCom(0x6000);
    const addr = allocateComObject(process.memory, mem, 0x6000); resource.mapAddressToHandle(addr, obj.handle);
    return addr;
}
function initialize(): void {
    bytes(0x2000, "60f518132c91d0119daa00a0c90a43cb"); u32(0x2010, 4); u32(0x2014, 60);
    bytes(0x2018, "c016d907afe0cf119c4e00a0c905425e"); u32(0x2028, 16);
    bytes(0x202c, "e05ee9367785cf11960c0080c7534e82");
    expect(call("InitializeConnection", [0x2000, 0])).toBe(DP.OK);
}
function open(): void {
    initialize(); u32(0x3000, 80); u32(0x3028, 8); bytes(0x3018, "1".repeat(32));
    expect(call("Open", [0x3000, 2])).toBe(DP.OK);
}
async function create(event = 0): Promise<number> {
    expect(await call("CreatePlayer", [0x4000, 0, event, 0, 0, 0])).toBe(DP.OK); return read(0x4000);
}
function receive(out = 0x10000, capacity = 4096, flags = 1) {
    u32(0x4100, capacity); return call("Receive", [0x4104, 0x4108, flags, out, 0x4100]);
}
function drain(): void { for (let n = 0; n < 20 && receive() === DP.OK; n++) {} }
beforeEach(() => {
    mem = new Uint8Array(2 * 1024 * 1024); allocated = 0x100000; objects = []; callbacks = []; saved = []; freed = []; events = [];
    const alloc = (size: number): number => { const ptr = allocated; allocated += (size + 15) & ~15; return ptr; };
    process = {
        getCurrentMemory: () => mem,
        memory: { alloc, allocSystemBlock: alloc, free: (p: number) => freed.push(p), freeSystemBlock() {} },
        addressSpace: { validateRange: (p: number, size: number, perms: string) => p >= 0x1000 && p + size <= mem.length && (!perms.includes("x") || (p >= 0x7000 && p < 0x8000)) },
        dispatcher: { callbackManager: {
            saveSuspendedThunkContext: (frame: unknown, cleanup: number) => { saved.push([frame, cleanup]); return 7; },
            abandonSuspendedFrame() {},
            invokeCallback: (_target: number, args: number[], _cleanup: number, done: (value: number) => number | null) => {
                callbacks.push({ args, done }); return { callbackId: callbacks.length };
            },
            getPendingCallback: (id: number) => callbacks[id - 1],
        } },
    } as unknown as Process;
    system.process = process; originalSetEvent = system.scheduler.setEvent;
    system.scheduler.setEvent = (handle: number) => { events.push(handle); return true; };
    Mem.bind(() => mem);
    const tables = Object.fromEntries((dplayxModule.interfaces ?? []).map((iface, i) => [iface.name, { address: 0x6000 + i * 0x100, size: iface.methods.length }])) as Record<string, VTableInfo>;
    for (const iface of dplayxModule.interfaces ?? []) if (iface.iid) ComObjectFactory.register(iface.iid, TestCom);
    api = new DirectPlayNetworkApi(process, () => tables, new LanNetwork(new Uint8Array([2, 0, 0, 0, 0, 1])));
    exports = {}; api.install(exports); primary = object(); u32(0x9000, 0x7000);
});
afterEach(() => {
    api.reset(); for (const obj of objects) resource.unregisterComObject(obj.handle);
    system.process = originalProcess; system.scheduler.setEvent = originalSetEvent;
});
test("native ANSI interface shapes and synchronous error contracts", () => {
    expect(IDirectPlay.methods.length).toBe(25); expect(IDirectPlay2A.methods.length).toBe(32);
    expect(IDirectPlay3A.methods.length).toBe(45); expect(IDirectPlay4A.methods.length).toBe(53);
    expect(call("Send", [1, 2, 0, 0, 0])).toBe(DP.UNINITIALIZED);
    expect(call("Receive", [0, 0, 0, 0, 0])).toBe(DP.UNINITIALIZED);
    expect(call("Initialize", [0])).toBe(DP.ALREADYINITIALIZED);
    initialize(); expect(call("Initialize", [0x2000])).toBe(DP.ALREADYINITIALIZED);
    expect(receive(0x10000, 0, 0)).toBe(DP.NOMESSAGES);
    expect(call("CreatePlayer", [0, 0, 0, 0, 0, 0])).toBe(DP.NOSESSIONS);
});
test("per-object sessions and QueryInterface tear-offs preserve COM identity with distinct ABI vtables", () => {
    initialize(); const first = primary, second = object(); primary = second;
    expect(call("GetMessageCount", [0, 0x4000])).toBe(DP.UNINITIALIZED); primary = first;
    bytes(0x2100, "80".repeat(16)); expect(call("QueryInterface", [0x2100, 0x2200])).toBe(0x80004002); expect(read(0x2200)).toBe(0);
    bytes(0x2100, "8005469d22a8cf11960c0080c7534e82");
    expect(call("QueryInterface", [0x2100, 0x2200])).toBe(DP.OK);
    const dp2 = read(0x2200); expect(dp2).not.toBe(first); expect(resource.getComObjectByAddress(dp2)?.handle).toBe(resource.getComObjectByAddress(first)?.handle);
    expect(read(dp2)).not.toBe(read(first));
    primary = dp2; expect(call("GetMessageCount", [0, 0x4000], "IDirectPlay2A")).toBe(DP.OK);
    bytes(0x2100, "0000000000000000c000000000000046");
    expect(call("QueryInterface", [0x2100, 0x2200], "IDirectPlay2A")).toBe(DP.OK); expect(read(0x2200)).toBe(first);
});
test("Receive validates full output extents, preserves short-buffer and PEEK queues and signals player event", async () => {
    open(); const a = await create(123), b = await create(456); drain(); events.length = 0;
    mem.set([10, 20, 30], 0x5000);
    expect(call("Send", [a, b, 1, 0x5000, 3])).toBe(DP.OK); expect(events).toEqual([456]);
    expect(receive(0, 0)).toBe(DP.BUFFERTOOSMALL); expect(read(0x4100)).toBe(3);
    expect(receive(0x10000, 3, 1 | 8)).toBe(DP.OK); expect([...mem.slice(0x10000, 0x10003)]).toEqual([10, 20, 30]);
    expect(read(0x4104)).toBe(a); expect(read(0x4108)).toBe(b);
    expect(receive(mem.length - 1, 3)).toBe(0x80004003);
    expect(receive(0x10000, 3)).toBe(DP.OK); expect(receive()).toBe(DP.NOMESSAGES);
    expect(call("Receive", [0, 0, 2, 0x10000, 0x4100])).toBe(0x80004003);
    expect(receive(0x10000, 3, 1 | 2)).toBe(DP.INVALIDFLAGS);
});
test("GetSessionDesc and GetPlayerName relocate embedded pointers into the caller buffer", async () => {
    open(); const a = await create();
    u32(0x5000, 16); u32(0x5008, 0x5100); u32(0x500c, 0x5100);
    expect(await call("SetPlayerName", [a, 0x5000, 0])).toBe(DP.OK);
    u32(0x3030, 0x5100); u32(0x3034, 0x5100); expect(call("SetSessionDesc", [0x3000, 0])).toBe(DP.OK);
    u32(0x4200, 0);
    expect(call("GetSessionDesc", [0, 0x4200])).toBe(DP.BUFFERTOOSMALL); expect(read(0x4200)).toBe(82);
    u32(0x4200, 82); expect(call("GetSessionDesc", [0x10000, 0x4200])).toBe(DP.OK);
    expect(read(0x10030)).toBe(0x10050); expect(read(0x10034)).toBe(0x10051);
    u32(0x4200, 100); expect(call("GetPlayerName", [a, 0x10000, 0x4200])).toBe(DP.OK);
    expect(read(0x10000)).toBe(16); expect(read(0x10008)).toBe(0x10010); expect(read(0x1000c)).toBe(0x10011);
    expect(call("GetPlayerName", [0xdead, 0x10000, 0x4200])).toBe(DP.INVALIDPLAYER);
});
test("system message native layout includes in-buffer names and remote data pointers", () => {
    const packed = packDirectPlayMessage({ from: 0, to: 1, data: new Uint8Array(), system: { type: 3, entity: {
        id: 2, group: false, owner: "peer", flags: 0, name: { short: "Bob", long: "Long" }, data: [7, 8], members: [], parent: 0, groupOwner: 0,
    } } }, 0x20000, 2);
    const v = new DataView(packed.buffer);
    expect(v.getUint32(0, true)).toBe(3); expect(v.getUint32(4, true)).toBe(1); expect(v.getUint32(8, true)).toBe(2);
    expect(v.getUint32(16, true)).toBe(0x20030); expect(v.getUint32(20, true)).toBe(2); expect(v.getUint32(24, true)).toBe(16);
    expect(v.getUint32(32, true)).toBe(0x20032); expect(v.getUint32(36, true)).toBe(0x20036);
});
test("remote CreatePlayer returns deferred writes and cannot touch another active process memory", async () => {
    initialize();
    const state = [...(api as unknown as { states: Map<number, { session: DirectPlaySession }> }).states.values()][0];
    const hostNet = new LanNetwork(new Uint8Array([2, 0, 0, 0, 0, 2])), clientNet = state.session.network;
    const route = (source: LanNetwork, target: LanNetwork) => ({
        send: (frame: Uint8Array) => {
            const p = decodeDatagram(frame)!;
            if (isBroadcastNode(p.node) || target.isSelf(p.node)) queueMicrotask(() => target.receiveFrame(encodeDatagram(p.proto, source.node, p.dstPort, p.srcPort, p.payload)));
            return true;
        }, close() {},
    });
    clientNet.attach(route(clientNet, hostNet)); hostNet.attach(route(hostNet, clientNet));
    const host = new DirectPlaySession(hostNet);
    try {
        expect(host.initialize()).toBe(DP.OK);
        expect(host.create({ instance: "0".repeat(32), application: "1".repeat(32), flags: 0, maxPlayers: 8, name: "room", password: "", user: [0, 0, 0, 0] })).toBe(DP.OK);
        state.session.discover(host.desc!.application); await Bun.sleep(1); expect(await state.session.join(host.desc!)).toBe(DP.OK);
        u32(0x4000, 0xfeed);
        const pending = call("CreatePlayer", [0x4000, 0, 0, 0, 0, 0]);
        const foreign = new Uint8Array(mem.length); new DataView(foreign.buffer).setUint32(0x4000, 0xbeef, true);
        Mem.bind(() => foreign);
        const result = await pending as ThunkResult;
        expect(result.value).toBe(DP.OK); expect(read(0x4000)).toBe(0xfeed);
        expect(new DataView(foreign.buffer).getUint32(0x4000, true)).toBe(0xbeef);
        expect(result.deferredWrites).toEqual([{ address: 0x4000, value: 1, size: 4 }]);
    } finally { Mem.bind(() => mem); host.dispose(); }
});
test("InitializeConnection owns the complete bounded address regardless of element order", () => {
    const totalGuid = "60f518132c91d0119daa00a0c90a43cb";
    const providerGuid = "c016d907afe0cf119c4e00a0c905425e";
    const inetGuid = "a04da5c4afe0cf119c4e00a0c905425e";
    const portGuid = "414552e4a58ed1118a96006097b01411";
    const provider = "e05ee9367785cf11960c0080c7534e82";
    const elements = [
        {guid:providerGuid, data:Uint8Array.from(provider.match(/../g)!, x=>parseInt(x,16))},
        {guid:inetGuid, data:new TextEncoder().encode("192.0.2.42\0")},
        {guid:portGuid, data:Uint8Array.of(0x18,0xba)},
    ];
    const write = (base:number, order:number[]) => {
        const length=24+order.reduce((sum,i)=>sum+20+elements[i].data.length,0);
        bytes(base,totalGuid); u32(base+16,4); u32(base+20,length);
        let p=base+24;
        for(const i of order) { const e=elements[i]; bytes(p,e.guid); u32(p+16,e.data.length); mem.set(e.data,p+20); p+=20+e.data.length; }
        return mem.slice(base,base+length);
    };
    const first=write(0x2000,[0,1,2]);
    expect(call("InitializeConnection",[0x2000,0])).toBe(DP.OK);
    const firstSession=(api as any).state(primary).session as DirectPlaySession;
    mem.fill(0x99,0x2000,0x2000+first.length);
    const copy=firstSession.getConnectionAddress()!;
    expect(copy.provider).toBe(provider); expect(copy.bytes).toEqual(first);
    copy.bytes.fill(0);
    expect(firstSession.getConnectionAddress()!.bytes).toEqual(first);
    const replacement=write(0x3000,[2,1,0]);
    expect(call("InitializeConnection",[0x3000,0])).toBe(DP.ALREADYINITIALIZED);
    expect(firstSession.getConnectionAddress()!.bytes).toEqual(first);
    primary=object();
    expect(call("InitializeConnection",[0x3000,0])).toBe(DP.OK);
    const secondSession=(api as any).state(primary).session as DirectPlaySession;
    expect(secondSession.getConnectionAddress()!.bytes).toEqual(replacement);
    api.reset();
    expect(firstSession.getConnectionAddress()).toBeUndefined();
    expect(secondSession.getConnectionAddress()).toBeUndefined();
});
test("EnumConnections returns the 80-byte source ADDRESSHEADER accepted by InitializeConnection",()=>{
    const result=call("EnumConnections",[0,0x7000,0x1234,0]) as ThunkResult;
    expect(result.suspendedForCallback).toBe(true);
    const [provider, address, size, name, flags, context]=callbacks[0].args;
    expect([provider,address+44,size,name,flags,context]).toEqual([address+44,address+44,80,address+80,1,0x1234]);
    const hex=(value:Uint8Array)=>[...value].map(n=>n.toString(16).padStart(2,"0")).join("");
    expect(hex(mem.slice(address,address+16))).toBe("60f518132c91d0119daa00a0c90a43cb");
    expect(read(address+16)).toBe(4); expect(read(address+20)).toBe(80);
    expect(hex(mem.slice(address+24,address+40))).toBe("c016d907afe0cf119c4e00a0c905425e");
    expect(read(address+40)).toBe(16);
    expect(hex(mem.slice(address+44,address+60))).toBe("e05ee9367785cf11960c0080c7534e82");
    expect([...mem.slice(address+60,address+80)]).toEqual(Array(20).fill(0));
    const owned=mem.slice(address,address+80);
    expect(call("InitializeConnection",[address,0])).toBe(DP.OK);
    expect(((api as any).state(primary).session as DirectPlaySession).getConnectionAddress()!.bytes).toEqual(owned);
    expect(callbacks[0].done?.(0)).toBe(DP.OK);
});
test("InitializeConnection rejects an address without its size header or service provider",()=>{
    bytes(0x2000,"c016d907afe0cf119c4e00a0c905425e");u32(0x2010,16);
    bytes(0x2014,"e05ee9367785cf11960c0080c7534e82");
    expect(call("InitializeConnection",[0x2000,1])).toBe(DP.INVALIDPARAMS);
    bytes(0x2000,"60f518132c91d0119daa00a0c90a43cb");u32(0x2010,4);u32(0x2014,24);
    expect(call("InitializeConnection",[0x2000,0])).toBe(DP.INVALIDPARAMS);
});
test("InitializeConnection checks object and address before flags",()=>{
    expect(call("InitializeConnection",[0,1])).toBe(DP.INVALIDPARAMS);
    const base=0x2000;
    bytes(base,"60f518132c91d0119daa00a0c90a43cb");u32(base+16,4);u32(base+20,0x100000);
    expect(call("InitializeConnection",[base,1])).toBe(DP.INVALIDPARAMS);
    u32(base+20,60);
    bytes(base+24,"c016d907afe0cf119c4e00a0c905425e");u32(base+40,16);
    bytes(base+44,"e05ee9367785cf11960c0080c7534e82");
    expect(call("InitializeConnection",[base,1])).toBe(DP.INVALIDFLAGS);
    expect(call("InitializeConnection",[base,0])).toBe(DP.OK);
    expect(call("InitializeConnection",[0,1])).toBe(DP.ALREADYINITIALIZED);
});
test("InitializeConnection follows native tail-byte and malformed SP observations",()=>{
    // Oracle dp4-address-oracle-20261028-second: tail-byte INIT 0,
    // tail-before-sp INIT INVALIDPARAMS.
    const base=0x2000;
    bytes(base,"60f518132c91d0119daa00a0c90a43cb");u32(base+16,4);u32(base+20,91);
    bytes(base+24,"c016d907afe0cf119c4e00a0c905425e");u32(base+40,0x1000);
    bytes(base+44,"e05ee9367785cf11960c0080c7534e82");
    bytes(base+60,"a04da5c4afe0cf119c4e00a0c905425e");u32(base+76,10);
    bytes(base+80,"3132372e302e302e3100");mem[base+90]=0xa5;
    expect(call("InitializeConnection",[base,0])).toBe(DP.INVALIDPARAMS);
    expect(((api as any).state(primary).session as DirectPlaySession).getConnectionAddress()).toBeUndefined();
    u32(base+40,16);
    const owned=mem.slice(base,base+91);
    expect(call("InitializeConnection",[base,0])).toBe(DP.OK);
    expect(((api as any).state(primary).session as DirectPlaySession).getConnectionAddress()!.bytes).toEqual(owned);
});
test("a LobbyProvider wins the NT5 first pass even when a supported SP comes first",()=>{
    const base=0x2000;
    bytes(base,"60f518132c91d0119daa00a0c90a43cb");u32(base+16,4);u32(base+20,96);
    bytes(base+24,"c016d907afe0cf119c4e00a0c905425e");u32(base+40,16);
    bytes(base+44,"e05ee9367785cf11960c0080c7534e82");
    bytes(base+60,"4056b9596796d011a77d0000f803abfc");u32(base+76,16);
    bytes(base+80,"0102030405060708090a0b0c0d0e0f10");
    // Lobby loading is not implemented, so report unavailable and do not use SP.
    expect(call("InitializeConnection",[base,0])).toBe(DP.UNAVAILABLE);
    expect(((api as any).state(primary).session as DirectPlaySession).getConnectionAddress()).toBeUndefined();
});

function nativeDiscoveryFixture() {
    api.reset();
    const network=new LanNetwork(Uint8Array.of(2,0,0,1,2,3)), sent: Uint8Array[]=[];
    let open!: (lease: any)=>void, releases=0, isLive=true;
    let ended!: (error:{code:number;message:string})=>void;
    const closed=new Promise<{code:number;message:string}>(ok=>{ended=ok;});
    const allowed=[[2,1,127,0,0,1]];
    const lease={address:{node:allowed[0],port:2309},allowedNodes:allowed,isLive:()=>isLive,closed,
        release(){if(isLive){isLive=false;releases++;ended({code:10054,message:"closed"});}}};
    network.attach({connected:true,send(frame){sent.push(frame.slice());return true;},close(){},
        openTcpHost(){return new Promise(ok=>{open=ok;});}});
    network.configureGatewayAddresses([[192,0,2,1]]);
    network.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    network.configureWinsock({provider:"native",hostListener:"game"});
    const table=new WsaSocketTable(network);
    const tables=(api as any).tables as () => Record<string,VTableInfo>;
    api=new DirectPlayNetworkApi(process,tables,network,()=>table);exports={};api.install(exports);
    const base=0x2000;
    bytes(base,"60f518132c91d0119daa00a0c90a43cb");u32(base+16,4);u32(base+20,90);
    bytes(base+24,"c016d907afe0cf119c4e00a0c905425e");u32(base+40,16);
    bytes(base+44,"e05ee9367785cf11960c0080c7534e82");
    bytes(base+60,"a04da5c4afe0cf119c4e00a0c905425e");u32(base+76,10);
    bytes(base+80,"3139322e302e322e3100");
    expect(call("InitializeConnection",[base,0])).toBe(DP.OK);
    u32(0x3000,80); bytes(0x3018,"101112131415161718191a1b1c1d1e1f");
    const run=(flags=0)=>call("EnumSessions",[0x3000,60,0x7000,0,flags]) as Promise<ThunkResult>;
    return {network,table,sent,ready:()=>open(lease),releases:()=>releases,run};
}
const nativeReply=Uint8Array.from(Buffer.from(
    "7600b0fa020008fcc00002010000000000000000"+
    "706c617901000b005000000000200000000102030405060708090a0b0c0d0e0f"+
    "101112131415161718191a1b1c1d1e1f08000000030000000000000000000000"+
    "0403020188776655010000000200000003000000040000005c000000410016040000","hex"));
async function discoveryTick(){await new Promise(resolve=>setTimeout(resolve,5));}
test("native EnumSessions uses READY, native reply and normal timeout callback chain",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run();expect(f.sent).toHaveLength(0);
        f.ready();await discoveryTick();
        const udp=f.sent.map(decodeDatagram).find(d=>d?.proto===PROTO_UDP);
        expect(udp?.dstPort).toBe(47624);
        expect(f.sent.map(decodeDatagram).some(d=>d?.proto===PROTO_DIRECTPLAY)).toBe(false);
        const port=f.table.get(0x10000000).local!.port, source=Uint8Array.of(2,1,127,0,0,1);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
        await discoveryTick();
        const child=f.table.get(0x10000003);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(DATA,88,child.wireId,0,nativeReply)));
        const result=await pending;expect(result.value).toBe(DP.OK);
        expect(result.startCallbackChain!({esp:0x9000} as never)).toBe(true);
        expect(callbacks).toHaveLength(1);
        const record=callbacks[0].args[0];
        expect(read(record+40)).toBe(8);expect(read(record+44)).toBe(3);
        expect(read(record+56)).toBe(0x01020304);expect(read(record+60)).toBe(0x55667788);
        expect(callbacks[0].done?.(1)).toBeNull();
        (callbacks[0] as any).enumerationState.continueEnumeration();
        expect(callbacks).toHaveLength(2);
        expect(callbacks[1].args[0]).toBe(0);
        expect(callbacks[1].args[2]).toBe(1);
        expect(callbacks[1].done?.(1)).toBe(DP.OK);
        const state=(api as any).state(primary).session as DirectPlaySession;
        const entry=[...state.discovered.values()][0];
        expect(entry.native).toBe(true);
        expect(entry.address).toEqual({node:[2,1,192,0,2,1],port:2300});
        expect(entry.nativeProvider?.version).toBe(11);
        expect([...entry.nativeProvider!.sockaddr.slice(4,8)]).toEqual([192,0,2,1]);
        expect([...entry.nativeProvider!.peer.ip!]).toEqual([127,0,0,1]);
        expect(entry.nativeProvider?.peer.port).toBe(4000);
        expect(await state.join(entry.desc)).toBe(DP.UNAVAILABLE);
        expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
});
test("native reply zero advertised IP is rehomed from the accepted peer, keeping host port",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run();f.ready();await discoveryTick();
        const port=f.table.get(0x10000000).local!.port, source=Uint8Array.of(2,1,127,0,0,1);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
        await discoveryTick();
        const child=f.table.get(0x10000003), frame=nativeReply.slice();
        frame.fill(0,8,12);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(DATA,88,child.wireId,0,frame)));
        frame.fill(0xff);source.fill(0xff);
        const result=await pending;expect(result.value).toBe(DP.OK);
        const session=(api as any).state(primary).session as DirectPlaySession, entry=[...session.discovered.values()][0];
        expect(entry.address).toEqual({node:[2,1,127,0,0,1],port:2300});
        expect([...entry.nativeProvider!.sockaddr.slice(4,8)]).toEqual([127,0,0,1]);
        expect(entry.nativeProvider?.version).toBe(11);
        session.dispose();expect(session.discovered.size).toBe(0);
        expect(result.startCallbackChain!({esp:0x9000} as never)).toBe(false);
        expect(callbacks).toHaveLength(0);
    } finally {f.table.reset();}
});
test("reentrant disconnect while routing a reply cannot replace a new virtual entry",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run();f.ready();await discoveryTick();
        const port=f.table.get(0x10000000).local!.port, source=Uint8Array.of(2,1,127,0,0,1);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
        await discoveryTick();
        const child=f.table.get(0x10000003);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(DATA,88,child.wireId,0,nativeReply)));
        const session=(api as any).state(primary).session as DirectPlaySession;
        const instance="000102030405060708090a0b0c0d0e0f";
        const virtual={desc:{instance,application:"1".repeat(32),flags:0,maxPlayers:8,name:"virtual",password:"",user:[0,0,0,0]},
            currentPlayers:1,address:{node:[2,0,0,0,0,1],port:1234},seen:Date.now()};
        const route=f.network.routeIpv4.bind(f.network);
        let routeCalls=0;
        f.network.routeIpv4=(ip:Uint8Array)=>{
            if (ip.join(".")==="192.0.2.1") {
                routeCalls++;
                f.network.setConnected(false,"injected reentrant disconnect");
                session.discovered.set(instance,virtual);
            }
            return route(ip);
        };
        const result=await pending;
        expect(routeCalls).toBe(1);
        expect(result.value).toBe(DP.SESSIONLOST);
        expect(session.discovered.get(instance)).toBe(virtual);
        expect([...session.discovered.values()].some(item=>item.native)).toBe(false);
        expect(result.startCallbackChain).toBeUndefined();
        expect(callbacks).toHaveLength(0);
    } finally {f.table.reset();}
});
test("native EnumSessions cancellation after READY prevents old result publication",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run();f.ready();await discoveryTick();
        expect(call("EnumSessions",[0,0,0,0,0x20])).toBe(DP.OK);
        expect((await pending).value).toBe(DP.SESSIONLOST);
        expect(((api as any).state(primary).session as DirectPlaySession).discovered.size).toBe(0);
        expect(f.releases()).toBe(1);
    } finally {f.table.reset();}
});
test("native default AVAILABLE filters disabled hosts before timeout callback",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run();f.ready();await discoveryTick();
        const port=f.table.get(0x10000000).local!.port, source=Uint8Array.of(2,1,127,0,0,1);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
        await discoveryTick();
        const child=f.table.get(0x10000003), disabled=nativeReply.slice();
        new DataView(disabled.buffer).setUint32(32,0x21,true);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(DATA,88,child.wireId,0,disabled)));
        const result=await pending;
        expect(result.startCallbackChain!({esp:0x9000} as never)).toBe(true);
        expect(callbacks).toHaveLength(1);
        expect(callbacks[0].args[0]).toBe(0);expect(callbacks[0].args[2]).toBe(1);
        expect(callbacks[0].done?.(1)).toBe(DP.OK);
    } finally {f.table.reset();}
});
test("native ALL takes precedence over AVAILABLE and application filter",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run(3);f.ready();await discoveryTick();
        const port=f.table.get(0x10000000).local!.port, source=Uint8Array.of(2,1,127,0,0,1);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
        await discoveryTick();
        const child=f.table.get(0x10000003), reply=nativeReply.slice();
        new DataView(reply.buffer).setUint32(32,0x21,true);
        reply[52]^=0xff;
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(DATA,88,child.wireId,0,reply)));
        const result=await pending;
        expect(result.startCallbackChain!({esp:0x9000} as never)).toBe(true);
        expect(callbacks[0].args[0]).not.toBe(0);
        expect(read(callbacks[0].args[0]+4)).toBe(0x21);
        expect(callbacks[0].done?.(0)).toBe(DP.OK);
    } finally {f.table.reset();}
});
test("COM disposal aborts the original native owner before object reuse",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run();f.ready();await discoveryTick();
        api.reset();
        expect((await pending).value).toBe(DP.SESSIONLOST);
        expect(f.releases()).toBe(1);
        primary=object();
        expect(call("InitializeConnection",[0x2000,0])).toBe(DP.OK);
        expect(((api as any).state(primary).session as DirectPlaySession).discovered.size).toBe(0);
    } finally {f.table.reset();}
});
test("stop after completion suppresses a not-yet-started callback chain",async()=>{
    const f=nativeDiscoveryFixture();
    try {
        const pending=f.run();f.ready();
        const result=await pending;
        expect(result.value).toBe(DP.OK);
        expect(call("EnumSessions",[0,0,0,0,0x20])).toBe(DP.OK);
        expect(result.startCallbackChain!({esp:0x9000} as never)).toBe(false);
        expect(callbacks).toHaveLength(0);
    } finally {f.table.reset();}
});
test("native unsupported async and missing endpoint never send virtual discovery",()=>{
    const f=nativeDiscoveryFixture();
    try {
        for (const flags of [0x10,0x40,0x80,0x41,0x82])
            expect(call("EnumSessions",[0x3000,60,0x7000,0,flags])).toBe(DP.UNAVAILABLE);
        expect(f.sent).toHaveLength(0);
    } finally {f.table.reset();}
});

test("native Lobby compound addresses validate element extents and round-trip through InitializeConnection", () => {
    bytes(0x2000, "c016d907afe0cf119c4e00a0c905425e");
    u32(0x2010, 16); u32(0x2014, 0x2100); bytes(0x2100, "e05ee9367785cf11960c0080c7534e82");
    u32(0x2200, 0);
    expect(call("CreateCompoundAddress", [0x2000, 1, 0, 0x2200], "IDirectPlayLobby3A")).toBe(DP.BUFFERTOOSMALL);
    expect(read(0x2200)).toBe(60);
    expect(call("CreateCompoundAddress", [0x2000, 1, 0x10000, 0x2200], "IDirectPlayLobby3A")).toBe(DP.OK);
    expect(read(0x10010)).toBe(4); expect(read(0x10014)).toBe(60);
    expect(call("InitializeConnection", [0x10000, 0])).toBe(DP.OK);
    expect(call("InitializeConnection", [0x10000, 1])).toBe(DP.ALREADYINITIALIZED);
    u32(0x2010, 0xfffffff0);
    expect(call("CreateCompoundAddress", [0x2000, 1, 0x10000, 0x2200], "IDirectPlayLobby3A")).toBe(DP.INVALIDPARAMS);
});
test("Lobby connection settings use the native five-argument ABI and own copied nested data", () => {
    expect((dplayxModule.interfaces ?? []).find(i => i.name === "IDirectPlayLobby3A")!.methods.find(m => m.name === "SetConnectionSettings")!.params.length).toBe(5);
    u32(0x3000, 80); u32(0x3028, 8); bytes(0x3018, "1".repeat(32));
    u32(0x2300, 40); u32(0x2304, 2); u32(0x2308, 0x3000);
    bytes(0x2310, "e05ee9367785cf11960c0080c7534e82");
    expect(call("SetConnectionSettings", [0, 0, 0x2300], "IDirectPlayLobby3A")).toBe(DP.OK);
    mem.fill(0, 0x2300, 0x2330); mem.fill(0, 0x3000, 0x3050);
    u32(0x2200, 0);
    expect(call("GetConnectionSettings", [0, 0, 0x2200], "IDirectPlayLobby3A")).toBe(DP.BUFFERTOOSMALL);
    expect(read(0x2200)).toBe(128);
    u32(0x2200, 160); mem.fill(0xcc, 0x10078, 0x10080);
    expect(call("GetConnectionSettings", [0, 0x10000, 0x2200], "IDirectPlayLobby3A")).toBe(DP.OK);
    expect(read(0x2200)).toBe(160); expect([...mem.slice(0x10078, 0x10080)]).toEqual(new Array(8).fill(0xcc));
    expect(read(0x10000)).toBe(40); expect(read(0x10004)).toBe(2); expect(read(0x10008)).toBe(0x10028);
    expect(read(0x10028)).toBe(80); expect(read(0x10050)).toBe(8);
});
test("synchronous discovery defers all guest callbacks until safe owner-thread continuation", async () => {
    initialize(); u32(0x3000, 80); bytes(0x3018, "1".repeat(32));
    const pending = call("EnumSessions", [0x3000, 1, 0x7000, 0x1234, 2]);
    expect(pending instanceof Promise).toBe(true); const result = await pending as ThunkResult;
    expect(callbacks).toEqual([]); expect(saved).toEqual([]);
    expect(result.startCallbackChain?.({ esp: 0x9000, returnAddr: 0x7111, mem })).toBe(true);
    expect(saved).toEqual([[{ esp: 0x9000, returnAddr: 0x7111, mem }, 24]]);
    expect(callbacks[0].args[0]).toBe(0); expect(callbacks[0].args[2]).toBe(1); expect(callbacks[0].args[3]).toBe(0x1234);
    expect(callbacks[0].done?.(0)).toBe(DP.OK); expect(freed.length).toBe(1);
});
test("enumeration callback false stops and releases frame storage, player filtering uses native callback signature", async () => {
    open(); const a = await create(), b = await create();
    const result = call("EnumPlayers", [0, 0x7000, 0x8765, 8]) as ThunkResult;
    expect(result.suspendedForCallback).toBe(true); expect(result.skipStackCheck).toBe(true); expect(result.stackCleanup).toBe(20);
    expect(callbacks[0].args.slice(0, 2)).toEqual([a, 1]); expect(callbacks[0].args[3] & 8).toBe(8); expect(callbacks[0].args[4]).toBe(0x8765);
    expect(callbacks[0].done?.(0)).toBe(DP.OK); expect(callbacks.length).toBe(1); expect(freed.length).toBe(1);
    expect(a).not.toBe(b);
});

function wide(ptr: number, text: string): void {
    const view = new DataView(mem.buffer);
    for (let i = 0; i <= text.length; i++) view.setUint16(ptr + i * 2, text.charCodeAt(i) || 0, true);
}
function readWide(ptr: number): string {
    let text = "", value: number; const view = new DataView(mem.buffer);
    while ((value = view.getUint16(ptr, true))) { text += String.fromCharCode(value); ptr += 2; }
    return text;
}
test("Unicode DP2/3/4 preserve UTF-16 names and session strings through ANSI QueryInterface", async () => {
    initialize(); u32(0x3000, 80); u32(0x3028, 8); bytes(0x3018, "1".repeat(32));
    wide(0x5000, "Комната漢字🙂"); u32(0x3030, 0x5000);
    expect(call("Open", [0x3000, 2], "IDirectPlay4")).toBe(DP.OK);
    u32(0x5100, 16); u32(0x5108, 0x5200); u32(0x510c, 0x5300);
    wide(0x5200, "Игрок漢🙂"); wide(0x5300, "Полное имя");
    expect(await call("CreatePlayer", [0x4000, 0x5100, 0, 0, 0, 0], "IDirectPlay3")).toBe(DP.OK);
    const id = read(0x4000);
    u32(0x4200, 1024); expect(call("GetPlayerName", [id, 0x10000, 0x4200], "IDirectPlay2")).toBe(DP.OK);
    expect(readWide(read(0x10008))).toBe("Игрок漢🙂"); expect(readWide(read(0x1000c))).toBe("Полное имя");
    u32(0x4200, 1024); expect(call("GetSessionDesc", [0x11000, 0x4200], "IDirectPlay4")).toBe(DP.OK);
    expect(readWide(read(0x11030))).toBe("Комната漢字🙂");
    bytes(0x2100, "31c5b10a4547d111a7a10000f803abfc");
    expect(call("QueryInterface", [0x2100, 0x2200], "IDirectPlay4")).toBe(DP.OK);
    primary = read(0x2200); u32(0x4200, 1024);
    expect(call("GetPlayerName", [id, 0x10000, 0x4200])).toBe(DP.OK);
    expect(mem[read(0x10008)]).not.toBe(0); // ANSI transcodes from the same canonical Unicode name.
});
test("Unicode system messages and Lobby settings use WCHAR lengths, not ANSI byte counts", () => {
    const entity = { id: 2, group: false, owner: "peer", flags: 0, name: { short: "漢🙂", long: "Тест" }, data: [], members: [], parent: 0, groupOwner: 0 };
    const packed = packDirectPlayMessage({ from: 0, to: 1, data: new Uint8Array(), system: { type: 3, entity } }, 0x20000, 2, true);
    mem.set(packed, 0x20000); expect(readWide(read(0x20020))).toBe("漢🙂"); expect(readWide(read(0x20024))).toBe("Тест");
    u32(0x3000, 80); u32(0x3028, 8); bytes(0x3018, "1".repeat(32)); u32(0x3030, 0x5000); wide(0x5000, "名🙂");
    u32(0x2300, 40); u32(0x2304, 2); u32(0x2308, 0x3000); bytes(0x2310, "e05ee9367785cf11960c0080c7534e82");
    expect(call("SetConnectionSettings", [0, 0, 0x2300], "IDirectPlayLobby3")).toBe(DP.OK);
    u32(0x2200, 1024);
    expect(call("GetConnectionSettings", [0, 0x10000, 0x2200], "IDirectPlayLobby2")).toBe(DP.OK);
    expect(readWide(read(read(0x10008) + 48))).toBe("名🙂");
});
test("SendEx asynchronous completion, priority, cancellation and native completion message layout", async () => {
    open(); const a = await create(), b = await create(); drain();
    mem.set([1], 0x5000); mem.set([2], 0x5001);
    expect(call("SendEx", [a, b, 0x201, 0x5000, 1, 1, 0, 0x1234, 0x4300])).toBe(DP.PENDING);
    const low = read(0x4300);
    expect(call("SendEx", [a, b, 0x201, 0x5001, 1, 10, 0, 0x5678, 0x4300])).toBe(DP.PENDING);
    const high = read(0x4300); expect(high).not.toBe(low);
    await Bun.sleep(5);
    u32(0x4108, b); expect(receive(0x10000, 4096, 2)).toBe(DP.OK); expect(mem[0x10000]).toBe(2);
    u32(0x4108, b); expect(receive(0x10000, 4096, 2)).toBe(DP.OK); expect(mem[0x10000]).toBe(1);
    u32(0x4108, a); expect(receive(0x10000, 4096, 2)).toBe(DP.OK);
    expect(read(0x10000)).toBe(0x10d); expect(read(0x10018)).toBe(0x5678); expect(read(0x1001c)).toBe(high); expect(read(0x10020)).toBe(DP.OK);
    drain();
    expect(call("SendEx", [a, b, 0x201, 0x5000, 1, 0, 0, 0, 0x4300])).toBe(DP.PENDING);
    expect(call("CancelMessage", [read(0x4300), 0])).toBe(DP.OK);
    expect(receive()).toBe(DP.OK); expect(read(0x10020)).toBe(DP.CANCELLED);
    expect(call("CancelMessage", [0xdead, 0])).toBe(DP.UNKNOWNMESSAGE);
    expect(call("CancelPriority", [10, 1, 0])).toBe(DP.INVALIDPARAMS);
    expect(call("SendEx", [a, b, 0x200, 0x5000, 1, 0x10000, 0, 0, 0x4300])).toBe(DP.INVALIDPRIORITY);
});
test("native service-provider-specific rejections and implemented spectator/server/group filters", async () => {
    expect(call("SaveSession", [0], "IDirectPlay")).toBe(DP.UNSUPPORTED);
    open(); await create();
    expect(call("GetPlayerAccount", [0xdead, 0, 0, 0])).toBe(DP.UNSUPPORTED);
    expect(call("GetGroupConnectionSettings", [0, 1, 0, 0])).toBe(DP.UNSUPPORTED);
    expect(call("SetGroupConnectionSettings", [0, 1, 0])).toBe(DP.UNSUPPORTED);
    expect(call("StartSession", [0, 1])).toBe(DP.UNSUPPORTED);
    expect(await call("CreatePlayer", [0x4000, 0, 0, 0, 0, 0x200])).toBe(DP.OK); const spectator = read(0x4000);
    const result = call("EnumPlayers", [0, 0x7000, 0, 0x200]) as ThunkResult;
    expect(result.suspendedForCallback).toBe(true); expect(callbacks[0].args[0]).toBe(spectator);
    expect(callbacks[0].args[3] & 0x200).toBe(0x200); callbacks[0].done?.(0);
});

test("remote Lobby settings are copied only at the safe owner-thread continuation", async () => {
    const { ProcessIpc } = await import("../../src/worker/core/process-ipc");
    const { DirectPlayLobbyEndpoint } = await import("../../src/worker/modules/dplayx/lobby-broker");
    const rootIpc = new ProcessIpc(1234), childIpc = new ProcessIpc(5600, 1234), ports = new MessageChannel();
    rootIpc.connectChild(5600, ports.port1); childIpc.adoptParent(ports.port2);
    const root = new DirectPlayLobbyEndpoint(rootIpc), child = new DirectPlayLobbyEndpoint(childIpc);
    try {
        await root.call({ op: "launch", pid: 5600, settings: { desc: { application: "1".repeat(32), instance: "2".repeat(32),
            name: "Лан", password: "", flags: 0, maxPlayers: 8, user: [0, 0, 0, 0] },
            create: true, player: null, provider: "e05ee9367785cf11960c0080c7534e82", address: new Uint8Array([9]) } });
        (api as unknown as { lobbyEndpoint: unknown }).lobbyEndpoint = child;
        u32(0x2200, 1024);
        const pending = call("GetConnectionSettings", [0, 0x10000, 0x2200], "IDirectPlayLobby3");
        expect(pending).toBeInstanceOf(Promise);
        const owner = mem, foreign = new Uint8Array(mem.length); Mem.bind(() => foreign);
        const result = await pending as ThunkResult;
        expect(result.value).toBe(DP.OK);
        expect(owner[0x10000]).toBe(0); expect(foreign[0x10000]).toBe(0);
        Mem.bind(() => owner);
        result.startCallbackChain?.({ esp: 0x9000, returnAddr: 0x7000, mem: owner });
        expect(read(0x10000)).toBe(40); expect(read(0x10008)).toBe(0x10028);
        expect(owner[read(0x10020)]).toBe(9);
    } finally { child.close(); root.close(); childIpc.close(); rootIpc.close(); Mem.bind(() => mem); }
});

test("Lobby retains event handles, delivers queued settings notifications and releases its alias", async () => {
    const { ProcessIpc } = await import("../../src/worker/core/process-ipc");
    const { DirectPlayLobbyEndpoint } = await import("../../src/worker/modules/dplayx/lobby-broker");
    const rootIpc = new ProcessIpc(1234), childIpc = new ProcessIpc(5700, 1234), ports = new MessageChannel();
    rootIpc.connectChild(5700, ports.port1); childIpc.adoptParent(ports.port2);
    const root = new DirectPlayLobbyEndpoint(rootIpc), child = new DirectPlayLobbyEndpoint(childIpc);
    const handle = system.scheduler.createEvent(false, false), preservedSetEvent = system.scheduler.setEvent;
    try {
        (api as unknown as { lobbyEndpoint: unknown }).lobbyEndpoint = root;
        root.onMessage = game => {
            const callbacks = (api as unknown as { lobbyEvents: Map<number, Map<number, number>> }).lobbyEvents;
            for (const events of callbacks.values()) { const alias = events.get(game); if (alias) system.scheduler.setEvent(alias); }
        };
        await root.call({ op: "launch", pid: 5700, settings: { desc: { application: "1".repeat(32), instance: "2".repeat(32),
            name: "", password: "", flags: 0, maxPlayers: 8, user: [0, 0, 0, 0] },
            create: true, player: null, provider: "e05ee9367785cf11960c0080c7534e82", address: new Uint8Array() } });
        expect(call("SetLobbyMessageEvent", [0, 5700, handle], "IDirectPlayLobby3A")).toBe(DP.OK);
        const retained = [...(api as unknown as { lobbyOwnedEvents: Set<number> }).lobbyOwnedEvents][0];
        expect(retained).not.toBe(handle);
        system.scheduler.syncObjects.closeEvent(handle);
        events.length = 0;
        await child.call({ op: "read" });
        await new Promise(resolve => setTimeout(resolve, 4));
        expect(events).toEqual([retained]); expect(resource.getKernelObject(retained)?.kind).toBe("event");
        expect(call("SetLobbyMessageEvent", [0, 5700, 0], "IDirectPlayLobby2A")).toBe(DP.OK);
        expect(resource.getKernelObject(retained)).toBeNull();
    } finally { system.scheduler.setEvent = preservedSetEvent; child.close(); root.close(); childIpc.close(); rootIpc.close(); }
});
test("Lobby Unicode registration validates the native descriptor and unregisters by GUID", () => {
    const writeWide = (ptr: number, value: string) => { for (let i = 0; i <= value.length; i++) new DataView(mem.buffer).setUint16(ptr + i * 2, i < value.length ? value.charCodeAt(i) : 0, true); };
    writeWide(0x5000, "テスト"); writeWide(0x5100, "game.exe"); writeWide(0x5200, "C:\\Games");
    u32(0x6000, 52); u32(0x6008, 0x5000); bytes(0x600c, "12".repeat(16)); u32(0x601c, 0x5100); u32(0x6024, 0x5200);
    expect(call("RegisterApplication", [1, 0x6000], "IDirectPlayLobby3")).toBe(DP.INVALIDFLAGS);
    expect(call("RegisterApplication", [0, 0x6000], "IDirectPlayLobby3")).toBe(DP.OK);
    const path = "Software\\Microsoft\\DirectPlay\\Applications\\テスト", key = system.registry.open("hklm", path)!;
    expect(system.registry.getValue(key, "File")?.data).toBe("game.exe");
    expect(system.registry.getValue(key, "Path")?.data).toBe("C:\\Games");
    expect(call("UnregisterApplication", [0, 0x600c], "IDirectPlayLobby3A")).toBe(DP.OK);
    expect(system.registry.open("hklm", path)).toBeNull();
});

test("RunApplication publishes settings before worker boot, defers the PID output, and reports the child's exit", async () => {
    const { VirtualFileSystem } = await import("../../src/worker/runtime/filesystem/vfs");
    const { stopChildProcesses } = await import("../../src/worker/core/child-process");
    const { closeProcessNetworkNamespace } = await import("../../src/worker/core/process-network");
    const { ProcessIpc } = await import("../../src/worker/core/process-ipc");
    const { DirectPlayLobbyEndpoint } = await import("../../src/worker/modules/dplayx/lobby-broker");
    const savedVfs = system.fileSystem, workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker"), NativeWorker = globalThis.Worker;
    const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, "self");
    let child: DirectPlayLobbyEndpoint | undefined, bootSettings: Promise<unknown> | undefined;
    let worker: { boot?: { processIdentity: { pid: number } }; onmessage?: (event: { data: unknown }) => void } | undefined;
    const vfs = new VirtualFileSystem(), image = new Uint8Array(0x6000), header = new DataView(image.buffer);
    header.setUint16(0, 0x5a4d, true); header.setUint32(0x3c, 0x5000, true);
    header.setUint32(0x5000, 0x4550, true); header.setUint16(0x5004, 0x14c, true);
    const entry = { name: "rom/game.exe", uncompressedSize: image.length, compressedSize: image.length, compression: 0, localHeaderOffset: 0, isDirectory: false };
    vfs.mountRom({ readEntryRangeSync: (_entry: unknown, offset: number, length: number) => image.slice(offset, offset + length),
        readEntryRange: async (_entry: unknown, offset: number, length: number) => image.slice(offset, offset + length) } as never, "rom", new Map([["game.exe", entry]]) as never);
    class WorkerBoundary {
        onmessage?: (event: { data: unknown }) => void;
        onerror?: unknown;
        onmessageerror?: unknown;
        boot?: { processIdentity: { pid: number } };
        constructor(url: string | URL, options?: WorkerOptions) {
            if (String(url) !== "file:///guest-worker.js") return new NativeWorker(url, options) as unknown as WorkerBoundary;
            worker = this;
        }
        postMessage(message: { type: string; processIdentity: { pid: number; rootPid: number }; ipcPort: MessagePort }) {
            if (message.type !== "child_boot") return;
            this.boot = message;
            const ipc = new ProcessIpc(message.processIdentity.pid, message.processIdentity.rootPid);
            ipc.adoptParent(message.ipcPort); child = new DirectPlayLobbyEndpoint(ipc);
            bootSettings = Promise.resolve(child.call({ op: "get" }));
        }
        terminate() { child?.ipc.close(); }
    }
    try {
        system.fileSystem = vfs;
        Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: WorkerBoundary });
        Object.defineProperty(globalThis, "self", { configurable: true, writable: true, value: { location: { href: "file:///guest-worker.js" } } });
        mem.set(new TextEncoder().encode("Launch ABI\0"), 0x5000); mem.set(new TextEncoder().encode("game.exe\0"), 0x5100);
        mem.set(new TextEncoder().encode("C:\\\0"), 0x5200);
        u32(0x6000, 52); u32(0x6008, 0x5000); bytes(0x600c, "34".repeat(16)); u32(0x601c, 0x5100); u32(0x6024, 0x5200);
        expect(call("RegisterApplication", [0, 0x6000], "IDirectPlayLobby3A")).toBe(0);
        u32(0x3000, 80); u32(0x3028, 8); bytes(0x3018, "34".repeat(16));
        u32(0x2300, 40); u32(0x2304, 2); u32(0x2308, 0x3000); bytes(0x2310, "e05ee9367785cf11960c0080c7534e82");
        u32(0x2200, 0xaabbccdd);
        const pending = call("RunApplication", [0, 0x2200, 0x2300, 0], "IDirectPlayLobby3A");
        expect(pending).toBeInstanceOf(Promise);
        const result = await pending as ThunkResult; expect(result.value).toBe(0); expect(read(0x2200)).toBe(0xaabbccdd);
        const pid = result.deferredWrites![0].value;
        for (let i = 0; i < 100 && !worker?.boot; i++) await new Promise(resolve => setTimeout(resolve, 1));
        expect(worker?.boot?.processIdentity.pid).toBe(pid);
        expect(await bootSettings).toMatchObject({ hr: 0, settings: { create: true, desc: { application: "34".repeat(16) } } });
        for (const write of result.deferredWrites!) u32(write.address, write.value);
        expect(read(0x2200)).toBe(pid);
        worker!.onmessage!({ data: { type: "process_exit", exitCode: 7 } });
        for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1));
        u32(0x2400, 64);
        expect(call("ReceiveLobbyMessage", [0, pid, 0x2404, 0x2500, 0x2400], "IDirectPlayLobby3A")).toBe(0);
        expect(read(0x2500)).toBe(4); expect(read(0x2400)).toBe(20); expect(read(0x2404)).toBe(1);
    } finally {
        if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor); else Reflect.deleteProperty(globalThis, "Worker");
        if (selfDescriptor) Object.defineProperty(globalThis, "self", selfDescriptor); else Reflect.deleteProperty(globalThis, "self");
        try { await stopChildProcesses(); } finally {
            child?.close(); child?.ipc.close();
            call("UnregisterApplication", [0, 0x600c], "IDirectPlayLobby3A");
            system.fileSystem = savedVfs;
            await closeProcessNetworkNamespace();
        }
    }
});
