/**
 * The DISCARD version ring is bounded by the renames of ONE frame, and a frame is this
 * device's Present — on every role. A render twin in the split render worker never runs the
 * guest-side half of Present, so a ring that restarted on a boundary only that half advances
 * never restarted there: every DISCARD-after-upload appended a GPUBuffer for the life of the
 * device (Painkiller: ~8 GB/min of GPU-process memory). This drives the real present() on a
 * render-role device and counts the buffers the ring asks the GPU device for.
 */

import { describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage ??=
    { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };

const VB = 3;
const SIZE = 4096;

function makeRenderTwin(): { device: any; gpu: { created: number }; lockDiscardAndDraw: () => void } {
    const gpu = { created: 0 };
    const gpuDevice = {
        createBuffer: (d: { size: number }) => { gpu.created++; return { size: d.size, destroy() {} }; },
    };
    let dirty = false;
    const shadow = new Uint8Array(SIZE);
    const store = {
        getSize: () => SIZE,
        getGpuBuffer: () => null,
        setGpuBuffer() {},
        isDirty: () => dirty,
        setDirty: (_i: number, d: boolean) => { dirty = d; },
        getDirtyStart: () => 0,
        getDirtyEnd: () => SIZE,
        takeLockedSinceUpload: () => SIZE,
    };
    const device: any = Object.create(D3D9Device.prototype);
    const own = (fields: Record<string, unknown>): void => {
        for (const [key, value] of Object.entries(fields)) {
            Object.defineProperty(device, key, { value, writable: true, configurable: true, enumerable: true });
        }
    };
    own({
        role: "render",
        // Field initializers do not run under Object.create: these are the ring's own.
        vbVersions: new Map(), ibVersions: new Map(),
        vbSlotThisFrame: new Map(), ibSlotThisFrame: new Map(),
        vbUploadedThisFrame: new Set(), ibUploadedThisFrame: new Set(),
        vbUploadCountThisFrame: new Map(), ibUploadCountThisFrame: new Map(),
        vbLastLockFlags: new Map(), ibLastLockFlags: new Map(),
        discardedVb: new Set(), discardedIb: new Set(),
        bufferFrameSerial: -1, presentBoundarySerial: 0,
        fetchAuditFramesLeft: 0,
        vertexBuffers: store, indexBuffers: store,
        commandRecorder: { queueUpload() {}, registerTemporaryBuffer() {} },
        frameSnapshot: { presents: 0, frameCounters: null, drawCalls: 0 },
        frameIdCounter: 0,
        lastDrawSnapshot: { timestamp: 0 },
        // present()'s collaborators on a render twin: a usable device, no RT bound, a sink.
        splitLossSource: { isUsable: () => true },
        renderTargetIndices: [null],
        submitFrame() {},
        fetchAuditOnPresent() {},
        updateFps() {},
        backendExecutor: { hasFrameSink: () => true },
    });
    // One frame's worth of a dynamic VB: upload, then Lock(DISCARD) + refill + draw again.
    const lockDiscardAndDraw = (): void => {
        dirty = true;
        device.uploadBufferVersion(VB, shadow, "vb", gpuDevice);
        device.discardedVb.add(VB);
        dirty = true;
        device.uploadBufferVersion(VB, shadow, "vb", gpuDevice);
    };
    return { device, gpu, lockDiscardAndDraw };
}

describe("d3d9 buffer version ring frame", () => {
    test("a render twin's ring reuses its slots across its own presents", async () => {
        const { device, gpu, lockDiscardAndDraw } = makeRenderTwin();
        lockDiscardAndDraw();
        await device.present();
        const afterOneFrame = gpu.created;
        expect(afterOneFrame).toBe(2); // slot 0 + one rename
        for (let frame = 0; frame < 50; frame++) {
            lockDiscardAndDraw();
            await device.present();
        }
        expect(gpu.created).toBe(afterOneFrame);
    });

    test("within one frame every DISCARD-after-upload still renames", () => {
        const { gpu, lockDiscardAndDraw } = makeRenderTwin();
        lockDiscardAndDraw();
        lockDiscardAndDraw();
        lockDiscardAndDraw();
        // slot 0 + one rename per DISCARD that followed an upload in the same frame.
        expect(gpu.created).toBe(1 + 3);
    });
});
