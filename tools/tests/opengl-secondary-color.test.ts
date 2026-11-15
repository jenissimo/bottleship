import { expect, test } from "bun:test";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { VERT_FLOATS, VERT_FOG_DIST, VERT_SECONDARY_COLOR } from "../../src/worker/modules/opengl32/context";
import { GL_CCW, GL_FILL, GL_LINE, GL_LINES, GL_TRIANGLES } from "../../src/worker/modules/opengl32/constants";
import type { OpenGLPipelineConfig } from "../../src/worker/backends/webgpu/opengl/opengl-pipeline-factory";
import { probeOfflineWgslValidator, validateWgslOffline } from "../d3d9-parity/wgsl-validator";

interface Packed { data: Float32Array; byteLength: number; vertexCount: number; topology: string; }
interface ExecutorProbe {
    vertexScratch: Float32Array; expandScratch: Float32Array;
    pipelineCache: Map<string, GPURenderPipeline>;
    prepareDrawData(arena: Float32Array, offset: number, count: number, mode: number, polygon: number): Packed;
    getOrCreatePipeline(device: GPUDevice, cfg: OpenGLPipelineConfig): GPURenderPipeline;
    buildShaderCode(): string;
}
function executor(): ExecutorProbe {
    return Object.assign(Object.create(OpenGLBackendExecutor.prototype), {
        vertexScratch: new Float32Array(0), expandScratch: new Float32Array(0), pipelineCache: new Map(),
    }) as ExecutorProbe;
}
function vertex(arena: Float32Array, index: number, secondary: number[]) {
    const at = index * VERT_FLOATS;
    arena.set([index, 2, 3, 1, .2, .4, .6, .37, 7, 8, 9, .1, .2, .3, .4], at);
    arena.set(secondary, at + VERT_SECONDARY_COLOR);
}

test("GL secondary RGB packs after untouched primary/UV/fog fields and advances the full CPU stride", () => {
    expect(VERT_FLOATS).toBe(18); expect(VERT_SECONDARY_COLOR).toBe(15);
    const arena = new Float32Array(3 * VERT_FLOATS);
    vertex(arena, 0, [99, 99, 99]); // nonzero source offset must skip this vertex
    vertex(arena, 1, [.7, .8, .9]); vertex(arena, 2, [1.5, -.2, .25]);
    arena[VERT_FLOATS + VERT_FOG_DIST] = 42;
    const packed = executor().prepareDrawData(arena, VERT_FLOATS, 2, GL_LINES, GL_FILL);
    expect(packed.vertexCount).toBe(2); expect(packed.byteLength).toBe(2 * 16 * 4);
    expect(packed.data.length).toBe(32);
    const expected = [1, 2, 3, 1, .2, .4, .6, .37, .1, .2, .3, .4, 42, .7, .8, .9];
    for (let i = 0; i < expected.length; i++) expect(packed.data[i]).toBeCloseTo(expected[i]!, 6);
    expect([...packed.data.subarray(29, 32)]).toEqual([1, 0, .25]); // vertex-stage color clamp
});

test("polygon wire expansion preserves secondary RGB from both ends of every edge", () => {
    const arena = new Float32Array(3 * VERT_FLOATS);
    vertex(arena, 0, [1, 0, 0]); vertex(arena, 1, [0, 1, 0]); vertex(arena, 2, [0, 0, 1]);
    const packed = executor().prepareDrawData(arena, 0, 3, GL_TRIANGLES, GL_LINE);
    expect(packed.topology).toBe("line-list"); expect(packed.vertexCount).toBe(6);
    const expected = [[1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0]];
    for (let i = 0; i < expected.length; i++) expect([...packed.data.subarray(i * 16 + 13, i * 16 + 16)]).toEqual(expected[i]!);
});

test("the actual GPU pipeline descriptor maps secondary RGB to its packed byte range", () => {
    const g = globalThis as unknown as { GPUColorWrite?: typeof GPUColorWrite };
    const previous = g.GPUColorWrite;
    g.GPUColorWrite = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };
    try {
        let descriptor: GPURenderPipelineDescriptor | undefined;
        const device = { createRenderPipeline(value: GPURenderPipelineDescriptor) { descriptor = value; return {}; } } as unknown as GPUDevice;
        const cfg: OpenGLPipelineConfig = { topology: "triangle-list", blendEnabled: false, blendSrc: 1, blendDst: 0,
            depthTest: false, depthWrite: false, depthFunc: 0, cullEnabled: false, cullFace: 0, frontFace: GL_CCW,
            colorMaskR: true, colorMaskG: true, colorMaskB: true, colorMaskA: true,
            stencilTest: false, stencilFunc: 0, stencilMask: 255, stencilWriteMask: 255, stencilFail: 0, stencilZFail: 0, stencilZPass: 0 };
        executor().getOrCreatePipeline(device, cfg);
        const buffers = Array.from(descriptor!.vertex.buffers!);
        expect(buffers[0]!.arrayStride).toBe(64);
        expect(Array.from(buffers[0]!.attributes)).toEqual([
            { shaderLocation: 0, offset: 0, format: "float32x4" }, { shaderLocation: 1, offset: 16, format: "float32x4" },
            { shaderLocation: 2, offset: 32, format: "float32x2" }, { shaderLocation: 3, offset: 40, format: "float32x2" },
            { shaderLocation: 4, offset: 48, format: "float32" }, { shaderLocation: 5, offset: 52, format: "float32x3" },
        ]);
    } finally {
        if (previous === undefined) delete g.GPUColorWrite; else g.GPUColorWrite = previous;
    }
});

function splitArgs(value: string): string[] {
    const args: string[] = []; let depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === "(") depth++; else if (value[i] === ")") depth--;
        else if (value[i] === "," && depth === 0) { args.push(value.slice(start, i)); start = i + 1; }
    }
    args.push(value.slice(start)); return args;
}
/** Evaluate arithmetic lifted from the emitted WGSL, following the existing FFP combiner test strategy.
 * This is a narrow scalar evaluator, not a separate implementation of the lighting equation. */
function evalColor(expr: string, color: number[], secondary: number[], fog: number[], fogF: number): number[] {
    const args = splitArgs(expr.trim().slice("vec4f(".length, -1)); expect(args.length).toBe(2);
    return [0, 1, 2, 3].map(i => {
        const js = args[i === 3 ? 1 : 0]!
            .replace(/vec3f\(([0-9.]+)\)/g, "$1")
            .replace(/uniforms\.fogColor\.rgb/g, "fog[i]")
            .replace(/input\.secondary/g, "secondary[i]")
            .replace(/color\.rgb/g, "color[i]").replace(/color\.a/g, "color[3]");
        return new Function("color", "secondary", "fog", "fogF", "i", "clamp", "mix", `return (${js});`)(
            color, secondary, fog, fogF, i,
            (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
            (a: number, b: number, t: number) => a * (1 - t) + b * t);
    });
}

test("emitted WGSL adds specular after both textures and before fog while leaving alpha unchanged", () => {
    const wgsl = executor().buildShaderCode(), fragment = wgsl.slice(wgsl.indexOf("fn fs_main"));
    expect(wgsl).toContain("@location(5) secondary: vec3f");
    expect(wgsl).toContain("@location(4) secondary: vec3f");
    expect(wgsl).toContain("out.secondary = input.secondary;");
    const assignments = [...fragment.matchAll(/color = (vec4f\([^;]+\));/g)];
    const secondary = assignments.find(m => m[1]!.includes("input.secondary"));
    const fog = assignments.find(m => m[1]!.includes("mix("));
    expect(secondary).toBeDefined(); expect(fog).toBeDefined();
    expect(fragment.indexOf(secondary![0])).toBeGreaterThan(fragment.indexOf("color = applyTexEnv(uniforms.texEnv1"));
    expect(fragment.indexOf(secondary![0])).toBeLessThan(fragment.indexOf("alphaTestPass("));
    expect(fragment.indexOf(secondary![0])).toBeLessThan(fragment.indexOf(fog![0]));
    // OpenGL1.5 independent oracle: primary.8 * texture0.5 * texture1.25 = .1,
    // plus separate specular.4 = .5; then fog(.1,.5)=.3. Alpha .37*.5*.8=.148.
    const textured = [.1, .1, .1, .148];
    const lit = evalColor(secondary![1]!, textured, [.4, .4, .4], [.1, .1, .1], .5);
    const result = evalColor(fog![1]!, lit, [.4, .4, .4], [.1, .1, .1], .5);
    for (let i = 0; i < 3; i++) expect(result[i]).toBeCloseTo(.3, 7);
    expect(result[3]).toBeCloseTo(.148, 7);
    // Unlit/ordinary single-color packets carry zero secondary and retain their previous result.
    expect(evalColor(secondary![1]!, textured, [0, 0, 0], [0, 0, 0], 1)).toEqual(textured);
    expect(evalColor(secondary![1]!, [.9, .8, .7, .25], [.5, .5, .5], [], 1)).toEqual([1, 1, 1, .25]);
});

test("the complete GL shader passes the available real WGSL validator", () => {
    const validator = probeOfflineWgslValidator();
    const result = validateWgslOffline(executor().buildShaderCode(), validator);
    expect(result.status, result.diagnostics ?? result.reason).toBe(validator.available ? "passed" : "skipped");
});
