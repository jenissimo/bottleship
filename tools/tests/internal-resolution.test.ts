import { describe, expect, test } from "bun:test";
import { resolveInternalScaleFactor } from "../../src/worker/backends/webgpu/shared/internal-resolution";

describe("resolveInternalScaleFactor", () => {
    test("explicit 2x/4x ignores the canvas entirely", () => {
        expect(resolveInternalScaleFactor(2, 640, 480, 640, 480)).toBe(2);
        expect(resolveInternalScaleFactor(4, 640, 480, 99999, 99999)).toBe(4);
        expect(resolveInternalScaleFactor(2, 640, 480, 100, 100)).toBe(2); // even a tiny canvas
    });

    test("native (1) is always exactly 1x, even with a much larger canvas", () => {
        expect(resolveInternalScaleFactor(1, 640, 480, 640, 480)).toBe(1);
        expect(resolveInternalScaleFactor(1, 640, 480, 1280, 960)).toBe(1);
        expect(resolveInternalScaleFactor(1, 320, 240, 8000, 8000)).toBe(1);
    });

    test("auto (0) with a canvas exactly matching the guest is a no-op (1x)", () => {
        expect(resolveInternalScaleFactor(0, 640, 480, 640, 480)).toBe(1);
    });

    test("auto (0) fits the larger axis-limited dimension, preserving guest AR (one scalar)", () => {
        // 1280x960 canvas over a 640x480 guest — both axes agree, so factor is exactly 2.
        expect(resolveInternalScaleFactor(0, 640, 480, 1280, 960)).toBe(2);
        // Canvas wider than guest AR (ultrawide window): height is the limiting axis.
        // 640x480 guest (4:3) in a 2000x600 canvas -> height-limited: 600/480 = 1.25.
        expect(resolveInternalScaleFactor(0, 640, 480, 2000, 600)).toBeCloseTo(1.25, 5);
        // Canvas taller than guest AR: width is the limiting axis.
        expect(resolveInternalScaleFactor(0, 640, 480, 800, 2000)).toBeCloseTo(800 / 640, 5);
    });

    test("auto never drops BELOW 1x even if the canvas is smaller than the guest mode", () => {
        expect(resolveInternalScaleFactor(0, 1024, 768, 320, 240)).toBe(1);
    });

    test("auto is capped at 4x regardless of how much bigger the canvas is", () => {
        expect(resolveInternalScaleFactor(0, 320, 240, 8000, 8000)).toBe(4);
    });

    test("degenerate inputs fail safe to 1x, never NaN/Infinity/0", () => {
        expect(resolveInternalScaleFactor(0, 0, 480, 1280, 960)).toBe(1);
        expect(resolveInternalScaleFactor(0, 640, 0, 1280, 960)).toBe(1);
        expect(resolveInternalScaleFactor(0, 640, 480, 0, 0)).toBe(1);
        // An unrecognized/NaN setting fails safe to auto-fit, not to a silent no-op.
        expect(resolveInternalScaleFactor(Number.NaN, 640, 480, 1280, 960)).toBe(2);
    });
});
