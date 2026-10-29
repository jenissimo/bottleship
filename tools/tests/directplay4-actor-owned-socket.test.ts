import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WsaFailure,WSA} from "../../src/worker/modules/wsa-network";

test("owned actor operations return handle and physical ID in same mailbox result",async()=>{
    const worker=new Worker(new URL("./fixtures/dp4-listener-actor-worker.ts",import.meta.url).href,{type:"module"});
    const channel=new MessageChannel(),ready=new Promise<void>(resolve=>{worker.onmessage=()=>resolve();});
    worker.postMessage({port:channel.port2,discovery:true},[channel.port2]);await ready;
    const network=new LanNetwork(),allowed=[[2,1,127,0,0,1]];
    network.attach({connected:true,send:()=>true,close(){}});
    network.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    network.configureWinsock({provider:"native",hostListener:"game"});
    network.configureGatewayAddresses([[192,0,2,1]]);
    const table=createWsaActorTable(network,{port:channel.port1,pid:1234,slot:0,epoch:1});
    try {
        const listener=table.socketOwned(1,2,6);
        expect(listener.handle).toBeGreaterThan(0);
        expect(table.fileObjectId(listener.handle)).toBe(listener.object);
        table.bind(listener.handle);
        const wait=new Promise<void>(resolve=>{const off=table.subscribe(()=>{off();resolve();});});
        try{table.listen(listener.handle,5,true,1);}catch(e){expect((e as WsaFailure).code).toBe(WSA.EWOULDBLOCK);}
        await wait;expect(table.listen(listener.handle,5,true,1)).toBe(0);
        const udp=table.socketOwned(2,2,17);
        expect(table.fileObjectId(udp.handle)).toBe(udp.object);
        table.sendto(udp.handle,Uint8Array.of(1),{family:2,node:Uint8Array.of(2,1,192,0,2,1),ip:Uint8Array.of(192,0,2,1),port:47624});
        let child:{handle:number;object:number}|undefined;
        const deadline=Date.now()+3000;
        while(!child) {
            try{child=table.acceptOwned(listener.handle);}
            catch(e){if(!(e instanceof WsaFailure)||e.code!==WSA.EWOULDBLOCK||Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,2));}
        }
        expect(table.fileObjectId(child.handle)).toBe(child.object);
        expect(child.handle).toBeGreaterThan(0);
        table.closesocket(child.handle);table.closesocket(udp.handle);table.closesocket(listener.handle);
    } finally {table.reset();channel.port1.close();worker.terminate();}
},10000);
