import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { coCreateMlang, liveMlangInstances } from '../../src/worker/modules/ole32-mlang-font-link';
import { GDIContext } from '../../src/worker/modules/gdi32/context';
import { addMemoryFontResource, removeMemoryFontResource, installedFontCoverage } from '../../src/worker/modules/gdi32/font-resource';
import { checkComGuard, resetComMemory, snapshotComVtableOwners } from '../../src/worker/core/com/com-memory';
import type { Process } from '../../src/worker/core/process';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';

const CLASS = '275c23e2-3747-11d0-9fea-00aa003f8646', MULTI = '275c23e1-3747-11d0-9fea-00aa003f8646';
const LINK = '359f3441-bd4a-11d0-b188-00aa0038c969', UNKNOWN = '00000000-0000-0000-c000-000000000046';
const system = System.getInstance(), savedProcess = system.process;
let restoreVtableOwners: () => void = () => {};
let memory: Uint8Array, process: Process, nextData: number, nextCode: number, batches: number;
let denyOut = false;
const handlers = new Map<string, ThunkImplementation>();
const namesByStub = new Map<number, string>();
let methodShapes: Array<{ name: string; argCount: number; stackCleanupBytes: number }>;
const view = () => new DataView(memory.buffer);
function guid(ptr: number, text: string) {
    const [a,b,c,d,e] = text.split('-');
    view().setUint32(ptr,parseInt(a,16),true); view().setUint16(ptr+4,parseInt(b,16),true); view().setUint16(ptr+6,parseInt(c,16),true);
    const tail=d+e; for(let i=0;i<8;i++) memory[ptr+8+i]=parseInt(tail.slice(i*2,i*2+2),16);
}
function alloc(size: number) { const p=nextData; nextData+=(size+15)&~15; return p; }
function invoke(ptr: number, slot: number, args: number[] = []) {
    const table=view().getUint32(ptr,true), stub=view().getUint32(table+slot*4,true);
    return handlers.get(namesByStub.get(stub)!)!(null as never,memory,[ptr,...args]);
}
beforeEach(() => {
    restoreVtableOwners = snapshotComVtableOwners();
    memory=new Uint8Array(0x40000); nextData=0x10000; nextCode=0x20000; batches=0;
    handlers.clear(); namesByStub.clear(); methodShapes=[]; denyOut=false; resetComMemory();
    Mem.bind(() => memory,(p,n,perms) => p>=0 && p+n<=memory.length && !(denyOut && perms.includes('w') && p<2056 && p+n>2052));
    process={ resetGeneration:0, getCurrentMemory:()=>memory,
        memory:{alloc,allocAt(){},allocSystemBlock:alloc,freeSystemBlock(){},systemPoolGeneration:0},
        dispatcher:{
            registerModule(_name: string, exports: Record<string,ThunkImplementation>) {
                for(const [name,handler] of Object.entries(exports)) handlers.set(name,handler);
            }, applyPendingRegistrations(){},
        },
        thunkGenerator:{generateStubDll(_name: string, methods: typeof methodShapes) {
            batches++; methodShapes.push(...methods);
            const baseAddress=nextCode; nextCode+=methods.length*16;
            const stubCode=new Uint8Array(methods.length*16), exportTable=new Map<string,number>();
            methods.forEach((m,i)=>{
                stubCode[i*16]=0xb8;
                exportTable.set(m.name.toLowerCase(),baseAddress+i*16); namesByStub.set(baseAddress+i*16,m.name);
            });
            return {baseAddress,stubCode,exportTable};
        }},
    } as unknown as Process;
    system.process=process; guid(1024,LINK); guid(1040,UNKNOWN);
});
afterEach(() => { restoreVtableOwners(); resetComMemory(); system.process=savedProcess; Mem.bind(()=>savedProcess?.getCurrentMemory()??new Uint8Array()); });

test('real installer publishes correct slots and COM guards; QI has canonical IUnknown and balanced refs',()=>{
    expect(coCreateMlang(process,CLASS,MULTI,2048)).toBe(0);
    const primary=view().getUint32(2048,true); expect(checkComGuard(memory,primary)).toBe(true);
    expect(batches).toBe(2);
    expect(methodShapes[18+3]).toMatchObject({name:'IMLangFontLink_GetCharCodePages',argCount:3,stackCleanupBytes:12});
    expect(methodShapes[18+7]).toMatchObject({name:'IMLangFontLink_GetFontCodePages',argCount:4,stackCleanupBytes:16});
    expect(invoke(primary,0,[1024,2052])).toBe(0); const link=view().getUint32(2052,true);
    expect(link).not.toBe(primary); expect(checkComGuard(memory,link)).toBe(true);
    expect(invoke(link,0,[1040,2056])).toBe(0); expect(view().getUint32(2056,true)).toBe(primary);
    expect(invoke(primary,4,[1252,2060])).toBe(0x80004001);
    expect(invoke(link,2)).toBe(2); expect(invoke(primary,2)).toBe(1); expect(invoke(primary,2)).toBe(0);
    expect(invoke(link,1)).toBe(0x80004003);
});
test('in-bounds but write-denied QI output fails without incrementing reference count',()=>{
    expect(coCreateMlang(process,CLASS,MULTI,2048)).toBe(0); const primary=view().getUint32(2048,true);
    view().setUint32(2052,0x12345678,true); denyOut=true;
    expect(invoke(primary,0,[1024,2052])).toBe(0x80004003);
    expect(view().getUint32(2052,true)).toBe(0x12345678);
    denyOut=false; expect(invoke(primary,1)).toBe(2); expect(invoke(primary,2)).toBe(1); expect(invoke(primary,2)).toBe(0);
});
test('same Process identity and changed resetGeneration reinstalls tables and drops old instances',()=>{
    expect(coCreateMlang(process,CLASS,MULTI,2048)).toBe(0); const stale=view().getUint32(2048,true);
    const oldTable=view().getUint32(stale,true);
    process.resetGeneration++; resetComMemory();
    expect(coCreateMlang(process,CLASS,MULTI,2052)).toBe(0); const fresh=view().getUint32(2052,true);
    expect(batches).toBe(4); expect(view().getUint32(fresh,true)).not.toBe(oldTable);
    expect(invoke(stale,1)).toBe(0x80004003); expect(invoke(fresh,1)).toBe(2);
    expect(invoke(fresh,2)).toBe(1); expect(invoke(fresh,2)).toBe(0);
});
test('GetFontCodePages requires explicit valid HFONT, clears failure output and permits omitted output',async()=>{
    const saved={gdi:system.gdiContext,FontFace:globalThis.FontFace,self:globalThis.self};
    let handle=0, link=0;
    try {
        globalThis.FontFace=class { async load(){return this;} } as unknown as typeof FontFace;
        globalThis.self={fonts:{add(){},delete(){}}} as never;
        const bytes=new Uint8Array(readFileSync(new URL('../../public/fonts/LiberationSans-Regular.ttf',import.meta.url)));
        handle=await addMemoryFontResource(bytes); expect(handle).not.toBe(0);
        const gdi=new GDIContext(); system.gdiContext=gdi;
        gdi.objects.set(10,{type:'FONT',handle:10,faceName:'Liberation Sans'} as never);
        gdi.hdcStates.set(1,{hFont:10} as never);
        expect(coCreateMlang(process,CLASS,LINK,2048)).toBe(0); link=view().getUint32(2048,true);
        expect(invoke(link,7,[1,10,2060])).toBe(0);
        const mask=installedFontCoverage('Liberation Sans')!.codePages;
        expect(mask).not.toBe(0); expect(view().getUint32(2060,true)).toBe(mask);
        for(const [hdc,font] of [[1,0],[0,10],[999,10],[1,999]]) {
            view().setUint32(2060,0xdeadbeef,true);
            expect(invoke(link,7,[hdc,font,2060])).toBe(0x80004005);
            expect(view().getUint32(2060,true)).toBe(0);
        }
        expect(invoke(link,7,[1,10,0])).toBe(0);
        denyOut=true;
        expect(invoke(link,7,[1,10,2052])).toBe(0x80004003); denyOut=false;
    } finally {
        denyOut=false; if(link) invoke(link,2); if(handle) removeMemoryFontResource(handle);
        system.gdiContext=saved.gdi; globalThis.FontFace=saved.FontFace; globalThis.self=saved.self;
    }
});
test('a live MLang object is counted for the savestate refusal until its last release',()=>{
    expect(liveMlangInstances(process)).toBe(0);
    expect(coCreateMlang(process,CLASS,MULTI,2048)).toBe(0);
    const primary=view().getUint32(2048,true);
    expect(liveMlangInstances(process)).toBe(1);
    expect(invoke(primary,0,[1024,2052])).toBe(0);
    expect(liveMlangInstances(process)).toBe(1);
    expect(invoke(primary,2)).toBe(1); expect(invoke(primary,2)).toBe(0);
    expect(liveMlangInstances(process)).toBe(0);
});
