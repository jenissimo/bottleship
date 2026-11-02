import{afterEach,expect,test}from"bun:test";
import{LanNetwork,nodeToIpv4}from"../../src/worker/net/lan-network";
import{PROTO_UDP,decodeDatagram,encodeDatagram}from"../../src/worker/net/netplay-wire";
import{DN,decodeNativeProtocolFrame}from"../../src/worker/modules/dpnet/native-wire/frame-codec";
import{decodeNativeGroupDestroyRequest,encodeNativeGroupDestroyed}from"../../src/worker/modules/dpnet/native-wire/group-operations";
import{DirectPlay8Session}from"../../src/worker/modules/dpnet/peer";
import{NativeDirectPlayCore}from"../../src/worker/modules/dpnet/native-wire/core";
import{DPN}from"../../src/worker/modules/dpnet/constants";
import type{SessionDesc}from"../../src/worker/modules/dplayx/session";
import type{DirectPlay8HostReady,DirectPlay8HostRequest}from"../../src/worker/modules/dpnet/backend";
const desc:SessionDesc={instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",name:"Native Host",password:"",maxPlayers:2,flags:0,user:[0,0,0,0],extended:{flags:0,reserved:[],application:[]}};
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0))close();});
async function turns(){for(let i=0;i<16;i++)await Promise.resolve();}
function scene(peerTimeout=500){
 const nets=[21,22].map(n=>new LanNetwork(Uint8Array.of(2,0,0,0,0,n))),sent:number[]=[],wire:{side:number;data:Uint8Array}[]=[];let blockHost=false;
 for(const[i,net]of nets.entries())net.attach({send(frame){const dg=decodeDatagram(frame)!;sent.push(dg.proto);
  const native=decodeNativeProtocolFrame(dg.payload);if(native?.kind==="data"&&(native.command&DN.USER1)&&(native.command&DN.NEW_MESSAGE)&&(native.command&DN.END_MESSAGE))wire.push({side:i,data:native.payload.slice()});
  if(i===0&&blockHost)return true;nets[1-i].receiveFrame(encodeDatagram(dg.proto,net.node,dg.dstPort,dg.srcPort,dg.payload));return true;},close(){}});
 const session=new DirectPlay8Session(nets[0]);expect(session.initialize()).toBe(0);
 let releases=0,returns=0;const requests:DirectPlay8HostRequest[]=[],events:any[]=[];
 session.onEvent=e=>{events.push(e);if(e.type===0x10||e.type===6)e.processed?.();};session.onNativeIndicate=()=>({hr:0,data:Uint8Array.of(8,0,9),context:0x7201,returnBuffer(){returns++;}});
 const ready=(request:DirectPlay8HostRequest):DirectPlay8HostReady=>({address:{node:[2,1,127,0,0,1],port:request.localPort},
 allowIncoming:a=>a.node.every((n,i)=>n===nets[1].node[i]),url:a=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0.1;port="+a.port,release(){releases++;}});
 const provider={prepare:async(request:DirectPlay8HostRequest)=>{requests.push(request);return ready(request);}};
 const peer=new NativeDirectPlayCore(nets[1],"peer",peerTimeout,2);
 cleanup.push(()=>{peer.dispose();session.dispose();nets.forEach(n=>n.attach(null));});
 return{nets,session,peer,provider,requests,events,sent,wire,ready,blockHostTraffic(){blockHost=true;},get releases(){return releases;},get returns(){return returns;},
 start:()=>session.hostNative(desc,0x7100,provider,2308,[20,0,2,14,500]),
 join:()=>peer.connect({node:[...nets[0].node],port:2308},desc,{name:{short:"Peer",long:""},data:[1,2],flags:0},Uint8Array.of(4,0,5))};
}
test("native Host waits for real provider READY before CREATE, with exact virtual binding and advertised endpoint",async()=>{
 const s=scene();let finish!:(ready:DirectPlay8HostReady)=>void;
 const pending=s.session.hostNative(desc,0x7100,{prepare:r=>{s.requests.push(r);return new Promise(resolve=>finish=resolve);}},2308);
 expect(s.events).toEqual([]);expect(s.session.engine.entities.size).toBe(0);expect(s.session.error).toBe(DPN.CONNECTING);
 expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(true);expect(s.requests[0].bindingGeneration).toBe(s.nets[0].bindingGeneration(2308,PROTO_UDP));
 finish(s.ready(s.requests[0]));expect(await pending).toBe(0);expect(s.session.engine.kind).toBe("native");
 expect(s.session.engine.localAddress).toEqual({node:[...s.nets[0].node],port:2308});
 expect(s.session.engine.advertisedAddress).toEqual({node:[2,1,127,0,0,1],port:2308});
 expect(s.events.filter(e=>e.type===7)).toMatchObject([{id:s.session.localId,context:0x7100}]);
 expect(s.session.hostId).toBe(s.session.localId);expect(s.session.virtualProvider.desc).toBeNull();
 s.session.close();expect(s.releases).toBe(1);expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(false);
});
test("native Host creates a group without consuming a player slot",async()=>{
 const s=scene();expect(await s.start()).toBe(DPN.OK);
 const players=s.session.engine.currentPlayers;
 const result=await s.session.createGroup({name:"Squad-\u0416",data:[7,0,9],flags:0},0x1111);
 expect(result.hr).toBe(DPN.OK);expect(result.id).toBeGreaterThan(0);expect(result.id).not.toBe(s.session.localId);
 expect(s.session.engine.entities.get(result.id!)).toMatchObject({group:true,groupOwner:s.session.localId,
  flags:0,name:{short:"Squad-\u0416"},data:[7,0,9],members:[]});
 expect(s.events.filter(e=>e.type===6)).toMatchObject([{type:6,id:result.id,owner:0,context:0x1111}]);
 expect(s.events.filter(e=>e.type===6)).toHaveLength(1);
 expect(s.session.engine.currentPlayers).toBe(players);expect(s.session.virtualProvider.desc).toBeNull();
 expect(await s.join()).toBe(DPN.OK);
 expect(s.peer.entities.get(result.id!)).toMatchObject({group:true,groupOwner:s.session.localId,
  flags:0,name:{short:"Squad-\u0416"},data:[7,0,9],members:[]});
 expect(s.session.engine.currentPlayers).toBe(2);
});
test("native Host explicitly destroys an idle ordinary group with NORMAL context and a retained callback query",async()=>{
 const s=scene();expect(await s.start()).toBe(DPN.OK);
 const made=await s.session.createGroup({name:"explicit-idle",data:[6,0,9],flags:0},0x6161);
 expect(made.hr).toBe(DPN.OK);const id=made.id!;
 expect(s.session.isGroupCreated(id)).toBe(true);expect(s.session.groupEntity(id)?.members).toEqual([]);
 const players=s.session.engine.currentPlayers,version=(s.session.engine as any).host.version,destroyed:any[]=[];
 s.session.onEvent=e=>{if(e.type!==8)return;
  destroyed.push({id:e.id,context:e.context,reason:e.reason,query:structuredClone(s.session.groupEntity(e.id!)),
   queryContext:s.session.groupContexts.get(e.id!),players:s.session.engine.currentPlayers});
  e.processed?.();
 };
 // Source contract is the already-Created idle case, not a universal deferred-notification barrier.
 const result=await s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id});await turns();
 expect(result.hr).toBe(DPN.OK);
 expect(destroyed).toHaveLength(1);expect(destroyed[0]).toMatchObject({id,context:0x6161,reason:1,queryContext:0x6161,players,
  query:{id,group:true,flags:0,name:{short:"explicit-idle"},data:[6,0,9],members:[]}});
 expect(s.session.engine.entities.has(id)).toBe(false);expect(s.session.groupEntity(id)).toBeUndefined();
 expect(s.session.groupContexts.has(id)).toBe(false);expect(s.session.engine.currentPlayers).toBe(players);
 expect((s.session.engine as any).host.version).toBe(version+1);
});
test("provider READY retains its original lease receiver and snapshots the advertised address",async()=>{
 const s=scene();let released=0;
 class Ready {address={node:[2,1,127,0,0,1],port:45001};allowIncoming(){return true;}url(){return"x-directplay:/hostname=127.0.0.1;port=45002";}release(){expect(this).toBe(ready);released++;}}
 const ready=new Ready();
 expect(await s.session.hostNative(desc,0,{prepare:async()=>ready},2308)).toBe(0);ready.address.port=45099;
 expect(s.session.engine.advertisedAddress?.port).toBe(45001);s.session.close();expect(released).toBe(1);
});
test("Close while READY is pending settles now and releases a late old ACK without reviving a replacement",async()=>{
 const s=scene();let finish!:(ready:DirectPlay8HostReady)=>void;
 const pending=s.session.hostNative(desc,1,{prepare:r=>{s.requests.push(r);return new Promise(resolve=>finish=resolve);}},2308);
 s.session.close();expect(await pending).toBe(DPN.USERCANCEL);expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(false);
 expect(await s.start()).toBe(0);const current=s.session.localId;
 finish(s.ready(s.requests[0]));await turns();expect(s.releases).toBe(1);expect(s.session.localId).toBe(current);expect(s.session.engine.entities.size).toBe(1);
 s.session.close();expect(s.releases).toBe(2);
});
test("unanswered provider READY has a finite deadline and releases a later lease after timeout",async()=>{
 const s=scene();let finish!:(ready:DirectPlay8HostReady)=>void,result:number|undefined;
 const pending=s.session.hostNative(desc,0,{prepare:r=>{s.requests.push(r);return new Promise(resolve=>finish=resolve);}},2308,[20,0,2,14,20]).then(hr=>{result=hr;return hr;});
 await new Promise(resolve=>setTimeout(resolve,35));expect(result).toBe(DPN.TIMEDOUT);
 expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(false);finish(s.ready(s.requests[0]));await turns();expect(s.releases).toBe(1);expect(await pending).toBe(DPN.TIMEDOUT);
});
test("listener loss retires only its own Host epoch, including pending self processing",async()=>{
 const s=scene();let lost!:(reason:{code:number;message:string})=>void,live=true;
 const closed=new Promise<{code:number;message:string}>(resolve=>lost=resolve);
 expect(await s.session.hostNative(desc,0,{prepare:async r=>({...s.ready(r),isLive:()=>live,closed})},2308)).toBe(0);
 const id=s.session.localId,finished:number[]=[];
 const pending=s.session.send(id,12,Uint8Array.of(4),undefined,undefined,hr=>finished.push(hr));
 live=false;lost({code:10054,message:"native listener closed"});await turns();
 expect(finished).toEqual([DPN.CONNECTIONLOST]);expect(await pending).toBe(DPN.CONNECTIONLOST);
 expect(s.session.error).toBe(DPN.CONNECTIONLOST);expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(false);expect(s.releases).toBe(1);
 expect(await s.start()).toBe(0);await turns();expect(s.session.error).toBe(0);expect(s.releases).toBe(1);
});
test("READY failure or invalid advertised endpoint never publishes a virtual fallback session",async()=>{
 for(const invalid of [false,true]){
  const s=scene();expect(await s.session.hostNative(desc,0,{prepare:async request=>{if(!invalid)throw Error("native bind denied");return{...s.ready(request),address:{node:[2,1,127,0,0,1],port:0}};}},2308)).not.toBe(0);
  expect(s.events.filter(e=>e.type===7)).toEqual([]);expect(s.session.engine.entities.size).toBe(0);
  expect(s.session.virtualProvider.desc).toBeNull();expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(false);expect(s.releases).toBe(Number(invalid));
 }
});
test("native Host admission preserves contexts, reply ownership and direct wire sends through the structural backend",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 expect(s.returns).toBe(1);expect(s.peer.joinReply?.data).toEqual(Uint8Array.of(8,0,9));
 const remote=s.peer.localId;expect(s.session.contexts.get(remote)).toBe(0x7201);
 expect(s.events.filter(e=>e.type===7)).toMatchObject([{id:s.session.localId,context:0x7100},{id:remote,context:0x7201}]);
 expect(await s.session.send(remote,8,Uint8Array.of(7,0,8))).toBe(0);expect(s.peer.queue.at(-1)?.data).toEqual(Uint8Array.of(7,0,8));s.peer.removeMessage(0);
 expect(await s.peer.sendDpn(s.peer.hostId,8,Uint8Array.of(9,0,8))).toBe(0);
 expect(s.events.at(-1)).toMatchObject({type:0x11,id:remote,context:0x7201,data:Uint8Array.of(9,0,8)});
 expect(s.sent.every(proto=>proto===PROTO_UDP)).toBe(true);
 expect(await s.peer.shutdown()).toBe(0);expect(await s.session.beginClose()).toBe(0);s.session.close();expect(s.releases).toBe(1);
});
test("early C3 waits for the actual RETURN_BUFFER callback completion before remote CREATE",async()=>{
 const s=scene();let returned!:()=>void;
 s.session.onNativeIndicate=()=>({hr:0,data:Uint8Array.of(1,2),context:9,returnBuffer:()=>new Promise<void>(resolve=>returned=resolve)});
 expect(await s.start()).toBe(0);const joined=s.join();await turns();
 expect(s.session.engine.entities.size).toBe(1);expect(s.events.filter(e=>e.type===7)).toHaveLength(1);
 returned();expect(await joined).toBe(0);expect(s.events.filter(e=>e.type===7)).toHaveLength(2);
});
test("Close while reply callback is pending aborts admitted context once and cannot later CREATE",async()=>{
 const s=scene();let returned!:()=>void;
 s.session.onNativeIndicate=()=>({hr:0,data:Uint8Array.of(1),context:0x7201,returnBuffer:()=>new Promise<void>(resolve=>returned=resolve)});
 expect(await s.start()).toBe(0);const joined=s.join();await turns();s.session.close();
 expect(s.events.filter(e=>e.type===0xf)).toMatchObject([{context:0x7201}]);returned();await turns();
 expect(s.events.filter(e=>e.type===7)).toHaveLength(1);expect(s.releases).toBe(1);// Peer application admission may already complete from C2; only Host CREATE is gated.
 s.peer.dispose();await joined;
});
test("adapter loss settles retained self processing before discarding its receive queue",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const results:number[]=[];
 const pending=s.session.send(s.session.localId,12,Uint8Array.of(1),undefined,undefined,hr=>results.push(hr));
 s.nets[0].attach(null);expect(results).toEqual([DPN.CONNECTIONLOST]);expect(s.session.pendingLocalProcessing).toBe(0);
 expect(await pending).toBe(DPN.CONNECTIONLOST);expect(s.releases).toBe(1);
});
test("native Host local processing has finite bytes independently of consumer queue removal",async()=>{
 const s=scene();expect(await s.start()).toBe(0);s.session.onEvent=()=>{};
 const pending=[];for(let i=0;i<4;i++)pending.push(s.session.send(s.session.localId,12,new Uint8Array(1024*1024)));
 expect(s.session.pendingLocalProcessing).toBe(4);expect(await s.session.send(s.session.localId,12,new Uint8Array(1))).toBe(DPN.TABLEFULL);
 s.session.close();expect(await Promise.all(pending)).toEqual(Array(4).fill(DPN.USERCANCEL));expect(s.session.pendingLocalProcessing).toBe(0);
});
test("native Host shares exact-self acceptance and synchronous processing observer before any Promise yield",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const events:string[]=[],results:number[]=[];
 let processed!:()=>void;s.session.onEvent=e=>{if(e.type===0x11){events.push("receive");processed=e.processed!;}};
 const pending=s.session.send(s.session.localId,12,Uint8Array.of(3,0,4),undefined,()=>events.push("accepted"),hr=>results.push(hr));
 expect(events).toEqual(["receive","accepted"]);expect(s.session.pendingLocalProcessing).toBe(1);
 processed();expect(results).toEqual([0]);expect(s.session.pendingLocalProcessing).toBe(0);s.session.close();processed();expect(results).toEqual([0]);expect(await pending).toBe(0);
});
test("Close cancels native Host pending self processing once and cannot emit a late terminal observer",async()=>{
 const s=scene();expect(await s.start()).toBe(0);let processed!:()=>void;const results:number[]=[];
 s.session.onEvent=e=>{if(e.type===0x11)processed=e.processed!;};
 const pending=s.session.send(s.session.localId,12,Uint8Array.of(1),undefined,undefined,hr=>results.push(hr));
 s.session.close();expect(results).toEqual([DPN.USERCANCEL]);processed();expect(results).toHaveLength(1);expect(await pending).toBe(DPN.USERCANCEL);expect(s.releases).toBe(1);
});

test("native Host SetPeerInfo name mask publishes authority and preserves the unselected data",async()=>{
 const s=scene();expect(await s.session.setInfo(0,{name:"host-initial",data:[0x20,0,0x40,0],flags:0},3)).toBe(0);
 expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();s.events.length=0;
 expect(await s.session.setInfo(s.session.localId,{name:"host-\u0416",data:[0xee],flags:0},1)).toBe(0);
 await turns();
 expect(s.session.engine.entities.get(s.session.localId)).toMatchObject({name:{short:"host-\u0416"},data:[0x20,0,0x40,0]});
 expect(s.peer.entities.get(s.session.localId)).toMatchObject({name:{short:"host-\u0416"},data:[0x20,0,0x40,0]});
 expect(s.events.filter(e=>e.type===0x10)).toMatchObject([{id:s.session.localId,context:0x7100}]);
});
test("native Host processes a real D6 peer info request and completes it from authoritative DB",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();s.events.length=0;
 const id=s.peer.localId;
 expect((await s.peer.mutate({op:"mutate",action:"info",id,data:[0x31,0,0x50,1]})).hr).toBe(0);
 expect(s.peer.entities.get(id)).toMatchObject({name:{short:"Peer"},data:[0x31,0,0x50,1]});
 expect(s.session.engine.entities.get(id)).toMatchObject({name:{short:"Peer"},data:[0x31,0,0x50,1]});
 expect(s.events.filter(e=>e.type===0x10)).toMatchObject([{id,context:0x7201}]);
});

test("native Host rejects an info update before mutation when the real reliable queue is full",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();
 const before=structuredClone(s.session.engine.entities.get(s.session.localId));s.blockHostTraffic();
 const pending=[];for(let i=0;i<256;i++)pending.push(s.session.engine.sendDpn!(s.peer.localId,8,Uint8Array.of(1)));
 expect(await s.session.setInfo(s.session.localId,{name:"must-not-publish",data:[],flags:0},1)).toBe(DPN.TABLEFULL);
 expect(s.session.engine.entities.get(s.session.localId)).toEqual(before);s.session.close();
 expect(await Promise.all(pending)).toEqual(Array(256).fill(DPN.USERCANCEL));expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(false);
});
test("reentrant Close from native local INFO cancels its reserved broadcast before wire publication",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();let closed=0;
 s.session.onEvent=e=>{if(e.type===0x10){closed++;s.session.close();e.processed?.();}};
 expect(await s.session.setInfo(s.session.localId,{name:"retired",data:[],flags:0},1)).toBe(DPN.USERCANCEL);
 expect(closed).toBe(1);expect(s.peer.entities.get(s.peer.hostId)?.name.short).not.toBe("retired");expect(s.session.engine.entities.size).toBe(0);expect(s.nets[0].isBound(2308,PROTO_UDP)).toBe(false);
});
test("reentrant native local INFO updates preserve reserved authoritative FIFO order",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();let once=false,nested:unknown;
 const seen:string[]=[];s.peer.onChange=()=>{const name=s.peer.entities.get(s.peer.hostId)?.name.short;if(name&&seen.at(-1)!==name)seen.push(name);};
 s.session.onEvent=e=>{if(e.type===0x10&&!once){once=true;nested=s.session.setInfo(s.session.localId,{name:"inner",data:[],flags:0},1);}if(e.type===0x10)e.processed?.();};
 expect(await s.session.setInfo(s.session.localId,{name:"outer",data:[],flags:0},1)).toBe(0);expect(await nested).toBe(0);
 expect(seen).toEqual(["outer","inner"]);expect(s.peer.entities.get(s.peer.hostId)?.name.short).toBe("inner");
});

test("native Host reserves DB but publishes only after the local INFO consumer returns",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();let returned!:(result?:number)=>void;
 const before=s.peer.entities.get(s.session.localId)!.name.short;
 s.session.onEvent=e=>{if(e.type===0x10)returned=e.processed!;};
 expect(await s.session.setInfo(s.session.localId,{name:"after-handler",data:[],flags:0},1)).toBe(0);
 expect(s.peer.entities.get(s.session.localId)!.name.short).toBe(before);expect(returned).toBeFunction();
 returned();await turns();expect(s.peer.entities.get(s.session.localId)!.name.short).toBe("after-handler");returned();expect(s.peer.entities.get(s.session.localId)!.name.short).toBe("after-handler");
});

test("native repeated empty DATA updates notify Host and the receiving Peer even when bytes are unchanged",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();s.events.length=0;
 const infos:number[]=[];(s.peer as any).onInfo=(id:number,returned:(hr?:number)=>void)=>{infos.push(id);returned();};
 for(let n=0;n<2;n++)expect(await s.session.setInfo(s.session.localId,{name:"",data:[],flags:0},2)).toBe(0);
 await turns();expect(s.events.filter(e=>e.type===0x10)).toHaveLength(2);expect(infos).toEqual([s.session.localId,s.session.localId]);
});

test("received native DB completes its request once after INFO return and ignores a stale return after Close",async()=>{
 for(const close of[false,true]){
  const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);await turns();
  let returned!:(hr?:number)=>void,complete=0;(s.peer as any).onInfo=(_id:number,done:(hr?:number)=>void)=>{returned=done;};
  const pending=s.peer.mutate({op:"mutate",action:"info",id:s.peer.localId,data:[8,0,9]}) as Promise<any>;void pending.then(()=>complete++);
  await turns();expect(returned).toBeFunction();expect(complete).toBe(0);
  if(close)s.peer.close();returned();returned();expect((await pending).hr).toBe(close?DPN.CONNECTIONLOST:0);await turns();expect(complete).toBe(1);
 }
});

test("native group publication waits for actual Host return while later versions remain independently committed",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const held:any[]=[];s.session.onEvent=e=>{if(e.type===6)held.push(e);};
 const completed:any[]=[];
 const outer=s.session.beginCreateGroup({name:"outer",data:[1,0,2],flags:0},0x1111,r=>completed.push(r));
 expect(held).toHaveLength(1);const first=held[0].id;
 expect(s.session.engine.entities.get(first)?.group).toBe(true);expect(s.session.isGroupCreated(first)).toBe(false);
 expect(s.peer.entities.has(first)).toBe(false);expect(completed).toEqual([]);
 const inner=s.session.beginCreateGroup({name:"inner",data:[],flags:1},0x2222,r=>completed.push(r));
 expect(held).toHaveLength(2);const second=held[1].id;expect(second).not.toBe(first);
 expect(held[1].owner).toBe(s.session.localId);expect(held[0].owner).toBe(0);
 held[1].processed();expect((await inner).hr).toBe(0);
 expect(completed).toHaveLength(1);expect(s.peer.entities.has(second)).toBe(false);// v+1 must wait for outer v.
 held[0].processed();expect((await outer).hr).toBe(0);await turns();
 expect(s.peer.entities.get(first)?.name.short).toBe("outer");
 expect(s.peer.entities.get(second)?.name.short).toBe("inner");
 expect(s.session.isGroupCreated(first)).toBe(true);expect(s.session.engine.currentPlayers).toBe(2);
 held[0].processed();held[1].processed();expect(completed).toHaveLength(2);
});
test("real remote D2 carries request-local context through D7 and completes after requester return",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 let returned!:(hr?:number)=>void,context=-1,id=0,completed=0;
 s.peer.onGroupCreated=(created,done,initial)=>{id=created;context=initial!;returned=done;};
 const pending=s.peer.mutate({op:"mutate",action:"create",group:true,flags:1,
  name:{short:"remote-Ж",long:""},data:[9,0,8],context:0x4444,completed:()=>completed++});
 await turns();expect(returned).toBeFunction();expect(context).toBe(0x4444);expect(completed).toBe(0);
 expect(s.session.engine.entities.get(id)).toMatchObject({group:true,groupOwner:s.peer.localId,flags:1,data:[9,0,8],name:{short:"remote-Ж"}});
 expect(s.events.filter(e=>e.type===6)).toMatchObject([{id,owner:s.peer.localId,context:0}]);
 returned();expect((await pending).hr).toBe(0);returned();await turns();expect(completed).toBe(1);
});
test("Close retires a held group create once and a late return cannot publish into a replacement",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 let event:any;const completions:number[]=[];
 s.session.onEvent=e=>{if(e.type===6)event=e;};
 const pending=s.session.beginCreateGroup({name:"retired",data:[],flags:0},0x5555,r=>completions.push(r.hr));
 const old=event.id;expect(s.peer.entities.has(old)).toBe(false);s.session.close();
 expect((await pending).hr).toBe(DPN.USERCANCEL);expect(completions).toEqual([DPN.USERCANCEL]);
 expect(await s.start()).toBe(0);event.processed();await turns();
 expect(s.session.engine.entities.size).toBe(1);expect(s.session.groupContexts.has(old)).toBe(false);
 expect(completions).toHaveLength(1);expect(s.peer.entities.has(old)).toBe(false);
});

test("a receiving D7 drain waits for its own CREATE_GROUP return before advancing an already queued version",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const hostEvents:any[]=[],peerEvents:{id:number;done:(hr?:number)=>void}[]=[];
 s.session.onEvent=e=>{if(e.type===6)hostEvents.push(e);};
 s.peer.onGroupCreated=(id,done)=>{peerEvents.push({id,done});};
 const first=s.session.beginCreateGroup({name:"first",data:[],flags:0},1);
 const second=s.session.beginCreateGroup({name:"second",data:[],flags:0},2);
 hostEvents[1].processed();expect((await second).hr).toBe(0);expect(peerEvents).toEqual([]);
 hostEvents[0].processed();expect((await first).hr).toBe(0);
 expect(peerEvents.map(e=>e.id)).toEqual([hostEvents[0].id]);
 peerEvents[0].done();expect(peerEvents.map(e=>e.id)).toEqual([hostEvents[0].id,hostEvents[1].id]);
 peerEvents[1].done();expect(s.peer.entities.size).toBe(4);
});

test("accepted D7 retires its wire timeout while the requesting CREATE_GROUP callback remains held",async()=>{
 const s=scene(80);expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 let returned!:(hr?:number)=>void,complete=0;
 s.peer.onGroupCreated=(_id,done)=>{returned=done;};
 const pending=s.peer.mutate({op:"mutate",action:"create",group:true,flags:0,name:{short:"held",long:""},data:[],
  context:0x1234,completed:()=>complete++});
 await turns();expect(returned).toBeFunction();
 // Keep the actual link live: its separate idle deadline also uses 80ms.
 for(let n=0;n<4;n++){
  await new Promise(resolve=>setTimeout(resolve,40));
  expect(await s.session.send(s.peer.localId,8,Uint8Array.of(n))).toBe(0);
  expect(s.peer.openError).toBe(0);expect(complete).toBe(0);
 }
 returned();expect((await pending).hr).toBe(0);returned();expect(complete).toBe(1);
});

test("owner departure implicitly destroys only its AUTODESTRUCT groups with the rewritten local context",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 s.session.onEvent=e=>{s.events.push(e);if(e.type===6){
  s.session.groupContexts.set(e.id!,e.owner?0xa070:0xb070);e.processed?.();}};
 const make=(flags:number)=>s.peer.mutate({op:"mutate",action:"create",group:true,flags,name:{short:"group-"+flags,long:""},data:[]});
 const ordinary=await make(0),auto=await make(1);expect(ordinary.hr).toBe(0);expect(auto.hr).toBe(0);
 expect(s.session.groupContexts.get(auto.id!)).toBe(0xa070);
 const version=(s.session.engine as any).host.version;s.events.length=0;
 expect(await s.peer.shutdown()).toBe(0);await turns();
 expect(s.session.engine.entities.has(auto.id!)).toBe(false);
 expect(s.session.engine.entities.get(ordinary.id!)).toMatchObject({group:true,flags:0});
 expect(s.events.filter(e=>e.type===8)).toMatchObject([{type:8,id:auto.id,context:0xa070,reason:2}]);
 expect(s.events.filter(e=>e.type===8)).toHaveLength(1);
 expect(s.session.engine.currentPlayers).toBe(1);
 expect((s.session.engine as any).host.version).toBe(version+1);// One owner D1, no invented D8/version.
});

test("an observing native peer derives AUTO cleanup from owner D1 and keeps its own rewritten context",async()=>{
 const nets=[31,32,33].map(n=>new LanNetwork(Uint8Array.of(2,0,0,0,0,n)));
 for(const net of nets)net.attach({send(frame){
  const d=decodeDatagram(frame)!,target=nets.find(other=>other.node.every((n,i)=>n===d.node[i]));
  if(!target)return false;
  target.receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;
 },close(){}});
 const host=new DirectPlay8Session(nets[0]),creator=new NativeDirectPlayCore(nets[1],"peer",500,2),observer=new DirectPlay8Session(nets[2]);
 cleanup.push(()=>{creator.dispose();observer.dispose();host.dispose();nets.forEach(n=>n.attach(null));});
 const hostEvents:any[]=[],observerEvents:any[]=[];
 host.onEvent=e=>{hostEvents.push(e);if(e.type===6){host.groupContexts.set(e.id!,e.owner?0xa070:0xb070);e.processed?.();}};
 observer.onEvent=e=>{observerEvents.push(e);if(e.type===6){observer.groupContexts.set(e.id!,e.owner?0xc070:0xd070);e.processed?.();}};
 host.onNativeIndicate=()=>({hr:0});expect(host.initialize()).toBe(0);expect(observer.initialize()).toBe(0);
 const app={...desc,maxPlayers:3},address={node:[...nets[0].node],port:2308};
 expect(await host.hostNative(app,0,{prepare:async r=>({address:r.localAddress,allowIncoming:()=>true,
  url:a=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname="+[...nodeToIpv4(Uint8Array.from(a.node))].join(".")+";port="+a.port,release(){}})},2308,[20,0,2,14,500])).toBe(0);
 expect(await creator.connect(address,app,{name:{short:"creator",long:""},data:[],flags:0},new Uint8Array())).toBe(0);
 expect(await observer.connectNative(address,app,0,new Uint8Array(),0,[20,0,2,14,500])).toBe(0);
 const make=(flags:number)=>creator.mutate({op:"mutate",action:"create",group:true,flags,name:{short:"shared-"+flags,long:""},data:[flags]});
 const ordinary=await make(0),auto=await make(1);expect(ordinary.hr).toBe(0);expect(auto.hr).toBe(0);await turns();
 expect(observer.groupContexts.get(auto.id!)).toBe(0xc070);expect(host.groupContexts.get(auto.id!)).toBe(0xa070);
 hostEvents.length=observerEvents.length=0;const version=(host.engine as any).host.version;
 expect(await creator.shutdown()).toBe(0);await turns();
 for(const session of[host,observer]){
  expect(session.engine.entities.has(auto.id!)).toBe(false);
  expect(session.engine.entities.get(ordinary.id!)).toMatchObject({group:true,flags:0,data:[0]});
  expect(session.engine.currentPlayers).toBe(2);
 }
 expect(hostEvents.filter(e=>e.type===8)).toMatchObject([{type:8,id:auto.id,context:0xa070,reason:2}]);
 expect(hostEvents.filter(e=>e.type===8)).toHaveLength(1);
 expect(observerEvents.filter(e=>e.type===8)).toMatchObject([{type:8,id:auto.id,context:0xc070,reason:2}]);
 expect(observerEvents.filter(e=>e.type===8)).toHaveLength(1);
 expect((host.engine as any).host.version).toBe(version+1);
 expect((observer.engine as any).version).toBe(version+1);
});

test("a held retired group query cannot leak into a replacement Host or erase its later context",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);let destroyed:any;
 s.session.onEvent=e=>{if(e.type===6){s.session.groupContexts.set(e.id!,0xa070);e.processed?.();}if(e.type===8)destroyed=e;};
 const made=await s.peer.mutate({op:"mutate",action:"create",group:true,flags:1,name:{short:"retired",long:""},data:[7]});
 expect(made.hr).toBe(0);expect(await s.peer.shutdown()).toBe(0);await turns();
 expect(s.session.groupEntity(made.id!)?.data).toEqual([7]);expect(destroyed.isCurrent()).toBe(true);
 s.session.close();expect(await s.start()).toBe(0);
 expect(s.session.groupEntity(made.id!)).toBeUndefined();expect(destroyed.isCurrent()).toBe(false);
 s.session.groupContexts.set(made.id!,0xeeee);destroyed.processed();destroyed.processed();
 expect(s.session.groupContexts.get(made.id!)).toBe(0xeeee);
});

const coreWords=(data:Uint8Array)=>{const view=new DataView(data.buffer,data.byteOffset,data.byteLength);return Array.from({length:data.length/4},(_,i)=>view.getUint32(i*4,true));};
test("D5 and D8 use literal source-derived DWORD layouts and reject a nonexact request extent",()=>{
 const request=Uint8Array.of(0xd5,0,0,0,0x40,0x30,0x20,0x10,0x44,0x33,0x22,0x11);
 const padded=Uint8Array.from([0xee,...request,0xef]);
 expect(decodeNativeGroupDestroyRequest(padded.subarray(1,13))).toEqual({handle:0x10203040,id:0x11223344});
 expect(decodeNativeGroupDestroyRequest(request.subarray(0,11))).toBeNull();
 expect(decodeNativeGroupDestroyRequest(padded.subarray(1))).toBeNull();
 const zeroToken=request.slice();zeroToken.fill(0,4,8);expect(decodeNativeGroupDestroyRequest(zeroToken)?.handle).toBe(0);
 expect(encodeNativeGroupDestroyed(0x11223344,0x12345678,0xaabbccdd,0x10203040)).toEqual(Uint8Array.of(
  0xd8,0,0,0,0x44,0x33,0x22,0x11,0x78,0x56,0x34,0x12,0,0,0,0,0xdd,0xcc,0xbb,0xaa,0x40,0x30,0x20,0x10));
});
test("authenticated remote D5 can destroy another owner's ordinary group and returns duplicate DE while Host is held",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"host-owned",data:[4,0,7],flags:0},0x7171);expect(made.hr).toBe(0);
 const id=made.id!,version=(s.session.engine as any).host.version,players=s.session.engine.currentPlayers,held:any[]=[],completed:number[]=[];
 s.session.onEvent=e=>{if(e.type===8)held.push(e);};s.wire.length=0;
 const pending=s.peer.mutate({op:"mutate",action:"destroy",group:true,id,completed:(r:{hr:number})=>completed.push(r.hr)});
 await turns();expect(held).toHaveLength(1);expect(completed).toEqual([]);
 expect(s.session.groupEntity(id)?.data).toEqual([4,0,7]);expect(s.peer.entities.get(id)?.groupOwner).toBe(s.session.localId);
 expect((s.session.engine as any).host.version).toBe(version);expect((s.peer as any).version).toBe(version);
 expect(await s.session.setInfo(id,{name:"must-not-update",data:[99],flags:0},3)).toBe(DPN.INVALIDGROUP);
 expect(s.session.groupEntity(id)?.name.short).toBe("host-owned");expect((s.session.engine as any).host.version).toBe(version);
 const duplicate=await s.peer.mutate({op:"mutate",action:"destroy",group:true,id});
 expect(duplicate.hr).toBe(DPN.INVALIDGROUP);expect(completed).toEqual([]);expect(held).toHaveLength(1);
 const requests=s.wire.filter(p=>p.side===1&&coreWords(p.data)[0]===0xd5).map(p=>coreWords(p.data));
 expect(requests).toHaveLength(2);const token=requests[0][1],duplicateToken=requests[1][1];
 expect(token).toBeGreaterThan(0);expect(duplicateToken).not.toBe(token);
 expect(requests).toEqual([[0xd5,token,id],[0xd5,duplicateToken,id]]);
 expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xde).map(p=>coreWords(p.data))).toEqual([[0xde,duplicateToken,DPN.INVALIDGROUP]]);
 expect(s.wire.some(p=>p.side===0&&coreWords(p.data)[0]===0xd8)).toBe(false);
 held[0].processed();expect((await pending).hr).toBe(0);held[0].processed();await turns();
 expect(completed).toEqual([0]);expect(held[0]).toMatchObject({id,context:0x7171,reason:1});expect(held).toHaveLength(1);
 expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xd8).map(p=>coreWords(p.data))).toEqual([[0xd8,id,version+1,0,s.peer.localId,token]]);
 expect(s.session.engine.entities.has(id)).toBe(false);expect(s.peer.entities.has(id)).toBe(false);
 expect(s.session.engine.currentPlayers).toBe(players);expect(s.peer.currentPlayers).toBe(players);
 expect((s.session.engine as any).host.version).toBe(version+1);expect((s.peer as any).version).toBe(version+1);
});
test("idle Host DestroyGroup commits its current version after a reentrant CREATE rather than overwriting that version",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"outer-destroy",data:[],flags:0},0x1111);expect(made.hr).toBe(0);
 const version=(s.session.engine as any).host.version,players=s.session.engine.currentPlayers,seen:number[]=[];let nested:any;
 s.session.onEvent=e=>{if(e.type===6||e.type===8)e.processed?.();};
 s.session.engine.onGroupDestroyed=(_id,done)=>{
  seen.push((s.session.engine as any).host.version);
  nested=s.session.beginCreateGroup({name:"inner-create",data:[9],flags:0},0x2222);
  done();
 };s.wire.length=0;
 const result=s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id:made.id});
 expect(result instanceof Promise).toBe(false);expect((await result).hr).toBe(0);expect(nested.hr).toBe(0);await turns();
 expect(seen).toEqual([version]);expect((s.session.engine as any).host.version).toBe(version+2);
 expect((s.peer as any).version).toBe(version+2);expect(s.peer.entities.has(made.id!)).toBe(false);
 expect(s.peer.entities.get(nested.id)?.name.short).toBe("inner-create");expect(s.session.engine.currentPlayers).toBe(players);
 const operations=s.wire.filter(p=>p.side===0).map(p=>coreWords(p.data)).filter(w=>w[0]===0xd7||w[0]===0xd8);
 expect(operations.map(w=>[w[0],w[0]===0xd7?w[6]:w[2]])).toEqual([[0xd7,version+1],[0xd8,version+2]]);
 expect(operations[1]).toEqual([0xd8,made.id,version+2,0,s.session.localId,0]);
});
test("Close settles a held Host destruction once and its late return cannot destroy a replacement generation",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"close-held",data:[5],flags:0},0x5151);expect(made.hr).toBe(0);
 let held:any;const completed:number[]=[];s.session.onEvent=e=>{if(e.type===8)held=e;};s.wire.length=0;
 const pending=s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id:made.id,completed:(r:{hr:number})=>completed.push(r.hr)});
 expect(held).toBeDefined();expect(s.session.groupEntity(made.id!)?.data).toEqual([5]);expect(completed).toEqual([]);
 s.session.close();expect((await pending).hr).toBe(DPN.USERCANCEL);expect(completed).toEqual([DPN.USERCANCEL]);
 expect(await s.start()).toBe(0);const version=(s.session.engine as any).host.version,local=s.session.localId;
 held.processed();held.processed();await turns();
 expect(completed).toEqual([DPN.USERCANCEL]);expect(s.session.engine.entities.size).toBe(1);expect(s.session.engine.entities.has(local)).toBe(true);
 expect((s.session.engine as any).host.version).toBe(version);
 expect(s.wire.some(p=>p.side===0&&coreWords(p.data)[0]===0xd8)).toBe(false);
});
test("invalid explicit Host group IDs do not notify or mutate the table version",async()=>{
 const s=scene();expect(await s.start()).toBe(0);let callbacks=0;s.session.onEvent=e=>{if(e.type===8)callbacks++;};
 const version=(s.session.engine as any).host.version;
 for(const id of[0,s.session.localId,0xdeadbeef,-1]){
  const result=await s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id});expect(result.hr).toBe(DPN.INVALIDGROUP);
 }
 expect(callbacks).toBe(0);expect(s.session.engine.entities.size).toBe(1);expect((s.session.engine as any).host.version).toBe(version);
});

test("receiving a real correlated D8 infrastructure failure never adopts its version or completes the D5 successfully",async()=>{
 for(const mode of["cancel","throw","ok-then-throw"]as const){
  const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
  const made=await s.session.createGroup({name:"peer-infrastructure-"+mode,data:[8],flags:0},0x1818);expect(made.hr).toBe(0);
  const version=(s.peer as any).version,results:any[]=[],callbacks:any[]=[];s.session.onEvent=e=>{if(e.type===8)e.processed?.();};
  s.peer.onGroupDestroyed=(id,done)=>{
   callbacks.push({id,data:s.peer.entities.get(id)?.data.slice(),version:(s.peer as any).version});
   if(mode==="cancel"){done(DPN.USERCANCEL);return;}
   if(mode==="ok-then-throw")done();
   throw Error("intentional receiving infrastructure failure");
  };
  const result=await s.peer.mutate({op:"mutate",action:"destroy",group:true,id:made.id,completed:(r:{hr:number})=>{
   results.push({hr:r.hr,version:(s.peer as any).version,queryable:s.peer.entities.has(made.id!)});
  }});await turns();
  const error=mode==="cancel"?DPN.USERCANCEL:DPN.GENERIC;
  expect(result.hr).toBe(error);expect(results).toEqual([{hr:error,version,queryable:true}]);
  expect(callbacks).toEqual([{id:made.id,data:[8],version}]);
  expect(s.peer.openError).not.toBe(DPN.OK);
  expect(s.session.engine.entities.has(made.id!)).toBe(false);expect((s.session.engine as any).host.version).toBe(version+1);
 }
});
test("Host destruction infrastructure failure including a throw after done OK cannot commit D8 or complete OK",async()=>{
 for(const mode of["cancel","throw","ok-then-throw"]as const){
  const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
  const made=await s.session.createGroup({name:"host-infrastructure-"+mode,data:[3],flags:0},0x1313);expect(made.hr).toBe(0);
  const version=(s.session.engine as any).host.version,results:any[]=[];s.wire.length=0;
  s.session.engine.onGroupDestroyed=(_id,done)=>{
   if(mode==="cancel"){done(DPN.USERCANCEL);return;}
   if(mode==="ok-then-throw")done();
   throw Error("intentional Host infrastructure failure");
  };
  const result=await s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id:made.id,completed:(r:{hr:number})=>{
   results.push({hr:r.hr,version:(s.session.engine as any).host.version,queryable:s.session.engine.entities.has(made.id!)});
  }});await turns();
  const error=mode==="cancel"?DPN.USERCANCEL:DPN.GENERIC;
  expect(result.hr).toBe(error);expect(results).toEqual([{hr:error,version,queryable:true}]);
  expect(s.wire.some(p=>p.side===0&&coreWords(p.data)[0]===0xd8)).toBe(false);
  expect(s.session.error).not.toBe(DPN.OK);
 }
});

test("native Host adds its existing local player to an idle ordinary group before the ADD callback",async()=>{
 const s=scene();expect(await s.session.setInfo(0,{name:"local-member",data:[],flags:0},1)).toBe(DPN.OK);
 expect(await s.start()).toBe(DPN.OK);
 const made=await s.session.createGroup({name:"member-idle",data:[2,0,6],flags:0},0x6262);expect(made.hr).toBe(DPN.OK);
 const id=made.id!,player=s.session.localId,players=s.session.engine.currentPlayers,version=(s.session.engine as any).host.version,added:any[]=[];
 expect(s.session.isGroupCreated(id)).toBe(true);expect(s.session.groupEntity(id)?.members).toEqual([]);
 s.session.onEvent=e=>{if(e.type!==1)return;
  const group=s.session.groupEntity(e.id!),member=s.session.engine.entities.get(e.player!);
  added.push({id:e.id,player:e.player,groupContext:e.groupContext,playerContext:e.playerContext,
   groupName:group?.name.short,playerName:member?.name.short,members:group?.members.slice(),
   version:(s.session.engine as any).host.version,players:s.session.engine.currentPlayers});
  e.processed?.();
 };
 const result=await s.session.member(id,player,true);await turns();
 expect(result).toBe(DPN.OK);expect(added).toEqual([{id,player,groupContext:0x6262,playerContext:0x7100,
  groupName:"member-idle",playerName:"local-member",members:[player],version:version+1,players}]);
 expect(s.session.groupEntity(id)?.members).toEqual([player]);expect(s.session.engine.currentPlayers).toBe(players);
 expect((s.session.engine as any).host.version).toBe(version+1);
});

test("remote nonowner D3 and D4 use exact reserved versions and duplicate DE without an extra ADD callback",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"member-host-owned",data:[7],flags:0},0xa101);expect(made.hr).toBe(0);
 const id=made.id!,player=s.session.localId,version=(s.session.engine as any).host.version,players=s.session.engine.currentPlayers;
 const held:any[]=[],removed:any[]=[],completed:number[]=[];s.wire.length=0;
 s.session.onEvent=e=>{
  if(e.type===1)held.push({event:e,members:s.session.groupEntity(id)?.members.slice(),version:(s.session.engine as any).host.version});
  if(e.type===0x12){removed.push({id:e.id,player:e.player,groupContext:e.groupContext,playerContext:e.playerContext,
   members:s.session.groupEntity(id)?.members.slice(),version:(s.session.engine as any).host.version});e.processed?.();}
 };
 const pending=s.peer.mutate({op:"mutate",action:"member",id,member:player,add:true,completed:(r:{hr:number})=>completed.push(r.hr)});
 await turns();expect(held).toHaveLength(1);expect(completed).toEqual([]);
 expect(held[0]).toMatchObject({members:[player],version:version+1,event:{id,player,groupContext:0xa101,playerContext:0x7100}});
 expect(s.peer.entities.get(id)?.members).toEqual([]);expect((s.peer as any).version).toBe(version);
 const duplicate=await s.peer.mutate({op:"mutate",action:"member",id,member:player,add:true});
 expect(duplicate.hr).toBe(DPN.PLAYERALREADYINGROUP);expect(held).toHaveLength(1);expect((s.session.engine as any).host.version).toBe(version+1);
 const requests=s.wire.filter(p=>p.side===1&&coreWords(p.data)[0]===0xd3).map(p=>coreWords(p.data));
 expect(requests).toHaveLength(2);const token=requests[0][1],duplicateToken=requests[1][1];
 expect(token).toBeGreaterThan(0);expect(duplicateToken).not.toBe(token);
 expect(requests).toEqual([[0xd3,token,id,player],[0xd3,duplicateToken,id,player]]);
 expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xde).map(p=>coreWords(p.data))).toEqual([[0xde,duplicateToken,DPN.PLAYERALREADYINGROUP]]);
 expect(s.wire.some(p=>p.side===0&&coreWords(p.data)[0]===0xd9)).toBe(false);
 held[0].event.processed();expect((await pending).hr).toBe(0);held[0].event.processed();await turns();
 expect(completed).toEqual([0]);expect(s.peer.entities.get(id)?.members).toEqual([player]);
 expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xd9).map(p=>coreWords(p.data))).toEqual([[0xd9,id,player,version+1,0,s.peer.localId,token]]);
 const removal=await s.peer.mutate({op:"mutate",action:"member",id,member:player,add:false});expect(removal.hr).toBe(0);await turns();
 expect(removed).toEqual([{id,player,groupContext:0xa101,playerContext:0x7100,members:[],version:version+2}]);
 const removeRequests=s.wire.filter(p=>p.side===1&&coreWords(p.data)[0]===0xd4).map(p=>coreWords(p.data));
 expect(removeRequests).toHaveLength(1);expect(removeRequests[0]).toEqual([0xd4,removeRequests[0][1],id,player]);
 expect(removeRequests[0][1]).toBeGreaterThan(0);
 expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xda).map(p=>coreWords(p.data))).toEqual([[0xda,id,player,version+2,0,s.peer.localId,removeRequests[0][1]]]);
 expect(s.session.groupEntity(id)?.members).toEqual([]);expect(s.peer.entities.get(id)?.members).toEqual([]);
 expect((s.peer as any).version).toBe(version+2);expect(s.session.engine.currentPlayers).toBe(players);
});
test("membership publication keeps its reserved version after an inline nested CREATE commits the next version",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"member-outer",data:[],flags:0},1);expect(made.hr).toBe(0);
 const id=made.id!,player=s.session.localId,version=(s.session.engine as any).host.version,seen:any[]=[];let nested:any;
 s.session.onEvent=e=>{if(e.type===6)e.processed?.();};
 s.session.engine.onGroupMember=(group,member,add,done)=>{
  seen.push({group,member,add,members:s.session.groupEntity(group)?.members.slice(),version:(s.session.engine as any).host.version});
  nested=s.session.beginCreateGroup({name:"member-inner",data:[8],flags:0},2);done();
 };s.wire.length=0;
 const result=s.session.engine.mutate({op:"mutate",action:"member",id,member:player,add:true});
 expect(result instanceof Promise).toBe(false);expect((await result).hr).toBe(0);expect(nested.hr).toBe(0);await turns();
 expect(seen).toEqual([{group:id,member:player,add:true,members:[player],version:version+1}]);
 const operations=s.wire.filter(p=>p.side===0).map(p=>coreWords(p.data)).filter(w=>w[0]===0xd7||w[0]===0xd9);
 expect(operations.map(w=>[w[0],w[0]===0xd7?w[6]:w[3]])).toEqual([[0xd7,version+2],[0xd9,version+1]]);
 expect(operations[1]).toEqual([0xd9,id,player,version+1,0,s.session.localId,0]);
 expect((s.session.engine as any).host.version).toBe(version+2);expect((s.peer as any).version).toBe(version+2);
 expect(s.peer.entities.get(id)?.members).toEqual([player]);expect(s.peer.entities.get(nested.id)?.name.short).toBe("member-inner");
});
test("Destroy of a stable member waits for its own implicit REMOVE and DESTROY returns without publishing DA",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"destroy-linked-member",data:[3],flags:0},0xa202);expect(made.hr).toBe(0);
 const id=made.id!,player=s.session.localId;s.session.onEvent=e=>{if(e.type===1)e.processed?.();};
 expect(await s.session.member(id,player,true)).toBe(0);
 const version=(s.session.engine as any).host.version,players=s.session.engine.currentPlayers,removed:any[]=[],destroyed:any[]=[],completed:number[]=[];
 s.session.onEvent=e=>{if(e.type===0x12)removed.push(e);if(e.type===8)destroyed.push(e);};s.wire.length=0;
 const pending=s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id,completed:(r:{hr:number})=>completed.push(r.hr)});
 expect(removed).toHaveLength(1);expect(removed[0]).toMatchObject({id,player,groupContext:0xa202,playerContext:0x7100});
 expect(s.session.groupEntity(id)?.members).toEqual([]);expect(s.session.engine.groupState?.(id)).toBe("disconnecting");
 expect(destroyed).toEqual([]);expect(completed).toEqual([]);expect((s.session.engine as any).host.version).toBe(version);
 expect((await s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id})).hr).toBe(DPN.INVALIDGROUP);
 removed[0].processed();expect(destroyed).toHaveLength(1);expect(completed).toEqual([]);
 expect(destroyed[0]).toMatchObject({id,context:0xa202,reason:1});expect(s.session.groupEntity(id)?.data).toEqual([3]);
 expect((s.session.engine as any).host.version).toBe(version);expect(s.wire.some(p=>p.side===0&&[0xd8,0xda].includes(coreWords(p.data)[0]))).toBe(false);
 destroyed[0].processed();expect((await pending).hr).toBe(0);removed[0].processed();destroyed[0].processed();await turns();
 expect(completed).toEqual([0]);expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xd8).map(p=>coreWords(p.data))).toEqual([[0xd8,id,version+1,0,s.session.localId,0]]);
 expect(s.wire.some(p=>p.side===0&&coreWords(p.data)[0]===0xda)).toBe(false);
 expect(s.session.groupEntity(id)).toBeUndefined();expect(s.peer.entities.has(id)).toBe(false);
 expect((s.peer as any).version).toBe(version+1);expect(s.session.engine.currentPlayers).toBe(players);
});
test("an already unlinked held REMOVE permits D8 but retains queries and defers DESTROY until its last notification reference returns",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"external-remove-reference",data:[4],flags:0},0xa303);expect(made.hr).toBe(0);
 const id=made.id!,player=s.session.localId;s.session.onEvent=e=>{if(e.type===1)e.processed?.();};
 expect(await s.session.member(id,player,true)).toBe(0);
 const version=(s.session.engine as any).host.version,removed:any[]=[],destroyed:any[]=[],removeCompleted:number[]=[],destroyCompleted:number[]=[];
 s.session.onEvent=e=>{if(e.type===0x12)removed.push(e);if(e.type===8)destroyed.push(e);};s.wire.length=0;
 const removal=s.session.engine.mutate({op:"mutate",action:"member",id,member:player,add:false,completed:(r:{hr:number})=>removeCompleted.push(r.hr)});
 expect(removed).toHaveLength(1);expect(s.session.groupEntity(id)?.members).toEqual([]);expect((s.session.engine as any).host.version).toBe(version+1);
 const destruction=s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id,completed:(r:{hr:number})=>destroyCompleted.push(r.hr)});
 expect(destruction instanceof Promise).toBe(false);expect((await destruction).hr).toBe(0);expect(destroyCompleted).toEqual([0]);
 expect(destroyed).toEqual([]);expect(removeCompleted).toEqual([]);expect(s.session.engine.entities.has(id)).toBe(false);
 expect(s.session.engine.groupState?.(id)).toBe("deleted");expect(s.session.engine.queryGroup?.(id)?.data).toEqual([4]);
 expect(s.session.groupEntity(id)?.data).toEqual([4]);expect(s.session.groupContexts.get(id)).toBe(0xa303);
 expect((await s.session.engine.mutate({op:"mutate",action:"destroy",group:true,id})).hr).toBe(DPN.CONNECTIONLOST);
 expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xd8).map(p=>coreWords(p.data))).toEqual([[0xd8,id,version+2,0,s.session.localId,0]]);
 expect(s.wire.some(p=>p.side===0&&coreWords(p.data)[0]===0xda)).toBe(false);
 removed[0].processed();expect(destroyed).toHaveLength(1);expect(removeCompleted).toEqual([]);
 expect(destroyed[0]).toMatchObject({id,context:0xa303,reason:1});expect(s.session.groupEntity(id)?.data).toEqual([4]);
 destroyed[0].processed();expect((await removal).hr).toBe(0);removed[0].processed();destroyed[0].processed();await turns();
 expect(removeCompleted).toEqual([0]);expect(s.session.groupEntity(id)).toBeUndefined();expect(s.session.engine.queryGroup?.(id)).toBeUndefined();
 const operations=s.wire.filter(p=>p.side===0).map(p=>coreWords(p.data)).filter(w=>w[0]===0xd8||w[0]===0xda);
 expect(operations).toEqual([[0xd8,id,version+2,0,s.session.localId,0],[0xda,id,player,version+1,0,s.session.localId,0]]);
 expect(s.peer.entities.has(id)).toBe(false);expect((s.peer as any).version).toBe(version+2);
});
test("a late C2 snapshot seeds stable memberships that subsequently receive a real DA removal",async()=>{
 const s=scene();expect(await s.start()).toBe(0);
 const made=await s.session.createGroup({name:"snapshot-member",data:[5],flags:0},0xa404);expect(made.hr).toBe(0);
 const id=made.id!,player=s.session.localId;s.session.onEvent=e=>{if(e.type===1||e.type===0x12)e.processed?.();};
 expect(await s.session.member(id,player,true)).toBe(0);expect(await s.join()).toBe(0);
 expect(s.peer.entities.get(id)).toMatchObject({group:true,name:{short:"snapshot-member"},members:[player]});
 const version=(s.session.engine as any).host.version;s.wire.length=0;
 expect(await s.session.member(id,player,false)).toBe(0);await turns();
 expect(s.peer.entities.get(id)?.members).toEqual([]);expect((s.peer as any).version).toBe(version+1);
 expect(s.wire.filter(p=>p.side===0&&coreWords(p.data)[0]===0xda).map(p=>coreWords(p.data))).toEqual([[0xda,id,player,version+1,0,s.session.localId,0]]);
 expect(s.session.engine.currentPlayers).toBe(2);
});
test("Close cancels a held ADD once and its stale callback cannot publish into a replacement Host generation",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"close-held-member",data:[6],flags:0},0xa505);expect(made.hr).toBe(0);
 let held:any;const completed:number[]=[];s.session.onEvent=e=>{if(e.type===1)held=e;};s.wire.length=0;
 const pending=s.session.engine.mutate({op:"mutate",action:"member",id:made.id,member:s.session.localId,add:true,completed:(r:{hr:number})=>completed.push(r.hr)});
 expect(held).toBeDefined();expect(completed).toEqual([]);s.session.close();
 expect((await pending).hr).toBe(DPN.USERCANCEL);expect(completed).toEqual([DPN.USERCANCEL]);expect(held.isCurrent()).toBe(false);
 expect(await s.start()).toBe(0);const version=(s.session.engine as any).host.version,local=s.session.localId;
 held.processed();held.processed();await turns();expect(completed).toEqual([DPN.USERCANCEL]);
 expect(s.session.engine.entities.size).toBe(1);expect(s.session.engine.entities.has(local)).toBe(true);
 expect((s.session.engine as any).host.version).toBe(version);expect(s.wire.some(p=>p.side===0&&coreWords(p.data)[0]===0xd9)).toBe(false);
});

test("a valid same-version DA replaces a completed failed duplicate D9 and unblocks its queued future operation",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"failed-slot-replacement",data:[9,0,4],flags:0},0xa606);expect(made.hr).toBe(0);
 const group=made.id!,original=s.session.localId,future=s.peer.localId;
 s.session.onEvent=e=>{if(e.type===1)e.processed?.();};
 expect(await s.session.member(group,original,true)).toBe(0);await turns();
 expect(s.session.isGroupCreated(group)).toBe(true);expect(s.peer.entities.get(group)?.members).toEqual([original]);
 const version=(s.peer as any).version,callbacks:any[]=[],acks:number[]=[],phases:any[]=[];
 const connection=[...(s.session.engine as any).host.connections.values()].find((c:any)=>c.id===future);
 expect(connection?.phase).toBe("connected");expect(s.peer.hostId).toBe(original);expect(connection.channel).toBeDefined();
 s.peer.onGroupMember=(id,player,add,returned)=>{
  callbacks.push({id,player,add,version:(s.peer as any).version,members:s.peer.entities.get(id)?.members.slice()});returned();
 };
 // Source fault-control on the real authenticated Host channel. These packets do
 // not assert that the Host semantic table itself generated inconsistent state.
 const literal=(words:number[])=>{const bytes=new Uint8Array(words.length*4),view=new DataView(bytes.buffer);
  words.forEach((word,index)=>view.setUint32(index*4,word,true));return bytes;};
 const offer=async(words:number[])=>{acks.push(await connection.channel.link.sendReliable(literal(words)));await turns();};
 const snapshot=()=>({version:(s.peer as any).version,members:s.peer.entities.get(group)?.members.slice(),callbacks:callbacks.slice()});
 s.wire.length=0;
 await offer([0xd9,group,original,version+1,0,original,0]);phases.push(snapshot());
 await offer([0xd9,group,future,version+2,0,original,0]);phases.push(snapshot());
 expect(acks).toEqual([0,0]);expect(phases).toEqual([
  {version,members:[original],callbacks:[]},{version,members:[original],callbacks:[]}]);
 await offer([0xda,group,original,version+1,0,original,0]);
 // The first replacement assertion is the actual callback, not a timeout or a
 // peek at the implementation's queued slot/cache.
 expect(callbacks.map(e=>[e.add,e.id,e.player])).toEqual([[false,group,original],[true,group,future]]);
 expect(callbacks).toEqual([
  {id:group,player:original,add:false,version:version+1,members:[]},
  {id:group,player:future,add:true,version:version+2,members:[future]}]);
 expect(acks).toEqual([0,0,0]);expect(s.peer.openError).toBe(0);
 expect(s.peer.entities.get(group)?.members).toEqual([future]);expect((s.peer as any).version).toBe(version+2);
 expect(s.wire.filter(p=>p.side===0&&[0xd9,0xda].includes(coreWords(p.data)[0])).map(p=>coreWords(p.data))).toEqual([
  [0xd9,group,original,version+1,0,original,0],[0xd9,group,future,version+2,0,original,0],[0xda,group,original,version+1,0,original,0]]);
});

/** Source fault-control only: retained authenticated Host channel, no direct Core/table injection. */
function membershipFaultOffer(s:ReturnType<typeof scene>){
 const connection=[...(s.session.engine as any).host.connections.values()].find((c:any)=>c.id===s.peer.localId);
 expect(connection?.phase).toBe("connected");expect(s.peer.hostId).toBe(s.session.localId);expect(connection.channel).toBeDefined();
 return async(words:number[])=>{
  const bytes=new Uint8Array(words.length*4),view=new DataView(bytes.buffer);
  words.forEach((word,index)=>view.setUint32(index*4,word,true));
  const result=await connection.channel.link.sendReliable(bytes);await turns();return result as number;
 };
}
test("another invalid same-version membership replacement remains unadopted and cannot release the future slot",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"invalid-slot-again",data:[],flags:0},0xa707);expect(made.hr).toBe(0);
 const group=made.id!,original=s.session.localId,future=s.peer.localId;
 s.session.onEvent=e=>{if(e.type===1)e.processed?.();};expect(await s.session.member(group,original,true)).toBe(0);
 const version=(s.peer as any).version,callbacks:any[]=[],offer=membershipFaultOffer(s);
 s.peer.onGroupMember=(id,player,add,returned)=>{callbacks.push({id,player,add});returned();};s.wire.length=0;
 expect(await offer([0xd9,group,original,version+1,0,original,0x11])).toBe(0);
 expect(await offer([0xd9,group,original,version+1,0,original,0x22])).toBe(0);
 expect(await offer([0xd9,group,future,version+2,0,original,0x33])).toBe(0);
 expect(callbacks).toEqual([]);expect((s.peer as any).version).toBe(version);expect(s.peer.entities.get(group)?.members).toEqual([original]);
 expect(s.peer.openError).toBe(0);
 expect(await offer([0xda,group,original,version+1,0,original,0x44])).toBe(0);
 expect(callbacks).toEqual([{id:group,player:original,add:false},{id:group,player:future,add:true}]);
 expect((s.peer as any).version).toBe(version+2);expect(s.peer.entities.get(group)?.members).toEqual([future]);
 expect(s.wire.filter(p=>p.side===0&&[0xd9,0xda].includes(coreWords(p.data)[0])).map(p=>coreWords(p.data))).toEqual([
  [0xd9,group,original,version+1,0,original,0x11],[0xd9,group,original,version+1,0,original,0x22],
  [0xd9,group,future,version+2,0,original,0x33],[0xda,group,original,version+1,0,original,0x44]]);
});
test("replacing a never-entered future membership slot executes only its latest player payload after the gap is filled",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"future-slot-latest",data:[],flags:0},0xa808);expect(made.hr).toBe(0);
 const group=made.id!,original=s.session.localId,discarded=s.peer.localId;
 s.session.onEvent=e=>{if(e.type===1)e.processed?.();};expect(await s.session.member(group,original,true)).toBe(0);
 const version=(s.peer as any).version,callbacks:any[]=[],offer=membershipFaultOffer(s);
 s.peer.onGroupMember=(id,player,add,returned)=>{
  callbacks.push({id,player,add,version:(s.peer as any).version,members:s.peer.entities.get(id)?.members.slice()});returned();
 };s.wire.length=0;
 expect(await offer([0xd9,group,discarded,version+2,0,original,0x51])).toBe(0);
 expect(await offer([0xd9,group,original,version+2,0,original,0x52])).toBe(0);
 expect(callbacks).toEqual([]);expect((s.peer as any).version).toBe(version);expect(s.peer.entities.get(group)?.members).toEqual([original]);
 expect(await offer([0xda,group,original,version+1,0,original,0x53])).toBe(0);
 expect(callbacks).toEqual([
  {id:group,player:original,add:false,version:version+1,members:[]},
  {id:group,player:original,add:true,version:version+2,members:[original]}]);
 expect((s.peer as any).version).toBe(version+2);expect(s.peer.entities.get(group)?.members).toEqual([original]);
 expect(s.peer.entities.get(group)?.members).not.toContain(discarded);expect(s.peer.openError).toBe(0);
 expect(s.wire.filter(p=>p.side===0&&[0xd9,0xda].includes(coreWords(p.data)[0])).map(p=>coreWords(p.data))).toEqual([
  [0xd9,group,discarded,version+2,0,original,0x51],[0xd9,group,original,version+2,0,original,0x52],
  [0xda,group,original,version+1,0,original,0x53]]);
});
test("an already precommitted held ADD keeps its own return identity when another packet arrives at that adopted version",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"held-adopted-identity",data:[],flags:0},0xa909);expect(made.hr).toBe(0);
 const group=made.id!,original=s.session.localId,added=s.peer.localId;
 s.session.onEvent=e=>{if(e.type===1)e.processed?.();};expect(await s.session.member(group,original,true)).toBe(0);
 const version=(s.peer as any).version,callbacks:any[]=[],offer=membershipFaultOffer(s);let held!:(result?:number)=>void;
 s.peer.onGroupMember=(id,player,add,returned)=>{
  callbacks.push({id,player,add,version:(s.peer as any).version,members:s.peer.entities.get(id)?.members.slice()});
  if(add)held=returned;else returned();
 };s.wire.length=0;
 expect(await offer([0xd9,group,added,version+1,0,original,0x61])).toBe(0);
 expect(held).toBeFunction();expect(callbacks).toEqual([{id:group,player:added,add:true,version:version+1,members:[original,added]}]);
 const originalReturn=held;
 // This is already-adopted history, not the unresolved active-unadopted D8 case.
 expect(await offer([0xda,group,original,version+1,0,original,0x62])).toBe(0);
 expect(held).toBe(originalReturn);expect(callbacks).toHaveLength(1);expect((s.peer as any).version).toBe(version+1);
 expect(s.peer.entities.get(group)?.members).toEqual([original,added]);
 originalReturn();originalReturn();await turns();expect(callbacks).toHaveLength(1);
 expect(await offer([0xda,group,original,version+2,0,original,0x63])).toBe(0);
 expect(callbacks).toEqual([
  {id:group,player:added,add:true,version:version+1,members:[original,added]},
  {id:group,player:original,add:false,version:version+2,members:[added]}]);
 expect((s.peer as any).version).toBe(version+2);expect(s.peer.entities.get(group)?.members).toEqual([added]);expect(s.peer.openError).toBe(0);
 expect(s.wire.filter(p=>p.side===0&&[0xd9,0xda].includes(coreWords(p.data)[0])).map(p=>coreWords(p.data))).toEqual([
  [0xd9,group,added,version+1,0,original,0x61],[0xda,group,original,version+1,0,original,0x62],
  [0xda,group,original,version+2,0,original,0x63]]);
});

/** Three real native peers/routes for normal C9 aggregation, not injected table entries. */
function historyReportScene(){
 const nets=[61,62,63].map(n=>new LanNetwork(Uint8Array.of(2,0,0,0,0,n)));
 const wire:{from:number;to:number;data:Uint8Array}[]=[],events:any[]=[];
 for(const [from,net]of nets.entries())net.attach({send(frame){
  const d=decodeDatagram(frame)!;const to=nets.findIndex(other=>other.node.every((n,i)=>n===d.node[i]));
  if(to<0)return false;
  const native=decodeNativeProtocolFrame(d.payload);
  if(native?.kind==="data"&&(native.command&DN.USER1)&&(native.command&DN.NEW_MESSAGE)&&(native.command&DN.END_MESSAGE))
   wire.push({from,to,data:native.payload.slice()});
  nets[to].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;
 },close(){}});
 const session=new DirectPlay8Session(nets[0]),peers=nets.slice(1).map(net=>new NativeDirectPlayCore(net,"peer",500,2));
 cleanup.push(()=>{peers.forEach(peer=>peer.dispose());session.dispose();nets.forEach(net=>net.attach(null));});
 expect(session.initialize()).toBe(0);session.onEvent=e=>{events.push(e);if(e.type===6||e.type===0x10)e.processed?.();};
 session.onNativeIndicate=()=>({hr:0});const app={...desc,maxPlayers:3},address={node:[...nets[0].node],port:2308};
 const start=()=>session.hostNative(app,0x8100,{prepare:async r=>({address:r.localAddress,
  allowIncoming:a=>nets.slice(1).some(net=>net.node.every((n,i)=>n===a.node[i])),
  url:a=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname="+[...nodeToIpv4(Uint8Array.from(a.node))].join(".")+";port="+a.port,
  release(){}})},2308,[20,0,2,14,500]);
 const join=(index:number)=>peers[index].connect(address,app,{name:{short:"Reporter-"+index,long:""},data:[index],flags:0},new Uint8Array());
 const report=async(index:number,version:number)=>{
  const peer=peers[index];expect(peer.hostId).toBe(session.localId);expect(peer.openError).toBe(0);
  const bytes=new Uint8Array(12),view=new DataView(bytes.buffer);
  view.setUint32(0,0xc9,true);view.setUint32(4,version,true);view.setUint32(8,0,true);
  const result=await(peer as any).channel.link.sendReliable(bytes);await turns();return result as number;
 };
 return{nets,session,peers,wire,events,start,join,report};
}
test("Host aggregates both authenticated nonHost C9 reports and fans out a positive minimum without inventing a global watermark",async()=>{
 const s=historyReportScene();expect(await s.start()).toBe(0);expect(await s.join(0)).toBe(0);expect(await s.join(1)).toBe(0);await turns();
 expect(s.session.engine.currentPlayers).toBe(3);expect(s.peers.map(peer=>peer.currentPlayers)).toEqual([3,3]);
 const hostVersion=(s.session.engine as any).host.version;expect(hostVersion).toBeGreaterThanOrEqual(2);
 // Source permits report assignment0. Set both actual authenticated entries to a
 // known baseline after any normal join reports, without changing adopted tables.
 expect(await s.report(0,0)).toBe(0);expect(await s.report(1,0)).toBe(0);await turns();s.wire.length=0;
 const versions=s.peers.map(peer=>(peer as any).version),tables=s.peers.map(peer=>structuredClone([...peer.entities])),eventCount=s.events.length;
 const fanout=()=>s.wire.filter(row=>row.from===0&&coreWords(row.data)[0]===0xca)
  .map(row=>({to:row.to,words:coreWords(row.data)})).sort((a,b)=>a.to-b.to);
 const expected=[{to:1,words:[0xca,1,0]},{to:2,words:[0xca,1,0]}],observed:any[]=[];
 expect(await s.report(0,1)).toBe(0);observed.push(fanout());
 // First RED must be the unwanted one-peer echo while the other reporter is0.
 expect(observed[0]).toEqual([]);s.wire.length=0;
 expect(await s.report(1,2)).toBe(0);observed.push(fanout());expect(observed[1]).toEqual(expected);s.wire.length=0;
 // Source globalLatest starts0 and is not advanced by sending CA: equal positive
 // minima may fan out again. Per-entry reports are assignment, not max().
 expect(await s.report(1,2)).toBe(0);observed.push(fanout());expect(observed[2]).toEqual(expected);s.wire.length=0;
 expect(await s.report(0,0)).toBe(0);observed.push(fanout());expect(observed[3]).toEqual([]);s.wire.length=0;
 expect(await s.report(0,1)).toBe(0);observed.push(fanout());expect(observed[4]).toEqual(expected);
 expect(s.wire.filter(row=>row.from===1&&row.to===0&&coreWords(row.data)[0]===0xc9).map(row=>coreWords(row.data))).toEqual([[0xc9,1,0]]);
 expect(s.peers.map(peer=>(peer as any).version)).toEqual(versions);expect((s.session.engine as any).host.version).toBe(hostVersion);
 expect(s.peers.map(peer=>[...peer.entities])).toEqual(tables);expect(s.events).toHaveLength(eventCount);
 expect(s.peers.map(peer=>peer.openError)).toEqual([0,0]);expect(s.session.engine.currentPlayers).toBe(3);
});

type RetainedHistoryRow={version:number;command:number;payload:Uint8Array;indexed:boolean;active:boolean};
const ownedHistory=(peer:NativeDirectPlayCore)=>(peer as any).historySnapshot() as RetainedHistoryRow[];
const reportWords=(s:ReturnType<typeof scene>)=>s.wire.filter(row=>row.side===1&&coreWords(row.data)[0]===0xc9).map(row=>coreWords(row.data));
test("CA prunes only strictly lower history and retains original equal and higher payload bytes without adopting or notifying",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"history-strict-prune",data:[],flags:0},0xb101);expect(made.hr).toBe(0);
 const group=made.id!,player=s.session.localId;s.session.onEvent=e=>{if(e.type===1)e.processed?.();};
 expect(await s.session.member(group,player,true)).toBe(0);
 const version=(s.peer as any).version,callbacks:any[]=[],offer=membershipFaultOffer(s);
 expect(version).toBeGreaterThan(3);s.peer.onGroupMember=(g,p,add,done)=>{callbacks.push({g,p,add});done();};
 const originals=[
  [0xd9,group,player,1,0x11223344,player,0xa1,0xfeedbeef],
  [0xd9,group,player,2,0x55667788,player,0xa2,0xdeadbeef],
  [0xda,group,player,3,0x99aabbcc,player,0xa3,0x01020304]];
 for(const words of originals)expect(await offer(words)).toBe(0);
 const before=ownedHistory(s.peer).filter(row=>row.indexed),usage=(s.peer as any).historyUsage;
 expect(before.filter(row=>row.version<=3).sort((a,b)=>a.version-b.version).map(row=>coreWords(row.payload))).toEqual(originals);
 expect(await offer([0xca,2,0])).toBe(0);
 const after=ownedHistory(s.peer).filter(row=>row.indexed);
 expect(after.map(row=>row.version).sort((a,b)=>a-b)).toEqual(before.filter(row=>row.version>=2).map(row=>row.version).sort((a,b)=>a-b));
 expect(after.filter(row=>row.version===2||row.version===3).sort((a,b)=>a.version-b.version).map(row=>coreWords(row.payload))).toEqual(originals.slice(1));
 expect((s.peer as any).historyUsage).toEqual({records:usage.records-1,bytes:usage.bytes-32});
 expect((s.peer as any).version).toBe(version);expect(s.peer.entities.get(group)?.members).toEqual([player]);expect(callbacks).toEqual([]);
});
test("replacing an adopted old history slot changes only its retained original payload and returns an owned snapshot copy",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"history-old-replace",data:[],flags:0},0xb202);expect(made.hr).toBe(0);
 const group=made.id!,player=s.session.localId;s.session.onEvent=e=>{if(e.type===1)e.processed?.();};
 expect(await s.session.member(group,player,true)).toBe(0);
 const version=(s.peer as any).version,callbacks:any[]=[],offer=membershipFaultOffer(s);
 s.peer.onGroupMember=(g,p,add,done)=>{callbacks.push({g,p,add});done();};
 const original=[0xd9,group,player,3,0x12345678,player,0xb1,0xaabbccdd],replacement=[0xda,group,player,3,0x87654321,player,0xb2,0xfedcba98];
 expect(await offer(original)).toBe(0);const usage=(s.peer as any).historyUsage;
 expect(ownedHistory(s.peer).filter(row=>row.indexed&&row.version===3).map(row=>coreWords(row.payload))).toEqual([original]);
 expect(await offer(replacement)).toBe(0);
 const rows=ownedHistory(s.peer).filter(row=>row.indexed&&row.version===3);expect(rows).toHaveLength(1);expect(coreWords(rows[0].payload)).toEqual(replacement);
 rows[0].payload.fill(0);expect(ownedHistory(s.peer).filter(row=>row.indexed&&row.version===3).map(row=>coreWords(row.payload))).toEqual([replacement]);
 expect((s.peer as any).historyUsage).toEqual(usage);expect((s.peer as any).version).toBe(version);
 expect(s.peer.entities.get(group)?.members).toEqual([player]);expect(callbacks).toEqual([]);
});
test("a completed failed boundary operation reports the prior adopted version from its own invocation tail",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"history-failed-boundary",data:[],flags:0},0xb303);expect(made.hr).toBe(0);
 const group=made.id!,player=s.session.localId;s.session.onEvent=e=>{if(e.type===1)e.processed?.();};
 expect(await s.session.member(group,player,true)).toBe(0);expect(await s.session.member(group,s.peer.localId,true)).toBe(0);
 expect((s.peer as any).version).toBe(7);
 const callbacks:any[]=[],offer=membershipFaultOffer(s);s.peer.onGroupMember=(g,p,add,done)=>{callbacks.push({g,p,add});done();};s.wire.length=0;
 const failed=[0xd9,group,player,8,0,player,0xc1];expect(await offer(failed)).toBe(0);
 expect(reportWords(s)).toEqual([[0xc9,7,0]]);expect((s.peer as any).version).toBe(7);expect(callbacks).toEqual([]);
 expect(s.peer.entities.get(group)?.members).toEqual([player,s.peer.localId]);
 expect(ownedHistory(s.peer).filter(row=>row.indexed&&row.version===8).map(row=>coreWords(row.payload))).toEqual([failed]);
});
test("a held boundary ADD delays only its own report and reports CURRENT after a nested next-version CREATE",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"history-held-boundary",data:[],flags:0},0xb404);expect(made.hr).toBe(0);
 expect((await s.session.createGroup({name:"history-padding",data:[],flags:0},0xb405)).hr).toBe(0);
 const group=made.id!,player=s.peer.localId;s.session.onEvent=e=>{if(e.type===1||e.type===6)e.processed?.();};
 expect(await s.session.member(group,s.session.localId,true)).toBe(0);expect((s.peer as any).version).toBe(7);
 let held!:(result?:number)=>void;const callbacks:any[]=[],completed:number[]=[];
 s.peer.onGroupMember=(g,p,add,done)=>{callbacks.push({g,p,add,version:(s.peer as any).version});held=done;};s.wire.length=0;
 const pending=s.peer.mutate({op:"mutate",action:"member",id:group,member:player,add:true,completed:(r:{hr:number})=>completed.push(r.hr)});
 await turns();expect(held).toBeFunction();expect(callbacks).toEqual([{g:group,p:player,add:true,version:8}]);expect(completed).toEqual([]);
 expect(reportWords(s)).toEqual([]);
 const nested=await s.session.createGroup({name:"history-nested-nine",data:[9],flags:0},0xb406);expect(nested.hr).toBe(0);await turns();
 expect((s.peer as any).version).toBe(9);expect(s.peer.entities.has(nested.id!)).toBe(true);expect(reportWords(s)).toEqual([]);expect(completed).toEqual([]);
 held();expect((await pending).hr).toBe(0);held();await turns();
 expect(completed).toEqual([0]);expect(callbacks).toHaveLength(1);expect(reportWords(s)).toEqual([[0xc9,9,0]]);
});
test("CA detaches an adopted held ADD index while its original request owner survives a new old-version payload",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"history-detached-owner",data:[],flags:0},0xb505);expect(made.hr).toBe(0);
 expect((await s.session.createGroup({name:"history-padding",data:[],flags:0},0xb506)).hr).toBe(0);
 const group=made.id!,host=s.session.localId,player=s.peer.localId;s.session.onEvent=e=>{if(e.type===1||e.type===6)e.processed?.();};
 expect(await s.session.member(group,host,true)).toBe(0);expect((s.peer as any).version).toBe(7);
 let held!:(result?:number)=>void;const callbacks:any[]=[],completed:number[]=[],offer=membershipFaultOffer(s);
 s.peer.onGroupMember=(g,p,add,done)=>{callbacks.push({g,p,add});held=done;};s.wire.length=0;
 const pending=s.peer.mutate({op:"mutate",action:"member",id:group,member:player,add:true,completed:(r:{hr:number})=>completed.push(r.hr)});
 await turns();expect(held).toBeFunction();expect((s.peer as any).version).toBe(8);expect(completed).toEqual([]);
 const requests=s.wire.filter(row=>row.side===1&&coreWords(row.data)[0]===0xd3).map(row=>coreWords(row.data));
 expect(requests).toHaveLength(1);const token=requests[0][1];expect(token).toBeGreaterThan(0);
 const original=[0xd9,group,player,8,0,player,token];
 expect(s.wire.filter(row=>row.side===0&&coreWords(row.data)[0]===0xd9).map(row=>coreWords(row.data))).toEqual([original]);
 // Safe detached ownership is our invariant; this does not assert universal
 // native active-prune scheduling or resolve unadopted held D8 replacement.
 expect(await offer([0xca,9,0])).toBe(0);
 const detached=ownedHistory(s.peer);expect(detached).toHaveLength(1);
 expect(detached[0]).toMatchObject({version:8,command:0xd9,indexed:false,active:true});expect(coreWords(detached[0].payload)).toEqual(original);
 expect((s.peer as any).historyUsage).toEqual({records:1,bytes:28});expect(completed).toEqual([]);expect(reportWords(s)).toEqual([]);
 const replacement=[0xda,group,host,8,0x31415926,host,0xd1,0xabcdef01];expect(await offer(replacement)).toBe(0);
 const both=ownedHistory(s.peer).filter(row=>row.version===8).sort((a,b)=>a.command-b.command);
 expect(both).toHaveLength(2);expect(both.map(row=>coreWords(row.payload))).toEqual([original,replacement]);
 expect(both.map(row=>({indexed:row.indexed,active:row.active}))).toEqual([{indexed:false,active:true},{indexed:true,active:false}]);
 expect((s.peer as any).historyUsage).toEqual({records:2,bytes:60});expect(completed).toEqual([]);expect(callbacks).toEqual([{g:group,p:player,add:true}]);
 expect(s.peer.entities.get(group)?.members).toEqual([host,player]);expect((s.peer as any).version).toBe(8);expect(reportWords(s)).toEqual([]);
 held();expect((await pending).hr).toBe(0);held();await turns();
 expect(completed).toEqual([0]);expect(callbacks).toHaveLength(1);expect(reportWords(s)).toEqual([[0xc9,8,0]]);
 expect(ownedHistory(s.peer).filter(row=>row.version===8).map(row=>coreWords(row.payload))).toEqual([replacement]);
 expect((s.peer as any).historyUsage).toEqual({records:1,bytes:32});expect(s.peer.entities.get(group)?.members).toEqual([host,player]);expect(s.peer.openError).toBe(0);
});

test("a routed D6 boundary DB holds its own history report and original request completion until INFO returns",async()=>{
 const s=scene();expect(await s.start()).toBe(0);expect(await s.join()).toBe(0);
 const made=await s.session.createGroup({name:"history-info-boundary",data:[],flags:0},0xb606);expect(made.hr).toBe(0);
 expect((await s.session.createGroup({name:"history-padding",data:[],flags:0},0xb607)).hr).toBe(0);
 s.session.onEvent=e=>{if(e.type===1||e.type===0x10)e.processed?.();};
 expect(await s.session.member(made.id!,s.session.localId,true)).toBe(0);expect((s.peer as any).version).toBe(7);
 const player=s.peer.localId,seen:any[]=[],completed:number[]=[];let held!:(result?:number)=>void;
 s.peer.onInfo=(id,returned)=>{seen.push({id,data:s.peer.entities.get(id)?.data.slice(),version:(s.peer as any).version});held=returned;};s.wire.length=0;
 const pending=s.peer.mutate({op:"mutate",action:"info",id:player,data:[0x44,0,0x42],completed:(r:{hr:number})=>completed.push(r.hr)});
 await turns();expect(held).toBeFunction();expect(seen).toEqual([{id:player,data:[0x44,0,0x42],version:8}]);
 expect(s.session.engine.entities.get(player)?.data).toEqual([0x44,0,0x42]);expect(completed).toEqual([]);expect(reportWords(s)).toEqual([]);
 const requests=s.wire.filter(row=>row.side===1&&coreWords(row.data)[0]===0xd6).map(row=>coreWords(row.data));
 expect(requests).toHaveLength(1);expect(requests[0][1]).toBeGreaterThan(0);
 const db=s.wire.filter(row=>row.side===0&&coreWords(row.data)[0]===0xdb);expect(db).toHaveLength(1);
 expect(ownedHistory(s.peer).filter(row=>row.version===8&&row.active).map(row=>row.payload)).toEqual([db[0].data]);
 // returned() is successful infrastructure completion; a guest handler HRESULT
 // is ignored by the guest callback bridge, not passed as this optional status.
 held();expect((await pending).hr).toBe(0);held();await turns();
 expect(completed).toEqual([0]);expect(seen).toHaveLength(1);expect(reportWords(s)).toEqual([[0xc9,8,0]]);
 expect((s.peer as any).version).toBe(8);expect(s.peer.entities.get(player)?.data).toEqual([0x44,0,0x42]);expect(s.peer.openError).toBe(0);
});

test("native Peer DestroyPeer sends reason-4 D1 and preserves the observer's player context", async () => {
 const nets=[121,122,123].map(n=>new LanNetwork(Uint8Array.of(2,0,0,0,0,n)));
 const wire:{from:number;to:number;data:Uint8Array}[]=[];
 for(const[from,net]of nets.entries())net.attach({send(frame){
  const d=decodeDatagram(frame)!,to=nets.findIndex(other=>other.node.every((n,i)=>n===d.node[i]));
  if(to<0||d.proto!==PROTO_UDP)return false;
  const decoded=decodeNativeProtocolFrame(d.payload);
  if(decoded?.kind==="data"&&(decoded.command&DN.USER1)&&(decoded.command&DN.NEW_MESSAGE)&&(decoded.command&DN.END_MESSAGE))
   wire.push({from,to,data:decoded.payload.slice()});
  nets[to].receiveFrame(encodeDatagram(d.proto,net.node,d.dstPort,d.srcPort,d.payload));return true;
 },close(){}});
 const host=new DirectPlay8Session(nets[0]),target=new NativeDirectPlayCore(nets[1],"peer",500,2),observer=new DirectPlay8Session(nets[2]);
 cleanup.push(()=>{target.dispose();observer.dispose();host.dispose();nets.forEach(n=>n.attach(null));});
 const hostEvents:any[]=[],observerEvents:any[]=[],targetTerminations:{data:number[];reason?:number}[]=[];
 let targetId=0;
 host.onEvent=e=>{hostEvents.push(e);e.processed?.();};
 observer.onEvent=e=>{
  observerEvents.push(e);
  if(e.type===7&&e.id===targetId)observer.contexts.set(targetId,0xcafe);
  e.processed?.();
 };
 target.onTermination=(data,reason)=>targetTerminations.push({data:[...data],reason});
 host.onNativeIndicate=()=>({hr:DPN.OK,context:0xa121});
 expect(host.initialize()).toBe(DPN.OK);expect(observer.initialize()).toBe(DPN.OK);
 const app={...desc,maxPlayers:3},address={node:[...nets[0].node],port:2308};
 expect(await host.hostNative(app,0x1111,{prepare:async request=>({
  address:request.localAddress,allowIncoming:()=>true,
  url:a=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname="+[...nodeToIpv4(Uint8Array.from(a.node))].join(".")+";port="+a.port,
  release(){},
 })},2308,[20,0,2,14,500])).toBe(DPN.OK);
 expect(await target.connect(address,app,{name:{short:"target",long:""},data:[],flags:0},new Uint8Array())).toBe(DPN.OK);
 targetId=target.localId;
 expect(await observer.connectNative(address,app,0xb123,new Uint8Array(),0,[20,0,2,14,500])).toBe(DPN.OK);
 expect(observer.engine.entities.has(targetId)).toBe(true);
 expect(observer.contexts.get(targetId)).toBe(0xcafe);
 const version=(host.engine as any).host.version;
 hostEvents.length=0;observerEvents.length=0;wire.length=0;

 const payload=Uint8Array.of(0x44,0,0x55);
 expect(host.engine.kick(targetId,payload)).toBe(DPN.OK);
 payload.fill(0xee);await turns();
 const d1=wire.filter(row=>row.from===0&&row.to===2&&row.data.length===20&&coreWords(row.data)[0]===0xd1);
 expect(d1.map(row=>coreWords(row.data))).toEqual([[0xd1,targetId,version+1,0,4]]);
 expect(targetTerminations).toEqual([{data:[0x44,0,0x55],reason:DPN.HOSTTERMINATEDSESSION}]);
 expect(hostEvents.filter(e=>e.type===9).map(e=>[e.id,e.context,e.reason])).toEqual([[targetId,0xa121,4]]);
 expect(observerEvents.filter(e=>e.type===9).map(e=>[e.id,e.context,e.reason])).toEqual([[targetId,0xcafe,4]]);
 expect(observer.engine.entities.has(targetId)).toBe(false);
 expect(observer.engine.entities.has(host.localId)).toBe(true);
 expect(observer.error).toBe(DPN.OK);
}, 15000);

test("native Peer Host destroys a created group when the session event sink is removed", async () => {
 const s=scene();expect(await s.start()).toBe(DPN.OK);
 const made=await s.session.createGroup({name:"no-sink",data:[4,0,6],flags:0},0xc701);
 expect(made.hr).toBe(DPN.OK);const id=made.id!;
 expect(s.session.isGroupCreated(id)).toBe(true);
 expect(s.session.groupContexts.get(id)).toBe(0xc701);
 expect(s.events.filter(event=>event.type===6&&event.id===id)).toHaveLength(1);
 const completed:number[]=[];
 s.session.onEvent=undefined;
 const result=s.session.beginDestroyGroup(id,reply=>completed.push(reply.hr));
 // The missing consumer must complete its owned notification, not leave a
 // promise waiting forever for an event no sink can receive.
 await turns();
 expect(completed).toEqual([DPN.OK]);
 expect((result instanceof Promise?await result:result).hr).toBe(DPN.OK);
 expect(s.session.engine.entities.has(id)).toBe(false);
 expect(s.session.groupEntity(id)).toBeUndefined();
 expect(s.session.groupContexts.has(id)).toBe(false);
 expect(s.session.engine.currentPlayers).toBe(1);
},15000);
