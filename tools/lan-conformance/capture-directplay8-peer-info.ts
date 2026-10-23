import{createHash}from"node:crypto";import{mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync,statSync,existsSync}from"node:fs";import{resolve,join,dirname,relative}from"node:path";import{createSocket}from"node:dgram";
const usage="bun tools/lan-conformance/capture-directplay8-peer-info.ts --proof <NEW directory> --compiler <x86 gcc.exe> --host-port <1..65534>";
if(process.argv.includes("--help")){console.log(usage);process.exit(0);}
const cli=new Map<string,string>(),argv=process.argv.slice(2);
for(let n=0;n<argv.length;n+=2){const k=argv[n],v=argv[n+1];if(!["--proof","--compiler","--host-port"].includes(k)||!v||v.startsWith("--")||cli.has(k))throw Error(usage);cli.set(k,v);}
for(const k of["--proof","--compiler","--host-port"])if(!cli.has(k))throw Error(usage);
if(process.platform!=="win32")throw Error("Native Windows required");
const nonce=Date.now()>>>0,root=resolve(cli.get("--proof")!),hostPort=Number(cli.get("--host-port"));
if(!Number.isInteger(hostPort)||hostPort<1||hostPort>65534||existsSync(root))throw Error("Invalid port or existing immutable proof directory");
mkdirSync(root,{recursive:true});
const source=join(import.meta.dir,"directplay8-peer-info.c"),exe=join(root,"host-peer-info.exe"),compiler=resolve(cli.get("--compiler")!);
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex"),save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+"\n");
const report:any={status:"running",startedAt:new Date().toISOString(),nonce,hostPort,peerPort:hostPort+1,source:{path:source,sha256:sha(source)},runner:{path:import.meta.filename,sha256:sha(import.meta.filename)},scope:"Native public API-only ordinary IPv4 loopback Host and one Peer; connected SetPeerInfo masks, callback query and sync/async ownership. No native wire implementation claim.",processes:[],ports:[],phases:[]};
const reportPath=join(root,"verified.json");save(reportPath,report);copyFileSync(source,join(root,"fixture.c"));
const paths=[join(root,"host"),join(root,"peer")];for(const p of paths)mkdirSync(p);
let pair:Array<{role:number;p:ReturnType<typeof Bun.spawn>;out:Promise<string>;err:Promise<string>}>=[],failed=false;
const marker=(p:string)=>writeFileSync(p,new Uint32Array([nonce]));
const isMarked=(p:string)=>{if(!existsSync(p))return false;const b=readFileSync(p);return b.length===4&&b.readUInt32LE(0)===nonce;};
const deadline=Date.now()+45000;
let peerCloseRequested=false;
const wait=async(label:string,predicate:()=>boolean,ms=10000)=>{const end=Math.min(deadline,Date.now()+ms);while(!predicate()){for(const item of pair)if(item.p.exitCode!==null&&!(peerCloseRequested&&item.role===1&&item.p.exitCode===0))throw Error(label+": native role"+item.role+" exited "+item.p.exitCode);if(Date.now()>end)throw Error("Finite phase deadline "+label);await Bun.sleep(10);}};
const free=async(port:number)=>{const socket=createSocket("udp4");try{await new Promise<void>((resolve,reject)=>{socket.once("error",reject);socket.bind(port,"0.0.0.0",()=>resolve());});return{port,available:true};}finally{try{socket.close();}catch{}}};
const walk=(p:string):string[]=>readdirSync(p).sort().flatMap(n=>{const f=join(p,n);return statSync(f).isDirectory()?walk(f):[f];});
const parse=(p:string)=>{const b=readFileSync(p);if(b.length<12||b.readUInt32LE(0)!==0x42534c4e||b.readUInt32LE(8)!==nonce||b.readUInt32LE(4)*4!==b.length||(b.length-12)%8)throw Error("Invalid tagged oracle "+p);const checks=[];for(let i=12;i<b.length;i+=8)checks.push({tag:b.readUInt32LE(i),value:b.readUInt32LE(i+4)});return{path:p,sha256:sha(p),observations:(b.length-12)/4,taggedChecks:checks.length,checks};};
try{
 report.portAvailabilityBefore=[await free(hostPort),await free(hostPort+1)];
 const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==="path")delete env[k];env.Path=dirname(compiler)+";"+(process.env.Path??process.env.PATH??"");
 const args=[compiler,"-O1","-Wall","-Wextra","-Werror","-Wno-misleading-indentation","-nostdlib","-fno-builtin","-fno-stack-protector","-DORACLE_NONCE="+nonce,"-DORACLE_HOST_PORT="+hostPort,"-Wl,--entry,_entry","-Wl,--subsystem,console","-o",exe,source,"-lkernel32","-lole32","-ldxguid","-luuid"];
 const built=Bun.spawnSync(args,{env,stdout:"pipe",stderr:"pipe"});writeFileSync(join(root,"compiler.stdout.txt"),built.stdout);writeFileSync(join(root,"compiler.stderr.txt"),built.stderr);report.build={args,exit:built.exitCode};save(reportPath,report);
 if(built.exitCode)throw Error("Native fixture compiler failed; see immutable compiler stderr");
 report.executable={path:exe,sha256:sha(exe)};save(reportPath,report);
 for(const role of[0,1]){
  const args=role?[exe,"--peer"]:[exe],p=Bun.spawn(args,{cwd:paths[role],stdout:"pipe",stderr:"pipe"});
  pair.push({role,p,out:new Response(p.stdout).text(),err:new Response(p.stderr).text()});report.processes.push({role,pid:p.pid,args,cwd:paths[role]});save(reportPath,report);
  if(!role)await wait("Host READY",()=>isMarked(join(paths[0],"host-ready.bin")));
 }
 await wait("Both connected",()=>paths.every(p=>isMarked(join(p,"connected.bin"))));
 report.phases.push({name:"connected",at:new Date().toISOString()});save(reportPath,report);
 for(let step=2;step<=8;step++){
  await wait("step"+step+" ready",()=>paths.every(p=>isMarked(join(p,"step-"+step+"-ready.bin"))));
  for(const p of paths)marker(join(p,"step-"+step+"-go.bin"));
  await wait("step"+step+" complete",()=>paths.every(p=>isMarked(join(p,"step-"+step+"-done.bin"))));
  report.phases.push({step,name:["","","host name SYNC","peer data ASYNC","host clear-name SYNC","peer clear-data SYNC","host BOTH ASYNC mutate-source","host empty name SYNC","peer nonNULL empty data SYNC"][step],at:new Date().toISOString()});save(reportPath,report);
 }
 await wait("All steps",()=>paths.every(p=>isMarked(join(p,"all-steps-done.bin"))));
 peerCloseRequested=true;marker(join(paths[1],"peer-close-go.bin"));
 await wait("Host saw peer departure",()=>isMarked(join(paths[0],"host-peer-closed.bin")));
 marker(join(paths[0],"host-close-go.bin"));
 for(const item of pair){const exit=await Promise.race([item.p.exited,Bun.sleep(5000).then(()=>null)]);if(exit===null)throw Error("Native Close process deadline role"+item.role);report.processes[item.role].exit=exit;if(exit)throw Error("Native process failed role"+item.role+" exit"+exit);}
 report.results=paths.map(p=>parse(join(p,"lan-oracle.bin")));
 for(const result of report.results){if(result.checks.find((x:any)=>x.tag===999)?.value!==0||result.checks.find((x:any)=>x.tag===906)?.value!==0)throw Error("Native oracle failure or callback overflow");}
 report.observations=report.results.reduce((n:number,x:any)=>n+x.observations,0);report.taggedChecks=report.results.reduce((n:number,x:any)=>n+x.taggedChecks,0);
 report.status="passed";
}catch(error){failed=true;report.status="failed";report.error=String(error);report.failedAt=new Date().toISOString();save(join(root,"red-before-cleanup.json"),report);console.error(String(error));}
finally{
 for(const p of paths){for(let step=2;step<=8;step++)marker(join(p,"step-"+step+"-go.bin"));marker(join(p,"peer-close-go.bin"));marker(join(p,"host-close-go.bin"));}
 for(const item of pair){
  let exit=await Promise.race([item.p.exited,Bun.sleep(3000).then(()=>null)]);
  if(exit===null){report.processes[item.role].forced=true;item.p.kill();exit=await item.p.exited;}
  report.processes[item.role].exit=exit;writeFileSync(join(paths[item.role],"stdout.txt"),await item.out);writeFileSync(join(paths[item.role],"stderr.txt"),await item.err);
 }
 try{report.ports=[await free(hostPort),await free(hostPort+1)];}catch(error){failed=true;report.status="failed";report.cleanupError=String(error);}
 if(report.processes.some((x:any)=>x.forced)){failed=true;report.status="failed";}
 report.sourceUnchanged=sha(source)===report.source.sha256;report.executableUnchanged=report.executable?sha(exe)===report.executable.sha256:undefined;
 if(!report.sourceUnchanged||report.executableUnchanged===false){failed=true;report.status="failed";}
 report.completedAt=new Date().toISOString();report.artifacts=walk(root).filter(p=>p!==reportPath).map(p=>({path:relative(root,p),bytes:statSync(p).size,sha256:sha(p)}));save(reportPath,report);
 console.log(JSON.stringify({status:report.status,path:reportPath,sha256:sha(reportPath),nonce,observations:report.observations,taggedChecks:report.taggedChecks,processes:report.processes,ports:report.ports,error:report.error}));
 if(failed)process.exitCode=1;
}
