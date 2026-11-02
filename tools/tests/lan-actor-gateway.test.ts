import {expect,test} from "bun:test";
import {createSocket} from "node:dgram";
import {createServer,type Socket as NativeSocket} from "node:net";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {WsaFailure,WSA,ipv4Address,ipv6Address} from "../../src/worker/modules/wsa-network";
import {createLanServer} from "../../packages/lan/src/server";
import {parseIpv6} from "../../packages/lan/src/ip-address";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,reason:string):Promise<void>{
    const deadline=Date.now()+10000;while(!check()){if(Date.now()>deadline)throw new Error("Timed out: "+reason);await pause(3);}
}
for(const family of [4,6] as const)for(const transport of ["websocket","polling"] as const)test("actor DNS and immediate native IPv"+family+" UDP/TCP routing over "+transport,async()=>{
    const host=family===4?"127.0.0.1":"::1",udp=createSocket(family===4?"udp4":"udp6");
    udp.on("message",(bytes,remote)=>udp.send(bytes,remote.port,remote.address));
    await new Promise<void>(resolve=>udp.bind(0,host,resolve));
    const udpPort=udp.address().port,sockets=new Set<NativeSocket>();
    const tcp=createServer(socket=>{
        sockets.add(socket);socket.on("data",bytes=>socket.write(bytes));
        socket.on("error",()=>{});socket.on("close",()=>sockets.delete(socket));
    });
    await new Promise<void>(resolve=>tcp.listen(0,host,resolve));
    const tcpPort=(tcp.address() as {port:number}).port,probe=createServer();
    await new Promise<void>(resolve=>probe.listen(0,host,resolve));
    const refusedPort=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
    // 10/8 must retain its configured external identity rather than becoming a
    // virtual LAN peer. IPv6 uses an explicit guest interface scope.
    const address=family===4?"10.222.223.224":"fe80::1234",scopeId=family===4?0:11;
    const server=createLanServer({port:0,transports:transport==="websocket"?["polling","websocket"]:["polling"],gateway:{routes:[
        {host,address,...(scopeId?{scopeId}:{}),names:["actor.gateway.test"],protocols:["udp","tcp"],ports:[udpPort,tcpPort,refusedPort]},
    ]}});
    const port=await server.listen(),network=new LanNetwork(),namespace=new RootNetworkNamespace(network,16,18000+family);
    const actor=createWsaActorTable(network,()=>namespace.socketActorClient());
    try{
        await namespace.configure({serverUrl:"http://127.0.0.1:"+port,room:"actor-gateway-"+family});
        if(transport==="websocket")await until(()=>[...server.io.sockets.sockets.values()][0]?.conn.transport.name==="websocket","normal polling-to-WebSocket upgrade");
        const resolved=await network.resolve("actor.gateway.test",family);
        expect(resolved.addresses[0].address).toBe(address);
        if(scopeId)expect(resolved.addresses[0].scopeId).toBe(scopeId);
        const ip=family===4?Uint8Array.from(address.split(".").map(Number)):parseIpv6(address)!;
        const remote=(port:number)=>family===4?ipv4Address(ip,port):ipv6Address(ip,port,scopeId);
        // No namespace/actor barrier between DNS completion and the first RPC:
        // the address route must travel with that RPC across the second port.
        const datagram=actor.socket(2,family===4?2:23),stream=actor.socket(1,family===4?2:23);
        try{actor.connect(stream,remote(tcpPort));}catch(error){if(!(error instanceof WsaFailure)||error.code!==WSA.EWOULDBLOCK)throw error;}
        await until(()=>actor.isConnected(stream),"actor native TCP connected");
        await until(()=>{
            try{return actor.send(datagram,Uint8Array.of(4,6,99),remote(udpPort))===3;}
            catch(error){if(error instanceof WsaFailure&&error.code===WSA.EWOULDBLOCK)return false;throw error;}
        },"actor native UDP sent");
        await until(()=>actor.readable(datagram),"actor native UDP reply");
        const received=actor.receive(datagram,10);
        expect([...received.data]).toEqual([4,6,99]);
        if(family===4)expect(received.from.ip).toEqual(ip);
        else{expect(received.from.ip6).toEqual(ip);expect(received.from.scopeId).toBe(scopeId);}
        const bytes=Uint8Array.from({length:98307},(_,index)=>(index*23+7)&255);
        let written=0;
        await until(()=>{
            try{written+=actor.send(stream,bytes.subarray(written));}
            catch(error){if(!(error instanceof WsaFailure)||error.code!==WSA.EWOULDBLOCK)throw error;}
            return written===bytes.length;
        },"actor native stream writes");
        const chunks:Uint8Array[]=[];let count=0;
        await until(()=>{
            while(actor.bytesAvailable(stream)){
                const part=actor.receive(stream,3001).data;chunks.push(part);count+=part.length;
            }return count===bytes.length;
        },"actor native partial reads");
        const echo=new Uint8Array(count);let offset=0;
        for(const chunk of chunks){echo.set(chunk,offset);offset+=chunk.length;}
        expect(echo).toEqual(bytes);
        const rejected=actor.socket(1,family===4?2:23);
        try{actor.connect(rejected,remote(refusedPort));}catch(error){if(!(error instanceof WsaFailure)||error.code!==WSA.EWOULDBLOCK)throw error;}
        await until(()=>actor.exceptional(rejected),"actor native refusal");
        expect(actor.get(rejected).error).toBe(WSA.ECONNREFUSED);
        await namespace.finishProcessLifetime(); // Both stream and datagram descriptors remain open.
        await until(()=>sockets.size===0,"graceful actor process finish closes native TCP");
        await namespace.close(); // Closing an online namespace must close its relay too.
        await until(()=>server.io.sockets.sockets.size===0,"actor namespace relay cleanup");
    }finally{
        await namespace.close();await server.close();
        for(const socket of sockets)socket.destroy();
        await Promise.all([new Promise<void>(resolve=>tcp.close(()=>resolve())),new Promise<void>(resolve=>udp.close(()=>resolve()))]);
    }
},30000);
