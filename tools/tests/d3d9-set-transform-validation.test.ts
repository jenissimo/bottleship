/**
 * SetTransform's argument checks run per call (Painkiller: thousands a frame through the ring),
 * so they are allocation-free: a finite scan instead of Array.from(...).every, and a selector
 * predicate instead of building the matrix view getTransform would return. The answers must
 * stay exactly getTransform's: every selector it answers is accepted, every other one is
 * D3DERR_INVALIDCALL — and the ring handler's reused scratch matrix is never retained.
 */

import { describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { D3D9StateTracker } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { StreamBindingTable } from "../../src/worker/backends/webgpu/shared/vertex-streams";

const D3DERR_INVALIDCALL = 0x8876086c | 0;

function fakeDevice() {
    const dev = Object.create(D3D9Device.prototype) as D3D9Device & Record<string, unknown>;
    dev.stateTracker = new D3D9StateTracker(new StreamBindingTable());
    Object.defineProperty(dev, "recordingStateBlock", { value: false });
    return dev;
}

const m = (x: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);

describe("D3D9Device.setTransform validation", () => {
    test("accepts exactly the selectors getTransform answers", () => {
        const dev = fakeDevice();
        for (let state = 0; state < 520; state++) {
            const known = dev.getTransform(state) !== null;
            const hr = dev.setTransform(state, m(state + 1)) | 0;
            expect([state, hr === 0]).toEqual([state, known]);
            if (!known) expect(hr).toBe(D3DERR_INVALIDCALL);
        }
    });

    test("a non-finite element in the first 16 is INVALIDCALL; beyond 16 is ignored", () => {
        const dev = fakeDevice();
        for (const bad of [NaN, Infinity, -Infinity]) {
            for (const at of [0, 7, 15]) {
                const mat = m(1);
                mat[at] = bad;
                expect(dev.setTransform(256, mat) | 0).toBe(D3DERR_INVALIDCALL);
            }
        }
        const long = new Float32Array(20);
        long.set(m(2));
        long[18] = NaN;
        expect(dev.setTransform(256, long)).toBe(0);
        expect(dev.setTransform(256, new Float32Array(15)) | 0).toBe(D3DERR_INVALIDCALL);
    });

    test("the caller's matrix is copied, never retained", () => {
        const dev = fakeDevice();
        const scratch = m(5);
        expect(dev.setTransform(2, scratch)).toBe(0);
        scratch.fill(9);
        expect(Array.from(dev.getTransform(2)!)).toEqual(Array.from(m(5)));
    });
});
