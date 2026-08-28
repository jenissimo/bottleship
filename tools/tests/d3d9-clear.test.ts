import { describe, expect, test } from "bun:test";
import { resolveD3D9ClearRegion, resolveD3D9RectClearPolicy } from "../../src/worker/backends/webgpu/d3d9/clear-policy";
import { D3D9CommandRecorder } from "../../src/worker/backends/webgpu/d3d9/d3d9-command-recorder";
import { RenderCommandType, RenderFrame, RenderFramePool } from "../../src/worker/backends/webgpu/render-frame";

describe("D3D9 attachment-specific Clear(rects) policy", () => {
    test("accepts target, depth and stencil on a single-sample stencil attachment", () => {
        expect(resolveD3D9RectClearPolicy(1 | 2 | 4, 1, true)).toEqual({
            supported: true,
            target: true,
            depth: true,
            stencil: true,
            reason: null,
        });
        expect(resolveD3D9RectClearPolicy(2, 1, false).supported).toBe(true);
    });

    test("refuses unsupported flags and stencil on depth-only views", () => {
        expect(resolveD3D9RectClearPolicy(0, 1, true).reason).toMatch(/flags/);
        expect(resolveD3D9RectClearPolicy(8, 1, true).reason).toMatch(/flags/);
        expect(resolveD3D9RectClearPolicy(2 | 4, 1, false).reason).toMatch(/stencil plane/);
        expect(resolveD3D9RectClearPolicy(2, 0, true).reason).toMatch(/sample count/);
    });

    test("accepts a rectangle clear of an MSAA attachment", () => {
        // D3D9's Clear cannot fail on a legal call; the lowering builds its fill pipeline at
        // the attachment's own sample count instead. Refusing left the target holding the
        // previous frame while the app believed it had cleared.
        for (const sampleCount of [2, 4]) {
            for (const flags of [1, 2, 1 | 2 | 4]) {
                const policy = resolveD3D9RectClearPolicy(flags, sampleCount, true);
                expect(policy.supported).toBe(true);
                expect(policy.reason).toBeNull();
            }
        }
    });
});

describe("RenderFrame clear submission boundaries", () => {
    test("does not merge a later clear across an intermediate draw", () => {
        const recorder = new D3D9CommandRecorder(new RenderFramePool(2));
        recorder.setClear({ r: 1, g: 0, b: 0, a: 1 }, 0.25, 3, 1 | 2);
        recorder.getCurrentFrame().pushDraw(3, 0, 12);

        // Finalize is the same submission boundary used by D3D9Device.clear before it records
        // the next Clear. Keep the first frame around so the intermediate draw is observable.
        const first = recorder.finalize();

        recorder.setClear({ r: 0, g: 1, b: 0, a: 1 }, 0.75, 9, 2);
        const second = recorder.getCurrentFrame();

        expect(first.hasClear).toBe(true);
        expect(first.clear.flags).toBe(1 | 2);
        expect(first.commandTypes).toContain(RenderCommandType.Draw);
        expect(second.clear.flags).toBe(2);
        expect(second.clear.depth).toBe(0.75);
    });

    test("does not carry the previous frame's clear mask through pool reset", () => {
        const frame = new RenderFrame();
        frame.setClear({ r: 1, g: 0, b: 0, a: 1 }, 0.25, 3, 1 | 2);
        frame.reset();
        frame.setClear({ r: 0, g: 0, b: 1, a: 1 }, 1, 0, 4);

        expect(frame.clear.flags).toBe(4);
    });
});

describe("Clear with no rect list is a VIEWPORT clear, not a whole-attachment clear", () => {
    const FULL = { x: 0, y: 0, width: 800, height: 600 };
    const NO_SCISSOR = { left: 0, top: 0, right: 0, bottom: 0 };

    test("a full-target viewport keeps the exact frame-level loadOp clear", () => {
        const region = resolveD3D9ClearRegion(FULL, NO_SCISSOR, false, 800, 600);
        expect(region.full).toBe(true);
        expect(region.empty).toBe(false);
    });

    test("a sub-viewport clears only its own rectangle", () => {
        // A shadow-map atlas tile / split-screen half. Clearing the whole attachment here
        // wipes every tile already rendered this frame, and nothing reports it.
        const region = resolveD3D9ClearRegion({ x: 512, y: 0, width: 512, height: 512 },
            NO_SCISSOR, false, 2048, 2048);
        expect(region.full).toBe(false);
        expect(region).toMatchObject({ left: 512, top: 0, right: 1024, bottom: 512 });
    });

    test("D3DRS_SCISSORTESTENABLE intersects the viewport (DXVK D3D9DeviceEx::Clear)", () => {
        const scissor = { left: 100, top: 50, right: 400, bottom: 300 };
        const region = resolveD3D9ClearRegion(FULL, scissor, true, 800, 600);
        expect(region).toMatchObject({ left: 100, top: 50, right: 400, bottom: 300, full: false });
        // The same scissor with the test OFF must not narrow anything.
        expect(resolveD3D9ClearRegion(FULL, scissor, false, 800, 600).full).toBe(true);
    });

    test("a viewport running past the target still covers it", () => {
        const region = resolveD3D9ClearRegion({ x: 0, y: 0, width: 4096, height: 4096 },
            NO_SCISSOR, false, 800, 600);
        expect(region.full).toBe(true);
        expect(region).toMatchObject({ right: 800, bottom: 600 });
    });

    test("a degenerate viewport/scissor intersection clears nothing", () => {
        const region = resolveD3D9ClearRegion({ x: 0, y: 0, width: 100, height: 100 },
            { left: 200, top: 200, right: 300, bottom: 300 }, true, 800, 600);
        expect(region.empty).toBe(true);
        expect(region.full).toBe(false);
    });
});
