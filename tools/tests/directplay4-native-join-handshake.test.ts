import {expect,test} from "bun:test";
import {DirectPlay4JoinChannel} from "../../src/worker/modules/dplayx/native-wire/join-channel";
import {DirectPlay4CreatePlayer} from "../../src/worker/modules/dplayx/native-wire/create-player";
import {encodeDirectPlay4PlayerTcpFrame} from "../../src/worker/modules/dplayx/native-wire/player-tcp";
import {encodeDirectPlay4PlayerWrapper} from "../../src/worker/modules/dplayx/native-wire/player-wrapper";
import {runDirectPlay4JoinHandshake} from "../../src/worker/modules/dplayx/native-wire/join-handshake";
import {encodeDirectPlay4SystemTcpFrame} from "../../src/worker/modules/dplayx/native-wire/tcp-frame";
import {WsaFailure,WSA,type WsaSocketTable} from "../../src/worker/modules/wsa-network";
const peer={family:2,node:Uint8Array.of(2,1,192,0,2,2),ip:Uint8Array.of(192,0,2,2),port:1234};
const sockaddr=Uint8Array.of(2,0,8,252,192,0,2,1,0,0,0,0,0,0,0,0);
class Fake {
 generation=1; next=10; sockets=new Map<number,number>(); queue:number[]=[]; packets=new Map<number,Uint8Array[]>(); handlers=new Set<()=>void>(); commands:number[]=[]; requests:Uint8Array[]=[]; reply=true; rejectForward=false; idCount=0; beforeId?:Uint8Array;
 subscribe(f:()=>void){this.handlers.add(f);return ()=>this.handlers.delete(f);}
 signal(){for(const f of this.handlers)f();}
 socketOwned(){const id=this.next++;this.sockets.set(id,id+100);return {handle:id,object:id+100};}
 acceptOwned(){const id=this.queue.shift();if(!id)throw new WsaFailure(WSA.EWOULDBLOCK);return {handle:id,object:this.sockets.get(id)!};}
 isValid(id:number){return this.sockets.has(id);} fileObjectId(id:number){return this.sockets.get(id);}
 closesocket(id:number){this.sockets.delete(id);this.signal();}
 connect(){} isConnected(){return true;} get(){return {state:"connected"};}
 injectRaw(frame:Uint8Array){const c=this.socketOwned().handle;this.packets.set(c,[frame,new Uint8Array()]);this.queue.push(c);this.signal();}
 inject(inner:Uint8Array,provider=sockaddr){const c=this.socketOwned().handle;this.packets.set(c,[encodeDirectPlay4SystemTcpFrame(provider,inner,1024),new Uint8Array()]);this.queue.push(c);this.signal();}
 receive(id:number){const data=this.packets.get(id)?.shift();if(!data)throw new WsaFailure(WSA.EWOULDBLOCK);return {data,from:peer};}
 send(_id:number,data:Uint8Array){
  const command=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint16(24,true);this.commands.push(command);this.requests.push(Uint8Array.from(data));
  if(this.reply&&command!==8){
   let inner:Uint8Array;
   if(command===5){inner=new Uint8Array(48);const v=new DataView(inner.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,7,true);v.setUint16(6,14,true);v.setUint32(8,0x12345678+this.idCount++,true);}
   else if(this.rejectForward){inner=new Uint8Array(12);const v=new DataView(inner.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,36,true);v.setUint16(6,14,true);v.setUint32(8,0x8877014a,true);}
   else {inner=new Uint8Array(116);const v=new DataView(inner.buffer);v.setUint32(0,0x79616c70,true);v.setUint16(4,41,true);v.setUint16(6,14,true);v.setUint32(16,116,true);v.setUint32(24,36,true);v.setUint32(36,80,true);}
   const c=this.socketOwned().handle;const reply=encodeDirectPlay4SystemTcpFrame(sockaddr,inner,1024);
   const message=command===5&&this.idCount===1&&this.beforeId?Uint8Array.from([...this.beforeId,...reply]):reply;
   this.packets.set(c,[message]);this.queue.push(c);this.signal();
  }
  return data.length;
 }
}
function setup(){
 const table=new Fake(), controller=new AbortController();let tcpReleased=0,udpReleased=0;
 const tcp={socket:1,ownerToken:1,address:{node:[2,1,192,0,2,1],port:2300},current:()=>true,release:()=>{tcpReleased++;}};
 const udp={socket:2,physical:2,binding:1,address:{node:[2,1,192,0,2,1],port:2301},allowedNodes:[],current:()=>true,release:()=>{udpReleased++;}};
 const o={table:table as unknown as WsaSocketTable,tcp,udp,destination:peer,signal:controller.signal,current:()=>true,
  authorizeDestination:()=>true,authorizePeer:()=>true,onOwnershipUncertain:()=>{},timeoutMs:1000,maxFrameBytes:1024,maxEntries:10,maxPendingBytes:4096,discovery:{version:14,flags:0,instanceGuid:new Uint8Array(16),applicationGuid:new Uint8Array(16),reserved1:0}};
 return {table,controller,o,releases:()=>[tcpReleased,udpReleased]};
}
test("controlled channel exchanges cmd5 and cmd19, retains owners until release",async()=>{
 const f=setup();const result=await runDirectPlay4JoinHandshake(f.o);
 expect(f.table.commands).toEqual([5,19]);
 const forward=f.table.requests[1],view=new DataView(forward.buffer);
 expect(view.getUint32(32,true)).toBe(0x12345678);
 expect([...forward.subarray(96,104)]).toEqual([2,0,8,252,192,0,2,1]);
 expect([...forward.subarray(112,120)]).toEqual([2,0,8,253,192,0,2,1]);
 expect(result.playerId).toBe(0x12345678);expect(result.table.command).toBe(41);
 const session=new AbortController();
 const lease=result.transfer({signal:session.signal,current:()=>true,exists:()=>false,applyPending:()=>{},onFrame:()=>{},onFailure:()=>{}});
 expect(lease).toBeDefined();expect(f.releases()).toEqual([0,0]);
 expect(lease.version).toBe(14);expect(lease.systemPlayerId).toBe(0x12345678);
 lease.tcpSockaddr.fill(0);expect(lease.tcpSockaddr[0]).toBe(2);expect(lease.udpSockaddr[3]).toBe(0xfd);
 lease!.release();expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
});
test("transferred session supplies fenced owner for application CreatePlayer",async()=>{
 const f=setup(),result=await runDirectPlay4JoinHandshake(f.o),signal=new AbortController();
 let operation:DirectPlay4CreatePlayer|undefined;
 const lease=result.transfer({signal:signal.signal,current:()=>true,exists:()=>false,applyPending:()=>{},onFrame:frame=>{operation?.receive(frame);},onFailure:()=>{}});
 operation=new DirectPlay4CreatePlayer({signal:lease.signal,current:lease.current,send:lease.send,version:lease.version,
  systemPlayerId:lease.systemPlayerId,tcpSockaddr:lease.tcpSockaddr,udpSockaddr:lease.udpSockaddr,onUncertain:()=>lease.release()},1000,1024);
 const created=await operation.create({shortName:"game",longName:null,data:new Uint8Array()});
 expect(created).toEqual({playerId:0x12345679,submission:"submitted"});expect(f.table.commands).toEqual([5,19,5,8]);
 lease.release();expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
});
test("wrapped magic player arriving before cmd7 is queued and does not become the reply",async()=>{
 const f=setup();f.table.beforeId=encodeDirectPlay4PlayerWrapper(sockaddr,0x79616c70,7,Uint8Array.of(42),14,1024);
 const result=await runDirectPlay4JoinHandshake(f.o),signal=new AbortController(),seen:number[]=[];
 const lease=result.transfer({signal:signal.signal,current:()=>true,exists:()=>false,
  applyPending:m=>seen.push(new DataView(m.bytes.buffer,m.bytes.byteOffset,m.bytes.byteLength).getUint32(0,true)),
  onFrame:()=>{},onFailure:()=>{}});
 expect(result.playerId).toBe(0x12345678);expect(f.table.commands).toEqual([5,19]);expect(seen).toEqual([0x79616c70]);lease.release();
});
test("pending and live raw player frames cross the session transfer in order",async()=>{
 const f=setup(),result=await runDirectPlay4JoinHandshake(f.o),signal=new AbortController(),events:string[]=[];
 const raw=encodeDirectPlay4PlayerTcpFrame(sockaddr,7,8,Uint8Array.of(42),1024);f.table.injectRaw(raw);
 await new Promise(resolve=>setTimeout(resolve,15));
 const lease=result.transfer({signal:signal.signal,current:()=>true,exists:()=>false,
  applyPending:m=>{const v=new DataView(m.bytes.buffer,m.bytes.byteOffset,m.bytes.byteLength);events.push("pending:"+v.getUint32(0,true));},
  onFrame:()=>{},onPlayerFrame:frame=>events.push("live:"+frame.from),onFailure:()=>{}});
 f.table.injectRaw(raw);await new Promise(resolve=>setTimeout(resolve,15));expect(events).toEqual(["pending:7","live:7"]);
 f.table.reply=false;await lease.sendPlayer(raw);expect(f.table.requests.at(-1)).toEqual(raw);lease.release();expect(f.releases()).toEqual([1,1]);
});
test("lease release and external abort promptly cancel held player-ID request",async()=>{
 for(const action of ["release","external"]){
  const f=setup(),result=await runDirectPlay4JoinHandshake(f.o),session=new AbortController();let operation:DirectPlay4CreatePlayer|undefined;
  const lease=result.transfer({signal:session.signal,current:()=>true,exists:()=>false,applyPending:()=>{},onFrame:frame=>{operation?.receive(frame);},onFailure:()=>{}});
  operation=new DirectPlay4CreatePlayer({signal:lease.signal,current:lease.current,send:lease.send,version:lease.version,
   systemPlayerId:lease.systemPlayerId,tcpSockaddr:lease.tcpSockaddr,udpSockaddr:lease.udpSockaddr,onUncertain:()=>lease.release()},5000,1024);
  f.table.reply=false;const run=operation.create({shortName:null,longName:null,data:new Uint8Array()});
  await new Promise(resolve=>setTimeout(resolve,15));expect(f.table.commands).toEqual([5,19,5]);
  if(action==="release")lease.release();else f.controller.abort();
  await expect(Promise.race([run,new Promise((_,reject)=>setTimeout(()=>reject(new Error("late")),100))])).rejects.toThrow("cancelled");
  expect(lease.signal.aborted).toBe(true);expect(f.releases()).toEqual([1,1]);
 }
});
test("session transfer retains channel past deadline and delivers later frames",async()=>{
 const f=setup();f.o.timeoutMs=60;const result=await runDirectPlay4JoinHandshake(f.o),signal=new AbortController(),commands:number[]=[];
 const lease=result.transfer({signal:signal.signal,current:()=>true,exists:()=>false,applyPending:()=>{},onFrame:frame=>commands.push(frame.command),onFailure:e=>{throw e;}});
 await new Promise(resolve=>setTimeout(resolve,90));
 const inner=Uint8Array.of(0x70,0x6c,0x61,0x79,8,0,14,0);f.table.inject(inner);
 await new Promise(resolve=>setTimeout(resolve,20));expect(commands).toEqual([8]);expect(f.releases()).toEqual([0,0]);
 lease.release();expect(f.table.sockets.size).toBe(0);
});
test("session send reentrant abort closes exact lease and rejects",async()=>{
 const f=setup(),result=await runDirectPlay4JoinHandshake(f.o),session=new AbortController();let armed=false;
 const lease=result.transfer({signal:session.signal,current:()=>{if(armed)session.abort();return true;},exists:()=>false,applyPending:()=>{},onFrame:()=>{},onFailure:()=>{}});
 armed=true;const frame=encodeDirectPlay4SystemTcpFrame(sockaddr,Uint8Array.of(0x70,0x6c,0x61,0x79,5,0,14,0),1024);
 await expect(lease.send(frame)).rejects.toThrow();expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
});
test("external owner abort after transfer releases session resources",async()=>{
 const f=setup(),result=await runDirectPlay4JoinHandshake(f.o),session=new AbortController();
 result.transfer({signal:session.signal,current:()=>true,exists:()=>false,applyPending:()=>{},onFrame:()=>{},onFailure:()=>{}});
 f.controller.abort();expect(session.signal.aborted).toBe(false);expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
});
test("malformed discovery snapshot releases both passed owners",async()=>{
 const f=setup();(f.o as any).discovery=null;await expect(runDirectPlay4JoinHandshake(f.o)).rejects.toThrow();expect(f.releases()).toEqual([1,1]);
});
test("pending replay precedes live delivery; abort inside replay releases both owners",async()=>{
 const f=setup(),result=await runDirectPlay4JoinHandshake(f.o),signal=new AbortController(),events:string[]=[];
 const inner=Uint8Array.of(0x70,0x6c,0x61,0x79,8,0,14,0,0,0,0,0,9,0,0,0);
 f.table.inject(inner);await new Promise(resolve=>setTimeout(resolve,15));
 const lease=result.transfer({signal:signal.signal,current:()=>true,exists:()=>false,applyPending:()=>events.push("pending"),onFrame:()=>events.push("live"),onFailure:()=>{}});
 f.table.inject(inner);await new Promise(resolve=>setTimeout(resolve,15));expect(events).toEqual(["pending","live"]);lease.release();
 const g=setup(),held=await runDirectPlay4JoinHandshake(g.o),cancel=new AbortController();g.table.inject(inner);await new Promise(resolve=>setTimeout(resolve,15));
 expect(()=>held.transfer({signal:cancel.signal,current:()=>true,exists:()=>false,applyPending:()=>cancel.abort(),onFrame:()=>{},onFailure:()=>{}})).toThrow();
 expect(g.releases()).toEqual([1,1]);expect(g.table.sockets.size).toBe(0);
});
test("reentrant ingress during replay respects the combined budget and cancels",async()=>{
 const f=setup();f.o.maxPendingBytes=132;let channel:DirectPlay4JoinChannel|undefined;
 const original=DirectPlay4JoinChannel.prototype.send;
 DirectPlay4JoinChannel.prototype.send=function(frame){channel=this;return original.call(this,frame);};
 try {
  const result=await runDirectPlay4JoinHandshake(f.o),signal=new AbortController();
  const pending=Uint8Array.of(0x70,0x6c,0x61,0x79,8,0,14,0,0,0,0,0,9,0,0,0);
  const extra=Uint8Array.of(0x70,0x6c,0x61,0x79,10,0,14,0);
  f.table.inject(pending);await new Promise(resolve=>setTimeout(resolve,15));
  expect(()=>result.transfer({signal:signal.signal,current:()=>true,exists:()=>false,applyPending:()=>{
   for(let i=0;i<5;i++)f.table.inject(extra);(channel as any).pump();
  },onFrame:()=>{},onFailure:()=>{}})).toThrow();
  expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
 } finally {DirectPlay4JoinChannel.prototype.send=original;}
});
test("transition budget retains the current frame through a reentrant consumer",async()=>{
 const f=setup();f.o.maxPendingBytes=132;let channel:DirectPlay4JoinChannel|undefined;
 const original=DirectPlay4JoinChannel.prototype.send;
 DirectPlay4JoinChannel.prototype.send=function(frame){channel=this;return original.call(this,frame);};
 try {
  const result=await runDirectPlay4JoinHandshake(f.o),signal=new AbortController();
  const pending=Uint8Array.of(0x70,0x6c,0x61,0x79,8,0,14,0,0,0,0,0,9,0,0,0);
  const extra=Uint8Array.of(0x70,0x6c,0x61,0x79,10,0,14,0);
  f.table.inject(pending);await new Promise(resolve=>setTimeout(resolve,15));
  expect(()=>result.transfer({signal:signal.signal,current:()=>true,exists:()=>false,
   applyPending:()=>{f.table.inject(extra);(channel as any).pump();},
   onFrame:()=>{for(let i=0;i<5;i++)f.table.inject(extra);(channel as any).pump();},onFailure:()=>{}})).toThrow();
  expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
 } finally {DirectPlay4JoinChannel.prototype.send=original;}
});
test("unsupported discovery flags and identity mismatch fail closed",async()=>{
 for(const flags of [0x100,0x200,0x400]){const f=setup();f.o.discovery.flags=flags;await expect(runDirectPlay4JoinHandshake(f.o)).rejects.toThrow();expect(f.releases()).toEqual([1,1]);expect(f.table.commands).toEqual([]);}
 const f=setup();f.o.discovery.instanceGuid[0]=1;await expect(runDirectPlay4JoinHandshake(f.o)).rejects.toThrow("identity");expect(f.releases()).toEqual([1,1]);
});
test("undersized frame fails without an unhandled reply rejection",async()=>{
 const f=setup(), unhandled:unknown[]=[];const record=(e:unknown)=>{unhandled.push(e);};
 process.on("unhandledRejection",record);
 try {f.o.maxFrameBytes=28;await expect(runDirectPlay4JoinHandshake(f.o)).rejects.toThrow();
  await new Promise(resolve=>setTimeout(resolve,20));expect(unhandled).toEqual([]);expect(f.releases()).toEqual([1,1]);
 } finally {process.off("unhandledRejection",record);}
});
test("host refusal releases owners and never publishes a table",async()=>{
 const f=setup();f.table.rejectForward=true;
 await expect(runDirectPlay4JoinHandshake(f.o)).rejects.toThrow("name table rejected");
 expect(f.table.commands).toEqual([5,19]);expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
});
test("abort while awaiting reply and pre-abort release exact owners",async()=>{
 const f=setup();f.table.reply=false;const run=runDirectPlay4JoinHandshake(f.o);f.controller.abort();
 await expect(run).rejects.toThrow();expect(f.releases()).toEqual([1,1]);expect(f.table.sockets.size).toBe(0);
 const g=setup();g.controller.abort();await expect(runDirectPlay4JoinHandshake(g.o)).rejects.toThrow();expect(g.releases()).toEqual([1,1]);
});
