import {expect,test} from "bun:test";
import {LanNetwork, type NetTransport} from "../../src/worker/net/lan-network";
import {encodeDatagram, encodeTcpFrame, PROTO_TCP, SYN, DATA, TCP_WINDOW} from "../../src/worker/net/netplay-wire";
import {WsaSocketTable, WsaFailure, WSA, ipv4Address} from "../../src/worker/modules/wsa-network";
import {makeNetworkSocketExports} from "../../src/worker/modules/wsa-network-api";
import {WsaActorKernel} from "../../src/worker/modules/wsa-actor-kernel";
import type {TcpHostLease} from "../../src/worker/net/tcp-host-lease-rpc";

const allowed = [[2,1,127,0,0,1]];
async function tick() { for (let i=0;i<8;i++) await Promise.resolve(); }
function fixture(onOpen?: () => void) {
    const net = new LanNetwork(Uint8Array.of(2,0,0,1,2,3));
    const requests: Array<{request: any; signal?: AbortSignal}> = [];
    const sent: Uint8Array[] = [];
    let resolve!: (value: TcpHostLease) => void, reject!: (error: Error) => void;
    const transport: NetTransport = {
        connected:true, send(frame){sent.push(frame.slice());return true;}, close(){},
        openTcpHost(request,signal) { requests.push({request,signal}); onOpen?.(); return new Promise((ok,no)=>{resolve=ok;reject=no;}); },
    };
    net.attach(transport);
    net.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    net.configureWinsock({provider:"native",hostListener:"game"});
    const table = new WsaSocketTable(net);
    const sid = table.socket(1,2,6);
    table.bind(sid,ipv4Address(net.ipv4,2302));
    let errors = 0, releases = 0, live = true;
    let ended!: (value:{code:number;message:string}) => void;
    const closed = new Promise<{code:number;message:string}>(ok=>{ended=ok;});
    const lease:TcpHostLease = {address:{node:[2,1,127,0,0,1],port:47624},allowedNodes:allowed,
        isLive:()=>live, closed, release(){if(!live)return;live=false;releases++;ended({code:10054,message:"released"});}};
    const api = makeNetworkSocketExports(table, code=>{errors=code;}, {started:true}, ()=>0);
    const callListen = () => api.listen({} as never,new Uint8Array(0),[sid,5]);
    return {net, table, sid, requests, sent, lease, callListen, ready:()=>resolve(lease), fail:(code:number)=>reject(Object.assign(new Error("failed"),{code})),
        releases:()=>releases, error:()=>errors};
}
test("native listen completes only after READY and keeps accepted child after listener closes",async()=>{
    const f=fixture();
    const result=f.callListen();
    expect(result).toBeInstanceOf(Promise);
    expect(f.table.get(f.sid).state).toBe("new");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].request).toMatchObject({proto:2,localPort:2302,listenerId:"game"});
    f.ready(); await tick();
    expect((await result as any).value).toBe(0);
    expect(f.table.get(f.sid).state).toBe("listening");
    const source=Uint8Array.from(allowed[0]);
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,2302,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
    const child=f.table.accept(f.sid), wire=f.table.get(child).wireId;
    f.table.closesocket(f.sid);
    expect(f.releases()).toBe(1);
    expect(f.table.isValid(child)).toBe(true);
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,2302,4000,encodeTcpFrame(DATA,88,wire,0,Uint8Array.of(9))));
    expect([...f.table.receive(child,1).data]).toEqual([9]);
    f.table.reset();
});
test("native listen reports rejection and releases late READY after cancellation",async()=>{
    const f=fixture(), pending=f.callListen();
    f.fail(10048);
    expect((await pending as any).value).toBe(-1);
    expect(f.error()).toBe(10048);
    f.table.reset();
    const g=fixture(), old=g.callListen();
    g.table.closesocket(g.sid);
    g.ready(); await tick();
    expect((await old as any).value).toBe(-1);
    expect(g.releases()).toBe(1);
    expect(g.requests[0].signal?.aborted).toBe(true);
    g.table.reset();
});
test("native listener bounds waiters without disrupting existing operations",()=>{
    const f=fixture();
    const issue=(id:number)=>{ try { f.table.listen(f.sid,5,true,id); throw new Error("unexpected success"); }
        catch(error) { expect(error).toBeInstanceOf(WsaFailure); return (error as WsaFailure).code; } };
    for(let id=1;id<=128;id++) expect(issue(id)).toBe(WSA.EWOULDBLOCK);
    expect(issue(129)).toBe(WSA.ENOBUFS);
    expect(issue(1)).toBe(WSA.EWOULDBLOCK);
    expect(f.requests).toHaveLength(1);
    for(let id=1;id<128;id++) f.table.cancelListen(f.sid,id);
    expect(f.requests[0].signal?.aborted).toBe(false);
    f.table.cancelListen(f.sid,128);
    expect(f.requests[0].signal?.aborted).toBe(true);
    f.table.reset();
});
test("one cancelled listen does not cancel a concurrent waiter",async()=>{
    const f=fixture(), first=new AbortController(), second=new AbortController();
    const a=f.table.withBlockingSignal(first.signal,()=>f.callListen()) as Promise<any>;
    const b=f.table.withBlockingSignal(second.signal,()=>f.callListen()) as Promise<any>;
    expect(f.requests).toHaveLength(1);
    first.abort();
    expect((await a).value).toBe(-1);
    expect(f.requests[0].signal?.aborted).toBe(false);
    f.ready(); await tick();
    expect((await b).value).toBe(0);
    expect(f.releases()).toBe(0);
    f.table.closesocket(f.sid);
    expect(f.releases()).toBe(1);
    f.table.reset();
});
test("closing one actor alias retires only its own pending listen",async()=>{
    const f=fixture(), kernel=new WsaActorKernel(f.table);
    const a={pid:1,slot:1,epoch:1}, b={pid:2,slot:2,epoch:1};
    kernel.register(a); kernel.register(b);
    const first=kernel.execute(a,"socket",[1,2,6]) as number;
    kernel.execute(a,"bind",[first,ipv4Address(f.net.ipv4,2303)]);
    const second=kernel.execute(a,"duplicate",[first,b.pid]) as number;
    expect(()=>kernel.execute(a,"listen",[first,5,true,11])).toThrow(WsaFailure);
    expect(()=>kernel.execute(b,"listen",[second,5,true,22])).toThrow(WsaFailure);
    expect(f.requests).toHaveLength(1);
    kernel.execute(a,"closesocket",[first]);
    expect(f.requests[0].signal?.aborted).toBe(false);
    f.ready(); await tick();
    expect(kernel.execute(b,"listen",[second,5,true,22])).toBe(0);
    kernel.execute(b,"closesocket",[second]);
    expect(f.releases()).toBe(1);
    f.table.reset();
});
test("READY then SYN then cancelled uncommitted listen closes pending child",async()=>{
    const f=fixture();
    expect(()=>f.table.listen(f.sid,5,true,11)).toThrow(WsaFailure);
    f.ready(); await tick();
    const source=Uint8Array.from(allowed[0]);
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,2302,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
    const pending=f.table.get(f.sid).pending.slice();
    expect(pending).toHaveLength(1);
    f.table.cancelListen(f.sid,11);
    expect(f.table.isValid(pending[0])).toBe(false);
    expect(f.table.get(f.sid).pending).toHaveLength(0);
    expect(f.table.get(f.sid).state).toBe("new");
    expect(f.releases()).toBe(1);
    f.table.reset();
});
test("once another listen succeeds cancellation does not retire backlog",async()=>{
    const f=fixture();
    expect(()=>f.table.listen(f.sid,5,true,11)).toThrow(WsaFailure);
    expect(()=>f.table.listen(f.sid,5,true,22)).toThrow(WsaFailure);
    f.ready(); await tick();
    expect(f.table.listen(f.sid,5,true,22)).toBe(0);
    const source=Uint8Array.from(allowed[0]);
    f.net.receiveFrame(encodeDatagram(PROTO_TCP,source,2302,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW)));
    const pending=f.table.get(f.sid).pending.slice();
    f.table.cancelListen(f.sid,11);
    expect(f.releases()).toBe(0);
    expect(f.table.isValid(pending[0])).toBe(true);
    expect(f.table.accept(f.sid)).toBe(pending[0]);
    f.table.reset();
});
test("reentrant signal abort during native issue removes its waiter",async()=>{
    const controller=new AbortController(), f=fixture(()=>controller.abort());
    expect(f.table.withBlockingSignal(controller.signal,()=>f.callListen())).toBe(-1);
    expect(f.error()).toBe(WSA.EINTR);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].signal?.aborted).toBe(true);
    f.ready(); await tick();
    expect(f.releases()).toBe(1);
    f.table.reset();
});
test("listen cannot succeed after lease loses liveness before closed callback",async()=>{
    const f=fixture(), first=f.callListen();
    f.ready(); await tick();
    expect((await first as any).value).toBe(0);
    f.lease.release();
    expect(f.callListen()).toBe(-1);
    expect(f.error()).toBe(WSA.ENETDOWN);
    expect(f.table.get(f.sid).state).toBe("failed");
    await tick(); f.table.reset();
});
test("policy removal while native open is pending cannot turn waiting listen into virtual success",async()=>{
    const f=fixture(), first=f.callListen();
    expect(first).toBeInstanceOf(Promise);
    f.net.configureWinsock(undefined);
    const second=f.callListen();
    expect(second).toBeInstanceOf(Promise);
    expect(f.requests).toHaveLength(1);
    f.net.attach(null);
    expect((await first as any).value).toBe(-1);
    expect((await second as any).value).toBe(-1);
    expect(f.table.get(f.sid).state).toBe("new");
    f.ready(); await tick();
    expect(f.releases()).toBe(1);
    f.table.reset();
});
test("pre-aborted blocking listen never starts native RPC",()=>{
    const f=fixture(), controller=new AbortController();
    controller.abort();
    expect(f.table.withBlockingSignal(controller.signal,()=>f.callListen())).toBe(-1);
    expect(f.error()).toBe(WSA.EINTR);
    expect(f.requests).toHaveLength(0);
    f.table.reset();
});
test("without native policy virtual listen stays synchronous",()=>{
    const net=new LanNetwork(Uint8Array.of(2,0,0,1,2,4));
    const table=new WsaSocketTable(net), sid=table.socket(1,2,6);
    table.bind(sid,ipv4Address(net.ipv4,2303));
    expect(table.listen(sid)).toBe(0);
    const api = makeNetworkSocketExports(table,()=>{}, {started:true}, ()=>0);
    const controller = new AbortController(); controller.abort();
    expect(table.withBlockingSignal(controller.signal,()=>api.listen({} as never,new Uint8Array(0),[sid,5]))).toBe(0);
    table.reset();
});
