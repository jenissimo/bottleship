import {beforeAll,expect,test} from "bun:test";
import {createSocket} from "node:dgram";
import {buildNativeForTests,nativeTestHelper} from "../../packages/lan/native/testing";
import {createLanServer} from "../../packages/lan/src/server";
import {parseIpv6} from "../../packages/lan/src/ip-address";
import {internetChecksum as checksum,setIcmpv6Checksum} from "../../packages/lan/src/icmp-nat";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
import {WsaSocketTable,WsaFailure,WSA,ipv4Address,ipv6Address} from "../../src/worker/modules/wsa-network";
beforeAll(buildNativeForTests);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,reason:string):Promise<void>{
    const deadline=Date.now()+8000;while(!check()){if(Date.now()>deadline)throw new Error("Timeout: "+reason);await pause(5);}
}
function code(fn:()=>unknown):number{try{fn();return 0;}catch(error){if(error instanceof WsaFailure)return error.code;throw error;}}
async function send(fn:()=>number):Promise<void>{await until(()=>{const result=code(fn);if(result===WSA.EWOULDBLOCK)return false;if(result)throw new Error("send failed "+result);return true;},"socket writable");}
for(const family of [4,6] as const)for(const transport of ["websocket","polling"] as const)test("generic native RAW"+family+" uses exclusive canonical target leases and releases them over "+transport,async()=>{
    const host=family===4?"127.0.0.1":"::1",protocol=family===4?1:58;
    const native=createSocket(family===4?"udp4":"udp6");let ordinaryPackets=0;
    native.on("message",(bytes,peer)=>{ordinaryPackets++;native.send(bytes,peer.port,peer.address);});
    await new Promise<void>(resolve=>native.bind(0,host,resolve));
    const nativePort=native.address().port;
    const server=createLanServer({port:0,gateway:{nativeHelperPath:nativeTestHelper,routes:[
        {host,address:family===4?"203.0.113.100":"2001:db8::100",protocols:["raw"],ipProtocols:[protocol,253],rawMode:"exclusive"},
        {host,address:"203.0.113.101",protocols:["udp"],ports:[nativePort]},
    ]}});
    const port=await server.listen(),a=new LanNetwork(),b=new LanNetwork();
    const linkA=new RelayLink("http://127.0.0.1:"+port,"raw-owner",a,{transports:[transport]});
    const linkB=new RelayLink("http://127.0.0.1:"+port,"foreign",b,{transports:[transport]});
    a.attach(linkA);b.attach(linkB);const first=new WsaSocketTable(a),second=new WsaSocketTable(b);
    const rawIp=family===4?Uint8Array.of(203,0,113,100):parseIpv6("2001:db8::100")!;
    const rawAddress=family===4?ipv4Address(rawIp,0):ipv6Address(rawIp,0),udpIp=Uint8Array.of(203,0,113,101);
    try{
        await Promise.all([linkA.ready,linkB.ready]);
        if(family===6)for(const wildcard of [0,255]){
            const unsupported=first.socket(3,23,wildcard);first.get(unsupported).headerInclude=true;
            const packet=new Uint8Array(48);packet[0]=0x60;packet[5]=8;packet[6]=58;packet[7]=128;
            packet.set(a.ipv6,8);packet.set(rawIp,24);packet[40]=128;
            await send(()=>first.send(unsupported,packet,rawAddress));
            await until(()=>first.readable(unsupported),"RAW6 cannot guess a wildcard next header");
            expect(code(()=>first.receive(unsupported,65535))).toBe(10045);first.closesocket(unsupported);
        }
        // Explicit exclusive mode bypasses echo identifier NAT and exercises the
        // generic OS RAW path, including address/checksum translation.
        const raw=first.socket(3,family===4?2:23,protocol),packet=Uint8Array.of(family===4?8:128,0,0,0,0x77,0x88,0,1,9,8,7,6);
        new DataView(packet.buffer).setUint16(2,checksum(packet));
        await send(()=>first.send(raw,packet,rawAddress));
        let received:ReturnType<WsaSocketTable["receive"]>|undefined;
        await until(()=>{
            if(first.get(raw).error)return true;
            while(first.bytesAvailable(raw)){
                const item=first.receive(raw,65535),offset=family===4?(item.data[0]&15)*4:0;
                if(item.data[offset]===(family===4?0:129)){received=item;return true;}
                expect(item.data[offset]).toBe(family===4?8:128); // Native loopback may also capture the request.
            }
            return false;
        },"native generic raw reply or permission failure");
        if(first.get(raw).error){
            expect(code(()=>first.receive(raw,65535))).toBe(WSA.EACCES);
        }else{
            const reply=received!,expected=packet.slice();expected[0]=family===4?0:129;expected[2]=expected[3]=0;
            if(family===4)new DataView(expected.buffer).setUint16(2,checksum(expected));else setIcmpv6Checksum(expected,rawIp,a.ipv6);
            expect(reply.data.subarray(family===4?20:0)).toEqual(expected);
            if(family===4){expect(reply.from.ip).toEqual(rawIp);expect(reply.data.subarray(12,16)).toEqual(rawIp);expect(reply.data.subarray(16,20)).toEqual(a.ipv4);expect(checksum(reply.data.subarray(0,20))).toBe(0);}
            else expect(reply.from.ip6).toEqual(rawIp);
            const blocked=second.socket(2);
            await send(()=>second.send(blocked,Uint8Array.of(1),ipv4Address(udpIp,nativePort)));
            await until(()=>second.readable(blocked),"foreign alias lease conflict");
            expect(code(()=>second.receive(blocked,100))).toBe(WSA.EADDRINUSE);
            expect(ordinaryPackets).toBe(0);second.closesocket(blocked);
        }
        first.closesocket(raw);
        await a.resolve(family===4?"203.0.113.100":"2001:db8::100",family);
        expect(linkA.connected).toBe(true);
        expect(server.io.sockets.sockets.size).toBe(2);
        const udp=second.socket(2);await send(()=>second.send(udp,Uint8Array.of(2,3),ipv4Address(udpIp,nativePort)));
        await until(()=>second.readable(udp),"native flow after last raw handle closes");
        expect(second.receive(udp,100).data).toEqual(Uint8Array.of(2,3));
        second.closesocket(udp);
        // Last-handle close releases native leases while both participants stay.
        await b.resolve("203.0.113.101",4);
        expect(linkB.connected).toBe(true);
        const c=new LanNetwork(),linkC=new RelayLink("http://127.0.0.1:"+port,"arbitrary",c,{transports:[transport]});
        c.attach(linkC);const arbitrary=new WsaSocketTable(c);
        try{
            await linkC.ready;
            const socket=arbitrary.socket(3,family===4?2:23,253),bytes=Uint8Array.of(11,22,33);
            await send(()=>arbitrary.send(socket,bytes,rawAddress));
            await until(()=>arbitrary.readable(socket),"arbitrary OS raw protocol capability");
            if(arbitrary.get(socket).error)expect(code(()=>arbitrary.receive(socket,65535))).toBe(WSA.EACCES);
            else expect(arbitrary.receive(socket,65535).data.subarray(family===4?20:0)).toEqual(bytes);
        }finally{arbitrary.reset();c.attach(null);}
    }finally{first.reset();second.reset();a.attach(null);b.attach(null);await server.close();await new Promise<void>(resolve=>native.close(()=>resolve()));}
},25000);
