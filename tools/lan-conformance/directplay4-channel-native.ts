/** Finite owned native host + Rust relay + WSA actor channel. No service control or global capture. */
import {createHash,randomBytes} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {networkInterfaces} from "node:os";
import {createServer} from "node:net";
import {execFileSync} from "node:child_process";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
const [binary,gcc,output,transport,hostIp]=process.argv.slice(2);
if(process.argv.length!==7||!["websocket","polling"].includes(transport)||!Object.values(networkInterfaces()).flat().some(x=>x?.family==="IPv4"&&x.address===hostIp&&!x.internal))throw Error("usage: <relay> <x86-gcc> <new dir> <transport> <owned non-loopback IPv4>");
mkdirSync(output,{recursive:false});const dir=resolve(output),exe=join(dir,"host.exe"),ready=join(dir,"ready.bin");
const src=resolve("tools/lan-conformance/directplay4-channel-native-host.c"),workerPath=resolve("tools/lan-conformance/directplay4-channel-native-worker.ts");
const runtime=["src/worker/modules/dplayx/native-wire/join-channel.ts","src/worker/modules/dplayx/native-wire/join-listener.ts","src/worker/modules/dplayx/native-wire/player-id.ts","src/worker/modules/dplayx/native-wire/tcp-frame.ts","src/worker/modules/dplayx/native-wire/tcp-stream.ts","src/worker/modules/wsa-network.ts","src/worker/modules/wsa-actor-kernel.ts","src/worker/modules/wsa-actor-table.ts","src/worker/modules/wsa-actor-worker.ts","src/worker/modules/wsa-actor-response.ts","src/worker/core/network-namespace.ts","src/worker/net/lan-network.ts","src/worker/net/relay-link.ts"];
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes=()=>({binary:sha(binary),gcc:sha(gcc),source:sha(src),runner:sha(import.meta.filename),worker:sha(workerPath),runtime:Object.fromEntries(runtime.map(p=>[p,sha(p)]))});
const bounded=async<T>(p:Promise<T>,ms=10000):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,no)=>timer=setTimeout(()=>no(Error("deadline")),ms))]);}finally{clearTimeout(timer);}};
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
const env={Path:dirname(resolve(gcc))+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
let build:ReturnType<typeof Bun.spawn>|undefined,host:ReturnType<typeof Bun.spawn>|undefined,relay:ReturnType<typeof Bun.spawn>|undefined,root:RootNetworkNamespace|undefined,worker:Worker|undefined,lease:{close():void}|undefined;
let buildDone:Promise<any>|undefined,hostDone:Promise<any>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,err:Promise<string>|undefined,buffer="",before:any,after:any,exeBefore:string|undefined,failed:unknown,retired:any,exit:number|undefined,eof=false,forced=false,hostExited:number|undefined,listenerPort=0;
const report:any={transport,hostIp,nonce:randomBytes(4).readUInt32LE()||1,capabilityInjected:false};
const track=(p:ReturnType<typeof Bun.spawn>)=>Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]).then(([exit,stdout,stderr])=>({pid:p.pid,exit,stdout,stderr,stdoutEof:true,stderrEof:true}));
async function line(){for(;;){const i=buffer.indexOf("\n");if(i>=0){const x=buffer.slice(0,i);buffer=buffer.slice(i+1);return x;}const r=await reader!.read();if(r.done)throw Error("relay EOF");buffer+=new TextDecoder().decode(r.value,{stream:true});}}
function endpoints(pid:number){const text=execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p","tcp"],{encoding:"utf8",timeout:2000,maxBuffer:2*1024*1024});return text.split(/\r?\n/).map(x=>x.trim().split(/\s+/)).filter(x=>x[0]==="TCP"&&x[3]==="LISTENING"&&Number(x[4])===pid);}
try{
 before=hashes();
 build=Bun.spawn([resolve(gcc),"-O1","-o",exe,src,"-lole32","-ldxguid","-luuid"],{env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});buildDone=track(build);report.build=await bounded(buildDone,15000);check(report.build.exit===0,"host compile failed");exeBefore=sha(exe);
 host=Bun.spawn([exe,String(report.nonce),ready],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});const child=host;child.exited.then(x=>hostExited=x);hostDone=track(child);
 const until=Date.now()+12000;let marker:Buffer|undefined;
 while(Date.now()<until){if(hostExited!==undefined)throw Error("host exited before READY");try{if(existsSync(ready)){const b=readFileSync(ready);if(b.length===32){marker=b;break;}}}catch{}await new Promise(ok=>setTimeout(ok,20));}
 check(marker&&marker.readUInt32LE(0)===0x43485044&&marker.readUInt32LE(4)===report.nonce&&marker.readUInt32LE(8)===host.pid&&marker.readUInt32LE(12)!==0,"invalid READY");
 report.hostReady={pid:host.pid,player:marker.readUInt32LE(12),instance:marker.subarray(16).toString("hex"),sha256:sha(ready)};
 const rows=endpoints(host.pid);report.hostListeners=rows;
 const candidates=rows.map(r=>{const i=r[1].lastIndexOf(":");return {ip:r[1].slice(0,i),port:Number(r[1].slice(i+1))};}).filter(x=>x.port>=2300&&x.port<=2400&&(x.ip==="0.0.0.0"||x.ip===hostIp));
 check(candidates.length===1,"no unique listener owned by native host PID");const target=candidates[0];report.target=target;
 const config=join(dir,"config.json");writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],gateway:{routes:[{host:hostIp,address:hostIp,ports:[target.port],protocols:["tcp"]}],tcpListeners:[{id:"game",bindHost:hostIp,advertisedHost:hostIp,port:0,allowedHosts:[hostIp],maxPending:4}]}}));report.configSha256=sha(config);
 relay=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});reader=relay.stdout.getReader();err=new Response(relay.stderr).text();const hello=JSON.parse(await bounded(line(),15000));check(hello.port>0&&hello.service==="bottleship-lan","bad relay READY");
 root=new RootNetworkNamespace(new LanNetwork(),16,37000);
 await bounded(root.configure({serverUrl:"http://127.0.0.1:"+hello.port,room:"channel-"+report.nonce,winsock:{provider:"native",hostListener:"game"}}));
 const internal=root as any;check(internal.active.link.socket.io.engine.transport.name===transport,"wrong transport");
 const capability=internal.backplane.tcpHostListenV1;check(capability?.listeners?.[0]?.id==="game"&&JSON.stringify(capability.listeners[0].allowedNodes)===JSON.stringify([[2,1,...hostIp.split(".").map(Number)]]),"bad public ACL");report.capability=capability;
 const stable=endpoints(host.pid).some(r=>r[1]===target.ip+":"+target.port);check(stable&&hostExited===undefined,"native listener ownership changed before connect");
 const childLease=root.createChild(37001);lease=childLease;report.child={pid:childLease.boot.pid,slot:childLease.boot.slot,epoch:childLease.boot.epoch};
 worker=new Worker(new URL("./directplay4-channel-native-worker.ts",import.meta.url).href,{type:"module"});
 let preflightOk!: (v:any)=>void, preflightNo!: (e:Error)=>void;
 const preflight=new Promise<any>((ok,no)=>{preflightOk=ok;preflightNo=no;});
 const result=new Promise<any>((ok,no)=>{worker!.onmessage=({data})=>{if(data.kind==="preflight")preflightOk(data.listener);else if(data.kind==="result")ok(data.result);else if(data.kind==="error"){const e=Error(data.error);preflightNo(e);no(e);}};worker!.onerror=e=>{const err=Error(e.message);preflightNo(err);no(err);};});
 void result.catch(()=>{});void preflight.catch(()=>{});
 worker.postMessage({boot:childLease.boot,ip:hostIp.split(".").map(Number),port:target.port},[childLease.boot.port]);
 report.channelListener=await bounded(preflight);listenerPort=report.channelListener.port;check(Number.isInteger(listenerPort)&&listenerPort>0,"bad actor listener address");
 const untilTuple=Date.now()+6000;let tuple:any;
 while(Date.now()<untilTuple){
  const raw=execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p","tcp"],{encoding:"utf8",timeout:2000,maxBuffer:2*1024*1024});
  const all=raw.split(/\r?\n/).map(x=>x.trim().split(/\s+/)).filter(x=>x[0]==="TCP"&&x[3]==="ESTABLISHED");
  const owned=all.filter(x=>Number(x[4])===host!.pid&&x[1]===hostIp+":"+target.port);
  const pairs=owned.filter(x=>all.some(y=>Number(y[4])===relay!.pid&&y[1]===x[2]&&y[2]===x[1]));
  if(pairs.length===1){tuple=pairs[0];break;}await new Promise(ok=>setTimeout(ok,20));
 }
 check(tuple&&hostExited===undefined&&endpoints(host.pid).some(r=>r[1]===target.ip+":"+target.port),"missing exact owned host/relay established tuple");
 report.verifiedHostRelayTuple=tuple;worker.postMessage({command:"send"});report.exchange=await bounded(result,12000);
 check(hostExited===undefined&&report.exchange.frame.command===7&&report.exchange.frame.result===0&&report.exchange.frame.playerId>0,"unexpected native reply");report.nativeHostAliveAtReply=true;
}catch(e){failed=e;}
finally{
 const cleanup:Record<string,string>={};const attempt=async(name:string,fn:()=>void|Promise<void>)=>{try{await fn();cleanup[name]="ok";}catch(e){cleanup[name]=String(e);failed??=e;}};
 await attempt("worker",async()=>{if(worker){const done=new Promise<void>(ok=>worker!.addEventListener("close",()=>ok(),{once:true}));worker.terminate();await bounded(done);}});
 await attempt("lease",()=>lease?.close());
 await attempt("listenerRebind",async()=>{if(!listenerPort)return;const end=Date.now()+10000;for(;;){const probe=createServer();try{await bounded(new Promise<void>((ok,no)=>{probe.once("error",no);probe.listen({host:hostIp,port:listenerPort,exclusive:true},ok);}));await bounded(new Promise<void>((ok,no)=>probe.close(e=>e?no(e):ok())));return;}catch(e){try{probe.close();}catch{}if((e as NodeJS.ErrnoException).code!=="EADDRINUSE"||Date.now()>end)throw e;await new Promise(ok=>setTimeout(ok,20));}}});
 await attempt("root",()=>bounded(root?.close()??Promise.resolve()));
 if(relay){await attempt("relaySignal",()=>{relay!.stdin.write("shutdown\n");relay!.stdin.end();});try{retired=JSON.parse(await bounded(line()));exit=await bounded(relay.exited);eof=(await bounded(reader!.read())).done&&buffer.length===0;report.relayStderr=await bounded(err!);check(retired?.explicit&&retired?.retired&&exit===0&&eof,"relay shutdown");cleanup.relay="ok";}catch(e){failed??=e;forced=true;await attempt("relayKill",async()=>{relay!.kill();exit=await bounded(relay!.exited);report.relayStderr=await bounded(err!);});}}
 if(host){await attempt("host",async()=>{host!.stdin.write("x");host!.stdin.end();try{report.hostProcess=await bounded(hostDone!,10000);}catch(e){host!.kill();report.hostProcess=await bounded(hostDone!,10000);report.hostForced=true;throw e;}check(report.hostProcess.exit===0&&report.hostProcess.stdout.includes("CLOSE 00000000"),"host failed to close");});}
 if(build&&buildDone&&!report.build)await attempt("build",async()=>{build!.kill();report.build=await bounded(buildDone!,5000);});
 await attempt("hashes",()=>{after=hashes();check(JSON.stringify(before)===JSON.stringify(after),"inputs changed");if(exeBefore)check(exeBefore===sha(exe),"host executable changed");});
 report.cleanup=cleanup;writeFileSync(join(dir,"result.json"),JSON.stringify({report,before,after,exeBefore,exeAfter:exeBefore?sha(exe):undefined,retired,exit,eof,forced,error:failed?String(failed):null},null,2));
}
if(failed)throw failed;console.log(JSON.stringify(report));
