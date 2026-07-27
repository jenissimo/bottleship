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
    cvaLock, cvaUnlock, createCvaState, VertexSpace,
} from "../../src/worker/modules/opengl32/client-arrays";
import { VERT_FLOATS, mat4Identity, type OpenGLContext } from "../../src/worker/modules/opengl32/context";

const GL_FLOAT = 0x1406;
const GL_SHORT = 0x1402;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_UNSIGNED_SHORT = 0x1403;
const GL_UNSIGNED_INT = 0x1405;

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
        enableFlags: new Set<number>(),
        cva: createCvaState(),
        modelviewStack: stack(ident),
        projectionStack: stack(ident2),
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

        expect(Array.from(decodeIndices(v, 0x100, GL_UNSIGNED_BYTE, 3).subarray(0, 3))).toEqual([7, 2, 9]);
        expect(Array.from(decodeIndices(v, 0x200, GL_UNSIGNED_SHORT, 2).subarray(0, 2))).toEqual([5, 40000]);
        expect(Array.from(decodeIndices(v, 0x300, GL_UNSIGNED_INT, 2).subarray(0, 2))).toEqual([123456, 3]);
    });

    it("reads a misaligned index pointer through the fallback", () => {
        const { ctx, mem } = makeCtx();
        const dv = new DataView(mem.buffer);
        dv.setUint16(0x201, 4242, true); // odd address: no Uint16Array fast path
        const idx = decodeIndices(guestViews(ctx), 0x201, GL_UNSIGNED_SHORT, 1);
        expect(idx[0]).toBe(4242);
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
