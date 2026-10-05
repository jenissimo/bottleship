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
                    buffer: { type: "uniform" },
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

        // Create uniform buffer
        this.uniformBuffer = this.device.createBuffer({
            size: UNIFORM_SIZE,
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

        // Calculate normalized UV coordinates for source texture sampling
        const srcU0 = config.srcRect.left / config.srcWidth;
        const srcV0 = config.srcRect.top / config.srcHeight;
        const srcU1 = config.srcRect.right / config.srcWidth;
        const srcV1 = config.srcRect.bottom / config.srcHeight;

        // Epsilon for colorkey comparison (1/255 for quantization tolerance)
        const epsilon = 1.0 / 255.0;

        // Write uniform data
        const enableColorKey = config.enableColorKey !== false;
        const uniformData = new Float32Array([
            // srcRect (UV coordinates)
            srcU0, srcV0, srcU1, srcV1,
            // colorKeyLow (r, g, b, epsilon)
            config.colorKeyLow.r, config.colorKeyLow.g, config.colorKeyLow.b, epsilon,
            // colorKeyHigh (r, g, b, enableFlag)
            config.colorKeyHigh.r, config.colorKeyHigh.g, config.colorKeyHigh.b, enableColorKey ? 1 : 0,
        ]);
        this.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

        // Create bind group for this blit
        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: config.srcView },
                { binding: 2, resource: config.filter === "linear" ? this.linearSampler : this.pointSampler },
            ],
        });

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
        renderPass.setBindGroup(0, bindGroup);
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
        this.shaderModule = null;
        this.bindGroupLayout = null;
        this.pipelineLayout = null;
        this.pipelines.clear();

        Logger.log(LogCategory.DDRAW, `ColorKeyBlitPipeline: Destroyed`);
    }
}
