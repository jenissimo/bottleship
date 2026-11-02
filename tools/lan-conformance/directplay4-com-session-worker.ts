import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {DirectPlayNetworkApi} from "../../src/worker/modules/dplayx/network-api";
import {DP,DirectPlaySession} from "../../src/worker/modules/dplayx/session";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {System} from "../../src/worker/core/system";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {BaseComObject,ComObjectFactory} from "../../src/worker/core/com/base-com-object";
import {allocateComObject} from "../../src/worker/core/com/com-memory";
import {acquireDirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";
import {acquireDirectPlay4JoinUdpListener} from "../../src/worker/modules/dplayx/native-wire/join-udp-listener";
import {runDirectPlay4JoinHandshake} from "../../src/worker/modules/dplayx/native-wire/join-handshake";
import {DirectPlay4JoinNameTableOwner} from "../../src/worker/modules/dplayx/native-wire/join-name-table-owner";
import {DirectPlay4CreatePlayer} from "../../src/worker/modules/dplayx/native-wire/create-player";
import {DirectPlay4JoinPending} from "../../src/worker/modules/dplayx/native-wire/join-pending";
import {DirectPlay4NativeSession,nativeSessionDriver} from "../../src/worker/modules/dplayx/native-wire/native-session";
import {DirectPlay4GuestNotificationOwner} from "../../src/worker/modules/dplayx/native-wire/guest-notification-owner";
import {projectDirectPlay4RemotePlayers,projectDirectPlay4RosterChange,directPlay4GuestNotification,installDirectPlay4GuestRoster} from "../../src/worker/modules/dplayx/native-wire/roster-projection";
import {dplayxModule} from "../../src/worker/api/dplayx.api";

let finish!:()=>void,retire!:()=>void,send!:()=>void,transfer!:()=>void,lateId=0;const finished=new Promise<void>(ok=>finish=ok),retired=new Promise<void>(ok=>retire=ok),sendGate=new Promise<void>(ok=>send=ok),transferGate=new Promise<void>(ok=>transfer=ok);
self.onmessage=async({data})=>{
 if(data.command==="late"){lateId=data.id;return;}
 if(data.command==="transfer"){transfer();return;}
 if(data.command==="send"){send();return;}
 if(data.command==="finish"){finish();return;}
 if(data.command==="retire"){retire();return;}
 let ns:ChildProcessNetworkNamespace|undefined,api:DirectPlayNetworkApi|undefined,obj:BaseComObject|undefined,guest:DirectPlaySession|undefined,guestApi:DirectPlayNetworkApi|undefined,guestObj:BaseComObject|undefined,guestNetwork:LanNetwork|undefined,guestEvent=0,nativeEvent=0;const controller=new AbortController();
 try {
  const network=new LanNetwork();ns=new ChildProcessNetworkNamespace(network,data.boot);
  await ns.barrier();ns.synchronizeState();
  if(network.tcpHostListenV1?.listeners[0]?.id!=="game")throw Error("missing capability");
  if(network.directPlay4?.tcpHostListener!=="game"||network.directPlay4?.udpHostListener!=="udp")throw Error("missing DirectPlay 4 policy");
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
    const plan=session.prepareNativeJoin(table,found);
    const driver=nativeSessionDriver(table,plan.udpListener,{destination:plan.destination,
     authorizeDestination:plan.authorizeDestination,authorizePeer:plan.authorizePeer,
     onOwnershipUncertain:e=>{self.postMessage({kind:"ownershipUncertain",error:String(e)});ns!.close();},
     timeoutMs:8000,maxFrameBytes:65536,maxEntries:1024,maxPendingBytes:65536,discovery:plan.discovery});
    const baseReceive=DirectPlay4JoinPending.prototype.receive;
    DirectPlay4JoinPending.prototype.receive=function(bytes,header,flags,source){
     const result=baseReceive.call(this,bytes,header,flags,source);
     if(result.kind==="queued"&&bytes.length>=16){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      if(v.getUint32(0,true)===0x79616c70&&v.getUint16(4,true)===11&&v.getUint32(12,true)===data.tempId)
       self.postMessage({kind:"pendingDelete",id:data.tempId,peer:{ip:[...(source?.ip??[])],port:source?.port}});
      if(v.getUint32(0,true)===0x79616c70&&v.getUint16(4,true)===8)
       self.postMessage({kind:"pendingCreate",id:v.getUint32(12,true),bytes:[...bytes],peer:{ip:[...(source?.ip??[])],port:source?.port}});
     }return result;
    };
    const handshake=driver.handshake;
    driver.handshake=async(...args)=>{const result=await handshake(...args);
     if(!result.table.players.some(p=>p.id===data.tempId))throw Error("temporary player missing from staged table");
     self.postMessage({kind:"handshakeHeld",tempId:data.tempId});await transferGate;return result;
    };
    let hostId=0,appId=0,guestId=0,guestLive=false,live=true,guestDelivery:DirectPlay4GuestNotificationOwner|undefined,nativeDelivery:DirectPlay4GuestNotificationOwner|undefined,guestCall!:(method:string,args:number[],wide:boolean)=>any;const nonce=new DataView(Uint8Array.from(data.guid).buffer).getUint32(0,true);
    const burstExpected=data.burstCount;if(burstExpected!==0&&burstExpected!==300)throw Error("invalid burst count");
    let got!:(x:any)=>void,fail!:(e:Error)=>void,burstDone!:()=>void,burstFail!:(e:Error)=>void,burstReceived=0,firstReceived=false;
    const playerEvent=new Promise<any>((ok,no)=>{got=ok;fail=no;}),burstEvent=new Promise<void>((ok,no)=>{burstDone=ok;burstFail=no;});void playerEvent.catch(()=>{});void burstEvent.catch(()=>{});if(!burstExpected)burstDone();
    const native=new DirectPlay4NativeSession(driver,()=>live&&plan.current(),{
     playerDelivery:"callback",
     onRosterChange:change=>{const ids=(x:typeof change.before)=>x.players.map(p=>p.id),message=directPlay4GuestNotification(change);self.postMessage({kind:"rosterChange",operation:change.kind,id:change.playerId,before:ids(change.before),after:ids(change.after),beforeProjected:projectDirectPlay4RemotePlayers(change.before),afterProjected:projectDirectPlay4RemotePlayers(change.after),notification:projectDirectPlay4RosterChange(change),guest:message});
      if(nativeDelivery){const localIds=[...session.entities.values()].filter((entity:any)=>!entity.group&&entity.owner===session.ownKey).map((entity:any)=>entity.id);
       if(!nativeDelivery.applyRosterChanges(localIds,change)||session.entities.has(change.playerId)!==(change.kind==="create")||session.queue.length!==localIds.length)throw Error("native session live roster update failed");
       while(session.queue.length)session.removeMessage(0);
      }
      if(guestLive){if(!guest)throw Error("guest session unavailable");
       if(!system.scheduler.resetEvent(guestEvent)||(resource.getKernelObject(guestEvent) as any)?.signaled)throw Error("guest event reset failed");
       if(!guestDelivery?.applyRosterChange(guestId,change)||guest.queue.length!==1||!(resource.getKernelObject(guestEvent) as any)?.signaled)throw Error("guest queue or event unavailable");
       u32(0x4500,0);u32(0x4504,0);u32(0x4508,0);
       const shortHr=guestCall("Receive",[0x4504,0x4508,1,0,0x4500],true),required=read(0x4500);
       if(shortHr!==DP.BUFFERTOOSMALL||required<48||guest.queue.length!==1)throw Error("guest COM short-buffer contract");
       const create=change.kind==="create";
       const unpack=(wide:boolean)=>{const base=wide?0x12000:0x14000;u32(0x4500,4096);u32(0x4504,0);u32(0x4508,0);
        const hr=guestCall("Receive",[0x4504,0x4508,wide?9:1,base,0x4500],wide);if(hr!==DP.OK||read(0x4504)!==0||read(0x4508)!==guestId)throw Error("guest COM Receive unavailable");
        const packed=mem.slice(base,base+read(0x4500)),v=new DataView(packed.buffer,packed.byteOffset,packed.byteLength);
        const textAt=(field:number)=>{const start=v.getUint32(field,true)-base;if(start<0||start>=packed.length)throw Error("guest name pointer");let out="";for(let i=start;i+(wide?1:0)<packed.length;i+=wide?2:1){const c=wide?v.getUint16(i,true):v.getUint8(i);if(!c)return out;out+=String.fromCharCode(c);}throw Error("guest name unterminated");};
        const dataOffset=v.getUint32(create?16:20,true)-base,dataLength=v.getUint32(create?20:24,true);if(dataOffset<0||dataLength>packed.length-dataOffset)throw Error("guest data pointer");
        return {type:v.getUint32(0,true),playerType:v.getUint32(4,true),id:v.getUint32(8,true),count:create?v.getUint32(12,true):message.currentPlayers,recipient:guestId,shortName:textAt(create?32:36),longName:textAt(create?36:40),data:[...packed.subarray(dataOffset,dataOffset+dataLength)]};};
       const wideResult=unpack(true);if(guest.queue.length!==1)throw Error("guest COM PEEK consumed message");
       const ansiResult=unpack(false);self.postMessage({kind:"guestMessage",...wideResult,ansi:ansiResult,event:guestEvent,eventSignaled:!!(resource.getKernelObject(guestEvent) as any)?.signaled,shortHr,required});if(guest.queue.length!==0)throw Error("guest COM Receive did not dequeue");}
     },
     onSystem:(frame,peer)=>{const roster=native.nameTable();self.postMessage({kind:"system",command:frame.command,bytes:[...frame.message],players:roster?.players.map((p:any)=>p.id),count:roster?new DataView(Uint8Array.from(roster.sessionDescription).buffer).getUint32(44,true):undefined,peer:{ip:[...(peer.ip??[])],port:peer.port}});},
     authorizeHost:id=>id===hostId,
     authorizeSystem:plan.authorizeSystem,
     authorizePlayer:plan.authorizePlayer,
     onPlayer:(frame,peer)=>{
      if(!nativeEvent||!system.scheduler.resetEvent(nativeEvent)||!nativeDelivery?.deliverPlayer(frame.from,frame.to,frame.data)||
         session.queue.length!==1||!(resource.getKernelObject(nativeEvent) as any)?.signaled)throw Error("native COM player delivery unavailable");
      const nativeReceive=(flags:number,address:number)=>{u32(0x4500,4096);u32(0x4504,0);u32(0x4508,0);
       const hr=call("Receive",[0x4504,0x4508,flags,address,0x4500]);
       if(hr!==DP.OK||read(0x4504)!==frame.from||read(0x4508)!==frame.to)throw Error("native COM Receive failed");
       return [...mem.slice(address,address+read(0x4500))];};
      const nativePeek=nativeReceive(9,0x16000);if(session.queue.length!==1)throw Error("native COM PEEK consumed message");
      const nativeData=nativeReceive(1,0x18000);if(session.queue.length||JSON.stringify(nativePeek)!==JSON.stringify([...frame.data])||JSON.stringify(nativeData)!==JSON.stringify(nativePeek))throw Error("native COM Receive payload mismatch");
      if(!guestLive||!guest||!system.scheduler.resetEvent(guestEvent)||!guestDelivery?.deliverPlayer(frame.from,guestId,frame.data)||!(resource.getKernelObject(guestEvent) as any)?.signaled)throw Error("guest player delivery unavailable");
      u32(0x4500,0);u32(0x4504,0);u32(0x4508,0);const shortHr=guestCall("Receive",[0x4504,0x4508,1,0,0x4500],true),required=read(0x4500);
      if(shortHr!==DP.BUFFERTOOSMALL||required!==frame.data.length||guest.queue.length!==1)throw Error("guest player short-buffer contract");
      const receivePlayer=(wide:boolean)=>{const address=wide?0x12000:0x14000;u32(0x4500,4096);u32(0x4504,0);u32(0x4508,0);
       const hr=guestCall("Receive",[0x4504,0x4508,wide?9:1,address,0x4500],wide);if(hr!==DP.OK||read(0x4504)!==frame.from||read(0x4508)!==guestId)throw Error("guest player COM Receive failed");
       return [...mem.slice(address,address+read(0x4500))];};
      const peek=receivePlayer(true);if(guest.queue.length!==1)throw Error("guest player PEEK consumed message");const received=receivePlayer(false);if(guest.queue.length!==0)throw Error("guest player not dequeued");
      self.postMessage({kind:"guestPlayerMessage",from:frame.from,to:guestId,peek,received,shortHr,required,event:guestEvent,eventSignaled:!!(resource.getKernelObject(guestEvent) as any)?.signaled});
      const payload=new TextDecoder().decode(frame.data);
      if(!firstReceived&&payload==="host-"+nonce){firstReceived=true;got({from:frame.from,to:frame.to,data:[...frame.data],peer:{ip:[...(peer.ip??[])],port:peer.port}});}
      else if(firstReceived&&burstReceived<burstExpected&&payload==="burst-"+nonce+"-"+burstReceived){burstReceived++;if(burstReceived===burstExpected)burstDone();}
      else throw Error("unexpected player payload or order: "+payload);
     },
     onFailure:e=>{fail(e);burstFail(e);self.postMessage({kind:"error",error:String(e)});}},plan.signal,()=>plan.close());
    const snapshot=await native.open();
    if(snapshot.players.some(p=>p.id===data.tempId))throw Error("pending deleted player published");
    const late=snapshot.players.find(p=>p.id===lateId);
    if(!late||!late.shortName||Buffer.from(late.shortName).toString("utf16le").replace(/\0+$/,"")!=="Late")throw Error("pending created player not published");
    if(new DataView(Uint8Array.from(snapshot.sessionDescription).buffer).getUint32(44,true)!==2)throw Error("pending player count not rebuilt");
    session.commitNativeJoin(plan,found,snapshot,native);
    if(!plan.current()||session.desc?.instance!==found.desc.instance||session.entities.size!==2)throw Error("native session publication failed");
    nativeDelivery=new DirectPlay4GuestNotificationOwner(session,()=>live&&plan.current(),error=>{native.close();self.postMessage({kind:"error",error:String(error)});});
    const hosts=snapshot.players.filter(p=>p.shortName&&Buffer.from(p.shortName).toString("utf16le").replace(/\0+$/,"")==="Host");
    if(hosts.length!==1)throw Error("native host player not unique");hostId=hosts[0].id;
    const systems=snapshot.players.filter(p=>p.preexisting);if(systems.length!==1)throw Error("native local system player not unique");const systemId=systems[0].id;
    u32(0x4300,16);u32(0x4304,0);u32(0x4308,0x4400);u32(0x430c,0);
    for(let i=0;i<"owned-client".length;i++)view.setUint16(0x4400+i*2,"owned-client".charCodeAt(i),true);view.setUint16(0x4400+"owned-client".length*2,0,true);
    nativeEvent=system.scheduler.syncObjects.createEvent(true,false);if(!nativeEvent)throw Error("native COM event creation failed");
    u32(0x4100,0xfeed);const createdNative=await call("CreatePlayer",[0x4100,0x4300,nativeEvent,0,0,0]);
    const resumedNative=createdNative.resumeOnOwner?.({esp:0x9000,returnAddr:0x7000,mem});
    if(!resumedNative||typeof resumedNative!=="object"||resumedNative.value!==DP.OK||read(0x4100)!==0xfeed||resumedNative.deferredWrites?.length!==1)throw Error("native COM CreatePlayer failed");
    const write=resumedNative.deferredWrites[0];if(write.address!==0x4100||write.size!==4||!write.value)throw Error("native COM player ID write invalid");
    u32(write.address,write.value);appId=read(0x4100);const app={playerId:appId,submission:"submitted"};
    if(session.entities.get(appId)?.owner!==session.ownKey)throw Error("native COM player not published");
    // Exercise COM Receive and event signaling with an isolated synthetic owner.
    guestNetwork=new LanNetwork(Uint8Array.of(2,0,0,0,0,77));guestNetwork.attach({send:()=>true,close(){}});
    guestApi=new DirectPlayNetworkApi(process,()=>tables,guestNetwork,()=>table);const guestExports:any={};guestApi.install(guestExports);
    guestObj=new TestCom(0x6000);const guestPtr=allocateComObject(process.memory,mem,0x6000);resource.mapAddressToHandle(guestPtr,guestObj.handle);
    guestCall=(method,args,wide)=>guestExports[(wide?"IDirectPlay4_":"IDirectPlay4A_")+method]({esp:0x9000},mem,[guestPtr,...args]);
    guestEvent=system.scheduler.syncObjects.createEvent(true,false);if(!guestEvent)throw Error("guest event creation failed");
    if(guestCall("InitializeConnection",[base,0],true)!==DP.OK)throw Error("guest COM initialization failed");
    u32(0x4000,80);u32(0x4028,4);bytes(0x4018,"1".repeat(32));if(guestCall("Open",[0x4000,2],true)!==DP.OK)throw Error("guest COM open failed");
    const created=await guestCall("CreatePlayer",[0x4100,0,guestEvent,0,0,0],true);if(created!==DP.OK)throw Error("guest COM player failed");
    guestId=read(0x4100);guest=(guestApi as any).states.get(guestObj.handle)?.session;if(!guestId||!guest)throw Error("guest COM owner missing");
    installDirectPlay4GuestRoster(guest,snapshot,()=>live&&plan.current());
    while(guest.queue.length)guest.removeMessage(0);guestLive=true;
    guestDelivery=new DirectPlay4GuestNotificationOwner(guest,()=>guestLive&&live&&plan.current(),error=>{guestLive=false;native.close();self.postMessage({kind:"error",error:String(error)});});
    self.postMessage({kind:"appReady",appId,hostId,systemId,guestId,guestEvent,hostWireFlags:hosts[0].flags,lateWireFlags:late.flags,projected:projectDirectPlay4RemotePlayers(snapshot),submission:app.submission});
    await sendGate;const outgoing=new TextEncoder().encode("client-"+nonce);mem.set(outgoing,0x1a000);
    const sent=await call("Send",[appId,hostId,1,0x1a000,outgoing.length]);
    if(!sent || typeof sent!=="object" || sent.resumeOnOwner?.({esp:0x9000,returnAddr:0x7000,mem})!==DP.OK)throw Error("native COM Send failed");
    self.postMessage({kind:"sent",appId,hostId,submission:"submitted"});
    const frame=await playerEvent;await burstEvent;
    if(frame.from!==hostId||frame.to!==appId||new TextDecoder().decode(Uint8Array.from(frame.data))!=="host-"+nonce||!Number.isInteger(frame.peer.port)||frame.peer.port<1)throw Error("wrong session player callback");
    if(native.receive(hostId,appId,false)!==undefined)throw Error("callback delivery retained a native queue copy");
    self.postMessage({kind:"result",result:{rows,cache,appId,hostId,submission:app.submission,frame,burstReceived,nativeQueueEmpty:true,sessionDescription:[...snapshot.sessionDescription],players:snapshot.players.length,current:session.isCurrentNativeDiscovery(found)}});
    await finished;const destroyResult=await call("DestroyPlayer",[appId]);
    if(!destroyResult || typeof destroyResult!=="object" || destroyResult.resumeOnOwner?.({esp:0x9000,returnAddr:0x7000,mem})!==DP.OK || session.entities.has(appId))throw Error("native COM DestroyPlayer failed");
    self.postMessage({kind:"destroyed",appId,systemId,submission:"submitted"});
    await retired;await native.gracefulClose();live=false;guestLive=false;guestDelivery?.close();guestApi?.reset();
    const guestHandle=guestObj!.handle,eventHandle=guestEvent;resource.unregisterComObject(guestHandle);guestObj=undefined;guestNetwork?.attach(null);
    if(!system.scheduler.syncObjects.closeEvent(eventHandle))throw Error("guest event close failed");guestEvent=0;
    if(!system.scheduler.syncObjects.closeEvent(nativeEvent))throw Error("native event close failed");nativeEvent=0;
    const guestComClosed=!resource.getComObject(guestHandle),guestEventClosed=!resource.getKernelObject(eventHandle);
    if(!guestComClosed||!guestEventClosed)throw Error("guest owner resources retained");
    native.close();plan.close();await ns.finishProcessLifetime();ns.close();api.reset();resource.unregisterComObject(obj.handle);obj=undefined;self.postMessage({kind:"retired",guestComClosed,guestEventClosed});return;
   }
  }
  throw Error("too many callbacks");
 }catch(e){controller.abort();try{guestApi?.reset();if(guestObj)SystemResourceProvider.getInstance().unregisterComObject(guestObj.handle);guestNetwork?.attach(null);if(guestEvent)System.getInstance().scheduler.syncObjects.closeEvent(guestEvent);guestEvent=0;if(nativeEvent)System.getInstance().scheduler.syncObjects.closeEvent(nativeEvent);nativeEvent=0;api?.reset();if(obj)SystemResourceProvider.getInstance().unregisterComObject(obj.handle);ns?.close();}catch{}self.postMessage({kind:"error",error:String(e)});}
};
