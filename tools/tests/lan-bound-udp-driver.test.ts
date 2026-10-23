import {expect,test} from "bun:test";
import {createSocket,type Socket} from "node:dgram";
import {NativeBoundUdpDriver} from "../../packages/lan/src/native-bound-udp";
import {buildBoundUdpHelper} from "../lan-conformance/build-bound-udp-helper";
const until=async(check:()=>boolean,label:string)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error("Timeout: "+label);await new Promise(r=>setTimeout(r,2));}};
const bind=async(family:4|6)=>{const s=createSocket(family===4?"udp4":"udp6");await new Promise<void>((ok,no)=>{s.once("error",no);s.bind(0,family===4?"127.0.0.1":"::1",ok);});return s;};
const close=async(s:Socket)=>{await new Promise<void>(ok=>s.close(()=>ok()));};
const send=(d:NativeBoundUdpDriver,id:number,epoch:number,bytes:Uint8Array)=>new Promise<void>((ok,no)=>{d.send(id,epoch,bytes,e=>e?no(e):ok());});
for(const family of [4,6] as const){
 test("bound UDP IPv"+family+" attributes A errors, keeps B and source port alive",async()=>{
  const executable=await buildBoundUdpHelper(),a=await bind(family),b=await bind(family),host=family===4?"127.0.0.1":"::1";
  let aClosed=false;const d=new NativeBoundUdpDriver(executable,family),errors:any[]=[],seen:Array<{bytes:number[];port:number}>=[],received:number[][]=[],fatal:Error[]=[];
  d.on("bindingError",e=>fatal.push(e));d.on("peerError",e=>errors.push(e));d.on("message",bytes=>received.push([...bytes]));
  b.on("message",(bytes,remote)=>{seen.push({bytes:[...bytes],port:remote.port});b.send(bytes,remote.port,remote.address);});
  try{
   const local=await d.ready;await d.registerPeer(1,1,host,a.address().port);await d.registerPeer(2,1,host,b.address().port);
   await send(d,2,1,Uint8Array.of(1));await until(()=>received.length===1,"warmup B");
   const aPort=a.address().port;await close(a);aClosed=true;
   await send(d,1,1,Uint8Array.of(2));await until(()=>errors.length>0,"actual A port-unreachable");
   expect(errors[0].peerId).toBe(1);expect(errors[0].endpoint.port).toBe(aPort);expect(errors[0].code).toBe(10054);
   await send(d,2,1,Uint8Array.of(3));await until(()=>received.length===2,"B survives A error");
   expect(received).toEqual([[1],[3]]);expect(seen.map(x=>x.port)).toEqual([local.port,local.port]);expect(fatal).toEqual([]);
   await d.close();
   const reused=createSocket(family===4?"udp4":"udp6");try{await new Promise<void>((ok,no)=>{reused.once("error",no);reused.bind(local.port,host,ok);});}finally{await close(reused);}
  }finally{await d.close("abort").catch(()=>{});await close(b);if(!aClosed)await close(a);}
 },15000);
 test("bound UDP IPv"+family+" empty RX consumes packet credit and ICMP drains at zero credit",async()=>{
  const a=await bind(family),b=await bind(family),d=new NativeBoundUdpDriver(await buildBoundUdpHelper(),family,{automaticReceiveCredit:false}),host=family===4?"127.0.0.1":"::1";
  let aClosed=false;const received:number[][]=[],errors:any[]=[];d.on("message",b=>received.push([...b]));d.on("peerError",e=>errors.push(e));
  try{
   const local=await d.ready;const aPort=a.address().port;await d.registerPeer(1,1,host,aPort);await d.registerPeer(2,1,host,b.address().port);
   await close(a);aClosed=true;await send(d,1,1,Uint8Array.of(1));await until(()=>errors.length===1,"ICMP without receive credit");expect(received).toEqual([]);
   const put=(bytes:Buffer)=>new Promise<void>((ok,no)=>b.send(bytes,local.port,host,e=>e?no(e):ok()));
   await put(Buffer.alloc(0));await put(Buffer.alloc(0));await put(Buffer.of(9));
   d.grantReceiveCredit(0,1);await until(()=>received.length===1,"first zero");expect(received).toEqual([[]]);
   d.grantReceiveCredit(0,1);await until(()=>received.length===2,"second zero");expect(received).toEqual([[],[]]);
   d.grantReceiveCredit(1,1);await until(()=>received.length===3,"nonempty credit");expect(received).toEqual([[],[],[9]]);
  }finally{await d.close("abort").catch(()=>{});await close(b);if(!aClosed)await close(a);}
 },15000);
 test("bound UDP IPv"+family+" tuple tombstones and epochs reject alias replacement",async()=>{
  const peer=await bind(family),d=new NativeBoundUdpDriver(await buildBoundUdpHelper(),family),host=family===4?"127.0.0.1":"::1";
  try{
   await d.ready;await d.registerPeer(1,1,host,peer.address().port);await d.retirePeer(1,1);
   const conflict=await d.registerPeer(2,1,host,peer.address().port).then(()=>null,e=>e);expect(conflict).toMatchObject({code:10048});
   await d.registerPeer(1,2,host,peer.address().port);await send(d,1,2,new Uint8Array());
   const stale=await send(d,1,1,new Uint8Array()).then(()=>null,e=>e);expect(stale).toMatchObject({code:10013});
  }finally{await d.close("abort").catch(()=>{});await close(peer);}
 },15000);
}
test("immediate abort before READY settles both lifecycle promises",async()=>{
 const d=new NativeBoundUdpDriver(await buildBoundUdpHelper(),4);const ready=d.ready.catch(e=>e);
 await d.close("abort");expect(d.pendingWrites).toBe(0);expect(d.closing).toBe(true);await ready;
},10000);

for(const family of [4,6] as const)test("healthy bound UDP has no global TTL after sixty controlled seconds, IPv"+family,async()=>{
 const peer=await bind(family),d=new NativeBoundUdpDriver(await buildBoundUdpHelper(["-DUDP_TEST_CLOCK"]),family),host=family===4?"127.0.0.1":"::1";
 const seen:Array<{data:Buffer;port:number}>=[];peer.on("message",(data,remote)=>seen.push({data,port:remote.port}));
 try{
  const local=await d.ready;await d.registerPeer(1,1,host,peer.address().port);
  const clock=Buffer.alloc(4);clock.writeUInt32LE(60000);
  // This command exists only in UDP_TEST_CLOCK builds, never the shipping binary.
  const reply=await (d as unknown as {request(op:number,expected:number,body:Buffer):Promise<Buffer>}).request(250,251,clock);
  expect(reply).toEqual(clock);await send(d,1,1,Uint8Array.of(60));
  await until(()=>seen.length===1,"same healthy binding after clock advance");
  expect(seen[0].data).toEqual(Buffer.of(60));expect(seen[0].port).toBe(local.port);
 }finally{await d.close("abort").catch(()=>{});await close(peer);}
},15000);
