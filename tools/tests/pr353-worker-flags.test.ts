import { expect, test } from "bun:test";
import { registerDbgCommands } from "../../src/worker/harness/cmds/dbg";
import { System } from "../../src/worker/core/system";
import { hypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
test("requested PR353 flags reset together while existing boot bindings remain truthful", () => {
    const globals=globalThis as Record<string,unknown>;
    const names=["__noTebStubs","__noGlColorPtrDerefWbuf","__appliedWorkerFlags"];
    const saved=names.map(n=>Object.getOwnPropertyDescriptor(globals,n));
    const system=System.getInstance(), oldProcess=system.process;
    const oldBound=hypercallDataManager.areTebStubsBound();
    const commands=new Map<string,(args:unknown[])=>any>();
    try {
        for(const n of names) delete globals[n];
        const binding={registered:true,trampoline:0x7000,stubs:[{address:0x8000,bound:true}]};
        system.process={dispatcher:{getPtrDerefWriteBufferBinding:()=>binding}} as never;
        hypercallDataManager.setTebStubsBound(true);
        registerDbgCommands({register(n:string,fn:any){commands.set(n,fn);}} as never);
        const call=(n:string,...args:unknown[])=>commands.get(n)!(args);
        expect(call("getWorkerFlags").tebStubsDisabled).toBe(false);
        call("setWorkerFlag","__noTebStubs",true);
        call("setWorkerFlag","__noGlColorPtrDerefWbuf",true);
        const both=call("getWorkerFlags");
        expect(both.tebStubsDisabled).toBe(true);
        expect(both.glColorPtrDerefWbufDisabled).toBe(true);
        expect(both.applied).toEqual({__noTebStubs:true,__noGlColorPtrDerefWbuf:true});
        expect(both.bindings.tebStubsBound).toBe(true); // setting flags never claims hot unbind
        expect(both.bindings.colorPtrDeref.glColor4fv).toEqual(binding);
        expect(new Set(call("resetWorkerFlags").cleared)).toEqual(new Set(names.slice(0,2)));
        const reset=call("getWorkerFlags");
        expect(reset.applied).toEqual({});
        expect(reset.tebStubsDisabled).toBe(false);
        expect(reset.glColorPtrDerefWbufDisabled).toBe(false);
        expect(reset.bindings.tebStubsBound).toBe(true);
        call("setWorkerFlag","__noGlColorPtrDerefWbuf",1);
        expect(call("getWorkerFlags").glColorPtrDerefWbufDisabled).toBe(false);
        call("setWorkerFlag","__noTebStubs",1);
        expect(call("getWorkerFlags").tebStubsDisabled).toBe(true); // existing loader flag is truthy
    } finally {
        system.process=oldProcess;
        hypercallDataManager.setTebStubsBound(oldBound);
        names.forEach((n,i)=>{delete globals[n];if(saved[i]) Object.defineProperty(globals,n,saved[i]!);});
    }
});
