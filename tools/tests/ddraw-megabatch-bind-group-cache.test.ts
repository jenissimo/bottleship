import { describe, expect, test } from "bun:test";
import { BindGroupManager, MEGA_BATCH_CACHE_LIMIT } from "../../src/worker/backends/webgpu/ddraw/bind-group-manager";
import type { StageSamplerState } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import { useWebGpuFlags } from "./helpers/scoped-globals";

function fakeDevice() {
    const made: Array<{ entries: Array<{ binding: number; resource: unknown }> }> = [];
    const device = {
        createBindGroupLayout: (d: unknown) => ({ d }),
        createSampler: (d: unknown) => ({ d }),
        createBindGroup: (d: { entries: Array<{ binding: number; resource: unknown }> }) => { made.push(d); return { made: made.length }; },
    };
    return { device: device as unknown as GPUDevice, made };
}

const sampler = (over: Partial<StageSamplerState> = {}): StageSamplerState => ({ minFilter: 2, magFilter: 2, mipFilter: 0, maxAnisotropy: 1, addressU: 3, addressV: 3, ...over });
const view = (n: string) => ({ n }) as unknown as GPUTextureView;
const buffer = (n: string) => ({ n }) as unknown as GPUBuffer;
const DUMMY = view("dummy");

describe("MegaBatch bind groups are keyed by resource identity", () => {
    useWebGpuFlags("GPUShaderStage");

    function rig() {
        const { device, made } = fakeDevice();
        return { m: new BindGroupManager(device), made };
    }

    test("the same mask, buffer, view and sampler give the same group, across content-only updates", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), a = view("a");
        const g = m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        expect(m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY)).toBe(g);
        expect(made).toHaveLength(1);
    });

    test("a sampledMask change with the same views builds a new group", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), a = view("a"), b = view("b");
        const one = m.createMegaBatchBindGroup(buf, 1, [a, b], [sampler(), sampler()], DUMMY);
        const two = m.createMegaBatchBindGroup(buf, 3, [a, b], [sampler(), sampler()], DUMMY);
        expect(two).not.toBe(one);
        expect(made).toHaveLength(2);
        expect(made[1]!.entries.length).toBe(5);
        const stage1Only = m.createMegaBatchBindGroup(buf, 2, [null, a], [sampler(), sampler()], DUMMY);
        expect(stage1Only).not.toBe(one);
        expect(made).toHaveLength(3);
    });

    test("an effective sampler change (quality/LOD override) builds a new group", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), a = view("a");
        const g = m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        expect(m.createMegaBatchBindGroup(buf, 1, [a], [sampler({ magFilter: 1 })], DUMMY)).not.toBe(g);
        expect(m.createMegaBatchBindGroup(buf, 1, [a], [sampler({ addressU: 1, addressV: 1 })], DUMMY)).not.toBe(g);
        expect(made).toHaveLength(3);
    });

    test("a recreated view, and a replaced or rotated storage buffer, build new groups", () => {
        const { m, made } = rig();
        const ring = buffer("ring"), a = view("a");
        const g = m.createMegaBatchBindGroup(ring, 1, [a], [sampler()], DUMMY);
        expect(m.createMegaBatchBindGroup(ring, 1, [view("a again")], [sampler()], DUMMY)).not.toBe(g);
        expect(m.createMegaBatchBindGroup(buffer("next ring"), 1, [a], [sampler()], DUMMY)).not.toBe(g);
        expect(m.createMegaBatchBindGroup(ring, 1, [a], [sampler()], DUMMY)).toBe(g);
        expect(made).toHaveLength(3);
    });

    test("every sampled stage is part of the key; an empty stage 0 is keyed by the dummy view", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), a = view("a"), b = view("b"), c = view("c");
        const g = m.createMegaBatchBindGroup(buf, 3, [a, b], [sampler(), sampler()], DUMMY);
        expect(m.createMegaBatchBindGroup(buf, 3, [a, c], [sampler(), sampler()], DUMMY)).not.toBe(g);
        expect(m.createMegaBatchBindGroup(buf, 3, [a, b], [sampler(), sampler({ addressU: 1 })], DUMMY)).not.toBe(g);
        const empty = m.createMegaBatchBindGroup(buf, 1, [null], [sampler()], DUMMY);
        expect(made.at(-1)!.entries.some(e => e.resource === DUMMY)).toBe(true);
        expect(m.createMegaBatchBindGroup(buf, 1, [null], [sampler()], DUMMY)).toBe(empty);
        expect(m.createMegaBatchBindGroup(buf, 1, [DUMMY], [sampler()], DUMMY)).toBe(empty);
        expect(made).toHaveLength(4);
    });

    test("no sampled stage: one group per buffer", () => {
        const { m, made } = rig();
        const buf = buffer("ring");
        expect(m.createMegaBatchBindGroup(buf, 0, [], [], DUMMY)).toBe(m.createMegaBatchBindGroup(buf, 0, [], [], DUMMY));
        expect(made).toHaveLength(1);
        expect(made[0]!.entries.map(e => e.binding)).toEqual([0]);
    });

    test("a group bound to a sub-range of the buffer is built every time", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), a = view("a");
        m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY, 512, 512);
        m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY, 512, 512);
        m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY, 0, 512);
        expect(made).toHaveLength(3);
    });

    test("the cache is bounded: past the limit it starts over", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), first = view("first");
        const g = m.createMegaBatchBindGroup(buf, 1, [first], [sampler()], DUMMY);
        for (let i = 1; i < MEGA_BATCH_CACHE_LIMIT; i++) m.createMegaBatchBindGroup(buf, 1, [view(`v${i}`)], [sampler()], DUMMY);
        expect(m.createMegaBatchBindGroup(buf, 1, [first], [sampler()], DUMMY)).toBe(g);
        const more = view("one more");
        const fresh = m.createMegaBatchBindGroup(buf, 1, [more], [sampler()], DUMMY);
        expect(m.createMegaBatchBindGroup(buf, 1, [more], [sampler()], DUMMY)).toBe(fresh);
        expect(m.createMegaBatchBindGroup(buf, 1, [first], [sampler()], DUMMY)).not.toBe(g);
        expect(made).toHaveLength(MEGA_BATCH_CACHE_LIMIT + 2);
    });

    test("clearCache, and a manager for a new device, share nothing", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), a = view("a");
        const g = m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        const u = m.createMegaBatchBindGroup(buf, 0, [], [], DUMMY);
        m.clearCache();
        expect(m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY)).not.toBe(g);
        expect(m.createMegaBatchBindGroup(buf, 0, [], [], DUMMY)).not.toBe(u);
        expect(made).toHaveLength(4);
        const other = rig();
        expect(other.m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY)).not.toBe(g);
        expect(other.made).toHaveLength(1);
    });
});

test("a cached group is bound again in every pass a batch is flushed into", async () => {
    const { DDrawWebGPUExecutor } = await import("../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor");
    const { setAuthorityGpu } = await import("../../src/worker/modules/ddraw/surface-sync");
    const bound: unknown[] = [];
    let passes = 0;
    const target = {
        surfaceType: "render_surface", width: 4, height: 2, pitch: 16, caps: 0, surfacePtr: 0, attachedSurfaceAddr: 0,
        format: { flags: 0x41, bpp: 32 }, mode: "GPU_ONLY", version: 0, gpuDirty: false, everLocked: false, lastUploadVersion: 0, writeGeneration: 0,
    };
    setAuthorityGpu(target as never);
    const cached = { cached: true };
    const ex = Object.create(DDrawWebGPUExecutor.prototype) as Record<string, unknown>;
    const fields: Record<string, unknown> = {
        debugFlags: {}, opLogArmed: 0, renderStats: { batches: 0, batchedDraws: 0 },
        ringBufferManager: { flushStorageBuffer: () => {} },
        ensureRenderPass: () => {
            passes++;
            ex.currentRenderPass = {
                setPipeline: () => {}, setStencilReference: () => {}, setVertexBuffer: () => {}, draw: () => {},
                setBindGroup: (_i: number, g: unknown) => { bound.push([passes, g]); },
            };
        },
        resetBindFastPath: () => {}, currentRenderPass: null, currentBatch: null,
    };
    for (const [k, v] of Object.entries(fields)) Object.defineProperty(ex, k, { value: v, writable: true, configurable: true });
    const batch = () => ({
        useMegaBatch: true, megaBatchBindGroup: cached, pipeline: {}, stencilRef: 0, target, viewport: {},
        vertexBuffer: {}, vertexSize: 64, primitiveType: 5,
        draws: [{ firstVertex: 0, vertexCount: 4, drawIndex: 1, vertexBufferOffset: 0, vertexBufferSize: 256 }],
    });
    const flush = (ex as unknown as { flushBatch(): void }).flushBatch.bind(ex);
    ex.currentBatch = batch(); flush();
    ex.currentBatch = batch(); flush();
    expect(bound).toEqual([[1, cached], [2, cached]]);
});
