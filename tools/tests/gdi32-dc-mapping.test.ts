/**
 * The DC coordinate mapping DPtoLP/LPtoDP exist for.
 *
 * The regression these pin: both calls used to answer "identity" unconditionally, which
 * is INDISTINGUISHABLE from a correct answer under the default MM_TEXT/unit-extent DC —
 * so the bug only shows once a DC actually has a mapping, and only as a nonsense number
 * far from the call (Tiberian Sun asked for a font of height -6832363). Every case below
 * therefore uses a mapping that is NOT the identity.
 */
import { describe, expect, test } from "bun:test";
import {
    applyMapMode, defaultDcMapping, dpToLp, lpToDp,
} from "../../src/worker/modules/gdi32/painting-dc-state";

const MM_TEXT = 1;
const MM_LOMETRIC = 2;
const MM_ANISOTROPIC = 8;
const res = { cx: 800, cy: 600 };

describe("DC coordinate mapping", () => {
    test("MM_TEXT with the default DC is the identity both ways", () => {
        const m = defaultDcMapping();
        expect(lpToDp(m, 37, -11)).toEqual({ x: 37, y: -11 });
        expect(dpToLp(m, 37, -11)).toEqual({ x: 37, y: -11 });
    });

    test("the window origin shifts logical space — SetWindowOrgEx's whole job", () => {
        const m = defaultDcMapping();
        m.wndOrgX = 100; m.wndOrgY = 50;
        // The logical point (100,50) is the one that lands on the viewport origin (0,0).
        expect(lpToDp(m, 100, 50)).toEqual({ x: 0, y: 0 });
        expect(dpToLp(m, 0, 0)).toEqual({ x: 100, y: 50 });
        expect(dpToLp(m, 10, 10)).toEqual({ x: 110, y: 60 });
    });

    test("viewport origin and window origin compose", () => {
        const m = defaultDcMapping();
        m.wndOrgX = 100; m.wndOrgY = 50;
        m.vportOrgX = 7; m.vportOrgY = 9;
        expect(lpToDp(m, 100, 50)).toEqual({ x: 7, y: 9 });
        expect(dpToLp(m, 7, 9)).toEqual({ x: 100, y: 50 });
    });

    test("MM_ANISOTROPIC extents scale, and DPtoLP inverts exactly that", () => {
        const m = defaultDcMapping();
        expect(applyMapMode(m, MM_ANISOTROPIC, res)).toBe(true);
        m.wndExtX = 100; m.wndExtY = 100;      // 100 logical units across…
        m.vportExtX = 800; m.vportExtY = 600;  // …map to the 800x600 device
        expect(lpToDp(m, 50, 50)).toEqual({ x: 400, y: 300 });
        expect(dpToLp(m, 400, 300)).toEqual({ x: 50, y: 50 });
    });

    test("MM_LOMETRIC has a Y axis that points the other way", () => {
        const m = defaultDcMapping();
        expect(applyMapMode(m, MM_LOMETRIC, res)).toBe(true);
        expect(m.vportExtY).toBeLessThan(0);
        expect(lpToDp(m, 0, 0)).toEqual({ x: 0, y: 0 });
        // Positive logical Y is UP, so it maps to a negative device Y.
        expect(lpToDp(m, 0, 100).y).toBeLessThan(0);
        // A tenth of a millimetre is far smaller than a pixel, so the round trip is only
        // exact to one device quantum — as it is on Windows. What must hold is that it
        // comes BACK, within that quantum rather than to some unrelated number.
        const quantumX = Math.abs(m.wndExtX / m.vportExtX);
        const quantumY = Math.abs(m.wndExtY / m.vportExtY);
        const dev = lpToDp(m, 500, -250);
        const back = dpToLp(m, dev.x, dev.y)!;
        expect(Math.abs(back.x - 500)).toBeLessThanOrEqual(quantumX);
        expect(Math.abs(back.y - -250)).toBeLessThanOrEqual(quantumY);
    });

    test("a mode outside the enum is refused and leaves the mapping alone", () => {
        const m = defaultDcMapping();
        expect(applyMapMode(m, MM_LOMETRIC, res)).toBe(true);
        const before = { ...m };
        expect(applyMapMode(m, 99, res)).toBe(false);
        expect(m).toEqual(before);
        expect(applyMapMode(m, MM_TEXT, res)).toBe(true);
        expect(m.wndExtX).toBe(1);
    });

    test("a zero extent has no inverse — DPtoLP must fail, not divide by zero", () => {
        const m = defaultDcMapping();
        m.vportExtX = 0;
        expect(dpToLp(m, 10, 10)).toBeNull();
    });
});
