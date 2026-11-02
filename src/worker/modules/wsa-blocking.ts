/** Winsock 1.1 blocking hooks. Guest callbacks execute on their issuer through a resumable guest call stack. */
import type { Process } from "../core/process";
import type { ModuleDescriptor } from "../api/types";
import type { ThunkImplementation, ThunkResult, DeferredWrite } from "../core/thunking/thunk-dispatcher";
import { writeGuestCode } from "../core/memory/guest-code";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";
import { createMessageExports } from "./user32/message";
import type { WsaProcessState } from "./wsa-stub-shared";
import { WSA } from "./wsa-network";

interface BlockingTask {
    thread: number; generation: number; hook: number; controller: AbortController;
    done: boolean; inHook: boolean; result?: ThunkResult; failure?: unknown; lastError?: number; wake: Set<() => void>;
}
class BlockingHooks {
    private hooks = new Map<number, number>();
    private tasks = new Map<number, BlockingTask>();
    private defaultPointer = 0;
    private trampoline = 0;
    private generation: number;
    constructor(readonly state: WsaProcessState, readonly owner: Process) {
        this.generation = state.table.generation;
        state.table.subscribe(() => {
            if (this.generation === state.table.generation) return;
            this.generation = state.table.generation;
            this.hooks.clear(); this.defaultPointer = this.trampoline = 0;
            for (const task of this.tasks.values()) { task.controller.abort(); task.wake.forEach(wake => wake()); }
            this.tasks.clear();
        });
    }
    private thread(): number { return System.getInstance().scheduler.getCurrentThreadId(); }
    private error(code: number, value = -1): number { this.state.setError(code); return value; }
    private usable(): boolean {
        if (!this.state.counter.started) { this.state.setError(WSA.NOTINITIALISED); return false; }
        if ((this.state.counter.version & 255) >= 2) { this.state.setError(WSA.EOPNOTSUPP); return false; }
        if (this.tasks.get(this.thread())?.inHook) { this.state.setError(WSA.EINPROGRESS); return false; }
        return true;
    }
    private stub(name: string, argc: number, implementation: ThunkImplementation): number {
        const generator = this.owner.thunkGenerator;
        let pointer = generator.getExportAddress("__winsock:" + name);
        if (!pointer) {
            const stub = generator.allocateOneStub("__winsock", name, argc, "stdcall", argc * 4);
            writeGuestCode(this.owner.getCurrentMemory(), stub.code, stub.address); pointer = stub.address;
        }
        this.owner.dispatcher.register("__winsock", name, implementation);
        return pointer;
    }
    private code(bytes: number[]): number {
        const address = this.owner.memory.alloc(bytes.length, "THUNK_CODE", "rx");
        if (!address || !writeGuestCode(this.owner.getCurrentMemory(), Uint8Array.from(bytes), address)) throw Error("Cannot allocate blocking callback");
        return address;
    }
    private call(bytes: number[], address: number): void {
        bytes.push(0xb8,address&255,address>>>8&255,address>>>16&255,address>>>24&255,0xff,0xd0);
    }
    private defaultHook(): number {
        if (this.defaultPointer) return this.defaultPointer;
        const messages = createMessageExports();
        const peek = this.stub("LegacyPeekMessage",5,messages.PeekMessageA);
        const translate = this.stub("LegacyTranslateMessage",1,messages.TranslateMessage);
        const dispatch = this.stub("LegacyDispatchMessage",1,messages.DispatchMessageA);
        const b = [0x83,0xec,28,0x89,0xe0,0x6a,1,0x6a,0,0x6a,0,0x6a,0,0x50];
        this.call(b,peek); b.push(0x85,0xc0,0x74,0); const jump = b.length-1;
        b.push(0x89,0xe0,0x50); this.call(b,translate);
        b.push(0x89,0xe0,0x50); this.call(b,dispatch); b.push(0xb8,1,0,0,0);
        b[jump]=b.length-(jump+1); b.push(0x83,0xc4,28,0xc3);
        return this.defaultPointer=this.code(b);
    }
    private loop(): number {
        if (this.trampoline) return this.trampoline;
        const before = this.stub("LegacyBeforeBlockingHook",0,() => {
            const task=this.tasks.get(this.thread());
            if (!task || task.done) return 0;
            task.inHook=true; return task.hook;
        });
        const wait = this.stub("LegacyWaitBlockingProgress",0,() => {
            const task=this.tasks.get(this.thread());
            if (!task || task.done) return 1;
            task.inHook=false;
            return new Promise<number>(resolve => {
                let finished=false;
                const end=(ready:number) => { if(finished)return;finished=true;clearTimeout(timer);task.wake.delete(wake);resolve(ready); };
                const wake=()=>end(1), timer=setTimeout(()=>end(task.done?1:0),10);
                task.wake.add(wake);
            });
        });
        const b:number[]=[]; this.call(b,before); b.push(0x85,0xc0,0x74,0); const done=b.length-1;
        b.push(0xff,0xd0,0x85,0xc0,0x75,0); const again=b.length-1;
        this.call(b,wait); b.push(0x85,0xc0,0x74,0); const retry=b.length-1;
        const exit=b.length; b.push(0x31,0xc0,0xc3);
        b[done]=exit-(done+1); b[again]=-(again+1)&255; b[retry]=-(retry+1)&255;
        return this.trampoline=this.code(b);
    }
    private publish(writes: readonly DeferredWrite[]): boolean {
        if (writes.some(w=>!this.owner.addressSpace.validateRange(w.address,w.size,"w"))) return false;
        for (const w of writes) {
            const data=new Uint8Array(w.size), v=new DataView(data.buffer);
            if(w.size===1)v.setUint8(0,w.value); else if(w.size===2)v.setUint16(0,w.value,true);
            else if(w.size===4)v.setUint32(0,w.value,true); else v.setBigUint64(0,BigInt(Math.trunc(w.value)),true);
            if(this.owner.addressSpace.write(w.address,data)!==data.length)return false;
        }
        return true;
    }
    readonly exports: Record<string,ThunkImplementation> = {
        WSAIsBlocking: () => { const blocking=!!this.tasks.get(this.thread())?.inHook; this.state.setError(0); return +blocking; },
        WSACancelBlockingCall: () => {
            if (!this.state.counter.started) return this.error(WSA.NOTINITIALISED);
            if ((this.state.counter.version&255)>=2) return this.error(WSA.EOPNOTSUPP);
            const task=this.tasks.get(this.thread());
            if(!task?.inHook)return this.error(WSA.EINVAL);
            task.controller.abort();this.state.setError(0);return 0;
        },
        WSASetBlockingHook: (_ctx,mem,a) => {
            if(!this.usable())return 0;
            if(!a[0]||!isValidAddress(mem,a[0],1,"rx"))return this.error(WSA.EFAULT,0);
            try {
                const tid=this.thread(), previous=this.hooks.get(tid)??this.defaultHook();
                this.hooks.set(tid,a[0]);this.state.setError(0);return previous;
            } catch { return this.error(WSA.ENOBUFS,0); }
        },
        WSAUnhookBlockingHook: () => {
            if(!this.usable())return -1;
            this.hooks.delete(this.thread());this.state.setError(0);return 0;
        },
    };
    wrap(implementation: ThunkImplementation, cleanup: number, nestedFailure = -1): ThunkImplementation {
        return (ctx,mem,args) => {
            if((this.state.counter.version&255)>=2)return implementation(ctx,mem,args);
            const tid=this.thread();
            if(this.tasks.get(tid)?.inHook)return this.error(WSA.EINPROGRESS, nestedFailure);
            const hook=this.hooks.get(tid);
            // NT's default hook has a callable address, but is not installed as the provider callback.
            if(!hook||hook===this.defaultPointer)return implementation(ctx,mem,args);
            const controller=new AbortController(); let pending:BlockingTask|undefined, issuedError:number|undefined;
            const answer=this.state.table.withBlockingSignal(controller.signal,()=>implementation(ctx,mem,args),code=>{if(pending)pending.lastError=code;else issuedError=code;});
            if(!(answer instanceof Promise)){if(issuedError!==undefined)this.state.setError(issuedError);return answer;}
            const task:BlockingTask=pending={thread:tid,generation:this.state.table.generation,hook,controller,done:false,inHook:false,wake:new Set(),lastError:issuedError};
            this.tasks.set(tid,task);
            void answer.then(result=>{task.result=typeof result==="number"?{value:result}:result;task.done=true;task.wake.forEach(wake=>wake());},
                failure=>{task.failure=failure;task.done=true;task.wake.forEach(wake=>wake());});
            const manager=this.owner.dispatcher.callbackManager, entry={...ctx,returnAddr:Mem.readUint32(ctx.esp)};
            let frame=0;
            try {
                frame=manager.saveSuspendedThunkContext(entry,cleanup,"Winsock 1.1 blocking hook");
                if(!frame)throw Error("No callback frame");
                const invocation=manager.invokeCallback(this.loop(),[],cleanup,() => {
                    this.tasks.delete(tid);task.inHook=false;
                    if(task.generation!==this.state.table.generation)return this.error(WSA.EINTR);
                    if(task.failure)throw task.failure;
                    if(task.lastError!==undefined)this.state.setError(task.lastError);
                    const result=task.result??{value:-1};
                    if(!this.publish(result.deferredWrites??[]))return this.error(WSA.EFAULT);
                    if(result.startCallbackChain) {
                        const chain={esp:entry.esp,returnAddr:entry.returnAddr!,mem:this.owner.getCurrentMemory(),wsaBlockingFrameId:frame};
                        if(result.startCallbackChain(chain))return null;
                    }
                    return result.value;
                },false,"Winsock 1.1 blocking hook",frame);
                if(!invocation.callbackId)throw Error("No callback entry");
                return {value:0,suspendedForCallback:true,callbackId:invocation.callbackId,stackCleanup:cleanup,skipStackCheck:true};
            } catch {
                controller.abort();this.tasks.delete(tid);if(frame)manager.abandonSuspendedFrame(frame);
                return this.error(WSA.ENOBUFS);
            }
        };
    }
}
const instances=new WeakMap<WsaProcessState,BlockingHooks>();
/** Both Winsock DLLs share per-thread hooks and one negotiated application version. */
export function installWsaBlockingHooks(exports:Record<string,ThunkImplementation>, descriptor:ModuleDescriptor, state:WsaProcessState, process:Process):void {
    let hooks=instances.get(state);if(!hooks){hooks=new BlockingHooks(state,process);instances.set(state,hooks);}
    Object.assign(exports,hooks.exports);
    for(const [ordinal,name] of [[109,"WSASetBlockingHook"],[110,"WSAUnhookBlockingHook"],[113,"WSACancelBlockingCall"],[114,"WSAIsBlocking"]] as const)exports["ord_"+ordinal]=hooks.exports[name];
    const exemptNames=["WSAGetLastError","WSASetLastError","htonl","htons","ntohl","ntohs","inet_addr","inet_ntoa",
        "WSACreateEvent","WSACloseEvent","WSASetEvent","WSAResetEvent","WSAWaitForMultipleEvents"];
    // Match aliases by implementation: wsock32 and ws2_32 use different ordinals for inet_* and ioctl.
    const exempt=new Set(exemptNames.map(name=>exports[name]).filter(Boolean));
    const failures=new Map<ThunkImplementation,number>();
    for(const name of ["gethostbyname","gethostbyaddr","getprotobyname","getprotobynumber","getservbyname","getservbyport",
        "WSAGetOverlappedResult","AcceptEx","ConnectEx","DisconnectEx","TransmitFile","inet_ntop","InetNtopA","InetNtopW",
        "WSAAsyncGetHostByAddr","WSAAsyncGetHostByName","WSAAsyncGetProtoByNumber","WSAAsyncGetProtoByName","WSAAsyncGetServByPort","WSAAsyncGetServByName"])
        if(exports[name])failures.set(exports[name],0);
    for(const name of ["getaddrinfo","getnameinfo","WSAStartup"])if(exports[name])failures.set(exports[name],WSA.EINPROGRESS);
    const helpers=new Set(Object.values(hooks.exports));
    const wrapped=new Map<ThunkImplementation,ThunkImplementation>();
    for(const fn of descriptor.functions) {
        const implementation=exports[fn.name];
        if(!implementation||exempt.has(implementation)||helpers.has(implementation))continue;
        let wrapper=wrapped.get(implementation);
        if(!wrapper){wrapper=hooks.wrap(implementation,(fn.params?.length??0)*4,failures.get(implementation));wrapped.set(implementation,wrapper);}
        exports[fn.name]=wrapper;
    }
}
