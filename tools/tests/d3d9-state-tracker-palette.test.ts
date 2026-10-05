import { describe, expect, test } from "bun:test";
import { D3D9StateTracker, FFP_WORLD_MATRIX_COUNT } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { StreamBindingTable } from "../../src/worker/backends/webgpu/shared/vertex-streams";

function translation(x: number): Float32Array {
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        x, 0, 0, 1,
    ]);
}

describe("D3D9StateTracker world-matrix palette", () => {
    test("keeps D3DTS_WORLD and D3DTS_WORLDMATRIX(1..7) independently", () => {
        const tracker = new D3D9StateTracker(new StreamBindingTable());
        expect(FFP_WORLD_MATRIX_COUNT).toBe(8);
        expect(tracker.setTransform(0x100, translation(10))).toBe(true);
        expect(tracker.setTransform(0x101, translation(20))).toBe(true);
        expect(tracker.setTransform(0x107, translation(70))).toBe(true);

        expect(tracker.getWorldMatrix()[12]).toBe(10);
        expect(tracker.getWorldMatrixPalette(0)![12]).toBe(10);
        expect(tracker.getWorldMatrixPalette(1)![12]).toBe(20);
        expect(tracker.getWorldMatrixPalette(7)![12]).toBe(70);
        expect(tracker.getWorldMatrixPalette(8)).toBeNull();

        // A later WORLD update mirrors only palette entry 0 and cannot erase entries 1..7.
        tracker.setTransform(0x100, translation(11));
        expect(tracker.getWorldMatrices()[12]).toBe(11);
        expect(tracker.getWorldMatrices()[16 + 12]).toBe(20);
        expect(tracker.getWorldMatrices()[7 * 16 + 12]).toBe(70);
    });

    test("multiplyTransform targets a palette entry", () => {
        const tracker = new D3D9StateTracker(new StreamBindingTable());
        tracker.setTransform(0x102, translation(3));
        tracker.multiplyTransform(0x102, translation(4));
        expect(tracker.getWorldMatrixPalette(2)![12]).toBe(7);
        expect(tracker.getWorldMatrixPalette(0)![12]).toBe(0);
    });

    test("seeds D3D9 multisample defaults as all-sample, single-sample-safe state", () => {
        const tracker = new D3D9StateTracker(new StreamBindingTable());
        expect(tracker.getRenderState(161)).toBe(1);
        expect(tracker.getRenderState(162) >>> 0).toBe(0xffff_ffff);
        expect(tracker.getRenderState(176)).toBe(0);
    });
});
