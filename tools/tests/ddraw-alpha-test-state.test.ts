import { expect, test } from "bun:test";
import { DDrawWebGPUExecutor } from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import { FfpStagesState } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";
import { DEFAULT_DEBUG_FLAGS } from "../../src/worker/backends/webgpu/ddraw/types";
import { EMPTY_RENDER_STATES, EMPTY_TEX_STATES, createDefaultMaterial } from "../../src/worker/modules/ddraw/d3d/types";
import * as C from "../../src/worker/modules/ddraw/constants";

/** Exercise the actual draw preparation and inspect the state sent to MegaBatch.
 * GPU resource allocation is stubbed; state decoding/packing runs unchanged. */
function prepareAlphaState(aMask: number, colorOp: number, alphaOp: number,
    enabled: boolean, forceDisable = false) {
    let packed: { enabled: number; func: number; ref: number } | undefined;
    const executor = Object.assign(Object.create(DDrawWebGPUExecutor.prototype), {
        ensureSurfaceGPUResources() {},
        prepareStageTexture() {},
        isSampledContentOverwritten: () => false,
        shouldTraceLargeTexture: () => false,
        resolveTexXformFlags() {},
        depthManager: { ensureDepthForTarget: () => false },
        pipelineFactory: { setColorTargetFormat() {}, getOrCreatePipeline: () => ({}) },
        ringBufferManager: {
            allocateUniformSlot: () => 0,
            allocateDrawUniforms(...args: unknown[]) {
                packed = { enabled: args[32] as number, func: args[33] as number, ref: args[4] as number };
                return { index: 0 };
            },
        },
        ffpStages: new FfpStagesState(),
        texXformFlagsScratch: new Int32Array(3),
        safeVpScratchPrepare: {},
        debugFlags: { ...DEFAULT_DEBUG_FLAGS, forceDisableAlphaTest: forceDisable },
        prepareResult: { stageViews: new Array(4).fill(null), stageSamplers: Array.from({ length: 4 }, () => ({})) },
        defaultMaterial: createDefaultMaterial(),
        loggedTexCoordQuirks: new Set(),
        lastDrawDiagnostics: {},
    });
    const surface = {
        surfaceType: "render", mode: "GPU_ONLY", width: 800, height: 600,
        surfacePtr: 0, caps: 0, version: 1, lastUploadVersion: 1, gpuDirty: false,
        gpuTexture: { format: "rgba8unorm" }, gpuTextureView: {}, gpuTextureFormat: "rgba8unorm",
        format: { bpp: aMask === 0x8000 ? 16 : 32, aMask },
    };
    const rs = EMPTY_RENDER_STATES.slice(), ts = EMPTY_TEX_STATES.slice();
    // Disabled arithmetic stages need no UV inputs in this fixture.
    for (let stage = 3; stage < 8; stage++) ts[stage * 32 + C.D3DTSS_TEXCOORDINDEX] = 0;
    rs[C.D3DRENDERSTATE_ALPHATESTENABLE] = enabled ? 1 : 0;
    rs[C.D3DRENDERSTATE_ALPHABLENDENABLE] = 0;
    rs[C.D3DRENDERSTATE_ALPHAREF] = 127;
    rs[C.D3DRENDERSTATE_ALPHAFUNC] = C.D3DCMP_GREATER;
    rs[C.D3DRENDERSTATE_LIGHTING] = 0;
    ts[C.D3DTSS_COLOROP] = colorOp;
    ts[C.D3DTSS_ALPHAOP] = alphaOp;
    executor.prepareDraw(surface, C.D3DFVF_XYZRHW | C.D3DFVF_DIFFUSE | C.D3DFVF_TEX1,
        C.D3DPT_TRIANGLESTRIP, { x: 0, y: 0, width: 800, height: 600, minZ: 0, maxZ: 1 },
        surface, rs, ts, undefined, null, true);
    expect(executor.prepareResult.sampledMask & 1).toBe(1);
    return packed;
}

// A full-screen DOTPRODUCT3 effect produces alpha=0 wherever its RGB result is black.
// Those pixels must overwrite the old image when the guest disables alpha testing.
test.each([0, 0x8000, 0xff000000])("opaque DOTPRODUCT3 does not infer alpha testing from aMask=%i", aMask => {
    expect(prepareAlphaState(aMask, C.D3DTOP_DOTPRODUCT3, C.D3DTOP_SELECTARG1, false))
        .toEqual({ enabled: 0, func: C.D3DCMP_GREATER, ref: 127 });
});

test.each([C.D3DTOP_SELECTARG1, C.D3DTOP_MODULATE])("opaque alpha operation %i preserves disabled alpha testing", alphaOp => {
    expect(prepareAlphaState(0x8000, C.D3DTOP_MODULATE, alphaOp, false))
        .toEqual({ enabled: 0, func: C.D3DCMP_GREATER, ref: 127 });
});

test("vertex-colored glyph draws preserve sampling for texture alpha", () => {
    expect(prepareAlphaState(0xff000000, C.D3DTOP_SELECTARG2, C.D3DTOP_MODULATE, false))
        .toEqual({ enabled: 0, func: C.D3DCMP_GREATER, ref: 127 });
});

test("explicit alpha testing preserves the guest's function and reference", () => {
    expect(prepareAlphaState(0xff000000, C.D3DTOP_MODULATE, C.D3DTOP_SELECTARG1, true))
        .toEqual({ enabled: 1, func: C.D3DCMP_GREATER, ref: 127 });
});

test("debug override disables an explicit test", () => {
    expect(prepareAlphaState(0xff000000, C.D3DTOP_MODULATE, C.D3DTOP_SELECTARG1, true, true))
        .toEqual({ enabled: 0, func: C.D3DCMP_GREATER, ref: 127 });
});
