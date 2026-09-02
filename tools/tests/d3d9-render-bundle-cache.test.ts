import { afterEach, describe, expect, test } from "bun:test";
import { D3D9BackendExecutor } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";
import type { ProgrammableDrawState } from "../../src/worker/backends/webgpu/render-frame";

type Signature = {
    device: GPUDevice;
    colorFormats: Array<GPUTextureFormat | null>;
    depthFormat: GPUTextureFormat;
    sampleCount: number;
    dynamicState: number[];
    objects: object[];
    words: number[];
};

type Host = {
    metrics: Record<string, number>;
    resetMetrics: () => void;
    noteRenderBundleFastReject: (reason: "noPlan" | "arenaLayout" | "constants") => void;
    noteRenderBundleFastConstantReject: (reason: "length" | "vsOffset" | "psOffset" | "endCursor") => void;
    renderBundlesEnabled: () => boolean;
    renderBundleFastHitsEnabled: () => boolean;
    renderBundleMaterialProof: (state: ProgrammableDrawState) => MaterialProof;
    renderBundleMaterialMatches: (proof: MaterialProof, state: ProgrammableDrawState) => boolean;
    renderBundleSignaturesEqual: (a: Signature, b: Signature) => boolean;
    renderBundleSignatureKey: (s: Signature) => string;
    getOrCreateRenderBundle: (device: GPUDevice, segment: {
        cacheKey: string; signature: Signature; draws: Array<{
            pipeline: GPURenderPipeline; bindGroup: GPUBindGroup;
            vertexBindings: Array<{ slot: number; buffer: GPUBuffer; offset: number; size: number }>;
            indexBuffer: GPUBuffer; indexFormat: GPUIndexFormat;
            vsOffset: number; psOffset: number; indexCount: number; startIndex: number; baseVertex: number;
        }>;
    }) => GPURenderBundle;
};

type MaterialProof = {
    stageEpoch: number;
    sampler: GPUSampler | null;
    cubeMask: number;
    comparisonMask: number;
    volumeMask: number;
    vertexVolumeMask: number;
    textures: (GPUTextureView | null)[];
    samplers: (GPUSampler | null)[];
    vertexTextures: (GPUTextureView | null)[];
    vertexSamplers: (GPUSampler | null)[];
};

function drawState(epoch: number, texture: GPUTextureView, sampler: GPUSampler): ProgrammableDrawState {
    const vsConst = new Float32Array(4), psConst = new Float32Array(4);
    return {
        vsConst, vsBits: new Uint32Array(vsConst.buffer), vsLen: 4,
        psConst, psBits: new Uint32Array(psConst.buffer), psLen: 4,
        textures: [texture], sampler, samplers: [sampler],
        vertexTextures: [], vertexSamplers: [], cubeMask: 0, comparisonMask: 0,
        volumeMask: 0, vertexVolumeMask: 0, stageEpoch: epoch,
    };
}

function fakeDevice() {
    let builds = 0;
    const encoder = {
        setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {},
        finish() { return { bundle: ++builds } as unknown as GPURenderBundle; },
    };
    return {
        device: { createRenderBundleEncoder: () => encoder } as unknown as GPUDevice,
        builds: () => builds,
    };
}

function signature(device: GPUDevice, object: object, word = 1): Signature {
    return {
        device, colorFormats: ["bgra8unorm"], depthFormat: "depth24plus-stencil8",
        sampleCount: 1, dynamicState: [0, 0, 640, 480], objects: [object], words: [word],
    };
}

afterEach(() => {
    const flags = globalThis as {
        __d3d9RenderBundles?: boolean;
        __d3d9RenderBundleFastHits?: boolean;
        __d3d9RenderBundleCacheN?: number;
    };
    delete flags.__d3d9RenderBundles;
    delete flags.__d3d9RenderBundleFastHits;
    delete flags.__d3d9RenderBundleCacheN;
});

describe("D3D9 render-bundle cache", () => {
    test("is default-off and requires an explicit live opt-in", () => {
        const host = new D3D9BackendExecutor({} as never) as unknown as Host;
        expect(host.renderBundlesEnabled()).toBe(false);
        (globalThis as { __d3d9RenderBundles?: boolean }).__d3d9RenderBundles = true;
        expect(host.renderBundlesEnabled()).toBe(true);
    });

    test("fast hits have a separate default-off live opt-in", () => {
        const host = new D3D9BackendExecutor({} as never) as unknown as Host;
        expect(host.renderBundleFastHitsEnabled()).toBe(false);
        (globalThis as { __d3d9RenderBundleFastHits?: boolean }).__d3d9RenderBundleFastHits = true;
        expect(host.renderBundleFastHitsEnabled()).toBe(true);
    });

    test("attributes fast-plan rejection reasons and resets their telemetry", () => {
        const host = new D3D9BackendExecutor({} as never) as unknown as Host;
        host.noteRenderBundleFastReject("noPlan");
        host.noteRenderBundleFastReject("arenaLayout");
        host.noteRenderBundleFastConstantReject("vsOffset");
        host.noteRenderBundleFastConstantReject("psOffset");
        expect(host.metrics.renderBundleFastFallbacks).toBe(4);
        expect(host.metrics.renderBundleFastRejectNoPlan).toBe(1);
        expect(host.metrics.renderBundleFastRejectArenaLayout).toBe(1);
        expect(host.metrics.renderBundleFastRejectConstants).toBe(2);
        expect(host.metrics.renderBundleFastRejectConstantVsOffset).toBe(1);
        expect(host.metrics.renderBundleFastRejectConstantPsOffset).toBe(1);
        expect(host.metrics.renderBundleFastRejectConstantLength).toBe(0);
        host.resetMetrics();
        expect(host.metrics.renderBundleFastFallbacks).toBe(0);
        expect(host.metrics.renderBundleFastRejectArenaLayout).toBe(0);
        expect(host.metrics.renderBundleFastRejectConstantVsOffset).toBe(0);
    });

    test("material generation miss falls back to exact GPU object identity", () => {
        const host = new D3D9BackendExecutor({} as never) as unknown as Host;
        const texture = {} as GPUTextureView;
        const sampler = {} as GPUSampler;
        const state = drawState(10, texture, sampler);
        const proof = host.renderBundleMaterialProof(state);

        // A new upstream epoch can still name the exact same resource window.
        state.stageEpoch = 11;
        expect(host.renderBundleMaterialMatches(proof, state)).toBe(true);
        expect(proof.stageEpoch).toBe(11);

        // Epoch equality cannot hide a bind-layout/mask change.
        state.cubeMask = 1;
        expect(host.renderBundleMaterialMatches(proof, state)).toBe(false);
        state.cubeMask = 0;

        // The lookup generation is only a shortcut. Different objects are rejected exactly.
        state.stageEpoch = 12;
        state.textures[0] = {} as GPUTextureView;
        expect(host.renderBundleMaterialMatches(proof, state)).toBe(false);
    });

    test("exact comparison covers attachment shape, object identities, dynamic state, and words", () => {
        const host = new D3D9BackendExecutor({} as never) as unknown as Host;
        const { device } = fakeDevice();
        const object = {};
        const a = signature(device, object);
        expect(host.renderBundleSignaturesEqual(a, { ...a, colorFormats: [...a.colorFormats],
            dynamicState: [...a.dynamicState], objects: [...a.objects], words: [...a.words] })).toBe(true);
        expect(host.renderBundleSignaturesEqual(a, { ...a, sampleCount: 4 })).toBe(false);
        expect(host.renderBundleSignaturesEqual(a, { ...a, objects: [{}] })).toBe(false);
        expect(host.renderBundleSignaturesEqual(a, { ...a, words: [2] })).toBe(false);
        expect(host.renderBundleSignaturesEqual(a, { ...a, dynamicState: [0, 0, 800, 600] })).toBe(false);
    });

    test("hits only after structural verification and fails safe on a forced hash collision", () => {
        const host = new D3D9BackendExecutor({} as never) as unknown as Host;
        const { device, builds } = fakeDevice();
        const pipeline = {} as GPURenderPipeline;
        const bindGroup = {} as GPUBindGroup;
        const vb = {} as GPUBuffer;
        const ib = {} as GPUBuffer;
        const sigA = signature(device, pipeline, 11);
        const base = {
            cacheKey: host.renderBundleSignatureKey(sigA), signature: sigA,
            draws: [{ pipeline, bindGroup, vertexBindings: [{ slot: 0, buffer: vb, offset: 0, size: 64 }],
                indexBuffer: ib, indexFormat: "uint16" as GPUIndexFormat,
                vsOffset: 0, psOffset: 0, indexCount: 3, startIndex: 0, baseVertex: 0 }],
        };
        const first = host.getOrCreateRenderBundle(device, base);
        expect(host.getOrCreateRenderBundle(device, base)).toBe(first);
        expect(builds()).toBe(1);
        expect(host.metrics.renderBundleHits).toBe(1);

        // Force a bucket collision by retaining A's key with a different exact signature.
        const sigB = signature(device, {}, 12);
        const second = host.getOrCreateRenderBundle(device, { ...base, cacheKey: base.cacheKey, signature: sigB });
        expect(second).not.toBe(first);
        expect(builds()).toBe(2);
        expect(host.metrics.renderBundleSignatureMismatches).toBe(1);
    });

    test("bounded LRU evicts old bundles", () => {
        (globalThis as { __d3d9RenderBundleCacheN?: number }).__d3d9RenderBundleCacheN = 1;
        const host = new D3D9BackendExecutor({} as never) as unknown as Host;
        const { device } = fakeDevice();
        const draw = {
            pipeline: {} as GPURenderPipeline, bindGroup: {} as GPUBindGroup,
            vertexBindings: [] as Array<{ slot: number; buffer: GPUBuffer; offset: number; size: number }>,
            indexBuffer: {} as GPUBuffer, indexFormat: "uint16" as GPUIndexFormat,
            vsOffset: 0, psOffset: 0, indexCount: 3, startIndex: 0, baseVertex: 0,
        };
        const a = signature(device, {}, 1), b = signature(device, {}, 2);
        host.getOrCreateRenderBundle(device, { cacheKey: host.renderBundleSignatureKey(a), signature: a, draws: [draw] });
        host.getOrCreateRenderBundle(device, { cacheKey: host.renderBundleSignatureKey(b), signature: b, draws: [draw] });
        expect(host.metrics.renderBundleEvictions).toBe(1);
    });
});
