import {afterEach,expect,test} from "bun:test";
import fixture from "./fixtures/directplay8-native-host.json";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {PROTO_UDP,decodeDatagram,encodeDatagram} from "../../src/worker/net/netplay-wire";
import {NativeDirectPlayHost,type NativeHostDecision} from "../../src/worker/modules/dpnet/native-wire/host";
import {NativeReliableLink} from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import {DN,encodeNativeProtocolFrame} from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import {decodeNativeCoreConnectInfo} from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import {decodeNativeCoreOperation,nativeCoreWords} from "../../src/worker/modules/dpnet/native-wire/core-operations";
import {DPN} from "../../src/worker/modules/dpnet/constants";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0))close();});
const bytes=(hex:string)=>Uint8Array.from(Buffer.from(hex,"hex"));
const c1=bytes(fixture.accept.peer.find(m=>m.command===0xc1)!.payload);
const reference=decodeNativeCoreConnectInfo(bytes(fixture.accept.host.find(m=>m.command===0xc2)!.payload))!;
const command=(b:Uint8Array)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
async function turns(){for(let i=0;i<8;i++)await Promise.resolve();}
function scene(admit?:(host:NativeDirectPlayHost)=>NativeHostDecision|Promise<NativeHostDecision>,autoC3=true,options:{closeOnRelease?:boolean;allowPendingRange?:boolean;closeOnIngress?:boolean;restartOnUrl?:boolean}={}){
 const [hostNet,peerNet]=[10,11].map(n=>new LanNetwork(Uint8Array.of(2,0,0,0,0,n)));
 const sent:{from:number;port:number;data:Uint8Array}[]=[];
 for(const [i,network] of [hostNet,peerNet].entries())network.attach({send(frame){
  const d=decodeDatagram(frame)!,remote=i?hostNet:peerNet;sent.push({from:i,port:d.srcPort,data:d.payload.slice()});
  remote.receiveFrame(encodeDatagram(d.proto,network.node,d.dstPort,d.srcPort,d.payload));return true;
 },close(){}});
 const host=new NativeDirectPlayHost(hostNet),events:string[]=[],messages:Uint8Array[]=[];
 let releases=0,accepted=0,aborted=0,context:unknown,admissionPlayers=0;
 const start=()=>host.start({port:fixture.ports[0],application:reference.application,player:{name:"stage28-host",data:new Uint8Array()},
  url:address=>{if(options.restartOnUrl){host.close();expect(start()).toBe(0);}return "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0.1;port="+address.port;},
  allowIncoming:address=>{if(options.closeOnIngress){host.close();return true;}return (options.allowPendingRange?address.port>=fixture.ports[1]&&address.port<fixture.ports[1]+32:address.port===fixture.ports[1])&&address.node.every((n,i)=>n===peerNet.node[i]);},
  timeout:120,retryInterval:2,
  admit:()=>{events.push("indicate");admissionPlayers=host.currentPlayers;return admit?.(host)??{hr:0,data:reference.reply.slice(),context:"peer"};},
  replyReleased:decision=>{events.push("reply-returned");releases++;decision.data?.fill(0xee);if(options.closeOnRelease)host.close();},
  aborted:()=>{aborted++;},
  accepted:(id,value)=>{events.push("create-remote");accepted++;context=value;expect(id).toBe(reference.localId);}
 });
 const link=new NativeReliableLink({timeout:120,retryInterval:2,send:packet=>peerNet.send(fixture.ports[1],hostNet.node,fixture.ports[0],packet,PROTO_UDP),
  onMessage:m=>{messages.push(m.payload.slice());if(!(m.command&DN.USER1))return;
   const id=command(m.payload);if(id===0xc2&&autoC3)void link.sendReliable(nativeCoreWords(0xc3));
   if(id===0xc6)void link.sendReliable(nativeCoreWords(0xc9,4,0));
  }});
 expect(peerNet.bind(fixture.ports[1],{deliver:packet=>link.receive(packet.data)},PROTO_UDP)).toBe(true);
 cleanup.push(()=>{link.close();host.dispose();hostNet.attach(null);peerNet.attach(null);});
 return{host,hostNet,peerNet,link,events,messages,sent,start,get releases(){return releases;},get accepted(){return accepted;},get context(){return context;},get aborted(){return aborted;},get admissionPlayers(){return admissionPlayers;},
  async connect(){expect(start()).toBe(0);expect(await link.connect()).toBe(0);expect(await link.sendReliable(c1)).toBe(0);await turns();},
  c2:()=>messages.find(m=>command(m)===0xc2),c5:()=>messages.find(m=>command(m)===0xc5)};
}
test("captured native C1 admits once, returns reply before CREATE, and sends actual C2/C6/CA",async()=>{
 const s=scene();await s.connect();
 expect(s.admissionPlayers).toBe(2);expect(s.c2()).toBeDefined();
 const info=decodeNativeCoreConnectInfo(s.c2()!)!;
 expect(info.reply).toEqual(reference.reply);expect(info.localId).toBe(reference.localId);
 expect(info.version).toBe(3);expect(info.application.players).toBe(2);
 const mask=new DataView(bytes(info.application.instance).buffer).getUint32(0,true);
 // NT5 CNameTable.FindEntry decodes the index and verifies the version in the handle.
 for(const entry of info.entries){const handle=(entry.id^mask)>>>0;expect(handle>>>20).toBe(entry.version&0xfff);expect(handle&0xfffff).toBeGreaterThan(1);expect(handle&0xfffff).toBeLessThan(16);}
 expect(info.entries.map(e=>[e.flags,e.version,e.name])).toEqual(reference.entries.map(e=>[e.flags,e.version,e.name]));
 expect(s.events).toEqual(["indicate","reply-returned","create-remote"]);expect(s.releases).toBe(1);expect(s.context).toBe("peer");
 expect(s.messages.filter(m=>m.length>=4).map(command)).toEqual([0xc2,0xc6,0xca]);
 expect(s.host.currentPlayers).toBe(2);expect(s.host.entities.size).toBe(2);
 expect(await s.link.sendReliable(Uint8Array.of(0x48,1,0x28,0x7a),0)).toBe(0);
 expect(s.host.queue[0]).toMatchObject({from:reference.localId,data:Uint8Array.of(0x48,1,0x28,0x7a),flags:1});
 s.host.removeMessage(0);
 expect(await s.host.sendDpn(reference.localId,8,Uint8Array.of(0x48,0,0x28,0x7a))).toBe(0);
 expect(s.messages.at(-1)).toEqual(Uint8Array.of(0x48,0,0x28,0x7a));
});
test("reentrant ingress policy Close cannot allocate a detached connection or socket",()=>{
 const s=scene(undefined,true,{closeOnIngress:true});expect(s.start()).toBe(0);
 s.hostNet.receiveFrame(encodeDatagram(PROTO_UDP,s.peerNet.node,fixture.ports[0],fixture.ports[1],
  encodeNativeProtocolFrame({kind:"control",command:0x88,opcode:1,messageId:0,responseId:0,version:0x10002,sessionId:99,timestamp:0,extra:new Uint8Array()})));
 expect(s.host.peerCount).toBe(0);expect(s.host.currentPlayers).toBe(0);expect(s.hostNet.isBound(fixture.ports[0],PROTO_UDP)).toBe(false);
});
test("a provider URL resolver restarting Host cannot publish or return an old admission",async()=>{
 let owned=0;const s=scene(()=>({hr:0,data:reference.reply.slice(),context:"retired",release(){owned++;}}),true,{restartOnUrl:true});
 expect(s.start()).toBe(0);expect(await s.link.connect()).toBe(0);
 const sent=s.link.sendReliable(c1);await turns();s.link.close();await sent;
 expect(owned).toBe(1);expect(s.aborted).toBe(1);expect(s.releases).toBe(0);expect(s.accepted).toBe(0);
 expect(s.host.isHost).toBe(true);expect(s.host.currentPlayers).toBe(1);expect(s.host.pendingAdmissions).toBe(0);expect(s.c2()).toBeUndefined();
});
test("oversized admission reply is refused before copying application-owned bytes",async()=>{
 const reply=new Uint8Array(60001);let copies=0,released=0;
 reply.slice=()=>{copies++;throw Error("unbudgeted copy");};
 const s=scene(()=>({hr:0,data:reply,release(){released++;}}));await s.connect();
 expect(copies).toBe(0);expect(released).toBe(1);expect(decodeNativeCoreOperation(s.c5()!)?.reason).toBe(DPN.DATATOOLARGE);
 expect(s.accepted).toBe(0);expect(s.host.pendingAdmissions).toBe(0);expect(s.host.retainedAdmissionBytes).toBe(0);
});
test("application failure maps to captured C5 and preserves rejected reply without publishing a player",async()=>{
 const nativeReject=bytes(fixture.reject.host[0].payload),reply=decodeNativeCoreOperation(nativeReject)!.data!;
 let released=0;const s=scene(()=>({hr:0x80004005,data:reply.slice(),context:"rejected",release(){released++;}}));
 await s.connect();expect(s.c5()).toEqual(nativeReject);expect(s.c2()).toBeUndefined();
 expect(s.host.entities.size).toBe(1);expect(s.host.currentPlayers).toBe(1);expect(s.accepted).toBe(0);
 expect(s.releases).toBe(1);expect(released).toBe(1);
});
test("C2 transport admission does not publish a peer before its real C3",async()=>{
 const s=scene(undefined,false);await s.connect();expect(s.c2()).toBeDefined();expect(s.host.entities.size).toBe(1);expect(s.accepted).toBe(0);
 expect(await s.link.sendReliable(nativeCoreWords(0xc3))).toBe(0);await turns();expect(s.accepted).toBe(1);
 expect(await s.link.sendReliable(nativeCoreWords(0xc3))).toBe(0);await turns();expect(s.accepted).toBe(1);
});
test("unknown data/voice/foreign initial frames never allocate a Host endpoint",()=>{
 const s=scene();expect(s.start()).toBe(0);
 const emit=(port:number,data:Uint8Array)=>s.hostNet.receiveFrame(encodeDatagram(PROTO_UDP,s.peerNet.node,fixture.ports[0],port,data));
 emit(fixture.ports[1],Uint8Array.of(0x7f,0,0,0));
 emit(fixture.ports[1],encodeNativeProtocolFrame({kind:"data",command:DN.DATA|DN.RELIABLE|DN.NEW_MESSAGE|DN.END_MESSAGE,control:0,sequence:0,nextReceive:0,masks:[],payload:c1}));
 emit(fixture.ports[1]+1,encodeNativeProtocolFrame({kind:"control",command:0x88,opcode:1,messageId:0,responseId:0,version:0x10002,sessionId:9,timestamp:0,extra:new Uint8Array()}));
 expect(s.host.peerCount).toBe(0);expect(s.host.currentPlayers).toBe(1);
});
test("late accepted admission after Close releases ownership once and cannot revive a restarted Host",async()=>{
 let finish!:(decision:NativeHostDecision)=>void,owned=0;
 const s=scene(()=>new Promise(resolve=>{finish=resolve;}));await s.connect();
 expect(s.host.currentPlayers).toBe(2);expect(s.host.entities.size).toBe(1);
 const oldPort=s.host.localAddress.port;s.host.close();expect(s.hostNet.isBound(oldPort,PROTO_UDP)).toBe(false);
 expect(s.start()).toBe(0);
 finish({hr:0,data:reference.reply.slice(),context:"old",release(){owned++;}});await turns();
 expect(owned).toBe(1);expect(s.releases).toBe(0);expect(s.accepted).toBe(0);expect(s.c2()).toBeUndefined();
 expect(s.host.entities.size).toBe(1);expect(s.host.currentPlayers).toBe(1);
});
test("reentrant Close from reply release aborts the admitted context without publishing remote CREATE",async()=>{
 let owned=0;const s=scene(()=>({hr:0,data:reference.reply.slice(),context:"aborted",release(){owned++;}}),true,{closeOnRelease:true});
 // C1 transport ACK can be cancelled by the local, reentrant Close.
 expect(s.start()).toBe(0);expect(await s.link.connect()).toBe(0);
 const sent=s.link.sendReliable(c1);await turns();s.link.close();await sent;
 expect(s.releases).toBe(1);expect(owned).toBe(1);expect(s.accepted).toBe(0);expect(s.aborted).toBe(1);
 expect(s.host.entities.size).toBe(0);expect(s.host.peerCount).toBe(0);expect(s.host.currentPlayers).toBe(0);
});
test("graceful Close cancels a C2 peer still waiting for C3 instead of waiting for its handshake deadline",async()=>{
 const s=scene(undefined,false);await s.connect();expect(s.c2()).toBeDefined();
 expect(await s.host.shutdown()).toBe(0);expect(s.aborted).toBe(1);expect(s.accepted).toBe(0);
 expect(s.hostNet.isBound(fixture.ports[0],PROTO_UDP)).toBe(false);expect(s.host.pendingBytes).toBe(0);
});
test("malformed C1 offsets and voice cannot consume an admission or publish user data",async()=>{
 const s=scene();expect(s.start()).toBe(0);expect(await s.link.connect()).toBe(0);
 const bad=c1.slice();new DataView(bad.buffer).setUint32(12,0xffffffff,true);
 expect(await s.link.sendReliable(bad)).toBe(0);await turns();expect(s.events).toEqual([]);
 expect(await s.link.sendReliable(c1)).toBe(0);await turns();expect(s.accepted).toBe(1);
 for(const flags of [DN.USER2,DN.USER1|DN.USER2])expect(await s.link.sendReliable(Uint8Array.of(7,8),flags)).toBe(0);
 expect(s.host.queue).toHaveLength(0);
});
test("unknown-tuple handshakes have finite aggregate count and deadline without allocating player IDs",async()=>{
 const s=scene(undefined,true,{allowPendingRange:true});expect(s.start()).toBe(0);
 for(let n=0;n<17;n++)s.hostNet.receiveFrame(encodeDatagram(PROTO_UDP,s.peerNet.node,fixture.ports[0],fixture.ports[1]+n,
  encodeNativeProtocolFrame({kind:"control",command:0x88,opcode:1,messageId:0,responseId:0,version:0x10002,sessionId:n+1,timestamp:0,extra:new Uint8Array()})));
 expect(s.host.peerCount).toBe(16);expect(s.host.currentPlayers).toBe(1);expect(s.host.entities.size).toBe(1);
 await Bun.sleep(160);expect(s.host.peerCount).toBe(0);expect(s.host.pendingBytes).toBe(0);expect(s.host.currentPlayers).toBe(1);
});
test("a failed Host observer cannot interrupt Close resource cleanup",async()=>{
 const s=scene();await s.connect();s.host.onChange=()=>{throw Error("owner gone");};
 try {expect(()=>s.host.close()).not.toThrow();
 expect(s.hostNet.isBound(fixture.ports[0],PROTO_UDP)).toBe(false);expect(s.host.peerCount).toBe(0);expect(s.host.pendingBytes).toBe(0);
 } finally {s.host.onChange=undefined;}
});
test("adapter lifetime loss releases listen, pending admission, and player reservations",async()=>{
 let finish!:(decision:NativeHostDecision)=>void,released=0;
 const s=scene(()=>new Promise(resolve=>{finish=resolve;}));await s.connect();s.hostNet.attach(null);
 expect(s.host.isHost).toBe(false);expect(s.host.currentPlayers).toBe(0);expect(s.host.pendingBytes).toBe(0);
 finish({hr:0,release(){released++;}});await turns();expect(released).toBe(1);expect(s.accepted).toBe(0);
});
test("unreturned admissions remain counted across Host lifetimes and refuse further callbacks before allocation",async()=>{
 const finishes:((decision:NativeHostDecision)=>void)[]=[];
 let released=0;const responses:Uint8Array[]=[];
 const s=scene(()=>new Promise(resolve=>finishes.push(resolve)),false,{allowPendingRange:true});
 for(let index=0;index<17;index++){
  expect(s.start()).toBe(0);const port=fixture.ports[1]+index+1;
  const link=new NativeReliableLink({timeout:120,retryInterval:2,send:packet=>s.peerNet.send(port,s.hostNet.node,fixture.ports[0],packet,PROTO_UDP),
   onMessage:m=>{if(m.command&DN.USER1)responses.push(m.payload.slice());}});
  cleanup.push(()=>link.close());
  expect(s.peerNet.bind(port,{deliver:d=>link.receive(d.data)},PROTO_UDP)).toBe(true);
  expect(await link.connect()).toBe(0);expect(await link.sendReliable(c1)).toBe(0);await turns();
  if(index<16){expect(finishes).toHaveLength(index+1);expect(s.host.pendingAdmissions).toBe(index+1);s.host.close();link.close();}
 }
 expect(finishes).toHaveLength(16);expect(s.host.pendingAdmissions).toBe(16);
 expect(s.host.retainedAdmissionBytes).toBe(c1.length*16);
 expect(decodeNativeCoreOperation(responses.at(-1)!)?.reason).toBe(DPN.TABLEFULL);
 for(const finish of finishes)finish({hr:0,release(){released++;}});
 await turns();expect(released).toBe(16);expect(s.host.pendingAdmissions).toBe(0);expect(s.host.retainedAdmissionBytes).toBe(0);
 expect(s.accepted).toBe(0);
});


