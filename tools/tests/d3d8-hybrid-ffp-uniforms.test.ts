/**
 * D3D8 hybrid draw (programmable vertex shader + NULL pixel shader) pixel-uniform gather.
 *
 * linkProgram's ps===null path (link/index.ts, emitHybridFixedFunctionFragment) generates the
 * SAME fixed-function texture-stage cascade the D3D9 hybrid path uses, reading its state from
 * `psc.c[0]` / `psc.tfactor` / `psc.stages[N]` / `psc.stageConstants[N]` — the layout
 * packFfpUniforms (ffp-lighting.ts) produces. Before this change, D3D8ProgrammableRenderer's
 * captureDrawState sized the PS uniform block from `ps.analysis.constantCount`, which is 0 (no
 * pixel shader) and clamps to a 4-float minimum in RenderFrame.nextDrawState — so every hybrid
 * draw uploaded a 4-float block of zeros: op selector 0 is not a valid D3DTEXTUREOP, every
 * argument selector 0 reads D3DTA_DIFFUSE, and TEXTUREFACTOR/the alpha-less-format flag never
 * reached the shader. All tests below fail against that code.
 */
import { describe, expect, test } from "bun:test";
// Prime the module graph the same way d3d8-ffp-combiner.test.ts does: ddraw/constants
// participates in an import cycle through core/com/com-memory -> ... -> d3d/types.
import "../../src/worker/modules/ddraw/d3d/types";
import {
    D3DRENDERSTATE_TEXTUREFACTOR,
    D3DTOP_DISABLE,
    D3DTOP_MODULATE,
    D3DTA_CURRENT,
    D3DTA_DIFFUSE,
    D3DTA_TEXTURE,
} from "../../src/worker/modules/ddraw/constants";
import { D3D8ProgrammableRenderer } from "../../src/worker/backends/webgpu/d3d8/d3d8-programmable-draw";
import type { D3D8DeviceAdapter } from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import type { D3D8ShaderRegistry } from "../../src/worker/backends/webgpu/d3d8/d3d8-shader-registry";
import type { DDrawWebGPUExecutor } from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import type { WebGPUBackend } from "../../src/worker/backends/webgpu/webgpu-backend";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";
import { FFP_MAX_STAGES, FFP_STAGE_CONSTANT_FLOATS } from "../../src/worker/backends/webgpu/d3d9/ffp-lighting";

const D3DTSS_COLOROP = 1, D3DTSS_COLORARG1 = 2, D3DTSS_COLORARG2 = 3, D3DTSS_ALPHAOP = 4;

/** No GPU device involved: captureDrawState only needs the CPU-side draw-state gather. */
function makeRenderer(): D3D8ProgrammableRenderer {
    const backend = { getDevice: () => undefined } as unknown as WebGPUBackend;
    return new D3D8ProgrammableRenderer(backend);
}

/** A flat-array adapter stub matching the surface captureDrawState/packFfpHybridPixelState
 *  actually reads (renderStates, textureStates, viewport, stageTexForDraw) — this title's
 *  D3D8 device adapter is itself a flat-array wrapper, not a StateTracker (see CLAUDE.md §3.3
 *  / the module header comment on d3d8-programmable-draw.ts). */
function makeAdapter(textures: (DirectDrawSurfaceState | null)[] = []): D3D8DeviceAdapter {
    const renderStates = new Int32Array(256);
    const textureStates = new Int32Array(256);
    // Representative setup for this bring-up's cel-shaded objects: stage 0
    // COLOROP=MODULATE(TEXTURE, DIFFUSE), stage 1 COLOROP=MODULATE(TEXTURE, CURRENT),
    // ALPHAOP=DISABLE on both.
    textureStates[0 * 32 + D3DTSS_COLOROP] = D3DTOP_MODULATE;
    textureStates[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
    textureStates[0 * 32 + D3DTSS_COLORARG2] = D3DTA_DIFFUSE;
    textureStates[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_DISABLE;
    textureStates[1 * 32 + D3DTSS_COLOROP] = D3DTOP_MODULATE;
    textureStates[1 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
    textureStates[1 * 32 + D3DTSS_COLORARG2] = D3DTA_CURRENT;
    textureStates[1 * 32 + D3DTSS_ALPHAOP] = D3DTOP_DISABLE;
    renderStates[D3DRENDERSTATE_TEXTUREFACTOR] = 0x80c08040; // a=0x80 r=0xc0 g=0x80 b=0x40, distinctive
    return {
        renderStates,
        textureStates,
        viewport: { x: 0, y: 0, width: 640, height: 480, minZ: 0, maxZ: 1 },
        stageTexForDraw: (stage: number) => textures[stage] ?? null,
    } as unknown as D3D8DeviceAdapter;
}

/** A registry stub: one bound vertex shader, no pixel shader (the hybrid case). */
function makeShaders(vsConstantCount = 4): D3D8ShaderRegistry {
    return {
        getActiveVs: () => ({ compiled: { analysis: { constantCount: vsConstantCount } } }),
        getActivePs: () => null,
        vsConstants: new Float32Array(256 * 4),
        psConstants: new Float32Array(224 * 4),
        vsConstantsVersion: 1,
        psConstantsVersion: 1,
    } as unknown as D3D8ShaderRegistry;
}

const rendererStub = { syncSurfaceFromMemory: () => {} } as unknown as DDrawWebGPUExecutor;

function captureHybridPsConst(adapter: D3D8DeviceAdapter): Float32Array {
    const renderer = makeRenderer();
    const shaders = makeShaders();
    const index = renderer.captureDrawState(adapter, shaders, rendererStub);
    const frame = renderer.getCommandRecorder().getCurrentFrame();
    const state = frame.drawStates[index]!;
    return state.psConst.slice(0, state.psLen);
}

describe("D3D8 hybrid VS + NULL-PS draws pack the FFP pixel cascade", () => {
    test("PS uniform block is sized for c[0] + tfactor + all stage records/constants, not 4 floats", () => {
        const psConst = captureHybridPsConst(makeAdapter());
        // 4 (c[0]) + 4 (tfactor) + FFP_MAX_STAGES*8 (stage a/b) + FFP_STAGE_CONSTANT_FLOATS
        expect(psConst.length).toBe(4 + 4 + FFP_MAX_STAGES * 8 + FFP_STAGE_CONSTANT_FLOATS);
    });

    test("TEXTUREFACTOR lands at [4..7], matching packFfpUniforms' tfactor offset", () => {
        const psConst = captureHybridPsConst(makeAdapter());
        // unpackD3dColor(0x80c08040): r=0xc0/255, g=0x80/255, b=0x40/255, a=0x80/255
        expect(psConst[4]).toBeCloseTo(0xc0 / 255, 5);
        expect(psConst[5]).toBeCloseTo(0x80 / 255, 5);
        expect(psConst[6]).toBeCloseTo(0x40 / 255, 5);
        expect(psConst[7]).toBeCloseTo(0x80 / 255, 5);
    });

    test("stage 0 record: MODULATE(TEXTURE, DIFFUSE), ALPHAOP=DISABLE", () => {
        const psConst = captureHybridPsConst(makeAdapter());
        const a = 8; // psc.stages[0].a
        expect(psConst[a + 0]).toBe(D3DTOP_MODULATE);
        expect(psConst[a + 1]).toBe(D3DTA_TEXTURE);
        expect(psConst[a + 2]).toBe(D3DTA_DIFFUSE);
        expect(psConst[a + 3]).toBe(D3DTOP_DISABLE);
    });

    test("stage 1 record: MODULATE(TEXTURE, CURRENT), ALPHAOP=DISABLE — the second stage the " +
        "diagnosed bug dropped (84 of 90 draws/frame needed 2 stages)", () => {
        const psConst = captureHybridPsConst(makeAdapter());
        const a = 8 + 1 * 8; // psc.stages[1].a
        expect(psConst[a + 0]).toBe(D3DTOP_MODULATE);
        expect(psConst[a + 1]).toBe(D3DTA_TEXTURE);
        expect(psConst[a + 2]).toBe(D3DTA_CURRENT);
        expect(psConst[a + 3]).toBe(D3DTOP_DISABLE);
    });

    test("no valid op ever lands at op-selector 0 (0 is not a D3DTEXTUREOP — the pre-fix symptom)", () => {
        const psConst = captureHybridPsConst(makeAdapter());
        expect(psConst[8 + 0]).not.toBe(0);
        expect(psConst[8 + 8 + 0]).not.toBe(0);
    });

    test("an alpha-less bound texture format sets stage.b.z (texOpaqueAlpha)", () => {
        // X8R8G8B8 = 22 (D3D_ALPHALESS_FORMATS), R8G8B8 not used here to keep the fixture small.
        const tex = { surfaceType: "bitmap_texture", d3dFormat: 22 } as unknown as DirectDrawSurfaceState;
        const psConst = captureHybridPsConst(makeAdapter([tex]));
        const bZ = 8 + 4 + 2; // psc.stages[0].b.z
        expect(psConst[bZ]).toBe(1);
    });

    test("a texture format WITH an alpha channel leaves stage.b.z clear", () => {
        // A8R8G8B8 = 21 — has alpha, not in D3D_ALPHALESS_FORMATS.
        const tex = { surfaceType: "bitmap_texture", d3dFormat: 21 } as unknown as DirectDrawSurfaceState;
        const psConst = captureHybridPsConst(makeAdapter([tex]));
        const bZ = 8 + 4 + 2;
        expect(psConst[bZ]).toBe(0);
    });

    test("a stage-state-only change (no PS, no VS-constant change) bumps psVersion so the " +
        "cached draw-state elision (render-frame.ts) can't reuse a stale cascade", () => {
        const renderer = makeRenderer();
        const shaders = makeShaders();
        const a1 = makeAdapter();
        const i1 = renderer.captureDrawState(a1, shaders, rendererStub);
        const v1 = renderer.getCommandRecorder().getCurrentFrame().drawStates[i1]!.psVersion;

        const a2 = makeAdapter();
        a2.textureStates[1 * 32 + D3DTSS_COLORARG2] = D3DTA_DIFFUSE; // was CURRENT
        const i2 = renderer.captureDrawState(a2, shaders, rendererStub);
        const v2 = renderer.getCommandRecorder().getCurrentFrame().drawStates[i2]!.psVersion;

        expect(v1).not.toBeUndefined();
        expect(v1).not.toBe(v2);
    });
});
