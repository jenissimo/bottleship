import {expect,test} from "bun:test";
import {createConnection,type Socket as NativeSocket} from "node:net";
import {once} from "node:events";
import {io} from "socket.io-client";
import {createLanServer} from "../../packages/lan/src/server";
import {asBytes,decodeDatagram,encodeDatagram} from "../../packages/lan/src/protocol";
import {CREDIT,DATA,FIN,SYN,SYNACK,TCP_WINDOW,decodeTcpFrame,encodeTcpFrame} from "../../packages/lan/src/tcp-protocol";

async function bounded<T>(p:Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("deadline")),5000);})]);}
    finally{clearTimeout(timer);}
}
for(const transport of ["websocket","polling"] as const)test("opt-in server handles native TCP child after listener release, "+transport,async()=>{
    const server=createLanServer({port:0,gateway:{routes:[],tcpListeners:[{
        id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,
        allowedHosts:["127.0.0.1"],maxPending:2,
    }]}});
    const serverPort=await server.listen();
    const socket=io("http://127.0.0.1:"+serverPort,{transports:[transport],forceNew:true,reconnection:false,
        auth:{version:1,room:"tcp-owner",clientId:"tcp-owner-client-0000001",node:[2,0,0,0,0,1]}});
    const frames:Array<Uint8Array>=[],waiters:Array<(v:Uint8Array)=>void>=[];
    socket.on("frame",(input:unknown,generation:unknown)=>{
        expect(generation).toBe(1);
        const data=asBytes(input);if(!data)throw Error("invalid frame");
        const next=waiters.shift();if(next)next(data.slice());else frames.push(data.slice());
    });
    const nextFrame=()=>bounded(new Promise<Uint8Array>(resolve=>{const f=frames.shift();if(f)resolve(f);else waiters.push(resolve);}));
    let peer:NativeSocket|undefined;
    try{
        const [ready]=await bounded(once(socket,"ready"));
        expect(ready.tcpHostListenV1).toBeUndefined();
        const openedPromise=bounded(once(socket,"tcpHostOpened"));
        socket.emit("openTcpHost",1,{proto:2,localPort:2302,bindingGeneration:1,listenerId:"game"});
        const [id,opened]=await openedPromise;
        expect(id).toBe(1);expect(opened.error).toBeUndefined();
        peer=createConnection({host:"127.0.0.1",port:opened.address.port,allowHalfOpen:true});
        await bounded(once(peer,"connect"));
        const synDatagram=decodeDatagram(await nextFrame())!,syn=decodeTcpFrame(synDatagram.payload)!;
        expect(syn.kind).toBe(SYN);expect(syn.dstId).toBe(0);
        const send=(kind:number,data=new Uint8Array(),value=0)=>{
            socket.emit("frame",encodeDatagram(2,synDatagram.node,synDatagram.srcPort,2302,
                encodeTcpFrame(kind,77,syn.srcId,value,data)),1);
        };
        const gotData=bounded(once(peer,"data"));
        send(SYNACK,new Uint8Array(),TCP_WINDOW);
        send(DATA,Uint8Array.of(1,2,3));
        socket.emit("releaseTcpHost",opened.leaseId);
        const [first]=await gotData;expect([...first]).toEqual([1,2,3]);
        const credit=decodeTcpFrame(decodeDatagram(await nextFrame())!.payload)!;expect(credit.kind).toBe(CREDIT);
        peer.write(Uint8Array.of(4,5));
        const reply=decodeTcpFrame(decodeDatagram(await nextFrame())!.payload)!;
        expect(reply.kind).toBe(DATA);expect([...reply.data]).toEqual([4,5]);
        send(CREDIT,new Uint8Array(),2);
        const ended=bounded(once(peer,"end"));send(FIN);await ended;peer.end();
        const fin=decodeTcpFrame(decodeDatagram(await nextFrame())!.payload)!;expect(fin.kind).toBe(FIN);
        socket.emit("releasePort",2,2302,1);
    }finally{peer?.destroy();socket.disconnect();await server.close();}
},15000);
