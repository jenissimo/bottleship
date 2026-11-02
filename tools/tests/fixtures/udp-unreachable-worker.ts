import {LanNetwork,type LanSocketError} from "../../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../../src/worker/core/network-namespace";
let network:LanNetwork,namespace:ChildProcessNetworkNamespace;
const errors:LanSocketError[]=[];
self.onmessage=async event=>{
 const message=event.data;
 try{
  if(message.boot){network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,message.boot);network.onSocketError(error=>errors.push(error));}
  else{
   if(!network.isBound(message.source,message.proto))network.bind(message.source,{deliver(){}},message.proto);
   const before=errors.length;
   if(!network.send(message.source,network.node,message.target,Uint8Array.of(9),message.proto))throw new Error("local send rejected");
   await namespace.barrier();
   self.postMessage({id:message.id,value:{errors:errors.slice(before).map(({localPort,remotePort,proto,code})=>({localPort,remotePort,proto,code}))}});
   return;
  }
  self.postMessage({id:message.id,value:true});
 }catch(error){self.postMessage({id:message.id,error:String(error)});}
};
