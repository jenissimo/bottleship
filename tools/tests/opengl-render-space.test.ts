import { describe, expect, test } from "bun:test";
import { scissorRect, viewportRect } from "../../src/worker/backends/webgpu/opengl/opengl-render-space";

/**
 * The guest viewport/scissor are GL drawable pixels with a bottom-left origin; the render
 * target is that drawable times one internal-scale scalar, top-left origin. These pin both
 * corrections together — a Y flip measured against the RENDER height instead of the guest
 * one, or a rect that forgets the scale, puts the picture in a corner of its own target.
 */

const G = { w: 640, h: 480 };

describe("viewportRect", () => {
    test("scale 1 is the pre-feature mapping: flip only", () => {
        expect(viewportRect(0, 0, 640, 480, G.w, G.h, 1, 640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
        // A 200-tall strip at GL y=100 sits 480-100-200 = 180 from the top.
        expect(viewportRect(50, 100, 300, 200, G.w, G.h, 1, 640, 480)).toEqual({ x: 50, y: 180, w: 300, h: 200 });
    });

    test("every component follows the SAME scalar", () => {
        expect(viewportRect(50, 100, 300, 200, G.w, G.h, 2, 1280, 960))
            .toEqual({ x: 100, y: 360, w: 600, h: 400 });
        expect(viewportRect(0, 0, 640, 480, G.w, G.h, 4, 2560, 1920))
            .toEqual({ x: 0, y: 0, w: 2560, h: 1920 });
    });

    test("the flip is measured in GUEST height, never render height", () => {
        // If the flip used the render height the top offset would be 960-100-200 = 660,
        // scaled or not — the sub-rect would land off the bottom of the picture.
        const r = viewportRect(0, 100, 640, 200, G.w, G.h, 2, 1280, 960)!;
        expect(r.y).toBe((480 - 100 - 200) * 2);
    });

    test("a full-drawable viewport still fits after a fractional scale rounds", () => {
        const scale = 1.6125;
        const rw = Math.round(G.w * scale), rh = Math.round(G.h * scale);
        const r = viewportRect(0, 0, 640, 480, G.w, G.h, scale, rw, rh)!;
        expect(r.x + r.w).toBeLessThanOrEqual(rw);
        expect(r.y + r.h).toBeLessThanOrEqual(rh);
        expect(r.w).toBe(rw);
        expect(r.h).toBe(rh);
    });

    test("a guest viewport that already overhangs the drawable is passed through, not clamped", () => {
        // Clamping it would change the NDC mapping the guest set up; it was out of range
        // before the scale existed and stays exactly as out of range.
        const r = viewportRect(0, 0, 800, 480, G.w, G.h, 2, 1280, 960)!;
        expect(r.w).toBe(1600);
    });
});

describe("scissorRect", () => {
    test("scale 1 is the pre-feature mapping", () => {
        expect(scissorRect(0, 0, 640, 480, G.w, G.h, 1, 640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
        expect(scissorRect(10, 20, 100, 50, G.w, G.h, 1, 640, 480))
            .toEqual({ x: 10, y: 480 - 70, w: 100, h: 50 });
    });

    test("the scaled box is the same picture region", () => {
        expect(scissorRect(10, 20, 100, 50, G.w, G.h, 4, 2560, 1920))
            .toEqual({ x: 40, y: (480 - 70) * 4, w: 400, h: 200 });
    });

    test("an out-of-range box is clamped in GUEST space, so the scaled one is inside by construction", () => {
        const r = scissorRect(600, 0, 200, 480, G.w, G.h, 2, 1280, 960)!;
        expect(r.x).toBe(1200);
        expect(r.x + r.w).toBeLessThanOrEqual(1280);
    });

    test("a box that clips away entirely is null at every scale", () => {
        for (const s of [1, 2, 4]) {
            expect(scissorRect(700, 0, 100, 100, G.w, G.h, s, 640 * s, 480 * s)).toBeNull();
            expect(scissorRect(0, 0, 0, 100, G.w, G.h, s, 640 * s, 480 * s)).toBeNull();
        }
    });

    test("a fractional scale keeps the box inside the target", () => {
        const scale = 1.6125;
        const rw = Math.round(G.w * scale), rh = Math.round(G.h * scale);
        for (const box of [[0, 0, 640, 480], [320, 240, 320, 240], [639, 479, 1, 1]]) {
            const r = scissorRect(box[0], box[1], box[2], box[3], G.w, G.h, scale, rw, rh)!;
            expect(r.x).toBeGreaterThanOrEqual(0);
            expect(r.y).toBeGreaterThanOrEqual(0);
            expect(r.x + r.w).toBeLessThanOrEqual(rw);
            expect(r.y + r.h).toBeLessThanOrEqual(rh);
        }
    });
});
