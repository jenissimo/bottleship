/** Finite Rust relay + real shared WSA actor integration; capability injection is test-only. */
import {createConnection,createServer} from "node:net";
import {once} from "node:events";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {WSA} from "../../src/worker/modules/wsa-network";

const [binary,output,transport]=process.argv.slice(2);
if(!binary||!output||!["websocket","polling"].includes(transport)||process.argv.length!==5)throw Error("usage: rust-tcp-host-process <server.exe> <new evidence directory> <websocket|polling>");
mkdirSync(output,{recursive:false});
const workerPath=resolve("tools/lan-conformance/rust-tcp-host-process-worker.ts");
const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const workerBefore=hash(workerPath), binaryBefore=hash(binary), runnerBefore=hash(import.meta.filename);
const config=resolve(join(output,"config.json"));
writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],gateway:{tcpListeners:[{id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.1"],maxPending:2}]}}));
const server=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
const stderrPromise=new Response(server.stderr).text(), reader=server.stdout.getReader(),decoder=new TextDecoder();
let buffered="";
async function line():Promise<string>{for(;;){const i=buffered.indexOf("\n");if(i>=0){const s=buffered.slice(0,i);buffered=buffered.slice(i+1);return s;}const r=await reader.read();if(r.done)throw Error("server stdout ended");buffered+=decoder.decode(r.value,{stream:true});}}
async function bounded<T>(p:Promise<T>,ms=10000):Promise<T>{let t:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{t=setTimeout(()=>reject(Error("deadline")),ms);})]);}finally{clearTimeout(t);}}
function check(v:unknown,m:string):asserts v {if(!v)throw Error(m);}
async function eventually<T>(fn:()=>Promise<T>):Promise<T>{const deadline=Date.now()+10000;for(;;){try{return await fn();}catch(e){if(e!==WSA.EWOULDBLOCK||Date.now()>deadline)throw e;await new Promise(ok=>setTimeout(ok,5));}}}
async function rebind(port:number):Promise<void>{
 const deadline=Date.now()+10000;
 for(;;){
  const probe=createServer();
  try{await new Promise<void>((ok,no)=>{probe.once("error",no);probe.listen({host:"127.0.0.1",port,exclusive:true},ok);});
   await new Promise<void>((ok,no)=>probe.close(e=>e?no(e):ok()));return;
  }catch(e){probe.close();if((e as NodeJS.ErrnoException).code!=="EADDRINUSE"||Date.now()>deadline)throw e;
   await new Promise(ok=>setTimeout(ok,10));}
 }
}
const result:Record<string,unknown>={transport,capabilityInjected:true};let failed:unknown;
let root:RootNetworkNamespace|undefined,processWorker:Worker|undefined,lease:{close():void}|undefined,peer:ReturnType<typeof createConnection>|undefined;
let request:((message:object,ports?:MessagePort[])=>Promise<any>)|undefined;
try{
 const hello=JSON.parse(await bounded(line(),15000));check(hello.service==="bottleship-lan"&&hello.port>0,"bad ready");
 const rootNet=new LanNetwork(), childNet=new LanNetwork();
 root=new RootNetworkNamespace(rootNet,16,36101);
 await bounded(root.configure({serverUrl:"http://127.0.0.1:"+hello.port,room:"tcp-actor-"+transport,winsock:{provider:"native",hostListener:"game"}}));
 const internal=root as any,link=internal.active.link;
 check(link.socket.io.engine.transport.name===transport,"unexpected Engine.IO transport");
 check(internal.backplane.tcpHostListenV1===undefined,"production capability unexpectedly advertised");
 internal.backplane.configureTcpHosts({listeners:[{id:"game",allowedNodes:[[2,1,127,0,0,1]]}]});
 internal.state(internal.snapshot());
 async function bootWorker(pid:number) {
  const child=root!.createChild(pid);lease=child;
  processWorker=new Worker(new URL("./rust-tcp-host-process-worker.ts",import.meta.url).href,{type:"module"});
  let sequence=0;
  const pending=new Map<number,{resolve(value:any):void,reject(error:unknown):void,timer:ReturnType<typeof setTimeout>}>();
  processWorker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);if(data.error!==undefined)task.reject(data.error);else task.resolve(data.result);};
  const worker=processWorker;
  request=(message:object,ports:MessagePort[]=[])=>new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error("process RPC deadline"));},10000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,...message},ports);});
  await request({boot:child.boot},[child.boot.port]);return child;
 }
 const child=await bootWorker(36102);result.childProcess={pid:child.boot.pid,slot:child.boot.slot,epoch:child.boot.epoch};
 const call=(command:string,args:object={})=>request!({command,args});
 const sid=await call("bind",{port:2302});
 const opened=bounded(once(link.socket,"tcpHostOpened"));
 const listening=call("listen",{sid});
 const [id,reply]=await opened;check(id>0&&reply.address?.port>0&&!reply.error,"listener open failed");
 await listening;
 peer=createConnection({host:"127.0.0.1",port:reply.address.port,allowHalfOpen:true});await bounded(once(peer,"connect"));
 const accepted=await eventually(()=>call("accept",{sid}));await call("close",{sid});
 await rebind(reply.address.port);result.listenerRebound=true;
 const chunks:number[]=[];const got=bounded(new Promise<void>((ok,no)=>{peer!.on("data",data=>{chunks.push(...data);if(chunks.length>=3)ok();});peer!.once("error",no);}));
 check(await call("send",{sid:accepted,bytes:[1,2,3]})===3,"guest send failed");await got;check(chunks.join(",")==="1,2,3","wrong guest data");
 peer.write(Uint8Array.of(4,5));const received:number[]=[];
 while(received.length<2){const part:number[]=await eventually(()=>call("receive",{sid:accepted,length:2-received.length}));check(part.length>0,"unexpected EOF");received.push(...part);}
 check(received.join(",")==="4,5","wrong peer data");
 const nativeEof=bounded(once(peer,"end"));check(await call("shutdown",{sid:accepted})===0,"guest shutdown failed");await nativeEof;
 peer.end();const eof:number[]=await eventually(()=>call("receive",{sid:accepted,length:1}));check(eof.length===0,"guest EOF missing");
 result.halfClose=true;await call("close",{sid:accepted});await call("finish");result.listenerPort=reply.address.port;result.bidirectional=true;
 peer.destroy();peer=undefined;
 {const stopped=new Promise<void>(resolve=>processWorker!.addEventListener("close",()=>resolve(),{once:true}));processWorker!.terminate();await bounded(stopped);}
 processWorker=undefined;lease?.close();lease=undefined;
 const crashed=await bootWorker(36103);result.crashChild={pid:crashed.boot.pid,slot:crashed.boot.slot,epoch:crashed.boot.epoch};
 const crashSid=await call("bind",{port:2303});
 const crashOpened=bounded(once(link.socket,"tcpHostOpened"));const crashListening=call("listen",{sid:crashSid});
 const [,crashReply]=await crashOpened;check(crashReply.address?.port>0&&!crashReply.error,"crash listener open failed");await crashListening;
 peer=createConnection({host:"127.0.0.1",port:crashReply.address.port,allowHalfOpen:true});await bounded(once(peer,"connect"));
 await eventually(()=>call("accept",{sid:crashSid}));
 const disconnected=bounded(new Promise<string>((ok,no)=>{
  peer!.once("end",()=>ok("EOF"));peer!.once("error",(error:NodeJS.ErrnoException)=>error.code==="ECONNRESET"?ok("ECONNRESET"):no(error));
  peer!.resume();
 }));
 const stopped=new Promise<void>(resolve=>processWorker!.addEventListener("close",()=>resolve(),{once:true}));
 processWorker!.terminate();await bounded(stopped);processWorker=undefined;
 // The supervisor explicitly revokes the dead worker's namespace lease.
 lease!.close();lease=undefined;
 const peerTermination=await disconnected;await rebind(crashReply.address.port);
 result.crashCleanup={peerTermination,listenerRebound:true,supervisorLeaseRevoked:true,listenerPort:crashReply.address.port};
}catch(e){failed=e;}
finally{
 const cleanup:Record<string,string>={};
 const attempt=async(name:string,fn:()=>void|Promise<void>)=>{try{await fn();cleanup[name]="ok";}catch(e){cleanup[name]=String(e);failed??=e;}};
 await attempt("peer",()=>{peer?.destroy();});
 await attempt("worker",async()=>{if(processWorker){const stopped=new Promise<void>(resolve=>processWorker!.addEventListener("close",()=>resolve(),{once:true}));processWorker.terminate();await bounded(stopped);}});
 await attempt("lease",()=>{lease?.close();});
 await attempt("root",()=>bounded(root?.close()??Promise.resolve()));
 result.cleanup=cleanup;
 server.stdin.write("shutdown\n");server.stdin.end();let retired:any,exit:number|undefined,stderr="",stdoutEof=false,forced=false;
 try{retired=JSON.parse(await bounded(line()));exit=await bounded(server.exited);const rest=await bounded(reader.read());stdoutEof=rest.done&&buffered.length===0;stderr=await bounded(stderrPromise);check(retired?.retired===true&&retired?.explicit===true&&exit===0&&stdoutEof,"server shutdown failed");}
 catch(e){failed??=e;forced=true;server.kill();try{exit=await bounded(server.exited);stderr=await bounded(stderrPromise);}catch(cleanup){failed??=cleanup;}}
 const workerAfter=hash(workerPath),binaryAfter=hash(binary),runnerAfter=hash(import.meta.filename);
 if(workerAfter!==workerBefore||binaryAfter!==binaryBefore||runnerAfter!==runnerBefore)failed??=Error("binary or fixture changed during run");
 writeFileSync(join(output,"result.json"),JSON.stringify({result,retired,exit,stderr,stdoutEof,forced,binaryBefore,binaryAfter,runnerBefore,runnerAfter,configSha256:hash(config),workerBefore,workerAfter,error:failed?String(failed):null},null,2));
}
if(failed)throw failed;console.log(JSON.stringify(result));
