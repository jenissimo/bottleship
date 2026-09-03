/**
 * OpenGL Backend Executor
 *
 * Executes OpenGL command stream on WebGPU:
 * - CLEAR / DRAW command processing
 * - fixed-function style fragment pipeline (vertex color + 2 texture units)
 * - depth / stencil / blend / cull / scissor state mapping
 * - offscreen rendering + present to swapchain
 */

import { OpenGLFrameInput } from "./opengl-types";
import { OpenGLPipelineConfig, pipelineConfigKey } from "./opengl-pipeline-factory";
import { EmulatorConfig } from "../../../core/emulator-config-manager";
import { registerBackendQualitySupport } from "../shared/quality-capabilities";
import { registerGpuDeviceObserver } from "../../../core/gpu/gpu-device-lifecycle";
import {
    GLCommandStream, GLDrawCommandType, GLTextureObject, VERT_FLOATS,
    CMD_I32, CMD_F32, CI_TYPE,
    CI_MODE, CI_VERT_OFFSET, CI_VERT_COUNT, CI_FLAGS, CI_DEPTH_FUNC, CI_BLEND_SRC, CI_BLEND_DST,
    CI_ALPHA_FUNC, CI_CULL_FACE, CI_FRONT_FACE, CI_TEX_ID0, CI_TEX_ID1, CI_TEXENV0, CI_TEXENV1,
    CI_FOG_MODE, CI_POLYGON_MODE, CI_STENCIL_FUNC, CI_STENCIL_REF, CI_STENCIL_MASK,
    CI_STENCIL_FAIL, CI_STENCIL_ZFAIL, CI_STENCIL_ZPASS, CI_STENCIL_WRITE_MASK,
    CI_SCISSOR_X, CI_SCISSOR_Y, CI_SCISSOR_W, CI_SCISSOR_H, CI_VP_X, CI_VP_Y, CI_VP_W, CI_VP_H,
    CI_CLEAR_MASK, CI_CLEAR_STENCIL,
    CF_ALPHA_REF, CF_FOG_R, CF_FOG_G, CF_FOG_B, CF_FOG_A, CF_FOG_DENSITY, CF_FOG_START, CF_FOG_END,
    CF_DEPTH_RANGE_NEAR, CF_DEPTH_RANGE_FAR,
    CI_COMBINE0_RGB, CI_COMBINE0_ALPHA, CI_COMBINE1_RGB, CI_COMBINE1_ALPHA,
    CF_ENV_COLOR0, CF_ENV_COLOR1,
    COMBINER_FN_REPLACE, COMBINER_FN_MODULATE, COMBINER_FN_ADD, COMBINER_FN_ADD_SIGNED,
    COMBINER_FN_INTERPOLATE, COMBINER_FN_SUBTRACT, COMBINER_FN_DOT3_RGB, COMBINER_FN_DOT3_RGBA,
    COMBINER_SRC_CONSTANT, COMBINER_SRC_PRIMARY, COMBINER_SRC_PREVIOUS,
    COMBINER_OP_ONE_MINUS_SRC_COLOR, COMBINER_OP_SRC_ALPHA, COMBINER_OP_ONE_MINUS_SRC_ALPHA,
    CF_CLEAR_R, CF_CLEAR_G, CF_CLEAR_B, CF_CLEAR_A, CF_CLEAR_DEPTH,
    DF_DEPTH_TEST, DF_DEPTH_MASK, DF_BLEND, DF_ALPHA_TEST, DF_CULL, DF_FOG,
    DF_COLOR_MASK_R, DF_COLOR_MASK_G, DF_COLOR_MASK_B, DF_COLOR_MASK_A, DF_STENCIL_TEST, DF_SCISSOR,
} from "../../../modules/opengl32/context";
import {
    GL_ADD,
    GL_ALWAYS,
    GL_BACK,
    GL_CLAMP,
    GL_CLAMP_TO_EDGE,
    GL_CCW,
    GL_COLOR_BUFFER_BIT,
    GL_COMBINE,
    GL_DECAL,
    GL_DECR,
    GL_DEPTH_BUFFER_BIT,
    GL_DST_ALPHA,
    GL_DST_COLOR,
    GL_EQUAL,
    GL_EXP,
    GL_EXP2,
    GL_FILL,
    GL_FRONT,
    GL_FRONT_AND_BACK,
    GL_GEQUAL,
    GL_GREATER,
    GL_INCR,
    GL_KEEP,
    GL_LEQUAL,
    GL_LESS,
    GL_LINEAR,
    GL_LINEAR_MIPMAP_LINEAR,
    GL_LINEAR_MIPMAP_NEAREST,
    GL_LINE,
    GL_LINES,
    GL_LINE_LOOP,
    GL_LINE_STRIP,
    GL_MODULATE,
    GL_NEAREST,
    GL_NEAREST_MIPMAP_LINEAR,
    GL_NEAREST_MIPMAP_NEAREST,
    GL_NEVER,
    GL_NOTEQUAL,
    GL_ONE,
    GL_ONE_MINUS_DST_ALPHA,
    GL_ONE_MINUS_DST_COLOR,
    GL_ONE_MINUS_SRC_ALPHA,
    GL_ONE_MINUS_SRC_COLOR,
    GL_POINT,
    GL_POINTS,
    GL_REPLACE,
    GL_REPEAT,
    GL_SRC_ALPHA,
    GL_SRC_ALPHA_SATURATE,
    GL_SRC_COLOR,
    GL_STENCIL_BUFFER_BIT,
    GL_ZERO,
} from "../../../modules/opengl32/constants";
import { Logger, LogCategory } from "../../../core/logger";
import { WebGPUBackend } from "../webgpu-backend";
import { statsOverlay } from "../../../core/stats-overlay";

type OpenGLTopology = "triangle-list" | "line-list" | "line-strip" | "point-list";

interface CachedTexture {
    id: number;
    texture: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
    version: number;
    wrapS: number;
    wrapT: number;
    minFilter: number;
    magFilter: number;
}

interface PreparedDrawData {
    topology: OpenGLTopology;
    vertexCount: number;
    data: Float32Array;
    byteLength: number;
}

/** Vertices selected for a draw: a (buffer, first-vertex, count) window. */
interface SelectedVertices {
    data: Float32Array;
    first: number;
    count: number;
    topology: OpenGLTopology;
}

const VERTEX_FLOAT_STRIDE = 12; // pos.xyz + color.rgba + uv0.xy + uv1.xy + pad
const VERTEX_BYTE_STRIDE = VERTEX_FLOAT_STRIDE * 4;
const UNIFORM_BLOCK_SIZE = 144;

export class OpenGLBackendExecutor {
    private readonly backend: WebGPUBackend;

    private offscreenTexture: GPUTexture | null = null;
    private offscreenView: GPUTextureView | null = null;
    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    private offscreenSize: { width: number; height: number } | null = null;
    private offscreenInitialized = false;
    /** Depth/stencil survives SwapBuffers exactly as GL's is: only glClear resets it.
     *  Quake-lineage engines run gl_ztrick — alternate frames swap the depth range and
     *  the compare function INSTEAD of clearing, so a per-frame clear drops every
     *  fragment of the GEQUAL frame. */
    private depthStencilInitialized = false;
    /** Last frame's default-framebuffer resolution (the GL drawable). */
    private presentSourceW = 0;
    private presentSourceH = 0;
    private targetFormat: GPUTextureFormat | null = null;

    private shaderModule: GPUShaderModule | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private pipelineLayout: GPUPipelineLayout | null = null;
    private readonly pipelineCache = new Map<string, GPURenderPipeline>();

    private readonly textureCache = new Map<number, CachedTexture>();
    private readonly samplerCache = new Map<string, GPUSampler>();
    private readonly bindGroupCache = new Map<string, GPUBindGroup>();

    private whiteTexture: GPUTexture | null = null;
    private whiteTextureView: GPUTextureView | null = null;
    private defaultSampler: GPUSampler | null = null;

    private vertexBuffer: GPUBuffer | null = null;
    private vertexBufferSize = 0;
    private vertexUploadCursor = 0;
    private vertexScratch = new Float32Array(0);
    /** Staging for polygon-mode wireframe / line-loop closing expansions. */
    private expandScratch = new Float32Array(0);

    private uniformBuffer: GPUBuffer | null = null;
    private uniformStride = 256;
    private uniformCapacity = 0;
    private uniformCursor = 0;
    private readonly uniformScratchBuffer = new ArrayBuffer(UNIFORM_BLOCK_SIZE);
    private readonly uniformScratchF32 = new Float32Array(this.uniformScratchBuffer);
    private readonly uniformScratchU32 = new Uint32Array(this.uniformScratchBuffer);

    /** Current draw's glDepthRange, as WebGPU takes it (see readDepthRange). */
    private depthRangeMin = 0;
    private depthRangeMax = 1;
    private depthRangeReversed = false;

    private readonly samplerIds = new WeakMap<GPUSampler, number>();
    private readonly textureViewIds = new WeakMap<GPUTextureView, number>();
    private nextObjectId = 1;

    constructor(backend: WebGPUBackend) {
        this.backend = backend;
        registerBackendQualitySupport("opengl", ["anisotropy", "forceTrilinear"]);
        // All of this is rebuilt lazily by ensureStaticResources/ensureTargets/resolveTexture
        // from the GL object state, which lives on the CPU side and outlives the device.
        registerGpuDeviceObserver("opengl-executor", {
            onDeviceLost: () => {
                this.offscreenTexture = null;
                this.offscreenView = null;
                this.depthTexture = null;
                this.depthView = null;
                this.targetFormat = null;
                this.shaderModule = null;
                this.bindGroupLayout = null;
                this.pipelineLayout = null;
                this.pipelineCache.clear();
                this.textureCache.clear();
                this.samplerCache.clear();
                this.bindGroupCache.clear();
                this.whiteTexture = null;
                this.whiteTextureView = null;
                this.defaultSampler = null;
                this.vertexBuffer = null;
                this.vertexBufferSize = 0;
                this.vertexUploadCursor = 0;
                this.uniformBuffer = null;
                this.uniformCapacity = 0;
                this.uniformCursor = 0;
            },
        });
    }

    /** Default-framebuffer size: the presentation surface a WGL context owns. */
    getDrawableSize(): [number, number] {
        const canvas = this.backend.getContext()?.canvas as OffscreenCanvas | undefined;
        return [canvas?.width ?? 0, canvas?.height ?? 0];
    }

    executeFrame(input: OpenGLFrameInput): void {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        const context = this.backend.getContext();
        if (!device || !queue || !context) {
            Logger.warn(LogCategory.SYSTEM,
                `OpenGL executeFrame: early exit — device=${!!device} queue=${!!queue} context=${!!context}`);
            return;
        }

        const canvas = context.canvas as OffscreenCanvas | undefined;
        const screenW = canvas?.width ?? 0;
        const screenH = canvas?.height ?? 0;
        if (screenW <= 0 || screenH <= 0) {
            Logger.warn(LogCategory.SYSTEM,
                `OpenGL executeFrame: early exit — canvas ${screenW}x${screenH}`);
            return;
        }

        const format = this.backend.getFormat() ?? "bgra8unorm";
        // The default framebuffer is sized by the DRAWABLE (here: the presentation
        // surface a WGL context always owns), never by glViewport — glViewport only
        // maps NDC onto a rectangle inside it. A frame whose last viewport is a
        // sub-rect (a portal, a HUD strip, a letterboxed 2D pass) must still render
        // at full drawable resolution.
        const renderW = screenW;
        const renderH = screenH;
        this.presentSourceW = renderW;
        this.presentSourceH = renderH;
        this.ensureStaticResources(device);
        this.ensureTargets(device, renderW, renderH, format);
        this.pruneTextureCache(input.textures);

        const drawCount = this.countDrawCommands(input.commands);
        this.ensureUniformCapacity(device, drawCount);
        this.ensureVertexBufferCapacity(device, this.estimateVertexBytes(input.commands));

        if (!this.offscreenView || !this.depthView || !this.uniformBuffer || !this.vertexBuffer) {
            Logger.warn(LogCategory.SYSTEM,
                `OpenGL executeFrame: early exit — offscreen=${!!this.offscreenView} depth=${!!this.depthView} uniform=${!!this.uniformBuffer} vertex=${!!this.vertexBuffer}`);
            return;
        }

        this.uniformCursor = 0;
        this.vertexUploadCursor = 0;

        const encoder = device.createCommandEncoder();
        let renderPass: GPURenderPassEncoder | null = null;
        let colorHasContent = this.offscreenInitialized;
        let depthStencilHasContent = this.depthStencilInitialized;
        let drawsIssued = 0;

        const endPass = (): void => {
            if (!renderPass) return;
            renderPass.end();
            renderPass = null;
        };

        const beginDrawPass = (): GPURenderPassEncoder => {
            if (renderPass) return renderPass;
            renderPass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: this.offscreenView!,
                    loadOp: colorHasContent ? "load" : "clear",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    storeOp: "store",
                }],
                depthStencilAttachment: {
                    view: this.depthView!,
                    depthLoadOp: depthStencilHasContent ? "load" : "clear",
                    depthClearValue: 1,
                    depthStoreOp: "store",
                    stencilLoadOp: depthStencilHasContent ? "load" : "clear",
                    stencilClearValue: 0,
                    stencilStoreOp: "store",
                },
            });
            // Viewport is set per-draw in the DRAW handler (OpenGL Y-flip).
            colorHasContent = true;
            depthStencilHasContent = true;
            return renderPass;
        };

        const stream = input.commands;
        const I = stream.i32;
        const F = stream.f32;

        for (let c = 0; c < stream.count; c++) {
            const i = c * CMD_I32;
            const f = c * CMD_F32;
            switch (I[i + CI_TYPE]) {
                case GLDrawCommandType.CLEAR: {
                    endPass();
                    if (this.encodeClearPass(
                        encoder,
                        I[i + CI_CLEAR_MASK] >>> 0,
                        F[f + CF_CLEAR_R],
                        F[f + CF_CLEAR_G],
                        F[f + CF_CLEAR_B],
                        F[f + CF_CLEAR_A],
                        F[f + CF_CLEAR_DEPTH],
                        I[i + CI_CLEAR_STENCIL] >>> 0,
                        colorHasContent,
                        depthStencilHasContent,
                    )) {
                        colorHasContent = true;
                        depthStencilHasContent = true;
                    }
                    break;
                }
                case GLDrawCommandType.DRAW: {
                    const vertCount = I[i + CI_VERT_COUNT];
                    if (vertCount <= 0) break;
                    const flags = I[i + CI_FLAGS];
                    const cullEnabled = (flags & DF_CULL) !== 0;
                    const cullFace = I[i + CI_CULL_FACE] >>> 0;
                    if (cullEnabled && cullFace === GL_FRONT_AND_BACK) break;

                    const prepared = this.prepareDrawData(
                        input.vertArena, I[i + CI_VERT_OFFSET], vertCount,
                        I[i + CI_MODE] >>> 0, I[i + CI_POLYGON_MODE] >>> 0);
                    if (!prepared || prepared.vertexCount <= 0) break;

                    const vertexOffset = this.uploadVertices(queue, prepared.data, prepared.byteLength);
                    if (vertexOffset < 0) break;

                    const tex0 = this.resolveTexture(device, queue, input.textures, I[i + CI_TEX_ID0]);
                    const tex1 = this.resolveTexture(device, queue, input.textures, I[i + CI_TEX_ID1]);
                    const useTex0 = !!tex0;
                    const useTex1 = !!tex1;

                    const sampler0 = tex0
                        ? this.getOrCreateSampler(device, tex0.wrapS, tex0.wrapT, tex0.minFilter, tex0.magFilter)
                        : this.getDefaultSampler(device);
                    const sampler1 = tex1
                        ? this.getOrCreateSampler(device, tex1.wrapS, tex1.wrapT, tex1.minFilter, tex1.magFilter)
                        : this.getDefaultSampler(device);

                    const view0 = tex0?.view ?? this.getWhiteTextureView(device, queue);
                    const view1 = tex1?.view ?? this.getWhiteTextureView(device, queue);
                    if (!view0 || !view1) break;

                    const uniformOffset = this.allocateUniformSlot();
                    if (uniformOffset < 0) break;

                    this.writeUniforms(queue, uniformOffset, renderW, renderH, I, F, i, f, useTex0, useTex1);

                    const stencilTest = (flags & DF_STENCIL_TEST) !== 0;
                    const pipelineCfg: OpenGLPipelineConfig = {
                        topology: prepared.topology,
                        blendEnabled: (flags & DF_BLEND) !== 0,
                        blendSrc: I[i + CI_BLEND_SRC] >>> 0,
                        blendDst: I[i + CI_BLEND_DST] >>> 0,
                        depthTest: (flags & DF_DEPTH_TEST) !== 0,
                        depthWrite: (flags & DF_DEPTH_MASK) !== 0,
                        depthFunc: I[i + CI_DEPTH_FUNC] >>> 0,
                        cullEnabled,
                        cullFace,
                        frontFace: I[i + CI_FRONT_FACE] >>> 0,
                        colorMaskR: (flags & DF_COLOR_MASK_R) !== 0,
                        colorMaskG: (flags & DF_COLOR_MASK_G) !== 0,
                        colorMaskB: (flags & DF_COLOR_MASK_B) !== 0,
                        colorMaskA: (flags & DF_COLOR_MASK_A) !== 0,
                        stencilTest,
                        stencilFunc: I[i + CI_STENCIL_FUNC] >>> 0,
                        stencilMask: I[i + CI_STENCIL_MASK] >>> 0,
                        stencilWriteMask: I[i + CI_STENCIL_WRITE_MASK] >>> 0,
                        stencilFail: I[i + CI_STENCIL_FAIL] >>> 0,
                        stencilZFail: I[i + CI_STENCIL_ZFAIL] >>> 0,
                        stencilZPass: I[i + CI_STENCIL_ZPASS] >>> 0,
                    };

                    const pipeline = this.getOrCreatePipeline(device, pipelineCfg);
                    const bindGroup = this.getOrCreateBindGroup(device, sampler0, view0, sampler1, view1);
                    const pass = beginDrawPass();
                    if (!this.applyScissor(pass, I, i, flags, renderW, renderH)) break;

                    // OpenGL Y-up → WebGPU Y-down, inside the drawable-sized target.
                    const cmdVpW = I[i + CI_VP_W];
                    const cmdVpH = I[i + CI_VP_H];
                    const vpW = cmdVpW > 0 ? cmdVpW : renderW;
                    const vpH = cmdVpH > 0 ? cmdVpH : renderH;
                    const vpX = I[i + CI_VP_X];
                    const vpY = renderH - I[i + CI_VP_Y] - vpH;
                    pass.setViewport(vpX, vpY, vpW, vpH, this.depthRangeMin, this.depthRangeMax);

                    pass.setPipeline(pipeline);
                    if (stencilTest) {
                        pass.setStencilReference(I[i + CI_STENCIL_REF] >>> 0);
                    }
                    pass.setBindGroup(0, bindGroup, [uniformOffset]);
                    pass.setVertexBuffer(0, this.vertexBuffer!, vertexOffset, prepared.byteLength);
                    pass.draw(prepared.vertexCount, 1, 0, 0);
                    drawsIssued++;
                    break;
                }
                case GLDrawCommandType.VIEWPORT:
                case GLDrawCommandType.SCISSOR:
                default:
                    break;
            }
        }

        endPass();

        // Compatibility path:
        // some legacy GL apps update textures every frame but geometry command stream
        // may be missing due partial list/FFP emulation gaps. If no draws were issued,
        // present the most relevant GL texture directly to avoid a hard black screen.
        if (drawsIssued === 0) {
            const fallbackTex = this.resolveFallbackPresentTexture(device, queue, input.textures);
            if (fallbackTex) {
                const targetView = context.getCurrentTexture().createView();
                this.backend.drawTexture(
                    fallbackTex.view,
                    targetView,
                    encoder,
                    true,
                    screenW,
                    screenH,
                    { r: 0, g: 0, b: 0, a: 1 },
                );
                this.compositeStatsOverlay(targetView, encoder, screenW, screenH);
                queue.submit([encoder.finish()]);
                this.offscreenInitialized = false;
                Logger.log(
                    LogCategory.SYSTEM,
                    `OpenGL fallback present: tex=${fallbackTex.id} ${fallbackTex.width}x${fallbackTex.height} draws=0 ` +
                    `cmds=${stream.count} [${this.summarizeCommands(stream)}]`,
                );
                return;
            }
        }

        if (!colorHasContent) {
            this.encodeClearPass(
                encoder,
                GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT,
                0,
                0,
                0,
                1,
                1,
                0,
                false,
                false,
            );
            colorHasContent = true;
            depthStencilHasContent = true;
        }

        this.offscreenInitialized = colorHasContent;
        this.depthStencilInitialized = depthStencilHasContent;

        const targetView = context.getCurrentTexture().createView();
        this.blitOffscreenToCanvas(targetView, encoder, screenW, screenH);
        this.compositeStatsOverlay(targetView, encoder, screenW, screenH);
        queue.submit([encoder.finish()]);

        Logger.verbose(
            LogCategory.SYSTEM,
            `OpenGL frame: cmds=${stream.count} draws=${drawCount} drawable=${renderW}x${renderH}`,
        );
    }

    /**
     * Re-present the last rendered offscreen to the canvas without re-rendering.
     * Low-fps wglSwapBuffers presenters need this so the swapchain holds the frame
     * between browser composites (single blit, no geometry re-draw).
     */
    repaintLastFrame(): void {
        if (!this.offscreenView || !this.offscreenInitialized) return;
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        const context = this.backend.getContext();
        if (!device || !queue || !context) return;
        const canvas = context.canvas as OffscreenCanvas | undefined;
        const screenW = canvas?.width ?? 0;
        const screenH = canvas?.height ?? 0;
        if (screenW <= 0 || screenH <= 0) return;
        const encoder = device.createCommandEncoder();
        const targetView = context.getCurrentTexture().createView();
        this.blitOffscreenToCanvas(targetView, encoder, screenW, screenH);
        this.compositeStatsOverlay(targetView, encoder, screenW, screenH);
        queue.submit([encoder.finish()]);
    }

    /** Blit offscreen render target to the swapchain, upscaling with nearest filter when needed. */
    private blitOffscreenToCanvas(
        targetView: GPUTextureView,
        encoder: GPUCommandEncoder,
        screenW: number,
        screenH: number,
    ): void {
        if (!this.offscreenView) return;
        const srcW = this.presentSourceW > 0 ? this.presentSourceW : screenW;
        const srcH = this.presentSourceH > 0 ? this.presentSourceH : screenH;
        const upscale = srcW !== screenW || srcH !== screenH;
        this.backend.drawTexture(
            this.offscreenView,
            targetView,
            encoder,
            true,
            screenW,
            screenH,
            { r: 0, g: 0, b: 0, a: 1 },
            upscale,
        );
    }

    private compositeStatsOverlay(
        targetView: GPUTextureView,
        encoder: GPUCommandEncoder,
        width: number,
        height: number,
    ): void {
        if (!statsOverlay.isEnabled()) return;
        const statsCanvas = statsOverlay.getCanvas();
        if (!statsCanvas) return;
        if (statsOverlay.isDirty()) {
            this.backend.updateStatsTexture(statsCanvas);
            statsOverlay.clearDirty();
        }
        this.backend.renderStatsOverlay(targetView, encoder, width, height);
    }

    destroy(): void {
        for (const tex of this.textureCache.values()) {
            tex.texture.destroy();
        }
        this.textureCache.clear();
        this.samplerCache.clear();
        this.bindGroupCache.clear();
        this.pipelineCache.clear();

        if (this.whiteTexture) {
            this.whiteTexture.destroy();
            this.whiteTexture = null;
            this.whiteTextureView = null;
        }
        this.defaultSampler = null;

        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
            this.vertexBuffer = null;
            this.vertexBufferSize = 0;
        }

        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
            this.uniformBuffer = null;
            this.uniformCapacity = 0;
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
        this.offscreenSize = null;
        this.offscreenInitialized = false;
        this.targetFormat = null;

        this.shaderModule = null;
        this.bindGroupLayout = null;
        this.pipelineLayout = null;
    }

    private ensureStaticResources(device: GPUDevice): void {
        if (!this.bindGroupLayout) {
            this.bindGroupLayout = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                        buffer: {
                            type: "uniform",
                            hasDynamicOffset: true,
                            minBindingSize: UNIFORM_BLOCK_SIZE,
                        },
                    },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                    { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                ],
            });
        }

        if (!this.pipelineLayout && this.bindGroupLayout) {
            this.pipelineLayout = device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayout],
            });
        }

        if (!this.shaderModule) {
            this.shaderModule = device.createShaderModule({ code: this.buildShaderCode() });
        }

        const align = device.limits.minUniformBufferOffsetAlignment || 256;
        this.uniformStride = Math.max(256, align);
    }

    private ensureTargets(device: GPUDevice, width: number, height: number, format: GPUTextureFormat): void {
        const sameSize = this.offscreenSize && this.offscreenSize.width === width && this.offscreenSize.height === height;
        const sameFormat = this.targetFormat === format;
        if (sameSize && sameFormat && this.offscreenTexture && this.depthTexture) {
            return;
        }

        if (this.offscreenTexture) {
            this.offscreenTexture.destroy();
        }
        if (this.depthTexture) {
            this.depthTexture.destroy();
        }

        if (!sameFormat) {
            this.pipelineCache.clear();
            this.bindGroupCache.clear();
        }

        this.targetFormat = format;
        this.offscreenTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.offscreenView = this.offscreenTexture.createView();

        this.depthTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: "depth24plus-stencil8",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.offscreenSize = { width, height };
        this.offscreenInitialized = false;
        this.depthStencilInitialized = false;
    }

    /**
     * Read a rectangle of the colour buffer back as RGBA8, GL orientation (row 0 is the
     * BOTTOM row, as glReadPixels defines it).
     *
     * The source is the offscreen colour target, which holds the most recently EXECUTED
     * frame: commands accumulate until present, so a read issued before SwapBuffers sees
     * the previous frame. That is a one-frame lag, not undefined data — and the caller
     * gets a real image either way.
     *
     * Returns null when there is nothing rendered yet or the rect falls outside it; the
     * caller must then say so rather than leave the guest buffer untouched.
     */
    async readPixels(x: number, y: number, width: number, height: number): Promise<Uint8Array | null> {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        const texture = this.offscreenTexture;
        const size = this.offscreenSize;
        if (!device || !queue || !texture || !size || !this.offscreenInitialized) return null;
        if (width <= 0 || height <= 0) return null;
        if (x < 0 || y < 0 || x + width > size.width || y + height > size.height) return null;

        // GL's y counts up from the bottom of the drawable; the texture's counts down.
        const topY = size.height - (y + height);
        const bytesPerRow = (width * 4 + 255) & ~255;
        const staging = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture, origin: { x, y: topY, z: 0 } },
                { buffer: staging, bytesPerRow, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 },
            );
            queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(staging.getMappedRange());
            const out = new Uint8Array(width * height * 4);
            const bgra = this.targetFormat === "bgra8unorm";
            for (let row = 0; row < height; row++) {
                // Flip vertically on the way out: the last texture row is GL's row 0.
                const src = (height - 1 - row) * bytesPerRow;
                const dst = row * width * 4;
                if (bgra) {
                    for (let px = 0; px < width; px++) {
                        const s = src + px * 4, d = dst + px * 4;
                        out[d] = mapped[s + 2];
                        out[d + 1] = mapped[s + 1];
                        out[d + 2] = mapped[s];
                        out[d + 3] = mapped[s + 3];
                    }
                } else {
                    out.set(mapped.subarray(src, src + width * 4), dst);
                }
            }
            staging.unmap();
            return out;
        } finally {
            staging.destroy();
        }
    }

    private pruneTextureCache(textures: Map<number, GLTextureObject>): void {
        let removed = false;
        for (const [id, cached] of this.textureCache.entries()) {
            if (textures.has(id)) continue;
            cached.texture.destroy();
            this.textureCache.delete(id);
            removed = true;
        }
        if (removed) {
            this.bindGroupCache.clear();
        }
    }

    private countDrawCommands(stream: GLCommandStream): number {
        let count = 0;
        for (let c = 0; c < stream.count; c++) {
            if (stream.i32[c * CMD_I32 + CI_TYPE] === GLDrawCommandType.DRAW) count++;
        }
        return count;
    }

    private estimateVertexBytes(stream: GLCommandStream): number {
        const I = stream.i32;
        let totalVertices = 0;
        for (let c = 0; c < stream.count; c++) {
            const i = c * CMD_I32;
            if (I[i + CI_TYPE] !== GLDrawCommandType.DRAW) continue;
            const mode = I[i + CI_MODE] >>> 0;
            let count = I[i + CI_VERT_COUNT];
            if (mode === GL_LINE_LOOP) count += 1;
            if ((I[i + CI_POLYGON_MODE] >>> 0) === GL_LINE && this.isTriangleLikeMode(mode)) {
                count *= 2;
            }
            totalVertices += count;
        }
        return Math.max(1, totalVertices * VERTEX_BYTE_STRIDE);
    }

    private summarizeCommands(stream: GLCommandStream): string {
        const I = stream.i32;
        const parts: string[] = [];
        for (let c = 0; c < stream.count; c++) {
            const i = c * CMD_I32;
            switch (I[i + CI_TYPE]) {
                case GLDrawCommandType.CLEAR:
                    parts.push(`CLEAR(m=0x${(I[i + CI_CLEAR_MASK] >>> 0).toString(16)})`);
                    break;
                case GLDrawCommandType.VIEWPORT:
                    parts.push(`VP(${I[i + CI_VP_W]}x${I[i + CI_VP_H]})`);
                    break;
                case GLDrawCommandType.SCISSOR:
                    parts.push('SCISSOR');
                    break;
                case GLDrawCommandType.DRAW:
                    parts.push(`DRAW(v=${I[i + CI_VERT_COUNT]})`);
                    break;
                default:
                    parts.push(`?${I[i + CI_TYPE]}`);
                    break;
            }
        }
        return parts.join(',');
    }

    private ensureUniformCapacity(device: GPUDevice, drawCount: number): void {
        const required = Math.max(1, drawCount + 8);
        if (this.uniformBuffer && this.uniformCapacity >= required) {
            return;
        }

        const nextCapacity = this.nextPow2(required);
        const size = nextCapacity * this.uniformStride;

        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
        }
        this.uniformBuffer = device.createBuffer({
            size,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.uniformCapacity = nextCapacity;
        this.bindGroupCache.clear();
    }

    private ensureVertexBufferCapacity(device: GPUDevice, requiredBytes: number): void {
        if (this.vertexBuffer && this.vertexBufferSize >= requiredBytes) return;

        const nextSize = this.nextPow2(Math.max(requiredBytes, 64 * 1024));
        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
        }
        this.vertexBuffer = device.createBuffer({
            size: nextSize,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.vertexBufferSize = nextSize;
    }

    private allocateUniformSlot(): number {
        if (!this.uniformBuffer || this.uniformCursor >= this.uniformCapacity) {
            return -1;
        }
        const offset = this.uniformCursor * this.uniformStride;
        this.uniformCursor++;
        return offset;
    }

    private uploadVertices(queue: GPUQueue, vertices: Float32Array, byteLength: number): number {
        if (!this.vertexBuffer) return -1;
        const offset = this.vertexUploadCursor;
        this.vertexUploadCursor += byteLength;
        if (this.vertexUploadCursor > this.vertexBufferSize) return -1;
        queue.writeBuffer(this.vertexBuffer, offset, vertices.buffer, vertices.byteOffset, byteLength);
        return offset;
    }

    private prepareDrawData(
        arena: Float32Array,
        vertOffset: number,
        vertCount: number,
        mode: number,
        polygonMode: number,
    ): PreparedDrawData | null {
        const selected = this.selectFlatVertices(arena, vertOffset, vertCount, mode, polygonMode);
        if (!selected || selected.count <= 0) return null;

        const count = selected.count;
        const floatCount = count * VERTEX_FLOAT_STRIDE;
        if (this.vertexScratch.length < floatCount) {
            this.vertexScratch = new Float32Array(this.nextPow2(floatCount));
        }
        const out = this.vertexScratch.subarray(0, floatCount);

        const src = selected.data;
        let si = selected.first;
        let idx = 0;
        for (let i = 0; i < count; i++) {
            out[idx++] = src[si];       // clip.x
            out[idx++] = src[si+1];     // clip.y
            out[idx++] = src[si+2];     // clip.z
            out[idx++] = src[si+3];     // clip.w
            out[idx++] = this.clamp01(src[si+4]); // r
            out[idx++] = this.clamp01(src[si+5]); // g
            out[idx++] = this.clamp01(src[si+6]); // b
            out[idx++] = this.clamp01(src[si+7]); // a
            out[idx++] = src[si+11];    // s0
            out[idx++] = src[si+12];    // t0
            out[idx++] = src[si+13];    // s1
            out[idx++] = src[si+14];    // t1
            si += VERT_FLOATS;
        }

        return {
            topology: selected.topology,
            vertexCount: count,
            data: out,
            byteLength: count * VERTEX_BYTE_STRIDE,
        };
    }

    /** Scratch big enough for `floats`, preserving nothing. */
    private expandBuffer(floats: number): Float32Array {
        if (this.expandScratch.length < floats) {
            this.expandScratch = new Float32Array(this.nextPow2(floats));
        }
        return this.expandScratch;
    }

    private selectFlatVertices(
        arena: Float32Array,
        vertOffset: number,
        vertCount: number,
        mode: number,
        polygonMode: number,
    ): SelectedVertices | null {
        if (polygonMode === GL_LINE && this.isTriangleLikeMode(mode)) {
            const triCount = (vertCount / 3) | 0;
            if (triCount <= 0) return null;
            const wireCount = triCount * 6;
            const wire = this.expandBuffer(wireCount * VERT_FLOATS);
            let wi = 0;
            for (let i = 0; i + 2 < vertCount; i += 3) {
                const a = vertOffset + i * VERT_FLOATS;
                const b = a + VERT_FLOATS;
                const c = b + VERT_FLOATS;
                wi = this.copyVertTo(arena, a, wire, wi);
                wi = this.copyVertTo(arena, b, wire, wi);
                wi = this.copyVertTo(arena, b, wire, wi);
                wi = this.copyVertTo(arena, c, wire, wi);
                wi = this.copyVertTo(arena, c, wire, wi);
                wi = this.copyVertTo(arena, a, wire, wi);
            }
            return { data: wire, first: 0, count: wireCount, topology: "line-list" };
        }

        if (polygonMode === GL_POINT && this.isTriangleLikeMode(mode)) {
            return { data: arena, first: vertOffset, count: vertCount, topology: "point-list" };
        }

        switch (mode) {
            case GL_POINTS:
                return { data: arena, first: vertOffset, count: vertCount, topology: "point-list" };
            case GL_LINES:
                return { data: arena, first: vertOffset, count: vertCount, topology: "line-list" };
            case GL_LINE_STRIP:
                return { data: arena, first: vertOffset, count: vertCount, topology: "line-strip" };
            case GL_LINE_LOOP: {
                if (vertCount < 2) return null;
                // Append the first vertex to close the loop.
                const floats = (vertCount + 1) * VERT_FLOATS;
                const looped = this.expandBuffer(floats);
                for (let k = 0; k < vertCount * VERT_FLOATS; k++) looped[k] = arena[vertOffset + k];
                this.copyVertTo(arena, vertOffset, looped, vertCount * VERT_FLOATS);
                return { data: looped, first: 0, count: vertCount + 1, topology: "line-strip" };
            }
            default:
                return { data: arena, first: vertOffset, count: vertCount, topology: "triangle-list" };
        }
    }

    /** Copy one VERT_FLOATS vertex; returns the advanced destination index. */
    private copyVertTo(src: Float32Array, s: number, dst: Float32Array, d: number): number {
        for (let k = 0; k < VERT_FLOATS; k++) dst[d + k] = src[s + k];
        return d + VERT_FLOATS;
    }

    private isTriangleLikeMode(mode: number): boolean {
        return mode !== GL_POINTS &&
            mode !== GL_LINES &&
            mode !== GL_LINE_STRIP &&
            mode !== GL_LINE_LOOP;
    }

    private resolveTexture(device: GPUDevice, queue: GPUQueue, textures: Map<number, GLTextureObject>, texId: number): CachedTexture | null {
        if (!texId) return null;
        const src = textures.get(texId);
        if (!src || !src.data || src.width <= 0 || src.height <= 0) return null;

        const expectedBytes = src.width * src.height * 4;
        if (src.data.length < expectedBytes) return null;

        let cached = this.textureCache.get(texId);
        const recreate = !cached || cached.width !== src.width || cached.height !== src.height;
        if (recreate) {
            if (cached) {
                cached.texture.destroy();
            }
            const texture = device.createTexture({
                size: { width: src.width, height: src.height, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            cached = {
                id: texId,
                texture,
                view: texture.createView(),
                width: src.width,
                height: src.height,
                version: -1,
                wrapS: src.wrapS,
                wrapT: src.wrapT,
                minFilter: src.minFilter,
                magFilter: src.magFilter,
            };
            this.textureCache.set(texId, cached);
            this.bindGroupCache.clear();
        }
        if (!cached) return null;

        if (recreate || cached.version !== src.gpuVersion || src.dirty) {
            queue.writeTexture(
                { texture: cached.texture },
                src.data.subarray(0, expectedBytes),
                { bytesPerRow: src.width * 4 },
                { width: src.width, height: src.height, depthOrArrayLayers: 1 },
            );
            cached.version = src.gpuVersion;
            src.dirty = false;
        }

        cached.wrapS = src.wrapS;
        cached.wrapT = src.wrapT;
        cached.minFilter = src.minFilter;
        cached.magFilter = src.magFilter;
        return cached;
    }

    private resolveFallbackPresentTexture(
        device: GPUDevice,
        queue: GPUQueue,
        textures: Map<number, GLTextureObject>,
    ): CachedTexture | null {
        // Prefer texture #1 (common for simple fixed-function video quads).
        const preferred = textures.get(1);
        if (preferred?.data && preferred.width > 0 && preferred.height > 0) {
            return this.resolveTexture(device, queue, textures, 1);
        }

        // Otherwise choose the most recently updated valid texture.
        let best: GLTextureObject | null = null;
        for (const tex of textures.values()) {
            if (!tex.data || tex.width <= 0 || tex.height <= 0) continue;
            if (!best || tex.gpuVersion > best.gpuVersion) {
                best = tex;
            }
        }
        if (!best) return null;
        return this.resolveTexture(device, queue, textures, best.id);
    }
    private getWhiteTextureView(device: GPUDevice, queue: GPUQueue): GPUTextureView | null {
        if (this.whiteTextureView) return this.whiteTextureView;
        this.whiteTexture = device.createTexture({
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        queue.writeTexture(
            { texture: this.whiteTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
        this.whiteTextureView = this.whiteTexture.createView();
        return this.whiteTextureView;
    }

    private getDefaultSampler(device: GPUDevice): GPUSampler {
        if (this.defaultSampler) return this.defaultSampler;
        this.defaultSampler = device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "repeat",
        });
        return this.defaultSampler;
    }

    private getOrCreateSampler(device: GPUDevice, wrapS: number, wrapT: number, minFilter: number, magFilter: number): GPUSampler {
        const addrU = this.mapAddressMode(wrapS);
        const addrV = this.mapAddressMode(wrapT);
        let wMin = this.mapMinMagFilter(minFilter);
        let wMag = this.mapMinMagFilter(magFilter);
        let wMip = this.mapMipmapFilter(minFilter);

        // Quality overrides — same policy as the ddraw sampler: never
        // upgrade point-sampled textures; maxAnisotropy>1 forces all-linear filters.
        const q = EmulatorConfig.getInstance().quality;
        const usesPoint = wMin === "nearest" || wMag === "nearest";
        let aniso = 1;
        if (q.anisotropy > 1 && !usesPoint) aniso = Math.min(16, q.anisotropy);
        if (q.forceTrilinear && !usesPoint) wMip = "linear";
        if (aniso > 1) { wMin = "linear"; wMag = "linear"; wMip = "linear"; }

        const key = `${addrU}|${addrV}|${wMin}|${wMag}|${wMip}|${aniso}`;
        const cached = this.samplerCache.get(key);
        if (cached) return cached;

        const sampler = device.createSampler({
            addressModeU: addrU,
            addressModeV: addrV,
            minFilter: wMin,
            magFilter: wMag,
            mipmapFilter: wMip,
            maxAnisotropy: aniso,
        });
        this.samplerCache.set(key, sampler);
        return sampler;
    }

    private getOrCreateBindGroup(
        device: GPUDevice,
        sampler0: GPUSampler,
        view0: GPUTextureView,
        sampler1: GPUSampler,
        view1: GPUTextureView,
    ): GPUBindGroup {
        const layout = this.bindGroupLayout!;
        const uniformBuffer = this.uniformBuffer!;
        const key = `${this.getWeakId(this.samplerIds, sampler0)}|${this.getWeakId(this.textureViewIds, view0)}|${this.getWeakId(this.samplerIds, sampler1)}|${this.getWeakId(this.textureViewIds, view1)}`;
        const cached = this.bindGroupCache.get(key);
        if (cached) return cached;

        const bindGroup = device.createBindGroup({
            layout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer, size: UNIFORM_BLOCK_SIZE } },
                { binding: 1, resource: sampler0 },
                { binding: 2, resource: view0 },
                { binding: 3, resource: sampler1 },
                { binding: 4, resource: view1 },
            ],
        });
        this.bindGroupCache.set(key, bindGroup);
        if (this.bindGroupCache.size > 4096) {
            this.bindGroupCache.clear();
            this.bindGroupCache.set(key, bindGroup);
        }
        return bindGroup;
    }

    private getOrCreatePipeline(device: GPUDevice, cfg: OpenGLPipelineConfig): GPURenderPipeline {
        const key = pipelineConfigKey(cfg);
        const cached = this.pipelineCache.get(key);
        if (cached) return cached;

        const colorWriteMask =
            (cfg.colorMaskR ? GPUColorWrite.RED : 0) |
            (cfg.colorMaskG ? GPUColorWrite.GREEN : 0) |
            (cfg.colorMaskB ? GPUColorWrite.BLUE : 0) |
            (cfg.colorMaskA ? GPUColorWrite.ALPHA : 0);

        const cullMode: GPUCullMode =
            !cfg.cullEnabled ? "none"
                : cfg.cullFace === GL_FRONT ? "front"
                    : cfg.cullFace === GL_BACK ? "back"
                        : "none";

        const frontFace: GPUFrontFace = cfg.frontFace === GL_CCW ? "ccw" : "cw";
        const blend: GPUBlendState | undefined = cfg.blendEnabled
            ? {
                color: {
                    srcFactor: this.mapBlendFactor(cfg.blendSrc),
                    dstFactor: this.mapBlendFactor(cfg.blendDst),
                    operation: "add",
                },
                alpha: {
                    srcFactor: this.mapBlendFactor(cfg.blendSrc),
                    dstFactor: this.mapBlendFactor(cfg.blendDst),
                    operation: "add",
                },
            }
            : undefined;

        const depthCompare = cfg.depthTest ? this.mapCompareFunc(cfg.depthFunc) : "always";
        const stencilCompare = cfg.stencilTest ? this.mapCompareFunc(cfg.stencilFunc) : "always";
        const stencilFront: GPUStencilFaceState = {
            compare: stencilCompare,
            failOp: cfg.stencilTest ? this.mapStencilOp(cfg.stencilFail) : "keep",
            depthFailOp: cfg.stencilTest ? this.mapStencilOp(cfg.stencilZFail) : "keep",
            passOp: cfg.stencilTest ? this.mapStencilOp(cfg.stencilZPass) : "keep",
        };

        const pipeline = device.createRenderPipeline({
            layout: this.pipelineLayout!,
            vertex: {
                module: this.shaderModule!,
                entryPoint: "vs_main",
                buffers: [{
                    arrayStride: VERTEX_BYTE_STRIDE,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x4" },
                        { shaderLocation: 1, offset: 16, format: "float32x4" },
                        { shaderLocation: 2, offset: 32, format: "float32x2" },
                        { shaderLocation: 3, offset: 40, format: "float32x2" },
                    ],
                }],
            },
            fragment: {
                module: this.shaderModule!,
                entryPoint: "fs_main",
                targets: [{
                    format: this.targetFormat ?? "bgra8unorm",
                    blend,
                    writeMask: colorWriteMask,
                }],
            },
            primitive: {
                topology: cfg.topology,
                frontFace,
                cullMode,
            },
            depthStencil: {
                format: "depth24plus-stencil8",
                // In OpenGL depth writes happen only when depth test is enabled.
                depthWriteEnabled: cfg.depthTest && cfg.depthWrite,
                depthCompare,
                stencilFront,
                stencilBack: stencilFront,
                stencilReadMask: cfg.stencilMask >>> 0,
                stencilWriteMask: cfg.stencilTest ? (cfg.stencilWriteMask >>> 0) : 0,
            },
        });
        this.pipelineCache.set(key, pipeline);
        return pipeline;
    }

    private writeUniforms(
        queue: GPUQueue,
        offset: number,
        _screenW: number,
        _screenH: number,
        I: Int32Array,
        F: Float32Array,
        i: number,
        f: number,
        useTex0: boolean,
        useTex1: boolean,
    ): void {
        this.uniformScratchF32.fill(0);
        const flags = I[i + CI_FLAGS];
        const vpW = I[i + CI_VP_W];
        const vpH = I[i + CI_VP_H];

        // 0..16 — use the viewport dimensions that were active when vertices were
        // transformed (in transformVertices), NOT the canvas size. The vertex shader
        // reverses the viewport transform: ndcX = (pos.x / screen.x) * 2 - 1, so
        // screen.x must match the viewportW used in the JS-side viewport transform.
        this.uniformScratchF32[0] = vpW > 0 ? vpW : _screenW;
        this.uniformScratchF32[1] = vpH > 0 ? vpH : _screenH;
        this.uniformScratchF32[2] = this.clamp01(F[f + CF_ALPHA_REF]);

        // 16..48 (u32s)
        this.uniformScratchU32[4] = I[i + CI_ALPHA_FUNC] >>> 0;
        this.uniformScratchU32[5] = I[i + CI_TEXENV0] >>> 0;
        this.uniformScratchU32[6] = I[i + CI_TEXENV1] >>> 0;
        this.uniformScratchU32[7] = (flags & DF_ALPHA_TEST) !== 0 ? 1 : 0;
        this.uniformScratchU32[8] = useTex0 ? 1 : 0;
        this.uniformScratchU32[9] = useTex1 ? 1 : 0;
        this.uniformScratchU32[10] = (flags & DF_FOG) !== 0 ? 1 : 0;
        this.uniformScratchU32[11] = I[i + CI_FOG_MODE] >>> 0;

        // 48..64
        this.uniformScratchF32[12] = Math.max(0, F[f + CF_FOG_DENSITY]);
        this.uniformScratchF32[13] = F[f + CF_FOG_START];
        this.uniformScratchF32[14] = F[f + CF_FOG_END];

        // 64..80 fogColor
        this.uniformScratchF32[16] = this.clamp01(F[f + CF_FOG_R]);
        this.uniformScratchF32[17] = this.clamp01(F[f + CF_FOG_G]);
        this.uniformScratchF32[18] = this.clamp01(F[f + CF_FOG_B]);
        this.uniformScratchF32[19] = this.clamp01(F[f + CF_FOG_A]);

        // 80..84 — reversed glDepthRange (see readDepthRange): the sorted pair goes to
        // setViewport, the mirroring happens here. writeUniforms runs before the
        // setViewport that consumes the same read.
        this.readDepthRange(F, f);
        this.uniformScratchU32[20] = this.depthRangeReversed ? 1 : 0;

        // 84..100 — packed GL_COMBINE words, decoded in the shader by the same layout
        // context.ts encodes them with.
        this.uniformScratchU32[21] = I[i + CI_COMBINE0_RGB] >>> 0;
        this.uniformScratchU32[22] = I[i + CI_COMBINE0_ALPHA] >>> 0;
        this.uniformScratchU32[23] = I[i + CI_COMBINE1_RGB] >>> 0;
        this.uniformScratchU32[24] = I[i + CI_COMBINE1_ALPHA] >>> 0;

        // 112..144 — GL_TEXTURE_ENV_COLOR per unit (vec4 alignment leaves 100..112 pad)
        for (let k = 0; k < 4; k++) {
            this.uniformScratchF32[28 + k] = this.clamp01(F[f + CF_ENV_COLOR0 + k]);
            this.uniformScratchF32[32 + k] = this.clamp01(F[f + CF_ENV_COLOR1 + k]);
        }

        queue.writeBuffer(this.uniformBuffer!, offset, this.uniformScratchBuffer, 0, UNIFORM_BLOCK_SIZE);
    }

    private applyScissor(
        pass: GPURenderPassEncoder,
        I: Int32Array,
        i: number,
        flags: number,
        screenW: number,
        screenH: number,
    ): boolean {
        if ((flags & DF_SCISSOR) === 0) {
            pass.setScissorRect(0, 0, screenW, screenH);
            return true;
        }

        const sx = I[i + CI_SCISSOR_X];
        const sy = I[i + CI_SCISSOR_Y];
        const sw = Math.max(0, I[i + CI_SCISSOR_W]);
        const sh = Math.max(0, I[i + CI_SCISSOR_H]);

        // OpenGL scissor origin is lower-left, WebGPU scissor origin is top-left.
        const x = this.clampInt(sx, 0, screenW);
        const y = this.clampInt(screenH - (sy + sh), 0, screenH);
        const w = this.clampInt(sw, 0, screenW - x);
        const h = this.clampInt(sh, 0, screenH - y);
        if (w <= 0 || h <= 0) {
            return false;
        }

        pass.setScissorRect(x, y, w, h);
        return true;
    }

    /**
     * glDepthRange(near, far) as WebGPU can express it.
     *
     * GL clamps both to [0,1] and explicitly ALLOWS near > far (a reversed mapping);
     * WebGPU's setViewport rejects minDepth > maxDepth and invalidates the whole command
     * buffer, so the frame is dropped and the canvas shows an unwritten swap image. Hand
     * setViewport the sorted pair and tell the vertex shader to mirror its normalized depth
     * (t → 1-t), which reproduces GL's z_window bit for bit.
     *
     * Results land in depthRangeMin/Max/Reversed — a per-draw call, so no object per draw.
     */
    private readDepthRange(F: Float32Array, f: number): void {
        const rawNear = F[f + CF_DEPTH_RANGE_NEAR];
        const rawFar = F[f + CF_DEPTH_RANGE_FAR];
        const near = this.clamp01(Number.isFinite(rawNear) ? rawNear : 0);
        const far = this.clamp01(Number.isFinite(rawFar) ? rawFar : 1);
        this.depthRangeReversed = near > far;
        this.depthRangeMin = this.depthRangeReversed ? far : near;
        this.depthRangeMax = this.depthRangeReversed ? near : far;
    }

    private encodeClearPass(
        encoder: GPUCommandEncoder,
        mask: number,
        r: number,
        g: number,
        b: number,
        a: number,
        depth: number,
        stencil: number,
        colorHasContent: boolean,
        depthStencilHasContent: boolean,
    ): boolean {
        if (!this.offscreenView || !this.depthView) return false;
        const clearColor = (mask & GL_COLOR_BUFFER_BIT) !== 0;
        const clearDepth = (mask & GL_DEPTH_BUFFER_BIT) !== 0;
        const clearStencil = (mask & GL_STENCIL_BUFFER_BIT) !== 0;
        if (!clearColor && !clearDepth && !clearStencil) return false;

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.offscreenView,
                loadOp: clearColor ? "clear" : (colorHasContent ? "load" : "clear"),
                clearValue: clearColor
                    ? { r: this.clamp01(r), g: this.clamp01(g), b: this.clamp01(b), a: this.clamp01(a) }
                    : { r: 0, g: 0, b: 0, a: 1 },
                storeOp: "store",
            }],
            depthStencilAttachment: {
                view: this.depthView,
                depthLoadOp: clearDepth ? "clear" : (depthStencilHasContent ? "load" : "clear"),
                depthClearValue: clearDepth ? this.clamp01(depth) : 1,
                depthStoreOp: "store",
                stencilLoadOp: clearStencil ? "clear" : (depthStencilHasContent ? "load" : "clear"),
                stencilClearValue: clearStencil ? (stencil >>> 0) : 0,
                stencilStoreOp: "store",
            },
        });
        pass.end();
        return true;
    }

    private mapBlendFactor(factor: number): GPUBlendFactor {
        switch (factor >>> 0) {
            case GL_ZERO: return "zero";
            case GL_ONE: return "one";
            case GL_SRC_COLOR: return "src";
            case GL_ONE_MINUS_SRC_COLOR: return "one-minus-src";
            case GL_DST_COLOR: return "dst";
            case GL_ONE_MINUS_DST_COLOR: return "one-minus-dst";
            case GL_SRC_ALPHA: return "src-alpha";
            case GL_ONE_MINUS_SRC_ALPHA: return "one-minus-src-alpha";
            case GL_DST_ALPHA: return "dst-alpha";
            case GL_ONE_MINUS_DST_ALPHA: return "one-minus-dst-alpha";
            case GL_SRC_ALPHA_SATURATE: return "src-alpha-saturated";
            default: return "one";
        }
    }

    private mapCompareFunc(func: number): GPUCompareFunction {
        switch (func >>> 0) {
            case GL_NEVER: return "never";
            case GL_LESS: return "less";
            case GL_EQUAL: return "equal";
            case GL_LEQUAL: return "less-equal";
            case GL_GREATER: return "greater";
            case GL_NOTEQUAL: return "not-equal";
            case GL_GEQUAL: return "greater-equal";
            case GL_ALWAYS: return "always";
            default: return "always";
        }
    }

    private mapStencilOp(op: number): GPUStencilOperation {
        switch (op >>> 0) {
            case GL_ZERO: return "zero";
            case GL_KEEP: return "keep";
            case GL_REPLACE: return "replace";
            case GL_INCR: return "increment-clamp";
            case GL_DECR: return "decrement-clamp";
            default: return "keep";
        }
    }

    private mapAddressMode(wrap: number): GPUAddressMode {
        switch (wrap >>> 0) {
            case GL_REPEAT:
                return "repeat";
            case GL_CLAMP:
            case GL_CLAMP_TO_EDGE:
                return "clamp-to-edge";
            default:
                return "repeat";
        }
    }

    private mapMinMagFilter(filter: number): GPUFilterMode {
        switch (filter >>> 0) {
            case GL_NEAREST:
            case GL_NEAREST_MIPMAP_NEAREST:
            case GL_NEAREST_MIPMAP_LINEAR:
                return "nearest";
            default:
                return "linear";
        }
    }

    private mapMipmapFilter(filter: number): GPUFilterMode {
        switch (filter >>> 0) {
            case GL_NEAREST_MIPMAP_LINEAR:
            case GL_LINEAR_MIPMAP_LINEAR:
                return "linear";
            case GL_NEAREST_MIPMAP_NEAREST:
            case GL_LINEAR_MIPMAP_NEAREST:
                return "nearest";
            default:
                return "linear";
        }
    }

    private getWeakId<T extends object>(map: WeakMap<T, number>, obj: T): number {
        const existing = map.get(obj);
        if (existing !== undefined) return existing;
        const id = this.nextObjectId++;
        map.set(obj, id);
        return id;
    }

    private nextPow2(value: number): number {
        let v = Math.max(1, value | 0);
        v--;
        v |= v >> 1;
        v |= v >> 2;
        v |= v >> 4;
        v |= v >> 8;
        v |= v >> 16;
        return v + 1;
    }

    private clamp01(v: number): number {
        if (v <= 0) return 0;
        if (v >= 1) return 1;
        return v;
    }

    private clampInt(v: number, min: number, max: number): number {
        if (v < min) return min;
        if (v > max) return max;
        return v | 0;
    }

    private buildShaderCode(): string {
        return `
struct Uniforms {
    screen: vec2f,          // 0..8
    alphaRef: f32,          // 8..12
    _pad0: f32,             // 12..16
    alphaFunc: u32,         // 16..20
    texEnv0: u32,           // 20..24
    texEnv1: u32,           // 24..28
    alphaTestEnabled: u32,  // 28..32
    useTex0: u32,           // 32..36
    useTex1: u32,           // 36..40
    fogEnabled: u32,        // 40..44
    fogMode: u32,           // 44..48
    fogDensity: f32,        // 48..52
    fogStart: f32,          // 52..56
    fogEnd: f32,            // 56..60
    _pad1: f32,             // 60..64
    fogColor: vec4f,        // 64..80
    depthFlip: u32,         // 80..84
    comb0Rgb: u32,          // 84..88
    comb0Alpha: u32,        // 88..92
    comb1Rgb: u32,          // 92..96
    comb1Alpha: u32,        // 96..100
    _pad2: u32,             // 100..104
    _pad3: u32,             // 104..108
    _pad4: u32,             // 108..112
    envColor0: vec4f,       // 112..128
    envColor1: vec4f,       // 128..144
};

struct VertexIn {
    @location(0) pos: vec4f,
    @location(1) color: vec4f,
    @location(2) uv0: vec2f,
    @location(3) uv1: vec2f,
};

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
    @location(1) uv0: vec2f,
    @location(2) uv1: vec2f,
    @location(3) fogCoord: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp0: sampler;
@group(0) @binding(2) var tex0: texture_2d<f32>;
@group(0) @binding(3) var samp1: sampler;
@group(0) @binding(4) var tex1: texture_2d<f32>;

// ---- ARB/EXT_texture_env_combine ----
//
// The packed word layout is defined in modules/opengl32/context.ts; these decoders are
// the other half of that contract. GL_COMBINE is the reason an engine drops its
// multi-pass lightmap path, so evaluating it as plain MODULATE is not a lost effect —
// it is the wrong image for geometry the engine deliberately stopped drawing twice.

fn combSource(src: u32, texel: vec4f, primary: vec4f, previous: vec4f, konst: vec4f) -> vec4f {
    if (src == ${COMBINER_SRC_CONSTANT}u) { return konst; }
    if (src == ${COMBINER_SRC_PRIMARY}u) { return primary; }
    if (src == ${COMBINER_SRC_PREVIOUS}u) { return previous; }
    return texel;
}

fn combOperandRgb(op: u32, v: vec4f) -> vec3f {
    if (op == ${COMBINER_OP_ONE_MINUS_SRC_COLOR}u) { return vec3f(1.0) - v.rgb; }
    if (op == ${COMBINER_OP_SRC_ALPHA}u) { return vec3f(v.a); }
    if (op == ${COMBINER_OP_ONE_MINUS_SRC_ALPHA}u) { return vec3f(1.0 - v.a); }
    return v.rgb;
}

// Alpha arguments accept only SRC_ALPHA / ONE_MINUS_SRC_ALPHA.
fn combOperandAlpha(op: u32, v: vec4f) -> f32 {
    if (op == ${COMBINER_OP_ONE_MINUS_SRC_ALPHA}u) { return 1.0 - v.a; }
    return v.a;
}

fn combArg(word: u32, index: u32, texel: vec4f, primary: vec4f, previous: vec4f, konst: vec4f) -> vec4f {
    let shift = 4u + index * 4u;
    let src = (word >> shift) & 3u;
    return combSource(src, texel, primary, previous, konst);
}

fn combOpBits(word: u32, index: u32) -> u32 {
    return (word >> (6u + index * 4u)) & 3u;
}

fn combineRgb(word: u32, texel: vec4f, primary: vec4f, previous: vec4f, konst: vec4f) -> vec3f {
    let fn_ = word & 15u;
    let a0 = combOperandRgb(combOpBits(word, 0u), combArg(word, 0u, texel, primary, previous, konst));
    let a1 = combOperandRgb(combOpBits(word, 1u), combArg(word, 1u, texel, primary, previous, konst));
    let a2 = combOperandRgb(combOpBits(word, 2u), combArg(word, 2u, texel, primary, previous, konst));
    var rgb: vec3f;
    if (fn_ == ${COMBINER_FN_REPLACE}u) { rgb = a0; }
    else if (fn_ == ${COMBINER_FN_ADD}u) { rgb = a0 + a1; }
    else if (fn_ == ${COMBINER_FN_ADD_SIGNED}u) { rgb = a0 + a1 - vec3f(0.5); }
    else if (fn_ == ${COMBINER_FN_INTERPOLATE}u) { rgb = a0 * a2 + a1 * (vec3f(1.0) - a2); }
    else if (fn_ == ${COMBINER_FN_SUBTRACT}u) { rgb = a0 - a1; }
    else if (fn_ == ${COMBINER_FN_DOT3_RGB}u || fn_ == ${COMBINER_FN_DOT3_RGBA}u) {
        rgb = vec3f(4.0 * dot(a0 - vec3f(0.5), a1 - vec3f(0.5)));
    }
    else { rgb = a0 * a1; }   // ${COMBINER_FN_MODULATE}
    let scale = f32(1u << ((word >> 16u) & 3u));
    return clamp(rgb * scale, vec3f(0.0), vec3f(1.0));
}

fn combineAlpha(word: u32, rgbWord: u32, texel: vec4f, primary: vec4f, previous: vec4f, konst: vec4f) -> f32 {
    // DOT3_RGBA replaces alpha with the same dot product, ignoring the alpha combiner.
    if ((rgbWord & 15u) == ${COMBINER_FN_DOT3_RGBA}u) {
        return combineRgb(rgbWord, texel, primary, previous, konst).r;
    }
    let fn_ = word & 15u;
    let a0 = combOperandAlpha(combOpBits(word, 0u), combArg(word, 0u, texel, primary, previous, konst));
    let a1 = combOperandAlpha(combOpBits(word, 1u), combArg(word, 1u, texel, primary, previous, konst));
    let a2 = combOperandAlpha(combOpBits(word, 2u), combArg(word, 2u, texel, primary, previous, konst));
    var a: f32;
    if (fn_ == ${COMBINER_FN_REPLACE}u) { a = a0; }
    else if (fn_ == ${COMBINER_FN_ADD}u) { a = a0 + a1; }
    else if (fn_ == ${COMBINER_FN_ADD_SIGNED}u) { a = a0 + a1 - 0.5; }
    else if (fn_ == ${COMBINER_FN_INTERPOLATE}u) { a = a0 * a2 + a1 * (1.0 - a2); }
    else if (fn_ == ${COMBINER_FN_SUBTRACT}u) { a = a0 - a1; }
    else { a = a0 * a1; }
    let scale = f32(1u << ((word >> 16u) & 3u));
    return clamp(a * scale, 0.0, 1.0);
}

fn applyTexEnv(
    mode: u32, incoming: vec4f, texel: vec4f,
    primary: vec4f, combRgb: u32, combAlpha: u32, konst: vec4f,
) -> vec4f {
    if (mode == ${GL_REPLACE}u) {
        return texel;
    }
    if (mode == ${GL_DECAL}u) {
        return vec4f(mix(incoming.rgb, texel.rgb, texel.a), incoming.a);
    }
    if (mode == ${GL_ADD}u) {
        return vec4f(min(incoming.rgb + texel.rgb, vec3f(1.0)), min(incoming.a + texel.a, 1.0));
    }
    if (mode == ${GL_COMBINE}u) {
        return vec4f(
            combineRgb(combRgb, texel, primary, incoming, konst),
            combineAlpha(combAlpha, combRgb, texel, primary, incoming, konst),
        );
    }
    return incoming * texel; // GL_MODULATE / default
}

fn alphaTestPass(alpha: f32, refValue: f32, func: u32) -> bool {
    if (func == ${GL_NEVER}u) { return false; }
    if (func == ${GL_LESS}u) { return alpha < refValue; }
    if (func == ${GL_EQUAL}u) { return alpha == refValue; }
    if (func == ${GL_LEQUAL}u) { return alpha <= refValue; }
    if (func == ${GL_GREATER}u) { return alpha > refValue; }
    if (func == ${GL_NOTEQUAL}u) { return alpha != refValue; }
    if (func == ${GL_GEQUAL}u) { return alpha >= refValue; }
    return true; // GL_ALWAYS / default
}

fn computeFogFactor(mode: u32, density: f32, start: f32, end: f32, coord: f32) -> f32 {
    if (mode == ${GL_EXP}u) {
        return clamp(exp(-density * coord), 0.0, 1.0);
    }
    if (mode == ${GL_EXP2}u) {
        let d = density * coord;
        return clamp(exp(-(d * d)), 0.0, 1.0);
    }
    if (mode == ${GL_LINEAR}u) {
        let range = max(end - start, 1e-6);
        return clamp((end - coord) / range, 0.0, 1.0);
    }
    return 1.0;
}

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
    var out: VertexOut;
    // Pass clip-space coordinates — GPU handles perspective divide, clipping,
    // and viewport transform. Remap Z from OpenGL [-w,w] to WebGPU [0,w]; depthFlip
    // mirrors it for a reversed glDepthRange, whose sorted pair the viewport carries.
    let zHalf = input.pos.z * 0.5 + input.pos.w * 0.5;
    let zOut = select(zHalf, input.pos.w - zHalf, uniforms.depthFlip != 0u);
    out.position = vec4f(input.pos.x, input.pos.y, zOut, input.pos.w);
    out.color = input.color;
    out.uv0 = input.uv0;
    out.uv1 = input.uv1;
    // Approximate fog from clip-space depth (NDC z mapped to [0,1])
    let w = max(abs(input.pos.w), 0.0001);
    out.fogCoord = clamp(input.pos.z / w * 0.5 + 0.5, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
    var color = input.color;

    // GL_PRIMARY_COLOR is the fragment's interpolated colour for EVERY unit; GL_PREVIOUS
    // is the running result, which at unit 0 is the same thing.
    let primary = input.color;
    if (uniforms.useTex0 != 0u) {
        let t0 = textureSample(tex0, samp0, input.uv0);
        color = applyTexEnv(uniforms.texEnv0, color, t0, primary,
                            uniforms.comb0Rgb, uniforms.comb0Alpha, uniforms.envColor0);
    }
    if (uniforms.useTex1 != 0u) {
        let t1 = textureSample(tex1, samp1, input.uv1);
        color = applyTexEnv(uniforms.texEnv1, color, t1, primary,
                            uniforms.comb1Rgb, uniforms.comb1Alpha, uniforms.envColor1);
    }

    color = vec4f(clamp(color.rgb, vec3f(0.0), vec3f(1.0)), clamp(color.a, 0.0, 1.0));

    if (uniforms.alphaTestEnabled != 0u && !alphaTestPass(color.a, uniforms.alphaRef, uniforms.alphaFunc)) {
        discard;
    }

    if (uniforms.fogEnabled != 0u) {
        let fogF = computeFogFactor(uniforms.fogMode, uniforms.fogDensity, uniforms.fogStart, uniforms.fogEnd, input.fogCoord);
        color = vec4f(mix(uniforms.fogColor.rgb, color.rgb, fogF), color.a);
    }

    return color;
}
`;
    }
}
