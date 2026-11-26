import { describe, test, expect } from "bun:test";
import { createOpenGLContext, VERT_FLOATS } from "../../src/worker/modules/opengl32/context";
import { createStateExports } from "../../src/worker/modules/opengl32/state";
import { createImmediateExports } from "../../src/worker/modules/opengl32/immediate";
import { createArrayExports } from "../../src/worker/modules/opengl32/arrays";
import { createListExports } from "../../src/worker/modules/opengl32/lists";
import * as G from "../../src/worker/modules/opengl32/constants";

function setup(size = 64) {
    let mem = new Uint8Array(8192);
    const ctx = createOpenGLContext({ getCurrentMemory: () => mem, getModule: () => ({ exports: api }) } as never);
    const api = { ...createStateExports(ctx), ...createImmediateExports(ctx), ...createArrayExports(ctx), ...createListExports(ctx) };
    const call = (fn: string, ...args: number[]) => api[fn]!(null as never, mem, args) as number;
    const draw = (mode: number, points: number[][]) => {
        call("glBegin", mode);
        for (const p of points) call("glVertex4d", p[0], p[1], p[2] ?? 0, p[3] ?? 1);
        call("glEnd");
    };
    const words = (count: number) => Array.from(new Uint32Array(mem.buffer, mem.byteOffset + 256, count));
    const begin = () => call("glRenderMode", G.GL_SELECT);
    const end = () => call("glRenderMode", G.GL_RENDER);
    call("glSelectBuffer", size, 256);
    return {ctx,call,draw,words,begin,end,mem:()=>mem,replace:(m:Uint8Array)=>{mem=m;}};
}
const depth = (z: number) => Math.round(z * 0xffffffff);

describe("OpenGL selection records", () => {
    test("hit intervals aggregate depth, unsigned nested names, and empty stack hits", () => {
        const s=setup(); s.begin(); s.call("glPushName", 0xffffffff); s.call("glPushName", 7);
        s.draw(G.GL_POINTS, [[0,0,-.5],[0,0,.5]]);
        s.call("glLoadName", 8);
        s.draw(G.GL_POINTS, [[0,0,0]]);
        s.call("glInitNames"); s.draw(G.GL_POINTS, [[0,0,1]]);
        expect(s.end()).toBe(3);
        expect(s.words(13)).toEqual([2,depth(.25),depth(.75),0xffffffff,7,2,depth(.5),depth(.5),0xffffffff,8,0,0xffffffff,0xffffffff]);
        expect(s.ctx.commands.count).toBe(0); expect(s.ctx.vertArena.used).toBe(0);
    });
    test("clipped line uses generated endpoints, and rejects fully outside points", () => {
        const s=setup(); s.begin(); s.call("glPushName", 2);
        s.draw(G.GL_POINTS, [[2,0,0],[0,0,2],[0,0,0,-1]]);
        s.draw(G.GL_LINES, [[-2,0,-2],[2,0,2]]);
        expect(s.end()).toBe(1); expect(s.words(4)).toEqual([1,0,0xffffffff,2]);
    });
    test("polygon surrounding the clip volume hits even with no vertex inside", () => {
        const s=setup(); s.begin(); s.draw(G.GL_TRIANGLES,[[-3,-3,0],[3,-3,0],[0,3,0]]);
        expect(s.end()).toBe(1); expect(s.words(3)).toEqual([0,depth(.5),depth(.5)]);
    });
    test("off-volume polygons miss; culling, front winding and polygon mode apply correctly", () => {
        const s=setup(); s.begin(); s.call("glEnable",G.GL_CULL_FACE);
        s.call("glPolygonMode",G.GL_FRONT_AND_BACK,G.GL_LINE);
        const ccw=[[-.5,-.5,0],[.5,-.5,0],[0,.5,0]];
        s.draw(G.GL_TRIANGLES,[[2,2,0],[3,2,0],[2,3,0]]);
        s.draw(G.GL_TRIANGLES,[...ccw].reverse()); expect(s.end()).toBe(0);
        s.begin(); s.draw(G.GL_TRIANGLES,ccw); expect(s.end()).toBe(1);
        s.begin(); s.call("glFrontFace",G.GL_CW); s.draw(G.GL_TRIANGLES,ccw); expect(s.end()).toBe(0);
        s.begin(); s.call("glCullFace",G.GL_FRONT_AND_BACK); s.draw(G.GL_TRIANGLES,ccw); expect(s.end()).toBe(0);
    });
    test("partial record on overflow, canaries intact, SELECT to SELECT resets counters and names", () => {
        const s=setup(3); s.mem().fill(0xa5); s.begin(); s.call("glPushName",42); s.draw(G.GL_POINTS,[[0,0,0]]);
        expect(s.begin()).toBe(-1); expect(s.words(4)).toEqual([1,depth(.5),depth(.5),0xa5a5a5a5]);
        expect(s.ctx.nameStackTop).toBe(-1); s.draw(G.GL_POINTS,[[0,0,0]]); expect(s.end()).toBe(1);
        expect(s.words(4)).toEqual([0,depth(.5),depth(.5),0xa5a5a5a5]);
    });
    test("zero sized buffer is legal and returns overflow on a hit", () => {
        const s=setup(0); s.begin(); s.draw(G.GL_POINTS,[[0,0,0]]); expect(s.end()).toBe(-1);
        s.begin(); expect(s.end()).toBe(0);
    });
    test("invalid calls preserve the pending hit and active buffer", () => {
        const s=setup(); s.begin(); s.call("glPushName",9); s.draw(G.GL_POINTS,[[0,0,0]]);
        s.call("glSelectBuffer",1,512); expect(s.ctx.error).toBe(G.GL_INVALID_OPERATION);
        s.call("glRenderMode",123); expect(s.ctx.error).toBe(G.GL_INVALID_ENUM);
        s.call("glBegin",G.GL_POINTS); s.call("glLoadName",10); expect(s.ctx.error).toBe(G.GL_INVALID_OPERATION); s.call("glEnd");
        expect(s.end()).toBe(1); expect(s.words(4)[3]).toBe(9);
        s.call("glPushName",12); expect(s.ctx.nameStackTop).toBe(-1);
        s.call("glSelectBuffer",-1,512); expect(s.ctx.error).toBe(G.GL_INVALID_VALUE); expect(s.ctx.selectBufferPtr).toBe(256);
    });
    test("selection requires a defined buffer", () => {
        const ctx=createOpenGLContext({getCurrentMemory:()=>new Uint8Array(4096)} as never);
        createStateExports(ctx).glRenderMode!(null as never,new Uint8Array(0),[G.GL_SELECT]);
        expect(ctx.error).toBe(G.GL_INVALID_OPERATION); expect(ctx.renderMode).toBe(G.GL_RENDER);
    });
    test("rebinding guest memory respects byteOffset and avoids writes to old memory", () => {
        const s=setup(); s.begin(); s.draw(G.GL_POINTS,[[0,0,0]]); const old=s.mem();
        const memory=new Uint8Array(16384); memory.fill(0xa5); s.replace(memory.subarray(4096,12288));
        expect(s.end()).toBe(1); expect(s.words(3)).toEqual([0,depth(.5),depth(.5)]);
        expect(old[256]).toBe(0); expect(memory[256]).toBe(0xa5); expect(memory[4096+268]).toBe(0xa5);
    });
    test("modelview/projection and reversed depth range", () => {
        const s=setup(); s.ctx.modelviewStack.stack[0][14]=.5; s.ctx.projectionStack.stack[0][10]=.5;
        s.ctx.depthRangeNear=.8; s.ctx.depthRangeFar=.2; s.begin(); s.draw(G.GL_POINTS,[[0,0,-.5],[0,0,.5]]);
        expect(s.end()).toBe(1); expect(s.words(3)).toEqual([0,depth(.35),depth(.5)]);
    });
    test("user clip planes are captured in eye coordinates and clipped depth is used", () => {
        const s=setup(),v=new DataView(s.mem().buffer); v.setFloat64(1024,1,true); v.setFloat64(1048,0,true);
        s.ctx.modelviewStack.stack[0][12]=.5; s.call("glClipPlane",G.GL_CLIP_PLANE0,1024);
        expect(Array.from(s.ctx.clipPlanes.slice(0,4))).toEqual([1,0,0,-.5]);
        s.ctx.modelviewStack.stack[0][12]=0; s.call("glEnable",G.GL_CLIP_PLANE0); s.begin();
        s.draw(G.GL_LINES,[[-1,0,-1],[1,0,1]]); expect(s.end()).toBe(1); expect(s.words(3)).toEqual([0,depth(.75),0xffffffff]);
    });
    test("RasterPos hits; DrawPixels does not render or create extra selection hits", () => {
        const s=setup(); s.begin(); s.call("glRasterPos3d",0,0,.5); s.call("glDrawPixels",1,1,G.GL_RGBA,G.GL_UNSIGNED_BYTE,1024);
        s.call("glRasterPos3d",2,0,0); expect(s.end()).toBe(1); expect(s.words(3)).toEqual([0,depth(.75),depth(.75)]);
        expect(s.ctx.commands.count).toBe(0);
    });
    for (const mode of [G.GL_POINTS,G.GL_LINES,G.GL_LINE_STRIP,G.GL_LINE_LOOP,G.GL_TRIANGLES,G.GL_TRIANGLE_STRIP,G.GL_TRIANGLE_FAN,G.GL_QUADS,G.GL_QUAD_STRIP,G.GL_POLYGON]) {
        test(`primitive mode ${mode} produces hits without growing the frame arena`,()=>{
            const s=setup(); s.begin(); s.call("glPushName",55);
            for(let i=0;i<50;i++) s.draw(mode,[[-.5,-.5,0],[.5,-.5,0],[.5,.5,0],[-.5,.5,0]]);
            expect(s.end()).toBe(1); expect(s.words(4)[3]).toBe(55); expect(s.ctx.vertArena.used).toBe(0);
        });
    }
    test("client arrays and indexed vertices reach selection without GPU commands",()=>{
        const s=setup(); new Float32Array(s.mem().buffer,1024,9).set([-.5,-.5,0,.5,-.5,0,0,.5,0]);
        new Uint16Array(s.mem().buffer,1200,3).set([0,1,2]);
        s.call("glVertexPointer",3,G.GL_FLOAT,0,1024);s.call("glEnableClientState",G.GL_VERTEX_ARRAY);
        s.begin(); s.call("glPushName",7);s.call("glDrawArrays",G.GL_TRIANGLES,0,3);
        s.call("glLoadName",8);s.call("glDrawElements",G.GL_TRIANGLES,3,G.GL_UNSIGNED_SHORT,1200);
        expect(s.end()).toBe(2);expect(s.words(8)).toEqual([1,depth(.5),depth(.5),7,1,depth(.5),depth(.5),8]);
        expect(s.ctx.vertArena.used).toBe(0);expect(s.ctx.commands.count).toBe(0);
    });
    test("display list selection replays original object primitives and names",()=>{
        const s=setup();
        // This matches the recorded command representation, including cached geometry.
        s.ctx.displayLists.set(1,{commands:[{fn:"glLoadName",args:[23]},{fn:"glBegin",args:[G.GL_TRIANGLES]},
            ...[[-.5,-.5,0],[.5,-.5,0],[0,.5,0]].map(args=>({fn:"glVertex3d",args})),{fn:"glEnd",args:[]}],
            prebaked:[{kind:"verts",mode:G.GL_TRIANGLES,flatVerts:new Float32Array(3*VERT_FLOATS),count:3}]});
        s.begin();s.call("glPushName",0);s.call("glCallList",1);expect(s.end()).toBe(1);expect(s.words(4)[3]).toBe(23);
    });
});
