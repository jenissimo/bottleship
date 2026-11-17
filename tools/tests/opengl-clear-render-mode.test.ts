import { describe, expect, test } from "bun:test";
import { createOpenGLContext, CI_CLEAR_MASK, CMD_I32 } from "../../src/worker/modules/opengl32/context";
import { createStateExports } from "../../src/worker/modules/opengl32/state";
import * as GL from "../../src/worker/modules/opengl32/constants";

describe("glClear outside rendering", () => {
    for (const mode of [GL.GL_SELECT, GL.GL_FEEDBACK]) {
        for (const scissored of [false, true]) {
            test(`mode ${mode}, scissor ${scissored}: preserves the rendered frame and resumes clearing`, () => {
                const mem = new Uint8Array(4096);
                const ctx = createOpenGLContext({ getCurrentMemory: () => mem } as never);
                const api = createStateExports(ctx);
                const call = (name: string, ...args: number[]) => api[name]!(null as never, mem, args);
                const mask = GL.GL_COLOR_BUFFER_BIT | GL.GL_DEPTH_BUFFER_BIT | GL.GL_STENCIL_BUFFER_BIT;

                // Keep real work before the picking pass; dropping/resetting the whole
                // stream would hide the bad clear but lose the frame just as surely.
                call("glClear", mask);
                const before = ctx.commands.i32.slice(0, ctx.commands.count * CMD_I32);
                const clears = ctx.frameSnapshot.clearCalls;
                if (scissored) {
                    call("glScissor", 10, 20, 100, 80);
                    call("glEnable", GL.GL_SCISSOR_TEST);
                }
                call("glSelectBuffer", 32, 256);
                call("glFeedbackBuffer", 32, 0x0601 /* GL_3D */, 512);
                call("glRenderMode", mode);
                const count = ctx.commands.count;
                const vertices = ctx.vertArena.used;
                call("glClear", mask);
                expect(ctx.commands.count).toBe(count);
                expect(ctx.commands.i32.slice(0, before.length)).toEqual(before);
                expect(ctx.vertArena.used).toBe(vertices);
                expect(ctx.frameSnapshot.clearCalls).toBe(clears);

                call("glRenderMode", GL.GL_RENDER);
                call("glDisable", GL.GL_SCISSOR_TEST);
                call("glClear", mask);
                expect(ctx.commands.count).toBe(count + 1);
                expect(ctx.commands.i32[count * CMD_I32 + CI_CLEAR_MASK]).toBe(mask);
                expect(ctx.frameSnapshot.clearCalls).toBe(clears + 1);
            });
        }
    }
});
