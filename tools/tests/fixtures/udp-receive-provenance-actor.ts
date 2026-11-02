/**
 * Real namespace + dedicated Worker socket actor + public Winsock ABI.
 * Expected addresses come from getsockname of the actual sender, not a receive mapper.
 * No packet/error injection, private delivery/encoder mocks or sleeps.
 */
import {RootNetworkNamespace} from "../../../src/worker/core/network-namespace";
import {LanNetwork} from "../../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../../src/worker/modules/wsa-actor-table";
import type {ThunkResult} from "../../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./wsa-api-context";

const input=0x20000,query=0x21000,queryLength=0x21100,sendData=0x22000;
const receiveName=0x23000,receiveLength=0x23100,receiveData=0x24000,nonblocking=0x25000;
const protocolInfo=0x30000,optionValue=0x32000,optionLength=0x32100,networkEventRecord=0x33000;
let sequence=0;
export type Family=2|23;
export type BindKind="loopback"|"virtual"|"wildcard";
export interface Endpoint {family:Family;socket:number;bytes:number[];port:number;}
export interface ReadResult {value:number;error:number|undefined;length:number;name:number[];payload:number[];}
export async function createUdpReceiveProvenanceActor(){
 const pid=38000+(++sequence),network=new LanNetwork(),host=new RootNetworkNamespace(network,16,pid);
 let memory:ReturnType<typeof createWsaApiFixture>|undefined;
 try{
  await host.barrier();
  const table=createWsaActorTable(network,()=>host.socketActorClient());
  memory=createWsaApiFixture(table,0x1234);const m=memory;
  let disposed=false;
  const size=(af:Family)=>af===2?16:28;
  const bytes=(address:number,count:number)=>Array.from(m.ram.slice(address,address+count));
  function call(name:string,args:number[]):number{
   const fn=m.api[name];if(!fn)throw Error("Public Winsock export missing:"+name);
   const r=fn({} as never,m.ram,args);
   if(r instanceof Promise)throw Error("Nonblocking public call unexpectedly asynchronous:"+name);
   if(typeof r==="number")return r;
   if(r.deferredWrites)m.apply(r as ThunkResult);
   return r.value;
  }
  function requireResult(name:string,args:number[],wanted:number){
   const actual=call(name,args);
   if(actual!==wanted)throw Error("Real actor fixture prerequisite "+name+" returned "+actual+" LE="+m.error());
   return actual;
  }
  function local(socket:number,af:Family):Endpoint{
   m.ram.fill(0xa5,query,query+32);m.put(queryLength,32);
   requireResult("getsockname",[socket,query,queryLength],0);
   const n=m.get(queryLength);if(n!==size(af))throw Error("Public getsockname size prerequisite");
   const b=bytes(query,n),port=(b[2]<<8)|b[3];
   if(b[0]!==af||b[1]!==0||port<=0)throw Error("Queried actual endpoint prerequisite");
   return{family:af,socket,bytes:b,port};
  }
  function inputAddress(af:Family,kind:BindKind,port=0){
   const b=new Uint8Array(size(af)),v=new DataView(b.buffer);v.setUint16(0,af,true);v.setUint16(2,port,false);
   if(kind==="loopback"){if(af===2){b[4]=127;b[7]=1;}else b[23]=1;}
   else if(kind==="virtual")b.set(af===2?network.ipv4:network.ipv6,af===2?4:8);
   return b;
  }
  function socket(af:Family,kind:BindKind="loopback"):Endpoint{
   const handle=call("WSASocketA",[af,2,17,0,0,1]);
   if(handle===-1||handle===0xffffffff)throw Error("Real actor socket prerequisite LE="+m.error());
   // Standard public sockaddr input; output expectations are independently queried.
   const b=inputAddress(af,kind);
   m.ram.set(b,input);requireResult("bind",[handle,input,b.length],0);
   m.put(nonblocking,1);requireResult("ioctlsocket",[handle,0x8004667e,nonblocking],0);
   const endpoint=local(handle,af),addressOffset=af===2?4:8,addressBytes=af===2?4:16;
   // A mapper must not make receive/query agree by rewriting the bound IP too.
   // b is the actual requested bind input: loopback, dynamic own virtual IP, or zeros.
   for(let i=0;i<addressBytes;i++)if(endpoint.bytes[addressOffset+i]!==b[addressOffset+i])
    throw Error("Public getsockname changed requested "+kind+" bind IP for AF"+af+
     " wanted="+Array.from(b.slice(addressOffset,addressOffset+addressBytes))+
     " actual="+endpoint.bytes.slice(addressOffset,addressOffset+addressBytes));
   return endpoint;
  }
  function destination(target:Endpoint,kind:BindKind):Endpoint{
   return{...target,bytes:Array.from(inputAddress(target.family,kind,target.port))};
  }
  function send(socket:number,target:Endpoint,byte:number){
   m.ram.set(target.bytes,input);m.ram[sendData]=byte;m.seed(0x5a380001);
   const value=call("sendto",[socket,sendData,1,0,input,target.bytes.length]);return{value,error:m.error()};
  }
  function sendOk(socket:number,target:Endpoint,byte:number){
   const result=send(socket,target,byte);
   if(result.value!==1||result.error!==0)throw Error("Real actor send prerequisite:"+JSON.stringify(result));
  }
  function receive(socket:number,{flags=0,capacity=32,fromPresent=true,lengthPresent=true}={}):ReadResult{
   m.ram.fill(0xa5,receiveData,receiveData+16);m.ram.fill(0xa5,receiveName,receiveName+32);m.put(receiveLength,capacity);m.seed(0x5a380002);
   const value=call("recvfrom",[socket,receiveData,16,flags,fromPresent?receiveName:0,lengthPresent?receiveLength:0]);
   return{value,error:m.error(),length:m.get(receiveLength),name:bytes(receiveName,32),payload:bytes(receiveData,16)};
  }
  /** Actual actor->namespace->actor FIFO control round trip; never sleep/inject readiness. */
  async function fence(){await host.barrier();}
  async function delivered(socket:number){
   await fence();if(!table.readable(socket))throw Error("Real actor UDP not readable after its namespace barrier");
  }
  function close(socket:number){requireResult("closesocket",[socket],0);}
  function duplicate(socket:number){
   requireResult("WSADuplicateSocketA",[socket,pid,protocolInfo],0);
   const alias=call("WSASocketA",[-1,-1,-1,protocolInfo,0,1]);
   if(alias===-1||alias===0xffffffff)throw Error("Real self-PID alias import prerequisite LE="+m.error());
   return alias;
  }
  function soError(socket:number){
   m.put(optionValue,0xa5a5a5a5);m.put(optionLength,4);m.seed(0x5a380003);
   const value=call("getsockopt",[socket,0xffff,0x1007,optionValue,optionLength]);
   return{value,error:m.error(),option:m.get(optionValue),length:m.get(optionLength)};
  }
  /** Public actor-table selection; no fake guest event object or private physical state. */
  function selectRead(socket:number){table.configureEvents(socket,1);}
  function networkEvents(socket:number){
   m.ram.fill(0xa5,networkEventRecord,networkEventRecord+44);m.seed(0x5a380004);
   const value=call("WSAEnumNetworkEvents",[socket,0,networkEventRecord]);
   return{value,error:m.error(),mask:m.get(networkEventRecord),
    errors:Array.from({length:10},(_,i)=>m.get(networkEventRecord+4+i*4))};
  }
  async function closedCase(af:Family,withAlias=false,watchRead=false){
   const client=socket(af),a=socket(af),b=socket(af),alias=withAlias?duplicate(client.socket):undefined;
   sendOk(client.socket,a,97);await delivered(a.socket);const warmA=receive(a.socket);
   sendOk(client.socket,b,98);await delivered(b.socket);const warmB=receive(b.socket);
   // Independent error-copyback regression must not fail first on the separately
   // tested source-IP loss. Keep both actual recvfrom snapshots; require real payloads.
   for(const [r,marker]of[[warmA,97],[warmB,98]] as const)
    if(r.value!==1||r.error!==0||r.payload[0]!==marker)throw Error("Real warmup payload prerequisite");
   let beforeErrorEvents:ReturnType<typeof networkEvents>|undefined;
   if(watchRead){selectRead(client.socket);beforeErrorEvents=networkEvents(client.socket);}
   close(a.socket);await fence();sendOk(client.socket,a,120);await delivered(client.socket);
   return{client,a,b,alias,warmA,warmB,beforeErrorEvents};
  }
  return{pid,socket,destination,send,sendOk,receive,fence,delivered,close,duplicate,soError,selectRead,networkEvents,closedCase,
   async dispose(){
    if(disposed)return;disposed=true;
    // The ABI fixture restores System/Mem even if reset fails. Independently
    // await this owned actor namespace close; never terminate a foreign worker.
    try{m.dispose();}finally{await host.close();}
   }};
 }catch(error){
  try{memory?.dispose();}finally{await host.close();}
  throw error;
 }
}
