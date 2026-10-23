import {ChildProcessNetworkNamespace,type NetworkNamespaceBoot} from "../../../src/worker/core/network-namespace";
import {LanNetwork} from "../../../src/worker/net/lan-network";
let network:LanNetwork,namespace:ChildProcessNetworkNamespace,boot:NetworkNamespaceBoot;
let handler:((event:MessageEvent)=>void)|null=null;
const held:MessageEvent[]=[];
function probe(){
 // Intentionally do not read connected before routing or capabilities.
 const policy=network.directPlay8,host=network.udpHostListenV1;
 const ipv4=Array.from(network.routeIpv4(Uint8Array.of(10,44,0,8)));
 let ipv6:number[]|undefined;try{ipv6=Array.from(network.routeIpv6(Uint8Array.of(32,1,13,184,0,0,0,0,0,0,0,0,0,0,0,9)))}catch{}
 return{policy,host,ipv4,ipv6,multicast:network.udpMulticast4V1,connected:network.connected};
}
self.onmessage=async event=>{
 const command=event.data;
 try{
  if(command.type==="boot"){
   boot=command.boot;network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,boot);
   handler=boot.port.onmessage as (event:MessageEvent)=>void;
   boot.port.onmessage=event=>{if(event.data?.type==="state"||event.data?.type==="gateways")held.push(event);else handler!(event)};
   network.bind(47591,{deliver(){}},1);
   const state=probe();
   const lease=await network.openUdpHost(47591,command.listener);
   lease.release();
   self.postMessage({id:command.id,state,earlyHost:true});
  }else if(command.type==="probe"){
   self.postMessage({id:command.id,state:probe()});
  }else if(command.type==="host"){
   const lease=await network.openUdpHost(47591,command.listener);lease.release();self.postMessage({id:command.id,earlyHost:true,state:probe()});
  }else if(command.type==="resolve"){
   await network.resolve("configured.test",4);self.postMessage({id:command.id,state:probe()});
  }else if(command.type==="flush"){
   for(const event of held.splice(0))handler!(event);self.postMessage({id:command.id,state:probe()});
  }else if(command.type==="close"){namespace?.close();self.postMessage({id:command.id,closed:true});}
 }catch(error){self.postMessage({id:command.id,error:{message:String(error),code:(error as any)?.code},state:network&&probe()})}
};
