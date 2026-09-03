/**
 * Internal render-target sizing for `quality.internalScale` — shared by every backend that
 * renders 3D geometry into an offscreen target before the present pass (post-fx/post-fx-
 * chain.ts) scales it onto the canvas. The guest never sees this: its own logical
 * resolution (grSstScreenWidth/Height for Glide, the DDraw primary surface dims, the D3D9
 * backbuffer dims) stays exactly what it asked for — this only decides how many PHYSICAL
 * pixels that logical frame gets rendered at before the present pass fits it to the canvas.
 *
 * `quality.internalScale` (quality-config.ts) has three regimes:
 *   - 2 or 4: a FIXED supersample multiplier of the guest's own resolution. Independent of
 *     window size/DPI — always 2x/4x, whatever the canvas is doing. This is the path Glide
 *     shipped and verified live (a 640x480 guest renders at 1280x960 at any window size).
 *   - 1 ("Native"): forces exactly 1x — the guest's own resolution, no supersample at all —
 *     regardless of canvas size. The compatibility/low-power fallback: predictable cost,
 *     and an escape hatch if a title's own post-process (LFB reads, screen-space effects)
 *     turns out to assume the render target IS the logical resolution.
 *   - 0 ("Auto", the default): follow the canvas's own physical-pixel size instead of a
 *     fixed multiplier, so the internal target is only ever as big as the display can
 *     actually show, and tracks the window/DPI as they change. Without this, "internal
 *     resolution" and "presentation resolution" are two unrelated numbers: a fixed-size
 *     render permanently downsamples into a differently-sized canvas, which reads as
 *     cleaner edges but never as MORE resolution — the gap Auto closes.
 */

/**
 * The single uniform scale factor to render `guestWidth x guestHeight` at, given the
 * canvas's own physical-pixel size and the user's `internalScale` setting.
 *
 * Always ONE scalar applied identically to both axes — never independent width/height
 * fits. Every guest-space quantity (vertices, clip rects, the LFB image) lives in the
 * guest's own logical coordinate space; a non-uniform scale would distort the picture the
 * guest believes it drew, where a uniform one only asks the rasterizer for more samples
 * per logical pixel.
 */
export function resolveInternalScaleFactor(
    internalScaleSetting: number,
    guestWidth: number,
    guestHeight: number,
    canvasWidth: number,
    canvasHeight: number,
): number {
    const n = Number(internalScaleSetting);
    if (Number.isFinite(n) && n >= 2) {
        return Math.max(1, Math.min(4, Math.round(n)));
    }
    // Native (1): exact guest resolution, no auto-fit — an explicit request, not a fallback.
    if (n === 1) return 1;
    // 0 ("Auto") and any other degenerate/unrecognized value fail safe to auto-fit rather
    // than to a silent no-op, matching DEFAULT_QUALITY.internalScale (0).
    if (guestWidth <= 0 || guestHeight <= 0 || canvasWidth <= 0 || canvasHeight <= 0) return 1;
    const fit = Math.min(canvasWidth / guestWidth, canvasHeight / guestHeight);
    // Never below 1x — auto only ADDS resolution; a canvas transiently smaller than the
    // guest mode (e.g. before host CSS layout has settled after a resize) must not blur the
    // picture below what the game itself asked for. Capped at 4x to match the
    // explicit-multiplier ceiling: past that, GPU cost (factor² pixels) outruns any benefit
    // a display can actually show.
    return Math.max(1, Math.min(4, fit));
}
