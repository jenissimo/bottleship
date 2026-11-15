import { describe, expect, test } from "bun:test";
import { OpenGL32 } from "../../src/worker/modules/opengl32";
import { VERT_FLOATS } from "../../src/worker/modules/opengl32/context";

function rig() {
    const mem = new Uint8Array(4096);
    const gl = new OpenGL32();
    gl.initialize({ getCurrentMemory: () => mem, dispatcher: {},
        getModule: (name: string) => name === "opengl32" ? gl : undefined } as never);
    const ctx = gl.getContext()!;
    const call = (name: string, ...args: number[]) => gl.exports[name]!(null as never, mem, args);
    const view = new DataView(mem.buffer);
    const put = (ptr: number, values: number[], type = "f") => values.forEach((v,i) => {
        if (type === "f") view.setFloat32(ptr+i*4,v,true);
        else if (type === "d") view.setFloat64(ptr+i*8,v,true);
        else if (type === "i") view.setInt32(ptr+i*4,v,true);
        else if (type === "ui") view.setUint32(ptr+i*4,v,true);
        else if (type === "s") view.setInt16(ptr+i*2,v,true);
        else if (type === "us") view.setUint16(ptr+i*2,v,true);
        else if (type === "b") view.setInt8(ptr+i,v);
        else view.setUint8(ptr+i,v);
    });
    return {mem,ctx,gl,call,put};
}

describe("display-list attribute vector snapshots", () => {
    test("ignored MultiTexCoord targets never dereference their unreadable pointer", () => {
        const {ctx,call} = rig();
        const before = ctx.currentTexCoord.map(v => [...v]);
        call("glNewList",4,0x1301);
        expect(() => call("glMultiTexCoord2fv",0x84BF,0xFFFFFFFC)).not.toThrow();
        expect(() => call("glMultiTexCoord4fvARB",0x84FF,0xFFFFFFFC)).not.toThrow();
        call("glEndList");
        expect(() => call("glCallList",4)).not.toThrow();
        expect(ctx.currentTexCoord.map(v => [...v])).toEqual(before);
    });

    test("lit replay uses call-time vertices, normals, colour and UVs after source memory changes", () => {
        const { mem,ctx,call,put } = rig();
        ctx.enableFlags.add(0x0B50); // lit lists intentionally use raw command replay
        ctx.enableFlags.add(0x4000);
        ctx.enableFlags.add(0x0B57);
        ctx.colorMaterialParam = 0x1201; // diffuse, exposing compiled colour and normal
        ctx.lightModelAmbient.fill(0);
        ctx.lights[0]!.ambient.fill(0);
        ctx.lights[0]!.diffuse.set([1,1,1,1]);
        ctx.lights[0]!.specular.fill(0);
        ctx.lights[0]!.position.set([0,0,1,0]);
        call("glNewList", 1, 0x1300);
        call("glBegin", 0);
        put(256,[0.25,0.5,0.75,1]); call("glColor4fv",256);
        put(256,[0,0,1]); call("glNormal3fv",256);
        put(256,[0.125,0.25]); call("glTexCoord2fv",256);
        put(256,[0.5,0.75]); call("glMultiTexCoord2fvARB",0x84C1,256);
        put(256,[0.25,0.5,0]); call("glVertex3fv",256);
        call("glEnd");
        call("glEndList");
        mem.fill(0xff,256,320);
        call("glCallList",1);
        const v = ctx.vertArena.data;
        expect(ctx.vertArena.used).toBe(VERT_FLOATS);
        expect([...v.subarray(0,4)]).toEqual([0.25,0.5,0,1]);
        expect([...v.subarray(4,8)]).toEqual([0.25,0.5,0.75,1]);
        expect([...v.subarray(8,11)]).toEqual([0,0,1]);
        expect([...v.subarray(11,15)]).toEqual([0.125,0.25,0.5,0.75]);
        expect([...ctx.currentColor]).toEqual([0.25,0.5,0.75,1]);
    });

    test("all implemented vector attribute families record owned scalar values", () => {
        const {mem,ctx,call,put} = rig();
        const cases = [
            ["glVertex2fv",[0.25,0.5],"f"], ["glVertex4dv",[1,2,3,1],"d"],
            ["glVertex3iv",[-1,2,3],"i"], ["glVertex2sv",[-2,3],"s"],
            ["glNormal3fv",[0,0,1],"f"], ["glNormal3dv",[0.5,0.25,1],"d"],
            ["glNormal3bv",[-127,0,127],"b"], ["glNormal3iv",[-1,0,1],"i"],
            ["glNormal3sv",[-32767,0,32767],"s"],
            ["glColor3fv",[0.25,0.5,0.75],"f"], ["glColor4dv",[0.25,0.5,0.75,1],"d"],
            ["glColor4bv",[-127,0,127,127],"b"], ["glColor3ubv",[64,128,255],"ub"],
            ["glColor3iv",[-1,0,1],"i"], ["glColor4uiv",[0,128,4294967295,4294967295],"ui"],
            ["glColor3sv",[-32767,0,32767],"s"], ["glColor4usv",[0,128,65535,65535],"us"],
            ["glTexCoord1fv",[0.25],"f"], ["glTexCoord2dv",[0.25,0.5],"d"],
            ["glTexCoord3iv",[-1,2,3],"i"], ["glTexCoord4sv",[-1,2,3,1],"s"],
            ["glMultiTexCoord2fv",[0.25,0.5],"f"], ["glMultiTexCoord4fvARB",[0.25,0.5,0,1],"f"],
        ] as Array<[string,number[],string]>;
        call("glNewList",2,0x1300);
        for (const [name,values,type] of cases) {
            put(256,values,type);
            call(name,...(name.startsWith("glMulti") ? [0x84C1,256] : [256]));
        }
        call("glEndList");
        mem.fill(0xff,256,320);
        const commands = ctx.displayLists.get(2)!.commands;
        expect(commands).toHaveLength(cases.length);
        for(let i=0;i<cases.length;i++) {
            const [name,values,type] = cases[i]!;
            const command = commands[i]!;
            expect(command.fn).toBe(name.replace(/v(ARB)?$/, "$1"));
            const prefix = name.startsWith("glMulti") ? [0x84C1] : [];
            const expected = type==="f" ? values.map(v => {
                const b = new ArrayBuffer(4),d = new DataView(b);
                d.setFloat32(0,v,true); return d.getUint32(0,true);
            }) : values;
            expect(command.args).toEqual([...prefix,...expected]);
        }
    });

    test("COMPILE_AND_EXECUTE draws once immediately and later replays the same frozen vectors", () => {
        const {mem,ctx,call,put} = rig();
        ctx.enableFlags.add(0x0B50);
        ctx.materialFrontEmission.set([0.25,0.5,0.75,1]);
        ctx.lightModelAmbient.fill(0);
        call("glNewList",3,0x1301);
        call("glBegin",0);
        put(256,[0.25,0.5,0]); call("glVertex3fv",256);
        call("glEnd");
        call("glEndList");
        const original = ctx.vertArena.data.slice(0,VERT_FLOATS);
        expect(ctx.vertArena.used).toBe(VERT_FLOATS);
        ctx.vertArena.reset(); ctx.commands.reset();
        mem.fill(0xff,256,320);
        call("glCallList",3);
        expect([...ctx.vertArena.data.subarray(0,VERT_FLOATS)]).toEqual([...original]);
    });
});
