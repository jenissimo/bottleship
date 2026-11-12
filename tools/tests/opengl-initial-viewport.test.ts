/**
 * A GL context takes its drawable's extent as viewport and scissor box the first time it is
 * made current (GL 1.1 spec 2.10.1 / 4.1.2). A title that never calls glViewport draws with
 * that rectangle for its whole run, so a fixed 640x480 default puts an 800x600 window's
 * picture into a corner of it.
 */

import { describe, expect, test } from "bun:test";
import { createOpenGLContext, type OpenGLContext } from "../../src/worker/modules/opengl32/context";
import { createStateExports } from "../../src/worker/modules/opengl32/state";
import { createWglExports } from "../../src/worker/modules/opengl32/wgl";

const WINDOW_DC = 0xdc;
const OTHER_DC = 0xdd;

function makeHarness(sizes: Record<number, { width: number; height: number }>) {
    const mem = new Uint8Array(0x1000);
    const ctx: OpenGLContext = createOpenGLContext({ getCurrentMemory: () => mem } as any);
    const asked: number[] = [];
    const api = {
        ...createStateExports(ctx),
        ...createWglExports(ctx, (hdc) => { asked.push(hdc); return sizes[hdc]!; }),
    };
    const call = (name: string, ...args: number[]) =>
        (api[name]!({ esp: 0 } as any, mem, args as any) as number) >>> 0;
    const viewport = () => [ctx.viewportX, ctx.viewportY, ctx.viewportW, ctx.viewportH];
    const scissor = () => [ctx.scissorX, ctx.scissorY, ctx.scissorW, ctx.scissorH];
    return { ctx, call, viewport, scissor, asked };
}

describe("initial GL viewport and scissor box", () => {
    test("the first wglMakeCurrent adopts the window's client size", () => {
        const h = makeHarness({ [WINDOW_DC]: { width: 800, height: 600 } });
        const rc = h.call("wglCreateContext", WINDOW_DC);
        expect(h.viewport()).toEqual([0, 0, 640, 480]);
        const before = h.ctx.commands.count;
        expect(h.call("wglMakeCurrent", WINDOW_DC, rc)).toBe(1);
        expect(h.viewport()).toEqual([0, 0, 800, 600]);
        expect(h.scissor()).toEqual([0, 0, 800, 600]);
        // The renderer learns the rectangle the same way it does from glViewport.
        expect(h.ctx.commands.count).toBe(before + 1);
    });

    test("rebinding the same context does not ask again or move the rectangles", () => {
        const sizes = { [WINDOW_DC]: { width: 800, height: 600 } };
        const h = makeHarness(sizes);
        const rc = h.call("wglCreateContext", WINDOW_DC);
        h.call("wglMakeCurrent", WINDOW_DC, rc);
        sizes[WINDOW_DC] = { width: 1024, height: 768 };
        h.call("wglMakeCurrent", 0, 0);
        h.call("wglMakeCurrent", WINDOW_DC, rc);
        expect(h.asked).toEqual([WINDOW_DC]);
        expect(h.viewport()).toEqual([0, 0, 800, 600]);
    });

    test("rectangles the guest set survive a second context's first bind", () => {
        const h = makeHarness({
            [WINDOW_DC]: { width: 800, height: 600 },
            [OTHER_DC]: { width: 320, height: 200 },
        });
        const rc = h.call("wglCreateContext", WINDOW_DC);
        h.call("wglMakeCurrent", WINDOW_DC, rc);
        h.call("glViewport", 10, 20, 300, 200);
        h.call("glScissor", 1, 2, 30, 40);
        const second = h.call("wglCreateContext", OTHER_DC);
        h.call("wglMakeCurrent", OTHER_DC, second);
        expect(h.viewport()).toEqual([10, 20, 300, 200]);
        expect(h.scissor()).toEqual([1, 2, 30, 40]);
    });

    test("only the rectangle the guest left alone follows the drawable", () => {
        const h = makeHarness({ [WINDOW_DC]: { width: 800, height: 600 } });
        const probe = h.call("wglCreateContext", WINDOW_DC);
        h.call("wglMakeCurrent", WINDOW_DC, probe);
        h.call("glScissor", 1, 2, 30, 40);
        const rc = h.call("wglCreateContext", WINDOW_DC);
        h.call("wglMakeCurrent", WINDOW_DC, rc);
        expect(h.viewport()).toEqual([0, 0, 800, 600]);
        expect(h.scissor()).toEqual([1, 2, 30, 40]);
    });

    test("after the last context is deleted the next one starts from its drawable again", () => {
        const sizes = { [WINDOW_DC]: { width: 640, height: 480 } };
        const h = makeHarness(sizes);
        const probe = h.call("wglCreateContext", WINDOW_DC);
        h.call("wglMakeCurrent", WINDOW_DC, probe);
        h.call("glViewport", 0, 0, 320, 240);
        h.call("wglDeleteContext", probe);
        sizes[WINDOW_DC] = { width: 800, height: 600 };
        const rc = h.call("wglCreateContext", WINDOW_DC);
        h.call("wglMakeCurrent", WINDOW_DC, rc);
        expect(h.viewport()).toEqual([0, 0, 800, 600]);
        expect(h.scissor()).toEqual([0, 0, 800, 600]);
    });

    test("a context made current without a DC waits for its drawable", () => {
        const h = makeHarness({ [WINDOW_DC]: { width: 800, height: 600 } });
        const rc = h.call("wglCreateContext", WINDOW_DC);
        h.call("wglMakeCurrent", 0, rc);
        expect(h.asked).toEqual([]);
        expect(h.viewport()).toEqual([0, 0, 640, 480]);
        h.call("wglMakeCurrent", WINDOW_DC, rc);
        expect(h.viewport()).toEqual([0, 0, 800, 600]);
    });
});
