import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable,type WsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {ipv4Address,WsaFailure} from "../../src/worker/modules/wsa-network";
import {acquireDirectPlay4JoinUdpListener,type DirectPlay4JoinUdpListener} from "../../src/worker/modules/dplayx/native-wire/join-udp-listener";
let network:LanNetwork, namespace:ChildProcessNetworkNamespace, table:WsaActorTable, listener:DirectPlay4JoinUdpListener;
self.onmessage=async({data})=>{
 try {
  let result:unknown;
  if(data.boot){
   network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot);
   await namespace.barrier();namespace.synchronizeState();
   if(network.udpHostListenV1?.listeners[0]?.id!=="udp")throw Error("missing public UDP capability");
   table=createWsaActorTable(network,namespace.socketActorClient());await namespace.barrier();result=true;
  }else switch(data.command){
   case "open":
    listener=await acquireDirectPlay4JoinUdpListener(table,"udp",8000);
    result={socket:listener.socket,physical:listener.physical,binding:listener.binding,address:listener.address,allowedNodes:listener.allowedNodes,current:listener.current(),generation:table.generation,fileId:table.fileObjectId(listener.socket)};break;
   case "receive": {const p=table.receive(listener.socket,512);result={data:[...p.data],from:{node:[...p.from.node],port:p.from.port}};break;}
   case "send": result=table.sendto(listener.socket,Uint8Array.from(data.bytes),ipv4Address(Uint8Array.from(data.ip),data.port));break;
   case "release": listener.release();result=listener.current();break;
   case "finish": await namespace.finishProcessLifetime();namespace.close();result=true;break;
   default:throw Error("unknown command");
  }
  self.postMessage({id:data.id,result});
 }catch(e){self.postMessage({id:data.id,error:e instanceof WsaFailure?e.code:String(e)});}
};
