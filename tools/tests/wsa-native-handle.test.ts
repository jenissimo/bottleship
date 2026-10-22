import {expect,test} from "bun:test";
import {RootNetworkNamespace} from "../../src/worker/core/network-namespace";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {createWsaActorTable} from "../../src/worker/modules/wsa-actor-table";
import {ipv4Address,WsaFailure,WSA} from "../../src/worker/modules/wsa-network";
import {getWsaNativeSocketTable,getWsaSocketTable,getWsaProcessState,makeSocketExports,WsaStartupCount} from "../../src/worker/modules/wsa-stub-shared";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import type {Process} from "../../src/worker/core/process";
test("unrelated native handles do not create a provider or pretend to be socket resources",()=>{
    const owner={} as Process;
    for(const handle of [0,1,2,0x50000,0xffffffff,-1,NaN,1.5]){
        expect(getWsaNativeSocketTable(owner,handle)).toBeUndefined();expect(getWsaSocketTable(owner)).toBeUndefined();
    }
    expect(getWsaNativeSocketTable(owner,0x10000000)).toBeUndefined();
    const state=getWsaProcessState(owner);expect(state.counter.started).toBe(false);expect(state.table.isValid(0x10000000)).toBe(false);state.reset();
});
test("a kernel-only child validates its reserved SOCKET before Winsock startup, preserves OS handle lifetime and rejects a stale PID epoch",async()=>{
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,16,27001),lease=host.createChild(27002);
    const table=createWsaActorTable(network,()=>host.socketActorClient()),worker=new Worker(new URL("./fixtures/wsa-native-handle-worker.ts",import.meta.url).href,{type:"module"});
    const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
    let sequence=0;const pending=new Map<number,{resolve(value:any):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>();
    worker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);if(data.error)task.reject(Error(data.error));else task.resolve(data.result);};
    const request=(message:object,ports:MessagePort[]=[])=>new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error("Native handle worker timeout"));},7000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,...message},ports);});
    let closed=false;
    try{
        await request({boot:lease.boot},[lease.boot.port]);const source=table.socket(2),sender=table.socket(2),address=ipv4Address(network.ipv4,7621);
        table.bind(source,address);const handle=table.duplicate(source,27002);
        const expected={existed:false,valid:true,started:false,sameBase:true,nativeIsDifferent:true,sameProvider:true,type:2,foreign:false,denied:-1,error:10093,retained:true,cancelled:0};
        expect(await request({command:"lookup",handle,foreign:source})).toEqual(expected);
        table.send(sender,Uint8Array.of(97,98,99),address);expect(await request({command:"read",handle})).toEqual([97,98,99]);
        expect(await request({command:"epoch",handle})).toEqual({stale:true,started:false});
        const fresh=table.duplicate(source,27002);expect(await request({command:"lookup",handle:fresh,foreign:source})).toEqual({...expected,existed:true});
        // Closing an issued native handle leaves its pending operation alive while the source alias survives.
        expect(await request({command:"issue",handle:fresh})).toEqual({value:-1,error:997,internal:259,bytes:0,data:[0,0,0],signaled:false});
        expect(await request({command:"closeHandle",handle:fresh})).toEqual({value:0,valid:false,internal:259,bytes:0,data:[0,0,0],signaled:false});
        table.send(sender,Uint8Array.of(97,98,99),address);
        const waitStatus=async(expected:number)=>{const deadline=Date.now()+5000;for(;;){const value=await request({command:"status"});if(value.internal===expected)return value;if(Date.now()>deadline)throw Error("Native IO status timeout: "+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,2));}};
        expect(await waitStatus(0)).toEqual({internal:0,bytes:3,data:[97,98,99],signaled:true});
        expect(table.isValid(source)).toBe(true);expect(table.readable(source)).toBe(false);
        // A lease does not keep the physical socket alive after its final real handle is closed.
        const last=table.duplicate(source,27002);table.closesocket(source);
        expect((await request({command:"issue",handle:last})).error).toBe(997);
        await request({command:"closeHandle",handle:last});
        expect(await waitStatus(0xc0000120)).toEqual({internal:0xc0000120,bytes:0,data:[0,0,0],signaled:true});
        const source2=table.socket(2);table.bind(source2,address);
        const wsa=table.duplicate(source2,27002),cancelAlias=table.duplicate(source2,27002);
        expect(table.nativeHandleView.fileObjectId(source2)).toBeGreaterThan(0);
        expect(await request({command:"wsaIssue",handle:wsa})).toEqual({value:-1,error:997,internal:259,bytes:0,data:[0,0,0],signaled:false});
        expect((await request({command:"closeHandle",handle:wsa})).internal).toBe(259);
        const awaitingResult=request({command:"getResult",handle:cancelAlias});
        table.send(sender,Uint8Array.of(97,98,99),address);
        expect(await awaitingResult).toEqual({value:1,error:0,bytes:3,flags:0,internal:0,data:[97,98,99],signaled:true});
        const cancelled=table.duplicate(source2,27002);
        expect((await request({command:"issue",handle:cancelled})).error).toBe(997);
        await request({command:"closeHandle",handle:cancelled});
        const observing=request({command:"observe",handle:cancelAlias});
        expect(await request({command:"cancel",handle:cancelAlias})).toBe(1);
        expect(await observing).toEqual({bytes:0,flags:0,writes:[],error:995});
        expect(await waitStatus(0xc0000120)).toEqual({internal:0xc0000120,bytes:0,data:[0,0,0],signaled:true});
        table.send(sender,Uint8Array.of(4,5,6),address);const deadline=Date.now()+5000;
        while(!table.readable(source2)){if(Date.now()>deadline)throw Error("Cancelled native request consumed a packet");await new Promise(resolve=>setTimeout(resolve,2));}
        expect([...table.receive(source2,16).data]).toEqual([4,5,6]);
        expect(await request({command:"close"})).toBe(true);closed=true;
    }finally{
        if(!closed){try{await request({command:"close"});}catch{}}
        worker.terminate();lease.close();for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error("Closed"));}pending.clear();
        await stopped;table.reset();await host.close();
    }
},20000);
test("extension APIs keep their physical streams after closing listener, target and connecting aliases in another worker",async()=>{
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,16,27101),lease=host.createChild(27102);
    const table=createWsaActorTable(network,()=>host.socketActorClient()),worker=new Worker(new URL("./fixtures/wsa-native-handle-worker.ts",import.meta.url).href,{type:"module"});
    const stopped=new Promise<void>(resolve=>worker.addEventListener("close",()=>resolve(),{once:true}));
    let sequence=0;const pending=new Map<number,{resolve(value:any):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>}>();
    worker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);if(data.error)task.reject(Error(data.error));else task.resolve(data.result);};
    const request=(message:object,ports:MessagePort[]=[])=>new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error("Extension worker timeout"));},7000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,...message},ports);});
    const waitUntil=async(predicate:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+5000;while(!await predicate()){if(Date.now()>deadline)throw Error("Extension readiness timeout");await new Promise(resolve=>setTimeout(resolve,2));}};
    const memory=new Uint8Array(8192);Mem.bind(()=>memory);const view=new DataView(memory.buffer),counter=new WsaStartupCount();counter.startup();
    let error=0;const api=makeSocketExports(table,value=>{error=value;},counter),call=(name:string,args:number[])=>api[name]({} as never,memory,args);
    let closed=false;
    try{
        await request({boot:lease.boot},[lease.boot.port]);
        for(let mode=0;mode<3;mode++){
            const listener=table.socket(),target=table.socket(),client=table.socket(),address=ipv4Address(network.ipv4,7721+mode);
            table.bind(listener,address);table.listen(listener);
            const rawListener=table.duplicate(listener,27102),rawTarget=table.duplicate(target,27102);
            expect(await request({command:"extensionAccept",handle:rawListener,target:rawTarget})).toEqual({value:0,error:997,internal:259,bytes:0,data:[0,0,0],signaled:false});
            if(mode!==1)await request({command:"closeHandle",handle:rawListener});
            if(mode!==0)await request({command:"closeHandle",handle:rawTarget});
            try{table.connect(client,address);}catch(error){if(!(error instanceof WsaFailure)||error.code!==WSA.EWOULDBLOCK)throw error;}
            await waitUntil(()=>table.isConnected(client));table.send(client,Uint8Array.of(97,98,99));
            let result:any;await waitUntil(async()=>{result=await request({command:"status"});return result.internal!==259;});
            expect(result).toEqual({internal:0,bytes:3,data:[97,98,99],signaled:true});
            view.setUint32(0x204,16,true);expect(call("getsockname",[target,0x100,0x204])).toBe(-1);expect(error).toBe(10022);
            view.setUint32(0x200,listener,true);expect(call("setsockopt",[target,0xffff,0x700b,0x200,4])).toBe(0);
            table.send(target,Uint8Array.of(122));await waitUntil(()=>table.readable(client));expect([...table.receive(client,1).data]).toEqual([122]);
            if(mode===0)await request({command:"closeHandle",handle:rawTarget});
            if(mode===1)await request({command:"closeHandle",handle:rawListener});
            table.closesocket(client);table.closesocket(target);table.closesocket(listener);
        }
        const listener=table.socket(),source=table.socket(),address=ipv4Address(network.ipv4,7730),length=512*1024;
        table.get(listener).receiveLimit=4096;table.bind(listener,address);table.listen(listener);table.bind(source,ipv4Address(Uint8Array.of(0,0,0,0),0));
        const raw=table.duplicate(source,27102),answer=await request({command:"extensionConnect",handle:raw,ip:[...network.ipv4],port:address.port,length});
        expect(answer.value).toBe(0);expect(answer.error).toBe(997);await request({command:"closeHandle",handle:raw});
        await waitUntil(()=>table.readable(listener));const peer=table.accept(listener);
        let total=0,hash=2166136261>>>0;
        await waitUntil(()=>{while(table.readable(peer)&&total<length){const bytes=table.receive(peer,16384).data;for(const value of bytes)hash=Math.imul(hash^value,16777619)>>>0;total+=bytes.length;if(!bytes.length)throw Error("Premature ConnectEx EOF");}return total===length;});
        expect(total).toBe(length);expect(hash|0).toBe(-544636347);
        let result:any;await waitUntil(async()=>{result=await request({command:"status"});return result.internal!==259;});
        expect(result.internal).toBe(0);expect(result.bytes).toBe(length);expect(result.signaled).toBe(true);
        view.setUint32(0x204,16,true);expect(call("getsockname",[source,0x100,0x204])).toBe(0);
        expect(call("setsockopt",[source,0xffff,0x7010,0,0])).toBe(0);
        const transmitAlias=table.duplicate(source,27102),transmit=await request({command:"extensionTransmit",handle:transmitAlias,length});
        expect(transmit.value).toBe(0);expect(transmit.error).toBe(997);await request({command:"closeHandle",handle:transmitAlias});
        total=0;hash=2166136261>>>0;
        await waitUntil(()=>{while(table.readable(peer)&&total<length){const bytes=table.receive(peer,16384).data;for(const value of bytes)hash=Math.imul(hash^value,16777619)>>>0;total+=bytes.length;if(!bytes.length)throw Error("Premature TransmitFile EOF");}return total===length;});
        expect(total).toBe(length);expect(hash|0).toBe(-544636347);
        await waitUntil(async()=>{result=await request({command:"status"});return result.internal!==259;});
        expect(result.internal).toBe(0);expect(result.bytes).toBe(length);expect(result.signaled).toBe(true);
        expect(await request({command:"close"})).toBe(true);closed=true;
    }finally{
        if(!closed){try{await request({command:"close"});}catch{}}
        worker.terminate();lease.close();for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error("Closed"));}pending.clear();
        await stopped;table.reset();await host.close();
    }
},20000);
