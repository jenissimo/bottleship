/**
 * A render target with NO guest surface must still get its OWN depth buffer.
 *
 * Every D3D8 render target reports surfacePtr 0, so keying the depth cache on that pointer
 * made all of them collide: alternating targets inside one frame failed the size check, the
 * entry was destroyed and rebuilt, and the first target came back with a FRESH depth buffer —
 * geometry drawn before the switch stopped occluding geometry drawn after it.
 */
import { describe, expect, test } from "bun:test";
// Node has no WebGPU globals; DepthManager only reads the usage bit constants.
(globalThis as any).GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x01 };

const { DepthManager } = await import("../../src/worker/backends/webgpu/ddraw/depth-manager");

/** Minimal GPUDevice/GPUQueue stand-ins: DepthManager only creates textures and views. */
function stubDevice(): { device: any; created: () => number } {
    let created = 0;
    const device = {
        createTexture(desc: any) {
            created++;
            const tex: any = { id: created, width: desc.size[0], height: desc.size[1], destroy() {} };
            tex.createView = () => ({ __tex: tex });
            return tex;
        },
    };
    return { device, created: () => created };
}

const target = (width: number, height: number, surfacePtr: number) =>
    ({ width, height, surfacePtr } as any);

describe("DepthManager target identity", () => {
    test("two pointer-less targets of different sizes keep separate depth buffers", () => {
        const { device, created } = stubDevice();
        const dm = new DepthManager(device as any, {} as any);

        const scene = target(512, 512, 0);
        const inset = target(256, 256, 0);

        expect(dm.ensureDepthForTarget(scene)).toBe(true);
        expect(dm.ensureDepthForTarget(inset)).toBe(true);
        expect(created()).toBe(2);

        const sceneView = dm.getDepthViewForTarget(scene);
        const insetView = dm.getDepthViewForTarget(inset);
        expect(sceneView).not.toBe(insetView);

        // Returning to the first target must REUSE its buffer, not rebuild it — rebuilding is
        // what silently discarded the depth written before the excursion.
        expect(dm.ensureDepthForTarget(scene)).toBe(false);
        expect(created()).toBe(2);
        expect(dm.getDepthViewForTarget(scene)).toBe(sceneView);
    });

    test("a real surfacePtr still keys the entry, so per-surface removal finds it", () => {
        const { device } = stubDevice();
        const dm = new DepthManager(device as any, {} as any);
        const surf = target(64, 64, 0x1234);

        dm.ensureDepthForTarget(surf);
        expect(dm.hasDepthForTarget(surf)).toBe(true);
        dm.removeDepthForSurface(0x1234);
        expect(dm.hasDepthForTarget(surf)).toBe(false);
    });
});
