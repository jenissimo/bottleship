import {createSocket,type Socket} from "node:dgram";
import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {createLanServer,type LanServer} from "../../packages/lan/src/server";
import {buildBoundUdpHelper} from "./build-bound-udp-helper";
import {decodeNativeProtocolFrame} from "../../src/worker/modules/dpnet/native-wire/frame-codec";
const parameter=process.argv.find(x=>x.startsWith("--prepared="))?.slice(11);
const transport=process.argv.includes("--websocket")?"websocket":"polling",helper=process.argv.includes("--helper");
if(process.platform!=="win32")throw Error("Windows native DirectPlay reference required");
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+"\n");
const compiler="C:/msys64/mingw32/bin/gcc.exe",env={...process.env};
for(const key of Object.keys(env))if(key.toLowerCase()==="path")delete env[key];env.Path=dirname(compiler)+";"+(process.env.Path??process.env.PATH??"");
const previous=parameter?JSON.parse(readFileSync(resolve(parameter),"utf8")):null;
const nonce:number=previous?.nonce??Date.now()>>>0,root:string=previous?.root??resolve("logs/lan-conformance/directplay8-com-mesh",String(nonce));
mkdirSync(root,{recursive:true});const ports:number[]=previous?.ports??[];
const peerExe=join(root,"native-peers.exe"),guestExe=join(root,"game","lan-oracle.exe");
const wordFile=(path:string)=>{const b=readFileSync(path);if(b.length%4)throw Error("Unaligned native record");return Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));};
async function freeRange(){const reserved:Socket[]=[];try{for(let attempt=0;attempt<32;attempt++){try{const first=createSocket("udp4");reserved.push(first);await new Promise<void>((ok,no)=>{first.once("error",no);first.bind(0,"127.0.0.1",ok);});const base=first.address().port;if(base>65533)throw Error("Port range");for(const port of [base+1,base+2]){const s=createSocket("udp4");reserved.push(s);await new Promise<void>((ok,no)=>{s.once("error",no);s.bind(port,"127.0.0.1",ok);});}ports.push(base,base+1,base+2);return;}catch{for(const s of reserved.splice(0)){try{s.close();}catch{}}}}throw Error("No loopback port range");}finally{for(const s of reserved.splice(0))await new Promise<void>(ok=>s.close(()=>ok()));}}
async function compile(){
 await freeRange();mkdirSync(join(root,"game"));
 for(const [source,out] of [["directplay8-com-mesh-peer.c",peerExe],["directplay8-com-mesh.c",guestExe]]){
  const args=[compiler,"-O1","-Wall","-Wextra","-Werror","-Wno-misleading-indentation","-nostdlib","-fno-builtin","-fno-stack-protector","-DORACLE_NONCE="+nonce,"-DORACLE_HOST_PORT="+ports[0],"-Wl,--entry,_entry","-Wl,--subsystem,console","-o",out,"tools/lan-conformance/"+source,"-lkernel32","-lole32","-ldxguid","-luuid","-lws2_32"];
  const built=Bun.spawnSync(args,{env,stdout:"pipe",stderr:"pipe"});writeFileSync(join(root,source+".stdout.txt"),built.stdout);writeFileSync(join(root,source+".stderr.txt"),built.stderr);save(join(root,source+".build.json"),{args,exit:built.exitCode});
  if(built.exitCode)throw Error("Native compile "+source+": "+new TextDecoder().decode(built.stderr));copyFileSync("tools/lan-conformance/"+source,join(root,source));
 }
}
interface Child{role:number;pid:number;cwd:string;proc:ReturnType<typeof Bun.spawn>;exit:number|null;logs:Promise<void>;}
async function phase(name:string,browser:boolean,buildPath?:string){
 const folder=join(root,name);mkdirSync(folder);const children:Child[]=[],events:unknown[]=[];const deadline=Date.now()+40000;
 let server:LanServer|undefined,comparison:ReturnType<typeof Bun.spawn>|undefined,comparisonExit:number|null=null,comparisonLogs:Promise<void>|undefined,failure:string|null=null;
 const waitProcess=async(promise:Promise<number>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<number>((_,reject)=>{timer=setTimeout(()=>reject(Error("Process phase deadline")),Math.max(1,deadline-Date.now()));})]);}finally{if(timer)clearTimeout(timer);}};
 const note=(kind:string,value:unknown=null)=>{events.push({at:new Date().toISOString(),kind,value});save(join(folder,"progress.json"),events);};
 const mark=(child:Child,file:string)=>{const b=Buffer.alloc(4);b.writeUInt32LE(nonce);writeFileSync(join(child.cwd,file),b);};
 const marked=(child:Child,file:string)=>{try{const b=readFileSync(join(child.cwd,file));return b.length===4&&b.readUInt32LE()===nonce;}catch{return false;}};
 const start=(role:number,exe=peerExe)=>{
  const cwd=join(folder,["host","peer1","peer2"][role]);mkdirSync(cwd);const proc=Bun.spawn([exe,"--"+["host","peer1","peer2"][role]],{cwd,env,stdout:"pipe",stderr:"pipe"});
  const child:Child={role,pid:proc.pid,cwd,proc,exit:null,logs:Promise.resolve()};
  child.logs=Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]).then(([out,error])=>{writeFileSync(join(cwd,"stdout.txt"),out);writeFileSync(join(cwd,"stderr.txt"),error);});
  void proc.exited.then(code=>{child.exit=code;note("exit",{role,pid:child.pid,code});});children.push(child);note("spawn",{role,pid:child.pid});return child;
 };
 async function wait(check:()=>boolean,label:string,milliseconds=12000,allowGuestExit=false){
  const end=Math.min(deadline,Date.now()+milliseconds);while(!check()){
   const dead=children.find(c=>c.exit!==null&&!(allowGuestExit&&c.role===2&&c.exit===0));if(dead)throw Error(label+": native role"+dead.role+" exit"+dead.exit);
   if(comparisonExit!==null)throw Error(label+": browser comparison exited "+comparisonExit);
   if(Date.now()>end)throw Error(label+" deadline");await Bun.sleep(5);
  }note(label);
 }
 try{
  note("begin",{nonce,ports,browser,transport,helper});
  let serverPort=0;
  if(browser){server=createLanServer({host:"127.0.0.1",port:0,transports:[transport],gateway:{...(helper?{nativeUdpHelperPath:await buildBoundUdpHelper()}:{}),routes:[{host:"127.0.0.1",address:"127.0.0.1",ports:ports.slice(0,2),protocols:["udp"]}]}});serverPort=await server.listen();note("relay-ready",{port:serverPort,transport,helper});}
  const host=start(0);await wait(()=>marked(host,"mesh-ready.bin"),"host-ready");
  const peer=start(1);await wait(()=>marked(peer,"mesh-ready.bin"),"peer1-ready");
  let nativeGuest:Child|undefined;
  if(browser){
   if(!buildPath)throw Error("Missing prepared build");
   const runEnv={...env,BS_TAB:env.BS_TAB??"lan-oracle",BS_DEV_URL:env.BS_DEV_URL??"http://localhost:5175/?game=dev",BS_SIDECAR_PORT:env.BS_SIDECAR_PORT??"3003",BS_CDP_PORT:env.BS_CDP_PORT??"9334",BS_ORACLE_BUILD:buildPath,BS_LAN_SERVER:"http://127.0.0.1:"+serverPort,BS_LAN_ROOM:"native-com-mesh-"+nonce};
   comparison=Bun.spawn([process.execPath,"tools/harness.ts","run","tools/lan-conformance/compare.harness.ts"],{env:runEnv,stdout:"pipe",stderr:"pipe"});
   comparisonLogs=Promise.all([new Response(comparison.stdout).text(),new Response(comparison.stderr).text()]).then(([out,error])=>{writeFileSync(join(folder,"browser.stdout.txt"),out);writeFileSync(join(folder,"browser.stderr.txt"),error);});
   void comparison.exited.then(code=>{comparisonExit=code;note("browser-exit",code);});
  }else nativeGuest=start(2,guestExe);
  await wait(()=>[host,peer].every(c=>marked(c,"mesh-full.bin")),"all-three-created",18000);
  [host,peer].forEach(c=>mark(c,"mesh-go.bin"));
  await wait(()=>[host,peer].every(c=>marked(c,"mesh-metrics.bin")),"native-direct-exchange",10000);
  mark(peer,"mesh-finish.bin");
  if(browser){const code=await waitProcess(comparison!.exited);await comparisonLogs;if(code)throw Error("Guest COM comparison failed "+code);}
  else{const code=await waitProcess(nativeGuest!.proc.exited);await nativeGuest!.logs;if(code)throw Error("Native reference PE failed "+code);}
  for(const c of [peer,host]){mark(c,"mesh-close.bin");const end=Date.now()+4000;while(c.exit===null&&Date.now()<end)await Bun.sleep(5);if(c.exit!==0)throw Error("Native counterpart Close failed "+c.exit);}
  await Promise.all(children.map(c=>c.logs));
  let physicalPeerPort=0;
  const records=children.filter(c=>c.role!==2).map(c=>{
   const state=wordFile(join(c.cwd,"mesh-state.bin")),observations=wordFile(join(c.cwd,"lan-oracle.bin"));
   if(state.length!==18||state[0]!==0x42534d53||state[1]!==nonce||state[2]!==c.role||state[3]!==7||state[4]||state[5]||state.slice(9,15).some(n=>n!==1)||observations[0]!==0x42534c4e||observations[1]!==observations.length||observations[2]!==nonce||observations.at(-1)!==0)throw Error("Native counterpart state mismatch "+JSON.stringify(state));
   if(c.role===1&&state[17]!==1)throw Error("Native peer missing guest RECEIVE");
   const body=observations.slice(3),q=body.slice(c.role===1?-18:-16,c.role===1?-12:-10);
   if(q[0]||q[1]||q[3]||q[4])throw Error("Native counterpart address failed");
   if(!physicalPeerPort)physicalPeerPort=q[5];if(!physicalPeerPort||q[5]!==physicalPeerPort)throw Error("Native roles disagree on guest UDP binding");
   const raw=readFileSync(join(c.cwd,"mesh-wire.bin")),head=Array.from({length:9},(_,i)=>raw.readUInt32LE(i*4));
   if(head[0]!==0x42534d54||head[1]!==3||head[2]!==nonce||head[3]!==c.role||head[4]!==1||head[6]||head[7]!==27||head[8]!==4096||raw.length!==36+head[5]*4204)throw Error("Native wire trace incomplete");
   const frames=[];for(let i=0;i<head[5];i++){const off=36+i*4204,meta=Array.from({length:27},(_,n)=>raw.readUInt32LE(off+n*4));if(meta[7]!==meta[8]||meta[13]!==2||meta[14]!==2||meta[5]!==0x0100007f||meta[4]!==ports[c.role]||!ports.slice(0,2).concat(physicalPeerPort).includes(meta[6]))throw Error("Native wire endpoint changed");const bytes=raw.subarray(off+108,off+108+meta[8]);frames.push({sourcePort:meta[4],destinationPort:meta[6],sha256:sha(bytes),frame:decodeNativeProtocolFrame(bytes)});}save(join(c.cwd,"frames.json"),frames);
   return{role:c.role,pid:c.pid,state,observations:body,packets:head[5],wireSha256:sha(raw)};
  });
  const reference=browser?null:join(nativeGuest!.cwd,"lan-oracle.bin");
  if(reference){const values=wordFile(reference);if(values[0]!==0x42534c4e||values[1]!==values.length||values[2]!==nonce||values.at(-1)!==0)throw Error("Invalid native COM reference");note("reference",{observations:values.length-3,sha256:sha(readFileSync(reference))});}
  const report={nonce,ports,browser,transport,helper,physicalPeerPort,reference,records,comparison:browser?join(dirname(buildPath!),"comparison-"+nonce+".json"):null};save(join(folder,"verified.json"),report);note("verified");return report;
 }catch(e){failure=String(e);note("failure",failure);throw e;}
 finally{
  if(comparison&&comparisonExit===null){comparison.kill();await comparison.exited;}if(comparisonLogs)await comparisonLogs;
  if(server)await server.close();
  for(const c of children.filter(c=>c.role!==2&&c.exit===null)){try{mark(c,"mesh-go.bin");mark(c,"mesh-finish.bin");mark(c,"mesh-close.bin");}catch{}}
  const end=Math.min(deadline,Date.now()+12000);while(children.some(c=>c.exit===null)&&Date.now()<end)await Bun.sleep(5);
  for(const c of children)if(c.exit===null)c.proc.kill();await Promise.all(children.map(c=>c.proc.exited));await Promise.all(children.map(c=>c.logs));
  save(join(folder,"result.json"),{nonce,failure,children:children.map(c=>({role:c.role,pid:c.pid,exit:c.exit}))});
 }
}
try{
 if(!previous){
  await compile();const ref=await phase("native-reference",false);
  const bundle=join(root,"com-mesh-"+nonce+".wgb");
  for(const args of [[process.execPath,"tools/make-wgb.ts",join(root,"game"),bundle,"--exe","lan-oracle.exe","--name","Native DP8 COM mesh","--game-id","app:lan-conformance","--ram","128"],[process.execPath,"tools/wgb.ts","patch-manifest",bundle,"emulator.deleteOnBoot",JSON.stringify(["C:\\lan-oracle.bin","C:\\lan-oracle-progress.bin"])]]){const r=Bun.spawnSync(args,{stdout:"inherit",stderr:"inherit"});if(r.exitCode)throw Error("Bundle creation failed");}
  const build={fixture:"directplay8-native-com-mesh",root,nonce,ports,bundle,reference:ref.reference,executableSha256:sha(readFileSync(guestExe)),referenceSha256:sha(readFileSync(ref.reference!)),nativePeerExecutableSha256:sha(readFileSync(peerExe)),sourceSha256:sha(readFileSync("tools/lan-conformance/directplay8-com-mesh.c")),peerSourceSha256:sha(readFileSync("tools/lan-conformance/directplay8-com-mesh-peer.c"))};
  save(join(root,"build.json"),build);console.log(JSON.stringify({prepared:join(root,"build.json"),nonce,ports,observations:wordFile(ref.reference!).length-3}));
 }else{
  if(previous.executableSha256!==sha(readFileSync(guestExe))||previous.nativePeerExecutableSha256!==sha(readFileSync(peerExe))||previous.referenceSha256!==sha(readFileSync(previous.reference)))throw Error("Prepared reference inputs changed");
  const report=await phase("guest-"+transport+(helper?"-helper":"-node")+"-"+Date.now(),true,resolve(parameter!));
  console.log(JSON.stringify({root,nonce,ports,report}));
 }
}catch(e){save(join(root,"failure-"+Date.now()+".json"),{nonce,error:String(e)});console.error(String(e));process.exitCode=1;}
