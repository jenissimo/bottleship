import {afterEach,beforeEach,expect,spyOn,test} from 'bun:test';
import {Process} from '../../src/worker/core/process';
import {System} from '../../src/worker/core/system';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {AddressSpace} from '../../src/worker/core/memory/address-space';
import {getWsaProcessState,makeSocketExports} from '../../src/worker/modules/wsa-stub-shared';
import {getWsaOverlapped} from '../../src/worker/modules/wsa-overlapped';
import {exports as sync,resetSyncState} from '../../src/worker/modules/kernel32/sync';
import {WsaFailure,WSA} from '../../src/worker/modules/wsa-network';
import {reserveControlApc} from '../../src/worker/modules/wsa-control-apc';
import type {ApcCallbackLifetime} from '../../src/worker/core/scheduler/types';

const sys=System.getInstance(),scheduler=sys.scheduler,savedProcess=sys.process,savedMem=Object.getOwnPropertyDescriptors(Mem);
let ram:Uint8Array,owner:Process,state:ReturnType<typeof getWsaProcessState>,api:ReturnType<typeof makeSocketExports>,socket:number,error:number,handles:number[],undo:Array<()=>void>,freed:number[];
const ctx={} as never,out=0x20000,returned=0x18000,ov=0x40000,routine=0x60000;
const set=(p:number,n:number)=>new DataView(ram.buffer).setUint32(p,n,true),get=(p:number)=>new DataView(ram.buffer).getUint32(p,true);
const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
const ioctl=(output=out,length=4096,count=returned,overlapped=ov,apc=0)=>api.WSAIoctl(ctx,ram,[socket,0x4004747f,0,0,output,length,count,overlapped,apc]);
const answer=(r:any)=>typeof r==='number'?r:r.value;
beforeEach(()=>{
 ram=new Uint8Array(2<<20);const space=new AddressSpace(()=>ram);owner=Object.create(Process.prototype) as Process;let next=0x100000;freed=[];
 Object.assign(owner,{resetGeneration:0,addressSpace:space,getMemory:()=>ram,getCurrentMemory:()=>ram,memory:{alloc(n:number){const p=next;next+=n+16;space.registerRegion({base:p,size:n,perms:'rw',kind:'HEAP',owner:'test'});return p;},free(p:number){freed.push(p);}}});
 space.registerRegion({base:routine,size:4096,perms:'rx',kind:'ROM',owner:'test',allowOverlap:true});
 Mem.bind(()=>ram,(p,n,perms)=>space.validateRange(p,n,perms));sys.process=owner;resetSyncState();state=getWsaProcessState(owner);state.counter.startup();
 error=0;handles=[];undo=[];api=makeSocketExports(state.table,n=>{error=n;},state.counter,owner);socket=state.table.socket(2,2);
 set(returned,0xdeadbeef);set(ov,0xfeed);set(ov+4,0xbeef);set(ov+8,0xaaaa);
});
afterEach(()=>{for(const f of undo.reverse())f();state.reset();resetSyncState();for(const h of handles)sys.resourceProvider.unregisterKernelObject(h);sys.process=savedProcess;for(const key of ['memoryGetter','validateRange','getRegion'])Object.defineProperty(Mem,key,savedMem[key]!);});
function event(){const h=scheduler.createEvent(true,false);handles.push(h);set(ov+16,h);return sys.resourceProvider.getKernelObject(h) as any;}
test('interface control overlapped publication signals its event after fresh owner writes',async()=>{
 const e=event();expect(answer(ioctl())).toBe(-1);expect(error).toBe(997);expect(get(returned)).toBe(0xdeadbeef);expect(e.signaled).toBe(false);
 const foreign=new Uint8Array(2<<20);Mem.bind(()=>foreign);await tick();
 expect(get(ov)).toBe(0);expect(get(ov+4)).toBe(152);expect(get(ov+8)).toBe(0xaaaa);expect(e.signaled).toBe(true);expect(get(out)).toBe(3);expect(foreign[out]).toBe(0);
});
test('control query is independent of a pending receive on the same file object',async()=>{
 event();const provider=getWsaOverlapped(state.table,owner);
 provider.issue(socket,ov+64,0,'read',()=>{throw new WsaFailure(WSA.EWOULDBLOCK);},()=>[]);
 expect(answer(ioctl())).toBe(-1);expect(error).toBe(997);await tick();expect(get(ov)).toBe(0);expect(get(ov+64)).toBe(259);
});
test('short control output completes with STATUS_BUFFER_TOO_SMALL and WSAEFAULT',async()=>{
 const e=event();expect(answer(ioctl(out,76))).toBe(-1);expect(error).toBe(997);await tick();expect(e.signaled).toBe(true);expect(get(ov)).toBe(0xc0000023);expect(get(ov+4)).toBe(0);expect(get(out)).toBe(3);
 expect(answer(api.WSAGetOverlappedResult(ctx,ram,[socket,ov,returned,0,returned+4]))).toBe(0);expect(error).toBe(10014);expect(get(returned)).toBe(0);
});
test('IOCP control completion defers status until dequeue and reports Win32 buffer-too-small',async()=>{
 const port=answer(sync.CreateIoCompletionPort(ctx,ram,[socket,0,42,0]));handles.push(port);expect(port).toBeGreaterThan(0);
 expect(answer(ioctl(out,75))).toBe(-1);await tick();expect(get(ov)).toBe(259);
 expect(answer(sync.GetQueuedCompletionStatus(ctx,ram,[port,returned,returned+4,returned+8,0]))).toBe(0);
 expect(get(ov)).toBe(0xc0000023);expect(get(returned)).toBe(0);expect(get(returned+4)).toBe(42);expect(get(returned+8)).toBe(ov);
});
test('synchronous creation still updates OVERLAPPED and event, but an inaccessible output creates no completion',async()=>{
 state.table.get(socket).overlapped=false;const e=event();expect(answer(ioctl())).toBe(0);expect(error).toBe(0);expect(get(returned)).toBe(152);expect(get(ov)).toBe(0);expect(e.signaled).toBe(true);
 set(ov,0xfeed);set(ov+4,0xbeef);scheduler.resetEvent(get(ov+16));
 expect(answer(ioctl(1))).toBe(-1);expect(error).toBe(10014);await tick();expect(get(ov)).toBe(259);expect(get(ov+4)).toBe(0xbeef);expect(e.signaled).toBe(false);
});
test('control APCs retain the issuing owner and synchronous handles expose a zeroed private context',async()=>{
 for(const synchronous of [false,true]){
  state.table.get(socket).overlapped=!synchronous;let captured:any[]=[];
  const spy=spyOn(scheduler,'queueWsaCompletionApc').mockImplementation((...a)=>{captured=a;return true;});
  try{
   event();expect(answer(ioctl(out,4096,returned,ov,routine))).toBe(synchronous?0:-1);await tick();expect(captured[1]).toBe(routine);
   if(synchronous){const lifetime=captured[6] as ApcCallbackLifetime,args=lifetime.prepare!([0,152,ov,0])!;expect(args[1]).toBe(0);expect(args[2]).not.toBe(ov);expect(args[2]).toBeGreaterThan(0);expect([...ram.slice(args[2],args[2]+20)]).toEqual(new Array(20).fill(0));lifetime.onReturn!();expect(freed).toContain(args[2]);}
   else expect(captured.slice(2)).toEqual([0,152,ov,0]);
  }finally{spy.mockRestore();}
 }
});
test('opaque control contexts are bounded, release once and do not free memory from a retired process epoch',()=>{
 const pending=Array.from({length:256},()=>reserveControlApc(owner));expect(()=>reserveControlApc(owner)).toThrow();
 for(const lifetime of pending)lifetime.onDiscard!();
 const one=reserveControlApc(owner),args=one.prepare!([0,10,ov,0])!;owner.resetGeneration++;one.onDiscard!();one.onReturn!();expect(freed).not.toContain(args[2]);
 reserveControlApc(owner).onDiscard!();
});
test('WSAGetOverlappedResult treats unknown positive NTSTATUS success independently from DOS error317',()=>{
 set(ov,0xfeed);set(ov+4,0xbeef);set(returned,0);set(returned+4,0xa5);
 expect(answer(api.WSAGetOverlappedResult(ctx,ram,[socket,ov,returned,0,returned+4]))).toBe(1);expect(error).toBe(317);expect(get(returned)).toBe(0xbeef);expect(get(returned+4)).toBe(0);
});
