import { describe, expect, test } from "bun:test";
import { d3dTextureMipUploadPlan } from "../../src/worker/backends/webgpu/shared/mip-utils";
import {
    D3DFMT_DXT1,
    getD3DTextureLayout,
} from "../../src/worker/backends/webgpu/shared/texture-formats";

describe("D3D9 authored DXT mip uploads", () => {
    test("keeps block-row storage for every mip, including 2x1/1x1 tails", () => {
        const plan = d3dTextureMipUploadPlan(8, 4, 0, (level) => level <= 3);
        expect(plan).toEqual([
            { level: 0, width: 8, height: 4 },
            { level: 1, width: 4, height: 2 },
            { level: 2, width: 2, height: 1 },
            { level: 3, width: 1, height: 1 },
        ]);

        expect(getD3DTextureLayout(D3DFMT_DXT1, 8, 4)).toMatchObject({
            pitch: 16,
            rows: 1,
            bytes: 16,
            compressed: true,
            blockBytes: 8,
        });
        expect(getD3DTextureLayout(D3DFMT_DXT1, 2, 1)).toMatchObject({
            pitch: 8,
            rows: 1,
            bytes: 8,
            compressed: true,
        });
    });

    test("does not expose a missing interior authored mip", () => {
        const plan = d3dTextureMipUploadPlan(16, 16, 0, (level) => level === 1 || level === 3);
        expect(plan).toHaveLength(2);
        expect(plan[1]).toEqual({ level: 1, width: 8, height: 8 });
    });
});
