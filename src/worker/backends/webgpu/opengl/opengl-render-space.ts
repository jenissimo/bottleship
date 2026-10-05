/**
 * Guest drawable space → the scaled render target.
 *
 * glViewport and glScissor are given in the guest's own drawable pixels with the origin at
 * the BOTTOM-left; the colour target holds `drawable x renderScale` samples with the origin
 * at the top-left. Both rects therefore need the same two corrections — the Y flip and the
 * one uniform scale — and getting them out of step is precisely the class of bug that puts
 * a 640x480 game in a corner of its own render target.
 *
 * Pure, so the arithmetic is pinned by a test instead of by a screenshot.
 */

export interface RenderRect { x: number; y: number; w: number; h: number; }

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : Math.round(v));

/**
 * The WebGPU viewport for a GL viewport of `vpW x vpH` at `(vpX, vpY)`.
 *
 * A rect that fitted the drawable must still fit after rounding; one that did NOT is the
 * guest's own out-of-range viewport and is passed through as it was, because clamping it
 * would silently change the NDC mapping the guest set up.
 */
export function viewportRect(
    vpX: number, vpY: number, vpW: number, vpH: number,
    guestW: number, guestH: number, scale: number, renderW: number, renderH: number,
): RenderRect | null {
    const topY = guestH - vpY - vpH;
    const x = Math.round(vpX * scale);
    const y = Math.round(topY * scale);
    let w = Math.max(1, Math.round(vpW * scale));
    let h = Math.max(1, Math.round(vpH * scale));
    if (vpX >= 0 && vpX + vpW <= guestW) w = Math.min(w, renderW - x);
    if (topY >= 0 && topY + vpH <= guestH) h = Math.min(h, renderH - y);
    return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * The WebGPU scissor for a GL scissor box of `sw x sh` at `(sx, sy)`, or null when it
 * clips away entirely (the draw is then skipped, as GL would).
 *
 * Clamped in GUEST space first, so the scaled rect is inside the target by construction.
 */
export function scissorRect(
    sx: number, sy: number, sw: number, sh: number,
    guestW: number, guestH: number, scale: number, renderW: number, renderH: number,
): RenderRect | null {
    const gw = Math.max(0, sw), gh = Math.max(0, sh);
    const gx = clampInt(sx, 0, guestW);
    const gy = clampInt(guestH - (sy + gh), 0, guestH);
    const cw = clampInt(gw, 0, guestW - gx);
    const ch = clampInt(gh, 0, guestH - gy);
    if (cw <= 0 || ch <= 0) return null;

    const x = clampInt(gx * scale, 0, renderW);
    const y = clampInt(gy * scale, 0, renderH);
    const w = clampInt(cw * scale, 0, renderW - x);
    const h = clampInt(ch * scale, 0, renderH - y);
    return w > 0 && h > 0 ? { x, y, w, h } : null;
}
