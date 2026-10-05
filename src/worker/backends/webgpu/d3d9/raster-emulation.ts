/**
 * Pure policy helpers for the D3D9 raster/output-merger states which do not
 * have a one-to-one WebGPU descriptor field.
 *
 * This module deliberately does not touch a device, encoder, or render
 * pipeline.  A policy result of `supported: false` is an honest boundary: a
 * caller must drop the draw (or provide a separate lowering) instead of
 * silently substituting a different raster operation.
 */

// D3D9 render-state indices.
export const D3DRS_MULTISAMPLEANTIALIAS = 161;
export const D3DRS_MULTISAMPLEMASK = 162;
export const D3DRS_ANTIALIASEDLINEENABLE = 176;
export const D3DRS_POINTSIZE = 154;
export const D3DRS_POINTSPRITEENABLE = 156;

// D3DPRIMITIVETYPE values.
export const D3DPT_POINTLIST = 1;
export const D3DPT_LINELIST = 2;
export const D3DPT_LINESTRIP = 3;
export const D3DPT_TRIANGLELIST = 4;
export const D3DPT_TRIANGLESTRIP = 5;
export const D3DPT_TRIANGLEFAN = 6;

export type D3D9PrimitiveType =
    | typeof D3DPT_POINTLIST
    | typeof D3DPT_LINELIST
    | typeof D3DPT_LINESTRIP
    | typeof D3DPT_TRIANGLELIST
    | typeof D3DPT_TRIANGLESTRIP
    | typeof D3DPT_TRIANGLEFAN;

export type D3D9RasterTopology = "point-list" | "line-list" | "triangle-list";

/** D3D9 homogeneous clip bits.  The first six bits are the canonical
 *  x/y/z half-spaces; bit 6 is a hard safety boundary rather than a plane to
 *  intersect (a non-positive W cannot be divided or safely interpolated). */
export const D3D9_CLIP_LEFT = 1;
export const D3D9_CLIP_RIGHT = 2;
export const D3D9_CLIP_BOTTOM = 4;
export const D3D9_CLIP_TOP = 8;
export const D3D9_CLIP_NEAR = 16;
export const D3D9_CLIP_FAR = 32;
export const D3D9_CLIP_NON_POSITIVE_W = 64;

export type D3D9HomogeneousPosition = readonly [number, number, number, number];

export type D3D9HomogeneousVertexClass = "inside" | "outside" | "invalid";

export interface D3D9HomogeneousVertexClassification {
    /** Null means at least one component was non-finite. */
    code: number | null;
    classification: D3D9HomogeneousVertexClass;
}

/**
 * Classify one D3D9 clip-space position without performing a perspective
 * divide.  D3D9 uses x/y in [-W,+W] and z in [0,W].  A finite position with
 * W<=0 is deliberately marked invalid: clipping an edge through W=0 would
 * fabricate a perspective intersection instead of preserving the guest's
 * primitive semantics.
 */
export function d3d9HomogeneousClipCode(
    position: readonly number[],
): number | null {
    if (position.length < 4 || position.some(component => !Number.isFinite(component))) return null;
    const x = position[0]!;
    const y = position[1]!;
    const z = position[2]!;
    const w = position[3]!;
    // Non-positive W is a distinct safety classification. Do not also mark
    // ordinary half-spaces using comparisons against a non-projectable W;
    // callers need the stable single-bit invalid result (and clipping refuses
    // such primitives before intersection).
    if (!(w > 0)) return D3D9_CLIP_NON_POSITIVE_W;
    const epsilon = 1e-12 * Math.max(1, Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(w));
    let code = 0;
    if (x < -w - epsilon) code |= D3D9_CLIP_LEFT;
    if (x > w + epsilon) code |= D3D9_CLIP_RIGHT;
    if (y < -w - epsilon) code |= D3D9_CLIP_BOTTOM;
    if (y > w + epsilon) code |= D3D9_CLIP_TOP;
    if (z < -epsilon) code |= D3D9_CLIP_NEAR;
    if (z > w + epsilon) code |= D3D9_CLIP_FAR;
    return code;
}

/** Named classifier for callers that need to distinguish an unsafe vertex
 * from an ordinary vertex outside one or more canonical clip planes. */
export function classifyD3D9HomogeneousPosition(
    position: readonly number[],
): D3D9HomogeneousVertexClassification {
    const code = d3d9HomogeneousClipCode(position);
    if (code === null || (code & D3D9_CLIP_NON_POSITIVE_W) !== 0) {
        return { code, classification: "invalid" };
    }
    return { code, classification: code === 0 ? "inside" : "outside" };
}

export type D3D9HomogeneousPrimitiveClass = "inside" | "partial" | "outside" | "invalid";

export interface D3D9HomogeneousClipResult {
    /** Invalid means the primitive was not safely representable and was not clipped. */
    valid: boolean;
    classification: D3D9HomogeneousPrimitiveClass;
    /** A clipped line has 0 or 2 vertices; a clipped triangle is an ordered polygon. */
    vertices: D3D9HomogeneousPosition[];
    reason: string | null;
}

type D3D9ClipPlane =
    | typeof D3D9_CLIP_LEFT
    | typeof D3D9_CLIP_RIGHT
    | typeof D3D9_CLIP_BOTTOM
    | typeof D3D9_CLIP_TOP
    | typeof D3D9_CLIP_NEAR
    | typeof D3D9_CLIP_FAR;

const D3D9_CANONICAL_CLIP_PLANES: readonly D3D9ClipPlane[] = [
    D3D9_CLIP_LEFT, D3D9_CLIP_RIGHT, D3D9_CLIP_BOTTOM,
    D3D9_CLIP_TOP, D3D9_CLIP_NEAR, D3D9_CLIP_FAR,
];

function d3d9PlaneDistance(position: D3D9HomogeneousPosition, plane: D3D9ClipPlane): number {
    // W is positive here, so comparing the normalized coordinate against the
    // canonical range avoids x+w/y+w overflow for very large finite inputs.
    const x = position[0] / position[3];
    const y = position[1] / position[3];
    const z = position[2] / position[3];
    switch (plane) {
        case D3D9_CLIP_LEFT: return x + 1;
        case D3D9_CLIP_RIGHT: return 1 - x;
        case D3D9_CLIP_BOTTOM: return y + 1;
        case D3D9_CLIP_TOP: return 1 - y;
        case D3D9_CLIP_NEAR: return z;
        case D3D9_CLIP_FAR: return 1 - z;
    }
}

function d3d9FinitePositivePosition(position: D3D9HomogeneousPosition): boolean {
    return position.every(component => Number.isFinite(component)) && position[3] > 0;
}

/** Compute d0/(d0-d1) without overflowing when the two finite distances have
 * opposite signs and their direct difference exceeds Number.MAX_VALUE. */
function d3d9IntersectionT(d0: number, d1: number): number | null {
    const scale = Math.max(Math.abs(d0), Math.abs(d1));
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    const a = d0 / scale;
    const b = d1 / scale;
    const denominator = a - b;
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    const t = a / denominator;
    return Number.isFinite(t) && t >= 0 && t <= 1 ? t : null;
}

function d3d9InterpolatePosition(
    a: D3D9HomogeneousPosition,
    b: D3D9HomogeneousPosition,
    t: number,
): D3D9HomogeneousPosition | null {
    if (t <= 0) return a;
    if (t >= 1) return b;
    const oneMinusT = 1 - t;
    const result: D3D9HomogeneousPosition = [
        oneMinusT * a[0] + t * b[0],
        oneMinusT * a[1] + t * b[1],
        oneMinusT * a[2] + t * b[2],
        oneMinusT * a[3] + t * b[3],
    ];
    return d3d9FinitePositivePosition(result) ? result : null;
}

function invalidD3D9Clip(reason: string): D3D9HomogeneousClipResult {
    return { valid: false, classification: "invalid", vertices: [], reason };
}

function validateD3D9ClipVertices(
    vertices: readonly D3D9HomogeneousPosition[],
    expectedCount: number,
    primitive: "line" | "triangle",
): D3D9HomogeneousClipResult | null {
    if (vertices.length !== expectedCount) {
        return invalidD3D9Clip(`${primitive} clipping expects ${expectedCount} vertices`);
    }
    for (const vertex of vertices) {
        const code = d3d9HomogeneousClipCode(vertex);
        if (code === null) return invalidD3D9Clip(`${primitive} has a non-finite homogeneous position`);
        if ((code & D3D9_CLIP_NON_POSITIVE_W) !== 0) {
            return invalidD3D9Clip(`${primitive} has a non-positive homogeneous W`);
        }
    }
    return null;
}

/** Clip a D3D9 homogeneous line against the six canonical clip planes. */
export function clipD3D9HomogeneousLine(
    vertices: readonly D3D9HomogeneousPosition[],
): D3D9HomogeneousClipResult {
    const invalid = validateD3D9ClipVertices(vertices, 2, "line");
    if (invalid) return invalid;
    let a = vertices[0]!;
    let b = vertices[1]!;
    let clipped = false;
    for (const plane of D3D9_CANONICAL_CLIP_PLANES) {
        const dA = d3d9PlaneDistance(a, plane);
        const dB = d3d9PlaneDistance(b, plane);
        if (!Number.isFinite(dA) || !Number.isFinite(dB)) {
            return invalidD3D9Clip("line clip distance is not finite");
        }
        const inA = dA >= 0;
        const inB = dB >= 0;
        if (!inA && !inB) return { valid: true, classification: "outside", vertices: [], reason: null };
        if (inA === inB) continue;
        const t = d3d9IntersectionT(dA, dB);
        if (t === null) return invalidD3D9Clip("line clip intersection is not finite");
        const intersection = d3d9InterpolatePosition(a, b, t);
        if (!intersection) return invalidD3D9Clip("line clip intersection is not finite");
        clipped = true;
        if (inA) b = intersection;
        else a = intersection;
    }
    return {
        valid: true,
        classification: clipped ? "partial" : "inside",
        vertices: [a, b],
        reason: null,
    };
}

/** Alias with the shorter name used by primitive callers. */
export const clipD3D9Line = clipD3D9HomogeneousLine;

/** Clip a D3D9 homogeneous triangle.  The returned vertices are an ordered
 * polygon (up to nine vertices); callers can triangulate it as a fan while
 * retaining the original winding. */
export function clipD3D9HomogeneousTriangle(
    vertices: readonly D3D9HomogeneousPosition[],
): D3D9HomogeneousClipResult {
    const invalid = validateD3D9ClipVertices(vertices, 3, "triangle");
    if (invalid) return invalid;
    let polygon: D3D9HomogeneousPosition[] = [...vertices];
    let clipped = false;
    for (const plane of D3D9_CANONICAL_CLIP_PLANES) {
        const next: D3D9HomogeneousPosition[] = [];
        for (let index = 0; index < polygon.length; index++) {
            const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
            const current = polygon[index]!;
            const previousDistance = d3d9PlaneDistance(previous, plane);
            const currentDistance = d3d9PlaneDistance(current, plane);
            if (!Number.isFinite(previousDistance) || !Number.isFinite(currentDistance)) {
                return invalidD3D9Clip("triangle clip distance is not finite");
            }
            const previousInside = previousDistance >= 0;
            const currentInside = currentDistance >= 0;
            if (currentInside !== previousInside) {
                const t = d3d9IntersectionT(previousDistance, currentDistance);
                if (t === null) return invalidD3D9Clip("triangle clip intersection is not finite");
                const intersection = d3d9InterpolatePosition(previous, current, t);
                if (!intersection) return invalidD3D9Clip("triangle clip intersection is not finite");
                next.push(intersection);
                clipped = true;
            }
            if (currentInside) next.push(current);
        }
        polygon = next;
        if (polygon.length === 0) {
            return { valid: true, classification: "outside", vertices: [], reason: null };
        }
    }
    return {
        valid: true,
        classification: clipped ? "partial" : "inside",
        vertices: polygon,
        reason: null,
    };
}

/** Alias with the shorter name used by primitive callers. */
export const clipD3D9Triangle = clipD3D9HomogeneousTriangle;

/** WebGPU draw arguments are GPUSize32 values.  D3D9's draw counts and start
 * offsets are DWORDs too, so accepting a larger JS number would not preserve
 * the guest command; it would only defer the failure to command-buffer
 * validation. */
export const D3D9_MAX_DRAW_ARGUMENT = 0xffff_ffff;

export type D3D9RasterDrawKind = "non-indexed" | "indexed";

export interface D3D9RasterDrawCommand {
    kind: D3D9RasterDrawKind;
    /** vertexCount for non-indexed draws, indexCount for indexed draws. */
    count: number;
    /** firstVertex for non-indexed draws, startIndex for indexed draws. */
    start: number;
    /** Signed baseVertex; ignored for non-indexed draws. */
    baseVertex?: number;
    /** D3D9 stream-frequency instance count. Zero is a valid no-op. */
    instanceCount?: number;
}

/**
 * Validate the compact draw arguments before they reach a WebGPU render pass.
 *
 * D3D9 hardware treats malformed/empty draw ranges as a draw-local failure;
 * WebGPU instead reports an encoding validation error which can discard every
 * later draw in the command buffer.  Keep this check pure so both the command
 * executor and tests use exactly the same boundary.  `null` means the command
 * is representable; a string is an explicit refusal reason.
 */
export function validateD3D9RasterDrawCommand(command: D3D9RasterDrawCommand): string | null {
    if (command.kind !== "non-indexed" && command.kind !== "indexed") {
        return `unknown raster draw kind ${String(command.kind)}`;
    }
    if (!Number.isSafeInteger(command.count) || command.count < 0
        || command.count > D3D9_MAX_DRAW_ARGUMENT) {
        return `${command.kind} draw count must be an integer in [0, ${D3D9_MAX_DRAW_ARGUMENT}]`;
    }
    if (!Number.isSafeInteger(command.start) || command.start < 0
        || command.start > D3D9_MAX_DRAW_ARGUMENT) {
        return `${command.kind} draw start must be an integer in [0, ${D3D9_MAX_DRAW_ARGUMENT}]`;
    }
    const instanceCount = command.instanceCount ?? 1;
    if (!Number.isSafeInteger(instanceCount) || instanceCount < 0
        || instanceCount > D3D9_MAX_DRAW_ARGUMENT) {
        return `draw instance count must be an integer in [0, ${D3D9_MAX_DRAW_ARGUMENT}]`;
    }
    if (command.kind === "indexed") {
        const baseVertex = command.baseVertex ?? 0;
        // GPUBaseVertex is a signed 32-bit value.  Do not coerce a bad guest
        // value with |0: that would turn a large positive offset into a valid
        // negative one and fetch unrelated vertices.
        if (!Number.isSafeInteger(baseVertex) || baseVertex < -0x8000_0000
            || baseVertex > 0x7fff_ffff) {
            return "indexed draw baseVertex must be a signed 32-bit integer";
        }
    }
    return null;
}

const SUPPORTED_SAMPLE_COUNTS = new Set([1, 2, 4]);

export interface D3D9SampleMaskPolicy {
    sampleCount: number;
    /** The DWORD written by D3DRS_MULTISAMPLEMASK. */
    requestedMask: number;
    /** Requested mask restricted to the samples that actually exist. */
    effectiveMask: number;
    /** WebGPU's pipeline multisample.mask carries all/none/partial coverage directly. */
    mode: "all" | "none" | "partial";
    supported: boolean;
    reason: string | null;
}

/**
 * Resolve D3DRS_MULTISAMPLEMASK to the WebGPU pipeline sample mask. High bits
 * are ignored by D3D9; zero and partial masks remain real coverage/depth/stencil
 * operations and are therefore carried into GPUMultisampleState.mask instead of
 * being replaced by COLORWRITEENABLE or a skipped draw.
 */
export function resolveD3D9SampleMaskPolicy(
    sampleCount: number,
    mask: number = 0xffff_ffff,
): D3D9SampleMaskPolicy {
    const requestedMask = mask >>> 0;
    if (!Number.isInteger(sampleCount) || !SUPPORTED_SAMPLE_COUNTS.has(sampleCount)) {
        return {
            sampleCount,
            requestedMask,
            effectiveMask: 0,
            mode: "partial",
            supported: false,
            reason: `D3D9 sample-mask policy has no attachment contract for sample count ${sampleCount}`,
        };
    }

    const sampleBits = sampleCount === 32 ? 0xffff_ffff : ((1 << sampleCount) - 1) >>> 0;
    const effectiveMask = requestedMask & sampleBits;
    const mode = effectiveMask === 0 ? "none" : "partial";
    return {
        sampleCount,
        requestedMask,
        effectiveMask,
        mode: effectiveMask === sampleBits ? "all" : mode,
        supported: true,
        reason: null,
    };
}

export interface D3D9MultisampleRasterPolicy {
    sampleMask: D3D9SampleMaskPolicy;
    /** D3DRS_MULTISAMPLEANTIALIAS as a normalized boolean. */
    antialiasEnabled: boolean;
    supported: boolean;
    reason: string | null;
}

/**
 * Combine the two D3D9 multisample render states.  D3DRS_MULTISAMPLEANTIALIAS is a
 * RASTERIZER sample-count override (DXVK: rasterizationSamples = 1 when FALSE), and
 * WebGPU has no such knob — a pipeline's sample count must equal its attachment's.
 * The hint is therefore ignored: D3D9 never fails a draw over it, and dropping the
 * draw would lose the whole pass (UI/particle passes routinely disable AA).
 */
export function resolveD3D9MultisampleRasterPolicy(
    sampleCount: number,
    antialiasEnabled: boolean = true,
    mask: number = 0xffff_ffff,
): D3D9MultisampleRasterPolicy {
    const sampleMask = resolveD3D9SampleMaskPolicy(sampleCount, mask);
    if (!sampleMask.supported) {
        return {
            sampleMask,
            antialiasEnabled: antialiasEnabled !== false,
            supported: false,
            reason: sampleMask.reason,
        };
    }
    return {
        sampleMask,
        antialiasEnabled: antialiasEnabled !== false,
        supported: true,
        reason: null,
    };
}

export interface D3D9PrimitiveRasterOptions {
    primitiveCount: number;
    /** The device gathers indexed point vertices before the same six-corner expansion. */
    indexed?: boolean;
    /** Programmable/declaration point lists use a VS vertex-index lowering path. */
    programmable?: boolean;
    /** D3DRS_POINTSPRITEENABLE. */
    pointSpriteEnable?: boolean;
    /** Effective point size in pixels, after any per-vertex/state selection. */
    pointSize?: number;
    /** D3DRS_ANTIALIASEDLINEENABLE. */
    antialiasedLineEnable?: boolean;
}

export interface D3D9PrimitiveRasterPolicy {
    primitiveType: number;
    primitiveCount: number;
    supported: boolean;
    topology: D3D9RasterTopology | null;
    sourceVertexCount: number;
    outputVertexCount: number;
    /** True when the caller must expand/repack before issuing WebGPU draw(). */
    needsCpuLowering: boolean;
    reason: string | null;
}

function refusedPrimitive(
    primitiveType: number,
    primitiveCount: number,
    reason: string,
): D3D9PrimitiveRasterPolicy {
    return {
        primitiveType,
        primitiveCount,
        supported: false,
        topology: null,
        sourceVertexCount: 0,
        outputVertexCount: 0,
        needsCpuLowering: false,
        reason,
    };
}

function checkedCount(value: number): number | null {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function checkedMul(a: number, b: number): number | null {
    const result = a * b;
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

/**
 * Validate primitive topology and identify the already-implemented safe
 * lowering.  Triangle fans/strips and line strips are repacked to list form;
 * fixed-function FVF point lists are expanded to quads by the D3D9 point-sprite path.
 * This pure policy has no vertex/index bytes with which to perform that gather, so indexed
 * and programmable point lists are lowered by the device's FVF/index gather and VS
 * vertex-index paths respectively. Antialiased lines are explicit refusals rather than
 * silently drawing 1px geometry with different coverage.
 */
export function resolveD3D9PrimitiveRasterPolicy(
    primitiveType: number,
    options: D3D9PrimitiveRasterOptions,
): D3D9PrimitiveRasterPolicy {
    const primitiveCount = checkedCount(options.primitiveCount);
    if (primitiveCount === null) {
        return refusedPrimitive(primitiveType, options.primitiveCount, "primitiveCount must be a non-negative safe integer");
    }

    switch (primitiveType) {
        case D3DPT_POINTLIST: {
            const pointSize = options.pointSize ?? 1;
            if (!Number.isFinite(pointSize) || pointSize <= 0) {
                return refusedPrimitive(primitiveType, primitiveCount, "point size must be finite and greater than zero");
            }
            const outputVertexCount = checkedMul(primitiveCount, 6);
            if (outputVertexCount === null) {
                return refusedPrimitive(primitiveType, primitiveCount, "point-list expansion exceeds safe vertex-count range");
            }
            return {
                primitiveType,
                primitiveCount,
                supported: true,
                topology: "triangle-list",
                sourceVertexCount: primitiveCount,
                outputVertexCount,
                needsCpuLowering: true,
                reason: null,
            };
        }

        case D3DPT_LINELIST:
            if (options.antialiasedLineEnable) {
                return refusedPrimitive(primitiveType, primitiveCount,
                    "D3DRS_ANTIALIASEDLINEENABLE is not representable by WebGPU line rasterization");
            }
            const lineVertexCount = checkedMul(primitiveCount, 2);
            if (lineVertexCount === null) {
                return refusedPrimitive(primitiveType, primitiveCount, "line-list exceeds safe vertex-count range");
            }
            return {
                primitiveType,
                primitiveCount,
                supported: true,
                topology: "line-list",
                sourceVertexCount: lineVertexCount,
                outputVertexCount: lineVertexCount,
                needsCpuLowering: false,
                reason: null,
            };

        case D3DPT_LINESTRIP: {
            if (options.antialiasedLineEnable) {
                return refusedPrimitive(primitiveType, primitiveCount,
                    "D3DRS_ANTIALIASEDLINEENABLE is not representable by WebGPU line rasterization");
            }
            const sourceVertexCount = primitiveCount === 0 ? 0 : primitiveCount + 1;
            const outputVertexCount = checkedMul(primitiveCount, 2);
            if (outputVertexCount === null || !Number.isSafeInteger(sourceVertexCount)) {
                return refusedPrimitive(primitiveType, primitiveCount, "line-strip conversion exceeds safe vertex-count range");
            }
            return {
                primitiveType,
                primitiveCount,
                supported: true,
                topology: "line-list",
                sourceVertexCount,
                outputVertexCount,
                needsCpuLowering: true,
                reason: null,
            };
        }

        case D3DPT_TRIANGLELIST: {
            const outputVertexCount = checkedMul(primitiveCount, 3);
            if (outputVertexCount === null) {
                return refusedPrimitive(primitiveType, primitiveCount, "triangle-list exceeds safe vertex-count range");
            }
            return {
                primitiveType,
                primitiveCount,
                supported: true,
                topology: "triangle-list",
                sourceVertexCount: outputVertexCount,
                outputVertexCount,
                needsCpuLowering: false,
                reason: null,
            };
        }

        case D3DPT_TRIANGLESTRIP:
        case D3DPT_TRIANGLEFAN: {
            const sourceVertexCount = primitiveCount === 0 ? 0 : primitiveCount + 2;
            const outputVertexCount = checkedMul(primitiveCount, 3);
            if (outputVertexCount === null || !Number.isSafeInteger(sourceVertexCount)) {
                return refusedPrimitive(primitiveType, primitiveCount, "triangle conversion exceeds safe vertex-count range");
            }
            return {
                primitiveType,
                primitiveCount,
                supported: true,
                topology: "triangle-list",
                sourceVertexCount,
                outputVertexCount,
                needsCpuLowering: true,
                reason: null,
            };
        }

        default:
            return refusedPrimitive(primitiveType, primitiveCount,
                `unknown D3DPRIMITIVETYPE ${primitiveType}`);
    }
}

// D3DBLEND values from d3d9types.h.
export const D3DBLEND_ZERO = 1;
export const D3DBLEND_ONE = 2;
export const D3DBLEND_SRCCOLOR = 3;
export const D3DBLEND_INVSRCCOLOR = 4;
export const D3DBLEND_SRCALPHA = 5;
export const D3DBLEND_INVSRCALPHA = 6;
export const D3DBLEND_DESTALPHA = 7;
export const D3DBLEND_INVDESTALPHA = 8;
export const D3DBLEND_DESTCOLOR = 9;
export const D3DBLEND_INVDESTCOLOR = 10;
export const D3DBLEND_SRCALPHASAT = 11;
export const D3DBLEND_BOTHSRCALPHA = 12;
export const D3DBLEND_BOTHINVSRCALPHA = 13;
export const D3DBLEND_BLENDFACTOR = 14;
export const D3DBLEND_INVBLENDFACTOR = 15;
export const D3DBLEND_SRCCOLOR2 = 16;
export const D3DBLEND_INVSRCCOLOR2 = 17;

export type D3D9BlendFactorKind = "ordinary" | "legacy-both" | "dual-source" | "invalid";

export interface D3D9BlendFactorPolicy {
    factor: number;
    kind: D3D9BlendFactorKind;
    representable: boolean;
    reason: string | null;
}

/** Classify one factor without silently mapping an unknown DWORD to ONE. */
export function classifyD3D9BlendFactor(factor: number): D3D9BlendFactorPolicy {
    const normalized = factor >>> 0;
    if (normalized >= D3DBLEND_ZERO && normalized <= D3DBLEND_SRCALPHASAT) {
        return { factor: normalized, kind: "ordinary", representable: true, reason: null };
    }
    if (normalized === D3DBLEND_BOTHSRCALPHA || normalized === D3DBLEND_BOTHINVSRCALPHA) {
        return {
            factor: normalized,
            kind: "legacy-both",
            representable: false,
            reason: "D3DBLEND_BOTH*SRCALPHA must be expanded into a source/destination pair before WebGPU lowering",
        };
    }
    if (normalized === D3DBLEND_BLENDFACTOR || normalized === D3DBLEND_INVBLENDFACTOR) {
        return { factor: normalized, kind: "ordinary", representable: true, reason: null };
    }
    if (normalized === D3DBLEND_SRCCOLOR2 || normalized === D3DBLEND_INVSRCCOLOR2) {
        return {
            factor: normalized,
            kind: "dual-source",
            representable: false,
            reason: "D3DBLEND_*SRCCOLOR2 requires a second fragment color source unavailable in WebGPU",
        };
    }
    return {
        factor: normalized,
        kind: "invalid",
        representable: false,
        reason: `unknown D3DBLEND factor ${normalized}`,
    };
}

export interface D3D9BlendFactorPair {
    src: number;
    dst: number;
}

export interface D3D9BlendStatePolicy {
    supported: boolean;
    usesDualSource: boolean;
    color: D3D9BlendFactorPair;
    alpha: D3D9BlendFactorPair;
    reason: string | null;
}

export interface D3D9BlendStateRequest {
    srcColor: number;
    dstColor: number;
    srcAlpha?: number;
    dstAlpha?: number;
}

function expandLegacyBoth(pair: D3D9BlendFactorPair): D3D9BlendFactorPair {
    if (pair.src === D3DBLEND_BOTHSRCALPHA) {
        return { src: D3DBLEND_SRCALPHA, dst: D3DBLEND_INVSRCALPHA };
    }
    if (pair.src === D3DBLEND_BOTHINVSRCALPHA) {
        return { src: D3DBLEND_INVSRCALPHA, dst: D3DBLEND_SRCALPHA };
    }
    return pair;
}

/**
 * Validate both color and alpha factors and apply the D3D6 BOTH*SRCALPHA
 * compatibility fixup.  The result is suitable for a caller that already
 * knows how to map ordinary factors to GPUBlendFactor; dual-source and bad
 * values remain explicit refusals.
 */
export function classifyD3D9BlendState(request: D3D9BlendStateRequest): D3D9BlendStatePolicy {
    const color = expandLegacyBoth({ src: request.srcColor >>> 0, dst: request.dstColor >>> 0 });
    const alpha = expandLegacyBoth({
        src: (request.srcAlpha ?? request.srcColor) >>> 0,
        dst: (request.dstAlpha ?? request.dstColor) >>> 0,
    });
    const factors = [color.src, color.dst, alpha.src, alpha.dst];
    const classifications = factors.map(classifyD3D9BlendFactor);
    const dual = classifications.find(c => c.kind === "dual-source");
    if (dual) {
        return {
            supported: false,
            usesDualSource: true,
            color,
            alpha,
            reason: dual.reason,
        };
    }
    const invalid = classifications.find(c => !c.representable);
    if (invalid) {
        return {
            supported: false,
            usesDualSource: false,
            color,
            alpha,
            reason: invalid.reason,
        };
    }
    return { supported: true, usesDualSource: false, color, alpha, reason: null };
}

/** Kept as a small named predicate for callers that only need the refusal gate. */
export function isD3D9DualSourceBlendFactor(factor: number): boolean {
    const kind = classifyD3D9BlendFactor(factor).kind;
    return kind === "dual-source";
}
