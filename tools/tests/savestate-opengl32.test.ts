import { afterEach, describe, expect, test } from "bun:test";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CaptureRefusal, newObjectGraph, restoreObjectGraph, type ObjectGraph } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants, type Participant } from "../../src/worker/savestate/participant";
import { OpenGL32 } from "../../src/worker/modules/opengl32";
import { Glu32 } from "../../src/worker/modules/glu32";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { createOpenGLContext, type OpenGLContext } from "../../src/worker/modules/opengl32/context";
import { createCvaState } from "../../src/worker/modules/opengl32/client-arrays";
import { createWglState } from "../../src/worker/modules/opengl32/wgl";
import {
    GL_ARRAY_POINTER_FIELDS, GL_CVA_ATTRIB_FIELDS, GL_CVA_FIELDS, GL_DISPLAY_LIST_FIELDS, GL_LIGHT_FIELDS,
    GL_MATRIX_STACK_FIELDS, GL_TEXGEN_FIELDS, GL_TEXTURE_FIELDS, GL_TEXTURE_UNIT_FIELDS, OPENGL_CONTEXT_FIELDS,
    WGL_BINDING_FIELDS, WGL_CONTEXT_FIELDS, WGL_STATE_FIELDS,
} from "../../src/worker/modules/opengl32/savestate";
import { preserveMemBinding } from "./helpers/scoped-process-state";

preserveMemBinding();

const GL_TRIANGLES = 4;
const GL_QUADS = 7;
const GL_COMPILE = 0x1300;
const GL_DEPTH_TEST = 0x0B71;
const GL_TEXTURE_2D = 0x0DE1;
const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_MODELVIEW = 0x1700;
const GL_PROJECTION = 0x1701;
const GL_VIEWPORT = 0x0BA2;
const GL_MODELVIEW_MATRIX = 0x0BA6;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_LINEAR = 0x2601;
const GL_LIGHT0 = 0x4000;
const GL_SPOT_EXPONENT = 0x1205;
const HDC = 0x1234;
const PIX = 0x2000;
const PIX_SUB = 0x3000;
const OUT = 0x100;

const bits = (x: number): number => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, x, true);
    return dv.getUint32(0, true);
};

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

const throughCodec = (v: SaveValue): SaveValue => decodeValue(encodeValue(v));

type Internals = { wgl: ReturnType<typeof createWglState>; restoreDebt: { executorOwed: boolean; colorSeed: unknown } };

interface Rig {
    gl: OpenGL32;
    mem: Uint8Array;
    ctx: OpenGLContext;
    call(name: string, ...args: number[]): number;
    participant: Participant;
    off(): void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    delete (globalThis as { __savestates?: boolean }).__savestates;
});

function makeRig(mem: Uint8Array = new Uint8Array(1 << 20)): Rig {
    Mem.bind(() => mem);
    const gl = new OpenGL32();
    const glu = new Glu32();
    const process = {
        getCurrentMemory: () => mem,
        dispatcher: {},
        getModule: (name: string) => (name === "opengl32" ? gl : name === "glu32" ? glu : undefined),
    };
    gl.initialize(process as never);
    const off = gl.registerSavestate();
    const participant = savestateParticipants.all().find(p => p.id === "opengl32")!;
    cleanups.push(off);
    return {
        gl, mem, ctx: gl.getContext()!, participant, off,
        call: (name, ...args) => gl.exports[name]!(null as never, mem, args as never) as number,
    };
}

function buildScene(r: Rig): void {
    const { call, mem } = r;
    mem.fill(0x11, PIX, PIX + 64);
    for (let i = 0; i < 64; i++) mem[PIX + i] = (i * 7 + 3) & 0xff;
    mem.fill(0xee, PIX_SUB, PIX_SUB + 16);
    const h = call("wglCreateContext", HDC);
    call("wglMakeCurrent", HDC, h);
    call("glViewport", 0, 0, 320, 240);
    call("glClearColor", bits(0.25), bits(0.5), bits(0.75), bits(1));
    call("glEnable", GL_DEPTH_TEST);
    call("glEnable", GL_TEXTURE_2D);
    call("glMatrixMode", GL_PROJECTION);
    call("glLoadIdentity");
    call("glMatrixMode", GL_MODELVIEW);
    call("glTranslatef", bits(1), bits(2), bits(3));
    call("glPushMatrix");
    call("glScalef", bits(2), bits(2), bits(2));
    call("glLightf", GL_LIGHT0, GL_SPOT_EXPONENT, bits(7));
    call("glGenTextures", 2, 0x400);
    const first = new DataView(mem.buffer).getUint32(0x400, true);
    call("glBindTexture", GL_TEXTURE_2D, first);
    call("glTexImage2D", GL_TEXTURE_2D, 0, GL_RGBA, 4, 4, 0, GL_RGBA, GL_UNSIGNED_BYTE, PIX);
    call("glTexParameteri", GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    call("glTexSubImage2D", GL_TEXTURE_2D, 0, 1, 1, 2, 2, GL_RGBA, GL_UNSIGNED_BYTE, PIX_SUB);
    call("glNewList", 1, GL_COMPILE);
    call("glBegin", GL_TRIANGLES);
    call("glVertex3f", bits(0), bits(0), bits(0));
    call("glVertex3f", bits(1), bits(0), bits(0));
    call("glVertex3f", bits(0), bits(1), bits(0));
    call("glEnd");
    call("glEnableClientState", 0x8074);
    call("glEndList");
    call("glBegin", GL_TRIANGLES);
    call("glVertex3f", bits(0), bits(0), bits(1));
    call("glVertex3f", bits(1), bits(0), bits(1));
    call("glVertex3f", bits(0), bits(1), bits(1));
    call("glEnd");
    call("glCallList", 1);
    call("glBegin", GL_QUADS);
    call("glVertex3f", bits(5), bits(5), bits(5));
    call("glVertex3f", bits(6), bits(6), bits(6));
}

function capture(r: Rig, graph: ObjectGraph = newObjectGraph()): { saved: SaveValue; graph: ObjectGraph } {
    const saved = r.participant.capture(graph as never);
    return { saved: throughCodec(saved), graph };
}

function restoreInto(target: Rig, saved: SaveValue, graph: ObjectGraph): void {
    void target.participant.restore(throughCodec(saved), restoreObjectGraph([], graph.blobs));
}

function readInts(r: Rig, pname: number, n: number): number[] {
    new Uint8Array(r.mem.buffer, OUT, 64).fill(0);
    r.call("glGetIntegerv", pname, OUT);
    const dv = new DataView(r.mem.buffer);
    return Array.from({ length: n }, (_, i) => dv.getInt32(OUT + i * 4, true));
}

function readFloats(r: Rig, pname: number, n: number): number[] {
    new Uint8Array(r.mem.buffer, OUT, 128).fill(0);
    r.call("glGetFloatv", pname, OUT);
    const dv = new DataView(r.mem.buffer);
    return Array.from({ length: n }, (_, i) => dv.getFloat32(OUT + i * 4, true));
}

describe("opengl32 savestate participant", () => {
    test("capture, restore into a fresh module and capture again is byte-identical", () => {
        const a = makeRig();
        buildScene(a);
        expect(a.ctx.commands.count).toBeGreaterThan(0);
        expect(a.ctx.immediateMode).toBe(true);
        const first = capture(a);
        const b = makeRig(a.mem);
        restoreInto(b, first.saved, first.graph);
        const second = capture(b);
        expect(bytes(second.saved)).toBe(bytes(first.saved));
        expect([...second.graph.blobs.keys()].sort()).toEqual([...first.graph.blobs.keys()].sort());
        expect(b.ctx.commands.count).toBe(a.ctx.commands.count);
    });

    test("real queries on the restored module answer what the original answered", () => {
        const a = makeRig();
        buildScene(a);
        const { saved, graph } = capture(a);
        const b = makeRig(a.mem);
        restoreInto(b, saved, graph);
        expect(b.call("wglGetCurrentContext")).toBe(a.call("wglGetCurrentContext"));
        expect(b.call("wglGetCurrentContext")).not.toBe(0);
        expect(b.call("wglGetCurrentDC")).toBe(HDC);
        expect(b.call("glIsEnabled", GL_DEPTH_TEST)).toBe(1);
        expect(b.call("glIsEnabled", GL_TEXTURE_2D)).toBe(1);
        expect(b.call("glIsEnabled", 0x0B44)).toBe(0);
        expect(b.call("glIsTexture", 1)).toBe(1);
        expect(b.call("glIsTexture", 99)).toBe(0);
        expect(b.call("glIsList", 1)).toBe(1);
        expect(readInts(b, GL_VIEWPORT, 4)).toEqual(readInts(a, GL_VIEWPORT, 4));
        expect(readInts(b, GL_VIEWPORT, 4)).toEqual([0, 0, 320, 240]);
        expect(readFloats(b, GL_MODELVIEW_MATRIX, 16)).toEqual(readFloats(a, GL_MODELVIEW_MATRIX, 16));
        expect(readFloats(b, GL_MODELVIEW_MATRIX, 16)[0]).toBe(2);
        expect(b.ctx.textures.get(1)!.data).toEqual(a.ctx.textures.get(1)!.data);
        expect(b.ctx.textures.get(1)!.data).not.toBe(a.ctx.textures.get(1)!.data);
        expect(b.ctx.textures.get(1)!.dirty).toBe(true);
        expect(b.ctx.lights[0]!.spotExponent).toBe(7);
    });

    test("the same further calls on the original and the restored module end in the same state", () => {
        const a = makeRig();
        buildScene(a);
        const { saved, graph } = capture(a);
        const b = makeRig(a.mem);
        restoreInto(b, saved, graph);
        const before = b.ctx.commands.count;
        for (const r of [a, b]) {
            r.call("glVertex3f", bits(7), bits(7), bits(7));
            r.call("glVertex3f", bits(8), bits(7), bits(7));
            r.call("glEnd");
            r.call("glCallList", 1);
            r.call("glTexSubImage2D", GL_TEXTURE_2D, 0, 0, 0, 2, 2, GL_RGBA, GL_UNSIGNED_BYTE, PIX);
        }
        expect(b.ctx.commands.count).toBeGreaterThan(before);
        expect(b.ctx.commands.count).toBe(a.ctx.commands.count);
        System.getInstance().services.render.setActive(a.ctx.presenter);
        const fromA = bytes(capture(a).saved);
        System.getInstance().services.render.setActive(b.ctx.presenter);
        expect(bytes(capture(b).saved)).toBe(fromA);
        System.getInstance().services.render.setActive(null);
    });

    test("every field of a fresh context and of its records has a policy", () => {
        const fake = { getCurrentMemory: () => new Uint8Array(16) };
        const ctx = createOpenGLContext(fake as never);
        expect(Object.keys(ctx).sort()).toEqual(Object.keys(OPENGL_CONTEXT_FIELDS).sort());
        expect(Object.keys(ctx.modelviewStack).sort()).toEqual(Object.keys(GL_MATRIX_STACK_FIELDS).sort());
        expect(Object.keys(ctx.textureUnits[0]!).sort()).toEqual(Object.keys(GL_TEXTURE_UNIT_FIELDS).sort());
        expect(Object.keys(ctx.lights[0]!).sort()).toEqual(Object.keys(GL_LIGHT_FIELDS).sort());
        expect(Object.keys(ctx.vertexArray).sort()).toEqual(Object.keys(GL_ARRAY_POINTER_FIELDS).sort());
        expect(Object.keys(ctx.texGenS).sort()).toEqual(Object.keys(GL_TEXGEN_FIELDS).sort());
        expect(Object.keys(ctx.cva).sort()).toEqual(Object.keys(GL_CVA_FIELDS).sort());
        expect(Object.keys(createCvaState().attribs[0]!).sort()).toEqual(Object.keys(GL_CVA_ATTRIB_FIELDS).sort());
        expect(Object.keys(createWglState()).sort()).toEqual(Object.keys(WGL_STATE_FIELDS).sort());

        const r = makeRig();
        buildScene(r);
        expect(Object.keys(r.ctx.textures.get(1)!).sort()).toEqual(Object.keys(GL_TEXTURE_FIELDS).sort());
        expect(Object.keys(r.ctx.displayLists.get(1)!).sort()).toEqual(Object.keys(GL_DISPLAY_LIST_FIELDS).sort());
        const wgl = (r.gl as unknown as Internals).wgl;
        expect(Object.keys([...wgl.contexts.values()][0]!).sort()).toEqual(Object.keys(WGL_CONTEXT_FIELDS).sort());
        expect(Object.keys({ hglrc: 1, hdc: 2 }).sort()).toEqual(Object.keys(WGL_BINDING_FIELDS).sort());
        for (const value of Object.values(OPENGL_CONTEXT_FIELDS)) {
            expect(["save", "derive", "host", "transient"]).toContain(value);
        }
    });

    test("texture pixels are copied once per version and never alias the guest-visible array", () => {
        const r = makeRig();
        buildScene(r);
        const seen: Uint8Array[] = [];
        const io = { blob: (b: Uint8Array) => { seen.push(b); return newObjectGraph().blob(b); } };
        const pixelBlobs = () => seen.filter(b => b.length === 64);

        r.participant.capture(io as never);
        expect(pixelBlobs()).toHaveLength(1);
        const firstCopy = pixelBlobs()[0]!;
        const firstBytes = [...firstCopy];
        expect(firstCopy).not.toBe(r.ctx.textures.get(1)!.data);

        seen.length = 0;
        r.participant.capture(io as never);
        expect(pixelBlobs()).toHaveLength(1);
        expect(pixelBlobs()[0]).toBe(firstCopy);

        r.call("glTexSubImage2D", GL_TEXTURE_2D, 0, 0, 0, 2, 2, GL_RGBA, GL_UNSIGNED_BYTE, PIX);
        r.ctx.textures.get(1)!.data![60] ^= 0xff;
        expect([...firstCopy]).toEqual(firstBytes);

        seen.length = 0;
        r.participant.capture(io as never);
        expect(pixelBlobs()).toHaveLength(1);
        expect(pixelBlobs()[0]).not.toBe(firstCopy);
    });

    test("the command stream and the vertex arena are saved trimmed and come back as owned copies", () => {
        const a = makeRig();
        buildScene(a);
        const { saved, graph } = capture(a);
        const state = saved as { context: { commands: { count: number; i32: string }; vertArena: { used: number; data: string } } };
        expect(state.context.commands.count).toBe(a.ctx.commands.count);
        expect(graph.blobs.get(state.context.commands.i32)!.length).toBe(a.ctx.commands.count * 37 * 4);
        expect(graph.blobs.get(state.context.vertArena.data)!.length).toBe(a.ctx.vertArena.used * 4);
        const b = makeRig(a.mem);
        restoreInto(b, saved, graph);
        expect(b.ctx.vertArena.used).toBe(a.ctx.vertArena.used);
        expect([...b.ctx.vertArena.data.subarray(0, b.ctx.vertArena.used)]).toEqual([...a.ctx.vertArena.data.subarray(0, a.ctx.vertArena.used)]);
        const stored = graph.blobs.get(state.context.vertArena.data)!;
        const snapshot = [...stored];
        b.ctx.vertArena.data.fill(12345);
        b.ctx.commands.i32.fill(7);
        expect([...stored]).toEqual(snapshot);
    });

    test("the immediate-mode buffer is saved only while a primitive is open", () => {
        const r = makeRig();
        buildScene(r);
        const open = capture(r).saved as { context: { immediateFlatBuf: unknown } };
        expect(typeof open.context.immediateFlatBuf).toBe("string");
        r.call("glEnd");
        const closed = capture(r).saved as { context: { immediateFlatBuf: unknown } };
        expect(closed.context.immediateFlatBuf).toBeNull();
    });

    test("fifty capture and restore rounds do not grow anything", () => {
        const r = makeRig();
        buildScene(r);
        const wgl = (r.gl as unknown as Internals).wgl;
        const sizes = () => [r.ctx.textures.size, r.ctx.displayLists.size, wgl.contexts.size, wgl.threadBindings.size, r.ctx.enableFlags.size, r.ctx.commands.count, r.ctx.vertArena.used];
        const start = sizes();
        const registered = savestateParticipants.all().length;
        let firstBytes = "";
        for (let i = 0; i < 50; i++) {
            const { saved, graph } = capture(r);
            if (i === 0) firstBytes = bytes(saved);
            restoreInto(r, saved, graph);
            expect(sizes()).toEqual(start);
        }
        expect(bytes(capture(r).saved)).toBe(firstBytes);
        expect(savestateParticipants.all().length).toBe(registered);
    });

    test("without savestates enabled initialize registers nothing, however often it runs", () => {
        const before = savestateParticipants.all().map(p => p.id);
        for (let i = 0; i < 50; i++) {
            const gl = new OpenGL32();
            gl.initialize({ getCurrentMemory: () => new Uint8Array(16), dispatcher: {}, getModule: () => undefined } as never);
            gl.reset();
        }
        expect(savestateParticipants.all().map(p => p.id)).toEqual(before);
    });

    test("with savestates enabled initialize registers the participant", () => {
        (globalThis as { __savestates?: boolean }).__savestates = true;
        const gl = new OpenGL32();
        gl.initialize({ getCurrentMemory: () => new Uint8Array(16), dispatcher: {}, getModule: () => undefined } as never);
        const p = savestateParticipants.all().find(x => x.id === "opengl32");
        expect(p).toBeDefined();
        expect(p!.covers).toEqual(["opengl32", "glu32"]);
        cleanups.push(gl.registerSavestate());
    });

    test("a value the encoder does not know is refused by name", () => {
        const r = makeRig();
        class Opaque { x = 1; }
        r.ctx.hints.set(1, new Opaque() as never);
        expect(() => r.participant.capture(newObjectGraph() as never)).toThrow(CaptureRefusal);
        expect(() => r.participant.capture(newObjectGraph() as never)).toThrow(/context\.hints\[1\]: Opaque/);
        r.ctx.hints.clear();
        (r.ctx as unknown as { currentColor: unknown }).currentColor = new Uint8ClampedArray(4);
        expect(() => r.participant.capture(newObjectGraph() as never)).toThrow(/context\.currentColor: Uint8ClampedArray/);
    });

    test("quadrics and the WGL name counter survive", () => {
        const a = makeRig();
        const glu = new Glu32();
        glu.initialize({ getCurrentMemory: () => a.mem, getModule: () => undefined } as never);
        glu.reset();
        const q1 = glu.exports["gluNewQuadric"]!(null as never, a.mem, [] as never) as number;
        glu.exports["gluQuadricTexture"]!(null as never, a.mem, [q1, 1] as never);
        buildScene(a);
        const { saved, graph } = capture(a);
        glu.reset();
        const b = makeRig(a.mem);
        restoreInto(b, saved, graph);
        const q2 = glu.exports["gluNewQuadric"]!(null as never, a.mem, [] as never) as number;
        expect(q2).toBe(q1 + 1);
        expect(b.call("wglCreateContext", HDC)).toBe((a.gl as unknown as Internals).wgl.nextHglrc);
        glu.reset();
    });

    test("a colour target that cannot be read back refuses the save by name, once", async () => {
        const a = makeRig();
        buildScene(a);
        a.ctx.executor = { getDrawableSize: () => [2, 2], readPixels: async () => { throw new Error("device lost"); } } as never;
        await a.participant.prepare!();
        expect(() => capture(a)).toThrow(CaptureRefusal);
        a.ctx.executor = { getDrawableSize: () => [2, 2], readPixels: async () => null } as never;
        await a.participant.prepare!();
        expect(capture(a).saved).toHaveProperty("color", null);
    });

    test("the executor and the colour target are owed until a backend exists, then settled", async () => {
        const a = makeRig();
        buildScene(a);
        const rgba = new Uint8Array(4 * 2 * 2).map((_, i) => i * 5 + 1);
        a.ctx.executor = { getDrawableSize: () => [2, 2], readPixels: async () => rgba } as never;
        await a.participant.prepare!();
        const { saved, graph } = capture(a);
        const color = (saved as { color: { width: number; height: number; pixels: string } }).color;
        expect([color.width, color.height]).toEqual([2, 2]);
        expect([...graph.blobs.get(color.pixels)!]).toEqual([...rgba]);
        expect(capture(a).saved).toHaveProperty("color", null);

        const b = makeRig(a.mem);
        restoreInto(b, saved, graph);
        const debt = (b.gl as unknown as Internals).restoreDebt;
        expect(debt.executorOwed).toBe(true);
        expect(b.ctx.executor).toBeNull();
        expect(System.getInstance().services.render.getActive()).toBe(b.ctx.presenter);

        b.gl.setBackend({} as never);
        expect(b.ctx.executor).toBeInstanceOf(OpenGLBackendExecutor);
        expect(debt.executorOwed).toBe(false);
        expect(debt.colorSeed).toBeNull();
        const seed = (b.ctx.executor as unknown as { colorSeed: { rgba: Uint8Array; width: number } }).colorSeed;
        expect([...seed.rgba]).toEqual([...rgba]);
        expect(seed.width).toBe(2);

        const c = makeRig(a.mem);
        c.ctx.backend = {} as never;
        restoreInto(c, saved, graph);
        expect(c.ctx.executor).toBeInstanceOf(OpenGLBackendExecutor);
        System.getInstance().services.render.setActive(null);
    });

    test("nothing is owed when no context was current and the presenter was idle", () => {
        const a = makeRig();
        a.call("glEnable", GL_DEPTH_TEST);
        const { saved, graph } = capture(a);
        const b = makeRig(a.mem);
        restoreInto(b, saved, graph);
        expect((b.gl as unknown as Internals).restoreDebt.executorOwed).toBe(false);
        b.gl.setBackend({} as never);
        expect(b.ctx.executor).toBeNull();
    });

    test("the schema is version 1 with a pinned hash", () => {
        const r = makeRig();
        expect(r.participant.version).toBe(1);
        expect(savestateParticipants.schemas().opengl32).toEqual({ version: 1, schemaHash: "3e23da0754ccd8ed" });
    });
});
