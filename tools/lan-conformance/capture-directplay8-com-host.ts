import {createSocket,type Socket} from "node:dgram";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,statSync,existsSync} from "node:fs";
import {resolve,join,dirname,relative} from "node:path";
import {fileURLToPath} from "node:url";

const cli=new Map<string,string>(),args=process.argv.slice(2);
if(args.includes("--help")){console.log("Usage: bun tools/lan-conformance/capture-directplay8-com-host.ts --proof <NEW native baseline directory> --compiler <32-bit MinGW gcc.exe>");process.exit(0);}
for(let i=0;i<args.length;i+=2){
 const name=args[i],value=args[i+1];
 if(!["--proof","--compiler"].includes(name)||!value||value.startsWith("--")||cli.has(name))throw Error("Usage: bun tools/lan-conformance/capture-directplay8-com-host.ts --proof <NEW native baseline directory> --compiler <32-bit MinGW gcc.exe>");
 cli.set(name,value);
}
for(const name of ["--proof","--compiler"])if(!cli.has(name))throw Error("Usage: bun tools/lan-conformance/capture-directplay8-com-host.ts --proof <NEW native baseline directory> --compiler <32-bit MinGW gcc.exe>");

if(process.platform!=="win32")throw Error("Native Windows required");
const script=fileURLToPath(import.meta.url),fixtureDirectory=dirname(script);
const nonce=Date.now()>>>0,root=resolve(cli.get("--proof")!);
if(existsSync(root))throw Error("Proof directory already exists; immutable evidence is never overwritten");
mkdirSync(root,{recursive:true});
const source=join(fixtureDirectory,"directplay8-com-host.c"),exe=join(root,"host-oracle.exe"),ports:number[]=[];
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
 const header=words(join(cwd,"callback-header.bin")),body=readFileSync(join(cwd,"callback-rows.bin"));
 if(header.length!==7||header[0]!==0x42534843||header[1]!==1||header[2]!==nonce||header[3]!==role||header[4]!==Number(reject)||header[5]>64||header[6]||body.length!==header[5]*48)throw Error("Callback trace incomplete");
 const callbacks=Array.from({length:header[5]},(_,i)=>Array.from({length:12},(_,n)=>body.readUInt32LE(i*48+n*4)));
 save(join(cwd,"callbacks.json"),callbacks);
 let url:string|null=null;
 if(role===0){const b=readFileSync(join(cwd,"host-address-url.bin"));url=b.toString("utf16le").split("\0")[0];if(!url.startsWith("x-directplay:/"))throw Error("Missing native Host provider URL");}
 return{callbackCount:callbacks.length,callbacks,hostUrl:url};
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
  if(h[100]!==1||h[101]!==1||h[102]!==0||!h[108]||!h[109]||!h[110]||!h[111]||!h[112]||h[113]!==2||p[103]!==1||!p[106]||!p[107]||p[105]!==8||Boolean(p[104]&0x80000000)!==reject)throw Error("Native admission/reply mismatch");
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
 copyFileSync(join(fixtureDirectory,"directplay8-com-host.md"),join(root,"directplay8-com-host.md"));
 const args=["-m32","-O1","-Wall","-Wextra","-Werror","-Wno-misleading-indentation","-nostdlib","-fno-builtin","-fno-stack-protector","-DORACLE_NONCE="+nonce,"-DORACLE_HOST_PORT="+ports[0],"-Wl,--entry,_entry","-Wl,--subsystem,console","-o",exe,source,"-lkernel32","-lole32","-ldxguid","-luuid","-lws2_32"];
 const build=Bun.spawnSync([compiler,...args],{env,stdout:"pipe",stderr:"pipe"});writeFileSync(join(root,"compiler.stdout.txt"),build.stdout);writeFileSync(join(root,"compiler.stderr.txt"),build.stderr);
 save(join(root,"build.json"),{nonce,ports,compiler,args,exit:build.exitCode,sourceSha256:fileSha(source),runnerSha256:fileSha(script)});
 note("compile",{exit:build.exitCode});
 if(build.exitCode)throw Error("Strict native build failed: "+new TextDecoder().decode(build.stderr));
 const image=readFileSync(exe),peOffset=image.readUInt32LE(0x3c);
 if(image.readUInt16LE(0)!==0x5a4d||image.readUInt32LE(peOffset)!==0x4550||image.readUInt16LE(peOffset+4)!==0x14c)throw Error("Compiler did not produce x86 PE");
 const accepted=await phase(false),rejected=await phase(true);
 const walk=(dir:string):string[]=>readdirSync(dir).flatMap(name=>{const p=join(dir,name);return statSync(p).isDirectory()?walk(p):[p];}).sort();
 const game=join(root,"game");mkdirSync(game);copyFileSync(exe,join(game,"lan-oracle.exe"));
 for(const mode of ["accept","reject"]){
  const bundle=join(root,"host-"+mode+"-"+nonce+".wgb");
  const pack=Bun.spawnSync([process.execPath,"tools/make-wgb.ts",game,bundle,"--exe","lan-oracle.exe","--args",mode==="reject"?"--host --reject":"--host","--name","DP8 COM Host "+mode,"--game-id","app:lan-conformance","--ram","128","--os","winxp"],{stdout:"pipe",stderr:"pipe"});
  writeFileSync(join(root,"pack-"+mode+".stdout.txt"),pack.stdout);writeFileSync(join(root,"pack-"+mode+".stderr.txt"),pack.stderr);
  if(pack.exitCode)throw Error("COM Host bundle failed: "+mode);
  const deleteOnBoot=["lan-oracle.bin","host-progress.bin","callback-header.bin","callback-rows.bin","host-ready.bin","host-admission-done.bin","peer-admission-done.bin","exchange-ready.bin","send-go.bin","exchange-done.bin","peer-close-go.bin","host-peer-closed.bin","host-close-go.bin","done.bin","watchdog.bin"].map(name=>"C:\\\\"+name);
  const patched=Bun.spawnSync([process.execPath,"tools/wgb.ts","patch-manifest",bundle,"emulator.deleteOnBoot",JSON.stringify(deleteOnBoot)],{stdout:"pipe",stderr:"pipe"});
  if(patched.exitCode)throw Error("COM Host fresh output configuration failed: "+mode);
  const reference=join(root,mode,"host/lan-oracle.bin");
  save(join(root,mode,"build.json"),{fixture:"directplay8-com-host",mode,bundle,reference,nonce,ports,
   executableSha256:fileSha(exe),referenceSha256:fileSha(reference),sourceSha256:fileSha(source),builtAt:new Date().toISOString()});
 }
 const report={status:"passed",nonce,ports,root,exeSha256:fileSha(exe),sourceSha256:fileSha(source),accepted,rejected,
 artifacts:walk(root).map(path=>({path:relative(root,path),sha256:fileSha(path)}))};
 save(join(root,"verified.json"),report);console.log(JSON.stringify({status:"passed",root,nonce,ports,exeSha256:report.exeSha256,sourceSha256:report.sourceSha256,reportSha256:fileSha(join(root,"verified.json"))}));
}catch(error){save(join(root,"failure.json"),{status:"failed",nonce,ports,error:String(error),at:new Date().toISOString()});console.error(JSON.stringify({status:"failed",root,nonce,ports,error:String(error)}));process.exitCode=1;}
