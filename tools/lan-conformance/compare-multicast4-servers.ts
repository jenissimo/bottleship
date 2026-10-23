/** Finite same-input TS/Rust multicast proof, never a performance benchmark. */
import assert from "node:assert/strict";
import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
import {join,relative,resolve} from "node:path";
import {createLanServer} from "../../packages/lan/src/server";
import {runMulticast4BlackBox} from "../../packages/lan-rust/core/tests/js/multicast4-black-box";
const args=process.argv.slice(2),options=new Map<string,string>();
for(let i=0;i<args.length;i+=2){
 assert(["--rust-exe","--output","--build-manifest"].includes(args[i])&&args[i+1]&&!options.has(args[i]),"Invalid/duplicate argument");
 options.set(args[i],args[i+1]);
}
const required=(name:string)=>{const value=options.get(name);assert(value,"Missing "+name);return resolve(value)};
const binary=required("--rust-exe"),output=required("--output");
assert(!existsSync(output),"Evidence directory must be new");mkdirSync(output,{recursive:true});
const sha=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const save=(name:string,value:unknown)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+"\n");
const paths=(folder:string):string[]=>readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
 if(["target",".git","node_modules"].includes(entry.name))return[];
 const next=join(folder,entry.name);return entry.isDirectory()?paths(next):[next];
});
const fingerprint=()=>Object.fromEntries([
 ...paths("packages/lan-rust").filter(path=>/\.(rs|toml|lock)$/.test(path)),
 ...paths("packages/lan/src").filter(path=>path.endsWith(".ts")),
 "packages/lan-rust/core/tests/js/multicast4-black-box.ts",import.meta.filename,
].sort().map(path=>[relative(process.cwd(),resolve(path)).replaceAll("\\","/"),sha(path)]));
const before={binarySha256:sha(binary),sources:fingerprint()};save("inputs-before.json",before);
copyFileSync(binary,join(output,"conformance-server.exe"));copyFileSync(import.meta.filename,join(output,"runner.ts"));
copyFileSync("packages/lan-rust/core/tests/js/multicast4-black-box.ts",join(output,"multicast4-black-box.ts"));
if(options.has("--build-manifest"))copyFileSync(resolve(options.get("--build-manifest")!),join(output,"build-manifest.json"));
async function finite<T>(promise:Promise<T>,name:string,ms=5000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<T>((_,reject)=>timer=setTimeout(()=>reject(Error("Deadline: "+name)),ms))])}
 finally{clearTimeout(timer)}
}
let child:ChildProcessWithoutNullStreams|undefined,exit:Promise<number|null>|undefined;
let log="",errors="",buffer="",ready:Record<string,any>|undefined,forced=false;
const retired:Record<string,any>[]=[];
const results:Record<string,any>[]=[];let failure:unknown;
let ts:ReturnType<typeof createLanServer>|undefined;
try{
 child=spawn(binary,[],{stdio:["pipe","pipe","pipe"],windowsHide:true});
 exit=new Promise((resolve,reject)=>{child!.once("error",reject);child!.once("close",resolve)});
 let notify:(()=>void)|undefined;
 child.stdout.on("data",chunk=>{
  const text=String(chunk);log=(log+text).slice(-65536);buffer+=text;
  for(;;){const cut=buffer.indexOf("\n");if(cut<0)break;const line=buffer.slice(0,cut);buffer=buffer.slice(cut+1);
   try{const value=JSON.parse(line);if(value.port)ready=value;if(value.retired)retired.push(value)}catch{}}
  notify?.();
 });
 child.stderr.on("data",chunk=>errors=(errors+String(chunk)).slice(-65536));
 await finite(new Promise<void>((resolve,reject)=>{
  notify=()=>{if(ready){notify=undefined;resolve()}};
  exit!.then(()=>reject(Error("Rust exited before readiness")),reject);notify();
 }),"Rust readiness",8000);
 assert(ready?.port,"No Rust port");
 ts=createLanServer({port:0});const port=await ts.listen();
 for(const [implementation,url]of [["ts","http://127.0.0.1:"+port],["rust","http://127.0.0.1:"+ready.port]] as const){
  for(const transport of ["websocket","polling"] as const){
   const result=await runMulticast4BlackBox(url,transport);results.push({implementation,...result});save("progress.json",results);
  }
 }
 assert.deepEqual(results.filter(row=>row.implementation==="ts").map(({implementation,...row})=>row),
  results.filter(row=>row.implementation==="rust").map(({implementation,...row})=>row),"TS/Rust transcript mismatch");
}catch(error){failure=error instanceof Error?{message:error.message,stack:error.stack}:String(error)}
finally{
 if(ts)await ts.close().catch(error=>failure??=String(error));
 if(child&&exit){try{child.stdin.end("shutdown\n");const code=await finite(exit,"Rust shutdown",5000);assert.equal(code,0)}
  catch(error){forced=true;child.kill();await finite(exit,"Rust forced cleanup",3000).catch(()=>{});failure??=String(error)}}
 writeFileSync(join(output,"rust.stdout.log"),log);writeFileSync(join(output,"rust.stderr.log"),errors);
 const after={binarySha256:sha(binary),sources:fingerprint()};save("inputs-after.json",after);
 const unchanged=JSON.stringify(before)===JSON.stringify(after);if(!unchanged)failure??="Inputs changed during proof";
 const result={passed:failure===undefined,results,forcedCleanup:forced,retired,unchanged,binarySha256:before.binarySha256,
  runtime:{bun:Bun.version,platform:process.platform},...(failure===undefined?{}:{failure})};
 save("result.json",result);console.log(JSON.stringify(result));if(failure!==undefined)process.exitCode=1;
}
