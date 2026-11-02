/**
 * Dual-stack regressions through real actors and the public Winsock memory ABI.
 * Modern Windows references: options 52711f6a, UDP 54075256, TCP d027dae2.
 * Alias/process lifetime and typed mapped reset cases are engine mechanism
 * coverage; they do not assert a new native ICMP or Windows XP certificate.
 */
import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WSA} from "../../src/worker/modules/wsa-network";
import type {ThunkResult} from "../../src/worker/core/thunking/thunk-dispatcher";
import {createWsaApiFixture} from "./fixtures/wsa-api-context";

type Family=2|23;
type Endpoint={socket:number;family:Family;port:number;ip:number[];scope:number;flow:number;raw:number[]};
const v4=[127,0,0,1],v6=[...Array(15).fill(0),1],any6=Array(16).fill(0);
const mapped=(ip:number[])=>[...Array(10).fill(0),255,255,...ip];
const arg=0x20000,arglen=0x20100,opt=0x20200,optlen=0x20300;
const sendData=0x21000,recvData=0x22000,recvName=0x23000,recvLen=0x23100;
let nextPid=50100;
function sockaddr(family:Family,ip:number[],port:number):Uint8Array{
 const raw=new Uint8Array(family===2?16:28),d=new DataView(raw.buffer);
 d.setUint16(0,family,true);d.setUint16(2,port,false);raw.set(ip,family===2?4:8);return raw;
}
function decodeName(socket:number,raw:number[],length:number):Endpoint{
 const family=(raw[0]|raw[1]<<8) as Family;
 if((family!==2&&family!==23)||length!==(family===2?16:28))throw Error("Malformed actual sockaddr");
 const d=new DataView(Uint8Array.from(raw).buffer);
 return{socket,family,port:d.getUint16(2,false),ip:raw.slice(family===2?4:8,family===2?8:24),
  scope:family===23?d.getUint32(24,true):0,flow:family===23?d.getUint32(4,true):0,raw:raw.slice(0,length)};
}
async function createFixture(){
 const network=new LanNetwork(),pid=++nextPid,namespace=new RootNetworkNamespace(network,16,pid);
 let memory:ReturnType<typeof createWsaApiFixture>|undefined;
 const transcript:{calls:unknown[];observations:unknown[]}={calls:[],observations:[]};
 try{
  await namespace.barrier();
  const table=createWsaActorTable(network,()=>namespace.socketActorClient());
  memory=createWsaApiFixture(table,0x5a500001);const m=memory;
  function note(value:unknown){if(transcript.observations.length>=128)throw Error("Observation cap");transcript.observations.push(value);}
  function call(name:string,args:number[]):number{
   if(transcript.calls.length>=256)throw Error("API transcript cap");
   const result=m.api[name]({} as never,m.ram,args);
   if(result instanceof Promise)throw Error("Unexpected blocking ABI: "+name);
   if(typeof result!=="number"&&result.deferredWrites)m.apply(result as ThunkResult);
   const value=typeof result==="number"?result:result.value;
   transcript.calls.push({name,args:[...args],value,error:m.error()});return value;
  }
  function need(name:string,args:number[],wanted:number):number{
   const actual=call(name,args);if(actual!==wanted)throw Error(name+" prerequisite="+actual+", error="+m.error());return actual;
  }
  function readOption(socket:number,requestedType:1|2=2){
   m.ram.fill(0xb6,opt,opt+8);m.put(optlen,4);m.seed(0x5a500003);
   const get=call("getsockopt",[socket,41,27,opt,optlen]);
   const observation={socket,get,getError:m.error(),length:m.get(optlen),raw:Array.from(m.ram.slice(opt,opt+8))};
   note({optionQuery:observation});
   const expectedLength=requestedType===1?4:1; // native52711: TCP DWORD, UDP BOOLEAN
   if(get!==0||observation.getError!==0||observation.length!==expectedLength)throw Error("Measured V6ONLY query ABI: "+JSON.stringify(observation));
   if(observation.raw.slice(expectedLength).some(x=>x!==0xb6))throw Error("Option query overwrote caller tail");
   const actualWord=observation.raw.slice(0,expectedLength).reduce((n,x,i)=>n+x*2**(8*i),0);
   if(actualWord!==0&&actualWord!==1)throw Error("Measured bool normalization missing");
   return{...observation,nonzero:actualWord!==0};
  }
  function option(socket:number,on:0|1,requestedType:1|2=2){
   m.put(opt,on);m.seed(0x5a500002);
   const set=call("setsockopt",[socket,41,27,opt,4]),setError=m.error();
   const observed=readOption(socket,requestedType);
   note({optionSet:{socket,on,set,setError}});
   // Width/LE here come from actual52711; no unmeasured pointer precedence is guessed.
   if(set!==0||setError!==0||observed.nonzero!==!!on)throw Error("Explicit V6ONLY mode prerequisite: "+JSON.stringify({set,setError,on,observed}));
   return{...observed,on,set,setError};
  }
  function socket(family:Family,type:1|2,on?:0|1){
   const id=call("WSASocketA",[family,type,type===1?6:17,0,0,1]);
   if(id===-1||id===0xffffffff)throw Error("Socket acquisition failed");
   if(family===23){if(on===undefined)throw Error("Draft must not assume V6ONLY default");option(id,on,type);}
   m.put(opt,1);need("ioctlsocket",[id,0x8004667e,opt],0);return id;
  }
  function query(socket:number,peer=false):Endpoint{
   m.ram.fill(0xa5,recvName,recvName+32);m.put(recvLen,32);
   need(peer?"getpeername":"getsockname",[socket,recvName,recvLen],0);
   const value=decodeName(socket,Array.from(m.ram.slice(recvName,recvName+32)),m.get(recvLen));note({query:peer?"peer":"local",value});return value;
  }
  function attemptBind(socket:number,family:Family,ip:number[],port=0){
   const raw=sockaddr(family,ip,port);m.ram.set(raw,arg);
   const value=call("bind",[socket,arg,raw.length]);return{value,error:m.error()};
  }
  function bind(socket:number,family:Family,ip:number[],port=0):Endpoint{
   const r=attemptBind(socket,family,ip,port);if(r.value!==0)throw Error("bind prerequisite: "+JSON.stringify(r));
   const q=query(socket);if(q.family!==family||q.port<1||q.ip.some((x,i)=>x!==ip[i]))throw Error("Actual bind/query mismatch");return q;
  }
  function sendto(socket:number,family:Family,ip:number[],port:number,payload:number[]){
   const raw=sockaddr(family,ip,port);m.ram.set(raw,arg);m.ram.set(payload,sendData);
   return call("sendto",[socket,sendData,payload.length,0,arg,raw.length]);
  }
  function receive(socket:number,flags=0){
   m.ram.fill(0xa5,recvData,recvData+32);m.ram.fill(0xa5,recvName,recvName+32);m.put(recvLen,32);m.seed(0x5a500004);
   const value=call("recvfrom",[socket,recvData,32,flags,recvName,recvLen]);
   const r={value,error:m.error(),length:m.get(recvLen),name:Array.from(m.ram.slice(recvName,recvName+32)),data:Array.from(m.ram.slice(recvData,recvData+32))};
   note({receive:r});return r;
  }
  async function until(predicate:()=>boolean,label:string){
   const deadline=Date.now()+3000;
   while(!predicate()){
    if(Date.now()>deadline)throw Error("Bounded actor readiness: "+label);
    await namespace.barrier();await new Promise<void>(resolve=>setTimeout(resolve,1));
   }
  }
  async function ready(socket:number){await namespace.barrier();await until(()=>table.readable(socket),"readable "+socket);}
  function connectAttempt(socket:number,family:Family,ip:number[],port:number){
   const raw=sockaddr(family,ip,port);m.ram.set(raw,arg);
   return{value:call("connect",[socket,arg,raw.length]),error:m.error()};
  }
  async function connect(socket:number,family:Family,ip:number[],port:number){
   const initial=connectAttempt(socket,family,ip,port);note({connect:initial});
   if(initial.value!==0&&!(initial.value===-1&&initial.error===WSA.EWOULDBLOCK))throw Error("Connect prerequisite: "+JSON.stringify(initial));
   await until(()=>table.isConnected(socket)||table.exceptional(socket),"connect completion");
   if(!table.isConnected(socket))throw Error("Actual connect failure="+table.get(socket).error);
  }
  async function accept(listener:number){
   await ready(listener);m.ram.fill(0xa5,recvName,recvName+32);m.put(recvLen,32);
   const id=call("accept",[listener,recvName,recvLen]);if(id===-1||id===0xffffffff)throw Error("Actual accept failed");
   const peer=decodeName(id,Array.from(m.ram.slice(recvName,recvName+32)),m.get(recvLen));note({acceptedPeer:peer});return{id,peer};
  }
  async function exchange(sender:number,receiver:number,payload:number[]){
   m.ram.set(payload,sendData);need("send",[sender,sendData,payload.length,0],payload.length);
   const actual:number[]=[];
   while(actual.length<payload.length){
    await ready(receiver);m.ram.fill(0xa5,recvData,recvData+32);
    const n=call("recv",[receiver,recvData,Math.min(32,payload.length-actual.length),0]);
    if(n<=0)throw Error("Actual stream ended before complete payload");actual.push(...m.ram.slice(recvData,recvData+n));
   }
   note({stream:{payload,actual}});return actual;
  }
  function close(socket:number){need("closesocket",[socket],0);}
  return{network,pid,namespace,table,m,transcript,note,call,need,option,readOption,socket,query,bind,attemptBind,sendto,receive,ready,until,connect,connectAttempt,accept,exchange,close,
   async dispose(){try{m.dispose();}finally{await namespace.close();}}};
 }catch(error){try{memory?.dispose();}finally{await namespace.close();}throw error;}
}
type F=Awaited<ReturnType<typeof createFixture>>;
function from(actual:ReturnType<F["receive"]>,sender:Endpoint,presentation:Family){
 expect(actual.length).toBe(presentation===2?16:28);
 const q=decodeName(-1,actual.name,actual.length);
 expect(q.family).toBe(presentation);expect(q.port).toBe(sender.port);
 expect(q.ip).toEqual(presentation===23&&sender.family===2?mapped(sender.ip):sender.ip);
 expect(actual.name.slice(actual.length)).toEqual(Array(32-actual.length).fill(0xa5));
}
function data(actual:ReturnType<F["receive"]>,sender:Endpoint,payload:number[],presentation:Family){
 expect(actual.value).toBe(payload.length);expect(actual.data).toEqual([...payload,...Array(32-payload.length).fill(0xa5)]);from(actual,sender,presentation);
}
async function run(name:string,body:(f:F)=>Promise<void>){
 const f=await createFixture();let first:unknown;
 try{await body(f);}catch(error){first=error;console.error(JSON.stringify({kind:"SOURCE_MECHANISM_NOT_NATIVE",name,transcript:f.transcript,error:String(error)}));}
 finally{try{await f.dispose();}catch(error){if(first===undefined)first=error;}}
 if(first!==undefined)throw first;
}

test("dual UDP: actual AF4/AF6 arrivals share one AF23 FIFO, mapped reply and closed-tuple error",async()=>run("udp",async f=>{
 const receiver=f.socket(23,2,0),r=f.bind(receiver,23,any6);
 const four=f.socket(2,2),a=f.bind(four,2,v4),six=f.socket(23,2,1),b=f.bind(six,23,v6);
 expect(f.sendto(four,2,v4,r.port,[0x41,0x42,0x43])).toBe(3);await f.namespace.barrier();
 expect(f.sendto(six,23,v6,r.port,[0x61,0x62,0x63,0x64,0x65])).toBe(5);await f.ready(receiver);
 const peek=f.receive(receiver,2),one=f.receive(receiver),two=f.receive(receiver);
 data(peek,a,[0x41,0x42,0x43],23);data(one,a,[0x41,0x42,0x43],23);data(two,b,[0x61,0x62,0x63,0x64,0x65],23);
 expect(f.sendto(receiver,23,mapped(a.ip),a.port,[0x71,0x72,0x73,0x74])).toBe(4);await f.ready(four);
 const reply=f.receive(four);expect(reply.value).toBe(4);expect(reply.data.slice(0,4)).toEqual([0x71,0x72,0x73,0x74]);
 const replySource=decodeName(-1,reply.name,reply.length);
 expect(replySource.family).toBe(2);expect(replySource.port).toBe(r.port);
 // Wildcard route-selected source IP is retained, not inferred from receiver getsockname.
 f.note({actualWildcardReplySource:replySource});
 const dead=f.socket(2,2),closed=f.bind(dead,2,v4);f.close(dead);await f.namespace.barrier();
 f.m.put(opt,1);f.need("WSAIoctl",[receiver,0x9800000c,opt,4,0,0,optlen,0,0],0);
 expect(f.sendto(receiver,23,mapped(closed.ip),closed.port,[0x51])).toBe(1);await f.ready(receiver);
 const admitted=f.receive(receiver,2); // actual receive-error ACK, never a time-based guess
 expect(admitted.value).toBe(-1);expect(admitted.error).toBe(WSA.ECONNRESET);from(admitted,closed,23);
 expect(f.sendto(four,2,v4,r.port,[0x44,0x45,0x46])).toBe(3);await f.namespace.barrier();
 const errorPeek=f.receive(receiver,2),errorPlain=f.receive(receiver),later=f.receive(receiver);
 for(const error of[errorPeek,errorPlain]){expect(error.value).toBe(-1);expect(error.error).toBe(WSA.ECONNRESET);from(error,closed,23);}
 data(later,a,[0x44,0x45,0x46],23);
 // This closed-tuple part is SOURCE/mechanism projection, not a new native mapped-ICMP certificate.
}),15000);

test("dual TCP: AF4 client to AF23 listener and AF23 mapped client to AF4 listener",async()=>run("tcp",async f=>{
 const listener=f.socket(23,1,0),l=f.bind(listener,23,any6);f.need("listen",[listener,4],0);
 const client=f.socket(2,1),c=f.bind(client,2,v4);await f.connect(client,2,v4,l.port);
 const accepted=await f.accept(listener);
 expect(accepted.peer.family).toBe(23);expect(accepted.peer.ip).toEqual(mapped(c.ip));expect(accepted.peer.port).toBe(c.port);
 const peer=f.query(accepted.id,true);expect(peer.raw).toEqual(accepted.peer.raw);
 expect(f.readOption(accepted.id,1).nonzero).toBe(false);
 const acceptedLocal=f.query(accepted.id);expect(acceptedLocal.ip).toEqual(mapped(v4));expect(acceptedLocal.port).toBe(l.port);
 f.close(listener);await f.namespace.barrier(); // accepted physical wire coverage must survive listener close
 expect(await f.exchange(client,accepted.id,[1,4,6,8])).toEqual([1,4,6,8]);
 expect(await f.exchange(accepted.id,client,[8,6,4,1])).toEqual([8,6,4,1]);
 const listener4=f.socket(2,1),l4=f.bind(listener4,2,v4);f.need("listen",[listener4,4],0);
 const client6=f.socket(23,1,0);await f.connect(client6,23,mapped(l4.ip),l4.port);
 const accepted4=await f.accept(listener4),local6=f.query(client6),peer6=f.query(client6,true);
 expect(local6.family).toBe(23);expect(local6.ip.slice(0,12)).toEqual(mapped([0,0,0,0]).slice(0,12));
 expect(peer6.family).toBe(23);expect(peer6.ip).toEqual(mapped(l4.ip));expect(peer6.port).toBe(l4.port);
 expect(accepted4.peer.family).toBe(2);expect(accepted4.peer.port).toBe(local6.port);expect(accepted4.peer.ip).toEqual(local6.ip.slice(12));
 expect(await f.exchange(client6,accepted4.id,[2,5,0,4])).toEqual([2,5,0,4]);
 expect(await f.exchange(accepted4.id,client6,[4,0,5,2])).toEqual([4,0,5,2]);
}),15000);

test("shared coverage: measured cross-family pair binds and physical alias retirement",async()=>run("ownership",async f=>{
 const original=f.socket(23,2,0),alias=f.table.duplicate(original,f.pid);
 expect(f.table.importDuplicate(alias)).toBe(alias);
 f.option(alias,1);expect(f.readOption(original).nonzero).toBe(true);
 f.option(original,0);expect(f.readOption(alias).nonzero).toBe(false);
 const local=f.bind(original,23,any6);f.close(original);
 expect(f.readOption(alias).nonzero).toBe(false); // getter only after bind; no assumed post-bind setter permission
 const tx=f.socket(2,2),source=f.bind(tx,2,v4);
 expect(f.sendto(tx,2,v4,local.port,[0x31,0x32,0x33])).toBe(3);await f.ready(alias);data(f.receive(alias),source,[0x31,0x32,0x33],23);
 f.close(alias);await f.namespace.barrier();
 // Actual54075256: wildcard AF2/AF23 both bind successfully in all eight arms.
 // Do not infer delivery priority or TCP listen coexistence from these bind-only observations.
 for(const type of[2,1] as const)for(const firstFamily of[2,23] as const)for(const on of[0,1] as const){
  const secondFamily:Family=firstFamily===2?23:2;
  const first=f.socket(firstFamily,type,firstFamily===23?on:undefined);
  const firstLocal=f.bind(first,firstFamily,firstFamily===2?[0,0,0,0]:any6);
  const second=f.socket(secondFamily,type,secondFamily===23?on:undefined);
  const secondLocal=f.bind(second,secondFamily,secondFamily===2?[0,0,0,0]:any6,firstLocal.port);
  expect(secondLocal.port).toBe(firstLocal.port);
  f.note({measuredPairBind:{type,firstFamily,on,firstLocal,secondLocal}});
  f.close(first);f.close(second);await f.namespace.barrier();
 }
 // SOURCE/mechanism lifetime control: the native bind-only batch did not measure
 // surviving-owner delivery. No packet is sent while both cross-family owners live.
 const fourOwner=f.socket(2,2);f.bind(fourOwner,2,[0,0,0,0],local.port);
 const survivor=f.socket(23,2,0);f.bind(survivor,23,any6,local.port);
 f.close(fourOwner);await f.namespace.barrier();
 expect(f.sendto(tx,2,v4,local.port,[0x34,0x35,0x36])).toBe(3);await f.ready(survivor);
 data(f.receive(survivor),source,[0x34,0x35,0x36],23);
 f.close(survivor);await f.namespace.barrier();
 const replacement=f.socket(23,2,0);f.bind(replacement,23,any6,local.port);
 expect(f.sendto(tx,2,v4,local.port,[0x37,0x38,0x39])).toBe(3);await f.ready(replacement);
 data(f.receive(replacement),source,[0x37,0x38,0x39],23);
}),15000);

test("true mode: native IPv6 live control and mapped traffic cannot enter an AF4 receiver",async()=>run("true",async f=>{
 const only=f.socket(23,2,1),o=f.bind(only,23,v6),live=f.socket(23,2,1),six=f.bind(live,23,v6);
 expect(f.sendto(live,23,v6,o.port,[0x6a])).toBe(1);await f.ready(only);data(f.receive(only),six,[0x6a],23);
 const four=f.socket(2,2),a=f.bind(four,2,v4);
 const rejected=f.sendto(only,23,mapped(a.ip),a.port,[0x4a]);f.note({mappedTrueActual:{rc:rejected,error:f.m.error(),local:f.query(only)}});
 expect(rejected).toBe(-1);await f.namespace.barrier();expect(f.table.readable(four)).toBe(false);
 // No exact error, default, implicit-bind side effect or post-bind toggle code is asserted.
}),15000);

function childProcess(host:RootNetworkNamespace,pid:number){
 const lease=host.createChild(pid),worker=new Worker(new URL("./fixtures/wsa-dualstack-child.ts",import.meta.url).href,{type:"module"});
 let sequence=0,closed=false;
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
 const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
 worker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);
  if(data.error!==undefined)task.reject(Error(data.error));else task.resolve(data.result);};
 worker.onerror=event=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error(String(event.message)));}pending.clear();};
 function request(value:object,ports:MessagePort[]=[]):Promise<any>{
  if(closed||pending.size)throw Error("Child request outside serial owned lifetime");
  return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error("Child RPC bounded deadline"));},3000);
   pending.set(id,{resolve,reject,timer});try{worker.postMessage({id,...value},ports);}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}});
 }
 const ready=request({boot:lease.boot},[lease.boot.port]);
 return{ready,call:(command:string,socket:number)=>request({command,socket}),async close(){
  if(!closed){closed=true;worker.terminate();lease.close();for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error("Own child retired"));}pending.clear();}
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([stopped,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("Own Worker retirement deadline")),2000);})]);}
  finally{if(timer)clearTimeout(timer);}
 }};
}
test("process epoch: duplicated dual socket survives creator process finish and new epoch cannot revive old alias",async()=>run("process",async f=>{
 const child=childProcess(f.namespace,++nextPid);
 try{
  const boot=await child.ready;expect(boot.ready).toBe(true);
  const source=f.socket(23,2,0),endpoint=f.bind(source,23,any6);
  const reserved=f.table.duplicate(source,boot.pid);
  // No import before the creator's actual process-lifetime release.
  await f.namespace.finishProcessLifetime();f.namespace.beginProcessLifetime();
  expect(f.table.isValid(source)).toBe(false);
  expect(await child.call("import",reserved)).toBe(reserved);
  const option=await child.call("option",reserved);
  expect(option.rc).toBe(0);expect(option.error).toBe(0);expect(option.length).toBe(1);
  expect(option.raw).toEqual([0,...Array(7).fill(0xb6)]);
  const tx=f.socket(2,2),actualSource=f.bind(tx,2,v4);
  expect(f.sendto(tx,2,v4,endpoint.port,[0x51,0x50,0x45])).toBe(3);await f.namespace.barrier();
  const deadline=Date.now()+3000;
  while(!await child.call("readable",reserved)){
   if(Date.now()>deadline)throw Error("Actual child alias readiness deadline");
   await f.namespace.barrier();
  }
  const received=await child.call("receive",reserved);
  data(received,actualSource,[0x51,0x50,0x45],23);
  await child.close();await f.namespace.barrier();
  const replacement=f.socket(23,2,0);f.bind(replacement,23,any6,endpoint.port);
  expect(f.table.isValid(source)).toBe(false);
 }finally{await child.close();}
}),15000);

test("measured modern option profile: AF2/AF23 UDP/TCP default1 and pre-bind physical0/1 queries",async()=>run("measured-options",async f=>{
 for(const family of[2,23] as const)for(const type of[1,2] as const){
  const socket=f.call("WSASocketA",[family,type,type===1?6:17,0,0,1]);
  if(socket===-1||socket===0xffffffff)throw Error("Measured option socket prerequisite");
  expect(f.readOption(socket,type).nonzero).toBe(true);
  f.option(socket,0,type);expect(f.readOption(socket,type).nonzero).toBe(false);
  f.option(socket,1,type);expect(f.readOption(socket,type).nonzero).toBe(true);
  f.close(socket);
 }
 // AF2 accepts the shadow option; routing enforcement must remain AF23-specific.
 // RAW default0 and the full 100 setter matrix belong to the separate native calibration.
}),15000);


// Independent coexistence references: UDP 0c54a95f and TCP 4b231d55.
// Both families bind successfully; actual IPv4 delivery selects the native AF4
// receiver/listener in both bind orders and both TCP listen orders.
for (const firstFamily of [2,23] as const) test("coexisting UDP owners: AF4 selection and original survivor, bind first "+firstFamily,async()=>run("udp-coexist",async f=>{
 const four=f.socket(2,2),six=f.socket(23,2,0),first=firstFamily===2?four:six,second=firstFamily===2?six:four;
 const bound=f.bind(first,firstFamily,firstFamily===2?[0,0,0,0]:any6);
 f.bind(second,firstFamily===2?23:2,firstFamily===2?any6:[0,0,0,0],bound.port);
 const sender=f.socket(2,2),source=f.bind(sender,2,v4),payload=[0x55,0x43,firstFamily,1,0xa5,0x50,0x7f,0];
 expect(f.sendto(sender,2,v4,bound.port,payload)).toBe(8);await f.ready(four);await f.namespace.barrier();
 expect(f.table.readable(six)).toBe(false);
 data(f.receive(four,2),source,payload,2);data(f.receive(four),source,payload,2);
 const absent=f.receive(six);expect(absent.value).toBe(-1);expect(absent.error).toBe(WSA.EWOULDBLOCK);
 expect(absent.data).toEqual(Array(32).fill(0xa5));expect(absent.name).toEqual(Array(32).fill(0xa5));
 f.close(first);await f.namespace.barrier();
 const later=[0x55,0x43,firstFamily,2,0xa5,0x50,0x7f,0];
 expect(f.sendto(sender,2,v4,bound.port,later)).toBe(8);await f.ready(second);
 data(f.receive(second,2),source,later,firstFamily===2?23:2);data(f.receive(second),source,later,firstFamily===2?23:2);
}),15000);

for (const firstFamily of [2,23] as const) for (const listenFirst of [2,23] as const)
 test("coexisting TCP listeners: AF4 selection, bind "+firstFamily+" listen "+listenFirst,async()=>run("tcp-coexist",async f=>{
 const four=f.socket(2,1),six=f.socket(23,1,0),first=firstFamily===2?four:six,second=firstFamily===2?six:four;
 const bound=f.bind(first,firstFamily,firstFamily===2?[0,0,0,0]:any6);
 f.bind(second,firstFamily===2?23:2,firstFamily===2?any6:[0,0,0,0],bound.port);
 f.need("listen",[listenFirst===2?four:six,4],0);f.need("listen",[listenFirst===2?six:four,4],0);
 const client=f.socket(2,1),local=f.bind(client,2,v4);await f.connect(client,2,v4,bound.port);await f.ready(four);
 expect(f.table.readable(six)).toBe(false);
 const accepted=await f.accept(four);expect(accepted.peer.family).toBe(2);expect(accepted.peer.ip).toEqual(v4);expect(accepted.peer.port).toBe(local.port);
 expect(await f.exchange(client,accepted.id,[1,2,3,4,5,6,7,8])).toEqual([1,2,3,4,5,6,7,8]);
 expect(await f.exchange(accepted.id,client,[8,7,6,5,4,3,2,1])).toEqual([8,7,6,5,4,3,2,1]);
}),15000);

test("IPv6-only TCP mapped connect completes with address error without an AF4 accepted connection",async()=>run("strict-tcp",async f=>{
 const listener=f.socket(2,1),l=f.bind(listener,2,v4);f.need("listen",[listener,4],0);
 const client=f.socket(23,1,1),before=f.bind(client,23,any6);
 const attempt=f.connectAttempt(client,23,mapped(v4),l.port);
 expect(attempt.value).toBe(-1);expect(attempt.error).toBe(WSA.EWOULDBLOCK);
 await f.until(()=>f.table.exceptional(client),"strict mapped connect completion");await f.namespace.barrier();
 expect(f.table.readable(listener)).toBe(false);expect(f.table.isConnected(client)).toBe(false);
 f.m.put(optlen,4);f.need("getsockopt",[client,0xffff,0x1007,opt,optlen],0);expect(f.m.get(opt)).toBe(WSA.EADDRNOTAVAIL);
 const after=f.query(client);expect(after.ip).toEqual(any6);expect(after.port).toBe(before.port);
 f.m.ram.fill(0xa5,recvName,recvName+32);f.m.put(recvLen,32);
 expect(f.call("getpeername",[client,recvName,recvLen])).toBe(-1);expect(f.m.error()).toBe(WSA.ENOTCONN);
 expect(Array.from(f.m.ram.slice(recvName,recvName+32))).toEqual(Array(32).fill(0xa5));
}),15000);

test("mapped UDP bind and connected peer retain family, source and exact peer address",async()=>run("mapped-udp",async f=>{
 const four=f.socket(2,2),a=f.bind(four,2,v4);
 const six=f.socket(23,2,0),b=f.bind(six,23,mapped(v4));
 const connected=f.connectAttempt(six,23,mapped(v4),a.port);expect(connected.value).toBe(0);
 expect(f.query(six).ip).toEqual(mapped(v4));expect(f.query(six,true).ip).toEqual(mapped(v4));
 f.m.ram.set([0x61,0x62,0x63],sendData);f.need("send",[six,sendData,3,0],3);await f.ready(four);
 data(f.receive(four),{...b,family:2,ip:v4},[0x61,0x62,0x63],2);
 f.close(four);await f.namespace.barrier();
 const other=f.socket(2,2);f.bind(other,2,[127,0,0,2],a.port);
 expect(f.sendto(other,2,v4,b.port,[0x71])).toBe(1);await f.namespace.barrier();
 expect(f.table.readable(six)).toBe(false);
 f.close(other);await f.namespace.barrier();
 const replacement=f.socket(2,2),source=f.bind(replacement,2,v4,a.port);
 expect(f.sendto(replacement,2,v4,b.port,[0x72])).toBe(1);await f.ready(six);
 data(f.receive(six),source,[0x72],23);
}),15000);

test("AF23 connect/sendto require an IPv6 sockaddr even for IPv4 destinations",async()=>run("sockaddr-family",async f=>{
 const peer=f.socket(2,2),p=f.bind(peer,2,v4),socket=f.socket(23,2,0);f.bind(socket,23,any6);
 const attempt=f.connectAttempt(socket,2,v4,p.port);expect(attempt.value).toBe(-1);expect(attempt.error).toBe(WSA.EFAULT);
 expect(f.sendto(socket,2,v4,p.port,[0x51])).toBe(-1);expect(f.m.error()).toBe(WSA.EFAULT);
 await f.namespace.barrier();expect(f.table.readable(peer)).toBe(false);
}),15000);

test("canonical UDP payload limits: mapped IPv4 has a terminal size error, native IPv6 retains its larger limit",async()=>run("wire-size",async f=>{
 // Engine wire admission regression, not a new native maximum-size observation.
 const four=f.socket(2,2),a=f.bind(four,2,v4),mappedSender=f.socket(23,2,0);f.bind(mappedSender,23,any6);
 const ipv4Maximum=Array(65507).fill(0x4d);
 expect(f.sendto(mappedSender,23,mapped(v4),a.port,ipv4Maximum)).toBe(65507);await f.ready(four);
 expect(f.table.bytesAvailable(four)).toBe(65507);
 expect(f.call("recv",[four,recvData,65507,0])).toBe(65507);
 expect(f.m.ram[recvData]).toBe(0x4d);expect(f.m.ram[recvData+65506]).toBe(0x4d);
 expect(f.sendto(mappedSender,23,mapped(v4),a.port,Array(65508).fill(0x4e))).toBe(-1);
 expect(f.m.error()).toBe(WSA.EMSGSIZE);
 const six=f.socket(23,2,1),b=f.bind(six,23,v6),nativeSender=f.socket(23,2,1);f.bind(nativeSender,23,v6);
 expect(f.sendto(nativeSender,23,v6,b.port,Array(65527).fill(0x6d))).toBe(65527);await f.ready(six);
 expect(f.table.bytesAvailable(six)).toBe(65527);
 expect(f.call("recv",[six,recvData,65527,0])).toBe(65527);
 expect(f.m.ram[recvData+65526]).toBe(0x6d);
}),15000);
