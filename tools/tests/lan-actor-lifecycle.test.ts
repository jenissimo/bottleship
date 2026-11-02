import {expect,test} from "bun:test";
import {RootNetworkNamespace,ChildProcessNetworkNamespace,readNetworkNamespaceProcesses,isNetworkNamespaceProcessLive} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {WsaSocketTable,ipv4Address,WSA,WsaFailure} from "../../src/worker/modules/wsa-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,what:string):Promise<void>{
    const deadline=Date.now()+8000;
    while(!check()){if(Date.now()>deadline)throw new Error("Timed out: "+what);await sleep(2);}
}
function connect(table:WsaSocketTable,network:LanNetwork,port:number):number{
    const socket=table.socket();
    try{table.connect(socket,ipv4Address(network.ipv4,port));}
    catch(error){if(!(error instanceof WsaFailure)||error.code!==WSA.EWOULDBLOCK)throw error;}
    return socket;
}
test("actor normal process finish drains an unclosed TCP socket; reload renews epoch and hard death resets",async()=>{
    const network=new LanNetwork(),namespace=new RootNetworkNamespace(network,16,17001),peer=new WsaSocketTable(network);
    const actor=createWsaActorTable(network,()=>namespace.socketActorClient());
    const listener=peer.socket();peer.bind(listener,ipv4Address(network.ipv4,7081));peer.listen(listener);
    try{
        const first=connect(actor,network,7081);
        await until(()=>peer.readable(listener),"first actor accept");
        const accepted=peer.accept(listener);
        await until(()=>actor.isConnected(first),"first actor connected");
        expect(actor.send(first,Uint8Array.of(1,2,3))).toBe(3);
        const old=namespace.socketActorClient();
        await namespace.finishProcessLifetime();
        await until(()=>peer.get(accepted).eof,"last reference graceful FIN");
        expect([...peer.receive(accepted,20).data]).toEqual([1,2,3]);
        expect(peer.receive(accepted,1).data.length).toBe(0);
        expect(peer.get(accepted).error).toBe(0);
        expect(()=>namespace.socketActorClient()).toThrow();
        namespace.beginProcessLifetime();
        const fresh=namespace.socketActorClient();expect(fresh.epoch).not.toBe(old.epoch);
        const second=connect(actor,network,7081);
        await until(()=>peer.readable(listener),"reloaded actor accept");
        const resetPeer=peer.accept(listener);
        await until(()=>actor.isConnected(second),"reloaded actor connected");
        namespace.dropSocketActorClient();
        await namespace.barrier();
        await until(()=>peer.exceptional(resetPeer),"hard process death reset");
        expect(peer.get(resetPeer).error).toBe(WSA.ECONNRESET);
    }finally{peer.reset();await namespace.close();}
},20000);

test("queued child drop followed by immediate begin cannot revoke the new process incarnation",async()=>{
    const network=new LanNetwork(),namespace=new RootNetworkNamespace(network,16,17002),lease=namespace.createChild(17003);
    const childNetwork=new LanNetwork(),child=new ChildProcessNetworkNamespace(childNetwork,lease.boot);
    const peer=new WsaSocketTable(network);
    const actor=createWsaActorTable(childNetwork,()=>child.socketActorClient());
    try{
        await child.barrier(); // The broker authenticates the child channel before synchronous actor RPC.
        const before=child.socketActorClient();await child.barrier();
        const socket=actor.socket(2);actor.bind(socket,ipv4Address(childNetwork.ipv4,7082));
        child.dropSocketActorClient();child.beginProcessLifetime();
        const after=child.socketActorClient();
        expect(after.epoch).not.toBe(before.epoch);
        await child.barrier();
        expect(isNetworkNamespaceProcessLive(lease.boot.shared,lease.boot.capacity,before)).toBe(false);
        expect(isNetworkNamespaceProcessLive(lease.boot.shared,lease.boot.capacity,after)).toBe(true);
        expect(readNetworkNamespaceProcesses(lease.boot.shared,lease.boot.capacity).filter(item=>item.pid===17003)).toEqual([{pid:17003,slot:after.slot,epoch:after.epoch}]);
        const replacement=actor.socket(2);actor.bind(replacement,ipv4Address(childNetwork.ipv4,7082));
        const sender=peer.socket(2);peer.send(sender,Uint8Array.of(9),ipv4Address(network.ipv4,7082));
        await until(()=>actor.readable(replacement),"new incarnation receives UDP");
        expect([...actor.receive(replacement,1).data]).toEqual([9]);
        await child.finishProcessLifetime();
        expect(isNetworkNamespaceProcessLive(lease.boot.shared,lease.boot.capacity,after)).toBe(false);
        const reusable=peer.socket(2);peer.bind(reusable,ipv4Address(network.ipv4,7082));
    }finally{child.close();lease.close();peer.reset();await namespace.close();}
},20000);
