import {expect,test} from "bun:test";
import {createServer, createConnection, type Socket} from "node:net";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {decodeDatagram, decodeTcpFrame, encodeDatagram, encodeTcpFrame, PROTO_TCP, PROTO_UDP, SYN, SYNACK, DATA, FIN, RST, CREDIT, TCP_WINDOW} from "../../src/worker/net/netplay-wire";
import {WsaSocketTable, WsaFailure, WSA} from "../../src/worker/modules/wsa-network";
import {discoverNativeSessions} from "../../src/worker/modules/dplayx/native-wire/lan-discovery";
import {nativeEnumTcpPort} from "../../src/worker/modules/dplayx/native-wire/connection";

const remote=Uint8Array.of(2,1,192,0,2,1);
const address={family:2,node:remote,ip:Uint8Array.of(192,0,2,1),port:47624};
const octets=(hex:string)=>Uint8Array.from(Buffer.from(hex.replace(/\s/g,""),"hex"));
const header=octets("60f518132c91d0119daa00a0c90a43cb 04000000 18000000");
const portChunk=octets("414552e4a58ed1118a96006097b01411 02000000 3412");

function fixture(onFrame:(network:LanNetwork, frame:Uint8Array)=>void) {
    const network=new LanNetwork(Uint8Array.of(2,0,0,1,2,3)), packets:Uint8Array[]=[];
    const allowed=[[2,1,127,0,0,1]];let released=false;
    let end!: (x:{code:number;message:string})=>void;
    const closed=new Promise<{code:number;message:string}>(ok=>{end=ok;});
    network.attach({connected:true,close(){},send(frame){packets.push(frame.slice());onFrame(network,frame);return true;},
        async openTcpHost(){let live=true;return {address:{node:allowed[0],port:2309},allowedNodes:allowed,
            isLive:()=>live,closed,release(){if(live){live=false;released=true;end({code:10054,message:"closed"});}}};}});
    network.configureGatewayAddresses([[192,0,2,1]]);
    network.configureTcpHosts({listeners:[{id:"game",allowedNodes:allowed}]});
    network.configureWinsock({provider:"native",hostListener:"game"});
    const table=new WsaSocketTable(network);
    return {network,table,packets,released:()=>released};
}
const request=(tcpPort:number,signal?:AbortSignal)=>({applicationGuid:new Uint8Array(16),flags:0,
    destination:address,tcpPort,timeoutMs:120,maxFrameBytes:1024,signal});

test("TCP port decodes source WORD little endian and last INetPort wins",()=>{
    expect(nativeEnumTcpPort(header)).toBe(47624);
    const twice=new Uint8Array(header.length+portChunk.length*2);
    twice.set(header);twice.set(portChunk,header.length);twice.set(portChunk,header.length+portChunk.length);
    twice[twice.length-2]=0x78;twice[twice.length-1]=0x56;
    expect(nativeEnumTcpPort(twice)).toBe(0x5678);
    twice[twice.length-2]=0;twice[twice.length-1]=0;
    expect(nativeEnumTcpPort(twice)).toBe(47624);
    const short=twice.slice(0,header.length+portChunk.length-1);
    new DataView(short.buffer).setUint32(header.length+16,1,true);
    expect(nativeEnumTcpPort(short)).toBeUndefined();
});
test("mocked flow retries partial TCP writes and sends exact UDP bytes before FIN",async()=>{
    const wire: number[]=[], kinds:number[]=[];
    const f=fixture((net,raw)=>{
        const dg=decodeDatagram(raw);if(!dg || dg.proto!==PROTO_TCP)return;
        const frame=decodeTcpFrame(dg.payload);if(!frame)return;
        kinds.push(frame.kind);
        const incoming=(kind:number,value=0)=>net.receiveFrame(encodeDatagram(PROTO_TCP,remote,dg.srcPort,dg.dstPort,encodeTcpFrame(kind,90,frame.srcId,value)));
        if(frame.kind===SYN) queueMicrotask(()=>incoming(SYNACK,TCP_WINDOW));
        if(frame.kind===DATA){wire.push(...frame.data);queueMicrotask(()=>incoming(CREDIT,frame.data.length));}
    });
    const actualSend=f.table.send.bind(f.table);let calls=0;
    f.table.send=(sid,bytes,to,flags)=>{
        if(bytes instanceof Uint8Array && f.table.get(sid).type===1){
            if(++calls===2){setTimeout(()=>f.network.notifyWritable(),0);throw new WsaFailure(WSA.EWOULDBLOCK);}
            return actualSend(sid,bytes.subarray(0,7),to,flags);
        }
        return actualSend(sid,bytes,to,flags);
    };
    try {
        expect(await discoverNativeSessions(f.table,request(5123))).toEqual([]);
        const udp=f.packets.map(decodeDatagram).find(d=>d?.proto===PROTO_UDP)!;
        expect(wire).toEqual([...udp.payload]);
        expect(kinds).toContain(FIN);
        expect(kinds.indexOf(FIN)).toBeGreaterThan(kinds.lastIndexOf(DATA));
        expect(calls).toBeGreaterThan(2);expect(f.released()).toBe(true);
    } finally {f.table.reset();}
});
test("TCP connect refusal is isolated from successful UDP discovery",async()=>{
    const f=fixture((net,raw)=>{
        const dg=decodeDatagram(raw);if(!dg || dg.proto!==PROTO_TCP)return;
        const frame=decodeTcpFrame(dg.payload);
        if(frame?.kind===SYN) queueMicrotask(()=>net.receiveFrame(encodeDatagram(PROTO_TCP,remote,dg.srcPort,dg.dstPort,encodeTcpFrame(RST,90,frame.srcId,WSA.ECONNREFUSED))));
    });
    try { expect(await discoverNativeSessions(f.table,request(5123))).toEqual([]);
        expect(f.packets.map(decodeDatagram).some(d=>d?.proto===PROTO_UDP)).toBe(true);
        expect(f.released()).toBe(true);
    } finally {f.table.reset();}
});

test("cancellation closes connecting socket and ignores its late SYNACK",async()=>{
    let syn: ReturnType<typeof decodeDatagram> = null;
    const f=fixture((_net,raw)=>{
        const dg=decodeDatagram(raw);
        if(dg?.proto===PROTO_TCP && decodeTcpFrame(dg.payload)?.kind===SYN) syn=dg;
    });
    const controller=new AbortController();
    try {
        const result=discoverNativeSessions(f.table,request(5123,controller.signal));
        for(let i=0;i<10 && !syn;i++) await new Promise(resolve=>setTimeout(resolve,2));
        expect(syn).not.toBeNull();
        const stream=f.table.get(0x10000002), oldWire=stream.wireId;
        controller.abort();
        await expect(result).rejects.toThrow("cancelled");
        expect(f.table.isValid(stream.id)).toBe(false);
        f.network.receiveFrame(encodeDatagram(PROTO_TCP,remote,syn!.srcPort,syn!.dstPort,encodeTcpFrame(SYNACK,90,oldWire,TCP_WINDOW)));
        await new Promise(resolve=>setTimeout(resolve,5));
        const data=f.packets.map(decodeDatagram).filter(d=>d?.proto===PROTO_TCP)
            .map(d=>decodeTcpFrame(d!.payload)).filter(frame=>frame?.kind===DATA);
        expect(data).toHaveLength(0);expect(f.released()).toBe(true);
    } finally {f.table.reset();}
});

test("real loopback TCP receives source-derived request while UDP path remains separate",async()=>{
    let received!: (data:Uint8Array)=>void;
    const complete=new Promise<Uint8Array>(ok=>{received=ok;});
    const server=createServer(socket=>{const chunks:Uint8Array[]=[];socket.on("data",part=>chunks.push(Uint8Array.from(part)));
        socket.on("end",()=>received(Uint8Array.from(Buffer.concat(chunks))));});
    await new Promise<void>(ok=>server.listen(0,"127.0.0.1",ok));
    const port=(server.address() as {port:number}).port;
    let socket:Socket|undefined;
    const f=fixture((net,raw)=>{
        const dg=decodeDatagram(raw);if(!dg || dg.proto!==PROTO_TCP)return;
        const frame=decodeTcpFrame(dg.payload);if(!frame)return;
        const incoming=(kind:number,value=0)=>net.receiveFrame(encodeDatagram(PROTO_TCP,remote,dg.srcPort,dg.dstPort,encodeTcpFrame(kind,90,frame.srcId,value)));
        if(frame.kind===SYN){socket=createConnection({host:"127.0.0.1",port},()=>incoming(SYNACK,TCP_WINDOW));socket.on("error",()=>incoming(RST,WSA.ECONNREFUSED));}
        if(frame.kind===DATA){socket!.write(frame.data);queueMicrotask(()=>incoming(CREDIT,frame.data.length));}
        if(frame.kind===FIN) socket!.end();
        if(frame.kind===RST) socket?.destroy();
    });
    try {
        const operation=discoverNativeSessions(f.table,request(port));
        const stream=await Promise.race([complete,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("loopback timeout")),3000))]);
        const udp=f.packets.map(decodeDatagram).find(d=>d?.proto===PROTO_UDP)!;
        expect(stream).toEqual(udp.payload);
        expect(await operation).toEqual([]);
    } finally {f.table.reset();socket?.destroy();await new Promise<void>(ok=>server.close(()=>ok()));}
},10000);
