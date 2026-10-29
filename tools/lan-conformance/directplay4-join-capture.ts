import {createHash,randomBytes} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
if(process.platform!=="win32"||process.argv.length!==4)throw Error("usage: directplay4-join-capture NEW_DIR X86_GCC");
const dir=resolve(process.argv[2]),gcc=resolve(process.argv[3]);mkdirSync(dir,{recursive:false});
const source=resolve("tools/lan-conformance/directplay4-join-oracle.c"),runner=resolve(import.meta.filename),exe=join(dir,"directplay4-join-oracle.exe"),ready=join(dir,"host-ready.bin");
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const before={source:sha(source),runner:sha(runner),compiler:sha(gcc)},nonce=randomBytes(4).readUInt32LE()||1;
const report:any={nonce,before,status:"STARTED",children:[]};const save=()=>writeFileSync(join(dir,"result.json"),JSON.stringify(report,null,2)+"\n");save();
const env={Path:dirname(gcc)+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
type Owned={pid:number;exit?:number;done:Promise<void>};
function start(role:string,args:string[]):Owned{
 const child=Bun.spawn(args,{cwd:dir,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),record:any={role,pid:child.pid,args};
 report.children.push(record);save();
 const drain=async(stream:ReadableStream<Uint8Array>,file:string)=>{const reader=stream.getReader(),parts:Uint8Array[]=[];let kept=0,total=0;
  for(;;){const r=await reader.read();if(r.done)break;total+=r.value.length;const n=Math.min(r.value.length,Math.max(0,1024*1024-kept));if(n){parts.push(r.value.slice(0,n));kept+=n;}}
  writeFileSync(file,Buffer.concat(parts));return {eof:true,total,kept,truncated:total!==kept,sha256:sha(file)};};
 const tracked:Owned={pid:child.pid,done:Promise.resolve()};
 const exit=child.exited.then(code=>{tracked.exit=code;record.exit=code;save();});
 tracked.done=Promise.all([exit,drain(child.stdout,join(dir,role+".stdout")),drain(child.stderr,join(dir,role+".stderr"))]).then(([,out,err])=>{
  record.stdout=out;record.stderr=err;save();
 });
 return tracked;
}
let host:Owned|undefined,client:Owned|undefined;
try{
 const version=start("compiler-version",[gcc,"--version"]);await version.done;if(version.exit!==0)throw Error("compiler version failed");
 const build=start("build",[gcc,"-O1","-o",exe,source,"-lole32","-ldxguid","-luuid"]);await build.done;if(build.exit!==0)throw Error("build failed");
 report.exeBefore=sha(exe);save();
 host=start("host",[exe,"host",String(nonce),ready]);
 const deadline=Date.now()+17000;
 while(!existsSync(ready)){
  if(host.exit!==undefined)throw Error("host exited before READY");
  if(Date.now()>deadline)throw Error("host READY deadline");
  await new Promise(ok=>setTimeout(ok,25));
 }
 let marker:Buffer|undefined;
 while(!marker&&Date.now()<deadline){try{const data=readFileSync(ready);if(data.length===16)marker=data;}catch{}if(!marker)await new Promise(ok=>setTimeout(ok,25));}
 if(!marker||marker.readUInt32LE(0)!==0x4a345044||marker.readUInt32LE(4)!==nonce||marker.readUInt32LE(8)!==host.pid||!marker.readUInt32LE(12))throw Error("bad READY");
 report.ready={sha256:sha(ready),hostPid:host.pid,player:marker.readUInt32LE(12)};save();
 client=start("client",[exe,"client",String(nonce),ready]);await client.done;
 report.hostAliveAtClientExit=host.exit===undefined;
 await host.done;
 if(client.exit!==0||host.exit!==0)throw Error("native helper failure");
 if(!report.hostAliveAtClientExit)throw Error("host exited before client");
 const hostText=readFileSync(join(dir,"host.stdout"),"utf8"),clientText=readFileSync(join(dir,"client.stdout"),"utf8");
 for(const text of ["OPEN_CREATE 00000000","CREATE_PLAYER 00000000","HOST_RECV 00000000","HOST_SEND 00000000","DESTROY 00000000","CLOSE 00000000"])if(!hostText.includes(text))throw Error("missing host stage "+text);
 for(const text of ["ENUM 00000000 matches=1","OPEN_JOIN 00000000","CREATE_PLAYER 00000000","CLIENT_SEND 00000000","CLIENT_RECV 00000000","DESTROY 00000000","CLOSE 00000000"])if(!clientText.includes(text))throw Error("missing client stage "+text);
 report.after={source:sha(source),runner:sha(runner),compiler:sha(gcc),exe:sha(exe)};
 if(report.after.source!==before.source||report.after.runner!==before.runner||report.after.compiler!==before.compiler||report.after.exe!==report.exeBefore)throw Error("inputs changed");
 report.status="OBSERVED";
}catch(e){report.status="FAILED";report.error=String(e);}
finally{
 // Each owned helper has a 25-second self-watchdog. Never discard an owned
 // process handle merely because readiness or observation failed.
 if(client)await client.done;if(host)await host.done;save();
}
if(report.status!=="OBSERVED")throw Error(report.error);console.log(JSON.stringify({nonce,status:report.status}));
