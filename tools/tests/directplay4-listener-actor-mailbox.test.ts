import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {discoverNativeSessions} from "../../src/worker/modules/dplayx/native-wire/lan-discovery";
import {WsaFailure,WSA} from "../../src/worker/modules/wsa-network";

test("native listener snapshot and current travel through actor mailbox and revoke on close",async()=>{
    const worker=new Worker(new URL("./fixtures/dp4-listener-actor-worker.ts",import.meta.url).href,{type:"module"});
    const channel=new MessageChannel();
    const ready=new Promise<void>(resolve=>{worker.onmessage=()=>resolve();});
    worker.postMessage({port:channel.port2},[channel.port2]);await ready;
    const table=createWsaActorTable(new LanNetwork(),{port:channel.port1,pid:1234,slot:0,epoch:1});
    try {
        const socket=table.socket(1,2,6);table.bind(socket);
        let notify!: ()=>void;
        const changed=new Promise<void>(resolve=>{notify=resolve;});
        const unsubscribe=table.subscribe(notify);
        try { table.listen(socket,5,true,1); throw Error("expected pending"); }
        catch(error){expect(error).toBeInstanceOf(WsaFailure);expect((error as WsaFailure).code).toBe(WSA.EWOULDBLOCK);}
        await changed;unsubscribe();
        expect(table.listen(socket,5,true,1)).toBe(0);
        const snapshot=table.nativeListenerSnapshot(socket)!;
        expect(snapshot.address).toEqual({node:[2,1,127,0,0,1],port:2309});
        expect(table.nativeListenerCurrent(socket,snapshot.ownerToken)).toBe(true);
        snapshot.address.node[2]=0;
        expect(table.nativeListenerSnapshot(socket)?.address.node[2]).toBe(127);
        table.closesocket(socket);
        expect(()=>table.nativeListenerCurrent(socket,snapshot.ownerToken)).toThrow();
    } finally {table.reset();channel.port1.close();worker.terminate();}
},10000);

test("discovery uses actor mailbox for READY, UDP and accepted TCP reply",async()=>{
    const worker=new Worker(new URL("./fixtures/dp4-listener-actor-worker.ts",import.meta.url).href,{type:"module"});
    const channel=new MessageChannel();
    const ready=new Promise<void>(resolve=>{worker.onmessage=()=>resolve();});
    worker.postMessage({port:channel.port2,discovery:true},[channel.port2]);await ready;
    const network=new LanNetwork(), allowed=[[2,1,127,0,0,1]];
    network.attach({connected:true,send(){return true;},close(){}});
    network.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    network.configureWinsock({provider:"native",hostListener:"game"});
    network.configureGatewayAddresses([[192,0,2,1]]);
    const table=createWsaActorTable(network,{port:channel.port1,pid:1234,slot:0,epoch:1});
    try {
        const replies=await discoverNativeSessions(table,{applicationGuid:new Uint8Array(16),flags:0,
            destination:{family:2,node:Uint8Array.of(2,1,192,0,2,1),ip:Uint8Array.of(192,0,2,1),port:47624},
            timeoutMs:200,maxFrameBytes:1024});
        expect(replies).toHaveLength(1);
        expect(replies[0].name).toBe("AЖ");
    } finally {table.reset();channel.port1.close();worker.terminate();}
},10000);
