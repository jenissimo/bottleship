import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Ole32 } from '../../src/worker/modules/ole32';
import { Combase } from '../../src/worker/modules/combase';
import { HleComServer } from '../../src/worker/core/com/hle-com-server';
import { BaseComObject, ComObjectFactory } from '../../src/worker/core/com/base-com-object';
import { registerComVtableOwner } from '../../src/worker/core/com/com-memory';
import { comApartments } from '../../src/worker/core/com/apartment';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { ModuleRegistry } from '../../src/worker/core/module-registry';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { preemptionManager } from '../../src/worker/core/cpu/preemption-manager';
import { resetGuestCodeInvalidationState } from '../../src/worker/core/memory/guest-code';
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from '../../src/worker/core/cpu/emulator-config';
import { EmulatorConfig } from '../../src/worker/core/emulator-config-manager';
import { hleImageBase, isHleModuleLoaded, markHleModuleLoaded, materializeHleModuleImages, resetHleModuleImages, retainHleModuleLoaded } from '../../src/worker/core/hle-module-images';
import { exports as kernel32 } from '../../src/worker/modules/kernel32/module/module';
import { kernel32Module } from '../../src/worker/api/kernel32.api';
import { guidBytes } from '../../src/worker/modules/dpnet/constants';
import type { ModuleDescriptor } from '../../src/worker/api/types';
import type { VTableInfo } from '../../src/worker/api/adapters/module-adapter';
import type { Process } from '../../src/worker/core/process';

const system=System.getInstance(), resources=system.resourceProvider, config=EmulatorConfig.getInstance();
const savedProcess=system.process, savedThread=system.scheduler.getCurrentThreadId, savedMem=Object.getOwnPropertyDescriptors(Mem);
const CLSID='e91b4460-b268-4ab7-8cad-4dd65be93201', IID='e91b4460-b268-4ab7-8cad-4dd65be93202';
const BAD='e91b4460-b268-4ab7-8cad-4dd65be93203', FACTORY='00000001-0000-0000-c000-000000000046';
const DLL='user32'; // Any materialized descriptor can own a registered COM server.
let ram:Uint8Array, owner:any, ole:Ole32, thread:number, baseline:Set<number>, savedExports:unknown, savedDisabled:string[];
const ctx={esp:0x1800,eip:0} as never;
function call(api:string,args:number[]=[]):any{return ole.exports[api]!(ctx,ram,args);}
function create(iid=0x1040):number{return call('CoCreateInstance',[0x1000,0,1,iid,0x1100]);}
function name(){const bytes=new TextEncoder().encode(DLL+'.dll\0');ram.set(bytes,0x1200);return 0x1200;}
function getHandle(){return (kernel32.GetModuleHandleA!(ctx,ram,[name()]) as any).value as number;}
function library(){return (kernel32.LoadLibraryA!(ctx,ram,[name()]) as any).value as number;}
function free(handle:number){return (kernel32.FreeLibrary!(ctx,ram,[handle]) as any).value as number;}
function release(){const object=resources.getComObjectByAddress(Mem.readUint32(0x1100)!)!;object.release();Mem.writeUint32(0x1100,0);}
beforeAll(()=>{
    APIRegistry.getInstance().registerModule(kernel32Module);
    ram=new Uint8Array(MEM_HLE_IMAGE_BASE+MEM_HLE_IMAGE_SIZE);
    savedExports=(preemptionManager as any).wasmExports;
    (preemptionManager as any).wasmExports={jit_dirty_cache(){},jit_clear_cache_js(){}};
    savedDisabled=config.disabledDlls;
});
beforeEach(()=>{
    Mem.bind(()=>ram);thread=7;config.disabledDlls=[];comApartments.reset();
    baseline=new Set(resources.getAllComObjects().map(o=>o.handle));
    let next=0x200000;const alloc=(size:number)=>{const p=next;next+=(size+15)&~15;return p;};
    const gen=new ThunkGenerator();gen.setBaseAddress(0x21046000);
    owner={resetGeneration:0,lastError:0,thunkGenerator:gen,modules:new Map(),moduleRegistry:new ModuleRegistry(),
        dispatcher:{registerModule(){},applyPendingRegistrations(){},thunkGenerator:gen,pendingRegistrations:new Map()},
        getCurrentMemory:()=>ram,memory:{alloc,free(){},allocSystemBlock:alloc,freeSystemBlock(){}},
        addressSpace:{validateRange:(p:number,n:number)=>p>0&&p+n<=ram.length}};
    system.process=owner;system.scheduler.getCurrentThreadId=()=>thread;
    materializeHleModuleImages(owner);
    const descriptor={name:DLL,functions:[],interfaces:[{name:'LoadReasonObject',iid:IID,methods:[]}]} as ModuleDescriptor;
    const tables={IClassFactory:{address:0x6000,size:5},LoadReasonObject:{address:0x6100,size:3}} as Record<string,VTableInfo>;
    for(const table of Object.values(tables))registerComVtableOwner(table.address,DLL);
    ComObjectFactory.register(IID,class extends BaseComObject{constructor(table:number){super(IID,table);}protected destroy(){}});
    const server=new HleComServer(owner as Process,descriptor,()=>tables,[{clsid:CLSID,interfaces:['LoadReasonObject']}]);
    server.install({});
    ole=new Ole32();ole.initialize(owner);
    ram.set(guidBytes(CLSID),0x1000);ram.set(guidBytes(FACTORY),0x1020);ram.set(guidBytes(IID),0x1040);ram.set(guidBytes(BAD),0x1060);
});
afterEach(()=>{
    for(const object of resources.getAllComObjects())if(!baseline.has(object.handle))object.forceRelease();
    ole.reset();comApartments.reset();system.process=savedProcess;system.scheduler.getCurrentThreadId=savedThread;config.disabledDlls=savedDisabled;
    resetHleModuleImages();
});
afterAll(()=>{
    (preemptionManager as any).wasmExports=savedExports;resetGuestCodeInvalidationState();
    for(const key of ['memoryGetter','validateRange','getRegion'])Object.defineProperty(Mem,key,savedMem[key]!);
});
test('installing a COM class catalog does not load its descriptor module',()=>{
    expect(hleImageBase(DLL)).toBeDefined();expect(getHandle()).toBe(0);expect(isHleModuleLoaded(DLL)).toBe(false);
});
test('activation loads by descriptor and nested COM initialization retains it until the final leave',()=>{
    expect(call('CoInitialize',[0])).toBe(0);expect(call('CoInitialize',[0])).toBe(1);
    expect(create()).toBe(0);expect(getHandle()).toBe(hleImageBase(DLL));release();
    call('CoUninitialize');expect(getHandle()).toBe(hleImageBase(DLL));
    call('CoUninitialize');expect(getHandle()).toBe(0);
});
test('a known class loads its server before an unsupported IID is rejected',()=>{
    call('CoInitialize',[0]);expect(create(0x1060)).toBe(0x80004002);expect(Mem.readUint32(0x1100)).toBe(0);
    expect(getHandle()).toBe(hleImageBase(DLL));call('CoUninitialize');expect(getHandle()).toBe(0);
});
test('unknown classes never acquire a COM module reference',()=>{
    call('CoInitialize',[0]);expect(call('CoCreateInstance',[0x1060,0,1,0x1060,0x1100])).toBe(0x80040154);
    expect(getHandle()).toBe(0);call('CoUninitialize');expect(getHandle()).toBe(0);
});
test('explicit LoadLibrary references survive COM cleanup and unload after the final FreeLibrary',()=>{
    const first=library(),second=library();expect(first).toBe(second);
    call('CoInitialize',[0]);expect(create()).toBe(0);release();call('CoUninitialize');
    expect(getHandle()).toBe(first);expect(free(first)).toBe(1);expect(getHandle()).toBe(first);
    expect(free(second)).toBe(1);expect(getHandle()).toBe(0);
});
test('freeing an explicit reference while COM owns the module preserves the COM reference',()=>{
    call('CoInitialize',[0]);expect(create()).toBe(0);release();const handle=library();free(handle);
    expect(getHandle()).toBe(handle);call('CoUninitialize');expect(getHandle()).toBe(0);
});
test('an import reference survives COM cleanup and dynamic FreeLibrary',()=>{
    markHleModuleLoaded(DLL);const handle=library();
    call('CoInitialize',[0]);expect(create()).toBe(0);release();call('CoUninitialize');free(handle);
    expect(getHandle()).toBe(handle);expect(isHleModuleLoaded(DLL)).toBe(true);
});
test('another initialized apartment retains the server until its own final leave',()=>{
    call('CoInitialize',[0]);expect(create()).toBe(0);release();
    thread=11;call('CoInitialize',[0]);expect(create()).toBe(0);release();
    thread=7;call('CoUninitialize');expect(getHandle()).toBe(hleImageBase(DLL));
    thread=11;call('CoUninitialize');expect(getHandle()).toBe(0);
});
test('CoGetClassObject uses the same descriptor load reason and release policy',()=>{
    call('CoInitialize',[0]);expect(call('CoGetClassObject',[0x1000,1,0,0x1020,0x1100])).toBe(0);
    expect(getHandle()).toBe(hleImageBase(DLL));release();call('CoUninitialize');expect(getHandle()).toBe(0);
});
test('a rejected disabled server does not acquire a load reason',()=>{
    config.disabledDlls=[DLL];call('CoInitialize',[0]);Mem.writeUint32(0x1100,0xfeed);expect(create()).toBe(0x80040154);
    expect(Mem.readUint32(0x1100)).toBe(0);expect(isHleModuleLoaded(DLL)).toBe(false);call('CoUninitialize');
});
for(const reverse of [false,true])test('mixed Co/Ro initialization releases only on the final shared leave, reverse='+reverse,()=>{
    const ro=new Combase();ro.initialize(owner);
    const initialize=()=>ro.exports.RoInitialize!(ctx,ram,[0]);
    const leave=()=>ro.exports.RoUninitialize!(ctx,ram,[]);
    expect(reverse?initialize():call('CoInitialize',[0])).toBe(0);
    expect(reverse?call('CoInitialize',[0]):initialize()).toBe(1);
    expect(create()).toBe(0);release();
    if(reverse)leave();else call('CoUninitialize');
    expect(getHandle()).toBe(hleImageBase(DLL));
    if(reverse)call('CoUninitialize');else leave();
    expect(getHandle()).toBe(0);
});
test('retired loader references cannot erase a new load after process image reset',()=>{
    const old=retainHleModuleLoaded(DLL)!;
    owner.resetGeneration++;materializeHleModuleImages(owner);
    const fresh=retainHleModuleLoaded(DLL)!;
    old.release();old.release();expect(isHleModuleLoaded(DLL)).toBe(true);
    fresh.release();expect(isHleModuleLoaded(DLL)).toBe(false);
});
test('a reset clears old COM reasons without clearing a new import reference',()=>{
    call('CoInitialize',[0]);expect(create(0x1060)).toBe(0x80004002);
    owner.resetGeneration++;materializeHleModuleImages(owner);markHleModuleLoaded(DLL);
    ole.reset();expect(isHleModuleLoaded(DLL)).toBe(true);
});
