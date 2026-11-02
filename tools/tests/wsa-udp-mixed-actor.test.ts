/**
 * Real Worker UDP receive-queue regressions against the saved Windows x86 capture.
 * Native source/certificate and the original actor RED are retained under
 * logs/lan-conformance/stage43 through stage45. Keep query/order assertions before
 * the separate ioctlsocket LastError contract. Empty recv is a secondary control.
 */
import {expect, test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WSA} from "../../src/worker/modules/wsa-network";
import type {ThunkResult} from "../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./fixtures/wsa-api-context";

type Family=2|23;
interface Endpoint {socket:number;family:Family;bytes:number[];port:number;}
const FIONREAD=0x4004667f,FIONBIO=0x8004667e;
const input=0x20000,name=0x21000,nameLength=0x21100,nonblocking=0x21200,resetInput=0x21300;
const sendData=0x22000,recvData=0x23000,recvName=0x24000,recvLength=0x24100;
const output=0x25000,returned=0x25100;
const nativeNonce=4301001;
const filled=(length:number)=>Array(length).fill(0xa5);
let fixtureSequence=0;

async function createActorFixture(){
 const network=new LanNetwork(),pid=45000+(++fixtureSequence);
 const namespace=new RootNetworkNamespace(network,16,pid);
 let memory:ReturnType<typeof createWsaApiFixture>|undefined;
 try{
  await namespace.barrier();
  const table=createWsaActorTable(network,()=>namespace.socketActorClient());
  memory=createWsaApiFixture(table,0x5a450001);
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
   m.seed(0x5a450002);
   requireValue("sendto",[sender.socket,sendData,payload.length,0,input,destination.bytes.length],payload.length);
  }
  function close(socket:number){requireValue("closesocket",[socket],0);}
  function resetOn(socket:number){
   m.put(resetInput,1);m.ram.fill(0xa5,returned,returned+8);
   requireValue("WSAIoctl",[socket,0x9800000c,resetInput,4,0,0,returned,0,0],0);
  }
  /** Actual actor -> namespace -> actor FIFO acknowledgement; no time-based delivery guess. */
  async function queued(){
   await namespace.barrier();
  }
  function available(socket:number){
   // Native stage43 measured ioctlsocket LE0. WSAIoctl LE remains diagnostic, not a new native claim.
   m.ram.fill(0xa5,output,output+12);m.seed(0x5a450003);
   const legacyValue=call("ioctlsocket",[socket,FIONREAD,output]);
   const legacy={value:legacyValue,error:m.error(),count:m.get(output),tail:bytes(output+4,8)};
   m.ram.fill(0xa5,output,output+12);m.ram.fill(0xa5,returned,returned+8);m.seed(0x5a450004);
   const wsaValue=call("WSAIoctl",[socket,FIONREAD,0,0,output,4,returned,0,0]);
   const wsa={value:wsaValue,error:m.error(),count:m.get(output),tail:bytes(output+4,8),
    returned:m.get(returned),returnedTail:bytes(returned+4,4)};
   return{legacy,wsa};
  }
  function receive(socket:number,flags=0){
   m.ram.fill(0xa5,recvData,recvData+16);m.ram.fill(0xa5,recvName,recvName+32);
   m.put(recvLength,32);m.seed(0x5a450005);
   const value=call("recvfrom",[socket,recvData,16,flags,recvName,recvLength]);
   return{value,error:m.error(),length:m.get(recvLength),name:bytes(recvName,32),payload:bytes(recvData,16)};
  }
  return{socket,send,queued,available,receive,close,resetOn,
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
function expectCounts(actual:Available,wanted:number){
 expect(actual.legacy.value).toBe(0);expect(actual.legacy.count).toBe(wanted);
 expect(actual.legacy.tail).toEqual(filled(8));
 expect(actual.wsa.value).toBe(0);expect(actual.wsa.count).toBe(wanted);
 expect(actual.wsa.returned).toBe(4);expect(actual.wsa.tail).toEqual(filled(8));
 expect(actual.wsa.returnedTail).toEqual(filled(4));
}
function expectLegacyLastError(...actual:Available[]){
 // Check only AFTER the queue/ordering assertions. This is a separate measured
 // ioctlsocket LE0 gap; WSAIoctl's actual seeded LE is logged but not asserted.
 for(const result of actual)expect(result.legacy.error).toBe(0);
}
function expectName(actual:Received,sender:Endpoint){
 expect(actual.length).toBe(sender.bytes.length);
 expect(actual.name).toEqual([...sender.bytes,...filled(32-sender.bytes.length)]);
}
function expectDatagram(actual:Received,sender:Endpoint,payload:number[]){
 expect(actual.value).toBe(payload.length);expect(actual.error).toBe(0);
 expectName(actual,sender);
 expect(actual.payload).toEqual([...payload,...filled(16-payload.length)]);
}
function expectReset(actual:Received,closedA:Endpoint){
 expect(actual.value).toBe(-1);expect(actual.error).toBe(WSA.ECONNRESET);
 expectName(actual,closedA);expect(actual.payload).toEqual(filled(16));
}
function expectEmpty(actual:Received){
 expect(actual.value).toBe(-1);expect(actual.error).toBe(WSA.EWOULDBLOCK);
 expect(actual.length).toBe(32);expect(actual.name).toEqual(filled(32));expect(actual.payload).toEqual(filled(16));
}
function twoWords(first:number,second:number){
 const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);
 view.setUint32(0,first,true);view.setUint32(4,second,true);return Array.from(bytes);
}
async function warmRole(x:ActorFixture,client:Endpoint,other:Endpoint,caseId:number,role:1|2){
 // Same eight raw marker bytes as native warm_role. Both directions really pass
 // through the Worker actor/local namespace; each recvfrom must name its sender.
 const payload=twoWords(nativeNonce,0x57000000|(caseId<<8)|role);
 x.send(client,other,payload);await x.queued();const outward=x.receive(other.socket);
 x.send(other,client,payload);await x.queued();const inward=x.receive(client.socket);
 expectDatagram(outward,client,payload);expectDatagram(inward,other,payload);
 return{payload,outward,inward};
}
async function establishError(x:ActorFixture,family:Family,caseId:number,transcript:Record<string,unknown>){
 const client=x.socket(family),live=x.socket(family),closedA=x.socket(family);
 transcript.endpoints={client,live,closedA};x.resetOn(client.socket);
 transcript.warmL=await warmRole(x,client,live,caseId,1);
 transcript.warmA=await warmRole(x,client,closedA,caseId,2);
 x.close(closedA.socket);await x.queued();
 const trigger=twoWords(nativeNonce,0x45000000|caseId);
 x.send(client,closedA,trigger);await x.queued();
 const firstPeek=x.receive(client.socket,2);transcript.trigger=trigger;transcript.firstPeek=firstPeek;
 // Admission is witnessed by the actual non-consuming public recvfrom itself.
 // Do not send D until this succeeds; a barrier alone is not an error-queue ACK.
 expectReset(firstPeek,closedA);
 return{client,live,closedA};
}

for(const family of[2,23] as const){
 test("UDP queue AF"+family+": retained error-only exposes FIONREAD1 through both public ABIs",async()=>{
  const x=await createActorFixture(),caseId=family===2?1:4;
  const transcript:Record<string,unknown>={family,caseId,mode:"error-only",executedPublicAbis:["ioctlsocket","WSAIoctl","recvfrom"]};
  try{
   const{client,closedA}=await establishError(x,family,caseId,transcript);
   const before=x.available(client.socket),again=x.available(client.socket);
   const repeatPeek=x.receive(client.socket,2),afterPeek=x.available(client.socket);
   const consumed=x.receive(client.socket),afterConsume=x.available(client.socket);
   const wouldBlock=x.receive(client.socket),drained=x.available(client.socket);
   Object.assign(transcript,{before,again,repeatPeek,afterPeek,consumed,afterConsume,wouldBlock,drained});
   // Collect all actual results before the first queue assertion. Native cases1/4.
   expectCounts(before,1);expectCounts(again,1);expectCounts(afterPeek,1);
   expectReset(repeatPeek,closedA);expectReset(consumed,closedA);expectEmpty(wouldBlock);
   expectCounts(afterConsume,0);expectCounts(drained,0);
   expectLegacyLastError(before,again,afterPeek,afterConsume,drained);
  }finally{
   await x.dispose();
  }
 },30000);

 test("UDP queue AF"+family+": retained A error precedes later unique D5 and PEEK never consumes",async()=>{
  const x=await createActorFixture(),caseId=family===2?2:5;
  const transcript:Record<string,unknown>={family,caseId,mode:"error-then-data",executedPublicAbis:["ioctlsocket","WSAIoctl","recvfrom"]};
  try{
   const{client,live,closedA}=await establishError(x,family,caseId,transcript);
   // Exact native mixed5 bytes, distinct from warmup and closed-A trigger.
   const data=[0xd3,caseId,nativeNonce&255,(nativeNonce>>>8)&255,0x69];
   x.send(live,client,data);await x.queued();
   const delivered=x.available(client.socket);
   const repeatPeek=x.receive(client.socket,2),afterPeek=x.available(client.socket);
   const firstPlain=x.receive(client.socket),afterFirst=x.available(client.socket);
   const secondPlain=x.receive(client.socket),afterSecond=x.available(client.socket);
   const wouldBlock=x.receive(client.socket),drained=x.available(client.socket);
   Object.assign(transcript,{data,delivered,repeatPeek,afterPeek,firstPlain,afterFirst,secondPlain,afterSecond,wouldBlock,drained});
   // The real FIFO barrier + positive FION5 + eventual exact D receive establish
   // data delivery. Preserve the whole transcript before any ordering/LE assertion.
   // An unchanged packet-first queue should fail here on repeatPeek, not on LE.
   expectCounts(delivered,5);
   expectReset(repeatPeek,closedA);
   expectCounts(afterPeek,5);expectReset(firstPlain,closedA);expectCounts(afterFirst,5);
   expectDatagram(secondPlain,live,data);expectCounts(afterSecond,0);
   expectEmpty(wouldBlock);expectCounts(drained,0);
   expectLegacyLastError(delivered,afterPeek,afterFirst,afterSecond,drained);
  }finally{
   await x.dispose();
  }
 },30000);
}


/**
 * Stage53 Windows x86 evidence: native-first-file-audit.json (052b1101...) and
 * root-native-first-classification.json (f3b8c276...). Four fresh cases observed
 * sequential A/B errors, or retained-A PEEKs then ordinary A/B returns, followed
 * by exact L data. This tests that public sequence through a real Worker.
 * Native offers, FIONREAD/pacing and L delivery are NOT admission ACK_B; the
 * native trace does not certify simultaneous enqueue or universal FIFO policy.
 */
for(const family of[2,23] as const)for(const retained of[false,true]){
 test("UDP stage53 AF"+family+": "+(retained?"retained A PEEK then A/B returns":"sequential A/B controls")+" through real Worker",async()=>{
  const x=await createActorFixture(),caseId=(family===2?0:2)+(retained?1:0),nonce=5301001;
  try{
   const client=x.socket(family),live=x.socket(family),closedA=x.socket(family),closedB=x.socket(family);
   x.resetOn(client.socket);
   // Query-derived actual tuples and unique 8B markers establish both directions
   // for every destination before it is closed; no fabricated error injection.
   for(const [index,other]of[live,closedA,closedB].entries()){
    const payload=twoWords(nonce,0x57000000|(caseId<<8)|(index+1));
    x.send(client,other,payload);await x.queued();const outward=x.receive(other.socket);
    x.send(other,client,payload);await x.queued();const inward=x.receive(client.socket);
    expectDatagram(outward,client,payload);expectDatagram(inward,other,payload);
   }
   const trigger=twoWords(nonce,0x45000000|caseId);
   x.close(closedA.socket);await x.queued();
   x.send(client,closedA,trigger);await x.queued();
   const firstA=x.receive(client.socket,retained?2:0);
   // Positive actual A return is a prerequisite for offering B in both profiles.
   expectReset(firstA,closedA);
   x.close(closedB.socket);await x.queued();
   x.send(client,closedB,trigger);await x.queued();
   const peeks=retained?[x.receive(client.socket,2),x.receive(client.socket,2)]:[];
   const ordinary=retained?[x.receive(client.socket),x.receive(client.socket)]:[x.receive(client.socket)];
   const finalPayload=twoWords(nonce,0x4c000000|caseId);
   x.send(live,client,finalPayload);await x.queued();
   const final=x.receive(client.socket),empty=x.receive(client.socket);
   // Collect target results before asserting ordering. The final positive B
   // return is checked separately from send acceptance and namespace barriers.
   for(const peek of peeks)expectReset(peek,closedA);
   if(retained){expectReset(ordinary[0]!,closedA);expectReset(ordinary[1]!,closedB);}
   else expectReset(ordinary[0]!,closedB);
   expectDatagram(final,live,finalPayload);expectEmpty(empty);
  }finally{await x.dispose();}
 },30000);
}
