/**
 * debugView / forceWireColor / textureConverterDebugMode must actually change what the
 * shared DDraw/D3D8 FFP shader generator emits and what a CPU texture upload produces —
 * otherwise `gpuToggle` reports "applied" for a lever that changes nothing on screen
 * (see CLAUDE.md's "validator/lever that cannot fail" rule).
 *
 * D3D8 draws share this exact generator: d3d8-device-adapter.ts's `renderer` field is
 * typed `DDrawWebGPUExecutor` and its drawPrimitive/drawIndexedPrimitive/clear methods
 * call straight through to `this.renderer.*`, which builds its ShaderConfig from
 * `this.debugFlags` (pipeline-factory.ts) before calling into this generator — there is
 * no separate D3D8 FFP shader path to fall out of sync with.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { generateShaderCode, generateMegaBatchShaderCode, ShaderConfig } from "../../src/worker/backends/webgpu/ddraw/shader-generator";
import { DebugFlags, DEFAULT_DEBUG_FLAGS } from "../../src/worker/backends/webgpu/ddraw/types";
import { applyTextureConverterDebugPaintCPU } from "../../src/worker/backends/webgpu/ddraw/compute/texture-converter";

function baseConfig(debugFlags: DebugFlags): ShaderConfig {
    return {
        sampledMask: 1,
        stageCount: 1,
        flatShading: false,
        alphaTestEnabled: false,
        alphaFunc: 8,
        shouldEnableBlending: false,
        missingTexture: false,
        colorKeyEnabled: false,
        colorKey: null,
        debugFlags,
        needsUVFlip: false,
    };
}

function withDebugView(view: DebugFlags["debugView"]): DebugFlags {
    return { ...DEFAULT_DEBUG_FLAGS, debugView: view };
}

describe("ddraw/d3d8 shared FFP shader — debugView", () => {
    const modes: Array<DebugFlags["debugView"]> = ["normal", "uv", "vertexcolor", "alpha", "solid"];

    test("each mode emits distinct WGSL (legacy fs_main)", () => {
        const codes = modes.map((m) => generateShaderCode(baseConfig(withDebugView(m))));
        expect(new Set(codes).size).toBe(modes.length);
    });

    test("each mode emits distinct WGSL (MegaBatch fs_main)", () => {
        const codes = modes.map((m) => generateMegaBatchShaderCode(baseConfig(withDebugView(m))));
        expect(new Set(codes).size).toBe(modes.length);
    });

    test("uv mode overrides finalColor with the interpolated UV", () => {
        const code = generateShaderCode(baseConfig(withDebugView("uv")));
        expect(code).toContain("finalColor = vec4f(in.uv, 0.0, 1.0);");
    });

    test("vertexcolor mode overrides finalColor with the diffuse vertex color", () => {
        const code = generateShaderCode(baseConfig(withDebugView("vertexcolor")));
        expect(code).toContain("finalColor = vec4f(in.color.rgb, 1.0);");
    });

    test("normal mode adds no override — WGSL is unaffected by debugView plumbing", () => {
        const normal = generateShaderCode(baseConfig(withDebugView("normal")));
        const explicit = generateShaderCode(baseConfig({ ...DEFAULT_DEBUG_FLAGS, debugView: "normal" }));
        expect(normal).toBe(explicit);
        expect(normal).not.toContain("in.uv, 0.0, 1.0");
        expect(normal).not.toContain("in.color.rgb, 1.0");
    });

    test("forceWireColor overrides finalColor and wins over debugView", () => {
        const flags: DebugFlags = { ...DEFAULT_DEBUG_FLAGS, debugView: "uv", forceWireColor: true };
        const code = generateShaderCode(baseConfig(flags));
        expect(code).toContain("finalColor = vec4f(1.0, 0.5, 0.0, 1.0);");
        expect(code).not.toContain("in.uv, 0.0, 1.0");
    });
});

describe("ddraw/d3d8 texture upload — textureConverterDebugMode (CPU path)", () => {
    // BitmapTexture surfaces (the common D3D8 CreateTexture+LockRect route) upload via the
    // CPU rgbaScratch path, which never reaches the GPU compute shader's debugMode branch
    // (ddraw-backend-executor.ts's syncSurfaceFromMemory "useTextureConverter" GPU branch
    // is skipped whenever hasFreshRGBA is true). applyTextureConverterDebugPaintCPU is the
    // fix: a post-process step the CPU upload path runs before every writeTexture.
    test("mode 1 (format) paints every texel a flat colour keyed by source bit depth", () => {
        const width = 4, height = 4;
        const rgba = new Uint8Array(width * height * 4).fill(0); // fully black source
        applyTextureConverterDebugPaintCPU(rgba, width, height, 1, 32);
        for (let i = 0; i < rgba.length; i += 4) {
            expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]).toEqual([255, 0, 0, 255]); // 32bpp = red
        }
    });

    test("mode 1 distinguishes 16-bit and 8-bit sources from 32-bit", () => {
        const width = 2, height = 2;
        const rgba16 = new Uint8Array(width * height * 4);
        applyTextureConverterDebugPaintCPU(rgba16, width, height, 1, 16);
        expect([rgba16[0], rgba16[1], rgba16[2]]).toEqual([0, 255, 0]);

        const rgba8 = new Uint8Array(width * height * 4);
        applyTextureConverterDebugPaintCPU(rgba8, width, height, 1, 8);
        expect([rgba8[0], rgba8[1], rgba8[2]]).toEqual([0, 0, 255]);
    });

    test("mode 0 (off) leaves the buffer untouched — the lever has an OFF state", () => {
        const width = 2, height = 2;
        const rgba = new Uint8Array(width * height * 4).fill(0x7f);
        const before = rgba.slice();
        applyTextureConverterDebugPaintCPU(rgba, width, height, 0, 32);
        expect(rgba).toEqual(before);
    });
});

describe("d3d8 draws reach the shared ddraw executor's shader path", () => {
    // Structural guard against the exact regression this task fixes: a D3D8 draw path that
    // quietly stops flowing through DDrawWebGPUExecutor (and therefore through
    // pipeline-factory's debugFlags-driven ShaderConfig) would make every lever above
    // inert again for D3D8 specifically, while this file's other tests kept passing.
    const src = readFileSync(
        join(__dirname, "..", "..", "src", "worker", "backends", "webgpu", "d3d8", "d3d8-device-adapter.ts"),
        "utf-8",
    );

    test("renderer field is typed as the shared DDrawWebGPUExecutor", () => {
        expect(src).toMatch(/readonly renderer:\s*DDrawWebGPUExecutor/);
    });

    test("draw entry points call straight into the shared renderer, not a private path", () => {
        expect(src).toContain("this.renderer.drawPrimitive(");
        expect(src).toContain("this.renderer.drawIndexedPrimitive(");
    });
});
