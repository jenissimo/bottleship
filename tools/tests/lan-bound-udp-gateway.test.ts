import {expect,test} from "bun:test";
import {buildBoundUdpHelper} from "../lan-conformance/build-bound-udp-helper";
import {createSocket,type Socket} from "node:dgram";
import {createLanServer} from "../../packages/lan/src/server";
import {parseIpv6} from "../../packages/lan/src/ip-address";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
import {WsaSocketTable,WsaFailure,WSA,ipv4Address,ipv6Address} from "../../src/worker/modules/wsa-network";

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,label:string):Promise<void>{
    const deadline=Date.now()+10000;
    while(!await check()){if(Date.now()>=deadline)throw Error("Timeout: "+label);await pause(2);}
}
async function send(run:()=>number):Promise<number>{
    let count=0;
    await until(()=>{try{count=run();return true;}catch(error){if(error instanceof WsaFailure&&error.code===WSA.EWOULDBLOCK)return false;throw error;}},"UDP writable");
    return count;
}
async function close(socket:Socket):Promise<void>{await new Promise<void>(resolve=>socket.close(()=>resolve()));}
async function portFree(family:4|6,port:number):Promise<boolean>{
    const socket=createSocket(family===4?"udp4":{type:"udp6",ipv6Only:true});
    return new Promise(resolve=>{
        socket.once("error",()=>{socket.close();resolve(false);});
        socket.bind(port,family===4?"0.0.0.0":"::",()=>socket.close(()=>resolve(true)));
    });
}
for(const family of [4,6] as const)for(const transport of ["websocket","polling"] as const){
    test("bound helper UDP port survives multiple peers, IPv"+family+", "+transport,async()=>{
        const host=family===4?"127.0.0.1":"::1";
        const peers=[createSocket(family===4?"udp4":"udp6"),createSocket(family===4?"udp4":"udp6")];
        const seen:Array<{peer:number;port:number;bytes:number[]}>=[];
        for(const [index,peer]of peers.entries()){
            peer.on("message",(bytes,remote)=>{seen.push({peer:index,port:remote.port,bytes:[...bytes]});peer.send(bytes,remote.port,remote.address);});
            await new Promise<void>((resolve,reject)=>{peer.once("error",reject);peer.bind(0,host,resolve);});
        }
        const ports=peers.map(peer=>peer.address().port);
        // First establish the OS reference: one native socket retains its source
        // port for both destinations, independently of any virtual routing.
        const reference=createSocket(family===4?"udp4":"udp6");
        await new Promise<void>((resolve,reject)=>{reference.once("error",reject);reference.bind(0,host,resolve);});
        for(const [index,port]of ports.entries())await new Promise<void>((resolve,reject)=>reference.send(Buffer.of(0x70+index),port,host,error=>error?reject(error):resolve()));
        await until(()=>seen.length===2,"native multi-peer reference");
        expect(seen[0].port).toBe(seen[1].port);
        await close(reference);seen.length=0;

        const ips=family===4?["203.0.113.141","203.0.113.142"]:["2001:db8::141","2001:db8::142"];
        const server=createLanServer({port:0,gateway:{nativeUdpHelperPath:await buildBoundUdpHelper(),routes:ips.map((address,index)=>({host,address,ports:[ports[index]],protocols:["udp" as const]}))}});
        const relayPort=await server.listen(),network=new LanNetwork();
        const link=new RelayLink("http://127.0.0.1:"+relayPort,"udp-multiple-peers",network,{transports:[transport]});
        network.attach(link);const table=new WsaSocketTable(network);
        let nativePort=0;
        try{
            await link.ready;
            const socket=table.socket(2,family===4?2:23),localPort=47141;
            table.bind(socket,family===4?ipv4Address(new Uint8Array(4),localPort):ipv6Address(new Uint8Array(16),localPort));
            const targets=ips.map((ip,index)=>family===4?ipv4Address(Uint8Array.from(ip.split(".").map(Number)),ports[index]):ipv6Address(parseIpv6(ip)!,ports[index]));
            for(let round=0;round<3;round++)for(let peer=0;peer<2;peer++){
                const payload=round===2?new Uint8Array():round===1?new Uint8Array(family===4?65507:65527).fill(peer+1):Uint8Array.of(peer,round,0xff);
                expect(await send(()=>table.send(socket,payload,targets[peer]))).toBe(payload.length);
                await until(()=>table.readable(socket),"native peer reply");
                const reply=table.receive(socket,65535);
                expect(reply.data).toEqual(payload);expect(reply.from.port).toBe(ports[peer]);
                if(family===4)expect(reply.from.ip).toEqual(targets[peer].ip);
                else expect(reply.from.ip6).toEqual(targets[peer].ip6);
            }
            expect(seen.length).toBe(6);
            nativePort=seen[0].port;
            expect(new Set(seen.map(item=>item.port))).toEqual(new Set([nativePort]));
            expect(await portFree(family,nativePort)).toBe(false);
            const unrelated=createSocket(family===4?"udp4":"udp6");
            try{
                await new Promise<void>((resolve,reject)=>{unrelated.once("error",reject);unrelated.bind(0,host,resolve);});
                for(let index=0;index<8;index++)await new Promise<void>((resolve,reject)=>unrelated.send(Buffer.of(0xee,index),nativePort,host,error=>error?reject(error):resolve()));
                expect(await send(()=>table.send(socket,Uint8Array.of(0x42),targets[0]))).toBe(1);
                await until(()=>table.readable(socket),"known peer after unrelated sender");
                expect(table.receive(socket,100).data).toEqual(Uint8Array.of(0x42));
                expect(table.readable(socket)).toBe(false);
            }finally{await close(unrelated);}
            table.closesocket(socket);
            await until(()=>portFree(family,nativePort),"last binding release closes the shared OS port");
            expect(link.connected).toBe(true);
        }finally{
            table.reset();network.attach(null);await server.close();
            await Promise.all(peers.map(close));
        }
    },20000);
}

for(const transport of ["websocket","polling"] as const)test("bound helper aliases of one native UDP peer keep distinct reply identities, "+transport,async()=>{
    const native=createSocket("udp4"),seen:number[]=[];
    native.on("message",(bytes,remote)=>{seen.push(remote.port);native.send(bytes,remote.port,remote.address);});
    await new Promise<void>((resolve,reject)=>{native.once("error",reject);native.bind(0,"127.0.0.1",resolve);});
    const remotePort=native.address().port,ips=[Uint8Array.of(203,0,113,151),Uint8Array.of(203,0,113,152)];
    const server=createLanServer({port:0,gateway:{nativeUdpHelperPath:await buildBoundUdpHelper(),routes:ips.map(ip=>({host:"127.0.0.1",address:ip.join("."),ports:[remotePort],protocols:["udp" as const]}))}});
    const port=await server.listen(),network=new LanNetwork();
    const link=new RelayLink("http://127.0.0.1:"+port,"udp-native-alias",network,{transports:[transport]});
    network.attach(link);const table=new WsaSocketTable(network);
    try{
        await link.ready;
        const socket=table.socket(2);table.bind(socket,ipv4Address(new Uint8Array(4),47151));
        for(const index of [0,1,0]){
            const payload=Uint8Array.of(index,0x73);
            expect(await send(()=>table.send(socket,payload,ipv4Address(ips[index],remotePort)))).toBe(payload.length);
            await until(()=>table.readable(socket),"native alias reply");
            const reply=table.receive(socket,100);expect(reply.data).toEqual(payload);
            expect(reply.from.ip).toEqual(ips[index]);expect(reply.from.port).toBe(remotePort);
        }
        expect(seen.length).toBe(3);expect(seen[0]).not.toBe(seen[1]);expect(seen[2]).toBe(seen[0]);
        table.closesocket(socket);
        await until(async()=>await portFree(4,seen[0])&&await portFree(4,seen[1]),"all alias ports released");
        expect(link.connected).toBe(true);
    }finally{table.reset();network.attach(null);await server.close();await close(native);}
},20000);
