/**
 * gpuCensus counts what the prototypes it wraps create and retire. A census that reports
 * zero live objects because it never saw them is indistinguishable from a clean run, so this
 * pins the ledger against stand-in WebGPU classes: creates are counted, destroy() and a
 * postMessage transfer retire, and a creation site names the caller.
 */

import { describe, expect, test } from "bun:test";

class FakeBuffer { constructor(readonly size: number) {} destroy(): void {} }
class FakeTexture { destroy(): void {} }
class FakeDevice {
    createBuffer(d: { size: number }): FakeBuffer { return new FakeBuffer(d.size); }
    createTexture(_d: unknown): FakeTexture { return new FakeTexture(); }
}
const g = globalThis as unknown as Record<string, unknown>;
g.GPUDevice ??= FakeDevice;
g.GPUBuffer ??= FakeBuffer;
g.GPUTexture ??= FakeTexture;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };

const { armGpuResourceCensus, gpuResourceCensus } = await import("../../src/worker/core/gpu/gpu-resource-census");

function allocateVertexBuffer(device: FakeDevice): FakeBuffer {
    return device.createBuffer({ size: 1024, usage: 32 | 8 } as never);
}

describe("gpu resource census", () => {
    test("live = created - destroyed, by tag and by site", () => {
        const Device = g.GPUDevice as typeof FakeDevice;
        if (Device !== FakeDevice) return; // a real WebGPU runtime: the fakes were not installed
        armGpuResourceCensus("test", { sites: true, reset: true });
        const device = new FakeDevice();
        const a = allocateVertexBuffer(device);
        allocateVertexBuffer(device);
        allocateVertexBuffer(device);
        a.destroy();
        a.destroy(); // a second destroy must not retire twice
        device.createTexture({ size: { width: 16, height: 16 }, format: "rgba8unorm" });

        const c = gpuResourceCensus();
        expect(c.kinds.buffer).toMatchObject({ created: 3, destroyed: 1, live: 2, liveBytes: 2048 });
        expect(c.kinds.texture).toMatchObject({ created: 1, live: 1, liveBytes: 16 * 16 * 4 });
        expect(c.liveByTag.find((t) => t.tag === "buffer:COPY_DST|VERTEX")).toMatchObject({ live: 2, bytes: 2048 });
        expect(c.liveBySite.some((s) => s.kind === "buffer" && s.site.includes("gpu-resource-census.test"))).toBe(true);
    });

    test("objects created before arming are never counted, even when destroyed after", () => {
        const Device = g.GPUDevice as typeof FakeDevice;
        if (Device !== FakeDevice) return;
        const device = new FakeDevice();
        armGpuResourceCensus("test", { reset: true });
        const early = allocateVertexBuffer(device);
        armGpuResourceCensus("test", { reset: true });
        early.destroy();
        const c = gpuResourceCensus();
        expect(c.kinds.buffer).toMatchObject({ created: 0, destroyed: 0, live: 0 });
    });
});
