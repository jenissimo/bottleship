import { describe, expect, test } from "bun:test";
import { createOpenGLContext, applyColorMaterial, VERT_FLOATS, VERT_SECONDARY_COLOR } from "../../src/worker/modules/opengl32/context";
import { createStateExports } from "../../src/worker/modules/opengl32/state";
import * as GL from "../../src/worker/modules/opengl32/constants";

function rig() {
    const mem = new Uint8Array(4096);
    const ctx = createOpenGLContext({ getCurrentMemory: () => mem } as never);
    const exports = createStateExports(ctx);
    const dv = new DataView(mem.buffer);
    const call = (name: string, ...args: number[]) => exports[name]!(null as never, mem, args);
    const vector = (values: number[], integer = false) => {
        values.forEach((v, i) => integer ? dv.setInt32(256 + i * 4, v, true) : dv.setFloat32(256 + i * 4, v, true));
        return 256;
    };
    const bits = (value: number) => { dv.setFloat32(128, value, true); return dv.getUint32(128, true); };
    return { ctx, call, vector, bits };
}

describe("fixed-function lighting state contracts", () => {
    test("scissored clear cannot inherit separate specular from reused arena memory", () => {
        const { ctx, call } = rig();
        ctx.vertArena.data.fill(0.75);
        call("glEnable", GL.GL_SCISSOR_TEST);
        call("glClear", GL.GL_COLOR_BUFFER_BIT);
        expect(ctx.vertArena.used).toBe(6 * VERT_FLOATS);
        for (let i = 0; i < 6; i++) {
            const b = i * VERT_FLOATS + VERT_SECONDARY_COLOR;
            expect([...ctx.vertArena.data.subarray(b,b+3)]).toEqual([0,0,0]);
        }
    });

    test("pixel raster quad cannot inherit separate specular from reused arena memory", () => {
        const { ctx, call, vector } = rig();
        ctx.vertArena.data.fill(0.75);
        const pixels = vector([0]); // one zero RGBA texel; no lighting is evaluated
        call("glDrawPixels", 1, 1, GL.GL_RGBA, GL.GL_UNSIGNED_BYTE, pixels);
        expect(ctx.vertArena.used).toBe(6 * VERT_FLOATS);
        for (let i = 0; i < 6; i++) {
            const b = i * VERT_FLOATS + VERT_SECONDARY_COLOR;
            expect([...ctx.vertArena.data.subarray(b,b+3)]).toEqual([0,0,0]);
        }
    });

    test("positions are transformed once at call time; direction w=0 ignores translation", () => {
        const { ctx, call, vector } = rig();
        const modelview = ctx.modelviewStack.stack[0]!;
        modelview.set([2,0,0,0, 0,3,0,0, 0,0,4,0, 10,20,30,1]);
        call("glLightfv", GL.GL_LIGHT0, GL.GL_POSITION, vector([1,2,3,1]));
        expect([...ctx.lights[0]!.position]).toEqual([12,26,42,1]);
        modelview[12] = 1000;
        expect([...ctx.lights[0]!.position]).toEqual([12,26,42,1]);
        call("glLightfv", GL.GL_LIGHT0 + 1, GL.GL_POSITION, vector([1,2,3,0]));
        expect([...ctx.lights[1]!.position]).toEqual([2,6,12,0]);
    });

    test("integer position and spot direction are direct numbers, not normalized colours", () => {
        const { ctx, call, vector } = rig();
        ctx.modelviewStack.stack[0]!.set([0,2,0,0, -3,0,0,0, 0,0,4,0, 10,20,30,1]);
        call("glLightiv", GL.GL_LIGHT0, GL.GL_POSITION, vector([1,2,3,1], true));
        expect([...ctx.lights[0]!.position]).toEqual([4,22,42,1]);
        call("glLightiv", GL.GL_LIGHT0, GL.GL_SPOT_DIRECTION, vector([1,2,3], true));
        // GL 1.5 §2.14.2: Mu*d, not inverse-transpose or translation.
        expect([...ctx.lights[0]!.spotDirection]).toEqual([-6,2,12]);
        call("glLightfv", GL.GL_LIGHT0 + 1, GL.GL_SPOT_DIRECTION, vector([1,2,3]));
        expect([...ctx.lights[1]!.spotDirection]).toEqual([-6,2,12]);
    });

    test("integer light/material colours cover the full signed normalized range", () => {
        const { ctx, call, vector } = rig();
        call("glLightiv", GL.GL_LIGHT0, GL.GL_AMBIENT, vector([-2147483648,0,2147483647,2147483647], true));
        expect([...ctx.lights[0]!.ambient]).toEqual([-1,0,1,1]);
        call("glMaterialiv", GL.GL_BACK, GL.GL_SPECULAR, vector([2147483647,-2147483648,0,2147483647], true));
        expect([...ctx.materialBackSpecular]).toEqual([1,-1,0,1]);
        expect([...ctx.materialFrontSpecular]).toEqual([0,0,0,1]);
    });

    test("front and back materials are independent, with BOTH updating both faces", () => {
        const { ctx, call, vector, bits } = rig();
        call("glMaterialfv", GL.GL_BACK, GL.GL_AMBIENT_AND_DIFFUSE, vector([0.5,0.25,0,0.75]));
        expect([...ctx.materialBackAmbient]).toEqual([0.5,0.25,0,0.75]);
        expect([...ctx.materialBackDiffuse]).toEqual([0.5,0.25,0,0.75]);
        expect(ctx.materialFrontDiffuse[0]).toBeCloseTo(0.8);
        call("glMaterialf", GL.GL_BACK, GL.GL_SHININESS, bits(17));
        expect(ctx.materialBackShininess).toBe(17);
        expect(ctx.materialFrontShininess).toBe(0);
        call("glMaterialfv", GL.GL_FRONT_AND_BACK, GL.GL_EMISSION, vector([0.25,0.5,1,1]));
        expect([...ctx.materialFrontEmission]).toEqual([0.25,0.5,1,1]);
        expect([...ctx.materialBackEmission]).toEqual([0.25,0.5,1,1]);
    });

    test("enabling color material immediately tracks current colour and disabling retains it", () => {
        const { ctx, call } = rig();
        ctx.currentColor.set([0.25,0.5,0.75,0.5]);
        call("glEnable", GL.GL_COLOR_MATERIAL);
        for (const value of [ctx.materialFrontAmbient, ctx.materialFrontDiffuse, ctx.materialBackAmbient, ctx.materialBackDiffuse]) {
            expect([...value]).toEqual([0.25,0.5,0.75,0.5]);
        }
        ctx.currentColor.set([1,0,0,1]);
        applyColorMaterial(ctx);
        call("glDisable", GL.GL_COLOR_MATERIAL);
        ctx.currentColor.set([0,1,0,1]);
        applyColorMaterial(ctx);
        expect([...ctx.materialBackDiffuse]).toEqual([1,0,0,1]);
    });

    test("color material mode changes track immediately and explicit material cannot overwrite tracked channels", () => {
        const { ctx, call, vector } = rig();
        ctx.currentColor.set([0.25,0.5,0.75,0.5]);
        call("glEnable", GL.GL_COLOR_MATERIAL);
        call("glColorMaterial", GL.GL_BACK, GL.GL_EMISSION);
        expect([...ctx.materialBackEmission]).toEqual([0.25,0.5,0.75,0.5]);
        expect([...ctx.materialFrontEmission]).toEqual([0,0,0,1]);
        call("glMaterialfv", GL.GL_FRONT_AND_BACK, GL.GL_EMISSION, vector([1,1,1,1]));
        expect([...ctx.materialBackEmission]).toEqual([0.25,0.5,0.75,0.5]);
        expect([...ctx.materialFrontEmission]).toEqual([1,1,1,1]);
        call("glColorMaterial", GL.GL_FRONT, GL.GL_AMBIENT);
        call("glMaterialfv", GL.GL_FRONT, GL.GL_AMBIENT_AND_DIFFUSE, vector([0,0,0,1]));
        expect([...ctx.materialFrontAmbient]).toEqual([0.25,0.5,0.75,0.5]);
        expect([...ctx.materialFrontDiffuse]).toEqual([0,0,0,1]);
    });

    test("invalid material/color-material enums and ranges do not mutate state", () => {
        const { ctx, call, vector, bits } = rig();
        const oldDiffuse = [...ctx.materialBackDiffuse];
        for (const [face,pname] of [[123,GL.GL_DIFFUSE], [GL.GL_BACK,123]]) {
            ctx.error = 0;
            call("glMaterialfv", face!, pname!, vector([1,0,0,1]));
            expect(ctx.error).toBe(GL.GL_INVALID_ENUM);
            expect([...ctx.materialBackDiffuse]).toEqual(oldDiffuse);
        }
        call("glMaterialf", GL.GL_BACK, GL.GL_SHININESS, bits(129));
        expect(ctx.error).toBe(GL.GL_INVALID_VALUE);
        expect(ctx.materialBackShininess).toBe(0);
        for (const [face,param] of [[123,GL.GL_AMBIENT],[GL.GL_FRONT,GL.GL_SHININESS]]) {
            ctx.error = 0;
            call("glColorMaterial", face!, param!);
            expect(ctx.error).toBe(GL.GL_INVALID_ENUM);
            expect(ctx.colorMaterialFace).toBe(GL.GL_FRONT_AND_BACK);
            expect(ctx.colorMaterialParam).toBe(GL.GL_AMBIENT_AND_DIFFUSE);
        }
    });

    test("light scalar bounds and unknown enums reject without mutation", () => {
        const { ctx, call, bits } = rig();
        for (const [pname,value] of [[GL.GL_SPOT_EXPONENT,-1], [GL.GL_SPOT_EXPONENT,129],
            [GL.GL_SPOT_CUTOFF,91], [GL.GL_LINEAR_ATTENUATION,-1]]) {
            ctx.error = 0;
            call("glLightf", GL.GL_LIGHT0, pname!, bits(value!));
            expect(ctx.error).toBe(GL.GL_INVALID_VALUE);
        }
        expect(ctx.lights[0]!.spotExponent).toBe(0);
        expect(ctx.lights[0]!.spotCutoff).toBe(180);
        expect(ctx.lights[0]!.linearAttenuation).toBe(0);
        for (const [light,pname] of [[GL.GL_LIGHT0+8,GL.GL_SPOT_CUTOFF],[GL.GL_LIGHT0,123],[GL.GL_LIGHT0,GL.GL_POSITION]]) {
            ctx.error = 0;
            call("glLighti", light!, pname!, 1);
            expect(ctx.error).toBe(GL.GL_INVALID_ENUM);
        }
        call("glLighti", GL.GL_LIGHT0, GL.GL_SPOT_CUTOFF, 180);
        expect(ctx.lights[0]!.spotCutoff).toBe(180);
    });

    test("light model booleans use nonzero, ambient is vector and color control accepts only its enums", () => {
        const { ctx, call, vector, bits } = rig();
        call("glLightModelf", GL.GL_LIGHT_MODEL_LOCAL_VIEWER, bits(0.25));
        call("glLightModeli", GL.GL_LIGHT_MODEL_TWO_SIDE, -7);
        expect(ctx.hints.get(GL.GL_LIGHT_MODEL_LOCAL_VIEWER)).toBe(1);
        expect(ctx.hints.get(GL.GL_LIGHT_MODEL_TWO_SIDE)).toBe(1);
        call("glLightModeliv", GL.GL_LIGHT_MODEL_AMBIENT, vector([2147483647,0,-2147483648,2147483647], true));
        expect([...ctx.lightModelAmbient]).toEqual([1,0,-1,1]);
        call("glLightModeli", GL.GL_LIGHT_MODEL_COLOR_CONTROL, GL.GL_SEPARATE_SPECULAR_COLOR);
        expect(ctx.hints.get(GL.GL_LIGHT_MODEL_COLOR_CONTROL)).toBe(GL.GL_SEPARATE_SPECULAR_COLOR);
        call("glLightModeli", GL.GL_LIGHT_MODEL_COLOR_CONTROL, 123);
        expect(ctx.error).toBe(GL.GL_INVALID_ENUM);
        expect(ctx.hints.get(GL.GL_LIGHT_MODEL_COLOR_CONTROL)).toBe(GL.GL_SEPARATE_SPECULAR_COLOR);
    });

    test("only material is permitted inside Begin; forbidden state calls preserve state", () => {
        const { ctx, call, vector, bits } = rig();
        ctx.immediateMode = true;
        call("glMaterialf", GL.GL_BACK, GL.GL_SHININESS, bits(12));
        expect(ctx.error).toBe(0);
        expect(ctx.materialBackShininess).toBe(12);
        for (const [name,args] of [
            ["glLightfv",[GL.GL_LIGHT0,GL.GL_POSITION,vector([1,2,3,1])]],
            ["glLightModeli",[GL.GL_LIGHT_MODEL_TWO_SIDE,1]],
            ["glColorMaterial",[GL.GL_FRONT,GL.GL_EMISSION]],
            ["glEnable",[GL.GL_LIGHTING]],
        ] as Array<[string,number[]]>) {
            ctx.error = 0; call(name, ...args); expect(ctx.error).toBe(GL.GL_INVALID_OPERATION);
        }
        expect([...ctx.lights[0]!.position]).toEqual([0,0,1,0]);
        expect(ctx.hints.has(GL.GL_LIGHT_MODEL_TWO_SIDE)).toBe(false);
        expect(ctx.colorMaterialFace).toBe(GL.GL_FRONT_AND_BACK);
        expect(ctx.enableFlags.has(GL.GL_LIGHTING)).toBe(false);
    });
});
