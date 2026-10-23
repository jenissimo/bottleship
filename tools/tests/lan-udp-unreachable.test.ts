import {expect,test} from "bun:test";
import {LanNetwork,type LanSocketError,type LanDatagram} from "../../src/worker/net/lan-network";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {PROTO_UDP,PROTO_UDP6,PROTO_IPX,BROADCAST_NODE,encodeDatagram} from "../../src/worker/net/netplay-wire";

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const source=62110,target=62111;
const sink={deliver(_packet:LanDatagram){}};
function expected(network:LanNetwork,proto:number){return {node:network.node,localPort:source,remotePort:target,proto,code:10054,bindingGeneration:network.bindingGeneration(source,proto)};}

for(const proto of [PROTO_UDP,PROTO_UDP6]){
 test(`UDP protocol ${proto}: accepted closed local port reports asynchronous source-bound reset`,async()=>{
  const network=new LanNetwork(),errors:LanSocketError[]=[];
  network.onSocketError(error=>errors.push(error));
  expect(network.bind(source,sink,proto)).toBe(true);
  expect(network.send(source,network.node,target,new Uint8Array(),proto)).toBe(true);
  expect(errors).toHaveLength(0);
  await tick();expect(errors).toEqual([expected(network,proto)]);
 });
 test(`UDP protocol ${proto}: live destination, foreign input and broadcast do not report port-unreachable`,async()=>{
  const network=new LanNetwork(),errors:LanSocketError[]=[],packets:LanDatagram[]=[];
  network.onSocketError(error=>errors.push(error));
  network.bind(source,sink,proto);const endpoint={deliver:(packet:LanDatagram)=>packets.push(packet)};
  network.bind(target,endpoint,proto);
  expect(network.send(source,network.node,target,Uint8Array.of(1),proto)).toBe(true);
  expect(packets).toHaveLength(1);network.unbind(target,endpoint,proto);
  network.receiveFrame(encodeDatagram(proto,Uint8Array.of(2,0,0,0,9,1),target,source,Uint8Array.of(2)));
  expect(network.send(source,BROADCAST_NODE,target,Uint8Array.of(3),proto)).toBe(true);
  expect(network.send(source,Uint8Array.of(2,0,0,0,9,2),target,Uint8Array.of(4),proto)).toBe(false);
  await tick();expect(errors).toHaveLength(0);
 });
 test(`UDP protocol ${proto}: source close/rebind and reset fence pending errors`,async()=>{
  const network=new LanNetwork(),errors:LanSocketError[]=[];
  network.onSocketError(error=>errors.push(error));network.bind(source,sink,proto);
  network.send(source,network.node,target,Uint8Array.of(1),proto);
  network.unbind(source,sink,proto);network.bind(source,sink,proto);
  await tick();expect(errors).toHaveLength(0);
  network.send(source,network.node,target,Uint8Array.of(2),proto);network.reset();
  await tick();expect(errors).toHaveLength(0);
 });
}
test("multicast, IPX and unbound sources cannot create local UDP errors",async()=>{
 const network=new LanNetwork(),errors:LanSocketError[]=[];network.onSocketError(error=>errors.push(error));
 network.bind(source,sink,PROTO_UDP);
 expect(network.sendMulticast4(source,Uint8Array.of(239,1,2,3),target,Uint8Array.of(1),1,0)).toBe(true);
 network.send(source,network.node,target,Uint8Array.of(1,2),PROTO_IPX);
 network.send(source+2,network.node,target,Uint8Array.of(1),PROTO_UDP);
 await tick();expect(errors).toHaveLength(0);
});
test("namespace reset goes only to the accepted source incarnation, including shared-port owners",async()=>{
 const network=new LanNetwork(),root=new RootNetworkNamespace(network,8,62801);
 const aLease=root.createChild(62802),a=new LanNetwork(),aNamespace=new ChildProcessNetworkNamespace(a,aLease.boot);
 const bLease=root.createChild(62803),b=new LanNetwork(),bNamespace=new ChildProcessNetworkNamespace(b,bLease.boot);
 const rootErrors:LanSocketError[]=[],aErrors:LanSocketError[]=[],bErrors:LanSocketError[]=[];
 network.onSocketError(error=>rootErrors.push(error));a.onSocketError(error=>aErrors.push(error));b.onSocketError(error=>bErrors.push(error));
 try{
  for(const proto of [PROTO_UDP,PROTO_UDP6]){
   expect(network.bind(source,sink,proto,true)).toBe(true);
   expect(a.bind(source,sink,proto,true)).toBe(true);expect(b.bind(source,sink,proto,true)).toBe(true);
   await aNamespace.barrier();await bNamespace.barrier();
   expect(a.send(source,a.node,target,Uint8Array.of(1),proto)).toBe(true);
   await aNamespace.barrier();await tick();
   expect(aErrors.at(-1)).toEqual(expected(a,proto));expect(aErrors).toHaveLength(proto===PROTO_UDP?1:2);
   expect(rootErrors).toHaveLength(0);expect(bErrors).toHaveLength(0);
   // A shared physical generation survives this owner's close. Its delivery incarnation must not.
   a.send(source,a.node,target,Uint8Array.of(2),proto);
   a.unbind(source,sink,proto);a.bind(source,sink,proto,true);
   await aNamespace.barrier();await tick();
   expect(aErrors).toHaveLength(proto===PROTO_UDP?1:2);
   expect(network.send(source,network.node,target,Uint8Array.of(3),proto)).toBe(true);
   network.unbind(source,sink,proto);network.bind(source,sink,proto,true);
   await tick();expect(rootErrors).toHaveLength(0);
   const packets:LanDatagram[]=[],endpoint={deliver:(packet:LanDatagram)=>packets.push(packet)};
   b.bind(target,endpoint,proto);await bNamespace.barrier();
   network.send(source,network.node,target,Uint8Array.of(4),proto);
   await bNamespace.barrier();await tick();
   expect(packets).toHaveLength(1);expect(aErrors).toHaveLength(proto===PROTO_UDP?1:2);
   b.unbind(target,endpoint,proto);
  }
 }finally{aNamespace.close();bNamespace.close();aLease.close();bLease.close();await root.close();}
},10000);

test("real Worker source receives IPv4/IPv6 reset and live worker delivery remains usable",async()=>{
 const network=new LanNetwork(),root=new RootNetworkNamespace(network,8,62811),lease=root.createChild(62812);
 const worker=new Worker(new URL("./fixtures/udp-unreachable-worker.ts",import.meta.url).href,{type:"module"});
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(reason:any)=>void;timer:ReturnType<typeof setTimeout>}>();
 let next=0;
 const stopped=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("worker close timed out")),9000);worker.addEventListener("close",()=>{clearTimeout(timer);resolve();},{once:true});});
 worker.onmessage=e=>{const item=pending.get(e.data.id);if(!item)return;pending.delete(e.data.id);clearTimeout(item.timer);if(e.data.error)item.reject(new Error(e.data.error));else item.resolve(e.data.value);};
 const call=(message:any)=>new Promise<any>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error("worker command timed out"));},6000)});worker.postMessage({id,...message},message.boot?[message.boot.port]:[]);});
 try{
  await call({boot:lease.boot});
  for(const proto of [PROTO_UDP,PROTO_UDP6]){
   network.bind(source,sink,proto);
   const result=await call({proto,source:source+2,target});
   expect(result.errors).toEqual([{localPort:source+2,remotePort:target,proto,code:10054}]);
   const packets:LanDatagram[]=[],endpoint={deliver:(packet:LanDatagram)=>packets.push(packet)};
   network.bind(target,endpoint,proto);
   await call({proto,source:source+2,target,live:true});
   await tick();expect(packets.at(-1)?.data).toEqual(Uint8Array.of(9));
   network.unbind(target,endpoint,proto);
  }
 }finally{
  worker.terminate();lease.close();for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error("worker closed"));}pending.clear();
  await stopped;await root.close();
 }
},15000);
