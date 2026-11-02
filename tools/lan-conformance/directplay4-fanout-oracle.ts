import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {createHash,randomBytes} from "node:crypto";
import {dirname,join,resolve} from "node:path";
const [gccArg,hostDirArg,outArg]=process.argv.slice(2);
if(process.argv.length!==5)throw Error("usage: gcc verified-host-dir new-output-dir");
const gcc=resolve(gccArg),hostDir=resolve(hostDirArg),dir=resolve(outArg);
mkdirSync(dir,{recursive:false});
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const host=join(hostDir,"host.exe"),hostSource=resolve("tools/lan-conformance/directplay4-session-native-host.c");
const source=resolve("tools/lan-conformance/directplay4-fanout-oracle.c"),reuse=process.env.BS_DP4_FANOUT_CLIENT_RUN?resolve(process.env.BS_DP4_FANOUT_CLIENT_RUN):undefined,client=join(reuse??dir,"client.exe"),ready=join(dir,"ready.bin");
const evidence=JSON.parse(readFileSync(join(hostDir,"result.json"),"utf8"));
if(evidence.error!==null||evidence.report?.hostProcess?.exit!==0||evidence.report?.cleanup?.host!=="ok"||
 evidence.before?.source!==sha(hostSource)||evidence.after?.source!==sha(hostSource)||
 evidence.before?.gcc!==sha(gcc)||evidence.after?.gcc!==sha(gcc)||
 !evidence.exeBefore||evidence.exeBefore!==evidence.exeAfter||sha(host)!==evidence.exeBefore)throw Error("host provenance mismatch");
const inputs={host:sha(host),hostSource:sha(hostSource),source:sha(source),runner:sha(import.meta.filename),gcc:sha(gcc)};
const env={Path:dirname(gcc)+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
const timed=async<T>(p:Promise<T>,ms=10000):Promise<T>=>{let t:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,no)=>{t=setTimeout(()=>no(Error("timeout")),ms);})]);}finally{if(t)clearTimeout(t);}};
class Lines {
 private reader:ReadableStreamDefaultReader<Uint8Array>;private buffer="";readonly lines:string[]=[];
 constructor(stream:ReadableStream<Uint8Array>){this.reader=stream.getReader();}
 async until(re:RegExp):Promise<RegExpExecArray>{
  for(;;){let i=this.buffer.indexOf("\n");if(i>=0){const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);this.lines.push(line);const found=re.exec(line);if(found)return found;continue;}
   const part=await timed(this.reader.read());if(part.done)throw Error("unexpected process EOF");this.buffer+=new TextDecoder().decode(part.value,{stream:true});}
 }
}
let h:ReturnType<typeof Bun.spawn>|undefined,c:ReturnType<typeof Bun.spawn>|undefined,error:string|null=null;
let hostLines:Lines|undefined,clientLines:Lines|undefined,hostExit:number|undefined,clientExit:number|undefined,clientHash:string|undefined,phase="build";
let sockets:string[]=[];
const snapshot=(pids:number[])=>new TextDecoder().decode(Bun.spawnSync(["C:/Windows/System32/netstat.exe","-ano"],{stdout:"pipe",stderr:"ignore"}).stdout).split(/\r?\n/).filter(line=>pids.some(pid=>line.trim().endsWith(" "+pid)));
const nonce=randomBytes(4).readUInt32LE()||1;
try{
 if(reuse){
  const previous=JSON.parse(readFileSync(join(reuse,"result.json"),"utf8"));
  if(previous.inputs?.source!==inputs.source||previous.inputs?.gcc!==inputs.gcc||!previous.clientHash||sha(client)!==previous.clientHash)throw Error("client provenance mismatch");
 }else{
  const build=Bun.spawn([gcc,"-O1","-o",client,source,"-lole32","-ldxguid","-luuid"],{env,stdout:"pipe",stderr:"pipe"});
  const buildErr=new Response(build.stderr).text(),buildOut=new Response(build.stdout).text();const code=await timed(build.exited,20000);
  if(code!==0)throw Error("compile failed: "+await buildOut+" "+await buildErr);
 }
 clientHash=sha(client);
 phase="host-ready";h=Bun.spawn([host,String(nonce),ready],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 const hostErr=new Response(h.stderr).text();hostLines=new Lines(h.stdout);await hostLines.until(/^READY$/);
 phase="client-ready";c=Bun.spawn([client,String(nonce),ready],{env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 const clientErr=new Response(c.stderr).text();clientLines=new Lines(c.stdout);
 const local=await clientLines.until(/^CLIENT_READY a=(\d+) b=(\d+)$/);
 if(local[1]===local[2])throw Error("duplicate local IDs");
 sockets=snapshot([h.pid,c.pid]);phase="host-create";h.stdin.write("T\n");await h.stdin.flush();const created=await hostLines.until(/^LIVE_CREATE hr=00000000 id=(\d+)$/);
 phase="client-create";c.stdin.write("C "+created[1]+"\n");await c.stdin.flush();await clientLines.until(/^CREATE_DONE$/);
 phase="host-delete";h.stdin.write("Y "+created[1]+"\n");await h.stdin.flush();await hostLines.until(/^LIVE_DELETE hr=00000000 id=/);
 phase="client-delete";c.stdin.write("D "+created[1]+"\n");await c.stdin.flush();await clientLines.until(/^DELETE_DONE$/);
 c.stdin.end();clientExit=await timed(c.exited);h.stdin.write("Q\n");h.stdin.end();hostExit=await timed(h.exited);
 if(clientExit!==0||hostExit!==0)throw Error("native process failed");
 const hs=await hostErr,cs=await clientErr;if(hs||cs)throw Error("native stderr: "+hs+" "+cs);
 if(inputs.host!==sha(host)||inputs.hostSource!==sha(hostSource)||inputs.source!==sha(source)||inputs.runner!==sha(import.meta.filename)||inputs.gcc!==sha(gcc)||clientHash!==sha(client))throw Error("inputs changed");
}catch(e){error=String(e);if(h&&c)sockets=snapshot([h.pid,c.pid]);}
finally{
 if(c&&clientExit===undefined){c.kill();clientExit=await timed(c.exited).catch(()=>undefined);}
 if(h&&hostExit===undefined){h.kill();hostExit=await timed(h.exited).catch(()=>undefined);}
 writeFileSync(join(dir,"result.json"),JSON.stringify({nonce,inputs,clientHash,hostExit,clientExit,phase,sockets,hostLines:hostLines?.lines,clientLines:clientLines?.lines,error},null,2));
}
if(error)throw Error(error);
