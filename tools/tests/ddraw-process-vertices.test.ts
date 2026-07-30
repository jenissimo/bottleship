/**
 * IDirect3DVertexBuffer::ProcessVertices — the transform + viewport mapping, checked against
 * Wine's ddraw conformance test (dlls/ddraw/tests/ddraw4.c, test_process_vertices), which is
 * itself calibrated on real DirectX. The vectors below are that test's expected outputs.
 *
 * They pin the two things that are easy to get wrong and invisible until a title looks wrong:
 *  - a D3DVIEWPORT's clipping volume / dvScale / dvMinZ..dvMaxZ remap CLIP SPACE; the
 *    rasterizer's own depth range stays [0,1],
 *  - D3DVIEWPORT (v1) and D3DVIEWPORT2 derive that remap by different formulas.
 */
import { describe, expect, test } from "bun:test";
import { processVertices, D3DVOP_TRANSFORM } from "../../src/worker/modules/ddraw/d3d/process-vertices";

const D3DFVF_XYZ = 0x002;
const D3DFVF_XYZRHW = 0x004;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** The test's `projection`: a pure translation by (6, 7, 8) in D3D row-vector layout. */
const TRANSLATE_678 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 6, 7, 8, 1]);

/** ddraw viewport_activate, VERSION_2 branch. */
function clipSpaceFromViewport2(clipX: number, clipY: number, clipW: number, clipH: number, minZ: number, maxZ: number) {
    const dz = maxZ - minZ;
    return {
        sx: 2 / clipW, sy: 2 / clipH, sz: 1 / dz,
        ox: (-2 * clipX) / clipW - 1, oy: (-2 * clipY) / clipH + 1, oz: -minZ / dz,
    };
}
/** ddraw viewport_activate, VERSION_1 branch — dvMinZ/dvMaxZ do not participate. */
function clipSpaceFromViewport1(scaleX: number, scaleY: number, width: number, height: number) {
    return { sx: (2 * scaleX) / width, sy: (2 * scaleY) / height, sz: 1, ox: 0, oy: 0, oz: 0 };
}

const SRC = [
    [-1, -1, -1],
    [0, 0, 0],
    [1, 1, 1],
];

function run(mvp: Float32Array, vp: { x: number; y: number; width: number; height: number },
             clipSpace: { sx: number; sy: number; sz: number; ox: number; oy: number; oz: number }) {
    const mem = new Uint8Array(4096);
    const view = new DataView(mem.buffer);
    const srcAddr = 256;
    const dstAddr = 1024;
    for (let i = 0; i < SRC.length; i++) {
        view.setFloat32(srcAddr + i * 12 + 0, SRC[i]![0]!, true);
        view.setFloat32(srcAddr + i * 12 + 4, SRC[i]![1]!, true);
        view.setFloat32(srcAddr + i * 12 + 8, SRC[i]![2]!, true);
    }
    const hr = processVertices(mem, {
        vertexOp: D3DVOP_TRANSFORM,
        destIndex: 0, srcIndex: 0, count: 3,
        dstAddr, dstFvf: D3DFVF_XYZRHW, dstStride: 16, dstNumVertices: 3,
        srcAddr, srcFvf: D3DFVF_XYZ, srcStride: 12, srcNumVertices: 3,
        mvp,
        // The rasterizer depth range is always [0,1]; the viewport's own z values live in clipSpace.
        viewport: { ...vp, minZ: 0, maxZ: 1 },
        clipSpace,
        lightingRenderState: false, legacyV3: true, hasMaterial: false,
        materialDiffuseArgb: 0xffffffff, materialSpecularArgb: 0,
    });
    expect(hr).toBe(0);
    return SRC.map((_, i) => [
        view.getFloat32(dstAddr + i * 16 + 0, true),
        view.getFloat32(dstAddr + i * 16 + 4, true),
        view.getFloat32(dstAddr + i * 16 + 8, true),
        view.getFloat32(dstAddr + i * 16 + 12, true),
    ]);
}

function expectClose(got: number[][], want: number[][]) {
    for (let i = 0; i < want.length; i++) {
        for (let c = 0; c < 4; c++) {
            expect(got[i]![c]!).toBeCloseTo(want[i]![c]!, 4);
        }
    }
}

describe("ProcessVertices (Wine ddraw4 test_process_vertices vectors)", () => {
    const vp2a = { x: 10, y: 20, width: 100, height: 200 };
    const cs2a = clipSpaceFromViewport2(2, 3, 4, 5, -2, 3);

    test("identity transform, D3DVIEWPORT2 clip volume 2/3/4/5 z -2..3", () => {
        expectClose(run(IDENTITY, vp2a, cs2a), [
            [-65, 180, 0.2, 1],
            [-40, 140, 0.4, 1],
            [-15, 100, 0.6, 1],
        ]);
    });

    test("projection translate(6,7,8), same viewport", () => {
        expectClose(run(TRANSLATE_678, vp2a, cs2a), [
            [85, -100, 1.8, 1],
            [110, -140, 2.0, 1],
            [135, -180, 2.2, 1],
        ]);
    });

    test("D3DVIEWPORT2 with an INVERTED z range (dvMinZ 3 > dvMaxZ -2)", () => {
        expectClose(
            run(TRANSLATE_678, { x: 30, y: 40, width: 90, height: 80 }, clipSpaceFromViewport2(4, 6, 2, 4, 3, -2)),
            [
                [75, 40, -0.8, 1],
                [120, 20, -1.0, 1],
                [165, 0, -1.2, 1],
            ],
        );
    });

    test("D3DVIEWPORT (v1): dvScaleX/Y drive the remap, dvMinZ/dvMaxZ are ignored", () => {
        expectClose(
            run(TRANSLATE_678, { x: 30, y: 40, width: 90, height: 80 }, clipSpaceFromViewport1(7, 2, 90, 80)),
            [
                [110, 68, 7, 1],
                [117, 66, 8, 1],
                [124, 64, 9, 1],
            ],
        );
    });

    test("D3DVOP_TRANSFORM is mandatory", () => {
        const mem = new Uint8Array(4096);
        const hr = processVertices(mem, {
            vertexOp: 0, destIndex: 0, srcIndex: 0, count: 3,
            dstAddr: 1024, dstFvf: D3DFVF_XYZRHW, dstStride: 16, dstNumVertices: 3,
            srcAddr: 256, srcFvf: D3DFVF_XYZ, srcStride: 12, srcNumVertices: 3,
            mvp: IDENTITY, viewport: { x: 0, y: 0, width: 100, height: 100, minZ: 0, maxZ: 1 },
            clipSpace: { sx: 1, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 },
            lightingRenderState: false, legacyV3: true, hasMaterial: false,
            materialDiffuseArgb: 0, materialSpecularArgb: 0,
        });
        expect(hr).toBe(0x80070057); // DDERR_INVALIDPARAMS
    });

    test("out-of-range source/destination index ranges are rejected", () => {
        const mem = new Uint8Array(4096);
        const base = {
            vertexOp: D3DVOP_TRANSFORM, srcIndex: 0, count: 3,
            dstAddr: 1024, dstFvf: D3DFVF_XYZRHW, dstStride: 16, dstNumVertices: 3,
            srcAddr: 256, srcFvf: D3DFVF_XYZ, srcStride: 12, srcNumVertices: 3,
            mvp: IDENTITY, viewport: { x: 0, y: 0, width: 100, height: 100, minZ: 0, maxZ: 1 },
            clipSpace: { sx: 1, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 },
            lightingRenderState: false, legacyV3: true, hasMaterial: false,
            materialDiffuseArgb: 0, materialSpecularArgb: 0,
        };
        expect(processVertices(mem, { ...base, destIndex: 1 })).toBe(0x80070057);
        expect(processVertices(mem, { ...base, destIndex: 0, srcIndex: 2 })).toBe(0x80070057);
    });
});
