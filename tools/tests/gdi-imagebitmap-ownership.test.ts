import {afterEach,beforeEach,expect,test} from 'bun:test';
import {System} from '../../src/worker/core/system';
import {SystemResourceProvider} from '../../src/worker/core/resources/system-resource-provider';
import {GDIContext} from '../../src/worker/modules/gdi32/context';


import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {preserveMemBinding} from './helpers/scoped-process-state';
preserveMemBinding();
let gdi:GDIContext, memory:Uint8Array, provider:SystemResourceProvider, savedSystem:unknown;
let globals:Record<string,PropertyDescriptor|undefined>,handles:number[],savedProvider:unknown;
let pending:Array<{promise:Promise<any>,resolve:(v:any)=>void,reject:(e:any)=>void}>;
class Canvas {
 ctx:any;
 constructor(public width:number,public height:number){this.ctx={canvas:this,putImageData(){},drawImage(){},clearRect(){}};}
 getContext(){return this.ctx;}
}
beforeEach(()=>{
 savedSystem=(System as any).instance;
 globals={};for(const k of ['OffscreenCanvas','ImageData','createImageBitmap'])globals[k]=Object.getOwnPropertyDescriptor(globalThis,k);
 (globalThis as any).OffscreenCanvas=Canvas;
 (globalThis as any).ImageData=class {constructor(public data:any,public width:number,public height:number){}};
 pending=[];(globalThis as any).createImageBitmap=()=>{let resolve!:any,reject!:any;const promise=new Promise((a,b)=>{resolve=a;reject=b;});pending.push({promise,resolve,reject});return promise;};
 memory=new Uint8Array(0x10000);Mem.bind(()=>memory);gdi=new GDIContext();savedProvider=(SystemResourceProvider as any).instance;provider=new (SystemResourceProvider as any)();(SystemResourceProvider as any).instance=provider;handles=[];
 (System as any).instance={gdiContext:gdi,resourceProvider:provider,process:{v86:{mem8:memory},getCurrentMemory:()=>memory,getModule:()=>undefined,addressSpace:{validateRange:(p:number,n:number)=>p>0&&n>=0&&p+n<=memory.length}}};
});
afterEach(()=>{
 for(const h of handles)provider.unregisterUserObject(h);(SystemResourceProvider as any).instance=savedProvider;
 (System as any).instance=savedSystem;
 for(const[k,v]of Object.entries(globals)){if(v)Object.defineProperty(globalThis,k,v);else delete(globalThis as any)[k];}
});
function bitmap(extra:Record<string,unknown>={}){const h=provider.registerUserObject({type:'BITMAP',width:1,height:1,pixels:new Uint8ClampedArray([10,20,30,255]),...extra} as never);handles.push(h);return h;}
function recycled(h:number){expect(gdi.deleteObject(h)).toBe(true);for(let i=0;i<4;i++){const next=bitmap();if(next===h)return next;expect(gdi.deleteObject(next)).toBe(true);}throw new Error('generation did not wrap');}
const decoded=()=>({closed:0,close(){this.closed++;}});
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
test('an owned decode is published normally',async()=>{
 const h=bitmap();expect(gdi.createBitmapDC(h)).not.toBeNull();const bm=decoded();pending[0]!.resolve(bm);await settle();expect(gdi.bitmapImageBitmapReady.get(h)).toBe(bm as any);expect(bm.closed).toBe(0);expect(gdi.bitmapImageBitmapCache.has(h)).toBe(false);
});
test('late old decode closes after DeleteObject and real HBITMAP slot reuse',async()=>{
 const h=bitmap();expect(gdi.createBitmapDC(h)).not.toBeNull();const reused=recycled(h);expect(reused).toBe(h);expect(gdi.createBitmapDC(reused)).not.toBeNull();expect(pending).toHaveLength(2);
 const old=decoded();pending[0]!.resolve(old);await settle();expect(old.closed).toBe(1);expect(gdi.bitmapImageBitmapReady.has(h)).toBe(false);expect(gdi.bitmapImageBitmapCache.get(h)).toBe(pending[1]!.promise);
 const fresh=decoded();pending[1]!.resolve(fresh);await settle();expect(gdi.bitmapImageBitmapReady.get(h)).toBe(fresh as any);expect(fresh.closed).toBe(0);
});
test('old rejection cannot delete the replacement decode promise',async()=>{
 const h=bitmap();gdi.createBitmapDC(h);expect(recycled(h)).toBe(h);gdi.createBitmapDC(h);pending[0]!.reject(new Error('delayed decoder failure'));await settle();expect(gdi.bitmapImageBitmapCache.get(h)).toBe(pending[1]!.promise);const fresh=decoded();pending[1]!.resolve(fresh);await settle();expect(gdi.bitmapImageBitmapReady.get(h)).toBe(fresh as any);
});
test('DIB refresh disowns an in-flight decode of older pixels',async()=>{
 memory.set([1,2,3,255],0x1000);const h=bitmap({pixels:undefined,bitsPtr:0x1000,dibStride:4,dibBpp:32,dibTopDown:true});gdi.createBitmapDC(h);expect(pending).toHaveLength(1);memory.set([7,8,9,255],0x1000);expect(gdi.refreshDibSectionCanvas(h)).not.toBeNull();const old=decoded();pending[0]!.resolve(old);await settle();expect(old.closed).toBe(1);expect(gdi.bitmapImageBitmapReady.has(h)).toBe(false);
});
test('late decode after context reset closes instead of being published',async()=>{
 const h=bitmap();gdi.createBitmapDC(h);gdi.reset();const old=decoded();pending[0]!.resolve(old);await settle();expect(old.closed).toBe(1);expect(gdi.bitmapImageBitmapReady.has(h)).toBe(false);
});
