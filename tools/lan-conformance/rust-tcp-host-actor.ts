/** Finite Rust relay + real shared WSA actor integration; capability injection is test-only. */
import {createConnection,createServer} from "node:net";
import {once} from "node:events";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WsaFailure,WSA,ipv4Address} from "../../src/worker/modules/wsa-network";
import {makeNetworkSocketExports} from "../../src/worker/modules/wsa-network-api";

const [binary,output,transport]=process.argv.slice(2);
if(!binary||!output||!["websocket","polling"].includes(transport)||process.argv.length!==5)throw Error("usage: rust-tcp-host-actor <server.exe> <new evidence directory> <websocket|polling>");
mkdirSync(output,{recursive:false});
const config=resolve(join(output,"config.json"));
writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],gateway:{tcpListeners:[{id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.1"],maxPending:2}]}}));
const server=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
const stderrPromise=new Response(server.stderr).text(), reader=server.stdout.getReader(),decoder=new TextDecoder();
let buffered="";
async function line():Promise<string>{for(;;){const i=buffered.indexOf("\n");if(i>=0){const s=buffered.slice(0,i);buffered=buffered.slice(i+1);return s;}const r=await reader.read();if(r.done)throw Error("server stdout ended");buffered+=decoder.decode(r.value,{stream:true});}}
async function bounded<T>(p:Promise<T>,ms=10000):Promise<T>{let t:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{t=setTimeout(()=>reject(Error("deadline")),ms);})]);}finally{clearTimeout(t);}}
function check(v:unknown,m:string):asserts v {if(!v)throw Error(m);}
async function eventually<T>(fn:()=>T):Promise<T>{const deadline=Date.now()+10000;for(;;){try{return fn();}catch(e){if(!(e instanceof WsaFailure)||e.code!==WSA.EWOULDBLOCK||Date.now()>deadline)throw e;await new Promise(ok=>setTimeout(ok,5));}}}
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
let root:RootNetworkNamespace|undefined,child:ChildProcessNetworkNamespace|undefined,peer:ReturnType<typeof createConnection>|undefined;
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
 const boot=root.createChild(36102);child=new ChildProcessNetworkNamespace(childNet,boot.boot);
 await bounded(child.barrier());child.synchronizeState();
 check(childNet.tcpHostListenV1?.listeners[0]?.id==="game"&&childNet.winsock?.hostListener==="game","child snapshot missing test capability/policy");
 const identity=child.socketActorClient();result.childProcess={pid:identity.pid,slot:identity.slot,epoch:identity.epoch};
 const table=createWsaActorTable(childNet,()=>child!.socketActorClient());
 await bounded(child.barrier());
 const sid=table.socket(1,2,6);table.bind(sid,ipv4Address(childNet.ipv4,2302));
 let error=0;const api=makeNetworkSocketExports(table,code=>{error=code;},{started:true},()=>0);
 const opened=bounded(once(link.socket,"tcpHostOpened"));
 const call=api.listen({} as never,new Uint8Array(0),[sid,5]);
 const [id,reply]=await opened;check(id>0&&reply.address?.port>0&&!reply.error,"listener open failed");
 const listenResult=await bounded(Promise.resolve(call));check((listenResult as {value:number}).value===0,"listen failed: "+error);
 peer=createConnection({host:"127.0.0.1",port:reply.address.port,allowHalfOpen:true});await bounded(once(peer,"connect"));
 const accepted=await eventually(()=>table.accept(sid));table.closesocket(sid);
 await rebind(reply.address.port);result.listenerRebound=true;
 const chunks:number[]=[];const got=bounded(new Promise<void>((ok,no)=>{peer!.on("data",data=>{chunks.push(...data);if(chunks.length>=3)ok();});peer!.once("error",no);}));
 check(table.send(accepted,Uint8Array.of(1,2,3))===3,"guest send failed");await got;check(chunks.join(",")==="1,2,3","wrong guest data");
 peer.write(Uint8Array.of(4,5));const received:number[]=[];
 while(received.length<2){const packet=await eventually(()=>table.receive(accepted,2-received.length));check(packet.data.length>0,"unexpected EOF");received.push(...packet.data);}
 check(received.join(",")==="4,5","wrong peer data");
 const nativeEof=bounded(once(peer,"end"));check(table.shutdown(accepted,1)===0,"guest shutdown failed");await nativeEof;
 peer.end();const eof=await eventually(()=>table.receive(accepted,1));check(eof.data.length===0,"guest EOF missing");
 result.halfClose=true;table.closesocket(accepted);await bounded(child.finishProcessLifetime());result.listenerPort=reply.address.port;result.bidirectional=true;
}catch(e){failed=e;}
finally{
 peer?.destroy();try{child?.close();await bounded(root?.close()??Promise.resolve());}catch(e){failed??=e;}
 server.stdin.write("shutdown\n");server.stdin.end();let retired:any,exit:number|undefined,stderr="",stdoutEof=false,forced=false;
 try{retired=JSON.parse(await bounded(line()));exit=await bounded(server.exited);const rest=await bounded(reader.read());stdoutEof=rest.done&&buffered.length===0;stderr=await bounded(stderrPromise);check(retired?.retired===true&&retired?.explicit===true&&exit===0&&stdoutEof,"server shutdown failed");}
 catch(e){failed??=e;forced=true;server.kill();try{exit=await bounded(server.exited);stderr=await bounded(stderrPromise);}catch(cleanup){failed??=cleanup;}}
 const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
 writeFileSync(join(output,"result.json"),JSON.stringify({result,retired,exit,stderr,stdoutEof,forced,binarySha256:hash(binary),configSha256:hash(config),runnerSha256:hash(import.meta.filename),error:failed?String(failed):null},null,2));
}
if(failed)throw failed;console.log(JSON.stringify(result));
