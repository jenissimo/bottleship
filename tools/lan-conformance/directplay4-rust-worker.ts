import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WsaSocketTable,ipv4Address} from "../../src/worker/modules/wsa-network";
import {discoverNativeSessions} from "../../src/worker/modules/dplayx/native-wire/lan-discovery";
let namespace:ChildProcessNetworkNamespace,network:LanNetwork;
self.onmessage=async({data})=>{
 try{
  if(data.boot){
   network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot);
   await namespace.barrier();namespace.synchronizeState();
   if(network.tcpHostListenV1?.listeners[0]?.id!=="game")throw Error("missing capability");
   const table=createWsaActorTable(network,namespace.socketActorClient());
   await namespace.barrier();
   const target={...ipv4Address(Uint8Array.of(192,0,2,1),data.port),node:Uint8Array.of(2,1,192,0,2,1)};
   const replies=await discoverNativeSessions(table as unknown as WsaSocketTable,{applicationGuid:Uint8Array.from(data.applicationGuid),flags:0,destination:target,timeoutMs:1500,maxFrameBytes:1024});
   await namespace.finishProcessLifetime();namespace.close();
   self.postMessage({id:data.id,result:replies.map(r=>({name:r.name,applicationGuid:[...r.applicationGuid]}))});
  }
 }catch(e){self.postMessage({id:data.id,error:String(e)});}
};
