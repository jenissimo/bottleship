/**
 * Synthetic raster status shared by IDirectDraw::GetScanLine and
 * ::GetVerticalBlankStatus (identical in every interface version).
 *
 * The beam position must keep moving and the vertical-blank flag must keep
 * toggling: the SDK-standard frame sync is a two-phase spin
 * (`do {} while (inVB); do {} while (!inVB);`), which never terminates if the
 * answer is constant — or if the out-parameter is left uninitialised.
 */

/** Vertical blanking as a fraction of the refresh period (~45 of 525 VGA lines). */
const VBLANK_FRACTION = 2 / (1000 / 60);

export interface RasterStatus {
    /** 0 <= scanLine < height. */
    scanLine: number;
    inVBlank: boolean;
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
