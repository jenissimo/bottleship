/**
 * ComputeSphereVisibility — the DX6/DX7 bounding-sphere frustum query.
 *
 * The app hands over spheres in WORLD space; the frustum is whatever the current
 * world*view*projection matrix describes, so no renderer state is involved and the whole
 * thing is pure arithmetic. It lives in its own module because the two encodings (DX7's
 * D3DSTATUS_CLIP* bits and DX3/DX6's D3DVIS_* codes) are easy to get subtly wrong and a
 * wrong answer here is invisible — the engine simply stops drawing objects that are on screen.
 */

/** Plane index order, and the order the D3DVIS_* per-plane codes are defined in. */
export const PLANE_COUNT = 6; // left, right, top, bottom, near, far

const D3DSTATUS_CLIPUNIONLEFT = 0x00000001;        // union bits step by 1 per plane
const D3DSTATUS_CLIPINTERSECTIONLEFT = 0x00001000; // intersection bits likewise
const D3DVIS_INTERSECT_LEFT = 1 << 2;              // D3DVIS_* codes step by 2 bits per plane
const D3DVIS_OUTSIDE_LEFT = 2 << 2;
const D3DVIS_INTERSECT_FRUSTUM = 1;
const D3DVIS_OUTSIDE_FRUSTUM = 2;

/**
 * The six frustum planes, in world space, extracted from a combined world*view*projection
 * matrix in D3D's row-vector layout (m[row * 4 + col]). A clip-space plane pulled back
 * through the matrix is a row combination of it: clip.x >= -clip.w is column 4 + column 1,
 * and so on. Planes are unnormalised; `sphereVisibilityBits` divides by the normal's length.
 * Returns 6 x vec4 packed as x,y,z,w.
 */
export function frustumPlanesFromCombined(m: ArrayLike<number>): Float32Array {
    const c = (row: number, col: number) => m[row * 4 + col];
    const p = new Float32Array(PLANE_COUNT * 4);
    const set = (i: number, x: number, y: number, z: number, w: number) => {
        p[i * 4] = x; p[i * 4 + 1] = y; p[i * 4 + 2] = z; p[i * 4 + 3] = w;
    };
    set(0, c(0, 3) + c(0, 0), c(1, 3) + c(1, 0), c(2, 3) + c(2, 0), c(3, 3) + c(3, 0)); // left
    set(1, c(0, 3) - c(0, 0), c(1, 3) - c(1, 0), c(2, 3) - c(2, 0), c(3, 3) - c(3, 0)); // right
    set(2, c(0, 3) - c(0, 1), c(1, 3) - c(1, 1), c(2, 3) - c(2, 1), c(3, 3) - c(3, 1)); // top
    set(3, c(0, 3) + c(0, 1), c(1, 3) + c(1, 1), c(2, 3) + c(2, 1), c(3, 3) + c(3, 1)); // bottom
    set(4, c(0, 2), c(1, 2), c(2, 2), c(3, 2));                                         // near (z >= 0)
    set(5, c(0, 3) - c(0, 2), c(1, 3) - c(1, 2), c(2, 3) - c(2, 2), c(3, 3) - c(3, 2)); // far
    return p;
}

/**
 * One sphere against all six planes in the DX7 encoding: the union bit alone means the
 * sphere STRADDLES that plane, union|intersection means it lies wholly outside it, and zero
 * means wholly inside. `equality` is the DX3/DX6 variant, which counts a sphere exactly
 * touching a plane as straddling it.
 */
export function sphereVisibilityBits(
    planes: Float32Array, cx: number, cy: number, cz: number, radius: number, equality: boolean
): number {
    let bits = 0;
    for (let i = 0; i < PLANE_COUNT; i++) {
        const px = planes[i * 4], py = planes[i * 4 + 1], pz = planes[i * 4 + 2], pw = planes[i * 4 + 3];
        const norm = Math.sqrt(px * px + py * py + pz * pz);
        // Degenerate plane (no projection matrix set yet): claim nothing about it rather
        // than reporting a NaN comparison as "outside".
        if (!(norm > 0)) continue;
        const distance = (px * cx + py * cy + pz * cz + pw) / norm;
        const straddles = equality ? Math.abs(distance) <= radius : Math.abs(distance) < radius;
        if (straddles) {
            bits |= D3DSTATUS_CLIPUNIONLEFT << i;
        } else if (equality ? distance <= -radius : distance < -radius) {
            bits |= (D3DSTATUS_CLIPUNIONLEFT | D3DSTATUS_CLIPINTERSECTIONLEFT) << i;
        }
    }
    return bits >>> 0;
}

/** The same classification in the DX3/DX6 D3DVIS_* encoding: two bits per plane, plus a
 *  summary of the whole frustum in the low two bits. */
export function clipBitsToD3dVis(bits: number): number {
    let vis = 0;
    let intersects = false;
    let outside = false;
    for (let i = 0; i < PLANE_COUNT; i++) {
        const clip = (bits >>> i) & (D3DSTATUS_CLIPUNIONLEFT | D3DSTATUS_CLIPINTERSECTIONLEFT);
        if (clip === D3DSTATUS_CLIPUNIONLEFT) {
            vis |= D3DVIS_INTERSECT_LEFT << (i * 2);
            intersects = true;
        } else if (clip) {
            vis |= D3DVIS_OUTSIDE_LEFT << (i * 2);
            outside = true;
        }
    }
    if (outside) vis |= D3DVIS_OUTSIDE_FRUSTUM;
    else if (intersects) vis |= D3DVIS_INTERSECT_FRUSTUM;
    return vis >>> 0;
}
