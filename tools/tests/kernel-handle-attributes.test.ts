import {beforeEach,afterEach,expect,test} from 'bun:test';
import {System} from '../../src/worker/core/system';
import {Process} from '../../src/worker/core/process';
import {Kernel32} from '../../src/worker/modules/kernel32';
import {SystemResourceProvider,IO_COMPLETION_ALL_ACCESS} from '../../src/worker/core/resources/system-resource-provider';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {AddressSpace} from '../../src/worker/core/memory/address-space';
import {EmulatorConfig,VER_PLATFORM_WIN32_NT} from '../../src/worker/core/emulator-config-manager';
import {exports as sync,captureFileIoCompletion,resetSyncState} from '../../src/worker/modules/kernel32/sync';
import {exports as fileIo} from '../../src/worker/modules/kernel32/file-io';
import {exports as processApi} from '../../src/worker/modules/kernel32/process/process';
// Measured Windows native74, nonce1634478063. Independent expected results, no build/log dependency.
const native={cases:[1,0].flatMap(nullTarget=>[1,3].map(options=>({nullTarget,options,duplicated:1,duplicateLastError:0x1234,sourceInfoSuccess:1,sourceInfoLastError:0x2345,sourceFlags:1,sourcePostSuccess:options===1?0:1,sourcePostLastError:options===1?5:0x5678,monitorPostSuccess:1,monitorPostLastError:0x3456})))};
const system=System.getInstance(),scheduler=system.scheduler,resources=system.resourceProvider;
const savedProcess=system.process,savedError=scheduler.setLastError,savedOwnerError=scheduler.setLastErrorForThread,savedTid=scheduler.getCurrentThreadId;
const savedMem=Object.getOwnPropertyDescriptors(Mem),register=resources.registerKernelObject;
let ram:Uint8Array,error:number,created:number[],files:number[],readonly:boolean,kernel:Kernel32;
const observed:any[]=[];const ctx={esp:0x18000} as never;
// Native128 lets a valid HANDLE's bad output escape through SEH, preserving LastError.
// Capture the API/dispatcher boundary here; real x86 dispatch and continuation have their own fixtures.
function handleOutputFault(handle:number,output:number){
 const process:any=system.process,previousV86=process.v86,previousDispatcher=process.dispatcher,calls:any[]=[];
 process.v86={cpu:{}};process.dispatcher={setupGuestAccessViolationDispatch(_cpu:any,memory:Uint8Array,esp:number,badAddress:number,write:boolean,cleanup:number){
  expect(memory).toBe(ram);calls.push({esp,badAddress,write,cleanup});return {value:0,skipStackCheck:true};
 }};
 try{expect(processApi.GetHandleInformation!(ctx,ram,[handle,output])).toEqual({value:0,skipStackCheck:true});return calls;}
 finally{process.v86=previousV86;process.dispatcher=previousDispatcher;}
}
const value=(result:any)=>typeof result==='number'?result:result.value;
const get=(ptr:number)=>new DataView(ram.buffer).getUint32(ptr,true),set=(ptr:number,n:number)=>new DataView(ram.buffer).setUint32(ptr,n,true);
function duplicate(source:number,output:number,options:number,inherit=true){return value(processApi.DuplicateHandle!(ctx,ram,[0xffffffff,source,0xffffffff,output,0,+inherit,options]));}
function close(handle:number){return value(fileIo.CloseHandle!(ctx,ram,[handle]));}
function create(){const handle=value(sync.CreateIoCompletionPort!(ctx,ram,[0xffffffff,0,0,1]));return {handle,object:resources.getKernelObject(handle)};}
function post(handle:number,bytes:number,key:number){return value(sync.PostQueuedCompletionStatus!(ctx,ram,[handle,bytes,key,0]));}
function info(handle:number){const fn=kernel.exports.GetHandleInformation;if(!fn)return {implemented:false,value:null,error:null,flags:null};set(0x10050,0xfeed);error=0x2345;const result=value(fn(ctx,ram,[handle,0x10050]));return {implemented:true,value:result,error,flags:get(0x10050)};}
beforeEach(()=>{
 resetSyncState();ram=new Uint8Array(0x20000);Mem.bind(()=>ram);error=0;readonly=false;created=[];files=[];
 resources.registerKernelObject=function(object:any){const handle=register.call(this,object);created.push(handle);return handle;};
 const owner=Object.create(Process.prototype) as Process;Object.assign(owner,{resetGeneration:0,getMemory:()=>ram,addressSpace:{validateRange:(ptr:number,size:number,perms='rw')=>ptr>0&&ptr+size<=ram.length&&!(readonly&&ptr<0x10044&&ptr+size>0x10040&&perms.includes('w')),write:(ptr:number,bytes:Uint8Array)=>{ram.set(bytes,ptr);return bytes.length;}}});
 system.process=owner;scheduler.getCurrentThreadId=()=>7;scheduler.setLastError=code=>{error=code;};scheduler.setLastErrorForThread=(_tid,code)=>{error=code;};
 kernel=new Kernel32();kernel.initialize(owner);
});
afterEach(()=>{
 resetSyncState();for(const handle of created){if(resources.getKernelObject(handle)?.kind==='event')scheduler.syncObjects.closeEvent(handle);else resources.unregisterKernelObject(handle);}for(const handle of files)resources.unregisterFileHandle(handle);
 resources.registerKernelObject=register;system.process=savedProcess;scheduler.setLastError=savedError;scheduler.setLastErrorForThread=savedOwnerError;scheduler.getCurrentThreadId=savedTid;
 for(const key of ['memoryGetter','validateRange','getRegion'])Object.defineProperty(Mem,key,savedMem[key]!);
});
for(const reference of native.cases)test('native74 same-process CLOSE_SOURCE null='+reference.nullTarget+' options='+reference.options,()=>{
 const {handle,object}=create();expect(duplicate(handle,0x10020,2,false)).toBe(1);const monitor=get(0x10020);
 const output=reference.nullTarget?0:0x10040;set(0x10040,0);error=0x1234;
 const duplicated=duplicate(handle,output,reference.options),duplicateError=error,target=get(0x10040),sourceInfo=info(handle);
 error=0x5678;const sourcePost=post(handle,6,41),sourcePostError=error;
 error=0x3456;const monitorPost=post(monitor,7,42),monitorPostError=error;
 const result={nullTarget:reference.nullTarget,options:reference.options,duplicated,duplicateError,sourceStillValid:resources.getKernelObject(handle)===object,outputIsSource:output?target===handle:null,sourceInfo,sourcePost,sourcePostError,monitorPost,monitorPostError};observed.push(result);
 expect(result).toEqual({nullTarget:reference.nullTarget,options:reference.options,duplicated:reference.duplicated,duplicateError:reference.duplicateLastError,sourceStillValid:true,outputIsSource:output?true:null,sourceInfo:{implemented:true,value:reference.sourceInfoSuccess,error:reference.sourceInfoLastError,flags:reference.sourceFlags},sourcePost:reference.sourcePostSuccess,sourcePostError:reference.sourcePostLastError,monitorPost:reference.monitorPostSuccess,monitorPostError:reference.monitorPostLastError});
});
test('NULL CLOSE_SOURCE has no unreachable IOCP alias after all caller-visible handles close',()=>{
 const {handle,object}=create();expect(duplicate(handle,0x10020,2,false)).toBe(1);const monitor=get(0x10020);
 const file=resources.registerFileHandle({});files.push(file);expect(value(sync.CreateIoCompletionPort!(ctx,ram,[file,handle,42,0]))).toBe(handle);
 const completion=captureFileIoCompletion(file)!;expect(duplicate(handle,0,3)).toBe(1);
 expect(completion.post(3,0x180)).toBe(true);close(handle);close(monitor);
 const result={remainingReferences:resources.kernelObjectReferenceCount(object),targetStillPosts:completion.post(4,0x184)};observed.push({lifetime:result});
 expect(result).toEqual({remainingReferences:0,targetStillPosts:false});
});
for(const output of [4095,0xfffffff0])test('failed CLOSE_SOURCE output cannot leak an unreachable alias output='+output,()=>{
 const {handle,object}=create();expect(duplicate(handle,0x10020,2,false)).toBe(1);const monitor=get(0x10020),before=resources.kernelObjectReferenceCount(object);
 const result=duplicate(handle,output,3);const record={output,result,error,before,after:resources.kernelObjectReferenceCount(object),sourceValid:resources.getKernelObject(handle)===object,monitorValid:resources.getKernelObject(monitor)===object};observed.push({unmeasuredBadPointerConservation:record});
 // Native74 measures NULL only. Assert ownership conservation on failure without inventing an OS return/error/close ordering contract.
 expect(record.after).toBeLessThanOrEqual(before);expect(record.monitorValid).toBe(true);
});
test('CLOSE_SOURCE does not bypass the owner write permission of a non-NULL destination',()=>{
 const {handle}=create();set(0x10040,0xa5a5a5a5);readonly=true;const result=duplicate(handle,0x10040,3);
 const record={result,error,output:get(0x10040)};observed.push({ownerMemorySafety:record});
 // This is the HLE owner-memory invariant; native bad non-NULL pointer behavior is not measured by native74.
 expect(record.output).toBe(0xa5a5a5a5);
});

for(const kind of ['iocp','event'])test('native182 handle flags and protected source remain per-alias kind='+kind,()=>{
 const handle=kind==='iocp'?create().handle:value(sync.CreateEventA!(ctx,ram,[0,1,0,0]));const object=resources.getKernelObject(handle);
 error=0x3456;expect(value(processApi.SetHandleInformation!(ctx,ram,[handle,1,1]))).toBe(1);expect(error).toBe(0x3456);
 expect(value(processApi.SetHandleInformation!(ctx,ram,[handle,2,2]))).toBe(1);expect(info(handle).flags).toBe(3);
 error=0x5678;expect(close(handle)).toBe(0);expect(error).toBe(6);expect(resources.getKernelObject(handle)).toBe(object);
 error=0x6789;expect(duplicate(handle,0x10040,3)).toBe(1);expect(error).toBe(0x6789);const copy=get(0x10040);expect(copy).not.toBe(handle);
 expect(resources.getKernelObject(copy)).toBe(object);expect(info(handle).flags).toBe(3);expect(info(copy).flags).toBe(1);
 error=0x789a;expect(value(processApi.SetHandleInformation!(ctx,ram,[copy,4,4]))).toBe(1);expect(error).toBe(0x789a);expect(info(copy).flags).toBe(1);
 expect(value(processApi.SetHandleInformation!(ctx,ram,[copy,1,0]))).toBe(1);expect(info(copy).flags).toBe(0);expect(close(copy)).toBe(1);
 expect(value(processApi.SetHandleInformation!(ctx,ram,[handle,2,0]))).toBe(1);expect(info(handle).flags).toBe(1);expect(close(handle)).toBe(1);
 expect(resources.kernelObjectReferenceCount(object)).toBe(0);
});
for(const access of [0,1,2,0x20000,0x80000000,0x40000000,0x20000000,0x10000000])test('native112 IOCP operations enforce this alias access='+access,()=>{
 const {handle,object}=create();const allowed=access===2||access===0x40000000||access===0x10000000;
 error=0x1234;expect(value(processApi.DuplicateHandle!(ctx,ram,[0xffffffff,handle,0xffffffff,0x10040,access,0,0]))).toBe(1);expect(error).toBe(0x1234);const copy=get(0x10040);
 error=0x2345;expect(post(copy,6,41)).toBe(allowed?1:0);expect(error).toBe(allowed?0x2345:5);
 expect(post(handle,7,42)).toBe(1);set(100,0xfeed);set(104,0xfeed);set(108,0xfeed);error=0x3456;
 expect(value(sync.GetQueuedCompletionStatus!(ctx,ram,[copy,100,104,108,0]))).toBe(allowed?1:0);expect(error).toBe(allowed?0x3456:5);
 expect([get(100),get(104),get(108)]).toEqual(allowed?[6,41,0]:[0xfeed,0xfeed,0]);
 if(!allowed){expect(value(sync.GetQueuedCompletionStatus!(ctx,ram,[handle,100,104,108,0]))).toBe(1);expect([get(100),get(104)]).toEqual([7,42]);}
 const file=resources.registerFileHandle({});files.push(file);error=0x4567;
 expect(value(sync.CreateIoCompletionPort!(ctx,ram,[file,copy,43,0]))).toBe(allowed?copy:0);expect(error).toBe(allowed?0x4567:5);
 expect(resources.getKernelObject(copy)).toBe(object);expect(resources.getHandleAttributes(handle)?.grantedAccess).toBe(IO_COMPLETION_ALL_ACCESS);
});
test('kernel HANDLE metadata and object references expire across allocator cleanup and numeric reuse',()=>{
 const provider=new SystemResourceProvider(),firstObject={kind:'iocp'},handle=provider.registerKernelObject(firstObject);
 expect(provider.setHandleFlags(handle,3,3)).toBe(true);expect(provider.replaceKernelHandle(handle,{grantedAccess:0,flags:1})).toBe(true);
 expect(provider.kernelObjectReferenceCount(firstObject)).toBe(1);provider.cleanup();expect(provider.getHandleAttributes(handle)).toBeUndefined();
 const replacement={kind:'iocp'},next=provider.registerKernelObject(replacement);expect(next).toBe(handle);
 expect(provider.getHandleAttributes(next)).toEqual({grantedAccess:IO_COMPLETION_ALL_ACCESS,flags:0});expect(provider.hasKernelObjectReference(firstObject)).toBe(false);
 provider.unregisterKernelObject(next);expect(provider.getHandleAttributes(next)).toBeUndefined();
});
for(const options of [1,3])test('native182 NT-profile low output CLOSE_SOURCE preserves the surviving IOCP object options='+options,()=>{
 const config=EmulatorConfig.getInstance(),previous=config.osVersion;config.osVersion={major:5,minor:1,build:2600,platformId:VER_PLATFORM_WIN32_NT};
 try{
  ram=new Uint8Array(0x20000);const space=new AddressSpace(()=>ram);Object.assign(system.process!,{addressSpace:space});
  Mem.bind(()=>ram,(pointer,size,perms)=>space.validateRange(pointer,size,perms));
  const {handle,object}=create(),monitorOutput=0x10020;
  expect(duplicate(handle,monitorOutput,2,false)).toBe(1);const monitor=get(monitorOutput);
  const file=resources.registerFileHandle({});files.push(file);expect(value(sync.CreateIoCompletionPort!(ctx,ram,[file,handle,42,0]))).toBe(handle);
  const completion=captureFileIoCompletion(file)!,before=ram.slice(0,16);error=0x1234;
  expect(duplicate(handle,1,options)).toBe(0);expect(error).toBe(998);expect(ram.slice(0,16)).toEqual(before);
  expect(resources.getKernelObject(handle)).toBeNull();expect(resources.getKernelObject(monitor)).toBe(object);
  expect(resources.kernelObjectReferenceCount(object)).toBe(1);expect(completion.post(3,0x123456)).toBe(true);
  expect(value(sync.GetQueuedCompletionStatus!(ctx,ram,[monitor,0x10040,0x10044,0x10048,0]))).toBe(1);
  expect([get(0x10040),get(0x10044),get(0x10048)]).toEqual([3,42,0x123456]);
 }finally{config.osVersion=previous;}
});
for(const output of [1,0xffff])test('native128 HANDLE information faults without publishing into a reserved user range output='+output,()=>{
 ram=new Uint8Array(0x20000);const space=new AddressSpace(()=>ram);Object.assign(system.process!,{addressSpace:space});
 Mem.bind(()=>ram,(pointer,size,perms)=>space.validateRange(pointer,size,perms));
 const {handle,object}=create();resources.setHandleFlags(handle,1,1);ram.fill(0xa5,output,output+4);const before=ram.slice(output,output+4);error=0x1234;
 expect(handleOutputFault(handle,output)).toEqual([{esp:0x18000,badAddress:output,write:true,cleanup:8}]);expect(error).toBe(0x1234);
 expect(ram.slice(output,output+4)).toEqual(before);expect(resources.getKernelObject(handle)).toBe(object);expect(resources.kernelObjectReferenceCount(object)).toBe(1);
});
test('NT-profile HANDLE output above the low guard remains writable with a real AddressSpace',()=>{
 const config=EmulatorConfig.getInstance(),previous=config.osVersion;config.osVersion={major:5,minor:1,build:2600,platformId:VER_PLATFORM_WIN32_NT};
 try{
  ram=new Uint8Array(0x20000);const space=new AddressSpace(()=>ram);Object.assign(system.process!,{addressSpace:space});
  Mem.bind(()=>ram,(pointer,size,perms)=>space.validateRange(pointer,size,perms));
  const {handle,object}=create();error=0x1234;expect(duplicate(handle,0x10000,3)).toBe(1);expect(error).toBe(0x1234);
  expect(get(0x10000)).toBe(handle);expect(resources.getKernelObject(handle)).toBe(object);expect(resources.kernelObjectReferenceCount(object)).toBe(1);
 }finally{config.osVersion=previous;}
});
test('handle flags validate the HANDLE and whole writable output while cleanup retires metadata',()=>{
 const {handle}=create();set(0x10050,0xa5a5a5a5);error=0;
 expect(value(processApi.GetHandleInformation!(ctx,ram,[0xdead,0x10050]))).toBe(0);expect(error).toBe(6);expect(get(0x10050)).toBe(0xa5a5a5a5);
 expect(handleOutputFault(handle,ram.length-1)).toEqual([{esp:0x18000,badAddress:ram.length,write:true,cleanup:8}]);expect(error).toBe(6);
 expect(close(handle)).toBe(1);expect(resources.getHandleAttributes(handle)).toBeUndefined();
 expect(value(processApi.SetHandleInformation!(ctx,ram,[handle,1,1]))).toBe(0);expect(error).toBe(6);
});
