import {createHash} from "node:crypto";
import {readFile,mkdir,access} from "node:fs/promises";
import {spawn} from "node:child_process";
import {dirname,resolve} from "node:path";
const pending=new Map<string,Promise<string>>();
/** Source-addressed build of ONLY the separate ordinary UDP helper. */
export function buildBoundUdpHelper(flags:string[]=[]):Promise<string>{
 const key=flags.join(" ");let job=pending.get(key);if(job)return job;
 job=(async()=>{
  const source=resolve("packages/lan/native/udp-bound-helper.c");
  const digest=createHash("sha256").update(await readFile(source)).update(key).digest("hex").slice(0,20);
  const folder=resolve("logs/lan-conformance/udp-bound-production/build");await mkdir(folder,{recursive:true});
  const output=resolve(folder,"udp-"+digest+(process.platform==="win32"?".exe":""));
  try{await access(output);return output;}catch{}
  const compiler=process.env.BS_LAN_CC??(process.platform==="win32"?"C:/msys64/mingw64/bin/gcc.exe":"cc");
  const env={...process.env};if(process.platform==="win32"){
   for(const name of Object.keys(env))if(name.toLowerCase()==="path")delete env[name];
   env.Path=dirname(compiler)+";"+(process.env.PATH??process.env.Path??"");
  }
  const args=["-std=c11","-O2","-Wall","-Wextra","-Werror",...flags,source,"-o",output,...(process.platform==="win32"?["-lws2_32"]:["-pthread"])];
  const code=await new Promise<number>((ok,no)=>{const child=spawn(compiler,args,{stdio:"inherit",env});child.once("error",no);child.once("exit",code=>ok(code??1));});
  if(code)throw Error("Separate UDP helper compile failed: "+code);return output;
 })();pending.set(key,job);return job;
}
