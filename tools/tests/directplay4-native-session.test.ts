import {expect,test} from "bun:test";
import {DirectPlay4NativeSession,type DirectPlay4NativeSessionDriver} from "../../src/worker/modules/dplayx/native-wire/native-session";
import type {DirectPlay4JoinHandshakeResult,DirectPlay4JoinSessionOwner} from "../../src/worker/modules/dplayx/native-wire/join-handshake";
import type {DirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";
import type {DirectPlay4JoinUdpListener} from "../../src/worker/modules/dplayx/native-wire/join-udp-listener";
const entry={id:1,flags:1,fixedSize:16,versionOrSystemId:14,version:14,parentId:0,shortName:null,longName:null,spData:new Uint8Array(),playerData:new Uint8Array(),memberIds:[]};
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const peer={family:2,node:Uint8Array.of(2,1,1,2,3,4),ip:Uint8Array.of(1,2,3,4),port:2000};
const player=(from:number,to:number,data=Uint8Array.of(4,5))=>({consumed:30,providerSockaddr:new Uint8Array(16),from,to,data});
function fixture(){
 let tcpClosed=0,udpClosed=0,leaseClosed=0,cancelled=0,transferred=false,owner:DirectPlay4JoinSessionOwner|undefined;
 let holdCreate:Promise<void>|undefined,nextId=3;
 const tcp={socket:1,ownerToken:1,address:{node:[2,1,1,2,3,4],port:1},current:()=>true,release(){if(!tcpClosed)tcpClosed++;}} as DirectPlay4JoinListener;
 const udp={socket:2,physical:2,binding:1,address:{node:[2,1,1,2,3,4],port:2},allowedNodes:[],current:()=>true,release(){if(!udpClosed)udpClosed++;}} as DirectPlay4JoinUdpListener;
 const leaseAbort=new AbortController();
 const result:DirectPlay4JoinHandshakeResult={playerId:1,table:{command:41,version:14,sessionDescription:new Uint8Array(80),name:null,password:null,players:[entry,{...entry,id:2}],groups:[],shortcuts:[]},
  cancel(){cancelled++;tcp.release();udp.release();},
  transfer(o){owner=o;transferred=true;return {signal:leaseAbort.signal,version:14,systemPlayerId:1,tcpSockaddr:new Uint8Array(16),udpSockaddr:new Uint8Array(16),
   current:()=>true,send:async(frame)=>{if(new DataView(frame.buffer,frame.byteOffset,frame.byteLength).getUint16(24,true)===5){
    const message=new Uint8Array(48),v=new DataView(message.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,7,true);v.setUint16(6,14,true);v.setUint32(8,nextId++,true);
    queueMicrotask(()=>owner?.onFrame({consumed:68,command:7,version:14,providerSockaddr:new Uint8Array(16),message},peer));
   }else if(holdCreate)await holdCreate;},sendPlayer:async()=>{},release(){if(!leaseClosed){leaseClosed++;leaseAbort.abort();tcp.release();udp.release();}}};}};
 const driver:DirectPlay4NativeSessionDriver={acquireTcp:async()=>tcp,acquireUdp:async()=>udp,handshake:async()=>result};
 const events={authorizePlayer:()=>true,onSystem:()=>{},onPlayer:()=>{},onFailure:()=>{}};
 return {driver,events,tcp,udp,result,hold:(p:Promise<void>)=>{holdCreate=p;},counts:()=>[tcpClosed,udpClosed,leaseClosed,cancelled],getOwner:()=>owner,getTransferred:()=>transferred};
}
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
 const creating=session.createPlayer({shortName:null,longName:null,data:new Uint8Array()});await new Promise(resolve=>setTimeout(resolve,5));
 f.getOwner()!.onPlayerFrame!(player(2,3,Uint8Array.of(7)),peer);expect(session.receive()).toBeUndefined();
 gate.resolve();expect((await creating).playerId).toBe(3);expect([...session.receive()!.data]).toEqual([7]);session.close();
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
test("unsupported pending replay closes without publishing session",async()=>{
 const f=fixture(),transfer=f.result.transfer;
 f.result.transfer=o=>{o.applyPending({kind:"player",bytes:Uint8Array.of(1),header:null,sendFlags:0});return transfer(o);};
 const session=new DirectPlay4NativeSession(f.driver,()=>true,f.events);
 await expect(session.open()).rejects.toThrow("replay unsupported");expect(f.counts()).toEqual([1,1,0,1]);
});
