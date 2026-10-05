/**
 * Glide texture addressing: the aspect-ratio texcoord scale and the mipmap chain
 * layout inside the buffer grTexDownloadMipMap is handed.
 *
 * Carmageddon 2 — the Glide bring-up fixture — uploads only square, single-level
 * textures, so neither of these is exercised by running it. Both are pinned here
 * against the 3dfx SDK's own behaviour instead of against a screenshot.
 */

import { describe, expect, test } from "bun:test";
import {
    glideTexCoordScale,
    glideIncludesMipLevel,
    glideMipLevelPlan,
    GR_MIPMAPLEVELMASK_BOTH,
    GR_MIPMAPLEVELMASK_EVEN,
    GR_MIPMAPLEVELMASK_ODD,
} from "../../src/worker/backends/webgpu/glide/glide-texture-decoder";

// ARGB_4444-ish: two bytes per texel, which is what the fixture titles use.
const size16bpp = (w: number, h: number): number => w * h * 2;

describe("glideTexCoordScale", () => {
    test("a square texture takes s and t over the full 0..255 range", () => {
        for (const n of [1, 8, 32, 64, 256]) {
            const s = glideTexCoordScale(n, n);
            expect(s.x).toBeCloseTo(1 / 256, 12);
            expect(s.y).toBeCloseTo(1 / 256, 12);
        }
    });

    test("the short axis is scaled by the aspect ratio, not by the size", () => {
        // 2:1 — s spans 0..255, t only 0..127 (view3df.c: smult 1.0, tmult 0.5).
        const wide = glideTexCoordScale(64, 32);
        expect(wide.x).toBeCloseTo(1 / 256, 12);
        expect(wide.y).toBeCloseTo(1 / 128, 12);

        // 1:8 the other way round.
        const tall = glideTexCoordScale(32, 256);
        expect(tall.y).toBeCloseTo(1 / 256, 12);
        expect(tall.x).toBeCloseTo(1 / 32, 12);
    });

    test("t=255*tmult lands on the far edge for every SDK aspect ratio", () => {
        // The SDK draws a full-texture quad as sow/tow = 255 * smult/tmult, so those
        // coordinates must map to 1.0 in uv whatever the aspect. This is the assertion
        // a single 1/256 for both axes fails.
        const cases: Array<[number, number, number, number]> = [
            // width, height, smult, tmult  (view3df.c)
            [256, 32, 1.0, 0.125],
            [256, 64, 1.0, 0.25],
            [256, 128, 1.0, 0.5],
            [256, 256, 1.0, 1.0],
            [128, 256, 0.5, 1.0],
            [64, 256, 0.25, 1.0],
            [32, 256, 0.125, 1.0],
        ];
        for (const [w, h, smult, tmult] of cases) {
            const s = glideTexCoordScale(w, h);
            expect(255 * smult * s.x).toBeCloseTo(255 / 256, 6);
            expect(255 * tmult * s.y).toBeCloseTo(255 / 256, 6);
        }
    });
});

describe("glideIncludesMipLevel", () => {
    test("BOTH takes every level, EVEN/ODD take their parity", () => {
        for (let lod = 0; lod <= 8; lod++) {
            expect(glideIncludesMipLevel(GR_MIPMAPLEVELMASK_BOTH, lod)).toBe(true);
            expect(glideIncludesMipLevel(GR_MIPMAPLEVELMASK_EVEN, lod)).toBe((lod & 1) === 0);
            expect(glideIncludesMipLevel(GR_MIPMAPLEVELMASK_ODD, lod)).toBe((lod & 1) === 1);
        }
    });

    test("an unrecognised mask selects nothing rather than everything", () => {
        expect(glideIncludesMipLevel(0, 0)).toBe(false);
        expect(glideIncludesMipLevel(7, 0)).toBe(false);
    });
});

describe("glideMipLevelPlan", () => {
    test("a single-level download is one level at offset 0", () => {
        const plan = glideMipLevelPlan(2, 2, GR_MIPMAPLEVELMASK_BOTH, 3, size16bpp);
        expect(plan).toHaveLength(1);
        expect(plan[0]).toEqual({ lod: 2, width: 64, height: 64, byteOffset: 0, byteSize: 64 * 64 * 2 });
    });

    test("levels are laid out largest first, offsets running", () => {
        // LOD 2 (64) down to LOD 5 (8), square.
        const plan = glideMipLevelPlan(2, 5, GR_MIPMAPLEVELMASK_BOTH, 3, size16bpp);
        expect(plan.map((l) => [l.width, l.height])).toEqual([[64, 64], [32, 32], [16, 16], [8, 8]]);
        let offset = 0;
        for (const level of plan) {
            expect(level.byteOffset).toBe(offset);
            offset += level.byteSize;
        }
        expect(offset).toBe((64 * 64 + 32 * 32 + 16 * 16 + 8 * 8) * 2);
    });

    test("non-square levels keep the aspect ratio all the way down", () => {
        // aspect 2 = 2:1 (computeTextureDimensions halves the short axis once).
        const plan = glideMipLevelPlan(2, 4, GR_MIPMAPLEVELMASK_BOTH, 2, size16bpp);
        // Literal, not re-derived from computeTextureDimensions: expectations computed by
        // the function under test agree with it by construction and assert nothing.
        expect(plan.map((l) => [l.width, l.height])).toEqual([[64, 32], [32, 16], [16, 8]]);
    });

    test("an EVEN/ODD chain stops at the first skipped level", () => {
        // GPU mip chains must halve; a mask that drops every other LOD cannot be one,
        // so only the top level survives rather than a chain that lies about its levels.
        const plan = glideMipLevelPlan(2, 6, GR_MIPMAPLEVELMASK_EVEN, 3, size16bpp);
        expect(plan).toHaveLength(1);
        expect(plan[0]!.width).toBe(64);
    });

    test("a malformed range yields nothing instead of guessing", () => {
        expect(glideMipLevelPlan(-1, 4, GR_MIPMAPLEVELMASK_BOTH, 3, size16bpp)).toHaveLength(0);
        expect(glideMipLevelPlan(4, 2, GR_MIPMAPLEVELMASK_BOTH, 3, size16bpp)).toHaveLength(0);
    });
});
