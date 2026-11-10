/**
 * IDirect3DDevice9::MultiplyTransform stores `matrix * current` — the given matrix is applied
 * BEFORE the transform already set (row-vector convention). A scale multiplied onto a
 * translation must therefore leave the translation alone; the reverse order would scale it.
 */

import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { D3D9StateTracker } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { StreamBindingTable } from "../../src/worker/backends/webgpu/shared/vertex-streams";

const D3DTS_VIEW = 2;
const D3DTS_WORLD = 256;

function fakeDevice() {
    const dev = Object.create(D3D9Device.prototype) as D3D9Device & Record<string, unknown>;
    dev.stateTracker = new D3D9StateTracker(new StreamBindingTable());
    Object.defineProperty(dev, "recordingStateBlock", { value: false });
    return dev;
}

const translate = (x: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
const scale = (s: number) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);

test("MultiplyTransform applies the given matrix before the current one", () => {
    for (const state of [D3DTS_WORLD, D3DTS_VIEW]) {
        const dev = fakeDevice();
        const tracker = dev.stateTracker as D3D9StateTracker;
        dev.setTransform(state, translate(5));
        expect(tracker.multiplyTransform(state, scale(2))).toBe(true);
        expect(Array.from(dev.getTransform(state)!)).toEqual([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 0, 0, 1]);
    }
});
