import { afterEach, describe, expect, test } from "bun:test";
import { WsaActorKernel } from "../../src/worker/modules/wsa-actor-kernel";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, FD_READ } from "../../src/worker/modules/wsa-network";
import { LanNetwork } from "../../src/worker/net/lan-network";
import type { WsaActorIdentity, WsaActorNotification } from "../../src/worker/modules/wsa-actor-protocol";
const tables: WsaSocketTable[] = [];
afterEach(() => tables.splice(0).forEach(table => table.reset()));
function fixture() {
    const network = new LanNetwork(Uint8Array.of(2,0,0,1,2,3)), table = new WsaSocketTable(network), kernel = new WsaActorKernel(table); tables.push(table);
    const root:WsaActorIdentity = {pid:1234,slot:0,epoch:1}, child:WsaActorIdentity = {pid:5000,slot:2,epoch:7}, sibling:WsaActorIdentity = {pid:5001,slot:3,epoch:8};
    kernel.register(root); kernel.register(child); kernel.register(sibling);
    const call = (owner:WsaActorIdentity, command:string, args:unknown[]=[]) => kernel.execute(owner,command,args) as any;
    const socket = (owner=root, type=2) => call(owner,"socket",[type,2,type===1?6:17]) as number;
    return {network,table,kernel,root,child,sibling,call,socket,address:ipv4Address(network.ipv4,1234)};
}
function fails(fn:()=>unknown, code:number) { try { fn(); throw Error("expected error"); } catch(error) { expect(error).toBeInstanceOf(WsaFailure); expect((error as WsaFailure).code).toBe(code); } }
describe("durable Winsock socket actor",()=>{
    test("native alias flags remain independent before import and protected closesocket keeps traffic alive",()=>{
        const h=fixture(),source=h.socket(),sender=h.socket(h.sibling);h.call(h.root,"bind",[source,h.address]);
        h.call(h.root,"setHandleFlags",[source,1,0]);const handle=h.call(h.root,"duplicate",[source,h.child.pid]);
        const native=(command:string,args:unknown[])=>h.kernel.execute(h.child,command,args,true) as any;
        expect(native("get",[handle]).handleFlags).toBe(1);expect(h.call(h.root,"get",[source]).handleFlags).toBe(0);
        expect(native("setHandleFlags",[handle,2,2])).toBe(0);expect(native("closesocket",[handle])).toBe(0);
        h.call(h.child,"reset");expect(native("isValid",[handle])).toBe(true);
        h.call(h.sibling,"send",[sender,Uint8Array.of(97),h.address]);expect(native("receive",[handle,1]).data).toEqual(Uint8Array.of(97));
        expect(native("setHandleFlags",[handle,2,0])).toBe(0);expect(native("closesocket",[handle])).toBe(0);
        expect(native("isValid",[handle])).toBe(false);expect(h.call(h.root,"isValid",[source])).toBe(true);
    });
    test("native I/O tokens survive closing their handle without importing or retaining a physical reference",()=>{
        const h=fixture(),source=h.socket(),sender=h.socket(h.sibling);h.call(h.root,"bind",[source,h.address]);
        const handle=h.call(h.root,"duplicate",[source,h.child.pid]);
        const native=(command:string,args:unknown[]=[])=>h.kernel.execute(h.child,command,args,true) as any;
        const objectId=native("fileObjectId",[handle]);
        expect(native("hasFileObject",[objectId])).toBe(true);
        expect(h.kernel.execute(h.sibling,"hasFileObject",[objectId],true)).toBe(false);
        const token=native("acquireNativeIo",[handle]);
        const io=(command:string,args:unknown[]=[handle])=>native("nativeIo",[token,command,args]);
        h.call(h.root,"set",[source,{overlapped:false}]);
        expect(io("get").overlapped).toBe(true); // The issuing alias metadata is captured.
        h.call(h.child,"reset");expect(native("isValid",[handle])).toBe(true);
        expect(native("closesocket",[handle])).toBe(0);expect(native("isValid",[handle])).toBe(false);
        fails(()=>native("get",[handle]),WSA.ENOTSOCK);expect(io("isValid")).toBe(true);
        expect(native("hasFileObject",[objectId])).toBe(false);expect(h.kernel.execute(h.root,"hasFileObject",[objectId],true)).toBe(true);
        const notifications:WsaActorNotification[]=[];h.kernel.attach(h.child,message=>notifications.push(message));
        h.call(h.sibling,"send",[sender,Uint8Array.of(97,98,99),h.address]);
        expect(notifications).toContainEqual({type:"changed"});expect(io("receive",[handle,16]).data).toEqual(Uint8Array.of(97,98,99));
        fails(()=>native("nativeIo",[token,"closesocket",[handle]]),WSA.EINVAL);
        fails(()=>native("nativeIo",[token,"send",[source,Uint8Array.of(1)]]),WSA.ENOTSOCK);
        fails(()=>h.kernel.execute(h.root,"nativeIo",[token,"get",[handle]],true),WSA.ENOTSOCK);
        h.call(h.root,"closesocket",[source]);expect(io("isValid")).toBe(false);
        expect(native("releaseNativeIo",[token])).toBeNull();expect(native("releaseNativeIo",[token])).toBeNull();
        expect(h.call(h.sibling,"bind",[h.socket(h.sibling),h.address])).toBe(0);
    });
    test("scoped extension leases accept into a duplicated target after both issuing handles close",()=>{
        const h=fixture(),listener=h.socket(h.root,1),target=h.socket(h.root,1),client=h.socket(h.sibling,1);
        h.call(h.root,"bind",[listener,h.address]);h.call(h.root,"listen",[listener,4]);
        const rawListener=h.call(h.root,"duplicate",[listener,h.child.pid]),rawTarget=h.call(h.root,"duplicate",[target,h.child.pid]);
        const native=(command:string,args:unknown[])=>h.kernel.execute(h.child,command,args,true) as any;
        const listenerToken=native("acquireNativeIo",[rawListener,"accept"]),targetToken=native("acquireNativeIo",[rawTarget,"acceptTarget"]);
        const io=(token:number,command:string,args:unknown[])=>native("nativeIo",[token,command,args]);
        native("closesocket",[rawListener]);native("closesocket",[rawTarget]);
        h.call(h.sibling,"connect",[client,h.address]);
        expect(io(listenerToken,"acceptInto",[rawListener,targetToken,rawTarget])).toBeNull();
        h.call(h.sibling,"send",[client,Uint8Array.of(97,98,99)]);
        expect(io(targetToken,"receive",[rawTarget,4]).data).toEqual(Uint8Array.of(97,98,99));
        const accepted=h.call(h.root,"get",[target]);
        expect(accepted.acceptListener).toBe(rawListener);
        expect(accepted.acceptListenerObjectId).toBe(h.kernel.execute(h.root,"fileObjectId",[listener],true));
        h.call(h.root,"send",[target,Uint8Array.of(122)]);
        expect(h.call(h.sibling,"receive",[client,1]).data).toEqual(Uint8Array.of(122));
        fails(()=>io(targetToken,"connect",[rawTarget,h.address]),WSA.EINVAL);
        fails(()=>io(listenerToken,"set",[rawListener,{connectExCompleted:true}]),WSA.EINVAL);
        const dataToken=native("acquireNativeIo",[h.call(h.root,"duplicate",[target,h.child.pid])]);
        fails(()=>io(dataToken,"disconnect",[rawTarget,false]),WSA.EINVAL);
        native("releaseNativeIo",[listenerToken]);native("releaseNativeIo",[targetToken]);native("releaseNativeIo",[dataToken]);
        expect(h.call(h.root,"isValid",[listener])).toBe(true);expect(h.call(h.root,"isValid",[target])).toBe(true);
    });
    test("native I/O token bounds, release and PID epoch revocation never create aliases",()=>{
        const h=fixture(),source=h.socket(),handle=h.call(h.root,"duplicate",[source,h.child.pid]),tokens:number[]=[];
        for(let i=0;i<4096;i++)tokens.push(h.kernel.execute(h.child,"acquireNativeIo",[handle],true) as number);
        fails(()=>h.kernel.execute(h.child,"acquireNativeIo",[handle],true),WSA.ENOBUFS);
        h.kernel.execute(h.child,"releaseNativeIo",[tokens.pop()],true);
        expect(h.kernel.execute(h.child,"acquireNativeIo",[handle],true)).toBeGreaterThan(4096);
        h.kernel.drop(h.child);fails(()=>h.kernel.execute(h.child,"nativeIo",[tokens[0],"get",[handle]],true),WSA.EACCES);
        h.call(h.root,"closesocket",[source]);expect((h.kernel as any).references.size).toBe(0);
        h.kernel.register({...h.child,epoch:h.child.epoch+1});
        fails(()=>h.kernel.execute({...h.child,epoch:h.child.epoch+1},"nativeIo",[tokens[0],"get",[handle]],true),WSA.ENOTSOCK);
    });
    test("an unimported target descriptor keeps its binding after source process death and imports repeatedly as the same handle",()=>{
        const h=fixture(),source=h.socket(),sender=h.socket(h.sibling);h.call(h.root,"bind",[source,h.address]);
        const target=h.call(h.root,"duplicate",[source,h.child.pid]);h.kernel.drop(h.root);
        expect(h.call(h.child,"import",[target])).toBe(target);expect(h.call(h.child,"import",[target])).toBe(target);
        const other=h.socket(h.sibling);fails(()=>h.call(h.sibling,"bind",[other,h.address]),WSA.EADDRINUSE);
        h.call(h.sibling,"send",[sender,Uint8Array.of(1,2,3),h.address]);expect(h.call(h.child,"receive",[target,10]).data).toEqual(Uint8Array.of(1,2,3));
        h.call(h.child,"closesocket",[target]);fails(()=>h.call(h.child,"import",[target]),WSA.ENOTSOCK);
        expect(h.call(h.sibling,"bind",[other,h.address])).toBe(0);
    });
    test("WSACleanup preserves an unimported reservation, then closes it after WSASocket imports it",()=>{
        const h=fixture(),source=h.socket(),sender=h.socket(h.sibling);h.call(h.root,"bind",[source,h.address]);
        const reserved=h.call(h.root,"duplicate",[source,h.root.pid]);h.call(h.root,"reset");
        expect(h.call(h.root,"isValid",[source])).toBe(false);expect(h.call(h.root,"isValid",[reserved])).toBe(true);
        const other=h.socket(h.sibling);fails(()=>h.call(h.sibling,"bind",[other,h.address]),WSA.EADDRINUSE);
        expect(h.call(h.root,"import",[reserved])).toBe(reserved);h.call(h.sibling,"send",[sender,Uint8Array.of(1,2,3),h.address]);
        expect(h.call(h.root,"receive",[reserved,8]).data).toEqual(Uint8Array.of(1,2,3));
        h.call(h.root,"reset");expect(h.call(h.root,"isValid",[reserved])).toBe(false);expect(h.call(h.sibling,"bind",[other,h.address])).toBe(0);
        const unimported=h.call(h.sibling,"duplicate",[other,h.root.pid]);h.kernel.drop(h.root);
        fails(()=>h.call(h.root,"import",[unimported]),WSA.EACCES);h.call(h.sibling,"closesocket",[other]);
        expect(h.call(h.sibling,"bind",[h.socket(h.sibling),h.address])).toBe(0);
    });
    test("a Winsock lookup implicitly attaches a reserved descriptor before provider cleanup",()=>{
        const h=fixture(),source=h.socket();h.call(h.root,"bind",[source,h.address]);
        const reserved=h.call(h.root,"duplicate",[source,h.root.pid]);expect(h.call(h.root,"get",[reserved]).local.port).toBe(1234);
        h.call(h.root,"reset");expect(h.call(h.root,"isValid",[reserved])).toBe(false);
        expect(h.call(h.sibling,"bind",[h.socket(h.sibling),h.address])).toBe(0);
    });
    test("duplicate descriptors consume one shared datagram queue while cached options differ and kernel buffer effects remain shared",()=>{
        const h=fixture(),source=h.socket(),sender=h.socket(h.sibling);h.call(h.root,"bind",[source,h.address]);const target=h.call(h.root,"duplicate",[source,h.child.pid]);
        h.call(h.child,"set",[target,{broadcast:true,receiveLimit:2}]);expect(h.call(h.child,"get",[target]).broadcast).toBe(true);expect(h.call(h.root,"get",[source]).broadcast).toBe(false);
        expect(h.call(h.root,"get",[source]).receiveLimit).toBeGreaterThan(2);
        // The native first-packet probe admits a whole packet beyond a tiny window; NT5 drops later arrivals while full.
        h.call(h.sibling,"send",[sender,Uint8Array.of(1,2,3),h.address]);expect(h.call(h.root,"readable",[source])).toBe(true);
        h.call(h.sibling,"send",[sender,Uint8Array.of(7,8,9),h.address]);
        expect(h.call(h.root,"receive",[source,8,2]).data).toEqual(Uint8Array.of(1,2,3));
        expect(h.call(h.child,"receive",[target,8]).data).toEqual(Uint8Array.of(1,2,3));
        fails(()=>h.call(h.root,"receive",[source,8]),WSA.EWOULDBLOCK);
        h.call(h.child,"set",[target,{receiveLimit:8}]);h.call(h.sibling,"send",[sender,Uint8Array.of(4,5,6),h.address]);
        expect(h.call(h.root,"receive",[source,8,2]).data).toEqual(Uint8Array.of(4,5,6));expect(h.call(h.child,"receive",[target,8]).data).toEqual(Uint8Array.of(4,5,6));
        fails(()=>h.call(h.root,"receive",[source,8]),WSA.EWOULDBLOCK);
        h.call(h.child,"setNonBlocking",[target,true]);expect(h.call(h.root,"get",[source]).nonBlocking).toBe(true);
    });
    test("a failed native OOBINLINE option update leaves both shared state and alias metadata unchanged",()=>{
        const h=fixture(),listener=h.socket(h.root,1),client=h.socket(h.sibling,1);
        h.call(h.root,"bind",[listener,h.address]);h.call(h.root,"listen",[listener,4]);h.call(h.sibling,"connect",[client,h.address]);
        const accepted=h.call(h.root,"accept",[listener]),duplicate=h.call(h.root,"duplicate",[accepted,h.child.pid]);
        const send=h.network.send.bind(h.network);h.network.send=()=>false;
        fails(()=>h.call(h.root,"setOobInline",[accepted,true]),WSA.ENETDOWN);
        expect(h.call(h.root,"get",[accepted]).oobInline).toBe(false);expect(h.call(h.child,"get",[duplicate]).oobInline).toBe(false);
        h.network.send=send;h.call(h.root,"setOobInline",[accepted,true]);
        expect(h.call(h.root,"get",[accepted]).oobInline).toBe(true);
        h.call(h.sibling,"send",[client,Uint8Array.of(7),undefined,1]);expect(h.call(h.root,"receive",[accepted,8]).data).toEqual(Uint8Array.of(7));
    });
    test("KEEPALIVE and NODELAY are shared physical options across duplicated descriptors",()=>{
        const h=fixture(),source=h.socket(h.root,1),target=h.call(h.root,"duplicate",[source,h.child.pid]);
        expect(h.call(h.root,"get",[source]).keepAlive).toBe(false);expect(h.call(h.child,"get",[target]).noDelay).toBe(false);
        h.call(h.child,"setKeepAlive",[target,true]);h.call(h.child,"setNoDelay",[target,true]);
        expect(h.call(h.root,"get",[source]).keepAlive).toBe(true);expect(h.call(h.root,"get",[source]).noDelay).toBe(true);
        h.call(h.root,"setKeepAlive",[source,false]);h.call(h.root,"setNoDelay",[source,false]);
        expect(h.call(h.child,"get",[target]).keepAlive).toBe(false);expect(h.call(h.child,"get",[target]).noDelay).toBe(false);
    });
    test("target PID/slot/epoch authentication rejects stale and foreign descriptors without changing their owners",()=>{
        const h=fixture(),source=h.socket(),target=h.call(h.root,"duplicate",[source,h.child.pid]);
        fails(()=>h.call({...h.child,epoch:6},"get",[target]),WSA.EACCES);fails(()=>h.call(h.sibling,"get",[target]),WSA.ENOTSOCK);
        fails(()=>h.call(h.root,"duplicate",[source,0]),WSA.EINVAL);h.kernel.drop({...h.child,epoch:6});expect(h.call(h.child,"isValid",[target])).toBe(true);
        h.kernel.reconcile([h.root,h.sibling]);fails(()=>h.call(h.child,"get",[target]),WSA.EACCES);expect(h.call(h.root,"isValid",[source])).toBe(true);
    });
    test("a duplicated listener and its accepted stream survive their original process and share stream shutdown",()=>{
        const h=fixture(),listener=h.socket(h.root,1);h.call(h.root,"bind",[listener,h.address]);h.call(h.root,"listen",[listener,4]);
        const inherited=h.call(h.root,"duplicate",[listener,h.child.pid]);h.kernel.drop(h.root);
        const client=h.socket(h.sibling,1);expect(h.call(h.sibling,"connect",[client,h.address])).toBe(0);const accepted=h.call(h.child,"accept",[inherited]);
        const alias=h.call(h.child,"duplicate",[accepted,h.sibling.pid]);h.call(h.sibling,"send",[client,Uint8Array.of(7,8,9)]);
        expect(h.call(h.child,"receive",[accepted,1]).data).toEqual(Uint8Array.of(7));expect(h.call(h.sibling,"receive",[alias,2]).data).toEqual(Uint8Array.of(8,9));
        h.kernel.drop(h.child);expect(h.call(h.sibling,"send",[alias,Uint8Array.of(3)])).toBe(1);expect(h.call(h.sibling,"receive",[client,1]).data).toEqual(Uint8Array.of(3));
        h.call(h.sibling,"shutdown",[alias,1]);expect(h.call(h.sibling,"receive",[client,1]).data.length).toBe(0);
    });
    test("shared event selection replaces the prior owner and sends the importing process its own descriptor",()=>{
        const h=fixture(),source=h.socket(),root:WsaActorNotification[]=[],child:WsaActorNotification[]=[];h.kernel.attach(h.root,e=>root.push(e));h.kernel.attach(h.child,e=>child.push(e));
        h.call(h.root,"bind",[source,h.address]);const target=h.call(h.root,"duplicate",[source,h.child.pid]);h.call(h.root,"configureEvents",[source,FD_READ]);h.call(h.child,"configureEvents",[target,FD_READ]);
        h.call(h.sibling,"send",[h.socket(h.sibling),Uint8Array.of(1),h.address]);expect(root.filter(e=>e.type==="event")).toEqual([]);
        expect(child.filter(e=>e.type==="event")).toEqual([{type:"event",socket:target,bit:FD_READ,error:0}]);
    });
    test("AcceptEx adoption preserves already duplicated references to the accepted physical stream",()=>{
        const h=fixture(),listener=h.socket(h.root,1),client=h.socket(h.sibling,1);h.call(h.root,"bind",[listener,h.address]);h.call(h.root,"listen",[listener,4]);h.call(h.sibling,"connect",[client,h.address]);
        const accepted=h.call(h.root,"accept",[listener]),duplicate=h.call(h.root,"duplicate",[accepted,h.child.pid]),target=h.socket(h.root,1);
        h.call(h.root,"adoptAccepted",[target,accepted]);expect(h.call(h.root,"isValid",[accepted])).toBe(false);
        h.call(h.sibling,"send",[client,Uint8Array.of(1,2)]);expect(h.call(h.child,"receive",[duplicate,1]).data).toEqual(Uint8Array.of(1));expect(h.call(h.root,"receive",[target,1]).data).toEqual(Uint8Array.of(2));
        h.kernel.drop(h.root);expect(h.call(h.child,"send",[duplicate,Uint8Array.of(9)])).toBe(1);
    });
});
