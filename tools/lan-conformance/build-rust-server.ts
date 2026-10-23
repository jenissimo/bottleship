/**
 * Archive locked Rust build inputs and the finite conformance launcher.
 * bun tools/lan-conformance/build-rust-server.ts --output <NEW directory> [--release]
 */
import {createHash} from "node:crypto";
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
import {join,relative,resolve} from "node:path";

const args=process.argv.slice(2);
if(args[0]!=="--output"||!args[1]||args.length>3||args.length===3&&args[2]!=="--release")
 throw Error("Usage: bun tools/lan-conformance/build-rust-server.ts --output <NEW directory> [--release]");
const output=resolve(args[1]),release=args[2]==="--release",root=resolve("packages/lan-rust");
if(existsSync(output))throw Error("Evidence directory already exists");
mkdirSync(output,{recursive:true});
const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const save=(name:string,value:unknown)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+"\n");
function inputs(dir:string):string[]{
 return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  if(["target",".git","node_modules"].includes(entry.name))return[];
  const path=join(dir,entry.name);
  return entry.isDirectory()?inputs(path):entry.isFile()&&(/\.(rs|toml|lock|md)$/.test(path)||["LICENSE","NOTICE"].includes(entry.name))?[path]:[];
 }).sort();
}
const fingerprint=()=>inputs(root).map(path=>({path:relative(process.cwd(),path).replaceAll("\\","/"),sha256:hash(path)}));
const before=fingerprint();
save("inputs.json",before);
for(const input of before){
 const target=join(output,"source",input.path);
 mkdirSync(resolve(target,".."),{recursive:true});
 copyFileSync(input.path,target);
}
copyFileSync(import.meta.filename,join(output,"builder.ts"));
const command=["cargo","build","--manifest-path","packages/lan-rust/Cargo.toml","--offline","--locked","-j","1","--example","conformance-server",...(release?["--release"]:[])];
const child=Bun.spawn(command,{stdout:"pipe",stderr:"pipe",stdin:"ignore"});
const logs=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
const code=await child.exited,[stdout,stderr]=await logs;
writeFileSync(join(output,"build.stdout.log"),stdout);
writeFileSync(join(output,"build.stderr.log"),stderr);
const after=fingerprint(),unchanged=JSON.stringify(before)===JSON.stringify(after);
save("inputs-after.json",after);
let binarySha256:string|null=null;
const binary="conformance-server"+(process.platform==="win32"?".exe":"");
if(code===0&&unchanged){
 const target=process.env.CARGO_TARGET_DIR?resolve(process.env.CARGO_TARGET_DIR):join(root,"target");
 const built=join(target,release?"release":"debug","examples",binary);
 copyFileSync(built,join(output,binary));binarySha256=hash(join(output,binary));
}
const result={command,exitCode:code,sourceCount:before.length,unchanged,binary:binarySha256?binary:null,binarySha256,runtime:{bun:Bun.version,platform:process.platform},inputs:"inputs.json"};
save("manifest.json",result);
console.log(JSON.stringify(result));
if(code!==0||!unchanged)process.exitCode=1;
