import { describe, expect, it } from "bun:test";
import { OpenGL32 } from "../../src/worker/modules/opengl32";
import { createOpenGLContext, VERT_FLOATS } from "../../src/worker/modules/opengl32/context";
import { createImmediateExports, emitDrawCommandFlat } from "../../src/worker/modules/opengl32/immediate";

import { applyLightingFlat, triangleFrontFacing, captureImmediateMaterials, restoreImmediateMaterials } from "../../src/worker/modules/opengl32/lighting";
import { createStateExports } from "../../src/worker/modules/opengl32/state";
import { cvaLock, gatherVertices, sequentialIndices, VertexSpace } from "../../src/worker/modules/opengl32/client-arrays";
import { createListExports } from "../../src/worker/modules/opengl32/lists";
const LIGHTING=0x0b50, LIGHT0=0x4000, NORMALIZE=0x0ba1, COLOR_MATERIAL=0x0b57;
function fixture() {
    const mem=new Uint8Array(65536);
    const ctx=createOpenGLContext({getCurrentMemory:()=>mem} as never);
    ctx.enableFlags.add(LIGHTING);
    ctx.lightModelAmbient.set([0,0,0,1]);
    ctx.materialFrontAmbient.set([1,1,1,1]);
    ctx.materialFrontDiffuse.set([1,1,1,0.75]);
    const verts=new Float32Array(3*VERT_FLOATS);
    for(let i=0;i<3;i++) {
        const b=i*VERT_FLOATS;
        verts[b]=i===1?1:0; verts[b+1]=i===2?1:0; verts[b+3]=1;
        verts[b+7]=1; verts[b+10]=1;
    }
    return {ctx,verts,mem};
}
function draw(f:ReturnType<typeof fixture>) {
    f.ctx.vertArena.reset(); f.ctx.commands.reset();
    emitDrawCommandFlat(f.ctx,0x0004,f.verts,3);
    return Array.from(f.ctx.vertArena.data.slice(4,8));
}
describe("fixed function primary lighting replaces raw color",()=>{
    it("positive per-light ambient lights a black current color with color material off",()=>{
        const f=fixture(); f.ctx.enableFlags.add(LIGHT0);
        f.ctx.lights[0].ambient.set([0.2,0.3,0.4,1]);
        f.ctx.lights[0].diffuse.fill(0); f.ctx.lights[0].specular.fill(0);
        const c=draw(f);
        expect(c[0]).toBeCloseTo(0.2); expect(c[1]).toBeCloseTo(0.3);
        expect(c[2]).toBeCloseTo(0.4); expect(c[3]).toBeCloseTo(0.75);
    });
    it("directional diffuse ignores positional attenuation and reverses with the normal",()=>{
        const f=fixture(); f.ctx.enableFlags.add(LIGHT0);
        f.ctx.lights[0].position.set([0,0,1,0]);
        f.ctx.lights[0].constantAttenuation=20;
        expect(draw(f)[0]).toBeCloseTo(1);
        for(let i=0;i<3;i++) f.verts[i*VERT_FLOATS+10]=-1;
        expect(draw(f)[0]).toBeCloseTo(0);
    });
    it("emission color material uses each vertex and preserves diffuse alpha",()=>{
        const f=fixture(); f.ctx.enableFlags.add(COLOR_MATERIAL);
        f.ctx.colorMaterialParam=0x1600;
        f.verts.set([0.25,0.5,0.75,0.2],4);
        const c=draw(f);
        expect(c[0]).toBeCloseTo(0.25); expect(c[1]).toBeCloseTo(0.5);
        expect(c[2]).toBeCloseTo(0.75); expect(c[3]).toBeCloseTo(0.75);
    });
    it("inverse transpose and GL_NORMALIZE handle nonuniform scaling",()=>{
        const f=fixture(); f.ctx.enableFlags.add(LIGHT0); f.ctx.enableFlags.add(NORMALIZE);
        f.ctx.modelviewStack.stack[0][0]=2;
        f.ctx.lights[0].position.set([1,0,0,0]);
        for(let i=0;i<3;i++) { f.verts[i*VERT_FLOATS+8]=1; f.verts[i*VERT_FLOATS+10]=1; }
        expect(draw(f)[0]).toBeCloseTo(1/Math.sqrt(5),5);
    });
});

function evaluate(f:ReturnType<typeof fixture>,mode=4) {
    const out=f.verts.slice(); applyLightingFlat(f.ctx,out,0,3,mode); return out;
}
const bits=(x:number)=>{const v=new DataView(new ArrayBuffer(4));v.setFloat32(0,x,true);return v.getUint32(0,true);};
function call(table:ReturnType<typeof createImmediateExports>,name:string,args:number[]=[]) {
    return table[name]({} as never,new Uint8Array(0),args);
}
describe("fixed lighting equations and invariants",()=>{
    it("preserves transformed normal length with both normal flags off, and supports RESCALE",()=>{
        const f=fixture(); f.ctx.enableFlags.add(LIGHT0);
        f.ctx.materialFrontDiffuse.set([0.6,0.4,0.2,1]);
        f.ctx.lights[0].diffuse.set([0.5,0.5,1,1]); f.ctx.lights[0].position.set([0,0,5,0]);
        f.ctx.lights[0].constantAttenuation=2;f.ctx.lights[0].linearAttenuation=3;f.ctx.lights[0].quadraticAttenuation=4;
        for(let i=0;i<3;i++) f.verts[i*VERT_FLOATS+10]=0.5;
        expect(Array.from(evaluate(f).slice(4,7))).toEqual([Math.fround(.15),Math.fround(.1),Math.fround(.1)]);
        f.ctx.enableFlags.add(0x803a);
        expect(evaluate(f)[4]).toBeCloseTo(.3);
    });
    it("applies distance attenuation to ambient even on backlit normals",()=>{
        const f=fixture(); f.ctx.enableFlags.add(LIGHT0);
        f.ctx.materialFrontAmbient.set([.5,.25,.125,1]);f.ctx.materialFrontEmission.set([.01,.02,.03,1]);
        f.ctx.lightModelAmbient.set([.2,.4,.8,1]);
        const l=f.ctx.lights[0];l.position.set([0,0,2,1]);l.ambient.set([.2,.4,.8,1]);
        l.diffuse.fill(0);l.specular.fill(0);l.constantAttenuation=1;l.linearAttenuation=.5;l.quadraticAttenuation=.5;
        for(let i=0;i<3;i++) f.verts[i*VERT_FLOATS+10]=-1;
        const out=evaluate(f);
        expect(out[4]).toBeCloseTo(.135,6);expect(out[5]).toBeCloseTo(.145,6);expect(out[6]).toBeCloseTo(.155,6);
    });
    it("uses light-to-vertex spot direction/exponent and suppresses ambient outside the cone",()=>{
        const f=fixture();f.ctx.enableFlags.add(LIGHT0);f.verts[0]=2;
        const l=f.ctx.lights[0];l.position.set([0,0,2,1]);l.spotDirection.set([0,0,-1]);
        l.ambient.set([.4,.4,.4,1]);l.diffuse.fill(0);l.specular.fill(0);l.spotCutoff=60;l.spotExponent=2;
        expect(evaluate(f)[4]).toBeCloseTo(.2,6);
        l.spotCutoff=30;expect(evaluate(f)[4]).toBe(0);
    });
    it("uses the local viewer half-vector and gates specular with N dot L even for shininess zero",()=>{
        const f=fixture(); f.ctx.enableFlags.add(LIGHT0);f.verts[0]=1;
        f.ctx.materialFrontDiffuse.fill(0);f.ctx.materialFrontSpecular.set([1,1,1,1]);f.ctx.materialFrontShininess=2;
        expect(evaluate(f)[4]).toBeCloseTo(1);
        f.ctx.hints.set(0x0b51,1);expect(evaluate(f)[4]).toBeCloseTo(.5,6);
        f.ctx.materialFrontShininess=0;f.verts[10]=-1;
        expect(evaluate(f)[4]).toBe(0);
    });
    it("keeps separate specular in a secondary vertex channel and clamps complete terms",()=>{
        const f=fixture();f.ctx.enableFlags.add(LIGHT0);
        f.ctx.materialFrontDiffuse.fill(0);f.ctx.materialFrontSpecular.set([.4,.4,.4,1]);f.ctx.materialFrontEmission.set([.2,.2,.2,1]);
        f.ctx.hints.set(0x81f8,0x81fa);
        const out=evaluate(f);expect(out[4]).toBeCloseTo(.2);expect(out[15]).toBeCloseTo(.4);
        expect(out[7]).toBe(0);
        f.ctx.hints.delete(0x81f8);expect(evaluate(f)[4]).toBeCloseTo(.6);
        f.ctx.materialFrontSpecular.fill(0);f.ctx.materialFrontEmission.fill(-.3);
        f.ctx.materialFrontAmbient.fill(1);f.ctx.lightModelAmbient.fill(.2);f.ctx.lights[0].ambient.fill(.4);
        expect(evaluate(f)[4]).toBeCloseTo(.3);
    });
    it("uses back material/reversed normals only for back-facing polygons, including mirrored modelview",()=>{
        const f=fixture();f.ctx.enableFlags.add(LIGHT0);f.ctx.hints.set(0x0b52,1);
        f.ctx.materialFrontDiffuse.set([.6,0,0,1]);f.ctx.materialFrontEmission.set([.1,0,0,1]);
        f.ctx.materialBackDiffuse.set([0,0,.6,1]);f.ctx.materialBackEmission.set([0,0,.1,1]);
        for(let i=0;i<3;i++) f.verts[i*VERT_FLOATS+10]=-1;
        expect(evaluate(f)[4]).toBeCloseTo(.1);expect(evaluate(f)[6]).toBe(0);
        f.ctx.modelviewStack.stack[0][0]=-1;
        expect(evaluate(f)[4]).toBe(0);expect(evaluate(f)[6]).toBeCloseTo(.7);
        expect(evaluate(f,1)[4]).toBeCloseTo(.1);expect(evaluate(f,0)[4]).toBeCloseTo(.1);
        f.ctx.frontFace=0x0900;expect(evaluate(f)[4]).toBeCloseTo(.1);
        f.ctx.hints.delete(0x0b52);expect(evaluate(f)[4]).toBeCloseTo(.1);
    });
    it("homogeneous orientation matches the clipped polygon when a vertex is behind the eye",()=>{
        const f=fixture(),m=f.ctx.modelviewStack.stack[0];
        f.verts.set([-.5,-.5,0,1],0);f.verts.set([.5,-.5,0,1],VERT_FLOATS);f.verts.set([0,.5,0,-.2],2*VERT_FLOATS);
        const input=[[-.5,-.5,1],[.5,-.5,1],[0,.5,-.2]],clipped:number[][]=[];
        for(let i=0;i<3;i++){
            const a=input[i],b=input[(i+1)%3],ina=a[2]>=.01,inb=b[2]>=.01;
            if(ina)clipped.push(a);
            if(ina!==inb){const t=(.01-a[2])/(b[2]-a[2]);clipped.push(a.map((v,k)=>v+t*(b[k]-v)));}
        }
        let area=0;for(let i=0;i<clipped.length;i++){const a=clipped[i],b=clipped[(i+1)%clipped.length];area+=a[0]/a[2]*b[1]/b[2]-a[1]/a[2]*b[0]/b[2];}
        expect(triangleFrontFacing(f.verts,0,m,0x0901)).toBe(area>0);
        m[0]=-1;expect(triangleFrontFacing(f.verts,0,m,0x0901)).toBe(area<0);
    });
    it("unlit primary/positions/normals/UV bytes remain identical and reused secondary is cleared",()=>{
        const f=fixture();f.ctx.enableFlags.delete(LIGHTING);
        for(let i=0;i<f.verts.length;i++)f.verts[i]=i*.123;
        const before=f.verts.slice();applyLightingFlat(f.ctx,f.verts,0,3,4);
        for(let i=0;i<3;i++){
            expect(new Uint8Array(f.verts.buffer,i*VERT_FLOATS*4,15*4)).toEqual(new Uint8Array(before.buffer,i*VERT_FLOATS*4,15*4));
            expect(Array.from(f.verts.slice(i*VERT_FLOATS+15,(i+1)*VERT_FLOATS))).toEqual([0,0,0]);
        }
    });
    it("locked arrays keep object positions for lighting and repeated draws never relight cached colors",()=>{
        const f=fixture(),dv=new DataView(f.mem.buffer);
        for(let i=0;i<3;i++)for(let k=0;k<3;k++)dv.setFloat32(0x100+i*12+k*4,f.verts[i*VERT_FLOATS+k],true);
        f.ctx.vertexArray={enabled:true,pointer:0x100,size:3,type:0x1406,stride:0};
        f.ctx.currentColor.set([.2,.3,.4,1]);f.ctx.enableFlags.add(COLOR_MATERIAL);f.ctx.enableFlags.add(LIGHT0);
        cvaLock(f.ctx,0,3);const out=new Float32Array(3*VERT_FLOATS),idx=sequentialIndices(0,3);
        expect(gatherVertices(f.ctx,idx,3,out,0,true)).toBe(VertexSpace.OBJECT);
        const raw=out.slice(),memory=f.mem.slice();applyLightingFlat(f.ctx,out,0,3,4);
        f.ctx.lights[0].diffuse.fill(.5);gatherVertices(f.ctx,idx,3,out,0,true);
        expect(out).toEqual(raw);applyLightingFlat(f.ctx,out,0,3,4);expect(out[4]).toBeCloseTo(.1);
        expect(f.mem).toEqual(memory);
        f.ctx.enableFlags.delete(LIGHTING);expect(gatherVertices(f.ctx,idx,3,out,0,true)).toBe(VertexSpace.CLIP);
    });
    it("captures vertex-time material changes inside Begin and restores the lazy material sidecar",()=>{
        const f=fixture(),gl={...createImmediateExports(f.ctx),...createStateExports(f.ctx)};
        function emission(r:number,g:number,b:number){const dv=new DataView(f.mem.buffer);[r,g,b,1].forEach((v,i)=>dv.setFloat32(0x300+i*4,v,true));call(gl,"glMaterialfv",[0x0404,0x1600,0x300]);}
        call(gl,"glBegin",[4]);emission(.2,0,0);call(gl,"glVertex3f",[bits(0),bits(0),bits(0)]);
        emission(0,.4,0);call(gl,"glVertex3f",[bits(1),bits(0),bits(0)]);
        emission(0,0,.6);call(gl,"glVertex3f",[bits(0),bits(1),bits(0)]);
        const saved=captureImmediateMaterials(f.ctx);expect(saved?.materials.length).toBe(4);
        restoreImmediateMaterials(f.ctx,null);restoreImmediateMaterials(f.ctx,saved);
        call(gl,"glEnd");
        expect(f.ctx.vertArena.data[4]).toBeCloseTo(.2);expect(f.ctx.vertArena.data[VERT_FLOATS+5]).toBeCloseTo(.4);
        expect(f.ctx.vertArena.data[2*VERT_FLOATS+6]).toBeCloseTo(.6);
        expect(captureImmediateMaterials(f.ctx)).toBeNull();
    });
    it("lit display lists replay inherited vertex color instead of an immutable baked lighting result",()=>{
        const f=fixture();f.ctx.enableFlags.add(COLOR_MATERIAL);f.ctx.colorMaterialParam=0x1600;
        const gl={...createImmediateExports(f.ctx),...createListExports(f.ctx)};
        (f.ctx.process as unknown as {getModule:()=>unknown}).getModule=()=>({exports:gl});
        const args:number[][]=[[bits(0),bits(0),bits(0)],[bits(1),bits(0),bits(0)],[bits(0),bits(1),bits(0)]];
        f.ctx.displayLists.set(1,{prebaked:[{kind:"verts",mode:4,flatVerts:f.verts,count:3}],commands:[
            {fn:"glBegin",args:[4]},...args.map(args=>({fn:"glVertex3f",args})),{fn:"glEnd",args:[]}]});
        call(gl,"glColor3f",[bits(.2),bits(.4),bits(.6)]);call(gl,"glCallList",[1]);
        expect(f.ctx.vertArena.data[4]).toBeCloseTo(.2);expect(f.ctx.vertArena.data[5]).toBeCloseTo(.4);
        expect(f.verts[4]).toBe(0);
    });
});

describe("unclamped color-material inputs and list activation",()=>{
    it("clamps tracked float RGB only after lighting, including negative emission",()=>{
        const f=fixture();f.ctx.enableFlags.add(LIGHT0);f.ctx.enableFlags.add(COLOR_MATERIAL);
        f.ctx.colorMaterialParam=0x1201;f.verts.set([2,0,0,1],4);f.ctx.lights[0].diffuse.fill(.25);
        expect(evaluate(f)[4]).toBeCloseTo(.5);
        f.ctx.colorMaterialParam=0x1600;f.verts[4]=-.2;f.ctx.lights[0].diffuse.fill(0);
        f.ctx.lightModelAmbient.fill(.5);expect(evaluate(f)[4]).toBeCloseTo(.3);
    });
    it("an in-list lighting enable retains inherited color through raw replay",()=>{
        const f=fixture();f.ctx.enableFlags.delete(LIGHTING);f.ctx.enableFlags.add(COLOR_MATERIAL);f.ctx.colorMaterialParam=0x1600;
        const gl={...createImmediateExports(f.ctx),...createStateExports(f.ctx),...createListExports(f.ctx)};
        (f.ctx.process as unknown as {getModule:()=>unknown}).getModule=()=>({exports:gl});
        f.ctx.displayLists.set(2,{prebaked:[{kind:"cmd",fn:"glEnable",args:[LIGHTING]},{kind:"verts",mode:4,flatVerts:f.verts,count:3}],
            commands:[{fn:"glEnable",args:[LIGHTING]},{fn:"glBegin",args:[4]},
            {fn:"glVertex3f",args:[bits(0),bits(0),bits(0)]},{fn:"glVertex3f",args:[bits(1),bits(0),bits(0)]},
            {fn:"glVertex3f",args:[bits(0),bits(1),bits(0)]},{fn:"glEnd",args:[]}]});
        // Real glEndList refuses baking an enabling list; this manually supplied legacy
        // bake also exercises replay's guard for savestates containing old list data.
        call(gl,"glColor3f",[bits(.2),bits(.4),bits(.6)]);call(gl,"glCallList",[2]);
        expect(f.ctx.vertArena.data[4]).toBeCloseTo(.2);expect(f.ctx.vertArena.data[6]).toBeCloseTo(.6);
    });
});

it("unlit baked lists preserve final current color and persistent color-material state",()=>{
    for(const tracking of [false,true]) {
        const f=fixture();f.ctx.enableFlags.delete(LIGHTING);
        const gl={...createImmediateExports(f.ctx),...createStateExports(f.ctx),...createListExports(f.ctx)};
        (f.ctx.process as unknown as {getModule:()=>unknown}).getModule=()=>({exports:gl});
        f.ctx.colorMaterialFace=0x0405;f.ctx.colorMaterialParam=0x1600;
        if(tracking)call(gl,"glEnable",[COLOR_MATERIAL]);
        call(gl,"glNewList",[3,0x1300]);
        f.ctx.compilingCommands=[{fn:"glBegin",args:[4]},{fn:"glColor3f",args:[bits(.8),bits(.2),bits(.1)]},
            {fn:"glVertex3f",args:[bits(0),bits(0),bits(0)]},{fn:"glVertex3f",args:[bits(1),bits(0),bits(0)]},
            {fn:"glVertex3f",args:[bits(0),bits(1),bits(0)]},{fn:"glEnd",args:[]}];
        call(gl,"glEndList");expect(f.ctx.displayLists.get(3)?.prebaked).not.toBeNull();
        call(gl,"glColor3f",[bits(0),bits(0),bits(1)]);call(gl,"glCallList",[3]);
        expect(f.ctx.currentColor[0]).toBeCloseTo(.8);
        if(!tracking)call(gl,"glEnable",[COLOR_MATERIAL]);
        expect(f.ctx.materialBackEmission[0]).toBeCloseTo(.8);
        expect(f.ctx.materialBackEmission[1]).toBeCloseTo(.2);
    }
});

it("signed-short vectors read two-byte components and COMPILE_AND_EXECUTE replays frozen values",()=>{
    const mem=new Uint8Array(1024),view=new DataView(mem.buffer),module=new OpenGL32();
    module.initialize({getCurrentMemory:()=>mem,dispatcher:{},getModule:()=>module} as never);
    const ctx=module.getContext()!,run=(name:string,...args:number[])=>module.exports[name]({} as never,mem,args);
    ctx.enableFlags.add(LIGHTING);ctx.materialFrontEmission.set([.2,.3,.4,1]);ctx.lightModelAmbient.fill(0);
    run("glNewList",7,0x1301);run("glBegin",0);
    for(const count of [2,3,4]){
        const values=[-2,3,-4,1];for(let i=0;i<4;i++)view.setInt16(128+i*2,values[i],true);
        run("glVertex"+count+"sv",128);
    }
    for(const count of [1,2,3,4]){
        for(let i=0;i<4;i++)view.setInt16(128+i*2,[-5,6,-7,1][i],true);
        run("glTexCoord"+count+"sv",128);run("glVertex2f",bits(0),bits(0));
    }
    run("glEnd");run("glEndList");
    const before=ctx.vertArena.data.slice(0,ctx.vertArena.used);
    expect(Array.from(before.slice(0,4))).toEqual([-2,3,0,1]);
    expect(Array.from(before.slice(VERT_FLOATS,VERT_FLOATS+4))).toEqual([-2,3,-4,1]);
    expect(Array.from(before.slice(2*VERT_FLOATS,2*VERT_FLOATS+4))).toEqual([-2,3,-4,1]);
    expect(before[6*VERT_FLOATS+11]).toBe(-5);expect(before[6*VERT_FLOATS+12]).toBe(6);
    ctx.vertArena.reset();ctx.commands.reset();
    // The first three vertices inherit UVs; compare both executions from the same state.
    ctx.currentTexCoord[0].set([0,0,0,1]);mem.fill(0xff);run("glCallList",7);
    expect(ctx.vertArena.data.slice(0,ctx.vertArena.used)).toEqual(before);
});
it("one-component float/double texture vectors match scalar reset during compile-and-execute",()=>{
    for(const type of ["f","d"]) {
        const mem=new Uint8Array(512),view=new DataView(mem.buffer),module=new OpenGL32();
        module.initialize({getCurrentMemory:()=>mem,dispatcher:{},getModule:()=>module} as never);
        const ctx=module.getContext()!,run=(name:string,...args:number[])=>module.exports[name]({} as never,mem,args);
        ctx.enableFlags.add(LIGHTING);ctx.materialFrontEmission.fill(.2);ctx.lightModelAmbient.fill(0);
        ctx.currentTexCoord[0][1]=.9;
        if(type==="f")view.setFloat32(128,.25,true);else view.setFloat64(128,.25,true);
        run("glNewList",8,0x1301);run("glBegin",0);run("glTexCoord1"+type+"v",128);
        run("glVertex2f",bits(0),bits(0));run("glEnd");run("glEndList");
        const before=ctx.vertArena.data.slice(0,ctx.vertArena.used);expect(before[12]).toBe(0);
        ctx.vertArena.reset();ctx.commands.reset();ctx.currentTexCoord[0][1]=.7;mem.fill(0xff);
        run("glCallList",8);expect(ctx.vertArena.data.slice(0,ctx.vertArena.used)).toEqual(before);
    }
});
