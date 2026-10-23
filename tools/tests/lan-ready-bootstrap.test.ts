import {test,expect} from "bun:test";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork,type NetTransport} from "../../src/worker/net/lan-network";
class ControlWorker extends EventTarget {
 private readonly ports:MessagePort[]=[];
 postMessage(message:any){const port=message.control;this.ports.push(port,message.network.port);
  port.onmessage=event=>{const value=event.data;if(["finish","barrier","shutdown"].includes(value.type))
   port.postMessage({type:value.type==="finish"?"finished":value.type==="barrier"?"barrierDone":"shutdownDone",id:value.id});};port.start();}
 unref(){}
 terminate(){for(const port of this.ports)port.close();this.dispatchEvent(new Event("close"));}
}
test("actual child boot and reconnect expose coherent ready metadata before queued states or a connected warmup",async()=>{
 const saved=globalThis.Worker,network=new LanNetwork();let root!:RootNetworkNamespace;
 try{globalThis.Worker=ControlWorker as unknown as typeof Worker;root=new RootNetworkNamespace(network,8,59201)}
 finally{globalThis.Worker=saved}
 const backplane=(root as unknown as {backplane:LanNetwork}).backplane;
 const allowedNodes=[[2,1,127,0,0,1]],opens:string[]=[];
 const transport:NetTransport={connected:false,send:()=>true,close(){},
  resolve:async()=>({canonicalName:"configured.test",addresses:[{family:4,address:"10.44.0.8"}]}),
  openUdpHost:async request=>{opens.push(request.listenerId);let live=true,done!:(value:{code:number;message:string})=>void;
   const closed=new Promise<{code:number;message:string}>(resolve=>done=resolve);
   return{address:{node:[2,1,127,0,0,1],port:49001},allowedNodes,closed,isLive:()=>live,release(){if(live){live=false;done({code:10004,message:"released"})}}};}};
 backplane.attach(transport);
 Object.defineProperty(transport,"connected",{get:()=>backplane.connected});
 (root as unknown as {active:unknown}).active={key:"test-provider",link:transport};
 const setReady=(listener:string,gateway:boolean,multicast:boolean)=>{
  backplane.configureDirectPlay8({provider:"native",hostListener:listener});
  backplane.configureUdpHosts({listeners:[{id:listener,allowedNodes}]});
  backplane.configureGatewayAddresses(gateway?[[10,44,0,8]]:[]);
  backplane.configureGatewayIpv6(gateway?[{address:[32,1,13,184,0,0,0,0,0,0,0,0,0,0,0,9],node:[2,2,0,0,0,9]}]:[]);
  backplane.configureMulticast4(multicast);backplane.setConnected(true);
 };
 setReady("first",true,true);
 const lease=root.createChild(59202),worker=new Worker(new URL("./fixtures/lan-ready-bootstrap-worker.ts",import.meta.url).href,{type:"module"});
 let next=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 worker.onmessage=event=>{const value=event.data,p=pending.get(value.id);if(!p)return;pending.delete(value.id);clearTimeout(p.timer);p.resolve(value)};
 worker.onerror=event=>{event.preventDefault();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(event.message))}pending.clear()};
 const rpc=(message:any,transfer:Transferable[]=[])=>new Promise<any>((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error("Ready metadata worker deadline"))},5000);pending.set(id,{resolve,reject,timer});worker.postMessage({...message,id},transfer)});
 try{
  const initial=await rpc({type:"boot",boot:lease.boot,listener:"first"},[lease.boot.port]);
  expect(initial.error).toBeUndefined();expect(initial.earlyHost).toBe(true);
  expect(initial.state).toEqual({policy:{provider:"native",hostListener:"first"},host:{listeners:[{id:"first",allowedNodes}]},ipv4:[2,1,10,44,0,8],ipv6:[2,2,0,0,0,9],multicast:true,connected:true});
  backplane.setConnected(false,"test disconnected");
  const offline=await rpc({type:"probe"});expect(offline.state.connected).toBe(false);expect(offline.state.host).toBeUndefined();expect(offline.state.multicast).toBeUndefined();
  setReady("second",false,false);
  const changed=await rpc({type:"host",listener:"second"});expect(changed.error).toBeUndefined();expect(changed.earlyHost).toBe(true);
  expect(changed.state.policy).toEqual({provider:"native",hostListener:"second"});expect(changed.state.host.listeners[0].id).toBe("second");expect(changed.state.multicast).toBeUndefined();
  expect(changed.state.ipv4).toEqual([2,0,0,44,0,8]);expect(changed.state.ipv6).toBeUndefined();
  const resolved=await rpc({type:"resolve"});expect(resolved.error).toBeUndefined();expect(resolved.state.ipv4).toEqual([2,1,10,44,0,8]);
  const flushed=await rpc({type:"flush"});expect(flushed.state).toEqual(resolved.state);expect(opens).toEqual(["first","second"]);
 }finally{
  try{await rpc({type:"close"})}finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("closing"))}pending.clear();worker.terminate();lease.close();await root.close()}
 }
},15000);
function localFixture(){
 const saved=globalThis.Worker,network=new LanNetwork();let root!:RootNetworkNamespace;
 try{globalThis.Worker=ControlWorker as unknown as typeof Worker;root=new RootNetworkNamespace(network,8,59301)}finally{globalThis.Worker=saved}
 const backplane=(root as unknown as {backplane:LanNetwork}).backplane;
 backplane.attach({connected:false,send:()=>true,close(){}});
 const lease=root.createChild(59302),child=new LanNetwork(),namespace=new ChildProcessNetworkNamespace(child,lease.boot);
 return{root,network,backplane,child,async close(){namespace.close();lease.close();await root.close()}};
}
test("the full accepted ready inventory is available without truncation before MessagePort delivery",async()=>{
 const f=localFixture();
 const ipv4=Array.from({length:4096},(_,i)=>[223,255,i>>>8,i&255]);
 const ipv6=Array.from({length:4096},(_,i)=>({address:[255,255,255,255,255,255,255,255,255,255,255,255,255,255,i>>>8,i&255],node:[2,2,255,255,i>>>8,i&255],scopeId:0xffffffff}));
 const allowedNodes=Array.from({length:32},(_,i)=>[2,1,223,255,255,i+1]);
 const listeners=Array.from({length:32},(_,i)=>({id:"x".repeat(62)+i.toString().padStart(2,"0"),allowedNodes}));
 try{
  f.backplane.configureGatewayAddresses(ipv4);f.backplane.configureGatewayIpv6(ipv6);
  f.backplane.configureUdpHosts({listeners});f.backplane.configureDirectPlay8({provider:"native",hostListener:listeners[31].id});
  f.backplane.configureMulticast4(true);f.backplane.setConnected(true);
  // Routing itself must refresh, without a preceding connected/capability read.
  expect(Array.from(f.child.routeIpv4(Uint8Array.from(ipv4[4095])))).toEqual([2,1,...ipv4[4095]]);
  expect(Array.from(f.child.routeIpv6(Uint8Array.from(ipv6[4095].address),0xffffffff))).toEqual(ipv6[4095].node);
  expect(f.child.udpHostListenV1).toEqual({listeners});
  expect(f.child.directPlay8).toEqual({provider:"native",hostListener:listeners[31].id});
  expect(f.child.udpMulticast4V1).toBe(true);expect(f.child.connected).toBe(true);
 }finally{await f.close()}
});
test("oversized readiness withdraws online and capabilities with a visible failure, then recovers",async()=>{
 const f=localFixture(),reasons:string[]=[];f.network.onStateChange(state=>{if(state.reason)reasons.push(state.reason)});
 try{
  f.backplane.configureMulticast4(true);f.backplane.setConnected(true);
  expect(f.child.connected).toBe(true);expect(f.child.udpMulticast4V1).toBe(true);
  f.backplane.setConnected(false);
  f.backplane.configureUdpHosts({listeners:[{id:"new",allowedNodes:[[2,1,127,0,0,1]]}]});
  f.backplane.setConnected(true,"oversized "+"x".repeat(1024*1024));
  expect(f.network.connected).toBe(false);expect(f.child.connected).toBe(false);
  expect(f.child.udpMulticast4V1).toBeUndefined();expect(f.child.udpHostListenV1).toBeUndefined();
  expect(reasons).toContain("Network readiness metadata exceeds shared snapshot capacity");
  f.backplane.setConnected(false);f.backplane.configureMulticast4(true);f.backplane.setConnected(true);
  expect(f.child.connected).toBe(true);expect(f.child.udpMulticast4V1).toBe(true);
 }finally{await f.close()}
});
