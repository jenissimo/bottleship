import {createSocket,type Socket} from "node:dgram";
import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync,copyFileSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {createLanServer,type LanServer} from "../../packages/lan/src/server";
import {RelayLink} from "../../src/worker/net/relay-link";
import {buildBoundUdpHelper} from "./build-bound-udp-helper";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {decodeDatagram,encodeDatagram,ipv4ToNode,PROTO_UDP} from "../../src/worker/net/netplay-wire";
import {NativeDirectPlayCore} from "../../src/worker/modules/dpnet/native-wire/core";
import {decodeNativeProtocolFrame,DN} from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import {NativeReceiveWindow} from "../../src/worker/modules/dpnet/native-wire/receive-window";
import {decodeNativeCoreConnectInfo} from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
if(process.platform!=="win32")throw Error("Two native Windows processes required");
const coreRole=process.argv.includes("--core-role=1")?1:2,nativeRole=3-coreRole;
const relayMode=process.argv.includes("--websocket")?"websocket":process.argv.includes("--polling")?"polling":null,helper=process.argv.includes("--helper");
const nonce=Date.now()>>>0,root=resolve("logs/lan-conformance/directplay8-core-mesh",String(nonce)+(relayMode?"-"+relayMode+(helper?"-helper":"-node"):"-dgram")+(coreRole===1?"-existing":""));
mkdirSync(root,{recursive:true});mkdirSync(join(root,"packets"));mkdirSync(join(root,"inbound"));
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const save=(name:string,value:unknown)=>writeFileSync(join(root,name),JSON.stringify(value,null,2)+"\n");
const events:unknown[]=[],note=(kind:string,value:unknown=null)=>{events.push({at:new Date().toISOString(),kind,value});save("progress.json",events);};
const reserved:Socket[]=[],children:{role:number;pid:number;cwd:string;proc:ReturnType<typeof Bun.spawn>;exit:number|null;output:Promise<void>}[]=[];
const packets:{source:number;target:number;port:number;destination:number;bytes:Uint8Array;socket:number}[]=[];
const ports:number[]=[],deadline=Date.now()+35000;
let relay:RelayLink|undefined,server:LanServer|undefined;
let socket:Socket|undefined,network:LanNetwork|undefined,core:NativeDirectPlayCore|undefined,stopped=false,failure:string|null=null,queued=0;
const allowed=new Map<number,number>(),leaseEvents:unknown[]=[],inbound:unknown[]=[];
const compiler="C:/msys64/mingw32/bin/gcc.exe",exe=join(root,"mesh.exe"),env={...process.env};
for(const key of Object.keys(env))if(key.toLowerCase()==="path")delete env[key];
env.Path=dirname(compiler)+";"+(process.env.Path??process.env.PATH??"");
const words=(path:string)=>{const b=readFileSync(path);if(b.length%4)throw Error("Unaligned record");return Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));};
const mark=(child:typeof children[number],name:string)=>{const b=Buffer.alloc(4);b.writeUInt32LE(nonce);writeFileSync(join(child.cwd,name),b);};
const marked=(child:typeof children[number],name:string)=>{try{const b=readFileSync(join(child.cwd,name));return b.length===4&&b.readUInt32LE()===nonce;}catch{return false;}};
async function wait(check:()=>boolean,label:string,milliseconds=8000){
 const end=Math.min(deadline,Date.now()+milliseconds);
 while(!check()){const dead=children.find(c=>c.exit!==null);if(dead)throw Error(label+": role"+dead.role+" exit"+dead.exit);if(failure)throw Error(failure);if(Date.now()>end)throw Error(label+" timeout");await Bun.sleep(2);}note(label);
}
function capture(source:number,target:number,port:number,destination:number,bytes:Uint8Array,physicalSocket=0){
 if(packets.length>=1024||bytes.length>4096)throw Error("Wire capture quota exceeded");writeFileSync(join(root,"packets/"+packets.length+".bin"),bytes);packets.push({source,target,port,destination,bytes:bytes.slice(),socket:physicalSocket});
}
function start(role:number){
 const cwd=join(root,["host","peer1","peer2"][role]);mkdirSync(cwd);
 const proc=Bun.spawn([exe,"--"+["host","peer1","peer2"][role]],{cwd,env,stdout:"pipe",stderr:"pipe"});
 const child={role,pid:proc.pid,cwd,proc,exit:null as number|null,output:Promise.resolve()};
 child.output=Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]).then(([out,error])=>{writeFileSync(join(cwd,"stdout.txt"),out);writeFileSync(join(cwd,"stderr.txt"),error);});
 void proc.exited.then(code=>{child.exit=code;note("exit",{role,pid:child.pid,code});});children.push(child);note("spawn",{role,pid:child.pid});return child;
}
try{
 note("begin",{nonce,source:sha(readFileSync("tools/lan-conformance/directplay8-core-mesh.c"))});
 for(let attempt=0;attempt<32&&!ports.length;attempt++){
  try{const first=createSocket("udp4");reserved.push(first);await new Promise<void>((ok,no)=>{first.once("error",no);first.bind(0,"127.0.0.1",ok);});
   const base=first.address().port;if(base>65533)throw Error("Port range");
   for(const port of [base+1,base+2]){const s=createSocket("udp4");reserved.push(s);await new Promise<void>((ok,no)=>{s.once("error",no);s.bind(port,"127.0.0.1",ok);});}
   ports.push(base,base+1,base+2);
  }catch{for(const s of reserved.splice(0)){try{s.close();}catch{}}}
 }
 if(!ports.length)throw Error("No loopback port range");
 const argv=[compiler,"-O1","-Wall","-Wextra","-Werror","-Wno-misleading-indentation","-nostdlib","-fno-builtin","-fno-stack-protector","-DORACLE_NONCE="+nonce,"-DORACLE_HOST_PORT="+ports[0],"-Wl,--entry,_entry","-Wl,--subsystem,console","-o",exe,"tools/lan-conformance/directplay8-core-mesh.c","-lkernel32","-lole32","-ldxguid","-luuid","-lws2_32"];
 const build=Bun.spawnSync(argv,{env,stdout:"pipe",stderr:"pipe"});writeFileSync(join(root,"compiler.stdout.txt"),build.stdout);writeFileSync(join(root,"compiler.stderr.txt"),build.stderr);save("build.json",{nonce,ports,argv,exit:build.exitCode});
 if(build.exitCode)throw Error(new TextDecoder().decode(build.stderr));copyFileSync("tools/lan-conformance/directplay8-core-mesh.c",join(root,"fixture.c"));note("built",{sha:sha(readFileSync(exe)),ports});
 for(const s of reserved.splice(0))await new Promise<void>(ok=>s.close(()=>ok()));
 const host=start(0);await wait(()=>marked(host,"mesh-ready.bin"),"native-host-ready");
 let counterpart:typeof children[number]|undefined;
 if(coreRole===2){counterpart=start(1);await wait(()=>marked(counterpart!,"mesh-ready.bin"),"native-peer1-ready");}
 network=new LanNetwork(Uint8Array.of(2,0,0,73,27,2));
 const nativePorts=[ports[0],ports[nativeRole]];
 const nativeNode=ipv4ToNode(Uint8Array.of(127,0,0,1),true);
 if(relayMode){
  server=createLanServer({host:"127.0.0.1",port:0,gateway:{...(helper?{nativeUdpHelperPath:await buildBoundUdpHelper()}:{}),routes:[{host:"127.0.0.1",address:"127.0.0.1",ports:nativePorts,protocols:["udp"]}]}});
  const relayPort=await server.listen();
  relay=new RelayLink("http://127.0.0.1:"+relayPort,"native-mesh-"+nonce,network,{transports:[relayMode]});network.attach(relay);await relay.ready;
  relay.socket.on("udpPeerLeased",(id,reply)=>leaseEvents.push({kind:"native-ready-ack",id,reply}));
  const transport=relay,send=transport.send.bind(transport);
  transport.send=(raw,generation)=>{const d=decodeDatagram(raw);if(d)capture(coreRole,ports.indexOf(d.dstPort),d.srcPort,d.dstPort,d.payload);return send(raw,generation);};
  note("relay-ready",{url:"http://127.0.0.1:"+relayPort,transport:relay.socket.io.engine.transport.name,helper,routes:[{address:"127.0.0.1",ports:nativePorts}]});
 }else{
 socket=createSocket("udp4");socket.on("error",e=>{failure=String(e);note("udp-error",failure);});
 await new Promise<void>((ok,no)=>{socket!.once("error",no);socket!.bind(ports[coreRole],"127.0.0.1",ok);});
 network!.configureGatewayAddresses([[127,0,0,1]]);allowed.set(ports[0],1);
 socket.on("message",(bytes,remote)=>{
  if(stopped)return;
  if(inbound.length>=1024||bytes.length>4096){failure="Inbound capture quota";return;}
  const path="inbound/"+inbound.length+".bin";writeFileSync(join(root,path),bytes);inbound.push({port:remote.port,address:remote.address,path,approved:allowed.has(remote.port)});
  if(remote.address!=="127.0.0.1"||!allowed.has(remote.port)){note("rejected-inbound",{remote:remote.address,port:remote.port,bytes:bytes.length});return;}
  network!.receiveFrame(encodeDatagram(PROTO_UDP,nativeNode,ports[coreRole],remote.port,bytes));
 });
 network.attach({send(raw){
  const d=decodeDatagram(raw);if(stopped||!d||d.proto!==PROTO_UDP||d.srcPort!==ports[coreRole]||d.node.some((v,i)=>v!==nativeNode[i])||!allowed.has(d.dstPort)||queued>=64)return false;
  capture(coreRole,ports.indexOf(d.dstPort),socket!.address().port,d.dstPort,d.payload);queued++;
  socket!.send(d.payload,d.dstPort,"127.0.0.1",error=>{queued--;if(error){failure=String(error);note("udp-send-error",failure);}network?.notifyWritable();});return true;
 },close(){},async leaseUdpPeer(request,signal){
  if(signal?.aborted||request.proto!==PROTO_UDP||request.localPort!==ports[coreRole]||request.bindingGeneration!==network!.bindingGeneration(ports[coreRole],PROTO_UDP)||request.node.some((v,i)=>v!==nativeNode[i])||!nativePorts.includes(request.remotePort))throw Error("Unapproved native endpoint");
  if(socket!.address().port!==ports[coreRole])throw Error("Native port not listening");
  allowed.set(request.remotePort,(allowed.get(request.remotePort)??0)+1);leaseEvents.push({kind:"ready",port:request.remotePort,localPort:socket!.address().port});
  let released=false;return{release(){if(released)return;released=true;const count=(allowed.get(request.remotePort)??1)-1;if(count)allowed.set(request.remotePort,count);else allowed.delete(request.remotePort);leaseEvents.push({kind:"released",port:request.remotePort});}};
 }});

 }
 core=new NativeDirectPlayCore(network,"peer",6000,100,14);
 const application=Buffer.alloc(16);application.writeUInt32LE(nonce);application.writeUInt16LE(0x75e1,4);
 const hr=await core.connect({node:[...nativeNode],port:ports[0]},{instance:"0".repeat(32),application:application.toString("hex"),flags:0,maxPlayers:3,name:"",password:"",user:[0,0,0,0]},{name:{short:"peer"+coreRole,long:""},data:[],flags:0},new Uint8Array(),ports[coreRole]);
 note("core-connect",{hr,entities:[...core.entities.values()]});if(hr)throw Error("Core Connect "+hr.toString(16));
 if(coreRole===1){counterpart=start(2);await wait(()=>marked(counterpart!,"mesh-ready.bin"),"native-peer2-ready");}
 const old=counterpart!;
 await wait(()=>children.every(c=>marked(c,"mesh-full.bin"))&&core!.currentPlayers===3,"three-players-created");
 const ids=[core.hostId,...[1,2].map(role=>[...core!.entities.values()].find(e=>e.name.short==="peer"+role)!.id)];
 children.forEach(c=>mark(c,"mesh-go.bin"));
 const send=await core.sendDpn(ids[nativeRole],8,Uint8Array.of(0x4d,coreRole,0x37,coreRole^0x5a));note("core-send",{hr:send});if(send)throw Error("Core direct Send "+send.toString(16));
 await wait(()=>core!.queue.some(m=>m.from===ids[nativeRole]&&Buffer.from(m.data).toString("hex")===Buffer.from([0x4d,nativeRole,0x37,nativeRole^0x5a]).toString("hex")),"core-direct-receive");
 await wait(()=>children.every(c=>marked(c,"mesh-metrics.bin")),"native-direct-exchange");
 const coreRecord={ids,receives:core.queue.map(m=>({from:m.from,data:Buffer.from(m.data).toString("hex")})),leaseEvents};
 const closed=await core.shutdown();note("core-close",{hr:closed});if(closed)throw Error("Core Close "+closed.toString(16));
 for(const child of [old,host]){mark(child,"mesh-close.bin");const end=Date.now()+4000;while(child.exit===null&&Date.now()<end)await Bun.sleep(2);if(child.exit!==0)throw Error("Native Close role"+child.role+" exit"+child.exit);}
 await Promise.all(children.map(c=>c.output));
 let physicalPeerPort=relayMode?0:ports[coreRole];
 const records=children.map(child=>{
  const state=words(join(child.cwd,"mesh-state.bin")),observations=words(join(child.cwd,"lan-oracle.bin"));
  if(state.length!==18||state[0]!==0x42534d53||state[1]!==nonce||state[2]!==child.role||state[3]!==7||state[4]||state[5]||state.slice(9,15).some(n=>n!==1)||state.slice(6,9).some((id,i)=>id!==ids[i])||observations[0]!==0x42534c4e||observations[1]!==observations.length||observations[2]!==nonce||observations.at(-1)!==0)throw Error("Native state mismatch "+JSON.stringify(state));
  const queries=observations.slice(3).slice(-16,-10);
  const targets=[0,1,2].filter(role=>role!==child.role);
  for(let i=0;i<targets.length;i++){
   if(queries[i*3]||queries[i*3+1])throw Error("Native GetPeerAddress failed");
   const measured=queries[i*3+2];
   if(targets[i]===coreRole){if(!physicalPeerPort)physicalPeerPort=measured;if(!physicalPeerPort||measured!==physicalPeerPort)throw Error("Native participants disagree on external peer UDP port");}
   else if(measured!==ports[targets[i]])throw Error("Native endpoint port changed");
  }
  if(child.role&&state[15+coreRole]!==1)throw Error("Native peer did not receive BunCore payload");
  const raw=readFileSync(join(child.cwd,"mesh-wire.bin")),head=Array.from({length:9},(_,i)=>raw.readUInt32LE(i*4));
  if(head[0]!==0x42534d54||head[1]!==3||head[2]!==nonce||head[3]!==child.role||head[4]!==1||head[6]||head[7]!==27||head[8]!==4096||raw.length!==36+head[5]*4204)throw Error("Invalid native packet trace");
  for(let i=0;i<head[5];i++){const offset=36+i*4204,meta=Array.from({length:27},(_,n)=>raw.readUInt32LE(offset+n*4));if(meta[7]!==meta[8]||meta[13]!==2||meta[14]!==2||meta[5]!==0x0100007f||meta[4]!==ports[child.role]||!(nativePorts.includes(meta[6])||meta[6]===physicalPeerPort)||(meta[11]!==0&&meta[12]!==997))throw Error("Native UDP endpoint changed "+JSON.stringify(meta));capture(child.role,meta[6]===physicalPeerPort?coreRole:ports.indexOf(meta[6]),meta[4],meta[6],raw.subarray(offset+108,offset+108+meta[8]),meta[2]);}
  return{role:child.role,pid:child.pid,observations:observations.slice(3),state};
 });
 const flows=new Map<string,NativeReceiveWindow>(),messages:unknown[]=[];
 const wire=packets.map((p,index)=>{
  const name="packets/"+index+".bin";writeFileSync(join(root,name),p.bytes);const frame=decodeNativeProtocolFrame(p.bytes);
  if(frame?.kind==="data"){const key=p.source+":"+p.target,w=flows.get(key)??new NativeReceiveWindow();flows.set(key,w);for(const m of w.receive(frame).messages){const command=m.command&DN.USER1&&m.payload.length>=4?new DataView(m.payload.buffer).getUint32(0,true):undefined;messages.push({source:p.source,target:p.target,command,payload:Buffer.from(m.payload).toString("hex"),...(command===0xc2?{decoded:decodeNativeCoreConnectInfo(m.payload)}:{})});}}
  return{source:p.source,target:p.target,sourcePort:p.port,destinationPort:p.destination,socket:p.socket,path:name,sha:sha(p.bytes),frame};
 });
 for(const role of [0,1,2])if(new Set(wire.filter(p=>p.source===role).map(p=>p.socket)).size!==1)throw Error("Multiple physical sockets for role"+role);
 save("packets.json",wire);save("messages.json",messages);save("verified.json",{nonce,ports,physicalPeerPort,coreRole,relayMode,helper,records,core:coreRecord,packets:packets.length,messages:messages.length,sourceSha:sha(readFileSync("tools/lan-conformance/directplay8-core-mesh.c")),executableSha:sha(readFileSync(exe))});note("verified");
}catch(e){failure=String(e);note("failure",failure);process.exitCode=1;}
finally{
 core?.dispose();network?.attach(null);relay?.close();if(server)await server.close();stopped=true;
 if(socket){try{await new Promise<void>(ok=>socket!.close(()=>ok()));}catch{}}
 for(const s of reserved.splice(0)){try{s.close();}catch{}}
 for(const c of children)if(c.exit===null){try{mark(c,"mesh-go.bin");mark(c,"mesh-close.bin");}catch{}}
 const end=Math.min(deadline,Date.now()+15000);while(children.some(c=>c.exit===null)&&Date.now()<end)await Bun.sleep(5);
 for(const c of children)if(c.exit===null)c.proc.kill();await Promise.all(children.map(c=>c.proc.exited));await Promise.all(children.map(c=>c.output));
 save("inbound.json",inbound);save("raw-packets.json",packets.map(({bytes,...packet},index)=>({...packet,path:"packets/"+index+".bin",sha:sha(bytes)})));
 save("result.json",{nonce,root,ports,coreRole,relayMode,helper,failure,leaseEvents,children:children.map(c=>({role:c.role,pid:c.pid,exit:c.exit}))});console.log(JSON.stringify({root,nonce,ports,failure}));
}
