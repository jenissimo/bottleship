/**
 * The device-loss contract: what the guest is told, and when.
 *
 * The failure mode this guards is the one the task warned about — answering an honest error
 * code before the backend can actually recreate a device. A guest that gets D3DERR_DEVICENOTRESET
 * while there is no device calls Reset(), which cannot succeed, and loops forever. So the
 * ordering DEVICELOST → (device exists) → DEVICENOTRESET → (Reset) → D3D_OK is the property under
 * test, not merely "some error is returned".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { gpuDeviceLifecycle } from "../../src/worker/core/gpu/gpu-device-lifecycle";
import {
    acknowledgeDeviceReset,
    deviceCooperativeLevel,
    forgetLossTrackedDevice,
    forgetLossTrackedSurface,
    isSurfaceLost,
    lostSurfaceCount,
    markSurfaceLost,
    markSurfaceRestored,
    registerLossTrackedDevice,
    resetDeviceLossContract,
} from "../../src/worker/core/gpu/gpu-device-loss-contract";
import { TextureStore, VertexBufferStore, IndexBufferStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

/** A stand-in for the replacement GPUDevice — the lifecycle only hands it to observers. */
const FAKE_DEVICE = {} as unknown as GPUDevice;

const DEV = 0x0d3d9000;

function loseAndRecover(): void {
    gpuDeviceLifecycle.notifyLost("test", "forced");
    gpuDeviceLifecycle.notifyRecreated(FAKE_DEVICE);
}

describe("d3d9/d3d8 TestCooperativeLevel sequence", () => {
    beforeEach(() => {
        resetDeviceLossContract();
        // Leave the lifecycle in "ok" for the next test regardless of how one ended.
        if (gpuDeviceLifecycle.status() !== "ok") gpuDeviceLifecycle.notifyRecreated(FAKE_DEVICE);
    });

    test("a healthy device answers ok", () => {
        registerLossTrackedDevice(DEV);
        expect(deviceCooperativeLevel(DEV)).toBe("ok");
    });

    test("while there is no device the answer is 'lost' and Reset is refused", () => {
        registerLossTrackedDevice(DEV);
        gpuDeviceLifecycle.notifyLost("test", "forced");

        expect(deviceCooperativeLevel(DEV)).toBe("lost");
        // The load-bearing half: Reset must FAIL here. Letting it succeed is what would put a
        // correct app into a reset loop against a device that does not exist.
        expect(acknowledgeDeviceReset(DEV)).toBe(false);
        expect(deviceCooperativeLevel(DEV)).toBe("lost");

        gpuDeviceLifecycle.notifyRecreated(FAKE_DEVICE);
    });

    test("once a device exists the answer becomes 'notreset', and Reset clears it", () => {
        registerLossTrackedDevice(DEV);
        loseAndRecover();

        expect(deviceCooperativeLevel(DEV)).toBe("notreset");
        expect(acknowledgeDeviceReset(DEV)).toBe(true);
        expect(deviceCooperativeLevel(DEV)).toBe("ok");
    });

    test("a second loss re-arms the sequence for an already-reset device", () => {
        registerLossTrackedDevice(DEV);
        loseAndRecover();
        acknowledgeDeviceReset(DEV);
        expect(deviceCooperativeLevel(DEV)).toBe("ok");

        loseAndRecover();
        expect(deviceCooperativeLevel(DEV)).toBe("notreset");
    });

    test("an untracked device is never reported lost", () => {
        // Reporting DEVICELOST for a device we merely failed to register would send a correct
        // app into a reset loop for a device that is perfectly healthy.
        loseAndRecover();
        expect(deviceCooperativeLevel(0xdeadbeef)).toBe("ok");
    });

    test("a released device stops being tracked", () => {
        registerLossTrackedDevice(DEV);
        forgetLossTrackedDevice(DEV);
        loseAndRecover();
        expect(deviceCooperativeLevel(DEV)).toBe("ok");
    });
});

describe("DirectDraw surface loss", () => {
    beforeEach(() => {
        resetDeviceLossContract();
        if (gpuDeviceLifecycle.status() !== "ok") gpuDeviceLifecycle.notifyRecreated(FAKE_DEVICE);
    });

    test("IsLost is false until a surface is marked, and Restore clears it", () => {
        const surf = {};
        expect(isSurfaceLost(surf)).toBe(false);
        markSurfaceLost(surf);
        expect(isSurfaceLost(surf)).toBe(true);
        expect(lostSurfaceCount()).toBe(1);
        markSurfaceRestored(surf);
        expect(isSurfaceLost(surf)).toBe(false);
        expect(lostSurfaceCount()).toBe(0);
    });

    test("marking twice counts once, so the fast-path gate cannot drift", () => {
        // lostSurfaceCount() is what makes the hot IsLost fast path defer to JS. A count that
        // over- or under-shoots either strands the slow path forever or answers DD_OK for a
        // surface that IS lost.
        const surf = {};
        markSurfaceLost(surf);
        markSurfaceLost(surf);
        expect(lostSurfaceCount()).toBe(1);
        markSurfaceRestored(surf);
        markSurfaceRestored(surf);
        expect(lostSurfaceCount()).toBe(0);
    });

    test("a surface destroyed while lost releases the count", () => {
        const surf = {};
        markSurfaceLost(surf);
        expect(lostSurfaceCount()).toBe(1);
        forgetLossTrackedSurface(surf);
        expect(lostSurfaceCount()).toBe(0);
    });

    test("lostness lives on the surface, not on its guest address", () => {
        // COM blocks are recycled from a shared pool, so an address-keyed flag would be
        // inherited by whatever unrelated interface reused the block.
        const a = {}, b = {};
        markSurfaceLost(a);
        expect(isSurfaceLost(b)).toBe(false);
    });
});

describe("d3d9 resource stores restore from their CPU shadow", () => {
    const FAKE_BUFFER = {} as unknown as GPUBuffer;
    const FAKE_TEXTURE = {} as unknown as GPUTexture;
    const FAKE_VIEW = {} as unknown as GPUTextureView;

    test("vertex buffers drop their GPU side and come back dirty", () => {
        const store = new VertexBufferStore(4);
        const i = store.create(0x10, 256, 0, 0x40000, 1 /* D3DPOOL_MANAGED */);
        store.getData(i)![0] = 0x52;
        store.setGpuBuffer(i, FAKE_BUFFER);
        store.setDirty(i, false);

        expect(store.dropGpuResources()).toBe(1);
        expect(store.getGpuBuffer(i)).toBeNull();
        // Dirty is the re-upload trigger: without it the buffer is silently never restored.
        expect(store.isDirty(i)).toBe(true);
        expect(store.getData(i)).toBeDefined();
        expect(store.getData(i)![0]).toBe(0x52);
    });

    test("index buffers behave the same", () => {
        const store = new IndexBufferStore(4);
        const i = store.create(0x11, 128, 101 /* D3DFMT_INDEX16 */, 0x50000);
        store.getData(i)![0] = 0x63;
        store.setGpuBuffer(i, FAKE_BUFFER);
        store.setDirty(i, false);

        expect(store.dropGpuResources()).toBe(1);
        expect(store.getGpuBuffer(i)).toBeNull();
        expect(store.isDirty(i)).toBe(true);
        expect(store.getData(i)![0]).toBe(0);
    });

    test("a sampled texture is restorable; a render target's contents are gone", () => {
        const store = new TextureStore(4);
        // A managed resource keeps its CPU shadow across a device loss.  The render
        // target is explicitly DEFAULT, so only that entry is reported as lost.
        const sampled = store.create(0x20, 16, 16, 1, 21 /* D3DFMT_A8R8G8B8 */, 0x60000, 1 /* D3DPOOL_MANAGED */);
        const rt = store.create(0x21, 16, 16, 1, 21, -1, 0 /* D3DPOOL_DEFAULT */);
        store.markRenderTarget(rt);
        store.setGpuTexture(sampled, FAKE_TEXTURE, FAKE_VIEW);
        store.setGpuTexture(rt, FAKE_TEXTURE, FAKE_VIEW);
        store.setDirty(sampled, false);
        store.setDirty(rt, false);
        store.getData(sampled)![0] = 0x42;
        store.getData(rt)![0] = 0x24;

        const tally = store.dropGpuResources();
        expect(tally.dropped).toBe(2);
        expect(tally.contentLost).toBe(1);

        expect(store.getGpuTexture(sampled)).toBeNull();
        expect(store.getView(sampled)).toBeNull();
        expect(store.isDirty(sampled)).toBe(true);
        expect(store.getData(sampled)![0]).toBe(0x42);

        // A render target has no CPU shadow to restore FROM — re-raising dirty would upload an
        // empty buffer over content the app is about to redraw itself.
        expect(store.getGpuTexture(rt)).toBeNull();
        expect(store.isDirty(rt)).toBe(false);
        expect(store.getData(rt)![0]).toBe(0);
    });
});
