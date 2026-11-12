/**
 * IDirect3DViewport::TransformVertices — the screen-space answer an app sizes its own 2D work
 * by. The Longest Journey transforms the 8 corners of each actor's bounding box with
 * D3DTRANSFORM_UNCLIPPED every frame and restores the background inside the resulting
 * rectangle; when this was a stub that wrote nothing, the rect came from stale corners and
 * the actors' heads left trails.
 *
 * Mapping and clip rules follow Wine's d3d_viewport_TransformVertices (dlls/ddraw/viewport.c).
 */
import { describe, expect, test } from "bun:test";
import {
    transformVertices, D3DTRANSFORM_CLIPPED, D3DTRANSFORM_UNCLIPPED, D3DTRANSFORMDATA_SIZE,
    D3DCLIP_LEFT, D3DCLIP_RIGHT, D3DCLIP_TOP, D3DCLIP_FRONT,
} from "../../src/worker/modules/ddraw/d3d/transform-vertices";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const IDENTITY_CS = { sx: 1, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 };
const VP = { x: 0, y: 0, width: 640, height: 480 };

const DATA = 64, IN = 256, OUT = 1024, HOUT = 2048, OFFSCREEN = 3000;
const STRIDE = 32; // D3DLVERTEX / D3DTLVERTEX

function setup(points: number[][], opts: { garbage?: boolean } = {}) {
    const mem = new Uint8Array(4096);
    const view = new DataView(mem.buffer);
    if (opts.garbage) mem.fill(0xcd);
    for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        view.setFloat32(IN + i * STRIDE + 0, p[0]!, true);
        view.setFloat32(IN + i * STRIDE + 4, p[1]!, true);
        view.setFloat32(IN + i * STRIDE + 8, p[2]!, true);
        view.setUint32(IN + i * STRIDE + 12, 0, true);
        // payload: colour, specular, tu, tv
        view.setUint32(IN + i * STRIDE + 16, 0xff102030 + i, true);
        view.setUint32(IN + i * STRIDE + 20, 0x11223344, true);
        view.setFloat32(IN + i * STRIDE + 24, 0.25, true);
        view.setFloat32(IN + i * STRIDE + 28, 0.75, true);
    }
    view.setUint32(DATA + 0, D3DTRANSFORMDATA_SIZE, true);
    view.setUint32(DATA + 4, IN, true);
    view.setUint32(DATA + 8, STRIDE, true);
    view.setUint32(DATA + 12, OUT, true);
    view.setUint32(DATA + 16, STRIDE, true);
    view.setUint32(DATA + 20, HOUT, true);
    view.setUint32(DATA + 24, 0x3f, true);
    return { mem, view };
}

const out = (view: DataView, i: number) =>
    [0, 4, 8, 12].map((o) => view.getFloat32(OUT + i * STRIDE + o, true));

describe("IDirect3DViewport::TransformVertices", () => {
    test("UNCLIPPED maps through the viewport and writes every corner of a bounding box", () => {
        const corners: number[][] = [];
        for (const x of [-0.5, 0.5]) for (const y of [-0.25, 0.75]) for (const z of [0.1, 0.9]) corners.push([x, y, z]);
        const { mem, view } = setup(corners, { garbage: false });
        // Stale lpOut: the stub used to leave exactly this behind.
        for (let i = 0; i < 8; i++) view.setFloat32(OUT + i * STRIDE, -12345, true);
        view.setUint32(OFFSCREEN, 0xdead, true);

        const hr = transformVertices(mem, 8, DATA, D3DTRANSFORM_UNCLIPPED, OFFSCREEN,
            { mvp: IDENTITY, viewport: VP, clipSpace: IDENTITY_CS });
        expect(hr).toBe(0);
        for (let i = 0; i < 8; i++) {
            const [x, y, z] = corners[i]!;
            const [sx, sy, sz, rhw] = out(view, i);
            expect(sx).toBeCloseTo((x! + 1) * 320, 4);
            expect(sy).toBeCloseTo((1 - y!) * 240, 4);
            expect(sz).toBeCloseTo(z!, 6);
            expect(rhw).toBe(1);
            // payload follows the position
            expect(view.getUint32(OUT + i * STRIDE + 16, true)).toBe(0xff102030 + i);
            expect(view.getFloat32(OUT + i * STRIDE + 28, true)).toBe(0.75);
        }
        // UNCLIPPED: no clip information, nothing offscreen, extents are the screen rect.
        expect(view.getUint32(DATA + 28, true)).toBe(0);
        expect(view.getUint32(DATA + 32, true)).toBe(0);
        expect(view.getUint32(OFFSCREEN, true)).toBe(0);
        expect([36, 40, 44, 48].map((o) => view.getInt32(DATA + o, true))).toEqual([160, 60, 480, 300]);
        // lpHOut untouched in UNCLIPPED mode
        expect(view.getUint32(HOUT, true)).toBe(0);
    });

    test("viewport offset, perspective divide and the clip-space remap", () => {
        const { mem, view } = setup([[1, 1, 2]]);
        // w = z (a perspective-like matrix): clip (1,1,2,2) → ndc (0.5,0.5,1)
        const persp = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
        const vp = { x: 10, y: 20, width: 200, height: 100 };
        expect(transformVertices(mem, 1, DATA, D3DTRANSFORM_UNCLIPPED, 0, { mvp: persp, viewport: vp, clipSpace: IDENTITY_CS })).toBe(0);
        const [sx, sy, sz, rhw] = out(view, 0);
        expect(sx).toBeCloseTo(10 + 1.5 * 100, 4);
        expect(sy).toBeCloseTo(20 + 0.5 * 50, 4);
        expect(sz).toBeCloseTo(1, 6);
        expect(rhw).toBeCloseTo(0.5, 6);

        // D3DVIEWPORT2 clip volume x -2..2: half the default scale.
        const { mem: m2, view: v2 } = setup([[1, 0, 0.5]]);
        const cs = { sx: 0.5, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 };
        expect(transformVertices(m2, 1, DATA, D3DTRANSFORM_UNCLIPPED, 0, { mvp: IDENTITY, viewport: VP, clipSpace: cs })).toBe(0);
        expect(out(v2, 0)[0]).toBeCloseTo(1.5 * 320, 4);
    });

    test("CLIPPED: per-vertex flags, raw clip coords for clipped vertices, AND/OR and offscreen", () => {
        const { mem, view } = setup([[0, 0, 0.5], [2, 0, 0.5], [-3, 2, -1]]);
        expect(transformVertices(mem, 3, DATA, D3DTRANSFORM_CLIPPED, OFFSCREEN,
            { mvp: IDENTITY, viewport: VP, clipSpace: IDENTITY_CS })).toBe(0);
        const flags = [0, 1, 2].map((i) => view.getUint32(HOUT + i * 16, true));
        expect(flags).toEqual([0, D3DCLIP_RIGHT, D3DCLIP_LEFT | D3DCLIP_TOP | D3DCLIP_FRONT]);
        // hx/hy/hz are the clip-space position
        expect(view.getFloat32(HOUT + 16 + 4, true)).toBe(2);
        // visible vertex mapped, clipped vertex left in clip space without its payload
        expect(out(view, 0).slice(0, 2)).toEqual([320, 240]);
        expect(out(view, 1)).toEqual([2, 0, 0.5, 1]);
        expect(view.getUint32(OUT + STRIDE + 16, true)).toBe(0);
        expect(view.getUint32(DATA + 28, true)).toBe(0); // intersection
        expect(view.getUint32(DATA + 32, true)).toBe(D3DCLIP_LEFT | D3DCLIP_RIGHT | D3DCLIP_TOP | D3DCLIP_FRONT);
        expect(view.getUint32(OFFSCREEN, true)).toBe(0);
        // extents cover only the vertices that were mapped to the screen
        expect([36, 40, 44, 48].map((o) => view.getInt32(DATA + o, true))).toEqual([320, 240, 320, 240]);
    });

    test("CLIPPED: a set wholly off one plane reports that plane as offscreen", () => {
        const { mem, view } = setup([[2, 0, 0.5], [3, 0.5, 0.5]]);
        expect(transformVertices(mem, 2, DATA, D3DTRANSFORM_CLIPPED, OFFSCREEN,
            { mvp: IDENTITY, viewport: VP, clipSpace: IDENTITY_CS })).toBe(0);
        expect(view.getUint32(OFFSCREEN, true)).toBe(D3DCLIP_RIGHT);
        expect(view.getUint32(DATA + 28, true)).toBe(D3DCLIP_RIGHT);
    });

    test("rejects a bad dwSize and a missing transform mode", () => {
        const { mem, view } = setup([[0, 0, 0]]);
        const st = { mvp: IDENTITY, viewport: VP, clipSpace: IDENTITY_CS };
        expect(transformVertices(mem, 1, DATA, 0, 0, st)).toBe(0x80070057);
        view.setUint32(DATA, 48, true);
        expect(transformVertices(mem, 1, DATA, D3DTRANSFORM_UNCLIPPED, 0, st)).toBe(0x80070057);
        expect(transformVertices(mem, 1, 0, D3DTRANSFORM_UNCLIPPED, 0, st)).toBe(0x80070057);
    });
});
