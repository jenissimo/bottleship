/**
 * Pure policy for D3D9 Clear(rects).  A WebGPU render-pass loadOp cannot be scissored, so a
 * rectangle clear is lowered as a scissored fullscreen-triangle draw into the attachment —
 * at the attachment's own sample count, MSAA included.  D3D9 has no failure mode for a legal
 * Clear, so the only refusals here are genuinely invalid arguments.
 */
export interface D3D9RectClearPolicy {
    supported: boolean;
    target: boolean;
    depth: boolean;
    stencil: boolean;
    reason: string | null;
}

export function resolveD3D9RectClearPolicy(
    flags: number,
    sampleCount: number,
    hasStencil: boolean,
): D3D9RectClearPolicy {
    const normalized = flags >>> 0;
    const target = (normalized & 1) !== 0;
    const depth = (normalized & 2) !== 0;
    const stencil = (normalized & 4) !== 0;
    if ((normalized & ~7) !== 0 || (!target && !depth && !stencil)) {
        return { supported: false, target, depth, stencil, reason: "invalid Clear flags" };
    }
    if (!Number.isInteger(sampleCount) || sampleCount < 1) {
        return { supported: false, target, depth, stencil, reason: "invalid attachment sample count" };
    }
    if (stencil && !hasStencil) {
        return { supported: false, target, depth, stencil, reason: "stencil clear has no stencil plane" };
    }
    return { supported: true, target, depth, stencil, reason: null };
}

/** The pixel region a D3D9 Clear with no rectangle list touches. */
export interface D3D9ClearRegion {
    left: number;
    top: number;
    right: number;
    bottom: number;
    /** The region covers the whole attachment — a render-pass loadOp is exact. */
    full: boolean;
    /** Nothing to clear (degenerate viewport/scissor intersection). */
    empty: boolean;
}

/**
 * D3D9's Clear clears the VIEWPORT, intersected with the scissor rectangle when
 * D3DRS_SCISSORTESTENABLE is on — not the whole attachment (DXVK D3D9DeviceEx::Clear).
 * A shadow-map atlas, a split-screen half or a PIP mirror clears its own sub-viewport and
 * must leave the regions already rendered alone.
 */
export function resolveD3D9ClearRegion(
    viewport: { x: number; y: number; width: number; height: number },
    scissor: { left: number; top: number; right: number; bottom: number },
    scissorEnabled: boolean,
    targetWidth: number,
    targetHeight: number,
): D3D9ClearRegion {
    let left = viewport.x | 0;
    let top = viewport.y | 0;
    let right = left + (viewport.width | 0);
    let bottom = top + (viewport.height | 0);
    if (scissorEnabled) {
        left = Math.max(left, scissor.left | 0);
        top = Math.max(top, scissor.top | 0);
        right = Math.min(right, scissor.right | 0);
        bottom = Math.min(bottom, scissor.bottom | 0);
    }
    const clampedLeft = Math.max(0, Math.min(targetWidth, left));
    const clampedTop = Math.max(0, Math.min(targetHeight, top));
    const clampedRight = Math.max(clampedLeft, Math.min(targetWidth, right));
    const clampedBottom = Math.max(clampedTop, Math.min(targetHeight, bottom));
    const empty = clampedRight <= clampedLeft || clampedBottom <= clampedTop;
    // Covering the attachment is decided from the UNCLAMPED bounds: a viewport that runs
    // past the edge still covers it, and clamping first would read as "not full".
    const full = !empty && left <= 0 && top <= 0 && right >= targetWidth && bottom >= targetHeight;
    return { left: clampedLeft, top: clampedTop, right: clampedRight, bottom: clampedBottom, full, empty };
}
