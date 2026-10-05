/**
 * WebGPU sizes a NON-indexed draw as
 *   (firstVertex + vertexCount - 1) * arrayStride + <end of the slot's last attribute>
 * and refuses an overrun, invalidating the whole frame's command buffer. Sizing it as
 * (firstVertex + vertexCount) * arrayStride instead over-triggers on an exact-fit buffer whose
 * final vertex carries trailing padding — we then substitute zeros where hardware and WebGPU
 * would both have drawn.
 */
import { describe, expect, test } from "bun:test";
import {
    MAX_VERTEX_BUFFER_SLOTS, layoutAttributeEnds, layoutStrides, padRegion, slotMaskExceedsLimit,
    vertexFormatSize, vertexRangeEndBytes,
} from "../../src/worker/backends/webgpu/shared/vertex-streams";

/** XYZ|DIFFUSE|TEX1 in a 32-byte vertex: the last attribute ends at 28, four bytes of the
 *  vertex are padding nothing reads. */
const paddedVertex: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "unorm8x4" },
        { shaderLocation: 2, offset: 16, format: "float32x3" },
    ],
};

describe("non-indexed vertex range", () => {
    test("an exact-fit buffer whose last vertex has trailing padding is IN range", () => {
        const ends = layoutAttributeEnds([paddedVertex]);
        expect(ends[0]).toBe(28);
        // 100 vertices of 32 bytes, but the buffer only holds up to the last attribute.
        const bound = 99 * 32 + 28;
        expect(vertexRangeEndBytes(0, 100, 32, ends[0]!)).toBe(bound);
        expect(vertexRangeEndBytes(0, 100, 32, ends[0]!) <= bound).toBe(true);
    });

    test("one vertex past the end is still out of range", () => {
        const ends = layoutAttributeEnds([paddedVertex]);
        const bound = 99 * 32 + 28;
        expect(vertexRangeEndBytes(0, 101, 32, ends[0]!) > bound).toBe(true);
    });

    test("firstVertex shifts the range by whole strides", () => {
        expect(vertexRangeEndBytes(10, 5, 32, 28)).toBe(14 * 32 + 28);
    });

    test("an empty draw reads nothing", () => {
        expect(vertexRangeEndBytes(0, 0, 32, 28)).toBe(0);
    });

    test("without an attribute extent the stride is the honest fallback", () => {
        // A pipeline registered by a caller that has no layouts to read ends from must not be
        // sized SHORTER than the old whole-stride rule.
        expect(vertexRangeEndBytes(0, 100, 32, 0)).toBe(100 * 32);
    });
});

describe("layouts a pipeline was built with", () => {
    test("strides and attribute ends come out per slot, holes included", () => {
        const slot2: GPUVertexBufferLayout = {
            arrayStride: 8,
            attributes: [{ shaderLocation: 3, offset: 0, format: "float32x2" }],
        };
        expect(layoutStrides([paddedVertex, null, slot2])).toEqual([32, 0, 8]);
        expect(layoutAttributeEnds([paddedVertex, null, slot2])).toEqual([28, 0, 8]);
    });

    test("attribute sizes are read from the format, never guessed", () => {
        expect(vertexFormatSize("float32x3")).toBe(12);
        expect(vertexFormatSize("unorm8x4")).toBe(4);
        expect(vertexFormatSize("float32")).toBe(4);
        expect(vertexFormatSize("float16x4")).toBe(8);
        expect(vertexFormatSize("uint32x4")).toBe(16);
        expect(vertexFormatSize("unorm10-10-10-2")).toBe(4);
    });
});

describe("robustness padding for a short slot", () => {
    test("the vertices that ARE in range keep their real bytes", () => {
        // 100 vertices asked for, 40 bound: hardware zeroes only what lies past the end.
        const r = padRegion(100 * 32, 40 * 32);
        expect(r.size).toBe(3200);
        expect(r.copyBytes).toBe(1280);
    });

    test("an unreadable source falls back to zeros for the whole slot", () => {
        expect(padRegion(3200, 0).copyBytes).toBe(0);
    });

    test("the copy never runs past what is bound, and stays on 4-byte units", () => {
        expect(padRegion(64, 4096).copyBytes).toBe(64);
        expect(padRegion(64, 30).copyBytes).toBe(28);
        expect(padRegion(30, 30).size).toBe(32);
    });
});

describe("stream slots WebGPU can bind", () => {
    test("a declaration on stream 8+ is refused, not handed to createRenderPipeline", () => {
        expect(slotMaskExceedsLimit(0b1010_0011)).toBe(false);
        expect(slotMaskExceedsLimit(1 << MAX_VERTEX_BUFFER_SLOTS)).toBe(true);
        expect(slotMaskExceedsLimit(1 << 15)).toBe(true);
    });

    test("a device advertising more slots is believed", () => {
        expect(slotMaskExceedsLimit(1 << 10, 16)).toBe(false);
    });
});
