/**
 * Client vertex arrays: the flat gather and the EXT_compiled_vertex_array cache.
 *
 * Both are pure functions of (guest bytes + array state), so they are testable without
 * an emulator. The load-bearing assertions are the INVALIDATION ones: a lock is a hint,
 * and a cache that outlives the promise behind it renders stale geometry.
 */
import { describe, expect, it } from "bun:test";
import {
    gatherVertices, decodeIndices, sequentialIndices, guestViews,
    cvaLock, cvaUnlock, createCvaState, VertexSpace, validateClientArrayRange,
} from "../../src/worker/modules/opengl32/client-arrays";
import { VERT_FLOATS, mat4Identity, type OpenGLContext } from "../../src/worker/modules/opengl32/context";
import { createArrayExports } from "../../src/worker/modules/opengl32/arrays";

const GL_BYTE = 0x1400;
const GL_FLOAT = 0x1406;
const GL_INT = 0x1404;
const GL_SHORT = 0x1402;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_UNSIGNED_SHORT = 0x1403;
const GL_UNSIGNED_INT = 0x1405;
const GL_TRIANGLES = 0x0004;
const GL_INVALID_ENUM = 0x0500;
const GL_INVALID_OPERATION = 0x0502;
const GL_V3F = 0x2A21;
const GL_C4UB_V3F = 0x2A23;
const GL_T2F_V3F = 0x2A27;
const GL_T4F_C4F_N3F_V4F = 0x2A2D;

const GL_VERTEX_ARRAY_SLOT = { size: 3, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false };

function makeCtx(memBytes = 1 << 16) {
    const mem = new Uint8Array(memBytes);
    const stack = (m: Float32Array) => ({ stack: [m], top: 0, maxDepth: 32 });
    const ident = new Float32Array(16); mat4Identity(ident);
    const ident2 = new Float32Array(16); mat4Identity(ident2);
    const ctx = {
        process: { getCurrentMemory: () => mem },
        vertexArray: { ...GL_VERTEX_ARRAY_SLOT },
        colorArray: { size: 4, type: GL_UNSIGNED_BYTE, stride: 0, pointer: 0, enabled: false },
        normalArray: { size: 3, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false },
        texCoordArrays: [
            { size: 2, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false },
            { size: 2, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false },
        ],
        currentColor: new Float32Array([0.25, 0.5, 0.75, 1]),
        currentNormal: new Float32Array([0, 0, 1]),
        clientActiveTextureUnit: 0,
        enableFlags: new Set<number>(),
        cva: createCvaState(),
        modelviewStack: stack(ident),
        projectionStack: stack(ident2),
        error: 0,
    } as unknown as OpenGLContext;
    return { ctx, mem };
}

/** Write `values` as float32 at guest `ptr`. */
function writeF32(mem: Uint8Array, ptr: number, values: number[]): void {
    const dv = new DataView(mem.buffer, mem.byteOffset);
    for (let i = 0; i < values.length; i++) dv.setFloat32(ptr + i * 4, values[i], true);
}

function vert(dst: Float32Array, i: number): number[] {
    return Array.from(dst.subarray(i * VERT_FLOATS, (i + 1) * VERT_FLOATS));
}

describe("index decode", () => {
    it("reads each width and reports the touched range", () => {
        const { ctx, mem } = makeCtx();
        const dv = new DataView(mem.buffer);
        mem[0x100] = 7; mem[0x101] = 2; mem[0x102] = 9;
        dv.setUint16(0x200, 5, true); dv.setUint16(0x202, 40000, true);
        dv.setUint32(0x300, 123456, true); dv.setUint32(0x304, 3, true);
        const v = guestViews(ctx);

        expect(Array.from(decodeIndices(v, 0x100, GL_UNSIGNED_BYTE, 3)!.subarray(0, 3))).toEqual([7, 2, 9]);
        expect(Array.from(decodeIndices(v, 0x200, GL_UNSIGNED_SHORT, 2)!.subarray(0, 2))).toEqual([5, 40000]);
        expect(Array.from(decodeIndices(v, 0x300, GL_UNSIGNED_INT, 2)!.subarray(0, 2))).toEqual([123456, 3]);
    });

    it("reads a misaligned index pointer through the fallback", () => {
        const { ctx, mem } = makeCtx();
        const dv = new DataView(mem.buffer);
        dv.setUint16(0x201, 4242, true); // odd address: no Uint16Array fast path
        const idx = decodeIndices(guestViews(ctx), 0x201, GL_UNSIGNED_SHORT, 1)!;
        expect(idx[0]).toBe(4242);
    });

    // Real GL raises GL_INVALID_ENUM and draws nothing. A zero-filled scratch would draw
    // `count` copies of vertex 0 — invisible garbage that also pins the CVA range to [0,0].
    it("refuses an index type GL does not define", () => {
        const { ctx } = makeCtx();
        expect(decodeIndices(guestViews(ctx), 0x100, GL_FLOAT, 4)).toBeNull();
    });

    it("raises GL_INVALID_ENUM and draws nothing for a bad glDrawElements type", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [1, 2, 3]);
        const api = createArrayExports(ctx);
        api["glDrawElements"]!({} as any, mem, [GL_TRIANGLES, 3, GL_FLOAT, 0x6000] as any);
        expect(ctx.error).toBe(GL_INVALID_ENUM);
    });
});

describe("draw-range validation", () => {
    it("accepts a draw whose arrays are fully inside guest memory", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [1, 2, 3]);
        sequentialIndices(0, 3);
        expect(validateClientArrayRange(ctx, 0, 2)).toBe(true);
    });

    // Unchecked, the typed-array gather reads undefined -> NaN vertices and the DataView
    // gather throws a RangeError the dispatcher swallows: a silently dropped draw.
    it("rejects an index that walks the position array past the end of guest memory", () => {
        const { ctx, mem } = makeCtx(1 << 12);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 12, pointer: 0xF00, enabled: true };
        expect(validateClientArrayRange(ctx, 0, 0)).toBe(true);
        expect(validateClientArrayRange(ctx, 0, 100000)).toBe(false);
    });

    it("rejects on any enabled array, not just the position one", () => {
        const { ctx, mem } = makeCtx(1 << 12);
        writeF32(mem, 0x100, [1, 0, 0, 2, 0, 0]);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 0, pointer: 0x100, enabled: true };
        ctx.colorArray = { size: 4, type: GL_UNSIGNED_BYTE, stride: 4, pointer: 0xFF0, enabled: true };
        expect(validateClientArrayRange(ctx, 0, 1)).toBe(true);
        expect(validateClientArrayRange(ctx, 0, 64)).toBe(false);
    });

    it("ignores disabled and null-pointer arrays", () => {
        const { ctx } = makeCtx(1 << 12);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 12, pointer: 0xF00, enabled: false };
        ctx.colorArray = { size: 4, type: GL_FLOAT, stride: 16, pointer: 0, enabled: true };
        expect(validateClientArrayRange(ctx, 0, 100000)).toBe(true);
    });

    it("fails the draw loudly instead of emitting NaN geometry", () => {
        const { ctx, mem } = makeCtx(1 << 12);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 12, pointer: 0xF00, enabled: true };
        const api = createArrayExports(ctx);
        api["glDrawArrays"]!({} as any, mem, [GL_TRIANGLES, 0, 6000] as any);
        expect(ctx.error).toBe(GL_INVALID_OPERATION);
    });
});

describe("glInterleavedArrays", () => {
    function interleave(format: number, stride: number, pointer: number) {
        const { ctx, mem } = makeCtx();
        const api = createArrayExports(ctx);
        api["glInterleavedArrays"]!({} as any, mem, [format, stride, pointer] as any);
        return ctx;
    }

    it("sets position only for GL_V3F and disables the rest", () => {
        const ctx = interleave(GL_V3F, 0, 0x1000);
        expect(ctx.vertexArray).toMatchObject({ enabled: true, size: 3, type: GL_FLOAT, stride: 12, pointer: 0x1000 });
        expect(ctx.colorArray.enabled).toBe(false);
        expect(ctx.normalArray.enabled).toBe(false);
        expect(ctx.texCoordArrays[0].enabled).toBe(false);
    });

    it("places the packed colour before the position for GL_C4UB_V3F", () => {
        const ctx = interleave(GL_C4UB_V3F, 0, 0x2000);
        expect(ctx.colorArray).toMatchObject({ enabled: true, size: 4, type: GL_UNSIGNED_BYTE, stride: 16, pointer: 0x2000 });
        expect(ctx.vertexArray).toMatchObject({ enabled: true, size: 3, stride: 16, pointer: 0x2004 });
    });

    it("lays out the widest format at the spec's offsets", () => {
        const ctx = interleave(GL_T4F_C4F_N3F_V4F, 0, 0x100);
        expect(ctx.texCoordArrays[0]).toMatchObject({ enabled: true, size: 4, stride: 60, pointer: 0x100 });
        expect(ctx.colorArray).toMatchObject({ enabled: true, size: 4, type: GL_FLOAT, stride: 60, pointer: 0x110 });
        expect(ctx.normalArray).toMatchObject({ enabled: true, size: 3, stride: 60, pointer: 0x120 });
        expect(ctx.vertexArray).toMatchObject({ enabled: true, size: 4, stride: 60, pointer: 0x12c });
    });

    it("honours an explicit stride over the packed one", () => {
        const ctx = interleave(GL_T2F_V3F, 64, 0x300);
        expect(ctx.texCoordArrays[0].stride).toBe(64);
        expect(ctx.vertexArray.stride).toBe(64);
        expect(ctx.vertexArray.pointer).toBe(0x308);
    });

    it("rejects an unknown format without touching the arrays", () => {
        const ctx = interleave(0x1234, 0, 0x400);
        expect(ctx.error).toBe(GL_INVALID_ENUM);
        expect(ctx.vertexArray.enabled).toBe(false);
    });

    // A gather after it must actually read the packed buffer, not stale state.
    it("makes the following draw read the interleaved buffer", () => {
        const { ctx, mem } = makeCtx();
        writeF32(mem, 0x1000, [0.5, 0.75, 1, 2, 3]); // T2F_V3F: s,t then x,y,z
        const api = createArrayExports(ctx);
        api["glInterleavedArrays"]!({} as any, mem, [GL_T2F_V3F, 0, 0x1000] as any);
        const dst = new Float32Array(VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 1), 1, dst, 0, false);
        expect(vert(dst, 0).slice(0, 4)).toEqual([1, 2, 3, 1]);
        expect(vert(dst, 0).slice(11, 13)).toEqual([0.5, 0.75]);
    });
});

describe("flat gather", () => {
    it("gathers position, colour, normal and both texcoord units by index", () => {
        const { ctx, mem } = makeCtx();
        // Two vertices, position stride 16 (padded, as id Tech 3 does).
        writeF32(mem, 0x1000, [1, 2, 3, 0, /**/ 4, 5, 6, 0]);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 16, pointer: 0x1000, enabled: true };
        // Colours: 4 unsigned bytes per vertex.
        mem.set([0, 51, 102, 255, 255, 204, 153, 0], 0x2000);
        ctx.colorArray = { size: 4, type: GL_UNSIGNED_BYTE, stride: 0, pointer: 0x2000, enabled: true };
        writeF32(mem, 0x3000, [0, 1, 0, /**/ 1, 0, 0]);
        ctx.normalArray = { size: 3, type: GL_FLOAT, stride: 0, pointer: 0x3000, enabled: true };
        writeF32(mem, 0x4000, [0.1, 0.2, /**/ 0.3, 0.4]);
        ctx.texCoordArrays[0] = { size: 2, type: GL_FLOAT, stride: 0, pointer: 0x4000, enabled: true };
        writeF32(mem, 0x5000, [0.5, 0.6, /**/ 0.7, 0.8]);
        ctx.texCoordArrays[1] = { size: 2, type: GL_FLOAT, stride: 0, pointer: 0x5000, enabled: true };

        // Index 1 first, to prove the gather follows the index and not the position.
        new DataView(mem.buffer).setUint32(0x6000, 1, true);
        new DataView(mem.buffer).setUint32(0x6004, 0, true);
        const idx = decodeIndices(guestViews(ctx), 0x6000, GL_UNSIGNED_INT, 2);

        const dst = new Float32Array(2 * VERT_FLOATS);
        expect(gatherVertices(ctx, idx, 2, dst, 0, true)).toBe(VertexSpace.OBJECT);

        const v0 = vert(dst, 0);
        expect(v0.slice(0, 4)).toEqual([4, 5, 6, 1]);
        expect(v0.slice(4, 8).map((c) => Math.round(c * 255))).toEqual([255, 204, 153, 0]);
        expect(v0.slice(8, 11)).toEqual([1, 0, 0]);
        expect(v0[11]).toBeCloseTo(0.3, 6);
        expect(v0[13]).toBeCloseTo(0.7, 6);

        const v1 = vert(dst, 1);
        expect(v1.slice(0, 4)).toEqual([1, 2, 3, 1]);
        expect(v1.slice(4, 8).map((c) => Math.round(c * 255))).toEqual([0, 51, 102, 255]);
    });

    it("substitutes current colour / normal / defaults for disabled arrays", () => {
        const { ctx } = makeCtx();
        const idx = sequentialIndices(0, 1);
        const dst = new Float32Array(VERT_FLOATS);
        gatherVertices(ctx, idx, 1, dst, 0, true);
        expect(vert(dst, 0)).toEqual([
            0, 0, 0, 1,
            0.25, 0.5, 0.75, 1,
            0, 0, 1,
            0, 0, 0, 0,
        ]);
    });

    it("reads non-float and misaligned arrays identically to the aligned fast path", () => {
        const { ctx, mem } = makeCtx();
        const dv = new DataView(mem.buffer);
        // GL_SHORT positions at an ODD address — no typed-array fast path exists.
        dv.setInt16(0x1001, -3, true); dv.setInt16(0x1003, 7, true); dv.setInt16(0x1005, 11, true);
        ctx.vertexArray = { size: 3, type: GL_SHORT, stride: 0, pointer: 0x1001, enabled: true };
        const idx = sequentialIndices(0, 1);
        const dst = new Float32Array(VERT_FLOATS);
        gatherVertices(ctx, idx, 1, dst, 0, true);
        expect(vert(dst, 0).slice(0, 4)).toEqual([-3, 7, 11, 1]);
    });

    it("writes at the requested destination offset without touching earlier vertices", () => {
        const { ctx, mem } = makeCtx();
        writeF32(mem, 0x1000, [9, 9, 9]);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 0, pointer: 0x1000, enabled: true };
        const dst = new Float32Array(3 * VERT_FLOATS).fill(-1);
        const idx = sequentialIndices(0, 1);
        gatherVertices(ctx, idx, 1, dst, 2 * VERT_FLOATS, true);
        expect(dst[0]).toBe(-1);
        expect(vert(dst, 2).slice(0, 4)).toEqual([9, 9, 9, 1]);
    });
});

describe("integer component conversion", () => {
    /** Gather one vertex with `write` having staged the guest bytes and array state. */
    function gatherOne(setup: (ctx: OpenGLContext, dv: DataView, mem: Uint8Array) => void): number[] {
        const { ctx, mem } = makeCtx();
        setup(ctx, new DataView(mem.buffer, mem.byteOffset), mem);
        const dst = new Float32Array(VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 1), 1, dst, 0, false);
        return vert(dst, 0);
    }

    // Colour: every integer type spans [0,1] (unsigned) or [-1,1] (signed) after
    // dividing by the type's largest positive value. Feeding the raw integer through
    // instead makes anything but UNSIGNED_BYTE render blown-out white.
    it("normalises an UNSIGNED_SHORT colour array", () => {
        const v = gatherOne((ctx, dv) => {
            dv.setUint16(0x2000, 65535, true); dv.setUint16(0x2002, 0, true);
            dv.setUint16(0x2004, 32768, true); dv.setUint16(0x2006, 16383, true);
            ctx.colorArray = { size: 4, type: GL_UNSIGNED_SHORT, stride: 0, pointer: 0x2000, enabled: true };
        });
        expect(v[4]).toBe(1);
        expect(v[5]).toBe(0);
        expect(v[6]).toBeCloseTo(0.50001, 4);
        expect(v[7]).toBeCloseTo(16383 / 65535, 6);
    });

    it("normalises a SHORT colour array onto [-1,1]", () => {
        const v = gatherOne((ctx, dv) => {
            dv.setInt16(0x2000, 32767, true); dv.setInt16(0x2002, -32767, true);
            dv.setInt16(0x2004, 0, true); dv.setInt16(0x2006, 16384, true);
            ctx.colorArray = { size: 4, type: GL_SHORT, stride: 0, pointer: 0x2000, enabled: true };
        });
        expect(v[4]).toBe(1);
        expect(v[5]).toBe(-1);
        expect(v[6]).toBe(0);
        expect(v[7]).toBeCloseTo(16384 / 32767, 6);
    });

    it("normalises a BYTE colour array", () => {
        const v = gatherOne((ctx, _dv, mem) => {
            mem.set([127, 0xFF /* -1 */, 0x81 /* -127 */, 0], 0x2000);
            ctx.colorArray = { size: 4, type: GL_BYTE, stride: 0, pointer: 0x2000, enabled: true };
        });
        expect(v[4]).toBe(1);
        expect(v[5]).toBeCloseTo(-1 / 127, 6);
        expect(v[6]).toBe(-1);
        expect(v[7]).toBe(0);
    });

    it("normalises UNSIGNED_INT and INT colour arrays", () => {
        const u = gatherOne((ctx, dv) => {
            dv.setUint32(0x2000, 0xFFFFFFFF, true); dv.setUint32(0x2004, 0, true);
            dv.setUint32(0x2008, 0x80000000, true); dv.setUint32(0x200C, 0xFFFFFFFF, true);
            ctx.colorArray = { size: 4, type: GL_UNSIGNED_INT, stride: 0, pointer: 0x2000, enabled: true };
        });
        expect(u[4]).toBe(1);
        expect(u[5]).toBe(0);
        expect(u[6]).toBeCloseTo(0.5, 6);

        const s = gatherOne((ctx, dv) => {
            dv.setInt32(0x2000, 2147483647, true); dv.setInt32(0x2004, -2147483647, true);
            dv.setInt32(0x2008, 0, true); dv.setInt32(0x200C, 2147483647, true);
            ctx.colorArray = { size: 4, type: GL_INT, stride: 0, pointer: 0x2000, enabled: true };
        });
        expect(s[4]).toBe(1);
        expect(s[5]).toBe(-1);
        expect(s[6]).toBe(0);
    });

    it("passes a FLOAT colour array through unscaled", () => {
        const v = gatherOne((ctx, dv) => {
            for (const [i, c] of [0.25, 2.5, -1.5, 1].entries()) dv.setFloat32(0x2000 + i * 4, c, true);
            ctx.colorArray = { size: 4, type: GL_FLOAT, stride: 0, pointer: 0x2000, enabled: true };
        });
        expect(v.slice(4, 8)).toEqual([0.25, 2.5, -1.5, 1]);
    });

    it("defaults an absent colour component to 1.0, not to a scaled zero", () => {
        const v = gatherOne((ctx, dv) => {
            dv.setUint16(0x2000, 65535, true); dv.setUint16(0x2002, 0, true); dv.setUint16(0x2004, 0, true);
            ctx.colorArray = { size: 3, type: GL_UNSIGNED_SHORT, stride: 0, pointer: 0x2000, enabled: true };
        });
        expect(v[7]).toBe(1);
    });

    // Normals normalise on the same table.
    it("normalises BYTE and SHORT normal arrays", () => {
        const b = gatherOne((ctx, _dv, mem) => {
            mem.set([0, 0x81 /* -127 */, 127], 0x3000);
            ctx.normalArray = { size: 3, type: GL_BYTE, stride: 0, pointer: 0x3000, enabled: true };
        });
        expect(b.slice(8, 11)).toEqual([0, -1, 1]);

        const s = gatherOne((ctx, dv) => {
            dv.setInt16(0x3000, 32767, true); dv.setInt16(0x3002, 0, true); dv.setInt16(0x3004, -32767, true);
            ctx.normalArray = { size: 3, type: GL_SHORT, stride: 0, pointer: 0x3000, enabled: true };
        });
        expect(s.slice(8, 11)).toEqual([1, 0, -1]);
    });

    // Positions and texcoords are coordinates, not normalised quantities: an integer
    // there means literally that integer.
    it("leaves INT positions and SHORT texcoords unnormalised", () => {
        const v = gatherOne((ctx, dv) => {
            dv.setInt32(0x1000, 100, true); dv.setInt32(0x1004, -200, true); dv.setInt32(0x1008, 300, true);
            ctx.vertexArray = { size: 3, type: GL_INT, stride: 0, pointer: 0x1000, enabled: true };
            dv.setInt16(0x4000, 2, true); dv.setInt16(0x4002, -3, true);
            ctx.texCoordArrays[0] = { size: 2, type: GL_SHORT, stride: 0, pointer: 0x4000, enabled: true };
        });
        expect(v.slice(0, 4)).toEqual([100, -200, 300, 1]);
        expect(v.slice(11, 13)).toEqual([2, -3]);
    });

    it("normalises identically through the compiled-vertex-array cache", () => {
        const { ctx, mem } = makeCtx();
        const dv = new DataView(mem.buffer, mem.byteOffset);
        writeF32(mem, 0x1000, [1, 0, 0, 2, 0, 0]);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 0, pointer: 0x1000, enabled: true };
        dv.setUint16(0x2000, 65535, true); dv.setUint16(0x2002, 0, true);
        dv.setUint16(0x2004, 65535, true); dv.setUint16(0x2006, 65535, true);
        ctx.colorArray = { size: 4, type: GL_UNSIGNED_SHORT, stride: 0, pointer: 0x2000, enabled: true };

        const direct = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, direct, 0, true);
        cvaLock(ctx, 0, 2);
        const cached = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, cached, 0, true);

        expect(Array.from(cached.subarray(4, 8))).toEqual([1, 0, 1, 1]);
        expect(Array.from(cached.subarray(4, 8))).toEqual(Array.from(direct.subarray(4, 8)));
    });
});

/** Position array of `n` vertices at 0x1000, tightly packed float3. */
function setupPositions(ctx: OpenGLContext, mem: Uint8Array, xs: number[]): void {
    const vals: number[] = [];
    for (const x of xs) vals.push(x, 0, 0);
    writeF32(mem, 0x1000, vals);
    ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 0, pointer: 0x1000, enabled: true };
}

describe("EXT_compiled_vertex_array cache", () => {
    it("returns clip space under a lock and matches the unlocked object-space gather", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [1, 2, 3, 4]);
        // A projection that is visibly not the identity: x scaled, z offset into w.
        ctx.projectionStack.stack[0].set([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1]);

        const unlocked = new Float32Array(4 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 4), 4, unlocked, 0, true)).toBe(VertexSpace.OBJECT);

        cvaLock(ctx, 0, 4);
        const locked = new Float32Array(4 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 4), 4, locked, 0, true)).toBe(VertexSpace.CLIP);

        for (let i = 0; i < 4; i++) {
            expect(locked[i * VERT_FLOATS]).toBeCloseTo(unlocked[i * VERT_FLOATS] * 2, 5);
            expect(locked[i * VERT_FLOATS + 3]).toBeCloseTo(1, 5); // w = z*1 + w*1, z = 0
        }
    });

    it("serves repeated indices from one gather of the locked range", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [10, 20, 30]);
        cvaLock(ctx, 0, 3);

        const idx = sequentialIndices(0, 3);
        const first = new Float32Array(3 * VERT_FLOATS);
        gatherVertices(ctx, idx, 3, first, 0, true);

        // Second draw over the same lock, indices in a different order.
        const idx2 = sequentialIndices(0, 3);
        idx2[0] = 2; idx2[1] = 0; idx2[2] = 2;
        const second = new Float32Array(3 * VERT_FLOATS);
        expect(gatherVertices(ctx, idx2, 3, second, 0, true)).toBe(VertexSpace.CLIP);
        expect(second[0]).toBe(30);
        expect(second[VERT_FLOATS]).toBe(10);
        expect(second[2 * VERT_FLOATS]).toBe(30);
    });

    it("drops the cache when the array is re-pointed under the lock", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [10, 20]);
        writeF32(mem, 0x2000, [77, 0, 0, 88, 0, 0]);
        cvaLock(ctx, 0, 2);

        const a = new Float32Array(2 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 2), 2, a, 0, true)).toBe(VertexSpace.CLIP);
        expect(a[0]).toBe(10);

        ctx.vertexArray.pointer = 0x2000; // spec violation by the app; must not go stale
        const b = new Float32Array(2 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 2), 2, b, 0, true)).toBe(VertexSpace.OBJECT);
        expect(b[0]).toBe(77);
    });

    it("never caches an array that was disabled when the lock was taken", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [1, 2]);
        mem.set([10, 20, 30, 40, 50, 60, 70, 80], 0x2000);
        ctx.colorArray = { size: 4, type: GL_UNSIGNED_BYTE, stride: 0, pointer: 0x2000, enabled: false };

        // Multipass renderers disable colour/texcoord BEFORE locking precisely because
        // they are about to rewrite those buffers between passes.
        cvaLock(ctx, 0, 2);
        ctx.colorArray.enabled = true;

        const a = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, a, 0, true);
        expect(Math.round(a[4] * 255)).toBe(10);

        mem[0x2000] = 200; // pass 2 rewrites the colour buffer in place
        const b = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, b, 0, true);
        expect(Math.round(b[4] * 255)).toBe(200);
    });

    it("caches an array that WAS enabled at lock time", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [1, 2]);
        mem.set([10, 20, 30, 40, 50, 60, 70, 80], 0x2000);
        ctx.colorArray = { size: 4, type: GL_UNSIGNED_BYTE, stride: 0, pointer: 0x2000, enabled: true };
        cvaLock(ctx, 0, 2);

        const a = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, a, 0, true);
        expect(Math.round(a[4] * 255)).toBe(10);

        // Locked data the app promised not to touch: the cache is what the promise buys.
        mem[0x2000] = 200;
        const b = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, b, 0, true);
        expect(Math.round(b[4] * 255)).toBe(10);

        cvaUnlock(ctx);
        const c = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, c, 0, true);
        expect(Math.round(c[4] * 255)).toBe(200);
    });

    it("re-transforms cached positions when the matrices change under the lock", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [3, 4]);
        cvaLock(ctx, 0, 2);

        const a = new Float32Array(2 * VERT_FLOATS);
        gatherVertices(ctx, sequentialIndices(0, 2), 2, a, 0, true);
        expect(a[0]).toBe(3);

        ctx.modelviewStack.stack[0].set([5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const b = new Float32Array(2 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 2), 2, b, 0, true)).toBe(VertexSpace.CLIP);
        expect(b[0]).toBe(15);
    });

    it("falls back to the direct gather for indices outside the locked range", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [1, 2, 3, 4]);
        cvaLock(ctx, 0, 2);
        const dst = new Float32Array(4 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 4), 4, dst, 0, true)).toBe(VertexSpace.OBJECT);
        expect(dst[3 * VERT_FLOATS]).toBe(4);
    });

    it("keeps positions in object space when texgen needs them", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [1, 2]);
        ctx.projectionStack.stack[0].set([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        ctx.enableFlags.add(0x0C60); // GL_TEXTURE_GEN_S
        cvaLock(ctx, 0, 2);
        const dst = new Float32Array(2 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 2), 2, dst, 0, true)).toBe(VertexSpace.OBJECT);
        expect(dst[0]).toBe(1);
    });

    it("keeps glArrayElement in object space even under a lock", () => {
        const { ctx, mem } = makeCtx();
        setupPositions(ctx, mem, [6]);
        ctx.projectionStack.stack[0].set([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        cvaLock(ctx, 0, 1);
        const dst = new Float32Array(VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 1), 1, dst, 0, false)).toBe(VertexSpace.OBJECT);
        expect(dst[0]).toBe(6);
    });
});
