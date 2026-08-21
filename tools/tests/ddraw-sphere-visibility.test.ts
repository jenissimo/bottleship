/**
 * ComputeSphereVisibility — the DX6/DX7 bounding-sphere frustum query.
 *
 * Before this existed the method returned D3D_OK and never touched lpdwReturnValues, so an
 * engine read its own stack as D3DVIS_* codes. The failure that buys is silent and total:
 * an object classified D3DVIS_OUTSIDE_FRUSTUM is simply not drawn, and nothing logs it.
 * These cases pin both encodings and, crucially, that a sphere sitting in the middle of the
 * frustum reports ZERO — the answer whose absence caused the bug.
 */

import { describe, expect, test } from "bun:test";
import {
    frustumPlanesFromCombined,
    sphereVisibilityBits,
    clipBitsToD3dVis,
} from "../../src/worker/modules/ddraw/d3d/sphere-visibility";

const D3DVIS_INTERSECT_FRUSTUM = 1;
const D3DVIS_OUTSIDE_FRUSTUM = 2;
const D3DVIS_OUTSIDE_LEFT = 2 << 2;
const D3DVIS_OUTSIDE_RIGHT = 2 << 4;
const D3DVIS_OUTSIDE_NEAR = 2 << 10;
const D3DVIS_INTERSECT_LEFT = 1 << 2;

/**
 * A left-handed perspective projection in D3D's row-vector layout, as D3DXMatrixPerspectiveFovLH
 * builds it: 90 degree fov, aspect 1, near 1, far 1000. View and world are identity, so the
 * frustum is the camera-space cone opening along +z.
 */
function projectionLH(): Float32Array {
    const near = 1, far = 1000;
    const h = 1 / Math.tan(Math.PI / 4); // fov/2 = 45 deg → h = 1
    const q = far / (far - near);
    return new Float32Array([
        h, 0, 0, 0,
        0, h, 0, 0,
        0, 0, q, 1,
        0, 0, -q * near, 0,
    ]);
}

const planes = frustumPlanesFromCombined(projectionLH());

/** DX7 encoding for a sphere, and the DX3/DX6 code the same classification maps to. */
const classify = (x: number, y: number, z: number, r: number) => ({
    dx7: sphereVisibilityBits(planes, x, y, z, r, false),
    dx3: clipBitsToD3dVis(sphereVisibilityBits(planes, x, y, z, r, true)),
});

describe("ComputeSphereVisibility", () => {
    test("a sphere well inside the frustum is fully visible", () => {
        const { dx7, dx3 } = classify(0, 0, 100, 1);
        expect(dx7).toBe(0);
        expect(dx3).toBe(0); // D3DVIS_INSIDE_* are all zero
    });

    test("a sphere far off to the left is outside, and says which plane", () => {
        const { dx7, dx3 } = classify(-500, 0, 100, 1);
        expect(dx7).not.toBe(0);
        expect(dx3 & 3).toBe(D3DVIS_OUTSIDE_FRUSTUM);
        expect(dx3 & D3DVIS_OUTSIDE_LEFT).toBe(D3DVIS_OUTSIDE_LEFT);
        expect(dx3 & D3DVIS_OUTSIDE_RIGHT).toBe(0);
    });

    test("a sphere behind the camera is outside the near plane", () => {
        const { dx3 } = classify(0, 0, -50, 1);
        expect(dx3 & 3).toBe(D3DVIS_OUTSIDE_FRUSTUM);
        expect(dx3 & D3DVIS_OUTSIDE_NEAR).toBe(D3DVIS_OUTSIDE_NEAR);
    });

    test("a sphere straddling the left plane intersects, it is not discarded", () => {
        // At z = 100 the 90-degree frustum's left edge is x = -100.
        const { dx3 } = classify(-100, 0, 100, 20);
        expect(dx3 & 3).toBe(D3DVIS_INTERSECT_FRUSTUM);
        expect(dx3 & D3DVIS_INTERSECT_LEFT).toBe(D3DVIS_INTERSECT_LEFT);
    });

    test("a sphere enclosing the whole frustum is still visible", () => {
        // Centred inside, radius large enough to cross every side plane: it intersects,
        // it is never outside. Reporting OUTSIDE here is the shape that deletes level geometry.
        const { dx3 } = classify(0, 0, 500, 5000);
        expect(dx3 & 3).toBe(D3DVIS_INTERSECT_FRUSTUM);
    });

    test("degenerate matrices claim nothing rather than reporting outside", () => {
        // A device whose projection was never set: every plane normal is zero. A NaN
        // comparison must not come back as "outside the frustum".
        const zero = frustumPlanesFromCombined(new Float32Array(16));
        expect(sphereVisibilityBits(zero, 0, 0, 0, 1, false)).toBe(0);
        expect(clipBitsToD3dVis(sphereVisibilityBits(zero, 1e6, 0, 0, 1, true))).toBe(0);
    });

    test("the DX3 encoding is two bits per plane, the DX7 encoding one", () => {
        // Same sphere, both encodings: outside-left is bit 0 + bit 12 in DX7 (union +
        // intersection), and the 2-wide field at bits 2..3 in DX3.
        const bits = sphereVisibilityBits(planes, -500, 0, 100, 1, false);
        expect(bits & 0x1).toBe(0x1);
        expect(bits & 0x1000).toBe(0x1000);
        expect(clipBitsToD3dVis(bits) & (3 << 2)).toBe(D3DVIS_OUTSIDE_LEFT);
    });
});
