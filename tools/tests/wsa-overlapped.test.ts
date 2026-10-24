import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, ipv6Address, FD_OOB } from "../../src/worker/modules/wsa-network";
import { makeSocketExports, WsaStartupCount, writeWsaData } from "../../src/worker/modules/wsa-stub-shared";
import { getWsaOverlapped, wsaStatusError } from "../../src/worker/modules/wsa-overlapped";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { encodeDatagram, decodeDatagram, parseIpv6, PROTO_UDP6 } from "../../src/worker/net/netplay-wire";
import { Process } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
const disposers: Array<() => void> = [];
afterEach(() => { for (const fn of disposers.splice(0).reverse()) fn(); });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
    let memory = new Uint8Array(2 * 1024 * 1024), tid = 11;
    const network = new LanNetwork(new Uint8Array([2, 0, 0, 9, 8, 7])), table = new WsaSocketTable(network);
    const owner = Object.create(Process.prototype) as Process;
    let allocation = 0x100000; const freed: number[] = [];
    (owner as any).memory = { alloc(size: number) { const ptr = allocation; allocation += size + 16; return ptr; }, free(ptr: number) { freed.push(ptr); } };
    (owner as any).resetGeneration = 0;
    (owner as any).getMemory = () => memory;
    (owner as any).addressSpace = {
        validateRange: (ptr: number, length: number) => ptr > 0 && ptr + length <= memory.length,
        write: (ptr: number, data: Uint8Array) => { if (ptr <= 0 || ptr + data.length > memory.length) return 0; memory.set(data, ptr); return data.length; },
    };
    Mem.bind(() => memory);
    const scheduler = System.getInstance().scheduler;
    const spy = spyOn(scheduler, "getCurrentThreadId").mockImplementation(() => tid);
    const counter = new WsaStartupCount(); counter.startup();
    let error = 0;
    const api = makeSocketExports(table, value => { error = value; }, counter, owner);
    const call = (name: string, args: number[]) => api[name]({} as never, memory, args);
    const listener = table.socket(); table.bind(listener, ipv4Address(network.ipv4, 1234)); table.listen(listener);
    const client = table.socket(); table.connect(client, ipv4Address(network.ipv4, 1234)); const server = table.accept(listener);
    disposers.push(() => { table.reset(); spy.mockRestore(); });
    const set = (ptr: number, value: number) => new DataView(memory.buffer).setUint32(ptr, value, true);
    const get = (ptr: number) => new DataView(memory.buffer).getUint32(ptr, true);
    const event = () => {
        const handle = scheduler.createEvent(true, false);
        disposers.push(() => System.getInstance().resourceProvider.unregisterKernelObject(handle));
        return handle;
    };
    const descriptor = (ptr: number, target: number, length: number) => { set(ptr, length); set(ptr + 4, target); };
    const apply = (result: any) => { for (const w of result.deferredWrites ?? []) {
        const view = new DataView(memory.buffer);
        if (w.size === 4) view.setUint32(w.address, w.value, true); else if (w.size === 2) view.setUint16(w.address, w.value, true); else view.setUint8(w.address, w.value);
    } };
    return { table, network, owner, scheduler, call, set, get, event, descriptor, client, server,
        listener, freed, memory: () => memory, error: () => error, grow: () => { const next = new Uint8Array(memory.length * 2); next.set(memory); memory = next; },
        thread: (value: number) => { tid = value; }, apply };
}
describe("Winsock overlapped I/O contracts", () => {
    test("native lease validity replaces numeric handle validity until the operation completes and is then forgotten", async()=>{
        const h=fixture(),provider=getWsaOverlapped(h.table,h.owner),event=h.event();let ready=false,releases=0;
        const operation=new Proxy(h.table,{get(target,name){if(name==="isValid")return()=>true;if(name==="generation")return 5;return Reflect.get(target,name,target);}});
        const lease={table:operation,release(){releases++;}};
        h.set(0x310,event);
        expect(provider.issue(h.server,0x300,0,"read",()=>{if(!ready)throw new WsaFailure(WSA.EWOULDBLOCK);return{bytes:1,flags:0,writes:[{address:0x1000,value:77,size:1}]};},()=>[],true,undefined,{nativeIoLease:lease}).error).toBe(997);
        h.table.closesocket(h.server);await tick();expect(h.get(0x300)).toBe(259);expect(releases).toBe(0);
        ready=true;provider.resume();await tick();expect(h.get(0x300)).toBe(0);expect(h.memory()[0x1000]).toBe(77);expect(releases).toBe(1);
        const request=(provider as any).requests.get(0x300);
        expect(request.nativeIoLease).toBeUndefined();expect(request.operationTable).toBeUndefined();expect(request.policy).toBeUndefined();expect(request.attempt).toBeUndefined();
        provider.resume();expect(releases).toBe(1);
    });
    test("native channel epoch fences queued publication after its lease has already been released",async()=>{
        const h=fixture(),provider=getWsaOverlapped(h.table,h.owner),event=h.event();let nativeEpoch=7,releases=0,ready=false;
        Object.defineProperty(h.table,"nativeIoGeneration",{configurable:true,get:()=>nativeEpoch});
        disposers.push(()=>{delete (h.table as any).nativeIoGeneration;});
        const queued:Array<()=>void>=[],enqueue=h.owner.enqueueCompletion.bind(h.owner);
        h.owner.enqueueCompletion=(writes,after,current)=>{queued.push(()=>enqueue(writes,after,current));};
        h.set(0x310,event);
        const lease={table:h.table,release(){releases++;}};
        provider.issue(h.server,0x300,0,"read",()=>{if(!ready)throw new WsaFailure(WSA.EWOULDBLOCK);return{bytes:1,flags:0,writes:[{address:0x1000,value:77,size:1}]};},()=>[],true,undefined,{nativeHandleIo:true,nativeIoLease:lease});
        ready=true;provider.resume();expect(releases).toBe(1);expect(queued.length).toBe(1);
        // Namespace lifetime can change before Process.resetGeneration is advanced.
        nativeEpoch++;for(const publish of queued)publish();await tick();
        expect(h.get(0x300)).toBe(259);expect(h.memory()[0x1000]).toBe(0);
        expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(false);
        provider.resume();expect((provider as any).requests.size).toBe(0);expect(releases).toBe(1);
    });
    test("a reentrant cancel hook can still use its I/O lease and cannot complete as success before cancellation",async()=>{
        const h=fixture(),provider=getWsaOverlapped(h.table,h.owner),event=h.event();let cancelled=false,released=false,attempts=0,hookCalls=0;
        h.set(0x310,event);
        const lease={table:h.table,release(){released=true;}};
        provider.issue(h.server,0x300,0,"read",()=>{attempts++;if(!cancelled)throw new WsaFailure(WSA.EWOULDBLOCK);return{bytes:1,flags:0,writes:[{address:0x1000,value:77,size:1}]};},()=>[],true,()=>{
            hookCalls++;expect(released).toBe(false);expect(lease.table.get(h.server).type).toBe(1);cancelled=true;
            h.table.send(h.client,Uint8Array.of(9));provider.resume(); // changed/resume runs inside the driver's cancel.
        },{nativeIoLease:lease});
        const before=attempts;expect(provider.cancel(h.server,0x300)).toBe(1);await tick();
        expect(hookCalls).toBe(1);expect(attempts).toBe(before);expect(released).toBe(true);
        expect(wsaStatusError(h.get(0x300))).toBe(995);expect(h.get(0x304)).toBe(0);expect(h.memory()[0x1000]).toBe(0);
        expect(h.table.receive(h.server,1).data).toEqual(Uint8Array.of(9));
    });
    test("issue owns a native lease on validation failure, immediate errors, cancellation and process reset",async()=>{
        const h=fixture(),provider=getWsaOverlapped(h.table,h.owner);
        const attempt=()=>{throw new WsaFailure(WSA.EWOULDBLOCK);};
        const lease=()=>{let count=0;return{table:h.table,release(){count++;},count:()=>count};};
        const duplicate=lease(),pending=lease();
        provider.issue(h.server,0x300,0,"read",attempt,()=>[],true,undefined,{nativeIoLease:pending});
        expect(()=>provider.issue(h.server,0x300,0,"read",attempt,()=>[],true,undefined,{nativeIoLease:duplicate})).toThrow();
        expect(duplicate.count()).toBe(1);expect(pending.count()).toBe(0);
        expect(provider.cancel(h.server,0x300)).toBe(1);await tick();expect(pending.count()).toBe(1);
        const invalidEvent=lease();h.set(0x330,0x7fffff00);
        expect(()=>provider.issue(h.server,0x320,0,"read",attempt,()=>[],true,undefined,{nativeIoLease:invalidEvent})).toThrow();expect(invalidEvent.count()).toBe(1);
        const hard=lease();expect(provider.issue(h.server,0x340,0,"read",()=>{throw new WsaFailure(WSA.ENOTCONN);},()=>[],true,undefined,{nativeIoLease:hard,immediateErrorHasNoCompletion:true}).error).toBe(WSA.ENOTCONN);expect(hard.count()).toBe(1);
        const fault=lease(),write=spyOn(Mem,"writeUint32").mockReturnValue(false);
        try { expect(()=>provider.issue(h.server,0x390,0,"read",attempt,()=>[],true,undefined,{nativeIoLease:fault})).toThrow();expect(fault.count()).toBe(1); }
        finally { write.mockRestore(); }
        const unexpected=lease();expect(()=>provider.issue(h.server,0x360,0,"read",()=>{throw Error("host failure");},()=>[],true,undefined,{nativeIoLease:unexpected})).toThrow("host failure");expect(unexpected.count()).toBe(1);
        const reset=lease();provider.issue(h.server,0x380,0,"read",attempt,()=>[],true,undefined,{nativeIoLease:reset});
        (h.owner as any).resetGeneration++;provider.resume();await tick();expect(reset.count()).toBe(1);expect(h.get(0x380)).toBe(259);
        provider.resume();expect(pending.count()).toBe(1);expect(reset.count()).toBe(1);
        const resetDuringIssue=lease();
        provider.issue(h.server,0x3a0,0,"read",()=>{(h.owner as any).resetGeneration++;return{bytes:0,flags:0,writes:[]};},()=>[],true,undefined,{nativeIoLease:resetDuringIssue});
        expect(resetDuringIssue.count()).toBe(1);expect((provider as any).requests.has(0x3a0)).toBe(false);expect(h.get(0x3a0)).toBe(259);
    });
    test("pending receive returns WSA_IO_PENDING, leaves the issuing thread runnable, and publishes before signalling", async () => {
        const h = fixture(), event = h.event();
        h.descriptor(0x100, 0x1000, 8); h.set(0x310, event); h.set(0x400, 0);
        expect(h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x300, 0])).toBe(-1);
        expect(h.error()).toBe(997); expect(h.get(0x300)).toBe(0x103);
        expect(h.call("WSAGetOverlappedResult", [h.server, 0x300, 0x404, 0, 0x408])).toBe(0); expect(h.error()).toBe(996);
        expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(false);
        h.grow(); h.thread(22);
        h.table.send(h.client, new Uint8Array([1, 2, 3]));
        await tick();
        expect(h.get(0x300)).toBe(0); expect(h.get(0x304)).toBe(3);
        expect([...h.memory().slice(0x1000, 0x1003)]).toEqual([1, 2, 3]);
        const object = System.getInstance().resourceProvider.getKernelObject(event) as any; expect(object.signaled).toBe(true);
        expect(h.call("WSAGetOverlappedResult", [h.server, 0x300, 0x404, 0, 0x408])).toBe(1);
        expect(h.get(0x404)).toBe(3); expect(h.get(0x408)).toBe(0);
    });
    test("completion routines have four arguments and retain the issuing thread rather than the receiving thread", async () => {
        const h = fixture(), calls: unknown[][] = [];
        const apc = spyOn(h.scheduler, "queueWsaCompletionApc").mockImplementation((...args) => { calls.push(args); return true; });
        disposers.push(() => apc.mockRestore());
        const event = h.event(); h.set(0x310, event); h.descriptor(0x100, 0x1000, 8); h.set(0x400, 0);
        expect(h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x300, 0x800])).toBe(-1);
        h.thread(22); h.table.send(h.client, new Uint8Array([4, 5])); await tick();
        expect(calls).toEqual([[11, 0x800, 0, 2, 0x300, 0]]);
        expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(false);
        expect(h.get(0x300)).toBe(0); expect(h.memory()[0x1000]).toBe(4);
    });
    test("WSAGetOverlappedResult(fWait) waits for this request and returns deferred outputs", async () => {
        const h = fixture(); h.descriptor(0x100, 0x1000, 8); h.set(0x400, 0);
        h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x300, 0]);
        const waiting = h.call("WSAGetOverlappedResult", [h.server, 0x300, 0x404, 1, 0x408]);
        expect(waiting).toBeInstanceOf(Promise);
        h.table.send(h.client, new Uint8Array([7])); const result: any = await waiting;
        expect(result.value).toBe(1); h.apply(result); expect(h.get(0x404)).toBe(1);
    });
    test("overlapped receive ignores FIONBIO and socket timeout; queued receives consume packets in issue order", async () => {
        const h = fixture(); h.table.setNonBlocking(h.server, true); h.table.get(h.server).receiveTimeout = 1;
        h.descriptor(0x100, 0x1000, 1); h.descriptor(0x108, 0x1001, 1); h.set(0x400, 0); h.set(0x408, 0);
        expect(h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x300, 0])).toBe(-1);
        expect(h.call("WSARecv", [h.server, 0x108, 1, 0, 0x408, 0x320, 0])).toBe(-1);
        h.table.send(h.client, new Uint8Array([8, 9])); await tick();
        expect([...h.memory().slice(0x1000, 0x1002)]).toEqual([8, 9]); expect(h.get(0x300)).toBe(0); expect(h.get(0x320)).toBe(0);
    });
    test("ordinary and urgent receive lanes progress independently while each keeps its issue order", async () => {
        for (const urgentFirst of [false, true]) {
            const h=fixture(),normal=h.event(),urgent=h.event();
            h.descriptor(0x100,0x1000,2);h.descriptor(0x108,0x1100,1);h.set(0x310,normal);h.set(0x330,urgent);h.set(0x400,0);h.set(0x408,1);
            const issue=(urgent:boolean)=>h.call("WSARecv",[h.server,urgent?0x108:0x100,1,0,urgent?0x408:0x400,urgent?0x320:0x300,0]);
            expect(issue(urgentFirst)).toBe(-1);expect(issue(!urgentFirst)).toBe(-1);
            h.table.send(h.client,Uint8Array.of(33),undefined,1);await tick();
            expect(h.get(0x320)).toBe(0);expect(h.get(0x324)).toBe(1);expect(h.memory()[0x1100]).toBe(33);
            expect((System.getInstance().resourceProvider.getKernelObject(urgent) as any).signaled).toBe(true);
            expect((System.getInstance().resourceProvider.getKernelObject(normal) as any).signaled).toBe(false);
            expect(h.get(0x300)).toBe(259);
            h.table.send(h.client,Uint8Array.of(97,98));await tick();
            expect(h.get(0x300)).toBe(0);expect(h.get(0x304)).toBe(2);expect([...h.memory().slice(0x1000,0x1002)]).toEqual([97,98]);
        }
    });
    test("native handle I/O survives provider cleanup on an open handle, then observes cancellation and process reset", async () => {
        const h=fixture(),provider=getWsaOverlapped(h.table,h.owner),event=h.event();let epoch=h.table.generation;
        Object.defineProperty(h.table,"generation",{configurable:true,get:()=>epoch});disposers.push(()=>{delete (h.table as any).generation;});
        h.set(0x310,event);
        const attempt=()=>{const packet=h.table.receive(h.server,1);return{bytes:packet.data.length,flags:0,writes:[{address:0x1000,value:packet.data[0],size:1 as const}]};};
        expect(provider.issue(h.server,0x300,0,"read",attempt,()=>[],true,undefined,{nativeHandleIo:true}).error).toBe(997);
        epoch++;provider.resume();expect(h.get(0x300)).toBe(259);
        h.grow();h.thread(22);const foreign=new Uint8Array(h.memory().length).fill(0x77);Mem.bind(()=>foreign);
        h.table.send(h.client,Uint8Array.of(9));await tick();
        expect(h.get(0x300)).toBe(0);expect(h.get(0x304)).toBe(1);expect(h.memory()[0x1000]).toBe(9);expect(foreign[0x1000]).toBe(0x77);
        Mem.bind(()=>h.memory());expect(provider.observeCompletion(h.server,0x300,result=>expect(result.bytes).toBe(1))).toBeInstanceOf(Function);
        h.set(0x330,event);expect(provider.issue(h.server,0x320,0,"read",attempt,()=>[],true,undefined,{nativeHandleIo:true}).error).toBe(997);
        epoch++;expect(provider.cancel(h.server,0x320)).toBe(1);await tick();expect(wsaStatusError(h.get(0x320))).toBe(995);
        h.set(0x350,event);provider.issue(h.server,0x340,0,"read",attempt,()=>[],true,undefined,{nativeHandleIo:true});
        (h.owner as any).resetGeneration++;h.memory().fill(0x55,0x340,0x354);h.table.reset();await tick();
        expect(h.get(0x340)).toBe(0x55555555);
    });
    test("native handle I/O completes aborted when provider cleanup actually closes its handle", async () => {
        const h=fixture(),provider=getWsaOverlapped(h.table,h.owner),event=h.event();h.set(0x310,event);
        provider.issue(h.server,0x300,0,"read",()=>{h.table.receive(h.server,1);return{bytes:1,flags:0,writes:[]};},()=>[],true,undefined,{nativeHandleIo:true});
        h.table.reset();await tick();expect(wsaStatusError(h.get(0x300))).toBe(995);
        expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(true);
    });
    test("closesocket aborts pending I/O, while provider reset does not write into recycled buffers", async () => {
        const h = fixture(), event = h.event(); h.set(0x310, event); h.descriptor(0x100, 0x1000, 8); h.set(0x400, 0);
        h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x300, 0]);
        h.table.closesocket(h.server); await tick();
        expect(wsaStatusError(h.get(0x300))).toBe(995); expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(true);
        const q = fixture(); q.descriptor(0x100, 0x1000, 8); q.set(0x400, 0);
        q.call("WSARecv", [q.server, 0x100, 1, 0, 0x400, 0x300, 0]);
        q.table.reset(); q.memory().fill(0x77, 0x300, 0x314); await tick(); expect(q.get(0x300)).toBe(0x77777777);
    });
    test("an overlapped send larger than the peer window remains pending until all bytes are accepted", async () => {
        const h = fixture(), size = 300000, payload = h.memory().subarray(0x1000, 0x1000 + size);
        for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
        h.descriptor(0x100, 0x1000, size); h.set(0x400, 0);
        expect(h.call("WSASend", [h.client, 0x100, 1, 0x400, 0, 0x300, 0])).toBe(-1); expect(h.error()).toBe(997);
        let received = 0;
        while (received < size) {
            const part = h.table.receive(h.server, 8192).data;
            expect(part).toEqual(Uint8Array.from({ length: part.length }, (_, i) => (received + i) % 251));
            received += part.length; await tick();
        }
        await tick(); expect(h.get(0x300)).toBe(0); expect(h.get(0x304)).toBe(size);
    });
    test("a buffer freed after issue completes with WSAEFAULT and wakes the event instead of hanging", async () => {
        const h = fixture(), event = h.event(); h.set(0x310, event); h.descriptor(0x100, 0x1000, 8); h.set(0x400, 0);
        h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x300, 0]);
        const original = h.owner.addressSpace.validateRange.bind(h.owner.addressSpace);
        (h.owner.addressSpace as any).validateRange = (ptr: number, length: number) => ptr !== 0x1000 && original(ptr, length, "w");
        h.table.send(h.client, new Uint8Array([7])); await tick(); await tick();
        expect(wsaStatusError(h.get(0x300))).toBe(10014);
        expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(true);
        expect(h.memory()[0x1000]).toBe(0);
    });
    test("socket cancellation filters the issuing thread or an exact OVERLAPPED without consuming another request", async () => {
        const h = fixture(); h.descriptor(0x100, 0x1000, 1); h.descriptor(0x108, 0x1001, 1); h.set(0x400, 0); h.set(0x404, 0);
        h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x300, 0]);
        h.thread(22); h.call("WSARecv", [h.server, 0x108, 1, 0, 0x404, 0x320, 0]);
        const io = getWsaOverlapped(h.table, h.owner);
        expect(io.cancel(h.server, 0, 11)).toBe(1); await tick(); expect(wsaStatusError(h.get(0x300))).toBe(995); expect(h.get(0x320)).toBe(0x103);
        h.table.send(h.client, Uint8Array.of(7)); await tick(); expect(h.get(0x320)).toBe(0); expect(h.memory()[0x1001]).toBe(7);
        h.call("WSARecv", [h.server, 0x100, 1, 0, 0x400, 0x340, 0]);
        expect(io.cancel(h.server, 0x341)).toBe(0); expect(io.cancel(h.server, 0x340)).toBe(1); await tick(); expect(wsaStatusError(h.get(0x340))).toBe(995);
    });
    test("truncated UDP publishes the prefix and records WSAEMSGSIZE in the OVERLAPPED status", async () => {
        const h = fixture(), rx = h.table.socket(2), tx = h.table.socket(2);
        h.table.bind(rx, ipv4Address(h.network.ipv4, 4444)); h.descriptor(0x100, 0x1000, 2); h.set(0x400, 0);
        h.call("WSARecv", [rx, 0x100, 1, 0, 0x400, 0x300, 0]);
        h.table.send(tx, new Uint8Array([1, 2, 3]), ipv4Address(h.network.ipv4, 4444)); await tick();
        expect(wsaStatusError(h.get(0x300))).toBe(10040); expect(h.get(0x304)).toBe(2); expect([...h.memory().slice(0x1000, 0x1002)]).toEqual([1, 2]);
    });
});
describe("Winsock abortive close", () => {
    test("SO_LINGER zero aborts the peer's pending read, while SO_DONTLINGER restores a graceful EOF", async () => {
        const h=fixture(); h.descriptor(0x100,0x1000,4);h.set(0x400,0);h.set(0x500,1);
        expect(h.call("setsockopt",[h.client,0xffff,0x80,0x500,4])).toBe(0);
        h.set(0x504,4);expect(h.call("getsockopt",[h.client,0xffff,0x80,0x508,0x504])).toBe(0);expect(h.get(0x508)).toBe(1);
        h.call("WSARecv",[h.server,0x100,1,0,0x400,0x300,0]);h.table.closesocket(h.client);await tick();
        expect(wsaStatusError(h.get(0x300))).toBe(WSA.ECONNRESET);expect(h.get(0x300)).toBe(0xc000020d);
        const q=fixture();q.descriptor(0x100,0x1000,4);q.set(0x400,0);q.set(0x500,1);
        q.call("setsockopt",[q.client,0xffff,0x80,0x500,4]);expect(q.call("setsockopt",[q.client,0xffff,0xffffff7f,0x500,4])).toBe(0);
        q.call("WSARecv",[q.server,0x100,1,0,0x400,0x300,0]);q.table.closesocket(q.client);await tick();
        expect(q.get(0x300)).toBe(0);expect(q.get(0x304)).toBe(0);
    });
});
describe("Winsock creation mode and OVERLAPPED fields", () => {
    test("both immediate and delayed WSA completions preserve Offset/OffsetHigh and return provider flags", async () => {
        const h=fixture(); h.descriptor(0x100,0x1000,8); h.set(0x400,0);
        h.set(0x308,0x11223344);h.set(0x30c,0x55667788);
        h.table.send(h.client,Uint8Array.of(7));
        expect(h.call("WSARecv",[h.server,0x100,1,0x404,0x400,0x300,0])).toBe(0);
        expect(h.get(0x308)).toBe(0x11223344);expect(h.get(0x30c)).toBe(0x55667788);
        h.set(0x328,0xaabbccdd);h.set(0x32c,0x12345678);
        expect(h.call("WSARecv",[h.server,0x100,1,0x404,0x400,0x320,0])).toBe(-1);
        h.table.send(h.client,Uint8Array.of(8,9));await tick();
        expect(h.get(0x328)).toBe(0xaabbccdd);expect(h.get(0x32c)).toBe(0x12345678);
        expect(h.call("WSAGetOverlappedResult",[h.server,0x320,0x404,0,0x408])).toBe(1);
        expect(h.get(0x404)).toBe(2);expect(h.get(0x408)).toBe(0);
    });
    test("flags0 WSARecv/From block through FIONBIO and SO_RCVTIMEO, publish events, and are absent from CancelIoEx", async () => {
        const h=fixture();
        for(const from of [false,true]) {
            const rx=h.call("WSASocketA",[2,2,17,0,0,0]) as number, tx=h.table.socket(2,2,17);
            h.table.bind(rx,ipv4Address(h.network.ipv4,4444));h.table.setNonBlocking(rx,true);h.table.get(rx).receiveTimeout=1;
            const event=h.event();h.descriptor(0x100,0x1000,8);h.set(0x310,event);h.set(0x308,0x11223344);h.set(0x400,0);
            const waiting=h.call(from?"WSARecvFrom":"WSARecv",from?[rx,0x100,1,0x404,0x400,0,0,0x300,0]:[rx,0x100,1,0x404,0x400,0x300,0]);
            expect(waiting).toBeInstanceOf(Promise);let settled=false;void (waiting as Promise<unknown>).then(()=>settled=true);
            expect(getWsaOverlapped(h.table,h.owner).cancel(rx,0x300)).toBe(0);
            await new Promise(resolve=>setTimeout(resolve,5));expect(settled).toBe(false);expect(h.get(0x300)).toBe(0x103);
            h.table.send(tx,Uint8Array.of(1,2,3),ipv4Address(h.network.ipv4,4444));
            const answer=await waiting as any;expect(answer.value).toBe(0);h.apply(answer);
            expect(h.get(0x404)).toBe(3);expect(h.get(0x300)).toBe(0);expect(h.get(0x304)).toBe(3);expect(h.get(0x308)).toBe(0x11223344);
            expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(true);
            h.table.closesocket(rx);h.table.closesocket(tx);
        }
    });
    test("flags0 completion APC belongs to the blocked issuer and WSASend/To waits for stream credit", async () => {
        const h=fixture(), calls:unknown[][]=[];
        h.table.get(h.server).overlapped=false;
        const apc=spyOn(h.scheduler,"queueWsaCompletionApc").mockImplementation((...args)=>{calls.push(args);return true;});disposers.push(()=>apc.mockRestore());
        h.descriptor(0x100,0x1000,4);h.set(0x400,0);
        const waiting=h.call("WSARecv",[h.server,0x100,1,0x404,0x400,0x300,0x800]);
        expect(waiting).toBeInstanceOf(Promise);h.thread(22);h.table.send(h.client,Uint8Array.of(9));
        expect((await waiting as any).value).toBe(0);expect(calls).toEqual([[11,0x800,0,0,0x300,0]]);
        h.table.get(h.client).overlapped=false;h.table.setNonBlocking(h.client,true);h.table.get(h.client).sendTimeout=1;
        const size=300000;h.descriptor(0x100,0x1000,size);
        for(const to of [false,true]) {
            const send=h.call(to?"WSASendTo":"WSASend",to?[h.client,0x100,1,0x404,0,0,0,0x320,0]:[h.client,0x100,1,0x404,0,0x320,0]);
            expect(send).toBeInstanceOf(Promise);let received=0;
            while(received<size){received+=h.table.receive(h.server,8192).data.length;await tick();}
            const answer=await send as any;expect(answer.value).toBe(0);h.apply(answer);expect(h.get(0x404)).toBe(size);
        }
    });
});
describe("Winsock completed I/O memory ownership", () => {
    test("completed immediate and pending requests release operation closures and write batches while result lookup remains usable", async () => {
        const h=fixture(),io=getWsaOverlapped(h.table,h.owner);
        const submit=(ov:number,immediate:boolean)=>{
            const readiness={value:immediate},payload={bytes:new Uint8Array(1024*1024)},cancellation={bytes:new Uint8Array(1024*1024)};
            const writes=[{address:0x1000,value:77,size:4 as const}],policyPayload={bytes:new Uint8Array(1024*1024)};
            const policy={forcePending:()=>policyPayload.bytes[0]===1};
            const attempt=()=>{
                if(!readiness.value)throw new WsaFailure(WSA.EWOULDBLOCK);
                return {bytes:payload.bytes[0]+3,flags:0x8000,error:WSA.EMSGSIZE,writes};
            };
            const cancel=()=>{cancellation.bytes[0]++;};
            const refs=[new WeakRef(payload),new WeakRef(cancellation),new WeakRef(writes),new WeakRef(attempt),new WeakRef(policyPayload)];
            io.issue(h.server,ov,0,"read",attempt,()=>[],true,cancel,policy);
            return {readiness,refs};
        };
        const immediate=submit(0x300,true),pending=submit(0x320,false);
        pending.readiness.value=true;io.resume();await tick();
        for(let attempt=0;attempt<20;attempt++){
            await new Promise(resolve=>setTimeout(resolve,0));Bun.gc(true);
            if([...immediate.refs,...pending.refs].every(ref=>ref.deref()===undefined))break;
        }
        expect([...immediate.refs,...pending.refs].map(ref=>ref.deref()===undefined)).toEqual(new Array(10).fill(true));
        expect(h.get(0x1000)).toBe(77);
        for(const ov of [0x300,0x320]){
            io.observeCompletion(h.server,ov,result=>expect(result.flags).toBe(0x8000));h.set(0x408,0x55667788);
            const result=io.result(h.server,ov,false,0x404,0x408) as any;
            expect(result.value).toBe(0);expect(result.error).toBe(WSA.EMSGSIZE);
            h.apply({deferredWrites:result.writes});expect(h.get(0x404)).toBe(3);expect(h.get(0x408)).toBe(0x55667788);
        }
    });
});
describe("Winsock receive warning and flag contracts",()=>{
    test("an immediate hard error leaves pending IOSB and old High without promising an event or APC",async()=>{
        const h=fixture(),socket=h.table.socket(),calls:unknown[][]=[];
        const apc=spyOn(h.scheduler,"queueWsaCompletionApc").mockImplementation((...args)=>{calls.push(args);return true;});disposers.push(()=>apc.mockRestore());
        for(const write of [false,true])for(const routine of [0,0x800]){
            const event=h.event();h.scheduler.setEvent(event);h.set(0x310,event);h.set(0x304,0x55667788);h.set(0x400,0);h.set(0x404,0xabcdef01);h.descriptor(0x100,0x1000,4);
            expect(h.call(write?"WSASend":"WSARecv",[socket,0x100,1,0x404,write?0:0x400,0x300,routine])).toBe(-1);expect(h.error()).toBe(WSA.ENOTCONN);
            expect(h.get(0x300)).toBe(259);expect(h.get(0x304)).toBe(0x55667788);expect(h.get(0x404)).toBe(0xabcdef01);
            await tick();expect(calls).toEqual([]);expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(!!routine);
            expect(getWsaOverlapped(h.table,h.owner).observeCompletion(socket,0x300,()=>{})).toBeNull();
        }
    });
    test("an overlapped MSG_OOB receive waits for urgent bytes and clears input flags before completion",async()=>{
        const h=fixture();h.descriptor(0x100,0x1000,2);h.set(0x400,1);
        expect(h.call("WSARecv",[h.server,0x100,1,0x404,0x400,0x300,0])).toBe(-1);expect(h.error()).toBe(997);expect(h.get(0x400)).toBe(0);
        h.table.send(h.client,Uint8Array.of(33),undefined,1);await tick();expect(h.get(0x300)).toBe(0);expect(h.get(0x304)).toBe(1);expect(h.memory()[0x1000]).toBe(33);expect(h.get(0x400)).toBe(0);
    });
    test("an already completed UDP overflow returns pending with zero input/output flags and leaves the byte count for GetResult",async()=>{
        const h=fixture();
        for(const synchronous of [false,true]){
            const rx=h.table.socket(2,2,17),tx=h.table.socket(2,2,17);h.table.get(rx).overlapped=!synchronous;h.table.bind(rx,ipv4Address(h.network.ipv4,4444));
            h.table.send(tx,Uint8Array.of(1,2,3),ipv4Address(h.network.ipv4,4444));h.descriptor(0x100,0x1000,2);h.set(0x400,0);h.set(0x404,0);h.set(0x308,0x11223344);
            const waiting=h.call("WSARecv",[rx,0x100,1,0x404,0x400,0x300,0]);
            const answer=waiting instanceof Promise?await waiting:waiting;if(typeof answer==='object')h.apply(answer);
            expect(typeof answer==='object'?(answer as any).value:answer).toBe(-1);expect(h.error()).toBe(997);expect(h.get(0x404)).toBe(0);expect(h.get(0x400)).toBe(0);
            expect(h.get(0x300)).toBe(0x80000005);expect(h.get(0x304)).toBe(2);expect(h.get(0x308)).toBe(0x11223344);
            h.set(0x408,0x55667788);expect(h.call("WSAGetOverlappedResult",[rx,0x300,0x404,0,0x408])).toBe(0);expect(h.error()).toBe(WSA.EMSGSIZE);expect(h.get(0x404)).toBe(2);expect(h.get(0x408)).toBe(0x55667788);
            h.table.closesocket(rx);h.table.closesocket(tx);
        }
    });
});
describe("Winsock completion observers", () => {
    test("unsubscribe removes a timed-out waiter, while completion and later observation receive one published result", async () => {
        const h=fixture(); h.descriptor(0x100,0x1000,4); h.set(0x400,0);
        h.call("WSARecv",[h.server,0x100,1,0,0x400,0x300,0]);
        const io=getWsaOverlapped(h.table,h.owner); let discarded=0,observed=0,late=0;
        const off=io.observeCompletion(h.server,0x300,()=>{discarded++;})!; off(); off();
        expect(io.observeCompletion(h.client,0x300,()=>{})).toBeNull();
        io.observeCompletion(h.server,0x300,result=>{expect(h.get(0x300)).toBe(0); expect(result.bytes).toBe(2); observed++;});
        h.table.send(h.client,Uint8Array.of(7,8)); await tick();
        expect(discarded).toBe(0); expect(observed).toBe(1);
        expect(io.observeCompletion(h.server,0x300,result=>{late++;expect(result.bytes).toBe(2);})).not.toBeNull(); expect(late).toBe(1);
    });
});
describe("Winsock provider extension contracts", () => {
    test("AcceptEx adopts the supplied socket, waits for initial data, and publishes address records", async () => {
        const h = fixture(), target = h.table.socket(), event = h.event(); h.set(0x310, event);
        expect(h.call("AcceptEx", [h.listener, target, 0x1000, 2, 32, 32, 0x400, 0x300])).toBe(0); expect(h.error()).toBe(997);
        const client = h.table.socket(); h.table.connect(client, ipv4Address(h.network.ipv4, 1234)); h.table.send(client, Uint8Array.of(7)); await tick();
        expect(h.get(0x300)).toBe(0); expect(h.get(0x304)).toBe(1); expect(h.memory()[0x1000]).toBe(7);
        expect(h.table.get(target).wireId).not.toBe(target);
        expect(h.call("GetAcceptExSockaddrs", [0x1000, 2, 32, 32, 0x500, 0x504, 0x508, 0x50c])).toBe(0);
        expect(h.get(0x500)).toBe(0x1012); expect(h.get(0x504)).toBe(16); expect(h.get(0x508)).toBe(0x1032); expect(h.get(0x50c)).toBe(16);
        h.set(0x604, 16); expect(h.call("getsockname", [target, 0x700, 0x604])).toBe(-1); expect(h.error()).toBe(10022);
        h.set(0x600, h.listener); expect(h.call("setsockopt", [target, 0xffff, 0x700b, 0x600, 4])).toBe(0);
        expect(h.call("getsockname", [target, 0x700, 0x604])).toBe(0);
        h.table.send(target, Uint8Array.of(8)); expect([...h.table.receive(client, 1).data]).toEqual([8]);
    });
    test("ConnectEx sends initial bytes and DisconnectEx(TF_REUSE_SOCKET) waits for peer FIN and reconnects the same bound handle", async () => {
        const h = fixture(), client = h.table.socket(); h.table.bind(client, ipv4Address(new Uint8Array(4), 0));
        h.memory()[0x100] = 2; h.memory()[0x102] = 4; h.memory()[0x103] = 210; h.memory().set(h.network.ipv4, 0x104); h.memory().set([1,2,3], 0x200);
        expect(h.call("ConnectEx", [client, 0x100, 16, 0x200, 3, 0x400, 0x300])).toBe(1); expect(h.get(0x400)).toBe(3);
        const server = h.table.accept(h.listener); expect([...h.table.receive(server, 3).data]).toEqual([1,2,3]);
        expect(h.call("setsockopt", [client, 0xffff, 0x7010, 0, 0])).toBe(0);
        const oldWire = h.table.get(client).wireId;
        const disconnect = h.call("DisconnectEx", [client, 0, 2, 0]); expect(disconnect).toBeInstanceOf(Promise);
        expect(h.table.receive(server, 1).data.length).toBe(0); h.table.closesocket(server);
        expect((await disconnect as any).value).toBe(1); expect(h.table.get(client).local).not.toBeNull();
        expect(h.table.get(client).wireId).not.toBe(oldWire);
        expect(h.call("ConnectEx", [client, 0x100, 16, 0x200, 3, 0x400, 0x320])).toBe(1);
        const next = h.table.accept(h.listener); expect([...h.table.receive(next, 3).data]).toEqual([1,2,3]);
    });
    test("a ConnectEx immediate completion repumps an earlier AcceptEx after synchronous local delivery", async () => {
        const h = fixture(), target = h.table.socket(), client = h.table.socket(), event = h.event();
        h.set(0x310, event); h.table.bind(client, ipv4Address(new Uint8Array(4), 0));
        expect(h.call("AcceptEx", [h.listener, target, 0x1000, 4, 32, 32, 0x400, 0x300])).toBe(0);
        h.memory()[0x100] = 2; h.memory()[0x102] = 4; h.memory()[0x103] = 210; h.memory().set(h.network.ipv4, 0x104); h.memory().set([1,2,3], 0x200);
        expect(h.call("ConnectEx", [client, 0x100, 16, 0x200, 3, 0x404, 0x320])).toBe(1);
        await tick(); expect(h.get(0x300)).toBe(0); expect(h.get(0x304)).toBe(3);
        expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(true);
        expect([...h.memory().slice(0x1000, 0x1003)]).toEqual([1,2,3]);
    });
    test("SIO_GET_EXTENSION_FUNCTION_POINTER checks the complete GUID and registers a private callable entry", () => {
        const h = fixture(), bound: unknown[][] = [];
        (h.owner as any).dispatcher = { register(...args: unknown[]) { bound.push(args); } };
        (h.owner as any).thunkGenerator = { getExportAddress(name: string) { expect(name).toBe("__winsock:ConnectEx"); return 0x900; } };
        h.memory().set([0xb9,0x07,0xa2,0x25,0xf3,0xdd,0x60,0x46,0x8e,0xe9,0x76,0xe5,0x8c,0x74,0x06,0x3e], 0x100);
        expect(h.call("WSAIoctl", [h.client, 0xc8000006, 0x100, 16, 0x200, 4, 0x204, 0, 0])).toBe(0);
        expect(h.get(0x200)).toBe(0x900); expect(h.get(0x204)).toBe(4); expect(bound[0].slice(0,2)).toEqual(["__winsock","ConnectEx"]);
        h.memory()[0x10f] ^= 1;
        expect(h.call("WSAIoctl", [h.client, 0xc8000006, 0x100, 16, 0x200, 4, 0x204, 0, 0])).toBe(-1); expect(h.error()).toBe(10022);
    });
});
describe("Winsock conditional accept owner callbacks", () => {
    test("WSAAccept passes the native eight-argument ABI and CF_DEFER preserves the queued connection", () => {
        const h = fixture(); let completion!: (result: number) => number | null; let callbackArgs: number[] = [], cleanup = 0;
        (h.owner as any).dispatcher = { callbackManager: {
            saveSuspendedThunkContext(_frame: unknown, size: number) { cleanup = size; return 7; },
            invokeCallback(_routine: number, args: number[], bytes: number, done: typeof completion) { callbackArgs = args; completion = done; expect(bytes).toBe(20); return { callbackId: 9 }; },
            abandonSuspendedFrame() {},
        } };
        const client = h.table.socket(); h.table.connect(client, ipv4Address(h.network.ipv4, 1234));
        h.set(0x400, 16);
        const result: any = h.call("WSAAccept", [h.listener, 0x500, 0x400, 0x800, 0x12345678]);
        expect(result.suspendedForCallback).toBe(true); expect(cleanup).toBe(20); expect(callbackArgs.length).toBe(8);
        expect(callbackArgs[1]).toBe(0); expect(callbackArgs[2]).toBe(0); expect(callbackArgs[3]).toBe(0); expect(callbackArgs[5]).toBe(0);
        expect(callbackArgs[7]).toBe(0x12345678); expect(h.get(callbackArgs[0])).toBe(16); expect(h.get(callbackArgs[4])).toBe(16);
        expect(completion(2)).toBe(-1); expect(h.error()).toBe(11002); expect(h.freed.length).toBe(1);
        const accepted = h.call("accept", [h.listener, 0x500, 0x400]) as number;
        expect(h.table.isConnected(accepted)).toBe(true); h.table.send(client, new Uint8Array([42]));
        expect([...h.table.receive(accepted, 1).data]).toEqual([42]);
    });
    test("a condition for a blocking WSAAccept starts only when dispatcher resumes its owner frame", async () => {
        const h = fixture(); let calls = 0, completion!: (result: number) => number | null;
        (h.owner as any).dispatcher = { callbackManager: {
            saveSuspendedThunkContext() { return 7; },
            invokeCallback(_routine: number, _args: number[], _cleanup: number, done: typeof completion) { completion = done; calls++; return { callbackId: 9 }; },
            abandonSuspendedFrame() {},
        } };
        const args = [h.listener, 0, 0, 0x800, 0x12345678], waiting = h.call("WSAAccept", args); args.fill(0);
        expect(waiting).toBeInstanceOf(Promise);
        const client = h.table.socket(); h.table.connect(client, ipv4Address(h.network.ipv4, 1234));
        const result: any = await waiting; expect(calls).toBe(0);
        expect(result.startCallbackChain({ esp: 0x1000, returnAddr: 0x900 })).toBe(true); expect(calls).toBe(1);
        const child = completion(0)!; expect(h.table.isConnected(child)).toBe(true); expect(h.freed.length).toBe(1);
    });
    test("CF_REJECT resets the peer, while callback allocation failures release the suspended frame", () => {
        const h = fixture(); let completion!: (result: number) => number | null, abandoned = 0;
        const manager = {
            saveSuspendedThunkContext() { return 7; },
            invokeCallback(_routine: number, _args: number[], _cleanup: number, done: typeof completion) { completion = done; return { callbackId: 9 }; },
            abandonSuspendedFrame() { abandoned++; },
        };
        (h.owner as any).dispatcher = { callbackManager: manager };
        const client = h.table.socket(); h.table.connect(client, ipv4Address(h.network.ipv4, 1234));
        h.call("WSAAccept", [h.listener, 0, 0, 0x800, 0]); expect(completion(1)).toBe(-1); expect(h.error()).toBe(10061);
        expect(() => h.table.receive(client, 1)).toThrow();
        const next = h.table.socket(); h.table.connect(next, ipv4Address(h.network.ipv4, 1234));
        manager.invokeCallback = () => ({ callbackId: 0 });
        expect(h.call("WSAAccept", [h.listener, 0, 0, 0x800, 0])).toBe(-1); expect(h.error()).toBe(10055); expect(abandoned).toBe(1);
    });
});
describe("Winsock IPv6, provider catalog and lifecycle", () => {
    test("IPv4 and IPv6 datagram endpoints can bind the same port and remain isolated", () => {
        const h = fixture(), v4 = h.table.socket(2, 2, 17), v6 = h.table.socket(2, 23, 17);
        h.table.bind(v4, ipv4Address(h.network.ipv4, 4000));
        h.table.bind(v6, ipv6Address(h.network.ipv6, 4000));
        const tx4 = h.table.socket(2, 2, 17), tx6 = h.table.socket(2, 23, 17);
        h.table.send(tx4, Uint8Array.of(4), ipv4Address(h.network.ipv4, 4000));
        expect(h.table.readable(v4)).toBe(true); expect(h.table.readable(v6)).toBe(false);
        h.table.send(tx6, Uint8Array.of(6), ipv6Address(h.network.ipv6, 4000));
        const from6 = h.table.receive(v6, 1);
        expect([...from6.data]).toEqual([6]); expect(from6.from.family).toBe(23); expect(from6.from.ip6).toEqual(h.network.ipv6);
        expect([...h.table.receive(v4, 1).data]).toEqual([4]);
    });
    test("scoped IPv6 endpoints route to distinct interfaces and recvfrom restores the peer scope", () => {
        const h = fixture(), address = parseIpv6("fe80::1234")!, first = [2, 2, 0, 0, 0, 11], second = [2, 2, 0, 0, 0, 12];
        h.network.configureGatewayIpv6([{ address: [...address], node: first, scopeId: 11 }, { address: [...address], node: second, scopeId: 12 }]);
        const sent: Uint8Array[] = []; h.network.attach({ send(frame) { sent.push(frame.slice()); return true; }, close() {} });
        const rx = h.table.socket(2, 23, 17); h.table.bind(rx, ipv6Address(h.network.ipv6, 4000));
        h.table.send(rx, Uint8Array.of(11), ipv6Address(address, 5000, 11)); h.table.send(rx, Uint8Array.of(12), ipv6Address(address, 5000, 12));
        expect([...decodeDatagram(sent[0])!.node]).toEqual(first); expect([...decodeDatagram(sent[1])!.node]).toEqual(second);
        h.network.receiveFrame(encodeDatagram(PROTO_UDP6, Uint8Array.from(second), 4000, 5000, Uint8Array.of(7)));
        h.set(0x300, 28); expect(h.call("recvfrom", [rx, 0x1000, 8, 0, 0x200, 0x300])).toBe(1);
        expect(h.get(0x218)).toBe(12); expect([...h.memory().slice(0x208, 0x218)]).toEqual([...address]);
        const loopback = new Uint8Array(16); loopback[15] = 1;
        try { h.table.send(rx, Uint8Array.of(1), ipv6Address(loopback, 5000, 1)); throw Error("expected invalid scope"); }
        catch (error) { expect((error as { code: number }).code).toBe(WSA.EADDRNOTAVAIL); }
    });
    test("IPv6 reliable streams use the IPv6 protocol and preserve stream/FIN semantics", () => {
        const h = fixture(), listener = h.table.socket(1, 23, 6); h.table.bind(listener, ipv6Address(h.network.ipv6, 4000)); h.table.listen(listener);
        const client = h.table.socket(1, 23, 6); expect(h.table.connect(client, ipv6Address(h.network.ipv6, 4000))).toBe(0);
        const server = h.table.accept(listener);
        expect(h.table.get(server).af).toBe(23); expect(h.table.get(server).peer?.ip6).toEqual(h.network.ipv6);
        h.table.send(client, Uint8Array.of(7, 8)); h.table.shutdown(client, 1);
        expect([...h.table.receive(server, 4).data]).toEqual([7, 8]); expect(h.table.receive(server, 1).data.length).toBe(0);
    });
    test("sockaddr_in6 outputs are 28 bytes and retain the full IPv6 address", () => {
        const h = fixture(), socket = h.call("socket", [23, 2, 17]) as number;
        h.memory()[0x100] = 23; h.memory()[0x102] = 0x10; h.memory()[0x103] = 0x00; h.memory().set(h.network.ipv6, 0x108);
        expect(h.call("bind", [socket, 0x100, 28])).toBe(0); h.set(0x300, 28);
        expect(h.call("getsockname", [socket, 0x200, 0x300])).toBe(0);
        expect(h.get(0x300)).toBe(28); expect(h.memory()[0x200]).toBe(23); expect([...h.memory().slice(0x208, 0x218)]).toEqual([...h.network.ipv6]);
    });
    test("a port/peer departure after FIN preserves queued bytes and EOF", () => {
        const h = fixture(); h.table.send(h.client, Uint8Array.of(7)); h.table.shutdown(h.client, 1);
        h.network.notifySocketError({ node: h.network.node, localPort: h.table.get(h.server).local!.port,
            remotePort: h.table.get(h.client).local!.port, proto: 2, code: 10054 });
        h.network.notifyPeerDisconnected(h.network.node);
        expect([...h.table.receive(h.server, 1).data]).toEqual([7]); expect(h.table.receive(h.server, 1).data.length).toBe(0);
    });
    test("a stale native error cannot poison a new UDP binding that reused the same port",()=>{
        const h=fixture(),first=h.table.socket(2,2,17);h.table.bind(first,ipv4Address(h.network.ipv4,4444));
        const old=h.network.bindingGeneration(4444,1);h.table.closesocket(first);
        const next=h.table.socket(2,2,17);h.table.bind(next,ipv4Address(h.network.ipv4,4444));
        const fresh=h.network.bindingGeneration(4444,1);expect(fresh).not.toBe(old);
        h.table.setNonBlocking(next,true);
        const payload=0x20000,option=0x20100,optionLength=0x20110;
        h.memory()[payload]=0xa5;
        const recv=()=>h.call("recvfrom",[next,payload,1,0,0,0]);
        const error={node:h.network.node,localPort:4444,remotePort:5555,proto:1,code:WSA.ECONNRESET};
        h.network.notifySocketError({...error,bindingGeneration:old});
        expect(h.table.readable(next)).toBe(false);
        expect(recv()).toBe(-1);expect(h.error()).toBe(WSA.EWOULDBLOCK);
        expect(h.memory()[payload]).toBe(0xa5);

        h.network.notifySocketError({...error,bindingGeneration:fresh});
        expect(h.table.readable(next)).toBe(true);
        h.set(option,0xdeadbeef);h.set(optionLength,4);
        expect(h.call("getsockopt",[next,0xffff,0x1007,option,optionLength])).toBe(0);
        expect(h.error()).toBe(0);expect(h.get(option)).toBe(0);expect(h.get(optionLength)).toBe(4);
        // SO_ERROR reports0 without consuming the independent receive-only reset.
        expect(h.table.readable(next)).toBe(true);
        expect(recv()).toBe(-1);expect(h.error()).toBe(WSA.ECONNRESET);
        expect(h.memory()[payload]).toBe(0xa5);expect(h.table.readable(next)).toBe(false);
        expect(recv()).toBe(-1);expect(h.error()).toBe(WSA.EWOULDBLOCK);
        expect(h.table.readable(next)).toBe(false);
    });
    test("UDP ICMP errors affect one socket and are consumed rather than permanently poisoning it", () => {
        const h = fixture(), rx = h.table.socket(2), tx = h.table.socket(2);
        h.table.bind(rx, ipv4Address(h.network.ipv4, 4000)); h.table.connect(tx, ipv4Address(h.network.ipv4, 4000));
        h.network.notifySocketError({ node: h.network.node, localPort: h.table.get(tx).local!.port, remotePort: 4000, proto: 1, code: 10054 });
        expect(() => h.table.receive(tx, 1)).toThrow(); expect(h.table.get(rx).error).toBe(0);
        expect(h.table.send(tx, Uint8Array.of(3))).toBe(1); expect([...h.table.receive(rx, 1).data]).toEqual([3]);
    });
    test("WSAEnumProtocols reports exact A/W record sizes and records can create sockets through FROM_PROTOCOL_INFO", () => {
        const h = fixture(); h.set(0x100, 0);
        expect(h.call("WSAEnumProtocolsA", [0, 0, 0x100])).toBe(-1); expect(h.error()).toBe(10055); expect(h.get(0x100)).toBe(7 * 372);
        h.set(0x100, 7 * 372); expect(h.call("WSAEnumProtocolsA", [0, 0x1000, 0x100])).toBe(7);
        const socket = h.call("WSASocketA", [0xffffffff, 0xffffffff, 0xffffffff, 0x1000, 0, 1]) as number;
        expect(h.table.get(socket).af).toBe(2); expect(h.table.get(socket).type).toBe(1); expect(h.table.get(socket).protocol).toBe(6);
        h.set(0x200, 17); h.set(0x204, 0); h.set(0x100, 0);
        expect(h.call("WSAEnumProtocolsW", [0x200, 0, 0x100])).toBe(-1); expect(h.get(0x100)).toBe(2 * 628);
        h.set(0x100, 2 * 628); expect(h.call("WSAEnumProtocolsW", [0x200, 0x4000, 0x100])).toBe(2);
        expect(h.get(0x4000 + 92)).toBe(17); expect(h.get(0x4000 + 628 + 76)).toBe(23);
    });
    test("socket-scoped host/network byte-order functions validate the socket and write only their declared width", () => {
        const h = fixture(); h.memory().fill(0xa5, 0x100, 0x108);
        expect(h.call("WSAHtons", [h.client, 0x1234, 0x100])).toBe(0);
        expect([...h.memory().slice(0x100, 0x104)]).toEqual([0x12, 0x34, 0xa5, 0xa5]);
        expect(h.call("WSANtohl", [h.client, 0x12345678, 0x104])).toBe(0);
        expect([...h.memory().slice(0x104, 0x108)]).toEqual([0x12, 0x34, 0x56, 0x78]);
        expect(h.call("WSAHtonl", [99999, 0, 0x100])).toBe(-1); expect(h.error()).toBe(10038);
    });
    test("IPv6 literal and socket address conversion preserve scopes, mapped IPv4 and length units", () => {
        const h = fixture();
        const put = (ptr: number, text: string) => h.memory().set(new TextEncoder().encode(text + "\0"), ptr);
        const read = (ptr: number) => { let end = ptr; while (h.memory()[end]) end++; return new TextDecoder().decode(h.memory().slice(ptr, end)); };
        put(0x100, "::ffff:192.0.2.1"); expect(h.call("InetPtonA", [23, 0x100, 0x200])).toBe(1);
        expect([...h.memory().slice(0x20a, 0x210)]).toEqual([255, 255, 192, 0, 2, 1]);
        expect(h.call("InetNtopA", [23, 0x200, 0x300, 128])).toBe(0x300); expect(read(0x300)).toBe("::ffff:192.0.2.1");
        put(0x100, "[fe80::1234%7]:1234"); h.set(0x400, 28);
        expect(h.call("WSAStringToAddressA", [0x100, 23, 0, 0x500, 0x400])).toBe(0); expect(h.get(0x518)).toBe(7);
        h.set(0x400, 128); expect(h.call("WSAAddressToStringA", [0x500, 28, 0, 0x600, 0x400])).toBe(0);
        expect(read(0x600)).toBe("[fe80::1234%7]:1234"); expect(h.get(0x400)).toBe(20);
        h.set(0x400, 1); h.memory()[0x600] = 0x55;
        expect(h.call("WSAAddressToStringA", [0x500, 28, 0, 0x600, 0x400])).toBe(-1);
        expect(h.error()).toBe(10014); expect(h.get(0x400)).toBe(20); expect(h.memory()[0x600]).toBe(0x55);
    });
});
describe("Winsock stream and IPX contracts", () => {
    test("MSG_WAITALL spans arrivals and receive windows, but returns a partial stream at FIN", async () => {
        const h = fixture(), waiting = h.call("recv", [h.server, 0x1000, 4, 8]);
        expect(waiting).toBeInstanceOf(Promise); h.table.send(h.client, new Uint8Array([1, 2])); await tick();
        expect(h.memory()[0x1000]).toBe(0); h.table.send(h.client, new Uint8Array([3, 4]));
        const result: any = await waiting; expect(result.value).toBe(4); h.apply(result);
        expect([...h.memory().slice(0x1000, 0x1004)]).toEqual([1, 2, 3, 4]);
        const partial = h.call("recv", [h.server, 0x1100, 4, 8]); h.table.send(h.client, new Uint8Array([5])); h.table.shutdown(h.client, 1);
        const last: any = await partial; expect(last.value).toBe(1); h.apply(last); expect(h.memory()[0x1100]).toBe(5);
    });
    test("MSG_OOB preserves the normal prefix, signals FD_OOB, and exposes the urgent mark", () => {
        const h = fixture(), events: number[] = []; h.table.configureEvents(h.server, FD_OOB, bit => events.push(bit));
        expect(h.table.send(h.client, new Uint8Array([0x78, 0x79]), undefined, 1)).toBe(2);
        expect(events).toEqual([FD_OOB]); expect(h.table.exceptional(h.server)).toBe(true);
        expect([...h.table.receive(h.server, 10).data]).toEqual([0x78]); expect(h.table.atMark(h.server)).toBe(false); // Native Windows, not BSD SIOCATMARK.
        expect([...h.table.receive(h.server, 1, 1).data]).toEqual([0x79]); expect(h.table.exceptional(h.server)).toBe(false); expect(h.table.atMark(h.server)).toBe(true);
        h.table.send(h.client, new Uint8Array([0x7a])); expect([...h.table.receive(h.server, 1).data]).toEqual([0x7a]); expect(h.table.atMark(h.server)).toBe(true);
    });
    test("urgent records form a FIFO, normal reads cross marks, and MSG_PEEK stops before the next mark", () => {
        const h = fixture(); h.table.send(h.client, Uint8Array.of(1,2));
        h.table.send(h.client, Uint8Array.of(8), undefined, 1); h.table.send(h.client, Uint8Array.of(9), undefined, 1);
        h.table.send(h.client, Uint8Array.of(3,4));
        expect(h.table.bytesAvailable(h.server)).toBe(4); expect([...h.table.receive(h.server, 10, 2).data]).toEqual([1,2]);
        expect([...h.table.receive(h.server, 10).data]).toEqual([1,2,3,4]);
        expect([...h.table.receive(h.server, 1, 1).data]).toEqual([8]); expect(h.table.atMark(h.server)).toBe(false);
        expect([...h.table.receive(h.server, 1, 1).data]).toEqual([9]); expect(h.table.atMark(h.server)).toBe(true);
    });
    test("SO_OOBINLINE set before arrival exposes ordinary bytes, no exceptional readiness, and no peek boundary", () => {
        const h = fixture(); h.table.setOobInline(h.server, true); h.table.send(h.client, Uint8Array.of(1,2));
        h.table.send(h.client, Uint8Array.of(8), undefined, 1); h.table.send(h.client, Uint8Array.of(3,4));
        expect(h.table.bytesAvailable(h.server)).toBe(5); expect(h.table.atMark(h.server)).toBe(true); expect(h.table.exceptional(h.server)).toBe(false);
        expect([...h.table.receive(h.server, 10, 2).data]).toEqual([1,2,8,3,4]);
        expect([...h.table.receive(h.server, 10).data]).toEqual([1,2,8,3,4]);
    });
    test("SO_OOBINLINE moves pending urgent records into and out of the byte stream without losing credit", () => {
        const h = fixture(), initialCredit = h.table.get(h.client).credit;
        h.table.send(h.client, Uint8Array.of(1,2)); h.table.send(h.client, Uint8Array.of(8), undefined, 1); h.table.send(h.client, Uint8Array.of(3,4));
        h.table.setOobInline(h.server, true); expect(h.table.bytesAvailable(h.server)).toBe(5);
        h.table.setOobInline(h.server, false); expect(h.table.bytesAvailable(h.server)).toBe(4);
        expect([...h.table.receive(h.server, 10).data]).toEqual([1,2,3,4]); expect([...h.table.receive(h.server, 1, 1).data]).toEqual([8]);
        expect(h.table.get(h.client).credit).toBe(initialCredit);
    });
    test("IPX extended address packet type/broadcast flags and 30-byte headers match wsnwlink layouts", () => {
        const h = fixture(), rx = h.table.socket(2, 6, 1000), tx = h.table.socket(2, 6, 1000);
        h.table.bind(rx, { family: 6, node: h.network.node, port: 5000 });
        h.table.get(rx).extendedAddress = true; h.table.get(rx).receiveHeader = true; h.table.get(tx).broadcast = true; h.table.get(tx).extendedAddress = true;
        h.table.send(tx, new Uint8Array([0xaa, 0xbb]), { family: 6, node: new Uint8Array(6).fill(255), port: 5000, packetType: 34 });
        const packet = h.table.receive(rx, 100);
        expect(packet.from.flags).toBe(3); expect(packet.data.length).toBe(32); expect(packet.data[0]).toBe(0xff); expect(packet.data[5]).toBe(34);
        expect([...packet.data.slice(30)]).toEqual([0xaa, 0xbb]);
    });
    test("WSADATA vendor pointer has the x86 alignment padding", () => {
        const memory = new Uint8Array(512).fill(0xa5); writeWsaData(32, 0x202, memory);
        expect([...memory.slice(32 + 396, 32 + 400)]).toEqual([0, 0, 0, 0]);
    });
});

describe("Winsock legacy receive and TransmitFile", () => {
    function file(h: ReturnType<typeof fixture>, data: Uint8Array, delayed = false) {
        const vfs = System.getInstance().fileSystem, handle = { kind: "file" as const, path: "C:\\transmit.dat",
            position: 3, access: 0x80000000, source: "rom" as const };
        const resource = { vfsHandle: handle, get position() { return handle.position; }, get size() { return data.length; } };
        const reads: number[] = []; let complete!: () => void;
        const copy = (cursor: typeof handle, count: number) => { const out = data.slice(cursor.position, cursor.position + count); cursor.position += out.length; return out; };
        const get = spyOn(System.getInstance().resourceProvider, "getFileHandle").mockImplementation(id => id === 0x51000 ? resource : undefined);
        const sync = spyOn(vfs, "readSync").mockImplementation((cursor, length) => { reads.push(length); return delayed ? null : copy(cursor as typeof handle, length); });
        const async = spyOn(vfs, "read").mockImplementation((cursor, length) => new Promise(resolve => { complete = () => resolve(copy(cursor as typeof handle, length)); }));
        disposers.push(() => { get.mockRestore(); sync.mockRestore(); async.mockRestore(); });
        h.memory()[0x1000] = 72; h.memory()[0x1100] = 84;
        h.set(0x100, 0x1000); h.set(0x104, 1); h.set(0x108, 0x1100); h.set(0x10c, 1);
        return { handle, reads, complete: () => complete() };
    }
    test("WSARecvEx returns a truncated byte count, MSG_PARTIAL and WSAEMSGSIZE; flags are output-only", () => {
        const h = fixture(), rx = h.table.socket(2), tx = h.table.socket(2);
        h.table.bind(rx, ipv4Address(h.network.ipv4, 5555)); h.table.setNonBlocking(rx, true);
        h.table.send(tx, Uint8Array.of(1,2,3,4), ipv4Address(h.network.ipv4,5555)); h.set(0x400,2);
        expect(h.call("WSARecvEx",[rx,0x1000,2,0x400])).toBe(2); expect(h.error()).toBe(WSA.EMSGSIZE); expect(h.get(0x400)).toBe(0x8000);
        expect([...h.memory().slice(0x1000,0x1002)]).toEqual([1,2]);
        expect(h.call("WSARecvEx",[rx,0x1000,8,0x400])).toBe(-1); expect(h.error()).toBe(WSA.EWOULDBLOCK); expect(h.get(0x400)).toBe(0);
        h.table.send(tx,Uint8Array.of(5,6),ipv4Address(h.network.ipv4,5555)); h.set(0x400,2);
        expect(h.call("WSARecvEx",[rx,0x1000,8,0x400])).toBe(2); expect(h.get(0x400)).toBe(0); expect(h.error()).toBe(0);
        expect(h.table.readable(rx)).toBe(false);
    });
    test("TransmitFile sends head, file range and tail with an independent cursor and accepts a NULL file", () => {
        const h = fixture(), f = file(h, new TextEncoder().encode("0123456789"));
        expect(h.call("TransmitFile",[h.client,0x51000,4,2,0,0x100,0])).toBe(1);
        expect(new TextDecoder().decode(h.table.receive(h.server,64).data)).toBe("H3456T"); expect(f.handle.position).toBe(3);
        expect(f.reads.every(count=>count<=2)).toBe(true);
        expect(h.call("TransmitFile",[h.client,0,0,0,0,0x100,0])).toBe(1);
        expect(new TextDecoder().decode(h.table.receive(h.server,64).data)).toBe("HT");
        expect(h.call("TransmitFile",[h.client,0xdead,1,0,0,0,0])).toBe(0); expect(h.error()).toBe(6);
    });
    test("overlapped TransmitFile repumps after a host read, preserves Offset and publishes only in owner RAM before signalling", async () => {
        const h = fixture(), f = file(h, new TextEncoder().encode("0123456789"), true), event = h.event();
        h.set(0x308,1); h.set(0x310,event);
        expect(h.call("TransmitFile",[h.client,0x51000,3,0,0x300,0x100,0])).toBe(0); expect(h.error()).toBe(997);
        h.memory()[0x1000]=88; h.memory()[0x1100]=89; h.grow(); h.thread(22); f.handle.position=9;
        const foreign = new Uint8Array(h.memory().length).fill(0x77); Mem.bind(()=>foreign);
        f.complete(); await tick(); await tick();
        expect(h.get(0x300)).toBe(0); expect(h.get(0x304)).toBe(5); expect(h.get(0x308)).toBe(1);
        expect(foreign[0x300]).toBe(0x77); expect(f.handle.position).toBe(9);
        expect((System.getInstance().resourceProvider.getKernelObject(event) as any).signaled).toBe(true);
        expect(new TextDecoder().decode(h.table.receive(h.server,64).data)).toBe("H123T");
        Mem.bind(()=>h.memory()); expect(h.call("WSAGetOverlappedResult",[h.client,0x300,0x400,0,0x404])).toBe(1);
        expect(h.get(0x400)).toBe(5); expect(h.get(0x404)).toBe(0);
    });
    test("TransmitFile streams beyond the credit window with bounded host reads and a complete byte count", async () => {
        const h=fixture(), data=Uint8Array.from({length:400000},(_,i)=>i%251), f=file(h,data); h.set(0x308,0);
        expect(h.call("TransmitFile",[h.client,0x51000,0,0,0x300,0,0])).toBe(0); expect(h.error()).toBe(997);
        let received=0;
        while(received<data.length) {
            const packet=h.table.receive(h.server,8192).data;
            expect(packet).toEqual(data.slice(received,received+packet.length)); received+=packet.length; await tick();
        }
        await tick(); expect(h.get(0x300)).toBe(0); expect(h.get(0x304)).toBe(data.length); expect(f.reads.every(count=>count<=65536)).toBe(true);
    });
    test("cancelling a TransmitFile pending on disk prevents its late read from sending or completing a second time", async () => {
        const h=fixture(), f=file(h,new TextEncoder().encode("0123456789"),true); h.set(0x308,1);
        h.call("TransmitFile",[h.client,0x51000,3,0,0x300,0,0]);
        expect(getWsaOverlapped(h.table,h.owner).cancel(h.client,0x300)).toBe(1); await tick();
        expect(wsaStatusError(h.get(0x300))).toBe(995); expect(h.table.readable(h.server)).toBe(false);
        f.complete(); await tick(); expect(wsaStatusError(h.get(0x300))).toBe(995); expect(h.table.readable(h.server)).toBe(false);
    });
    test("local TCP and an unconnected UDP receive survive relay loss", async () => {
        const h=fixture(), udp=h.table.socket(2); h.table.bind(udp,ipv4Address(h.network.ipv4,5555));
        h.network.setConnected(true); const waiting=h.call("recv",[udp,0x1000,4,0]); let settled=false;
        void (waiting as Promise<unknown>).then(()=>{settled=true;}); h.network.setConnected(false); await tick(); expect(settled).toBe(false);
        h.table.send(h.client,Uint8Array.of(7)); expect([...h.table.receive(h.server,4).data]).toEqual([7]);
        h.table.send(h.table.socket(2),Uint8Array.of(8),ipv4Address(h.network.ipv4,5555));
        const answer:any=await waiting; expect(answer.value).toBe(1); h.apply(answer); expect(h.memory()[0x1000]).toBe(8);
    });
});
