import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Process } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { installWsaBlockingHooks } from "../../src/worker/modules/wsa-blocking";
import { WsaStartupCount, makeSocketExports, type WsaProcessState } from "../../src/worker/modules/wsa-stub-shared";
import { WsaSocketTable, WSA, ipv4Address } from "../../src/worker/modules/wsa-network";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";
import type { WsaErrorSetter } from "../../src/worker/modules/wsa-network-api";
const cleanup:Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(fn=>fn());});
const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
function fixture(version=0x101) {
    let memory=new Uint8Array(1024*1024),tid=11,allocation=0x20000,stubId=0;
    const network=new LanNetwork(new Uint8Array([2,0,0,1,2,3])),table=new WsaSocketTable(network),errors=new Map<number,number>();
    const counter=new WsaStartupCount(()=>table.reset());counter.startup(version);
    const setter:WsaErrorSetter=code=>{errors.set(tid,code);};
    setter.capture=()=>{const id=tid,sink=table.blockingErrorSink;return code=>{if(sink)sink(code);else errors.set(id,code);};};
    const state:WsaProcessState={table,counter,setError:setter,getError:()=>errors.get(tid)??0,reset:()=>{table.reset();counter.reset();}};
    const owner=Object.create(Process.prototype) as Process, registry=new Map<string,ThunkImplementation>(),addresses=new Map<string,number>();
    let done!:(value:number)=>number|null,frames=0,stackCleanup=0;
    (owner as any).memory={alloc(size:number){const address=allocation;allocation+=size+16;return address;},free(){}};
    (owner as any).getCurrentMemory=()=>memory;
    (owner as any).addressSpace={validateRange:(address:number,size:number)=>address>0&&address+size<=memory.length,
        write:(address:number,data:Uint8Array)=>{memory.set(data,address);return data.length;}};
    (owner as any).thunkGenerator={getExportAddress:(name:string)=>addresses.get(name)??0,
        allocateOneStub(dll:string,name:string){const address=0x10000+(stubId++)*16;addresses.set(dll+":"+name,address);return{address,code:Uint8Array.of(0xc3)};}};
    (owner as any).dispatcher={register(_dll:string,name:string,fn:ThunkImplementation){registry.set(name,fn);},
        callbackManager:{saveSuspendedThunkContext(_ctx:unknown,bytes:number){frames++;stackCleanup=bytes;return 7;},
            invokeCallback(_address:number,_args:number[],_cleanup:number,complete:typeof done){done=complete;return{callbackId:9};},
            abandonSuspendedFrame(){}}};
    const spy=spyOn(System.getInstance().scheduler,"getCurrentThreadId").mockImplementation(()=>tid);
    cleanup.push(()=>{state.reset();spy.mockRestore();});
    Mem.bind(()=>memory);const api=makeSocketExports(table,setter,counter,owner);
    const functions=[["recv",4],["select",5],["WSASetBlockingHook",1],["WSAUnhookBlockingHook",0],["WSACancelBlockingCall",0],["WSAIsBlocking",0]]
        .map(([name,count])=>({name,params:Array.from({length:count as number},()=>({name:"arg",type:"u32"}))}));
    installWsaBlockingHooks(api,{name:"wsock32",functions} as never,state,owner);
    const call=(name:string,args:number[]=[])=>api[name]({esp:0x300} as never,memory,args);
    const internal=(name:string)=>registry.get(name)!({} as never,memory,[]);
    const rx=table.socket(2),tx=table.socket(2);table.bind(rx,ipv4Address(network.ipv4,4444));
    return{table,state,call,internal,rx,tx,memory:()=>memory,done:()=>done(0),frames:()=>frames,cleanup:()=>stackCleanup,
        thread:(id:number)=>{tid=id;},grow:()=>{const next=new Uint8Array(memory.length*2);next.set(memory);memory=next;},
        send:()=>table.send(tx,Uint8Array.of(1,2,3),ipv4Address(network.ipv4,4444))};
}
describe("Winsock 1.1 blocking hook contracts",()=>{
    test("2.2 rejects legacy hooks, whereas 1.1 keeps hooks per thread and returns the previous callable pointer",()=>{
        const modern=fixture(0x202);
        expect(modern.call("WSASetBlockingHook",[0x500])).toBe(0);expect(modern.state.getError()).toBe(WSA.EOPNOTSUPP);
        expect(modern.call("WSACancelBlockingCall")).toBe(-1);expect(modern.state.getError()).toBe(WSA.EOPNOTSUPP);
        expect(modern.call("WSAUnhookBlockingHook")).toBe(-1);
        const h=fixture(),previous=h.call("WSASetBlockingHook",[0x500]);
        expect(previous).toBeGreaterThan(0);expect(h.call("WSASetBlockingHook",[0x600])).toBe(0x500);
        h.thread(22);expect(h.call("WSASetBlockingHook",[0x700])).toBe(previous);
        h.thread(11);expect(h.call("WSASetBlockingHook",[0x500])).toBe(0x600);expect(h.state.getError()).toBe(0);
        expect(h.call("WSACancelBlockingCall")).toBe(-1);expect(h.state.getError()).toBe(WSA.EINVAL);
    });
    test("a custom hook runs as a suspended owner callback, while its wait parks and publishes only on the final owner return",async()=>{
        const h=fixture();h.call("WSASetBlockingHook",[0x500]);
        const result:any=h.call("recv",[h.rx,0x1000,8,0]);expect(result.suspendedForCallback).toBe(true);expect(h.cleanup()).toBe(16);
        expect(h.internal("LegacyBeforeBlockingHook")).toBe(0x500);expect(h.call("WSAIsBlocking")).toBe(1);
        const wait=h.internal("LegacyWaitBlockingProgress");expect(wait).toBeInstanceOf(Promise);expect(h.call("WSAIsBlocking")).toBe(0);
        h.grow();h.thread(22);const foreign=new Uint8Array(h.memory().length).fill(0x77);Mem.bind(()=>foreign);h.send();await tick();
        expect(await wait).toBe(1);expect(h.memory()[0x1000]).toBe(0);
        h.thread(11);expect(h.done()).toBe(3);expect([...h.memory().slice(0x1000,0x1003)]).toEqual([1,2,3]);expect(foreign[0x1000]).toBe(0x77);
    });
    test("only the issuing hook can cancel; EINTR publishes after return and the late packet remains available",async()=>{
        const h=fixture();h.call("WSASetBlockingHook",[0x500]);h.memory()[0x1000]=85;
        h.call("recv",[h.rx,0x1000,8,0]);h.internal("LegacyBeforeBlockingHook");
        h.thread(22);expect(h.call("WSACancelBlockingCall")).toBe(-1);expect(h.state.getError()).toBe(WSA.EINVAL);
        h.thread(11);expect(h.call("WSACancelBlockingCall")).toBe(0);expect(h.state.getError()).toBe(0);
        const wait=h.internal("LegacyWaitBlockingProgress");await tick();expect(await wait).toBe(1);
        expect(h.done()).toBe(-1);expect(h.state.getError()).toBe(WSA.EINTR);expect(h.memory()[0x1000]).toBe(85);
        h.send();expect([...h.table.receive(h.rx,8).data]).toEqual([1,2,3]);
    });
    test("restoring the default pointer keeps normal waits and startup versions retain the oldest requirement until final cleanup",async()=>{
        const h=fixture(),previous=h.call("WSASetBlockingHook",[0x500]) as number;
        h.call("WSASetBlockingHook",[previous]);const waiting=h.call("recv",[h.rx,0x1000,8,0]);
        expect(waiting).toBeInstanceOf(Promise);expect(h.frames()).toBe(0);h.send();expect((await waiting as any).value).toBe(3);
        h.state.counter.startup(0x202);expect(h.state.counter.version).toBe(0x101);h.state.counter.cleanup();expect(h.state.counter.version).toBe(0x101);
        h.state.counter.cleanup();expect(h.state.counter.version).toBe(0x202);
    });
});
