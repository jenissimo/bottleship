import {LanNetwork, type NetTransport} from "../../../src/worker/net/lan-network";
import {decodeDatagram, decodeTcpFrame, encodeDatagram, encodeTcpFrame, PROTO_UDP, PROTO_TCP, SYN, SYNACK, DATA, TCP_WINDOW} from "../../../src/worker/net/netplay-wire";
import {WsaSocketTable, WsaFailure} from "../../../src/worker/modules/wsa-network";
import {WsaActorKernel} from "../../../src/worker/modules/wsa-actor-kernel";
import {encodeActorValue, WSA_ACTOR_PENDING, WSA_ACTOR_EXECUTING, WSA_ACTOR_DONE, WSA_ACTOR_ERROR} from "../../../src/worker/modules/wsa-actor-protocol";

self.onmessage = ({data}) => {
    const port: MessagePort = data.port;
    const network = new LanNetwork(Uint8Array.of(2,0,0,1,2,3));
    const allowed = [[2,1,127,0,0,1]], source=Uint8Array.from(allowed[0]);
    let listenerPort=0;
    const reply=Uint8Array.from(Buffer.from(
        "7600b0fa020008fcc00002010000000000000000"+
        "706c617901000b005000000000200000000102030405060708090a0b0c0d0e0f"+
        "101112131415161718191a1b1c1d1e1f08000000030000000000000000000000"+
        "0403020188776655010000000200000003000000040000005c000000410016040000","hex"));
    const transport: NetTransport = {connected:true,send(frame){
        const datagram=decodeDatagram(frame);
        if(data.discovery && datagram?.proto===PROTO_UDP)
            queueMicrotask(()=>network.receiveFrame(encodeDatagram(PROTO_TCP,source,listenerPort,4000,encodeTcpFrame(SYN,88,0,TCP_WINDOW))));
        if(data.discovery && datagram?.proto===PROTO_TCP) {
            const tcp=decodeTcpFrame(datagram.payload);
            if(tcp?.kind===SYNACK) queueMicrotask(()=>network.receiveFrame(
                encodeDatagram(PROTO_TCP,source,listenerPort,4000,encodeTcpFrame(DATA,88,tcp.srcId,0,reply))));
        }
        return true;
    },close(){},openTcpHost:async request=>{
        listenerPort=request.localPort;
        let live=true;
        let end!: (value:{code:number;message:string})=>void;
        const closed=new Promise<{code:number;message:string}>(resolve=>{end=resolve;});
        return {address:{node:allowed[0],port:2309},allowedNodes:allowed,isLive:()=>live,closed,
            release(){if(live){live=false;end({code:10054,message:"closed"});}}};
    }};
    network.attach(transport);
    network.configureGatewayAddresses([[192,0,2,1]]);
    network.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    network.configureWinsock({provider:"native",hostListener:"game"});
    const kernel=new WsaActorKernel(new WsaSocketTable(network)), identity={pid:1234,slot:0,epoch:1};
    kernel.register(identity);
    kernel.attach(identity,message=>port.postMessage(message));
    port.onmessage = ({data:request}) => {
        const header=new Int32Array(request.mailbox,0,2);
        if (Atomics.compareExchange(header,0,WSA_ACTOR_PENDING,WSA_ACTOR_EXECUTING)!==WSA_ACTOR_PENDING) return;
        let status=WSA_ACTOR_DONE, result:unknown;
        try { result=kernel.execute(identity,request.command,request.args,request.nativeHandleOnly); }
        catch (error) {status=WSA_ACTOR_ERROR;result={error:error instanceof WsaFailure?error.code:10050};}
        const bytes=new TextEncoder().encode(encodeActorValue(result));
        new Uint8Array(request.mailbox,16,bytes.length).set(bytes);
        Atomics.store(header,1,bytes.length);Atomics.store(header,0,status);Atomics.notify(header,0);
    };
    port.start();
    self.postMessage("ready");
};
