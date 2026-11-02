import {expect, test} from "bun:test";
import {LanNetwork, type NetTransport} from "../../src/worker/net/lan-network";
import {decodeDatagram, encodeDatagram, encodeTcpFrame, PROTO_TCP, PROTO_UDP, SYN, DATA, TCP_WINDOW} from "../../src/worker/net/netplay-wire";
import {WsaActorKernel} from "../../src/worker/modules/wsa-actor-kernel";
import {WsaSocketTable, ipv4Address} from "../../src/worker/modules/wsa-network";
import type {TcpHostLease} from "../../src/worker/net/tcp-host-lease-rpc";
import {discoverNativeSessions} from "../../src/worker/modules/dplayx/native-wire/lan-discovery";

const allowed = [[2,1,127,0,0,1]];
const source = Uint8Array.from(allowed[0]);
const literal = Uint8Array.from(Buffer.from(
    "7600b0fa020008fcc00002010000000000000000" +
    "706c617901000b005000000000200000000102030405060708090a0b0c0d0e0f" +
    "101112131415161718191a1b1c1d1e1f08000000030000000000000000000000" +
    "0403020188776655010000000200000003000000040000005c000000410016040000", "hex"));
async function tick() { for(let i=0;i<16;i++) await Promise.resolve(); await new Promise(resolve=>setTimeout(resolve,2)); }
function fixture() {
    const net = new LanNetwork(Uint8Array.of(2,0,0,1,2,3));
    let ready!: (value: TcpHostLease) => void, pendingSignal: AbortSignal | undefined;
    let releases = 0, lease: TcpHostLease;
    const freshLease = (): TcpHostLease => {
        let live = true;
        let ended!: (value: {code:number;message:string}) => void;
        const closed = new Promise<{code:number;message:string}>(ok => {ended=ok;});
        return {address:{node:allowed[0].slice(),port:2309},allowedNodes:allowed,
            isLive:()=>live,closed,release(){if(live){live=false;releases++;ended({code:10054,message:"closed"});}}};
    };
    const sent: Uint8Array[] = [];
    const transport: NetTransport = {connected:true,close(){},send(frame){sent.push(frame.slice());return true;},
        openTcpHost(_request,signal){pendingSignal=signal;return new Promise(ok=>{ready=ok;});}};
    net.attach(transport);
    net.configureGatewayAddresses([[192,0,2,1]]);
    net.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    net.configureWinsock({provider:"native",hostListener:"game"});
    const table = new WsaSocketTable(net);
    const request = {applicationGuid:new Uint8Array(16),flags:0,destination:{...ipv4Address(Uint8Array.of(192,0,2,1),47624),node:Uint8Array.of(2,1,192,0,2,1)},timeoutMs:30,maxFrameBytes:1024};
    return {net,table,request,sent, ready:()=>{lease=freshLease();ready(lease);},release:()=>lease.release(),releases:()=>releases,signal:()=>pendingSignal};
}
test("listener READY precedes unicast request, fragmented TCP reply and teardown",async()=>{
    const f=fixture(), result=discoverNativeSessions(f.table,f.request);
    expect(f.sent).toHaveLength(0);
    f.ready(); await tick();
    const udp=f.sent.map(decodeDatagram).find(frame=>frame?.proto===PROTO_UDP)!;
    expect(udp).toBeDefined();
    expect([...udp.payload.slice(4,12)]).toEqual([2,0,9,5,127,0,0,1]);
    const tcpPort=f.table.get(0x10000000).local!.port;
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,tcpPort,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
    await tick();
    const child=f.table.get(0x10000002), wire=child.wireId;
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,tcpPort,4000,encodeTcpFrame(DATA,88,wire,0,literal.subarray(0,40))));
    await tick();
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,tcpPort,4000,encodeTcpFrame(DATA,88,wire,0,literal.subarray(40))));
    const replies=await result;
    expect(replies).toHaveLength(1);
    expect(replies[0].name).toBe("AЖ");
    expect(f.releases()).toBe(1);
    expect(f.table.isValid(child.id)).toBe(false);
    f.table.reset();
});
test("cancel while opening aborts exact listener; late READY is released",async()=>{
    const f=fixture(), controller=new AbortController();
    const result=discoverNativeSessions(f.table,{...f.request,signal:controller.signal});
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(f.signal()?.aborted).toBe(true);
    f.ready(); await tick();
    expect(f.releases()).toBe(1);
    expect(f.sent).toHaveLength(0);
    f.table.reset();
});
test("revoked READY ends discovery and does not publish success",async()=>{
    const f=fixture(), result=discoverNativeSessions(f.table,f.request);
    f.ready(); await tick();
    f.release();
    await expect(result).rejects.toThrow("retired");
    expect(f.releases()).toBe(1);
    f.table.reset();
});
test("timeout before READY cannot report successful discovery",async()=>{
    const f=fixture();
    await expect(discoverNativeSessions(f.table,{...f.request,timeoutMs:5})).rejects.toThrow("before send");
    expect(f.signal()?.aborted).toBe(true);
    f.ready(); await tick();
    expect(f.releases()).toBe(1);
    f.table.reset();
});

test("READY getter copies address and fences the original socket and lease",async()=>{
    const f=fixture(), result=discoverNativeSessions(f.table,f.request);
    f.ready(); await tick();
    const snapshot=f.table.nativeListenerSnapshot(0x10000000)!;
    expect(f.table.nativeListenerCurrent(0x10000000,snapshot.ownerToken)).toBe(true);
    snapshot.address.node[2]=9;
    expect(f.table.nativeListenerSnapshot(0x10000000)?.address.node[2]).toBe(127);
    f.table.closesocket(0x10000000);
    expect(f.table.nativeListenerCurrent(0x10000000,snapshot.ownerToken)).toBe(false);
    await expect(result).rejects.toThrow();
    expect(f.releases()).toBe(1);
    f.table.reset();
});
test("pending operation captures caller input before async READY",async()=>{
    const f=fixture(), controller=new AbortController();
    const request={...f.request,signal:controller.signal};
    const result=discoverNativeSessions(f.table,request);
    request.flags=9; request.maxFrameBytes=112; request.applicationGuid.fill(0xaa);
    request.destination.ip!.fill(0); request.destination.node.fill(0);
    f.ready(); await tick();
    const udp=f.sent.map(decodeDatagram).find(frame=>frame?.proto===PROTO_UDP)!;
    expect([...udp.payload.slice(28,44)]).toEqual([...new Uint8Array(16)]);
    expect([...udp.payload.slice(48,52)]).toEqual([0,0,0,0]);
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    f.table.reset();
});


test("oversize partial frame retires only that child and does not publish",async()=>{
    const f=fixture(), result=discoverNativeSessions(f.table,{...f.request,maxFrameBytes:128});
    f.ready(); await tick();
    const port=f.table.get(0x10000000).local!.port;
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
    await tick();
    const child=f.table.get(0x10000002);
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,port,4000,encodeTcpFrame(DATA,88,child.wireId,0,Uint8Array.of(129,0,176,250))));
    await tick();
    expect(f.table.isValid(child.id)).toBe(false);
    expect(await result).toEqual([]);
    f.table.reset();
});

test("actor snapshots follow alias, process epoch and physical owner across duplicates",async()=>{
    const f=fixture(), kernel=new WsaActorKernel(f.table);
    const a={pid:1,slot:1,epoch:1}, b={pid:2,slot:2,epoch:1};
    kernel.register(a); kernel.register(b);
    const first=kernel.execute(a,"socket",[1,2,6]) as number;
    kernel.execute(a,"bind",[first]);
    const second=kernel.execute(a,"duplicate",[first,b.pid]) as number;
    expect(()=>kernel.execute(a,"listen",[first,5,true,1])).toThrow();
    f.ready(); await tick();
    kernel.execute(a,"listen",[first,5,true,1]);
    const snap=kernel.execute(a,"nativeListenerSnapshot",[first]) as {address:{node:number[]};ownerToken:number};
    expect(kernel.execute(b,"nativeListenerCurrent",[second,snap.ownerToken])).toBe(true);
    expect(()=>kernel.execute(b,"nativeListenerSnapshot",[first])).toThrow();
    kernel.drop(a);
    expect(kernel.execute(b,"nativeListenerCurrent",[second,snap.ownerToken])).toBe(true);
    kernel.execute(b,"closesocket",[second]);
    const restarted={pid:1,slot:1,epoch:2}; kernel.register(restarted);
    expect(()=>kernel.execute(a,"nativeListenerCurrent",[first,snap.ownerToken])).toThrow();
    const next=kernel.execute(restarted,"socket",[1,2,6]) as number;
    kernel.execute(restarted,"bind",[next]);
    expect(()=>kernel.execute(restarted,"listen",[next,5,true,1])).toThrow();
    f.ready(); await tick(); kernel.execute(restarted,"listen",[next,5,true,1]);
    const newer=kernel.execute(restarted,"nativeListenerSnapshot",[next]) as {ownerToken:number};
    expect(newer.ownerToken).toBeGreaterThan(snap.ownerToken);
    expect(kernel.execute(restarted,"nativeListenerCurrent",[next,snap.ownerToken])).toBe(false);
    kernel.drop(restarted); kernel.drop(b); f.table.reset();
});

test("identical client operation ids on different aliases cancel independently",async()=>{
    const f=fixture(), kernel=new WsaActorKernel(f.table);
    const a={pid:1,slot:1,epoch:1}, b={pid:2,slot:2,epoch:1};
    kernel.register(a);kernel.register(b);
    const first=kernel.execute(a,"socket",[1,2,6]) as number;
    kernel.execute(a,"bind",[first]);
    const second=kernel.execute(a,"duplicate",[first,b.pid]) as number;
    expect(()=>kernel.execute(a,"listen",[first,5,true,1])).toThrow();
    expect(()=>kernel.execute(b,"listen",[second,5,true,1])).toThrow();
    kernel.execute(a,"cancelListen",[first,1]);
    expect(f.signal()?.aborted).toBe(false);
    f.ready(); await tick();
    expect(kernel.execute(b,"listen",[second,5,true,1])).toBe(0);
    expect(kernel.execute(b,"nativeListenerSnapshot",[second])).toBeDefined();
    kernel.drop(a);kernel.drop(b);f.table.reset();
});
test("accept flood yields to cancellation and closes operation",async()=>{
    const f=fixture(), controller=new AbortController();
    const result=discoverNativeSessions(f.table,{...f.request,timeoutMs:1000,signal:controller.signal});
    f.ready(); await tick();
    const original=f.table.accept.bind(f.table);
    let accepts=0;
    f.table.accept=()=>{accepts++;return f.table.socket(1,2,6);};
    const notify=f.table.socket(2,2,17);f.table.closesocket(notify);
    setTimeout(()=>controller.abort(),10);
    await expect(result).rejects.toThrow("cancelled");
    expect(accepts).toBeGreaterThan(0);
    expect(f.releases()).toBe(1);
    f.table.accept=original;f.table.reset();
});
