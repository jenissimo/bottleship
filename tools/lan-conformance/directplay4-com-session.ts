/** COM native discovery cache -> isolated handshake over explicit owned laboratory NAT alias. */
import {createHash,randomBytes} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {networkInterfaces} from "node:os";
import {execFileSync} from "node:child_process";
import {createServer,createConnection,type Socket} from "node:net";
import {createSocket} from "node:dgram";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
const [binary,gcc,output,transport,hostIp,aliasIp,portText]=process.argv.slice(2),aliasPort=Number(portText),parts=aliasIp?.split(".").map(Number);
if(process.argv.length!==9||!["websocket","polling"].includes(transport)||!Object.values(networkInterfaces()).flat().some(x=>x?.family==="IPv4"&&x.address===hostIp&&!x.internal)||!parts||parts.length!==4||parts.some(x=>!Number.isInteger(x)||x<0||x>255)||!Number.isInteger(aliasPort)||aliasPort<1||aliasPort>65535)throw Error("usage: relay gcc new-dir transport local-ip observed-advertised-ip observed-advertised-port");
mkdirSync(output,{recursive:false});const dir=resolve(output),reusedHostRun=process.env.BS_DP4_HOST_RUN?resolve(process.env.BS_DP4_HOST_RUN):undefined,exe=join(reusedHostRun??dir,"host.exe"),ready=join(dir,"ready.bin");
const src=resolve("tools/lan-conformance/directplay4-session-native-host.c"),workerPath=resolve("tools/lan-conformance/directplay4-com-session-worker.ts");
const runtime=["src/network-config.ts","src/worker/modules/dplayx/network-api.ts","src/worker/modules/dplayx/session.ts","src/worker/modules/dplayx/native-wire/connection.ts","src/worker/modules/dplayx/native-wire/lan-discovery.ts","src/worker/modules/dplayx/native-wire/discovery.ts","src/worker/modules/dplayx/native-wire/peer-address.ts","src/worker/modules/dplayx/native-wire/join-handshake.ts","src/worker/modules/dplayx/native-wire/join-plan.ts","src/worker/modules/dplayx/native-wire/native-session.ts","src/worker/modules/dplayx/native-wire/join-name-table-owner.ts","src/worker/modules/dplayx/native-wire/create-player.ts","src/worker/modules/dplayx/native-wire/create-message.ts","src/worker/modules/dplayx/native-wire/remote-player-mutation.ts","src/worker/modules/dplayx/native-wire/roster-projection.ts","src/worker/modules/dplayx/native-wire/guest-notification-owner.ts","src/worker/modules/dplayx/native-wire/host-system-authorization.ts","src/worker/modules/dplayx/native-wire/destroy-player.ts","src/worker/modules/dplayx/native-wire/join-channel.ts","src/worker/modules/dplayx/native-wire/mixed-tcp-stream.ts","src/worker/modules/dplayx/native-wire/player-tcp.ts","src/worker/modules/dplayx/native-wire/join-transaction.ts","src/worker/modules/dplayx/native-wire/join-pending.ts","src/worker/modules/dplayx/native-wire/join-listener.ts","src/worker/modules/dplayx/native-wire/join-udp-listener.ts","src/worker/modules/dplayx/native-wire/player-id.ts","src/worker/modules/dplayx/native-wire/packed-player.ts","src/worker/modules/dplayx/native-wire/name-table.ts","src/worker/modules/dplayx/native-wire/tcp-frame.ts","src/worker/modules/dplayx/native-wire/tcp-stream.ts","src/worker/modules/wsa-network.ts","src/worker/modules/wsa-actor-kernel.ts","src/worker/modules/wsa-actor-table.ts","src/worker/modules/wsa-actor-worker.ts","src/worker/modules/wsa-actor-response.ts","src/worker/core/network-namespace.ts","src/worker/core/scheduler/scheduler.ts","src/worker/core/scheduler/sync-objects.ts","src/worker/core/resources/system-resource-provider.ts","src/worker/core/cpu/hypercall-data.ts","src/worker/net/lan-network.ts","src/worker/net/relay-link.ts"];
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes=()=>({binary:sha(binary),gcc:sha(gcc),source:sha(src),runner:sha(import.meta.filename),worker:sha(workerPath),runtime:Object.fromEntries(runtime.map(p=>[p,sha(p)]))});
const bounded=async<T>(p:Promise<T>,ms=10000):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,no)=>timer=setTimeout(()=>no(Error("deadline")),ms))]);}finally{clearTimeout(timer);}};
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
const env={Path:dirname(resolve(gcc))+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
let build:ReturnType<typeof Bun.spawn>|undefined,host:ReturnType<typeof Bun.spawn>|undefined,relay:ReturnType<typeof Bun.spawn>|undefined,root:RootNetworkNamespace|undefined,worker:Worker|undefined,lease:{close():void}|undefined,proxy:ReturnType<typeof createServer>|undefined;
const sockets=new Set<Socket>();let buildDone:Promise<any>|undefined,hostDone:Promise<any>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,err:Promise<string>|undefined,buffer="",before:any,after:any,exeBefore:string|undefined,failed:unknown,retired:any,exit:number|undefined,eof=false,forced=false,hostExited:number|undefined,proxyError:string|undefined;
const burstCount=process.env.BS_DP4_BURST==="1"?300:0,burstRecords=process.env.BS_DP4_BURST_RECORDS==="1024"?1024:undefined;
const report:any={transport,hostIp,aliasIp,aliasPort,burstCount,burstRecords,nonce:randomBytes(4).readUInt32LE()||1,capabilityInjected:false,laboratoryNatAlias:true,proxyConnections:[]};
const track=(p:ReturnType<typeof Bun.spawn>)=>Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]).then(([exit,stdout,stderr])=>({pid:p.pid,exit,stdout,stderr,stdoutEof:true,stderrEof:true}));
async function line(){for(;;){const i=buffer.indexOf("\n");if(i>=0){const x=buffer.slice(0,i);buffer=buffer.slice(i+1);return x;}const r=await reader!.read();if(r.done)throw Error("relay EOF");buffer+=new TextDecoder().decode(r.value,{stream:true});}}
function snapshot(proto:"tcp"|"udp"){return execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p",proto],{encoding:"utf8",timeout:2000,maxBuffer:2*1024*1024}).split(/\r?\n/).map(x=>x.trim().split(/\s+/)).filter(x=>x[0]===proto.toUpperCase());}
function listeners(pid:number){return snapshot("tcp").filter(x=>x[3]==="LISTENING"&&Number(x[4])===pid);}
async function rebind(port:number,udp=false){
 const until=Date.now()+10000;for(;;){
  if(udp){const p=createSocket("udp4");try{await bounded(new Promise<void>((ok,no)=>{p.once("error",no);p.bind({address:hostIp,port,exclusive:true},()=>ok());}));await bounded(new Promise<void>(ok=>p.close(()=>ok())));return;}catch(e){try{p.close();}catch{}if((e as NodeJS.ErrnoException).code!=="EADDRINUSE"||Date.now()>until)throw e;}}
  else{const p=createServer();try{await bounded(new Promise<void>((ok,no)=>{p.once("error",no);p.listen({host:hostIp,port,exclusive:true},ok);}));await bounded(new Promise<void>((ok,no)=>p.close(e=>e?no(e):ok())));return;}catch(e){try{p.close();}catch{}if((e as NodeJS.ErrnoException).code!=="EADDRINUSE"||Date.now()>until)throw e;}}
  await new Promise(ok=>setTimeout(ok,20));
 }
}
function registered(sock:Socket){sockets.add(sock);sock.on("close",()=>sockets.delete(sock));sock.on("error",e=>{proxyError=String(e);sock.destroy();});return sock;}
try{
 before=hashes();
 if(reusedHostRun){
  // Reuse only an unchanged executable from a successful owned run. Keeping
  // its existing path avoids creating a new firewall prompt on every run.
  const evidence=JSON.parse(readFileSync(join(reusedHostRun,"result.json"),"utf8"));
  check(evidence.error===null&&evidence.report?.hostProcess?.exit===0&&evidence.report?.cleanup?.host==="ok"&&
   evidence.before?.source===before.source&&evidence.after?.source===before.source&&evidence.before?.gcc===before.gcc&&evidence.after?.gcc===before.gcc&&
   typeof evidence.exeBefore==="string"&&evidence.exeBefore===evidence.exeAfter&&sha(exe)===evidence.exeBefore,"reused host provenance mismatch");
  exeBefore=evidence.exeBefore;report.build={reused:true,sourceRun:reusedHostRun,sha256:exeBefore};
 }else{
  build=Bun.spawn([resolve(gcc),"-O1","-o",exe,src,"-lole32","-ldxguid","-luuid"],{env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});buildDone=track(build);report.build=await bounded(buildDone,15000);check(report.build.exit===0,"host compile failed");exeBefore=sha(exe);
 }
 host=Bun.spawn([exe,String(report.nonce),ready],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});const child=host;child.exited.then(x=>hostExited=x);
 let queryOk!:(v:string)=>void,destroyQueryOk!:(v:string)=>void,systemBeforeOk!:(v:string)=>void,systemAfterOk!:(v:string)=>void,tempCreateOk!:(v:string)=>void,tempDeleteOk!:(v:string)=>void,hostCountOk!:(v:string)=>void,lateCreateOk!:(v:string)=>void,lateCountOk!:(v:string)=>void;
 let playerFlagsOk!:(v:string)=>void;const playerFlags=new Promise<string>(ok=>playerFlagsOk=ok);
 let liveCreateOk!:(v:string)=>void,liveDeleteOk!:(v:string)=>void,liveCreateCountOk!:(v:string)=>void,liveDeleteCountOk!:(v:string)=>void;
 const liveCreate=new Promise<string>(ok=>liveCreateOk=ok),liveDelete=new Promise<string>(ok=>liveDeleteOk=ok),liveCreateCount=new Promise<string>(ok=>liveCreateCountOk=ok),liveDeleteCount=new Promise<string>(ok=>liveDeleteCountOk=ok);
 const query=new Promise<string>(ok=>queryOk=ok),destroyQuery=new Promise<string>(ok=>destroyQueryOk=ok),systemBefore=new Promise<string>(ok=>systemBeforeOk=ok),systemAfter=new Promise<string>(ok=>systemAfterOk=ok),tempCreate=new Promise<string>(ok=>tempCreateOk=ok),tempDelete=new Promise<string>(ok=>tempDeleteOk=ok),hostCount=new Promise<string>(ok=>hostCountOk=ok),lateCreate=new Promise<string>(ok=>lateCreateOk=ok),lateCount=new Promise<string>(ok=>lateCountOk=ok);
 const output=(async()=>{const reader=child.stdout.getReader(),decoder=new TextDecoder();let text="";for(;;){const x=await reader.read();if(x.done)break;text+=decoder.decode(x.value,{stream:true});if(text.length>1024*1024)throw Error("host stdout bound");const match=text.match(/QUERY id=\d+ hr=[0-9a-f]+ size=\d+ nameok=[01]/i);if(match)queryOk(match[0]);const pf=text.match(/PLAYER_FLAGS host=[0-9a-f]+ late=[0-9a-f]+ guest=[0-9a-f]+ hr=[0-9a-f]+,[0-9a-f]+,[0-9a-f]+(?=\r?\n)/i);if(pf)playerFlagsOk(pf[0]);const count=text.match(/HOST_COUNT hr=[0-9a-f]+ current=\d+(?=\r?\n)/i);if(count)hostCountOk(count[0]);const count2=text.match(/LATE_COUNT hr=[0-9a-f]+ current=\d+(?=\r?\n)/i);if(count2)lateCountOk(count2[0]);const late=text.match(/LATE_CREATE hr=[0-9a-f]+ id=\d+(?=\r?\n)/i);if(late)lateCreateOk(late[0]);for(const item of text.matchAll(/LIVE_COUNT phase=([CD]) current=\d+(?=\r?\n)/gi)){if(item[1]==="C")liveCreateCountOk(item[0]);else liveDeleteCountOk(item[0]);}for(const item of text.matchAll(/LIVE_(CREATE|DELETE) hr=[0-9a-f]+ id=\d+(?=\r?\n)/gi)){if(item[1]==="CREATE")liveCreateOk(item[0]);else liveDeleteOk(item[0]);}for(const temp of text.matchAll(/TEMP_(CREATE|DELETE) hr=[0-9a-f]+ id=\d+(?=\r?\n)/gi)){if(temp[1]==="CREATE")tempCreateOk(temp[0]);else tempDeleteOk(temp[0]);}for(const observed of text.matchAll(/INSPECT mode=([ID]) id=(\d+) hr=[0-9a-f]+ size=\d+(?=\r?\n)/gi)){const id=Number(observed[2]);if(observed[1]==="I"&&id===report.appReady?.systemId)systemBeforeOk(observed[0]);if(observed[1]==="D"&&id===report.appReady?.appId)destroyQueryOk(observed[0]);if(observed[1]==="D"&&id===report.appReady?.systemId)systemAfterOk(observed[0]);}}return text;})();
 hostDone=Promise.all([child.exited,output,new Response(child.stderr).text()]).then(([exit,stdout,stderr])=>({pid:child.pid,exit,stdout,stderr,stdoutEof:true,stderrEof:true}));
 report.queryWait=query;
 const until=Date.now()+12000;let marker:Buffer|undefined;
 while(Date.now()<until){if(hostExited!==undefined)throw Error("host exited before READY");try{if(existsSync(ready)){const b=readFileSync(ready);if(b.length===36){marker=b;break;}}}catch{}await new Promise(ok=>setTimeout(ok,20));}
 check(marker&&marker.readUInt32LE(0)===0x43485044&&marker.readUInt32LE(4)===report.nonce&&marker.readUInt32LE(8)===host.pid&&marker.readUInt32LE(12)!==0,"invalid READY");
 report.hostReady={pid:host.pid,player:marker.readUInt32LE(12),instance:marker.subarray(16,32).toString("hex"),reserved1:marker.readUInt32LE(32),sha256:sha(ready)};
 host.stdin.write("C\n");report.tempCreate=await bounded(tempCreate,6000);const tempMatch=report.tempCreate.match(/TEMP_CREATE hr=00000000 id=(\d+)/i);
 check(tempMatch&&Number(tempMatch[1])>0&&Number(tempMatch[1])!==report.hostReady.player,"native temporary player creation failed");report.tempId=Number(tempMatch[1]);
 report.udp47624Observed=snapshot("udp").filter(r=>r[1].endsWith(":47624"));
 const rows=listeners(host.pid);report.hostListeners=rows;
 const candidates=rows.map(r=>{const i=r[1].lastIndexOf(":");return {ip:r[1].slice(0,i),port:Number(r[1].slice(i+1))};}).filter(x=>x.port>=2300&&x.port<=2400&&(x.ip==="0.0.0.0"||x.ip===hostIp));
 check(candidates.length===1,"no unique native host-owned listener");const target=candidates[0];report.target=target;
 proxy=createServer(incoming=>{
  registered(incoming);incoming.pause();const record:any={source:incoming.remoteAddress+":"+incoming.remotePort,verified:false};report.proxyConnections.push(record);
  try{
   check(report.proxyConnections.length===1&&relay&&hostExited===undefined&&listeners(host!.pid).some(r=>r[1]===target.ip+":"+target.port),"proxy admission or host listener lost");
   const incomingRows=snapshot("tcp");
   const relayTuple=incomingRows.find(r=>r[3]==="ESTABLISHED"&&r[1]===incoming.remoteAddress+":"+incoming.remotePort&&r[2]===hostIp+":"+aliasPort&&Number(r[4])===relay!.pid);
   check(relayTuple,"proxy source is not the owned relay process");
   record.initialRelayTuple=relayTuple;
   const native=registered(createConnection({host:hostIp,port:target.port}));native.pause();
   native.once("connect",()=>{
    try {
     const rows=snapshot("tcp");
     const first=rows.find(r=>r[3]==="ESTABLISHED"&&r[1]===incoming.remoteAddress+":"+incoming.remotePort&&r[2]===hostIp+":"+aliasPort&&Number(r[4])===relay!.pid);
     const second=rows.find(r=>r[3]==="ESTABLISHED"&&r[1]===hostIp+":"+target.port&&r[2]===native.localAddress+":"+native.localPort&&Number(r[4])===host!.pid);
     const reciprocal=rows.find(r=>r[3]==="ESTABLISHED"&&r[1]===native.localAddress+":"+native.localPort&&r[2]===hostIp+":"+target.port&&Number(r[4])===process.pid);
     check(first&&second&&reciprocal&&hostExited===undefined&&listeners(host!.pid).some(r=>r[1]===target.ip+":"+target.port),"proxy tuple ownership failed");
     Object.assign(record,{relayTuple:first,hostTuple:second,proxyTuple:reciprocal,verified:true,relayBytes:0,hostBytes:0});
     const limit=(key:"relayBytes"|"hostBytes")=>(chunk:Buffer)=>{record[key]+=chunk.length;if(record[key]>262144){proxyError="proxy byte limit";incoming.destroy();native.destroy();}};
     incoming.on("data",limit("relayBytes"));native.on("data",limit("hostBytes"));
     incoming.pipe(native);native.pipe(incoming);incoming.resume();native.resume();
    }catch(e){proxyError=String(e);incoming.destroy();native.destroy();}
   });
  }catch(e){proxyError=String(e);incoming.destroy();}
 });
 await bounded(new Promise<void>((ok,no)=>{proxy!.once("error",no);proxy!.listen({host:hostIp,port:aliasPort,exclusive:true},ok);}));
 const config=join(dir,"config.json");writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],logConnections:true,...(burstRecords?{maxBufferedFrames:burstRecords}:{}),gateway:{
  udpListeners:[{id:"udp",bindHost:hostIp,advertisedHost:hostIp,port:0,allowedHosts:[hostIp],maxOwners:1,maxPeers:2,idleTimeoutMs:60000}],
  tcpListeners:[{id:"game",bindHost:hostIp,advertisedHost:hostIp,port:0,allowedHosts:[hostIp],maxPending:8}],
  routes:[{host:hostIp,address:hostIp,ports:[47624],protocols:["udp"]},{host:hostIp,address:aliasIp,ports:[aliasPort],protocols:["tcp"]}]
 }}));report.configSha256=sha(config);
 relay=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});reader=relay.stdout.getReader();err=new Response(relay.stderr).text();const hello=JSON.parse(await bounded(line(),15000));check(hello.port>0&&hello.service==="bottleship-lan","bad relay READY");
 root=new RootNetworkNamespace(new LanNetwork(),16,37100);await bounded(root.configure({serverUrl:"http://127.0.0.1:"+hello.port,room:"com-join-"+report.nonce,winsock:{provider:"native",hostListener:"game"},directPlay4:{provider:"native",tcpHostListener:"game",udpHostListener:"udp"}}));
 const internal=root as any;check(internal.active.link.socket.io.engine.transport.name===transport,"wrong transport");
 report.relayEvents={};internal.active.link.socket.io.engine.on("error",(error:any)=>{report.relayTransportError={message:String(error?.message??error),description:String(error?.description??""),context:String(error?.context??"")};});internal.active.link.socket.onAny((event:string,...args:any[])=>{report.relayEvents[event]=(report.relayEvents[event]??0)+1;if(event==="frame"){const raw=args[0];report.relayFrameBytes=(report.relayFrameBytes??0)+(raw?.byteLength??0);}});internal.active.link.socket.on("disconnect",(reason:string)=>{report.relayDisconnect=reason;});
 report.actorTcpPorts=[];report.actorUdpPorts=[];internal.active.link.socket.on("tcpHostOpened",(_id:number,reply:any)=>{if(reply?.address?.port>0&&!reply.error)report.actorTcpPorts.push(reply.address.port);});internal.active.link.socket.on("udpHostOpened",(_id:number,reply:any)=>{if(reply?.address?.port>0&&!reply.error)report.actorUdpPorts.push(reply.address.port);});
 report.capability=internal.backplane.tcpHostListenV1;report.udpCapability=internal.backplane.udpHostListenV1;
 const allowed=JSON.stringify([[2,1,...hostIp.split(".").map(Number)]]);
 check(report.capability?.listeners?.length===1&&report.capability.listeners[0].id==="game"&&JSON.stringify(report.capability.listeners[0].allowedNodes)===allowed&&report.udpCapability?.listeners?.length===1&&report.udpCapability.listeners[0].id==="udp"&&JSON.stringify(report.udpCapability.listeners[0].allowedNodes)===allowed,"bad READY ACL");
 const childLease=root.createChild(37101);lease=childLease;report.child={pid:childLease.boot.pid,slot:childLease.boot.slot,epoch:childLease.boot.epoch};
 worker=new Worker(new URL("./directplay4-com-session-worker.ts",import.meta.url).href,{type:"module"});
 let appOk!:(v:any)=>void,dataOk!:(v:any)=>void,destroyOk!:(v:any)=>void,retiredOk!:(v:any)=>void,heldOk!:(v:any)=>void,pendingOk!:(v:any)=>void,createOk!:(v:any)=>void,appNo!:(e:Error)=>void,dataNo!:(e:Error)=>void,destroyNo!:(e:Error)=>void,retiredNo!:(e:Error)=>void,heldNo!:(e:Error)=>void,pendingNo!:(e:Error)=>void,createNo!:(e:Error)=>void;
 const appReady=new Promise<any>((ok,no)=>{appOk=ok;appNo=no;}),dataReady=new Promise<any>((ok,no)=>{dataOk=ok;dataNo=no;}),destroyed=new Promise<any>((ok,no)=>{destroyOk=ok;destroyNo=no;}),workerRetired=new Promise<any>((ok,no)=>{retiredOk=ok;retiredNo=no;}),held=new Promise<any>((ok,no)=>{heldOk=ok;heldNo=no;}),pendingDelete=new Promise<any>((ok,no)=>{pendingOk=ok;pendingNo=no;}),pendingCreate=new Promise<any>((ok,no)=>{createOk=ok;createNo=no;});
 void appReady.catch(()=>{});void dataReady.catch(()=>{});void destroyed.catch(()=>{});void workerRetired.catch(()=>{});void held.catch(()=>{});void pendingDelete.catch(()=>{});void pendingCreate.catch(()=>{});
 let livePhase=false,liveCreateFrameOk!:(v:any)=>void,liveDeleteFrameOk!:(v:any)=>void;
 const liveCreateFrame=new Promise<any>(ok=>liveCreateFrameOk=ok),liveDeleteFrame=new Promise<any>(ok=>liveDeleteFrameOk=ok);
 const result=new Promise<any>((ok,no)=>{worker!.onmessage=({data})=>{if(data.kind==="handshakeHeld")heldOk(data);else if(data.kind==="pendingDelete")pendingOk(data);else if(data.kind==="pendingCreate")createOk(data);else if(data.kind==="rosterChange"){(report.rosterChanges??=[]).push(data);}else if(data.kind==="guestMessage"){(report.guestMessages??=[]).push(data);}else if(data.kind==="guestPlayerMessage"){(report.guestPlayerMessages??=[]).push(data);}else if(data.kind==="system"){(report.systemFrames??=[]).push(data);if(livePhase&&data.command===8)liveCreateFrameOk(data);if(livePhase&&data.command===11)liveDeleteFrameOk(data);}else if(data.kind==="cache")report.cache=data;else if(data.kind==="listeners")report.listeners=data;else if(data.kind==="liveFrame"){(report.liveFrames??=[]).push(data);}else if(data.kind==="appReady")appOk(data);else if(data.kind==="sent")dataOk(data);else if(data.kind==="destroyed")destroyOk(data);else if(data.kind==="retired")retiredOk(data);else if(data.kind==="result")ok(data.result);else if(data.kind==="error"||data.kind==="ownershipUncertain"){const e=Error(data.error);appNo(e);dataNo(e);destroyNo(e);retiredNo(e);heldNo(e);pendingNo(e);createNo(e);no(e);}};worker!.onerror=e=>{const error=Error(e.message);appNo(error);dataNo(error);destroyNo(error);retiredNo(error);heldNo(error);pendingNo(error);createNo(error);no(error);};});void result.catch(()=>{});
 const guid=Buffer.from("000000001973e14aa3928047312f9ad1","hex");guid.writeUInt32LE(report.nonce);
 worker.postMessage({id:1,boot:childLease.boot,guid:[...guid],hostIp,aliasIp:parts,aliasPort,tempId:report.tempId,burstCount},[childLease.boot.port]);
 report.handshakeHeld=await bounded(held,16000);check(report.handshakeHeld.tempId===report.tempId,"wrong held handshake");
 host.stdin.write("X "+report.tempId+"\n");report.tempDelete=await bounded(tempDelete,6000);
 check(report.tempDelete.includes("hr=00000000 id="+report.tempId),"native temporary player deletion failed");
 report.pendingDelete=await bounded(pendingDelete,7000);check(report.pendingDelete.id===report.tempId&&report.pendingDelete.peer.ip.join(".")===hostIp&&report.pendingDelete.peer.port>0,"missing pending native delete provenance");
 host.stdin.write("G\n");report.hostCount=await bounded(hostCount,6000);check(report.hostCount==="HOST_COUNT hr=00000000 current=1","native player count mismatch");
 host.stdin.write("N\n");report.lateCreate=await bounded(lateCreate,6000);report.pendingCreate=await bounded(pendingCreate,7000);
 const lateMatch=report.lateCreate.match(/LATE_CREATE hr=00000000 id=(\d+)/i);
 check(lateMatch&&Number(lateMatch[1])===report.pendingCreate.id&&report.pendingCreate.peer.ip.join(".")===hostIp,"pending native create mismatch");
 report.lateId=Number(lateMatch[1]);worker.postMessage({command:"late",id:report.lateId});
 host.stdin.write("H\n");report.lateCount=await bounded(lateCount,6000);check(report.lateCount==="LATE_COUNT hr=00000000 current=2","native late player count mismatch");
 if(process.env.BS_DP4_CAPTURE_CREATE==="1")throw Error("intentional capture of native pending create");
 worker.postMessage({command:"transfer"});report.appReady=await bounded(appReady,10000);
 check(JSON.stringify(report.systemFrames?.map((frame:any)=>frame.command))==="[11,8]","pending system events were not dispatched in order");
 check(report.rosterChanges?.length===2&&report.rosterChanges[0].operation==="delete"&&report.rosterChanges[0].id===report.tempId&&report.rosterChanges[0].before.includes(report.tempId)&&!report.rosterChanges[0].after.includes(report.tempId)&&report.rosterChanges[1].operation==="create"&&report.rosterChanges[1].id===report.lateId&&!report.rosterChanges[1].before.includes(report.lateId)&&report.rosterChanges[1].after.includes(report.lateId),"pending roster history mismatch");
 host.stdin.write("P "+report.appReady.appId+"\n");report.hostQuery=await bounded(report.queryWait,7000);delete report.queryWait;
 check(report.hostQuery.includes("id="+report.appReady.appId+" hr=00000000")&&report.hostQuery.endsWith("nameok=1"),"host player/name mismatch");
 host.stdin.write("F "+report.appReady.appId+"\n");report.playerFlags=await bounded(playerFlags,6000);check(report.playerFlags==="PLAYER_FLAGS host=00000008 late=00000008 guest=00000000 hr=00000000,00000000,00000000","native GetPlayerFlags failed");
 const projected=report.appReady.projected;check(projected.length===2&&projected.some((p:any)=>p.id===report.hostReady.player&&p.shortName==="Host"&&p.flags===0)&&projected.some((p:any)=>p.id===report.lateId&&p.shortName==="Late"&&p.flags===0),"native player projection mismatch");
 livePhase=true;host.stdin.write("T\n");report.liveCreate=await bounded(liveCreate,6000);report.liveCreateCount=await bounded(liveCreateCount,6000);report.liveCreateFrame=await bounded(liveCreateFrame,7000);
 const liveMatch=report.liveCreate.match(/LIVE_CREATE hr=00000000 id=(\d+)/i),frameId=(frame:any)=>new DataView(Uint8Array.from(frame.bytes).buffer).getUint32(12,true);
 check(liveMatch&&frameId(report.liveCreateFrame)===Number(liveMatch[1])&&report.liveCreateCount==="LIVE_COUNT phase=C current="+report.liveCreateFrame.count&&report.liveCreateFrame.players.includes(Number(liveMatch[1]))&&report.liveCreateFrame.peer.ip.join(".")===hostIp,"live native create frame mismatch");
 host.stdin.write("Y "+liveMatch[1]+"\n");report.liveDelete=await bounded(liveDelete,6000);report.liveDeleteCount=await bounded(liveDeleteCount,6000);report.liveDeleteFrame=await bounded(liveDeleteFrame,7000);
 check(report.liveDelete.includes("hr=00000000 id="+liveMatch[1])&&frameId(report.liveDeleteFrame)===Number(liveMatch[1])&&report.liveDeleteCount==="LIVE_COUNT phase=D current="+report.liveDeleteFrame.count&&!report.liveDeleteFrame.players.includes(Number(liveMatch[1]))&&report.liveDeleteFrame.peer.ip.join(".")===hostIp,"live native delete frame mismatch");
 livePhase=false;
 check(report.rosterChanges?.length===4&&report.rosterChanges[2].operation==="create"&&report.rosterChanges[2].id===Number(liveMatch[1])&&!report.rosterChanges[2].before.includes(Number(liveMatch[1]))&&report.rosterChanges[2].after.includes(Number(liveMatch[1]))&&report.rosterChanges[3].operation==="delete"&&report.rosterChanges[3].id===Number(liveMatch[1])&&report.rosterChanges[3].before.includes(Number(liveMatch[1]))&&!report.rosterChanges[3].after.includes(Number(liveMatch[1])),"live roster history mismatch");
 check(report.guestMessages?.length===2&&report.guestMessages[0].type===3&&report.guestMessages[1].type===5&&report.guestMessages.every((m:any)=>m.playerType===1&&m.id===Number(liveMatch[1])&&m.recipient===report.appReady.guestId&&m.event===report.appReady.guestEvent&&m.event>0&&m.eventSignaled===true&&m.shortHr===0x8877001e&&m.required===(m.type===3?82:86)&&m.shortName==="Live"&&m.longName==="Live Long"&&JSON.stringify(m.data)==="[18,52,86,120]"&&m.ansi.type===m.type&&m.ansi.playerType===m.playerType&&m.ansi.id===m.id&&m.ansi.count===m.count&&m.ansi.recipient===m.recipient&&m.ansi.shortName===m.shortName&&m.ansi.longName===m.longName&&JSON.stringify(m.ansi.data)===JSON.stringify(m.data))&&report.guestMessages[0].count===report.liveCreateFrame.count&&report.guestMessages[1].count===report.liveDeleteFrame.count,"guest queue delivery mismatch");
 const liveProjection=report.rosterChanges[2].afterProjected.find((p:any)=>p.id===Number(liveMatch[1]));
 check(report.rosterChanges[0].notification.type===5&&report.rosterChanges[0].notification.player.id===report.tempId&&report.rosterChanges[1].notification.type===3&&report.rosterChanges[1].notification.player.id===report.lateId&&report.rosterChanges[2].notification.type===3&&report.rosterChanges[2].notification.player.id===Number(liveMatch[1])&&report.rosterChanges[3].notification.type===5&&report.rosterChanges[3].notification.player.id===Number(liveMatch[1]),"guest notification projection mismatch");
 check(report.rosterChanges[2].guest.type===3&&report.rosterChanges[2].guest.currentPlayers===report.liveCreateFrame.count&&report.rosterChanges[3].guest.currentPlayers===report.liveDeleteFrame.count&&report.rosterChanges[2].guest.entity.id===Number(liveMatch[1])&&report.rosterChanges[2].guest.entity.name.short==="Live"&&report.rosterChanges[2].guest.entity.flags===0&&report.rosterChanges[3].guest.type===5&&report.rosterChanges[3].guest.entity.id===Number(liveMatch[1]),"guest system message mismatch");
 check(liveProjection?.shortName==="Live"&&liveProjection.longName==="Live Long"&&JSON.stringify(liveProjection.data)==="[18,52,86,120]"&&liveProjection.flags===0&&!report.rosterChanges[2].beforeProjected.some((p:any)=>p.id===Number(liveMatch[1]))&&report.rosterChanges[3].beforeProjected.some((p:any)=>p.id===Number(liveMatch[1]))&&!report.rosterChanges[3].afterProjected.some((p:any)=>p.id===Number(liveMatch[1])),"live guest projection mismatch");
 check(!proxyError&&report.proxyConnections.length===1&&report.proxyConnections[0].verified&&hostExited===undefined&&report.appReady.hostId===report.hostReady.player&&report.appReady.submission==="submitted"&&report.actorTcpPorts.length>=2&&report.actorUdpPorts.length>=1,"proxy, READY listeners or host player mismatch");
 const rowsBeforeSend=snapshot("tcp"),h=report.proxyConnections[0].hostTuple,r=report.proxyConnections[0].relayTuple;
 check(hostExited===undefined&&rowsBeforeSend.some(x=>x[3]==="ESTABLISHED"&&x[1]===h[1]&&x[2]===h[2]&&Number(x[4])===host!.pid)&&rowsBeforeSend.some(x=>x[3]==="ESTABLISHED"&&x[1]===r[1]&&x[2]===r[2]&&Number(x[4])===relay!.pid),"owned proxy tuples lost before player send");
 report.playerSendTuples={host:h,relay:r};
 worker.postMessage({command:"send"});report.sent=await bounded(dataReady,6000);
 check(report.sent.submission==="submitted"&&report.sent.appId===report.appReady.appId&&report.sent.hostId===report.hostReady.player,"wrong native send submission");
 host.stdin.write("R "+report.appReady.appId+" "+burstCount+"\n");report.exchange=await bounded(result,12000);
 const guestPlayer=report.guestPlayerMessages?.[0],expectedGuestPayload="host-"+report.nonce;
 check(report.guestPlayerMessages?.length===1+burstCount&&report.exchange.burstReceived===burstCount&&report.guestPlayerMessages.every((m:any,i:number)=>{const payload=i===0?expectedGuestPayload:"burst-"+report.nonce+"-"+(i-1);return m.from===report.hostReady.player&&m.to===report.appReady.guestId&&m.event===report.appReady.guestEvent&&m.eventSignaled===true&&m.shortHr===0x8877001e&&m.required===Buffer.byteLength(payload)&&Buffer.from(m.peek).toString()===payload&&Buffer.from(m.received).toString()===payload;}),"guest COM player delivery mismatch");
 check(report.exchange.nativeQueueEmpty===true&&report.exchange.current&&report.exchange.cache.instance===report.hostReady.instance&&report.exchange.cache.reserved[0]===report.hostReady.reserved1&&Buffer.from(report.exchange.sessionDescription).subarray(8,24).toString("hex")===report.hostReady.instance&&report.exchange.appId===report.appReady.appId&&report.exchange.hostId===report.hostReady.player,"COM cache / native session mismatch");
 host.stdin.write("I "+report.appReady.systemId+"\n");report.systemBefore=await bounded(systemBefore,6000);
 worker.postMessage({command:"finish"});report.destroy=await bounded(destroyed,6000);
 check(report.destroy.appId===report.appReady.appId&&report.destroy.submission==="submitted","wrong destroy submission");
 host.stdin.write("D "+report.appReady.appId+"\n");report.destroyHostQuery=await bounded(destroyQuery,7000);
 check(report.destroyHostQuery.includes("id="+report.appReady.appId+" hr=88770096"),"native host still has the application player before close");
 worker.postMessage({command:"retire"});report.workerRetired=await bounded(workerRetired,6000);
 check(report.workerRetired.guestComClosed===true&&report.workerRetired.guestEventClosed===true,"guest COM or event retained after retirement");
 host.stdin.write("D "+report.appReady.systemId+"\n");report.systemAfter=await bounded(systemAfter,7000);
 if(report.systemBefore.includes("hr=00000000"))check(report.systemAfter.includes("hr=88770096"),"native host still has the system player");
}catch(e){failed=e;}
finally{
 const cleanup:Record<string,string>={};const attempt=async(name:string,fn:()=>void|Promise<void>)=>{try{await fn();cleanup[name]="ok";}catch(e){cleanup[name]=String(e);failed??=e;}};
 await attempt("worker",async()=>{if(worker){const done=new Promise<void>(ok=>worker!.addEventListener("close",()=>ok(),{once:true}));worker.terminate();await bounded(done);}});
 await attempt("lease",()=>lease?.close());
 await attempt("actorTcpRebind",async()=>{for(const p of new Set<number>(report.actorTcpPorts??[]))await rebind(p);});
 await attempt("actorUdpRebind",async()=>{for(const p of new Set<number>(report.actorUdpPorts??[]))await rebind(p,true);});
 await attempt("root",()=>bounded(root?.close()??Promise.resolve()));
 await attempt("proxy",async()=>{for(const s of sockets)s.destroy();if(proxy)await bounded(new Promise<void>((ok,no)=>proxy!.close(e=>e?no(e):ok())));});
 await attempt("proxyRebind",async()=>{if(proxy)await rebind(aliasPort);});
 if(relay){await attempt("relaySignal",()=>{relay!.stdin.write("shutdown\n");relay!.stdin.end();});try{retired=JSON.parse(await bounded(line()));exit=await bounded(relay.exited);eof=(await bounded(reader!.read())).done&&buffer.length===0;report.relayStderr=await bounded(err!);check(retired?.explicit&&retired?.retired&&exit===0&&eof,"relay shutdown");cleanup.relay="ok";}catch(e){failed??=e;forced=true;await attempt("relayKill",async()=>{relay!.kill();exit=await bounded(relay!.exited);report.relayStderr=await bounded(err!);});}}
 if(host){await attempt("host",async()=>{host!.stdin.write("Q\n");host!.stdin.end();try{report.hostProcess=await bounded(hostDone!,10000);}catch(e){host!.kill();report.hostProcess=await bounded(hostDone!,10000);report.hostForced=true;throw e;}check(report.hostProcess.exit===0&&report.hostProcess.stdout.includes("CLOSE 00000000")&&report.hostProcess.stdout.includes("SEND hr=00000000")&&report.hostProcess.stdout.includes("BURST count="+burstCount+" hr=00000000")&&report.hostProcess.stdout.includes("RECV ok=1 hr=00000000 from="+report.appReady.appId+" to="+report.hostReady.player+" "),"host receive/send/close failed");});}
 if(build&&buildDone&&!report.build)await attempt("build",async()=>{build!.kill();report.build=await bounded(buildDone!,5000);});
 await attempt("hashes",()=>{after=hashes();check(JSON.stringify(before)===JSON.stringify(after),"inputs changed");if(exeBefore)check(exeBefore===sha(exe),"host executable changed");});
 report.proxyError=proxyError;report.cleanup=cleanup;writeFileSync(join(dir,"result.json"),JSON.stringify({report,before,after,exeBefore,exeAfter:exeBefore?sha(exe):undefined,retired,exit,eof,forced,error:failed?String(failed):null},null,2));
}
if(failed)throw failed;console.log(JSON.stringify(report));
