/**
 * PostFxChain — the unified present/post-process path.
 *
 * This is the keystone of the graphics-QoL refactor: every backend's "blit the final
 * frame to the canvas" (ddraw / d3d8 / opengl / glide, via WebGPUBackend.drawTexture
 * with opaque=true) routes here. The chain owns gamma, user color grade, FXAA, the
 * example post effects, and presentation scaling (integer / pillarbox).
 *
 * Cost contract: when nothing is configured the chain runs a SINGLE plain
 * passthrough blit — byte-identical to the pre-feature present. Each enabled effect adds
 * exactly one pass; intermediates are lazily allocated only when the chain is >1 pass.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { QualityConfig } from "../../../core/quality-config";
import {
    PostEffect,
    PostFrameContext,
    POSTFX_WGSL_PRELUDE,
    COMMON_UNIFORM_SIZE,
    writeCommonUniforms,
} from "./post-effect";
import { getActiveEffects } from "./registry";
import { computePresentDestRect, PresentRect } from "../shared/present-geometry";

export interface PresentOptions {
    /** Clear the target before drawing (letterbox bars take this color). */
    clearColor?: GPUColor;
    /** Sample the source with nearest filtering (pixel-perfect present). */
    nearest?: boolean;
    /** Existing full-canvas viewport semantics (1:1, avoids HiDPI stretch). */
    viewport?: { width: number; height: number };
    /** Source texture pixel size (for FXAA texel + aspect/integer scaling + intermediates). */
    sourceWidth?: number;
    sourceHeight?: number;
    /** Output (canvas) pixel size. */
    outputWidth?: number;
    outputHeight?: number;
}

interface PipelineEntry { pipeline: GPURenderPipeline | null; valid: boolean; }

interface Intermediate { texture: GPUTexture; view: GPUTextureView; w: number; h: number; }

const MAX_PASSES = 6;
const VERTEX_STRIDE = 16;
// Intermediate (ping-pong) format: 16-bit float keeps multi-pass color-grade / CRT / FXAA
// chains free of the banding 8-bit intermediates accumulate. rgba16float is filterable +
// renderable everywhere WebGPU runs. The FINAL pass still targets the canvas format.
const INTERMEDIATE_FORMAT: GPUTextureFormat = "rgba16float";

function roundUp(n: number, mult: number): number {
    return Math.ceil(n / mult) * mult;
}

export class PostFxChain {
    private device: GPUDevice;
    private getQuality: () => QualityConfig;
    private format: GPUTextureFormat | null = null;

    private gammaLut: Float32Array | null = null;
    private frame = 0;

    // Lazily-created shared resources.
    private vertexBuffer: GPUBuffer | null = null;
    private samplerLinear: GPUSampler | null = null;
    private samplerNearest: GPUSampler | null = null;
    private layout2: GPUBindGroupLayout | null = null;   // bindings 0,1,2 (no private uniforms)
    private layout3: GPUBindGroupLayout | null = null;   // bindings 0,1,2,3
    private pipelineLayout2: GPUPipelineLayout | null = null;
    private pipelineLayout3: GPUPipelineLayout | null = null;
    private uniformAlign = 256;
    private commonBuffer: GPUBuffer | null = null;        // MAX_PASSES slots
    private commonScratch = new ArrayBuffer(COMMON_UNIFORM_SIZE);

    // Per-effect private uniform buffers (single slot each).
    private privateBuffers = new Map<string, { buffer: GPUBuffer; size: number }>();
    // Pipeline cache: `${effectId}:${format}` and `__passthrough:${format}`.
    private pipelineCache = new Map<string, PipelineEntry>();
    private passthroughCache = new Map<GPUTextureFormat, GPURenderPipeline>();

    private intermediates: Intermediate[] = [];

    constructor(device: GPUDevice, getQuality: () => QualityConfig) {
        this.device = device;
        this.getQuality = getQuality;
        const align = device.limits.minUniformBufferOffsetAlignment;
        if (align && align > 0) this.uniformAlign = align;
    }

    setFormat(format: GPUTextureFormat): void {
        this.format = format;
    }

    /** Store the current gamma ramp (768 normalized floats) or null = identity/disabled. */
    updateGammaLut(lut: Float32Array | null): void {
        this.gammaLut = lut;
    }

    hasGamma(): boolean {
        return !!this.gammaLut;
    }

    /** Drop size-dependent caches (call on canvas reconfigure). */
    invalidate(): void {
        for (const it of this.intermediates) it.texture.destroy();
        this.intermediates = [];
    }

    // ---- resource setup -------------------------------------------------------

    private ensureResources(): void {
        if (this.vertexBuffer) return;

        // Fullscreen quad: pos(x,y) + uv(u,v). uv.y=0 at top (NDC y=+1) — matches the
        // backend's overlay quad so present orientation is unchanged.
        const verts = new Float32Array([
            -1, -1, 0, 1,
             1, -1, 1, 1,
             1,  1, 1, 0,
            -1, -1, 0, 1,
             1,  1, 1, 0,
            -1,  1, 0, 0,
        ]);
        this.vertexBuffer = this.device.createBuffer({
            size: verts.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.vertexBuffer, 0, verts);

        this.samplerLinear = this.device.createSampler({
            magFilter: "linear", minFilter: "linear",
            addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
        });
        this.samplerNearest = this.device.createSampler({
            magFilter: "nearest", minFilter: "nearest",
            addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
        });

        const tex: GPUBindGroupLayoutEntry = { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } };
        const smp: GPUBindGroupLayoutEntry = { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } };
        const common: GPUBindGroupLayoutEntry = { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: COMMON_UNIFORM_SIZE } };
        const priv: GPUBindGroupLayoutEntry = { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } };

        this.layout2 = this.device.createBindGroupLayout({ entries: [tex, smp, common] });
        this.layout3 = this.device.createBindGroupLayout({ entries: [tex, smp, common, priv] });
        this.pipelineLayout2 = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout2] });
        this.pipelineLayout3 = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout3] });

        this.commonBuffer = this.device.createBuffer({
            size: this.uniformAlign * MAX_PASSES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    private vertexLayout(): GPUVertexBufferLayout {
        return {
            arrayStride: VERTEX_STRIDE,
            attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x2" },
                { shaderLocation: 1, offset: 8, format: "float32x2" },
            ],
        };
    }

    private getPassthrough(format: GPUTextureFormat): GPURenderPipeline {
        let p = this.passthroughCache.get(format);
        if (p) return p;
        const code = POSTFX_WGSL_PRELUDE + `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
    return textureSample(inputTex, inputSampler, in.uv);
}`;
        const module = this.device.createShaderModule({ code });
        p = this.device.createRenderPipeline({
            layout: this.pipelineLayout2!,
            vertex: { module, entryPoint: "vs_main", buffers: [this.vertexLayout()] },
            fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        this.passthroughCache.set(format, p);
        return p;
    }

    private getEffectPipeline(effect: PostEffect, format: GPUTextureFormat): PipelineEntry {
        const key = `${effect.id}:${format}`;
        const cached = this.pipelineCache.get(key);
        if (cached) return cached;

        const entry: PipelineEntry = { pipeline: null, valid: false };
        const code = POSTFX_WGSL_PRELUDE + "\n" + effect.fragmentSource();
        const module = this.device.createShaderModule({ code });
        // Async compile-gate: a broken effect shader can't black-screen — we keep using
        // passthrough for that pass until compilation is confirmed clean.
        module.getCompilationInfo().then((info) => {
            const errors = info.messages.filter((m) => m.type === "error");
            if (errors.length > 0) {
                Logger.error(LogCategory.SYSTEM,
                    `[POSTFX] effect '${effect.id}' shader FAILED: ${errors.map((e) => e.message).join("; ")}`);
                entry.valid = false;
            } else {
                entry.valid = true;
            }
        });
        entry.pipeline = this.device.createRenderPipeline({
            layout: effect.uniformSize > 0 ? this.pipelineLayout3! : this.pipelineLayout2!,
            vertex: { module, entryPoint: "vs_main", buffers: [this.vertexLayout()] },
            fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        this.pipelineCache.set(key, entry);
        return entry;
    }

    private getPrivateBuffer(effect: PostEffect): GPUBuffer {
        let pb = this.privateBuffers.get(effect.id);
        const want = roundUp(effect.uniformSize, 16);
        if (!pb || pb.size < want) {
            if (pb) pb.buffer.destroy();
            const buffer = this.device.createBuffer({
                size: want, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            pb = { buffer, size: want };
            this.privateBuffers.set(effect.id, pb);
        }
        return pb.buffer;
    }

    private getIntermediate(index: number, w: number, h: number): Intermediate {
        let it = this.intermediates[index];
        if (it && (it.w !== w || it.h !== h)) {
            it.texture.destroy();
            it = undefined as unknown as Intermediate;
        }
        if (!it) {
            const texture = this.device.createTexture({
                size: [Math.max(1, w), Math.max(1, h)],
                format: INTERMEDIATE_FORMAT,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            it = { texture, view: texture.createView(), w, h };
            this.intermediates[index] = it;
        }
        return it;
    }

    // ---- the present ----------------------------------------------------------

    /**
     * Run the active effect chain and present `srcView` to `target`. Used by
     * WebGPUBackend.drawTexture(opaque=true) for ALL backends.
     *
     * Pass plan:
     *   - no effects                → 1 plain passthrough blit (byte-identical to the legacy present).
     *   - source-res chain          → effects ping-pong at source res; final → canvas (scaled).
     *   - output-res chain (CRT/    → upscale source → content-res buffer, run the chain there so
     *     scanlines/FXAA active)       scanlines/aperture/edge-AA land on real display pixels.
     */
    present(srcView: GPUTextureView, target: GPUTextureView, encoder: GPUCommandEncoder, opts: PresentOptions): void {
        if (!this.format) return;
        this.ensureResources();
        this.frame++;
        // Monotonic wall-clock seconds for animated effects. performance.now() is the worker's
        // standard monotonic clock (not the banned Date.now()/Math.random()).
        const time = performance.now() / 1000;
        const q = this.getQuality();

        const srcW = opts.sourceWidth ?? opts.viewport?.width ?? 0;
        const srcH = opts.sourceHeight ?? opts.viewport?.height ?? 0;
        const outW = opts.outputWidth ?? opts.viewport?.width ?? 0;
        const outH = opts.outputHeight ?? opts.viewport?.height ?? 0;
        const outAspect = outH > 0 ? outW / outH : 1;
        const destRect = computePresentDestRect(srcW, srcH, outW, outH, q);

        const effects = getActiveEffects(q, this.hasGamma());
        const finalGeom = {
            clearColor: opts.clearColor ?? (destRect ? { r: 0, g: 0, b: 0, a: 1 } as GPUColor : undefined),
            destRect,
            viewport: opts.viewport,
        };

        if (effects.length === 0) {
            // Fast path: single passthrough blit. Byte-identical to the legacy opaque present.
            this.writeCommonSlot(0, srcW || outW || 1, srcH || outH || 1, outW, outH, outAspect, time, q, null);
            const bg = this.buildBindGroup(srcView, !!opts.nearest, 0, null);
            this.drawPass(encoder, this.getPassthrough(this.format!), bg, target, finalGeom);
            return;
        }

        // Display content size (post-letterbox). When the chain runs at output res, this is
        // the actual on-screen pixel count of the game image.
        const contentW = destRect ? destRect.w : (outW || srcW);
        const contentH = destRect ? destRect.h : (outH || srcH);
        const wantOutputRes = contentW > 0 && contentH > 0 &&
            effects.some((e) => (e.needsOutputRes ? e.needsOutputRes(q) : false));
        const workW = wantOutputRes ? contentW : (srcW || contentW || 1);
        const workH = wantOutputRes ? contentH : (srcH || contentH || 1);
        const needUpscale = wantOutputRes && (workW !== srcW || workH !== srcH);

        const ctx: PostFrameContext = {
            resolution: { width: workW, height: workH },
            outputSize: { width: outW || workW, height: outH || workH },
            time, frame: this.frame, quality: q, gammaLut: this.gammaLut, outputAspect: outAspect,
        };

        // Write per-pass common uniforms (distinct 256-aligned slots) + per-effect private
        // uniforms (1 each) up front — every queue.writeBuffer lands before the recorded passes,
        // so each pass must read a DISTINCT region.
        const passCount = effects.length + (needUpscale ? 1 : 0);
        const cdv = new DataView(this.commonScratch);
        for (let p = 0; p < passCount && p < MAX_PASSES; p++) {
            writeCommonUniforms(cdv, 0, ctx);
            this.device.queue.writeBuffer(this.commonBuffer!, p * this.uniformAlign, this.commonScratch);
        }
        for (const e of effects) {
            if (e.uniformSize > 0 && e.writeUniforms) {
                const scratch = new ArrayBuffer(roundUp(e.uniformSize, 16));
                e.writeUniforms(new DataView(scratch), ctx);
                this.device.queue.writeBuffer(this.getPrivateBuffer(e), 0, scratch);
            }
        }

        let slot = 0;
        let readView = srcView;
        let writeIdx = 0; // which ping-pong buffer the next intermediate pass writes to

        if (needUpscale) {
            const up = this.getIntermediate(0, workW, workH);
            const bg = this.buildBindGroup(readView, !!opts.nearest, slot, null);
            this.drawPass(encoder, this.getPassthrough(INTERMEDIATE_FORMAT), bg, up.view, { clearColor: { r: 0, g: 0, b: 0, a: 1 } });
            readView = up.view;
            slot++;
            writeIdx = 1;
        }

        // Pre-effects: render into rgba16float intermediates at workRes.
        const preCount = effects.length - 1;
        for (let i = 0; i < preCount; i++) {
            const dst = this.getIntermediate(writeIdx % 2, workW, workH);
            this.runEffectPass(encoder, effects[i], slot, readView, dst.view, INTERMEDIATE_FORMAT, false,
                { clearColor: { r: 0, g: 0, b: 0, a: 1 } });
            readView = dst.view;
            writeIdx ^= 1;
            slot++;
        }

        // Final effect → canvas, with present geometry (scaling / letterbox).
        this.runEffectPass(encoder, effects[preCount], slot, readView, target, this.format!, !!opts.nearest, finalGeom);
    }

    /** Write one CommonUniforms slot (helper for the fast path). */
    private writeCommonSlot(
        slot: number, resW: number, resH: number, outW: number, outH: number, outAspect: number,
        time: number, q: QualityConfig, gammaLut: Float32Array | null,
    ): void {
        const cdv = new DataView(this.commonScratch);
        writeCommonUniforms(cdv, 0, {
            resolution: { width: resW, height: resH },
            outputSize: { width: outW || resW, height: outH || resH },
            time, frame: this.frame, quality: q, gammaLut, outputAspect: outAspect,
        });
        this.device.queue.writeBuffer(this.commonBuffer!, slot * this.uniformAlign, this.commonScratch);
    }

    private buildBindGroup(inputView: GPUTextureView, nearest: boolean, slot: number, paramsEffect: PostEffect | null): GPUBindGroup {
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: inputView },
            { binding: 1, resource: nearest ? this.samplerNearest! : this.samplerLinear! },
            { binding: 2, resource: { buffer: this.commonBuffer!, offset: slot * this.uniformAlign, size: COMMON_UNIFORM_SIZE } },
        ];
        if (paramsEffect) {
            entries.push({ binding: 3, resource: { buffer: this.getPrivateBuffer(paramsEffect), offset: 0, size: roundUp(paramsEffect.uniformSize, 16) } });
        }
        return this.device.createBindGroup({ layout: paramsEffect ? this.layout3! : this.layout2!, entries });
    }

    private runEffectPass(
        encoder: GPUCommandEncoder, effect: PostEffect, slot: number,
        inputView: GPUTextureView, target: GPUTextureView, targetFormat: GPUTextureFormat, nearest: boolean,
        geom: { clearColor?: GPUColor; destRect?: PresentRect | null; viewport?: { width: number; height: number } },
    ): void {
        const pe = this.getEffectPipeline(effect, targetFormat);
        const useEffect = pe.valid && !!pe.pipeline;
        const useParams = useEffect && effect.uniformSize > 0;
        const pipeline = useEffect ? pe.pipeline! : this.getPassthrough(targetFormat);
        const bindGroup = this.buildBindGroup(inputView, nearest, slot, useParams ? effect : null);
        this.drawPass(encoder, pipeline, bindGroup, target, geom);
    }

    private drawPass(
        encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, target: GPUTextureView,
        geom: { clearColor?: GPUColor; destRect?: PresentRect | null; viewport?: { width: number; height: number } },
    ): void {
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: target,
                ...(geom.clearColor
                    ? { loadOp: "clear" as const, clearValue: geom.clearColor, storeOp: "store" as const }
                    : { loadOp: "load" as const, storeOp: "store" as const }),
            }],
        });
        if (geom.destRect) {
            const r = geom.destRect;
            pass.setViewport(r.x, r.y, r.w, r.h, 0, 1);
            pass.setScissorRect(r.x, r.y, r.w, r.h);
        } else if (geom.viewport && geom.viewport.width > 0 && geom.viewport.height > 0) {
            pass.setViewport(0, 0, geom.viewport.width, geom.viewport.height, 0, 1);
            pass.setScissorRect(0, 0, geom.viewport.width, geom.viewport.height);
        }
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer!);
        pass.draw(6, 1, 0, 0);
        pass.end();
    }
}
