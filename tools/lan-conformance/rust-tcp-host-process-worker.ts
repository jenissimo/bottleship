import {LanNetwork} from "../../src/worker/net/lan-network";
import {ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {createWsaActorTable,type WsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {ipv4Address,WsaFailure} from "../../src/worker/modules/wsa-network";
import {makeNetworkSocketExports} from "../../src/worker/modules/wsa-network-api";

let network:LanNetwork,namespace:ChildProcessNetworkNamespace,table:WsaActorTable;
self.onmessage=async({data})=>{
 try{
  if(data.boot){
   network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot);
   await namespace.barrier();namespace.synchronizeState();
   if(network.tcpHostListenV1?.listeners[0]?.id!=="game"||network.winsock?.hostListener!=="game")throw Error("missing host policy");
   table=createWsaActorTable(network,namespace.socketActorClient());await namespace.barrier();
   self.postMessage({id:data.id,result:true});return;
  }
  let result:unknown;const a=data.args??{};
  switch(data.command){
   case "bind":{const sid=table.socket(1,2,6);table.bind(sid,ipv4Address(network.ipv4,a.port));result=sid;break;}
   case "listen":{let error=0;const api=makeNetworkSocketExports(table,code=>{error=code;},{started:true},()=>0);
    const call=await api.listen({} as never,new Uint8Array(0),[a.sid,5]);
    if((call as {value:number}).value!==0)throw new WsaFailure(error);result=true;break;}
   case "accept":result=table.accept(a.sid);break;
   case "close":result=table.closesocket(a.sid);break;
   case "send":result=table.send(a.sid,Uint8Array.from(a.bytes));break;
   case "receive":result=[...table.receive(a.sid,a.length).data];break;
   case "shutdown":result=table.shutdown(a.sid,1);break;
   case "finish":await namespace.finishProcessLifetime();namespace.close();result=true;break;
   default:throw Error("unknown process fixture command");
  }
  self.postMessage({id:data.id,result});
 }catch(error){self.postMessage({id:data.id,error:error instanceof WsaFailure?error.code:String(error)});}
};
