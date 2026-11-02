import {expect,test} from "bun:test";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork,type LanDatagram} from "../../src/worker/net/lan-network";
import {PROTO_UDP,encodeDatagram} from "../../src/worker/net/netplay-wire";

class ControlWorker extends EventTarget {
 private ports:MessagePort[]=[];
 postMessage(message:any){const port=message.control;this.ports.push(port,message.network.port);port.onmessage=e=>{const m=e.data;if(["shutdown","barrier","finish"].includes(m.type))port.postMessage({type:m.type==="shutdown"?"shutdownDone":m.type==="finish"?"finished":"barrierDone",id:m.id});};port.start();}
 unref(){} terminate(){this.ports.forEach(p=>p.close());this.dispatchEvent(new Event("close"));}
}
function fixture(){
 const network=new LanNetwork(Uint8Array.of(2,0,0,29,0,1)),saved=globalThis.Worker;let host:RootNetworkNamespace;
 try{globalThis.Worker=ControlWorker as unknown as typeof Worker;host=new RootNetworkNamespace(network,8);}finally{globalThis.Worker=saved;}
 const lease=host!.createChild(),child=new LanNetwork(),namespace=new ChildProcessNetworkNamespace(child,lease.boot);
 return {network,host:host!,child,namespace,backplane:(host! as unknown as {backplane:LanNetwork}).backplane,async close(){namespace.close();lease.close();await host!.close();}};
}
const group=Uint8Array.of(239,255,42,17),port=6290,remote=Uint8Array.of(2,0,0,29,0,2);
test("offline multicast crosses the process namespace with original interface and group",async()=>{
 const h=fixture(),rootPackets:LanDatagram[]=[],childPackets:LanDatagram[]=[];
 try{
  h.network.bind(port,{deliver:dg=>rootPackets.push(dg)},PROTO_UDP,true);h.child.bind(port,{deliver:dg=>childPackets.push(dg)},PROTO_UDP,true);await h.namespace.barrier();
  expect(h.network.sendMulticast4(6291,group,port,Uint8Array.of(1),1,0)).toBe(true);await h.namespace.barrier();
  expect(rootPackets).toHaveLength(1);expect(childPackets).toHaveLength(1);
  expect(childPackets[0].multicast4).toEqual({group,interfaceIndex:1,ttl:0,localOrigin:true});
  expect(h.child.sendMulticast4(6292,group,port,Uint8Array.of(2),2,1)).toBe(true);await h.namespace.barrier();
  expect(rootPackets).toHaveLength(2);expect(childPackets).toHaveLength(2);
  expect(rootPackets[1].multicast4).toEqual({group,interfaceIndex:2,ttl:1,localOrigin:true});
 }finally{await h.close();}
},10000);
test("multicast snapshots recipient incarnation before callbacks and queued rebind",async()=>{
 const h=fixture(),old:LanDatagram[]=[],fresh:LanDatagram[]=[];let replace=false;
 const before={deliver:(dg:LanDatagram)=>old.push(dg)},after={deliver:(dg:LanDatagram)=>fresh.push(dg)};
 try{
  h.network.bind(port,{deliver(){if(replace){replace=false;h.child.unbind(port,before,PROTO_UDP);expect(h.child.bind(port,after,PROTO_UDP,true)).toBe(true);}}},PROTO_UDP,true);
  h.child.bind(port,before,PROTO_UDP,true);await h.namespace.barrier();
  replace=true;const frame=encodeDatagram(PROTO_UDP,remote,port,6291,Uint8Array.of(3),{group,interfaceIndex:2,ttl:1});
  h.backplane.receiveFrame(frame);await h.namespace.barrier();
  expect(old).toHaveLength(0);expect(fresh).toHaveLength(0);
  h.backplane.receiveFrame(frame);await h.namespace.barrier();
  expect(fresh).toHaveLength(1);expect(fresh[0].multicast4?.localOrigin).toBe(false);
 }finally{await h.close();}
},10000);
