import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {ipv4Address} from "../../src/worker/modules/wsa-network";
import {discoverNativeSessions} from "../../src/worker/modules/dplayx/native-wire/lan-discovery";
self.onmessage=async({data})=>{
 try {
  const network=new LanNetwork(),ns=new ChildProcessNetworkNamespace(network,data.boot);
  await ns.barrier();ns.synchronizeState();
  if(network.tcpHostListenV1?.listeners[0]?.id!=="game")throw Error("missing capability");
  const table=createWsaActorTable(network,ns.socketActorClient());await ns.barrier();
  const destination={...ipv4Address(Uint8Array.of(192,0,2,1),47624),node:Uint8Array.of(2,1,192,0,2,1)};
  const replies=await discoverNativeSessions(table,{applicationGuid:Uint8Array.from(data.guid),flags:0,destination,timeoutMs:3500,maxFrameBytes:65536});
  await ns.finishProcessLifetime();ns.close();
  self.postMessage({id:data.id,result:replies.map(r=>({...r,applicationGuid:[...r.applicationGuid],instanceGuid:[...r.instanceGuid],providerSockaddr:[...r.providerSockaddr]}))});
 }catch(e){self.postMessage({id:data.id,error:String(e)});}
};