import{afterEach,expect,test}from"bun:test";
import{LanNetwork}from"../../src/worker/net/lan-network";
import{PROTO_UDP,decodeDatagram,encodeDatagram}from"../../src/worker/net/netplay-wire";
import{DirectPlay8Session}from"../../src/worker/modules/dpnet/peer";
import{NativeDirectPlayCore}from"../../src/worker/modules/dpnet/native-wire/core";
import{DPN}from"../../src/worker/modules/dpnet/constants";
import type{SessionDesc}from"../../src/worker/modules/dplayx/session";
import type{DirectPlay8HostReady,DirectPlay8HostRequest}from"../../src/worker/modules/dpnet/backend";
const desc:SessionDesc={instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",name:"Native Host",password:"",maxPlayers:2,flags:0,user:[0,0,0,0],extended:{flags:0,reserved:[],application:[]}};
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0))close();});
async function turns(){for(let i=0;i<16;i++)await Promise.resolve();}
function scene(){
 const nets=[21,22].map(n=>new LanNetwork(Uint8Array.of(2,0,0,0,0,n))),sent:number[]=[];
 for(const[i,net]of nets.entries())net.attach({send(frame){const dg=decodeDatagram(frame)!;sent.push(dg.proto);nets[1-i].receiveFrame(encodeDatagram(dg.proto,net.node,dg.dstPort,dg.srcPort,dg.payload));return true;},close(){}});
 const session=new DirectPlay8Session(nets[0]);expect(session.initialize()).toBe(0);
 let releases=0,returns=0;const requests:DirectPlay8HostRequest[]=[],events:any[]=[];
 session.onEvent=e=>{events.push(e);};session.onNativeIndicate=()=>({hr:0,data:Uint8Array.of(8,0,9),context:0x7201,returnBuffer(){returns++;}});
 const ready=(request:DirectPlay8HostRequest):DirectPlay8HostReady=>({address:{node:[2,1,127,0,0,1],port:request.localPort},
 allowIncoming:a=>a.node.every((n,i)=>n===nets[1].node[i]),url:a=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0.1;port="+a.port,release(){releases++;}});
 const provider={prepare:async(request:DirectPlay8HostRequest)=>{requests.push(request);return ready(request);}};
 const peer=new NativeDirectPlayCore(nets[1],"peer",500,2);
 cleanup.push(()=>{peer.dispose();session.dispose();nets.forEach(n=>n.attach(null));});
 return{nets,session,peer,provider,requests,events,sent,ready,get releases(){return releases;},get returns(){return returns;},
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
