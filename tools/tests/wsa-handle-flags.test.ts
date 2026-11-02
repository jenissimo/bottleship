import {afterEach,beforeEach,expect,test} from 'bun:test';
import {Process} from '../../src/worker/core/process';
import {System} from '../../src/worker/core/system';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {getWsaProcessState,makeSocketExports} from '../../src/worker/modules/wsa-stub-shared';
import {exports as processApi} from '../../src/worker/modules/kernel32/process/process';
import {exports as fileIo} from '../../src/worker/modules/kernel32/file-io';
import {ipv4Address} from '../../src/worker/modules/wsa-network';
const system=System.getInstance(),scheduler=system.scheduler,savedProcess=system.process,savedError=scheduler.setLastError;
let owner:Process,ram:Uint8Array,error:number,state:ReturnType<typeof getWsaProcessState>;
const ctx={} as never,value=(answer:any)=>typeof answer==='number'?answer:answer.value;
const invoke=(name:string,args:number[])=>value(processApi[name](ctx,ram,args));
const flags=(handle:number)=>{expect(invoke('GetHandleInformation',[handle,0x10000])).toBe(1);return new DataView(ram.buffer).getUint32(0x10000,true);};
beforeEach(()=>{
 ram=new Uint8Array(0x20000);Mem.bind(()=>ram);error=0;
 owner=Object.create(Process.prototype) as Process;Object.assign(owner,{resetGeneration:0,getMemory:()=>ram,addressSpace:{validateRange:(p:number,n:number)=>p>0&&p+n<=ram.length}});
 system.process=owner;scheduler.setLastError=code=>{error=code;};state=getWsaProcessState(owner);
});
afterEach(()=>{state.reset();system.process=savedProcess;scheduler.setLastError=savedError;});
for(const creation of [undefined,0,1,0x80,0x81])test('native212 socket inheritance flags creation='+creation,()=>{
 state.counter.startup();const api=makeSocketExports(state.table,code=>{error=code;},state.counter,owner);
 const handle=value(creation===undefined?api.socket(ctx,ram,[2,2,17]):api.WSASocketA(ctx,ram,[2,2,17,0,0,creation]));
 expect(handle).toBeGreaterThan(0);error=0x2345;expect(flags(handle)).toBe(creation!==undefined&&(creation&0x80)?0:1);expect(error).toBe(0x2345);
});
test('native protected closesocket preserves actual UDP traffic and clears the issuing error',()=>{
 state.counter.startup();const api=makeSocketExports(state.table,code=>{error=code;},state.counter,owner);
 const source=state.table.socket(2),peer=state.table.socket(2),a=ipv4Address(state.table.network.ipv4,31611),b=ipv4Address(state.table.network.ipv4,31612);
 state.table.bind(source,a);state.table.bind(peer,b);expect(invoke('SetHandleInformation',[source,2,2])).toBe(1);
 error=0x1234;expect(value(api.closesocket(ctx,ram,[source]))).toBe(0);expect(error).toBe(0);expect(flags(source)).toBe(3);
 expect(state.table.send(source,Uint8Array.of(97),b)).toBe(1);expect([...state.table.receive(peer,1).data]).toEqual([97]);
 expect(state.table.send(peer,Uint8Array.of(98),a)).toBe(1);expect([...state.table.receive(source,1).data]).toEqual([98]);
 expect(invoke('SetHandleInformation',[source,2,0])).toBe(1);expect(value(api.closesocket(ctx,ram,[source]))).toBe(0);expect(state.table.isValid(source)).toBe(false);
});
test('kernel attributes authenticate native SOCKETs before startup and reject closed handles',()=>{
 const handle=state.table.socket(2);expect(state.counter.started).toBe(false);expect(flags(handle)).toBe(1);
 expect(invoke('SetHandleInformation',[handle,1,0])).toBe(1);expect(flags(handle)).toBe(0);expect(state.counter.started).toBe(false);
 expect(invoke('SetHandleInformation',[handle,2,2])).toBe(1);error=0x1234;expect(value(fileIo.CloseHandle!(ctx,ram,[handle]))).toBe(0);expect(error).toBe(6);expect(state.table.isValid(handle)).toBe(true);
 expect(invoke('SetHandleInformation',[handle,2,0])).toBe(1);expect(value(fileIo.CloseHandle!(ctx,ram,[handle]))).toBe(1);
 expect(invoke('GetHandleInformation',[handle,0x10000])).toBe(0);expect(error).toBe(6);expect(system.resourceProvider.getHandleAttributes(handle)).toBeUndefined();expect(state.counter.started).toBe(false);
});
