import {beforeAll,expect,test} from "bun:test";
import {createSocket} from "node:dgram";
import {spawn} from "node:child_process";
import {dirname,join} from "node:path";
import {buildNativeForTests,nativeTestHelper} from "../../packages/lan/native/testing";
import {createLanServer} from "../../packages/lan/src/server";
import {parseIpv6} from "../../packages/lan/src/ip-address";
import {internetChecksum} from "../../packages/lan/src/icmp-nat";
import {rawUdpPorts} from "../../packages/lan/src/raw-udp";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
import {WsaSocketTable,WsaFailure,WSA,ipv4Address,ipv6Address} from "../../src/worker/modules/wsa-network";
// Compiling the native helper can exceed the default 5 s hook budget under full-gate load.
beforeAll(buildNativeForTests, 120_000);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,reason:string):Promise<void>{
    const deadline=Date.now()+8000;while(!await check()){if(Date.now()>deadline)throw new Error("Timeout: "+reason);await pause(5);}
}
function code(fn:()=>unknown):number{try{fn();return 0;}catch(error){if(error instanceof WsaFailure)return error.code;throw error;}}
async function send(fn:()=>number):Promise<void>{
    await until(()=>{const result=code(fn);if(result===WSA.EWOULDBLOCK)return false;if(result)throw new Error("send failed "+result);return true;},"transport writable");
}
function udpPacket(source:Uint8Array,destination:Uint8Array,port:number,tag:number):Uint8Array{
    const bytes=Uint8Array.of(0xa0,0x33,port>>>8,port&255,0,12,0,0,tag,77,88,99);
    const family=source.length===4?4:6,prefix=family===4?12:40,pseudo=new Uint8Array(prefix+bytes.length);
    pseudo.set(source);pseudo.set(destination,source.length);
    if(family===4){pseudo[9]=17;pseudo[11]=bytes.length;}else{pseudo[35]=bytes.length;pseudo[39]=17;}
    pseudo.set(bytes,prefix);new DataView(bytes.buffer).setUint16(6,internetChecksum(pseudo)||65535);return bytes;
}
async function canBind(family:4|6,host:string,port:number):Promise<boolean>{
    const probe=createSocket(family===4?"udp4":"udp6");
    return new Promise(resolve=>{
        probe.once("error",()=>{try{probe.close();}catch{}resolve(false);});
        probe.bind(port,host,()=>probe.close(()=>resolve(true)));
    });
}
test("native UDP tuple oracle uses real IPv4/IPv6 reservations and independent full checksums",async()=>{
    const executable=join(dirname(nativeTestHelper),"test-udp-tuple"+(process.platform==="win32"?".exe":""));
    const result=await new Promise<{code:number|null;text:string}>((resolve,reject)=>{
        const child=spawn(executable,[],{stdio:["ignore","pipe","pipe"],windowsHide:true});let text="",errors="";
        const timer=setTimeout(()=>{child.kill();reject(new Error("Native tuple oracle timed out: "+errors));},8000);
        child.stdout.on("data",bytes=>{text=(text+String(bytes)).slice(-4096);});
        child.stderr.on("data",bytes=>{errors=(errors+String(bytes)).slice(-4096);});
        child.on("error",error=>{clearTimeout(timer);reject(error);});
        child.on("close",code=>{clearTimeout(timer);resolve({code,text});});
    });
    expect(result.code).toBe(0);expect(JSON.parse(result.text)).toEqual({checks:74,families:2});
},15000);
test("raw UDP parsing rejects fragments and unknown extension chains before opening sockets",()=>{
    expect(rawUdpPorts(Uint8Array.of(0,0,0xff,0xff,0,8,0,0),4,false)).toEqual({source:0,destination:65535});
    const ipv4=new Uint8Array(28);ipv4[0]=0x45;ipv4[9]=17;ipv4[6]=0x20;
    let failure:any;try{rawUdpPorts(ipv4,4,true);}catch(error){failure=error;}expect(failure.code).toBe(10045);
    const ipv6=new Uint8Array(48);ipv6[0]=0x60;ipv6[6]=44;
    try{rawUdpPorts(ipv6,6,true);}catch(error){failure=error;}expect(failure.code).toBe(10045);
    expect(()=>rawUdpPorts(new Uint8Array(7),6,false)).toThrow();
});
for(const family of [4,6] as const)for(const transport of ["websocket","polling"] as const)test("RAW UDP"+family+" tuple isolation, ordinary coexistence and cleanup over "+transport,async()=>{
    const host=family===4?"127.0.0.1":"::1",native=createSocket(family===4?"udp4":"udp6"),intruder=createSocket(family===4?"udp4":"udp6");
    const observed=new Map<number,number>();
    native.on("message",(bytes,peer)=>{observed.set(bytes[0],peer.port);native.send(bytes,peer.port,peer.address);});
    await new Promise<void>(resolve=>native.bind(0,host,resolve));
    const nativePort=native.address().port,address=family===4?"203.0.113.202":"2001:db8::202";
    const server=createLanServer({port:0,gateway:{nativeHelperPath:nativeTestHelper,routes:[
        {host,address,protocols:["raw","udp"],ipProtocols:[17],ports:[nativePort]},
    ]}});
    const port=await server.listen(),networks=[new LanNetwork(),new LanNetwork()];
    const tables=networks.map(network=>new WsaSocketTable(network));
    const links=networks.map((network,index)=>new RelayLink("http://127.0.0.1:"+port,"tuple-room-"+index,network,{transports:[transport]}));
    networks.forEach((network,index)=>network.attach(links[index]));
    const rawIp=family===4?Uint8Array.of(203,0,113,202):parseIpv6(address)!;
    const peer=(port:number)=>family===4?ipv4Address(rawIp,port):ipv6Address(rawIp,port);
    const raw=tables.map(table=>table.socket(3,family===4?2:23,17));
    const ordinary=tables.map((table,index)=>{
        const socket=table.socket(2,family===4?2:23);
        table.bind(socket,family===4?ipv4Address(networks[index].ipv4,41011):ipv6Address(networks[index].ipv6,41011));return socket;
    });
    try{
        await Promise.all(links.map(link=>link.ready));
        for(let index=0;index<2;index++){
            await send(()=>tables[index].send(ordinary[index],Uint8Array.of(33+index),peer(nativePort)));
            await until(()=>tables[index].readable(ordinary[index]),"ordinary UDP before raw flow");
            expect([...tables[index].receive(ordinary[index],100).data]).toEqual([33+index]);
            const bytes=udpPacket(family===4?networks[index].ipv4:networks[index].ipv6,rawIp,nativePort,17+index);
            await send(()=>tables[index].send(raw[index],bytes,peer(0)));
        }
        const allowed:boolean[]=[];
        for(let index=0;index<2;index++){
            await until(()=>tables[index].readable(raw[index]),"raw UDP reply or explicit native permission error");
            if(tables[index].get(raw[index]).error){
                expect(code(()=>tables[index].receive(raw[index],65535))).toBe(WSA.EACCES);allowed.push(false);
            }else{
                const packet=tables[index].receive(raw[index],65535),offset=family===4?(packet.data[0]&15)*4:0;
                const udp=packet.data.subarray(offset);
                expect([...udp.subarray(8)]).toEqual([17+index,77,88,99]);
                expect((udp[2]<<8)|udp[3]).toBe(41011);expect((udp[0]<<8)|udp[1]).toBe(nativePort);
                if(family===4)expect(packet.from.ip).toEqual(rawIp);else expect(packet.from.ip6).toEqual(rawIp);
                allowed.push(true);
            }
        }
        expect(allowed[0]).toBe(allowed[1]); // One host capability policy applies to both rooms.
        if(allowed[0]){
            expect(new Set([observed.get(17),observed.get(18),observed.get(33),observed.get(34)]).size).toBe(4);
            // Same native source IP, wrong source UDP port: never deliver it to either room.
            await new Promise<void>((resolve,reject)=>intruder.send(Uint8Array.of(201),observed.get(17)!,host,error=>error?reject(error):resolve()));
            await pause(50);expect(tables[0].readable(raw[0])).toBe(false);expect(tables[1].readable(raw[1])).toBe(false);
        }else{
            expect(observed.has(17)).toBe(false);expect(observed.has(18)).toBe(false);
        }
        for(let index=0;index<2;index++){
            await send(()=>tables[index].send(ordinary[index],Uint8Array.of(43+index),peer(nativePort)));
            await until(()=>tables[index].readable(ordinary[index]),"ordinary UDP remains independent of raw capability");
            expect([...tables[index].receive(ordinary[index],100).data]).toEqual([43+index]);
        }
        tables[0].reset();networks[0].attach(null);
        await until(()=>server.io.sockets.sockets.size===1,"first room disconnect cleanup");
        if(allowed[0])await until(()=>canBind(family,host,observed.get(17)!),"native raw UDP reservation released on disconnect");
        tables[1].reset();networks[1].attach(null);
        await until(()=>server.io.sockets.sockets.size===0,"second room reset/disconnect cleanup");
        if(allowed[1])await until(()=>canBind(family,host,observed.get(18)!),"second native reservation released");
    }finally{
        tables.forEach(table=>table.reset());networks.forEach(network=>network.attach(null));await server.close();
        await new Promise<void>(resolve=>native.close(()=>resolve()));try{intruder.close();}catch{}
    }
},25000);
