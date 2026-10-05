/**
 * The two compact-path keys, checked against structural probes (a real WebGPU device is
 * neither available nor needed to check a key's coverage — same pattern as
 * d3d9-pipeline-memo.test.ts).
 *
 * Both keys front a cache whose entries are only as safe as the state the key looked at. A
 * value that a capture BAKES but the key never reads is how one slot starts answering for two
 * different draws.
 */

import { describe, expect, test } from "bun:test";
import { D3D9Device, legacyBumpEnvStageKey } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

const D3DTSS_BUMPENVMAT00 = 7;
const D3DTSS_BUMPENVLOFFSET = 23;

type CapturedProbe = Record<string, unknown> & {
    stageStates: Map<number, number>;
    captures: number;
    viewport: { width: number; height: number };
};

const proto = D3D9Device.prototype as unknown as {
    captureCompactDrawState: (
        this: CapturedProbe, pipelineId: number, fullStateKey: number,
        startFloat: number, floatCount: number,
    ) => number;
    compactPipelineFastKey: (
        this: Record<string, unknown>, fullStateKey: number, stride: number,
    ) => string;
};

/** A shader pair that clears every bail-out in captureCompactDrawState's fullyOverwritten
 *  guard, so the cache is genuinely consulted. */
function shader(usesLegacyBumpEnv: boolean) {
    return {
        analysis: { constantCount: 4, usesLegacyBumpEnv },
        prog: { usesRelativeConst: false, instructions: [], definitions: [] },
    };
}

function stageKey(stage: number, state: number): number {
    return stage * 256 + state;
}

function makeCaptureProbe(usesLegacyBumpEnv: boolean): CapturedProbe {
    const probe: CapturedProbe = {
        stageStates: new Map<number, number>(),
        captures: 0,
        viewport: { width: 640, height: 480 },
        activeVertexShader: 7,
        activePixelShader: 9,
        activeVertexDecl: 3,
        psConstantsVersion: 11,
        arenaSamplerBankGeneration: 1,
        samplerStateGeneration: 2,
        attachmentGeneration: 3,
        gpuResourceGeneration: 4,
        compactCaptureCache: new Map<string, number>(),
        compactCaptureReuseHits: 0,
        compactCaptureReuseMisses: 0,
        getActiveVsShader: () => shader(false),
        getActivePsShader: () => shader(usesLegacyBumpEnv),
        getRS: () => 0,
    };
    probe.getTextureStageState = (stage: number, state: number) =>
        probe.stageStates.get(stageKey(stage, state)) ?? 0;
    probe.captureDrawState = () => probe.captures++;
    return probe;
}

function capture(probe: CapturedProbe): number {
    return proto.captureCompactDrawState.call(probe, 5, 0x1234, 0, 16);
}

describe("compact capture cache key", () => {
    test("an unchanged draw state reuses the slot it already captured", () => {
        const probe = makeCaptureProbe(true);
        expect(capture(probe)).toBe(0);
        expect(capture(probe)).toBe(0);
        expect(probe.compactCaptureReuseHits).toBe(1);
    });

    test("a moved BUMPENVMAT does not share a slot with the state it was captured under", () => {
        // captureDrawState bakes the six bump-env stage states into psConst for a legacy
        // TEXBEM/TEXBEML shader; psConstantsVersion hashes the constant BANK and cannot see it.
        const probe = makeCaptureProbe(true);
        expect(capture(probe)).toBe(0);
        probe.stageStates.set(stageKey(1, D3DTSS_BUMPENVMAT00), 0x3f800000);
        expect(capture(probe)).toBe(1);
        expect(probe.compactCaptureReuseHits).toBe(0);
    });

    test("every baked bump-env stage state falsifies the key", () => {
        for (let stage = 0; stage < 8; stage++) {
            for (const state of [7, 8, 9, 10, 22, 23]) {
                const probe = makeCaptureProbe(true);
                capture(probe);
                probe.stageStates.set(stageKey(stage, state), 1);
                expect({ stage, state, captured: capture(probe) })
                    .toEqual({ stage, state, captured: 1 });
            }
        }
    });

    test("a shader that bakes nothing pays no key and still reuses its slot", () => {
        const probe = makeCaptureProbe(false);
        expect(capture(probe)).toBe(0);
        probe.stageStates.set(stageKey(0, D3DTSS_BUMPENVLOFFSET), 9);
        expect(capture(probe)).toBe(0);
        expect(legacyBumpEnvStageKey(shader(false), () => 1)).toBe("");
    });
});

describe("compact pipeline fast key", () => {
    function makeKeyProbe(): Record<string, unknown> {
        return {
            activeVertexShader: 7,
            activePixelShader: 9,
            activeVertexDecl: 3,
            samplerStateGeneration: 2,
            arenaSamplerBankGeneration: 1,
            attachmentGeneration: 3,
            stateKeyBlend: "b",
            stateKeyAlpha: "a",
            stateKeyDepth: "d",
            stateKeyProjected: "p",
            stateKeyTarget: "rt",
            debugFlags: { forceCullNone: false },
            stateTracker: { getFVF: () => 0x142 },
            refreshStateKeys: () => {},
            streamHash: () => 0xabc,
            getRS: () => 0,
        };
    }

    test("the debug cull override falsifies the key", () => {
        // prepareArenaPipelineIdentity folds debugFlags.forceCullNone into the identity; a
        // fast key that omits it reuses the pipeline built under the other setting.
        const off = makeKeyProbe();
        const on = makeKeyProbe();
        (on.debugFlags as { forceCullNone: boolean }).forceCullNone = true;
        expect(proto.compactPipelineFastKey.call(off, 0x1234, 32))
            .not.toBe(proto.compactPipelineFastKey.call(on, 0x1234, 32));
    });

    test("is stable for an identical state", () => {
        expect(proto.compactPipelineFastKey.call(makeKeyProbe(), 0x1234, 32))
            .toBe(proto.compactPipelineFastKey.call(makeKeyProbe(), 0x1234, 32));
    });
});
