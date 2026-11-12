import { expect, test } from "bun:test";
import { registerWriteBufferGLStateFunctions } from "../../src/worker/modules/opengl32/wbuf-state";

test("matrix-stack calls and glEnd go on the ring, the zero-argument ones through their own trampoline", () => {
    const plain: Array<[string, number]> = [];
    const zero: string[] = [];
    const calls: Array<[string, number[]]> = [];
    const impl = (name: string) => (_c: unknown, _m: unknown, args: number[]) => { calls.push([name, [...args]]); return 0; };
    const exports: Record<string, any> = {};
    for (const n of ["glTranslatef", "glRotatef", "glScalef", "glPushMatrix", "glPopMatrix", "glLoadIdentity", "glEnd"]) exports[n] = impl(n);
    const handlers: Record<string, (m8: Uint8Array, m32: Uint32Array, p: number) => void> = {};
    const dispatcher = {
        registerWriteBufferFunction: (_d: string, name: string, argCount: number, h: any) => { plain.push([name, argCount]); handlers[name] = h; return true; },
        registerZeroArgWriteBufferFunction: (_d: string, name: string, h: any) => { zero.push(name); handlers[name] = h; return true; },
    };
    registerWriteBufferGLStateFunctions(dispatcher, exports);
    expect(plain).toEqual([["glTranslatef", 3], ["glRotatef", 4], ["glScalef", 3]]);
    expect(zero).toEqual(["glPushMatrix", "glPopMatrix", "glLoadIdentity", "glEnd"]);
    const m32 = new Uint32Array([0, 0x3f800000, 0x40000000, 0x40400000]);
    handlers.glTranslatef!(new Uint8Array(m32.buffer), m32, 4);
    handlers.glPushMatrix!(new Uint8Array(m32.buffer), m32, 4);
    expect(calls).toEqual([["glTranslatef", [0x3f800000, 0x40000000, 0x40400000]], ["glPushMatrix", []]]);
});
