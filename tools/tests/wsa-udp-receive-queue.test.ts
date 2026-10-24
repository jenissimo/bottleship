/**
 * Common physical UDP receive queue controls. NT5 source audit8cad1e82:
 * misc.c tail-admits status/source records; recvdg.c consumes one head unless PEEK;
 * receive.c returns payload-byte total, or1 when Count>0 and the byte total is0.
 * Multiple errors, zero datagrams and SD_RECEIVE here are SOURCE/mechanism controls,
 * not additional modern-Windows measurements. Stage45 f8b2 remains the real-Worker
 * primary for the certified single-error-before-later-D transcript.
 */
import {afterEach,expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {PROTO_UDP,PROTO_UDP6} from "../../src/worker/net/netplay-wire";
import {WsaActorKernel} from "../../src/worker/modules/wsa-actor-kernel";
import type {WsaActorIdentity} from "../../src/worker/modules/wsa-actor-protocol";
import {FD_READ,WSA,WsaFailure,WsaUdpReceiveFailure,WsaSocketTable,ipv4Address,ipv6Address,
 type WsaAddress} from "../../src/worker/modules/wsa-network";
import {getWsaOverlapped,wsaStatusError} from "../../src/worker/modules/wsa-overlapped";
import type {ThunkResult} from "../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./fixtures/wsa-api-context";
import {actorFixture,ov} from "./fixtures/udp-connreset-actor";

type Family=2|23;
const disposers:Array<()=>void>=[];
afterEach(()=>{for(const dispose of disposers.splice(0).reverse())dispose();});
const copy=(a:WsaAddress):WsaAddress=>({...a,node:Uint8Array.from(a.node),
 ...(a.ip?{ip:Uint8Array.from(a.ip)}:{}),...(a.ip6?{ip6:Uint8Array.from(a.ip6)}:{})});
const input=0x20000,buffer=0x22000,name=0x23000,nameLength=0x23100,option=0x25000;
function failed(action:()=>unknown,code:number):WsaFailure{
 let caught:unknown;try{action();}catch(error){caught=error;}
 expect(caught).toBeInstanceOf(WsaFailure);expect((caught as WsaFailure).code).toBe(code);
 return caught as WsaFailure;
}
function resetFrom(action:()=>unknown,from:WsaAddress):WsaUdpReceiveFailure{
 const error=failed(action,WSA.ECONNRESET);
 expect(error).toBeInstanceOf(WsaUdpReceiveFailure);
 expect((error as WsaUdpReceiveFailure).from).toEqual(from);
 return error as WsaUdpReceiveFailure;
}
function fixture(family:Family){
 const network=new LanNetwork(Uint8Array.of(2,0,0,45,1,2)),table=new WsaSocketTable(network);
 const memory=createWsaApiFixture(table);
 disposers.push(()=>memory.dispose());
 const address=(port=0)=>family===2?ipv4Address(network.ipv4,port):ipv6Address(network.ipv6,port);
 function socket(port=0){
  const id=table.socket(2,family,17);table.bind(id,address(port));table.setNonBlocking(id,true);
  return{id,address:copy(table.get(id).local!)};
 }
 const rx=socket(),live=socket(),a=socket(),b=socket(),proto=family===2?PROTO_UDP:PROTO_UDP6;
 const endpoint=(x:WsaAddress)=>({family,address:Uint8Array.from(family===2?x.ip!:x.ip6!),port:x.port,
  ...(family===23?{scopeId:x.scopeId??0,flowInfo:x.flowInfo??0}:{})});
 // Explicit secondary admission at the existing trusted network callback boundary.
 // No socket table internals, fabricated actor results or changed error-producer methods.
 function error(to:WsaAddress,from:WsaAddress,generation=network.bindingGeneration(to.port,proto)){
  const context={source:endpoint(to),destination:endpoint(from)};
  network.notifyLocalUdpError({node:Uint8Array.from(network.node),proto,localPort:to.port,
   remotePort:from.port,code:WSA.ECONNRESET,bindingGeneration:generation,localUdp:context});
  return context;
 }
 function call(exportName:string,args:number[]){
  const result=memory.api[exportName]({} as never,memory.ram,args);
  if(result instanceof Promise)throw Error("Expected synchronous nonblocking ABI: "+exportName);
  if(typeof result==="number")return result;
  if(result.deferredWrites)memory.apply(result as ThunkResult);
  return result.value;
 }
 function sockaddr(x:WsaAddress){
  const bytes=new Uint8Array(family===2?16:28),view=new DataView(bytes.buffer);
  view.setUint16(0,family,true);view.setUint16(2,x.port,false);
  bytes.set(family===2?x.ip!:x.ip6!,family===2?4:8);
  if(family===23){view.setUint32(4,x.flowInfo??0,true);view.setUint32(24,x.scopeId??0,true);}
  return bytes;
 }
 function receivePublic({capacity=32,data=buffer,from=name,length=nameLength,flags=0}={}){
  memory.ram.fill(0xa5,buffer,buffer+16);memory.ram.fill(0xa5,name,name+32);
  memory.put(nameLength,capacity);memory.seed(0x12345678);
  const value=call("recvfrom",[rx.id,data,16,flags,from,length]);
  return{value,error:memory.error(),length:memory.get(nameLength),
   payload:Array.from(memory.ram.slice(buffer,buffer+16)),name:Array.from(memory.ram.slice(name,name+32))};
 }
 return{network,table,memory,address,socket,rx,live,a,b,proto,error,call,sockaddr,receivePublic};
}

for(const family of[2,23] as const){
 test("UDP queue source FIFO AF"+family+": data/A-error/data/B-error, PEEK and copied source",()=>{
  const f=fixture(family),first=Uint8Array.of(0x11,0x12,0x13),second=Uint8Array.of(0x51,0x52,0x53,0x54,0x55);
  f.table.send(f.live.id,first,f.rx.address);
  const admitted=f.error(f.rx.address,f.a.address);
  f.table.send(f.live.id,second,f.rx.address);f.error(f.rx.address,f.b.address);
  // Retained provenance must not borrow either producer context or a prior PEEK exception.
  admitted.destination.address.fill(0);admitted.source.address.fill(0);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(8);
  expect(f.table.receive(f.rx.id,16).data).toEqual(first);
  const peek=resetFrom(()=>f.table.receive(f.rx.id,16,2),f.a.address);
  peek.from.node.fill(0);(family===2?peek.from.ip!:peek.from.ip6!).fill(0);
  resetFrom(()=>f.table.receive(f.rx.id,16,2),f.a.address);
  resetFrom(()=>f.table.receive(f.rx.id,16),f.a.address);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(5);
  const data=f.table.receive(f.rx.id,16);
  expect({data:data.data,from:data.from}).toEqual({data:second,from:f.live.address});
  expect(f.table.bytesAvailable(f.rx.id)).toBe(1);
  resetFrom(()=>f.table.receive(f.rx.id,16),f.b.address);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(0);expect(f.table.readable(f.rx.id)).toBe(false);
  failed(()=>f.table.receive(f.rx.id,16),WSA.EWOULDBLOCK);
 });

 test("UDP queue NT5-source AF"+family+": zero datagrams count as records, not payload bytes",()=>{
  const f=fixture(family),data=Uint8Array.of(0x61,0x62,0x63);
  f.table.send(f.live.id,new Uint8Array(0),f.rx.address);f.table.send(f.live.id,data,f.rx.address);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(3);
  const peek=f.table.receive(f.rx.id,16,2),empty=f.table.receive(f.rx.id,16);
  expect({peek:peek.data,consumed:empty.data,from:empty.from})
   .toEqual({peek:new Uint8Array(0),consumed:new Uint8Array(0),from:f.live.address});
  expect(f.table.bytesAvailable(f.rx.id)).toBe(3);
  expect(f.table.receive(f.rx.id,16).data).toEqual(data);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(0);
  f.table.send(f.live.id,new Uint8Array(0),f.rx.address);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(1);expect(f.table.readable(f.rx.id)).toBe(true);
  expect(f.table.receive(f.rx.id,16,2).data.length).toBe(0);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(1);
  expect(f.table.receive(f.rx.id,16).data.length).toBe(0);
  expect(f.table.bytesAvailable(f.rx.id)).toBe(0);expect(f.table.readable(f.rx.id)).toBe(false);
 });
}

test("UDP physical aliases retain FIFO across close and NT5-source SD_RECEIVE, then final reset revokes it",()=>{
 const f=fixture(2),kernel=new WsaActorKernel(f.table);
 const owner:WsaActorIdentity={pid:45101,slot:0,epoch:1},child:WsaActorIdentity={pid:45102,slot:1,epoch:2};
 kernel.register(owner);kernel.register(child);
 const call=(who:WsaActorIdentity,command:string,args:unknown[]=[])=>kernel.execute(who,command,args);
 const source=call(owner,"socket",[2,2,17]) as number;call(owner,"bind",[source,f.address()]);
 const destination=copy((call(owner,"get",[source]) as {local:WsaAddress}).local);
 const generation=f.network.bindingGeneration(destination.port,f.proto);
 const alias=call(owner,"duplicate",[source,child.pid]) as number;call(child,"import",[alias]);
 f.error(destination,f.a.address);f.table.send(f.live.id,Uint8Array.of(7,8,9),destination);f.error(destination,f.b.address);
 resetFrom(()=>call(child,"receive",[alias,16,2]),f.a.address);
 resetFrom(()=>call(owner,"receive",[source,16]),f.a.address);
 call(owner,"closesocket",[source]);
 expect((call(child,"receive",[alias,16,2]) as {data:Uint8Array}).data).toEqual(Uint8Array.of(7,8,9));
 expect(call(child,"bytesAvailable",[alias])).toBe(3);
 // NT5 disconn.c says just remember UDP shutdown: later recv fails, queued data is not purged.
 call(child,"shutdown",[alias,0]);
 expect(call(child,"bytesAvailable",[alias])).toBe(3);expect(call(child,"readable",[alias])).toBe(true);
 failed(()=>call(child,"receive",[alias,16]),WSA.ESHUTDOWN);
 const errorOnly=f.socket();f.error(errorOnly.address,f.a.address);f.table.shutdown(errorOnly.id,0);
 expect(f.table.bytesAvailable(errorOnly.id)).toBe(1);
 failed(()=>f.table.receive(errorOnly.id,16),WSA.ESHUTDOWN);
 call(child,"reset");expect(call(child,"isValid",[alias])).toBe(false);
 const replacement=f.socket(destination.port);
 f.error(replacement.address,f.b.address,generation);
 expect(f.table.bytesAvailable(replacement.id)).toBe(0);expect(f.table.readable(replacement.id)).toBe(false);
 failed(()=>f.table.receive(replacement.id,16),WSA.EWOULDBLOCK);
 f.table.reset();
 const afterReset=f.socket(destination.port);
 expect(f.table.readable(afterReset.id)).toBe(false);expect(f.table.bytesAvailable(afterReset.id)).toBe(0);
});

test("UDP queue public guards, reset toggle, SO_ERROR, send and FD_READ do not consume or rename the head",()=>{
 const f=fixture(23),payload=Uint8Array.of(0x71,0x72,0x73);
 f.table.configureEvents(f.rx.id,FD_READ);
 f.error(f.rx.address,f.a.address);f.table.send(f.live.id,payload,f.rx.address);
 expect(f.table.enumEvents(f.rx.id)).toEqual({mask:FD_READ,errors:Array(10).fill(0)});
 f.memory.put(input,0);f.memory.put(option,0xabcdef01);
 expect(f.call("WSAIoctl",[f.rx.id,0x9800000c,input,4,0,0,option,0,0])).toBe(0);
 f.error(f.rx.address,f.b.address); // OFF suppresses future B, never already retained A.
 f.memory.put(option+4,4);
 expect(f.call("getsockopt",[f.rx.id,0xffff,0x1007,option,option+4])).toBe(0);
 expect(f.memory.get(option)).toBe(0);
 const to=f.sockaddr(f.live.address);f.memory.ram.set(to,input);f.memory.ram[buffer]=0x7a;
 expect(f.call("sendto",[f.rx.id,buffer,1,0,input,to.length])).toBe(1);
 expect(f.table.receive(f.live.id,16).data).toEqual(Uint8Array.of(0x7a));
 const invalid=[
  f.receivePublic({capacity:27}),
  f.receivePublic({from:0}),
  f.receivePublic({data:f.memory.ram.length-8}),
 ];
 for(const result of invalid){
  expect({value:result.value,error:result.error,payload:result.payload})
   .toEqual({value:-1,error:WSA.EFAULT,payload:Array(16).fill(0xa5)});
 }
 resetFrom(()=>f.table.receive(f.rx.id,16,2),f.a.address);
 f.table.configureEvents(f.rx.id,FD_READ);
 expect(f.table.enumEvents(f.rx.id)).toEqual({mask:FD_READ,errors:Array(10).fill(0)});
 expect(f.table.bytesAvailable(f.rx.id)).toBe(3);
 resetFrom(()=>f.table.receive(f.rx.id,16),f.a.address);
 expect(f.table.receive(f.rx.id,16).data).toEqual(payload);
 failed(()=>f.table.receive(f.rx.id,16),WSA.EWOULDBLOCK); // suppressed B was never admitted
 f.memory.put(input,1);
 expect(f.call("WSAIoctl",[f.rx.id,0x9800000c,input,4,0,0,option,0,0])).toBe(0);
 f.error(f.rx.address,f.b.address);
 resetFrom(()=>f.table.receive(f.rx.id,16),f.b.address);
 expect(f.table.readable(f.rx.id)).toBe(false);
});

test("UDP real actor pending reads complete once in admission order; cancelled read cannot eat later data",async()=>{
 const f=await actorFixture(),stopObservers:Array<()=>void>=[];
 try{
  const p=await f.peers(2),desc=0x35000,flags=0x35100,target=0x36000,counts=0x37000;
  expect(f.value(f.ioctl(p.client,1))).toBe(0);
  const firstEvent=f.event(),firstHandle=f.get(ov+16),secondEvent=f.event(),secondHandle=f.get(ov+16);
  f.put(ov+16,firstHandle);f.put(ov+32+16,secondHandle);
  for(let i=0;i<2;i++){
   f.ram.fill(0xa5,target+i*32,target+i*32+16);
   f.put(desc+i*8,16);f.put(desc+i*8+4,target+i*32);f.put(flags+i*4,0);
   expect(f.value(f.api.WSARecv({} as never,f.ram,[p.client,desc+i*8,1,0,flags+i*4,ov+i*32,0]))).toBe(-1);
   expect(f.error()).toBe(997);
  }
  const provider=getWsaOverlapped(f.table,f.owner),completed=[0,0];
  for(let i=0;i<2;i++){
   const stop=provider.observeCompletion(p.client,ov+i*32,()=>{completed[i]++;});
   if(!stop)throw Error("Issued receive must have an observable completion");
   stopObservers.push(stop);
  }
  const data=Uint8Array.of(0x81,0x82,0x83);
  f.table.send(p.client,Uint8Array.of(0x45),p.deadAddress);
  f.table.send(p.live,data,p.self);await f.host.barrier();
  async function result(offset:number){
   const answer=await f.api.WSAGetOverlappedResult({} as never,f.ram,[p.client,offset,counts,1,counts+4]);
   if(typeof answer!=="number"&&answer.deferredWrites)f.apply(answer as ThunkResult);
   return{value:f.value(answer),error:f.error(),bytes:f.get(counts)};
  }
  const first=await result(ov),second=await result(ov+32);
  expect({value:first.value,error:first.error}).toEqual({value:0,error:WSA.ECONNRESET});
  expect(second).toEqual({value:1,error:0,bytes:data.length});
  expect(wsaStatusError(f.get(ov))).toBe(WSA.ECONNRESET);expect(f.get(ov+4)).toBe(0);
  expect(Array.from(f.ram.slice(target,target+16))).toEqual(Array(16).fill(0xa5));
  expect(Array.from(f.ram.slice(target+32,target+48))).toEqual([...data,...Array(13).fill(0xa5)]);
  expect(firstEvent.signaled&&secondEvent.signaled).toBe(true);expect(completed).toEqual([1,1]);
  expect(f.table.readable(p.client)).toBe(false);
  const cancelledOv=ov+64,cancelledEvent=f.event();f.put(cancelledOv+16,f.get(ov+16));
  f.put(desc+16,16);f.put(desc+20,target+64);f.put(flags+8,0);f.ram.fill(0xa5,target+64,target+80);
  expect(f.value(f.api.WSARecv({} as never,f.ram,[p.client,desc+16,1,0,flags+8,cancelledOv,0]))).toBe(-1);
  expect(provider.cancel(p.client,cancelledOv)).toBe(1);
  await f.tick();const cancelled=await result(cancelledOv);
  expect({value:cancelled.value,error:cancelled.error}).toEqual({value:0,error:995});
  f.table.send(p.live,Uint8Array.of(0x91),p.self);await f.host.barrier();
  expect(f.table.receive(p.client,16).data).toEqual(Uint8Array.of(0x91));
  expect(Array.from(f.ram.slice(target+64,target+80))).toEqual(Array(16).fill(0xa5));
  expect(cancelledEvent.signaled).toBe(true);expect(f.table.readable(p.client)).toBe(false);
  expect(completed).toEqual([1,1]);
 }finally{for(const stop of stopObservers)stop();await f.disposeActor();}
},30000);
