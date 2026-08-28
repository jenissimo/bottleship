import { describe, expect, test } from "bun:test";
import {
    d3dTextureMipUploadPlan,
    mipLevelCountFor,
    mipExtent,
    effectiveMipLevels,
    effectiveCubeMipLevels,
} from "../../src/worker/backends/webgpu/shared/mip-utils";

describe("mipLevelCountFor", () => {
    test("full chain down to 1x1 for power-of-two", () => {
        expect(mipLevelCountFor(256, 256)).toBe(9); // 256,128,...,1
        expect(mipLevelCountFor(1, 1)).toBe(1);
        expect(mipLevelCountFor(512, 256)).toBe(10); // driven by the larger dim
    });
    test("NPOT uses the larger dimension", () => {
        expect(mipLevelCountFor(640, 480)).toBe(Math.floor(Math.log2(640)) + 1); // 10
        expect(mipLevelCountFor(100, 1)).toBe(Math.floor(Math.log2(100)) + 1);   // 7
    });
});

describe("mipExtent", () => {
    test("floor-halving with a floor of 1 (NPOT-correct)", () => {
        expect(mipExtent(256, 0)).toBe(256);
        expect(mipExtent(256, 1)).toBe(128);
        expect(mipExtent(256, 8)).toBe(1);
        expect(mipExtent(256, 9)).toBe(1); // never below 1
        expect(mipExtent(5, 1)).toBe(2);   // 5>>1 = 2
        expect(mipExtent(1, 3)).toBe(1);
    });
});

describe("effectiveMipLevels — conservative authored-only policy", () => {
    const none = () => false;
    const all = () => true;

    test("declared=1 → single level regardless of data", () => {
        expect(effectiveMipLevels(1, 256, 256, all)).toBe(1);
    });
    test("declared full chain but only level 0 authored → 1 (no black mips)", () => {
        expect(effectiveMipLevels(0, 256, 256, none)).toBe(1);
        expect(effectiveMipLevels(9, 256, 256, none)).toBe(1);
    });
    test("declared=0 (full chain) with all levels authored → full chain", () => {
        expect(effectiveMipLevels(0, 256, 256, all)).toBe(9);
    });
    test("stops at the first missing level (contiguous only)", () => {
        // levels 1,2 present, 3 missing
        const has = (lvl: number) => lvl === 1 || lvl === 2;
        expect(effectiveMipLevels(0, 256, 256, has)).toBe(3); // 0,1,2
    });
    test("declared count caps the chain even if more data exists", () => {
        expect(effectiveMipLevels(3, 256, 256, all)).toBe(3);
    });
    test("declared count is clamped to the valid maximum", () => {
        expect(effectiveMipLevels(999, 4, 4, all)).toBe(3); // 4x4 → 3 levels max (4,2,1)
    });
});

describe("d3dTextureMipUploadPlan", () => {
    test("returns contiguous authored extents and stops at the first missing level", () => {
        const plan = d3dTextureMipUploadPlan(8, 4, 0, (level) => level === 1 || level === 2);
        expect(plan).toEqual([
            { level: 0, width: 8, height: 4 },
            { level: 1, width: 4, height: 2 },
            { level: 2, width: 2, height: 1 },
        ]);
    });

    test("declared level count caps the upload plan", () => {
        const plan = d3dTextureMipUploadPlan(16, 16, 2, () => true);
        expect(plan).toEqual([
            { level: 0, width: 16, height: 16 },
            { level: 1, width: 8, height: 8 },
        ]);
    });
});

describe("effectiveCubeMipLevels", () => {
    test("requires all six faces before exposing a cube mip", () => {
        const authored = new Set<string>();
        for (let face = 0; face < 5; face++) authored.add(`${face}:1`);
        expect(effectiveCubeMipLevels(0, 8, 8, (face, level) => authored.has(`${face}:${level}`))).toBe(1);
        authored.add("5:1");
        expect(effectiveCubeMipLevels(0, 8, 8, (face, level) => authored.has(`${face}:${level}`))).toBe(2);
    });
});
