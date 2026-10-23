import{afterEach,beforeEach,expect,spyOn,test}from'bun:test';
import{System}from'../../src/worker/core/system';
import{Process}from'../../src/worker/core/process';
import{AddressSpace}from'../../src/worker/core/memory/address-space';
import{Mem}from'../../src/worker/core/memory/mem-accessor';
import{exports as file,resetFileIoState}from'../../src/worker/modules/kernel32/file-io';
const system=System.getInstance(),resources=system.resourceProvider,savedProcess=system.process,savedMem=Object.getOwnPropertyDescriptors(Mem);
let ram:Uint8Array,owner:Process,handles:number[],error:number,spy:ReturnType<typeof spyOn>;
beforeEach(()=>{ram=new Uint8Array(4<<20);const space=new AddressSpace(()=>ram);let next=0x100000;owner=Object.create(Process.prototype)as Process;Object.assign(owner,{resetGeneration:0,addressSpace:space,getMemory:()=>ram,getCurrentMemory:()=>ram,memory:{alloc(size:number){const p=next;next+=size+4096;space.registerRegion({base:p,size,kind:'HEAP',perms:'rw',owner:'test'});return p;},free(){}}});Mem.bind(()=>ram,(p,n,perms)=>space.validateRange(p,n,perms));system.process=owner;handles=[];error=0;spy=spyOn(system.scheduler,'setLastError').mockImplementation(code=>{error=code;});resetFileIoState();});
afterEach(()=>{for(const h of handles)resources.unregisterKernelObject(h);resetFileIoState();spy.mockRestore();system.process=savedProcess;for(const key of['memoryGetter','validateRange','getRegion'])Object.defineProperty(Mem,key,savedMem[key]!);});
for(const wide of[false,true])test('CreateFileMapping'+(wide?'W':'A')+' recognizes the unsigned INVALID_HANDLE_VALUE emitted by x86 thunks',async()=>{
 const fn=file[wide?'CreateFileMappingW':'CreateFileMappingA'],ctx={}as never;
 for(const sentinel of[0xffffffff,-1]){
  error=0x1234;const handle=fn(ctx,ram,[sentinel,0,4,0,64,0])as number;handles.push(handle);expect(handle).toBeGreaterThan(0);expect(error).toBe(0);
  const mapping=resources.getKernelObject(handle)as any;expect(mapping.kind).toBe('file_mapping');expect(mapping.file).toBeNull();expect(mapping.size).toBe(64);
  const base=await file.MapViewOfFile(ctx,ram,[handle,2,0,0,64])as number;expect(base).toBeGreaterThan(0);expect([...ram.slice(base,base+64)]).toEqual(new Array(64).fill(0));Mem.writeUint32(base+60,0x12345678);expect(Mem.readUint32(base+60)).toBe(0x12345678);file.UnmapViewOfFile(ctx,ram,[base]);
 }
 error=0;expect(fn(ctx,ram,[0x12345678,0,4,0,64,0])).toBe(0);expect(error).toBe(6);
});
