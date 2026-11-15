import { expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { System } from "../../src/worker/core/system";
import { MemoryAllocationError } from "../../src/worker/core/memory/allocation-error";
import { exports as tls } from "../../src/worker/modules/kernel32/tls";
import { exports as fls, captureFls, restoreFls, resetFlsState } from "../../src/worker/modules/kernel32/fls";
import { hypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
test("lazy native TLS/FLS exhaustion returns Win32 failure without publishing pointers or consuming FLS index", () => {
    const system=System.getInstance(), oldScheduler=system.scheduler, oldProcess=system.process;
    const oldFls=captureFls(), manager=hypercallDataManager as any;
    const hc={...manager}, allocated=manager.flsAllocatedShadow.slice();
    manager.flsValuesByThread=new Map(); manager.initialized=false;
    manager.view=null; manager.wasmMemory=null;
    manager.initialize({wasm_memory:{buffer:new ArrayBuffer(0x20000)}},0x1000);
    const mem=new Uint8Array(0x40000), dv=new DataView(mem.buffer);
    let next=0x10000, failure: Error | null=null;
    const memory={alloc(n:number){if(failure) throw failure; const a=next;next=(next+n+15)&~15;return a;}};
    const s=new Scheduler(); s.tebManager.initProcess(()=>mem,memory);
    const teb=s.tebManager.allocateTeb(1,0,0,memory);
    (s as any).threads.set(1,{id:1,tebAddress:teb,tlsValues:new Map(),lastError:0});
    (s as any).currentThreadId=1;(s as any).process={memory};
    system.scheduler=s;system.process={memory,resetGeneration:0} as never;
    const call=(api:typeof tls,n:string,args:number[])=>Number(api[n]!(null as never,mem,args));
    try {
        resetFlsState();
        const implicit=dv.getUint32(teb+0x2c,true);
        failure=new MemoryAllocationError("test guest heap exhaustion");
        expect(call(tls,"TlsSetValue",[105,0xbad])).toBe(0);
        expect(s.getLastError()).toBe(8);
        expect(dv.getUint32(teb+0xf94,true)).toBe(0);
        expect(call(tls,"TlsGetValue",[105])).toBe(0);
        expect(s.getLastError()).toBe(0);
        expect(call(fls,"FlsAlloc",[0])).toBe(0xffffffff);
        expect(s.getLastError()).toBe(8);
        expect(captureFls().allocated).toEqual([]);
        expect(call(fls,"FlsSetValue",[1,0xbad])).toBe(0);
        expect(s.getLastError()).toBe(8);
        expect(dv.getUint32(teb+0xfb4,true)).toBe(0);
        expect(dv.getUint32(teb+0x2c,true)).toBe(implicit);
        // A bad guest index must retain INVALID_PARAMETER, regardless of exhaustion.
        expect(call(tls,"TlsSetValue",[1088,1])).toBe(0);expect(s.getLastError()).toBe(87);
        expect(call(fls,"FlsSetValue",[128,1])).toBe(0);expect(s.getLastError()).toBe(87);
        failure=new Error("allocator programming error");
        expect(()=>call(tls,"TlsSetValue",[105,1])).toThrow("allocator programming error");
        expect(()=>call(fls,"FlsAlloc",[0])).toThrow("allocator programming error");
        failure=null;
        expect(call(fls,"FlsAlloc",[0])).toBe(1);
        expect(call(tls,"TlsSetValue",[105,0x1234])).toBe(1);
        expect(call(tls,"TlsGetValue",[105])).toBe(0x1234);
    } finally {
        system.scheduler=oldScheduler;system.process=oldProcess;restoreFls(oldFls);
        Object.assign(manager,hc); manager.flsAllocatedShadow.set(allocated);
    }
});
