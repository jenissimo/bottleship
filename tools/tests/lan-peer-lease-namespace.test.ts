import {test,expect} from "bun:test";
import {createSocket} from "node:dgram";
import {createLanServer} from "../../packages/lan/src/server";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error(label);await sleep(2);}}
for(const transport of ["websocket","polling"] as const)test("UDP peer permissions cross process namespaces with one relay, "+transport,async()=>{
 const native=createSocket("udp4");let nativePayloads=0;native.on("message",()=>nativePayloads++);
 await new Promise<void>(resolve=>native.bind(0,"127.0.0.1",resolve));
 const remotePort=native.address().port,ip=[203,0,113,222],requests:any[]=[],releases:number[]=[];let connections=0;
 const server=createLanServer({port:0,gateway:{routes:[{host:"127.0.0.1",address:ip.join("."),ports:[remotePort],protocols:["udp"]}]}});
 server.io.on("connection",socket=>{connections++;socket.on("leaseUdpPeer",(id,request)=>requests.push({id,request}));socket.on("releaseUdpPeer",id=>releases.push(id));});
 const serverPort=await server.listen(),network=new LanNetwork(),host=new RootNetworkNamespace(network,16,91001);
 const childLease=host.createChild(91002),childNetwork=new LanNetwork(),child=new ChildProcessNetworkNamespace(childNetwork,childLease.boot);
 const rootEndpoint={deliver(){}},childEndpoint={deliver(){}};
 try{
  const broker=host as any;
  const link=new RelayLink("http://127.0.0.1:"+serverPort,"peer-namespace",broker.backplane,{transports:[transport]});
  broker.active={key:"peer-test",link};broker.backplane.attach(link);await link.ready;
  expect(link.socket.io.engine.transport.name).toBe(transport);
  await until(()=>childNetwork.connected,"child relay readiness");
  expect(network.bind(47124,rootEndpoint,1)).toBe(true);expect(childNetwork.bind(47125,childEndpoint,1)).toBe(true);
  await child.barrier();
  const rootNode=network.routeIpv4(Uint8Array.from(ip)),childNode=childNetwork.routeIpv4(Uint8Array.from(ip));
  const rootPermission=await network.leaseUdpPeer(47124,rootNode,remotePort);
  const childPermission=await childNetwork.leaseUdpPeer(47125,childNode,remotePort);
  expect(requests.map(item=>item.request.localPort)).toEqual([47124,47125]);
  expect(requests.every(item=>item.request.remotePort===remotePort&&item.request.bindingGeneration>0)).toBe(true);
  expect(nativePayloads).toBe(0);
  const count=requests.length;
  const denied=await child.leaseUdpPeer({proto:1,localPort:47124,bindingGeneration:network.bindingGeneration(47124,1),node:[...rootNode],remotePort}).then(()=>null,error=>error);expect(denied?.code).toBe(10022);
  expect(requests).toHaveLength(count);
  childPermission.release();childPermission.release();rootPermission.release();
  await until(()=>releases.length===2,"exact remote lease releases");
  expect(new Set(releases).size).toBe(2);
  const controller=new AbortController(),cancelled=child.leaseUdpPeer({proto:1,localPort:47125,bindingGeneration:childNetwork.bindingGeneration(47125,1),node:[...childNode],remotePort},controller.signal);
  controller.abort();await expect(cancelled).rejects.toHaveProperty("code",995);
  expect(connections).toBe(1);
  const tuple={proto:1 as const,localPort:47125,bindingGeneration:childNetwork.bindingGeneration(47125,1),node:[...childNode],remotePort};
  const childBurst:Promise<any>[]=[];let maxInFlight=0;
  for(let index=0;index<300;index++){
   const abort=new AbortController();childBurst.push(child.leaseUdpPeer(tuple,abort.signal).then(()=>null,error=>error));abort.abort();
   maxInFlight=Math.max(maxInFlight,(child as any).udpControlsInFlight);
  }
  expect(maxInFlight).toBeLessThanOrEqual(256);
  const childErrors=await Promise.all(childBurst);
  expect(childErrors.every(error=>error?.code===995||error?.code===10055)).toBe(true);expect(childErrors.some(error=>error?.code===10055)).toBe(true);
  await until(()=>(child as any).udpControlsInFlight===0,"parent consumed bounded child controls");
  const engine=link.socket.io.engine,oldWritable=engine.transport.writable,stalled:Promise<any>[]=[];let maxQueued=0;
  engine.transport.writable=false;
  try{
   for(let index=0;index<300;index++){
    const abort=new AbortController();stalled.push(link.leaseUdpPeer({...tuple,localPort:47124,bindingGeneration:network.bindingGeneration(47124,1)},abort.signal).then(()=>null,error=>error));abort.abort();
    maxQueued=Math.max(maxQueued,(link as any).reliableQueue.length);
   }
   expect(maxQueued).toBeLessThanOrEqual(256);
   expect(engine.writeBuffer.length).toBeLessThanOrEqual(1);
   expect((link as any).queuedBytes).toBeLessThanOrEqual(1024*1024);
   const stalledErrors=await Promise.all(stalled);
   expect(stalledErrors.every(error=>error?.code===995||error?.code===10055)).toBe(true);expect(stalledErrors.some(error=>error?.code===10055)).toBe(true);
   expect(link.connected).toBe(true);
  }finally{engine.transport.writable=oldWritable;(link as any).flush();}
  await until(()=>(link as any).reliableQueue.length===0,"ordered cancellations drained");
  expect(nativePayloads).toBe(0);
 }finally{
  child.close();childLease.close();network.unbind(47124,rootEndpoint,1);await host.close();await server.close();
  await new Promise<void>(resolve=>native.close(()=>resolve()));
 }
},20000);
