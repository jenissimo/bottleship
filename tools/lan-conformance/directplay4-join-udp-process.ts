/** Owned real Rust relay + Root/Child + WSA actor UDP host seam; no capability injection. */
import {createSocket} from "node:dgram";
import {networkInterfaces} from "node:os";
import {once} from "node:events";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {createHash,randomBytes} from "node:crypto";
import {resolve,join} from "node:path";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {WSA} from "../../src/worker/modules/wsa-network";
const [binary,output,transport,host]=process.argv.slice(2);
const octets=host?.split(".").map(Number)??[];
if(octets.length!==4||octets.some(n=>!Number.isInteger(n)||n<0||n>255)||octets[0]===127||!Object.values(networkInterfaces()).flat().some(x=>x?.family==="IPv4"&&x.address===host&&!x.internal))throw Error("host must be a local non-loopback IPv4");
const allowed=JSON.stringify([[2,1,...octets]]);
if(!binary||!output||!["websocket","polling"].includes(transport)||process.argv.length!==6)throw Error("usage: <relay> <new dir> <transport>");
mkdirSync(output,{recursive:false});
const runtime=["src/worker/modules/dplayx/native-wire/join-udp-listener.ts","src/worker/modules/wsa-network.ts","src/worker/modules/wsa-actor-kernel.ts","src/worker/modules/wsa-actor-table.ts","src/worker/modules/wsa-actor-worker.ts","src/worker/core/network-namespace.ts","src/worker/net/lan-network.ts","src/worker/net/relay-link.ts"];
const workerPath=resolve("tools/lan-conformance/directplay4-join-udp-process-worker.ts");
const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes=()=>({binary:hash(binary),runner:hash(import.meta.filename),worker:hash(workerPath),runtime:Object.fromEntries(runtime.map(p=>[p,hash(p)]))});
const bounded=async<T>(p:Promise<T>,ms=10000):Promise<T>=>{let t:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,no)=>t=setTimeout(()=>no(Error("deadline")),ms))]);}finally{clearTimeout(t);}};
function check(v:unknown,m:string):asserts v{if(!v)throw Error(m);}
async function rebind(port:number){const end=Date.now()+10000;for(;;){const s=createSocket("udp4");try{await bounded(new Promise<void>((ok,no)=>{s.once("error",no);s.bind({address:host,port,exclusive:true},()=>ok());}));await new Promise<void>(ok=>s.close(()=>ok()));return;}catch(e){try{s.close();}catch{}if((e as NodeJS.ErrnoException).code!=="EADDRINUSE"||Date.now()>end)throw e;await new Promise(ok=>setTimeout(ok,20));}}}
let server:ReturnType<typeof Bun.spawn>|undefined,root:RootNetworkNamespace|undefined,worker:Worker|undefined,lease:{close():void}|undefined,peer:ReturnType<typeof createSocket>|undefined;
let reader:ReadableStreamDefaultReader<Uint8Array>|undefined, stderr:Promise<string>|undefined, buffer="",port=0,failed:unknown,before:any,after:any,retired:any,exit:number|undefined,eof=false,forced=false;
const result:Record<string,unknown>={transport,host,capabilityInjected:false};
async function line(){for(;;){const i=buffer.indexOf("\n");if(i>=0){const s=buffer.slice(0,i);buffer=buffer.slice(i+1);return s;}const r=await reader!.read();if(r.done)throw Error("relay stdout ended");buffer+=new TextDecoder().decode(r.value,{stream:true});}}
try{
 before=hashes();const config=resolve(join(output,"config.json"));
 writeFileSync(config,JSON.stringify({host:"127.0.0.1",transports:[transport],gateway:{udpListeners:[{id:"udp",bindHost:host,advertisedHost:host,port:0,allowedHosts:[host],maxOwners:1,maxPeers:2,idleTimeoutMs:60000}]}}));result.configSha256=hash(config);
 server=Bun.spawn([resolve(binary),"--config",config],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});reader=server.stdout.getReader();stderr=new Response(server.stderr).text();
 const hello=JSON.parse(await bounded(line(),15000));check(hello.service==="bottleship-lan"&&hello.port>0,"bad relay READY");
 root=new RootNetworkNamespace(new LanNetwork(),16,36900);
 await bounded(root.configure({serverUrl:"http://127.0.0.1:"+hello.port,room:"udp-actor-"+randomBytes(8).toString("hex")}));
 const internal=root as any,link=internal.active.link;
 check(link.socket.io.engine.transport.name===transport,"unexpected transport");
 const capability=internal.backplane.udpHostListenV1;
 check(capability?.listeners?.length===1&&capability.listeners[0].id==="udp"&&JSON.stringify(capability.listeners[0].allowedNodes)===allowed,"missing exact public capability");result.capability=capability;
 const child=root.createChild(36901);lease=child;result.child={pid:child.boot.pid,slot:child.boot.slot,epoch:child.boot.epoch};
 worker=new Worker(new URL("./directplay4-join-udp-process-worker.ts",import.meta.url).href,{type:"module"});
 let seq=0;const pending=new Map<number,{ok:(v:any)=>void;no:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
 worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);clearTimeout(p.timer);data.error!==undefined?p.no(data.error):p.ok(data.result);};
 const request=(payload:object,ports:MessagePort[]=[])=>new Promise<any>((ok,no)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);no(Error("worker deadline"));},10000);pending.set(id,{ok,no,timer});worker!.postMessage({id,...payload},ports);});
 await request({boot:child.boot},[child.boot.port]);
 const opened=await request({command:"open"});port=opened.address.port;
 check(opened.current&&opened.physical===opened.fileId&&opened.binding>0&&port>0&&JSON.stringify(opened.allowedNodes)===allowed,"invalid exact ownership");result.opened=opened;
 peer=createSocket("udp4");await bounded(new Promise<void>((ok,no)=>{peer!.once("error",no);peer!.bind(0,host,()=>ok());}));const peerPort=(peer.address() as {port:number}).port;
 const inbound=Buffer.from("owned-native-to-actor");await bounded(new Promise<void>((ok,no)=>peer!.send(inbound,port,host,e=>e?no(e):ok())));
 const deadline=Date.now()+10000;let received:any;for(;;){try{received=await request({command:"receive"});break;}catch(e){if(e!==WSA.EWOULDBLOCK||Date.now()>deadline)throw e;await new Promise(ok=>setTimeout(ok,10));}}
 check(Buffer.from(received.data).equals(inbound)&&received.from.port===peerPort,"wrong incoming datagram");result.nativeToActor=received;
 const outbound=Buffer.from("actor-to-owned-native"),got=bounded(once(peer,"message"));void got.catch(()=>{});
 check(await request({command:"send",bytes:[...outbound],port:peerPort,ip:octets})===outbound.length,"actor send failed");
 const [message,info]=await got;check(Buffer.from(message).equals(outbound)&&info.port===port&&info.address===host,"wrong outgoing datagram or source");
 result.actorToNative={hex:Buffer.from(message).toString("hex"),address:info.address,port:info.port,peerPort};
 check(await request({command:"release"})===false,"listener remains current");await rebind(port);result.reboundBeforeRelayShutdown=true;
 await request({command:"finish"});
}catch(e){failed=e;}
finally{
 const cleanup:Record<string,string>={};const attempt=async(name:string,fn:()=>void|Promise<void>)=>{try{await fn();cleanup[name]="ok";}catch(e){cleanup[name]=String(e);failed??=e;}};
 await attempt("peer",async()=>{if(peer)await bounded(new Promise<void>(ok=>peer!.close(()=>ok())));});
 await attempt("worker",async()=>{if(worker){const done=new Promise<void>(ok=>worker!.addEventListener("close",()=>ok(),{once:true}));worker.terminate();await bounded(done);}});
 await attempt("lease",()=>lease?.close());
 await attempt("listenerRebind",async()=>{if(port)await rebind(port);});
 await attempt("root",()=>bounded(root?.close()??Promise.resolve()));
 if(server){await attempt("shutdown",()=>{server!.stdin.write("shutdown\n");server!.stdin.end();});try{retired=JSON.parse(await bounded(line()));exit=await bounded(server.exited);eof=(await bounded(reader!.read())).done&&buffer.length===0;result.stderr=await bounded(stderr!);check(retired?.retired&&retired?.explicit&&exit===0&&eof,"relay cleanup");cleanup.relay="ok";}catch(e){failed??=e;forced=true;await attempt("kill",async()=>{server!.kill();exit=await bounded(server!.exited);result.stderr=await bounded(stderr!);});}}
 await attempt("hashes",()=>{after=hashes();check(JSON.stringify(before)===JSON.stringify(after),"input changed");});
 result.cleanup=cleanup;writeFileSync(join(output,"result.json"),JSON.stringify({result,retired,exit,eof,forced,before,after,error:failed?String(failed):null},null,2));
}
if(failed)throw failed;console.log(JSON.stringify(result));
