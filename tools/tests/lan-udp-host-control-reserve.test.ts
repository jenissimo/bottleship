import {expect,test} from "bun:test";
import {createSocket,type Socket as UdpSocket} from "node:dgram";
import {createLanServer} from "../../packages/lan/src/server";
import {encodeTcpFrame,DATA} from "../../packages/lan/src/tcp-protocol";
import {PROTO_UDP,PROTO_TCP} from "../../packages/lan/src/protocol";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,label:string){
 const deadline=Date.now()+5000;
 while(!await check()){if(Date.now()>=deadline)throw Error("Deadline: "+label);await pause(2);}
}
async function available(port:number){
 const socket=createSocket("udp4");
 return new Promise<boolean>(resolve=>{
  socket.once("error",()=>{socket.close();resolve(false);});
  // Wildcard bind also conflicts with a connected native socket on Windows.
  socket.bind(port,"0.0.0.0",()=>socket.close(()=>resolve(true)));
 });
}
for(const transport of ["websocket","polling"]as const)test("Host and peer cleanup retain separate slots behind a shared TCP queue, "+transport,async()=>{
 const peer=createSocket("udp4");let sourcePort=0,received=0,host:UdpSocket|undefined,hostPort=0;
 peer.on("message",(bytes,remote)=>{sourcePort=remote.port;peer.send(bytes,remote.port,remote.address);});
 await new Promise<void>((resolve,reject)=>{peer.once("error",reject);peer.bind(0,"127.0.0.1",resolve);});
 const allowedNodes=[[2,1,127,0,0,1]];
 const server=createLanServer({port:0,gateway:{routes:[{host:"127.0.0.1",address:"203.0.113.218",ports:[peer.address().port],protocols:["udp"]}]}});
 server.io.use((socket,next)=>{
  socket.onAnyOutgoing((event,...args)=>{if(event==="ready")args[0].udpHostListenV1={listeners:[{id:"game",allowedNodes}]};});next();
 });
 server.io.on("connection",socket=>{
  socket.on("openUdpHost",(requestId)=>{
   host=createSocket("udp4");host.bind(0,"0.0.0.0",()=>{
    hostPort=host!.address().port;
    socket.emit("udpHostOpened",requestId,{leaseId:1,address:{node:[2,1,127,0,0,1],port:hostPort},allowedNodes});
   });
  });
  const close=()=>{const owned=host;host=undefined;if(owned)owned.close();};
  socket.on("releaseUdpHost",close);socket.on("cancelUdpHost",close);socket.on("disconnect",close);
 });
 const port=await server.listen(),network=new LanNetwork(),link=new RelayLink("http://127.0.0.1:"+port,"mixed-cleanup",network,{transports:[transport]});
 network.attach(link);
 const ordinary={deliver(){received++;}},hosting={deliver(){}},tcp={deliver(){}};
 let peerLease:{release():void}|undefined,hostLease:{release():void}|undefined,blocked:{writable:boolean}|undefined;
 try{
  await link.ready;
  expect(network.bind(49318,ordinary,PROTO_UDP)).toBe(true);
  expect(network.bind(49317,hosting,PROTO_UDP)).toBe(true);
  expect(network.bind(49319,tcp,PROTO_TCP)).toBe(true);
  const destination=Uint8Array.of(2,1,203,0,113,218);
  await until(()=>network.send(49318,destination,peer.address().port,Uint8Array.of(7),PROTO_UDP),"ordinary native warmup");
  await until(()=>sourcePort>0&&received===1,"ordinary native socket ready");
  peerLease=await network.leaseUdpPeer(49318,destination,peer.address().port);
  hostLease=await network.openUdpHost(49317,"game");
  expect(await available(sourcePort)).toBe(false);expect(await available(hostPort)).toBe(false);
  const engine=link.socket.io.engine;
  await until(()=>engine.writeBuffer.length===0,"control drain");
  blocked=engine.transport;blocked.writable=false;
  const absent=Uint8Array.of(2,0,0,99,1,1);
  let accepted=0;
  while(network.send(49319,absent,49320,encodeTcpFrame(DATA,1,2,0,Uint8Array.of(1)),PROTO_TCP)){
   if(++accepted>256)throw Error("Reliable queue is not bounded");
  }
  expect(accepted).toBe(254);expect(link.connected).toBe(true);
  peerLease.release();hostLease.release();
  expect(link.connected).toBe(true);
  blocked.writable=true;engine.emit("drain");
  await until(()=>available(hostPort),"Host physical release");
  expect(link.connected).toBe(true);
  // Sending created an ordinary flow that outlives its optional peer pin.
  network.unbind(49318,ordinary,PROTO_UDP);
  await until(()=>available(sourcePort),"ordinary binding physical release");
 }finally{
  if(blocked)blocked.writable=true;
  hostLease?.release();peerLease?.release();network.reset();network.attach(null);link.close();
  if(host){const owned=host;host=undefined;await new Promise<void>(resolve=>owned.close(()=>resolve()));}
  await server.close();await new Promise<void>(resolve=>peer.close(()=>resolve()));
 }
},15000);
