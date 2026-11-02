import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {decodeDirectPlay4PlayerTcpFrame} from "../../src/worker/modules/dplayx/native-wire/player-tcp";
import {encodeDirectPlay4DestroyPlayer} from "../../src/worker/modules/dplayx/native-wire/destroy-player";
import {DirectPlay4NativeSession,type DirectPlay4NativeSessionDriver} from "../../src/worker/modules/dplayx/native-wire/native-session";
import type {DirectPlay4JoinHandshakeResult,DirectPlay4JoinSessionOwner} from "../../src/worker/modules/dplayx/native-wire/join-handshake";
import type {DirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";
import type {DirectPlay4JoinUdpListener} from "../../src/worker/modules/dplayx/native-wire/join-udp-listener";
const nativeCreateFixture=JSON.parse(readFileSync(new URL("./fixtures/dp4-native-pending-create.json",import.meta.url),"utf8"));
function nativeCreate(id:number,system=6){const b=Uint8Array.from(nativeCreateFixture.bytes as number[]),v=new DataView(b.buffer);v.setUint32(12,id,true);v.setUint32(36,id,true);v.setUint32(60,system,true);return b;}
const entry={id:1,flags:1,fixedSize:16,versionOrSystemId:14,version:14,parentId:0,shortName:null,longName:null,spData:new Uint8Array(),playerData:new Uint8Array(),memberIds:[]};
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const peer={family:2,node:Uint8Array.of(2,1,1,2,3,4),ip:Uint8Array.of(1,2,3,4),port:2000};
const player=(from:number,to:number,data=Uint8Array.of(4,5))=>({consumed:30,providerSockaddr:new Uint8Array(16),from,to,data});
function fixture(){
 let tcpClosed=0,udpClosed=0,leaseClosed=0,cancelled=0,transferred=false,owner:DirectPlay4JoinSessionOwner|undefined;
 let holdCreate:Promise<void>|undefined,holdDestroy:Promise<void>|undefined,holdSend:Promise<void>|undefined,nextId=3;const destroyed:number[]=[],sent:Uint8Array[]=[];
 const tcp={socket:1,ownerToken:1,address:{node:[2,1,1,2,3,4],port:1},current:()=>true,release(){if(!tcpClosed)tcpClosed++;}} as DirectPlay4JoinListener;
 const udp={socket:2,physical:2,binding:1,address:{node:[2,1,1,2,3,4],port:2},allowedNodes:[],current:()=>true,release(){if(!udpClosed)udpClosed++;}} as DirectPlay4JoinUdpListener;
 const leaseAbort=new AbortController();
 const result:DirectPlay4JoinHandshakeResult={playerId:1,table:{command:41,version:14,sessionDescription:new Uint8Array(80),name:null,password:null,players:[entry,{...entry,id:2,flags:0}],groups:[],shortcuts:[]},
  cancel(){cancelled++;tcp.release();udp.release();},
  transfer(o){owner=o;transferred=true;return {signal:leaseAbort.signal,version:14,systemPlayerId:1,tcpSockaddr:new Uint8Array(16),udpSockaddr:new Uint8Array(16),
   current:()=>true,send:async(frame)=>{if(new DataView(frame.buffer,frame.byteOffset,frame.byteLength).getUint16(24,true)===5){
    const message=new Uint8Array(48),v=new DataView(message.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,7,true);v.setUint16(6,14,true);v.setUint32(8,nextId++,true);
    queueMicrotask(()=>owner?.onFrame({consumed:68,command:7,version:14,providerSockaddr:new Uint8Array(16),message},peer));
   }else if(new DataView(frame.buffer,frame.byteOffset,frame.byteLength).getUint16(24,true)===11){destroyed.push(new DataView(frame.buffer,frame.byteOffset,frame.byteLength).getUint32(32,true));if(holdDestroy)await holdDestroy;}else if(holdCreate)await holdCreate;},sendPlayer:async(frame)=>{sent.push(Uint8Array.from(frame));if(holdSend)await holdSend;},release(){if(!leaseClosed){leaseClosed++;leaseAbort.abort();tcp.release();udp.release();}}};}};
 const driver:DirectPlay4NativeSessionDriver={acquireTcp:async()=>tcp,acquireUdp:async()=>udp,handshake:async()=>result};
 const events={authorizePlayer:()=>true,authorizeHost:(_id:number)=>true,authorizeSystem:(_id:number,_peer:any)=>true,onSystem:()=>{},onPlayer:()=>{},onFailure:()=>{}};
 return {driver,events,tcp,udp,result,hold:(p:Promise<void>)=>{holdCreate=p;},holdDestroy:(p:Promise<void>)=>{holdDestroy=p;},holdSend:(p:Promise<void>)=>{holdSend=p;},abortLease:()=>leaseAbort.abort(),destroyed,sent,counts:()=>[tcpClosed,udpClosed,leaseClosed,cancelled],getOwner:()=>owner,getTransferred:()=>transferred};
}
test("frames delivered during lease transfer are published after activation in FIFO order",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:number[]=[];
 f.events.onSystem=(frame:any)=>{seen.push(frame.command);if(frame.command===10)f.getOwner()!.onFrame({consumed:28,command:13,version:14,providerSockaddr:new Uint8Array(16),message:new Uint8Array(8)},peer);};
 f.result.transfer=o=>{
  const lease=transfer(o);
  const first={consumed:28,command:10,version:14,providerSockaddr:new Uint8Array(16),message:new Uint8Array(8)};
  o.onFrame(first,peer);
  o.onFrame({consumed:28,command:12,version:14,providerSockaddr:new Uint8Array(16),message:new Uint8Array(8)},peer);
  first.command=99;
  return lease;
 };
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await session.open();expect(seen).toEqual([10,12,13]);session.close();expect(f.counts()).toEqual([1,1,1,0]);
});

test("owner reentry cannot overtake the transfer frame being reserved",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:number[]=[];let reenter=false;
 f.events.onSystem=(frame:any)=>{seen.push(frame.command);};
 f.result.transfer=o=>{const lease=transfer(o);reenter=true;o.onFrame({consumed:28,command:10,version:14,providerSockaddr:new Uint8Array(16),message:new Uint8Array(8)},peer);return lease;};
 const session=new DirectPlay4NativeSession(f.driver,()=>{
  if(reenter){reenter=false;f.getOwner()!.onFrame({consumed:28,command:12,version:14,providerSockaddr:new Uint8Array(16),message:new Uint8Array(8)},peer);}return true;
 },f.events);
 await session.open();expect(seen).toEqual([10,12]);session.close();
});

test("retirement while draining transfer frames cancels publication and releases the lease",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:number[]=[];
 f.result.transfer=o=>{const lease=transfer(o);for(const command of [10,12])o.onFrame({consumed:28,command,version:14,providerSockaddr:new Uint8Array(16),message:new Uint8Array(8)},peer);return lease;};
 let session!:DirectPlay4NativeSession;
 f.events.onSystem=(frame:any)=>{seen.push(frame.command);session.close();};
 session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow("retired");expect(seen).toEqual([10]);expect(f.counts()).toEqual([1,1,1,0]);
});

test("transfer frame queue is bounded and a failed transfer retires its resources",async()=>{
 const f=fixture(),transfer=f.result.transfer;
 f.result.transfer=o=>{const lease=transfer(o);try{for(let i=0;i<257;i++)o.onFrame({consumed:28,command:11,version:14,providerSockaddr:new Uint8Array(16),message:new Uint8Array(8)},peer);return lease;}catch(error){lease.release();throw error;}};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow("queue full");expect(f.counts()).toEqual([1,1,1,1]);
});

test("native retirement releases resources before notifying its owner exactly once",async()=>{
 const f=fixture();let calls=0,atNotification:number[]=[];
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events,undefined,()=>{calls++;atNotification=f.counts();session.close();});
 await session.open();session.close();session.close();expect(calls).toBe(1);expect(atNotification).toEqual([1,1,1,0]);
});
test("owner abort synchronously retires an active native session and its resources",async()=>{
 const f=fixture(),owner=new AbortController(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events,owner.signal);
 await session.open();owner.abort();
 expect(f.counts()).toEqual([1,1,1,0]);expect(()=>session.nameTable()).toThrow();
 session.close();expect(f.counts()).toEqual([1,1,1,0]);
 const retired=new AbortController();retired.abort();
 const other=new DirectPlay4NativeSession(f.driver,()=>true,f.events,retired.signal);
 await expect(other.open()).rejects.toThrow();
});
test("stages real identities before exact session lease ownership, closes once",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events),snapshot=await session.open();
 expect(snapshot.players[0].preexisting).toBe(true);expect(f.getTransferred()).toBe(true);expect(f.counts()).toEqual([0,0,0,0]);
 session.close();session.close();expect(f.counts()).toEqual([1,1,1,0]);await expect(session.open()).rejects.toThrow();
});
test("session player creation and bounded receive support filters, peek and owned copies",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 expect(await session.createPlayer({shortName:"x",longName:null,data:new Uint8Array()})).toEqual({playerId:3,submission:"submitted"});
 f.getOwner()!.onPlayerFrame!(player(99,3),peer);f.getOwner()!.onPlayerFrame!(player(2,99),peer);f.getOwner()!.onPlayerFrame!(player(2,1),peer);f.getOwner()!.onPlayerFrame!(player(3,3),peer);
 expect(session.receive()).toBeUndefined();
 const raw=player(2,3);f.getOwner()!.onPlayerFrame!(raw,peer);raw.data.fill(0);
 expect(session.receive(9,3)).toBeUndefined();const peek=session.receive(2,3,true)!;expect([...peek.data]).toEqual([4,5]);peek.data.fill(0);
 expect([...session.receive(2,3)!.data]).toEqual([4,5]);expect(session.receive()).toBeUndefined();session.close();expect(()=>session.receive()).toThrow();
});
test("definite invalid create leaves active session and subsequent creation intact",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:"valid",longName:null,data:new Uint8Array()});
 await expect(session.createPlayer({shortName:"bad\0name",longName:null,data:new Uint8Array()})).rejects.toThrow();
 f.getOwner()!.onPlayerFrame!(player(2,3),peer);expect([...session.receive()!.data]).toEqual([4,5]);
 expect((await session.createPlayer({shortName:"next",longName:null,data:new Uint8Array()})).playerId).toBe(4);
 expect(f.counts()).toEqual([0,0,0,0]);session.close();
});
test("reentrant authorization preserves bounded ingress FIFO",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});let entered=false;
 f.events.authorizePlayer=()=>{if(!entered){entered=true;f.getOwner()!.onPlayerFrame!(player(2,3,Uint8Array.of(2)),peer);}return true;};
 f.getOwner()!.onPlayerFrame!(player(2,3,Uint8Array.of(1)),peer);
 expect([...session.receive()!.data]).toEqual([1]);expect([...session.receive()!.data]).toEqual([2]);session.close();
});
test("early data waits for player publication and keeps FIFO",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();const gate=deferred<void>();f.hold(gate.promise);
 let published=0,seenPublished=0;f.events.onPlayer=()=>{seenPublished=published;};
 const creating=session.createPlayer({shortName:null,longName:null,data:new Uint8Array()},result=>{published=result.playerId;});await new Promise(resolve=>setTimeout(resolve,5));
 f.getOwner()!.onPlayerFrame!(player(2,3,Uint8Array.of(7)),peer);expect(session.receive()).toBeUndefined();
 gate.resolve();expect((await creating).playerId).toBe(3);expect(seenPublished).toBe(3);expect([...session.receive()!.data]).toEqual([7]);session.close();
});
test("reentrant guest publication retirement closes the exact native player owner",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await expect(session.createPlayer({shortName:null,longName:null,data:new Uint8Array()},()=>session.close())).rejects.toThrow("retired");
 expect(f.counts()).toEqual([1,1,1,0]);expect(()=>session.receive()).toThrow();
});
test("receive cap and defensive authorization copies",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 f.events.authorizePlayer=(frame:any)=>{frame.from=99;frame.data.fill(0);return true;};
 for(let i=0;i<256;i++)f.getOwner()!.onPlayerFrame!(player(2,3),peer);
 expect(()=>f.getOwner()!.onPlayerFrame!(player(2,3),peer)).toThrow("queue full");
 expect([...session.receive()!.data]).toEqual([4,5]);session.close();
});
test("reentrant authorization close prevents delivery",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 f.events.authorizePlayer=()=>{session.close();return true;};
 expect(()=>f.getOwner()!.onPlayerFrame!(player(2,3),peer)).toThrow();expect(f.counts()).toEqual([1,1,1,0]);
});
test("late acquired resource after close is retired without starting subsequent operations",async()=>{
 const f=fixture(),late=deferred<DirectPlay4JoinListener>();let udpCalls=0;
 f.driver.acquireTcp=()=>late.promise;f.driver.acquireUdp=async()=>{udpCalls++;return f.udp;};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events),opening=session.open();session.close();late.resolve(f.tcp);
 await expect(opening).rejects.toThrow();expect(udpCalls).toBe(0);expect(f.counts()).toEqual([1,0,0,0]);
});
test("late handshake is cancelled after close; no publication",async()=>{
 const f=fixture(),late=deferred<DirectPlay4JoinHandshakeResult>();f.driver.handshake=()=>late.promise;
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events),opening=session.open();
 await new Promise(resolve=>setTimeout(resolve,5));session.close();late.resolve(f.result);
 await expect(opening).rejects.toThrow();expect(f.getTransferred()).toBe(false);expect(f.counts()).toEqual([1,1,0,1]);
});
test("reentrant retirement while owner liveness is checked prevents publication",async()=>{
 const f=fixture();let session!:DirectPlay4NativeSession,calls=0;
 session=new DirectPlay4NativeSession(f.driver,()=>{calls++;if(calls===4)session.close();return true;},f.events);
 await expect(session.open()).rejects.toThrow();expect(f.getTransferred()).toBe(false);expect(f.counts()[0]).toBe(1);
});
test("native send uses the explicitly authorized host and snapshots caller data",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const bytes=Uint8Array.of(4,5,6),gate=deferred<void>();f.holdSend(gate.promise);
 const pending=session.sendToHost(3,2,bytes);bytes.fill(0);await Promise.resolve();await Promise.resolve();
 expect(f.sent.length).toBe(1);const wire=decodeDirectPlay4PlayerTcpFrame(f.sent[0],65536)!;
 expect([wire.from,wire.to,...wire.data]).toEqual([3,2,4,5,6]);
 await expect(session.destroyPlayer(3)).rejects.toThrow();gate.resolve();
 expect(await pending).toEqual({submission:"submitted"});session.close();
});
test("native send rejects system, local, unknown, unapproved or malformed destinations before mutation",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 for(const [from,to] of [[1,2],[3,1],[3,3],[3,99],[99,2]])await expect(session.sendToHost(from,to,Uint8Array.of(1))).rejects.toThrow();
 f.events.authorizeHost=()=>false;await expect(session.sendToHost(3,2,Uint8Array.of(1))).rejects.toThrow();
 await expect(session.sendToHost(3,2,new Uint8Array(60001))).rejects.toThrow();
 expect(f.sent).toEqual([]);expect(f.counts()).toEqual([0,0,0,0]);session.close();
});
test("native send cancellation and uncertain submission retire the exact session",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const gate=deferred<void>();f.holdSend(gate.promise);const pending=session.sendToHost(3,2,Uint8Array.of(1));
 await Promise.resolve();await Promise.resolve();f.abortLease();await expect(pending).rejects.toThrow();gate.resolve();
 expect(f.counts()).toEqual([1,1,1,0]);expect(()=>session.receive()).toThrow();
});
test("native send reserves before reentrant authorization and rejects overlapping sends",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 let nested:Promise<unknown>|undefined;
 f.events.authorizeHost=()=>{nested??=session.sendToHost(3,2,Uint8Array.of(2));return true;};
 expect(await session.sendToHost(3,2,Uint8Array.of(1))).toEqual({submission:"submitted"});
 await expect(nested!).rejects.toThrow();expect(f.sent.length).toBe(1);session.close();
});
test("native send retires session if authorization is revoked while submission is pending",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const gate=deferred<void>();f.holdSend(gate.promise);const pending=session.sendToHost(3,2,Uint8Array.of(1));
 await Promise.resolve();await Promise.resolve();f.events.authorizeHost=()=>false;gate.resolve();
 await expect(pending).rejects.toThrow();expect(f.counts()).toEqual([1,1,1,0]);
});
test("native send retires session when its channel rejects after submission starts",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const fail=Promise.reject(new Error("send failed"));void fail.catch(()=>{});f.holdSend(fail);
 await expect(session.sendToHost(3,2,Uint8Array.of(1))).rejects.toThrow("send failed");
 expect(f.counts()).toEqual([1,1,1,0]);
});
test("native send reentrant authorization can retire owner without sending",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 f.events.authorizeHost=()=>{session.close();return true;};
 await expect(session.sendToHost(3,2,Uint8Array.of(1))).rejects.toThrow();
 expect(f.sent).toEqual([]);expect(f.counts()).toEqual([1,1,1,0]);
});
test("graceful native close submits application players before the system player and retires the lease",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 expect(await session.gracefulClose()).toEqual({submission:"submitted"});
 expect(f.destroyed).toEqual([3,4,1]);expect(f.counts()).toEqual([1,1,1,0]);
 expect(()=>session.receive()).toThrow();await expect(session.gracefulClose()).rejects.toThrow();
});
test("graceful close reserves before callbacks and aborts held send on forced close",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const gate=deferred<void>();f.holdDestroy(gate.promise);
 const pending=session.gracefulClose();await Promise.resolve();await Promise.resolve();
 await expect(session.createPlayer({shortName:null,longName:null,data:new Uint8Array()})).rejects.toThrow();
 await expect(session.destroyPlayer(3)).rejects.toThrow();
 await expect(session.sendToHost(3,2,Uint8Array.of(1))).rejects.toThrow();
 await expect(session.gracefulClose()).rejects.toThrow();session.close();
 await expect(pending).rejects.toThrow();gate.resolve();
 expect(f.destroyed).toEqual([3]);expect(f.counts()).toEqual([1,1,1,0]);
});
test("graceful close never submits system player after application submission fails",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const fail=Promise.reject(new Error("destroy failed"));void fail.catch(()=>{});f.holdDestroy(fail);
 await expect(session.gracefulClose()).rejects.toThrow("destroy failed");
 expect(f.destroyed).toEqual([3]);expect(f.counts()).toEqual([1,1,1,0]);
});
test("graceful close retires session when lease is revoked during the first submission",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const gate=deferred<void>();f.holdDestroy(gate.promise);const pending=session.gracefulClose();
 await Promise.resolve();await Promise.resolve();f.abortLease();await expect(pending).rejects.toThrow();gate.resolve();
 expect(f.destroyed).toEqual([3]);expect(f.counts()).toEqual([1,1,1,0]);
});
test("normal native destroy encodes the source-derived cmd11 layout",()=>{
 const inner=encodeDirectPlay4DestroyPlayer(0x12345678,14),v=new DataView(inner.buffer);
 expect(inner.length).toBe(28);expect(v.getUint32(0,true)).toBe(0x79616c70);
 expect(v.getUint16(4,true)).toBe(11);expect(v.getUint16(6,true)).toBe(14);
 expect(v.getUint32(12,true)).toBe(0x12345678);
 expect([...inner.slice(8,12),...inner.slice(16)]).toEqual(new Array(16).fill(0));
 for(const id of [0,-1,0x100000000,1.5,NaN])expect(()=>encodeDirectPlay4DestroyPlayer(id,14)).toThrow();
 expect(()=>encodeDirectPlay4DestroyPlayer(1,8)).toThrow();
});
test("native destroy submits only a local player, removes its queued messages and preserves others",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 f.getOwner()!.onPlayerFrame!(player(2,3,Uint8Array.of(3)),peer);
 f.getOwner()!.onPlayerFrame!(player(2,4,Uint8Array.of(4)),peer);
 expect(await session.destroyPlayer(3)).toEqual({submission:"submitted"});
 expect(f.destroyed).toEqual([3]);expect([...session.receive()!.data]).toEqual([4]);expect(session.receive()).toBeUndefined();
 await expect(session.destroyPlayer(3)).rejects.toThrow();await expect(session.destroyPlayer(2)).rejects.toThrow();
 expect(f.counts()).toEqual([0,0,0,0]);session.close();
});
test("native destroy reserves the operation and close cancels a pending submission",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const gate=deferred<void>();f.holdDestroy(gate.promise);
 const pending=session.destroyPlayer(3);await Promise.resolve();await Promise.resolve();
 await expect(session.destroyPlayer(3)).rejects.toThrow();
 await expect(session.createPlayer({shortName:null,longName:null,data:new Uint8Array()})).rejects.toThrow();
 session.close();await expect(pending).rejects.toThrow();gate.resolve();
 expect(f.destroyed).toEqual([3]);expect(f.counts()).toEqual([1,1,1,0]);
});
test("native destroy stops and releases its owner when the lease is revoked during submission",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 const gate=deferred<void>();f.holdDestroy(gate.promise);
 const pending=session.destroyPlayer(3);await Promise.resolve();await Promise.resolve();f.abortLease();
 await expect(pending).rejects.toThrow("cancelled");gate.resolve();
 expect(f.counts()).toEqual([1,1,1,0]);expect(()=>session.receive()).toThrow();
});
test("native destroy checks the owner before sending even when the check closes reentrantly",async()=>{
 const f=fixture();let closeOnCheck=false,session!:DirectPlay4NativeSession;
 session=new DirectPlay4NativeSession(f.driver,()=>{if(closeOnCheck)session.close();return true;},f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});closeOnCheck=true;
 await expect(session.destroyPlayer(3)).rejects.toThrow();expect(f.destroyed).toEqual([]);expect(f.counts()).toEqual([1,1,1,0]);
});
test("native destroy retires the session after a failed submission",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 f.holdDestroy(Promise.reject(new Error("send failed")));
 await expect(session.destroyPlayer(3)).rejects.toThrow("send failed");
 expect(f.counts()).toEqual([1,1,1,0]);expect(()=>session.receive()).toThrow();
});
test("authorized native pending create enters staged roster with owned player data and count",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:number[]=[];f.result.table.players.push({...entry,id:6});f.events.onSystem=(frame:any)=>seen.push(frame.command);
 f.result.transfer=o=>{const b=nativeCreate(5);o.applyPending({kind:"system",bytes:b,header:new Uint8Array(16),sendFlags:0,peer});b.fill(0);return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events),snapshot=await session.open(),created=snapshot.players.find(p=>p.id===5)!;
 expect(created).toBeDefined();expect(created.preexisting).toBe(false);expect(created.flags).toBe(8);
 expect(created.shortName).toEqual([76,0,97,0,116,0,101,0,0,0]);
 expect(created.spData.length).toBe(32);expect(Object.isFrozen(created.spData)).toBe(true);
 expect(new DataView(Uint8Array.from(snapshot.sessionDescription).buffer).getUint32(44,true)).toBe(2);expect(seen).toEqual([8]);session.close();
});
test("pending native create rejects unauthorized, duplicate and unknown system owner",async()=>{
 for(const mode of ["unauthorized","duplicate","unknownSystem"]){
  const f=fixture(),transfer=f.result.transfer;f.result.table.players.push({...entry,id:6});f.events.authorizeSystem=()=>mode!=="unauthorized";
  f.result.transfer=o=>{o.applyPending({kind:"system",bytes:nativeCreate(mode==="duplicate"?2:5,mode==="unknownSystem"?99:6),header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);};
  const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
  await expect(session.open()).rejects.toThrow();expect(f.counts()).toEqual([1,1,0,1]);
 }
});
test("authorized pending delete updates staged roster and dispatches after transfer",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:number[]=[];
 f.result.table.players.push({...entry,id:5,flags:0});
 f.events.onSystem=(frame:any)=>seen.push(frame.command);
 f.result.transfer=o=>{const b=new Uint8Array(28),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,2,true);
  o.applyPending({kind:"system",bytes:b,header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events),snapshot=await session.open();
 expect(snapshot.players.map(p=>p.id)).toEqual([1,5]);expect(new DataView(Uint8Array.from(snapshot.sessionDescription).buffer).getUint32(44,true)).toBe(1);expect(seen).toEqual([11]);
 await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 f.getOwner()!.onPlayerFrame!(player(2,3),peer);expect(session.receive()).toBeUndefined();session.close();
});
test("pending delete rejects unauthorized, system, malformed and unknown identities without publishing",async()=>{
 for(const mode of ["unauthorized","system","short","unknown","missingPeer"]){
  const f=fixture(),transfer=f.result.transfer;f.events.authorizeSystem=()=>mode!=="unauthorized";
  f.result.transfer=o=>{const b=new Uint8Array(mode==="short"?16:28),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,mode==="system"?1:mode==="unknown"?99:2,true);
   o.applyPending({kind:"system",bytes:b,header:new Uint8Array(16),sendFlags:0,...(mode==="missingPeer"?{}:{peer})});return transfer(o);};
  const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
  await expect(session.open()).rejects.toThrow();expect(f.counts()).toEqual([1,1,0,1]);
 }
});
test("pending delete with group membership fails closed until ordered group notifications exist",async()=>{
 const f=fixture(),transfer=f.result.transfer;
 f.result.table.groups=[{...entry,id:4,memberIds:[2]}];
 f.result.transfer=o=>{const b=new Uint8Array(28),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,2,true);
  o.applyPending({kind:"system",bytes:b,header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow();expect(f.counts()).toEqual([1,1,0,1]);
});
test("reentrant owner close during pending-delete authorization prevents publication",async()=>{
 const f=fixture(),transfer=f.result.transfer;let session!:DirectPlay4NativeSession,notified=false;
 f.events.authorizeSystem=()=>{session.close();return true;};f.events.onSystem=()=>{notified=true;};
 f.result.transfer=o=>{const b=new Uint8Array(28),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,2,true);
  o.applyPending({kind:"system",bytes:b,header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);};
 session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow();expect(notified).toBe(false);expect(f.counts()).toEqual([1,1,0,1]);
});
test("pending player replay retains transport peer and drops data for non-local target",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:Array<{from:number;to:number;peer:number[]}>=[];let notified=0;
 f.events.authorizePlayer=(frame:any,source:any)=>{seen.push({from:frame.from,to:frame.to,peer:[...source.ip]});return true;};
 f.events.onPlayer=()=>{notified++;};
 f.result.transfer=o=>{const payload=new Uint8Array(10),v=new DataView(payload.buffer);v.setUint32(0,2,true);v.setUint32(4,1,true);payload.set([8,9],8);
  o.applyPending({kind:"player",bytes:payload,header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 expect(seen).toEqual([{from:2,to:1,peer:[1,2,3,4]}]);expect(notified).toBe(0);expect(session.receive()).toBeUndefined();session.close();
});
test("pending player replay without exact source fails closed",async()=>{
 const f=fixture(),transfer=f.result.transfer;
 f.result.transfer=o=>{o.applyPending({kind:"player",bytes:new Uint8Array(8),header:new Uint8Array(16),sendFlags:0});return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow();expect(f.counts()).toEqual([1,1,0,1]);
});
test("historical pending snapshots count against the bounded transition budget",async()=>{
 const f=fixture(),transfer=f.result.transfer;
 f.result.table.players=[entry,...Array.from({length:3998},(_,i)=>({...entry,id:i+2,flags:0}))];
 f.result.transfer=o=>{
  for(let id=2;id<42;id++){
   const b=new Uint8Array(28),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,id,true);
   o.applyPending({kind:"system",bytes:b,header:new Uint8Array(16),sendFlags:0,peer});
  }
  return transfer(o);
 };
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow("transition queue full");expect(f.counts()).toEqual([1,1,0,1]);
});
test("pending player data uses its historical roster when the sender is later deleted",async()=>{
 const f=fixture(),transfer=f.result.transfer;let sawSender=false,delivered=false;
 (f.events as any).authorizePlayer=(_frame:any,_peer:any,table:any)=>{sawSender=table.players.some((p:any)=>p.id===2);return sawSender;};
 f.events.onPlayer=()=>{delivered=true;};
 f.result.transfer=o=>{
  const data=new Uint8Array(9),pv=new DataView(data.buffer);pv.setUint32(0,2,true);pv.setUint32(4,1,true);data[8]=42;
  o.applyPending({kind:"player",bytes:data,header:new Uint8Array(16),sendFlags:0,peer});
  const d=new Uint8Array(28),v=new DataView(d.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,2,true);
  o.applyPending({kind:"system",bytes:d,header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);
 };
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events),snapshot=await session.open();
 expect(sawSender).toBe(true);expect(snapshot.players.some(p=>p.id===2)).toBe(false);expect(delivered).toBe(false);expect(session.receive()).toBeUndefined();session.close();
});
test("callback player delivery releases native queue budget for sustained guest traffic",async()=>{
 const f=fixture();(f.events as any).playerDelivery="callback";let count=0;f.events.onPlayer=()=>{count++;};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 for(let i=0;i<300;i++)f.getOwner()!.onPlayerFrame!(player(2,3),peer);
 expect(count).toBe(300);expect(session.receive()).toBeUndefined();session.close();expect(f.counts()).toEqual([1,1,1,0]);
});
test("callback player delivery retires the session if the consumer throws",async()=>{
 const f=fixture();(f.events as any).playerDelivery="callback";f.events.onPlayer=()=>{throw Error("consumer failed");};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 expect(()=>f.getOwner()!.onPlayerFrame!(player(2,3),peer)).toThrow("consumer failed");expect(f.counts()).toEqual([1,1,1,0]);expect(()=>session.receive()).toThrow();
});
test("player authorization receives the current immutable native roster",async()=>{
 const f=fixture();let rosterIds:number[]=[];
 (f.events as any).authorizePlayer=(_frame:any,_peer:any,table:any)=>{expect(Object.isFrozen(table)).toBe(true);rosterIds=table.players.map((p:any)=>p.id);return true;};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();await session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});
 f.getOwner()!.onPlayerFrame!(player(2,3),peer);expect(rosterIds).toEqual([1,2]);expect(session.receive()?.from).toBe(2);session.close();
});
test("pending and live authorization receive the exact immutable pre-change roster",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:number[][]=[];f.result.table.players.push({...entry,id:6});
 (f.events as any).authorizeSystem=(_id:number,_source:any,_system:number,table:any)=>{expect(Object.isFrozen(table)).toBe(true);seen.push(table.players.map((p:any)=>p.id));return true;};
 f.result.transfer=o=>{o.applyPending({kind:"system",bytes:nativeCreate(5),header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 const d=new Uint8Array(28),v=new DataView(d.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,5,true);
 f.getOwner()!.onFrame({consumed:48,command:11,version:14,providerSockaddr:new Uint8Array(16),message:d},peer);
 expect(seen).toEqual([[1,2,6],[1,2,6,5]]);session.close();
});
test("pending roster transitions retain each historical state in arrival order",async()=>{
 const f=fixture(),transfer=f.result.transfer,seen:any[]=[];f.result.table.players.push({...entry,id:6});
 (f.events as any).onRosterChange=(c:any)=>seen.push([c.kind,c.playerId,c.before.players.map((p:any)=>p.id),c.after.players.map((p:any)=>p.id)]);
 f.events.onSystem=(frame:any)=>seen.push(frame.command);
 f.result.transfer=o=>{
  const b=new Uint8Array(28),v=new DataView(b.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,2,true);
  o.applyPending({kind:"system",bytes:b,header:new Uint8Array(16),sendFlags:0,peer});
  o.applyPending({kind:"system",bytes:nativeCreate(5),header:new Uint8Array(16),sendFlags:0,peer});
  return transfer(o);
 };
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 expect(seen).toEqual([["delete",2,[1,2,6],[1,6]],11,["create",5,[1,6],[1,6,5]],8]);session.close();
});
test("reentrant live mutations preserve roster and system notification order",async()=>{
 const f=fixture(),seen:string[]=[];f.result.table.players.push({...entry,id:6});
 let session!:DirectPlay4NativeSession;
 (f.events as any).onRosterChange=(c:any)=>{
  seen.push(c.kind+":"+c.playerId);
  if(c.kind==="create"){
   const d=new Uint8Array(28),v=new DataView(d.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,5,true);
   f.getOwner()!.onFrame({consumed:48,command:11,version:14,providerSockaddr:new Uint8Array(16),message:d},peer);
  }
 };
 f.events.onSystem=(frame:any)=>seen.push("system:"+frame.command);
 session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 const b=nativeCreate(5);f.getOwner()!.onFrame({consumed:20+b.length,command:8,version:14,providerSockaddr:new Uint8Array(16),message:b},peer);
 expect(seen).toEqual(["create:5","system:8","delete:5","system:11"]);
 expect(session.nameTable().players.some(p=>p.id===5)).toBe(false);session.close();
});
test("native roster accessor is immutable and revoked when session closes",async()=>{
 const f=fixture(),session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 expect(()=>session.nameTable()).toThrow();await session.open();const snapshot=session.nameTable();
 expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.players)).toBe(true);
 session.close();expect(()=>session.nameTable()).toThrow();
});
test("live remote mutation during transfer appears in the returned snapshot",async()=>{
 const f=fixture(),transfer=f.result.transfer;f.result.table.players.push({...entry,id:6});
 f.result.transfer=o=>{const lease=transfer(o),b=nativeCreate(5);o.onFrame({consumed:20+b.length,command:8,version:14,providerSockaddr:new Uint8Array(16),message:b},peer);return lease;};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events),snapshot=await session.open();
 expect(snapshot.players.map(p=>p.id)).toEqual([1,2,6,5]);session.close();
});
test("live remote player mutations update the roster before notification",async()=>{
 const f=fixture();f.result.table.players.push({...entry,id:6});const seen:number[][]=[];
 let session!:DirectPlay4NativeSession;f.events.onSystem=()=>seen.push(session.nameTable().players.map(p=>p.id));
 session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 const b=nativeCreate(5),frame={consumed:20+b.length,command:8,version:14,providerSockaddr:new Uint8Array(16),message:b};
 f.getOwner()!.onFrame(frame,peer);
 const d=new Uint8Array(28),v=new DataView(d.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,11,true);v.setUint16(6,14,true);v.setUint32(12,5,true);
 f.getOwner()!.onFrame({...frame,command:11,message:d},peer);
 expect(seen).toEqual([[1,2,6,5],[1,2,6]]);session.close();
});
test("live remote mutation snapshots bytes and rechecks owner after authorization",async()=>{
 const f=fixture();f.result.table.players.push({...entry,id:6});let notices=0;
 const b=nativeCreate(5);f.events.authorizeSystem=()=>{b.fill(0);return true;};f.events.onSystem=()=>{notices++;};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);await session.open();
 f.getOwner()!.onFrame({consumed:20+b.length,command:8,version:14,providerSockaddr:new Uint8Array(16),message:b},peer);
 expect(session.nameTable().players.some(p=>p.id===5)).toBe(true);
 expect((session as any).knownPlayers.has(5)).toBe(true);expect(notices).toBe(1);session.close();
 const g=fixture();g.result.table.players.push({...entry,id:6});let observed=false;
 const closed=new DirectPlay4NativeSession(g.driver,()=>true,g.events);await closed.open();
 g.events.authorizeSystem=()=>{closed.close();return true;};g.events.onSystem=()=>{observed=true;};
 const c=nativeCreate(5);expect(()=>g.getOwner()!.onFrame({consumed:20+c.length,command:8,version:14,providerSockaddr:new Uint8Array(16),message:c},peer)).toThrow();
 expect(observed).toBe(false);
});
test("unsupported pending replay closes without publishing session",async()=>{
 const f=fixture(),transfer=f.result.transfer;
 f.result.transfer=o=>{o.applyPending({kind:"system",bytes:Uint8Array.of(0x70,0x6c,0x61,0x79,10,0,14,0),header:new Uint8Array(16),sendFlags:0,peer});return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow("replay unsupported");expect(f.counts()).toEqual([1,1,0,1]);
});
