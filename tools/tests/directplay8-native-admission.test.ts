import{beforeEach,afterEach,expect,test}from"bun:test";
import{DirectPlay8Callbacks}from"../../src/worker/modules/dpnet/callbacks";
import{DirectPlayCallbackExecutor}from"../../src/worker/modules/dpnet/executor";
import{DirectPlay8Session}from"../../src/worker/modules/dpnet/peer";
import{DirectPlayAddressApi}from"../../src/worker/modules/dpnet/address-api";
import{DPN}from"../../src/worker/modules/dpnet/constants";
import{LanNetwork}from"../../src/worker/net/lan-network";
import{Mem}from"../../src/worker/core/memory/mem-accessor";
import{System}from"../../src/worker/core/system";
import{SystemResourceProvider}from"../../src/worker/core/resources/system-resource-provider";
import{BaseComObject,ComObjectFactory}from"../../src/worker/core/com/base-com-object";
import{ThunkGenerator}from"../../src/worker/core/thunking/thunk-generator";
import{dpnetModule}from"../../src/worker/api/dpnet.api";
import type{Process}from"../../src/worker/core/process";
import type{NativeHostDecision,NativeHostJoin}from"../../src/worker/modules/dpnet/native-wire/host";
import type{ThunkResult,X86Context}from"../../src/worker/core/thunking/thunk-dispatcher";
import type{VTableInfo}from"../../src/worker/api/adapters/module-adapter";
const system=System.getInstance(),scheduler=system.scheduler,resource=SystemResourceProvider.getInstance();
const original={process:system.process,current:scheduler.getCurrentThreadId};
let ram:Uint8Array,active:Uint8Array,foreign:Uint8Array,process:Process,session:DirectPlay8Session,callbacks:DirectPlay8Callbacks,addresses:DirectPlayAddressApi,executor:DirectPlayCallbackExecutor;
let cursor:number,objects:BaseComObject[],reset:Set<()=>void>,calls:{args:number[];done(value:number):number|null;enumerationState?:{continueEnumeration():void}}[],frees:number[];
const ctx=()=>({esp:0x9000,eip:0x7000,eax:0,ebx:0,ecx:0,edx:0,edi:0,esi:0,ebp:0,eflags:0x202})as X86Context;
const write=(p:number,n:number)=>new DataView(ram.buffer).setUint32(p,n>>>0,true);
const read=(p:number)=>new DataView(ram.buffer).getUint32(p,true);
const controller=()=>new AbortController();
function request(signal:AbortSignal):NativeHostJoin{return{address:{node:[2,0,0,0,0,2],port:2309},signal,
 info:{flags:4,version:7,name:"Peer",data:new Uint8Array(),password:null,connectData:Uint8Array.of(3,0,4),url:null,
 instance:"0".repeat(32),application:"11223344556677889900aabbccddeeff",alternate:new Uint8Array()}};}
function runOne(handler:(message:number,ptr:number)=>number=()=>0){
 active=ram;const before=calls.length,result=callbacks.queue.run(ctx(),0)as ThunkResult;
 expect(result.suspendedForCallback).toBe(true);
 for(let i=before;i<calls.length;i++){const call=calls[i];const value=call.done(handler(call.args[1]&0xffff,call.args[2]));if(value===null)call.enumerationState?.continueEnumeration();}
}
beforeEach(()=>{
 ram=new Uint8Array(8<<20);foreign=new Uint8Array(ram.length);active=ram;Mem.bind(()=>active);cursor=0x600000;objects=[];reset=new Set();calls=[];frees=[];
 const alloc=(size:number)=>{const p=cursor;cursor+=(size+15)&~15;return p;};
 const generator=new ThunkGenerator();generator.setBaseAddress(0x500000);
 process={resetGeneration:0,thunkGenerator:generator,getCurrentMemory:()=>ram,memory:{alloc,allocSystemBlock:alloc,free:(p:number)=>frees.push(p),freeSystemBlock(){}},
 addressSpace:{validateRange:(p:number,n:number)=>p>=0x1000&&p+n<=ram.length},resourceProvider:{unregisterKernelObject(){}},
 onReset:(fn:()=>void)=>{reset.add(fn);return()=>reset.delete(fn);},dispatcher:{register(){},callbackManager:{
 saveSuspendedThunkContext:()=>1,abandonSuspendedFrame(){},getPendingCallback:(id:number)=>calls[id-1],
 invokeCallback:(_routine:number,args:number[],_cleanup:number,done:(value:number)=>number|null)=>{calls.push({args,done});return{callbackId:calls.length};}}}}as unknown as Process;
 system.process=process;scheduler.getCurrentThreadId=()=>1;
 const tables=Object.fromEntries(dpnetModule.interfaces!.map((i,n)=>[i.name,{address:0x20000+n*0x100,size:i.methods.length}]))as Record<string,VTableInfo>;
 for(const iface of dpnetModule.interfaces!)if(iface.iid){const iid=iface.iid;ComObjectFactory.register(iid,class TestObject extends BaseComObject{constructor(table:number){super(iid,table);objects.push(this);}protected destroy(){}});}
 const network=new LanNetwork(Uint8Array.of(2,0,0,0,0,1));session=new DirectPlay8Session(network);
 addresses=new DirectPlayAddressApi(process,()=>tables,network);executor=DirectPlayCallbackExecutor.forProcess(process);expect(executor.initialize(0x7000,0)).toBe(0);expect(executor.setCount(0)).toBe(0);
 callbacks=new DirectPlay8Callbacks(process,session,addresses,0x7000,0x1234);
});
afterEach(()=>{active=ram;callbacks.close();executor.reset();session.dispose();addresses.reset();for(const o of objects)resource.unregisterComObject(o.handle);system.process=original.process;scheduler.getCurrentThreadId=original.current;});
test("native admission only reads output on owner return and returns the original guest buffer exactly once",async()=>{
 const control=controller();active=foreign;const pending=callbacks.indicateNative(request(control.signal));expect(cursor).toBe(0x600000);expect(foreign.some(Boolean)).toBe(false);
 runOne((message,p)=>{expect(message).toBe(0xe);expect(read(p)).toBe(36);expect([...ram.slice(read(p+4),read(p+4)+3)]).toEqual([3,0,4]);
  expect([12,16,20,24].map(n=>read(p+n))).toEqual([0,0,0,0]);expect(read(p+28)).not.toBe(0);expect(read(p+32)).not.toBe(0);
  ram.set([8,0,9],0x3000);write(p+12,0x3000);write(p+16,3);write(p+20,0x7301);write(p+24,0x7201);return 0;});
 active=foreign;const decision=await pending;expect(decision.hr).toBe(0);expect(decision.context).toBe(0x7201);expect(decision.data).toEqual(Uint8Array.of(8,0,9));
 expect(callbacks.pending).toBe(0);ram.fill(0xee,0x3000,0x3003);expect(decision.data).toEqual(Uint8Array.of(8,0,9));
 const first=decision.returnBuffer!(),second=decision.returnBuffer!();expect(first).toBe(second);expect(foreign.some(Boolean)).toBe(false);
 runOne((message,p)=>{expect(message).toBe(0x13);expect([0,4,8,12].map(n=>read(p+n))).toEqual([16,0,0x3000,0x7301]);return 0;});
 await first;decision.release?.();expect(callbacks.pending).toBe(0);expect(calls.map(c=>c.args[1]&0xffff)).toEqual([0xe,0x13]);
});
test("INDICATED_CONNECT_ABORTED carries the exact native eight-byte context structure",()=>{
 expect(callbacks.emit({type:0xf,context:0x7201})).toBe(true);
 runOne((message,p)=>{expect(message).toBe(0xf);expect(read(p)).toBe(8);expect(read(p+4)).toBe(0x7201);return 0;});
});
test("a rejected native admission preserves actual callback HRESULT and reply bytes for C5",async()=>{
 const pending=callbacks.indicateNative(request(controller().signal));
 runOne((_m,p)=>{ram.set([5,0],0x3000);write(p+12,0x3000);write(p+16,2);return 1;});
 const decision=await pending;expect(decision.hr).toBe(1);expect(decision.data).toEqual(Uint8Array.of(5,0));
 const returned=decision.returnBuffer!();runOne();await returned;decision.release?.();
});
test("Close before pending INDICATE preparation cancels its owner task without materializing guest memory",async()=>{
 const c=controller(),pending=callbacks.indicateNative(request(c.signal));active=foreign;c.abort();const decision=await pending;
 expect(decision.hr).toBe(DPN.USERCANCEL);expect(callbacks.pending).toBe(0);expect(cursor).toBe(0x600000);expect(foreign.some(Boolean)).toBe(false);
});
test("discarding an admitted decision still returns its application buffer once before ownership is released",async()=>{
 const pending=callbacks.indicateNative(request(controller().signal));runOne((_m,p)=>{write(p+12,0x3000);write(p+16,0);write(p+20,0x7301);return 0;});
 const decision=await pending;decision.release?.();decision.release?.();await Promise.resolve();expect(callbacks.pending).toBe(1);
 runOne((m,p)=>{expect(m).toBe(0x13);expect(read(p+8)).toBe(0x3000);return 0;});await Promise.resolve();expect(callbacks.pending).toBe(0);
});
test("process reset discards old pending native admission without reading replacement memory or queuing late callbacks",async()=>{
 const pending=callbacks.indicateNative(request(controller().signal));active=foreign;(process as unknown as{resetGeneration:number}).resetGeneration++;
 for(const fn of [...reset])fn();const decision=await pending;expect(decision.hr).toBe(DPN.USERCANCEL);expect(cursor).toBe(0x600000);expect(foreign.some(Boolean)).toBe(false);
});
test("active indication cancelled before return still releases its returned guest buffer once",async()=>{
 const c=controller(),pending=callbacks.indicateNative(request(c.signal));let returns=0;
 runOne((message,p)=>{if(message===0xe){c.abort();write(p+12,0x3000);write(p+16,0);write(p+20,0x7301);}else if(message===0x13){returns++;expect(read(p+8)).toBe(0x3000);}return 0;});
 expect((await pending).hr).toBe(DPN.USERCANCEL);expect(returns).toBe(1);expect(callbacks.pending).toBe(0);
});
test("reply ownership survives callback backpressure without bypassing the existing queue quota",async()=>{
 const pending=callbacks.indicateNative(request(controller().signal));
 runOne((_m,p)=>{write(p+12,0x3000);write(p+16,0);return 0;});const decision=await pending;
 let accepted=0;while(callbacks.native(2,0)){if(++accepted>3000)throw Error("Unbounded callback queue");}expect(accepted).toBe(2304);
 const returned=decision.returnBuffer!();expect(callbacks.pending).toBe(2304);runOne();await new Promise(resolve=>setTimeout(resolve,8));
 expect(callbacks.pending).toBe(1);let count=0;runOne((message,p)=>{expect(message).toBe(0x13);expect(read(p+8)).toBe(0x3000);count++;return 0;});await returned;expect(count).toBe(1);
});
test("old reply ownership after process reset cannot materialize a callback in replacement memory",async()=>{
 const pending=callbacks.indicateNative(request(controller().signal));runOne((_m,p)=>{write(p+12,0x3000);return 0;});const decision=await pending;
 (process as unknown as{resetGeneration:number}).resetGeneration++;for(const fn of [...reset])fn();active=foreign;
 const result=await Promise.resolve(decision.returnBuffer!()).catch(error=>error);expect(result).toBeInstanceOf(Error);expect(callbacks.pending).toBe(0);expect(foreign.some(Boolean)).toBe(false);
});
test("native admission has its own aggregate bound and no callback allocation after refusal",async()=>{
 const controls=Array.from({length:17},controller),pending=controls.map(c=>callbacks.indicateNative(request(c.signal)));
 expect((await pending[16]).hr).toBe(DPN.TABLEFULL);expect(callbacks.pending).toBe(16);expect(cursor).toBe(0x600000);
 controls.forEach(c=>c.abort());await Promise.all(pending);expect(callbacks.pending).toBe(0);
});
