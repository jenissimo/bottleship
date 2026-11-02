import { LanNetwork } from "../../../src/worker/net/lan-network";
import { ChildProcessNetworkNamespace } from "../../../src/worker/core/network-namespace";
import { createWsaActorTable, type WsaActorTable } from "../../../src/worker/modules/wsa-actor-table";
import { ipv4Address, WsaFailure } from "../../../src/worker/modules/wsa-network";
let table:WsaActorTable, namespace:ChildProcessNetworkNamespace;
self.onmessage=({data})=>{
    try{
        if(data.boot){const network=new LanNetwork();namespace=new ChildProcessNetworkNamespace(network,data.boot);table=createWsaActorTable(network,namespace.socketActorClient());self.postMessage({id:data.id,result:true});return;}
        let result:unknown;const args=data.args??{};
        switch(data.command){
            case "bind":{const socket=table.socket(args.type??2);table.bind(socket,ipv4Address(table.network.ipv4,args.port));result=socket;break;}
            case "duplicate":result=table.duplicate(args.socket,args.pid);break;
            case "import":result=table.importDuplicate(args.socket);break;
            case "close":result=table.closesocket(args.socket);break;
            case "isValid":result=table.isValid(args.socket);break;
            case "get":result={id:table.get(args.socket).id,state:table.get(args.socket).state};break;
            case "send":result=table.send(args.socket,Uint8Array.from(args.data??[]),args.port?ipv4Address(table.network.ipv4,args.port):undefined);break;
            default:throw Error("Unknown actor test command");
        }
        self.postMessage({id:data.id,result});
    }catch(error){self.postMessage({id:data.id,error:error instanceof WsaFailure?error.code:String(error)});}
};
