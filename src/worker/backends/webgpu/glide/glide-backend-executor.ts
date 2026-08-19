/// <reference types="@webgpu/types" />

import { WebGPUBackend } from "../webgpu-backend";
import { Legacy3DCommandType } from "../legacy3d/types";
import { Legacy3DExecutor } from "../legacy3d/executor";
import { GlidePipelineFactory } from "./glide-pipeline-factory";
import { GlideExecutorMetrics, GlideFrameInput, GlideGpuTexture, GlidePipelineConfig } from "./glide-types";
import { uploadToGPUTexture } from "../../../modules/ddraw/gpu-texture-utils";
import { Logger, LogCategory } from "../../../core/logger";
import { statsOverlay } from "../../../core/stats-overlay";

function unpackColorU32(color: number): { r: number; g: number; b: number; a: number } {
    const c = color >>> 0;
    return {
        r: ((c >>> 16) & 0xff) / 255,
        g: ((c >>> 8) & 0xff) / 255,
        b: (c & 0xff) / 255,
        a: ((c >>> 24) & 0xff) / 255,
    };
}

function normalizeDepth(depth: number): number {
    const d = depth >>> 0;
    if (d > 0xffff) {
        return Math.max(0, Math.min(1, d / 0xffffffff));
    }
    return Math.max(0, Math.min(1, d / 0xffff));
}

// Globals uniform layout (std140), bytes — must match `struct Globals` in WGSL:
//   resolution vec2f @0, alphaRef f32 @8, alphaTestFunc u32 @12,
//   constantColor vec4f @16, chromaKey vec4f @32,
//   texCoordScale vec2f @48, chromaEnabled u32 @56, fogMode u32 @60,
//   fogColor vec4f @64, colorCombine u32 @80, alphaCombine u32 @84,
//   gammaCorrection f32 @88, _pad0 u32 @92,
//   fogTable array<vec4f,16> @96 (entry k at 96 + 4*k).
const GLIDE_UNIFORM_FOGTABLE_OFFSET = 96;
const GLIDE_UNIFORM_SIZE = GLIDE_UNIFORM_FOGTABLE_OFFSET + 64 * 4; // 352

export class GlideBackendExecutor extends Legacy3DExecutor {
    private offscreenTexture: GPUTexture | null = null;
    private offscreenView: GPUTextureView | null = null;
    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    private offscreenSize: { width: number; height: number } | null = null;

    private vertexBuffer: GPUBuffer | null = null;
    private vertexBufferSize = 0;
    private uniformBuffer: GPUBuffer | null = null;
    private readonly samplers = new Map<number, GPUSampler>();

    private whiteTexture: GPUTexture | null = null;
    private whiteTextureView: GPUTextureView | null = null;

    private readonly textures = new Map<number, GlideGpuTexture>();
    private pipelineFactory: GlidePipelineFactory | null = null;
    private bindGroupCache = new WeakMap<GPURenderPipeline, Map<number, GPUBindGroup>>();
    private hasRenderedFrame = false;
    private vertexScratchBuffer: ArrayBuffer | null = null;
    private vertexScratchView: DataView | null = null;
    private lfbUploadScratch: Uint8Array | null = null;
    private textureUploadScratch: Uint8Array | null = null;
    // Globals uniform: see glide-shader-generator.ts `struct Globals` (352 bytes).
    private readonly uniformBytes = new ArrayBuffer(GLIDE_UNIFORM_SIZE);
    private readonly uniformView = new DataView(this.uniformBytes);

    private readonly metrics: GlideExecutorMetrics = {
        frames: 0,
        draws: 0,
        pipelineSets: 0,
        textureUploads: 0,
        bindGroupHits: 0,
        bindGroupMisses: 0,
    };

    constructor(private readonly backend: WebGPUBackend) {
        super("glide");
    }

    getMetrics(): GlideExecutorMetrics {
        return { ...this.metrics };
    }

    getPipelineCacheStats(): { hits: number; misses: number; size: number } {
        return this.pipelineFactory?.getStats() ?? { hits: 0, misses: 0, size: 0 };
    }

    uploadTexture(handle: number, width: number, height: number, format: number, rgba: Uint8Array): void {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!device || !queue || width <= 0 || height <= 0) return;

        const existing = this.textures.get(handle);
        if (existing) {
            existing.texture.destroy();
            this.textures.delete(handle);
        }

        const texture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        const requiredBytes = width * height * 4;
        const alignedRowBytes = ((width * 4 + 255) & ~255);
        const paddedBytes = height > 1 ? alignedRowBytes * height : requiredBytes;
        if (!this.textureUploadScratch || this.textureUploadScratch.length < paddedBytes) {
            this.textureUploadScratch = new Uint8Array(paddedBytes);
        }
        uploadToGPUTexture(
            queue,
            texture,
            rgba,
            width,
            height,
            this.textureUploadScratch,
            "rgba8unorm",
        );

        this.textures.set(handle, {
            handle,
            texture,
            view: texture.createView(),
            width,
            height,
            format,
        });

        this.bindGroupCache = new WeakMap();
        this.metrics.textureUploads++;
    }

    deleteTexture(handle: number): void {
        const existing = this.textures.get(handle);
        if (!existing) return;
        existing.texture.destroy();
        this.textures.delete(handle);
        this.bindGroupCache = new WeakMap();
    }

    clearTextures(): void {
        for (const tex of this.textures.values()) {
            tex.texture.destroy();
        }
        this.textures.clear();
        this.bindGroupCache = new WeakMap();
    }

    executeFrame(input: GlideFrameInput): void {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        const context = this.backend.getContext();

        if (!device || !queue || !context) return;
        if (input.width <= 0 || input.height <= 0) return;

        this.ensureTargets(device, input.width, input.height);
        this.ensureGlobals(device);

        if (!this.offscreenTexture || !this.offscreenView || !this.depthView || !this.uniformBuffer) {
            return;
        }

        const encoder = device.createCommandEncoder();
        const stream = input.stream;

        const hasLfbPixels = !!input.lfbPixels;
        let clearColor = unpackColorU32(input.clearColor);
        let clearDepth = normalizeDepth(input.clearDepth);
        let shouldClearColor = !this.hasRenderedFrame && !hasLfbPixels;
        let shouldClearDepth = true;

        if (input.lfbPixels) {
            // Presenter produces logical RGBA; offscreen is usually bgra8unorm (Windows
            // swapchain format). Route through uploadToGPUTexture so R/B are swizzled.
            const requiredScratch = input.width * input.height * 4;
            if (!this.lfbUploadScratch || this.lfbUploadScratch.length < requiredScratch) {
                this.lfbUploadScratch = new Uint8Array(requiredScratch);
            }
            uploadToGPUTexture(
                queue,
                this.offscreenTexture,
                input.lfbPixels,
                input.width,
                input.height,
                this.lfbUploadScratch,
                this.backend.getFormat() ?? "bgra8unorm",
            );
            shouldClearColor = false;
        }

        for (let i = 0; i < stream.commandTypes.length; i++) {
            if (stream.commandTypes[i] !== Legacy3DCommandType.Clear) continue;
            const clearCmd = stream.getClearCommand(i);
            if (!clearCmd) continue;
            clearColor = unpackColorU32(clearCmd.color);
            clearDepth = normalizeDepth(clearCmd.depth);
            if (!hasLfbPixels) {
                shouldClearColor = clearCmd.clearColor || shouldClearColor;
            }
            shouldClearDepth = clearCmd.clearDepth;
            if (hasLfbPixels && clearCmd.clearColor) {
                if (this.metrics.frames < 240 || ((this.metrics.frames & 63) === 0)) {
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `[Glide] executeFrame: ignoring color clear because LFB pixels are present (${input.width}x${input.height})`
                    );
                }
            }
            break;
        }

        const vertexCount = stream.getVertexCount();
        if (input.lfbPixels && vertexCount === 0 && shouldClearColor) {
            // In LFB-only video paths a queued clear is often intended to happen before CPU writes.
            // Clearing here would wipe the uploaded LFB frame and present black.
            Logger.warn(
                LogCategory.SYSTEM,
                `[Glide] executeFrame: suppressing clear over LFB-only frame (${input.width}x${input.height})`
            );
            shouldClearColor = false;
        }
        if (vertexCount > 0) {
            this.uploadVertices(queue, stream);
        }

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.offscreenView,
                    clearValue: clearColor,
                    loadOp: shouldClearColor ? "clear" : "load",
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: this.depthView,
                depthClearValue: clearDepth,
                depthLoadOp: shouldClearDepth ? "clear" : "load",
                depthStoreOp: "store",
            },
        });

        if (this.vertexBuffer && vertexCount > 0) {
            renderPass.setVertexBuffer(0, this.vertexBuffer, 0, vertexCount * 28);

            for (let i = 0; i < stream.commandTypes.length; i++) {
                if (stream.commandTypes[i] !== Legacy3DCommandType.Draw) continue;
                const draw = stream.getDrawCommand(i);
                if (!draw || draw.vertexCount <= 0) continue;

                const colorWriteMask =
                    (draw.colorMaskRgb ? (GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE) : 0) |
                    (draw.colorMaskAlpha ? GPUColorWrite.ALPHA : 0);
                const cfg: GlidePipelineConfig = {
                    topology: draw.topology,
                    useTexture: draw.useTexture,
                    blendEnabled: draw.blendEnabled,
                    blend: draw.blend,
                    depthTestEnabled: draw.depthTestEnabled,
                    depthWriteEnabled: draw.depthWriteEnabled,
                    depthFunction: draw.depthFunction,
                    cullMode: draw.cullMode,
                    colorWriteMask,
                };

                const pipeline = this.getPipeline(device, cfg);
                renderPass.setPipeline(pipeline);
                this.metrics.pipelineSets++;

                // Glide texel-center convention: for N-texel LOD, texel k's center sits at
                // sow = 4 * (256/N) * (k + 0.5) / 4 ... i.e. sow values at texel centers are
                // (k + 0.5) * (256/N). Normalizing by 1/256 makes every sow hit a texel center
                // cleanly. Games typically use sow=2..254 for 64x64 tiles (texels 0..63 center),
                // which with 1/255 scale would bleed past texel 63 and wrap into texel 0 at the
                // right edge, producing visible tile seams. 1/256 maps sow=254 → u=63.5/64
                // exactly at texel 63's center.
                const scaleX = 1 / 256;
                const scaleY = 1 / 256;

                this.writeUniforms(queue, {
                    width: input.width,
                    height: input.height,
                    alphaRef: draw.alphaRef,
                    alphaTestFunc: draw.alphaTestFunc,
                    constantColor: draw.constantColor,
                    chromaKey: input.chromaKey,
                    chromaEnabled: input.chromaKeyEnabled,
                    texCoordScaleX: scaleX,
                    texCoordScaleY: scaleY,
                    fogMode: draw.fogMode,
                    fogColor: draw.fogColor,
                    colorCombine: draw.colorCombine,
                    alphaCombine: draw.alphaCombine,
                    fogTable: input.fogTable,
                    gammaCorrection: input.gammaCorrection,
                });

                const bindGroup = this.createBindGroup(
                    device,
                    pipeline,
                    draw.textureHandle,
                    draw.useTexture,
                    draw.clampS,
                    draw.clampT,
                    draw.filterLinear,
                );
                renderPass.setBindGroup(0, bindGroup);
                renderPass.draw(draw.vertexCount, 1, draw.firstVertex, 0);
                this.metrics.draws++;
            }
        }

        renderPass.end();

        const targetView = context.getCurrentTexture().createView();
        this.backend.drawTexture(
            this.offscreenView,
            targetView,
            encoder,
            true,
            input.width,
            input.height,
            { r: 0, g: 0, b: 0, a: 1 },
        );

        if (input.videoOverlayCanvas) {
            this.backend.blit(input.videoOverlayCanvas, targetView, encoder);
        }

        // GDI overlay per the shared plan (input.gdiOverlayRects): undefined = whole overlay
        // (windowed); [] = nothing (game owns screen, no live dialog); [rects] = only live
        // modal dialog rects composited over the Glide frame.
        if (input.gdiOverlayCanvas) {
            const rects = input.gdiOverlayRects;
            if (rects === undefined) {
                this.backend.blit(input.gdiOverlayCanvas, targetView, encoder);
            } else if (rects.length) {
                this.backend.blitRects(input.gdiOverlayCanvas, targetView, encoder, rects);
            }
        }

        // Stats overlay
        if (statsOverlay.isEnabled()) {
            const statsCanvas = statsOverlay.getCanvas();
            if (statsCanvas) {
                if (statsOverlay.isDirty()) {
                    this.backend.updateStatsTexture(statsCanvas);
                    statsOverlay.clearDirty();
                }
                this.backend.renderStatsOverlay(targetView, encoder, input.width, input.height);
            }
        }

        queue.submit([encoder.finish()]);

        this.metrics.frames++;
        this.hasRenderedFrame = true;
    }

    async captureFrame(): Promise<Blob> {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!device || !queue || !this.offscreenTexture || !this.offscreenSize) {
            return new Blob();
        }

        const width = this.offscreenSize.width;
        const height = this.offscreenSize.height;
        const bytesPerPixel = 4;
        const rowBytes = width * bytesPerPixel;
        const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
        const readbackSize = paddedRowBytes * height;

        const readback = device.createBuffer({
            size: readbackSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: this.offscreenTexture },
            { buffer: readback, bytesPerRow: paddedRowBytes },
            { width, height, depthOrArrayLayers: 1 },
        );

        queue.submit([encoder.finish()]);
        await queue.onSubmittedWorkDone();

        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const pixels = new Uint8ClampedArray(width * height * bytesPerPixel);
        // The offscreen carries the canvas's preferred format (bgra8unorm on most desktops)
        // while ImageData is always RGBA — copying rows straight through hands back a
        // red/blue-swapped frame that still looks plausible. Same swizzle the screen route
        // (WebGPUBackend.captureScreen) applies; the two must not disagree about colour.
        const swapRB = (this.backend.getFormat() ?? "bgra8unorm") === "bgra8unorm";
        for (let y = 0; y < height; y++) {
            const src = y * paddedRowBytes;
            const dst = y * rowBytes;
            if (!swapRB) {
                pixels.set(mapped.subarray(src, src + rowBytes), dst);
                continue;
            }
            for (let x = 0, s = src, d = dst; x < width; x++, s += 4, d += 4) {
                pixels[d] = mapped[s + 2]!;
                pixels[d + 1] = mapped[s + 1]!;
                pixels[d + 2] = mapped[s]!;
                pixels[d + 3] = mapped[s + 3]!;
            }
        }
        readback.unmap();
        readback.destroy();

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return new Blob();
        }
        ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
        return canvas.convertToBlob({ type: "image/png" });
    }

    destroy(): void {
        this.clearTextures();

        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
            this.vertexBuffer = null;
            this.vertexBufferSize = 0;
        }

        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
            this.uniformBuffer = null;
        }

        if (this.whiteTexture) {
            this.whiteTexture.destroy();
            this.whiteTexture = null;
            this.whiteTextureView = null;
        }

        if (this.offscreenTexture) {
            this.offscreenTexture.destroy();
            this.offscreenTexture = null;
            this.offscreenView = null;
        }

        if (this.depthTexture) {
            this.depthTexture.destroy();
            this.depthTexture = null;
            this.depthView = null;
        }

        this.samplers.clear();

        this.offscreenSize = null;
        this.pipelineFactory?.clear();
        this.pipelineFactory = null;
        this.bindGroupCache = new WeakMap();
    }

    private ensureTargets(device: GPUDevice, width: number, height: number): void {
        const sameSize = this.offscreenSize && this.offscreenSize.width === width && this.offscreenSize.height === height;
        if (sameSize && this.offscreenTexture && this.depthTexture) {
            return;
        }

        if (this.offscreenTexture) this.offscreenTexture.destroy();
        if (this.depthTexture) this.depthTexture.destroy();

        this.offscreenTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: this.backend.getFormat() ?? "bgra8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.offscreenView = this.offscreenTexture.createView();

        this.depthTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.offscreenSize = { width, height };
    }

    private ensureGlobals(device: GPUDevice): void {
        if (!this.uniformBuffer) {
            this.uniformBuffer = device.createBuffer({
                size: GLIDE_UNIFORM_SIZE,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }

        // Ensure default sampler (clamp, clamp, linear) exists; other variants created lazily.
        this.getSampler(device, true, true, true);

        if (!this.whiteTexture) {
            this.whiteTexture = device.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.backend.getQueue()?.writeTexture(
                { texture: this.whiteTexture },
                new Uint8Array([255, 255, 255, 255]),
                { bytesPerRow: 4 },
                { width: 1, height: 1, depthOrArrayLayers: 1 },
            );
            this.whiteTextureView = this.whiteTexture.createView();
        }
    }

    private getPipeline(device: GPUDevice, config: GlidePipelineConfig): GPURenderPipeline {
        const format = this.backend.getFormat() ?? "bgra8unorm";
        if (!this.pipelineFactory) {
            this.pipelineFactory = new GlidePipelineFactory(device, format);
        }
        return this.pipelineFactory.getOrCreate(config);
    }

    private uploadVertices(queue: GPUQueue, stream: GlideFrameInput["stream"]): void {
        const count = stream.getVertexCount();
        if (count <= 0) return;

        const required = count * 28;
        const device = this.backend.getDevice();
        if (!device) return;

        if (!this.vertexBuffer || this.vertexBufferSize < required) {
            if (this.vertexBuffer) {
                this.vertexBuffer.destroy();
            }
            this.vertexBufferSize = Math.max(required, 64 * 1024);
            this.vertexBuffer = device.createBuffer({
                size: this.vertexBufferSize,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }

        if (!this.vertexScratchBuffer || this.vertexScratchBuffer.byteLength < required) {
            this.vertexScratchBuffer = new ArrayBuffer(required);
            this.vertexScratchView = new DataView(this.vertexScratchBuffer);
        }
        const packed = this.vertexScratchBuffer;
        const view = this.vertexScratchView!;
        for (let i = 0; i < count; i++) {
            const base = i * 28;
            view.setFloat32(base + 0, stream.vertexX[i] ?? 0, true);
            view.setFloat32(base + 4, stream.vertexY[i] ?? 0, true);
            view.setFloat32(base + 8, stream.vertexZ[i] ?? 0, true);
            view.setFloat32(base + 12, stream.vertexU[i] ?? 0, true);
            view.setFloat32(base + 16, stream.vertexV[i] ?? 0, true);
            view.setFloat32(base + 20, stream.vertexQ[i] ?? 1, true);
            view.setUint32(base + 24, stream.vertexColor[i] ?? 0xffffffff, true);
        }

        queue.writeBuffer(this.vertexBuffer, 0, packed, 0, required);
    }

    private writeUniforms(
        queue: GPUQueue,
        args: {
            width: number;
            height: number;
            alphaRef: number;
            alphaTestFunc: number;
            constantColor: number;
            chromaKey: number;
            chromaEnabled: boolean;
            texCoordScaleX: number;
            texCoordScaleY: number;
            fogMode: number;
            fogColor: number;
            colorCombine: number;
            alphaCombine: number;
            fogTable: Uint8Array;
            gammaCorrection: number;
        },
    ): void {
        if (!this.uniformBuffer) return;

        const c = unpackColorU32(args.constantColor);
        const k = unpackColorU32(args.chromaKey);
        const fog = unpackColorU32(args.fogColor);
        const v = this.uniformView;

        v.setFloat32(0, args.width, true);
        v.setFloat32(4, args.height, true);
        v.setFloat32(8, Math.max(0, Math.min(255, args.alphaRef >>> 0)), true);
        v.setUint32(12, args.alphaTestFunc >>> 0, true);
        v.setFloat32(16, c.r, true);
        v.setFloat32(20, c.g, true);
        v.setFloat32(24, c.b, true);
        v.setFloat32(28, c.a, true);
        v.setFloat32(32, k.r, true);
        v.setFloat32(36, k.g, true);
        v.setFloat32(40, k.b, true);
        v.setFloat32(44, k.a, true);
        v.setFloat32(48, args.texCoordScaleX, true);
        v.setFloat32(52, args.texCoordScaleY, true);
        v.setUint32(56, args.chromaEnabled ? 1 : 0, true);
        v.setUint32(60, args.fogMode >>> 0, true);
        v.setFloat32(64, fog.r, true);
        v.setFloat32(68, fog.g, true);
        v.setFloat32(72, fog.b, true);
        v.setFloat32(76, fog.a, true);
        v.setUint32(80, args.colorCombine >>> 0, true);
        v.setUint32(84, args.alphaCombine >>> 0, true);
        const gamma = Number.isFinite(args.gammaCorrection) ? Math.max(0.01, args.gammaCorrection) : 1.0;
        v.setFloat32(88, gamma, true);
        v.setUint32(92, 0, true);

        const table = args.fogTable;
        for (let i = 0; i < 64; i++) {
            v.setFloat32(GLIDE_UNIFORM_FOGTABLE_OFFSET + i * 4, (table[i] ?? 0) / 255, true);
        }

        queue.writeBuffer(this.uniformBuffer, 0, this.uniformBytes, 0, GLIDE_UNIFORM_SIZE);
    }

    private getSampler(device: GPUDevice, clampS: boolean, clampT: boolean, linear: boolean): GPUSampler {
        const key = (clampS ? 1 : 0) | (clampT ? 2 : 0) | (linear ? 4 : 0);
        let sampler = this.samplers.get(key);
        if (sampler) return sampler;
        const filter: GPUFilterMode = linear ? "linear" : "nearest";
        sampler = device.createSampler({
            magFilter: filter,
            minFilter: filter,
            mipmapFilter: filter,
            addressModeU: clampS ? "clamp-to-edge" : "repeat",
            addressModeV: clampT ? "clamp-to-edge" : "repeat",
        });
        this.samplers.set(key, sampler);
        return sampler;
    }

    private createBindGroup(
        device: GPUDevice,
        pipeline: GPURenderPipeline,
        textureHandle: number,
        useTexture: boolean,
        clampS: boolean,
        clampT: boolean,
        filterLinear: boolean,
    ): GPUBindGroup {
        if (!this.uniformBuffer) {
            throw new Error("GlideBackendExecutor: uniform buffer is not initialized");
        }

        let perPipeline = this.bindGroupCache.get(pipeline);
        if (!perPipeline) {
            perPipeline = new Map<number, GPUBindGroup>();
            this.bindGroupCache.set(pipeline, perPipeline);
        }

        const samplerKey = (clampS ? 1 : 0) | (clampT ? 2 : 0) | (filterLinear ? 4 : 0);
        let cacheKey: number;
        if (!useTexture) {
            cacheKey = -1;
        } else {
            const textureKey = this.textures.has(textureHandle) ? textureHandle : -2;
            // Pack: high bits = textureKey (+2 to avoid -2 collision), low 3 bits = samplerKey.
            cacheKey = ((textureKey + 2) << 3) | samplerKey;
        }

        const cached = perPipeline.get(cacheKey);
        if (cached) {
            this.metrics.bindGroupHits++;
            return cached;
        }
        this.metrics.bindGroupMisses++;

        if (!useTexture) {
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffer } },
                ],
            });
            perPipeline.set(cacheKey, bindGroup);
            return bindGroup;
        }

        const tex = this.textures.get(textureHandle);
        const view = tex?.view ?? this.whiteTextureView;
        const sampler = this.getSampler(device, clampS, clampT, filterLinear);
        if (!view) {
            throw new Error("GlideBackendExecutor: texture resources are not initialized");
        }

        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: sampler },
                { binding: 2, resource: view },
            ],
        });
        perPipeline.set(cacheKey, bindGroup);
        return bindGroup;
    }
}
