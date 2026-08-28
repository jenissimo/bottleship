/**
 * Bounded CPU lowering for the portable part of D3D9 NPatch mode.
 *
 * WebGPU has no D3D9 fixed-function patch primitive.  This helper lowers a triangle list to a
 * triangle list of cubic PN triangles: position follows the Bézier net built from the corner
 * positions and normals, the normal follows the quadratic net, and every other lane is
 * interpolated linearly, exactly as D3D9 defines N-patches.  It deliberately operates only on
 * packed float32 vertices; callers must reject declarations/FVFs containing packed colours,
 * blend indices, RHW or other non-float fields.  That restriction is important: interpolating
 * raw bytes would fabricate colour/normal semantics while looking superficially plausible.
 *
 * Without a normal the control net collapses to the source plane and every lane is already
 * linear, so subdivision cannot change one rasterized pixel.  That case therefore emits the
 * source triangle instead of n² copies of it.
 */

export const D3D9_NPATCH_MAX_SEGMENTS = 32;
const D3D9_NPATCH_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface NpatchTessellation {
    /** Flat triangle-list vertex bytes, suitable for a non-indexed draw from vertex 0. */
    data: Uint8Array;
    vertexCount: number;
    primitiveCount: number;
    segments: number;
}

/** Where the two lanes with curved (non-linear) N-patch semantics live in the vertex. */
export interface NpatchVertexLayout {
    /** Byte offset of the float3 POSITION lane. */
    positionOffset: number;
    /** Byte offset of the float3 NORMAL lane, or null when the source has no normal. */
    normalOffset: number | null;
}

type Vec3 = readonly [number, number, number];

function validSegments(segments: number): number | null {
    if (!Number.isFinite(segments) || segments <= 0) return null;
    const n = Math.ceil(segments);
    if (!Number.isSafeInteger(n) || n > D3D9_NPATCH_MAX_SEGMENTS) return null;
    return n;
}

/** A curved patch exists only when both lanes are addressable float3 fields. */
function curvedLayout(layout: NpatchVertexLayout | null | undefined, stride: number):
    { position: number; normal: number } | null {
    if (!layout || layout.normalOffset === null) return null;
    const position = layout.positionOffset, normal = layout.normalOffset;
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(normal)
        || position < 0 || normal < 0 || (position & 3) !== 0 || (normal & 3) !== 0
        || position + 12 > stride || normal + 12 > stride
        || (position < normal + 12 && normal < position + 12)) return null;
    return { position, normal };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function readVec3(view: DataView, offset: number): Vec3 {
    return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
}

function normalize(v: Vec3): Vec3 {
    const length = Math.hypot(v[0], v[1], v[2]);
    return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : v;
}

/**
 * The PN-triangle control net (Vlachos et al., the construction D3D9 N-patches implement).
 * Ten cubic position control points and six quadratic normal control points are derived from
 * the three corners; both nets reduce to the flat triangle when the corner normals are the
 * triangle's own plane normal.
 */
interface PnNet {
    b: Vec3[];  // b300 b030 b003 b210 b120 b021 b012 b102 b201 b111
    n: Vec3[];  // n200 n020 n002 n110 n011 n101
}

function buildPnNet(p: Vec3[], nrm: Vec3[]): PnNet {
    const p1 = p[0]!, p2 = p[1]!, p3 = p[2]!;
    const n1 = normalize(nrm[0]!), n2 = normalize(nrm[1]!), n3 = normalize(nrm[2]!);
    const edgePoint = (from: Vec3, to: Vec3, normal: Vec3): Vec3 => {
        const w = dot(sub(to, from), normal);
        return [
            (2 * from[0] + to[0] - w * normal[0]) / 3,
            (2 * from[1] + to[1] - w * normal[1]) / 3,
            (2 * from[2] + to[2] - w * normal[2]) / 3,
        ];
    };
    const b210 = edgePoint(p1, p2, n1), b120 = edgePoint(p2, p1, n2);
    const b021 = edgePoint(p2, p3, n2), b012 = edgePoint(p3, p2, n3);
    const b102 = edgePoint(p3, p1, n3), b201 = edgePoint(p1, p3, n1);
    const e: Vec3 = [
        (b210[0] + b120[0] + b021[0] + b012[0] + b102[0] + b201[0]) / 6,
        (b210[1] + b120[1] + b021[1] + b012[1] + b102[1] + b201[1]) / 6,
        (b210[2] + b120[2] + b021[2] + b012[2] + b102[2] + b201[2]) / 6,
    ];
    const v: Vec3 = [(p1[0] + p2[0] + p3[0]) / 3, (p1[1] + p2[1] + p3[1]) / 3, (p1[2] + p2[2] + p3[2]) / 3];
    const b111: Vec3 = [e[0] + (e[0] - v[0]) / 2, e[1] + (e[1] - v[1]) / 2, e[2] + (e[2] - v[2]) / 2];

    const edgeNormal = (from: Vec3, to: Vec3, a: Vec3, bN: Vec3): Vec3 => {
        const d = sub(to, from);
        const denominator = dot(d, d);
        const k = denominator > 0 ? (2 * dot(d, [a[0] + bN[0], a[1] + bN[1], a[2] + bN[2]])) / denominator : 0;
        return normalize([a[0] + bN[0] - k * d[0], a[1] + bN[1] - k * d[1], a[2] + bN[2] - k * d[2]]);
    };
    return {
        b: [p1, p2, p3, b210, b120, b021, b012, b102, b201, b111],
        n: [n1, n2, n3, edgeNormal(p1, p2, n1, n2), edgeNormal(p2, p3, n2, n3), edgeNormal(p3, p1, n3, n1)],
    };
}

/** Evaluate the cubic position net at barycentric (u,v,w) for corners 1,2,3. */
function evaluatePnPosition(net: PnNet, u: number, v: number, w: number): Vec3 {
    const c = [
        u * u * u, v * v * v, w * w * w,
        3 * u * u * v, 3 * u * v * v, 3 * v * v * w,
        3 * v * w * w, 3 * u * w * w, 3 * u * u * w, 6 * u * v * w,
    ];
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < c.length; i++) {
        const point = net.b[i]!;
        out[0] += point[0] * c[i]!;
        out[1] += point[1] * c[i]!;
        out[2] += point[2] * c[i]!;
    }
    return out;
}

/** Evaluate the quadratic normal net; D3D9 renormalizes the result per vertex. */
function evaluatePnNormal(net: PnNet, u: number, v: number, w: number): Vec3 {
    const c = [u * u, v * v, w * w, u * v, v * w, u * w];
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < c.length; i++) {
        const normal = net.n[i]!;
        out[0] += normal[0] * c[i]!;
        out[1] += normal[1] * c[i]!;
        out[2] += normal[2] * c[i]!;
    }
    return normalize(out);
}

function writeInterpolatedVertex(
    output: DataView,
    outputOffset: number,
    source: DataView,
    stride: number,
    wa: number,
    wb: number,
    wc: number,
): void {
    for (let byte = 0; byte < stride; byte += 4) {
        const av = source.getFloat32(byte, true);
        const bv = source.getFloat32(stride + byte, true);
        const cv = source.getFloat32(2 * stride + byte, true);
        output.setFloat32(outputOffset + byte, av * wa + bv * wb + cv * wc, true);
    }
}

/**
 * Tessellate one packed-float triangle.  The source is exactly three vertices at `stride`
 * bytes each; output is a non-indexed triangle list with `ceil(segments)^2` triangles when the
 * layout names a normal lane, and the unchanged source triangle otherwise (see the header).
 */
export function tessellateNpatchTriangle(
    source: Uint8Array,
    stride: number,
    segments: number,
    layout?: NpatchVertexLayout | null,
): NpatchTessellation | null {
    const requested = validSegments(segments);
    if (requested === null || stride <= 0 || (stride & 3) !== 0 || source.byteLength < stride * 3) return null;
    const curved = curvedLayout(layout, stride);
    const n = curved ? requested : 1;
    // NPatch is a geometry-producing path, so non-finite source lanes must be rejected before
    // either the one-segment fast path or an output allocation.  Letting NaN/Infinity through
    // would create a command that WebGPU may accept but whose raster result is undefined.
    const sourceView = new DataView(source.buffer, source.byteOffset, stride * 3);
    for (let vertex = 0; vertex < 3; vertex++) {
        for (let byte = 0; byte < stride; byte += 4) {
            if (!Number.isFinite(sourceView.getFloat32(vertex * stride + byte, true))) return null;
        }
    }
    const primitiveCount = n * n;
    const vertexCount = primitiveCount * 3;
    if (vertexCount * stride > D3D9_NPATCH_MAX_OUTPUT_BYTES) return null;
    if (n === 1) {
        // Preserve bit patterns (including signed zero/NaN) when no subdivision was requested;
        // arithmetic interpolation would otherwise turn Infinity*0 into NaN.
        return {
            data: source.slice(0, stride * 3),
            vertexCount: 3,
            primitiveCount: 1,
            segments: 1,
        };
    }
    const output = new Uint8Array(vertexCount * stride);
    const a = sourceView;
    const result = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const net = curved ? buildPnNet(
        [0, 1, 2].map(v => readVec3(sourceView, v * stride + curved.position)),
        [0, 1, 2].map(v => readVec3(sourceView, v * stride + curved.normal)),
    ) : null;
    let outputVertex = 0;
    const point = (i: number, j: number): Vec3 => {
        const wb = i / n;
        const wc = j / n;
        return [1 - wb - wc, wb, wc];
    };
    const emitPoint = (p: Vec3): void => {
        const offset = outputVertex * stride;
        writeInterpolatedVertex(result, offset, a, stride, p[0], p[1], p[2]);
        // Position and normal are the two lanes an N-patch curves; every other lane keeps the
        // linear value written above.
        if (net && curved) {
            const position = evaluatePnPosition(net, p[0], p[1], p[2]);
            const normal = evaluatePnNormal(net, p[0], p[1], p[2]);
            for (let lane = 0; lane < 3; lane++) {
                result.setFloat32(offset + curved.position + lane * 4, position[lane]!, true);
                result.setFloat32(offset + curved.normal + lane * 4, normal[lane]!, true);
            }
        }
        outputVertex++;
    };

    // Every valid (i,j) cell contributes one lower-left triangle and, when present, one upper
    // triangle. The ordering preserves the source triangle's winding.
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n - i; j++) {
            emitPoint(point(i, j));
            emitPoint(point(i + 1, j));
            emitPoint(point(i, j + 1));
            if (i + j + 1 < n) {
                emitPoint(point(i + 1, j));
                emitPoint(point(i + 1, j + 1));
                emitPoint(point(i, j + 1));
            }
        }
    }
    return { data: output, vertexCount, primitiveCount, segments: n };
}

/** Tessellate a complete non-indexed triangle list, preserving primitive order. */
export function tessellateNpatchTriangleList(
    source: Uint8Array,
    stride: number,
    primitiveCount: number,
    segments: number,
    layout?: NpatchVertexLayout | null,
): NpatchTessellation | null {
    const requested = validSegments(segments);
    if (requested === null || !Number.isSafeInteger(primitiveCount) || primitiveCount <= 0
        || stride <= 0 || (stride & 3) !== 0
        || source.byteLength < primitiveCount * 3 * stride) return null;
    const n = curvedLayout(layout, stride) ? requested : 1;
    const perTriangle = n * n * 3 * stride;
    if (primitiveCount > Math.floor(D3D9_NPATCH_MAX_OUTPUT_BYTES / perTriangle)) return null;
    const output = new Uint8Array(primitiveCount * perTriangle);
    for (let primitive = 0; primitive < primitiveCount; primitive++) {
        const inputOffset = primitive * 3 * stride;
        const one = tessellateNpatchTriangle(source.subarray(inputOffset, inputOffset + 3 * stride), stride, n, layout);
        if (!one) return null;
        output.set(one.data, primitive * perTriangle);
    }
    return {
        data: output,
        vertexCount: primitiveCount * n * n * 3,
        primitiveCount: primitiveCount * n * n,
        segments: n,
    };
}
