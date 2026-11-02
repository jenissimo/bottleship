import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import type {WsaSocketTable} from "../../src/worker/modules/wsa-network";
import type {DirectPlay4NativeSession} from "../../src/worker/modules/dplayx/native-wire/native-session";
import {DirectPlaySession,type Discovery} from "../../src/worker/modules/dplayx/session";
import {createDirectPlay4NativeJoinPlan} from "../../src/worker/modules/dplayx/native-wire/join-plan";
function fixture(){
 const net=new LanNetwork(),node=[2,1,192,0,2,7],ip=Uint8Array.of(192,0,2,7),destIp=Uint8Array.of(198,51,100,9);
 net.attach({connected:true,send:()=>true,close(){}});
 net.configureGatewayAddresses([[...destIp]]);
 net.configureWinsock({provider:"native",hostListener:"tcp"});
 net.configureDirectPlay4({provider:"native",tcpHostListener:"tcp",udpHostListener:"udp"});
 net.configureTcpHosts({listeners:[{id:"tcp",allowedNodes:[node]}]});
 net.configureUdpHosts({listeners:[{id:"udp",allowedNodes:[node]}]});
 const sockaddr=new Uint8Array(16);sockaddr[0]=2;sockaddr[2]=9;sockaddr[3]=7;sockaddr.set(destIp,4);
 const peer={family:2,node:Uint8Array.from(node),ip,port:4000};
 const found:Discovery={native:true,nativeEpoch:{},seen:1,currentPlayers:1,address:{node:[2,1,...destIp],port:2311},
  desc:{instance:"01".repeat(16),application:"02".repeat(16),flags:0,maxPlayers:8,name:"x",password:"",user:[0,0,0,0],reserved:[42,0]},
  nativeProvider:{sockaddr,version:14,peer}};
 const table={network:net,generation:1} as unknown as WsaSocketTable;
 let owner=true;
 return {net,found,peer,table,revoke:()=>{owner=false;},make:()=>createDirectPlay4NativeJoinPlan(net,table,found,()=>owner)};
}
test("native join plan is synchronously cancelled when its exact cached discovery is replaced",()=>{
 const f=fixture(),session=new DirectPlaySession(f.net);
 expect(session.initialize()).toBe(0);
 const discovery=session.beginNativeDiscovery();
 f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
 const plan=session.prepareNativeJoin(f.table,f.found);
 expect(plan.current()).toBe(true);
 session.cacheDiscovery({...f.found});
 expect(plan.signal.aborted).toBe(true);
 expect(plan.current()).toBe(false);
 session.dispose();
});
test("a COM session admits only one native join and releases its reservation on close",async()=>{
 const f=fixture(),session=new DirectPlaySession(f.net);expect(session.initialize()).toBe(0);
 const discovery=session.beginNativeDiscovery();f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
 expect(()=>session.prepareNativeJoin({network:new LanNetwork()} as WsaSocketTable,f.found)).toThrow();
 const first=session.prepareNativeJoin(f.table,f.found);
 expect(()=>session.prepareNativeJoin(f.table,f.found)).toThrow();
 first.signal.addEventListener("abort",()=>expect(()=>session.prepareNativeJoin(f.table,f.found)).toThrow(),{once:true});
 first.close();await Promise.resolve();const second=session.prepareNativeJoin(f.table,f.found);
 first.close();expect(second.current()).toBe(true);
 session.close();expect(second.signal.aborted).toBe(true);session.dispose();
});
test("native join publication keeps its exact owner and rejects a mismatched snapshot",()=>{
 const f=fixture(),session=new DirectPlaySession(f.net);expect(session.initialize()).toBe(0);
 const discovery=session.beginNativeDiscovery();f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
 const plan=session.prepareNativeJoin(f.table,f.found),description=new Uint8Array(80),view=new DataView(description.buffer);
 view.setUint32(0,80,true);description.set(plan.discovery.instanceGuid,8);description.set(plan.discovery.applicationGuid,24);
 view.setUint32(56,plan.discovery.reserved1,true);
 const snapshot={command:41,version:14,sessionDescription:[...description],name:null,password:null,players:[],groups:[],shortcuts:[]} as const;
 const invalid={...snapshot,sessionDescription:[...description]};invalid.sessionDescription[8]^=1;
 let currentSnapshot=snapshot;const backend={nameTable:()=>currentSnapshot} as unknown as DirectPlay4NativeSession;
 currentSnapshot=invalid;expect(()=>session.commitNativeJoin(plan,f.found,invalid,backend)).toThrow();expect(session.desc).toBeNull();expect(plan.current()).toBe(true);
 currentSnapshot=snapshot;session.commitNativeJoin(plan,f.found,snapshot,backend);expect(session.desc?.instance).toBe(f.found.desc.instance);expect(plan.current()).toBe(true);
 expect(session.mutate({op:"mutate",action:"create"})).toEqual({hr:0x887700fa});expect(session.send(1,2,0,Uint8Array.of(1))).toBe(0x88770096);
 plan.close();expect(plan.signal.aborted).toBe(true);expect(session.desc).toBeNull();expect(session.readyError).toBe(0x88770136);
 session.close();session.dispose();
});
test("native CreatePlayer publishes the exact guest before delivery and fences close during await",async()=>{
 for(const closeEarly of [false,true]){
  const f=fixture(),session=new DirectPlaySession(f.net);expect(session.initialize()).toBe(0);
  const discovery=session.beginNativeDiscovery();f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
  const plan=session.prepareNativeJoin(f.table,f.found),description=new Uint8Array(80),view=new DataView(description.buffer);
  view.setUint32(0,80,true);description.set(plan.discovery.instanceGuid,8);description.set(plan.discovery.applicationGuid,24);view.setUint32(56,plan.discovery.reserved1,true);
  const snapshot={command:41,version:14,sessionDescription:[...description],name:null,password:null,players:[],groups:[],shortcuts:[]} as const;
  let release!:()=>void;const gate=new Promise<void>(ok=>release=ok);let publishedBeforeDelivery=false;
  const backend={nameTable:()=>snapshot,createPlayer:async(_request:unknown,publish:(r:{playerId:number;submission:"submitted"})=>void)=>{
   await gate;const result={playerId:7,submission:"submitted" as const};publish(result);publishedBeforeDelivery=session.entities.has(7);return result;
  }} as unknown as DirectPlay4NativeSession;
  session.commitNativeJoin(plan,f.found,snapshot,backend);
  const name={short:"local",long:"",shortNull:false,longNull:true},data=[3,4];
  const pending=session.mutate({op:"mutate",action:"create",group:false,flags:0,parent:0,name,data}) as Promise<any>;
  name.short="changed";data[0]=99;if(closeEarly)session.close();release();
  const result=await pending;
  if(closeEarly){expect(result.hr).toBe(0x88770136);expect(session.entities.size).toBe(0);}
  else{expect(result).toEqual({hr:0,id:7});expect(publishedBeforeDelivery).toBe(true);expect(session.entities.get(7)?.name.short).toBe("local");expect(session.entities.get(7)?.data).toEqual([3,4]);}
  session.dispose();
 }
});
test("native guaranteed send snapshots bytes and rejects unsupported or retired owners",async()=>{
 for(const closeEarly of [false,true]){
  const f=fixture(),session=new DirectPlaySession(f.net);expect(session.initialize()).toBe(0);
  const discovery=session.beginNativeDiscovery();f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
  const plan=session.prepareNativeJoin(f.table,f.found),description=new Uint8Array(80),view=new DataView(description.buffer);
  view.setUint32(0,80,true);description.set(plan.discovery.instanceGuid,8);description.set(plan.discovery.applicationGuid,24);view.setUint32(56,plan.discovery.reserved1,true);
  const snapshot={command:41,version:14,sessionDescription:[...description],name:null,password:null,players:[],groups:[],shortcuts:[]} as const;
  let release!:()=>void;const gate=new Promise<void>(ok=>release=ok);let observed:number[]=[];let sends=0;
  const backend={nameTable:()=>snapshot,sendToHost:async(from:number,to:number,data:Uint8Array)=>{
   expect([from,to]).toEqual([7,8]);sends++;await gate;observed=[...data];return {submission:"submitted"};
  }} as unknown as DirectPlay4NativeSession;
  session.commitNativeJoin(plan,f.found,snapshot,backend);
  const entity=(id:number,owner:string)=>({id,owner,group:false,flags:0,name:{short:"",long:"",shortNull:true,longNull:true},data:[],members:[],parent:0,groupOwner:0});
  session.entities.set(7,entity(7,session.ownKey));session.entities.set(8,entity(8,"native:host"));
  expect(session.send(7,8,0,Uint8Array.of(1))).toBe(0x887700fa);
  expect(session.send(7,0,1,Uint8Array.of(1))).toBe(0x887700fa);
  expect(session.send(8,7,1,Uint8Array.of(1))).toBe(0x88770096);
  expect(session.send(7,8,1,new Uint8Array(60001))).toBe(0x887700fa);
  const bytes=Uint8Array.of(3,4),pending=session.send(7,8,1,bytes) as Promise<number>;bytes[0]=99;
  if(closeEarly)session.close();release();
  expect(await pending).toBe(closeEarly?0x88770136:0);expect(observed).toEqual([3,4]);expect(sends).toBe(1);
  session.dispose();
 }
});
test("native DestroyPlayer removes the local player and its queue only after submission",async()=>{
 for(const closeEarly of [false,true]){
  const f=fixture(),session=new DirectPlaySession(f.net);expect(session.initialize()).toBe(0);
  const discovery=session.beginNativeDiscovery();f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
  const plan=session.prepareNativeJoin(f.table,f.found),description=new Uint8Array(80),view=new DataView(description.buffer);
  view.setUint32(0,80,true);description.set(plan.discovery.instanceGuid,8);description.set(plan.discovery.applicationGuid,24);view.setUint32(56,plan.discovery.reserved1,true);
  const snapshot={command:41,version:14,sessionDescription:[...description],name:null,password:null,players:[],groups:[],shortcuts:[]} as const;
  let release!:()=>void;const gate=new Promise<void>(ok=>release=ok);let destroyed=0;
  const backend={nameTable:()=>snapshot,destroyPlayer:async(id:number)=>{destroyed=id;await gate;return {submission:"submitted"};}} as unknown as DirectPlay4NativeSession;
  session.commitNativeJoin(plan,f.found,snapshot,backend);
  const entity=(id:number,owner:string)=>({id,owner,group:false,flags:0,name:{short:"",long:"",shortNull:true,longNull:true},data:[],members:[],parent:0,groupOwner:0});
  session.entities.set(7,entity(7,session.ownKey));session.entities.set(8,entity(8,"native:host"));
  expect(session.enqueueNativePlayer(8,7,Uint8Array.of(4,5))).toBe(true);
  const invalid=await session.mutate({op:"mutate",action:"destroy",id:8,group:false});expect(invalid.hr).toBe(0x88770096);
  const pending=session.mutate({op:"mutate",action:"destroy",id:7,group:false}) as Promise<any>;
  expect(session.entities.has(7)).toBe(true);expect(session.queue.length).toBe(1);
  if(closeEarly)session.close();release();const result=await pending;
  expect(result.hr).toBe(closeEarly?0x88770136:0);expect(session.entities.has(7)).toBe(false);expect(session.queue.length).toBe(0);expect(destroyed).toBe(7);
  session.dispose();
 }
});
test("opening a virtual session retires an outstanding native join owner",()=>{
 const f=fixture(),session=new DirectPlaySession(f.net);expect(session.initialize()).toBe(0);
 const discovery=session.beginNativeDiscovery();f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
 const plan=session.prepareNativeJoin(f.table,f.found);
 expect(session.create(f.found.desc)).toBe(0);
 expect(plan.signal.aborted).toBe(true);expect(plan.current()).toBe(false);
 session.dispose();
});
test("reentrant close during native owner retirement does not report virtual create success",()=>{
 const f=fixture(),session=new DirectPlaySession(f.net);expect(session.initialize()).toBe(0);
 const discovery=session.beginNativeDiscovery();f.found.nativeEpoch=discovery.epoch;session.cacheDiscovery(f.found);discovery.finish();
 const plan=session.prepareNativeJoin(f.table,f.found);
 plan.signal.addEventListener("abort",()=>session.close(),{once:true});
 expect(session.create(f.found.desc)).toBe(0x88770136);
 expect(session.desc).toBeNull();session.dispose();
});
test("native join plan binds the exact discovery, both listener ACLs and configured route",()=>{
 const f=fixture(),plan=f.make();expect(plan.current()).toBe(true);expect(plan.udpListener).toBe("udp");
 expect(plan.authorizeDestination(plan.destination)).toBe(true);
 expect(plan.authorizeDestination({...plan.destination,port:2})).toBe(false);
 expect(plan.authorizePeer({...f.peer,port:12345})).toBe(true);
 expect(plan.authorizePeer({...f.peer,ip:Uint8Array.of(1,2,3,4)})).toBe(false);
 const snapshot=plan.discovery;snapshot.instanceGuid.fill(0);expect(plan.discovery.instanceGuid[0]).toBe(1);
 plan.close();expect(plan.signal.aborted).toBe(true);expect(plan.current()).toBe(false);
});
test("native join plan ties system authorization to the host snapshot and discovered peer",()=>{
 const f=fixture(),plan=f.make();
 const roster={version:14,players:[{id:6,flags:15,preexisting:false},{id:7,flags:12,versionOrSystemId:6},{id:8,flags:12,versionOrSystemId:6}]} as any;
 expect(plan.authorizeSystem(9,f.peer,6,roster)).toBe(true);
 expect(plan.authorizePlayer({from:7,to:1} as any,f.peer,roster)).toBe(true);
 expect(plan.authorizePlayer({from:8,to:1} as any,f.peer,roster)).toBe(true);
 expect(plan.authorizePlayer({from:6,to:1} as any,f.peer,roster)).toBe(false);
 expect(plan.authorizePlayer({from:99,to:1} as any,f.peer,roster)).toBe(false);
 expect(plan.authorizePlayer({from:7,to:1} as any,{...f.peer,ip:Uint8Array.of(1,2,3,4)},roster)).toBe(false);
 expect(plan.authorizeSystem(9,{...f.peer,ip:Uint8Array.of(1,2,3,4)},6,roster)).toBe(false);
 expect(plan.authorizeSystem(9,f.peer,7,roster)).toBe(false);
 expect(plan.authorizeSystem(0,f.peer,6,roster)).toBe(false);
 f.revoke();expect(plan.authorizeSystem(9,f.peer,6,roster)).toBe(false);expect(plan.signal.aborted).toBe(true);
});
test("native join plan rejects missing policy, capability, source ACL and foreign route",()=>{
 for(const change of [
  (f:ReturnType<typeof fixture>)=>f.net.configureDirectPlay4(),
  (f:ReturnType<typeof fixture>)=>f.net.configureWinsock({provider:"native",hostListener:"other"}),
  (f:ReturnType<typeof fixture>)=>f.net.configureUdpHosts({listeners:[{id:"udp",allowedNodes:[[2,1,1,1,1,1]]}]}),
  (f:ReturnType<typeof fixture>)=>f.net.configureTcpHosts(),
  (f:ReturnType<typeof fixture>)=>f.net.configureGatewayAddresses([]),
 ]){
  const f=fixture();change(f);expect(()=>f.make()).toThrow();
 }
});
test("cache replacement, table generation and policy ABA retire exact plan",()=>{
 for(const change of [
  (f:ReturnType<typeof fixture>)=>f.revoke(),
  (f:ReturnType<typeof fixture>)=>{(f.table as any).generation++;},
  (f:ReturnType<typeof fixture>)=>{f.found.desc.reserved![0]++;},
  (f:ReturnType<typeof fixture>)=>{f.net.configureDirectPlay4({provider:"native",tcpHostListener:"tcp",udpHostListener:"other"});f.net.configureDirectPlay4({provider:"native",tcpHostListener:"tcp",udpHostListener:"udp"});},
 ]){
  const f=fixture(),plan=f.make();change(f);expect(plan.current()).toBe(false);expect(plan.signal.aborted).toBe(true);
 }
});
test("network generation change synchronously aborts the native join plan",()=>{
 const f=fixture(),plan=f.make();f.net.setConnected(false,"test");expect(plan.signal.aborted).toBe(true);expect(plan.current()).toBe(false);
});
