import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { Ntdll } from '../../src/worker/modules/ntdll';
import { effectiveThreadPriority } from '../../src/worker/modules/ntdll/thread-information';
import { exports as processApi, resetProcessApiState } from '../../src/worker/modules/kernel32/process/process';
import { ThreadState, type Thread } from '../../src/worker/core/scheduler/types';
import { VIRTUAL_CURRENT_PROCESS_ID } from '../../src/worker/modules/kernel32/process/virtual-process-manager';

const system = System.getInstance(), scheduler = system.scheduler;
const internals = scheduler as unknown as { threads: Map<number,Thread>; currentThreadId: number | null };
const savedProcess = system.process;
let savedCurrent: number | null, memory: Uint8Array, ntdll: Ntdll, handle: number, alias: number;
let denied: number;
const TID=0x7ffe, OUT=256, RETLEN=512, CURRENT=0xfffffffe;
const view=()=>new DataView(memory.buffer);
const query=(h=handle,cls=0,out=OUT,length=28,ret=RETLEN)=>ntdll.exports.NtQueryInformationThread(null,memory,[h,cls,out,length,ret]);
const fields=()=>Array.from({length:7},(_,i)=>view().getInt32(OUT+i*4,true));

beforeEach(()=>{
    savedCurrent=internals.currentThreadId; memory=new Uint8Array(8192); denied=-1;
    const validateRange=(p:number,n:number,perms:string)=>p>0 && p+n<=memory.length && !(perms.includes('w') && p<=denied && p+n>denied);
    Mem.bind(()=>memory,validateRange);
    system.process={getCurrentMemory:()=>memory,addressSpace:{validateRange}} as never;
    const object={kind:'thread',threadId:TID};
    handle=system.resourceProvider.registerKernelObject(object); alias=system.resourceProvider.registerKernelObject(object);
    internals.threads.set(TID,{id:TID,handle,kernelObject:object,state:ThreadState.READY,context:null,stackBase:0,stackSize:0,stackTop:0,
        startAddress:0x401000,parameter:0,waitInfo:null,exitCode:null,tlsValues:new Map(),lastError:0,suspendCount:0,
        priority:0,lastSwitchTime:0,lastSwitchInsn:0,tebAddress:4096,kernelPinCount:0,apcQueue:[],quitPosted:false,
        quitExitCode:0,asyncParkGeneration:0} as Thread);
    internals.currentThreadId=TID; resetProcessApiState(); ntdll=new Ntdll(); ntdll.initialize(system.process!);
});
afterEach(()=>{
    internals.threads.delete(TID); internals.currentThreadId=savedCurrent;
    system.resourceProvider.unregisterKernelObject(handle); system.resourceProvider.unregisterKernelObject(alias);
    system.process=savedProcess; Mem.bind(()=>savedProcess?.getCurrentMemory()??new Uint8Array()); resetProcessApiState();
});
test('real Ntdll registration returns all seven x86 fields from scheduler/process state',()=>{
    expect(query()).toBe(0);
    expect(fields()).toEqual([259,4096,VIRTUAL_CURRENT_PROCESS_ID,TID,1,8,0]);
    expect(view().getUint32(RETLEN,true)).toBe(28);
    expect(ntdll.exports.ZwQueryInformationThread).toBe(ntdll.exports.NtQueryInformationThread);
});
test('pseudo handle and duplicate kernel-object aliases resolve the same thread',()=>{
    expect(query(CURRENT)).toBe(0); const expected=fields();
    expect(query(alias)).toBe(0); expect(fields()).toEqual(expected);
    expect(query(-2)).toBe(0); expect(fields()).toEqual(expected);
});
test('closed/unknown/wrong-type handles fail even if a Thread record remains',()=>{
    system.resourceProvider.unregisterKernelObject(handle);
    expect(query()).toBe(0xc0000008); expect(query(alias)).toBe(0);
    expect(query(CURRENT)).toBe(0); // Pseudo handle remains valid after the ordinary handle closes.
    expect(query(0)).toBe(0xc0000008); expect(query(0xffffffff)).toBe(0xc0000008);
    const event=system.resourceProvider.registerKernelObject({kind:'event'});
    try { expect(query(event)).toBe(0xc0000008); } finally { system.resourceProvider.unregisterKernelObject(event); }
    internals.currentThreadId=null; expect(query(CURRENT)).toBe(0xc0000008);
});
test('Win32 priority setters feed relative BasePriority and correctly converted NT Priority',()=>{
    const call=(name:string,args:number[])=>processApi[name](null as never,memory,args) as {value:number};
    const rows=[
        [0x40,[1,2,3,4,5,6,15]], [0x4000,[1,4,5,6,7,8,15]], [0x20,[1,6,7,8,9,10,15]],
        [0x8000,[1,8,9,10,11,12,15]], [0x80,[1,11,12,13,14,15,15]], [0x100,[16,22,23,24,25,26,31]],
    ] as const;
    const relatives=[-15,-2,-1,0,1,2,15];
    for(const [cls,expected] of rows) {
        expect(call('SetPriorityClass',[0xffffffff,cls]).value).toBe(1);
        for(let i=0;i<relatives.length;i++) {
            expect(call('SetThreadPriority',[handle,relatives[i]>>>0]).value).toBe(1);
            expect(query()).toBe(0);
            expect(fields().slice(5)).toEqual([expected[i],relatives[i]]);
        }
    }
    expect(effectiveThreadPriority(0x100,-7)).toBe(17);
    expect(effectiveThreadPriority(0x100,6)).toBe(30);
    expect(effectiveThreadPriority(0xdead,0)).toBeNull();
});
test('ExitStatus and last scheduler metadata survive actual termination and record reaping',()=>{
    const thread=internals.threads.get(TID)!; thread.priority=-1;
    expect(scheduler.terminateThreadByHandle(handle,0xdeadbeef)).toBe(true);
    expect(query(alias)).toBe(0); expect(view().getUint32(OUT,true)).toBe(0xdeadbeef);
    const before=fields(); internals.threads.delete(TID); // Reaping removes this record; kernel object lives on.
    expect(query(alias)).toBe(0); expect(fields()).toEqual(before);
});
test('alias retains exit metadata when the original handle was closed before termination',()=>{
    system.resourceProvider.unregisterKernelObject(handle);
    scheduler.exitThread(42); // Current-thread termination is legal with its ordinary handle closed.
    expect(query(alias)).toBe(0); const before=fields(); expect(before[0]).toBe(42);
    internals.threads.delete(TID);
    expect(query(alias)).toBe(0); expect(fields()).toEqual(before);
    expect(query(handle)).toBe(0xc0000008);
});
test('exact 28-byte contract rejects short/long lengths before probing or handle lookup',()=>{
    memory.fill(0xcc,OUT,OUT+32);
    for(const length of [0,1,27,29,32,0xffffffff]) {
        expect(query(0,0,1,length)).toBe(0xc0000004);
        expect(view().getUint32(RETLEN,true)).toBe(28);
        expect([...memory.slice(OUT,OUT+32)]).toEqual(new Array(32).fill(0xcc));
    }
});
test('null, short, readonly and misaligned output paths return honest NTSTATUS',()=>{
    expect(query(handle,0,0)).toBe(0xc0000005);
    expect(query(handle,0,8192-24)).toBe(0xc0000005);
    expect(query(handle,0,1)).toBe(0x80000002);
    expect(query(handle,0,2)).toBe(0x80000002);
    expect(query(handle,0,OUT,28,RETLEN+1)).toBe(0x80000002);
    expect(query(handle,0,OUT,28,8192)).toBe(0xc0000005);
    denied=OUT+20; expect(query()).toBe(0xc0000005);
    denied=RETLEN; expect(query()).toBe(0xc0000005);
});
test('optional ReturnLength works, unknown classes fail, and successful writes stay within 28 bytes',()=>{
    memory.fill(0xcc,OUT-4,OUT+32);
    expect(query(handle,0,OUT,28,0)).toBe(0);
    expect(view().getUint32(OUT-4,true)).toBe(0xcccccccc);
    expect(view().getUint32(OUT+28,true)).toBe(0xcccccccc);
    const before=memory.slice(); expect(query(handle,9)).toBe(0xc0000002);
    expect(memory).toEqual(before);
});
test('argument decoding does not call Array.map',()=>{
    const args=[handle,0,OUT,28,RETLEN];
    args.map=(()=>{throw new Error('per-call args.map allocation');}) as typeof args.map;
    expect(ntdll.exports.NtQueryInformationThread(null,memory,args)).toBe(0);
});
test('ReturnLength aliases each struct DWORD and is written after all seven fields',()=>{
    internals.threads.get(TID)!.priority=-1;
    const expected=[259,4096,VIRTUAL_CURRENT_PROCESS_ID,TID,1,7,-1];
    for(let index=0;index<7;index++) {
        memory.fill(0xcc,OUT-4,OUT+32);
        expect(query(handle,0,OUT,28,OUT+index*4)).toBe(0);
        const aliased=expected.slice(); aliased[index]=28;
        expect(fields()).toEqual(aliased);
        expect(view().getUint32(OUT-4,true)).toBe(0xcccccccc);
        expect(view().getUint32(OUT+28,true)).toBe(0xcccccccc);
    }
});
test('denied trailing output byte or ReturnLength preflight leaves every byte untouched',()=>{
    memory.fill(0xcc);
    for(const inaccessible of [OUT+27,RETLEN+3]) {
        denied=inaccessible; const before=memory.slice();
        expect(query()).toBe(0xc0000005); expect(memory).toEqual(before);
    }
});
test('write accessor failure returns access violation and never continues later writes',()=>{
    // Defensive injected failure after preflight; not a concurrent guest-memory race.
    for(const failedAddress of [OUT,OUT+4,OUT+8,OUT+12,OUT+16,OUT+20,OUT+24,RETLEN]) {
        const real=Mem.writeUint32.bind(Mem);
        const writes:number[]=[];
        const mock=spyOn(Mem,'writeUint32').mockImplementation((address,value)=>{
            writes.push(address); return address===failedAddress ? false : real(address,value);
        });
        try {
            expect(query()).toBe(0xc0000005);
            expect(writes.at(-1)).toBe(failedAddress);
            expect(writes).toEqual([OUT,OUT+4,OUT+8,OUT+12,OUT+16,OUT+20,OUT+24,RETLEN]
                .slice(0,failedAddress===RETLEN ? 8 : (failedAddress-OUT)/4+1));
        } finally { mock.mockRestore(); }
    }
});
