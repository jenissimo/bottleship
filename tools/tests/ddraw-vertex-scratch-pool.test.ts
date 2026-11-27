/**
 * VertexConverter's frame-scoped scratch pool.
 *
 * The property under test is the ORDERING INVARIANT, not the allocation count: a range
 * referenced by a recorded-but-unsubmitted dispatch must never be rewritten. The pool
 * satisfies it by bump-allocating disjoint sub-ranges per conversion and rewinding only in
 * startFrame(), which every caller reaches after queue.submit(). So the tests assert that
 * within one frame no two conversions share a source range, a params slot or a destination,
 * and that a rewind happens across the frame boundary.
 *
 * The allocation counts ride along: they are what the change is FOR, and `conversions` is
 * what makes them readable (zero objects created says nothing if nothing ran).
 */
import { describe, expect, test, afterEach } from "bun:test";
// Prime the module graph: ddraw/constants participates in an import cycle through
// core/com/com-memory → … → d3d/types (which reads constants at module scope).
import "../../src/worker/modules/ddraw/d3d/types";
import {
    VertexConverter,
    OUTPUT_VERTEX_BYTES,
} from "../../src/worker/backends/webgpu/ddraw/compute/vertex-converter";
import { D3DFVF_XYZRHW, D3DFVF_DIFFUSE } from "../../src/worker/modules/ddraw/constants";
import { useWebGpuFlags } from "./helpers/scoped-globals";

useWebGpuFlags("GPUShaderStage", "GPUBufferUsage");

const KILL_SWITCH = "__noVertexScratchPool";
const BATCH_SWITCH = "__ffpVertexSourceBatch";
afterEach(() => {
    const flags = globalThis as Record<string, unknown>;
    delete flags[KILL_SWITCH];
    delete flags[BATCH_SWITCH];
});

const FVF = D3DFVF_XYZRHW | D3DFVF_DIFFUSE; // 20-byte stride
const STRIDE = 20;
const VERTS = 128; // above GPU_VERTEX_THRESHOLD, and a whole number of workgroups

interface Dispatch {
    /** Dynamic offset the params slot was bound at. */
    paramsOffset: number;
    /** Identity of the bind group used (bind groups are handed out as {id}). */
    bindGroupId: number;
}

interface Recorded {
    dispatches: Dispatch[];
    /** queue.writeBuffer calls as [bufferId, offset, size]. */
    writes: Array<[number, number, number]>;
    payloads: Uint8Array[];
    buffersCreated: number;
    bindGroupsCreated: number;
    failWrite?: boolean;
    failNextStorageAllocation?: boolean;
    destroyed: number[];
}

function makeHarness(): { converter: VertexConverter; rec: Recorded; encoder: GPUCommandEncoder } {
    const rec: Recorded = { dispatches: [], writes: [], payloads: [], buffersCreated: 0, bindGroupsCreated: 0, destroyed: [] };
    let nextBufferId = 1;
    let nextBindGroupId = 1;

    const device = {
        limits: {
            maxBufferSize: 8 << 20,
            maxStorageBufferBindingSize: 8 << 20,
            minUniformBufferOffsetAlignment: 256,
        },
        createBindGroupLayout: () => ({}),
        createBuffer: (desc: GPUBufferDescriptor & { mappedAtCreation?: boolean }) => {
            if (rec.failNextStorageAllocation && desc.usage === (GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE)) {
                rec.failNextStorageAllocation = false;
                throw new Error("test source arena allocation failure");
            }
            rec.buffersCreated++;
            const id = nextBufferId++;
            const backing = new ArrayBuffer(Number(desc.size));
            return {
                id,
                size: desc.size,
                getMappedRange: () => backing,
                unmap: () => {},
                destroy: () => rec.destroyed.push(id),
            };
        },
        createBindGroup: () => {
            rec.bindGroupsCreated++;
            return { id: nextBindGroupId++ };
        },
        createShaderModule: () => ({}),
        createPipelineLayout: () => ({}),
        createComputePipeline: () => ({}),
    } as unknown as GPUDevice;

    const queue = {
        writeBuffer: (buffer: { id: number }, offset: number, src: ArrayBufferLike, srcOff: number, size: number) => {
            if (rec.failWrite) throw new Error("test upload failure");
            rec.writes.push([buffer.id, offset, size ?? 0]);
            rec.payloads.push(new Uint8Array(src, srcOff, size).slice());
        },
    } as unknown as GPUQueue;

    let pending: Dispatch | null = null;
    const encoder = {
        beginComputePass: () => ({
            setPipeline: () => {},
            setBindGroup: (_i: number, bg: { id: number }, dyn: number[]) => {
                pending = { paramsOffset: dyn[0], bindGroupId: bg.id };
            },
            dispatchWorkgroups: () => {},
            end: () => {
                if (pending) rec.dispatches.push(pending);
                pending = null;
            },
        }),
        copyBufferToBuffer: () => {},
    } as unknown as GPUCommandEncoder;

    return { converter: new VertexConverter(device, queue), rec, encoder };
}

/** One conversion of VERTS vertices out of a guest-memory stand-in. */
function convert(converter: VertexConverter, encoder: GPUCommandEncoder) {
    const memory = new Uint8Array(VERTS * STRIDE);
    return converter.convertToGpuBuffer(encoder, memory, 0, VERTS, FVF, 640, 480, STRIDE, 0, 0);
}

describe("VertexConverter scratch pool", () => {
    test("default batch upload preserves both snapshots of reused guest and declaration data", () => {
        const { converter, rec, encoder } = makeHarness();
        const backing = new Uint8Array(96);
        backing.fill(0x99);
        const view = backing.subarray(16, 80);
        const draw = () => converter.convertToGpuBuffer(encoder, view, 4, 1, FVF, 640, 480, STRIDE);
        view.fill(0x14, 4, 24);
        expect(draw()).not.toBeNull();
        view.fill(0x35, 4, 24);
        expect(draw()).not.toBeNull();
        view.fill(0x61, 4, 24);
        expect(rec.writes).toHaveLength(0);
        converter.flushParams();
        expect(rec.writes.map(([, offset, size]) => [offset, size])).toEqual([[0, 52], [0, 512]]);
        const src = rec.payloads[0]!;
        expect([...src.slice(0, 20)]).toEqual(Array(20).fill(0x14));
        expect([...src.slice(20, 32)]).toEqual(Array(12).fill(0));
        expect([...src.slice(32)]).toEqual(Array(20).fill(0x35));
        const params = new DataView(rec.payloads[1]!.buffer);
        expect(params.getUint32(24, true)).toBe(0);
        expect(params.getUint32(256 + 24, true)).toBe(32);
        converter.flushParams();
        expect(rec.writes).toHaveLength(2);
    });

    test("rolling the host chunk preserves its destination range within the same GPU buffer", () => {
        (globalThis as Record<string, unknown>)[BATCH_SWITCH] = true;
        const { converter, rec, encoder } = makeHarness();
        const warmVertices = 30_000;
        const warm = new Uint8Array(warmVertices * STRIDE);
        expect(converter.convertToGpuBuffer(encoder, warm, 0, warmVertices, FVF, 640, 480, STRIDE)).not.toBeNull();
        converter.flushParams();
        converter.startFrame();
        rec.writes.length = 0;
        rec.payloads.length = 0;
        const bytesPerDraw = VERTS * STRIDE;
        const memory = new Uint8Array(bytesPerDraw);
        const drawsPerChunk = Math.floor((256 * 1024) / bytesPerDraw);
        for (let i = 0; i <= drawsPerChunk; i++) {
            memory[0] = i + 1;
            expect(converter.convertToGpuBuffer(encoder, memory, 0, VERTS, FVF, 640, 480, STRIDE)).not.toBeNull();
        }
        expect(rec.writes).toHaveLength(1);
        converter.flushParams();
        const firstBytes = drawsPerChunk * bytesPerDraw;
        expect(rec.writes.slice(0, 2)).toEqual([
            [rec.writes[0]![0], 0, firstBytes],
            [rec.writes[0]![0], firstBytes, bytesPerDraw],
        ]);
        expect(rec.payloads[0]![0]).toBe(1);
        expect(rec.payloads[0]![(drawsPerChunk - 1) * bytesPerDraw]).toBe(drawsPerChunk);
        expect(rec.payloads[1]![0]).toBe(drawsPerChunk + 1);
    });

    test("scratch growth uploads the previous buffer before enqueuing a larger range", () => {
        (globalThis as Record<string, unknown>)[BATCH_SWITCH] = true;
        const { converter, rec, encoder } = makeHarness();
        const first = convert(converter, encoder);
        const vertices = 60_000;
        const memory = new Uint8Array(vertices * STRIDE);
        const second = converter.convertToGpuBuffer(encoder, memory, 0, vertices, FVF, 640, 480, STRIDE);
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        converter.flushParams();
        const uploaded = rec.writes.filter(([, , size]) => size === VERTS * STRIDE || size === memory.length);
        expect(uploaded.map(([, offset, size]) => [offset, size])).toEqual([[0, VERTS * STRIDE], [0, memory.length]]);
        expect(uploaded[0]![0]).not.toBe(uploaded[1]![0]);
        converter.startFrame();
        expect(converter.getScratchStats().unflushedParams).toBe(0);
    });

    test("failed writes keep the captured source intact until a successful retry", () => {
        const { converter, rec, encoder } = makeHarness();
        const source = new Uint8Array(VERTS * STRIDE).fill(7);
        expect(converter.convertToGpuBuffer(encoder, source, 0, VERTS, FVF)).not.toBeNull();
        rec.failWrite = true;
        expect(() => converter.flushParams()).toThrow("test upload failure");
        source.fill(61);
        rec.failWrite = false;
        converter.flushParams();
        expect(rec.payloads[0]).toEqual(new Uint8Array(VERTS * STRIDE).fill(7));
        converter.startFrame();
        expect(converter.getScratchStats().unflushedParams).toBe(0);
    });

    test("a failed scratch replacement leaves the prior arena alive for the next frame", () => {
        const { converter, rec, encoder } = makeHarness();
        expect(convert(converter, encoder)).not.toBeNull();
        const vertices = 60_000;
        rec.failNextStorageAllocation = true;
        expect(converter.convertToGpuBuffer(encoder, new Uint8Array(vertices * STRIDE), 0, vertices, FVF)).toBeNull();
        converter.flushParams();
        converter.destroyPendingAfterSubmit();
        converter.startFrame();
        const sourceId = rec.writes[0]![0];
        expect(rec.destroyed).not.toContain(sourceId);
        expect(convert(converter, encoder)).not.toBeNull();
        converter.flushParams();
        expect(rec.writes[2]![0]).toBe(sourceId);
    });

    test("the upload opt-out keeps disjoint per-draw source writes and params slots", () => {
        (globalThis as Record<string, unknown>)[BATCH_SWITCH] = false;
        const { converter, rec, encoder } = makeHarness();

        const results = [convert(converter, encoder), convert(converter, encoder), convert(converter, encoder)];
        expect(results.every((r) => r !== null)).toBe(true);

        // Destinations: distinct, stride-aligned offsets into the one global vertex buffer.
        const dstOffsets = results.map((r) => r!.offset);
        expect(new Set(dstOffsets).size).toBe(3);
        for (const o of dstOffsets) expect(o % OUTPUT_VERTEX_BYTES).toBe(0);
        expect(new Set(results.map((r) => r!.buffer)).size).toBe(1);

        // Params slots: distinct and correctly aligned for a dynamic uniform offset.
        const slots = rec.dispatches.map((d) => d.paramsOffset);
        expect(slots).toEqual([0, 256, 512]);
        expect(new Set(rec.dispatches.map((d) => d.bindGroupId)).size).toBe(1);

        // Source staging: distinct, non-overlapping ranges of the one arena.
        const srcWrites = rec.writes.filter(([, , size]) => size === VERTS * STRIDE);
        expect(srcWrites.length).toBe(3);
        expect(new Set(srcWrites.map(([id]) => id)).size).toBe(1);
        const starts = srcWrites.map(([, off]) => off).sort((a, b) => a - b);
        for (let i = 1; i < starts.length; i++) {
            expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1] + VERTS * STRIDE);
        }
    });

    test("the arenas rewind at the frame boundary, not within a frame", () => {
        (globalThis as Record<string, unknown>)[BATCH_SWITCH] = false;
        const { converter, rec, encoder } = makeHarness();

        convert(converter, encoder);
        convert(converter, encoder);
        const beforeRewind = rec.writes.filter(([, , size]) => size === VERTS * STRIDE).map(([, off]) => off);
        expect(beforeRewind[1]).toBeGreaterThan(beforeRewind[0]);

        // startFrame() is only reached after queue.submit(), so reuse from zero is legal there.
        converter.flushParams();
        converter.startFrame();
        convert(converter, encoder);

        const after = rec.writes.filter(([, , size]) => size === VERTS * STRIDE).map(([, off]) => off);
        expect(after[2]).toBe(0);
        expect(rec.dispatches[2].paramsOffset).toBe(0);
        expect(converter.getScratchStats().unflushedParams).toBe(0);
    });

    test("steady state creates no GPU objects, and says how many conversions back that up", () => {
        const { converter, rec, encoder } = makeHarness();

        // Warm-up frame: the arenas and the bind group are created here.
        for (let i = 0; i < 4; i++) convert(converter, encoder);
        converter.flushParams();
        converter.startFrame();

        const buffersAfterWarmup = rec.buffersCreated;
        const bindGroupsAfterWarmup = rec.bindGroupsCreated;
        const statsAfterWarmup = converter.getScratchStats();

        for (let i = 0; i < 4; i++) convert(converter, encoder);

        expect(rec.buffersCreated).toBe(buffersAfterWarmup);
        expect(rec.bindGroupsCreated).toBe(bindGroupsAfterWarmup);

        const stats = converter.getScratchStats();
        expect(stats.enabled).toBe(true);
        // The counter that makes "zero objects" mean something.
        expect(stats.conversions - statsAfterWarmup.conversions).toBe(4);
        expect(stats.gpuObjects - statsAfterWarmup.gpuObjects).toBe(0);
        expect(stats.perDraw).toBe(0);
    });

    test("the kill switch restores the per-draw allocation path", () => {
        const { converter, rec, encoder } = makeHarness();
        convert(converter, encoder); // pooled, so the global vertex buffer already exists
        const baseline = rec.buffersCreated;

        (globalThis as Record<string, unknown>)[KILL_SWITCH] = true;
        convert(converter, encoder);

        // src + dst + params, freshly allocated, plus its own bind group.
        expect(rec.buffersCreated - baseline).toBe(3);
        expect(rec.bindGroupsCreated).toBe(2);
        expect(rec.dispatches[1].paramsOffset).toBe(0);
        expect(converter.getScratchStats().perDraw).toBe(1);
    });
});
