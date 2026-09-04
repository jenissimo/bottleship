import { describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import {
    D3D9_VERTEX_TEXTURE_SAMPLER_BASE,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";

// D3D's texture blend cascade STOPS at the first stage whose COLOROP is D3DTOP_DISABLE, so a
// texture left bound above that stage is inert — real hardware draws such a call. These probes
// pin that the fixed-function pipeline resolver agrees, and that a refusal never outlives the
// binding that caused it. Structural probes, like d3d9-pipeline-key.test.ts: a real WebGPU
// device is neither needed nor available under Bun.

const proto = D3D9Device.prototype as unknown as Record<string, (...a: never[]) => unknown>;

// The cached pipeline id resolvePipelineId returns once every refusal gate has passed.
const DRAWN = 42;

type ResolveProbe = {
    cube: number;
    volume: number;
    vertexVolume: number;
    stages: number;
    sampledStageLimit: number | null;
    includedVertexSamplers: boolean | null;
};

function resolveProbe(over: Partial<ResolveProbe> = {}): {
    probe: ResolveProbe;
    resolve: () => number;
} {
    const probe: ResolveProbe = {
        cube: 0, volume: 0, vertexVolume: 0, stages: 1,
        sampledStageLimit: null, includedVertexSamplers: null,
        ...over,
    };
    const self = {
        rasterStateSupported: () => true,
        // D3DRS_VERTEXBLEND / D3DRS_INDEXEDVERTEXBLENDENABLE both off: the blend gate above
        // the masks under test must not be what decides these cases.
        getRS: () => 0,
        activeStageCount: () => probe.stages,
        boundCubeMask: () => probe.cube,
        boundVolumeMask: () => probe.volume,
        boundVertexVolumeMask: () => probe.vertexVolume,
        firstUnsupportedSamplerStage: (_emu: boolean, limit: number, includeVertex: boolean) => {
            probe.sampledStageLimit = limit;
            probe.includedVertexSamplers = includeVertex;
            return null;
        },
        debugFlags: { forceCullNone: false },
        blendCacheKey: () => "k",
        activeSlotMask: () => 1,
        pipelineCache: new Map<string, number>([["k|topotriangle-list|fc0", DRAWN]]),
        frameSnapshot: {},
    };
    return {
        probe,
        resolve: () => proto.resolvePipelineId.call(self as never, 0 as never, "triangle-list" as never) as number,
    };
}

describe("FFP refuses only what the cascade actually samples", () => {
    test("a cube texture ABOVE the active cascade does not drop the draw", () => {
        // Painkiller leaves an env-cubemap on stage 2 from an earlier programmable draw while
        // every fixed-function draw of the frame terminates at stage 1 (COLOROP=DISABLE).
        const { resolve } = resolveProbe({ cube: 1 << 2, stages: 1 });
        expect(resolve()).toBe(DRAWN);
    });

    test("a cube texture ON a sampled stage is still refused", () => {
        expect(resolveProbe({ cube: 1 << 0, stages: 1 }).resolve()).toBe(-1);
        expect(resolveProbe({ cube: 1 << 1, stages: 2 }).resolve()).toBe(-1);
    });

    test("a volume texture above the cascade draws; one inside it is refused", () => {
        expect(resolveProbe({ volume: 1 << 3, stages: 2 }).resolve()).toBe(DRAWN);
        expect(resolveProbe({ volume: 1 << 1, stages: 2 }).resolve()).toBe(-1);
    });

    test("vertex-texture bindings never gate a fixed-function draw", () => {
        // The fixed function has no vertex-texture fetch, so a volume bound to a vertex
        // sampler cannot make an FFP draw unrepresentable.
        expect(resolveProbe({ vertexVolume: 0xf, stages: 1 }).resolve()).toBe(DRAWN);
    });

    test("the sampler scan is bounded by the cascade and skips vertex samplers", () => {
        const { probe, resolve } = resolveProbe({ stages: 3 });
        resolve();
        expect(probe.sampledStageLimit).toBe(3);
        expect(probe.includedVertexSamplers).toBe(false);
    });
});

describe("firstUnsupportedSamplerStage honours the caller's stage window", () => {
    const scan = (limit?: number, includeVertex?: boolean) => {
        const textures = new Map<number, number>([[3, 1], [D3D9_VERTEX_TEXTURE_SAMPLER_BASE, 2]]);
        const self = {
            stateTracker: { getTexture: (s: number) => textures.get(s) ?? null },
            samplerSpecForStage: () => ({ unsupportedFeatures: ["probe"] }),
        };
        return limit === undefined
            ? proto.firstUnsupportedSamplerStage.call(self as never, false as never)
            : proto.firstUnsupportedSamplerStage.call(
                self as never, false as never, limit as never, includeVertex as never);
    };

    test("the full scan still finds an unsupported pixel stage", () => {
        expect(scan()).toEqual({ stage: 3, reason: "probe" });
    });

    test("a cascade of 1 does not see stage 3", () => {
        expect(scan(1, false)).toBeNull();
    });

    test("vertex samplers are scanned only when the caller asks", () => {
        expect(scan(0, true)).toEqual({ stage: D3D9_VERTEX_TEXTURE_SAMPLER_BASE, reason: "probe" });
        expect(scan(0, false)).toBeNull();
    });
});

describe("a refused FFP draw does not poison the one-entry pipeline memo", () => {
    test("the next draw re-resolves instead of inheriting the refusal", () => {
        // The memo key does not carry everything a refusal depends on, so remembering -1 let
        // whichever draw filled it first decide the fate of every later draw that hashed the
        // same — the refusal outlived the binding.
        let answer = -1;
        let resolves = 0;
        const self = {
            buildPipelineKey: () => 0,
            blendCacheKey: () => "same-key",
            resolvePipelineId: () => { resolves++; return answer; },
            currentPipelineKey: "",
            currentPipelineId: null as number | null,
        };
        expect(proto.getPipelineId.call(self as never, 1 as never)).toBe(-1);
        answer = DRAWN;
        expect(proto.getPipelineId.call(self as never, 1 as never)).toBe(DRAWN);
        expect(resolves).toBe(2);
    });

    test("a successful id is still memoised (the cache is not disabled)", () => {
        let resolves = 0;
        const self = {
            buildPipelineKey: () => 0,
            blendCacheKey: () => "same-key",
            resolvePipelineId: () => { resolves++; return DRAWN; },
            currentPipelineKey: "",
            currentPipelineId: null as number | null,
        };
        expect(proto.getPipelineId.call(self as never, 1 as never)).toBe(DRAWN);
        expect(proto.getPipelineId.call(self as never, 1 as never)).toBe(DRAWN);
        expect(resolves).toBe(1);
    });
});

describe("bound texture DIMENSION is part of the pipeline cache key", () => {
    const key = (cube: number, volume: number, stages: number): string => {
        const self = {
            stateTracker: { getFVF: () => 0 },
            activeStageCount: () => stages,
            samplerShaderStatesResolved: () => ({ key: "" }),
            texGenActive: () => false,
            boundCubeMask: () => cube,
            boundVolumeMask: () => volume,
            activeColorTargetKey: () => "rt",
            getRS: () => 0,
            alphaTestKey: () => "a",
            activeDepthTargetFormat: () => "depth24plus",
            rasterStateKey: () => "r",
            streamKey: () => "s",
        };
        return proto.blendCacheKey.call(self as never, 0 as never, 0 as never, 1 as never) as string;
    };

    test("a cube on a sampled stage keys a different pipeline than a 2-D one", () => {
        expect(key(1 << 0, 0, 1)).not.toBe(key(0, 0, 1));
        expect(key(0, 1 << 0, 1)).not.toBe(key(0, 0, 1));
    });

    test("a binding above the cascade does not fragment the cache", () => {
        expect(key(1 << 4, 1 << 5, 1)).toBe(key(0, 0, 1));
    });
});
