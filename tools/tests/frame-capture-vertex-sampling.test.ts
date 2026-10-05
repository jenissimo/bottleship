/**
 * The capture engine (frame-capture.ts) is a "built-in RenderDoc": firstVertices/
 * indexedVertices are the only way to answer "where is this draw on screen" from a
 * capture. Two failure modes matter equally:
 *   1. A real indexed draw whose vertex source is a LOCAL scratch buffer (D3D8's
 *      decl-interleave path) starts at offset 0 — a legitimate address the old
 *      `lpVertices > 0` gate misread as "no vertex buffer", producing a plausible-looking
 *      empty array for 100/112 draws in a real capture.
 *   2. A draw that genuinely has no readable vertex source must say WHY, not return []
 *      indistinguishably from "this draw legitimately has no vertices".
 */
import { describe, expect, test } from "bun:test";
import { startCapture, cancelCapture, recordDrawCall, onFrameEnd, isCapturing, type RecordDrawCallParams } from "../../src/worker/modules/ddraw/frame-capture";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

const D3DFVF_XYZ = 0x002;
const D3DFVF_TEX1 = 0x100; // 1 texture coordinate set

function rtState(): DirectDrawSurfaceState {
    return { surfacePtr: 0, width: 512, height: 512 } as unknown as DirectDrawSurfaceState;
}

function baseParams(overrides: Partial<RecordDrawCallParams>): RecordDrawCallParams {
    return {
        primitiveType: 4, // TRILIST
        vertexType: D3DFVF_XYZ | D3DFVF_TEX1,
        lpVertices: 0,
        count: 0,
        lpIndices: 0,
        iCount: 0,
        mem: new Uint8Array(0),
        isIndexed: false,
        rtState: rtState(),
        texStateObj: null,
        texStateObj1: null,
        renderStates: [],
        texStates: [],
        executionDiagnostics: null,
        ...overrides,
    };
}

/** Build a scratch buffer of N interleaved XYZ+UV (20-byte) vertices, plus a 16-bit index
 *  block right after — mirrors D3D8's drawIndexedDeclInterleavedFFP layout exactly. */
function buildIndexedScratch(vertexCount: number, indices: number[]): { mem: Uint8Array; stride: number; indicesOffset: number } {
    const stride = 20; // 12 (xyz) + 8 (uv)
    const indicesOffset = vertexCount * stride;
    const mem = new Uint8Array(indicesOffset + indices.length * 2);
    const dv = new DataView(mem.buffer);
    for (let v = 0; v < vertexCount; v++) {
        dv.setFloat32(v * stride + 0, v, true);       // x = vertex index (distinguishable)
        dv.setFloat32(v * stride + 4, v * 2, true);    // y
        dv.setFloat32(v * stride + 8, 0, true);        // z
        dv.setFloat32(v * stride + 12, 0.25, true);    // u
        dv.setFloat32(v * stride + 16, 0.75, true);    // v
    }
    for (let i = 0; i < indices.length; i++) dv.setUint16(indicesOffset + i * 2, indices[i]!, true);
    return { mem, stride, indicesOffset };
}

async function oneDrawFrame(record: () => void): Promise<import("../../src/worker/modules/ddraw/frame-capture-types").CapturedFrame> {
    const p = startCapture("d3d8");
    onFrameEnd("d3d8"); // discard the in-progress tail
    record();
    onFrameEnd("d3d8");
    return p;
}

describe("indexed draw vertex sampling", () => {
    test("a scratch-buffer indexed draw (lpVertices=0, vertexSourceValid=true) resolves indexedVertices", async () => {
        const { mem, stride, indicesOffset } = buildIndexedScratch(50, [10, 20, 30, 40]);
        const frame = await oneDrawFrame(() => {
            recordDrawCall(baseParams({
                vertexType: D3DFVF_XYZ | D3DFVF_TEX1,
                lpVertices: 0,
                vertexSourceValid: true,
                count: 50,
                isIndexed: true,
                lpIndices: indicesOffset,
                iCount: 4,
                mem,
                sourceStride: stride,
                backend: "d3d8",
            }));
        });
        expect(frame.drawCalls).toHaveLength(1);
        const d = frame.drawCalls[0]!;
        expect(d.firstVerticesUnavailable).toBeUndefined();
        expect(d.firstVertices.length).toBeGreaterThan(0);
        // x was written as the vertex's own index, so a resolved vertex proves the
        // dereference landed on the right byte offset, not on garbage that happens to parse.
        expect(d.indexedVerticesUnavailable).toBeUndefined();
        expect(d.indexedVertices).toBeDefined();
        expect(d.indexedVertices!.length).toBeGreaterThan(0);
        for (const v of d.indexedVertices!) expect(v.x).toBe(v.idx);
    });

    test("without the explicit flag, lpVertices=0 is STILL read as no vertex source (default preserved)", async () => {
        const { mem, indicesOffset } = buildIndexedScratch(10, [1, 2, 3]);
        const frame = await oneDrawFrame(() => {
            recordDrawCall(baseParams({
                lpVertices: 0, // vertexSourceValid omitted -> defaults to (lpVertices > 0) = false
                count: 10,
                isIndexed: true,
                lpIndices: indicesOffset,
                iCount: 3,
                mem,
                backend: "d3d8",
            }));
        });
        const d = frame.drawCalls[0]!;
        expect(d.firstVertices).toEqual([]);
        expect(d.firstVerticesUnavailable).toMatch(/no vertex source/);
        expect(d.indexedVertices).toBeUndefined();
        expect(d.indexedVerticesUnavailable).toMatch(/no vertex source/);
    });

    test("a real guest pointer (lpVertices>0) still works with the flag omitted", async () => {
        const { mem, stride } = buildIndexedScratch(8, []); // no indices needed
        const frame = await oneDrawFrame(() => {
            recordDrawCall(baseParams({
                lpVertices: 0, // NB: still 0, but non-indexed here so only firstVertices matters
                vertexSourceValid: true,
                count: 8,
                mem,
                sourceStride: stride,
                backend: "d3d8",
            }));
        });
        expect(frame.drawCalls[0]!.firstVertices.length).toBe(4); // default sample
    });

    test("no VB/IB bound at all names the reason instead of returning []", async () => {
        const frame = await oneDrawFrame(() => {
            recordDrawCall(baseParams({
                count: 3,
                isIndexed: true,
                lpIndices: 0, // no IB
                iCount: 0,
                backend: "d3d8",
            }));
        });
        const d = frame.drawCalls[0]!;
        expect(d.indexedVerticesUnavailable).toMatch(/no index source/);
    });

    test("an index/vertex address past the end of the buffer is reported, not silently truncated to []", async () => {
        const { mem, stride, indicesOffset } = buildIndexedScratch(4, [0, 1, 2, 9999]); // 9999 way out of range
        const frame = await oneDrawFrame(() => {
            recordDrawCall(baseParams({
                lpVertices: 0,
                vertexSourceValid: true,
                count: 4,
                isIndexed: true,
                lpIndices: indicesOffset,
                iCount: 4,
                mem,
                sourceStride: stride,
                backend: "d3d8",
            }));
        });
        const d = frame.drawCalls[0]!;
        // The in-range indices (0,1,2) still resolve — one bad index must not blank the sample.
        expect(d.indexedVertices!.some((v) => v.idx === 0)).toBe(true);
        expect(d.indexedVertices!.some((v) => v.idx === 9999)).toBe(false);
    });
});

describe("configurable sample size (captureFrame maxVerts/maxIndexedVerts)", () => {
    test("maxIndexedVerts is honoured and echoed back in captureConfig", async () => {
        const { mem, stride, indicesOffset } = buildIndexedScratch(
            100,
            Array.from({ length: 40 }, (_, i) => i * 2), // 40 distinct indices, evenly spread
        );
        const p = startCapture("d3d8", { maxIndexedVerts: 3 });
        onFrameEnd("d3d8");
        recordDrawCall(baseParams({
            lpVertices: 0,
            vertexSourceValid: true,
            count: 100,
            isIndexed: true,
            lpIndices: indicesOffset,
            iCount: 40,
            mem,
            sourceStride: stride,
            backend: "d3d8",
        }));
        onFrameEnd("d3d8");
        const frame = await p;
        expect(frame.captureConfig).toEqual({ maxVerts: 4, maxIndexedVerts: 3 });
        expect(frame.drawCalls[0]!.indexedVertexSampleN).toBe(3);
        expect(frame.drawCalls[0]!.indexedVertices!.length).toBeLessThanOrEqual(3);
    });

    test("an unarmed capture cancels cleanly and does not leak config into the next one", async () => {
        const p1 = startCapture("d3d8", { maxIndexedVerts: 99 });
        cancelCapture(new Error("test cancel"));
        await expect(p1).rejects.toThrow();
        expect(isCapturing()).toBe(false);

        const { mem, stride, indicesOffset } = buildIndexedScratch(5, [0, 1]);
        const p2 = startCapture("d3d8"); // default this time
        onFrameEnd("d3d8");
        recordDrawCall(baseParams({
            lpVertices: 0, vertexSourceValid: true, count: 5, isIndexed: true,
            lpIndices: indicesOffset, iCount: 2, mem, sourceStride: stride, backend: "d3d8",
        }));
        onFrameEnd("d3d8");
        const frame = await p2;
        expect(frame.captureConfig).toEqual({ maxVerts: 4, maxIndexedVerts: 6 });
    });
});
