/**
 * UDP FIONREAD reports total queued payload bytes on AF_INET/AF_INET6.
 * Microsoft WinSock IOCTLs, FIONREAD section:
 * https://learn.microsoft.com/windows/win32/winsock/winsock-ioctls
 * NT5 AFD receive.c:1501-1513 snapshots aggregate bytes without consuming.
 *
 * Real namespace + dedicated Worker actor + public ioctlsocket/WSAIoctl ABI.
 * Single-datagram controls and actual receives establish payload/source delivery.
 * First unchanged-runtime RED: stage42 job j340041,4pass/2fail; both ABIs returned3 for3+5.
 * Error-only/zero-byte fallback and mixed queue semantics need separate native probes.
 */
import {expect, test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WSA} from "../../src/worker/modules/wsa-network";
import type {ThunkResult} from "../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./fixtures/wsa-api-context";

type Family = 2 | 23;
interface Endpoint {socket:number; family:Family; bytes:number[]; port:number;}
const FIONREAD=0x4004667f, FIONBIO=0x8004667e;
const input=0x20000, name=0x21000, nameLength=0x21100, nonblocking=0x21200;
const sendData=0x22000, recvData=0x23000, recvName=0x24000, recvLength=0x24100;
const output=0x25000, returned=0x25100;
const three=[0x31,0x32,0x33], five=[0x51,0x52,0x53,0x54,0x55];
const filled=(length:number)=>Array(length).fill(0xa5);
let fixtureSequence=0;

async function createActorFixture(){
 const network=new LanNetwork(),pid=42000+(++fixtureSequence);
 const namespace=new RootNetworkNamespace(network,16,pid);
 let memory:ReturnType<typeof createWsaApiFixture>|undefined;
 try{
  await namespace.barrier();
  const table=createWsaActorTable(network,()=>namespace.socketActorClient());
  memory=createWsaApiFixture(table,0x5a420001);
  const m=memory;
  let disposed=false;
  const size=(af:Family)=>af===2?16:28;
  const bytes=(p:number,n:number)=>Array.from(m.ram.slice(p,p+n));
  function call(exportName:string,args:number[]):number{
   const fn=m.api[exportName];
   if(!fn)throw Error("Missing public Winsock export:"+exportName);
   const result=fn({} as never,m.ram,args);
   if(result instanceof Promise)throw Error("Nonblocking Winsock call unexpectedly asynchronous:"+exportName);
   if(typeof result==="number")return result;
   if(result.deferredWrites)m.apply(result as ThunkResult);
   return result.value;
  }
  function requireValue(exportName:string,args:number[],wanted:number){
   const actual=call(exportName,args);
   if(actual!==wanted)throw Error("Actor prerequisite "+exportName+"="+actual+" LastError="+m.error());
  }
  function socket(family:Family):Endpoint{
   const handle=call("WSASocketA",[family,2,17,0,0,1]);
   if(handle===-1||handle===0xffffffff)throw Error("Actor UDP socket prerequisite:"+m.error());
   const address=new Uint8Array(size(family)),view=new DataView(address.buffer);
   view.setUint16(0,family,true);
   if(family===2){address[4]=127;address[7]=1;}else address[23]=1;
   m.ram.set(address,input);
   requireValue("bind",[handle,input,address.length],0);
   m.put(nonblocking,1);requireValue("ioctlsocket",[handle,FIONBIO,nonblocking],0);
   m.ram.fill(0xa5,name,name+32);m.put(nameLength,32);
   requireValue("getsockname",[handle,name,nameLength],0);
   const length=m.get(nameLength),actual=bytes(name,length),port=((actual[2]??0)<<8)|(actual[3]??0);
   if(length!==size(family)||actual[0]!==family||actual[1]!==0||port<1||port>65535)
    throw Error("Queried real endpoint prerequisite");
   const start=family===2?4:8,count=family===2?4:16;
   for(let i=0;i<count;i++)if(actual[start+i]!==address[start+i])
    throw Error("getsockname must preserve the explicitly requested loopback IP");
   return{socket:handle,family,bytes:actual,port};
  }
  function send(sender:Endpoint,destination:Endpoint,payload:number[]){
   m.ram.set(destination.bytes,input);m.ram.set(payload,sendData);
   m.seed(0x5a420002);
   requireValue("sendto",[sender.socket,sendData,payload.length,0,input,destination.bytes.length],payload.length);
  }
  /** Actual actor -> namespace -> actor FIFO acknowledgement; no time-based delivery guess. */
  async function queued(){
   await namespace.barrier();
  }
  function available(socket:number){
   m.ram.fill(0xa5,output,output+12);m.seed(0x5a420003);
   const legacyValue=call("ioctlsocket",[socket,FIONREAD,output]);
   const legacy={value:legacyValue,error:m.error(),count:m.get(output),tail:bytes(output+4,8)};
   m.ram.fill(0xa5,output,output+12);m.ram.fill(0xa5,returned,returned+8);m.seed(0x5a420004);
   const wsaValue=call("WSAIoctl",[socket,FIONREAD,0,0,output,4,returned,0,0]);
   const wsa={value:wsaValue,error:m.error(),count:m.get(output),tail:bytes(output+4,8),
    returned:m.get(returned),returnedTail:bytes(returned+4,4)};
   return{legacy,wsa};
  }
  function receive(socket:number,flags=0){
   m.ram.fill(0xa5,recvData,recvData+16);m.ram.fill(0xa5,recvName,recvName+32);
   m.put(recvLength,32);m.seed(0x5a420005);
   const value=call("recvfrom",[socket,recvData,16,flags,recvName,recvLength]);
   return{value,error:m.error(),length:m.get(recvLength),name:bytes(recvName,32),payload:bytes(recvData,16)};
  }
  return{socket,send,queued,available,receive,
   async dispose(){
    if(disposed)return;disposed=true;
    // createWsaApiFixture restores shared System.process/Mem descriptors even on reset failure.
    // Independently await ONLY this owned real namespace/actor shutdown in finally.
    try{m.dispose();}finally{await namespace.close();}
   }
  };
 }catch(error){
  try{memory?.dispose();}finally{await namespace.close();}
  throw error;
 }
}

type ActorFixture=Awaited<ReturnType<typeof createActorFixture>>;
type Available=ReturnType<ActorFixture["available"]>;
type Received=ReturnType<ActorFixture["receive"]>;
function expectAvailable(actual:Available,wanted:number){
 expect(actual.legacy.value).toBe(0);expect(actual.legacy.error).toBe(0);expect(actual.legacy.count).toBe(wanted);
 expect(actual.legacy.tail).toEqual(filled(8));
 expect(actual.wsa.value).toBe(0);expect(actual.wsa.error).toBe(0);expect(actual.wsa.count).toBe(wanted);
 expect(actual.wsa.returned).toBe(4);expect(actual.wsa.tail).toEqual(filled(8));
 expect(actual.wsa.returnedTail).toEqual(filled(4));
}
function expectDatagram(actual:Received,sender:Endpoint,payload:number[]){
 expect(actual.value).toBe(payload.length);
 expect(actual.length).toBe(sender.bytes.length);
 expect(actual.name).toEqual([...sender.bytes,...filled(32-sender.bytes.length)]);
 expect(actual.payload).toEqual([...payload,...filled(16-payload.length)]);
}
function expectEmpty(actual:Received){
 expect(actual.value).toBe(-1);expect(actual.error).toBe(WSA.EWOULDBLOCK);
 expect(actual.length).toBe(32);expect(actual.name).toEqual(filled(32));expect(actual.payload).toEqual(filled(16));
}

for(const family of[2,23] as const){
 for(const payload of[three,five]){
  test("UDP FIONREAD data-only AF"+family+": independent single"+payload.length+" control uses both public ABIs",async()=>{
   const x=await createActorFixture();
   try{
    const sender=x.socket(family),receiver=x.socket(family),empty=x.available(receiver.socket);
    x.send(sender,receiver,payload);await x.queued();
    const first=x.available(receiver.socket),again=x.available(receiver.socket);
    const peek=x.receive(receiver.socket,2),afterPeek=x.available(receiver.socket);
    const consumed=x.receive(receiver.socket),drained=x.available(receiver.socket),wouldBlock=x.receive(receiver.socket);
    // Actual endpoint and both real receive payloads establish delivery independently of FIONREAD.
    expectDatagram(peek,sender,payload);expectDatagram(consumed,sender,payload);expectEmpty(wouldBlock);
    expectAvailable(empty,0);expectAvailable(first,payload.length);expectAvailable(again,payload.length);
    expectAvailable(afterPeek,payload.length);expectAvailable(drained,0);
   }finally{await x.dispose();}
  },30000);
 }
 test("UDP FIONREAD data-only AF"+family+": queued3+5 totals8 without query or PEEK consumption",async()=>{
  const x=await createActorFixture();
  try{
   const sender=x.socket(family),receiver=x.socket(family),empty=x.available(receiver.socket);
   // Two real sends from ONE independently queried sender; no receive until the causal namespace barrier.
   x.send(sender,receiver,three);x.send(sender,receiver,five);await x.queued();
   const total=x.available(receiver.socket),repeat=x.available(receiver.socket);
   const peek=x.receive(receiver.socket,2),afterPeek=x.available(receiver.socket);
   const first=x.receive(receiver.socket),remaining=x.available(receiver.socket);
   const second=x.receive(receiver.socket),drained=x.available(receiver.socket),wouldBlock=x.receive(receiver.socket);
   // Collect the entire transcript before the aggregate assertion so both payloads/source are retained
   // even when unchanged head-only FIONREAD returns3 instead of8.
   expectDatagram(peek,sender,three);expectDatagram(first,sender,three);expectDatagram(second,sender,five);
   expectEmpty(wouldBlock);expectAvailable(empty,0);
   expectAvailable(total,8);expectAvailable(repeat,8);expectAvailable(afterPeek,8);
   expectAvailable(remaining,5);expectAvailable(drained,0);
  }finally{await x.dispose();}
 },30000);
}
