import {expect,test} from "bun:test";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork,type LanDatagram,type NetTransport} from "../../src/worker/net/lan-network";
import {WsaSocketTable,WsaFailure,ipv4Address} from "../../src/worker/modules/wsa-network";
import {PROTO_UDP} from "../../src/worker/net/netplay-wire";
class ControlWorker extends EventTarget {
 private readonly ports:MessagePort[]=[];
 postMessage(message:any){const port=message.control;this.ports.push(port,message.network.port);
  port.onmessage=event=>{const value=event.data;if(["finish","barrier","shutdown"].includes(value.type))
   port.postMessage({type:value.type==="finish"?"finished":value.type==="barrier"?"barrierDone":"shutdownDone",id:value.id});};port.start();}
 unref(){}
 terminate(){for(const port of this.ports)port.close();this.dispatchEvent(new Event("close"));}
}
const group=Uint8Array.of(239,255,42,17),port=6298;
function fixture(supported:boolean){
 const network=new LanNetwork(Uint8Array.of(2,0,0,29,5,1)),saved=globalThis.Worker;
 let root:RootNetworkNamespace;try{globalThis.Worker=ControlWorker as unknown as typeof Worker;root=new RootNetworkNamespace(network,8,59001);}
 finally{globalThis.Worker=saved;}
 const backplane=(root! as unknown as {backplane:LanNetwork}).backplane,forwarded:Uint8Array[]=[];
 backplane.attach({connected:false,send:frame=>{forwarded.push(frame);return true},close(){}});
 backplane.configureMulticast4(supported);backplane.setConnected(true);
 const packets:LanDatagram[]=[];network.bind(port,{deliver:packet=>packets.push(packet)},PROTO_UDP);
 const lease=root!.createChild(59002),child=new LanNetwork(),namespace=new ChildProcessNetworkNamespace(child,lease.boot);
 const table=new WsaSocketTable(child),sender=table.socket(2,2,17);
 return{network,root:root!,backplane,child,namespace,table,sender,packets,forwarded,
  transition(support:boolean,connected=true){backplane.setConnected(false,"test transition");backplane.configureMulticast4(support);if(connected)backplane.setConnected(true);},
  async close(){table.reset();namespace.close();lease.close();await root!.close();}};
}
function errorCode(invoke:()=>unknown):number|undefined{try{invoke();return undefined}catch(error){if(error instanceof WsaFailure)return error.code;throw error;}}
test("online child sees host multicast capability before the first MessagePort state",async()=>{
 const f=fixture(true);
 try{
  // No await has occurred since constructor. The posted state has not run.
  expect(f.child.connected).toBe(true);expect(f.child.udpMulticast4V1).toBe(true);
  expect(f.table.send(f.sender,Uint8Array.of(1),ipv4Address(group,port))).toBe(1);
  await f.namespace.barrier();
  expect(f.forwarded).toHaveLength(1);expect(f.packets.map(packet=>packet.data[0])).toEqual([1]);
 }finally{await f.close();}
},10000);
test("SAB disconnect overrides a stale online message without disabling offline local multicast",async()=>{
 const f=fixture(true);
 try{
  await f.namespace.barrier();expect(f.child.connected).toBe(true);expect(f.child.udpMulticast4V1).toBe(true);
  f.transition(false,false);
  // The child still has its old MessagePort state, but shared host state is offline.
  expect(f.child.connected).toBe(false);expect(f.child.udpMulticast4V1).toBeUndefined();
  expect(f.table.send(f.sender,Uint8Array.of(2),ipv4Address(group,port))).toBe(1);
  await f.namespace.barrier();
  expect(f.forwarded).toHaveLength(0);expect(f.packets.map(packet=>packet.data[0])).toEqual([2]);
 }finally{await f.close();}
},10000);
test("capability reconnect is authoritative before and after queued stale states",async()=>{
 const f=fixture(true);
 try{
  await f.namespace.barrier();
  f.transition(false);
  expect(f.child.connected).toBe(true);expect(f.child.udpMulticast4V1).toBeUndefined();
  expect(errorCode(()=>f.table.send(f.sender,Uint8Array.of(90),ipv4Address(group,port)))).toBe(10045);
  await f.namespace.barrier();expect(f.child.udpMulticast4V1).toBeUndefined();
  f.transition(true);
  expect(f.child.connected).toBe(true);expect(f.child.udpMulticast4V1).toBe(true);
  expect(f.table.send(f.sender,Uint8Array.of(3),ipv4Address(group,port))).toBe(1);
  await f.namespace.barrier();
  expect(f.forwarded).toHaveLength(1);expect(f.packets.map(packet=>packet.data[0])).toEqual([3]);
 }finally{await f.close();}
},10000);
test("ordinary transports keep the established explicit state contract",()=>{
 const network=new LanNetwork(),transport:NetTransport={connected:false,send:()=>true,close(){}};
 network.attach(transport);network.setConnected(true);network.configureMulticast4(true);
 expect(network.connected).toBe(true);expect(network.udpMulticast4V1).toBe(true);
 network.setConnected(false);
 expect(network.connected).toBe(false);expect(network.udpMulticast4V1).toBeUndefined();
});
