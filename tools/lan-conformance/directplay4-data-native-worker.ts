import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {ipv4Address,WSA,WsaFailure} from "../../src/worker/modules/wsa-network";
import {acquireDirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";
import {acquireDirectPlay4JoinUdpListener} from "../../src/worker/modules/dplayx/native-wire/join-udp-listener";
import {DirectPlay4JoinChannel} from "../../src/worker/modules/dplayx/native-wire/join-channel";
import {encodeDirectPlay4SystemTcpFrame} from "../../src/worker/modules/dplayx/native-wire/tcp-frame";
import {encodeDirectPlay4RequestPlayerId,decodeDirectPlay4PlayerIdReply} from "../../src/worker/modules/dplayx/native-wire/player-id";
import {encodeDirectPlay4PackedPlayer,encodeDirectPlay4TcpIpPlayerData} from "../../src/worker/modules/dplayx/native-wire/packed-player";
import {encodeDirectPlay4AddForward,decodeDirectPlay4NameTable} from "../../src/worker/modules/dplayx/native-wire/name-table";
let allowSend!:()=>void,allowRaw!:()=>void,finish!:()=>void;const sendGate=new Promise<void>(ok=>allowSend=ok),rawGate=new Promise<void>(ok=>allowRaw=ok),finishGate=new Promise<void>(ok=>finish=ok);
self.onmessage=async({data})=>{
 if(data.command==="send"){allowSend();return;}
 if(data.command==="rawSend"){allowRaw();return;}
 if(data.command==="finish"){finish();return;}
 let namespace:ChildProcessNetworkNamespace|undefined,channel:DirectPlay4JoinChannel|undefined,listener:Awaited<ReturnType<typeof acquireDirectPlay4JoinListener>>|undefined,udp:Awaited<ReturnType<typeof acquireDirectPlay4JoinUdpListener>>|undefined;
 const controller=new AbortController();
 try{
  const network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot);
  await namespace.barrier();namespace.synchronizeState();const table=createWsaActorTable(network,namespace.socketActorClient());await namespace.barrier();
  listener=await acquireDirectPlay4JoinListener(table,10000,controller.signal);
  udp=await acquireDirectPlay4JoinUdpListener(table,"udp",10000,controller.signal);
  const ip=Uint8Array.from(data.ip), address={...ipv4Address(ip,data.port),node:network.routeIpv4(ip)};
  function sockaddr(port:number){const b=new Uint8Array(16);b[0]=2;b[2]=port>>>8;b[3]=port&255;b.set(ip,4);return b;}
  const stream=sockaddr(listener.address.port), datagram=sockaddr(udp.address.port);
  const request=encodeDirectPlay4SystemTcpFrame(stream,encodeDirectPlay4RequestPlayerId(9,14),65536);
  let channelFailure:Error|undefined,nextOk!:(v:any)=>void,nextNo!:(e:Error)=>void;
  const pending=()=>{const p=new Promise<any>((ok,no)=>{nextOk=ok;nextNo=no;});void p.catch(()=>{});return p;};
  const first=pending();
  channel=new DirectPlay4JoinChannel(table,{destination:address,listener,signal:controller.signal,current:()=>udp!.current(),
   authorizeDestination:a=>a.port===data.port&&!!a.ip&&a.ip.every((v,i)=>v===ip[i]),
   authorizePeer:a=>!!a.ip&&a.ip.every((v,i)=>v===ip[i]),
   onFrame:(frame,peer)=>{const raw={command:frame.command,version:frame.version,providerSockaddr:[...frame.providerSockaddr],message:[...frame.message],peer:{ip:[...(peer.ip??[])],port:peer.port}};self.postMessage({kind:"frame",frame:raw});nextOk({frame,raw});},
   onFailure:e=>{channelFailure=e;nextNo(e);},onOwnershipUncertain:e=>{self.postMessage({kind:"ownershipUncertain",error:String(e)});namespace!.close();},
   timeoutMs:10000,maxFrameBytes:65536,maxChildren:4,maxWriteBytes:65536});
  self.postMessage({kind:"preflight",listener:listener.address,udp:udp.address,udpBinding:udp.binding});
  await sendGate;await channel.send(request);const answer=await first;
  if(answer.frame.command!==7||answer.frame.version!==14)throw Error("unexpected cmd5 reply");
  const player=decodeDirectPlay4PlayerIdReply(answer.frame.message,65536);
  if(player.result!==0||!player.playerId)throw Error("player ID rejected");
  const packed=encodeDirectPlay4PackedPlayer({flags:9,id:player.playerId,systemPlayerId:player.playerId,version:14,parentId:0,shortName:null,longName:null,spData:encodeDirectPlay4TcpIpPlayerData(stream,datagram),playerData:new Uint8Array()},65536);
  const tick=data.tick; // Exact reserved1 from the owned host GetSessionDesc.
  const forward=encodeDirectPlay4SystemTcpFrame(stream,encodeDirectPlay4AddForward(player.playerId,packed,"",tick,65536,14),65536);
  const second=pending();self.postMessage({kind:"generated",request:[...request],forward:[...forward],tick,playerId:player.playerId,stream:[...stream],datagram:[...datagram]});
  await channel.send(forward);const response=await second;
  const decoded=decodeDirectPlay4NameTable(response.frame.message,65536,4096);
  const idRequest=encodeDirectPlay4SystemTcpFrame(stream,encodeDirectPlay4RequestPlayerId(8,14),65536);
  const third=pending();await channel.send(idRequest);const reply2=await third;
  if(reply2.frame.command!==7||reply2.frame.version!==14)throw Error("unexpected app player ID response");
  const app=decodeDirectPlay4PlayerIdReply(reply2.frame.message,65536);if(app.result!==0||!app.playerId||app.playerId===player.playerId)throw Error("invalid app player ID");
  const appPacked=encodeDirectPlay4PackedPlayer({flags:8,id:app.playerId,systemPlayerId:player.playerId,version:14,parentId:0,shortName:"owned-client",longName:null,spData:encodeDirectPlay4TcpIpPlayerData(stream,datagram),playerData:new Uint8Array()},65536);
  const create=new Uint8Array(28+appPacked.length+6),v=new DataView(create.buffer);
  v.setUint32(0,0x79616c70,true);v.setUint16(4,8,true);v.setUint16(6,14,true);v.setUint32(12,app.playerId,true);v.setUint32(20,28,true);create.set(appPacked,28);
  const frame=encodeDirectPlay4SystemTcpFrame(stream,create,65536);
  self.postMessage({kind:"appGenerated",idRequest:[...idRequest],create:[...frame],appId:app.playerId,systemId:player.playerId});
  await channel.send(frame);await new Promise(ok=>setTimeout(ok,300));if(channelFailure)throw channelFailure;
  if(!decoded.players.some(p=>p.id===data.hostPlayer))throw Error("host player missing from native table");
  channel.close();
  const raw=table.socketOwned(1,2,6),valid=()=>table.isValid(raw.handle)&&table.fileObjectId(raw.handle)===raw.object;
  try {
   try{table.connect(raw.handle,address);}catch(e){if(!(e instanceof WsaFailure&&e.code===WSA.EWOULDBLOCK))throw e;}
   const end=Date.now()+6000;
   while(!table.isConnected(raw.handle)){if(Date.now()>end||!valid())throw Error("raw connect failed");await new Promise(ok=>setTimeout(ok,10));}
   self.postMessage({kind:"rawReady",appId:app.playerId,rawHandle:raw.handle,rawPhysical:raw.object});
   await rawGate;
   const text=new TextEncoder().encode("client-"+data.nonce), outbound=new Uint8Array(28+text.length),outView=new DataView(outbound.buffer);
   outView.setUint32(0,(0xfab00000|outbound.length)>>>0,true);outbound.set(stream,4);outView.setUint32(20,app.playerId,true);outView.setUint32(24,data.hostPlayer,true);outbound.set(text,28);
   let offset=0;while(offset<outbound.length){if(!valid()||Date.now()>end+8000)throw Error("raw send deadline");try{offset+=table.send(raw.handle,outbound.subarray(offset));}catch(e){if(!(e instanceof WsaFailure&&e.code===WSA.EWOULDBLOCK))throw e;await new Promise(ok=>setTimeout(ok,10));}}
   self.postMessage({kind:"dataReady",outbound:[...outbound],appId:app.playerId,hostId:data.hostPlayer});
   let incoming:ReturnType<typeof table.acceptOwned>|undefined,buffer=new Uint8Array(),peer:any;
   try{
    const receiveEnd=Date.now()+9000;
    while(Date.now()<receiveEnd){
     if(!incoming){try{incoming=table.acceptOwned(listener.socket);}catch(e){if(!(e instanceof WsaFailure&&e.code===WSA.EWOULDBLOCK))throw e;await new Promise(ok=>setTimeout(ok,10));continue;}}
     try {
      if(!table.isValid(incoming.handle)||table.fileObjectId(incoming.handle)!==incoming.object)throw Error("raw accepted identity lost");
      const packet=table.receive(incoming.handle,65536);if(!packet.data.length)throw Error("EOF before raw reply");
      peer=packet.from;const joined=new Uint8Array(buffer.length+packet.data.length);joined.set(buffer);joined.set(packet.data,buffer.length);buffer=joined;
      if(buffer.length>65536)throw Error("raw reply exceeds bound");
      if(buffer.length>=4){const v=new DataView(buffer.buffer),token=v.getUint32(0,true),size=token&0xfffff;
       if((token>>>20)!==0xfab||size<28||size>65536)throw Error("invalid raw frame");
       if(buffer.length>=size){if(buffer.length!==size)throw Error("extra bytes after raw frame");
        if(v.getUint32(20,true)!==data.hostPlayer||v.getUint32(24,true)!==app.playerId||new TextDecoder().decode(buffer.subarray(28))!=="host-"+data.nonce)throw Error("wrong raw reply IDs or payload");
        if(!peer.ip||!peer.ip.every((x:number,i:number)=>x===ip[i])||!Number.isInteger(peer.port)||peer.port<1||peer.port>65535)throw Error("wrong raw peer address or port");
        self.postMessage({kind:"rawReply",bytes:[...buffer],peer:{ip:[...peer.ip],port:peer.port},hostId:data.hostPlayer,appId:app.playerId});break;
       }
      }
     }catch(e){if(!(e instanceof WsaFailure&&e.code===WSA.EWOULDBLOCK))throw e;await new Promise(ok=>setTimeout(ok,10));}
    }
    if(!buffer.length||buffer.length<28||new TextDecoder().decode(buffer.subarray(28))!=="host-"+data.nonce)throw Error("raw receive deadline");
   }finally{if(incoming)try{if(table.isValid(incoming.handle)&&table.fileObjectId(incoming.handle)===incoming.object)table.closesocket(incoming.handle);}catch{}}
  }finally{try{if(valid())table.closesocket(raw.handle);}catch{}}
  self.postMessage({kind:"result",result:{request:[...request],forward:[...forward],tick,listener:listener.address,udp:udp.address,playerId:player.playerId,appId:app.playerId,idRequest:[...idRequest],create:[...frame],first:answer.raw,second:response.raw,third:reply2.raw,decoded:{command:decoded.command,version:decoded.version,sessionDescription:[...decoded.sessionDescription],players:decoded.players.length,groups:decoded.groups.length,shortcuts:decoded.shortcuts.length}}});
  await finishGate;
 }catch(e){self.postMessage({kind:"error",error:String(e)});}
 finally{controller.abort();channel?.close();listener?.release();udp?.release();try{await namespace?.finishProcessLifetime();}finally{namespace?.close();}self.postMessage({kind:"finished"});}
};
