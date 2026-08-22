/**
 * The DDraw conformance scene judges two things, and both can be wrong in ways that still
 * print a plausible verdict: how a raw pixel word becomes the colour Wine compares, and
 * whether an injected bug was actually caught. Neither needs a GPU to check.
 */

import { describe, expect, it } from "bun:test";
import {
    MUTATIONS, blindGroups, mutationVerdict, channel8, decodeRgb, encodeRgb,
    type ConformanceCheck, type Mutation, type PixelFormat,
} from "../../src/worker/harness/cmds/ddraw-conformance-eval";

/** The same rows, all green — the baseline a mutation is judged against. */
const allGreenFor = (checks: { name: string; pass: boolean }[]) =>
    checks.map((c) => ({ ...c, pass: true })) as typeof checks;


const X8R8G8B8: PixelFormat = { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0 };
const RGB565: PixelFormat = { bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };

const row = (name: string, pass: boolean): ConformanceCheck =>
    ({ name, wine: "", expected: "", observed: "", pass });

describe("pixel decode", () => {
    it("reads get_surface_color's colour out of an X8R8G8B8 word, X channel ignored", () => {
        expect(decodeRgb(0xff00ff00, X8R8G8B8)).toBe(0x00ff00);
        expect(decodeRgb(0x000000ff, X8R8G8B8)).toBe(0x0000ff);
        expect(decodeRgb(0x00123456, X8R8G8B8)).toBe(0x123456);
    });

    it("round-trips the scene's pure-channel colours through 565 exactly", () => {
        for (const rgb of [0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x000000]) {
            expect(decodeRgb(encodeRgb(rgb, RGB565), RGB565)).toBe(rgb);
            expect(decodeRgb(encodeRgb(rgb, X8R8G8B8), X8R8G8B8)).toBe(rgb);
        }
    });

    it("expands a channel to its full range instead of left-shifting it", () => {
        // 0x3f in a 6-bit green mask is 255, not 252 — a shift-only expansion would make
        // every full-brightness 565 read miss by 3 and invent a colour failure.
        expect(channel8(0x07e0, RGB565.gMask)).toBe(255);
        expect(channel8(0xf800, RGB565.rMask)).toBe(255);
        expect(channel8(0, RGB565.rMask)).toBe(0);
    });

    it("encodes a fill colour in the surface's own format, not D3DCOLOR", () => {
        expect(encodeRgb(0x00ff00, RGB565)).toBe(0x07e0);
        expect(encodeRgb(0x00ff00, X8R8G8B8)).toBe(0x0000ff00);
    });
});

describe("mutation effectiveness", () => {
    it("calls a mutation blind when the rows it targets stayed green", () => {
        const allGreen = Object.values(MUTATIONS)
            .flatMap((m) => m.groups)
            .map((g) => row(`${g}.probe`, true));
        for (const name of Object.keys(MUTATIONS) as Mutation[]) {
            expect(blindGroups(allGreen, allGreen, name)).toEqual(MUTATIONS[name]!.groups);
        }
    });

    it("clears a group as soon as ONE row in it fails", () => {
        const checks = [row("subrect1x1.(0,0)", true), row("subrect1x1.(17,1)", false)];
        expect(blindGroups(allGreenFor(checks), checks, "ignore-subrect")).toEqual([]);
    });

    it("does not accept an unrelated failure as proof", () => {
        const checks = [row("colorfill.fullSurfaceLock", false), row("flip3d.otherChainSlot", true)];
        expect(blindGroups(allGreenFor(checks), checks, "noop-flip")).toEqual(["flip3d.otherChainSlot"]);
    });

    it("requires EVERY group a mutation names, not just one", () => {
        // skip-colorfill blanks both the sysmem fill and the quadrant pattern; a build where
        // only one of those rows moved has not been shown to catch the bug in the other.
        const checks = [row("colorfill.fullSurfaceLock", false), row("subrect1x1.(1,17)", true)];
        expect(blindGroups(allGreenFor(checks), checks, "skip-colorfill")).toEqual(["subrect1x1"]);
    });

    it("names every row group in the roster after a real assertion row", () => {
        // A group prefix that matches no row the scene emits can never fail, so the mutation
        // would report itself blind forever — or, if the test above were inverted, proven.
        const emitted = [
            "flip3d.currentBackBuffer", "flip3d.otherChainSlot",
            "subrect1x1.(0,0)", "colorfill.fullSurfaceLock", "colorfill.xChannel",
            "lockExclusivity.secondLock",
        ];
        for (const m of Object.values(MUTATIONS)) {
            for (const g of m.groups) {
                expect(emitted.some((name) => name.startsWith(g))).toBe(true);
            }
        }
    });
});
