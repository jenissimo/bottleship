/**
 * Finite SAME-PE connected SetPeerInfo native Host ↔ guest COM Peer reverse proof through an explicitly configured UDP route.
 * This is functional conformance, never a benchmark. Run only with an allocated browser slot.
 */
import {createHash} from "node:crypto";
import {createSocket} from "node:dgram";
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
import {basename,dirname,join,relative,resolve} from "node:path";
import {harness,closeHarnessConnection} from "../harness";

const usage="bun tools/lan-conformance/interop-directplay8-peer-info-reverse.ts --proof <prepared directory> --output <NEW dir> --server-exe <conformance-server.exe> --source-manifest <FINAL freeze source.json> --transport <websocket|polling> [--bundle <SAME WGB path|URL>]";
if(process.argv.includes("--help")){console.log(usage);process.exit(0);}
const cli=new Map<string,string>(),args=process.argv.slice(2);
for(let n=0;n<args.length;n+=2){
 const key=args[n],value=args[n+1];
 if(!["--proof","--output","--server-exe","--source-manifest","--transport","--bundle"].includes(key)||!value||value.startsWith("--")||cli.has(key))throw Error(usage);
 cli.set(key,value);
}
const required=(key:string)=>{const value=cli.get(key);if(!value)throw Error(usage);return value;};
if(process.platform!=="win32")throw Error("The immutable native Host PE requires Windows");
const baseline=resolve(required("--proof")),output=resolve(required("--output")),transport=required("--transport");
const serverExe=resolve(required("--server-exe")),frozenPath=resolve(required("--source-manifest"));
if(!["websocket","polling"].includes(transport))throw Error(usage);
if(existsSync(output))throw Error("Output exists; evidence is immutable");
mkdirSync(output,{recursive:true});
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex"),fileSha=(path:string)=>sha(readFileSync(path));
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+"\n");
const buildPath=join(baseline,"build.json"),build=JSON.parse(readFileSync(buildPath,"utf8")),nonce:number=build.nonce,ports:number[]=build.ports;
const exe=build.executable,source=build.source,progress:unknown[]=[];
if(build.executableSha256!=="37e9fdcef29b0d69ae05d02bbe6c0a6acbdc7b09ce10fe1744f83226296099c1"||build.sourceSha256!=="1ea01926588983162ddc31232f5a5db586949b53f7bdc63225be8964e1839c58"||build.references?.[0]?.sha256!=="771eaa0e0eba48ea072edbc01f767917a8aa406587cd15126a473eaea5da6af6"||build.references?.[1]?.sha256!=="e822d99d7f0d71cbf552aeeb80a7bd5b6ac26bfe2f82a79609f4389a1f8273ec"||build.nativeProof?.sha256!=="15e2de040cde6cc4da8f5fb6ad48820362331f7fba524a49d0875f368bc9ab28")throw Error("This reverse proof must use the exact immutable native988 inputs");
const note=(kind:string,data:unknown=null)=>{progress.push({at:new Date().toISOString(),kind,data});save(join(output,"progress.json"),progress);};
if(build.guestRole!=="peer"||build.fixture!=="directplay8-peer-info"||build.status!=="prepared"||ports.length!==2||ports[1]!==ports[0]+1||fileSha(exe)!==build.executableSha256||fileSha(source)!==build.sourceSha256)throw Error("Prepared native proof/PE/source guard failed");
if(build.traces?.length!==4||build.traces.some((r:any)=>fileSha(r.path)!==r.sha256))throw Error("Native callback trace guard failed");
if(build.references.length!==2||build.references.reduce((n:number,r:any)=>n+r.observations,0)!==988||build.references.some((r:any)=>fileSha(r.path)!==r.sha256)||fileSha(build.nativeProof.path)!==build.nativeProof.sha256)throw Error("Native reference guard failed");
const inputPaths=[buildPath,exe,source,build.bundle,build.nativeProof.path,...build.references.map((r:any)=>r.path),...build.traces.map((r:any)=>r.path),serverExe,frozenPath];
const fingerprint=(paths:string[])=>paths.sort().map(path=>({path:relative(process.cwd(),path).replaceAll("\\","/"),sha256:fileSha(path)}));
const tree=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>["target","node_modules",".git"].includes(entry.name)?[]:entry.isDirectory()?tree(join(dir,entry.name)):[join(dir,entry.name)]);
const sourcePaths=[...tree("src").filter(p=>/\.(ts|tsx)$/.test(p)),...tree("packages/lan-rust").filter(p=>/\.(rs|toml|lock)$/.test(p)),...tree("packages/lan/src").filter(p=>p.endsWith(".ts")),import.meta.filename];
const frozen=JSON.parse(readFileSync(frozenPath,"utf8"));
if(!frozen.source||typeof frozen.source!=="object"||Array.isArray(frozen.source))throw Error("Final source manifest must contain source:{relativePath:sha256}");
const verifyFrozen=()=>{
 const entries=Object.entries(frozen.source) as [string,string][];
 for(const [path,hash]of entries)if(typeof hash!=="string"||fileSha(path)!==hash)throw Error("Frozen source changed: "+path);
 for(const path of sourcePaths)if(path!==import.meta.filename&&!frozen.source[path.replaceAll("\\","/")])throw Error("Runtime source missing from final freeze: "+path);
 return{path:frozenPath,sha256:fileSha(frozenPath),files:entries.length};
};
const frozenBefore=verifyFrozen();
const sourceBefore=fingerprint(sourcePaths),inputsBefore=fingerprint(inputPaths);
copyFileSync(frozenPath,join(output,"runtime-source-manifest.json"));
save(join(output,"source-map-before.json"),sourceBefore);save(join(output,"inputs-before.json"),inputsBefore);
copyFileSync(import.meta.filename,join(output,"runner.ts"));copyFileSync(exe,join(output,"native-host.exe"));copyFileSync(source,join(output,"native-fixture.c"));
save(join(output,"environment.json"),{tab:process.env.BS_TAB??"",devUrl:process.env.BS_DEV_URL??"",cdpPort:process.env.BS_CDP_PORT??"",sidecarPort:process.env.BS_SIDECAR_PORT??"",transport,nonce,ports,serverExecutableSha256:serverExe?fileSha(serverExe):null});
const until=async(check:()=>boolean|Promise<boolean>,label:string,ms:number,live:()=>void=()=>{})=>{
 const end=Date.now()+ms;while(!await check()){live();if(Date.now()>=end)throw Error(label+" deadline");await Bun.sleep(20);}note(label);
};
async function finite<T>(promise:Promise<T>,label:string,ms:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<T>((_,reject)=>timer=setTimeout(()=>reject(Error(label+" deadline")),ms))]);}finally{if(timer)clearTimeout(timer);}
}
function localMarker(cwd:string,name:string){try{const bytes=readFileSync(join(cwd,name));return bytes.length===4&&bytes.readUInt32LE()===nonce;}catch{return false;}}
function mark(cwd:string,name:string){const b=Buffer.alloc(4);b.writeUInt32LE(nonce);writeFileSync(join(cwd,name),b);}
async function guestFile(name:string,archive?:string):Promise<Buffer|null>{
 const path="C:\\"+name,stat=await harness().fsStat(path).run();
 if(!stat.ok||!(stat.named.fsStat as {exists?:boolean})?.exists)return null;
 const result=await harness().fsRead(path).run(),record=result.named.fsRead as {content?:string;truncated?:boolean}|undefined;
 if(!result.ok||record?.truncated||!record?.content)return null;
 const bytes=Buffer.from(record.content,"base64");if(archive)writeFileSync(archive,bytes);return bytes;
}
async function guestMarked(name:string){const b=await guestFile(name);return !!b&&b.length===4&&b.readUInt32LE()===nonce;}
async function guestMark(name:string){
 const b=Buffer.alloc(4);b.writeUInt32LE(nonce);const r=await harness().fsWrite("C:\\"+name,b.toString("base64"),{encoding:"base64"}).run();
 if(!r.ok)throw Error("Guest marker write failed: "+name);note("guest-marker",name);
}
async function cleanupPorts(){
 const result=[];for(const port of ports){
  const deadline=Date.now()+2000;let attempts=0;
  for(;;){
   const socket=createSocket("udp4");let busy=false;attempts++;
   try{await finite(new Promise<void>((ok,no)=>{socket.once("error",no);socket.bind(port,"127.0.0.1",ok);}),"port rebind",500);result.push({port,available:true,attempts});break;}
   catch(error){if((error as {code?:string}).code!=="EADDRINUSE"||Date.now()>=deadline)throw error;busy=true;}
   finally{try{await new Promise<void>(ok=>socket.close(()=>ok()));}catch{}}
   if(busy)await Bun.sleep(20);
  }
 }return result;
}
function compare(reference:string,actual:Buffer,destination:string){
 const expected=readFileSync(reference);
 if(expected.length%4||actual.length%4||expected.length<12||actual.length<12||expected.readUInt32LE()!==0x42534c4e||actual.readUInt32LE()!==0x42534c4e||expected.readUInt32LE(8)!==nonce||actual.readUInt32LE(8)!==nonce||actual.readUInt32LE(4)*4!==actual.length)throw Error("Invalid oracle record");
 const differences=[];for(let i=0;i<Math.max(expected.length,actual.length);i+=4){
  const native=i<expected.length?expected.readUInt32LE(i):null,guest=i<actual.length?actual.readUInt32LE(i):null;
  if(native!==guest)differences.push({word:i/4,observation:i/4-3,native,guest});
 }
 const comparison={nonce,executableSha256:build.executableSha256,reference,referenceSha256:sha(expected),actualSha256:sha(actual),observations:expected.length/4-3,taggedChecks:(expected.length/4-3)/2,differences};
 save(destination,comparison);return comparison;
}
function infoTrace(headerPath:string,rowsPath:string,role:number){
 const header=readFileSync(headerPath),body=readFileSync(rowsPath);
 if(header.length!==24||header.readUInt32LE(0)!==0x42534946||header.readUInt32LE(4)!==1||header.readUInt32LE(8)!==nonce||header.readUInt32LE(12)!==role||header.readUInt32LE(16)>128||header.readUInt32LE(20)!==0||body.length!==header.readUInt32LE(16)*64)throw Error("Incomplete or overflowing INFO callback trace");
 const raw=Array.from({length:body.length/64},(_,i)=>Array.from({length:16},(_,j)=>body.readUInt32LE(i*64+j*4)));
 const info=raw.filter(row=>row[3]===0xffff0010).map(row=>[row[3],row[4],row[5],row[7],...row.slice(8,10),...row.slice(11)]);
 return{count:raw.length,info,raw};
}
function compareTrace(actualHeader:string,actualRows:string,role:number,destination:string){
 const actual=infoTrace(actualHeader,actualRows,role),native=infoTrace(build.traces[role*2].path,build.traces[role*2+1].path,role);
 const matched=JSON.stringify(actual.info)===JSON.stringify(native.info);save(destination,{matched,native,actual});
 if(!matched)throw Error("INFO callback query/context trace differs from native");
 return{matched,callbackCount:actual.count,infoCount:actual.info.length};
}
let server:ReturnType<typeof Bun.spawn>|undefined,serverExit:number|null=null,serverLogs:Promise<void>|undefined,serverForced=false,url:string|undefined;
const phases:unknown[]=[];let failed:string|null=null;

interface OwnedUdpEndpoint {LocalAddress:string;LocalPort:number;OwningProcess:number;}
const portEvidence:{stage:string;pid:number;endpoints:OwnedUdpEndpoint[]}[]=[];
async function ownedUdp(stage:string):Promise<OwnedUdpEndpoint[]>{
 if(!server||serverExit!==null)throw Error("Owned gateway process is not live for UDP endpoint proof");
 const pid=server.pid;
 const command="$ErrorActionPreference='Stop'; $owned = @(Get-NetUDPEndpoint -ErrorAction Stop | Where-Object { $_.OwningProcess -eq "+pid+" } | Select-Object LocalAddress,LocalPort,OwningProcess); ConvertTo-Json -InputObject $owned -Compress";
 const query=Bun.spawn(["powershell.exe","-NoProfile","-NonInteractive","-Command",command],{stdout:"pipe",stderr:"pipe"});
 const captured=Promise.all([new Response(query.stdout).text(),new Response(query.stderr).text(),query.exited]);
 let result:[string,string,number];
 try{result=await finite(captured,"owned UDP endpoint query",5000);}catch(error){query.kill();await query.exited;throw error;}
 const [stdout,stderr,exit]=result;
 writeFileSync(join(output,"owned-udp-"+stage+".stdout.txt"),stdout);writeFileSync(join(output,"owned-udp-"+stage+".stderr.txt"),stderr);
 if(exit||stdout.length>65536)throw Error("Cannot establish actual owned UDP endpoint identity");
 const endpoints=JSON.parse(stdout) as OwnedUdpEndpoint[];
 if(!Array.isArray(endpoints)||endpoints.length>16||endpoints.some(e=>e.OwningProcess!==pid||!Number.isInteger(e.LocalPort)||e.LocalPort<1||e.LocalPort>65535||!["127.0.0.1","0.0.0.0"].includes(e.LocalAddress)))throw Error("Unexpected owned UDP endpoint shape/budget");
 portEvidence.push({stage,pid,endpoints});save(join(output,"owned-udp-endpoints.json"),portEvidence);return endpoints;
}
async function rebindActual(endpoints:OwnedUdpEndpoint[]){
 const rebound=[];
 for(const endpoint of endpoints){
  const socket=createSocket("udp4");
  try{await finite(new Promise<void>((ok,no)=>{socket.once("error",no);socket.bind(endpoint.LocalPort,endpoint.LocalAddress,ok);}),"actual gateway port rebind",2000);rebound.push({...endpoint,rebound:true});}
  finally{try{await new Promise<void>(ok=>socket.close(()=>ok()));}catch{}}
 }
 return rebound;
}

try{
 if(serverExe){
  const config={host:"127.0.0.1",port:0,transports:[transport],gateway:{routes:[{host:"127.0.0.1",address:"127.0.0.1",ports:[ports[0]],protocols:["udp"]}]}};
  const path=join(output,"server-config.json");save(path,config);
  server=Bun.spawn([serverExe,"--config",path],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  let stdout="",stderr="",ready:{port:number}|undefined,overflow=false;
  const collect=async(stream:ReadableStream<Uint8Array>,kind:"stdout"|"stderr")=>{
   const reader=stream.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(kind==="stdout")stdout+=new TextDecoder().decode(value);else stderr+=new TextDecoder().decode(value);
    if(stdout.length+stderr.length>1024*1024){overflow=true;await reader.cancel();break;}
    for(const line of stdout.split(/\r?\n/)){try{const v=JSON.parse(line);if(v.service==="bottleship-lan"&&v.version===1&&Number.isInteger(v.port)&&v.port>0&&v.port<=65535)ready=v;}catch{}}
    writeFileSync(join(output,"server.stdout.txt"),stdout);writeFileSync(join(output,"server.stderr.txt"),stderr);
   }}finally{reader.releaseLock();}
  };
  serverLogs=Promise.all([collect(server.stdout as ReadableStream<Uint8Array>,"stdout"),collect(server.stderr as ReadableStream<Uint8Array>,"stderr")]).then(()=>{});
  void server.exited.then(code=>{serverExit=code;note("server-exit",{pid:server!.pid,code});});
  note("server-spawn",{pid:server.pid,exe:serverExe,sha256:fileSha(serverExe)});
  await until(()=>!!ready,"server-ready",8000,()=>{if(overflow||serverExit!==null)throw Error("Server failed before READY");});
  url="http://127.0.0.1:"+ready!.port;
 }
 const origin=new URL(url!);if(origin.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(origin.hostname))throw Error("This ordinary loopback proof requires a local HTTP server");
 const folder=join(output,"connected"),nativeFolder=join(folder,"native-host"),guestFolder=join(folder,"guest-peer");mkdirSync(nativeFolder,{recursive:true});mkdirSync(guestFolder);
 const bundle=cli.get("--bundle")??build.bundle;
 const bundleBytes=/^https?:/.test(bundle)?Buffer.from(await (await fetch(bundle,{signal:AbortSignal.timeout(10000)})).arrayBuffer()):readFileSync(bundle);
 if(sha(bundleBytes)!==build.bundleSha256||fileSha(build.bundle)!==build.bundleSha256)throw Error("Immutable reverse WGB byte guard failed");
 save(join(folder,"served-bundle.json"),{bundle,sha256:sha(bundleBytes),original:build.bundle,originalSha256:build.bundleSha256,guestArgs:"--peer"});
 const network={serverUrl:origin.origin,room:"peer-info-reverse-"+nonce};
 const connect="new Promise((resolve,reject)=>{const worker=window.worker;const timer=setTimeout(()=>{worker.removeEventListener('message',done);reject(Error('LAN readiness timeout'));},15000);const done=e=>{if(e.data?.type!=='network_state'||!['connected','error'].includes(e.data.status.state))return;clearTimeout(timer);worker.removeEventListener('message',done);if(e.data.status.state==='connected')resolve(e.data.status);else reject(Error(e.data.status.reason));};worker.addEventListener('message',done);worker.postMessage({type:'set_network',network:"+JSON.stringify(network)+"});})";
 let nativeHost:ReturnType<typeof Bun.spawn>|undefined,nativeExit:number|null=null,nativeLogs:Promise<void>|undefined,nativeForced=false,phaseFailure:string|null=null;
 let gatewayEndpoints:OwnedUdpEndpoint[]=[];
 const artifacts=["info-progress.bin","info-callback-header.bin","info-callback-rows.bin","info-watchdog.bin","lan-oracle.bin"];
 const deadline=Date.now()+75000;
 const live=()=>{if(nativeExit!==null)throw Error("Native Host exited early: "+nativeExit);if(serverExit!==null)throw Error("Server exited early: "+serverExit);if(Date.now()>=deadline)throw Error("Whole reverse SetPeerInfo deadline");};
 try{
  // Warm/reload the worker BEFORE native Host starts its unchanged eight-second peer wait.
  const prepared=await harness().reload().evalPage(connect,20000).run();save(join(folder,"worker-readiness.json"),prepared);if(!prepared.ok)throw Error("Guest worker/network preparation failed");
  if((await ownedUdp("before-native-host")).length)throw Error("New route-only server unexpectedly owns a UDP binding before guest Connect");
  nativeHost=Bun.spawn([exe],{cwd:nativeFolder,stdout:"pipe",stderr:"pipe"});
  nativeLogs=Promise.all([new Response(nativeHost.stdout).text(),new Response(nativeHost.stderr).text()]).then(([out,error])=>{writeFileSync(join(nativeFolder,"stdout.txt"),out);writeFileSync(join(nativeFolder,"stderr.txt"),error);});
  void nativeHost.exited.then(code=>{nativeExit=code;note("native-host-exit",{pid:nativeHost!.pid,code});});note("native-host-spawn",{pid:nativeHost.pid,sha256:fileSha(exe),args:[]});
  await until(()=>localMarker(nativeFolder,"host-ready.bin"),"native-host-ready",8000,live);
  const hostUrl=readFileSync(join(nativeFolder,"info-host-address-url.bin")).toString("utf16le").split("\0")[0];
  if(!hostUrl.includes(";hostname=127.0.0.1;port="+ports[0])||!/port=\d+$/.test(hostUrl))throw Error("Native Host endpoint differs from SAME Peer address: "+hostUrl);
  note("actual-native-host-endpoint",{url:hostUrl,port:ports[0]});
  const loaded=await harness().openWgb(bundle,{reload:false}).run();save(join(folder,"load.json"),loaded);if(!loaded.ok)throw Error("Guest Peer load failed");
  await until(async()=>localMarker(nativeFolder,"connected.bin")&&await guestMarked("connected.bin"),"both-connected",8000,live);
  gatewayEndpoints=await ownedUdp("connected");if(!gatewayEndpoints.length)throw Error("No actual native UDP gateway binding was observed");
  for(let step=2;step<=8;step++){
   await until(async()=>localMarker(nativeFolder,"step-"+step+"-ready.bin")&&await guestMarked("step-"+step+"-ready.bin"),"step"+step+":ready",5000,live);
   mark(nativeFolder,"step-"+step+"-go.bin");await guestMark("step-"+step+"-go.bin");
   await until(async()=>localMarker(nativeFolder,"step-"+step+"-done.bin")&&await guestMarked("step-"+step+"-done.bin"),"step"+step+":done",7000,live);
   await guestFile("info-callback-header.bin",join(guestFolder,"step-"+step+"-callback-header.bin"));
   await guestFile("info-callback-rows.bin",join(guestFolder,"step-"+step+"-callback-rows.bin"));
  }
  await until(async()=>localMarker(nativeFolder,"all-steps-done.bin")&&await guestMarked("all-steps-done.bin"),"all-steps-done",4000,live);
  await guestMark("peer-close-go.bin");await until(()=>guestMarked("done.bin"),"guest-peer-close-returned",7000,live);
  await until(()=>localMarker(nativeFolder,"host-peer-closed.bin"),"native-host-observed-peer-close",5000,live);
  // This is the OS gateway binding, not the requested virtual guest port 55173.
  let remaining:OwnedUdpEndpoint[]=[];
  for(let attempt=0;attempt<3;attempt++){remaining=await ownedUdp("after-guest-close-"+attempt);if(!remaining.length)break;await Bun.sleep(50);}
  if(remaining.length)throw Error("Gateway UDP binding survives guest Close before server shutdown");
  const actualGatewayCleanup=await rebindActual(gatewayEndpoints);save(join(folder,"actual-gateway-ports-before-native-host-close.json"),actualGatewayCleanup);
  mark(nativeFolder,"host-close-go.bin");await finite(nativeHost.exited,"native-host-close",8000);await nativeLogs;
  if(nativeExit!==0)throw Error("Native Host Close failed "+nativeExit);
  const guest=await guestFile("lan-oracle.bin",join(guestFolder,"lan-oracle.bin"));if(!guest)throw Error("Guest COM Peer did not finish");
  const peerComparison=compare(build.references[1].path,guest,join(folder,"guest-peer-comparison.json"));
  const hostComparison=compare(build.references[0].path,readFileSync(join(nativeFolder,"lan-oracle.bin")),join(folder,"native-host-comparison.json"));
  for(const artifact of artifacts)await guestFile(artifact,join(guestFolder,artifact));
  const callbackProof=[compareTrace(join(nativeFolder,"info-callback-header.bin"),join(nativeFolder,"info-callback-rows.bin"),0,join(folder,"native-host-callback-comparison.json")),compareTrace(join(guestFolder,"info-callback-header.bin"),join(guestFolder,"info-callback-rows.bin"),1,join(folder,"guest-peer-callback-comparison.json"))];
  const portCleanup=await cleanupPorts();save(join(folder,"ports-before-server-shutdown.json"),portCleanup);
  const report={status:hostComparison.differences.length||peerComparison.differences.length?"failed":"passed",nonce,ports,hostUrl,nativePid:nativeHost.pid,nativeExit,forced:false,portCleanup,actualGatewayCleanup,hostComparison,peerComparison,callbackProof};
  save(join(folder,"comparison.json"),report);phases.push(report);
  if(report.status!=="passed")throw Error("SAME PE reverse connected SetPeerInfo observations differ");
  note("passed");
 }catch(error){
  phaseFailure=String(error);note("failure",phaseFailure);save(join(folder,"red-before-cleanup.json"),{failure:phaseFailure,pid:nativeHost?.pid,exit:nativeExit,at:new Date().toISOString()});
  try{save(join(folder,"guest-report.json"),await harness().report().run());for(const artifact of artifacts)await guestFile(artifact,join(guestFolder,artifact));}catch(reportError){save(join(folder,"report-error.json"),{error:String(reportError)});}
  throw error;
 }finally{
  if(nativeHost&&nativeExit===null){
   try{for(let step=2;step<=8;step++){mark(nativeFolder,"step-"+step+"-go.bin");await guestMark("step-"+step+"-go.bin");}await guestMark("peer-close-go.bin");mark(nativeFolder,"host-close-go.bin");}catch{}
   try{await harness().evalPage("window.worker?.postMessage({type:'set_network',network:null});true").run();}catch{}
   try{await finite(nativeHost.exited,"native Host graceful cleanup",3000);}catch{nativeForced=true;nativeHost.kill();await nativeHost.exited;}if(nativeLogs)await nativeLogs;
  }
  if(nativeForced){failed??="Native Host required forced cleanup";process.exitCode=1;}
  try{await harness().evalPage("window.worker?.postMessage({type:'set_network',network:null});true").run();}catch{}
  save(join(folder,"result.json"),{failure:phaseFailure,nativePid:nativeHost?.pid,nativeExit,forced:nativeForced});
 }

}catch(error){failed=String(error);note("failed",failed);process.exitCode=1;}
finally{
 closeHarnessConnection();
 if(server&&serverExit===null){
  try{const input=server.stdin as {write(input:string):unknown;end():unknown};input.write("shutdown\n");input.end();await finite(server.exited,"server shutdown",8000);}
  catch(error){serverForced=true;server.kill();await server.exited;failed??=String(error);process.exitCode=1;}
 }if(serverLogs)await serverLogs;
 let frozenAfter:unknown;try{frozenAfter=verifyFrozen();}catch(error){failed??=String(error);process.exitCode=1;}save(join(output,"frozen-source-guard.json"),{before:frozenBefore,after:frozenAfter});
 const sourceAfter=fingerprint(sourcePaths),inputsAfter=fingerprint(inputPaths);save(join(output,"source-map-after.json"),sourceAfter);save(join(output,"inputs-after.json"),inputsAfter);
 const sourceUnchanged=JSON.stringify(sourceBefore)===JSON.stringify(sourceAfter),inputsUnchanged=JSON.stringify(inputsBefore)===JSON.stringify(inputsAfter);
 if(!sourceUnchanged||!inputsUnchanged||serverForced||serverExit!==null&&serverExit!==0){failed??="Source/reference/server cleanup guard failed";process.exitCode=1;}
 let cleanup:unknown;try{cleanup=await cleanupPorts();}catch(error){cleanup={error:String(error)};failed??="Physical UDP endpoint still retained";process.exitCode=1;}
 const artifacts=tree(output).map(path=>({path:relative(output,path).replaceAll("\\","/"),sha256:fileSha(path)}));
 const report={status:failed?"failed":"passed",scope:"SAME-PE connected SetPeerInfo guest x86 COM Peer and actual native Host; NAME/DATA masks, NULL/empty, callback query/context and completion; ordinary loopback, explicit gateway route",nonce,ports,transport,serverUrl:url,serverPid:server?.pid,serverExit,serverForced,serverExecutableSha256:serverExe?fileSha(serverExe):null,executableSha256:build.executableSha256,sourceGuard:{unchanged:sourceUnchanged},referenceGuard:{unchanged:inputsUnchanged},failure:failed,phases,cleanup,ownedUdp:portEvidence,frozenBefore,frozenAfter,artifacts};
 save(join(output,"verified.json"),report);console.log(JSON.stringify({status:report.status,output,sha256:fileSha(join(output,"verified.json")),failure:failed}));
}
