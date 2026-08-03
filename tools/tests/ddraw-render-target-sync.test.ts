import { describe, expect, test } from "bun:test";

import {
    needsRenderTargetUploadBeforeDraw,
    unionSurfaceDirtyRegion,
} from "../../src/worker/modules/ddraw/surface-sync";

describe("DirectDraw/D3D render-target synchronization", () => {
    test("uploads a CPU write to an ordinary video-memory backbuffer before drawing", () => {
        const target = {
            surfacePtr: 0x1000,
            gpuTexture: {},
            version: 12,
            lastUploadVersion: 11,
            gpuDirty: true,
        } as any;

        expect(needsRenderTargetUploadBeforeDraw(target)).toBe(true);

        target.lastUploadVersion = target.version;
        target.gpuDirty = false;
        expect(needsRenderTargetUploadBeforeDraw(target)).toBe(false);
    });

    test("keeps both the erased and newly drawn software-cursor rectangles dirty", () => {
        const target = {
            surfaceType: "render_surface",
            width: 640,
            height: 480,
        } as any;

        unionSurfaceDirtyRegion(target, { left: 100, top: 80, right: 132, bottom: 112 });
        unionSurfaceDirtyRegion(target, { left: 300, top: 220, right: 332, bottom: 252 });

        expect(target.dirtyRegion).toEqual({
            left: 100,
            top: 80,
            right: 332,
            bottom: 252,
        });
    });
});
