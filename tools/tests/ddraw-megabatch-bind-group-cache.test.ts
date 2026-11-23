import { describe, expect, test } from "bun:test";
import { BindGroupManager, MEGA_BATCH_CACHE_LIMIT } from "../../src/worker/backends/webgpu/ddraw/bind-group-manager";
import type { StageSamplerState } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import { scopedGlobals, useWebGpuFlags } from "./helpers/scoped-globals";

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

useWebGpuFlags("GPUShaderStage");

describe("MegaBatch bind groups are keyed by resource identity", () => {

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

    test("hits, misses, uncached builds and resets are counted, and every built group is one of them", () => {
        const { m, made } = rig();
        const buf = buffer("ring"), a = view("a");
        m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        m.createMegaBatchBindGroup(buf, 2, [a, null], [sampler(), sampler()], DUMMY);
        m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY, 0, 512);
        expect(m.megaBatchCacheStats).toEqual({ hits: 2, misses: 1, uncached: 2, resets: 0 });
        for (let i = 1; i < MEGA_BATCH_CACHE_LIMIT; i++) m.createMegaBatchBindGroup(buf, 1, [view(`v${i}`)], [sampler()], DUMMY);
        m.createMegaBatchBindGroup(buf, 1, [view("past the limit")], [sampler()], DUMMY);
        const st = m.megaBatchCacheStats;
        expect(st.resets).toBe(1);
        expect(st.misses).toBe(MEGA_BATCH_CACHE_LIMIT + 1);
        expect(st.misses + st.uncached).toBe(made.length);
    });

    test("with the cache switched off when the manager is created, every group is built (the pre-cache path)", () => {
        const g = globalThis as { __ddrawMegaBatchCacheOff?: unknown };
        g.__ddrawMegaBatchCacheOff = true;
        let off: ReturnType<typeof rig>;
        try { off = rig(); } finally { delete g.__ddrawMegaBatchCacheOff; }
        const buf = buffer("ring"), a = view("a");
        const first = off.m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        expect(off.m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY)).not.toBe(first);
        expect(off.made).toHaveLength(2);
        expect(off.m.megaBatchCacheStats).toEqual({ hits: 0, misses: 0, uncached: 2, resets: 0 });
        const on = rig();
        on.m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        on.m.createMegaBatchBindGroup(buf, 1, [a], [sampler()], DUMMY);
        expect(on.made).toHaveLength(1);
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

describe("ordinary multi-texture bind groups", () => {
    scopedGlobals({ __ffpMultiBindCache: true });

    test("matches the uncached descriptor and reuses bindings after resource-content changes", () => {
        const { device, made } = fakeDevice();
        const manager = new BindGroupManager(device);
        const pipeline = {} as GPURenderPipeline;
        const uniform = buffer("uniform"), lights = buffer("lights"), clip = buffer("clip");
        const a = view("a"), b = view("b"), dormant = view("unused");
        const maps = [a, dormant, b];
        const modes = [sampler(), sampler(), sampler({ addressU: 1 })];
        const call = () => manager.getOrCreateBindGroup(pipeline, uniform, 5, maps, modes, DUMMY, lights, clip);
        const original = call();
        const globalFlag = globalThis as { __ffpMultiBindCache?: boolean };
        globalFlag.__ffpMultiBindCache = false;
        call();
        globalFlag.__ffpMultiBindCache = true;
        expect(made[0]).toEqual(made[1]);
        maps[1] = view("changed unsampled stage");
        modes[1] = sampler({ magFilter: 1 });
        expect(call()).toBe(original);
        expect(made).toHaveLength(2);
    });

    test("resolves every sampled and buffer identity on each draw and clears on reset", () => {
        const { device, made } = fakeDevice();
        const manager = new BindGroupManager(device);
        const pipeline = {} as GPURenderPipeline;
        const originalUniform = buffer("uniform");
        const originalLights = buffer("lights");
        const originalClip = buffer("clip");
        let uniform = originalUniform, lights = originalLights, clip = originalClip;
        const a = view("a"), b = view("b");
        const maps = [a, b];
        const modes = [sampler(), sampler()];
        const call = () => manager.getOrCreateBindGroup(pipeline, uniform, 3, maps, modes, DUMMY, lights, clip);
        const original = call();
        modes[1].magFilter = 1;
        expect(call()).not.toBe(original);
        modes[1].magFilter = 2;
        maps[1] = view("replacement");
        expect(call()).not.toBe(original);
        maps[1] = b;
        uniform = buffer("rotated uniform ring");
        expect(call()).not.toBe(original);
        uniform = originalUniform;
        lights = buffer("rotated light ring");
        expect(call()).not.toBe(original);
        lights = originalLights;
        clip = buffer("replacement clip buffer");
        expect(call()).not.toBe(original);
        clip = originalClip;
        expect(call()).toBe(original);
        manager.clearCache();
        expect(call()).not.toBe(original);
        expect(made).toHaveLength(7);
    });

    test("the default cache evicts when more than 512 distinct groups are requested", () => {
        const globalFlag = globalThis as { __ffpMultiBindCache?: boolean };
        delete globalFlag.__ffpMultiBindCache;
        const { device, made } = fakeDevice();
        const manager = new BindGroupManager(device);
        const pipeline = {} as GPURenderPipeline;
        const uniform = buffer("uniform"), lights = buffer("lights"), clip = buffer("clip");
        const a = view("a");
        const modes = [sampler(), sampler()];
        const secondStages = Array.from({ length: 513 }, (_, index) => view(String(index)));
        const draw = (second: GPUTextureView) => manager.getOrCreateBindGroup(pipeline, uniform, 3, [a, second], modes, DUMMY, lights, clip);
        expect(draw(secondStages[0]!)).toBe(draw(secondStages[0]!));
        for (const next of secondStages.slice(1)) draw(next);
        expect(made).toHaveLength(513);
        for (const next of secondStages) draw(next);
        expect(made.length).toBeGreaterThan(513);
        globalFlag.__ffpMultiBindCache = true;
    });

    test("the real binding path selects each draw's dynamic uniform and light data", async () => {
        const { DDrawWebGPUExecutor, STAGE_SAMPLER_KEY_LANES } = await import("../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor");
        const { MAX_FFP_SAMPLED_STAGES } = await import("../../src/worker/backends/webgpu/ddraw/ffp-stages");
        const { device, made } = fakeDevice();
        const bound: Array<{ group: GPUBindGroup; offsets: number[] }> = [];
        const uniform = buffer("uniform"), lights = buffer("lights");
        const executor = Object.assign(Object.create(DDrawWebGPUExecutor.prototype), {
            bindGroupManager: new BindGroupManager(device),
            ringBufferManager: { getCurrentUniformBuffer: () => uniform, getCurrentLightsBuffer: () => lights },
            clipPlanesBuffer: buffer("clip"),
            dummyTextureView: DUMMY,
            currentRenderPass: {
                setPipeline() {},
                setStencilReference() {},
                setBindGroup(_binding: number, group: GPUBindGroup, offsets: number[]) { bound.push({ group, offsets }); },
            },
            lastPipeline: null,
            lastBindGroup: null,
            lastUniformOffset: -1,
            lastLightsOffset: -1,
            lastStageViews: new Array(MAX_FFP_SAMPLED_STAGES).fill(null),
            stageSamplerKeyScratch: new Int32Array(MAX_FFP_SAMPLED_STAGES * STAGE_SAMPLER_KEY_LANES),
            lastStageSamplerKeys: new Int32Array(MAX_FFP_SAMPLED_STAGES * STAGE_SAMPLER_KEY_LANES).fill(-1),
        });
        const pipeline = {} as GPURenderPipeline;
        const a = view("a"), b = view("b"), c = view("c");
        const stageViews = [a, b, null, null];
        const stageSamplers = [sampler(), sampler()];
        const draw = (uniformOffset: number, lightsOffset: number) => executor.setupPipelineAndBindings({
            pipeline, stencilRef: 0, sampledMask: 3, stageViews, stageSamplers, uniformOffset, lightsOffset,
        });
        draw(0, 256);
        stageViews[1] = c;
        draw(256, 512);
        stageViews[1] = b;
        draw(512, 1024);
        expect(made).toHaveLength(2);
        expect(bound[2]!.group).toBe(bound[0]!.group);
        expect(bound[1]!.group).not.toBe(bound[0]!.group);
        expect(bound.map(row => row.offsets)).toEqual([[0, 256], [256, 512], [512, 1024]]);
    });
});
