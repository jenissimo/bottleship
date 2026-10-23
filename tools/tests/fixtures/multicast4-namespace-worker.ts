import {LanNetwork,type LanDatagram} from "../../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../../src/worker/core/network-namespace";
import {PROTO_UDP} from "../../../src/worker/net/netplay-wire";
let network:LanNetwork,namespace:ChildProcessNetworkNamespace;
const received:LanDatagram[]=[];
self.onmessage=async event=>{
 const m=event.data;
 try{
  let result:unknown;
  if(m.boot){
   network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,m.boot);
   await namespace.configure(m.config??null);
   result={node:[...network.node],connected:network.connected};
  }else if(m.command==="bind"){result=network.bind(m.port,{deliver:dg=>received.push(dg)},PROTO_UDP,true);await namespace.barrier();}
  else if(m.command==="send"){result=network.sendMulticast4(m.srcPort,Uint8Array.from(m.group),m.dstPort,Uint8Array.from(m.payload),m.interfaceIndex,m.ttl);await namespace.barrier();}
  else if(m.command==="packets"){result=received.splice(0).map(dg=>({node:[...dg.srcNode],port:dg.srcPort,data:[...dg.data],multicast4:dg.multicast4&&{...dg.multicast4,group:[...dg.multicast4.group]}}));}
  else if(m.command==="barrier"){await namespace.barrier();result=true;}
  else throw Error("Unknown multicast worker operation");
  self.postMessage({id:m.id,result});
 }catch(error){self.postMessage({id:m.id,error:String(error)});}
};
