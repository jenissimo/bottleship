/**
 * WebGPU sizes a NON-indexed draw as (firstVertex + vertexCount - 1) * arrayStride + <end of the
 * slot's last attribute> and rejects an overrun — and the rejection kills the WHOLE command
 * buffer, not the one draw. The executor's guard (planVertexRangePadding) reconciles that with
 * hardware robustness (an out-of-range fetch reads zeros), but it is driven by the pipeline's
 * per-slot strides: register a pipeline without them and the guard is a silent no-op. D3D8 folds
 * firstVertex into the binding offset and draws from vertex 0, so the comparison is only
 * meaningful if the bound SIZE is measured from that same offset.
 *
 * The rules themselves come from vertex-streams.ts — the very functions the executor calls, so a
 * change to either can actually fail this file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
    bindingSize, layoutStrides, vertexRangeEndBytes,
} from "../../src/worker/backends/webgpu/shared/vertex-streams";

/** Strides as registerPipeline receives them, from the layouts the pipeline was built with. */
function stridesOf(buffers: ({ arrayStride: number } | null)[]): number[] {
    return layoutStrides(buffers as (GPUVertexBufferLayout | null)[]);
}

/** The guard's verdict for one slot. True = the slot covers the draw; false = padding stands in.
 *  `attrEnd` 0 is the executor's own fallback for a slot with no attribute-end recorded. */
function slotCovers(stride: number, boundSize: number, firstVertex: number, vertexCount: number,
                    attrEnd = 0): boolean {
    if (stride <= 0) return true;
    return vertexRangeEndBytes(firstVertex, vertexCount, stride, attrEnd) <= boundSize;
}

describe("d3d8 pipeline strides reach the vertex-range guard", () => {
    test("null holes in the layout array become stride 0, keeping slot numbering", () => {
        // linkProgram emits one layout per used stream, slot = stream number, holes kept as null.
        expect(stridesOf([{ arrayStride: 32 }, null, { arrayStride: 8 }])).toEqual([32, 0, 8]);
    });

    test("an empty stride array disables the guard for every slot", () => {
        // The defect: registerPipeline(pipeline, hasTexture, true) left strides = [].
        const strides: number[] = [];
        const anyChecked = strides.some(s => s > 0);
        expect(anyChecked).toBe(false);
    });

    test("a stride of 0 is skipped, not treated as a zero-length requirement", () => {
        expect(slotCovers(0, 0, 0, 3000)).toBe(true);
    });

    test("the D3D8 call site passes per-slot strides from the pipeline's own layouts", () => {
        const src = readFileSync(
            join(import.meta.dir, "../../src/worker/backends/webgpu/d3d8/d3d8-programmable-draw.ts"),
            "utf8",
        );
        const call = /registerPipeline\(([^;]*?)\);/s.exec(src);
        expect(call).not.toBeNull();
        // Derived from link.vertexBuffers — the same array handed to createRenderPipeline —
        // rather than a stride guessed from state that the pipeline may not have been built with.
        expect(call![1]).toMatch(/link\.vertexBuffers\.map\(\s*b\s*=>\s*b\?\.arrayStride\s*\?\?\s*0\s*\)/);
    });
});

describe("folded-origin vs GPU-applied firstVertex", () => {
    // D3D8: DrawPrimitive(startVertex=1000, 3 verts) over a 1024-vertex, 32-byte VB.
    const stride = 32, bufferSize = 1024 * stride, startVertex = 1000, vertexCount = 3;

    test("D3D8 folds the vertex offset into the binding and draws from vertex 0", () => {
        const offset = startVertex * stride;
        const size = bindingSize(bufferSize, offset);
        // 24 vertices remain from the fold point; 3 are asked for.
        expect(slotCovers(stride, size, 0, vertexCount)).toBe(true);
    });

    test("D3D9 leaves the offset to the GPU and gets the same verdict", () => {
        // Same draw, opposite convention: the binding starts at 0 and firstVertex reaches the GPU.
        expect(slotCovers(stride, bindingSize(bufferSize, 0), startVertex, vertexCount)).toBe(true);
    });

    test("a size measured from the BUFFER while the offset is folded hides a real overrun", () => {
        // The bug the two conventions invite: 1022 of 1024 vertices consumed, 3 asked for.
        const first = 1022;
        const offset = first * stride;
        expect(slotCovers(stride, bindingSize(bufferSize, offset), 0, 3)).toBe(false); // honest
        expect(slotCovers(stride, bufferSize, 0, 3)).toBe(true);                       // blind
    });

    test("an exactly-sized upload is not treated as an overrun", () => {
        // DrawPrimitiveUP writes vertexCount * stride bytes and binds all of them.
        expect(slotCovers(stride, vertexCount * stride, 0, vertexCount)).toBe(true);
    });

    test("the last vertex is sized by its final attribute, not by a whole stride", () => {
        // 3 vertices whose attributes end 8 bytes before the stride: the buffer holding exactly
        // (3*stride - 8) bytes is legal, and sizing by the stride would reject it.
        const attrEnd = stride - 8;
        expect(slotCovers(stride, 2 * stride + attrEnd, 0, vertexCount, attrEnd)).toBe(true);
        expect(slotCovers(stride, 2 * stride + attrEnd - 1, 0, vertexCount, attrEnd)).toBe(false);
    });

    test("a stream one vertex short is caught under both conventions", () => {
        const shortBuffer = (vertexCount - 1) * stride;
        expect(slotCovers(stride, shortBuffer, 0, vertexCount)).toBe(false);
        expect(slotCovers(stride, bindingSize(shortBuffer + 2 * stride, 2 * stride), 0, vertexCount)).toBe(false);
    });
});
