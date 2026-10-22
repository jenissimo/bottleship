import {adoptProcessNetworkNamespace,getProcessNetworkNamespace,closeProcessNetworkNamespace} from "../../../src/worker/core/process-network";
import {getWsaSocketTable,getWsaNativeSocketTable,getWsaProcessState,hasWsaSocket,cancelWsaIo,makeSocketExports} from "../../../src/worker/modules/wsa-stub-shared";
import {getWsaOverlapped} from "../../../src/worker/modules/wsa-overlapped";
import {Process} from "../../../src/worker/core/process";
import {Mem} from "../../../src/worker/core/memory/mem-accessor";
import {System} from "../../../src/worker/core/system";
const owner=Object.create(Process.prototype) as Process;
const memory=new Uint8Array(2*1024*1024);Mem.bind(()=>memory);
Object.assign(owner,{resetGeneration:0,memory:{alloc(){return 0;},free(){}},getMemory:()=>memory,addressSpace:{
    validateRange:(ptr:number,length:number)=>ptr>0&&ptr+length<=memory.length,
    write:(ptr:number,bytes:Uint8Array)=>{if(ptr<=0||ptr+bytes.length>memory.length)return 0;memory.set(bytes,ptr);return bytes.length;},
}});
const word=(ptr:number,value:number)=>new DataView(memory.buffer).setUint32(ptr,value,true);
const get=(ptr:number)=>new DataView(memory.buffer).getUint32(ptr,true);
let event=0;
const status=()=>({internal:get(0x300),bytes:get(0x304),data:[...memory.slice(0x1000,0x1003)],
    signaled:!!(System.getInstance().resourceProvider.getKernelObject(event) as any)?.signaled});
Object.defineProperty(globalThis,"importScripts",{value:()=>{},configurable:true});
self.onmessage=async({data})=>{
    try{
        let result:unknown;
        if(data.boot){adoptProcessNetworkNamespace(data.boot);await getProcessNetworkNamespace().barrier();result=true;}
        else if(data.command==="lookup"){
            const existed=!!getWsaSocketTable(owner),valid=hasWsaSocket(owner,data.handle),table=getWsaNativeSocketTable(owner,data.handle);
            if(!valid||!table)throw Error("Reserved native handle was not found");
            const state=getWsaProcessState(owner);let error=0;
            const api=makeSocketExports(table,value=>{error=value;},state.counter,owner);
            const denied=api.send({} as never,memory,[data.handle,0x100,1,0]);
            const provider=getWsaOverlapped(table,owner);
            const type=table.nativeHandleView.get(data.handle).type;
            const foreign=hasWsaSocket(owner,data.foreign);
            state.counter.startup();state.counter.cleanup();
            result={existed,valid,started:state.counter.started,sameBase:table===getWsaSocketTable(owner),nativeIsDifferent:table!==table.nativeHandleView,
                sameProvider:provider===getWsaOverlapped(getWsaNativeSocketTable(owner,data.handle)!,owner),type,foreign,denied,error,
                retained:table.nativeHandleView.isValid(data.handle),cancelled:cancelWsaIo(owner,data.handle)};
        }else if(data.command==="read"){
            const table=getWsaNativeSocketTable(owner,data.handle)!;const deadline=Date.now()+5000;
            while(!table.nativeHandleView.readable(data.handle)){if(Date.now()>deadline)throw Error("Native handle packet timeout");await new Promise(resolve=>setTimeout(resolve,2));}
            result=[...table.nativeHandleView.receive(data.handle,16).data];
        }else if(data.command==="issue"){
            const table=getWsaNativeSocketTable(owner,data.handle)!;const io=table.acquireNativeIo(data.handle),provider=getWsaOverlapped(table,owner);
            if(event)System.getInstance().resourceProvider.unregisterKernelObject(event);
            event=System.getInstance().scheduler.createEvent(true,false);memory.fill(0,0x300,0x314);memory.fill(0,0x1000,0x1003);word(0x310,event);
            const answer=provider.issue(data.handle,0x300,0,"read",()=>{
                const packet=io.table.receive(data.handle,3);
                return{bytes:packet.data.length,flags:0,writes:[...packet.data].map((value,index)=>({address:0x1000+index,value,size:1 as const}))};
            },()=>[],true,undefined,{nativeIoLease:io});
            result={value:answer.value,error:answer.error,...status()};
        }else if(["extensionAccept","extensionConnect","extensionTransmit"].includes(data.command)){
            const table=getWsaNativeSocketTable(owner,data.handle)!,state=getWsaProcessState(owner);if(!state.counter.started)state.counter.startup();
            if(event)System.getInstance().resourceProvider.unregisterKernelObject(event);
            event=System.getInstance().scheduler.createEvent(true,false);memory.fill(0,0x300,0x314);word(0x310,event);
            let error=0;const api=makeSocketExports(table,value=>{error=value;},state.counter,owner);
            let value:unknown;
            if(data.command==="extensionAccept"){
                memory.fill(0,0x1000,0x1000+68);
                value=api.AcceptEx({} as never,memory,[data.handle,data.target,0x1000,4,32,32,0x500,0x300]);
            }else if(data.command==="extensionTransmit"){
                for(let index=0;index<data.length;index++)memory[0x1000+index]=index%251;
                memory.fill(0,0x600,0x610);word(0x600,0x1000);word(0x604,data.length);
                value=api.TransmitFile({} as never,memory,[data.handle,0,0,0,0x300,0x600,0]);
            }else{
                memory.fill(0,0x700,0x710);new DataView(memory.buffer).setUint16(0x700,2,true);
                new DataView(memory.buffer).setUint16(0x702,data.port,false);memory.set(data.ip,0x704);
                for(let index=0;index<data.length;index++)memory[0x1000+index]=index%251;
                value=api.ConnectEx({} as never,memory,[data.handle,0x700,16,0x1000,data.length,0x500,0x300]);
            }
            result={value,error,...status()};
        }else if(data.command==="wsaIssue"){
            const table=getWsaNativeSocketTable(owner,data.handle)!,state=getWsaProcessState(owner);if(!state.counter.started)state.counter.startup();
            if(event)System.getInstance().resourceProvider.unregisterKernelObject(event);
            event=System.getInstance().scheduler.createEvent(true,false);memory.fill(0,0x300,0x314);memory.fill(0,0x1000,0x1003);
            word(0x310,event);word(0x100,3);word(0x104,0x1000);word(0x400,0);
            let error=0;const api=makeSocketExports(table,value=>{error=value;},state.counter,owner);
            const value=api.WSARecv({} as never,memory,[data.handle,0x100,1,0,0x400,0x300,0]);result={value,error,...status()};
        }else if(data.command==="getResult"){
            const table=getWsaNativeSocketTable(owner,data.handle)!,provider=getWsaOverlapped(table,owner);
            const answer=await provider.result(data.handle,0x300,true,0x500,0x504);
            for(const write of answer.writes??[])word(write.address,write.value);
            result={value:answer.value,error:answer.error,bytes:get(0x500),flags:get(0x504),...status()};
        }else if(data.command==="observe"){
            const table=getWsaNativeSocketTable(owner,data.handle)!,provider=getWsaOverlapped(table,owner);
            let unsubscribe:(()=>void)|null=null;
            result=await new Promise(resolve=>{unsubscribe=provider.observeCompletion(data.handle,0x300,value=>resolve(value));if(!unsubscribe)resolve(null);});unsubscribe?.();
        }else if(data.command==="cancel"){result=cancelWsaIo(owner,data.handle,0x300);
        }else if(data.command==="closeHandle"){
            const table=getWsaNativeSocketTable(owner,data.handle)!;
            const value=table.nativeHandleView.closesocket(data.handle);
            await Promise.resolve();await Promise.resolve();result={value,valid:hasWsaSocket(owner,data.handle),...status()};
        }else if(data.command==="status"){await Promise.resolve();await Promise.resolve();result=status();
        }else if(data.command==="epoch"){
            await getProcessNetworkNamespace().finishProcessLifetime();getProcessNetworkNamespace().beginProcessLifetime();(owner as any).resetGeneration++;
            result={stale:getWsaNativeSocketTable(owner,data.handle)===undefined,started:getWsaProcessState(owner).counter.started};
        }else if(data.command==="close"){await getProcessNetworkNamespace().finishProcessLifetime();await closeProcessNetworkNamespace();result=true;}
        else throw Error("Unknown native handle worker command");
        self.postMessage({id:data.id,result});
    }catch(error){self.postMessage({id:data.id,error:String(error)});}
};
