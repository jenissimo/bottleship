import {test,expect} from "bun:test";
import {createServer} from "node:net";
import {createLanServer} from "../../packages/lan/src/server";
import {RootNetworkNamespace,ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,label:string) {
    const end=Date.now()+5000;
    while(!await check()){if(Date.now()>end)throw Error("TCP namespace deadline: "+label);await pause(2);}
}
async function bindable(port:number):Promise<boolean> {
    const server=createServer();
    return new Promise(resolve=>{
        server.once("error",()=>resolve(false));
        server.listen({host:"127.0.0.1",port,exclusive:true},()=>server.close(()=>resolve(true)));
    });
}
for(const transport of ["websocket","polling"] as const)test("real TCP Host leases preserve root/child ownership and ignore late close, "+transport,async()=>{
    const allowedNodes=[[2,1,127,0,0,1]];
    const server=createLanServer({port:0,transports:[transport],gateway:{routes:[],tcpListeners:[{
        id:"game",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,
        allowedHosts:["127.0.0.1"],maxOwners:2,maxPending:2,
    }]}});
    const opens:Array<{id:number;localPort:number;generation:number}>=[];
    const opened:Array<{id:number;lease:number}>=[];
    let sendClosed:(id:number,lease:number)=>void=()=>{throw Error("not connected");};
    let connections=0;
    // Capability is injected only in this test: production READY stays unchanged.
    server.io.use((socket,next)=>{
        socket.onAnyOutgoing((event,...args)=>{
            if(event==="ready")args[0].tcpHostListenV1={listeners:[{id:"game",allowedNodes}]};
            if(event==="tcpHostOpened"&&args[1]?.leaseId)opened.push({id:args[0],lease:args[1].leaseId});
        });next();
    });
    server.io.on("connection",socket=>{
        connections++;
        socket.on("openTcpHost",(id,request)=>opens.push({id,localPort:request.localPort,generation:request.bindingGeneration}));
        sendClosed=(id,lease)=>socket.emit("tcpHostClosed",id,lease,{code:10054,message:"late stale close"});
    });
    const port=await server.listen(),network=new LanNetwork(),root=new RootNetworkNamespace(network,16,93001);
    const boot=root.createChild(93002),childNet=new LanNetwork(),child=new ChildProcessNetworkNamespace(childNet,boot.boot);
    const a={deliver(){}},b={deliver(){}};
    let rootLease:Awaited<ReturnType<LanNetwork["openTcpHost"]>>|undefined;
    let childLease:Awaited<ReturnType<LanNetwork["openTcpHost"]>>|undefined;
    try{
        await root.configure({serverUrl:"http://127.0.0.1:"+port,room:"tcp-namespace"});
        await until(()=>childNet.connected,"child connected");
        expect(childNet.tcpHostListenV1?.listeners).toEqual([{id:"game",allowedNodes}]);
        expect(network.bind(47126,a,2)).toBe(true);
        expect(childNet.bind(47127,b,2)).toBe(true);
        await child.barrier();
        rootLease=await network.openTcpHost(47126,"game");
        childLease=await childNet.openTcpHost(47127,"game");
        expect(connections).toBe(1);
        expect(opens.map(x=>x.localPort)).toEqual([47126,47127]);
        expect(rootLease.address.port).not.toBe(childLease.address.port);
        expect(await bindable(rootLease.address.port)).toBe(false);
        expect(await bindable(childLease.address.port)).toBe(false);
        const count=opens.length;
        const foreign=await child.openTcpHost({proto:2,localPort:47126,
            bindingGeneration:network.bindingGeneration(47126,2),listenerId:"game"}).then(()=>null,error=>error);
        expect(foreign).toMatchObject({code:10022});expect(opens).toHaveLength(count);
        await until(()=>opened.length===2,"server replies");
        const stale=opened[1];
        childLease.release();
        expect((await childLease.closed).code).toBe(995);
        await until(()=>bindable(childLease!.address.port),"child native listener closed");
        const relay=(root as unknown as {active:{link:{socket:{once(event:string,callback:()=>void):void}}}}).active.link.socket;
        let lateReceived=false;
        relay.once("tcpHostClosed",()=>{lateReceived=true;});
        sendClosed(stale.id,stale.lease);
        await until(()=>lateReceived,"late closed delivered to relay");
        await child.barrier();
        expect(rootLease.isLive()).toBe(true);expect(childLease.isLive()).toBe(false);
        expect(network.connected).toBe(true);expect(childNet.connected).toBe(true);
        expect(await bindable(rootLease.address.port)).toBe(false);
        rootLease.release();rootLease.release();
        await until(()=>bindable(rootLease!.address.port),"root native listener closed");
    }finally{
        childLease?.release();rootLease?.release();child.close();boot.close();
        network.unbind(47126,a,2);await root.close();await server.close();
    }
},15000);
