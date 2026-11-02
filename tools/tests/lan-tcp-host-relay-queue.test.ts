import {expect,test} from "bun:test";
import {createLanServer} from "../../packages/lan/src/server";
import {encodeTcpFrame,DATA} from "../../packages/lan/src/tcp-protocol";
import {PROTO_TCP} from "../../packages/lan/src/protocol";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {RelayLink} from "../../src/worker/net/relay-link";
import type {TcpHostLeaseRpc} from "../../src/worker/net/tcp-host-lease-rpc";

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string) {
    const deadline=Date.now()+5000;
    while (!check()) {if(Date.now()>=deadline)throw Error("Deadline: "+label);await pause(2);}
}
const reply=(leaseId:number)=>({leaseId,address:{node:[2,1,127,0,0,1],port:47624},allowedNodes:[[2,1,127,0,0,1]]});
for (const transport of ["websocket","polling"] as const) test("dormant TCP Host shares bounded reliable queue and owns late ACK, "+transport,async()=>{
    // Replace only the TCP control handlers on this owned real server so that
    // the request remains pending until the test deliberately supplies READY.
    const server=createLanServer({port:0,transports:[transport]});
    const seen:Array<[string,number]>=[];
    let sendReady:(id:number,leaseId:number)=>void=()=>{throw Error("not connected");};
    server.io.on("connection",socket=>{
        socket.removeAllListeners("openTcpHost");
        socket.removeAllListeners("cancelTcpHost");
        socket.removeAllListeners("releaseTcpHost");
        sendReady=(id,leaseId)=>socket.emit("tcpHostOpened",id,reply(leaseId));
        socket.on("openTcpHost",id=>{seen.push(["open",id]);});
        socket.on("cancelTcpHost",id=>{seen.push(["cancel",id]);});
        socket.on("releaseTcpHost",id=>{seen.push(["release",id]);});
    });
    const port=await server.listen();
    const net=new LanNetwork(Uint8Array.of(2,0,0,0,0,1)),link=new RelayLink("http://127.0.0.1:"+port,"tcp-host-queue",net,{transports:[transport]});
    net.attach(link);
    let blocked:{writable:boolean}|undefined;
    const endpoint={deliver(){}};
    try {
        await link.ready;
        expect(net.bind(49319,endpoint,PROTO_TCP)).toBe(true);
        // Explicitly reach the private dormant state: no public listen/feature path is enabled.
        const rpc=(link as unknown as {tcpHosts:TcpHostLeaseRpc}).tcpHosts;
        const abort=new AbortController();
        const first=rpc.open({proto:2,localPort:49319,bindingGeneration:1,listenerId:"game"},abort.signal);
        const firstResult=first.catch(error=>error);
        await until(()=>seen.some(([kind,id])=>kind==="open"&&id===1),"first request");
        const engine=link.socket.io.engine;
        await until(()=>engine.writeBuffer.length===0,"drain");
        blocked=engine.transport;blocked.writable=false;
        const node=Uint8Array.of(2,0,0,99,1,1);
        let accepted=0;
        while(net.send(49319,node,49320,encodeTcpFrame(DATA,1,2,0,Uint8Array.of(1)),PROTO_TCP)) {
            if(++accepted>256)throw Error("reliable queue is not bounded");
        }
        expect(accepted).toBe(255);
        abort.abort();
        expect(await firstResult).toMatchObject({code:995});
        expect(link.connected).toBe(true);
        blocked.writable=true;engine.emit("drain");
        await until(()=>seen.some(([kind,id])=>kind==="cancel"&&id===1),"queued cancel");
        sendReady(1,7);
        const second=rpc.open({proto:2,localPort:49319,bindingGeneration:2,listenerId:"game"});
        await until(()=>seen.some(([kind,id])=>kind==="open"&&id===2),"second request");
        sendReady(2,7);
        const lease=await second;
        expect(lease.isLive()).toBe(true);
        expect(seen.filter(([kind])=>kind==="release")).toHaveLength(0);
        lease.release();
        await until(()=>seen.some(([kind,id])=>kind==="release"&&id===7),"owned release");
        expect(seen.filter(([kind])=>kind==="release")).toEqual([["release",7]]);
    } finally {
        if(blocked)blocked.writable=true;
        net.reset();net.attach(null);link.close();
        await server.close();
    }
},15000);
