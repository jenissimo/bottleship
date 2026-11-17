import {expect,test} from "bun:test";
import {Glu32} from "../../src/worker/modules/glu32";
import {createOpenGLContext} from "../../src/worker/modules/opengl32/context";
import {createStateExports} from "../../src/worker/modules/opengl32/state";
import {createImmediateExports} from "../../src/worker/modules/opengl32/immediate";
import {glu32Module} from "../../src/worker/api/glu32.api";
import * as G from "../../src/worker/modules/opengl32/constants";
function setup(){
 const mem=new Uint8Array(4096),ctx=createOpenGLContext({getCurrentMemory:()=>mem} as never),glu=new Glu32();
 glu.initialize({getCurrentMemory:()=>mem,getModule:()=>({getContext:()=>ctx})} as never);
 new Int32Array(mem.buffer,128,4).set([100,50,800,600]);
 const pick=(x:number,y:number,w:number,h:number)=>{
  const doubles=new Float64Array([x,y,w,h]);
  return glu.exports.gluPickMatrix!(null as never,mem,[...new Uint32Array(doubles.buffer),128]);
 };
 return {mem,ctx,pick};
}
test("gluPickMatrix declares four doubles and a viewport pointer (nine stack words)",()=>{
 expect(glu32Module.functions.find(f=>f.name==='gluPickMatrix')?.params.map(p=>p.type)).toEqual(['f64','f64','f64','f64','ptr']);
});
test("viewport origin and right multiplication, no reset of caller projection",()=>{
 const {ctx,pick}=setup();ctx.currentMatrix()[0]=2;ctx.currentMatrix()[12]=3;
 pick(300,350,10,20);
 expect(Array.from(ctx.currentMatrix())).toEqual([160,0,0,0,0,30,0,0,0,0,1,0,83,0,0,1]);
});
test("invalid pick extents preserve the current matrix",()=>{
 const {ctx,pick}=setup(),before=ctx.currentMatrix().slice();pick(100,100,0,10);pick(100,100,10,-1);
 expect(ctx.currentMatrix()).toEqual(before);
});
test("selection sees only the requested window region",()=>{
 const {ctx,mem,pick}=setup();ctx.matrixMode=G.GL_PROJECTION;pick(300,350,10,10);
 const api={...createStateExports(ctx),...createImmediateExports(ctx)};
 const call=(n:string,...a:number[])=>api[n]!(null as never,mem,a);
 call('glSelectBuffer',16,256);call('glRenderMode',G.GL_SELECT);call('glPushName',11);
 call('glBegin',G.GL_POINTS);call('glVertex3d',-.5,0,0);call('glEnd');call('glLoadName',22);
 call('glBegin',G.GL_POINTS);call('glVertex3d',.5,0,0);call('glEnd');
 expect(call('glRenderMode',G.GL_RENDER)).toBe(1);
 expect(Array.from(new Uint32Array(mem.buffer,256,4))).toEqual([1,2147483648,2147483648,11]);
});
