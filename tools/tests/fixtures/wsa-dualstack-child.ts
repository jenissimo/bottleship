/** SOURCE-ONLY DRAFT: own test Worker, no native/browser/server. */
import {LanNetwork} from "../../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace,type NetworkNamespaceBoot} from "../../../src/worker/core/network-namespace";
import {createWsaActorTable,type WsaActorTable} from "../../../src/worker/modules/wsa-actor-table";
import {createWsaApiFixture} from "./wsa-api-context";
import type {ThunkResult} from "../../../src/worker/core/thunking/thunk-dispatcher";
let namespace:ChildProcessNetworkNamespace,table:WsaActorTable,m:ReturnType<typeof createWsaApiFixture>;
const output=0x20000,length=0x20100,payload=0x21000,name=0x22000,nameLength=0x22100;
function call(operation:string,args:number[]):number{
 const r=m.api[operation]({} as never,m.ram,args);
 if(r instanceof Promise)throw Error("Expected nonblocking child public ABI");
 if(typeof r==="number")return r;
 if(r.deferredWrites)m.apply(r as ThunkResult);return r.value;
}
self.onmessage=async({data})=>{
 try{
  if(data.boot){
   const network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot as NetworkNamespaceBoot);
   await namespace.barrier();table=createWsaActorTable(network,()=>namespace.socketActorClient());m=createWsaApiFixture(table);
   self.postMessage({id:data.id,result:{ready:true,pid:data.boot.pid,epoch:data.boot.epoch}});return;
  }
  let result:unknown;const socket=data.socket as number;
  if(data.command==="import")result=table.importDuplicate(socket);
  else if(data.command==="readable")result=table.readable(socket);
  else if(data.command==="option"){
   m.ram.fill(0xb6,output,output+8);m.put(length,4);
   const rc=call("getsockopt",[socket,41,27,output,length]);
   result={rc,error:m.error(),length:m.get(length),raw:Array.from(m.ram.slice(output,output+8))};
  }else if(data.command==="receive"){
   m.ram.fill(0xa5,payload,payload+32);m.ram.fill(0xa5,name,name+32);m.put(nameLength,32);
   const value=call("recvfrom",[socket,payload,32,0,name,nameLength]);
   result={value,error:m.error(),length:m.get(nameLength),name:Array.from(m.ram.slice(name,name+32)),data:Array.from(m.ram.slice(payload,payload+32))};
  }else throw Error("Unknown owned child command");
  self.postMessage({id:data.id,result});
 }catch(error){self.postMessage({id:data.id,error:String(error)});}
};
