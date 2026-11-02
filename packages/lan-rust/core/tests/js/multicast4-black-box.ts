/** Same finite Socket.IO multicast contract for caller-owned TS and Rust servers. */
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {io,type Socket} from "socket.io-client";
type Transport="websocket"|"polling";
const node=(id:number)=>Uint8Array.of(2,0,0,4,5,id);
const G=[239,255,42,17],H=[239,255,42,18];
function frame(group:number[],payload:Uint8Array,iface=2,ttl=1):Uint8Array{
 const bytes=new Uint8Array(20+payload.length),v=new DataView(bytes.buffer);
 bytes.set([3,1,2,3,...group]);v.setUint16(8,4000);v.setUint16(10,5000);
 bytes.set(group,12);bytes[16]=iface;bytes[17]=ttl;bytes.set(payload,20);return bytes;
}
function unicast():Uint8Array{
 const bytes=new Uint8Array(13),v=new DataView(bytes.buffer);bytes.set([2,1,...node(2)]);
 v.setUint16(8,4000);v.setUint16(10,5000);bytes[12]=222;return bytes;
}
export async function runMulticast4BlackBox(url:string,transport:Transport){
 const room="mc-"+randomUUID(),sockets:Socket[]=[],clientIds=new Map<number,string>(),reached:string[]=[];
 const event=(socket:Socket,name:string,predicate:(args:any[])=>boolean=()=>true)=>new Promise<any[]>((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);socket.off(name,receive)};
  const receive=(...args:any[])=>{try{if(predicate(args)){cleanup();resolve(args)}}catch(error){cleanup();reject(error)}};
  const timer=setTimeout(()=>{cleanup();reject(Error("Deadline: "+name))},3000);socket.on(name,receive);
 });
 const make=(id:number,selectedRoom=room)=>{
  const clientId=clientIds.get(id)??randomUUID();clientIds.set(id,clientId);
  const socket=io(url,{autoConnect:false,forceNew:true,reconnection:false,upgrade:false,timeout:2500,transports:[transport],
   auth:{version:1,room:selectedRoom,clientId,node:[...node(id)]}});
  sockets.push(socket);return socket;
 };
 const connect=async(socket:Socket)=>{const ready=event(socket,"ready");socket.connect();const [info]=await ready;
  assert.equal(info.udpMulticast4V1,true);assert.equal(socket.io.engine.transport.name,transport);return info};
 const sync=async(socket:Socket)=>{const got=event(socket,"resolved",args=>args[0]===1);
  socket.emit("resolve",1,{host:"not-configured.invalid",family:4});await got};
 let a:Socket|undefined,b:Socket|undefined;
 try{
  a=make(1);b=make(2);const outside=make(3,room+"-other");
  await connect(a);await connect(b);await connect(outside);reached.push("ready-capability");
  const seen:{bytes:Uint8Array;arity:number}[]=[];let reflected=0,leaked=0;
  const collect=(socket:Socket)=>socket.on("frame",(...args:any[])=>seen.push({bytes:new Uint8Array(args[0]),arity:args.length}));
  collect(b);a.on("frame",()=>reflected++);outside.on("frame",()=>leaked++);
  const barrier=async()=>{const done=event(b!,"frame",args=>new Uint8Array(args[0])[0]===2);a!.emit("frame",unicast());await done};
  for(const [index,length]of [0,1,65507].entries()){
   const payload=Uint8Array.from({length},(_,n)=>(n*17+index)&255);
   a.emit("frame",frame(index===1?H:G,payload),7);
  }
  a.emit("frame",frame(G,Uint8Array.of(90),1,1),7);
  a.emit("frame",frame(G,Uint8Array.of(91),2,0),7);
  await barrier();await sync(a);await sync(outside);
  let packets=seen.filter(row=>row.bytes[0]===3);assert.equal(packets.length,3);assert.equal(reflected,0);assert.equal(leaked,0);
  for(let i=0;i<packets.length;i++){
   const {bytes,arity}=packets[i];assert.equal(arity,1);assert.deepEqual(bytes.subarray(2,8),node(1));
   assert.deepEqual([...bytes.subarray(12,16)],i===1?H:G);assert.deepEqual([...bytes.subarray(16,20)],[2,1,0,0]);
   const expected=Uint8Array.from({length:[0,1,65507][i]},(_,n)=>(n*17+i)&255);assert.deepEqual(bytes.subarray(20),expected);
  }
  reached.push("empty/max65507/exactgroups/auth-source/room-isolation/no-reflection/local-only");
  a.emit("releasePort",1,5000,7);a.emit("frame",frame(G,Uint8Array.of(92)),7);a.emit("frame",frame(G,Uint8Array.of(93)));
  a.emit("frame",frame(H,Uint8Array.of(55)),8);a.emit("releasePort",1,5000,7);a.emit("frame",frame(G,Uint8Array.of(56)),8);
  await barrier();packets=seen.filter(row=>row.bytes[0]===3);assert.deepEqual(packets.slice(3).map(row=>row.bytes[20]),[55,56]);
  reached.push("generation-tombstone/newbind/stale-release");
  const left=event(a,"peerLeft",args=>JSON.stringify(args[0].node)===JSON.stringify([...node(2)]));
  b.disconnect();await left;a.emit("frame",frame(G,Uint8Array.of(94)),8);
  // This marker on the sender connection is a causal server-processing fence.
  await sync(a);b=make(2);await connect(b);collect(b);
  a.emit("frame",frame(G,Uint8Array.of(57)),8);await barrier();
  packets=seen.filter(row=>row.bytes[0]===3);assert.deepEqual(packets.slice(3).map(row=>row.bytes[20]),[55,56,57]);
  reached.push("offline-peer-no-replay/reconnect");
  const malformed=[
   (bytes:Uint8Array)=>{bytes.set(node(9),2);return bytes},
   (bytes:Uint8Array)=>{bytes.fill(255,2,8);return bytes},
   (bytes:Uint8Array)=>{bytes.set([2,1,127,0,0,1],2);return bytes},
   (bytes:Uint8Array)=>{bytes[7]^=1;return bytes},
   (bytes:Uint8Array)=>{bytes[18]=1;return bytes},
   (bytes:Uint8Array)=>{bytes[1]=4;return bytes},
  ];
  for(let i=0;i<malformed.length;i++){
   const invalid=make(i+10);await connect(invalid);const closed=event(invalid,"disconnect");
   invalid.emit("frame",malformed[i](frame(G,Uint8Array.of(99))),1);await closed;assert.equal(invalid.connected,false);
  }
  const invalid=make(30);await connect(invalid);const closed=event(invalid,"disconnect");
  invalid.emit("frame",frame(G,Uint8Array.of(99)),null);await closed;
  reached.push("malformed/direction/source-forgery/explicit-null-rejected");
  await barrier();assert.equal(seen.filter(row=>row.bytes[0]===3).length,6);assert(a.connected&&b.connected);
  return{transport,reached,packets:packets.map(row=>({group:[...row.bytes.subarray(12,16)],length:row.bytes.length-20,
   payloadSha256:createHash("sha256").update(row.bytes.subarray(20)).digest("hex"),arity:row.arity}))};
 }finally{for(const socket of sockets){socket.removeAllListeners();socket.disconnect()}}
}
