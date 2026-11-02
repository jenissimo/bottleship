import {afterEach,beforeEach,expect,test} from 'bun:test';
import {Process} from '../../src/worker/core/process';
import {System} from '../../src/worker/core/system';
import {AddressSpace} from '../../src/worker/core/memory/address-space';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {lanNetwork} from '../../src/worker/net/lan-network';
import {getVirtualNetworkTopology} from '../../src/worker/net/virtual-topology';
import {createDnsStubs,createAddrInfoStubs,getWsaProcessState} from '../../src/worker/modules/wsa-stub-shared';
const system=System.getInstance(),savedProcess=system.process,savedMem=Object.getOwnPropertyDescriptors(Mem);
let ram:Uint8Array,owner:Process,state:ReturnType<typeof getWsaProcessState>,api:any,connected:boolean;
const ctx={}as never,host=0x18000,returned=0x19000;
const word=(p:number)=>new DataView(ram.buffer).getUint32(p,true),text=(p:number)=>{let q=p;while(ram[q])q++;return new TextDecoder().decode(ram.subarray(p,q));};
beforeEach(()=>{
 ram=new Uint8Array(4<<20);const space=new AddressSpace(()=>ram);let allocation=0x100000;owner=Object.create(Process.prototype)as Process;
 Object.assign(owner,{resetGeneration:0,addressSpace:space,getCurrentMemory:()=>ram,getMemory:()=>ram,memory:{alloc(size:number){const p=allocation;allocation+=size+16;space.registerRegion({base:p,size,perms:'rw',kind:'HEAP',owner:'test'});return p;},free(){}}});
 Mem.bind(()=>ram,(p,n,perms)=>space.validateRange(p,n,perms));system.process=owner;state=getWsaProcessState(owner);state.counter.startup();
 api={...createDnsStubs(owner,()=>{}),...createAddrInfoStubs(owner,()=>{})};connected=lanNetwork.connected;
});
afterEach(()=>{state.reset();lanNetwork.setConnected(connected);system.process=savedProcess;for(const key of ['memoryGetter','validateRange','getRegion'])Object.defineProperty(Mem,key,savedMem[key]!);});
function addresses(name:string):number[][]{
 Mem.writeBytes(host,new TextEncoder().encode(name+'\0'));
 expect(api.getaddrinfo(ctx,ram,[host,0,0,returned])).toBe(0);const head=word(returned),result:number[][]=[];
 for(let p=head;p;p=word(p+28)){const family=word(p+4),sa=word(p+24);result.push(Array.from(ram.slice(sa+(family===23?8:4),sa+(family===23?24:8))));}
 api.freeaddrinfo(ctx,ram,[head]);return result;
}
test('self hostname and both resolver APIs retain virtual NIC identity through offline startup and relay loss',()=>{
 lanNetwork.setConnected(true);expect(api.gethostname(ctx,ram,[host,256])).toBe(0);const name=text(host),topology=getVirtualNetworkTopology();
 const local=topology.interfaces[0].addresses.map(address=>Array.from(address.address));
 for(const online of [false,true,false]){
  lanNetwork.setConnected(online);expect(api.gethostname(ctx,ram,[host,256])).toBe(0);expect(text(host)).toBe(name);
  const entry=api.gethostbyname(ctx,ram,[host]);expect(entry).toBeGreaterThan(0);const address=word(word(entry+12));expect(Array.from(ram.slice(address,address+4))).toEqual(local[0]);
  const resolved=addresses(name);expect(resolved.some(ip=>ip.length===4&&ip.join('.')===local[0].join('.'))).toBe(true);expect(resolved.some(ip=>ip.length===16&&ip.join('.')===local[1].join('.'))).toBe(true);
  expect(getVirtualNetworkTopology()).toEqual(topology);
 }
});
test('localhost remains loopback in both families independently of the relay state',()=>{
 const loopback=getVirtualNetworkTopology().interfaces[1].addresses.map(address=>Array.from(address.address));
 for(const online of [false,true]){
  lanNetwork.setConnected(online);const result=addresses('localhost');expect(result.every(ip=>loopback.some(local=>ip.join('.')===local.join('.')))).toBe(true);expect(result.some(ip=>ip.length===4)).toBe(true);expect(result.some(ip=>ip.length===16)).toBe(true);
 }
});
