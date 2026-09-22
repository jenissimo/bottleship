/**
 * GL name 0 is the DEFAULT TEXTURE OBJECT, not "no texture".
 *
 * GL 1.x §3.8: the default object exists per target from context creation, takes
 * uploads and parameters like any other, and is sampled when texturing is enabled.
 * It is only unnameable — glGenTextures never returns it, glDeleteTextures ignores it,
 * and texturing is switched by glEnable(GL_TEXTURE_2D), never by the binding.
 *
 * id Tech 2's Draw_StretchRaw (ref_gl) uploads EVERY cinematic frame into it:
 * GL_Bind(0) then glTexImage2D(...256x256...) then a textured quad. Dropping that
 * upload leaves the quad sampling the backend's 1x1 white stand-in, which is a
 * fullscreen white screen where the video should be.
 */
import { describe, expect, test } from "bun:test";
import { createTextureExports } from "../../src/worker/modules/opengl32/texture";
import {
    boundTextureStorageId, createTextureUnit, DEFAULT_TEXTURE_STORAGE_ID,
    type GLTextureObject, type OpenGLContext,
} from "../../src/worker/modules/opengl32/context";

const GL_TEXTURE_2D = 0x0DE1;
const GL_RGB = 0x1907;
const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_LINEAR = 0x2601;

const W = 4, H = 4;
const PIXELS_PTR = 0x1000;

function makeCtx() {
    const mem = new Uint8Array(1 << 16);
    // A frame the test can recognise: opaque red, the way a decoded cinematic arrives.
    for (let i = 0; i < W * H; i++) {
        mem[PIXELS_PTR + i * 4] = 0xF0;
        mem[PIXELS_PTR + i * 4 + 1] = 0x10;
        mem[PIXELS_PTR + i * 4 + 2] = 0x20;
        mem[PIXELS_PTR + i * 4 + 3] = 0xFF;
    }
    const ctx = {
        process: { getCurrentMemory: () => mem },
        textures: new Map<number, GLTextureObject>(),
        textureUnits: [createTextureUnit(), createTextureUnit()],
        activeTextureUnit: 0,
        nextTextureId: 1,
        unpackAlignment: 4,
        unpackRowLength: 0,
        unpackSkipPixels: 0,
        unpackSkipRows: 0,
        frameSnapshot: { texUploads: 0 },
        error: 0,
    } as unknown as OpenGLContext;
    return { ctx, exports: createTextureExports(ctx), mem };
}

/** The storage record the unit's current binding addresses. */
const boundTex = (ctx: OpenGLContext) =>
    ctx.textures.get(boundTextureStorageId(ctx.textureUnits[ctx.activeTextureUnit]));

describe("GL default texture object (name 0)", () => {
    test("glTexImage2D while 0 is bound defines the default object", () => {
        const { ctx, exports } = makeCtx();
        exports['glBindTexture']!(0 as never, 0 as never, [GL_TEXTURE_2D, 0] as never);
        exports['glTexImage2D']!(0 as never, 0 as never,
            [GL_TEXTURE_2D, 0, GL_RGB, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, PIXELS_PTR] as never);

        const tex = boundTex(ctx);
        expect(tex).toBeDefined();
        expect(tex!.width).toBe(W);
        expect(tex!.height).toBe(H);
        // The upload actually landed — this is the assertion the white screen failed.
        expect(tex!.data).not.toBeNull();
        expect(Array.from(tex!.data!.subarray(0, 4))).toEqual([0xF0, 0x10, 0x20, 0xFF]);
    });

    test("the default object is reachable by a draw, and is not name 0", () => {
        const { ctx, exports } = makeCtx();
        exports['glBindTexture']!(0 as never, 0 as never, [GL_TEXTURE_2D, 0] as never);
        exports['glTexImage2D']!(0 as never, 0 as never,
            [GL_TEXTURE_2D, 0, GL_RGB, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, PIXELS_PTR] as never);

        // The draw path spells "texturing disabled" as 0, so the default object's
        // storage key must be something the name space cannot produce.
        const id = boundTextureStorageId(ctx.textureUnits[0]);
        expect(id).toBe(DEFAULT_TEXTURE_STORAGE_ID);
        expect(id).not.toBe(0);
        expect(ctx.textures.get(id)?.data).not.toBeNull();
    });

    test("glTexParameter applies to the default object", () => {
        const { ctx, exports } = makeCtx();
        exports['glBindTexture']!(0 as never, 0 as never, [GL_TEXTURE_2D, 0] as never);
        exports['glTexParameteri']!(0 as never, 0 as never,
            [GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR] as never);
        expect(boundTex(ctx)!.minFilter).toBe(GL_LINEAR);
    });

    test("a named object and the default object are distinct storage", () => {
        const { ctx, exports } = makeCtx();
        exports['glBindTexture']!(0 as never, 0 as never, [GL_TEXTURE_2D, 0] as never);
        exports['glTexImage2D']!(0 as never, 0 as never,
            [GL_TEXTURE_2D, 0, GL_RGB, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, PIXELS_PTR] as never);

        exports['glBindTexture']!(0 as never, 0 as never, [GL_TEXTURE_2D, 7] as never);
        expect(boundTex(ctx)!.data).toBeNull();          // freshly named, never uploaded
        expect(ctx.textures.get(DEFAULT_TEXTURE_STORAGE_ID)!.data).not.toBeNull();

        exports['glBindTexture']!(0 as never, 0 as never, [GL_TEXTURE_2D, 0] as never);
        expect(boundTex(ctx)!.data).not.toBeNull();      // rebinding 0 finds it again
    });
});
