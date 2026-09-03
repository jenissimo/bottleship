/**
 * Graphics quality configuration — the single source of truth for all user-facing
 * "video / quality" enhancements injected at the HLE → WebGPU translation seam.
 *
 * Lives in core/ (not backends/webgpu/) so both EmulatorConfig (the worker config
 * singleton) and the WebGPU post-process chain can depend on the same type without
 * a layering cycle. Defaults are NEUTRAL: a fresh QualityConfig must reproduce the
 * exact pre-feature behavior (no AF override, identity color, stretch present).
 */

export type AspectMode = "stretch" | "pillarbox" | "integer";
export type PostAA = "off" | "fxaa";
export type ToneMap = "off" | "aces";

export interface QualityConfig {
    // --- Sampler overrides (safe side of the seam — GPU-resident only) ---
    /** 1 = off (use game's own filter); 2/4/8/16 = force anisotropic on linear-filtered textures. */
    anisotropy: number;
    /** Force trilinear (linear mip) on textures that have a mip chain. */
    forceTrilinear: boolean;

    // --- Color grade (consolidated present pass: gamma ⊕ brightness/contrast/sat ⊕ FXAA ⊕ tonemap ⊕ vignette) ---
    /** User multiplier on top of the game gamma ramp. 1.0 = neutral. */
    brightness: number;
    /** Contrast around mid-grey. 1.0 = neutral. */
    contrast: number;
    /** Saturation (lerp toward luma). 1.0 = neutral, 0 = greyscale. */
    saturation: number;
    /** Post-process AA. Works on everything (incl. 2D / alpha-test edges) but blurs slightly. */
    postAA: PostAA;
    /** Filmic tonemap applied before gamma. */
    tonemap: ToneMap;
    /** Vignette strength 0 (off) .. 1. */
    vignette: number;

    // --- Presentation scaling (display-only; guest still thinks in its own res) ---
    /** Snap the present rect to the largest integer multiple of the source that fits. */
    integerScale: boolean;
    /** stretch (fill), pillarbox (preserve source AR, letterbox), integer (implies integerScale). */
    aspectMode: AspectMode;

    // --- Example / community post effects (separate chain passes) ---
    /** CRT scanline overlay (example effect template). */
    scanlines: boolean;
    /** Full CRT emulation: scanlines + aperture mask + curvature (example effect template). */
    crt: boolean;

    // --- GPU-resident precision / AA (config reserved, staged impl) ---
    /** Multi-sample AA for 3D geometry edges: 1/2/4. */
    msaa: number;
    /**
     * Internal-resolution factor for GPU-resident 3D: 0/1/2/4. 0 ("Auto", the default)
     * tracks the canvas's own physical-pixel size; 1 ("Native") forces exactly the guest's
     * own resolution (no supersample, the compatibility/low-power fallback); 2/4 are a
     * fixed multiplier of the guest's resolution regardless of canvas size — see
     * backends/webgpu/shared/internal-resolution.ts for the split.
     */
    internalScale: number;
    /** Auto-generate mip chains on texture upload (prereq for trilinear/AF to bite). */
    autoMipmap: boolean;
}

export const DEFAULT_QUALITY: QualityConfig = {
    anisotropy: 1,
    forceTrilinear: false,
    brightness: 1.0,
    contrast: 1.0,
    saturation: 1.0,
    postAA: "off",
    tonemap: "off",
    vignette: 0.0,
    integerScale: false,
    aspectMode: "stretch",
    scanlines: false,
    crt: false,
    msaa: 1,
    internalScale: 0,
    autoMipmap: false,
};

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
}

/** Snap to the nearest allowed value in `allowed` (used for anisotropy / msaa / internalScale). */
function snapTo(v: unknown, allowed: readonly number[], dflt: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    let best = allowed[0];
    let bestD = Infinity;
    for (const a of allowed) {
        const d = Math.abs(a - n);
        if (d < bestD) { bestD = d; best = a; }
    }
    return best;
}

const ANISO_STEPS = [1, 2, 4, 8, 16] as const;
const SAMPLE_STEPS = [1, 2, 4] as const;
/** internalScale's own steps: 0 ("Auto") is a valid value here but never for msaa. */
const INTERNAL_SCALE_STEPS = [0, 1, 2, 4] as const;
const ASPECT_MODES: readonly AspectMode[] = ["stretch", "pillarbox", "integer"];
const POST_AA: readonly PostAA[] = ["off", "fxaa"];
const TONEMAPS: readonly ToneMap[] = ["off", "aces"];

/**
 * Validate + clamp an untrusted partial (from manifest JSON, host UI, or dbg console)
 * and merge it onto `base`, returning a NEW QualityConfig. Unknown keys are ignored;
 * out-of-range values are clamped/snapped rather than rejected.
 */
export function mergeQuality(base: QualityConfig, partial: Partial<QualityConfig> | null | undefined): QualityConfig {
    if (!partial || typeof partial !== "object") return { ...base };
    const out: QualityConfig = { ...base };

    if ("anisotropy" in partial) out.anisotropy = snapTo(partial.anisotropy, ANISO_STEPS, base.anisotropy);
    if ("forceTrilinear" in partial) out.forceTrilinear = !!partial.forceTrilinear;
    if ("brightness" in partial) out.brightness = clampNum(partial.brightness, 0, 4, base.brightness);
    if ("contrast" in partial) out.contrast = clampNum(partial.contrast, 0, 4, base.contrast);
    if ("saturation" in partial) out.saturation = clampNum(partial.saturation, 0, 4, base.saturation);
    if ("postAA" in partial) out.postAA = POST_AA.includes(partial.postAA as PostAA) ? partial.postAA as PostAA : base.postAA;
    if ("tonemap" in partial) out.tonemap = TONEMAPS.includes(partial.tonemap as ToneMap) ? partial.tonemap as ToneMap : base.tonemap;
    if ("vignette" in partial) out.vignette = clampNum(partial.vignette, 0, 1, base.vignette);
    if ("integerScale" in partial) out.integerScale = !!partial.integerScale;
    if ("aspectMode" in partial) out.aspectMode = ASPECT_MODES.includes(partial.aspectMode as AspectMode) ? partial.aspectMode as AspectMode : base.aspectMode;
    if ("scanlines" in partial) out.scanlines = !!partial.scanlines;
    if ("crt" in partial) out.crt = !!partial.crt;
    if ("msaa" in partial) out.msaa = snapTo(partial.msaa, SAMPLE_STEPS, base.msaa);
    if ("internalScale" in partial) out.internalScale = snapTo(partial.internalScale, INTERNAL_SCALE_STEPS, base.internalScale);
    if ("autoMipmap" in partial) out.autoMipmap = !!partial.autoMipmap;

    // integerScale and aspectMode:'integer' are two spellings of the same intent — keep them coherent.
    if (out.aspectMode === "integer") out.integerScale = true;

    return out;
}

/**
 * Does this config request ANY color-grade work in the present pass?
 * When false (and no separate effects active), the present collapses to the plain
 * passthrough blit — byte-identical to the pre-feature path.
 */
export function colorGradeActive(q: QualityConfig): boolean {
    return q.brightness !== 1.0
        || q.contrast !== 1.0
        || q.saturation !== 1.0
        || q.postAA !== "off"
        || q.tonemap !== "off"
        || q.vignette > 0.0;
}

/** Bumped when a stored value's MEANING changes, not its range — see parseStoredQuality. */
export const QUALITY_SCHEMA = 2;

/** What the host writes to localStorage: the config plus the marker parseStoredQuality reads. */
export function serializeStoredQuality(q: QualityConfig): string {
    return JSON.stringify({ ...q, schema: QUALITY_SCHEMA });
}

/**
 * Decode the host's persisted quality blob. Lives here, next to mergeQuality, so the
 * meaning of a stored value is defined in ONE place and stays testable without the host.
 *
 * internalScale === 1 used to be the default and did nothing; it now means an explicit
 * "Native, never upscale". Carrying the number forward would pin every existing user to
 * the one value that opts OUT of the feature. A stored 1 written BEFORE this schema
 * existed cannot have been a deliberate choice, so it is dropped back to the default;
 * the marker is what distinguishes it from a Native chosen since.
 */
export function parseStoredQuality(raw: string | null | undefined): QualityConfig {
    if (!raw) return { ...DEFAULT_QUALITY };
    let parsed: (Partial<QualityConfig> & { schema?: unknown }) | null;
    try {
        parsed = JSON.parse(raw) as Partial<QualityConfig> & { schema?: unknown };
    } catch {
        return { ...DEFAULT_QUALITY };
    }
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_QUALITY };
    if (parsed.schema !== QUALITY_SCHEMA && parsed.internalScale === 1) {
        delete parsed.internalScale;
    }
    return mergeQuality(DEFAULT_QUALITY, parsed);
}
