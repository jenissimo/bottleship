import { afterEach, expect, test } from "bun:test";
import { newVertexReuseStats, RetainedIndexRanges, RetainedVertexConversions } from "../../src/worker/backends/webgpu/ddraw/retained-geometry";
import type { GpuVertexConversionResult } from "../../src/worker/backends/webgpu/ddraw/compute/vertex-converter";
import { useWebGpuFlags } from "./helpers/scoped-globals";

useWebGpuFlags("GPUBufferUsage");
const flags = globalThis as Record<string, unknown>;
afterEach(() => {
    delete flags.__ffpRetainedVertices;
});

function makeGeometry() {
    const allocations: GPUBuffer[] = [];
    const destroyed: GPUBuffer[] = [];
    const device = {
        limits: { maxBufferSize: 64 },
        createBuffer: () => {
            const output = { destroy: () => destroyed.push(output) } as unknown as GPUBuffer;
            allocations.push(output);
            return output;
        },
    } as unknown as GPUDevice;
    const source = {} as GPUBuffer;
    const result = { buffer: source, offset: 128, size: 32, stride: 16, count: 2 } as GpuVertexConversionResult;
    const owner = () => ({} as GPUCommandEncoder);
    return { device, result, owner, allocations, destroyed };
}

test("vertex ranges can reuse recorded bytes in the owner epoch only", () => {
    flags.__ffpRetainedVertices = true;
    const cache = new RetainedVertexConversions();
    const { device, result, owner } = makeGeometry();
    const range = "buffer-version:32:vertices2:fvf2:stride16";
    cache.remember(range, 5, result, device, owner(), () => { throw new Error("unexpected copy"); });
    expect(cache.find(range, 5, 32)).toBe(result);
    expect(cache.find(range, 6, 32)).toBeNull();
    expect(cache.find(range + ":mutated", 5, 32)).toBeNull();
    flags.__ffpRetainedVertices = "measure";
    expect(cache.find(range, 5, 32)).toBeNull();
});

test("default raw ranges persist while GPU-computed ranges stay within their recording", () => {
    const { device, result, owner } = makeGeometry();
    const raw = new RetainedVertexConversions(newVertexReuseStats(), "persistent");
    const converted = new RetainedVertexConversions();
    const encoder = owner();
    let rawCopies = 0, convertedCopies = 0;
    for (const epoch of [1, 2]) {
        raw.remember("A", epoch, result, device, encoder, () => { rawCopies++; });
        converted.remember("A", epoch, result, device, encoder, () => { convertedCopies++; });
    }
    expect(rawCopies).toBe(1);
    expect(convertedCopies).toBe(0);
    raw.retire(encoder, true);
    expect(raw.find("A", 3, 32)).not.toBeNull();
    expect(converted.find("A", 3, 32)).toBeNull();
    flags.__ffpRetainedVertices = false;
    expect(raw.find("A", 3, 32)).toBeNull();
});

test("a promotion survives its owner submission with the exact output offset", () => {
    flags.__ffpRetainedVertices = "persistent";
    const cache = new RetainedVertexConversions();
    const { device, result, owner, allocations } = makeGeometry();
    const encoded = owner();
    const copied: Array<[GPUBuffer, number]> = [];
    for (const key of ["A", "B"]) {
        cache.remember(key, 1, result, device, owner(), () => {});
        cache.remember(key, 2, result, device, encoded, (buffer, offset) => copied.push([buffer, offset]));
    }
    expect(copied).toEqual([[allocations[0], 0], [allocations[0], 32]]);
    expect(cache.find("B", 2, 8)).toEqual({ ...result, buffer: allocations[0], offset: 32 });
    expect(cache.find("B", 3, 8)).toBeNull();
    cache.retire(encoded, true);
    expect(cache.find("B", 3, 8)).toEqual({ ...result, buffer: allocations[0], offset: 32 });
    expect(cache.find("B:mutated", 3, 8)).toBeNull();
});

test("rotation keeps the previous GPU arena alive until the encoder retires", () => {
    flags.__ffpRetainedVertices = "persistent";
    const cache = new RetainedVertexConversions();
    const { device, result, owner, allocations, destroyed } = makeGeometry();
    const first = owner();
    for (const key of ["A", "B"]) {
        cache.remember(key, 1, result, device, owner(), () => {});
        cache.remember(key, 2, result, device, first, () => {});
    }
    cache.retire(first, true);
    const second = owner();
    expect(cache.find("A", 3, 32)?.buffer).toBe(allocations[0]);
    cache.remember("C", 2, result, device, first, () => {});
    cache.remember("C", 3, result, device, second, () => {});
    expect(destroyed).toEqual([]);
    expect(cache.find("C", 3, 32)?.buffer).toBe(allocations[1]);
    cache.retire(second, false);
    expect(cache.find("C", 4, 32)).toBeNull();
    expect(destroyed).toEqual([allocations[0]]);
    cache.reset(true);
    expect(destroyed).toEqual(allocations);
});

test("index bounds survive changing encoders, but ring offsets must be recorded again", () => {
    flags.__ffpRetainedVertices = true;
    const cache = new RetainedIndexRanges();
    const oldKey = "ib:version:offset:count:uint16";
    const changed = "ib:new-version:offset:count:uint16";
    const buffer = {} as GPUBuffer;
    cache.rememberBounds(oldKey, 127, 191);
    cache.rememberUpload(oldKey + ":trianglelist", 5, buffer, 256);
    expect(cache.findBounds(oldKey)).toEqual({ min: 127, max: 191 });
    expect(cache.findUpload(oldKey + ":trianglelist", 5, 32)).toEqual({ epoch: 5, buffer, offset: 256 });
    expect(cache.findUpload(oldKey + ":trianglefan", 5, 32)).toBeUndefined();
    expect(cache.findUpload(oldKey + ":trianglelist", 6, 32)).toBeUndefined();
    expect(cache.findBounds(changed)).toBeUndefined();
});
