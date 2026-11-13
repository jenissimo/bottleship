/**
 * GPU mip-chain generator.
 *
 * WebGPU has no built-in generateMipmaps, so we render each mip level from the previous
 * one with a fullscreen-triangle + linear sampler (a 2×2 box downsample via bilinear at the
 * destination texel centers). This is what makes forced anisotropic / trilinear filtering
 * actually bite — without a mip chain those sampler overrides have nothing to filter between.
 *
 * The target texture MUST be created with `mipLevelCount = N` and usage
 * `RENDER_ATTACHMENT | TEXTURE_BINDING`. Level 0 must already hold the source image.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { beforeQueueWrite } from "../shared/queue-write-guard";
// Re-exported from the shared mip math so existing importers (ddraw-backend-executor) are unaffected.
export { mipLevelCountFor } from "../shared/mip-utils";

export class MipGenerator {
    private device: GPUDevice;
    private sampler: GPUSampler;
    private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

    constructor(device: GPUDevice) {
        this.device = device;
        // Linear, clamp — a bilinear tap at each dst texel center averages the 2×2 src block.
        this.sampler = device.createSampler({
            magFilter: "linear", minFilter: "linear",
            addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
        });
    }

    private getPipeline(format: GPUTextureFormat): GPURenderPipeline {
        let p = this.pipelines.get(format);
        if (p) return p;
        const module = this.device.createShaderModule({
            code: /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
    // Fullscreen triangle. uv preserves orientation (v=0 top) so the mip isn't flipped.
    var clip = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var uvs  = array<vec2f, 3>(vec2f(0.0, 1.0),  vec2f(2.0, 1.0),  vec2f(0.0, -1.0));
    var o: VSOut;
    o.pos = vec4f(clip[i], 0.0, 1.0);
    o.uv = uvs[i];
    return o;
}
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    return textureSample(t, s, in.uv);
}`,
        });
        p = this.device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        this.pipelines.set(format, p);
        return p;
    }

    /**
     * (Re)generate mip levels 1..levelCount-1 of `texture` from level 0. Submits its own
     * command buffer. No-op for levelCount <= 1.
     */
    generate(texture: GPUTexture, format: GPUTextureFormat, levelCount: number): void {
        if (levelCount <= 1) return;
        const pipeline = this.getPipeline(format);
        const encoder = this.device.createCommandEncoder();
        for (let level = 1; level < levelCount; level++) {
            const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
            const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
            const bindGroup = this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: srcView },
                ],
            });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: dstView, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3, 1, 0, 0);
            pass.end();
        }
        // The levels are written by this submit, ahead of any recorded work that samples them.
        beforeQueueWrite(texture);
        this.device.queue.submit([encoder.finish()]);
        Logger.verbose(LogCategory.DDRAW, `MipGenerator: generated ${levelCount - 1} mip level(s)`);
    }
}
