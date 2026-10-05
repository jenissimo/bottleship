import { describe, expect, test } from "bun:test";
import { fullTargetViewport, sanitizeViewport } from "../../src/worker/backends/webgpu/ddraw/types";
import { hybridTexcoordSetForStage, linkProgram, type CompiledVs } from "../../src/worker/backends/webgpu/d3d9/shader";

describe("D3D9 render-target viewport rules", () => {
    test("SetRenderTarget starts the newly selected target at its full viewport", () => {
        expect(fullTargetViewport(512, 512)).toEqual({ x: 0, y: 0, width: 512, height: 512, minZ: 0, maxZ: 1 });
        expect(fullTargetViewport(1024, 768)).toEqual({ x: 0, y: 0, width: 1024, height: 768, minZ: 0, maxZ: 1 });
    });

    test("SetViewport clamps against the active target rather than the prior viewport", () => {
        // A 1024x768 backbuffer follows a 512x512 bloom target.  Its requested
        // viewport must retain the backbuffer dimensions instead of being clipped
        // to the stale bloom viewport.
        expect(sanitizeViewport({ x: 0, y: 0, width: 1024, height: 768, minZ: 0, maxZ: 1 }, 1024, 768))
            .toEqual({ x: 0, y: 0, width: 1024, height: 768, minZ: 0, maxZ: 1 });
    });
});

describe("D3D9 hybrid VS + fixed-function pixel coordinates", () => {
    test("stage 1 consumes oT1 even when fixed-function TCI is zero", () => {
        // D3DTSS_TEXCOORDINDEX is ignored with a programmable VS.  The value
        // would be packed as zero by the caller, but must not redirect stage 1
        // to oT0 (the albedo UVs).
        const packedTci = 0;
        expect(packedTci).toBe(0);
        expect(hybridTexcoordSetForStage(1, [0, 1, 2])).toBe(1);
        expect(hybridTexcoordSetForStage(2, [0, 1])).toBeNull();
    });

    test("generated hybrid WGSL samples stage 1 from t1, never packed TCI", () => {
        const vs = {
            prog: { major: 1, minor: 1, instructions: [], definitions: [] },
            analysis: {
                inputDcls: [], constantCount: 0, writesColor: [false, false],
                writesTexcoord: new Set([0, 1]), writesFog: false, needsA0: false,
                maxTemp: 0, defConsts: new Map(), outputBindings: new Map(),
            },
        } as unknown as CompiledVs;
        const wgsl = linkProgram({ vs, ps: null, declElements: null, streamStride: 16, ffpStageCount: 2 }).wgsl;
        expect(wgsl).toContain("textureSample(tex1, samp1, in.tex1.xy)");
        // Stage 1's coordinate is oT1 and nothing else — a TCI-driven variant would sample t0.
        expect(wgsl).not.toContain("textureSample(tex1, samp1, in.tex0.xy)");
    });
});
