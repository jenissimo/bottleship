import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {ipv4Address} from "../../src/worker/modules/wsa-network";
import {acquireDirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";
import {DirectPlay4JoinChannel} from "../../src/worker/modules/dplayx/native-wire/join-channel";
import {encodeDirectPlay4SystemTcpFrame} from "../../src/worker/modules/dplayx/native-wire/tcp-frame";
import {encodeDirectPlay4RequestPlayerId,decodeDirectPlay4PlayerIdReply} from "../../src/worker/modules/dplayx/native-wire/player-id";
let allowSend!:()=>void;
const sendGate=new Promise<void>(ok=>allowSend=ok);
self.onmessage=async({data})=>{
 if(data.command==="send"){allowSend();return;}
 let namespace:ChildProcessNetworkNamespace|undefined,channel:DirectPlay4JoinChannel|undefined,listener:Awaited<ReturnType<typeof acquireDirectPlay4JoinListener>>|undefined;
 const controller=new AbortController();
 try{
  const network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot);
  await namespace.barrier();namespace.synchronizeState();const table=createWsaActorTable(network,namespace.socketActorClient());await namespace.barrier();
  listener=await acquireDirectPlay4JoinListener(table,8000,controller.signal);
  const ip=Uint8Array.from(data.ip), address={...ipv4Address(ip,data.port),node:network.routeIpv4(ip)};
  const sockaddr=new Uint8Array(16);sockaddr[0]=2;sockaddr[2]=listener.address.port>>>8;sockaddr[3]=listener.address.port&255;sockaddr.set(listener.address.node.slice(2),4);
  const request=encodeDirectPlay4SystemTcpFrame(sockaddr,encodeDirectPlay4RequestPlayerId(9,14),65536);
  let resolveFrame!:(v:any)=>void,rejectFrame!:(e:Error)=>void;
  const reply=new Promise<any>((ok,no)=>{resolveFrame=ok;rejectFrame=no;});void reply.catch(()=>{});
  channel=new DirectPlay4JoinChannel(table,{destination:address,listener,signal:controller.signal,current:()=>true,
   authorizeDestination:a=>a.port===data.port&&!!a.ip&&a.ip.every((v,i)=>v===ip[i]),
   authorizePeer:a=>!!a.ip&&a.ip.every((v,i)=>v===ip[i]),
   onFrame:(frame,peer)=>{if(frame.command!==7){rejectFrame(Error("unexpected command "+frame.command));return;}
    const decoded=decodeDirectPlay4PlayerIdReply(frame.message,65536);resolveFrame({command:frame.command,version:frame.version,playerId:decoded.playerId,result:decoded.result,providerSockaddr:[...frame.providerSockaddr],message:[...frame.message],peer:{ip:[...(peer.ip??[])],port:peer.port}});},
   onFailure:rejectFrame,onOwnershipUncertain:e=>{self.postMessage({kind:"ownershipUncertain",error:String(e)});namespace!.close();},timeoutMs:8000,maxFrameBytes:65536,maxChildren:4,maxWriteBytes:65536});
  self.postMessage({kind:"preflight",listener:listener.address});
  await sendGate;await channel.send(request);const frame=await reply;
  self.postMessage({kind:"result",result:{request:[...request],listener:listener.address,frame}});
 }catch(e){self.postMessage({kind:"error",error:String(e)});}
 finally{controller.abort();channel?.close();listener?.release();try{await namespace?.finishProcessLifetime();}finally{namespace?.close();}self.postMessage({kind:"finished"});}
};
