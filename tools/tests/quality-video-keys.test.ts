/**
 * The movie-decode quality knobs (videoChroma / videoDither / videoDeinterlace): validated
 * like every other QualityConfig key, mapped to the decoder's ENH_* word, and never counted
 * as a graphics-backend gap — the VideoEngine consumes them, not the backend.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { DEFAULT_QUALITY, mergeQuality, parseStoredQuality } from "../../src/worker/core/quality-config";
import {
    VIDEO_QUALITY_KEYS, UNIVERSAL_QUALITY_KEYS,
    registerBackendQualitySupport, computeQualityGaps, resetQualityCapabilitiesForTest,
} from "../../src/worker/backends/webgpu/shared/quality-capabilities";
import {
    videoEnhancementFlags, ENH_CHROMA_SMOOTH, ENH_DITHER_16, ENH_DEINTERLACE, ENH_DEINTERLACE_FORCE,
} from "../../src/video/video-engine";

describe("quality video keys", () => {
    beforeEach(() => resetQualityCapabilitiesForTest());

    test("defaults are the period-faithful conversion (flag word 0)", () => {
        expect(DEFAULT_QUALITY.videoChroma).toBe("nearest");
        expect(DEFAULT_QUALITY.videoDither).toBe(false);
        expect(DEFAULT_QUALITY.videoDeinterlace).toBe("off");
        expect(videoEnhancementFlags(DEFAULT_QUALITY)).toBe(0);
    });

    test("mergeQuality accepts the enumerations and refuses anything else", () => {
        const q = mergeQuality(DEFAULT_QUALITY, { videoChroma: "smooth", videoDither: 1 as unknown as boolean, videoDeinterlace: "always" });
        expect(q.videoChroma).toBe("smooth");
        expect(q.videoDither).toBe(true);
        expect(q.videoDeinterlace).toBe("always");
        const bad = mergeQuality(q, { videoChroma: "lanczos" as never, videoDeinterlace: "yadif" as never });
        expect(bad.videoChroma).toBe("smooth");
        expect(bad.videoDeinterlace).toBe("always");
    });

    test("a stored blob without the keys parses to the defaults", () => {
        const q = parseStoredQuality(JSON.stringify({ schema: 2, anisotropy: 4 }));
        expect(q.videoChroma).toBe("nearest");
        expect(q.videoDither).toBe(false);
        expect(q.videoDeinterlace).toBe("off");
    });

    test("each knob sets exactly its ENH_* bits", () => {
        expect(videoEnhancementFlags({ videoChroma: "smooth", videoDither: false, videoDeinterlace: "off" })).toBe(ENH_CHROMA_SMOOTH);
        expect(videoEnhancementFlags({ videoChroma: "nearest", videoDither: true, videoDeinterlace: "off" })).toBe(ENH_DITHER_16);
        expect(videoEnhancementFlags({ videoChroma: "nearest", videoDither: false, videoDeinterlace: "auto" })).toBe(ENH_DEINTERLACE);
        expect(videoEnhancementFlags({ videoChroma: "nearest", videoDither: false, videoDeinterlace: "always" }))
            .toBe(ENH_DEINTERLACE | ENH_DEINTERLACE_FORCE);
    });

    test("video keys are neither universal nor a backend gap", () => {
        for (const k of VIDEO_QUALITY_KEYS) expect(UNIVERSAL_QUALITY_KEYS.has(k)).toBe(false);
        registerBackendQualitySupport("ddraw", []);
        const gaps = computeQualityGaps({ ...DEFAULT_QUALITY, videoChroma: "smooth", videoDither: true, videoDeinterlace: "always", msaa: 4 });
        // The positive control: a real GPU knob the backend did not declare IS a gap.
        expect(gaps).toEqual(["msaa"]);
    });
});
