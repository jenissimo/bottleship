import {expect,test} from "bun:test";
import {createLanServer} from "../../packages/lan/src/server";
import {RootNetworkNamespace,ChildProcessNetworkNamespace,type NetworkNamespaceBoot} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import type {TcpHostLease} from "../../src/worker/net/tcp-host-lease-rpc";

const allowedNodes=[[2,1,127,0,0,1]];
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string) {
    const end=Date.now()+5000;
    while(!check()){if(Date.now()>end)throw Error("Namespace race deadline: "+label);await pause(2);}
}
function providerLease() {
    let live=true,releases=0,releaseCalls=0,end!:(v:{code:number;message:string})=>void;
    const closed=new Promise<{code:number;message:string}>(resolve=>{end=resolve;});
    const lease:TcpHostLease={
        address:{node:[2,1,127,0,0,1],port:45678},allowedNodes,
        isLive:()=>live,closed,
        release(){releaseCalls++;if(!live)return;live=false;releases++;end({code:995,message:"released"});},
    };
    return {lease,releases:()=>releases,releaseCalls:()=>releaseCalls,fail:()=>{live=false;end({code:10054,message:"provider closed"});}};
}
class ServiceWorker extends EventTarget {
    static latest:ServiceWorker;
    boot!:NetworkNamespaceBoot;
    private ports:MessagePort[]=[];
    constructor(){super();ServiceWorker.latest=this;}
    postMessage(message:{network:NetworkNamespaceBoot;control:MessagePort}):void {
        this.boot=message.network;
        const control=message.control;this.ports.push(control,message.network.port);
        control.onmessage=event=>{
            const m=event.data;
            if(["shutdown","barrier","finish"].includes(m.type))
                control.postMessage({type:m.type==="shutdown"?"shutdownDone":m.type==="finish"?"finished":"barrierDone",id:m.id});
        };
        control.start();
    }
    unref():void {}
    terminate():void {for(const port of this.ports)port.close();this.dispatchEvent(new Event("close"));}
}
type Probe={
    active:{link:{openTcpHost:(...args:any[])=>Promise<TcpHostLease>}};
    state:(state:unknown)=>void;
};
async function setup(service=false) {
    const server=createLanServer({port:0});
    server.io.use((socket,next)=>{
        socket.onAnyOutgoing((event,...args)=>{
            if(event==="ready")args[0].tcpHostListenV1={listeners:[{id:"game",allowedNodes}]};
        });next();
    });
    const port=await server.listen(),network=new LanNetwork();
    let root:RootNetworkNamespace;
    if(service){
        const previous=globalThis.Worker;
        try{globalThis.Worker=ServiceWorker as unknown as typeof Worker;root=new RootNetworkNamespace(network,16,94001);}
        finally{globalThis.Worker=previous;}
    }else root=new RootNetworkNamespace(network,16,94001);
    await root.configure({serverUrl:"http://127.0.0.1:"+port,room:"tcp-race"});
    const probe=root as unknown as Probe;
    return {server,network,root,probe,async close(){
        try {await root.close();} catch(error) {if(!service)throw error;}
        finally {await server.close();}
    }};
}
test("root readiness publication rechecks provider liveness before returning a lease",async()=>{
    const f=await setup(),endpoint={deliver(){}},fake=providerLease();
    let called=false;
    try {
        expect(f.network.bind(47201,endpoint,2)).toBe(true);
        f.probe.active.link.openTcpHost=async()=>{called=true;return fake.lease;};
        const original=f.probe.state.bind(f.root);
        f.probe.state=state=>{original(state);if(called)fake.fail();};
        const result=await f.network.openTcpHost(47201,"game").then(()=>null,error=>error);
        expect(result).toMatchObject({code:10054});
        // A provider that already closed needs no physical release.
        expect(fake.lease.isLive()).toBe(false);
        expect(fake.releaseCalls()).toBe(1);
    }finally{f.network.unbind(47201,endpoint,2);await f.close();}
},10000);
test("child PID retirement before held READY prevents stale Opened and releases its lease",async()=>{
    const f=await setup(),boot=f.root.createChild(94002),net=new LanNetwork();
    const child=new ChildProcessNetworkNamespace(net,boot.boot),endpoint={deliver(){}},fake=providerLease();
    let resolve!:(lease:TcpHostLease)=>void,started=false;
    const held=new Promise<TcpHostLease>(done=>{resolve=done;});
    const seen:any[]=[];
    const original=boot.boot.port.onmessage!;
    boot.boot.port.onmessage=event=>{if(event.data?.type==="tcpHostOpened")seen.push(event.data);original.call(boot.boot.port,event);};
    try {
        await until(()=>net.connected,"child connected");
        expect(net.bind(47202,endpoint,2)).toBe(true);await child.barrier();
        f.probe.active.link.openTcpHost=()=>{started=true;return held;};
        const pending=net.openTcpHost(47202,"game").then(()=>({ok:true}),error=>({ok:false,error}));
        await until(()=>started,"provider request held");
        // Mark PID dead, but deliberately do not deliver actorDrop yet.
        Atomics.store(new Int32Array(boot.boot.shared),16+boot.boot.slot*8+6,0);
        resolve(fake.lease);
        await until(()=>fake.releases()===1,"stale physical lease released");
        await child.barrier();
        expect(seen.filter(event=>event.reply?.leaseId)).toHaveLength(0);
        child.close();await pending;
    }finally{child.close();boot.close();await f.close();}
},10000);
test("service PID zero can own TCP Host and actor death releases its lease",async()=>{
    const f=await setup(true),worker=ServiceWorker.latest,net=new LanNetwork();
    const service=new ChildProcessNetworkNamespace(net,worker.boot),endpoint={deliver(){}},fake=providerLease();
    try {
        expect(worker.boot.pid).toBe(0);
        await until(()=>net.connected,"service connected");
        expect(net.bind(47203,endpoint,2)).toBe(true);await service.barrier();
        f.probe.active.link.openTcpHost=async()=>fake.lease;
        const lease=await net.openTcpHost(47203,"game");
        expect(lease.isLive()).toBe(true);
        worker.dispatchEvent(new Event("error",{cancelable:true}));
        await until(()=>fake.releases()===1,"service actor physical lease released");
        expect(fake.lease.isLive()).toBe(false);
    }finally{service.close();await f.close();}
},10000);

test("child receives failure instead of Opened if provider closes during state publication",async()=>{
    const f=await setup(),boot=f.root.createChild(94003),net=new LanNetwork();
    const child=new ChildProcessNetworkNamespace(net,boot.boot),endpoint={deliver(){}},fake=providerLease();
    let called=false;
    try {
        await until(()=>net.connected,"child connected");
        expect(net.bind(47204,endpoint,2)).toBe(true);await child.barrier();
        f.probe.active.link.openTcpHost=async()=>{called=true;return fake.lease;};
        const original=f.probe.state.bind(f.root);
        f.probe.state=state=>{original(state);if(called)fake.fail();};
        const result=await net.openTcpHost(47204,"game").then(()=>null,error=>error);
        expect(result).toMatchObject({code:10054});
        expect(fake.releaseCalls()).toBe(1);
    }finally{child.close();boot.close();await f.close();}
},10000);
