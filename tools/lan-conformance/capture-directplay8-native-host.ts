import {createSocket,type Socket} from "node:dgram";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,statSync,existsSync} from "node:fs";
import {resolve,join,dirname,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {decodeNativeProtocolFrame} from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import {NativeReceiveWindow} from "../../src/worker/modules/dpnet/native-wire/receive-window";
import {decodeNativePlayerConnect,decodeNativeCoreConnectInfo} from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";

const cli=new Map<string,string>(),args=process.argv.slice(2);
if(args.includes("--help")){console.log("Usage: bun tools/lan-conformance/capture-directplay8-native-host.ts --proof <NEW native baseline directory> --compiler <32-bit MinGW gcc.exe>");process.exit(0);}
for(let i=0;i<args.length;i+=2){
 const name=args[i],value=args[i+1];
 if(!["--proof","--compiler"].includes(name)||!value||value.startsWith("--")||cli.has(name))throw Error("Usage: bun tools/lan-conformance/capture-directplay8-native-host.ts --proof <NEW native baseline directory> --compiler <32-bit MinGW gcc.exe>");
 cli.set(name,value);
}
for(const name of ["--proof","--compiler"])if(!cli.has(name))throw Error("Usage: bun tools/lan-conformance/capture-directplay8-native-host.ts --proof <NEW native baseline directory> --compiler <32-bit MinGW gcc.exe>");

if(process.platform!=="win32")throw Error("Native Windows required");
const script=fileURLToPath(import.meta.url),fixtureDirectory=dirname(script);
const nonce=Date.now()>>>0,root=resolve(cli.get("--proof")!);
if(existsSync(root))throw Error("Proof directory already exists; immutable evidence is never overwritten");
mkdirSync(root,{recursive:true});
const source=join(fixtureDirectory,"directplay8-native-host.c"),exe=join(root,"host-oracle.exe"),ports:number[]=[];
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const fileSha=(path:string)=>sha(readFileSync(path));
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,(_k,v)=>v instanceof Uint8Array?Array.from(v):v,2)+"\n");
const compiler=resolve(cli.get("--compiler")!),env={...process.env};
for(const key of Object.keys(env))if(key.toLowerCase()==="path")delete env[key];
env.Path=dirname(compiler)+";"+(process.env.Path??process.env.PATH??"");
const progress:unknown[]=[];
const note=(kind:string,data:unknown=null)=>{progress.push({at:new Date().toISOString(),kind,data});save(join(root,"progress.json"),progress);};
async function reservePorts(){
 for(let attempt=0;attempt<32;attempt++){
  const sockets:Socket[]=[];
  try{
   const first=createSocket("udp4");sockets.push(first);await new Promise<void>((ok,no)=>{first.once("error",no);first.bind(0,"127.0.0.1",ok);});
   const port=first.address().port;if(port>=65535)throw Error("No adjacent port");
   const second=createSocket("udp4");sockets.push(second);await new Promise<void>((ok,no)=>{second.once("error",no);second.bind(port+1,"127.0.0.1",ok);});
   ports.push(port,port+1);return;
  }catch(error){if(attempt===31)throw error;}
  finally{for(const socket of sockets)try{await new Promise<void>(ok=>socket.close(()=>ok()));}catch{}}
 }
}
async function provePortCleanup(){
 const records=[];
 for(const port of ports){
  const socket=createSocket("udp4");
  try{await new Promise<void>((ok,no)=>{socket.once("error",no);socket.bind(port,"127.0.0.1",ok);});records.push({port,available:true});}
  finally{try{await new Promise<void>(ok=>socket.close(()=>ok()));}catch{}}
 }
 return records;
}
const words=(path:string)=>{const b=readFileSync(path);if(b.length%4)throw Error("Unaligned "+path);return Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));};
function observations(cwd:string){
 const all=words(join(cwd,"lan-oracle.bin"));
 if(all[0]!==0x42534c4e||all[1]!==all.length||all[2]!==nonce||(all.length-3)%2)throw Error("Invalid oracle record");
 const tags:Record<string,number>={};for(let i=3;i<all.length;i+=2){if(String(all[i]) in tags)throw Error("Duplicate observation tag");tags[all[i]]=all[i+1];}
 return{sha256:fileSha(join(cwd,"lan-oracle.bin")),tags};
}
function decodeArtifacts(cwd:string,role:number,reject:boolean){
 const callbackBytes=readFileSync(join(cwd,"callback-events.bin")),callbackHeader=words(join(cwd,"callback-events.bin")).slice(0,9);
 if(callbackHeader[0]!==0x42534845||callbackHeader[1]!==1||callbackHeader[2]!==nonce||callbackHeader[3]!==role||callbackHeader[4]!==Number(reject)||callbackHeader[6]||callbackHeader[7]!==20||callbackBytes.length!==36+callbackHeader[5]*80)throw Error("Callback trace incomplete");
 const callbacks=Array.from({length:callbackHeader[5]},(_,i)=>Array.from({length:20},(_,n)=>callbackBytes.readUInt32LE(36+i*80+n*4)));
 save(join(cwd,"callbacks.json"),callbacks);
 const addr=readFileSync(join(cwd,"native-addresses.bin"));
 if(addr.readUInt32LE(0)!==0x42534841||addr.readUInt32LE(8)!==nonce||addr.readUInt32LE(12)!==role||addr.readUInt32LE(16)!==Number(reject)||addr.readUInt32LE(24)||addr.readUInt32LE(28)!==1064||addr.length!==32+addr.readUInt32LE(20)*1064)throw Error("Address trace incomplete");
 const addresses=Array.from({length:addr.readUInt32LE(20)},(_,i)=>{
  const off=32+i*1064,meta=Array.from({length:10},(_,n)=>addr.readUInt32LE(off+n*4));
  const text=addr.subarray(off+40,off+1064).toString("utf16le").split("\0")[0];
  return{kind:meta[0],subject:meta[1],componentResult:meta[2],port:meta[3],type:meta[4],urlResult:meta[5],urlChars:meta[6],url:text};
 });
 save(join(cwd,"addresses.json"),addresses);
 const wire=readFileSync(join(cwd,"native-wire.bin")),head=Array.from({length:9},(_,i)=>wire.readUInt32LE(i*4));
 if(head[0]!==0x42534d54||head[1]!==3||head[2]!==nonce||head[3]!==role||head[4]!==1||head[6]||head[7]!==27||head[8]!==4096||wire.length!==36+head[5]*4204)throw Error("Packet trace incomplete");
 const receiver=new NativeReceiveWindow(),frames=[],messages=[];
 const sockets=new Set<number>();
 for(let i=0;i<head[5];i++){
  const off=36+i*4204,meta=Array.from({length:27},(_,n)=>wire.readUInt32LE(off+n*4));
  if(meta[7]!==meta[8]||meta[13]!==2||meta[14]!==2||meta[3]!==0x0100007f||meta[5]!==0x0100007f||meta[4]!==ports[role]||meta[6]!==ports[1-role])throw Error("Packet endpoint/truncation changed "+JSON.stringify(meta));
  sockets.add(meta[2]);
  const bytes=wire.subarray(off+108,off+108+meta[8]),frame=decodeNativeProtocolFrame(bytes);
  if(!frame)throw Error("Undecodable native DNET packet");
  frames.push({meta,sha256:sha(bytes),frame});
  if(frame.kind==="data"){
   const result=receiver.receive(frame);if(result.overflow)throw Error("Captured reassembly overflow");
   for(const message of result.messages){
    const b=message.payload,command=b.length>=4?new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true):null;
    messages.push({packet:i,command,flags:message.command,control:message.control,data:Array.from(b),
     c1:command===0xc1?decodeNativePlayerConnect(b):undefined,c2:command===0xc2?decodeNativeCoreConnectInfo(b):undefined});
   }
  }
 }
 if(sockets.size!==1)throw Error("Native role used multiple physical UDP sockets");
 if(role===0&&!addresses.some(a=>a.kind===1&&a.componentResult===0&&a.port===ports[0]))throw Error("Advertised Host endpoint does not match actual socket");
 save(join(cwd,"frames.json"),frames);save(join(cwd,"messages.json"),messages);
 return{packets:head[5],wireSha256:sha(wire),callbackCount:callbacks.length,addresses,commands:messages.filter(m=>m.flags&0x40).map(m=>m.command),messages};
}
interface Child{role:number;pid:number;cwd:string;proc:ReturnType<typeof Bun.spawn>;exit:number|null;forced:boolean;retired:boolean;logs:Promise<void>;}
async function phase(reject:boolean){
 const name=reject?"reject":"accept",folder=join(root,name);mkdirSync(folder);const children:Child[]=[];
 const deadline=Date.now()+45000;let failure:string|null=null,result:unknown=null;
 const phaseNote=(kind:string,data:unknown=null)=>note(name+":"+kind,data);
 const mark=(child:Child,path:string)=>{const b=Buffer.alloc(4);b.writeUInt32LE(nonce);writeFileSync(join(child.cwd,path),b);phaseNote("marker",{role:child.role,path});};
 const marked=(child:Child,path:string)=>{try{const b=readFileSync(join(child.cwd,path));return b.length===4&&b.readUInt32LE()===nonce;}catch{return false;}};
 const start=(role:number)=>{
  const cwd=join(folder,role?"peer":"host");mkdirSync(cwd);const args=[exe,role?"--peer":"--host",...(reject?["--reject"]:[])];
  const proc=Bun.spawn(args,{cwd,env,stdout:"pipe",stderr:"pipe"});const child:Child={role,pid:proc.pid,cwd,proc,exit:null,forced:false,retired:false,logs:Promise.resolve()};
  child.logs=Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]).then(([out,error])=>{writeFileSync(join(cwd,"stdout.txt"),out);writeFileSync(join(cwd,"stderr.txt"),error);});
  void proc.exited.then(code=>{child.exit=code;phaseNote("exit",{role,pid:child.pid,code});});children.push(child);phaseNote("spawn",{role,pid:child.pid,args});return child;
 };
 const wait=async(check:()=>boolean,label:string,timeout=10000,allowedExitRole=-1)=>{
  const until=Math.min(deadline,Date.now()+timeout);
  while(!check()){
   const dead=children.find(c=>c.exit!==null&&!c.retired&&c.role!==allowedExitRole);
   if(dead)throw Error(label+": role"+dead.role+" exited "+dead.exit);
   if(Date.now()>=until)throw Error(label+" deadline");
   await Bun.sleep(5);
  }phaseNote(label);
 };
 try{
  const host=start(0);await wait(()=>marked(host,"host-ready.bin"),"host-ready",8000);
  const client=start(1);
  await wait(()=>marked(host,"host-admission-done.bin")&&marked(client,"peer-admission-done.bin"),"admission-complete",20000);
  if(!reject){
   await wait(()=>children.every(c=>marked(c,"exchange-ready.bin")),"exchange-ready");
   for(const c of children)mark(c,"send-go.bin");
   await wait(()=>children.every(c=>marked(c,"exchange-done.bin")),"exchange-complete");
  }
  mark(client,"peer-close-go.bin");await wait(()=>client.exit!==null,"peer-exit",5000,1);
  if(client.exit!==0)throw Error("Peer failed "+client.exit);client.retired=true;
  if(!reject)await wait(()=>marked(host,"host-peer-closed.bin"),"host-saw-peer-close",5000,1);
  mark(host,"host-close-go.bin");await wait(()=>host.exit!==null,"host-exit",5000,0);
  if(host.exit!==0)throw Error("Host failed "+host.exit);
  await Promise.all(children.map(c=>c.logs));
  const records=children.map(c=>{
   const observation=observations(c.cwd),t=observation.tags;
   if(t[399]||t[341]||t[342]||t[343]||t[316]||t[250]!==0||existsSync(join(c.cwd,"watchdog.bin")))throw Error("Native failure/capture loss "+JSON.stringify(t));
   const trace=decodeArtifacts(c.cwd,c.role,reject);
   return{role:c.role,pid:c.pid,exit:c.exit,...observation,...trace};
  });
  const h=records[0].tags,p=records[1].tags;
  if(h[101]!==1||h[102]!==1||!h[109]||!h[110]||!h[111]||!h[112]||!h[113]||p[104]!==1||!p[107]||!p[108]||p[106]!==8||Boolean(p[105]&0x80000000)!==reject)throw Error("Native admission/reply mismatch");
  result={status:"passed",name,nonce,ports,records,portCleanup:await provePortCleanup()};
  save(join(folder,"verified.json"),result);phaseNote("verified");
 }catch(error){failure=String(error);phaseNote("failure",failure);throw error;}
 finally{
  for(const child of children.filter(c=>c.exit===null)){try{mark(child,"peer-close-go.bin");mark(child,"host-close-go.bin");mark(child,"send-go.bin");}catch{}}
  const grace=Date.now()+4000;while(children.some(c=>c.exit===null)&&Date.now()<grace)await Bun.sleep(10);
  for(const child of children)if(child.exit===null){child.forced=true;child.proc.kill();}
  await Promise.all(children.map(c=>c.proc.exited));await Promise.all(children.map(c=>c.logs));
  let cleanup:unknown;try{cleanup=await provePortCleanup();}catch(error){cleanup={error:String(error)};}
  save(join(folder,"result.json"),{nonce,failure,children:children.map(c=>({role:c.role,pid:c.pid,exit:c.exit,forced:c.forced})),portCleanup:cleanup});
 }
 return result;
}
try{
 await reservePorts();copyFileSync(source,join(root,"fixture.c"));copyFileSync(script,join(root,"capture.ts"));
 for(const name of ["directplay8-native-host.md","directplay8-native-host-schema.json"])copyFileSync(join(fixtureDirectory,name),join(root,name));
 const args=["-m32","-O1","-Wall","-Wextra","-Werror","-Wno-misleading-indentation","-nostdlib","-fno-builtin","-fno-stack-protector","-DORACLE_NONCE="+nonce,"-DORACLE_HOST_PORT="+ports[0],"-Wl,--entry,_entry","-Wl,--subsystem,console","-o",exe,source,"-lkernel32","-lole32","-ldxguid","-luuid","-lws2_32"];
 const build=Bun.spawnSync([compiler,...args],{env,stdout:"pipe",stderr:"pipe"});writeFileSync(join(root,"compiler.stdout.txt"),build.stdout);writeFileSync(join(root,"compiler.stderr.txt"),build.stderr);
 save(join(root,"build.json"),{nonce,ports,compiler,args,exit:build.exitCode,sourceSha256:fileSha(source),runnerSha256:fileSha(script)});
 note("compile",{exit:build.exitCode});
 if(build.exitCode)throw Error("Strict native build failed: "+new TextDecoder().decode(build.stderr));
 const image=readFileSync(exe),peOffset=image.readUInt32LE(0x3c);
 if(image.readUInt16LE(0)!==0x5a4d||image.readUInt32LE(peOffset)!==0x4550||image.readUInt16LE(peOffset+4)!==0x14c)throw Error("Compiler did not produce x86 PE");
 const accepted=await phase(false),rejected=await phase(true);
 const walk=(dir:string):string[]=>readdirSync(dir).flatMap(name=>{const p=join(dir,name);return statSync(p).isDirectory()?walk(p):[p];}).sort();
 const report={status:"passed",nonce,ports,root,exeSha256:fileSha(exe),sourceSha256:fileSha(source),accepted,rejected,
 artifacts:walk(root).map(path=>({path:relative(root,path),sha256:fileSha(path)}))};
 save(join(root,"verified.json"),report);console.log(JSON.stringify({status:"passed",root,nonce,ports,exeSha256:report.exeSha256,sourceSha256:report.sourceSha256,reportSha256:fileSha(join(root,"verified.json"))}));
}catch(error){save(join(root,"failure.json"),{status:"failed",nonce,ports,error:String(error),at:new Date().toISOString()});console.error(JSON.stringify({status:"failed",root,nonce,ports,error:String(error)}));process.exitCode=1;}
