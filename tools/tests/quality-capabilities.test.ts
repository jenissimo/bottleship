import { describe, expect, test, beforeEach } from "bun:test";
import { DEFAULT_QUALITY, type QualityConfig } from "../../src/worker/core/quality-config";
import {
    UNIVERSAL_QUALITY_KEYS,
    registerBackendQualitySupport,
    activeQualityBackend,
    computeQualityGaps,
    logQualityGapsOnce,
    resetQualityCapabilitiesForTest,
    onQualityBackendChanged,
} from "../../src/worker/backends/webgpu/shared/quality-capabilities";

function withOverride(patch: Partial<QualityConfig>): QualityConfig {
    return { ...DEFAULT_QUALITY, ...patch };
}

describe("quality-capabilities", () => {
    beforeEach(() => {
        resetQualityCapabilitiesForTest();
    });

    test("no registration -> no gaps, no active backend", () => {
        expect(activeQualityBackend()).toBeNull();
        expect(computeQualityGaps(withOverride({ msaa: 4 }))).toEqual([]);
    });

    test("a default-valued config is never a gap, even for a fully unsupported key", () => {
        registerBackendQualitySupport("glide", ["internalScale"]);
        // msaa is at DEFAULT_QUALITY.msaa (1) — untouched, so it must not be flagged
        // even though "glide" never declared it.
        expect(computeQualityGaps(DEFAULT_QUALITY)).toEqual([]);
    });

    test("a non-default key the backend did not declare is a gap", () => {
        registerBackendQualitySupport("glide", ["internalScale"]);
        const gaps = computeQualityGaps(withOverride({ msaa: 4, anisotropy: 8 }));
        expect(gaps).toContain("msaa");
        expect(gaps).toContain("anisotropy");
    });

    test("a declared key never appears as a gap regardless of value", () => {
        registerBackendQualitySupport("glide", ["internalScale"]);
        const gaps = computeQualityGaps(withOverride({ internalScale: 4 }));
        expect(gaps).not.toContain("internalScale");
    });

    test("universal (post-fx) keys are never gaps for any backend", () => {
        registerBackendQualitySupport("glide", []); // declares nothing GPU-resident
        const q = withOverride({
            brightness: 1.5, contrast: 1.2, saturation: 0.5, postAA: "fxaa",
            tonemap: "aces", vignette: 0.4, integerScale: true, aspectMode: "pillarbox",
            scanlines: true, crt: true,
        });
        expect(computeQualityGaps(q)).toEqual([]);
        for (const key of UNIVERSAL_QUALITY_KEYS) {
            expect(DEFAULT_QUALITY).toHaveProperty(key as string);
        }
    });

    test("re-registration (fresh game load) replaces the previous backend, not merges it", () => {
        registerBackendQualitySupport("ddraw", ["anisotropy", "forceTrilinear", "autoMipmap", "msaa"]);
        registerBackendQualitySupport("glide", ["internalScale"]);
        expect(activeQualityBackend()).toBe("glide");
        // ddraw's msaa support does not carry over to the glide registration.
        expect(computeQualityGaps(withOverride({ msaa: 4 }))).toContain("msaa");
    });

    test("logQualityGapsOnce returns the live gap list every call (not just the first)", () => {
        registerBackendQualitySupport("opengl", ["anisotropy", "forceTrilinear"]);
        const q = withOverride({ msaa: 4 });
        expect(logQualityGapsOnce(q)).toEqual(["msaa"]);
        expect(logQualityGapsOnce(q)).toEqual(["msaa"]); // still reported, just not re-logged
    });

    test("glide only declares internalScale — every other GPU-resident knob is an honest gap", () => {
        registerBackendQualitySupport("glide", ["internalScale"]);
        const q = withOverride({ anisotropy: 16, forceTrilinear: true, autoMipmap: true, msaa: 4 });
        const gaps = new Set(computeQualityGaps(q));
        expect(gaps.has("anisotropy")).toBe(true);
        expect(gaps.has("forceTrilinear")).toBe(true);
        expect(gaps.has("autoMipmap")).toBe(true);
        expect(gaps.has("msaa")).toBe(true);
        expect(gaps.has("internalScale")).toBe(false);
    });
});

describe("backend-change notification", () => {
    beforeEach(() => resetQualityCapabilitiesForTest());

    // The guest opens its graphics API long after the host's last set_quality, so gaps
    // computed once describe a backend that is no longer rendering — which is exactly how
    // the UI came to warn "unsupported" about a knob the live backend does support.
    test("fires when the backend driving the frame changes", () => {
        const seen: string[] = [];
        onQualityBackendChanged((b) => seen.push(b));

        registerBackendQualitySupport("ddraw", ["msaa"]);
        registerBackendQualitySupport("glide", ["internalScale"]);
        expect(seen).toEqual(["ddraw", "glide"]);
    });

    test("a re-registration of the SAME backend is not a change", () => {
        const seen: string[] = [];
        registerBackendQualitySupport("glide", ["internalScale"]);
        onQualityBackendChanged((b) => seen.push(b));
        registerBackendQualitySupport("glide", ["internalScale"]);
        expect(seen).toEqual([]);
    });

    test("the gap answer follows the new backend, not the one that first registered", () => {
        const q = withOverride({ internalScale: 4 });
        registerBackendQualitySupport("ddraw", ["msaa"]);
        expect(computeQualityGaps(q)).toContain("internalScale");

        let refreshed: string[] = [];
        onQualityBackendChanged(() => { refreshed = computeQualityGaps(q); });
        registerBackendQualitySupport("glide", ["internalScale"]);
        expect(refreshed).toEqual([]);
    });

    test("unsubscribing stops the notifications", () => {
        const seen: string[] = [];
        const off = onQualityBackendChanged((b) => seen.push(b));
        registerBackendQualitySupport("ddraw", []);
        off();
        registerBackendQualitySupport("glide", []);
        expect(seen).toEqual(["ddraw"]);
    });
});
