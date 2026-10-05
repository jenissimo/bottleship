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

const KILL_SWITCH = "__noVertexScratchPool";
afterEach(() => delete (globalThis as Record<string, unknown>)[KILL_SWITCH]);

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
    buffersCreated: number;
    bindGroupsCreated: number;
}

function makeHarness(): { converter: VertexConverter; rec: Recorded; encoder: GPUCommandEncoder } {
    (globalThis as Record<string, unknown>).GPUShaderStage ??= { COMPUTE: 4 };
    (globalThis as Record<string, unknown>).GPUBufferUsage ??= {
        VERTEX: 32, STORAGE: 128, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1,
    };

    const rec: Recorded = { dispatches: [], writes: [], buffersCreated: 0, bindGroupsCreated: 0 };
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
            rec.buffersCreated++;
            const id = nextBufferId++;
            const backing = new ArrayBuffer(Number(desc.size));
            return {
                id,
                size: desc.size,
                getMappedRange: () => backing,
                unmap: () => {},
                destroy: () => {},
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
        writeBuffer: (buffer: { id: number }, offset: number, _src: unknown, _srcOff: number, size: number) => {
            rec.writes.push([buffer.id, offset, size ?? 0]);
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
    test("conversions in one frame get disjoint src ranges, params slots and destinations", () => {
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
