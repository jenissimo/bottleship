/**
 * Fixed-function D3D9 vertex blend/tween math.
 *
 * The shader and CPU fallback both use the same row-vector convention as the
 * D3D9 state tracker: a translation lives at matrix elements 12..14 and a
 * point is transformed as `p * M`. Keeping the small, allocation-bounded
 * reference implementation here makes the weight/index rules testable
 * without constructing a WebGPU device.
 */

export const FFP_MAX_BLEND_MATRICES = 8;

export const D3DVBF_DISABLE = 0;
export const D3DVBF_1WEIGHTS = 1;
export const D3DVBF_2WEIGHTS = 2;
export const D3DVBF_3WEIGHTS = 3;
export const D3DVBF_TWEENING = 255;
export const D3DVBF_0WEIGHTS = 256;

export type FfpVertexBlendKind = "disabled" | "palette" | "tweening";

export interface FfpVertexBlendMode {
    readonly kind: FfpVertexBlendKind;
    /** Number of matrix iterations. For N explicit weights this is N + 1. */
    readonly matrixCount: number;
    /** Number of weights read from the vertex; the final weight is implicit. */
    readonly explicitWeightCount: number;
    readonly indexed: boolean;
}

export interface FfpVertexBlendResolution {
    readonly mode: FfpVertexBlendMode | null;
    readonly reason?: string;
}

/**
 * Decode D3DRS_VERTEXBLEND and D3DRS_INDEXEDVERTEXBLENDENABLE.
 *
 * D3DVBF_1/2/3WEIGHTS store N betas and use N+1 matrices; the final beta is
 * `1 - sum(previous betas)`. D3DVBF_0WEIGHTS is the indexed one-matrix form.
 * Tweening is a separate POSITION0/POSITION1 path and cannot be indexed.
 */
export function resolveFfpVertexBlend(vertexBlend: number, indexed: boolean): FfpVertexBlendResolution {
    const vbf = vertexBlend | 0;
    const indexedEnable = !!indexed;

    if (vbf === D3DVBF_DISABLE) {
        return indexedEnable
            ? { mode: null, reason: "indexed vertex blend requires a nonzero vertex-blend mode" }
            : {
                mode: {
                    kind: "disabled",
                    matrixCount: 1,
                    explicitWeightCount: 0,
                    indexed: false,
                },
            };
    }

    if (vbf === D3DVBF_TWEENING) {
        return indexedEnable
            ? { mode: null, reason: "vertex tweening and indexed vertex blending are mutually exclusive" }
            : {
                mode: {
                    kind: "tweening",
                    matrixCount: 0,
                    explicitWeightCount: 0,
                    indexed: false,
                },
            };
    }

    if (vbf === D3DVBF_0WEIGHTS) {
        return indexedEnable
            ? {
                mode: {
                    kind: "palette",
                    matrixCount: 1,
                    explicitWeightCount: 0,
                    indexed: true,
                },
            }
            : { mode: null, reason: "D3DVBF_0WEIGHTS is valid only with indexed vertex blending" };
    }

    if (vbf === D3DVBF_1WEIGHTS || vbf === D3DVBF_2WEIGHTS || vbf === D3DVBF_3WEIGHTS) {
        return {
            mode: {
                kind: "palette",
                matrixCount: vbf + 1,
                explicitWeightCount: vbf,
                indexed: indexedEnable,
            },
        };
    }

    return { mode: null, reason: `unsupported D3DRS_VERTEXBLEND value ${vbf}` };
}

/** Transform one point by a D3D row-major matrix (the D3D9 FFP convention). */
export function transformFfpPoint(
    point: readonly [number, number, number],
    matrix: ArrayLike<number> | null | undefined,
): Float32Array {
    if (!matrix) return Float32Array.from(point);
    const x = point[0], y = point[1], z = point[2];
    return new Float32Array([
        x * matrix[0]! + y * matrix[4]! + z * matrix[8]! + matrix[12]!,
        x * matrix[1]! + y * matrix[5]! + z * matrix[9]! + matrix[13]!,
        x * matrix[2]! + y * matrix[6]! + z * matrix[10]! + matrix[14]!,
    ]);
}

/** Transform a direction by the upper-left 3×3 portion of a D3D matrix. */
export function transformFfpDirection(
    direction: readonly [number, number, number],
    matrix: ArrayLike<number> | null | undefined,
): Float32Array {
    if (!matrix) return Float32Array.from(direction);
    const x = direction[0], y = direction[1], z = direction[2];
    return new Float32Array([
        x * matrix[0]! + y * matrix[4]! + z * matrix[8]!,
        x * matrix[1]! + y * matrix[5]! + z * matrix[9]!,
        x * matrix[2]! + y * matrix[6]! + z * matrix[10]!,
    ]);
}

function paletteMatrix(
    palette: readonly (ArrayLike<number> | null | undefined)[],
    index: number,
): ArrayLike<number> | null {
    // D3D9 exposes a finite indexed palette. Invalid/missing entries behave
    // like the identity in the existing D3D8 CPU fallback, and clamping keeps
    // a malformed guest byte from becoming a shader array OOB access.
    const clamped = Math.max(0, Math.min(palette.length - 1, index | 0));
    return palette[clamped] ?? null;
}

function blendWeights(weights: ArrayLike<number>, matrixCount: number): Float32Array {
    const out = new Float32Array(matrixCount);
    let remainder = 1;
    for (let i = 0; i < matrixCount; i++) {
        if (i + 1 < matrixCount) {
            const w = Number(weights[i] ?? 0);
            out[i] = w;
            remainder -= w;
        } else {
            out[i] = remainder;
        }
    }
    return out;
}

/**
 * Blend one position using the decoded FFP palette mode. The return value is
 * world-space and intentionally uses Float32Array stores, matching the CPU
 * converter's observable f32 rounding at the vertex output boundary.
 */
export function blendFfpPosition(
    point: readonly [number, number, number],
    weights: ArrayLike<number>,
    palette: readonly (ArrayLike<number> | null | undefined)[],
    mode: FfpVertexBlendMode,
    indices?: ArrayLike<number>,
): Float32Array {
    if (mode.kind !== "palette") return Float32Array.from(point);
    const ws = blendWeights(weights, mode.matrixCount);
    const out = [0, 0, 0];
    for (let i = 0; i < mode.matrixCount; i++) {
        const paletteIndex = mode.indexed ? Number(indices?.[i] ?? 0) : i;
        const transformed = transformFfpPoint(point, paletteMatrix(palette, paletteIndex));
        out[0] += ws[i]! * transformed[0]!;
        out[1] += ws[i]! * transformed[1]!;
        out[2] += ws[i]! * transformed[2]!;
    }
    return Float32Array.from(out);
}

/** Blend one normal/direction using the same palette and implicit final weight. */
export function blendFfpNormal(
    normal: readonly [number, number, number],
    weights: ArrayLike<number>,
    palette: readonly (ArrayLike<number> | null | undefined)[],
    mode: FfpVertexBlendMode,
    indices?: ArrayLike<number>,
): Float32Array {
    if (mode.kind !== "palette") return Float32Array.from(normal);
    const ws = blendWeights(weights, mode.matrixCount);
    const out = [0, 0, 0];
    for (let i = 0; i < mode.matrixCount; i++) {
        const paletteIndex = mode.indexed ? Number(indices?.[i] ?? 0) : i;
        const transformed = transformFfpDirection(normal, paletteMatrix(palette, paletteIndex));
        out[0] += ws[i]! * transformed[0]!;
        out[1] += ws[i]! * transformed[1]!;
        out[2] += ws[i]! * transformed[2]!;
    }
    return Float32Array.from(out);
}

/** D3DVBF_TWEENING: linear interpolation between POSITION0/POSITION1 (and NORMALs). */
export function tweenFfpVector(
    first: readonly [number, number, number],
    second: readonly [number, number, number],
    factor: number,
): Float32Array {
    const t = Number(factor);
    return Float32Array.from([
        first[0] + (second[0] - first[0]) * t,
        first[1] + (second[1] - first[1]) * t,
        first[2] + (second[2] - first[2]) * t,
    ]);
}

