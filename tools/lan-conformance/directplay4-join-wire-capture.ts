import {createSocket} from "node:dgram";
import {createServer,createConnection, type Socket} from "node:net";
import {once} from "node:events";
import {networkInterfaces} from "node:os";
import {execFileSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {createHash,randomBytes} from "node:crypto";
import {resolve,join,dirname} from "node:path";
import {encodeDirectPlay4EnumSessionsReply} from "../../src/worker/modules/dplayx/native-wire/discovery";

if(process.platform!=="win32"||process.argv.length!==4)throw Error("usage: <new-dir> <x86-gcc>");
const dir=resolve(process.argv[2]),gcc=resolve(process.argv[3]);mkdirSync(dir,{recursive:false});
const src=resolve("tools/lan-conformance/directplay4-join-wire-client.c"),runner=resolve(import.meta.filename),exe=join(dir,"client.exe");
const sha=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
const before={src:sha(src),runner:sha(runner),gcc:sha(gcc)};
const report:any={before,status:"STARTED",events:[],cleanup:{}},save=()=>writeFileSync(join(dir,"result.json"),JSON.stringify(report,null,2)+"\n");
const deadline=<T>(p:Promise<T>,ms=10000)=>new Promise<T>((ok,no)=>{const t=setTimeout(()=>no(Error("deadline")),ms);p.then(v=>{clearTimeout(t);ok(v)},e=>{clearTimeout(t);no(e)});});
const udp=createSocket({type:"udp4",reuseAddr:false}),tcp=createServer(),sockets=new Set<Socket>();
udp.on("error",e=>{report.events.push({udpError:String(e)});});tcp.on("error",e=>{report.events.push({tcpError:String(e)});});
const nonce=randomBytes(4).readUInt32LE()||1,app=Buffer.from("000000001973e14aa3928047312f9ad1","hex");app.writeUInt32LE(nonce);
const instance=randomBytes(16);report.nonce=nonce;report.app=app.toString("hex");report.instance=instance.toString("hex");
let client:ReturnType<typeof Bun.spawn>|undefined,clientOut:Promise<string>|undefined,clientErr:Promise<string>|undefined,failure:unknown,requestSeen=false;
let ownedEndpoint:{ip:string;port:number;pid:number;target:string}|undefined;
let requestCount=0;
const env={Path:dirname(gcc)+";C:/Windows/System32;C:/Windows",SystemRoot:"C:/Windows"};
try{
 save();
 const build=Bun.spawn([gcc,"-O1","-o",exe,src,"-lole32","-ldxguid","-luuid"],{cwd:dir,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 const bo=new Response(build.stdout).text(),be=new Response(build.stderr).text();let ec:number;
 try {ec=await deadline(build.exited,15000);} catch(e){build.kill();await deadline(build.exited,5000);await deadline(Promise.all([bo,be]),5000);throw e;}
 report.build={pid:build.pid,exit:ec,stdout:await bo,stderr:await be};if(ec)throw Error("compile failed");
 report.exe=sha(exe);
 await deadline(new Promise<void>((ok,no)=>{udp.once("error",no);udp.bind({port:47624,address:"127.0.0.1",exclusive:true},()=>{udp.removeListener("error",no);ok();});}));
 await deadline(new Promise<void>((ok,no)=>{tcp.once("error",no);tcp.listen({host:"127.0.0.1",port:0,exclusive:true},()=>{tcp.removeListener("error",no);ok();});}));
 const listen=(tcp.address() as {port:number}).port;report.listener=listen;
 const sawRequest=new Promise<void>((ok,no)=>{
  udp.on("message",(packet,peer)=>{
   if(packet.length<52||packet.subarray(28,44).compare(app)!==0)return;
   report.events.push({udp:packet.toString("hex"),peer});writeFileSync(join(dir,"enum-request.bin"),packet);
   const returnPort=packet.readUInt16BE(6),returnIp=[...packet.subarray(8,12)].join(".");
   if(!returnPort||peer.address!=="127.0.0.1"){no(Error("unexpected enum source or return port"));return;}
   const list=execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p","tcp"],{encoding:"utf8",timeout:2000,maxBuffer:1024*1024});
   const matches=list.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(row=>row[0]==="TCP"&&row[3]==="LISTENING"&&row[1].endsWith(":"+returnPort));
   const all=list.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(row=>row[0]==="TCP"&&Number(row[4])===client?.pid);
   report.events.push({advertisedReturnIp:returnIp,endpointSnapshot:matches,ownedEndpoints:all,ownedPid:client?.pid});
   const localIps=new Set(Object.values(networkInterfaces()).flat().filter(x=>x?.family==="IPv4").map(x=>x!.address));
   const listeners=all.filter(row=>row[3]==="LISTENING").map(row=>{const k=row[1].lastIndexOf(":");return {ip:row[1].slice(0,k),port:Number(row[1].slice(k+1)),pid:Number(row[4])};}).filter(x=>x.port>=2300&&x.port<=2400&&(x.ip==="0.0.0.0"||localIps.has(x.ip)));
   if(listeners.length!==1||client?.exitCode!==null){no(Error("no unique live owned client listener"));return;}
   const chosen=listeners[0],target=chosen.ip==="0.0.0.0"?"127.0.0.1":chosen.ip;
   report.events.push({ownedListener:chosen,target,natAliasUsed:true});ownedEndpoint={...chosen,target};
   const payload=Buffer.from(encodeDirectPlay4EnumSessionsReply({version:13,size:80,flags:0,instanceGuid:instance,applicationGuid:app,maxPlayers:8,currentPlayers:1,reserved:[0,0],user:[0,0,0,0],name:"owned-wire"}));
   const msg=Buffer.alloc(20+payload.length);msg.writeUInt32LE((0xfab00000|msg.length)>>>0);msg[4]=2;msg.writeUInt16BE(listen,6);msg.set([127,0,0,1],8);payload.copy(msg,20);
   writeFileSync(join(dir,"enum-reply.bin"),msg);
   const sock=createConnection({host:target,port:chosen.port});sockets.add(sock);sock.on("close",()=>sockets.delete(sock));sock.on("error",e=>no(e));sock.on("connect",()=>{
    try {const now=execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p","tcp"],{encoding:"utf8",timeout:2000,maxBuffer:1024*1024});
     const stable=now.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).some(row=>row[0]==="TCP"&&row[1]===chosen.ip+":"+chosen.port&&row[3]==="LISTENING"&&Number(row[4])===client?.pid);
     const rows=now.split(/\r?\n/).map(line=>line.trim().split(/\s+/));
     const tuple=rows.find(row=>row[0]==="TCP"&&row[1]===sock.remoteAddress+":"+sock.remotePort&&row[2]===sock.localAddress+":"+sock.localPort&&row[3]==="ESTABLISHED"&&Number(row[4])===client?.pid);
     report.events.push({ownedListenerRecheck:stable,clientAlive:client?.exitCode===null,connectedTuple:tuple??null});
     if(!stable||!tuple||client?.exitCode!==null)throw Error("client listener or exact accepted tuple ownership changed before reply");sock.end(msg);
    } catch(e){sock.destroy();no(e);}
   });
  });
  tcp.on("connection",sock=>{
   sockets.add(sock);const record:any={remote:sock.remoteAddress,port:sock.remotePort,frames:[]};report.events.push(record);
   sock.on("close",()=>sockets.delete(sock));sock.on("error",e=>report.events.push({tcpPeerError:String(e)}));
   let buf=Buffer.alloc(0),total=0;
   sock.on("data",bytes=>{
    total+=bytes.length;if(total>262144){sock.destroy();no(Error("wire bound exceeded"));return;}
    buf=Buffer.concat([buf,bytes]);
    while(buf.length>=4){const h=buf.readUInt32LE(),size=h&0xfffff;if((h&0xfff00000)!==(0xfab00000|0)||size<20||size>65535){no(Error("unexpected frame header"));sock.destroy();return;}if(buf.length<size)break;
     const frame=Buffer.from(buf.subarray(0,size));buf=buf.subarray(size);record.frames.push(frame.toString("hex"));
     const cmd=frame.length>=28&&frame.subarray(20,24).toString()==="play"?frame.readUInt16LE(24):0;
     if(cmd===5&&requestCount<2){
      requestSeen=true;requestCount++;writeFileSync(join(dir,"player-id-request-native-"+requestCount+".bin"),frame);record.command=cmd;
      if(frame.length!==32||frame.readUInt16LE(26)!==14||!ownedEndpoint){no(Error("unexpected native player request"));return;}
      const local=ownedEndpoint, view=execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p","tcp"],{encoding:"utf8",timeout:2000,maxBuffer:1024*1024});
      const rows=view.split(/\r?\n/).map(line=>line.trim().split(/\s+/));
      const inbound=rows.find(row=>row[0]==="TCP"&&row[1]===sock.remoteAddress+":"+sock.remotePort&&row[2]===sock.localAddress+":"+sock.localPort&&row[3]==="ESTABLISHED"&&Number(row[4])===client?.pid);
      report.events.push({nativeRequestTuple:inbound??null,version:frame.readUInt16LE(26)});if(!inbound){no(Error("request socket not owned by client"));return;}
      const answer=Buffer.alloc(68);answer.writeUInt32LE(0xfab00044);answer[4]=2;answer.writeUInt16BE(listen,6);answer.set([127,0,0,1],8);
      answer.write("play",20);answer.writeUInt16LE(7,24);answer.writeUInt16LE(14,26);answer.writeUInt32LE(requestCount===1?0x12345678:0x12345679,28);
      writeFileSync(join(dir,"player-id-reply-generated-"+requestCount+".bin"),answer);
      const back=createConnection({host:local.target,port:local.port});sockets.add(back);back.on("close",()=>sockets.delete(back));back.on("error",e=>no(e));back.on("connect",()=>{
       try{const snap=execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p","tcp"],{encoding:"utf8",timeout:2000,maxBuffer:1024*1024});const rr=snap.split(/\r?\n/).map(line=>line.trim().split(/\s+/));
        const lst=rr.some(row=>row[0]==="TCP"&&row[1]===local.ip+":"+local.port&&row[3]==="LISTENING"&&Number(row[4])===local.pid);
        const accepted=rr.find(row=>row[0]==="TCP"&&row[1]===back.remoteAddress+":"+back.remotePort&&row[2]===back.localAddress+":"+back.localPort&&row[3]==="ESTABLISHED"&&Number(row[4])===local.pid);
        report.events.push({generatedPlayerIdReply:answer.toString("hex"),ownedReplyTuple:accepted??null,listenerRecheck:lst});
        if(!lst||!accepted||client?.exitCode!==null)throw Error("player reply ownership changed");back.end(answer);
       }catch(e){back.destroy();no(e);}
      });
     }
     if(cmd===19&&requestSeen){
      writeFileSync(join(dir,"addforward-request-native.bin"),frame);record.command=cmd;
      if(!ownedEndpoint||frame.readUInt16LE(26)!==14){no(Error("unexpected addforward version"));return;}
      const local=ownedEndpoint;
      // Source-derived synthetic SUPERENUMPLAYERSREPLY: one remote nameserver
      // system player with a 32-byte SPPLAYERDATA (stream + datagram sockaddr).
      const reply=Buffer.alloc(20+116+53);reply.writeUInt32LE((0xfab00000|reply.length)>>>0);reply[4]=2;reply.writeUInt16BE(listen,6);reply.set([127,0,0,1],8);
      const p=20;reply.write("play",p);reply.writeUInt16LE(41,p+4);reply.writeUInt16LE(14,p+6);reply.writeUInt32LE(1,p+8);reply.writeUInt32LE(116,p+16);reply.writeUInt32LE(36,p+24);
      const d=p+36;reply.writeUInt32LE(80,d);instance.copy(reply,d+8);app.copy(reply,d+24);reply.writeUInt32LE(8,d+40);reply.writeUInt32LE(1,d+44);
      const q=p+116;reply.writeUInt32LE(16,q);reply.writeUInt32LE(3,q+4);reply.writeUInt32LE(0x23456789,q+8);reply.writeUInt32LE(4,q+12);reply.writeUInt32LE(14,q+16);reply[q+20]=32;
      reply[q+21]=2;reply.writeUInt16BE(listen,q+23);reply.set([127,0,0,1],q+25);reply[q+37]=2;reply.writeUInt16BE(47624,q+39);reply.set([127,0,0,1],q+41);
      writeFileSync(join(dir,"name-table-reply-generated.bin"),reply);
      const back=createConnection({host:local.target,port:local.port});sockets.add(back);back.on("close",()=>sockets.delete(back));back.on("error",e=>no(e));back.on("connect",()=>{
       try{const snap=execFileSync("C:/Windows/System32/netstat.exe",["-ano","-p","tcp"],{encoding:"utf8",timeout:2000,maxBuffer:1024*1024});const rr=snap.split(/\r?\n/).map(line=>line.trim().split(/\s+/));
        const lst=rr.some(row=>row[0]==="TCP"&&row[1]===local.ip+":"+local.port&&row[3]==="LISTENING"&&Number(row[4])===local.pid);
        const tuple=rr.find(row=>row[0]==="TCP"&&row[1]===back.remoteAddress+":"+back.remotePort&&row[2]===back.localAddress+":"+back.localPort&&row[3]==="ESTABLISHED"&&Number(row[4])===local.pid);
        report.events.push({generatedNameTableReply:reply.toString("hex"),ownedReplyTuple:tuple??null,listenerRecheck:lst});
        if(!lst||!tuple||client?.exitCode!==null)throw Error("name table reply ownership changed");back.end(reply);
       }catch(e){back.destroy();no(e);}
      });
     }
     if(cmd===8&&requestCount===2){writeFileSync(join(dir,"create-player-request-native.bin"),frame);report.observedCreatePlayerRequest=true;ok();}
    }
   });
  });
 });
 void sawRequest.catch(()=>{});
 client=Bun.spawn([exe,String(nonce)],{cwd:dir,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 report.clientPid=client.pid;clientOut=new Response(client.stdout).text();clientErr=new Response(client.stderr).text();
 await deadline(sawRequest,14000);report.observedCreatePlayer=true;
 // Let native process its generated table while the owned sockets remain live.
 try {report.exitBeforeCleanup=await deadline(client.exited,12000);} catch {report.exitBeforeCleanup="deadline";}
 // Replies are generated, only request frames come from native. No full Join claim.
}catch(e){failure=e;report.error=String(e);}
finally{
 for(const s of sockets)s.destroy();
 try{await deadline(new Promise<void>(ok=>tcp.listening?tcp.close(()=>ok()):ok()),2000);report.cleanup.tcp="closed";}catch(e){report.cleanup.tcp=String(e);failure??=e;}
 try{await deadline(new Promise<void>(ok=>{try{udp.close(()=>ok());}catch{ok();}}),2000);report.cleanup.udp="closed";}catch(e){report.cleanup.udp=String(e);failure??=e;}
 if(client){try{report.clientExit=await deadline(client.exited,22000);report.clientStdout=await deadline(clientOut!,2000);report.clientStderr=await deadline(clientErr!,2000);report.cleanup.client="exited and stdout/stderr EOF";}catch(e){report.cleanup.client=String(e);failure??=e;client.kill();try{await deadline(client.exited,2000);}catch{}}}
 report.after={src:sha(src),runner:sha(runner),gcc:sha(gcc),exe:report.exe?sha(exe):undefined};
 if(report.after.src!==before.src||report.after.runner!==before.runner||report.after.gcc!==before.gcc||(report.exe&&report.after.exe!==report.exe))failure??=Error("input changed");
 report.status=failure?"FAILED":"OBSERVED_CREATEPLAYER_REQUEST";if(failure)report.error=String(failure);save();
}
if(failure)throw failure;
