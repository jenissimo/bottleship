import {expect,test} from 'bun:test';
import {System} from '../../src/worker/core/system';
import {ModuleRegistry,type LoadedPEModule} from '../../src/worker/core/module-registry';
import {exports as api} from '../../src/worker/modules/kernel32/module/module';

for(const wide of [false,true]) test(`LoadLibraryEx${wide?'W':'A'} retains an existing dynamic DLL until both owners release`,async()=>{
    const system=System.getInstance(); const previous=system.process;
    const registry=new ModuleRegistry();
    const mod:LoadedPEModule={name:'resource-test.dll',path:'C:/resource-test.dll',baseAddress:0x24000000,size:0x10000,entryPoint:0,exports:new Map(),ordinalExports:new Map(),isRealDll:true,initialized:true};
    const loader={peekLoadDll:()=>({kind:'io'}),loadDll:async()=>{registry.register(mod);return mod;},getPendingDllInits:()=>[]};
    system.process={moduleRegistry:registry,loader,resetGeneration:0} as never;
    const mem=new Uint8Array(0x1000); const name='resource-test.dll';
    for(let i=0;i<name.length;i++)mem[0x100+i*(wide?2:1)]=name.charCodeAt(i);
    const invoke=async(n:string,a:number[])=>await api[n]({} as never,mem,a) as {value:number};
    try{
        const load='LoadLibraryEx'+(wide?'W':'A');
        expect((await invoke(load,[0x100,0,0])).value).toBe(mod.baseAddress);
        expect((await invoke(load,[0x100,0,8])).value).toBe(mod.baseAddress);
        await invoke('FreeLibrary',[mod.baseAddress]);
        expect(registry.getByBase(mod.baseAddress)).toBe(mod);
        await invoke('FreeLibrary',[mod.baseAddress]);
        expect(registry.getByBase(mod.baseAddress)).toBeUndefined();
    }finally{system.process=previous;}
});
