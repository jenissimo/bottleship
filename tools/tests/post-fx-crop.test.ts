/**
 * A cropped source (the host view's part of a screen plane) is sampled through the crop UVs
 * only by a passthrough pass. An effect that sampled the plane through them would centre its
 * vignette or curvature on the plane, let pixels outside the crop in, and step its texels in
 * plane units while its uniforms carry the crop's resolution.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostFxChain } from "../../src/worker/backends/webgpu/postfx/post-fx-chain";
import { DEFAULT_QUALITY, type QualityConfig } from "../../src/worker/core/quality-config";

const g = globalThis as Record<string, unknown>;
const WEBGPU_ENUMS: Record<string, unknown> = {
    GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 },
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
};
const before: Record<string, unknown> = {};
beforeAll(() => { for (const k of Object.keys(WEBGPU_ENUMS)) { before[k] = g[k]; g[k] ??= WEBGPU_ENUMS[k]; } });
afterAll(() => { for (const k of Object.keys(WEBGPU_ENUMS)) { if (before[k] === undefined) delete g[k]; else g[k] = before[k]; } });

interface Pass { passthrough: boolean; cropQuad: boolean; target: unknown }

function rig(quality: QualityConfig) {
    const buffers: Array<{ size: number }> = [];
    const passes: Pass[] = [];
    let cropBuffer: unknown = null;
    const device = {
        limits: { minUniformBufferOffsetAlignment: 256 },
        createBuffer: (d: { size: number }) => { const b = { size: d.size }; buffers.push(b); return b; },
        createSampler: () => ({}),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createBindGroup: () => ({}),
        createShaderModule: (d: { code: string }) => ({ code: d.code, getCompilationInfo: () => Promise.resolve({ messages: [] }) }),
        createRenderPipeline: (d: { fragment: { module: { code: string } } }) =>
            ({ passthrough: /return textureSample\(inputTex, inputSampler, in\.uv\);\s*\}$/.test(d.fragment.module.code.trim()) }),
        createTexture: () => ({ createView: () => ({ intermediate: true }), destroy: () => undefined }),
        queue: {
            writeBuffer: (b: unknown, _o: number, data: ArrayBufferView | ArrayBuffer) => {
                if (data instanceof Float32Array && data.length === 24 && data[2] !== 0) cropBuffer = b;
            },
        },
    };
    const chain = new PostFxChain(device as unknown as GPUDevice, () => quality);
    chain.setFormat("bgra8unorm");
    const encoder = {
        beginRenderPass: (d: { colorAttachments: Array<{ view: unknown }> }) => {
            const p: Pass = { passthrough: false, cropQuad: false, target: d.colorAttachments[0]!.view };
            passes.push(p);
            return {
                setViewport: () => undefined, setScissorRect: () => undefined,
                setPipeline: (pl: { passthrough: boolean }) => { p.passthrough = pl.passthrough; },
                setBindGroup: () => undefined,
                setVertexBuffer: (_s: number, b: unknown) => { p.cropQuad = b === cropBuffer && b !== null; },
                draw: () => undefined, end: () => undefined,
            };
        },
    };
    const canvas = { canvas: true };
    const present = (sourceUv?: readonly [number, number, number, number], out = [800, 600]) => {
        passes.length = 0;
        chain.present({} as GPUTextureView, canvas as unknown as GPUTextureView, encoder as unknown as GPUCommandEncoder, {
            sourceWidth: 400, sourceHeight: 300, outputWidth: out[0], outputHeight: out[1], sourceUv,
        });
        return passes.slice();
    };
    return { present, chain, canvas };
}

const CROP = [0.25, 0.25, 0.75, 0.75] as const;

describe("PostFxChain with a cropped source", () => {
    test("no effect: one passthrough pass samples the crop straight onto the canvas", () => {
        const { present, canvas } = rig({ ...DEFAULT_QUALITY });
        const passes = present(CROP);
        expect(passes.length).toBe(1);
        expect(passes[0]).toEqual({ passthrough: true, cropQuad: true, target: canvas });
    });

    test("an effect that does not need output resolution gets a [0,1] intermediate, not the crop", () => {
        const { present, canvas } = rig({ ...DEFAULT_QUALITY, vignette: 0.5 });
        const passes = present(CROP);
        expect(passes.length).toBe(2);
        expect(passes[0]!.passthrough && passes[0]!.cropQuad).toBe(true);
        expect(passes[0]!.target).not.toBe(canvas);
        expect(passes[1]!.cropQuad).toBe(false);
        expect(passes[1]!.target).toBe(canvas);
    });

    test("an output-resolution effect at 1:1 also reads the cropped intermediate", () => {
        const { present } = rig({ ...DEFAULT_QUALITY, scanlines: true });
        const passes = present(CROP, [400, 300]);
        expect(passes.filter((p) => p.cropQuad).length).toBe(1);
        expect(passes.find((p) => p.cropQuad)!.passthrough).toBe(true);
        expect(passes.at(-1)!.cropQuad).toBe(false);
    });

    test("without a crop the effect chain is what it was", () => {
        const { present, canvas } = rig({ ...DEFAULT_QUALITY, vignette: 0.5 });
        const passes = present();
        expect(passes.length).toBe(1);
        expect(passes[0]!.cropQuad).toBe(false);
        expect(passes[0]!.target).toBe(canvas);
    });
});
