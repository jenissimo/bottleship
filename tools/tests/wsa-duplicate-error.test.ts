import {expect,test} from 'bun:test';
import {Process} from '../../src/worker/core/process';
import {System} from '../../src/worker/core/system';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {AddressSpace} from '../../src/worker/core/memory/address-space';
import {RootNetworkNamespace} from '../../src/worker/core/network-namespace';
import {LanNetwork} from '../../src/worker/net/lan-network';
import {createWsaActorTable} from '../../src/worker/modules/wsa-actor-table';
import {makeSocketExports,WsaStartupCount} from '../../src/worker/modules/wsa-stub-shared';
const value=(answer:any)=>typeof answer==='number'?answer:answer.value;
// Native winsock-handle-flags212 nonce1640434443: every successful A duplication
// clears the shared Win32/Winsock thread error (observation8+21*n). W uses the same adapter.
for(const wide of [false,true])test('WSADuplicateSocket'+(wide?'W':'A')+' clears success LastError and returns a usable authenticated actor reservation',async()=>{
    const system=System.getInstance(),previous=system.process,savedMem=Object.getOwnPropertyDescriptors(Mem);
    const ram=new Uint8Array(0x20000),space=new AddressSpace(()=>ram),owner=Object.create(Process.prototype) as Process;
    Object.assign(owner,{resetGeneration:0,getMemory:()=>ram,addressSpace:space});system.process=owner;
    Mem.bind(()=>ram,(pointer,size,perms)=>space.validateRange(pointer,size,perms));
    const network=new LanNetwork(),host=new RootNetworkNamespace(network,8,29101),table=createWsaActorTable(network,()=>host.socketActorClient());
    const counter=new WsaStartupCount();counter.startup();let error=0;
    try{
        const api=makeSocketExports(table,code=>{error=code;},counter,owner),source=table.socket(2),output=0x10000;
        const result=value(api[wide?'WSADuplicateSocketW':'WSADuplicateSocketA']({} as never,ram,[source,29101,output]));
        const view=new DataView(ram.buffer),reserved=view.getUint32(output+112,true);
        // Reissue with the exact native sentinel. Both reservations are real actor resources.
        error=0x1234;const repeated=value(api[wide?'WSADuplicateSocketW':'WSADuplicateSocketA']({} as never,ram,[source,29101,output]));
        expect({result,repeated,error}).toEqual({result:0,repeated:0,error:0});
        expect(reserved).toBeGreaterThan(0);expect(table.nativeHandleView.isValid(reserved)).toBe(true);
        expect(view.getUint32(output+76,true)).toBe(2);expect(view.getUint32(output+88,true)).toBe(2);expect(view.getUint32(output+92,true)).toBe(17);
        const second=view.getUint32(output+112,true);expect(second).not.toBe(reserved);
        expect(table.importDuplicate(second)).toBe(second);
        expect(table.fileObjectId(second)).toBe(table.fileObjectId(source));expect(table.isValid(source)).toBe(true);
    }finally{
        table.reset();await host.close();system.process=previous;
        for(const key of ['memoryGetter','validateRange','getRegion'])Object.defineProperty(Mem,key,savedMem[key]!);
    }
},10000);
