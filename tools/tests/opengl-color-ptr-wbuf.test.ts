import { afterEach, expect, test } from "bun:test";
import { createOpenGLContext } from "../../src/worker/modules/opengl32/context";
import { createImmediateExports, registerWriteBufferGLFunctions } from "../../src/worker/modules/opengl32/immediate";
import { createStateExports } from "../../src/worker/modules/opengl32/state";
import * as GL from "../../src/worker/modules/opengl32/constants";

const g = globalThis as { __noGlColorPtrDerefWbuf?: unknown };
afterEach(() => { delete g.__noGlColorPtrDerefWbuf; });
function fixture(flag?: unknown) {
    if (flag !== undefined) g.__noGlColorPtrDerefWbuf = flag;
    else delete g.__noGlColorPtrDerefWbuf;
    const mem = new Uint8Array(4096), words = new Uint32Array(mem.buffer), dv = new DataView(mem.buffer);
    const ctx = createOpenGLContext({ getCurrentMemory: () => mem } as never);
    const sync = createImmediateExports(ctx), state = createStateExports(ctx);
    const handlers = new Map<string, (m: Uint8Array, w: Uint32Array, p: number) => void>();
    const scalar = new Set<string>();
    registerWriteBufferGLFunctions({
        registerWriteBufferFunction(_dll: string, name: string) { scalar.add(name); },
        registerPtrDerefWriteBufferFunction(_dll: string, name: string, _n: number, h: any) { handlers.set(name, h); },
    }, ctx);
    return { ctx, mem, dv, words, sync, state, handlers, scalar };
}
test("strict narrow flag removes only the three added color pointer registrations", () => {
    for (const flag of [undefined, false, 1, "true"]) {
        const f = fixture(flag);
        for (const n of ["glColor4ubv","glColor4fv","glColor3fv"]) expect(f.handlers.has(n)).toBe(true);
    }
    const f = fixture(true);
    for (const n of ["glColor4ubv","glColor4fv","glColor3fv"]) {
        expect(f.handlers.has(n)).toBe(false);
        expect(f.scalar.has(n)).toBe(false); // no escape through broad scalar WBUF
        expect(typeof f.sync[n]).toBe("function");
    }
    for (const n of ["glVertex3fv","glNormal3fv","glTexCoord2fv"]) expect(f.handlers.has(n)).toBe(true);
    expect(f.scalar.has("glColor4f")).toBe(true);
});
for (const name of ["glColor4ubv", "glColor4fv", "glColor3fv"]) {
    test(name + " WBUF matches synchronous current color and both tracked materials", () => {
        const f=fixture(), s=fixture(true);
        for (const x of [f,s]) {
            x.state.glColorMaterial!(null as never,x.mem,[GL.GL_FRONT_AND_BACK,GL.GL_AMBIENT_AND_DIFFUSE]);
            x.state.glEnable!(null as never,x.mem,[GL.GL_COLOR_MATERIAL]);
            if(name==="glColor4ubv") x.mem.set([17,91,203,111],256);
            else [.125,.375,.75,.625].forEach((v,i)=>x.dv.setFloat32(256+i*4,v,true));
        }
        f.handlers.get(name)!(f.mem,f.words,256);
        s.sync[name]!(null as never,s.mem,[256]);
        expect([...f.ctx.currentColor]).toEqual([...s.ctx.currentColor]);
        for (const k of ["materialFrontAmbient","materialFrontDiffuse","materialBackAmbient","materialBackDiffuse"] as const)
            expect([...f.ctx[k]]).toEqual([...s.ctx[k]]);
        expect(f.ctx.currentColor[3]).toBe(name==="glColor3fv" ? 1 : name==="glColor4fv" ? .625 : Math.fround(111/255));
    });
    test(name + " records scalar values in COMPILE and applies CM only in COMPILE_AND_EXECUTE", () => {
        const f=fixture();
        f.state.glEnable!(null as never,f.mem,[GL.GL_COLOR_MATERIAL]);
        f.mem.set([17,91,203,111],256);
        if(name!=="glColor4ubv") [.125,.375,.75,.625].forEach((v,i)=>f.dv.setFloat32(256+i*4,v,true));
        f.ctx.compilingList=7; f.ctx.compilingListMode=GL.GL_COMPILE;
        const before=[...f.ctx.currentColor], material=[...f.ctx.materialFrontDiffuse];
        f.handlers.get(name)!(f.mem,f.words,256);
        expect([...f.ctx.currentColor]).toEqual(before);
        expect([...f.ctx.materialFrontDiffuse]).toEqual(material);
        const command=f.ctx.compilingCommands[0]!;
        expect(command.fn).toBe(name==="glColor4ubv" ? "glColor4ub" : name==="glColor4fv" ? "glColor4f" : "glColor3f");
        expect(command.args).not.toEqual([256]);
        f.ctx.compilingListMode=GL.GL_COMPILE_AND_EXECUTE;
        f.handlers.get(name)!(f.mem,f.words,256);
        expect([...f.ctx.currentColor]).not.toEqual(before);
        expect([...f.ctx.materialFrontDiffuse]).toEqual([...f.ctx.currentColor]);
    });
}
