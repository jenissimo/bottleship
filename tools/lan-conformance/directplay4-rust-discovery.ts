/** Finite source-vector DP4 discovery across real Rust relay and two workers. */
import {createSocket,type Socket as DatagramSocket} from "node:dgram";
import {createConnection,type Socket} from "node:net";
import {once} from "node:events";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {createHash,randomBytes} from "node:crypto";
import {resolve,join} from "node:path";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
const [binary,output,transport]=process.argv.slice(2);
if(!binary||!output||!["websocket","polling"].includes(transport)||process.argv.length!==5)throw Error("usage: directplay4-rust-discovery <exe> <new-dir> <transport>");
mkdirSync(output,{recursive:false});
const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const workerPath="tools/lan-conformance/directplay4-rust-worker.ts";
const udpHelper=resolve("logs/lan-conformance/stage54-rust-startup-dns/lan-conformance-first/udp-helper.exe");
const runtimePaths=["src/worker/modules/dplayx/native-wire/discovery.ts","src/worker/modules/dplayx/native-wire/lan-discovery.ts","src/worker/modules/wsa-network.ts","src/worker/modules/wsa-actor-kernel.ts","src/worker/modules/wsa-actor-table.ts","src/worker/modules/wsa-actor-worker.ts","src/worker/core/network-namespace.ts","src/worker/net/lan-network.ts","src/worker/net/relay-link.ts","src/worker/net/tcp-host-lease-rpc.ts"];
const runtimeHash=()=>Object.fromEntries(runtimePaths.map(path=>[path,hash(path)]));
const inputs=()=>({binary:hash(binary),runner:hash(import.meta.filename),worker:hash(workerPath),udpHelper:hash(udpHelper),runtime:runtimeHash()});
let root:RootNetworkNamespace|undefined,worker:Worker|undefined,lease:{close():void}|undefined,peer:Socket|undefined,udp:DatagramSocket|undefined,server:ReturnType<typeof Bun.spawn>|undefined;
let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,stderrP:Promise<string>|undefined,buf="",failed:unknown,inputsBefore:ReturnType<typeof inputs>|undefined,inputsAfter:ReturnType<typeof inputs>|undefined;
const config=resolve(join(output,"config.json"));
const bounded=async<T>(p:Promise<T>,ms=10000):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(Error("deadline")),ms);})]);}finally{clearTimeout(timer);}};
function check(v:unknown,m:string):asserts v {if(!v)throw Error(m);}
async function line(){for(;;){const i=buf.indexOf("\n");if(i>=0){const s=buf.slice(0,i);buf=buf.slice(i+1);return s;}const r=await reader!.read();if(r.done)throw Error("server stdout ended");buf+=new TextDecoder().decode(r.value,{stream:true});}}
const result:Record<string,unknown>={transport,capabilityInjected:true,replySource:"source-derived literal"};
let retired:any,exit:number|undefined,stderr="",eof=false,forced=false,configHash:string|undefined;
try{
 inputsBefore=inputs();
 const guid=randomBytes(16);result.applicationGuid=guid.toString("hex");
 udp=createSocket("udp4");
 await bounded(new Promise<void>((ok,no)=>{udp!.once("error",no);udp!.bind(0,"127.0.0.1",ok);}));
 const udpPort=udp.address().port;
 writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],gateway:{
  nativeUdpHelperPath:udpHelper,routes:[{host:"127.0.0.1",address:"192.0.2.1",ports:[udpPort],protocols:["udp"]}],
  tcpListeners:[{id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.1"],maxPending:8}]
 }}));configHash=hash(config);
 server=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 stderrP=new Response(server.stderr).text();reader=server.stdout.getReader();
 const hello=JSON.parse(await bounded(line()));check(hello.service==="bottleship-lan"&&hello.port>0,"bad ready");
 root=new RootNetworkNamespace(new LanNetwork(),16,36300);
 await bounded(root.configure({serverUrl:"http://127.0.0.1:"+hello.port,room:"dp4-rust-"+transport,winsock:{provider:"native",hostListener:"game"}}));
 const internal=root as any,link=internal.active.link;
 check(link.socket.io.engine.transport.name===transport,"wrong transport");
 check(internal.backplane.tcpHostListenV1===undefined,"production capability unexpectedly advertised");
 internal.backplane.configureTcpHosts({listeners:[{id:"game",allowedNodes:[[2,1,127,0,0,1]]}]});internal.state(internal.snapshot());
 const received=bounded(once(udp,"message"));void received.catch(()=>{});
 const child=root.createChild(36301);lease=child;worker=new Worker(new URL("./directplay4-rust-worker.ts",import.meta.url).href,{type:"module"});
 const response=bounded(new Promise<any>((ok,no)=>{worker!.onmessage=({data})=>data.error?no(Error(data.error)):ok(data.result);worker!.onerror=e=>no(Error(e.message));}));void response.catch(()=>{});
 worker.postMessage({id:1,boot:child.boot,port:udpPort,applicationGuid:[...guid]},[child.boot.port]);
 const [packet,rinfo]=await received;writeFileSync(join(output,"request.bin"),packet);result.request={hex:packet.toString("hex"),rinfo,sha256:hash(join(output,"request.bin"))};
 check(rinfo.address==="127.0.0.1"&&rinfo.family==="IPv4"&&rinfo.port>0,"unexpected UDP source");
 check(packet.length===52,"invalid UDP request length");
 const port=packet.readUInt16BE(6);check(port>0,"invalid advertised port");
 // Independent NT5 source-layout literal: only the return port and per-run GUID vary.
 const expected=Buffer.from("3400b0fa020000007f0000010000000000000000706c617902000d00000000000000000000000000000000000000000000000000","hex");
 expected.writeUInt16BE(port,6);guid.copy(expected,28);
 writeFileSync(join(output,"request-expected.bin"),expected);result.expectedRequestSha256=hash(join(output,"request-expected.bin"));
 check(packet.equals(expected),"UDP request differs from source-layout literal");
 peer=createConnection({host:"127.0.0.1",port});await bounded(once(peer,"connect"));
 const reply=Buffer.from("7600b0fa020008fcc00002010000000000000000"+"706c617901000b005000000000200000000102030405060708090a0b0c0d0e0f"+"101112131415161718191a1b1c1d1e1f08000000030000000000000000000000"+"0403020188776655010000000200000003000000040000005c000000410016040000","hex");
 guid.copy(reply,52);writeFileSync(join(output,"reply.bin"),reply);result.replyWire={hex:reply.toString("hex"),sha256:hash(join(output,"reply.bin"))};
 peer.write(reply.subarray(0,40));peer.end(reply.subarray(40));
 const replies=await response;check(replies.length===1&&replies[0].name==="AЖ","reply mismatch");
 check(replies[0].applicationGuid.join(",")===[...guid].join(","),"wrong reply GUID");
 result.reply=replies[0];result.advertisedPort=port;result.childProcess={pid:child.boot.pid,slot:child.boot.slot,epoch:child.boot.epoch};
}catch(e){failed=e;}
finally{
 const cleanup:Record<string,string>={};
 const attempt=async(name:string,fn:()=>void|Promise<void>)=>{try{await fn();cleanup[name]="ok";}catch(e){cleanup[name]=String(e);failed??=e;}};
 await attempt("peer",()=>{peer?.destroy();});
 await attempt("worker",async()=>{if(worker){const stopped=new Promise<void>(ok=>worker!.addEventListener("close",()=>ok(),{once:true}));worker.terminate();await bounded(stopped);}});
 await attempt("lease",()=>{lease?.close();});
 await attempt("root",()=>bounded(root?.close()??Promise.resolve()));
 await attempt("udp",async()=>{if(udp)await bounded(new Promise<void>(ok=>{try{udp!.close(()=>ok());}catch(e){if((e as NodeJS.ErrnoException).code==="ERR_SOCKET_DGRAM_NOT_RUNNING")ok();else throw e;}}));});
 if(server){
  await attempt("serverShutdown",()=>{server!.stdin.write("shutdown\n");server!.stdin.end();});
  try{retired=JSON.parse(await bounded(line()));exit=await bounded(server.exited);const r=await bounded(reader!.read());eof=r.done&&buf.length===0;stderr=await bounded(stderrP!);check(retired?.explicit&&retired?.retired&&exit===0&&eof,"server cleanup failed");cleanup.server="ok";}
  catch(e){cleanup.server=String(e);failed??=e;forced=true;await attempt("serverKill",async()=>{server!.kill();exit=await bounded(server!.exited);stderr=await bounded(stderrP!);});}
 }
 result.cleanup=cleanup;
 await attempt("inputHashes",()=>{inputsAfter=inputs();if(JSON.stringify(inputsBefore)!==JSON.stringify(inputsAfter))throw Error("inputs changed during run");});
 writeFileSync(join(output,"result.json"),JSON.stringify({result,retired,exit,stderr,eof,forced,inputsBefore,inputsAfter,config:configHash,error:failed?String(failed):null},null,2));
}
if(failed)throw failed;
console.log(JSON.stringify(result));
