/** Reusable real Socket.IO v1 cases. The caller owns/listens/closes the TS or Rust server. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {io, type Socket} from "socket.io-client";
import {encodeDatagram,decodeDatagram} from "../../../../lan/src/protocol";
type Options={url:string;transport:"websocket"|"polling";timeoutMs?:number};
export async function runLanBlackBox({url,transport,timeoutMs=4000}:Options){
 const sockets:Socket[]=[];const room="core-"+randomUUID();const reached:string[]=[];
 const make=(node:number,selectedRoom=room,clientId=randomUUID())=>{
  const socket=io(url,{path:"/socket.io",transports:[transport],upgrade:false,reconnection:false,autoConnect:false,
   auth:{version:1,room:selectedRoom,clientId,node:[2,0,0,0,0,node]}});
  sockets.push(socket);return socket;
 };
 const event=(socket:Socket,name:string)=>new Promise<any[]>((resolve,reject)=>{
  const done=(...args:any[])=>{clearTimeout(timer);socket.off(name,done);resolve(args)};
  const timer=setTimeout(()=>{socket.off(name,done);reject(Error("Timed out: "+name))},timeoutMs);socket.on(name,done);
 });
 const connect=async(socket:Socket)=>{const ready=event(socket,"ready");socket.connect();const [info]=await ready;assert.equal(info.version,1);return info};
 const frame=(to:number,payload:Uint8Array)=>encodeDatagram(1,Uint8Array.of(2,0,0,0,0,to),9000,2000,payload);
 try{
  const a=make(1),b=make(2),outside=make(2,room+"-other");
  await connect(a);await connect(b);await connect(outside);
  let outsideFrames=0;outside.on("frame",()=>outsideFrames++);
  const got=event(b,"frame");a.emit("frame",frame(2,Uint8Array.of(3,5,8)),7);
  const args=await got;assert.equal(args.length,1,"LAN peer generation must be omitted");
  const d=decodeDatagram(new Uint8Array(args[0]));assert(d);assert.deepEqual(Array.from(d.node),[2,0,0,0,0,1]);assert.deepEqual(Array.from(d.payload),[3,5,8]);
  assert.equal(outsideFrames,0);reached.push("room-isolation/source-rewrite/omitted-forward-generation");
  const maximum=event(b,"frame");a.emit("frame",frame(2,new Uint8Array(65507).fill(91)));
  const max=decodeDatagram(new Uint8Array((await maximum)[0]));assert(max);assert.equal(max.payload.length,65507);assert(max.payload.every(v=>v===91));reached.push("maximum-udp-binary");
  const denied=event(a,"udpPeerLeased");a.emit("leaseUdpPeer",1,{proto:1,localPort:2000,bindingGeneration:0,node:[2,1,127,0,0,1],remotePort:9000});
  const [id,reply]=await denied;assert.equal(id,1);assert.equal(reply.error.code,10022);assert(a.connected);reached.push("invalid-lease-replies-without-disconnect");
  const rejection=make(2);const rejected=event(rejection,"connect_error");rejection.connect();assert.match(String((await rejected)[0]),/address already in use/i);reached.push("foreign-client-cannot-steal-live-node");
  const left=event(a,"peerLeft");b.disconnect();assert.deepEqual((await left)[0].node,[2,0,0,0,0,2]);reached.push("peer-left");
  const invalid=make(3);await connect(invalid);const closed=event(invalid,"disconnect");invalid.emit("frame",frame(1,Uint8Array.of(1)),null);await closed;reached.push("explicit-null-generation-rejected");
  assert.equal(outsideFrames,0);
  return{transport,reached};
 }finally{for(const socket of sockets){socket.removeAllListeners();socket.disconnect();}}
}
