/**
 * Native x86 PE11edadb2/ref9d2781e1: IP UDP success LastError and
 * empty/zero/data SD_RECEIVE readiness. TCP EOF is a separate mechanism control.
 */
import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WSA} from "../../src/worker/modules/wsa-network";
import type {ThunkImplementation,ThunkResult} from "../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./fixtures/wsa-api-context";

type Family=2|23;
interface Endpoint{handle:number;raw:number[];length:number;}
const address=0x20000,option=0x20100,name=0x21000,nameLength=0x21100;
const data=0x22000,receiveData=0x23000,receiveName=0x24000,receiveLength=0x24100;
const output=0x25000,returned=0x25100,readSet=0x26000,exceptSet=0x26100,timeout=0x26200;
const fill=(n:number)=>Array(n).fill(0xa5);
let sequence=0;
async function withActor(label:string,body:(x:Awaited<ReturnType<typeof fixture>>)=>Promise<void>){
 let x:Awaited<ReturnType<typeof fixture>>|undefined,first:unknown;
 try{x=await fixture();await body(x);}
 catch(error){first=error;console.error(JSON.stringify({label,trace:x?.trace,error:String(error)}));}
 finally{try{await x?.dispose();}catch(error){if(first===undefined)first=error;}}
 if(first!==undefined)throw first;
}
async function fixture(){
 const network=new LanNetwork(),ns=new RootNetworkNamespace(network,16,52300+(++sequence));
 let memory:ReturnType<typeof createWsaApiFixture>|undefined;
 try{
  await ns.barrier();memory=createWsaApiFixture(createWsaActorTable(network,()=>ns.socketActorClient()));
  const m=memory,trace:unknown[]=[];
  const bytes=(p:number,n:number)=>Array.from(m.ram.slice(p,p+n));
  function invoke(fn:ThunkImplementation,args:number[],label:string){
   const result=fn({} as never,m.ram,args);
   if(result instanceof Promise)throw Error("Expected bounded nonblocking ABI: "+label);
   if(typeof result!=="number"&&result.deferredWrites)m.apply(result as ThunkResult);
   const rc=typeof result==="number"?result:result.value;
   if(trace.length>=256)throw Error("Bounded actor/API trace");
   trace.push({label,args:[...args],rc,error:m.error()});return rc;
  }
  const call=(label:string,args:number[])=>invoke(m.api[label],args,label);
  function need(label:string,args:number[],wanted=0){
   const rc=call(label,args);if(rc!==wanted)throw Error(label+" prerequisite "+rc+"/"+m.error());return rc;
  }
  function local(handle:number):Endpoint{
   m.ram.fill(0xa5,name,name+32);m.put(nameLength,32);need("getsockname",[handle,name,nameLength]);
   const length=m.get(nameLength),raw=bytes(name,length),family=raw[0]|raw[1]<<8;
   if(length!==(family===2?16:28)||!((raw[2]<<8)|raw[3]))throw Error("Actual bound endpoint required");
   return{handle,raw,length};
  }
  function socket(family:Family,type=2):Endpoint{
   const handle=call("WSASocketA",[family,type,type===1?6:17,0,0,1]);
   if(handle===-1||handle===0xffffffff)throw Error("Socket creation prerequisite");
   m.put(option,1);need("ioctlsocket",[handle,0x8004667e,option]);
   if(family===23)need("setsockopt",[handle,41,27,option,4]);
   const raw=new Uint8Array(family===2?16:28);raw[0]=family;
   if(family===2)raw.set([127,0,0,1],4);else raw[23]=1;
   m.ram.set(raw,address);need("bind",[handle,address,raw.length]);
   const endpoint=local(handle);
   if(endpoint.raw.some((b,i)=>i!==2&&i!==3&&b!==raw[i]))throw Error("Independent bind input differs");
   return endpoint;
  }
  function connect(source:Endpoint,peer:Endpoint){
   m.ram.fill(0xa5,address,address+32);m.ram.set(peer.raw,address);const before=bytes(address,32);
   m.seed(0x5a520018);const rc=call("connect",[source.handle,address,peer.length]);
   return{rc,error:m.error(),before,after:bytes(address,32)};
  }
  function send(source:Endpoint,peer:Endpoint,payload:number[],connected=false){
   m.ram.set(peer.raw,address);m.ram.set(payload,data);
   need(connected?"send":"sendto",connected?[source.handle,data,payload.length,0]:
    [source.handle,data,payload.length,0,address,peer.length],payload.length);
  }
  function receive(handle:number,peek=false){
   m.ram.fill(0xa5,receiveData,receiveData+16);m.ram.fill(0xa5,receiveName,receiveName+32);
   m.put(receiveLength,32);m.seed(0x5a520019);
   const rc=call("recvfrom",[handle,receiveData,16,peek?2:0,receiveName,receiveLength]);
   return{rc,error:m.error(),length:m.get(receiveLength),data:bytes(receiveData,16),name:bytes(receiveName,32)};
  }
  function available(handle:number){
   m.ram.fill(0xa5,output,output+16);m.ram.fill(0xa5,returned,returned+12);
   m.put(output+4,0xb6b6b6b6);m.put(returned+4,0xb7b7b7b7);m.seed(0x5a520021);
   const rc=call("WSAIoctl",[handle,0x4004667f,0,0,output+4,4,returned+4,0,0]);
   return{rc,error:m.error(),value:m.get(output+4),returned:m.get(returned+4),
    output:bytes(output,16),count:bytes(returned,12)};
  }
  function select(handle:number){
   for(const ptr of[readSet,exceptSet]){m.ram.fill(0xa5,ptr,ptr+16);m.put(ptr,1);m.put(ptr+4,handle);}
   m.put(timeout,0);m.put(timeout+4,0);m.seed(0x5a520008);
   const rc=invoke(m.select,[0,readSet,0,exceptSet,timeout],"select");
   return{rc,error:m.error(),read:m.get(readSet),except:m.get(exceptSet),
    readTail:bytes(readSet+8,8),exceptTail:bytes(exceptSet+8,8)};
  }
  return{m,trace,call,need,socket,local,connect,send,receive,available,select,barrier:()=>ns.barrier(),
   async dispose(){try{m.dispose();}finally{await ns.close();}}};
 }catch(error){try{memory?.dispose();}finally{await ns.close();}throw error;}
}
type Actor=Awaited<ReturnType<typeof fixture>>;
function expectReady(actual:ReturnType<Actor["select"]>,read:boolean){
 expect(actual.rc).toBe(+read);expect(actual.read).toBe(+read);expect(actual.except).toBe(0);
 expect(actual.error).toBe(0);expect(actual.readTail).toEqual(fill(8));expect(actual.exceptTail).toEqual(fill(8));
}
function expectAvailable(actual:ReturnType<Actor["available"]>,value:number){
 const word=[value&255,value>>>8&255,value>>>16&255,value>>>24&255];
 expect(actual.rc).toBe(0);expect(actual.error).toBe(0);expect(actual.value).toBe(value);expect(actual.returned).toBe(4);
 expect(actual.output).toEqual([...fill(4),...word,...fill(8)]);
 expect(actual.count).toEqual([...fill(4),4,0,0,0,...fill(4)]);
}
function expectDatagram(actual:ReturnType<Actor["receive"]>,source:Endpoint,payload:number[]){
 expect(actual.rc).toBe(payload.length);expect(actual.error).toBe(0);expect(actual.length).toBe(source.length);
 expect(actual.data).toEqual([...payload,...fill(16-payload.length)]);
 expect(actual.name).toEqual([...source.raw,...fill(32-source.length)]);
}
function expectReceiveError(actual:ReturnType<Actor["receive"]>,error:number){
 expect(actual.rc).toBe(-1);expect(actual.error).toBe(error);expect(actual.length).toBe(32);
 expect(actual.data).toEqual(fill(16));expect(actual.name).toEqual(fill(32));
}
for(const family of[2,23] as const){
 test("IP UDP connect clears only the issuing thread LastError AF"+family,async()=>withActor("CONNECT_AF"+family,async x=>{
  const source=x.socket(family),peer=x.socket(family),connected=x.connect(source,peer);
  x.send(source,peer,[0xd7,0x52,0x18],true);await x.barrier();const received=x.receive(peer.handle);
  expectDatagram(received,source,[0xd7,0x52,0x18]);expect(connected.before).toEqual(connected.after);
  expect(connected.rc).toBe(0);expect(connected.error).toBe(0);expect(x.m.error(2)).toBe(0x2222);
 }),20000);
 test("IP UDP query/connect errors keep guarded outputs and endpoint AF"+family,async()=>withActor("GUARDS_AF"+family,async x=>{
  const source=x.socket(family),peer=x.socket(family),observed:{rc:number;error:number|undefined;out:number[];count:number[]}[]=[];
  for(const args of[
   [source.handle,0x4004667f,0,0,output+4,3,returned+4,0,0],
   [source.handle,0x4004667f,0,0,0,4,returned+4,0,0],
   [source.handle,0x4004667f,0,0,output+4,4,0,0,0],
   [source.handle,0x4004667f,0,0,output+4,4,returned+4,0x28000,0],
  ]){
   x.m.ram.fill(0xa5,output,output+16);x.m.ram.fill(0xa5,returned,returned+12);x.m.seed(0x5a520022);
   const rc=x.call("WSAIoctl",args);observed.push({rc,error:x.m.error(),out:Array.from(x.m.ram.slice(output,output+16)),count:Array.from(x.m.ram.slice(returned,returned+12))});
  }
  const bad=x.call("connect",[source.handle,0,peer.length]),badError=x.m.error();
  x.send(peer,source,[0x52]);await x.barrier();const received=x.receive(source.handle);
  observed.forEach((r,i)=>{expect(r.rc).toBe(-1);expect(r.error).toBe(i===3?WSA.EOPNOTSUPP:WSA.EFAULT);
   expect(r.out).toEqual(fill(16));expect(r.count).toEqual(fill(12));});
  expect(bad).toBe(-1);expect(badError).toBe(WSA.EFAULT);expectDatagram(received,peer,[0x52]);
  expect(x.m.error(2)).toBe(0x2222);
 }),20000);
 for(const connected of[false,true])for(const mode of["empty","zero","data"] as const){
  test("IP UDP SD_RECEIVE follows queue state AF"+family+" connected="+connected+" "+mode,async()=>withActor("SHUTDOWN_"+family+"_"+connected+"_"+mode,async x=>{
   const source=x.socket(family),peer=x.socket(family);
   if(connected){const r=x.connect(source,peer);if(r.rc)throw Error("UDP connect prerequisite");}
   const payload=mode==="data"?[0xd7,0x52,0x47,0x31,0x01]:[];
   if(mode!=="empty")x.send(peer,source,payload);await x.barrier();
   const before=x.select(source.handle),peek=x.receive(source.handle,true),available=x.available(source.handle);
   const shutdown=x.call("shutdown",[source.handle,0]),shutdownError=x.m.error();
   const polls=Array.from({length:4},()=>x.select(source.handle));
   const denied=x.receive(source.handle),after=x.available(source.handle);
   expectReady(before,mode!=="empty");
   if(mode==="empty")expectReceiveError(peek,WSA.EWOULDBLOCK);else expectDatagram(peek,peer,payload);
   expect(shutdown).toBe(0);expect(shutdownError).toBe(0);
   // A zero-byte datagram is a retained record despite having no payload bytes.
   for(const poll of polls)expectReady(poll,mode!=="empty");
   expectReceiveError(denied,WSA.ESHUTDOWN);
   expectAvailable(available,mode==="empty"?0:mode==="zero"?1:5);expectAvailable(after,mode==="empty"?0:mode==="zero"?1:5);
   expect(x.m.error(2)).toBe(0x2222);
  }),20000);
 }
 test("TCP EOF stays readable after the peer sends FIN AF"+family,async()=>withActor("TCP_EOF_AF"+family,async x=>{
  const listener=x.socket(family,1),client=x.socket(family,1);x.need("listen",[listener.handle,2]);
  const connection=x.connect(client,listener);
  if(connection.rc!==0&&(connection.rc!==-1||connection.error!==WSA.EWOULDBLOCK))throw Error("TCP connect prerequisite");
  await x.barrier();const accepted=x.call("accept",[listener.handle,0,0]);
  if(accepted===-1||accepted===0xffffffff)throw Error("TCP accept prerequisite");
  const empty=x.select(accepted);x.need("shutdown",[client.handle,1]);await x.barrier();
  const ready=x.select(accepted),eof=x.receive(accepted),again=x.select(accepted);
  expectReady(empty,false);expectReady(ready,true);expectReady(again,true);expect(eof.rc).toBe(0);expect(eof.error).toBe(0);
  expect(eof.data).toEqual(fill(16));
 }),20000);
}
