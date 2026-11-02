import {describe,it,expect} from "bun:test";
import {PF_HALT_TARGET} from "../../src/worker/core/bootloader";
import {ThunkDispatcher} from "../../src/worker/core/thunking/thunk-dispatcher";
import {SEH_SCRATCH_LAYOUT as L} from "../../src/worker/core/thunking/seh-layout";
function fixture(){
 const mem=new Uint8Array(0x50000),view=new DataView(mem.buffer),esp=0x30000,ret=0x18000,retry=0x14000,teb=0x10000,frame=0x2f000;
 const d:any=new ThunkDispatcher({add_listener(){}} as any,{getStubById:(id:number)=>id===17?{address:retry}:undefined} as any);
 const regs=Int32Array.from([17,2,3,4,esp,6,7,8]);
 const cpu:any={reg32:regs,instruction_pointer:new Int32Array([retry+11]),segment_offsets:[0,0,0,0,teb],flags:new Int32Array([0x202]),flags_changed:new Int32Array([0]),get_eflags:()=>0x202};
 d.cachedMem8=mem;d.cachedDataView=view;d.memLength=mem.length;d.sehScratchAddr=0x40000;d.sehDispatchStubAddress=0x11000;d.lastThunkId=17;
 d.cachedFlagsRaw=cpu.flags;d._enterSehCriticalRuntime=()=>{};d._leaveSehCriticalRuntime=()=>{};
 view.setUint32(esp,ret,true);view.setUint32(esp+4,0x1234,true);view.setUint32(esp+8,0x2345,true);
 view.setUint32(teb,frame,true);view.setUint32(frame,0xffffffff,true);view.setUint32(frame+4,0x12000,true);
 const raise=(write=true)=>d.setupGuestAccessViolationDispatch(cpu,mem,esp,0x21000,write,8);
 return {mem,view,esp,ret,retry,teb,d,cpu,raise};
}
describe("HLE buffer access faults through guest SEH",()=>{
 it.each([false,true])("publishes actual AV parameters and preserves caller frame (write=%s)",write=>{
  const f=fixture(),regs=Array.from(f.cpu.reg32);
  expect(f.raise(write)).toEqual({value:0,skipStackCheck:true});
  const c=f.d.sehDispatchStack[0],s=c.scratchAddr;
  expect(c.kind).toBe("hle-access");
  expect(f.view.getUint32(s,true)).toBe(0xc0000005);
  expect(f.view.getUint32(s+4,true)).toBe(0);
  expect(f.view.getUint32(s+16,true)).toBe(2);
  expect(f.view.getUint32(s+20,true)).toBe(write?1:0);
  expect(f.view.getUint32(s+24,true)).toBe(0x21000);
  expect(f.view.getUint32(s+L.CONTEXT+0xb8,true)).toBe(f.retry);
  expect(f.view.getUint32(s+L.CONTEXT+0xc4,true)).toBe(f.esp);
  for(const [reg,offset] of [[7,0x9c],[6,0xa0],[3,0xa4],[2,0xa8],[1,0xac],[0,0xb0],[5,0xb4]])expect(f.view.getUint32(s+L.CONTEXT+offset,true)).toBe(regs[reg]!);
  expect(f.view.getUint32(f.esp,true)).toBe(f.d.sehDispatchStubAddress);
  expect(f.view.getUint32(f.esp+4,true)).toBe(0x1234);
  expect(f.view.getUint32(f.esp+8,true)).toBe(0x2345);
 });
 it("ContinueExecution retries the failed API with its original return address and arguments",()=>{
  const f=fixture();f.raise();const s=f.d.sehDispatchStack[0].scratchAddr;
  f.view.setUint32(s+L.DISPATCH_RESULT,0,true);f.cpu.reg32[4]=s-0x10;
  f.d._handleSehDispatchResult(f.cpu);
  expect(f.d.sehDispatchStack).toHaveLength(0);
  expect(f.cpu.reg32[4]).toBe(f.esp-4);
  expect(f.view.getUint32(f.esp-4,true)).toBe(f.retry);
  expect(f.view.getUint32(f.esp,true)).toBe(f.ret);
  expect(f.view.getUint32(f.esp+4,true)).toBe(0x1234);
  expect(f.view.getUint32(f.esp+8,true)).toBe(0x2345);
 });
 it("honors a handler's changed CONTEXT instead of forcing an API return",()=>{
  const f=fixture();f.raise();const s=f.d.sehDispatchStack[0].scratchAddr,c=s+L.CONTEXT;
  f.view.setUint32(s+L.DISPATCH_RESULT,0,true);f.view.setUint32(c+0xb8,0x19000,true);f.view.setUint32(c+0xc4,0x28000,true);
  f.view.setUint32(c+0xb0,99,true);f.cpu.reg32[4]=s-0x10;
  f.d._handleSehDispatchResult(f.cpu);
  expect(f.cpu.reg32[0]).toBe(99);expect(f.cpu.reg32[4]).toBe(0x27ffc);expect(f.view.getUint32(0x27ffc,true)).toBe(0x19000);
  expect(f.view.getUint32(f.esp,true)).toBe(f.ret);
 });
 it("reaches the existing UEF path when the explicit SEH chain is empty",()=>{
  const f=fixture();f.view.setUint32(f.teb,0xffffffff,true);
  expect(f.raise()).not.toBeNull();const s=f.d.sehDispatchStack[0].scratchAddr;
  expect(f.view.getUint32(s+L.FRAME_LIST,true)).toBe(0xffffffff);
 });
 it("bounds nested faults and leaves a rejected frame intact",()=>{
  const f=fixture();f.d.sehDispatchStack=Array.from({length:4},()=>({}));
  expect(f.raise()).toBeNull();expect(f.view.getUint32(f.esp,true)).toBe(f.ret);
 });
 it("keeps software RaiseException ContinueExecution returning with its own cleanup",()=>{
  const f=fixture();expect(f.d.setupCxxExceptionX86Dispatch(f.cpu,f.mem,f.esp,0xe0000001,0,0,0,16)).not.toBeNull();
  const s=f.d.sehDispatchStack[0].scratchAddr;f.view.setUint32(s+L.DISPATCH_RESULT,0,true);f.cpu.reg32[4]=s-0x10;
  f.d._handleSehDispatchResult(f.cpu);expect(f.cpu.reg32[4]).toBe(f.esp+16);expect(f.view.getUint32(f.esp+16,true)).toBe(f.ret);
 });
});

describe("UEF continuation and integer CONTROL context",()=>{
 it("captures arithmetic flags and segment selectors before dispatch overwrites the CPU",()=>{
  const f=fixture();f.cpu.sreg=Int16Array.from([0x23,0x1b,0x23,0x23,0x3b,0]);
  f.cpu.get_eflags=()=>0x647;f.cpu.flags[0]=0x202;f.raise();
  const c=f.d.sehDispatchStack[0].scratchAddr+L.CONTEXT;
  expect(f.view.getUint32(c+0xc0,true)).toBe(0x647);
  for(const [offset,value] of [[0x8c,0],[0x90,0x3b],[0x94,0x23],[0x98,0x23],[0xbc,0x1b],[0xc8,0x23]])expect(f.view.getUint32(c+offset,true)).toBe(value);
 });
 it("hardware empty-chain UEF uses the same bounded continuation and interrupted flags",()=>{
  const f=fixture();f.d.captureSehRuntimeDump=()=>{};f.d.unhandledExceptionFilterAddr=0x16000;
  f.view.setUint32(f.esp+20,0x647,true);
  expect(f.d._setupUnhandledExceptionFilterCall(f.cpu,0x21000,f.retry,true,f.esp,17,3,f.view)).toBe(true);
  const ctx=f.d.sehDispatchStack[0],s=ctx.scratchAddr;
  expect(ctx.kind).toBe("av");expect(f.view.getUint32(s+L.CONTEXT+0xc0,true)).toBe(0x647);
  expect(f.view.getUint32(f.esp+12,true)).toBe(f.d.sehDispatchStubAddress);
  f.cpu.reg32[4]=f.esp-0x200;f.d._handleSehDispatchResult(f.cpu);expect(f.d.sehDispatchStack).toHaveLength(1);
  f.view.setUint32(s+L.LAST_HANDLER_RESULT,0xffffffff,true);f.d._handleSehDispatchResult(f.cpu);
  expect(f.d.sehDispatchStack).toHaveLength(0);expect(f.cpu.reg32[4]).toBe(f.esp+20);
  expect(f.view.getUint32(f.esp+20,true)).toBe(f.retry);expect(f.cpu.flags[0]).toBe(0x647);
 });
 it("restores edited EFLAGS and invalidates stale lazy arithmetic flags",()=>{
  const f=fixture();f.raise();const s=f.d.sehDispatchStack[0].scratchAddr;
  f.view.setUint32(s+L.CONTEXT+0xc0,0x647,true);f.view.setUint32(s+L.DISPATCH_RESULT,0,true);
  f.cpu.flags_changed[0]=-1;f.cpu.reg32[4]=s-0x10;f.d._handleSehDispatchResult(f.cpu);
  expect(f.cpu.flags[0]).toBe(0x647);expect(f.cpu.flags_changed[0]).toBe(0);
 });
 it("keeps one bounded dispatch alive through UEF and resumes its edited context on -1",()=>{
  const f=fixture();f.d.unhandledExceptionFilterAddr=0x16000;f.raise();
  const ctx=f.d.sehDispatchStack[0],s=ctx.scratchAddr;f.cpu.reg32[4]=s-0x10;
  f.d._handleSehDispatchResult(f.cpu);
  expect(f.d.sehDispatchStack).toHaveLength(1);expect(ctx.awaitingUef).toBe(true);
  const stub=f.view.getUint32(s-0x10,true),frame=f.view.getUint32(stub+1,true),completion=f.view.getUint32(frame,true);
  expect(f.view.getUint32(frame+4,true)).toBe(s+L.EXCEPTION_POINTERS);
  expect(f.mem[completion]).toBe(0xa3);expect(f.view.getUint32(completion+1,true)).toBe(s+L.LAST_HANDLER_RESULT);
  f.view.setUint32(s+L.LAST_HANDLER_RESULT,0xffffffff,true);
  f.view.setUint32(s+L.CONTEXT+0xb8,0x1a000,true);f.view.setUint32(s+L.CONTEXT+0xc4,0x29000,true);
  f.view.setUint32(s+L.CONTEXT+0xc0,0x247,true);f.cpu.reg32[4]=frame+8;
  f.d._handleSehDispatchResult(f.cpu);
  expect(f.d.sehDispatchStack).toHaveLength(0);expect(f.cpu.reg32[4]).toBe(0x28ffc);
  expect(f.view.getUint32(0x28ffc,true)).toBe(0x1a000);expect(f.cpu.flags[0]).toBe(0x247);
  expect(f.view.getUint32(f.esp,true)).toBe(f.ret);
 });
 it.each([0,1])("UEF disposition %i halts once without invoking the filter again",disposition=>{
  const f=fixture();f.d.unhandledExceptionFilterAddr=0x16000;f.raise();const s=f.d.sehDispatchStack[0].scratchAddr;
  f.cpu.reg32[4]=s-0x10;f.d._handleSehDispatchResult(f.cpu);expect(f.d.sehDispatchStack).toHaveLength(1);
  f.view.setUint32(s+L.LAST_HANDLER_RESULT,disposition,true);f.cpu.reg32[4]=s-0x10;f.d._handleSehDispatchResult(f.cpu);
  expect(f.d.sehDispatchStack).toHaveLength(0);expect(f.view.getUint32(s-0x10,true)).toBe(PF_HALT_TARGET);
 });
});
