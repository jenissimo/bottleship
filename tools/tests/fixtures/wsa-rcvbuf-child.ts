/** Real child fixture; no synthetic receive/window injection. */
import {LanNetwork} from "../../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace,type NetworkNamespaceBoot} from "../../../src/worker/core/network-namespace";
import {createWsaActorTable} from "../../../src/worker/modules/wsa-actor-table";
import {publicContext} from "./wsa-rcvbuf-context";
let namespace:ChildProcessNetworkNamespace,f:ReturnType<typeof publicContext>;
self.onmessage=async({data})=>{
 try{
  if(data.boot){
   const network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot as NetworkNamespaceBoot);
   await namespace.barrier();f=publicContext(createWsaActorTable(network,()=>namespace.socketActorClient()));
   self.postMessage({id:data.id,result:{ready:true,pid:data.boot.pid,epoch:data.boot.epoch}});return;
  }
  let result:unknown;
  if(data.command==="import"){
   if(!(data.info instanceof Uint8Array)||data.info.length!==628)throw Error("Actual opaque WSAPROTOCOL_INFOW required");
   result=f.importInfo(data.info);
  }else if(data.command==="readable")result=f.table.readable(data.socket);
  else if(data.command==="query")result=f.query(data.socket);
  else if(data.command==="set")result=f.set(data.socket,data.value);
  else if(data.command==="receive")result=f.receive(data.socket,!!data.peek);
  else throw Error("Unknown owned child request");
  self.postMessage({id:data.id,result});
 }catch(error){self.postMessage({id:data.id,error:String(error)});}
};
