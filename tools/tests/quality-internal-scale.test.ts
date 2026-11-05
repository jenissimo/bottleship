/**
 * `internalScale` is the one quality key whose default (Auto, 0) is a real request rather
 * than "off", so "is it a gap" cannot answer "will the backend apply it". These pin the
 * separate answer the panel labels the resolution with (issue #97): a backend that never
 * reads the setting must not be reported as rendering above the guest's own resolution,
 * and D3D9's Auto must be reported as the 1x it actually renders at.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { DEFAULT_QUALITY } from "../../src/worker/core/quality-config";
import {
    registerBackendQualitySupport,
    computeQualityGaps,
    internalScaleSupport,
    resetQualityCapabilitiesForTest,
    onQualityBackendChanged,
} from "../../src/worker/backends/webgpu/shared/quality-capabilities";
import {
    resolveInternalScaleFactor,
    resolveEffectiveInternalScale,
} from "../../src/worker/backends/webgpu/shared/internal-resolution";

// 640x480 guest in a 2560x1920 canvas: a 4x fit, doubled by Auto's supersample, clamped
// back to 4 — the exact shape of the "currently 2560x1920 (4.00x)" the panel used to print
// for backends that render 640x480.
const GUEST_W = 640;
const GUEST_H = 480;
const CANVAS_W = 2560;
const CANVAS_H = 1920;

function effective(setting: number) {
    return resolveEffectiveInternalScale(
        setting, GUEST_W, GUEST_H, CANVAS_W, CANVAS_H, internalScaleSupport(),
    );
}

/** The panel's own arithmetic, so the target size is checked, not only the factor. */
function target(setting: number): { w: number; h: number; applied: boolean } {
    const e = effective(setting);
    return { w: Math.round(GUEST_W * e.factor), h: Math.round(GUEST_H * e.factor), applied: e.applied };
}

describe("internal scale support", () => {
    beforeEach(() => {
        resetQualityCapabilitiesForTest();
    });
    // The registry is process-wide: a declared backend and its listeners must not leak into
    // whichever file runs next.
    afterEach(() => {
        resetQualityCapabilitiesForTest();
    });

    test("no backend registered yet reports nothing implemented", () => {
        expect(internalScaleSupport()).toEqual({ implemented: false, autoIsNative: false });
        expect(effective(0)).toEqual({ applied: false, factor: 1 });
    });

    test("ddraw at Auto renders the guest resolution, not a 4x that does not exist", () => {
        // Exactly ddraw-backend-executor.ts's declaration: no internalScale.
        registerBackendQualitySupport("ddraw", ["anisotropy", "forceTrilinear", "autoMipmap", "msaa"]);

        expect(internalScaleSupport()).toEqual({ implemented: false, autoIsNative: false });
        // The factor the setting WOULD mean is still 4 — that is why the panel looked right.
        expect(resolveInternalScaleFactor(0, GUEST_W, GUEST_H, CANVAS_W, CANVAS_H)).toBe(4);
        // What it actually renders at.
        expect(effective(0)).toEqual({ applied: false, factor: 1 });
        expect(target(0)).toEqual({ w: 640, h: 480, applied: false });
    });

    test("a backend without internalScale stays unapplied even when the user asks for 4x", () => {
        registerBackendQualitySupport("ddraw", ["anisotropy"]);

        expect(target(4)).toEqual({ w: 640, h: 480, applied: false });
        // …and it is a gap at that point, so the control is labelled unsupported too.
        expect(computeQualityGaps({ ...DEFAULT_QUALITY, internalScale: 4 })).toContain("internalScale");
    });

    test("D3D9's Auto is the 1x it actually renders at", () => {
        // Exactly d3d9-device.ts's declaration. Auto maps to Native there for the
        // occlusion-query sample grid (resolveOffscreenExtent).
        registerBackendQualitySupport("d3d9", ["anisotropy", "forceTrilinear", "msaa", "internalScale"],
            { autoInternalScale: "native" });

        expect(internalScaleSupport()).toEqual({ implemented: true, autoIsNative: true });
        expect(effective(0)).toEqual({ applied: true, factor: 1 });
        expect(target(0)).toEqual({ w: 640, h: 480, applied: true });
    });

    test("D3D9 still honours an explicit 2x/4x", () => {
        registerBackendQualitySupport("d3d9", ["internalScale"], { autoInternalScale: "native" });

        expect(effective(1).factor).toBe(1);
        expect(effective(2).factor).toBe(2);
        expect(target(4)).toEqual({ w: 2560, h: 1920, applied: true });
    });

    test("glide and OpenGL fit the canvas on Auto, so their report stays above 1x", () => {
        for (const backend of ["glide", "opengl"]) {
            resetQualityCapabilitiesForTest();
            registerBackendQualitySupport(backend, ["internalScale"]);

            expect(internalScaleSupport()).toEqual({ implemented: true, autoIsNative: false });
            expect(effective(0).factor).toBe(4);
            expect(target(0)).toEqual({ w: 2560, h: 1920, applied: true });
        }
    });

    test("switching how Auto is honoured re-announces, so the panel does not keep a stale label", () => {
        const seen: string[] = [];
        const off = onQualityBackendChanged((backend) => seen.push(backend));

        registerBackendQualitySupport("d3d9", ["internalScale"], { autoInternalScale: "fit" });
        // Same backend, same keys, different Auto: the label would change, so tell the host.
        registerBackendQualitySupport("d3d9", ["internalScale"], { autoInternalScale: "native" });
        // Identical re-declaration: nothing to say.
        registerBackendQualitySupport("d3d9", ["internalScale"], { autoInternalScale: "native" });
        off();

        expect(seen).toEqual(["d3d9", "d3d9"]);
    });

    test("an unregistered backend after a reset stops claiming support", () => {
        registerBackendQualitySupport("glide", ["internalScale"]);
        expect(internalScaleSupport().implemented).toBe(true);

        resetQualityCapabilitiesForTest();
        expect(internalScaleSupport()).toEqual({ implemented: false, autoIsNative: false });
    });
});
