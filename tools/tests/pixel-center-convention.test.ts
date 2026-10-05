/**
 * The legacy-D3D pixel-centre convention, pinned on BOTH fixed-function paths.
 *
 * D3D <= 9 puts pixel centres on INTEGER screen coordinates, WebGPU on half-integers
 * (Wine dlls/wined3d/glsl_shader.c get_projection_matrix; DXVK biases the whole viewport
 * by cf = 0.5 in d3d9_device.cpp BindViewportAndScissor). The pre-transformed (XYZRHW)
 * converter has always carried that +0.5; transformed geometry (XYZ → MVP in the vertex
 * shader) carried nothing, so a UI drawn as transformed quads landed on exact pixel
 * boundaries and the fill rule decided its baseline.
 *
 * These tests state the fix as an EQUIVALENCE: for the same screen-space point, the two
 * paths must produce the same NDC. The pre-transformed side is the real shipping code
 * (VertexConverter.convertCPU), not a re-derivation of its formula.
 */
import { describe, expect, test, afterEach } from "bun:test";
// Prime the module graph: ddraw/constants participates in an import cycle through
// core/com/com-memory → … → d3d/types (which reads constants at module scope).
import "../../src/worker/modules/ddraw/d3d/types";
import {
    D3D_PIXEL_CENTER_OFFSET_PX,
    pixelCenterOffsetPx,
    writeMvpWithPixelCenter,
} from "../../src/worker/backends/webgpu/pixel-center";
import { VertexConverter } from "../../src/worker/backends/webgpu/ddraw/compute/vertex-converter";
import {
    packFfpUniforms,
    FFP_UNIFORM_FLOATS,
    FFP_MAX_TEX_MATRICES,
    type FfpUniformParams,
} from "../../src/worker/backends/webgpu/d3d9/ffp-lighting";
import { D3DFVF_XYZRHW, D3DFVF_DIFFUSE } from "../../src/worker/modules/ddraw/constants";

// The convention is the DEFAULT; the flag is a kill-switch, so `setFlag(true)` here means
// "convention on" = flag absent, and `setFlag(false)` means "restore the old behaviour".
const KILL_SWITCH = "__d3dNoPixelCentre";
const setFlag = (on: boolean) => {
    if (on) delete (globalThis as Record<string, unknown>)[KILL_SWITCH];
    else (globalThis as Record<string, unknown>)[KILL_SWITCH] = true;
};
afterEach(() => delete (globalThis as Record<string, unknown>)[KILL_SWITCH]);

const VP_W = 640;
const VP_H = 480;

/** Identity-ish stand-ins for the GPU objects VertexConverter's constructor touches. */
function makeConverter(): VertexConverter {
    (globalThis as Record<string, unknown>).GPUShaderStage ??= { COMPUTE: 4 };
    const device = {
        limits: { maxBufferSize: 1 << 20 },
        createBindGroupLayout: () => ({}),
    } as unknown as GPUDevice;
    return new VertexConverter(device, {} as GPUQueue);
}

/**
 * The pre-transformed path: one XYZRHW|DIFFUSE vertex at (x, y) with rhw = 1 (so clip == NDC),
 * through the shipping CPU converter. Returns [ndcX, ndcY].
 */
function rhwNdc(x: number, y: number): [number, number] {
    const fvf = D3DFVF_XYZRHW | D3DFVF_DIFFUSE; // 16 + 4 = 20-byte stride
    const src = new Float32Array([x, y, 0, 1, 0]);
    const memory = new Uint8Array(src.buffer);
    const out = makeConverter().convertCPU(memory, 0, 1, fvf, undefined, VP_W, VP_H, 20, null, 0, 0);
    const f = new Float32Array(out.buffer, out.byteOffset, 16);
    return [f[0] / f[3], f[1] / f[3]];
}

/**
 * The transformed path: the same screen point through an app-style 2D projection
 * (screen pixels → NDC, D3D row-major / row-vector), with whatever the uniform writers
 * would have folded into the matrix. Returns [ndcX, ndcY].
 */
function transformedNdc(x: number, y: number): [number, number] {
    const ortho = new Float32Array([
        2 / VP_W, 0, 0, 0,
        0, -2 / VP_H, 0, 0,
        0, 0, 1, 0,
        -1, 1, 0, 1,
    ]);
    const m = new Float32Array(16);
    writeMvpWithPixelCenter(m, 0, ortho, VP_W, VP_H);
    // clip = (x, y, 0, 1) · m  (row vector × D3D row-major matrix)
    const cx = x * m[0] + y * m[4] + m[12];
    const cy = x * m[1] + y * m[5] + m[13];
    const cw = x * m[3] + y * m[7] + m[15];
    return [cx / cw, cy / cw];
}

describe("D3D pixel-centre convention", () => {
    test("kill-switch restores the raw matrix byte for byte", () => {
        setFlag(false);
        expect(pixelCenterOffsetPx()).toBe(0);
        const src = Float32Array.from({ length: 16 }, (_u, i) => i + 1);
        const dst = new Float32Array(20).fill(-1);
        writeMvpWithPixelCenter(dst, 4, src, VP_W, VP_H);
        expect(Array.from(dst.subarray(4, 20))).toEqual(Array.from(src));
        expect(dst[0]).toBe(-1); // wrote only at the requested offset
    });

    test("the convention is the default — no flag needed", () => {
        expect(pixelCenterOffsetPx()).toBe(D3D_PIXEL_CENTER_OFFSET_PX);
    });

    test("kill-switch ON: the two paths disagree by exactly half a pixel — the bug", () => {
        setFlag(false);
        const [rx, ry] = rhwNdc(100, 50);
        const [tx, ty] = transformedNdc(100, 50);
        // Half a pixel is 1/vp NDC units; the RHW path is the one already shifted.
        // (Loose to 1e-7: the converter rounds to f32 at every step, on purpose.)
        expect(rx - tx).toBeCloseTo(1 / VP_W, 7);
        expect(ry - ty).toBeCloseTo(-1 / VP_H, 7);
    });

    test("ON: transformed and pre-transformed geometry land on the same NDC", () => {
        setFlag(true);
        // Corners and interior of a screen-space quad, plus an odd/exact-boundary point.
        for (const [x, y] of [[0, 0], [640, 480], [100.5, 50.5], [123, 456], [1, 479]]) {
            const [rx, ry] = rhwNdc(x, y);
            const [tx, ty] = transformedNdc(x, y);
            expect(tx).toBeCloseTo(rx, 6);
            expect(ty).toBeCloseTo(ry, 6);
        }
    });

    test("ON: the shift is a clip-space delta of w·(+1/vpW, -1/vpH) for ANY matrix", () => {
        setFlag(true);
        // A perspective-style matrix: w_clip varies per vertex, so the offset must scale
        // with w or it would be a different number of pixels at different depths.
        const proj = new Float32Array([
            1.3, 0, 0, 0,
            0, 1.8, 0, 0,
            0.1, -0.2, 1.001, 1,
            0, 0, -1.001, 0,
        ]);
        const shifted = new Float32Array(16);
        writeMvpWithPixelCenter(shifted, 0, proj, VP_W, VP_H);

        const apply = (m: Float32Array, v: number[]) => [0, 1, 2, 3].map(
            (c) => v[0] * m[c] + v[1] * m[4 + c] + v[2] * m[8 + c] + v[3] * m[12 + c]);

        for (const v of [[1, 2, 3, 1], [-40, 12, 900, 1], [0, 0, 5, 1]]) {
            const base = apply(proj, v);
            const got = apply(shifted, v);
            expect(got[0]).toBeCloseTo(base[0] + base[3] * (2 * 0.5 / VP_W), 5);
            expect(got[1]).toBeCloseTo(base[1] - base[3] * (2 * 0.5 / VP_H), 5);
            expect(got[2]).toBeCloseTo(base[2], 6); // depth untouched
            expect(got[3]).toBeCloseTo(base[3], 6);
        }
    });

    test("a degenerate viewport contributes no offset (never an infinity)", () => {
        setFlag(true);
        const src = Float32Array.from({ length: 16 }, (_u, i) => i + 1);
        const dst = new Float32Array(16);
        writeMvpWithPixelCenter(dst, 0, src, 0, 0);
        expect(Array.from(dst)).toEqual(Array.from(src));
    });

    test("the D3D9 FFP uniform block carries the same convention on both paths", () => {
        const p = d3d9Params();
        setFlag(false);
        const off = new Float32Array(FFP_UNIFORM_FLOATS);
        packFfpUniforms(off, p);
        // viewport.z is what the shader's pre-transformed branch adds, in pixels.
        expect(off[2]).toBe(0);
        expect(off[4]).toBe(p.mvp[0]); // mvp @4, unshifted

        setFlag(true);
        const on = new Float32Array(FFP_UNIFORM_FLOATS);
        packFfpUniforms(on, p);
        expect(on[2]).toBe(D3D_PIXEL_CENTER_OFFSET_PX);
        // Row 3 is the row with w = 1 in this projection, so it is the one that moves.
        expect(on[4 + 12]).toBeCloseTo(p.mvp[12] + 2 * 0.5 / p.viewportW, 6);
        expect(on[4 + 13]).toBeCloseTo(p.mvp[13] - 2 * 0.5 / p.viewportH, 6);
        // The packer must not have mutated the caller's cached matrix.
        expect(p.mvp[12]).toBe(-1);
    });
});

/** Minimal FFP params: only the viewport + mvp matter here, the rest just has to be present. */
function d3d9Params(): FfpUniformParams {
    const identity = () => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const black = { r: 0, g: 0, b: 0, a: 0 };
    return {
        viewportW: VP_W, viewportH: VP_H,
        mvp: Float32Array.from([
            2 / VP_W, 0, 0, 0,
            0, -2 / VP_H, 0, 0,
            0, 0, 1, 0,
            -1, 1, 0, 1,
        ]),
        worldView: identity(), normalMatrix: identity(), view: identity(), world: identity(),
        clipPlanes: new Float32Array(24), clipPlaneEnable: 0,
        material: { diffuse: black, ambient: black, specular: black, emissive: black, power: 0 },
        globalAmbient: black,
        lightingEnabled: false, specularEnable: false, localViewer: false,
        diffuseSrc: 0, ambientSrc: 0, specularSrc: 0, emissiveSrc: 0,
        hasNormal: false, normalizeNormals: false,
        lights: [],
        stages: [],
        texMatrices: new Float32Array(FFP_MAX_TEX_MATRICES * 16),
        tfactor: black, fogColor: black,
        fogStart: 0, fogEnd: 1, fogDensity: 0, fogMode: 0,
    };
}
