import assert from "node:assert/strict";
import {createSocket} from "node:dgram";
import {NativeBoundUdpDriver} from "../../packages/lan/src/native-bound-udp";
const executable=process.argv[2];
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){assert(Date.now()<end,"timeout");await new Promise(r=>setTimeout(r,2));}};
for(const family of [4,6] as const){
 const host=family===4?"127.0.0.1":"::1",peers=[createSocket(family===4?"udp4":"udp6"),createSocket(family===4?"udp4":"udp6")];
 for(const p of peers)await new Promise<void>((ok,no)=>{p.once("error",no);p.bind(0,host,ok);});
 const d=new NativeBoundUdpDriver(executable,family),received:number[][]=[],errors:any[]=[],source:number[]=[];let aClosed=false;
 d.on("message",b=>received.push([...b]));d.on("peerError",e=>errors.push(e));
 peers[1].on("message",(b,r)=>{source.push(r.port);peers[1].send(b,r.port,r.address);});
 const send=(id:number,b:Uint8Array)=>new Promise<void>((ok,no)=>d.send(id,1,b,e=>e?no(e):ok()));
 try{
  const local=await d.ready,aPort=peers[0].address().port;await d.registerPeer(1,1,host,aPort);await d.registerPeer(2,1,host,peers[1].address().port);
  await send(2,Uint8Array.of(1));await until(()=>received.length===1);
  await new Promise<void>(ok=>peers[0].close(()=>ok()));aClosed=true;
  await send(1,Uint8Array.of(2));await until(()=>errors.length===1);
  assert.equal(errors[0].code,10054);assert.equal(errors[0].endpoint.port,aPort);assert.equal(errors[0].nativeCode,111);
  await send(2,new Uint8Array());await until(()=>received.length===2);assert.deepEqual(received,[[1],[]]);assert.deepEqual(source,[local.port,local.port]);
  console.log(JSON.stringify({pass:"real-TypeScript-driver-Node-Linux-A-error-B-live",family,sourcePort:local.port,error:errors[0]}));
 }finally{await d.close("abort");await Promise.all(peers.filter((_,i)=>i!==0||!aClosed).map(p=>new Promise<void>(ok=>p.close(()=>ok()))));}
}
