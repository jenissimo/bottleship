/**
 * Synthetic raster status shared by IDirectDraw::GetScanLine and
 * ::GetVerticalBlankStatus (identical in every interface version).
 *
 * The beam position must keep moving and the vertical-blank flag must keep
 * toggling: the SDK-standard frame sync is a two-phase spin
 * (`do {} while (inVB); do {} while (!inVB);`), which never terminates if the
 * answer is constant — or if the out-parameter is left uninitialised.
 */

/** Vertical blanking as a fraction of the refresh period: the VGA blanking interval is
 *  ~45 of 525 total lines, and that ratio holds whatever the refresh rate is. */
const VBLANK_FRACTION = 45 / 525;

export interface RasterStatus {
    /** 0 <= scanLine < height. */
    scanLine: number;
    inVBlank: boolean;
}

export function nextVerticalBlankEdgeMs(nowMs: number, refreshHz: number, end: boolean): number {
    const frameMs = 1000 / Math.max(1, refreshHz || 60);
    const edge = end ? frameMs * VBLANK_FRACTION : 0;
    const frame = Math.floor((nowMs - edge) / frameMs);
    const nextEdge = (frame + 1) * frameMs + edge;
    return nextEdge > nowMs ? nextEdge : nextEdge + frameMs;
}

export function rasterStatusAt(nowMs: number, height: number, refreshHz: number): RasterStatus {
    const lines = Math.max(1, Math.floor(height) || 480);
    const frameMs = 1000 / Math.max(1, refreshHz || 60);
    const posInFrame = ((nowMs % frameMs) + frameMs) % frameMs / frameMs;
    return {
        scanLine: Math.min(lines - 1, Math.floor(posInFrame * lines)),
        inVBlank: posInFrame < VBLANK_FRACTION,
    };
}
