import {expect,test} from "bun:test";
import {createSocket,type Socket} from "node:dgram";
import {io,type Socket as ClientSocket} from "socket.io-client";
import {createLanServer} from "../../packages/lan/src/server";
import {asBytes,decodeDatagram,encodeDatagram,ipv4ToNode,PROTO_UDP,PROTOCOL_VERSION,type ClientEvents,type ServerEvents,type UdpPeerLeaseReply} from "../../packages/lan/src/protocol";
import {buildBoundUdpHelper} from "../lan-conformance/build-bound-udp-helper";
const wait=async(check:()=>boolean|Promise<boolean>,label:string)=>{const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error("Timeout: "+label);await new Promise(r=>setTimeout(r,2));}};
const bind=async()=>{const s=createSocket("udp4");await new Promise<void>((ok,no)=>{s.once("error",no);s.bind(0,"127.0.0.1",ok);});return s;};
const close=(s:Socket)=>new Promise<void>(ok=>s.close(()=>ok()));
const portFree=async(port:number)=>{const s=createSocket("udp4");return new Promise<boolean>(ok=>{s.once("error",()=>{s.close();ok(false);});s.bind(port,"0.0.0.0",()=>s.close(()=>ok(true)));});};
for(const helper of [false,true])for(const transport of ["websocket","polling"] as const)test("server inbound UDP lease lifecycle "+(helper?"helper":"node")+"/"+transport,async()=>{
 const a=await bind(),b=await bind(),ips=["203.0.113.211","203.0.113.212"],nodes=ips.map(ip=>ipv4ToNode(Uint8Array.from(ip.split(".").map(Number)),true)),seen:number[]=[],aReceived:Buffer[]=[];
 a.on("message",bytes=>aReceived.push(bytes));b.on("message",(bytes,r)=>{seen.push(r.port);b.send(bytes,r.port,r.address);});
 const server=createLanServer({port:0,gateway:{...(helper?{nativeUdpHelperPath:await buildBoundUdpHelper()}:{}),routes:[
  {host:"127.0.0.1",address:ips[0],ports:[a.address().port],protocols:["udp"]},
  {host:"127.0.0.1",address:ips[1],ports:[b.address().port],protocols:["udp"]}
 ]}});
 const port=await server.listen(),clients:ClientSocket<ServerEvents,ClientEvents>[]=[],frames:Array<Array<{data:number[];node:number[]}>>=[[],[]],replies:Map<number,UdpPeerLeaseReply>[]=[new Map(),new Map()],localPort=48211;
 try{
  for(let index=0;index<2;index++){
   const c=io("http://127.0.0.1:"+port,{autoConnect:false,transports:[transport],auth:{version:PROTOCOL_VERSION,room:"lease-room-"+index,clientId:"lease-client-"+index+"-0000000000",node:[2,0,0,31,2,1]}});
   clients.push(c);c.on("frame",raw=>{const bytes=asBytes(raw),d=bytes&&decodeDatagram(bytes);if(d)frames[index].push({data:[...d.payload],node:[...d.node]});});c.on("udpPeerLeased",(id,reply)=>replies[index].set(id,reply));
   await new Promise<void>((ok,no)=>{const timer=setTimeout(()=>no(Error("ready timeout")),5000);c.once("connect_error",e=>{clearTimeout(timer);no(e);});c.once("ready",()=>{clearTimeout(timer);ok();});c.connect();});
  }
  const emit=(i:number,n:number,generation=1)=>clients[i].emit("frame",encodeDatagram(PROTO_UDP,nodes[1],b.address().port,localPort,Uint8Array.of(n)),generation);
  const request=(i:number,id:number,generation=1,remotePort=a.address().port)=>clients[i].emit("leaseUdpPeer",id,{proto:PROTO_UDP,localPort,bindingGeneration:generation,node:[...nodes[0]],remotePort});
  const has=(i:number,n:number)=>frames[i].some(f=>f.data[0]===n);
  emit(0,10);await wait(()=>has(0,10),"first port");emit(1,11);await wait(()=>has(1,11),"other room port");
  const ports=[seen[0],seen[1]];expect(ports[0]).not.toBe(ports[1]);
  request(0,1);request(0,2);request(1,1);await wait(()=>replies[0].size===2&&replies[1].size===1,"ready ACKs");
  const ids=[replies[0].get(1)!,replies[0].get(2)!].map(r=>{expect("leaseId" in r).toBe(true);return(r as {leaseId:number}).leaseId;});expect(aReceived).toEqual([]);
  const put=(i:number,n:number)=>new Promise<void>((ok,no)=>a.send(Buffer.of(n),ports[i],"127.0.0.1",e=>e?no(e):ok()));
  await put(0,21);await wait(()=>has(0,21),"first inbound without outbound A");expect(frames[0].find(f=>f.data[0]===21)?.node).toEqual([...nodes[0]]);expect(has(1,21)).toBe(false);
  clients[0].emit("releaseUdpPeer",ids[0]);emit(0,22);await wait(()=>has(0,22),"release barrier");await put(0,23);await wait(()=>has(0,23),"duplicate lease preserves peer");
  clients[0].emit("cancelUdpPeer",2);emit(0,24);await wait(()=>has(0,24),"cancel queued ACK barrier");
  await put(0,25);await put(1,26);await wait(()=>has(1,26),"other room live");emit(0,27);await wait(()=>has(0,27),"known peer drain");
  expect(has(0,25)).toBe(false);expect(has(1,25)).toBe(false);
  request(0,3,1,a.address().port===65535?65534:a.address().port+1);await wait(()=>replies[0].has(3),"ACL denied");expect(replies[0].get(3)).toMatchObject({error:{code:10013}});
  clients[0].emit("releasePort",PROTO_UDP,localPort,1);await wait(()=>portFree(ports[0]),"native generation released");expect(await portFree(ports[1])).toBe(false);
  request(0,4,1);await wait(()=>replies[0].has(4),"stale binding denied");expect(replies[0].get(4)).toMatchObject({error:{code:10013}});
  emit(0,30,2);await wait(()=>has(0,30),"new generation");clients[0].emit("releaseUdpPeer",ids[1]);request(0,5,2);await wait(()=>replies[0].has(5),"new lease ACK");expect("leaseId" in replies[0].get(5)!).toBe(true);
  const newPort=seen[seen.length-1];await new Promise<void>((ok,no)=>a.send(Buffer.of(31),newPort,"127.0.0.1",e=>e?no(e):ok()));await wait(()=>has(0,31),"new generation inbound");
 }finally{for(const c of clients)c.close();await server.close();await Promise.all([close(a),close(b)]);}
},20000);
