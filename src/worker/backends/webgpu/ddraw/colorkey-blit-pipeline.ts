/**
 * Colorkey Blit Pipeline for DirectDraw WebGPU backend.
 * Handles GPU-accelerated blitting with colorkey transparency using a render pass
 * with a fragment shader that discards colorkey-matching pixels.
 *
 * This solves the problem of copyTextureToTexture not supporting per-pixel transparency,
 * which caused colorkey blits (DDBLT_KEYSRC) to fall back to slow CPU path.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { generateColorKeyBlitShaderCode } from "./shader-generator";

/**
 * Configuration for a colorkey blit operation
 */
export interface ColorKeyBlitConfig {
    /** Source texture view */
    srcView: GPUTextureView;
    /** Source texture dimensions */
    srcWidth: number;
    srcHeight: number;
    /** Destination texture view */
    dstView: GPUTextureView;
    /** Destination texture format */
    dstFormat: GPUTextureFormat;
    /** Destination texture dimensions */
    dstWidth: number;
    dstHeight: number;
    /** Source rectangle (in pixels) */
    srcRect: { left: number; top: number; right: number; bottom: number };
    /** Destination rectangle (in pixels) */
    dstRect: { left: number; top: number; right: number; bottom: number };
    /** Colorkey low value (normalized RGBA, 0-1) */
    colorKeyLow: { r: number; g: number; b: number; a: number };
    /** Colorkey high value (normalized RGBA, 0-1) */
    colorKeyHigh: { r: number; g: number; b: number; a: number };
    /** Enable colorkey discard (default true) */
    enableColorKey?: boolean;
    /** Texture filtering used while scaling. DirectDraw defaults to point sampling. */
    filter?: GPUFilterMode;
}

/**
 * Uniform buffer layout (48 bytes):
 * - vec4f srcRect (normalized 0-1): left, top, right, bottom (16 bytes)
 * - vec4f colorKeyLow: r, g, b, epsilon (16 bytes)
 * - vec4f colorKeyHigh: r, g, b, unused (16 bytes)
 */
const UNIFORM_SIZE = 48;
const UNIFORM_FLOATS = UNIFORM_SIZE / 4;

/**
 * Blits between two submits each read their own slot of the uniform ring, addressed by a
 * dynamic offset. A slot is written again RING_SLOTS blits later, so no more than that many
 * blits may sit in unsubmitted encoders at once: the caller asks hasFreeSlot() before a
 * blit, submits when it is false, and reports every submit through slotsSubmitted().
 */
const RING_SLOTS = 256;

/** Epsilon for colorkey comparison (1/255 for quantization tolerance). */
const COLOR_KEY_EPSILON = 1.0 / 255.0;

interface CachedBindGroups {
    point: GPUBindGroup | null;
    linear: GPUBindGroup | null;
}

/**
 * Colorkey blit pipeline manager.
 * Caches pipelines by destination format and provides efficient GPU blitting with colorkey transparency.
 */
export class ColorKeyBlitPipeline {
    private device: GPUDevice;
    private queue: GPUQueue;

    /** Pipeline cache by destination format */
    private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

    /** Shared resources */
    private shaderModule: GPUShaderModule | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private pipelineLayout: GPUPipelineLayout | null = null;
    private pointSampler: GPUSampler | null = null;
    private linearSampler: GPUSampler | null = null;
    private uniformBuffer: GPUBuffer | null = null;
    private vertexBuffer: GPUBuffer | null = null;

    /** Byte distance between two ring slots: UNIFORM_SIZE rounded up to the device's
     *  uniform offset alignment. */
    private slotStride = 256;
    private nextSlot = 0;
    /** Slots written since the caller's last submit. */
    private unsubmittedSlots = 0;
    /** One blit's uniforms; written to the ring slot and reused by the next blit. */
    private readonly uniformScratch = new Float32Array(UNIFORM_FLOATS);
    private readonly dynamicOffset = [0];
    /** Bind groups by source view. They hold the view, so the map must not: an entry
     *  goes when the surface's view is replaced or destroyed. */
    private bindGroups = new WeakMap<GPUTextureView, CachedBindGroups>();

    constructor(device: GPUDevice, queue: GPUQueue) {
        this.device = device;
        this.queue = queue;
        this.initialize();
    }

    private initialize(): void {
        // Create shader module
        const shaderCode = generateColorKeyBlitShaderCode();
        this.shaderModule = this.device.createShaderModule({ code: shaderCode });

        // Create bind group layout
        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                // binding 0: uniform buffer
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_SIZE },
                },
                // binding 1: source texture
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" },
                },
                // binding 2: sampler
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: "filtering" },
                },
            ],
        });

        // Create pipeline layout
        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        // Create nearest-neighbor sampler (pixel-perfect blit without interpolation)
        this.pointSampler = this.device.createSampler({
            magFilter: "nearest",
            minFilter: "nearest",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });
        this.linearSampler = this.device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        // Uniform ring: one slot per blit, so blits recorded into the same encoder do not
        // share (and overwrite) their parameters.
        const alignment = Math.max(1, this.device.limits?.minUniformBufferOffsetAlignment ?? 256);
        this.slotStride = Math.ceil(UNIFORM_SIZE / alignment) * alignment;
        this.uniformBuffer = this.device.createBuffer({
            size: this.slotStride * RING_SLOTS,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create vertex buffer for full-screen quad (4 vertices, 2 floats each)
        // Vertices: (-1,-1), (1,-1), (-1,1), (1,1) for triangle strip
        const vertices = new Float32Array([
            -1.0, -1.0,
             1.0, -1.0,
            -1.0,  1.0,
             1.0,  1.0,
        ]);
        this.vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.queue.writeBuffer(this.vertexBuffer, 0, vertices);

        Logger.log(LogCategory.DDRAW, `ColorKeyBlitPipeline: Initialized`);
    }

    /**
     * Get or create a render pipeline for the specified destination format
     */
    private getPipelineForFormat(format: GPUTextureFormat): GPURenderPipeline {
        let pipeline = this.pipelines.get(format);
        if (pipeline) return pipeline;

        pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout!,
            vertex: {
                module: this.shaderModule!,
                entryPoint: "vs_main",
                buffers: [
                    {
                        arrayStride: 8, // 2 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x2" },
                        ],
                    },
                ],
            },
            fragment: {
                module: this.shaderModule!,
                entryPoint: "fs_main",
                targets: [
                    {
                        format,
                        // No blending - we're doing discard for transparency
                        // Write directly to destination
                    },
                ],
            },
            primitive: {
                topology: "triangle-strip",
                stripIndexFormat: undefined,
            },
        });

        this.pipelines.set(format, pipeline);
        Logger.log(LogCategory.DDRAW, `ColorKeyBlitPipeline: Created pipeline for format ${format}`);
        return pipeline;
    }

    /**
     * Perform a colorkey blit operation.
     *
     * @param encoder Command encoder to record commands into
     * @param config Blit configuration
     */
    blit(encoder: GPUCommandEncoder, config: ColorKeyBlitConfig): void {
        if (!this.uniformBuffer || !this.vertexBuffer || !this.pointSampler ||
            !this.linearSampler || !this.bindGroupLayout) {
            Logger.warn(LogCategory.DDRAW, `ColorKeyBlitPipeline: Not initialized`);
            return;
        }

        const pipeline = this.getPipelineForFormat(config.dstFormat);

        // This blit's uniforms, in its own ring slot.
        const u = this.uniformScratch;
        // srcRect (UV coordinates)
        u[0] = config.srcRect.left / config.srcWidth;
        u[1] = config.srcRect.top / config.srcHeight;
        u[2] = config.srcRect.right / config.srcWidth;
        u[3] = config.srcRect.bottom / config.srcHeight;
        // colorKeyLow (r, g, b, epsilon)
        u[4] = config.colorKeyLow.r; u[5] = config.colorKeyLow.g; u[6] = config.colorKeyLow.b;
        u[7] = COLOR_KEY_EPSILON;
        // colorKeyHigh (r, g, b, enableFlag)
        u[8] = config.colorKeyHigh.r; u[9] = config.colorKeyHigh.g; u[10] = config.colorKeyHigh.b;
        u[11] = config.enableColorKey !== false ? 1 : 0;
        const offset = this.nextSlot * this.slotStride;
        this.nextSlot = (this.nextSlot + 1) % RING_SLOTS;
        this.unsubmittedSlots++;
        this.queue.writeBuffer(this.uniformBuffer, offset, u);
        this.dynamicOffset[0] = offset;

        const bindGroup = this.bindGroupFor(config.srcView, config.filter === "linear");

        // Begin render pass with loadOp: "load" to preserve existing destination pixels
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: config.dstView,
                    loadOp: "load", // preserve destination pixels under transparent areas
                    storeOp: "store",
                },
            ],
        });

        renderPass.setPipeline(pipeline);
        renderPass.setBindGroup(0, bindGroup, this.dynamicOffset);
        renderPass.setVertexBuffer(0, this.vertexBuffer);

        // Set viewport and scissor to destination rect for correct clipping
        const rectWidth = config.dstRect.right - config.dstRect.left;
        const rectHeight = config.dstRect.bottom - config.dstRect.top;
        renderPass.setViewport(
            config.dstRect.left,
            config.dstRect.top,
            rectWidth,
            rectHeight,
            0,
            1
        );
        renderPass.setScissorRect(
            config.dstRect.left,
            config.dstRect.top,
            rectWidth,
            rectHeight
        );

        renderPass.draw(4, 1, 0, 0);
        renderPass.end();

        Logger.verbose(LogCategory.DDRAW,
            `ColorKeyBlitPipeline: ${config.srcWidth}x${config.srcHeight} -> ${config.dstWidth}x${config.dstHeight} ` +
            `colorkey=RGB[${config.colorKeyLow.r.toFixed(3)},${config.colorKeyLow.g.toFixed(3)},${config.colorKeyLow.b.toFixed(3)}]`
        );
    }

    /** False when the next blit would overwrite a slot an unsubmitted blit still reads. */
    hasFreeSlot(): boolean {
        return this.unsubmittedSlots < RING_SLOTS;
    }

    /** Every blit recorded so far has been submitted. */
    slotsSubmitted(): void {
        this.unsubmittedSlots = 0;
    }

    private bindGroupFor(srcView: GPUTextureView, linear: boolean): GPUBindGroup {
        let cached = this.bindGroups.get(srcView);
        if (!cached) {
            cached = { point: null, linear: null };
            this.bindGroups.set(srcView, cached);
        }
        const existing = linear ? cached.linear : cached.point;
        if (existing) return existing;
        const created = this.device.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer!, size: UNIFORM_SIZE } },
                { binding: 1, resource: srcView },
                { binding: 2, resource: linear ? this.linearSampler! : this.pointSampler! },
            ],
        });
        if (linear) cached.linear = created; else cached.point = created;
        return created;
    }

    /**
     * Release GPU resources
     */
    destroy(): void {
        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
            this.uniformBuffer = null;
        }
        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
            this.vertexBuffer = null;
        }
        this.pointSampler = null;
        this.linearSampler = null;
        // The cached bind groups reference the ring that was just destroyed.
        this.bindGroups = new WeakMap();
        this.shaderModule = null;
        this.bindGroupLayout = null;
        this.pipelineLayout = null;
        this.pipelines.clear();

        Logger.log(LogCategory.DDRAW, `ColorKeyBlitPipeline: Destroyed`);
    }
}
