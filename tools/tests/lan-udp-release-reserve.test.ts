import {expect,test} from "bun:test";
import {createSocket} from "node:dgram";
import {createLanServer} from "../../packages/lan/src/server";
import {encodeTcpFrame,DATA} from "../../packages/lan/src/tcp-protocol";
import {ipv4ToNode,PROTO_UDP,PROTO_TCP} from "../../packages/lan/src/protocol";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
import {buildBoundUdpHelper} from "../lan-conformance/build-bound-udp-helper";
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error("Timeout: "+label);await new Promise(r=>setTimeout(r,2));}};
async function free(port:number):Promise<boolean>{
 const socket=createSocket("udp4");return new Promise(ok=>{socket.once("error",()=>{socket.close();ok(false);});socket.bind(port,"0.0.0.0",()=>socket.close(()=>ok(true)));});
}
for(const helper of [false,true])for(const transport of ["websocket","polling"] as const)test("releasePort cannot disappear behind another UDP lease reservation, "+(helper?"helper":"node")+"/"+transport,async()=>{
 const peer=createSocket("udp4");let nativePort=0,received=0;
 peer.on("message",(bytes,remote)=>{nativePort=remote.port;peer.send(bytes,remote.port,remote.address);});
 await new Promise<void>((ok,no)=>{peer.once("error",no);peer.bind(0,"127.0.0.1",ok);});
 const server=createLanServer({port:0,gateway:{...(helper?{nativeUdpHelperPath:await buildBoundUdpHelper()}:{}),routes:[{host:"127.0.0.1",address:"203.0.113.218",ports:[peer.address().port],protocols:["udp"]}]}});
 const serverPort=await server.listen(),network=new LanNetwork(),link=new RelayLink("http://127.0.0.1:"+serverPort,"release-reserve",network,{transports:[transport]});
 network.attach(link);
 const udpPort=49318,tcpPort=49319,udpEndpoint={deliver(){received++;}},tcpEndpoint={deliver(){}};
 let lease:{release():void}|undefined,savedTransport:{writable:boolean}|undefined,wasWritable=false;
 try{
  await link.ready;expect(network.bind(udpPort,udpEndpoint,PROTO_UDP)).toBe(true);expect(network.bind(tcpPort,tcpEndpoint,PROTO_TCP)).toBe(true);
  const destination=ipv4ToNode(Uint8Array.of(203,0,113,218),true);
  await until(()=>network.send(udpPort,destination,peer.address().port,Uint8Array.of(1),PROTO_UDP),"warmup admitted");
  await until(()=>nativePort>0&&received===1,"native UDP live");
  lease=await network.leaseUdpPeer(udpPort,destination,peer.address().port);
  const engine=link.socket.io.engine;
  await until(()=>engine.writeBuffer.length===0,"engine drained before controlled pressure");
  const state=link as unknown as {reliableQueue:unknown[];udpPeers:{controlReservations:number}};
  expect(state.udpPeers.controlReservations).toBe(1);expect(await free(nativePort)).toBe(false);
  savedTransport=engine.transport;wasWritable=savedTransport.writable;savedTransport.writable=false;
  // This synchronous turn admits real RelayLink records without allowing any
  // engine drain. The single existing UDP lease reserves the final queue slot.
  const absentLanPeer=Uint8Array.of(2,0,0,99,1,1);
  for(let i=0;i<255;i++)expect(network.send(tcpPort,absentLanPeer,49320,encodeTcpFrame(DATA,1,2,0,Uint8Array.of(i)),PROTO_TCP)).toBe(true);
  expect(state.reliableQueue.length).toBe(255);
  // Closing a different port does not consume that UDP lease's reservation.
  // The void release cannot refuse silently: disconnect must clean native state.
  network.unbind(tcpPort,tcpEndpoint,PROTO_TCP);
  expect(link.connected).toBe(false);
  await until(()=>free(nativePort),"fatal cleanup releases actual native UDP port");
  expect(state.reliableQueue.length).toBe(0);
 }finally{
  if(savedTransport)savedTransport.writable=wasWritable;
  lease?.release();network.reset();network.attach(null);link.close();await server.close();await new Promise<void>(ok=>peer.close(()=>ok()));
 }
},15000);
