/** Experimental DP4 host oracle + real Rust relay. No packet capture or service control. */
import {createHash,randomBytes} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {createServer} from "node:net";
import {once} from "node:events";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
const [binary,hostExe,output,transport,mode]=process.argv.slice(2);
if(!binary||!hostExe||!output||!["websocket","polling"].includes(transport)||!["match","mismatch"].includes(mode)||process.argv.length!==7)
 throw Error("usage: directplay4-native-rust <relay.exe> <host.exe> <new-dir> <websocket|polling> <match|mismatch>");
mkdirSync(output,{recursive:false});const dir=resolve(output);
const workerPath=resolve("tools/lan-conformance/directplay4-native-rust-worker.ts");
const hostSource=resolve("tools/lan-conformance/directplay4-discovery.c");
const helper=resolve("logs/lan-conformance/stage54-rust-startup-dns/lan-conformance-first/udp-helper.exe");
const runtimePaths=["src/worker/modules/dplayx/native-wire/discovery.ts","src/worker/modules/dplayx/native-wire/lan-discovery.ts","src/worker/modules/wsa-network.ts","src/worker/modules/wsa-actor-kernel.ts","src/worker/modules/wsa-actor-table.ts","src/worker/modules/wsa-actor-worker.ts","src/worker/core/network-namespace.ts","src/worker/net/lan-network.ts","src/worker/net/relay-link.ts","src/worker/net/tcp-host-lease-rpc.ts"];
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes=()=>({binary:sha(binary),hostExe:sha(hostExe),hostSource:sha(hostSource),runner:sha(import.meta.filename),worker:sha(workerPath),udpHelper:sha(helper),runtime:Object.fromEntries(runtimePaths.map(p=>[p,sha(p)]))});
const bounded=async<T>(p:Promise<T>,ms=10000):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,no)=>timer=setTimeout(()=>no(Error("deadline")),ms))]);}finally{clearTimeout(timer);}};
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
const result:Record<string,unknown>={transport,mode,capabilityInjected:true,endpointOwnership:"observed only"};
let failed:unknown,root:RootNetworkNamespace|undefined,worker:Worker|undefined,lease:{close():void}|undefined;
let server:ReturnType<typeof Bun.spawn>|undefined,host:ReturnType<typeof Bun.spawn>|undefined,hostExit:number|undefined,hostOutput:Promise<any>|undefined;
let serverOut:ReadableStreamDefaultReader<Uint8Array>|undefined,serverErr:Promise<string>|undefined,buffer="",retired:any,serverExit:number|undefined,eof=false,forced=false;
let before:any,after:any,listenerPort=0,configHash:string|undefined,hostResult:any;
async function line(){for(;;){const i=buffer.indexOf("\n");if(i>=0){const s=buffer.slice(0,i);buffer=buffer.slice(i+1);return s;}const x=await serverOut!.read();if(x.done)throw Error("relay stdout ended");buffer+=new TextDecoder().decode(x.value,{stream:true});}}
async function endpointSnapshot(){
 const script="$ErrorActionPreference='Stop'; @(Get-NetUDPEndpoint | Where-Object LocalPort -eq 47624 | ForEach-Object { $p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; @{address=$_.LocalAddress;port=$_.LocalPort;pid=$_.OwningProcess;name=$p.ProcessName} }) | ConvertTo-Json -Depth 4 -Compress";
 const proc=Bun.spawn(["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe","-NoProfile","-NonInteractive","-Command",script],{stdout:"pipe",stderr:"pipe"});
 const out=new Response(proc.stdout).text(),err=new Response(proc.stderr).text();const [exit,stdout,stderr]=await bounded(Promise.all([proc.exited,out,err]));
 check(exit===0,"endpoint observation failed: "+stderr);
 return {pid:proc.pid,exit,stdout,stderr,stdoutEof:true,stderrEof:true,observedAt:new Date().toISOString()};
}
async function waitReady(nonce:number,pid:number){
 const path=join(dir,"host-ready.bin"),deadline=Date.now()+20000;
 while(Date.now()<deadline){
  if(hostExit!==undefined)throw Error("host exited before ready: "+hostExit);
  try{if(existsSync(path)){const b=readFileSync(path);if(b.length===20){
   check(b.readUInt32LE(0)===0x34525044&&b.readUInt32LE(4)===nonce&&b.readUInt32LE(8)===pid,"invalid host READY");
   check(b.readUInt32LE(12)===0&&b.readUInt32LE(16)===0,"host Open/CreatePlayer failed");
   return {sha256:sha(path),open:b.readUInt32LE(12),player:b.readUInt32LE(16)};
  }}}catch(e){if(!String(e).includes("EBUSY")&&!String(e).includes("EPERM"))throw e;}
  await new Promise(ok=>setTimeout(ok,25));
 }throw Error("host READY deadline");
}
async function rebind(port:number){
 const until=Date.now()+10000;
 for(;;){const probe=createServer();try{await new Promise<void>((ok,no)=>{probe.once("error",no);probe.listen({host:"127.0.0.1",port,exclusive:true},ok);});await new Promise<void>((ok,no)=>probe.close(e=>e?no(e):ok()));return;}
 catch(e){try{probe.close();}catch{}if((e as NodeJS.ErrnoException).code!=="EADDRINUSE"||Date.now()>until)throw e;await new Promise(ok=>setTimeout(ok,10));}}
}
try {
 before=hashes();
 const nonce=randomBytes(4).readUInt32LE()||1,guid=Buffer.from("000000001973e14aa3928047312f9ad1","hex");guid.writeUInt32LE(mode==="match"?nonce:(nonce^1)>>>0,0);
 result.nonce=nonce;result.guid=guid.toString("hex");
 result.endpointBefore=await endpointSnapshot();
 const config=join(dir,"config.json");writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],gateway:{nativeUdpHelperPath:helper,routes:[{host:"127.0.0.1",address:"192.0.2.1",ports:[47624],protocols:["udp"]}],tcpListeners:[{id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.1"],maxPending:8}]}}));configHash=sha(config);
 server=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});serverErr=new Response(server.stderr).text();serverOut=server.stdout.getReader();
 const hello=JSON.parse(await bounded(line()));check(hello.service==="bottleship-lan"&&hello.port>0,"bad relay ready");
 root=new RootNetworkNamespace(new LanNetwork(),16,36400);
 await bounded(root.configure({serverUrl:"http://127.0.0.1:"+hello.port,room:"dp4-native-"+nonce,winsock:{provider:"native",hostListener:"game"}}));
 const internal=root as any,link=internal.active.link;
 check(link.socket.io.engine.transport.name===transport,"wrong transport");check(!internal.backplane.tcpHostListenV1,"capability already published");
 internal.backplane.configureTcpHosts({listeners:[{id:"game",allowedNodes:[[2,1,127,0,0,1]]}]});internal.state(internal.snapshot());
 host=Bun.spawn([resolve(hostExe),"host",String(nonce),dir,"10000","match"],{stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 const h=host;const stdout=new Response(h.stdout).arrayBuffer(),stderr=new Response(h.stderr).arrayBuffer();
 const hostExited=h.exited.then(code=>{hostExit=code;return code;});
 hostOutput=Promise.all([hostExited,stdout,stderr]).then(([code,out,err])=>{const a=Buffer.from(out),b=Buffer.from(err);writeFileSync(join(dir,"host-stdout.bin"),a);writeFileSync(join(dir,"host-stderr.bin"),b);return {pid:h.pid,exit:code,stdoutEof:true,stderrEof:true,stdoutSha256:sha(join(dir,"host-stdout.bin")),stderrSha256:sha(join(dir,"host-stderr.bin"))};});
 void hostOutput.catch(()=>{});
 result.hostReady=await waitReady(nonce,h.pid);result.endpointAfterReady=await endpointSnapshot();
 const child=root.createChild(36401);lease=child;worker=new Worker(new URL("./directplay4-native-rust-worker.ts",import.meta.url).href,{type:"module"});
 const response=bounded(new Promise<any>((ok,no)=>{worker!.onmessage=({data})=>data.error?no(Error(data.error)):ok(data.result);worker!.onerror=e=>no(Error(e.message));}),8000);void response.catch(()=>{});
 const opened=bounded(once(link.socket,"tcpHostOpened"),8000);void opened.catch(()=>{});
 worker.postMessage({id:1,boot:child.boot,guid:[...guid]},[child.boot.port]);
 const [,openReply]=await opened;check(openReply.address?.port>0&&!openReply.error,"listener failed");listenerPort=openReply.address.port;
 const replies=await response;result.replies=replies;result.hostAliveAtReply=hostExit===undefined;
 check(result.hostAliveAtReply,"host exited before response");
 if(mode==="match")check(replies.length===1&&Buffer.from(replies[0].applicationGuid).equals(guid)&&replies[0].name==="DP4-oracleЖ"&&replies[0].maxPlayers===8&&replies[0].currentPlayers===1,"native matching session missing");
 else check(replies.length===0,"mismatched GUID produced a reply");
}catch(e){failed=e;}
finally {
 const cleanup:Record<string,string>={};const attempt=async(name:string,fn:()=>void|Promise<void>)=>{try{await fn();cleanup[name]="ok";}catch(e){cleanup[name]=String(e);failed??=e;}};
 await attempt("worker",async()=>{if(worker){const stopped=new Promise<void>(ok=>worker!.addEventListener("close",()=>ok(),{once:true}));worker.terminate();await bounded(stopped);}});
 await attempt("lease",()=>{lease?.close();});
 await attempt("listenerRebind",async()=>{if(listenerPort)await rebind(listenerPort);});
 await attempt("root",()=>bounded(root?.close()??Promise.resolve()));
 await attempt("host",async()=>{if(hostOutput){const observed=await bounded(hostOutput,25000);result.hostProcess=observed;check(observed.exit===0,"host process failure");const p=join(dir,"host-result.bin"),b=readFileSync(p);check(b.readUInt32LE(0)===0x344f5044&&b.readUInt32LE(8)===result.nonce&&b.readUInt32LE(16)===observed.pid&&b.readUInt32LE(48)===0&&b.readUInt32LE(52)===0&&b.readUInt32LE(60)===0,"host result failed");hostResult={sha256:sha(p),open:b.readUInt32LE(48),player:b.readUInt32LE(52),close:b.readUInt32LE(60)};}});
 if(server){await attempt("relayShutdown",()=>{server!.stdin.write("shutdown\n");server!.stdin.end();});try{retired=JSON.parse(await bounded(line()));serverExit=await bounded(server.exited);const r=await bounded(serverOut!.read());eof=r.done&&buffer.length===0;result.relayStderr=await bounded(serverErr!);check(retired?.retired&&retired?.explicit&&serverExit===0&&eof,"relay cleanup");cleanup.relay="ok";}catch(e){failed??=e;cleanup.relay=String(e);forced=true;await attempt("relayKill",async()=>{server!.kill();serverExit=await bounded(server!.exited);});}}
 await attempt("afterHashes",()=>{after=hashes();check(JSON.stringify(before)===JSON.stringify(after),"inputs changed");});
 result.cleanup=cleanup;writeFileSync(join(dir,"result.json"),JSON.stringify({result,hostResult,retired,serverExit,eof,forced,before,after,configHash,error:failed?String(failed):null},null,2));
}
if(failed)throw failed;console.log(JSON.stringify(result));
