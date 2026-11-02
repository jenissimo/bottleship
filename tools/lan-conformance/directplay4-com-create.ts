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
mkdirSync(output,{recursive:false});const dir=resolve(output),exe=join(dir,"host.exe"),ready=join(dir,"ready.bin");
const src=resolve("tools/lan-conformance/directplay4-create-native-host.c"),workerPath=resolve("tools/lan-conformance/directplay4-com-create-worker.ts");
const runtime=["src/worker/modules/dplayx/network-api.ts","src/worker/modules/dplayx/session.ts","src/worker/modules/dplayx/native-wire/connection.ts","src/worker/modules/dplayx/native-wire/lan-discovery.ts","src/worker/modules/dplayx/native-wire/discovery.ts","src/worker/modules/dplayx/native-wire/peer-address.ts","src/worker/modules/dplayx/native-wire/join-handshake.ts","src/worker/modules/dplayx/native-wire/join-name-table-owner.ts","src/worker/modules/dplayx/native-wire/create-player.ts","src/worker/modules/dplayx/native-wire/join-channel.ts","src/worker/modules/dplayx/native-wire/join-transaction.ts","src/worker/modules/dplayx/native-wire/join-pending.ts","src/worker/modules/dplayx/native-wire/join-listener.ts","src/worker/modules/dplayx/native-wire/join-udp-listener.ts","src/worker/modules/dplayx/native-wire/player-id.ts","src/worker/modules/dplayx/native-wire/packed-player.ts","src/worker/modules/dplayx/native-wire/name-table.ts","src/worker/modules/dplayx/native-wire/tcp-frame.ts","src/worker/modules/dplayx/native-wire/tcp-stream.ts","src/worker/modules/wsa-network.ts","src/worker/modules/wsa-actor-kernel.ts","src/worker/modules/wsa-actor-table.ts","src/worker/modules/wsa-actor-worker.ts","src/worker/modules/wsa-actor-response.ts","src/worker/core/network-namespace.ts","src/worker/net/lan-network.ts","src/worker/net/relay-link.ts"];
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes=()=>({binary:sha(binary),gcc:sha(gcc),source:sha(src),runner:sha(import.meta.filename),worker:sha(workerPath),runtime:Object.fromEntries(runtime.map(p=>[p,sha(p)]))});
const bounded=async<T>(p:Promise<T>,ms=10000):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,no)=>timer=setTimeout(()=>no(Error("deadline")),ms))]);}finally{clearTimeout(timer);}};
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
const env={Path:dirname(resolve(gcc))+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
let build:ReturnType<typeof Bun.spawn>|undefined,host:ReturnType<typeof Bun.spawn>|undefined,relay:ReturnType<typeof Bun.spawn>|undefined,root:RootNetworkNamespace|undefined,worker:Worker|undefined,lease:{close():void}|undefined,proxy:ReturnType<typeof createServer>|undefined;
const sockets=new Set<Socket>();let buildDone:Promise<any>|undefined,hostDone:Promise<any>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,err:Promise<string>|undefined,buffer="",before:any,after:any,exeBefore:string|undefined,failed:unknown,retired:any,exit:number|undefined,eof=false,forced=false,hostExited:number|undefined,proxyError:string|undefined;
const report:any={transport,hostIp,aliasIp,aliasPort,nonce:randomBytes(4).readUInt32LE()||1,capabilityInjected:false,laboratoryNatAlias:true,proxyConnections:[]};
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
 build=Bun.spawn([resolve(gcc),"-O1","-o",exe,src,"-lole32","-ldxguid","-luuid"],{env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});buildDone=track(build);report.build=await bounded(buildDone,15000);check(report.build.exit===0,"host compile failed");exeBefore=sha(exe);
 host=Bun.spawn([exe,String(report.nonce),ready],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});const child=host;child.exited.then(x=>hostExited=x);
 let queryOk!:(v:string)=>void;const query=new Promise<string>(ok=>queryOk=ok);
 const output=(async()=>{const reader=child.stdout.getReader(),decoder=new TextDecoder();let text="";for(;;){const x=await reader.read();if(x.done)break;text+=decoder.decode(x.value,{stream:true});if(text.length>1024*1024)throw Error("host stdout bound");const match=text.match(/QUERY id=\d+ hr=[0-9a-f]+ size=\d+ nameok=[01]/i);if(match)queryOk(match[0]);}return text;})();
 hostDone=Promise.all([child.exited,output,new Response(child.stderr).text()]).then(([exit,stdout,stderr])=>({pid:child.pid,exit,stdout,stderr,stdoutEof:true,stderrEof:true}));
 report.queryWait=query;
 const until=Date.now()+12000;let marker:Buffer|undefined;
 while(Date.now()<until){if(hostExited!==undefined)throw Error("host exited before READY");try{if(existsSync(ready)){const b=readFileSync(ready);if(b.length===36){marker=b;break;}}}catch{}await new Promise(ok=>setTimeout(ok,20));}
 check(marker&&marker.readUInt32LE(0)===0x43485044&&marker.readUInt32LE(4)===report.nonce&&marker.readUInt32LE(8)===host.pid&&marker.readUInt32LE(12)!==0,"invalid READY");
 report.hostReady={pid:host.pid,player:marker.readUInt32LE(12),instance:marker.subarray(16,32).toString("hex"),reserved1:marker.readUInt32LE(32),sha256:sha(ready)};
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
 const config=join(dir,"config.json");writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],gateway:{
  udpListeners:[{id:"udp",bindHost:hostIp,advertisedHost:hostIp,port:0,allowedHosts:[hostIp],maxOwners:1,maxPeers:2,idleTimeoutMs:60000}],
  tcpListeners:[{id:"game",bindHost:hostIp,advertisedHost:hostIp,port:0,allowedHosts:[hostIp],maxPending:8}],
  routes:[{host:hostIp,address:hostIp,ports:[47624],protocols:["udp"]},{host:hostIp,address:aliasIp,ports:[aliasPort],protocols:["tcp"]}]
 }}));report.configSha256=sha(config);
 relay=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});reader=relay.stdout.getReader();err=new Response(relay.stderr).text();const hello=JSON.parse(await bounded(line(),15000));check(hello.port>0&&hello.service==="bottleship-lan","bad relay READY");
 root=new RootNetworkNamespace(new LanNetwork(),16,37100);await bounded(root.configure({serverUrl:"http://127.0.0.1:"+hello.port,room:"com-join-"+report.nonce,winsock:{provider:"native",hostListener:"game"}}));
 const internal=root as any;check(internal.active.link.socket.io.engine.transport.name===transport,"wrong transport");
 report.actorTcpPorts=[];internal.active.link.socket.on("tcpHostOpened",(_id:number,reply:any)=>{if(reply?.address?.port>0&&!reply.error)report.actorTcpPorts.push(reply.address.port);});
 report.capability=internal.backplane.tcpHostListenV1;report.udpCapability=internal.backplane.udpHostListenV1;
 const allowed=JSON.stringify([[2,1,...hostIp.split(".").map(Number)]]);
 check(report.capability?.listeners?.length===1&&report.capability.listeners[0].id==="game"&&JSON.stringify(report.capability.listeners[0].allowedNodes)===allowed&&report.udpCapability?.listeners?.length===1&&report.udpCapability.listeners[0].id==="udp"&&JSON.stringify(report.udpCapability.listeners[0].allowedNodes)===allowed,"bad READY ACL");
 const childLease=root.createChild(37101);lease=childLease;report.child={pid:childLease.boot.pid,slot:childLease.boot.slot,epoch:childLease.boot.epoch};
 worker=new Worker(new URL("./directplay4-com-create-worker.ts",import.meta.url).href,{type:"module"});
 const result=new Promise<any>((ok,no)=>{worker!.onmessage=({data})=>{if(data.kind==="cache")report.cache=data;else if(data.kind==="listeners")report.listeners=data;else if(data.kind==="liveFrame"){(report.liveFrames??=[]).push(data);}else if(data.kind==="result")ok(data.result);else if(data.kind==="error"||data.kind==="ownershipUncertain")no(Error(data.error));};worker!.onerror=e=>no(Error(e.message));});void result.catch(()=>{});
 const guid=Buffer.from("000000001973e14aa3928047312f9ad1","hex");guid.writeUInt32LE(report.nonce);
 worker.postMessage({id:1,boot:childLease.boot,guid:[...guid],hostIp,aliasIp:parts,aliasPort},[childLease.boot.port]);report.exchange=await bounded(result,16000);
 check(!proxyError&&report.proxyConnections.length===1&&report.proxyConnections[0].verified&&hostExited===undefined,"proxy ownership or host failure");
 check(report.exchange.current&&report.exchange.cache.instance===report.hostReady.instance&&report.exchange.cache.reserved[0]===report.hostReady.reserved1&&Buffer.from(report.exchange.sessionDescription).subarray(8,24).toString("hex")===report.hostReady.instance&&report.exchange.playerId>0&&report.exchange.appId>0&&report.exchange.submission==="submitted","COM cache / native host mismatch");
 host.stdin.write("P "+report.exchange.appId+"\n");report.hostQuery=await bounded(report.queryWait,7000);delete report.queryWait;
 check(report.hostQuery.includes("id="+report.exchange.appId+" hr=00000000")&&report.hostQuery.endsWith("nameok=1"),"host player/name mismatch");worker.postMessage({command:"finish"});
}catch(e){failed=e;}
finally{
 const cleanup:Record<string,string>={};const attempt=async(name:string,fn:()=>void|Promise<void>)=>{try{await fn();cleanup[name]="ok";}catch(e){cleanup[name]=String(e);failed??=e;}};
 await attempt("worker",async()=>{if(worker){const done=new Promise<void>(ok=>worker!.addEventListener("close",()=>ok(),{once:true}));worker.terminate();await bounded(done);}});
 await attempt("lease",()=>lease?.close());
 await attempt("actorTcpRebind",async()=>{for(const p of new Set<number>(report.actorTcpPorts??[]))await rebind(p);});
 await attempt("actorUdpRebind",async()=>{if(report.listeners?.udp?.port)await rebind(report.listeners.udp.port,true);});
 await attempt("root",()=>bounded(root?.close()??Promise.resolve()));
 await attempt("proxy",async()=>{for(const s of sockets)s.destroy();if(proxy)await bounded(new Promise<void>((ok,no)=>proxy!.close(e=>e?no(e):ok())));});
 await attempt("proxyRebind",async()=>{if(proxy)await rebind(aliasPort);});
 if(relay){await attempt("relaySignal",()=>{relay!.stdin.write("shutdown\n");relay!.stdin.end();});try{retired=JSON.parse(await bounded(line()));exit=await bounded(relay.exited);eof=(await bounded(reader!.read())).done&&buffer.length===0;report.relayStderr=await bounded(err!);check(retired?.explicit&&retired?.retired&&exit===0&&eof,"relay shutdown");cleanup.relay="ok";}catch(e){failed??=e;forced=true;await attempt("relayKill",async()=>{relay!.kill();exit=await bounded(relay!.exited);report.relayStderr=await bounded(err!);});}}
 if(host){await attempt("host",async()=>{host!.stdin.write("Q\n");host!.stdin.end();try{report.hostProcess=await bounded(hostDone!,10000);}catch(e){host!.kill();report.hostProcess=await bounded(hostDone!,10000);report.hostForced=true;throw e;}check(report.hostProcess.exit===0&&report.hostProcess.stdout.includes("CLOSE 00000000"),"host failed to close");});}
 if(build&&buildDone&&!report.build)await attempt("build",async()=>{build!.kill();report.build=await bounded(buildDone!,5000);});
 await attempt("hashes",()=>{after=hashes();check(JSON.stringify(before)===JSON.stringify(after),"inputs changed");if(exeBefore)check(exeBefore===sha(exe),"host executable changed");});
 report.proxyError=proxyError;report.cleanup=cleanup;writeFileSync(join(dir,"result.json"),JSON.stringify({report,before,after,exeBefore,exeAfter:exeBefore?sha(exe):undefined,retired,exit,eof,forced,error:failed?String(failed):null},null,2));
}
if(failed)throw failed;console.log(JSON.stringify(report));
