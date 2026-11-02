import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {DirectPlayNetworkApi} from "../../src/worker/modules/dplayx/network-api";
import {DP} from "../../src/worker/modules/dplayx/session";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {System} from "../../src/worker/core/system";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {BaseComObject,ComObjectFactory} from "../../src/worker/core/com/base-com-object";
import {allocateComObject} from "../../src/worker/core/com/com-memory";
import {acquireDirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";
import {acquireDirectPlay4JoinUdpListener} from "../../src/worker/modules/dplayx/native-wire/join-udp-listener";
import {runDirectPlay4JoinHandshake} from "../../src/worker/modules/dplayx/native-wire/join-handshake";
import {dplayxModule} from "../../src/worker/api/dplayx.api";

self.onmessage=async({data})=>{
 let ns:ChildProcessNetworkNamespace|undefined,api:DirectPlayNetworkApi|undefined,obj:BaseComObject|undefined;const controller=new AbortController();
 try {
  const network=new LanNetwork();ns=new ChildProcessNetworkNamespace(network,data.boot);
  await ns.barrier();ns.synchronizeState();
  if(network.tcpHostListenV1?.listeners[0]?.id!=="game")throw Error("missing capability");
  const table=createWsaActorTable(network,ns.socketActorClient());await ns.barrier();
  const mem=new Uint8Array(2*1024*1024),view=new DataView(mem.buffer),u32=(p:number,n:number)=>view.setUint32(p,n>>>0,true),read=(p:number)=>view.getUint32(p,true);
  const bytes=(p:number,s:string)=>mem.set(Uint8Array.from(s.match(/../g)!,x=>parseInt(x,16)),p);
  let next=0x100000;
  const alloc=(size:number)=>{const p=next;next+=(size+15)&~15;return p;};
  const callbacks:any[]=[],saved:any[]=[];
  const process:any={getCurrentMemory:()=>mem,memory:{alloc,allocSystemBlock:alloc,free(){},freeSystemBlock(){}},
   addressSpace:{validateRange:(p:number,n:number,perms:string)=>p>=0x1000&&p+n<=mem.length&&(!perms.includes("x")||(p>=0x7000&&p<0x8000))},
   dispatcher:{callbackManager:{
    saveSuspendedThunkContext:(frame:any,cleanup:number)=>{saved.push({frame,cleanup});return 7;},
    abandonSuspendedFrame(){},
    invokeCallback:(_target:number,args:number[],_cleanup:number,done:(n:number)=>number|null)=>{callbacks.push({args,done});return {callbackId:callbacks.length};},
    getPendingCallback:(id:number)=>callbacks[id-1]
   }}};
  const system=System.getInstance(),resource=SystemResourceProvider.getInstance();system.process=process;Mem.bind(()=>mem);
  class TestCom extends BaseComObject {constructor(vtable:number){super("0ab1c531-4745-11d1-a7a1-0000f803abfc",vtable);}protected destroy():void{}}
  const tables=Object.fromEntries((dplayxModule.interfaces??[]).map((iface,i)=>[iface.name,{address:0x6000+i*0x100,size:iface.methods.length}]));
  for(const iface of dplayxModule.interfaces??[])if(iface.iid)ComObjectFactory.register(iface.iid,TestCom);
  api=new DirectPlayNetworkApi(process,()=>tables,network,()=>table);const exports:any={};api.install(exports);
  obj=new TestCom(0x6000);const primary=allocateComObject(process.memory,mem,0x6000);resource.mapAddressToHandle(primary,obj.handle);
  const call=(method:string,args:number[])=>exports["IDirectPlay4_"+method]({esp:0x9000},mem,[primary,...args]);
  const base=0x2000;bytes(base,"60f518132c91d0119daa00a0c90a43cb");u32(base+16,4);u32(base+20,112);
  bytes(base+24,"c016d907afe0cf119c4e00a0c905425e");u32(base+40,16);bytes(base+44,"e05ee9367785cf11960c0080c7534e82");
  bytes(base+60,"a04da5c4afe0cf119c4e00a0c905425e");
  const ipBytes=new TextEncoder().encode(data.hostIp),ipText=new Uint8Array(ipBytes.length+1);ipText.set(ipBytes);u32(base+76,ipText.length);mem.set(ipText,base+80);u32(base+20,80+ipText.length);
  const init=call("InitializeConnection",[base,0]);if(init!==DP.OK)throw Error("InitializeConnection "+init);
  u32(0x3000,80);mem.set(data.guid,0x3018);u32(0x9000,0x7000);
  const result=await call("EnumSessions",[0x3000,3500,0x7000,0x4321,0]);
  if(result.value!==DP.OK)throw Error("EnumSessions "+result.value);
  if(!result.startCallbackChain?.({esp:0x9000}))throw Error("callback chain did not start");
  const rows:any[]=[];
  for(let index=0;index<8;index++){
   const cb=callbacks[index];if(!cb)throw Error("missing callback");
   const [desc,timeoutPtr,flags,context]=cb.args;
   if(context!==0x4321||!timeoutPtr)throw Error("callback metadata");
   if(desc){
    const namePtr=read(desc+48);let name="";
    if(namePtr){for(let p=namePtr;p+1<mem.length;p+=2){const c=view.getUint16(p,true);if(!c)break;name+=String.fromCharCode(c);if(name.length>1024)throw Error("name too long");}}
    rows.push({size:read(desc),flags:read(desc+4),instanceGuid:[...mem.slice(desc+8,desc+24)],applicationGuid:[...mem.slice(desc+24,desc+40)],maxPlayers:read(desc+40),currentPlayers:read(desc+44),name,reserved:[read(desc+56),read(desc+60)],callbackFlags:flags,timeout:read(timeoutPtr),context});
    if(cb.done(1)!==null)throw Error("row RET did not continue");cb.enumerationState.continueEnumeration();
   }else{
    if(flags!==1||cb.done(1)!==DP.OK)throw Error("timeout callback RET");
    if(rows.length!==1)throw Error("expected exactly one COM session");
    const session=(api as any).states.get(obj.handle).session;
    const key=Buffer.from(rows[0].instanceGuid).toString("hex"),found=session.discovered.get(key);
    if(!found?.native||!session.isCurrentNativeDiscovery(found)||!found.nativeProvider)throw Error("missing current native cache owner");
    const sockaddr=found.nativeProvider.sockaddr,addr=found.address,peer=found.nativeProvider.peer;
    if(Buffer.from(sockaddr.subarray(4,8)).toString("hex")!==Buffer.from(data.aliasIp).toString("hex")||addr.port!==data.aliasPort||!found.desc.reserved)
      throw Error("advertised endpoint differs from explicitly configured lab NAT alias");
    if(rows[0].reserved[0]!==found.desc.reserved[0])throw Error("reserved1 callback/cache mismatch");
    const cache={instance:found.desc.instance,application:found.desc.application,reserved:found.desc.reserved,version:found.nativeProvider.version,sockaddr:[...sockaddr],address:addr,peer:{ip:[...(peer.ip??[])],port:peer.port}};
    self.postMessage({kind:"cache",cache,callbackReserved:rows[0].reserved});
    const tcp=await acquireDirectPlay4JoinListener(table,8000,controller.signal);
    const udp=await acquireDirectPlay4JoinUdpListener(table,"udp",8000,controller.signal);
    self.postMessage({kind:"listeners",tcp:tcp.address,udp:udp.address});
    const destination={family:2,node:Uint8Array.from(addr.node),ip:Uint8Array.from(data.aliasIp),port:addr.port};
    const handshake=await runDirectPlay4JoinHandshake({table,tcp,udp,destination,signal:controller.signal,
     current:()=>session.isCurrentNativeDiscovery(found),
     authorizeDestination:a=>a.port===addr.port&&!!a.ip&&a.ip.every((v,i)=>v===data.aliasIp[i]),
     authorizePeer:a=>!!a.ip&&a.ip.every((v,i)=>v===data.hostIp.split(".").map(Number)[i]),
     onOwnershipUncertain:e=>{self.postMessage({kind:"ownershipUncertain",error:String(e)});ns!.close();},
     timeoutMs:8000,maxFrameBytes:65536,maxEntries:1024,maxPendingBytes:65536,discovery:{version:found.nativeProvider.version,flags:found.desc.flags,instanceGuid:Uint8Array.from(rows[0].instanceGuid),applicationGuid:Uint8Array.from(rows[0].applicationGuid),reserved1:found.desc.reserved[0]}});
    self.postMessage({kind:"result",result:{rows,cache,playerId:handshake.playerId,sessionDescription:[...handshake.table.sessionDescription],players:handshake.table.players.length,tcp:tcp.address,udp:udp.address,current:session.isCurrentNativeDiscovery(found)}});
    handshake.cancel();await ns.finishProcessLifetime();ns.close();api.reset();resource.unregisterComObject(obj.handle);obj=undefined;return;
   }
  }
  throw Error("too many callbacks");
 }catch(e){controller.abort();try{api?.reset();if(obj)SystemResourceProvider.getInstance().unregisterComObject(obj.handle);ns?.close();}catch{}self.postMessage({kind:"error",error:String(e)});}
};
