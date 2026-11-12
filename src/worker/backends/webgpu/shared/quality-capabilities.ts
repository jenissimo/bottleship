/**
 * Quality-config capability contract — the seam between the ONE QualityConfig
 * (core/quality-config.ts) and the FIVE graphics backends (glide/ddraw/d3d8/d3d9/opengl),
 * each with its own render-target/present path.
 *
 * A quality knob only reaches guest pixels if something on the active backend's draw
 * path actually reads it. Historically that has silently drifted: `internalScale` had a
 * UI slider and a merged/clamped config value with ZERO consumers anywhere. This is the
 * same defect class CLAUDE.md calls out for instruments ("a check reporting a plausible
 * number while measuring something other than its label") applied to settings: a control
 * that visibly moves and provably does nothing is worse than no control, because it reads
 * as confirmation the feature works.
 *
 * Two tiers of keys:
 *  - UNIVERSAL: the present-pass family (gamma/color-grade, FXAA, tonemap, vignette,
 *    aspect/integer-scale presentation, the example scanline/CRT effects).
 *    Every backend's final "blit the frame to the canvas" call routes through the ONE
 *    PostFxChain (see post-fx-chain.ts), so these are supported by construction and no
 *    backend needs to declare them.
 *  - BACKEND-DECLARED: GPU-resident knobs a backend's own render path must implement
 *    (sampler anisotropy/trilinear, MSAA, auto-mipmap, internal-resolution supersample).
 *    Each backend executor calls registerBackendQualitySupport() once (constructor) with
 *    the keys it actually reads. Anything else, if the user sets it away from default,
 *    is a GAP — surfaced via logQualityGapsOnce() and the harness report, never silently
 *    dropped.
 *
 * Exactly one graphics backend executor is alive per running game (the API the title
 * asked for), so "last registration wins" is the whole model — no need to track a
 * backend that isn't currently driving the frame.
 */

import { DEFAULT_QUALITY, QualityConfig } from "../../../core/quality-config";
import { Logger, LogCategory } from "../../../core/logger";
import type { InternalScaleSupport } from "./internal-resolution";

export type QualityKey = keyof QualityConfig;

export const UNIVERSAL_QUALITY_KEYS: ReadonlySet<QualityKey> = new Set<QualityKey>([
    "brightness", "contrast", "saturation", "postAA", "tonemap", "vignette",
    "integerScale", "aspectMode", "scanlines", "crt",
]);

/**
 * Keys the movie decoder consumes (video/video-engine.ts), not a graphics backend: they
 * apply to whatever the VideoEngine decodes regardless of which backend presents it. They
 * are never a backend gap, but they are also not universal — a title that plays its
 * cutscenes through its OWN player DLL (the guest's Escape/Bink code running on the CPU)
 * never hands us a frame, and then nothing here reaches the screen. That gap is reported
 * where it can be seen: `state(['video'])` lists the sessions each knob actually touched.
 */
export const VIDEO_QUALITY_KEYS: ReadonlySet<QualityKey> = new Set<QualityKey>([
    "videoChroma", "videoDither", "videoDeinterlace",
]);

interface RegisteredBackend {
    backend: string;
    supports: ReadonlySet<QualityKey>;
    /**
     * What `internalScale = 0` ("Auto") renders at on this backend. Every backend but D3D9
     * fits the canvas and supersamples on top (internal-resolution.ts); D3D9 pins Auto to
     * 1x, because it exposes its raster sample grid through occlusion queries and a
     * fractional supersample changes edge coverage. That difference is invisible in
     * `supports` — the key is declared either way — but it decides what the panel may
     * honestly claim, so it is declared here rather than inferred from the backend name.
     */
    autoInternalScale: "fit" | "native";
}

/** Options a backend may declare alongside the keys it reads. */
interface BackendQualityOptions {
    /** Defaults to "fit": Auto follows the canvas and supersamples on top of it. */
    autoInternalScale?: "fit" | "native";
}

let active: RegisteredBackend | null = null;
/** `${backend}:${key}` tokens already logged — one warning per gap, not per frame. */
const warnedGaps = new Set<string>();

/**
 * Declare the GPU-resident quality keys `backend` actually reads on its render path.
 * Call once, from the backend executor's constructor (it is reconstructed per game
 * load, so this naturally tracks whichever backend is currently active).
 */
export function registerBackendQualitySupport(
    backend: string, supports: readonly QualityKey[], options: BackendQualityOptions = {},
): void {
    const autoInternalScale = options.autoInternalScale ?? "fit";
    // A re-registration that only changes how Auto is honoured still changes what the
    // panel has to say about the setting, so it has to be announced like a backend switch.
    const changed = active?.backend !== backend || active?.autoInternalScale !== autoInternalScale;
    active = { backend, supports: new Set(supports), autoInternalScale };
    // A backend registers when the GUEST opens its graphics API — long after the host's
    // last set_quality. Gaps computed before that answered for a different backend (or for
    // none at all), and nothing recomputed them, so the UI kept showing a stale verdict
    // about a backend that was no longer running. Announce the change instead.
    if (changed) for (const fn of backendListeners) fn(backend);
}

type BackendListener = (backend: string) => void;
const backendListeners = new Set<BackendListener>();

/** Notify when the backend driving the frame changes, so gap answers can be refreshed. */
export function onQualityBackendChanged(fn: BackendListener): () => void {
    backendListeners.add(fn);
    return () => backendListeners.delete(fn);
}

/** The backend currently driving the frame, or null before any executor has registered. */
export function activeQualityBackend(): string | null {
    return active?.backend ?? null;
}

/**
 * Whether the active backend applies `internalScale` at all, and what Auto means there.
 *
 * `computeQualityGaps` cannot answer this: it reports keys the user moved AWAY from their
 * default, so a backend that never reads `internalScale` is silent for as long as the
 * setting stays on Auto (0) — which is the default, i.e. always, for anyone who has not
 * touched it. The panel used that silence as "supported" and printed a multiplier for a
 * render target that does not exist (ddraw renders 640x480 and was labelled 4.00x).
 * Support has to be answered from the declaration, not from whether the value is a gap.
 */
export function internalScaleSupport(): InternalScaleSupport {
    return {
        implemented: !!active?.supports.has("internalScale"),
        autoIsNative: active?.autoInternalScale === "native",
    };
}

/** Test-only: drop the registration so an isolated test doesn't inherit another suite's. */
export function resetQualityCapabilitiesForTest(): void {
    active = null;
    warnedGaps.clear();
    backendListeners.clear();
}

/**
 * Non-default keys the active backend does not declare support for. A key still at its
 * DEFAULT_QUALITY value is never a gap — asking for "off" from a backend that cannot
 * turn it "on" is not a misconfiguration, so a backend with zero declarations is silent
 * until the user actually reaches for something it can't do.
 */
export function computeQualityGaps(quality: QualityConfig): QualityKey[] {
    if (!active) return [];
    const gaps: QualityKey[] = [];
    for (const key of Object.keys(DEFAULT_QUALITY) as QualityKey[]) {
        if (UNIVERSAL_QUALITY_KEYS.has(key) || VIDEO_QUALITY_KEYS.has(key)) continue;
        if (active.supports.has(key)) continue;
        if (quality[key] === DEFAULT_QUALITY[key]) continue;
        gaps.push(key);
    }
    return gaps;
}

/**
 * Compute the current gaps and log any NEW ones once (Logger.warn, deduped per
 * backend+key). Called from the set_quality handler so a gap is visible in the log the
 * instant it is created, not only when someone thinks to ask. Returns the full current
 * gap list (including already-logged ones) for the caller to relay to the UI/harness.
 */
export function logQualityGapsOnce(quality: QualityConfig): QualityKey[] {
    const gaps = computeQualityGaps(quality);
    if (!active) return gaps;
    for (const key of gaps) {
        const token = `${active.backend}:${key}`;
        if (warnedGaps.has(token)) continue;
        warnedGaps.add(token);
        Logger.warn(LogCategory.SYSTEM,
            `[QUALITY] "${key}"=${JSON.stringify(quality[key])} requested but the ${active.backend} `
            + `backend does not implement it (ignored — see quality-capabilities.ts)`);
    }
    return gaps;
}
