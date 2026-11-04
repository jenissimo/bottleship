import { describe, expect, it } from "bun:test";
import { RingBufferManager } from "../../src/worker/backends/webgpu/ddraw/ring-buffer-manager";
import { DEFAULT_RING_BUFFER_CONFIG, DEFAULT_STORAGE_BUFFER_CONFIG, DEFAULT_UNIFORM_BUFFER_CONFIG } from "../../src/worker/backends/webgpu/ddraw/types";

const g = globalThis as Record<string, unknown>;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200 };

interface FakeBuffer { id: number; size: number; usage: number; label?: string; destroyed: boolean; bytes: Uint8Array; destroy(): void }

function fakeGpu() {
    let next = 1;
    const buffers: FakeBuffer[] = [];
    const device = {
        limits: { minUniformBufferOffsetAlignment: 256 },
        createBuffer(desc: { size: number; usage: number; label?: string }): FakeBuffer {
            const b: FakeBuffer = { id: next++, size: desc.size, usage: desc.usage, label: desc.label, destroyed: false,
                bytes: new Uint8Array(desc.size), destroy() { this.destroyed = true; } };
            buffers.push(b);
            return b;
        },
    };
    const queue = {
        writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferLike, dataOffset = 0, size?: number) {
            if (buffer.destroyed) throw new Error("write to destroyed buffer");
            const src = new Uint8Array(data as ArrayBuffer, dataOffset, size ?? (data.byteLength - dataOffset));
            if (offset + src.length > buffer.size) throw new Error(`write past end of buffer ${buffer.id}`);
            buffer.bytes.set(src, offset);
        },
    };
    return { device: device as unknown as GPUDevice, queue: queue as unknown as GPUQueue, buffers };
}

const SMALL = { bufferSize: 1024, indexBufferSize: 256, maxBufferSize: 8192, bufferCount: 3 };
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

describe("RingBufferManager: geometry rings grow on demand", () => {
    it("default config starts small: no 128 MB rings up front", () => {
        const { device, queue, buffers } = fakeGpu();
        new RingBufferManager(device, queue);
        const total = buffers.reduce((s, b) => s + b.size, 0);
        const mb = 1024 * 1024;
        expect(DEFAULT_RING_BUFFER_CONFIG.maxBufferSize).toBe(128 * mb);
        expect(buffers.filter((b) => b.label === "ddraw-vertex-ring").map((b) => b.size)).toEqual([16 * mb, 16 * mb, 16 * mb]);
        expect(buffers.filter((b) => b.label === "ddraw-index-ring").map((b) => b.size)).toEqual([4 * mb, 4 * mb, 4 * mb]);
        // vertex + index + uniform + lights + storage, x3
        expect(total).toBe(3 * (16 * mb + 4 * mb + 2 * DEFAULT_UNIFORM_BUFFER_CONFIG.bufferSize + DEFAULT_STORAGE_BUFFER_CONFIG.bufferSize));
        expect(total).toBeLessThan(100 * mb);
    });

    it("an allocation past the current size moves to a bigger buffer; earlier data stays in the old one", () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue, SMALL);
        const a = rbm.allocateVertexData(fill(800, 0xa1));
        const b = rbm.allocateVertexData(fill(400, 0xb2));
        expect(a.overflow).toBeUndefined();
        expect(b.overflow).toBeUndefined();
        expect(b.buffer).not.toBe(a.buffer);
        expect(a.offset).toBe(0);
        expect(b.offset).toBe(0);
        rbm.flushGeometry(); // what the executor does before submitting
        const oldBuf = a.buffer as unknown as FakeBuffer, newBuf = b.buffer as unknown as FakeBuffer;
        expect(oldBuf.destroyed).toBe(false);          // recorded draws still name it
        expect(oldBuf.bytes.subarray(0, 800).every((x) => x === 0xa1)).toBe(true);
        expect(newBuf.size).toBe(2048);
        expect(newBuf.bytes.subarray(0, 400).every((x) => x === 0xb2)).toBe(true);
        // Subsequent allocations continue after b in the new buffer.
        const c = rbm.allocateVertexData(fill(100, 0xc3));
        expect(c.buffer).toBe(b.buffer);
        expect(c.offset).toBe(400);
        expect(rbm.getGeometryRingStats().growths.vertex).toBe(1);
    });

    it("ensureSpaceForDraw grows geometry rings without a flush or a ring switch", () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue, SMALL);
        rbm.allocateVertexData(fill(1000, 1));
        let flushes = 0;
        const switched = rbm.ensureSpaceForDraw(500, 300, 256, () => { flushes++; });
        expect(switched).toBe(false);
        expect(flushes).toBe(0);
        expect(rbm.getCurrentFrameIndex()).toBe(0);
        const v = rbm.allocateVertexData(fill(500, 2));
        const i = rbm.allocateIndexData(fill(300, 3));
        expect(v.overflow).toBeUndefined();
        expect(i.overflow).toBeUndefined();
        expect(rbm.getGeometryRingStats().vertexSizes[0]).toBe(2048);
        expect(rbm.getGeometryRingStats().indexSizes[0]).toBe(512);
    });

    it("grows straight to a size that fits a large request, capped at the ceiling", () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue, SMALL);
        const big = rbm.allocateVertexData(fill(5000, 4));
        expect(big.overflow).toBeUndefined();
        expect((big.buffer as unknown as FakeBuffer).size).toBe(8192);
        const tooBig = rbm.allocateVertexData(fill(9000, 5));
        expect(tooBig.overflow).toBe(true);
    });

    it("retired buffers are destroyed only after every ring has rotated past them", () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue, SMALL);
        const a = rbm.allocateVertexData(fill(1000, 1));
        rbm.allocateVertexData(fill(100, 1));
        const old = a.buffer as unknown as FakeBuffer;
        for (let f = 0; f < 3; f++) { rbm.nextFrame(); expect(old.destroyed).toBe(false); }
        rbm.nextFrame();
        expect(old.destroyed).toBe(true);
    });

    it("the other rings adopt the grown size when entered, so growth happens once", () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue, SMALL);
        rbm.allocateVertexData(fill(1500, 1));
        rbm.nextFrame();
        rbm.nextFrame();
        expect(rbm.getGeometryRingStats().vertexSizes).toEqual([2048, 2048, 2048]);
        // A same-sized frame on a new ring does not grow again.
        const before = rbm.getGeometryRingStats().growths.vertex;
        rbm.allocateVertexData(fill(1500, 1));
        expect(rbm.getGeometryRingStats().growths.vertex).toBe(before);
    });

    it("staging off: data written directly is not re-published after growth", () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue, SMALL);
        rbm.setGeometryStagingEnabled(false);
        const a = rbm.allocateVertexData(fill(900, 7));
        const b = rbm.allocateVertexData(fill(900, 8));
        expect(() => rbm.flushGeometry()).not.toThrow();
        expect((a.buffer as unknown as FakeBuffer).bytes[899]).toBe(7);
        expect((b.buffer as unknown as FakeBuffer).bytes[899]).toBe(8);
    });

    it("a frame that would overflow the light-set ring switches rings instead of reusing a slot", () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue, SMALL,
            { slotSize: 768, bufferSize: 4096 }, { slotSize: 512, bufferSize: 4096 });
        // 4096-byte lights ring, 1024-byte slots: four fit, a fifth would not.
        for (let k = 0; k < 4; k++) rbm.allocateLightSlot(undefined);
        let flushes = 0;
        expect(rbm.ensureSpaceForDraw(0, 0, 0, () => { flushes++; })).toBe(true);
        expect(flushes).toBe(1);
        expect(rbm.getCurrentFrameIndex()).toBe(1);
        expect(rbm.lightsOverflowCount).toBe(0);
    });
});
