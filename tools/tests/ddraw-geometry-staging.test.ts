import { describe, expect, test } from "bun:test";
import { GeometryUploadWindow } from "../../src/worker/backends/webgpu/ddraw/geometry-upload-window";

describe("DDraw geometry staging", () => {
    test("coalesces vertex and index allocations until flush", () => {
        const writes: Array<{ offset: number; bytes: number[] }> = [];
        const queue = {
            writeBuffer: (_buffer: unknown, offset: number, source: ArrayBuffer, sourceOffset: number, size: number) => {
                writes.push({ offset, bytes: Array.from(new Uint8Array(source, sourceOffset, size)) });
            },
        } as unknown as GPUQueue;
        const vertex = new GeometryUploadWindow();
        const index = new GeometryUploadWindow();
        const vertexBuffer = {} as GPUBuffer;
        const indexBuffer = {} as GPUBuffer;

        vertex.stage(0, new Uint8Array([1, 2, 3]));
        vertex.stage(4, new Uint8Array([4, 5]));
        index.stage(0, new Uint8Array([6, 7]));
        expect(writes).toHaveLength(0);

        vertex.flush(queue, vertexBuffer, 8);
        index.flush(queue, indexBuffer, 4);
        expect(writes).toHaveLength(2);
        expect(writes[0]).toEqual({ offset: 0, bytes: [1, 2, 3, 0, 4, 5, 0, 0] });
        expect(writes[1]).toEqual({ offset: 0, bytes: [6, 7, 0, 0] });

        vertex.stage(8, new Uint8Array([8, 9, 10, 11]));
        vertex.flush(queue, vertexBuffer, 12);
        expect(writes[2]).toEqual({ offset: 8, bytes: [8, 9, 10, 11] });

        vertex.advanceTo(20);
        vertex.stage(20, new Uint8Array([12, 13]));
        vertex.flush(queue, vertexBuffer, 24);
        expect(writes[3].offset).toBe(20);
        // Only the two staged bytes are asserted: the tail is alignment padding the ring
        // allocator skipped over, so its contents are unread by any draw.
        expect(writes[3].bytes.slice(0, 2)).toEqual([12, 13]);
    });

    test("a window kept in step with direct writes publishes nothing", () => {
        // With geometry staging OFF the ring is written through queue.writeBuffer and the
        // window never receives those bytes. If its cursor does not follow the ring, the
        // next flush republishes that range out of a staging array that never held it —
        // an empty one makes writeBuffer throw (taking the frame's whole submit with it),
        // a stale one overwrites the geometry that was uploaded correctly.
        const writes: unknown[] = [];
        const queue = {
            writeBuffer: (...args: unknown[]) => { writes.push(args); },
        } as unknown as GPUQueue;
        const window = new GeometryUploadWindow();

        window.advanceTo(64);      // what the direct-write path now does
        window.flush(queue, {} as GPUBuffer, 64);
        expect(writes).toHaveLength(0);

        window.advanceTo(128);
        window.flush(queue, {} as GPUBuffer, 128);
        expect(writes).toHaveLength(0);
    });
});
