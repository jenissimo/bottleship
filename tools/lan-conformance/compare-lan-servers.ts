/**
 * Whole-server functional conformance, never a benchmark.
 * bun run tools/lan-conformance/compare-lan-servers.ts --rust-exe <launcher>
 *   --udp-helper <native helper> --output <new directory> [--build-manifest <json>]
 */
import assert from "node:assert/strict";
import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync,existsSync} from "node:fs";
import {resolve,relative,join} from "node:path";
import {createServer,type Socket as TcpSocket} from "node:net";
import {createSocket} from "node:dgram";
import {io,type Socket} from "socket.io-client";
import {createLanServer,type LanServerOptions} from "../../packages/lan/src/server";
import {encodeDatagram,decodeDatagram} from "../../packages/lan/src/protocol";
import {encodeTcpFrame,decodeTcpFrame,SYN,SYNACK,DATA,CREDIT,FIN,RST,TCP_WINDOW,TCP_SEGMENT,SYN_WINDOW_MASK} from "../../packages/lan/src/tcp-protocol";
import {runLanBlackBox} from "../../packages/lan-rust/core/tests/js/black-box";

type Transport="websocket"|"polling";
type Json=Record<string,any>;
const options=new Map<string,string>();
for(let n=2;n<process.argv.length;n+=2){
 const key=process.argv[n],value=process.argv[n+1];
 assert(["--rust-exe","--udp-helper","--output","--build-manifest"].includes(key)&&value&&!options.has(key),"Unknown/missing/duplicate argument "+key);
 options.set(key,value);
}
const binary=resolve(required("--rust-exe")),helper=resolve(required("--udp-helper")),output=resolve(required("--output"));
mkdirSync(output,{recursive:false});
function required(key:string){const value=options.get(key);assert(value,"Required "+key);return value}
const sha=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const save=(name:string,value:unknown)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+"\n");
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function finite<T>(promise:Promise<T>,name:string,ms=6000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<T>((_,reject)=>timer=setTimeout(()=>reject(Error("Deadline: "+name)),ms))])}finally{clearTimeout(timer)}
}
async function until(check:()=>boolean,name:string,ms=6000){const deadline=Date.now()+ms;while(!check()){assert(Date.now()<deadline,"Deadline: "+name);await pause(2)}}
function tree(path:string):string[]{
 return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{
  if(["target",".git","node_modules"].includes(entry.name))return[];
  const next=join(path,entry.name);return entry.isDirectory()?tree(next):[next];
 });
}
function fingerprint(paths:string[]){return Object.fromEntries(paths.sort().map(path=>[relative(process.cwd(),path).replaceAll("\\","/"),existsSync(path)?sha(path):"MISSING"]))}
const collectRust=()=>tree("packages/lan-rust").filter(p=>/\.(rs|toml|lock)$/.test(p)||p.endsWith("LICENSE")||p.endsWith("UPSTREAM.md"));
const rustSources=collectRust();
const referenceSources=[...tree("packages/lan/src"),"packages/lan-rust/core/tests/js/black-box.ts",import.meta.filename].filter(p=>p.endsWith(".ts"));
const before={rust:fingerprint(rustSources),reference:fingerprint(referenceSources),binary:sha(binary),helper:sha(helper)};
save("inputs-before.json",before);copyFileSync(binary,join(output,"conformance-server.exe"));copyFileSync(helper,join(output,"udp-helper.exe"));
const buildManifest=options.get("--build-manifest");
if(buildManifest)copyFileSync(resolve(buildManifest),join(output,"provided-build-manifest.json"));
const evidence:Json[]=[],gatewayDiagnostics:Json[]=[];let failure:Json|undefined,stage="setup";
const nativeSockets=new Set<TcpSocket>();const nativeErrors:string[]=[];
const tcp=createServer({allowHalfOpen:true},socket=>{
 nativeSockets.add(socket);socket.on("data",data=>socket.write(data));socket.on("end",()=>socket.end());
 socket.on("error",e=>nativeErrors.push(String(e)));socket.on("close",()=>nativeSockets.delete(socket));
});
const udp=createSocket("udp4");let udpPackets=0,tcpBytes=0,tcpAccepted=0;
tcp.on("connection",socket=>{tcpAccepted++;socket.on("data",data=>tcpBytes+=data.length)});
udp.on("message",(data,peer)=>{udpPackets++;udp.send(data,peer.port,peer.address,error=>{if(error)nativeErrors.push(String(error))})});
let tcpListening=false,udpListening=false,rust:ChildProcessWithoutNullStreams|undefined,ts:ReturnType<typeof createLanServer>|undefined;
let rustExit:Promise<number|null>|undefined,rustClose:Promise<void>|undefined,rustLog="",rustErrors="",rustLines:Json[]=[],rustReady:Json|undefined,forced=false;
const rustState={exitObserved:false,code:null as number|null,signal:null as string|null,closeObserved:false,closeCode:null as number|null,closeSignal:null as string|null,processError:null as string|null,stdinError:null as string|null};
const streamState=()=>({bytes:0,eof:false,closed:false,error:null as string|null,truncated:false,abandoned:false});
const rustStreams={stdout:streamState(),stderr:streamState()};
let rustRetirement:Json|undefined;
const closeClients=new Set<Socket>();
function event(socket:Socket,name:string,predicate:(args:any[])=>boolean=()=>true,ms=6000):Promise<any[]>{
 return new Promise((resolve,reject)=>{
  const done=(...args:any[])=>{try{if(!predicate(args))return;cleanup();resolve(args)}catch(e){cleanup();reject(e)}};
  const cleanup=()=>{clearTimeout(timer);socket.off(name,done)};
  const timer=setTimeout(()=>{cleanup();reject(Error("Event deadline: "+name))},ms);socket.on(name,done);
 });
}
async function client(url:string,transport:Transport|"upgrade"){
 const socket=io(url,{path:"/socket.io",transports:transport==="upgrade"?["polling","websocket"]:[transport],upgrade:false,reconnection:false,timeout:5000,autoConnect:false,forceNew:true,
  auth:{version:1,room:"whole-"+randomUUID(),clientId:randomUUID(),node:[2,0,0,44,55,66]}});
 closeClients.add(socket);const ready=event(socket,"ready");socket.connect();const [info]=await ready;assert.equal(info.version,1);return socket;
}
async function httpChecks(url:string){
 const health=await fetch(url+"/health",{signal:AbortSignal.timeout(3000)});const raw=await health.text();
 assert.equal(health.status,200);assert.deepEqual(JSON.parse(raw),{service:"bottleship-lan",version:1});assert.equal(health.headers.get("cache-control"),"no-store");
 const allowed=await fetch(url+"/socket.io/?EIO=4&transport=polling",{headers:{origin:"https://allowed.bottleship.test"},signal:AbortSignal.timeout(3000)});
 const allowedBody=await allowed.text();assert.equal(allowed.status,200);assert.equal(allowed.headers.get("access-control-allow-origin"),"https://allowed.bottleship.test");
 assert.notEqual(allowed.headers.get("access-control-allow-credentials"),"true");
 const denied=await fetch(url+"/socket.io/?EIO=4&transport=polling",{headers:{origin:"https://denied.bottleship.test"},signal:AbortSignal.timeout(3000)});
 assert.equal(denied.status,403);const deniedBody=await denied.text();
 return{health:{status:health.status,body:raw,cacheControl:health.headers.get("cache-control")},allowed:{status:allowed.status,body:allowedBody,cors:allowed.headers.get("access-control-allow-origin"),credentials:allowed.headers.get("access-control-allow-credentials")},denied:{status:denied.status,body:deniedBody}};
}
async function upgradeChecks(url:string){
 const socket=await client(url,"upgrade"),engine=socket.io.engine;
 const before={engineSid:engine.id,socketId:socket.id,transport:engine.transport.name};
 assert.equal(before.transport,"polling");const lengths=[0,1,65507];
 // Local LAN forwarding requires another participant in the same authenticated room.
 const peer=io(url,{path:"/socket.io",transports:["polling"],upgrade:false,reconnection:false,autoConnect:false,forceNew:true,
  auth:{...(socket.auth as Record<string,unknown>),node:[2,0,0,44,55,67],clientId:randomUUID()}});
 closeClients.add(peer);const ready=event(peer,"ready");peer.connect();await ready;
 const roundtrip=async()=>{for(const length of lengths){
  const payload=Uint8Array.from({length},(_,n)=>(n*17+3)&255);
  const got=event(peer,"frame");socket.emit("frame",encodeDatagram(1,Uint8Array.of(2,0,0,44,55,67),9001,9002,payload),33);
  const args=await got;assert.equal(args.length,1);const packet=decodeDatagram(new Uint8Array(args[0]));assert(packet);assert.deepEqual(Array.from(packet.node),[2,0,0,44,55,66]);assert.deepEqual(packet.payload,payload);
 }};
 await roundtrip();const upgraded=event(engine as any,"upgrade");(engine as any).opts.upgrade=true;(engine as any)._probe("websocket");await upgraded;
 assert.equal(engine.transport.name,"websocket");await roundtrip();
 const after={engineSid:engine.id,socketId:socket.id,transport:engine.transport.name};assert.equal(after.engineSid,before.engineSid);assert.equal(after.socketId,before.socketId);
 socket.disconnect();peer.disconnect();return{before,after,binaryLengthsBeforeAndAfter:lengths};
}
async function gatewayChecks(url:string,transport:Transport,udpPort:number,tcpPort:number){
 const socket=await client(url,transport);let asynchronousFailure:unknown;
 const ledger:Json={stage,url,transport,socketId:socket.id,engineSid:socket.io.engine.id,phase:"dns",udpComplete:[],frames:[],socketErrors:[],nativeBefore:{tcpAccepted,tcpBytes,udpPackets}};
 gatewayDiagnostics.push(ledger);
 const checkpoint=()=>{ledger.nativeNow={tcpAccepted,tcpBytes,udpPackets};save("gateway-diagnostics.json",gatewayDiagnostics)};
 const remember=(item:Json)=>{ledger.frames.push(item);if(ledger.frames.length>32)ledger.frames.shift()};
 socket.on("socketError",error=>{if(ledger.socketErrors.length<16)ledger.socketErrors.push(error);asynchronousFailure=Error("Unexpected native socket error: "+JSON.stringify(error));checkpoint()});
 socket.on("disconnect",reason=>{ledger.disconnect={reason,phase:ledger.phase};asynchronousFailure??=Error("Unexpected native disconnect: "+reason);checkpoint()});
 const udpNode=Uint8Array.of(2,1,203,0,113,71),tcpNode=Uint8Array.of(2,1,203,0,113,72);
 const resolved=event(socket,"resolved",args=>args[0]===1);socket.emit("resolve",1,{host:"whole-tcp.test",family:4});
 const [,dns]=await resolved;assert.deepEqual(dns.result?.addresses,[{address:"203.0.113.72",family:4}]);assert(!dns.error);
 const refused=event(socket,"resolved",args=>args[0]===2);socket.emit("resolve",2,{host:"unconfigured-whole.test",family:4});
 assert.equal((await refused)[1].error.code,"ACCESS_DENIED");
 const udpLengths=[0,3,65507];ledger.phase="udp";checkpoint();
 for(const length of udpLengths){
  const payload=Uint8Array.from({length},(_,n)=>(n*19+5)&255);
  const got=event(socket,"frame",args=>{const frame=decodeDatagram(new Uint8Array(args[0]));return !!frame&&frame.proto===1&&frame.dstPort===40002});
  socket.emit("frame",encodeDatagram(1,udpNode,udpPort,40002,payload),22);
  const args=await got;assert.equal(args.length,2);assert.equal(args[1],22);
  const frame=decodeDatagram(new Uint8Array(args[0]));assert(frame);assert.equal(frame.srcPort,udpPort);assert.deepEqual(frame.node,udpNode);assert.deepEqual(frame.payload,payload);
  ledger.udpComplete.push(length);checkpoint();
 }
 ledger.phase="udp-release";socket.emit("releasePort",1,40002,22);checkpoint();
 const localId=0x12340000+(transport==="polling"?2:1),localPort=40001,generation=11;
 let peerId=0,credit=0,written=0,read=0,finished=false,returnedCredit=0,dataFrames=0;
 const stream=Uint8Array.from({length:400000},(_,n)=>n%251),received=new Uint8Array(stream.length);
 const send=(kind:number,value=0,data?:Uint8Array)=>{remember({direction:"send",kind,value,bytes:data?.length??0,peerId});return socket.emit("frame",encodeDatagram(2,tcpNode,tcpPort,localPort,encodeTcpFrame(kind,localId,peerId,value,data)),generation)};
 const receive=(raw:unknown,gen?:number)=>{
  try{
   const frame=decodeDatagram(new Uint8Array(raw as ArrayBuffer));if(!frame||frame.proto!==2||frame.dstPort!==localPort)return;
   assert.equal(gen,generation);assert.deepEqual(frame.node,tcpNode);assert.equal(frame.srcPort,tcpPort);
   const packet=decodeTcpFrame(frame.payload);assert(packet);remember({direction:"receive",kind:packet.kind,value:packet.value,bytes:packet.data.length,source:packet.srcId,destination:packet.dstId});assert.equal(packet.dstId,localId);
   if(packet.kind===SYNACK){assert.equal(peerId,0);peerId=packet.srcId;assert(peerId);credit=packet.value&SYN_WINDOW_MASK;}
   else{assert.equal(packet.srcId,peerId);
    if(packet.kind===CREDIT){assert(packet.value<=TCP_WINDOW);credit+=packet.value;returnedCredit+=packet.value;assert(credit<=TCP_WINDOW);}
    else if(packet.kind===DATA){assert(read+packet.data.length<=received.length);received.set(packet.data,read);read+=packet.data.length;dataFrames++;send(CREDIT,packet.data.length);}
    else if(packet.kind===FIN)finished=true;
    else if(packet.kind===RST)throw Error("Native TCP RST: "+packet.value);
   }
  }catch(error){asynchronousFailure=error;}
 };
 socket.on("frame",receive);ledger.phase="tcp-syn";send(SYN,TCP_WINDOW);checkpoint();
 try{
  await until(()=>{if(asynchronousFailure)throw asynchronousFailure;return peerId!==0},"native TCP SYNACK");
  ledger.phase="tcp-stream";checkpoint();
  const deadline=Date.now()+8000;
  while(read<stream.length){
   if(asynchronousFailure)throw asynchronousFailure;assert(Date.now()<deadline,"Native TCP echo deadline");
   while(written<stream.length&&credit>0){
    const length=Math.min(TCP_SEGMENT,credit,stream.length-written);send(DATA,0,stream.subarray(written,written+length));written+=length;credit-=length;
   }
   await pause(1);
  }
  assert.equal(written,stream.length);assert.deepEqual(received,stream);assert(returnedCredit>0);assert(dataFrames>1);
  ledger.phase="tcp-fin";send(FIN);checkpoint();await until(()=>{if(asynchronousFailure)throw asynchronousFailure;return finished},"native FIN/EOF");
  socket.emit("releasePort",2,localPort,generation);
  return{transport,dns:dns.result,denied:"ACCESS_DENIED",udpLengths,tcp:{bytes:read,segments:dataFrames,returnedCredit,fin:true}};
 }finally{ledger.tcp={peerId,credit,written,read,finished,returnedCredit,dataFrames};ledger.error=asynchronousFailure?String(asynchronousFailure):undefined;checkpoint();socket.off("frame",receive);socket.disconnect();}
}
async function startRust(configPath:string){
 rust=spawn(binary,["--config",configPath],{cwd:process.cwd(),stdio:["pipe","pipe","pipe"]});
 rustExit=new Promise((resolve,reject)=>{
  rust!.once("exit",(code,signal)=>{Object.assign(rustState,{exitObserved:true,code,signal});resolve(code)});
  rust!.once("error",error=>{rustState.processError=String(error);reject(error)});
 });
 rustClose=new Promise(resolve=>rust!.once("close",(closeCode,closeSignal)=>{Object.assign(rustState,{closeObserved:true,closeCode,closeSignal});resolve()}));
 rust.stdin.on("error",error=>{rustState.stdinError=String(error)});
 rustExit.catch(()=>{});
 for(const name of ["stdout","stderr"] as const){
  const stream=rust[name],state=rustStreams[name];
  stream.on("end",()=>{state.eof=true});stream.on("close",()=>{state.closed=true});stream.on("error",error=>{state.error=String(error)});
  stream.on("data",chunk=>{state.bytes+=chunk.length;state.truncated=state.bytes>65536});
 }
 rust.stderr.on("data",chunk=>rustErrors=(rustErrors+chunk.toString()).slice(-65536));
 let readyResolve:(value:Json)=>void;let readyReject:(error:unknown)=>void;
 const ready=new Promise<Json>((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
 rust.stdout.on("data",chunk=>{
  rustLog=(rustLog+chunk.toString()).slice(-65536);let partial=(rust as any).__partial??"";partial+=chunk.toString();
  if(partial.length>=131072){readyReject(Error("Rust stdout line exceeded bound"));partial=partial.slice(-65536);}
  let at;while((at=partial.indexOf("\n"))>=0){const line=partial.slice(0,at);partial=partial.slice(at+1);try{const parsed=JSON.parse(line);assert(rustLines.length<32);rustLines.push(parsed);if(parsed.port)readyResolve(parsed)}catch{}}
  (rust as any).__partial=partial;
 });
 rust.once("error",readyReject!);
 rust.once("exit",code=>readyReject(Error("Rust launcher exited before readiness: "+code)));
 rustReady=await finite(ready,"Rust launcher readiness",10000);assert.equal(rustReady.version,1);assert.equal(rustReady.service,"bottleship-lan");
 return"http://127.0.0.1:"+rustReady.port;
}
async function stopRust(){
 if(!rust||!rustExit||!rustClose)return undefined;
 const child=rust,started=Date.now(),issues:string[]=[];let killAttempted=false,killAccepted:boolean|null=null,unrefAttempted=false;
 const fault=(message:string)=>{issues.push(message);failure??={stage:"rust-retirement",message}};
 const snapshot=()=>({pid:child.pid??null,...rustState,forced,killAttempted,killAccepted,unrefAttempted,elapsedMs:Date.now()-started,
  retired:rustLines.find(line=>line.retired===true)??null,stdout:{...rustStreams.stdout},stderr:{...rustStreams.stderr},
  unknown:!rustState.exitObserved,gracefulLimitMs:20000,retirementLimitMs:3000,issues:[...issues]});
 const retain=(name:string,value:unknown)=>{try{save(name,value);return true}catch(error){fault("Rust retirement evidence "+name+": "+String(error));return false}};
 try{
  child.stdin.end("shutdown\n");
  await finite(Promise.all([rustExit,rustClose]),"Rust shutdown, exit and stdio close",20000);
 }catch(error){fault(String(error))}
 if(!rustState.exitObserved||rustState.code!==0||rustState.signal!==null)fault("Rust did not exit naturally with code 0");
 if(!rustState.closeObserved||rustState.closeCode!==0||rustState.closeSignal!==null)fault("Rust child close not observed with code 0");
 if(rustState.processError||rustState.stdinError)fault("Rust process/stdin error");
 for(const [name,state]of Object.entries(rustStreams)){
  if(!state.eof||!state.closed||state.error||state.truncated)fault("Rust "+name+" capture incomplete, errored or truncated");
 }
 if(rustLines.find(line=>line.retired===true)?.explicit!==true)fault("Rust did not acknowledge explicit retirement");
 if(issues.length){
  // Persist the first failure before cleanup; evidence I/O failure must not skip retirement.
  if(!existsSync(join(output,"first-red.json")))retain("first-red.json",failure);
  retain("rust-red-before-cleanup.json",snapshot());
  // Only the original still-live child may be killed, once. Exit without pipe EOF is not a reason to kill another process.
  if(child.pid!==undefined&&!rustState.exitObserved&&!rustState.closeObserved){
   forced=true;killAttempted=true;
   try{killAccepted=child.kill();if(!killAccepted)fault("Rust kill was not accepted")}catch(error){fault("Rust kill: "+String(error))}
  }
  if(!rustState.closeObserved){
   try{await finite(rustClose,"Rust post-failure retirement",3000)}catch(error){fault(String(error))}
  }
  // Abandon only local incomplete handles; never turn their destruction into EOF or a natural-exit claim.
  for(const name of ["stdout","stderr"] as const){
   if(!rustStreams[name].closed){rustStreams[name].abandoned=true;try{child[name].destroy()}catch(error){fault("Rust "+name+" destroy: "+String(error))}}
  }
  if(!rustState.closeObserved){
   try{child.stdin.destroy()}catch(error){fault("Rust stdin destroy: "+String(error))}
   unrefAttempted=true;try{child.unref()}catch(error){fault("Rust unref: "+String(error))}
  }
 }
 rustRetirement=snapshot();if(!retain("rust-retirement.json",rustRetirement))rustRetirement=snapshot();
 if(issues.length)throw Error("Rust retirement failed: "+issues.join("; "));
 return rustRetirement;
}
let retirement:Json|undefined,configPath="",tsPort=0;
try{
 await finite(new Promise<void>((resolve,reject)=>{tcp.once("error",reject);tcp.listen(0,"127.0.0.1",resolve)}),"native TCP listen");tcpListening=true;
 await finite(new Promise<void>((resolve,reject)=>{udp.once("error",reject);udp.bind(0,"127.0.0.1",resolve)}),"native UDP bind");udpListening=true;
 const tcpPort=(tcp.address() as {port:number}).port,udpPort=udp.address().port;
 const config:LanServerOptions & {logConnections:boolean}={host:"127.0.0.1",port:0,logConnections:true,allowedOrigins:["https://allowed.bottleship.test"],transports:["polling","websocket"],gateway:{nativeUdpHelperPath:helper,routes:[
  {host:"127.0.0.1",address:"203.0.113.71",names:["whole-udp.test"],ports:[udpPort],protocols:["udp"]},
  {host:"127.0.0.1",address:"203.0.113.72",names:["whole-tcp.test"],ports:[tcpPort],protocols:["tcp"]},
 ]}};
 configPath=join(output,"config.json");save("config.json",config);copyFileSync(import.meta.filename,join(output,"runner.ts"));
 const configHash=sha(configPath);ts=createLanServer(config);tsPort=await ts.listen();
 const urls:[string,string][]=[["typescript","http://127.0.0.1:"+tsPort],["rust",await startRust(configPath)]];
 for(const [implementation,url]of urls){
  for(const transport of ["websocket","polling"] as const){
   stage=implementation+"/"+transport+"/core-black-box";evidence.push({stage,...await runLanBlackBox({url,transport})});save("progress.json",evidence);
   stage=implementation+"/"+transport+"/native-gateway";evidence.push({stage,...await gatewayChecks(url,transport,udpPort,tcpPort)});save("progress.json",evidence);
  }
  stage=implementation+"/cors-health";evidence.push({stage,...await httpChecks(url)});save("progress.json",evidence);
  stage=implementation+"/controlled-upgrade";evidence.push({stage,...await upgradeChecks(url)});save("progress.json",evidence);
 }
 assert.equal(sha(configPath),configHash,"Generated config changed during run");
}catch(error){failure={stage,message:String(error),stack:(error as Error).stack};save("first-red.json",failure);}
finally{
 for(const socket of closeClients){socket.removeAllListeners();socket.disconnect();}
 if(ts){try{await finite(ts.close(),"TS server close",10000)}catch(error){failure??={stage:"typescript-retirement",message:String(error)}}}
 try{retirement=await stopRust()}catch(error){retirement=rustRetirement;failure??={stage:"rust-retirement",message:String(error)}}
 let nativeForced=false;
 try{await until(()=>nativeSockets.size===0,"native stream retirement",3000)}catch(error){failure??={stage:"native-retirement",message:String(error)};nativeForced=true;for(const socket of nativeSockets)socket.destroy();}
 if(tcpListening)await finite(new Promise<void>(resolve=>tcp.close(()=>resolve())),"native TCP close");
 if(udpListening)await finite(new Promise<void>(resolve=>udp.close(()=>resolve())),"native UDP close");
 const after={rust:fingerprint(collectRust()),reference:fingerprint(referenceSources),binary:sha(binary),helper:sha(helper)};
 save("inputs-after.json",after);
 if(before.binary!==after.binary||before.helper!==after.helper||JSON.stringify(before.reference)!==JSON.stringify(after.reference))failure??={stage:"input-stability",message:"Binary/helper/imported TS source changed"};
 writeFileSync(join(output,"rust-stdout.log"),rustLog);writeFileSync(join(output,"rust-stderr.log"),rustErrors);
 const report={status:failure?"FAIL":"PASS",kind:"functional conformance; not benchmark",failure,evidence,retirement,native:{udpPackets,tcpBytes,tcpAccepted,forced:nativeForced,errors:nativeErrors},gatewayDiagnostics,runtime:{version:process.version,bun:Bun.version},provenance:{
  rustSource:"Observed current source hashes; not certified as executable build input",
  providedBuildManifest:buildManifest?{path:resolve(buildManifest),sha256:sha(resolve(buildManifest))}:null,
  rustCurrentSourcesChanged:JSON.stringify(before.rust)!==JSON.stringify(after.rust),binary:before.binary,helper:before.helper,
 },config:configPath?{path:configPath,sha256:sha(configPath)}:null};
 if(failure&&!existsSync(join(output,"first-red.json")))save("first-red.json",failure);
 save("report.json",report);const reportSha256=sha(join(output,"report.json"));save("report-hash.json",{sha256:reportSha256});console.log(JSON.stringify({output,status:report.status,failure,completed:evidence.map(item=>item.stage),retirement,native:report.native,binary:before.binary,reportSha256}));
 if(failure)process.exitCode=1;
}
