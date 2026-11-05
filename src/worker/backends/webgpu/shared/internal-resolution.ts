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
 *   - 0 ("Auto", the default): follow the canvas's own physical-pixel size AND supersample
 *     on top of it, so the picture tracks the window/DPI instead of a fixed multiplier that
 *     is too small on a large display and wasted on a small one. Fitting alone is not
 *     enough: it makes the render target exactly the present target, one rendered sample
 *     per presented pixel, so there is nothing to resolve and edges stay aliased — which
 *     reads as the final picture being scaled rather than as a detailed one. Auto therefore
 *     fits AND multiplies, and the present pass resolves back down.
 */

/**
 * Samples per presented pixel, per axis, that "Auto" asks for on top of the canvas fit.
 * 2 is the whole useful range here: it costs 4x the pixels for the edge quality a 1x fit
 * cannot produce at all, while the MAX_SCALE ceiling keeps that bounded on the guest
 * modes where the fit is already large.
 */
const AUTO_SUPERSAMPLE = 2;

/** Ceiling for every regime — past this, cost (factor squared) outruns what a display shows. */
const MAX_SCALE = 4;

/**
 * What a backend declared about `internalScale`. Answered by the backend's own registration
 * (shared/quality-capabilities.ts) and carried to the host with the quality ack, so the
 * panel never has to guess from the backend's name.
 */
export interface InternalScaleSupport {
    /** Whether the backend's render path reads `internalScale` at all. */
    implemented: boolean;
    /** Whether Auto (0) means "guest resolution", not "fit the canvas and supersample". */
    autoIsNative: boolean;
}

/**
 * What a backend will actually render at, given what it can honour.
 *
 * `resolveInternalScaleFactor` answers "what would this setting mean if the backend applied
 * it". The panel cannot use that answer alone: a backend that never reads `internalScale`
 * renders the guest's own resolution whatever is asked for, and D3D9 reads the setting but
 * maps Auto (0) to Native for a documented reason of its own (its occlusion queries expose
 * the raster sample grid, so fractional supersampling changes edge coverage). Both used to
 * be reported as if the setting had been applied — ddraw at 640x480 was labelled "4.00x".
 *
 * So this takes the backend's answer as a parameter rather than guessing it, and returns
 * `applied: false` where nothing reads the setting at all: the honest label there is "the
 * game still renders at WxH", not a multiplier that never happened.
 */
export function resolveEffectiveInternalScale(
    internalScaleSetting: number,
    guestWidth: number,
    guestHeight: number,
    canvasWidth: number,
    canvasHeight: number,
    support: InternalScaleSupport,
): { applied: boolean; factor: number } {
    if (!support.implemented) return { applied: false, factor: 1 };
    const n = Number(internalScaleSetting);
    // Auto is the default, and the one regime a backend may reinterpret: D3D9 pins it to 1x.
    if (support.autoIsNative && !(Number.isFinite(n) && n >= 1)) {
        return { applied: true, factor: 1 };
    }
    return {
        applied: true,
        factor: resolveInternalScaleFactor(internalScaleSetting, guestWidth, guestHeight, canvasWidth, canvasHeight),
    };
}

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
        return Math.max(1, Math.min(MAX_SCALE, Math.round(n)));
    }
    // Native (1): exact guest resolution, no auto-fit — an explicit request, not a fallback.
    if (n === 1) return 1;
    // 0 ("Auto") and any other degenerate/unrecognized value fail safe to auto-fit rather
    // than to a silent no-op, matching DEFAULT_QUALITY.internalScale (0).
    // Written as a POSITIVE test so a NaN extent fails it: `NaN <= 0` is false, and a NaN
    // fit propagates through both clamps to a NaN scale, which sizes a texture to nothing.
    if (!(guestWidth > 0) || !(guestHeight > 0) || !(canvasWidth > 0) || !(canvasHeight > 0)) return 1;
    const fit = Math.min(canvasWidth / guestWidth, canvasHeight / guestHeight);
    // Never below 1x — auto only ADDS resolution; a canvas transiently smaller than the
    // guest mode (e.g. before host CSS layout has settled after a resize) must not blur the
    // picture below what the game itself asked for. The supersample rides on the FIT, not on
    // the guest mode, so one setting behaves the same way on every window size.
    return Math.max(1, Math.min(MAX_SCALE, fit * AUTO_SUPERSAMPLE));
}
