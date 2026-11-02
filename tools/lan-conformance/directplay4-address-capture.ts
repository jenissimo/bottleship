import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
if(process.platform!=="win32"||process.argv.length!==4)throw Error("usage: bun directplay4-address-capture.ts NEW_DIR X86_GCC");
const dir=resolve(process.argv[2]),gcc=resolve(process.argv[3]);
mkdirSync(dir,{recursive:false});
const source=resolve("tools/lan-conformance/directplay4-address-oracle.c"),runner=resolve(import.meta.filename),exe=join(dir,"directplay4-address-oracle.exe");
const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const before={source:hash(source),runner:hash(runner),compiler:hash(gcc)};
const manifest:any={before,children:[],status:"STARTED"};const save=()=>writeFileSync(join(dir,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
const env={Path:dirname(gcc)+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
async function run(role:string,args:string[]){
 const proc=Bun.spawn(args,{cwd:dir,env,stdout:"pipe",stderr:"pipe"});
 const row:any={role,pid:proc.pid,args};manifest.children.push(row);save();
 // Read both owned streams to EOF and retain their raw bytes.
 const capture=async(s:ReadableStream<Uint8Array>,path:string)=>{const parts:Uint8Array[]=[];const r=s.getReader();let n=0;for(;;){const item=await r.read();if(item.done)break;n+=item.value.length;if(n>1024*1024)throw Error("output limit");parts.push(item.value);}const data=Buffer.concat(parts);writeFileSync(path,data);return {eof:true,bytes:n,sha256:hash(path)};};
 const [exit,stdout,stderr]=await Promise.all([proc.exited,capture(proc.stdout,join(dir,role+".stdout")),capture(proc.stderr,join(dir,role+".stderr"))]);
 Object.assign(row,{exit,stdout,stderr});save();if(exit!==0)throw Error(role+" exit "+exit);
}
try{
 await run("compiler-version",[gcc,"--version"]);
 await run("build",[gcc,"-O1","-o",exe,source,"-lole32","-ldxguid","-luuid"]);
 manifest.exeBefore=hash(exe);save();
 for(const scenario of ["enum","valid","null-flags","wrong-guid-flags","valid-flags","already-null-flags","tail-byte","tail-before-sp","size-23","size-zero","total-chunk-zero"]){
  await run(scenario,[exe,scenario]);
  const out=readFileSync(join(dir,scenario+".stdout"),"utf8");
  if(!out.includes(scenario==="enum"?"ENUM ":"INIT "))throw Error("missing observation "+scenario);
 }
 manifest.after={source:hash(source),runner:hash(runner),compiler:hash(gcc),exe:hash(exe)};
 if(manifest.after.source!==before.source||manifest.after.runner!==before.runner||manifest.after.compiler!==before.compiler||manifest.after.exe!==manifest.exeBefore)throw Error("input changed");
 manifest.status="OBSERVED";save();
}catch(e){manifest.status="FAILED";manifest.error=String(e);save();throw e;}
