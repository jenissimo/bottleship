import {afterEach,beforeEach,expect,spyOn,test} from 'bun:test';
import {System} from '../../src/worker/core/system';
import {Process} from '../../src/worker/core/process';
import {AddressSpace} from '../../src/worker/core/memory/address-space';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import * as guestFault from '../../src/worker/core/thunking/guest-fault';
import {LanNetwork} from '../../src/worker/net/lan-network';
import {Iphlpapi} from '../../src/worker/modules/iphlpapi';
import {WsaSocketTable} from '../../src/worker/modules/wsa-network';
import {makeSocketExports,WsaStartupCount,getWsaSocketTable} from '../../src/worker/modules/wsa-stub-shared';
const system=System.getInstance(),scheduler=system.scheduler,savedProcess=system.process,savedError=scheduler.setLastError;
const savedMem=Object.getOwnPropertyDescriptors(Mem);let ram:Uint8Array,space:AddressSpace,owner:Process,net:LanNetwork,module:Iphlpapi,error:number,spy:ReturnType<typeof spyOn>,faults:any[],tables:WsaSocketTable[];
const ctx={esp:0x90000} as never,ptr=0x18000,out=0x20000,capacity=8192;
const word=(p:number)=>new DataView(ram.buffer).getUint32(p,true),set=(p:number,n:number)=>new DataView(ram.buffer).setUint32(p,n,true);
const value=(r:any)=>typeof r==='number'?r:r.value;
beforeEach(()=>{
 ram=new Uint8Array(2*1024*1024);space=new AddressSpace(()=>ram);owner=Object.create(Process.prototype) as Process;Object.assign(owner,{resetGeneration:0,getMemory:()=>ram,getCurrentMemory:()=>ram,addressSpace:space});
 Mem.bind(()=>ram,(p,n,perms)=>space.validateRange(p,n,perms));system.process=owner;error=0;faults=[];tables=[];scheduler.setLastError=n=>{error=n;};
 spy=spyOn(guestFault,'raiseGuestAccessViolation').mockImplementation((_ctx,_mem,address,access,cleanup)=>{faults.push({address,access,cleanup});return {value:0,terminated:true};});
 net=new LanNetwork(Uint8Array.of(2,0,0,7,6,5));module=new Iphlpapi(net);module.initialize(owner);
});
afterEach(()=>{for(const table of tables)table.reset();spy.mockRestore();system.process=savedProcess;scheduler.setLastError=savedError;for(const key of ['memoryGetter','validateRange','getRegion'])Object.defineProperty(Mem,key,savedMem[key]!);});
function call(modern:boolean,output:number,sizePointer:number,family=0,flags=0){return module.exports[modern?'GetAdaptersAddresses':'GetAdaptersInfo'](ctx,ram,modern?[family,flags,0,output,sizePointer]:[output,sizePointer]);}
function protect(base:number,size:number,perms:'r'|'noaccess'){space.registerRegion({base,size,perms,kind:'RESERVED',owner:'test',allowOverlap:true});}
for(const modern of [false,true]){
 test('native IP Helper size negotiation and whole-capacity zeroing, modern='+modern,()=>{
  expect(getWsaSocketTable(owner)).toBeUndefined();set(ptr,0);error=0x1234;
  expect(value(call(modern,0,ptr))).toBe(111);expect(error).toBe(0);const needed=word(ptr);expect(needed).toBeGreaterThanOrEqual(modern?752:640);
  ram.fill(0xa5,out,out+capacity+1);set(ptr,needed-1);error=0x1234;expect(value(call(modern,out,ptr))).toBe(111);expect(word(ptr)).toBe(needed);expect(error).toBe(0);expect(ram[out]).toBe(0xa5);
  set(ptr,capacity);error=0x1234;expect(value(call(modern,out,ptr))).toBe(0);expect(error).toBe(0);expect(word(ptr)).toBe(capacity);expect(ram[out+capacity-1]).toBe(0);expect(ram[out+capacity]).toBe(0xa5);
  expect(faults).toEqual([]);expect(getWsaSocketTable(owner)).toBeUndefined();
 });
 test('IP Helper accepts read-only size storage on success but faults when overflow must update it, modern='+modern,()=>{
  set(ptr,capacity);protect(ptr,4096,'r');ram.fill(0xa5,out,out+capacity);expect(value(call(modern,out,ptr))).toBe(0);expect(word(ptr)).toBe(capacity);expect(faults).toEqual([]);
  // A fresh owner map isolates the short-capacity variant without changing raw pages globally.
  space=new AddressSpace(()=>ram);Object.assign(owner,{addressSpace:space});set(ptr,0);protect(ptr,4096,'r');
  const answer=call(modern,0,ptr) as any;expect(answer.terminated).toBe(true);expect(faults).toEqual([{address:ptr,access:'w',cleanup:modern?20:8}]);expect(word(ptr)).toBe(0);
 });
 test('IP Helper exposes native access violations and the cleared prefix instead of returning a fabricated status, modern='+modern,()=>{
  const boundary=0x30000,output=boundary-2;ram.fill(0xa5,output,output+capacity);set(ptr,capacity);protect(boundary,4096,'noaccess');error=0x1234;
  const answer=call(modern,output,ptr) as any;expect(answer.terminated).toBe(true);expect(faults).toEqual([{address:boundary,access:'w',cleanup:modern?20:8}]);
  expect([...ram.slice(output,boundary+1)]).toEqual([0,0,0xa5]);expect(word(ptr)).toBe(capacity);
 });
 test('IP Helper distinguishes NULL size from inaccessible size storage, modern='+modern,()=>{
  error=0x1234;expect(value(call(modern,out,0))).toBe(87);expect(error).toBe(0x1234);expect(faults).toEqual([]);
  call(modern,out,1);expect(faults).toEqual([{address:1,access:'r',cleanup:modern?20:8}]);
 });
}
test('GetAdaptersAddresses rejects unknown families while ignoring unrecognized flag bits and Reserved',()=>{
 set(ptr,capacity);error=0x1234;expect(value(call(true,out,ptr,999))).toBe(87);expect(error).toBe(0x1234);expect(word(ptr)).toBe(capacity);
 expect(value(module.exports.GetAdaptersAddresses(ctx,ram,[23,0x80000000,1,out,ptr]))).toBe(0);expect(error).toBe(0);
 const next=word(out+8);expect(next).toBeGreaterThan(out);for(const row of [out,next]){const entry=word(row+16),address=word(entry+12);expect(new DataView(ram.buffer).getUint16(address,true)).toBe(23);}
});
function socketApi(family=2){const table=new WsaSocketTable(net);tables.push(table);const counter=new WsaStartupCount();counter.startup();const socket=table.socket(2,family);return {table,socket,api:makeSocketExports(table,n=>{error=n;},counter,owner)};}
function ioctl(api:any,socket:number,output=out,size=capacity,returned=ptr){return value(api.WSAIoctl(ctx,ram,[socket,0x4004747f,0,0,output,size,returned,0,0]));}
test('native SIO_GET_INTERFACE_LIST publishes the same IPv4 topology without binding its socket',()=>{
 const {api,socket,table}=socketApi();ram.fill(0xa5,out,out+capacity);set(ptr,0xdeadbeef);error=0x1234;
 expect(ioctl(api,socket)).toBe(0);expect(error).toBe(0);expect(word(ptr)).toBe(152);expect(word(out)).toBe(19);expect([...ram.slice(out+8,out+12)]).toEqual([10,7,6,5]);expect(ram[out+152]).toBe(0xa5);expect(table.get(socket).local).toBeNull();
});
test('native SIO_GET_INTERFACE_LIST short output retains complete prefix records and resets returned bytes',()=>{
 const {api,socket}=socketApi();ram.fill(0xa5,out,out+capacity);set(ptr,0xdeadbeef);
 expect(ioctl(api,socket,out,76)).toBe(-1);expect(error).toBe(10014);expect(word(ptr)).toBe(0);expect(word(out)).toBe(19);expect(ram[out+76]).toBe(0xa5);
});
test('native interface list full-capacity protection probing precedes output, while byte-count protection is checked last',()=>{
 const {api,socket}=socketApi();ram.fill(0xa5,out,out+capacity);set(ptr,0xdeadbeef);protect(out+4096,4096,'r');
 expect(ioctl(api,socket)).toBe(-1);expect(error).toBe(10014);expect(word(ptr)).toBe(0);expect(ram[out]).toBe(0xa5);
 space=new AddressSpace(()=>ram);Object.assign(owner,{addressSpace:space});set(ptr,0xdeadbeef);protect(ptr,4096,'r');
 expect(ioctl(api,socket)).toBe(-1);expect(error).toBe(10014);expect(word(ptr)).toBe(0xdeadbeef);expect(word(out)).toBe(19);
});
test('native interface list NULL byte-count pointer is rejected before touching output',()=>{
 const {api,socket}=socketApi();ram.fill(0xa5,out,out+capacity);
 expect(ioctl(api,socket,out,capacity,0)).toBe(-1);expect(error).toBe(10014);expect(ram[out]).toBe(0xa5);
});
test('native interface list rejects IPv6 provider with EINVAL rather than inventing IPv6 records',()=>{
 const {api,socket}=socketApi(23);set(ptr,0xdeadbeef);ram.fill(0xa5,out,out+capacity);
 expect(ioctl(api,socket)).toBe(-1);expect(error).toBe(10022);expect(word(ptr)).toBe(0);expect(ram[out]).toBe(0xa5);
});
