import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {acquireDirectPlay4JoinListener} from "../../src/worker/modules/dplayx/native-wire/join-listener";

test("actor close during policy sync cannot outpace the final identity check",async()=>{
    const worker=new Worker(new URL("./fixtures/dp4-listener-actor-worker.ts",import.meta.url).href,{type:"module"});
    const channel=new MessageChannel();
    const ready=new Promise<void>(resolve=>{worker.onmessage=()=>resolve();});
    worker.postMessage({port:channel.port2},[channel.port2]);await ready;
    const network=new LanNetwork(),allowed=[[2,1,127,0,0,1]];
    network.attach({connected:true,send(){return true;},close(){}});
    network.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    network.configureWinsock({provider:"native",hostListener:"game"});
    const boot={port:channel.port1,pid:1234,slot:0,epoch:1};
    const table=createWsaActorTable(network,boot);
    try {
        const owner=await acquireDirectPlay4JoinListener(table,1000);
        expect(owner.current()).toBe(true);
        const closer=createWsaActorTable(network,boot);
        const snapshot=network.tcpHostPolicySnapshot.bind(network);
        let calls=0,notifications=0;
        const off=table.subscribe(()=>notifications++);
        network.tcpHostPolicySnapshot=()=>{
            const result=snapshot();
            calls++;
            closer.closesocket(owner.socket);
            return result;
        };
        expect(owner.current()).toBe(false);
        expect(calls).toBe(1);
        expect(notifications).toBe(0); // actor notification remains queued on MessagePort.
        expect(table.isValid(owner.socket)).toBe(false);
        off();owner.release();
    } finally {table.reset();channel.port1.close();worker.terminate();}
},10000);
