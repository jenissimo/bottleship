/**
 * Contract: NT5 XPSP1 recvdg.c967278:1168-1186; default drop-incoming buffering path,
 * no outstanding receive IRP. The NT5 x86 free default /Zp8 source profile uses
 * 48-byte AFD_BUFFER_TAG records. Modern provider quota remains UNMEASURED.
 * This first case does not encode sizeof: window1 needs only positive sizeof.
 * Exactly one AF_INET case, two live sockets, one zero plus two distinct1B offers.
 * Namespace barriers prove engine sequencing only, never Windows admission ACK.
 */
import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {publicContext} from "./fixtures/wsa-rcvbuf-context";

type F=ReturnType<typeof publicContext>;
type Endpoint=ReturnType<F["local"]>;
const DATA=0x24000,NAME=0x25000,NAME_LENGTH=0x25100,INPUT=0x26000,TARGET=0x26100;
const a5=(n:number)=>Array(n).fill(0xa5);
let seed=0x5a590000;

function receive(f:F,socket:number,peek=false){
 f.m.ram.fill(0xa5,DATA,DATA+48); //8-byte prefix +32-byte output +8-byte suffix
 f.m.ram.fill(0xa5,NAME,NAME+48); //8 +sockaddr capacity32 +8
 f.m.ram.fill(0xa5,NAME_LENGTH,NAME_LENGTH+12);f.m.put(NAME_LENGTH+4,32);
 f.m.seed(++seed);
 const rc=f.call("recvfrom",[socket,DATA+8,32,peek?2:0,NAME+8,NAME_LENGTH+4]);
 const row={rc,error:f.m.error(),peek,nameLength:f.m.get(NAME_LENGTH+4),
  data:Array.from(f.m.ram.slice(DATA,DATA+48)),name:Array.from(f.m.ram.slice(NAME,NAME+48)),
  lengthBytes:Array.from(f.m.ram.slice(NAME_LENGTH,NAME_LENGTH+12))};
 f.note({receiveZeroPressure:row});return row;
}
function offer(f:F,socket:number,target:Endpoint,input:readonly number[]){
 if(input.length>1)throw Error("This source contract case is zero/one-byte only");
 f.m.ram.fill(0xa5,INPUT,INPUT+32);f.m.ram.set(input,INPUT+8);
 f.m.ram.fill(0xa5,TARGET,TARGET+48);f.m.ram.set(target.raw.slice(0,target.length),TARGET+8);
 const before={data:Array.from(f.m.ram.slice(INPUT,INPUT+32)),target:Array.from(f.m.ram.slice(TARGET,TARGET+48))};
 f.m.seed(++seed);
 const rc=f.call("sendto",[socket,INPUT+8,input.length,0,TARGET+8,target.length]),error=f.m.error();
 const after={data:Array.from(f.m.ram.slice(INPUT,INPUT+32)),target:Array.from(f.m.ram.slice(TARGET,TARGET+48))};
 const row={input:[...input],rc,error,before,after};f.note({offerZeroPressure:row});return row;
}
function empty(r:ReturnType<typeof receive>){
 expect(r.rc).toBe(-1);expect(r.error).toBe(10035);expect(r.nameLength).toBe(32);
 expect(r.data).toEqual(a5(48));expect(r.name).toEqual(a5(48));
 expect(r.lengthBytes).toEqual([...a5(4),32,0,0,0,...a5(4)]);
}
function datagram(r:ReturnType<typeof receive>,source:Endpoint,input:readonly number[]){
 expect(r.rc).toBe(input.length);expect(r.error).toBe(0);expect(r.nameLength).toBe(16);
 expect(r.data).toEqual([...a5(8),...input,...a5(40-input.length)]);
 expect(r.name).toEqual([...a5(8),...source.raw.slice(0,16),...a5(24)]);
 expect(r.lengthBytes).toEqual([...a5(4),16,0,0,0,...a5(4)]);
}

test("SOURCE NT5 zero-record pressure window1 drops later datagram until consume; modern quota unmeasured",async()=>{
 const network=new LanNetwork(),ns=new RootNetworkNamespace(network,16,59001);
 let f:F|undefined,first:unknown;const transcript:Record<string,unknown>={basis:"NT5_SOURCE_NOT_MODERN_QUOTA"};
 try{
  await ns.barrier();
  f=publicContext(createWsaActorTable(network,()=>ns.socketActorClient()));
  const receiver=f.socket(2),sender=f.socket(2);
  // The existing public fixture independently validates requested127.0.0.1/family2
  // and actual chosen port. Expected source comes from that actual sender query.
  const target=f.bind(receiver,2),source=f.bind(sender,2);
  const set=f.set(receiver,1),query=f.query(receiver,4);
  const initial=receive(f,receiver,true);
  const zeroOffer=offer(f,sender,target,[]);await ns.barrier();
  const zeroPeek=receive(f,receiver,true); //positive first admission, without consuming
  const blockedOffer=offer(f,sender,target,[0xd1]);await ns.barrier();
  const afterOfferPeek=receive(f,receiver,true);
  const zeroPlain=receive(f,receiver);
  const afterZeroPlain=receive(f,receiver);
  // Both source-expected drop and current available-only behavior have now drained
  // their observed transcript; a distinct offer is an independent recovery control.
  const recoveryOffer=offer(f,sender,target,[0xd2]);await ns.barrier();
  const recoveryPeek=receive(f,receiver,true),recoveryPlain=receive(f,receiver),tail=receive(f,receiver);
  const closeSender=f.call("closesocket",[sender]),closeSenderError=f.m.error();
  const closeReceiver=f.call("closesocket",[receiver]),closeReceiverError=f.m.error();
  Object.assign(transcript,{receiver,sender,target,source,set,query,initial,zeroOffer,zeroPeek,
   blockedOffer,afterOfferPeek,zeroPlain,afterZeroPlain,recoveryOffer,recoveryPeek,recoveryPlain,tail,
   closeSender,closeSenderError,closeReceiver,closeReceiverError});
  f.note({completeActualZeroPressureTranscript:transcript});
  // Every actual offer/read/close above occurs BEFORE semantic assertions.
  expect(target.family).toBe(2);expect(source.family).toBe(2);
  expect(target.length).toBe(16);expect(source.length).toBe(16);
  expect(source.port).not.toBe(target.port);
  expect(set.rc).toBe(0);expect(set.error).toBe(0);expect(set.after).toEqual(set.before);
  expect(query.rc).toBe(0);expect(query.error).toBe(0);expect(query.length).toBe(4);expect(query.word).toBe(1);
  for(const row of[zeroOffer,blockedOffer,recoveryOffer]){
   expect(row.rc).toBe(row.input.length);expect(row.error).toBe(0);
   expect(row.after).toEqual(row.before);
   expect(row.before.data).toEqual([...a5(8),...row.input,...a5(24-row.input.length)]);
   expect(row.before.target).toEqual([...a5(8),...target.raw.slice(0,16),...a5(24)]);
  }
  empty(initial);datagram(zeroPeek,source,[]);datagram(afterOfferPeek,source,[]);
  datagram(zeroPlain,source,[]);
  // NT5 rejects the later offer while the zero-byte head still occupies its tag;
  // consuming that head must leave no delayed0xd1 datagram behind.
  empty(afterZeroPlain);
  datagram(recoveryPeek,source,[0xd2]);datagram(recoveryPlain,source,[0xd2]);empty(tail);
  expect(closeSender).toBe(0);expect(closeReceiver).toBe(0);
 }catch(error){
  first=error;console.error(JSON.stringify({kind:"NT5_SOURCE_ZERO_TAG_PRESSURE_NOT_NATIVE_CERTIFICATE",
   transcript,trace:f?.trace,error:String(error)}));
 }finally{
  // Independent cleanup paths; failing assertions never skip physical fixture/namespace release.
  try{f?.dispose();}catch(error){if(first===undefined)first=error;}
  try{await ns.close();}catch(error){if(first===undefined)first=error;}
 }
 if(first!==undefined)throw first;
},15000);

/** Literal boundaries of the explicitly selected NT5 x86 free /Zp8 source profile.
 * These are source-model controls, not measurements of modern Windows quotas. */
for(const family of [2,23] as const)for(const [window,admitsLater] of [[47,false],[48,false],[49,true]] as const){
 test("SOURCE NT5 x86 free tag boundary AF"+family+" window"+window,async()=>{
  const network=new LanNetwork(),ns=new RootNetworkNamespace(network,16,59100+family*10+window);
  let f:F|undefined,first:unknown;const actual:Record<string,unknown>={family,window,basis:"NT5_X86_FREE_SOURCE_PROFILE"};
  try{
   await ns.barrier();f=publicContext(createWsaActorTable(network,()=>ns.socketActorClient()));
   const receiver=f.socket(family),sender=f.socket(family),target=f.bind(receiver,family),source=f.bind(sender,family);
   const set=f.set(receiver,window),query=f.query(receiver);
   const offerZero=f.send(sender,target,[]);await ns.barrier();
   const offerLater=f.send(sender,target,[0xd1]);await ns.barrier();
   const peek=f.receive(receiver,true),zero=f.receive(receiver),later=f.receive(receiver);
   const offerRecovery=f.send(sender,target,[0xd2]);await ns.barrier();
   const recovery=f.receive(receiver),tail=f.receive(receiver);
   f.close(sender);f.close(receiver);
   Object.assign(actual,{target,source,set,query,offerZero,offerLater,peek,zero,later,offerRecovery,recovery,tail});
   f.note({completeBoundaryTranscript:actual});
   const packet=(r:ReturnType<F["receive"]>,bytes:number[])=>{
    expect(r.rc).toBe(bytes.length);expect(r.error).toBe(0);expect(r.length).toBe(source.length);
    expect(r.data).toEqual([...bytes,...a5(32-bytes.length)]);
    expect(r.name).toEqual([...source.raw.slice(0,source.length),...a5(32-source.length)]);
   };
   const noPacket=(r:ReturnType<F["receive"]>)=>{
    expect(r.rc).toBe(-1);expect(r.error).toBe(10035);expect(r.length).toBe(32);
    expect(r.data).toEqual(a5(32));expect(r.name).toEqual(a5(32));
   };
   expect(set.rc).toBe(0);expect(set.error).toBe(0);expect(set.after).toEqual(set.before);
   expect(query.rc).toBe(0);expect(query.error).toBe(0);expect(query.word).toBe(window);
   expect([offerZero,offerLater,offerRecovery]).toEqual([0,1,1]);
   packet(peek,[]);packet(zero,[]);
   if(admitsLater)packet(later,[0xd1]);else noPacket(later);
   packet(recovery,[0xd2]);noPacket(tail);
  }catch(error){first=error;console.error(JSON.stringify({kind:"NT5_SOURCE_BOUNDARY_NOT_MODERN_QUOTA",actual,trace:f?.trace,error:String(error)}));}
  finally{try{f?.dispose();}catch(error){if(first===undefined)first=error;}
   try{await ns.close();}catch(error){if(first===undefined)first=error;}}
  if(first!==undefined)throw first;
 },15000);
}
