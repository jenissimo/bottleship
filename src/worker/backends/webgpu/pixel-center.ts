/**
 * The legacy-D3D pixel-centre convention, in ONE place for every fixed-function path.
 *
 * D3D9-and-earlier coordinates name pixel CENTRES; WebGPU names corners. The offset
 * belongs to the viewport mapping, so it applies to ALL geometry, not to pre-transformed
 * vertices only — Wine folds the same `center_offset` into both branches of
 * wined3d/glsl_shader.c get_projection_matrix(), and DXVK reaches the same result by
 * biasing the viewport once (d3d9_device.cpp BindViewportAndScissor, "Correctness Factor
 * for 1/2 texel offset"). We cannot copy DXVK's placement — WebGPU rejects a viewport
 * whose x + width exceeds the attachment — so it is Wine's placement with DXVK's value.
 *
 * Both paths are made to agree in CLIP space by adding `w · (dx, dy)` to (x, y):
 *     dx = +2·px/vpWidth,  dy = -2·px/vpHeight
 * which after the perspective divide is half a pixel of screen x and y (screen y grows
 * down, NDC y up — hence the sign). The pre-transformed path already does this on the
 * screen coordinate and is untouched here; the transformed path gets it post-multiplied
 * into the MVP as it is copied into the uniform slot, which keeps it out of every
 * pipeline-cache key. x and y only: depth, fog, and the separately-uploaded world /
 * worldView matrices never carry it.
 *
 * Kill-switch `__d3dNoPixelCentre` restores the pre-transformed-only behaviour for an
 * A/B; it is not a feature gate.
 */

/** Half a pixel: the distance from a D3D integer pixel centre to a WebGPU one. */
export const D3D_PIXEL_CENTER_OFFSET_PX = 0.5;

/**
 * The pixel-centre offset to apply to TRANSFORMED geometry, in GUEST pixels.
 * 0 until the convention is turned on (see the flag above); never negative.
 *
 * `renderScale` is physical samples per guest pixel. The correction is half a PHYSICAL
 * pixel — a property of where the target samples — so a supersampled target owes half of
 * a proportionally smaller guest pixel, not half of the guest's own.
 */
export function pixelCenterOffsetPx(renderScale = 1): number {
    if ((globalThis as { __d3dNoPixelCentre?: boolean }).__d3dNoPixelCentre === true) return 0;
    const scale = renderScale > 0 ? renderScale : 1;
    return D3D_PIXEL_CENTER_OFFSET_PX / scale;
}

/** Convert the legacy pixel-centre offset to the clip-space delta used by a
 * programmable vertex epilogue. Viewport extents are guest-space, as is the offset. */
export function pixelCenterClipOffset(
    viewportWidth: number,
    viewportHeight: number,
    renderScale = 1,
): { dx: number; dy: number } {
    const px = pixelCenterOffsetPx(renderScale);
    return {
        dx: px > 0 && viewportWidth > 0 ? (2 * px) / viewportWidth : 0,
        dy: px > 0 && viewportHeight > 0 ? -(2 * px) / viewportHeight : 0,
    };
}

const pixelCentreVersionF32 = new Float32Array(1);
const pixelCentreVersionU32 = new Uint32Array(pixelCentreVersionF32.buffer);

/** Mix runtime pixel-centre values into a programmable constant-bank cache key. */
export function withPixelCenterVersion(
    baseVersion: number | undefined,
    dx: number,
    dy: number,
): number {
    let h1 = Math.floor((baseVersion ?? 0) / 0x100000000) >>> 0;
    let h2 = (baseVersion ?? 0) >>> 0;
    for (const value of [dx, dy]) {
        pixelCentreVersionF32[0] = value;
        const bits = pixelCentreVersionU32[0]!;
        h1 = Math.imul(h1 ^ bits, 0x01000193) >>> 0;
        h2 = (Math.imul(h2 ^ bits, 0x85ebca6b) + 0x9e3779b9) >>> 0;
    }
    return ((h1 & 0x1fffff) * 0x100000000) + h2;
}

/**
 * Copy a 16-float D3D row-major MVP into `dst` at `dstFloatOffset`, folding in the
 * pixel-centre shift for the viewport it will be rasterized into (see the header for the
 * derivation). `src` is never mutated — callers hand us a cached matrix.
 * A degenerate viewport (<= 0) contributes no offset rather than an infinity.
 */
export function writeMvpWithPixelCenter(
    dst: Float32Array,
    dstFloatOffset: number,
    src: ArrayLike<number>,
    viewportWidth: number,
    viewportHeight: number,
    renderScale = 1,
): void {
    const { dx, dy } = pixelCenterClipOffset(viewportWidth, viewportHeight, renderScale);

    for (let row = 0; row < 4; row++) {
        const i = row * 4;
        const w = src[i + 3];
        dst[dstFloatOffset + i + 0] = src[i + 0] + w * dx;
        dst[dstFloatOffset + i + 1] = src[i + 1] + w * dy;
        dst[dstFloatOffset + i + 2] = src[i + 2];
        dst[dstFloatOffset + i + 3] = w;
    }
}
