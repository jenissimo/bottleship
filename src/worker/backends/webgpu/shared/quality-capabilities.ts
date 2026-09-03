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
 *    aspect/integer-scale presentation, the example scanline/CRT effects, HDR output).
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

export type QualityKey = keyof QualityConfig;

export const UNIVERSAL_QUALITY_KEYS: ReadonlySet<QualityKey> = new Set<QualityKey>([
    "brightness", "contrast", "saturation", "postAA", "tonemap", "vignette",
    "integerScale", "aspectMode", "scanlines", "crt", "hdr",
]);

interface RegisteredBackend {
    backend: string;
    supports: ReadonlySet<QualityKey>;
}

let active: RegisteredBackend | null = null;
/** `${backend}:${key}` tokens already logged — one warning per gap, not per frame. */
const warnedGaps = new Set<string>();

/**
 * Declare the GPU-resident quality keys `backend` actually reads on its render path.
 * Call once, from the backend executor's constructor (it is reconstructed per game
 * load, so this naturally tracks whichever backend is currently active).
 */
export function registerBackendQualitySupport(backend: string, supports: readonly QualityKey[]): void {
    active = { backend, supports: new Set(supports) };
}

/** The backend currently driving the frame, or null before any executor has registered. */
export function activeQualityBackend(): string | null {
    return active?.backend ?? null;
}

/** Test-only: drop the registration so an isolated test doesn't inherit another suite's. */
export function resetQualityCapabilitiesForTest(): void {
    active = null;
    warnedGaps.clear();
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
        if (UNIVERSAL_QUALITY_KEYS.has(key)) continue;
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
