/**
 * Host COMPLETEONPROCESS binary-lane regressions.
 * Real NativeReliableLink C1/C2/C3 and E0/E1 binary lanes; no mocked encoder/reserve.
 * NT5-derived component controls, NOT a new Windows/public-COM or buffer-lifetime certificate.
 */
import {afterEach,expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {PROTO_UDP,decodeDatagram,encodeDatagram} from "../../src/worker/net/netplay-wire";
import {NativeHostBackend} from "../../src/worker/modules/dpnet/native-wire/host-backend";
import {NativeReliableLink} from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import {DN,decodeNativeProtocolFrame} from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import {decodeNativeCoreConnectInfo,encodeNativePlayerConnect} from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import {DPN} from "../../src/worker/modules/dpnet/constants";
import type {DirectPlay8HostReady} from "../../src/worker/modules/dpnet/backend";
import type {SessionDesc} from "../../src/worker/modules/dplayx/session";

const closes:Array<()=>void>=[];
afterEach(()=>{for(const close of closes.splice(0).reverse())close();});
const words=(...values:number[])=>{
 const result=new Uint8Array(values.length*4),view=new DataView(result.buffer);
 values.forEach((value,index)=>view.setUint32(index*4,value,true));return result;
};
const word=(bytes:Uint8Array,offset=0)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset,true);
async function turns(){for(let n=0;n<32;n++)await Promise.resolve();}
function observe(result:number|Promise<number>){const values:number[]=[];const promise=Promise.resolve(result).then(hr=>{values.push(hr);return hr;});return{values,promise};}
const description:SessionDesc={
 instance:"00112233445566778899aabbccddeeff",application:"11223344556677889900aabbccddeeff",
 name:"COP component",password:"",maxPlayers:3,flags:0,user:[0,0,0,0],
 extended:{flags:0,reserved:[],application:[]},
};
function scene(){
 const nets=[31,32,33].map(last=>new LanNetwork(Uint8Array.of(2,0,0,0,0,last)));
 const carrierReceipts:Array<{recipient:number;handle:number;sequence:number;ackDelivered:boolean}>=[];
 for(const [source,network]of nets.entries())network.attach({send(frame){
  const datagram=decodeDatagram(frame);if(!datagram)throw Error("Actual datagram decode");
  const target=nets.findIndex(net=>net.node.every((byte,index)=>byte===datagram.node[index]));
  if(target<0)return false;
  const wire=decodeNativeProtocolFrame(datagram.payload);
  if(source===0&&wire?.kind==="data"&&(wire.command&(DN.USER1|DN.RELIABLE|DN.NEW_MESSAGE|DN.END_MESSAGE))===(DN.USER1|DN.RELIABLE|DN.NEW_MESSAGE|DN.END_MESSAGE)&&wire.payload.length>=8&&word(wire.payload)===0xe0)
   carrierReceipts.push({recipient:target,handle:word(wire.payload,4),sequence:wire.sequence,ackDelivered:false});
  nets[target].receiveFrame(encodeDatagram(datagram.proto,nets[source].node,datagram.dstPort,datagram.srcPort,datagram.payload));
  if(target===0&&wire?.kind==="ack")for(const receipt of carrierReceipts)
   if(receipt.recipient===source&&wire.nextReceive===((receipt.sequence+1)&255))receipt.ackDelivered=true;
  return true;
 },close(){}});
 const backend=new NativeHostBackend(nets[0],500,20);
 const peers:Array<{link:NativeReliableLink;port:number;binding:Parameters<LanNetwork["bind"]>[1];id:number;packets:Uint8Array[];cop:Array<{handle:number;data:Uint8Array}>}>=[];
 let releases=0,providerLost!:(reason:{code:number;message:string})=>void;
 const provider={prepare:async(request:{localPort:number}):Promise<DirectPlay8HostReady>=>({
  address:{node:[2,1,127,0,0,1],port:request.localPort},
  allowIncoming:address=>nets.slice(1).some(net=>net.node.every((byte,index)=>byte===address.node[index])),
  url:address=>"x-directplay:/hostname=127.0.0.1;port="+address.port,
  release(){releases++;},
  closed:new Promise(resolve=>{providerLost=resolve;}),
 })};
 const start=()=>backend.start(description,{name:"host",data:Uint8Array.of(0)},provider,57100,()=>({hr:0}),()=>{});
 async function join(role:1|2){
  const old=peers[role];if(old){old.link.close();nets[role].unbind(old.port,old.binding,PROTO_UDP);}
  const port=57100+role,packets:Uint8Array[]=[],cop:Array<{handle:number;data:Uint8Array}>=[];
  const received:{snapshot?:NonNullable<ReturnType<typeof decodeNativeCoreConnectInfo>>}={};
  const link=new NativeReliableLink({timeout:500,retryInterval:20,
   send:payload=>nets[role].send(port,nets[0].node,57100,payload,PROTO_UDP),
   onMessage:message=>{
    const packet=message.payload.slice();packets.push(packet);
    if(packet.length>=4&&word(packet)===0xc2){const snapshot=decodeNativeCoreConnectInfo(packet);if(!snapshot)throw Error("Actual C2 decode");received.snapshot=snapshot;}
    if(packet.length>=8&&word(packet)===0xe0)cop.push({handle:word(packet,4),data:packet.slice(8)});
   }});
  const binding:Parameters<LanNetwork["bind"]>[1]={deliver:datagram=>link.receive(datagram.data)};
  closes.push(()=>{link.close();nets[role].unbind(port,binding,PROTO_UDP);});
  expect(nets[role].bind(port,binding,PROTO_UDP)).toBe(true);
  expect(await link.connect()).toBe(0);
  expect(await link.sendReliable(encodeNativePlayerConnect({
   flags:4,version:2,instance:description.instance,application:description.application,
   name:"peer"+role,data:Uint8Array.of(role),password:null,connectData:new Uint8Array(),url:null,alternate:new Uint8Array(),
  }))).toBe(0);
  await turns();expect(received.snapshot).toBeTruthy();
  expect(await link.sendReliable(words(0xc3))).toBe(0);await turns();
  const id=received.snapshot!.localId;expect(backend.entities.has(id)).toBe(true);
  return peers[role]={link,port,binding,id,packets,cop};
 }
 closes.push(()=>{backend.dispose();for(const net of nets)net.attach(null);});
 return{backend,nets,start,join,carrierReceipts,ack:(peer:Awaited<ReturnType<typeof join>>,handle:number)=>peer.link.sendReliable(words(0xe1,handle)),
  loseProvider:()=>providerLost({code:10054,message:"owned provider lost"}),get releases(){return releases;}};
}
test("Host COP sends E0 and waits beyond reliable ACK for the recipient E1; retained bytes survive completion",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const peer=await s.join(1),payload=Uint8Array.of(7,0,9);
 const pending=observe(s.backend.sendDpn(peer.id,12,payload));await turns();
 // On unchanged code this fails at a real, fully joined binary lane: UNSUPPORTED, no E0.
 expect(peer.cop).toHaveLength(1);expect(peer.cop[0].handle).toBeGreaterThan(0);
 expect(peer.cop[0].data).toEqual(payload);
 // Observe the actual E0 sequence and its SACK delivered to Host; microtask turns alone are not an ACK receipt.
 expect(s.carrierReceipts.find(receipt=>receipt.recipient===1&&receipt.handle===peer.cop[0].handle)?.ackDelivered).toBe(true);
 expect(pending.values).toEqual([]);
 expect(await s.ack(peer,peer.cop[0].handle)).toBe(0);expect(await pending.promise).toBe(0);
 expect(peer.cop[0].data).toEqual(payload); // Recipient still owns its copied bytes; no buffer release is required here.
 expect(await s.ack(peer,peer.cop[0].handle)).toBe(0);await turns();expect(pending.values).toEqual([0]);
 expect(await s.backend.sendDpn(peer.id,8,Uint8Array.of(0x77))).toBe(0);
 expect(peer.packets.at(-1)).toEqual(Uint8Array.of(0x77));
},5000);
test("Ordinary guaranteed completion settles on carrier ACK alone while the same silent lane keeps COP pending",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const peer=await s.join(1);
 // Measured native contract (stage56): an ordinary GUARANTEED completion is transport-level
 // and must not wait for any recipient processing. Bare link delivery, no E1, no reply.
 const ordinary=observe(s.backend.sendDpn(peer.id,8,Uint8Array.of(1,2,3)));await turns();
 expect(peer.packets.at(-1)).toEqual(Uint8Array.of(1,2,3));
 expect(await ordinary.promise).toBe(0);
 // The identical held lane: COMPLETEONPROCESS stays pending until the recipient E1.
 const cop=observe(s.backend.sendDpn(peer.id,12,Uint8Array.of(4,5,6)));await turns();
 expect(peer.cop).toHaveLength(1);expect(cop.values).toEqual([]);
 expect(await s.ack(peer,peer.cop[0].handle)).toBe(0);expect(await cop.promise).toBe(0);
 expect(await s.backend.sendDpn(peer.id,8,Uint8Array.of(0x33))).toBe(0);
 expect(peer.packets.at(-1)).toEqual(Uint8Array.of(0x33));
},5000);
test("Host COP rejects malformed, foreign-recipient, unknown and stale E1 without completing a replacement",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const first=await s.join(1),other=await s.join(2);
 const pending=observe(s.backend.sendDpn(first.id,12,Uint8Array.of(1,0,2)));await turns();expect(first.cop).toHaveLength(1);
 const handle=first.cop[0].handle;
 for(const packet of[words(0xe1),Uint8Array.from([...words(0xe1,handle),0]),words(0xe1,0),words(0xe1,handle+1)]){
  expect(await first.link.sendReliable(packet)).toBe(0);await turns();expect(pending.values).toEqual([]);
 }
 expect(await s.ack(other,handle)).toBe(0);await turns();expect(pending.values).toEqual([]);
 expect(await s.ack(first,handle)).toBe(0);expect(await pending.promise).toBe(0);
 const replacement=observe(s.backend.sendDpn(first.id,12,Uint8Array.of(3,0,4)));await turns();expect(first.cop).toHaveLength(2);
 const next=first.cop[1].handle;expect(next).not.toBe(handle);
 expect(await s.ack(first,handle)).toBe(0);await turns();expect(replacement.values).toEqual([]);
 expect(await s.ack(first,next)).toBe(0);expect(await replacement.promise).toBe(0);
 expect(await s.backend.sendDpn(other.id,8,Uint8Array.of(0x55))).toBe(0);expect(other.packets.at(-1)).toEqual(Uint8Array.of(0x55));
},5000);
test("Host COP abort retires one request and a late reply cannot settle the next request",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const peer=await s.join(1),controller=new AbortController();
 const cancelled=observe(s.backend.sendDpn(peer.id,12,Uint8Array.of(1),controller.signal));await turns();expect(peer.cop).toHaveLength(1);
 controller.abort();expect(await cancelled.promise).toBe(DPN.USERCANCEL);
 const next=observe(s.backend.sendDpn(peer.id,12,Uint8Array.of(2)));await turns();expect(peer.cop).toHaveLength(2);
 expect(peer.cop[1].handle).not.toBe(peer.cop[0].handle);
 expect(await s.ack(peer,peer.cop[0].handle)).toBe(0);await turns();expect(next.values).toEqual([]);
 expect(await s.ack(peer,peer.cop[1].handle)).toBe(0);expect(await next.promise).toBe(0);
 controller.abort();expect(cancelled.values).toEqual([DPN.USERCANCEL]);expect(next.values).toEqual([0]);
},5000);
test("Host broadcast COP waits for both actual recipient completions",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const first=await s.join(1),second=await s.join(2);
 const pending=observe(s.backend.sendDpn(0,12|0x20,Uint8Array.of(7,0,8)));await turns();
 expect(first.cop).toHaveLength(1);expect(second.cop).toHaveLength(1);
 expect(first.cop[0].handle).not.toBe(second.cop[0].handle);
 expect(await s.ack(first,first.cop[0].handle)).toBe(0);await turns();expect(pending.values).toEqual([]);
 expect(await s.ack(second,second.cop[0].handle)).toBe(0);expect(await pending.promise).toBe(0);expect(pending.values).toEqual([0]);
},5000);
test("Host Close/restart fences old handles and preserves once completion",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const oldPeer=await s.join(1);
 const old=observe(s.backend.sendDpn(oldPeer.id,12,Uint8Array.of(1)));await turns();expect(oldPeer.cop).toHaveLength(1);
 s.backend.close();expect(await old.promise).toBe(DPN.USERCANCEL);expect(s.releases).toBe(1);
 expect(await s.start()).toBe(0);const freshPeer=await s.join(1);
 const fresh=observe(s.backend.sendDpn(freshPeer.id,12,Uint8Array.of(2)));await turns();expect(freshPeer.cop).toHaveLength(1);
 expect(freshPeer.cop[0].handle).not.toBe(oldPeer.cop[0].handle);
 expect(await s.ack(freshPeer,oldPeer.cop[0].handle)).toBe(0);await turns();expect(fresh.values).toEqual([]);
 expect(await s.ack(freshPeer,freshPeer.cop[0].handle)).toBe(0);expect(await fresh.promise).toBe(0);
 expect(old.values).toEqual([DPN.USERCANCEL]);expect(fresh.values).toEqual([0]);
},5000);
test("Host provider loss settles remote processing as connection loss without forced successful completion",async()=>{
 const s=scene();expect(await s.start()).toBe(0);const peer=await s.join(1);
 const pending=observe(s.backend.sendDpn(peer.id,12,Uint8Array.of(9)));await turns();expect(peer.cop).toHaveLength(1);
 s.loseProvider();await turns();expect(await pending.promise).toBe(DPN.CONNECTIONLOST);
 expect(pending.values).toEqual([DPN.CONNECTIONLOST]);expect(s.backend.openError).toBe(DPN.CONNECTIONLOST);expect(s.releases).toBe(1);
},5000);
