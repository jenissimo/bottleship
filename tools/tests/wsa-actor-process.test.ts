import { expect, test } from "bun:test";
import { RootNetworkNamespace } from "../../src/worker/core/network-namespace";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { createWsaActorTable } from "../../src/worker/modules/wsa-actor-table";
import { ipv4Address, WSA } from "../../src/worker/modules/wsa-network";
import { actorRequestFits } from "../../src/worker/modules/wsa-actor-protocol";
import { waitOperation } from "../../src/worker/modules/wsa-network-api";
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw Error("Actor readiness timeout");await delay(5);}}
function process(host:RootNetworkNamespace,pid:number){
    const lease=host.createChild(pid),worker=new Worker(new URL("./fixtures/wsa-actor-process-worker.ts",import.meta.url).href,{type:"module"});let sequence=0,closed=false;
    const pending=new Map<number,{resolve(value:any):void,reject(error:unknown):void,timer:ReturnType<typeof setTimeout>}>();
    const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
    worker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);if(data.error!==undefined)task.reject(data.error);else task.resolve(data.result);};
    const request=(message:object,ports:MessagePort[]=[])=>new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error("Actor process timed out"));},7000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,...message},ports);});
    const ready=request({boot:lease.boot},[lease.boot.port]);
    return{ready,call:(command:string,args:object={})=>request({command,args}),async close(){if(!closed){closed=true;worker.terminate();lease.close();for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error("Terminated"));}pending.clear();}await stopped;}};
}
test("the primary worker can use synchronous actor RPC while a killed creator leaves a reserved duplicate alive",async()=>{
    const network=new LanNetwork(Uint8Array.of(2,0,0,8,7,6)),host=new RootNetworkNamespace(network,16,1234),table=createWsaActorTable(network,host.socketActorClient());
    const first=process(host,5000),second=process(host,5001);
    try{
        await Promise.all([first.ready,second.ready]);const socket=await first.call("bind",{port:6201});
        const reserved=await first.call("duplicate",{socket,pid:1234});expect(reserved).toBeGreaterThan(0);
        await first.close(); // Terminate before importing, so the reserved target descriptor is the only reference.
        expect(table.importDuplicate(reserved)).toBe(reserved);expect(table.importDuplicate(reserved)).toBe(reserved);
        await expect(second.call("import",{socket:reserved})).rejects.toBe(WSA.ENOTSOCK);
        const sender=table.socket(2);expect(table.send(sender,Uint8Array.of(1,2,3),ipv4Address(network.ipv4,6201))).toBe(3);
        await until(()=>table.readable(reserved));expect(table.receive(reserved,8).data).toEqual(Uint8Array.of(1,2,3));
        await expect(second.call("bind",{port:6201})).rejects.toBe(WSA.EADDRINUSE);
        table.closesocket(reserved);expect(table.isValid(reserved)).toBe(false);expect(await second.call("bind",{port:6201})).toBeGreaterThan(0);
    }finally{table.reset();await first.close();await second.close();await host.close();}
},15000);
test("the same provider resets after process exit and renews its channel without reviving stale socket tokens",async()=>{
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,1234),table=createWsaActorTable(network,()=>host.socketActorClient());
    try{
        const old=table.socket(2),token=table.duplicate(old,1234),epoch=host.socketActorClient().epoch;
        await host.finishProcessLifetime();expect(()=>table.reset()).not.toThrow();
        expect(()=>host.socketActorClient()).toThrow();host.beginProcessLifetime();
        expect(host.socketActorClient().epoch).not.toBe(epoch);const current=table.socket(2);expect(table.isValid(current)).toBe(true);
        expect(table.isValid(old)).toBe(false);expect(()=>table.importDuplicate(token)).toThrow();
        table.reset();
    }finally{await host.close();}
},10000);
test("kernel handle view reads and writes a reserved duplicate without attaching it to provider cleanup",async()=>{
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,1234),table=createWsaActorTable(network,()=>host.socketActorClient());
    try{
        const source=table.socket(2),peer=table.socket(2),address=ipv4Address(network.ipv4,6211),remote=ipv4Address(network.ipv4,6212);
        table.bind(source,address);table.bind(peer,remote);table.connect(source,remote);
        const reserved=table.duplicate(source,1234),native=table.nativeHandleView;
        expect(native).toBe(table.nativeHandleView);expect(native.nativeHandleView).toBe(native);
        expect(native.get(reserved).type).toBe(2);
        table.send(peer,Uint8Array.of(1,2,3),address);
        await until(()=>native.readable(reserved));expect(native.receive(reserved,8).data).toEqual(Uint8Array.of(1,2,3));
        expect(native.send(reserved,Uint8Array.of(4,5,6))).toBe(3);
        await until(()=>table.readable(peer));expect(table.receive(peer,8).data).toEqual(Uint8Array.of(4,5,6));
        table.reset();expect(table.isValid(source)).toBe(false);expect(table.isValid(reserved)).toBe(true);
        const other=table.socket(2);expect(()=>table.bind(other,address)).toThrow();
        expect(table.importDuplicate(reserved)).toBe(reserved);expect(table.get(reserved).local?.port).toBe(6211);
        table.closesocket(reserved);expect(table.bind(other,address)).toBe(0);
    }finally{table.reset();await host.close();}
},10000);
test("a synchronous kernel handle wait survives provider cleanup while its reserved OS handle remains open",async()=>{
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,1234),table=createWsaActorTable(network,()=>host.socketActorClient());
    try{
        const source=table.socket(2),address=ipv4Address(network.ipv4,6213);table.bind(source,address);
        const reserved=table.duplicate(source,1234),native=table.nativeHandleView;
        const providerGeneration=table.generation,handleGeneration=native.generation;
        const pending=waitOperation(native,reserved,()=>native.receive(reserved,8),0,false,undefined,true);
        expect(pending).toBeInstanceOf(Promise);table.reset();
        expect(table.generation).not.toBe(providerGeneration);expect(native.generation).toBe(handleGeneration);
        expect(native.isValid(reserved)).toBe(true);
        const peer=table.socket(2);table.send(peer,Uint8Array.of(97,98,99),address);
        expect((await pending).data).toEqual(Uint8Array.of(97,98,99));table.importDuplicate(reserved);
    }finally{table.reset();await host.close();}
},10000);
test("actor request bounds reject oversized views and cyclic metadata before structured cloning",()=>{
    expect(actorRequestFits([1,new Uint8Array(65535)])).toBe(true);expect(actorRequestFits([1,new Uint8Array(65536)])).toBe(false);
    const cyclic:any={};cyclic.self=cyclic;expect(actorRequestFits([cyclic])).toBe(false);expect(actorRequestFits(Array(13).fill(0))).toBe(false);
});
