import {createSocket,type Socket}from"node:dgram";
import{createHash}from"node:crypto";
import{readFileSync,writeFileSync,mkdirSync,readdirSync,statSync,copyFileSync,existsSync}from"node:fs";
import{resolve,join,relative}from"node:path";
import{fileURLToPath}from"node:url";
import{LanNetwork}from"../../src/worker/net/lan-network";
import{PROTO_UDP,decodeDatagram,encodeDatagram,ipv4ToNode}from"../../src/worker/net/netplay-wire";
import{NativeDirectPlayHost}from"../../src/worker/modules/dpnet/native-wire/host";

const cli=new Map<string,string>(),args=process.argv.slice(2);
if(args.includes("--help")){console.log("Usage: bun tools/lan-conformance/interop-directplay8-native-host.ts --proof <immutable native baseline directory> --output <NEW interop directory>");process.exit(0);}
for(let i=0;i<args.length;i+=2){
 const name=args[i],value=args[i+1];
 if(!["--proof","--output"].includes(name)||!value||value.startsWith("--")||cli.has(name))throw Error("Usage: bun tools/lan-conformance/interop-directplay8-native-host.ts --proof <immutable native baseline directory> --output <NEW interop directory>");
 cli.set(name,value);
}
for(const name of ["--proof","--output"])if(!cli.has(name))throw Error("Usage: bun tools/lan-conformance/interop-directplay8-native-host.ts --proof <immutable native baseline directory> --output <NEW interop directory>");

const script=fileURLToPath(import.meta.url),base=resolve(cli.get("--proof")!);
const original=JSON.parse(readFileSync(join(base,"verified.json"),"utf8"));
if(original.status!=="passed")throw Error("Native baseline was not verified");
const root=resolve(cli.get("--output")!);
if(existsSync(root))throw Error("Output directory already exists; immutable evidence is never overwritten");
mkdirSync(root,{recursive:true});copyFileSync(script,join(root,"interop-runner.ts"));
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const fileSha=(p:string)=>sha(readFileSync(p));
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+"\n");
const nonce:number=original.nonce,ports:number[]=original.ports,exe=join(base,"host-oracle.exe");
if(fileSha(exe)!==original.exeSha256)throw Error("Original PE changed");
const fingerprint={
host:fileSha("src/worker/modules/dpnet/native-wire/host.ts"),port:fileSha("src/worker/modules/dpnet/native-wire/port.ts"),
constants:fileSha("src/worker/modules/dpnet/constants.ts"),runner:fileSha(script)};
const sourcePaths=[...readdirSync("src/worker/modules/dpnet/native-wire").filter(n=>n.endsWith(".ts")).map(n=>"src/worker/modules/dpnet/native-wire/"+n),
 "src/worker/net/lan-network.ts","src/worker/net/netplay-wire.ts","src/worker/modules/dpnet/constants.ts","src/worker/modules/dpnet/backend.ts","src/worker/modules/dplayx/session.ts"].sort();
const sourceBefore=sourcePaths.map(path=>({path,sha256:fileSha(path)}));save(join(root,"source-map-before.json"),sourceBefore);
const referenceBefore=["verified.json","host-oracle.exe","accept/peer/lan-oracle.bin","reject/peer/lan-oracle.bin"].map(path=>({path,sha256:fileSha(join(base,path))}));
const core=original.accepted.records[0].messages.find((m:any)=>m.command===0xc2).c2;
const nativeNode=ipv4ToNode(Uint8Array.of(127,0,0,1),true),events:unknown[]=[];
const note=(kind:string,value:unknown=null)=>{events.push({at:new Date().toISOString(),kind,value});save(join(root,"progress.json"),events);};
async function portCleanup(){const results=[];for(const port of ports){const s=createSocket("udp4");try{await new Promise<void>((ok,no)=>{s.once("error",no);s.bind(port,"127.0.0.1",ok);});results.push({port,available:true});}finally{try{await new Promise<void>(ok=>s.close(()=>ok()));}catch{}}}return results;}
async function phase(reject:boolean){
 const name=reject?"reject":"accept",folder=join(root,name);mkdirSync(folder);mkdirSync(join(folder,"peer"));mkdirSync(join(folder,"packets"));
 const network=new LanNetwork(Uint8Array.of(2,0,0,28,0,1)),host=new NativeDirectPlayHost(network);
 const packets:unknown[]=[],callbackEvents:unknown[]=[],received:Uint8Array[]=[];
 const deadline=Date.now()+45000;let stopped=false,failure:string|null=null,queued=0,proc:ReturnType<typeof Bun.spawn>|undefined,exit:number|null=null,forced=false,logs:Promise<void>|undefined,socket:Socket|undefined;
 const capture=(direction:string,port:number,bytes:Uint8Array)=>{
  if(packets.length>=1024||bytes.length>4096){failure="Capture quota exceeded";return;}
  const path="packets/"+packets.length+".bin";writeFileSync(join(folder,path),bytes);packets.push({direction,localPort:ports[0],remotePort:port,path,bytes:bytes.length,sha256:sha(bytes)});
 };
 const marked=(file:string)=>{try{const b=readFileSync(join(folder,"peer",file));return b.length===4&&b.readUInt32LE()===nonce;}catch{return false;}};
 const mark=(file:string)=>{const b=Buffer.alloc(4);b.writeUInt32LE(nonce);writeFileSync(join(folder,"peer",file),b);note(name+":marker",file);};
 const wait=async(check:()=>boolean,label:string,milliseconds=10000,allowExit=false)=>{
  const end=Math.min(deadline,Date.now()+milliseconds);
  while(!check()){
   if(failure)throw Error(failure);if(exit!==null&&!allowExit)throw Error(label+": native peer exited "+exit);
   if(Date.now()>=end)throw Error(label+" deadline");await Bun.sleep(5);
  }note(name+":"+label);
 };
 let result:unknown;
 try{
  socket=createSocket("udp4");socket.on("error",e=>{failure=String(e);});
  await new Promise<void>((ok,no)=>{socket!.once("error",no);socket!.bind(ports[0],"127.0.0.1",ok);});
  const physical=socket.address();if(physical.address!=="127.0.0.1"||physical.port!==ports[0])throw Error("Wrong physical Host binding");
  network.configureGatewayAddresses([[127,0,0,1]]);
  socket.on("message",(bytes,remote)=>{
   if(stopped)return;capture("in",remote.port,bytes);
   if(remote.address!=="127.0.0.1"||remote.port!==ports[1]){failure="Unapproved incoming source";return;}
   network.receiveFrame(encodeDatagram(PROTO_UDP,nativeNode,ports[0],remote.port,bytes));
  });
  network.attach({send(raw){
   const d=decodeDatagram(raw);if(stopped||!d||d.proto!==PROTO_UDP||d.srcPort!==ports[0]||d.dstPort!==ports[1]||d.node.some((n,i)=>n!==nativeNode[i])||queued>=64)return false;
   capture("out",d.dstPort,d.payload);if(failure)return false;queued++;
   socket!.send(d.payload,d.dstPort,"127.0.0.1",error=>{queued--;if(error)failure=String(error);network.notifyWritable();});return true;
  },close(){}});
  host.onChange=()=>{callbackEvents.push({event:"change",players:host.currentPlayers,ids:[...host.entities.keys()]});};
  host.onMessage=id=>{while(host.queue.length){const m=host.queue[0];received.push(m.data.slice());host.removeMessage(0);m.processed?.();}callbackEvents.push({event:"receive",id});};
  const hr=host.start({port:ports[0],application:core.application,player:{name:"stage28-host",data:new Uint8Array()},timeout:6000,retryInterval:100,
   url:address=>"x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0.1;port="+address.port,
   allowIncoming:a=>a.port===ports[1]&&a.node.every((n,i)=>n===nativeNode[i]),
   admit:request=>{
    callbackEvents.push({event:"indicate",players:host.currentPlayers,address:request.address,info:{...request.info,data:Array.from(request.info.data),connectData:Array.from(request.info.connectData),alternate:Array.from(request.info.alternate)}});
    const reply=Uint8Array.of(0x52,Number(reject),nonce&255,(nonce>>>8)&255,0x61,0x62,0x63,0);
    return{hr:reject?0x80004005:0,data:reply,context:0x7201,release(){callbackEvents.push({event:"ownership-released"});}};
   },
   replyReleased:decision=>{callbackEvents.push({event:"return-buffer",data:Array.from(decision.data??[])});decision.data?.fill(0xee);},
   accepted:(id,context)=>{callbackEvents.push({event:"create-remote",id,context});},
   aborted:context=>{callbackEvents.push({event:"aborted",context});}
  });
  note(name+":host-start",{hr,physical,local:host.localAddress});if(hr)throw Error("Bun Host start "+hr.toString(16));
  proc=Bun.spawn([exe,"--peer",...(reject?["--reject"]:[])],{cwd:join(folder,"peer"),stdout:"pipe",stderr:"pipe"});
  logs=Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]).then(([out,error])=>{writeFileSync(join(folder,"peer/stdout.txt"),out);writeFileSync(join(folder,"peer/stderr.txt"),error);});
  const pid=proc.pid;void proc.exited.then(code=>{exit=code;note(name+":peer-exit",{pid,code});});note(name+":peer-start",{pid});
  await wait(()=>marked("peer-admission-done.bin"),"native-admission-complete",15000);
  if(!reject){
   await wait(()=>marked("exchange-ready.bin")&&host.currentPlayers===2,"native-exchange-ready");
   mark("send-go.bin");const id=[...host.entities.keys()].find(id=>id!==host.localId)!;
   const sent=await host.sendDpn(id,8,Uint8Array.of(0x48,0,0x28,0x7a));note(name+":host-send",sent);if(sent)throw Error("Host guaranteed send "+sent.toString(16));
   await wait(()=>marked("exchange-done.bin")&&received.length===1,"both-directions-received");
   if(Buffer.from(received[0]).toString("hex")!=="4801287a")throw Error("Bun Host payload mismatch");
  }
  mark("peer-close-go.bin");await wait(()=>exit!==null,"native-peer-finished",8000,true);
  if(exit!==0)throw Error("Native Peer failed "+exit);await logs;
  const closed=await host.shutdown();note(name+":host-shutdown",closed);if(closed)throw Error("Bun Host shutdown "+closed.toString(16));
  await wait(()=>queued===0,"udp-send-callbacks-drained",3000,true);
  const ref=readFileSync(join(base,name,"peer/lan-oracle.bin")),actual=readFileSync(join(folder,"peer/lan-oracle.bin"));
  const differences=[];
  if(ref.length%4||actual.length%4)throw Error("Unaligned oracle record");
  for(let off=0;off<Math.max(ref.length,actual.length);off+=4){
   const native=off<ref.length?ref.readUInt32LE(off):null,guest=off<actual.length?actual.readUInt32LE(off):null;
   if(native!==guest)differences.push({word:off/4,native,hostBackend:guest});
  }
  const comparison={sameExecutableSha256:fileSha(exe),reference:join(base,name,"peer/lan-oracle.bin"),referenceSha256:sha(ref),actualSha256:sha(actual),observations:(ref.length/4-3)/2,differences};
  save(join(folder,"comparison.json"),comparison);
  if(differences.length)throw Error("Native Peer result differs with Bun Host");
  if(failure)throw Error(failure);
  result={status:"passed",name,nonce,ports,nativePid:pid,nativeExit:exit,physicalHostEndpoint:physical,hostSource:fingerprint,comparison,packets:packets.length,callbackEvents};
  save(join(folder,"verified.json"),result);return result;
 }catch(error){failure=String(error);note(name+":failure",failure);throw error;}
 finally{
  if(proc&&exit===null){try{mark("peer-close-go.bin");mark("send-go.bin");}catch{}const end=Date.now()+3000;while(exit===null&&Date.now()<end)await Bun.sleep(10);if(exit===null){forced=true;proc.kill();}await proc.exited;if(logs)await logs;}
  host.dispose();stopped=true;network.attach(null);
  if(socket)try{await new Promise<void>(ok=>socket!.close(()=>ok()));}catch{}
  let cleanup:unknown;try{cleanup=await portCleanup();}catch(error){cleanup={error:String(error)};}
  save(join(folder,"packets.json"),packets);save(join(folder,"callbacks.json"),callbackEvents);
  save(join(folder,"result.json"),{failure,nativePid:proc?.pid,nativeExit:exit,forced,queued,cleanup});
 }
}
try{
 const accepted=await phase(false),rejected=await phase(true);
 const walk=(dir:string):string[]=>readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?walk(p):[p];}).sort();
 const sourceAfter=sourcePaths.map(path=>({path,sha256:fileSha(path)}));save(join(root,"source-map-after.json"),sourceAfter);
 const referenceAfter=referenceBefore.map(({path})=>({path,sha256:fileSha(join(base,path))}));
 if(JSON.stringify(sourceBefore)!==JSON.stringify(sourceAfter)||JSON.stringify(referenceBefore)!==JSON.stringify(referenceAfter))throw Error("Source or immutable PE/reference changed during actual proof");
 const report={status:"passed",root,nonce,ports,fingerprint,sourceGuard:{unchanged:true,files:sourceBefore},referenceGuard:{unchanged:true,files:referenceBefore},nativeProof:fileSha(join(base,"verified.json")),accepted,rejected,files:walk(root).map(path=>({path:relative(root,path),sha256:fileSha(path)}))};
 save(join(root,"verified.json"),report);console.log(JSON.stringify({status:"passed",root,nonce,ports,sha256:fileSha(join(root,"verified.json"))}));
}catch(error){save(join(root,"failure.json"),{status:"failed",root,nonce,ports,error:String(error),fingerprint});console.error(JSON.stringify({status:"failed",root,error:String(error)}));process.exitCode=1;}
