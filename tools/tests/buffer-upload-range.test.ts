import { describe, expect, test, beforeEach } from "bun:test";
import {
    alignUploadRange, writeDirtyRange,
    getBufferUploadCensus, resetBufferUploadCensus, noteGuestBufferWrite,
} from "../../src/worker/backends/webgpu/buffer-upload";

/** Records what would reach the GPU. `size` is all writeBuffer validation needs from us. */
function fakeQueue(): { queue: GPUQueue; writes: Array<{ offset: number; length: number }> } {
    const writes: Array<{ offset: number; length: number }> = [];
    const queue = {
        writeBuffer(_buf: GPUBuffer, offset: number, data: BufferSource, dataOffset?: number, size?: number) {
            const length = size ?? (data as Uint8Array).byteLength;
            // The two rules a real GPUQueue enforces by throwing.
            expect(offset % 4).toBe(0);
            expect(length % 4).toBe(0);
            expect(offset + length).toBeLessThanOrEqual((_buf as unknown as { size: number }).size);
            writes.push({ offset, length: length as number });
            void dataOffset;
        },
    } as unknown as GPUQueue;
    return { queue, writes };
}
const fakeBuffer = (size: number) => ({ size }) as unknown as GPUBuffer;

describe("alignUploadRange", () => {
    test("widens to 4-byte boundaries on both ends", () => {
        expect(alignUploadRange(5, 7, 64)).toEqual({ offset: 4, length: 4 });
        expect(alignUploadRange(0, 1, 64)).toEqual({ offset: 0, length: 4 });
    });

    test("an empty range uploads nothing", () => {
        expect(alignUploadRange(0, 0, 64).length).toBe(0);
        expect(alignUploadRange(32, 16, 64).length).toBe(0);
    });

    test("never runs past the GPU buffer", () => {
        // A 10-byte buffer is a 12-byte allocation; a tail lock must not write 13 bytes.
        expect(alignUploadRange(8, 10, 12)).toEqual({ offset: 8, length: 4 });
        expect(alignUploadRange(60, 64, 64)).toEqual({ offset: 60, length: 4 });
        // A range recorded against a LARGER earlier size (the store re-created under the
        // ring) must be clamped, not written past the end of the buffer that exists now.
        expect(alignUploadRange(32, 4096, 64)).toEqual({ offset: 32, length: 32 });
        expect(alignUploadRange(4096, 8192, 64).length).toBe(0);
    });
});

describe("writeDirtyRange", () => {
    test("uploads only the dirty range, aligned", () => {
        const { queue, writes } = fakeQueue();
        writeDirtyRange(queue, fakeBuffer(4096), new Uint8Array(4096), 1000, 1200, "d3d9");
        expect(writes).toEqual([{ offset: 1000, length: 200 }]);
    });

    test("zero-pads a tail the shadow does not cover", () => {
        const { queue, writes } = fakeQueue();
        // 10-byte shadow in a 12-byte buffer: the last write is 4 bytes, 2 of them padding.
        writeDirtyRange(queue, fakeBuffer(12), new Uint8Array(10), 8, 10, "d3d9");
        expect(writes).toEqual([{ offset: 8, length: 4 }]);
    });
});

describe("upload census", () => {
    beforeEach(() => resetBufferUploadCensus());

    test("reports no amplification when it has observed nothing", () => {
        const c = getBufferUploadCensus();
        expect(c.observed).toBe(false);
        expect((c.d3d9 as Record<string, unknown>).amplification).toBeNull();
    });

    test("a whole-buffer upload per small lock reads as the defect", () => {
        const { queue } = fakeQueue();
        const shadow = new Uint8Array(1 << 20);   // 1 MB dynamic VB
        for (let i = 0; i < 8; i++) {
            noteGuestBufferWrite("d3d9", 256);     // guest rewrites 256 B …
            writeDirtyRange(queue, fakeBuffer(shadow.length), shadow, 0, shadow.length, "d3d9", true);
        }
        const d3d9 = getBufferUploadCensus().d3d9 as Record<string, number>;
        expect(d3d9.amplification).toBeGreaterThan(1000);
        expect(d3d9.fullUploads).toBe(8);
    });

    test("a ranged upload per small lock reads as healthy", () => {
        const { queue } = fakeQueue();
        const shadow = new Uint8Array(1 << 20);
        for (let i = 0; i < 8; i++) {
            const off = i * 256;
            noteGuestBufferWrite("d3d9", 256);
            writeDirtyRange(queue, fakeBuffer(shadow.length), shadow, off, off + 256, "d3d9");
        }
        const d3d9 = getBufferUploadCensus().d3d9 as Record<string, number>;
        expect(d3d9.amplification).toBe(1);
        expect(d3d9.partialUploads).toBe(8);
    });

    test("keeps the two backends apart", () => {
        const { queue } = fakeQueue();
        noteGuestBufferWrite("d3d8", 1024);
        writeDirtyRange(queue, fakeBuffer(4096), new Uint8Array(4096), 0, 1024, "d3d8");
        expect((getBufferUploadCensus().d3d8 as Record<string, number>).amplification).toBe(1);
        expect((getBufferUploadCensus().d3d9 as Record<string, unknown>).amplification).toBeNull();
    });
});

describe("VertexBufferStore dirty range", () => {
    test("accumulates locked ranges and forces the whole buffer on a forced re-upload", async () => {
        const { VertexBufferStore } = await import("../../src/worker/backends/webgpu/d3d9/d3d9-resources");
        const store = new VertexBufferStore(4);
        const guestBase = 0x1000, size = 65536;
        const idx = store.create(1, size, 0, guestBase);
        const mem = new Uint8Array(guestBase + size);

        // A brand-new buffer has nothing on the GPU: its first upload must be whole.
        expect(store.getDirtyStart(idx)).toBe(0);
        expect(store.getDirtyEnd(idx)).toBe(size);

        store.setDirty(idx, false);
        expect(store.getDirtyEnd(idx)).toBe(0);

        // Two NOOVERWRITE sub-range locks accumulate into their union, not the buffer.
        store.lock(idx, 4096, 256); store.unlock(idx, mem);
        store.lock(idx, 8192, 128); store.unlock(idx, mem);
        expect(store.getDirtyStart(idx)).toBe(4096);
        expect(store.getDirtyEnd(idx)).toBe(8320);

        // Whatever forces a re-upload (device loss, ring rewind) means the whole buffer.
        store.setDirty(idx, true);
        expect(store.getDirtyStart(idx)).toBe(0);
        expect(store.getDirtyEnd(idx)).toBe(size);

        // Device loss goes through the same door.
        store.setDirty(idx, false);
        store.dropGpuResources();
        expect(store.getDirtyEnd(idx)).toBe(size);
    });
});
