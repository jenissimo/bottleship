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

interface Pass { passthrough: boolean; cropQuad: boolean; placedQuad: boolean; target: unknown }

function rig(quality: QualityConfig) {
    const passes: Pass[] = [];
    const contents = new Map<unknown, Float32Array>();
    const device = {
        limits: { minUniformBufferOffsetAlignment: 256 },
        createBuffer: (d: { size: number }) => ({ size: d.size }),
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
                if (data instanceof Float32Array && data.length === 24) contents.set(b, data.slice());
            },
        },
    };
    const chain = new PostFxChain(device as unknown as GPUDevice, () => quality);
    chain.setFormat("bgra8unorm");
    const encoder = {
        beginRenderPass: (d: { colorAttachments: Array<{ view: unknown }> }) => {
            const p: Pass = { passthrough: false, cropQuad: false, placedQuad: false, target: d.colorAttachments[0]!.view };
            passes.push(p);
            return {
                setViewport: () => undefined, setScissorRect: () => undefined,
                setPipeline: (pl: { passthrough: boolean }) => { p.passthrough = pl.passthrough; },
                setBindGroup: () => undefined,
                setVertexBuffer: (_s: number, b: unknown) => {
                    const q = contents.get(b);
                    if (!q) return;
                    const us = [q[2], q[6], q[10], q[14], q[18], q[22]], vs = [q[3], q[7], q[11], q[15], q[19], q[23]];
                    const xs = [q[0], q[4], q[8], q[12], q[16], q[20]], ys = [q[1], q[5], q[9], q[13], q[17], q[21]];
                    p.cropQuad = Math.min(...us) > 0 || Math.max(...us) < 1 || Math.min(...vs) > 0 || Math.max(...vs) < 1;
                    p.placedQuad = Math.min(...xs) > -1 || Math.max(...xs) < 1 || Math.min(...ys) > -1 || Math.max(...ys) < 1;
                },
                draw: () => undefined, end: () => undefined,
            };
        },
    };
    const canvas = { canvas: true };
    const present = (sourceUv?: readonly [number, number, number, number], out = [800, 600],
        destPlace?: readonly [number, number, number, number]) => {
        passes.length = 0;
        chain.present({} as GPUTextureView, canvas as unknown as GPUTextureView, encoder as unknown as GPUCommandEncoder, {
            sourceWidth: 400, sourceHeight: 300, outputWidth: out[0], outputHeight: out[1], sourceUv, destPlace,
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
        expect(passes[0]).toEqual({ passthrough: true, cropQuad: true, placedQuad: false, target: canvas });
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

    test("a placed picture: one pass crops and places; with an effect that pass fills a cleared intermediate and the effect runs over the whole view", () => {
        const PLACE = [0.1, 0.2, 0.6, 0.9] as const;
        const plain = rig({ ...DEFAULT_QUALITY }).present(CROP, [800, 600], PLACE);
        expect(plain.map(p => [p.passthrough, p.cropQuad, p.placedQuad])).toEqual([[true, true, true]]);
        const { present, canvas } = rig({ ...DEFAULT_QUALITY, vignette: 0.5 });
        const passes = present(CROP, [800, 600], PLACE);
        expect(passes.map(p => [p.cropQuad, p.placedQuad])).toEqual([[true, true], [false, false]]);
        expect(passes[0]!.passthrough).toBe(true);
        expect(passes[0]!.target).not.toBe(canvas);
        expect(passes[1]!.target).toBe(canvas);
        const placedOnly = present(undefined, [800, 600], PLACE);
        expect(placedOnly.map(p => [p.cropQuad, p.placedQuad])).toEqual([[false, true], [false, false]]);
    });
});
