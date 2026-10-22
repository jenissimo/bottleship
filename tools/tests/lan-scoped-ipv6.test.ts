import { beforeAll, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import { createLanServer } from "../../packages/lan/src/server";
import { buildNativeForTests, nativeTestHelper } from "../../packages/lan/native/testing";
import { parseIpv6 } from "../../packages/lan/src/ip-address";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";
import { WsaSocketTable, WsaFailure, WSA, ipv6Address } from "../../src/worker/modules/wsa-network";

beforeAll(buildNativeForTests);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, reason: string): Promise<void> {
    const deadline = Date.now()+8000;
    while (!check()) { if(Date.now()>deadline)throw new Error("Timeout: "+reason); await pause(5); }
}
function code(fn: () => unknown): number {
    try { fn(); return 0; } catch(error) { if(error instanceof WsaFailure)return error.code; throw error; }
}
for(const transport of ["websocket","polling"] as const) test("native scoped IPv6 preserves distinct same-address interfaces over "+transport,async()=>{
    const scoped=Object.values(networkInterfaces()).flat().find(item=>item?.family==="IPv6"&&item.address.startsWith("fe80:")&&item.scopeid);
    const host=scoped?scoped.address.split("%")[0]+"%"+scoped.scopeid:"::1";
    const udp6=createSocket("udp6"),udp4=createSocket("udp4"),sockets=new Set<Socket>();
    udp6.on("message",(bytes,peer)=>udp6.send(Buffer.concat([Buffer.from([6]),bytes]),peer.port,peer.address));
    udp4.on("message",(bytes,peer)=>udp4.send(Buffer.concat([Buffer.from([4]),bytes]),peer.port,peer.address));
    await new Promise<void>((resolve,reject)=>{udp6.once("error",reject);udp6.bind({address:"::",port:0,ipv6Only:true},resolve);});
    const nativePort=udp6.address().port;
    await new Promise<void>((resolve,reject)=>{udp4.once("error",reject);udp4.bind(nativePort,"127.0.0.1",resolve);});
    const tcp=createServer({allowHalfOpen:true},socket=>{
        sockets.add(socket);socket.on("data",bytes=>socket.write(bytes));socket.on("end",()=>socket.end());
        socket.on("error",()=>{});socket.on("close",()=>sockets.delete(socket));
    });
    await new Promise<void>((resolve,reject)=>{tcp.once("error",reject);tcp.listen({port:0,host:"::",ipv6Only:true},resolve);});
    const tcpPort=(tcp.address() as {port:number}).port;
    const address="fe80::123";
    const server=createLanServer({port:0,gateway:{nativeHelperPath:nativeTestHelper,routes:[
        {host,address,scopeId:11,names:["scoped.game.test"],ports:[nativePort,tcpPort],protocols:["udp","tcp"]},
        {host:"127.0.0.1",address,scopeId:12,names:["scoped.game.test"],ports:[nativePort],protocols:["udp"]},
    ]}});
    const port=await server.listen(),network=new LanNetwork();
    const link=new RelayLink("http://127.0.0.1:"+port,"scopes",network,{transports:[transport]});
    network.attach(link);const table=new WsaSocketTable(network),ip=parseIpv6(address)!;
    try {
        await link.ready;
        const a=network.routeIpv6(ip,11),b=network.routeIpv6(ip,12);
        expect(a).not.toEqual(b);
        expect(network.nodeToIpv6Scope(a)).toBe(11);expect(network.nodeToIpv6Scope(b)).toBe(12);
        const dns=await network.resolve("scoped.game.test",6);
        expect(dns.addresses.map(item=>item.scopeId)).toEqual([11,12]);
        expect(dns.addresses.map(item=>item.address)).toEqual([address,address]);
        const socket=table.socket(2,23);
        expect(code(()=>table.send(socket,Uint8Array.of(1),ipv6Address(ip,nativePort)))).toBe(WSA.EACCES);
        for(const [scopeId,marker] of [[11,6],[12,4]]) {
            await until(()=>{const result=code(()=>table.send(socket,Uint8Array.of(scopeId),ipv6Address(ip,nativePort,scopeId)));
                if(result===WSA.EWOULDBLOCK)return false;if(result)throw new Error("UDP send error "+result);return true;},"scoped send");
            await until(()=>table.readable(socket),"scoped native UDP");
            const packet=table.receive(socket,100);
            expect(packet.data).toEqual(Uint8Array.of(marker,scopeId));
            expect(packet.from.ip6).toEqual(ip);expect(packet.from.scopeId).toBe(scopeId);
        }
        const stream=table.socket(1,23);
        expect(code(()=>table.connect(stream,ipv6Address(ip,tcpPort,11)))).toBe(WSA.EWOULDBLOCK);
        await until(()=>table.isConnected(stream)||table.exceptional(stream),"scoped native TCP");
        expect(table.get(stream).error).toBe(0);
        expect(table.send(stream,Uint8Array.of(7,8))).toBe(2);
        await until(()=>table.bytesAvailable(stream)===2,"scoped stream echo");
        expect(table.receive(stream,100).data).toEqual(Uint8Array.of(7,8));
        table.shutdown(stream,1);await until(()=>table.get(stream).eof,"scoped FIN");
    } finally {
        table.reset();network.attach(null);await server.close();
        for(const socket of sockets)socket.destroy();
        await new Promise<void>(resolve=>tcp.close(()=>resolve()));
        await Promise.all([new Promise<void>(resolve=>udp4.close(()=>resolve())),new Promise<void>(resolve=>udp6.close(()=>resolve()))]);
    }
},25000);
