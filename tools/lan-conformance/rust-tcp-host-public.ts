/** Explicit conformance runner; requires an owned finite Rust conformance-server binary. */
import {createConnection,createServer} from "node:net";
import {once} from "node:events";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
import {WsaSocketTable, WsaFailure, WSA, ipv4Address} from "../../src/worker/modules/wsa-network";
import {makeNetworkSocketExports} from "../../src/worker/modules/wsa-network-api";

const [binary,output]=process.argv.slice(2);
if(!binary||!output||process.argv.length!==4)throw Error("usage: rust-tcp-host-worker <server.exe> <new evidence directory>");
mkdirSync(output,{recursive:false});
const config=resolve(join(output,"config.json"));
writeFileSync(config,JSON.stringify({host:"127.0.0.1",gateway:{tcpListeners:[{id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.1"],maxPending:2}]}}));
const server=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
const stderrPromise=new Response(server.stderr).text();
const reader=server.stdout.getReader(), decoder=new TextDecoder();
let buffered="";
async function line():Promise<string>{
 for(;;){const i=buffered.indexOf("\n");if(i>=0){const s=buffered.slice(0,i);buffered=buffered.slice(i+1);return s;}
 const r=await reader.read();if(r.done)throw Error("server stdout ended");buffered+=decoder.decode(r.value,{stream:true});}
}
async function bounded<T>(p:Promise<T>,ms=5000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("deadline")),ms);})]);}
 finally{clearTimeout(timer);}}
function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
async function eventually<T>(fn:()=>T):Promise<T>{const until=Date.now()+5000;
 for(;;){try{return fn();}catch(e){if(!(e instanceof WsaFailure)||e.code!==WSA.EWOULDBLOCK||Date.now()>until)throw e;
 await new Promise(ok=>setTimeout(ok,10));}}
}
async function rebind(port:number):Promise<void>{
 const until=Date.now()+5000;
 for(;;){
  const probe=createServer();
  try{await new Promise<void>((ok,no)=>{probe.once("error",no);probe.listen({host:"127.0.0.1",port,exclusive:true},ok);});
   await new Promise<void>((ok,no)=>probe.close(e=>e?no(e):ok()));return;
  }catch(e){probe.close();if((e as NodeJS.ErrnoException).code!=="EADDRINUSE"||Date.now()>until)throw e;
   await new Promise(ok=>setTimeout(ok,10));}
 }
}
const results:unknown[]=[];
let failed:unknown;
try{
 const hello=JSON.parse(await bounded(line(),15000));check(hello.service==="bottleship-lan"&&hello.port>0,"bad ready");
 for(const transport of ["websocket","polling"] as const){
  const net=new LanNetwork(Uint8Array.of(2,0,0,1,2,transport==="websocket"?3:4));
  const link=new RelayLink("http://127.0.0.1:"+hello.port,"tcp-worker-"+transport,net,{transports:[transport],timeoutMs:5000});
  net.attach(link);let peer:ReturnType<typeof createConnection>|undefined;
  const table=new WsaSocketTable(net);
  try{
   await bounded(link.ready);
   check(link.socket.io.engine.transport.name===transport,"unexpected Engine.IO transport");
   check(JSON.stringify(net.tcpHostListenV1)==JSON.stringify({listeners:[{id:"game",allowedNodes:[[2,1,127,0,0,1]]}]}),"server did not advertise the configured capability");
   net.configureWinsock({provider:"native",hostListener:"game"});
   const sid=table.socket(1,2,6);table.bind(sid,ipv4Address(net.ipv4,2302));
   let error=0;
   const api=makeNetworkSocketExports(table,code=>{error=code;},{started:true},()=>0);
   const opened=bounded(once(link.socket,"tcpHostOpened"));
   const call=api.listen({} as never,new Uint8Array(0),[sid,5]);
   const [requestId,reply]=await opened;
   check(requestId>0&&reply.address?.port>0&&!reply.error,"listener open failed");
   const listenResult=await bounded(Promise.resolve(call));
   check((listenResult as {value:number}).value===0,"listen failed: "+error);
   peer=createConnection({host:"127.0.0.1",port:reply.address.port,allowHalfOpen:true});
   await bounded(once(peer,"connect"));
   const child=await eventually(()=>table.accept(sid));
   table.closesocket(sid);
   await rebind(reply.address.port);
   const chunks:number[]=[];
   const got=bounded(new Promise<void>((resolve,reject)=>{
    peer!.on("data",data=>{chunks.push(...data);if(chunks.length>=3)resolve();});
    peer!.once("error",reject);
   }));
   check(table.send(child,Uint8Array.of(1,2,3))===3,"guest send failed");
   await got;check(chunks.join(",")==="1,2,3","wrong guest data");
   peer.write(Uint8Array.of(4,5));
   const received:number[]=[];
   while(received.length<2){const packet=await eventually(()=>table.receive(child,2-received.length));
    check(packet.data.length>0,"unexpected EOF");received.push(...packet.data);}
   check(received.join(",")==="4,5","wrong native data");
   const nativeEof=bounded(once(peer,"end"));
   check(table.shutdown(child,1)===0,"guest shutdown failed");
   await nativeEof;
   peer.end();
   const eof=await eventually(()=>table.receive(child,1));
   check(eof.data.length===0,"guest EOF missing");
   table.closesocket(child);
   results.push({transport,port:reply.address.port,listenerRebound:true,bidirectional:true,halfClose:true,capabilityFromServer:true});
  } finally {peer?.destroy();table.reset();net.attach(null);link.close();}
 }
} catch(e){failed=e;}
finally{
 server.stdin.write("shutdown\n");server.stdin.end();
 let retired:any,exit:number|undefined,stderr="",stdoutEof=false,forced=false;
 try{
  retired=JSON.parse(await bounded(line(),10000));
  exit=await bounded(server.exited,10000);
  const rest=await bounded(reader.read(),10000);stdoutEof=rest.done && buffered.length===0;
  stderr=await bounded(stderrPromise,10000);
  check(retired?.retired===true&&retired?.explicit===true&&exit===0&&stdoutEof,"server shutdown/EOF failed");
 } catch(e){
  failed??=e;forced=true;server.kill();
  try{exit=await bounded(server.exited,10000);stderr=await bounded(stderrPromise,10000);}catch(cleanup){failed??=cleanup;}
 }
 const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
 writeFileSync(join(output,"result.json"),JSON.stringify({results,retired,exit,stderr,stdoutEof,forced,binarySha256:hash(binary),configSha256:hash(config),runnerSha256:hash(import.meta.filename),error:failed?String(failed):null},null,2));
}
if(failed)throw failed;
console.log(JSON.stringify(results));
