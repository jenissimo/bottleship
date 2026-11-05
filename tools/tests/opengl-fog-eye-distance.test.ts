import { describe, expect, it } from "bun:test";
import { transformFlatVerts } from "../../src/worker/modules/opengl32/immediate";
import { gatherVertices, sequentialIndices, cvaLock, createCvaState, VertexSpace } from "../../src/worker/modules/opengl32/client-arrays";
import { VERT_FLOATS, VERT_FOG_DIST, mat4Identity, type OpenGLContext } from "../../src/worker/modules/opengl32/context";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { probeOfflineWgslValidator, validateWgslOffline } from "../d3d9-parity/wgsl-validator";

const GL_FOG = 0x0B60;
const GL_FLOAT = 0x1406;

function makeCtx(mv: number[], proj: number[]) {
    const mem = new Uint8Array(1 << 16);
    const m = new Float32Array(mv), p = new Float32Array(proj);
    const ident = new Float32Array(16); mat4Identity(ident);
    const ctx = {
        process: { getCurrentMemory: () => mem },
        vertexArray: { size: 3, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false },
        colorArray: { size: 4, type: 0x1401, stride: 0, pointer: 0, enabled: false },
        normalArray: { size: 3, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false },
        texCoordArrays: [
            { size: 2, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false },
            { size: 2, type: GL_FLOAT, stride: 0, pointer: 0, enabled: false },
        ],
        currentColor: new Float32Array([1, 1, 1, 1]),
        currentNormal: new Float32Array([0, 0, 1]),
        currentTexCoord: [new Float32Array(4), new Float32Array(4)],
        clientActiveTextureUnit: 0,
        enableFlags: new Set<number>(),
        cva: createCvaState(),
        modelviewStack: { stack: [m], top: 0, maxDepth: 32 },
        projectionStack: { stack: [p], top: 0, maxDepth: 32 },
        viewportX: 0, viewportY: 0, viewportW: 640, viewportH: 480,
        error: 0,
    } as unknown as OpenGLContext;
    return { ctx, mem };
}

const ORTHO_MV = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.1, 0, 0, 0, 0, 1];
const PERSPECTIVE = [1.81, 0, 0, 0, 0, 2.41, 0, 0, 0, 0, -1.0057, -1, 0, 0, -0.4011, 0];

function flatVert(buf: Float32Array, i: number, x: number, y: number, z: number): void {
    const b = i * VERT_FLOATS;
    buf[b] = x; buf[b + 1] = y; buf[b + 2] = z; buf[b + 3] = 1;
    buf[b + 8] = 0.25; buf[b + 9] = 0.5; buf[b + 10] = 0.75;
}

describe("GL fog distance is eye-space |z_e|", () => {
    it("the transform records |z_e| from the modelview, not the projected depth", () => {
        const { ctx } = makeCtx(ORTHO_MV, PERSPECTIVE);
        ctx.enableFlags.add(GL_FOG);
        const buf = new Float32Array(3 * VERT_FLOATS);
        flatVert(buf, 0, 0, 0, -10);
        flatVert(buf, 1, 3, 4, -300);
        flatVert(buf, 2, 0, 0, 25);
        transformFlatVerts(ctx, buf, 0, 3);
        expect(buf[VERT_FOG_DIST]).toBeCloseTo(1, 5);
        expect(buf[VERT_FLOATS + VERT_FOG_DIST]).toBeCloseTo(30, 4);
        expect(buf[2 * VERT_FLOATS + VERT_FOG_DIST]).toBeCloseTo(2.5, 5);
        expect(buf[3]).toBeCloseTo(-1, 5);
    });

    it("with fog off the slot is left alone", () => {
        const { ctx } = makeCtx(ORTHO_MV, PERSPECTIVE);
        const buf = new Float32Array(VERT_FLOATS);
        flatVert(buf, 0, 0, 0, -10);
        transformFlatVerts(ctx, buf, 0, 1);
        expect(buf[VERT_FOG_DIST]).toBe(0.25);
    });

    it("a compiled-vertex-array lock does not hand fogged draws pre-transformed positions", () => {
        const { ctx, mem } = makeCtx(ORTHO_MV, PERSPECTIVE);
        const dv = new DataView(mem.buffer);
        for (let i = 0; i < 9; i++) dv.setFloat32(0x1000 + i * 4, i, true);
        ctx.vertexArray = { size: 3, type: GL_FLOAT, stride: 0, pointer: 0x1000, enabled: true };
        cvaLock(ctx, 0, 3);
        const out = new Float32Array(3 * VERT_FLOATS);
        expect(gatherVertices(ctx, sequentialIndices(0, 3), 3, out, 0, true)).toBe(VertexSpace.CLIP);
        ctx.enableFlags.add(GL_FOG);
        expect(gatherVertices(ctx, sequentialIndices(0, 3), 3, out, 0, true)).toBe(VertexSpace.OBJECT);
    });

    it("the shader fogs by the per-vertex distance with GL's signed linear range", () => {
        const wgsl = (OpenGLBackendExecutor.prototype as unknown as { buildShaderCode(): string })
            .buildShaderCode.call(null);
        expect(wgsl).toContain("@location(4) fogDist: f32");
        expect(wgsl).toContain("out.fogCoord = input.fogDist;");
        expect(wgsl).toContain("let range = end - start;");
        expect(wgsl).not.toContain("max(end - start");
        const validator = probeOfflineWgslValidator();
        if (validator.available) {
            const result = validateWgslOffline(wgsl, validator);
            expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
        }
    });
});
