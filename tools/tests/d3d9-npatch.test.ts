import { describe, expect, test } from "bun:test";
import {
    D3D9_NPATCH_MAX_SEGMENTS,
    tessellateNpatchTriangle,
    tessellateNpatchTriangleList,
} from "../../src/worker/backends/webgpu/d3d9/npatch-tessellator";

function triangle(values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 4);
    new Float32Array(bytes.buffer).set(values);
    return bytes;
}

function readFloats(bytes: Uint8Array): number[] {
    return [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];
}

/** Position + normal, 24 bytes per vertex. */
const POSITION_NORMAL = { positionOffset: 0, normalOffset: 12 };

describe("D3D9 bounded NPatch tessellator", () => {
    test("keeps a one-segment triangle and its exact bytes", () => {
        const source = triangle([
            0, 0, 0, 10, 20, 30,
            1, 0, 0, 20, 30, 40,
            0, 1, 0, 30, 40, 50,
        ]);
        const result = tessellateNpatchTriangle(source, 24, 1, POSITION_NORMAL);
        expect(result).toMatchObject({ segments: 1, primitiveCount: 1, vertexCount: 3 });
        expect(readFloats(result!.data)).toEqual(readFloats(source));
    });

    test("emits the source triangle, not n² copies, when nothing can curve", () => {
        // Without a normal lane the control net is the source plane and every
        // attribute is linear, so subdivision cannot change one rasterized pixel.
        const source = triangle([
            0, 0, 0, 0,
            2, 0, 0, 20,
            0, 2, 0, 40,
        ]);
        for (const layout of [undefined, { positionOffset: 0, normalOffset: null }]) {
            const result = tessellateNpatchTriangle(source, 16, 4, layout);
            expect(result).toMatchObject({ segments: 1, primitiveCount: 1, vertexCount: 3 });
            expect(readFloats(result!.data)).toEqual(readFloats(source));
        }
    });

    test("creates n² ordered triangles whose non-curved lanes stay linear", () => {
        // Flat-shaded corners (all normals +Z on a z=0 triangle): the PN net collapses to
        // the plane, so positions match the linear barycentric points exactly.
        const source = triangle([
            0, 0, 0, 0, 0, 1,
            2, 0, 0, 0, 0, 1,
            0, 2, 0, 0, 0, 1,
        ]);
        const result = tessellateNpatchTriangle(source, 24, 2, POSITION_NORMAL);
        expect(result).toMatchObject({ segments: 2, primitiveCount: 4, vertexCount: 12 });
        const out = readFloats(result!.data);
        // First small triangle is A, midpoint(A,B), midpoint(A,C); normals stay unit +Z.
        expect(out.slice(0, 18)).toEqual([
            0, 0, 0, 0, 0, 1,
            1, 0, 0, 0, 0, 1,
            0, 1, 0, 0, 0, 1,
        ]);
    });

    test("curves position and normal like a cubic PN triangle", () => {
        // Corner normals tilted off the plane must lift the interior; a linear
        // interpolation would leave every generated vertex at z === 0.
        const s = Math.SQRT1_2;
        const source = triangle([
            0, 0, 0, -s, -s, s,
            1, 0, 0, s, -s, s,
            0, 1, 0, -s, s, s,
        ]);
        const result = tessellateNpatchTriangle(source, 24, 3, POSITION_NORMAL);
        expect(result).toMatchObject({ segments: 3, primitiveCount: 9, vertexCount: 27 });
        const out = readFloats(result!.data);
        const z: number[] = [];
        for (let vertex = 0; vertex < 27; vertex++) z.push(out[vertex * 6 + 2]!);
        expect(Math.max(...z.map(Math.abs))).toBeGreaterThan(0.01);
        // Corners stay put: vertex 0 is the source corner A.
        expect(out.slice(0, 3)).toEqual([0, 0, 0]);
        // Interpolated normals stay unit length.
        for (let vertex = 0; vertex < 27; vertex++) {
            const n = out.slice(vertex * 6 + 3, vertex * 6 + 6);
            expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 5);
        }
    });

    test("preserves primitive order and refuses malformed/unbounded input", () => {
        const one = triangle([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const two = triangle([2, 0, 0, 3, 0, 0, 2, 1, 0]);
        const source = new Uint8Array(one.byteLength + two.byteLength);
        source.set(one);
        source.set(two, one.byteLength);
        const result = tessellateNpatchTriangleList(source, 12, 2, 1);
        expect(result).toMatchObject({ primitiveCount: 2, vertexCount: 6 });
        expect(readFloats(result!.data).slice(9, 12)).toEqual([2, 0, 0]);
        expect(tessellateNpatchTriangle(one, 10, 2)).toBeNull();
        expect(tessellateNpatchTriangle(one, 12, D3D9_NPATCH_MAX_SEGMENTS + 1)).toBeNull();
        expect(tessellateNpatchTriangle(one.subarray(0, 20), 12, 2)).toBeNull();

        const nonFinite = triangle([0, 0, 0, 1, 0, 0, 0, 1, Number.NaN]);
        expect(tessellateNpatchTriangle(nonFinite, 12, 1)).toBeNull();
    });

    test("ignores a layout whose lanes do not fit or overlap", () => {
        const source = triangle([
            0, 0, 0, 0, 0, 1,
            1, 0, 0, 0, 0, 1,
            0, 1, 0, 0, 0, 1,
        ]);
        for (const layout of [
            { positionOffset: 0, normalOffset: 16 },   // normal runs past the stride
            { positionOffset: 0, normalOffset: 8 },    // overlaps the position lane
            { positionOffset: 2, normalOffset: 12 },   // unaligned
        ]) {
            expect(tessellateNpatchTriangle(source, 24, 4, layout))
                .toMatchObject({ segments: 1, vertexCount: 3 });
        }
    });

    test("a curved triangle list keeps per-primitive spans and order", () => {
        const s = Math.SQRT1_2;
        const one = triangle([
            0, 0, 0, -s, -s, s,
            1, 0, 0, s, -s, s,
            0, 1, 0, -s, s, s,
        ]);
        const source = new Uint8Array(one.byteLength * 2);
        source.set(one);
        source.set(one, one.byteLength);
        const result = tessellateNpatchTriangleList(source, 24, 2, 2, POSITION_NORMAL);
        expect(result).toMatchObject({ primitiveCount: 8, vertexCount: 24, segments: 2 });
        const out = readFloats(result!.data);
        const perTriangle = 12 * 6;
        expect(out.slice(0, perTriangle)).toEqual(out.slice(perTriangle, perTriangle * 2));
    });
});
