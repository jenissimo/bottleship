/**
 * Clear pipeline for DirectDraw WebGPU backend.
 * Handles partial and full clears with optional scissor rects.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { generateClearShaderCode } from "./shader-generator";
import {
    D3DCLEAR_TARGET,
    D3DCLEAR_ZBUFFER,
    D3DCLEAR_STENCIL,
} from "../../../modules/ddraw/constants";
import { ClearConfig } from "./types";
import { normalizePortableWebGpuSampleCount } from "../shared/msaa-policy";

/** Color pipelines: partial clear with color attachment (D3DCLEAR_TARGET). Format-specific. */
type ClearPipelineSet = {
    noDepth: GPURenderPipeline;
    depthOnly: GPURenderPipeline;
    stencilOnly: GPURenderPipeline;
    depthAndStencil: GPURenderPipeline;
};

/** Depth/stencil-only pipelines: no color target. Used when partial clear has only Z/stencil. */
type DepthOnlyPipelineSet = {
    depthOnly: GPURenderPipeline;
    stencilOnly: GPURenderPipeline;
    depthAndStencil: GPURenderPipeline;
};

const BLEND_CONSTANT_CLEAR = {
    color: { operation: "add" as const, srcFactor: "constant" as const, dstFactor: "zero" as const },
    alpha: { operation: "add" as const, srcFactor: "constant" as const, dstFactor: "zero" as const },
};

/**
 * Manages clear pipelines and operations.
 * Pipelines are cached per color format (rgba8unorm, bgra8unorm, etc.) to support
 * SwapChain and 16-bit surfaces. Depth/stencil uses depth24plus-stencil8.
 */
export class ClearPipeline {
    private device: GPUDevice;
    private queue: GPUQueue;
    private depthFormat: GPUTextureFormat;
    // MSAA sample count (1 = off). Clear pipelines bake this into multisample.count so they
    // match the MSAA color/depth attachments the executor supplies under quality.msaa>1.
    private sampleCount = 1;

    private pipelines = new Map<GPUTextureFormat, ClearPipelineSet>();
    private depthOnlyPipelines: DepthOnlyPipelineSet | null = null;
    private clearVertexBuffer: GPUBuffer | null = null;
    private depthUniformBuffer: GPUBuffer | null = null;
    private depthBindGroupLayout: GPUBindGroupLayout | null = null;
    private depthBindGroup: GPUBindGroup | null = null;
    private shaderModule: GPUShaderModule | null = null;

    constructor(
        device: GPUDevice,
        queue: GPUQueue,
        depthFormat: GPUTextureFormat = "depth24plus-stencil8"
    ) {
        this.device = device;
        this.queue = queue;
        this.depthFormat = depthFormat;
        this.initialize();
    }

    private initialize(): void {
        const vertices = new Float32Array([
            -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0,
        ]);
        this.clearVertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.queue.writeBuffer(this.clearVertexBuffer, 0, vertices);

        this.depthUniformBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.depthBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            ],
        });
        this.depthBindGroup = this.device.createBindGroup({
            layout: this.depthBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.depthUniformBuffer } }],
        });
        const shaderCode = generateClearShaderCode();
        this.shaderModule = this.device.createShaderModule({ code: shaderCode });
    }

    /**
     * Set the MSAA sample count (from quality.msaa). Clamps to {1,4}. On change, all cached
     * clear pipelines are dropped (they baked the old sampleCount). Returns true if it changed.
     * Only take effect once the executor also supplies MSAA color/depth attachments; sampleCount===1
     * keeps the pre-MSAA single-sample pipelines.
     */
    setSampleCount(n: number): boolean {
        const clamped = normalizePortableWebGpuSampleCount(n);
        if (clamped === this.sampleCount) return false;
        this.sampleCount = clamped;
        this.pipelines.clear();
        this.depthOnlyPipelines = null;
        return true;
    }

    getSampleCount(): number {
        return this.sampleCount;
    }

    private getPipelinesForFormat(format: GPUTextureFormat): ClearPipelineSet {
        let set = this.pipelines.get(format);
        if (!set) {
            set = this.createPipelinesForFormat(format);
            this.pipelines.set(format, set);
        }
        return set;
    }

    private createPipelinesForFormat(format: GPUTextureFormat): ClearPipelineSet {
        const sm = this.shaderModule!;
        const layoutWithDepth = this.device.createPipelineLayout({
            bindGroupLayouts: [this.depthBindGroupLayout!],
        });
        const vertexDesc = {
            module: sm,
            entryPoint: "vs_main" as const,
            buffers: [
                {
                    arrayStride: 8,
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" as const }],
                },
            ],
        };
        const targets = [{ format, blend: BLEND_CONSTANT_CLEAR }];
        const primitive = { topology: "triangle-strip" as const };

        const depthStencilBase = {
            format: this.depthFormat,
            depthCompare: "always" as const,
        };

        const noDepth = this.device.createRenderPipeline({
            layout: layoutWithDepth,
            vertex: vertexDesc,
            multisample: { count: this.sampleCount },
            fragment: { module: sm, entryPoint: "fs_main", targets: [...targets] },
            primitive,
        });

        const depthOnly = this.device.createRenderPipeline({
            layout: layoutWithDepth,
            vertex: vertexDesc,
            multisample: { count: this.sampleCount },
            fragment: { module: sm, entryPoint: "fs_main", targets: [...targets] },
            primitive,
            depthStencil: {
                ...depthStencilBase,
                depthWriteEnabled: true,
                stencilFront: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilBack: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilReadMask: 0xff,
                stencilWriteMask: 0,
            },
        });

        const stencilOps = {
            compare: "always" as const,
            failOp: "keep" as const,
            depthFailOp: "keep" as const,
            passOp: "replace" as const,
        };
        const stencilOnly = this.device.createRenderPipeline({
            layout: layoutWithDepth,
            vertex: vertexDesc,
            multisample: { count: this.sampleCount },
            fragment: { module: sm, entryPoint: "fs_main", targets: [...targets] },
            primitive,
            depthStencil: {
                ...depthStencilBase,
                depthWriteEnabled: false,
                stencilFront: stencilOps,
                stencilBack: stencilOps,
                stencilReadMask: 0xff,
                stencilWriteMask: 0xff,
            },
        });

        const depthAndStencil = this.device.createRenderPipeline({
            layout: layoutWithDepth,
            vertex: vertexDesc,
            multisample: { count: this.sampleCount },
            fragment: { module: sm, entryPoint: "fs_main", targets: [...targets] },
            primitive,
            depthStencil: {
                ...depthStencilBase,
                depthWriteEnabled: true,
                stencilFront: stencilOps,
                stencilBack: stencilOps,
                stencilReadMask: 0xff,
                stencilWriteMask: 0xff,
            },
        });

        return { noDepth, depthOnly, stencilOnly, depthAndStencil };
    }

    private getDepthOnlyPipelines(): DepthOnlyPipelineSet {
        if (!this.depthOnlyPipelines) {
            this.depthOnlyPipelines = this.createDepthOnlyPipelines();
        }
        return this.depthOnlyPipelines;
    }

    private createDepthOnlyPipelines(): DepthOnlyPipelineSet {
        const sm = this.shaderModule!;
        const layout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.depthBindGroupLayout!],
        });
        const vertexDesc = {
            module: sm,
            entryPoint: "vs_main" as const,
            buffers: [
                { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" as const }] },
            ],
        };
        const depthStencilBase = {
            format: this.depthFormat,
            depthCompare: "always" as const,
        };
        const stencilOps = {
            compare: "always" as const,
            failOp: "keep" as const,
            depthFailOp: "keep" as const,
            passOp: "replace" as const,
        };
        const fragmentDepthOnly = { module: sm, entryPoint: "fs_main_depth_only" as const, targets: [] as GPUColorTargetState[] };

        const depthOnly = this.device.createRenderPipeline({
            layout,
            vertex: vertexDesc,
            multisample: { count: this.sampleCount },
            fragment: fragmentDepthOnly,
            primitive: { topology: "triangle-strip" as const },
            depthStencil: {
                ...depthStencilBase,
                depthWriteEnabled: true,
                stencilFront: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilBack: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilReadMask: 0xff,
                stencilWriteMask: 0,
            },
        });

        const stencilOnly = this.device.createRenderPipeline({
            layout,
            vertex: vertexDesc,
            multisample: { count: this.sampleCount },
            fragment: fragmentDepthOnly,
            primitive: { topology: "triangle-strip" as const },
            depthStencil: {
                ...depthStencilBase,
                depthWriteEnabled: false,
                stencilFront: stencilOps,
                stencilBack: stencilOps,
                stencilReadMask: 0xff,
                stencilWriteMask: 0xff,
            },
        });

        const depthAndStencil = this.device.createRenderPipeline({
            layout,
            vertex: vertexDesc,
            multisample: { count: this.sampleCount },
            fragment: fragmentDepthOnly,
            primitive: { topology: "triangle-strip" as const },
            depthStencil: {
                ...depthStencilBase,
                depthWriteEnabled: true,
                stencilFront: stencilOps,
                stencilBack: stencilOps,
                stencilReadMask: 0xff,
                stencilWriteMask: 0xff,
            },
        });

        return { depthOnly, stencilOnly, depthAndStencil };
    }

    private getPipeline(
        format: GPUTextureFormat,
        hasColor: boolean,
        needsDepth: boolean,
        needsStencil: boolean
    ): GPURenderPipeline {
        if (hasColor) {
            const set = this.getPipelinesForFormat(format);
            if (!needsDepth && !needsStencil) return set.noDepth;
            if (needsDepth && !needsStencil) return set.depthOnly;
            if (!needsDepth && needsStencil) return set.stencilOnly;
            return set.depthAndStencil;
        }
        const set = this.getDepthOnlyPipelines();
        if (needsDepth && !needsStencil) return set.depthOnly;
        if (!needsDepth && needsStencil) return set.stencilOnly;
        return set.depthAndStencil;
    }

    /**
     * Parse ARGB color to GPUColor
     * Preserve alpha=0 for valid D3D7 clear operations (render-to-texture, masks, etc.)
     */
    parseColor(color: number): GPUColor {
        const r = ((color >> 16) & 0xff) / 255;
        const g = ((color >> 8) & 0xff) / 255;
        const b = (color & 0xff) / 255;
        const a = ((color >> 24) & 0xff) / 255;
        return { r, g, b, a };
    }

    /**
     * Check if clear requires partial clear (viewport or rects specified)
     */
    private isPartialClear(
        config: ClearConfig,
        targetWidth: number,
        targetHeight: number
    ): boolean {
        if (config.rects && config.rects.length > 0) return true;
        if (
            config.viewport &&
            (config.viewport.x !== 0 ||
                config.viewport.y !== 0 ||
                config.viewport.width !== targetWidth ||
                config.viewport.height !== targetHeight)
        ) {
            return true;
        }
        return false;
    }

    /**
     * Perform a full surface clear using loadOp: "clear"
     * This is the fast path for clearing entire surfaces
     */
    performFullClear(
        encoder: GPUCommandEncoder,
        targetView: GPUTextureView,
        depthView: GPUTextureView | null,
        config: ClearConfig,
        // MSAA on: render the clear into this multisample color view and resolve into targetView
        // (the single-sample surface). Absent → clear targetView directly (byte-identical pre-MSAA).
        msaaColorView?: GPUTextureView
    ): void {
        const clearColor = this.parseColor(config.color);

        const colorAttachments: GPURenderPassColorAttachment[] = [];
        if (config.flags & D3DCLEAR_TARGET) {
            colorAttachments.push(
                msaaColorView
                    ? {
                        view: msaaColorView,
                        resolveTarget: targetView,
                        clearValue: clearColor,
                        loadOp: "clear",
                        storeOp: "store",
                    }
                    : {
                        view: targetView,
                        clearValue: clearColor,
                        loadOp: "clear",
                        storeOp: "store",
                    }
            );
        }

        const needsDepth = (config.flags & D3DCLEAR_ZBUFFER) !== 0;
        const needsStencil = (config.flags & D3DCLEAR_STENCIL) !== 0;
        const useDepthStencil = (needsDepth || needsStencil) && depthView;
        let depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
        if (useDepthStencil) {
            depthStencilAttachment = {
                view: depthView,
                depthLoadOp: needsDepth ? "clear" : "load",
                depthStoreOp: "store",
                stencilLoadOp: needsStencil ? "clear" : "load",
                stencilStoreOp: "store",
            };
            if (needsDepth) {
                const depthValue = (config.depth !== undefined && !isNaN(config.depth)) 
                    ? config.depth 
                    : 1.0;
                depthStencilAttachment.depthClearValue = depthValue;
            }
            if (needsStencil) depthStencilAttachment.stencilClearValue = config.stencil ?? 0;
        }

        if (colorAttachments.length > 0 || depthStencilAttachment) {
            const renderPass = encoder.beginRenderPass({
                colorAttachments,
                depthStencilAttachment,
            });
            renderPass.end();
        }
    }

    /**
     * Perform a partial clear using draw calls with scissor rects
     *
     * @param targetFormat - Actual format of targetView
     */
    performPartialClear(
        encoder: GPUCommandEncoder,
        targetView: GPUTextureView,
        targetFormat: GPUTextureFormat,
        targetWidth: number,
        targetHeight: number,
        depthView: GPUTextureView | null,
        config: ClearConfig,
        // MSAA on: draw the scissor clear into this multisample color view and resolve into
        // targetView. Absent → draw straight into targetView (byte-identical pre-MSAA).
        msaaColorView?: GPUTextureView
    ): void {
        const hasColor = (config.flags & D3DCLEAR_TARGET) !== 0;
        const needsDepth = (config.flags & D3DCLEAR_ZBUFFER) !== 0;
        const needsStencil = (config.flags & D3DCLEAR_STENCIL) !== 0;
        const pipeline = this.getPipeline(targetFormat, hasColor, needsDepth, needsStencil);

        if (!this.clearVertexBuffer) {
            Logger.warn(LogCategory.DDRAW, `ClearPipeline: Vertex buffer not initialized`);
            return;
        }

        const clearColor = this.parseColor(config.color);

        const colorAttachments: GPURenderPassColorAttachment[] = [];
        if (hasColor) {
            colorAttachments.push(
                msaaColorView
                    ? {
                        view: msaaColorView,
                        resolveTarget: targetView,
                        loadOp: "load",
                        storeOp: "store",
                    }
                    : {
                        view: targetView,
                        loadOp: "load",
                        storeOp: "store",
                    }
            );
        }

        const useDepthStencil = (needsDepth || needsStencil) && depthView;
        let depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
        if (useDepthStencil) {
            depthStencilAttachment = {
                view: depthView,
                depthLoadOp: "load",
                depthStoreOp: "store",
                stencilLoadOp: "load",
                stencilStoreOp: "store",
            };
        }

        if (colorAttachments.length === 0 && !depthStencilAttachment) return;

        const renderPass = encoder.beginRenderPass({
            colorAttachments,
            depthStencilAttachment,
        });

        if (hasColor) renderPass.setBlendConstant(clearColor);
        if (needsStencil) renderPass.setStencilReference(config.stencil ?? 0);

        if (this.depthUniformBuffer && this.depthBindGroup) {
            if (needsDepth) {
                const depthValue = (config.depth !== undefined && !isNaN(config.depth))
                    ? config.depth
                    : 1.0;
                const depthData = new Float32Array([depthValue, 0, 0, 0]);
                this.queue.writeBuffer(this.depthUniformBuffer, 0, depthData);
            }
            renderPass.setBindGroup(0, this.depthBindGroup);
        }

        renderPass.setPipeline(pipeline);
        renderPass.setVertexBuffer(0, this.clearVertexBuffer);

        if (config.rects?.length) {
            for (const rect of config.rects) {
                const rectX = Math.max(0, Math.min(rect.x1, targetWidth));
                const rectY = Math.max(0, Math.min(rect.y1, targetHeight));
                const rectX2 = Math.max(0, Math.min(rect.x2, targetWidth));
                const rectY2 = Math.max(0, Math.min(rect.y2, targetHeight));
                const w = Math.max(0, rectX2 - rectX);
                const h = Math.max(0, rectY2 - rectY);
                if (w > 0 && h > 0) {
                    this.drawScissorRect(
                        renderPass,
                        rectX,
                        rectY,
                        w,
                        h,
                        targetWidth,
                        targetHeight
                    );
                }
            }
        } else if (config.viewport) {
            this.drawScissorRect(
                renderPass,
                config.viewport.x,
                config.viewport.y,
                config.viewport.width,
                config.viewport.height,
                targetWidth,
                targetHeight
            );
        }

        renderPass.end();
    }

    private drawScissorRect(
        renderPass: GPURenderPassEncoder,
        x: number,
        y: number,
        width: number,
        height: number,
        targetWidth: number,
        targetHeight: number
    ): void {
        // Clamp to target bounds
        const scissorX = Math.max(0, Math.min(x, targetWidth));
        const scissorY = Math.max(0, Math.min(y, targetHeight));
        const scissorWidth = Math.max(0, Math.min(width, targetWidth - scissorX));
        const scissorHeight = Math.max(0, Math.min(height, targetHeight - scissorY));

        if (scissorWidth <= 0 || scissorHeight <= 0) return;

        renderPass.setScissorRect(scissorX, scissorY, scissorWidth, scissorHeight);

        // Set viewport (depth value is controlled via uniform buffer, not viewport minDepth/maxDepth)
        renderPass.setViewport(
            scissorX,
            scissorY,
            scissorWidth,
            scissorHeight,
            0,
            1
        );

        renderPass.draw(4, 1, 0, 0);
    }

    /**
     * Perform a clear operation (fast path: loadOp clear; slow path: partial scissor draws).
     * @param targetFormat - Format of targetView (from state.gpuTextureFormat)
     */
    clear(
        encoder: GPUCommandEncoder,
        targetView: GPUTextureView,
        targetWidth: number,
        targetHeight: number,
        depthView: GPUTextureView | null,
        config: ClearConfig,
        targetFormat: GPUTextureFormat,
        // MSAA on: multisample color view to clear into and resolve to targetView. Absent = pre-MSAA.
        msaaColorView?: GPUTextureView
    ): void {
        const isPartial = this.isPartialClear(config, targetWidth, targetHeight);

        if (isPartial) {
            this.performPartialClear(
                encoder,
                targetView,
                targetFormat,
                targetWidth,
                targetHeight,
                depthView,
                config,
                msaaColorView
            );
        } else {
            this.performFullClear(encoder, targetView, depthView, config, msaaColorView);
        }
    }

    destroy(): void {
        if (this.clearVertexBuffer) {
            this.clearVertexBuffer.destroy();
            this.clearVertexBuffer = null;
        }
        if (this.depthUniformBuffer) {
            this.depthUniformBuffer.destroy();
            this.depthUniformBuffer = null;
        }
        this.depthBindGroupLayout = null;
        this.depthBindGroup = null;
        this.shaderModule = null;
        this.pipelines.clear();
        this.depthOnlyPipelines = null;
    }
}
