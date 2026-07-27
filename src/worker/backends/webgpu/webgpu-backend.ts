import { RenderBackend } from "../../runtime/runtime-services";
import { Logger, LogCategory } from "../../core/logger";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { PostFxChain } from "./postfx/post-fx-chain";
import { desktopBackground } from "../../runtime/desktop-background";

export class WebGPUBackend implements RenderBackend {
    readonly kind = "webgpu";
    private device: GPUDevice | null = null;
    private queue: GPUQueue | null = null;
    private context: GPUCanvasContext | null = null;
    private format: GPUTextureFormat | null = null;
    private bcSupported = false;
    /** Readable copy of the last presented canvas image (see mirrorPresentedFrame). */
    private screenMirror: GPUTexture | null = null;

    // Compositing resources
    private overlayPipeline: GPURenderPipeline | null = null;
    private overlayPipelineOpaque: GPURenderPipeline | null = null;
    private overlayPipelineFormat: GPUTextureFormat | null = null;
    private overlayTexture: GPUTexture | null = null;
    private overlayTextureView: GPUTextureView | null = null;
    private overlaySampler: GPUSampler | null = null;
    private overlayNearestSampler: GPUSampler | null = null;
    private overlayVertexBuffer: GPUBuffer | null = null;
    private overlayBindGroup: GPUBindGroup | null = null;
    
    // Rect compositing resources (positioned quad for video subregions)
    private rectVertexBuffer: GPUBuffer | null = null;
    // Growable vertex buffer for blitRects (N sub-rect quads per call)
    private rectsVertexBuffer: GPUBuffer | null = null;
    private rectsVertexBufferCapacity = 0;

    // Stats overlay resources (positioned quad at bottom-left)
    private statsTexture: GPUTexture | null = null;
    private statsTextureView: GPUTextureView | null = null;
    private statsBindGroup: GPUBindGroup | null = null;
    private statsVertexBuffer: GPUBuffer | null = null;

    // BindGroup cache for drawTexture to avoid per-frame allocations
    private bindGroupCache = new WeakMap<GPUTextureView, GPUBindGroup>();
    private nearestBindGroupCache = new WeakMap<GPUTextureView, GPUBindGroup>();

    // RGB565 conversion pipeline and resources
    private rgb565Pipeline: GPURenderPipeline | null = null;
    private rgb565BindGroupCache = new WeakMap<GPUTextureView, GPUBindGroup>();

    // Unified present / post-process chain (gamma, user color grade, FXAA, scaling, post-FX).
    // Owns what the old per-backend gamma pipeline used to. Created in initialize().
    private postFx: PostFxChain | null = null;


    async initialize(canvas: OffscreenCanvas): Promise<void> {
        if (!("gpu" in navigator)) {
            throw new Error("WebGPU unavailable: navigator.gpu is absent — this browser/worker does not expose the WebGPU API.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("WebGPU unavailable: requestAdapter() returned no adapter — no usable GPU (hardware acceleration disabled, GPU blocklisted, or VM/Remote Desktop with no GPU).");
        }

        // Request BC (DXT/S3TC) texture compression when the adapter supports it so
        // the D3D9 backend can upload DXT1/3/5 textures as native bc1/2/3-rgba-unorm
        // (hardware-decoded, like a real driver). Universally available on desktop;
        // when absent the D3D9 path falls back to CPU block decode.
        const requiredFeatures: GPUFeatureName[] = [];
        if (adapter.features.has("texture-compression-bc")) {
            requiredFeatures.push("texture-compression-bc");
        }
        this.device = await adapter.requestDevice({ requiredFeatures });
        this.bcSupported = this.device.features.has("texture-compression-bc");
        this.queue = this.device.queue;

        // Monitor device loss — after this fires, all GPU ops are no-ops (black screen)
        this.device.lost.then((info) => {
            Logger.error(LogCategory.SYSTEM,
                `[WEBGPU] Device LOST! reason=${info.reason} message="${info.message}"`);
        });

        // DIAGNOSTIC: Catch WebGPU validation errors that silently drop draw calls
        this.device.onuncapturederror = (event: GPUUncapturedErrorEvent) => {
            Logger.error(LogCategory.DDRAW,
                `[WEBGPU] Uncaptured error: ${event.error.message}`);
        };

        this.context = canvas.getContext("webgpu") as GPUCanvasContext | null;
        if (!this.context) {
            throw new Error("WebGPU unavailable: OffscreenCanvas.getContext('webgpu') returned null despite a valid device.");
        }

        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: "opaque",
            // COPY_SRC so the presented frame can be mirrored into a readable texture:
            // once presented, the canvas image belongs to the compositor and is no longer
            // reliably readable (see mirrorPresentedFrame).
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        });

        this.postFx = new PostFxChain(this.device, () => EmulatorConfig.getInstance().quality);
        this.postFx.setFormat(this.format);
    }

    /**
     * Reconfigure the WebGPU canvas context after canvas.width/height change.
     * Setting canvas dimensions resets the OffscreenCanvas drawing surface,
     * which unconfigures the GPUCanvasContext. Without reconfiguration,
     * getCurrentTexture() may return textures that render to a detached
     * swap chain — GPU commands succeed silently but pixels never appear.
     */
    reconfigure(): void {
        if (!this.context || !this.device || !this.format) return;
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: "opaque",
            // COPY_SRC so the presented frame can be mirrored into a readable texture:
            // once presented, the canvas image belongs to the compositor and is no longer
            // reliably readable (see mirrorPresentedFrame).
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        });
        // Invalidate bind group caches — old texture views are now stale
        this.bindGroupCache = new WeakMap();
        this.nearestBindGroupCache = new WeakMap();
        this.postFx?.invalidate();
    }

    getDevice(): GPUDevice | null {
        return this.device;
    }

    getQueue(): GPUQueue | null {
        return this.queue;
    }

    getContext(): GPUCanvasContext | null {
        return this.context;
    }

    getScreenCanvas(): OffscreenCanvas | null {
        return (this.context?.canvas as OffscreenCanvas | undefined) ?? null;
    }

    /**
     * Copy the frame just submitted to the canvas into a mirror texture we own.
     *
     * A presented WebGPU canvas is NOT reliably readable: once the compositor takes the
     * swap image, createImageBitmap() yields a 0x0 bitmap and convertToBlob() throws
     * "Readback of the source image has failed" — measured on a static GDI screen and on
     * every paused frame. This copy, encoded while the texture is still the current one,
     * is the only exact record of what the user saw. Called from RenderService.notifyPresent
     * (every present path funnels through it) and only while a screenshot consumer has
     * armed it, so a normal run pays nothing.
     */
    mirrorPresentedFrame(): void {
        const device = this.device, queue = this.queue, ctx = this.context, format = this.format;
        if (!device || !queue || !ctx || !format) return;
        let tex: GPUTexture;
        try {
            tex = ctx.getCurrentTexture();
        } catch {
            return; // canvas unconfigured this frame
        }
        if (!tex.width || !tex.height) return;
        if (!this.screenMirror || this.screenMirror.width !== tex.width || this.screenMirror.height !== tex.height) {
            this.screenMirror?.destroy();
            this.screenMirror = device.createTexture({
                size: { width: tex.width, height: tex.height, depthOrArrayLayers: 1 },
                format,
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
            });
        }
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToTexture(
            { texture: tex }, { texture: this.screenMirror },
            { width: tex.width, height: tex.height, depthOrArrayLayers: 1 },
        );
        queue.submit([encoder.finish()]);
    }

    /** PNG of the mirrored frame (see mirrorPresentedFrame); null until one was mirrored. */
    async captureMirroredFrame(): Promise<Blob | null> {
        const device = this.device, queue = this.queue, mirror = this.screenMirror;
        if (!device || !queue || !mirror) return null;
        const width = mirror.width, height = mirror.height;
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const readback = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture: mirror }, { buffer: readback, bytesPerRow },
                { width, height, depthOrArrayLayers: 1 },
            );
            queue.submit([encoder.finish()]);
            await queue.onSubmittedWorkDone();
            await readback.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(readback.getMappedRange());
            const pixels = new Uint8ClampedArray(width * height * 4);
            const swapRB = this.format === "bgra8unorm";
            for (let y = 0; y < height; y++) {
                let s = y * bytesPerRow, d = y * width * 4;
                for (let x = 0; x < width; x++, s += 4, d += 4) {
                    pixels[d] = mapped[s + (swapRB ? 2 : 0)]!;
                    pixels[d + 1] = mapped[s + 1]!;
                    pixels[d + 2] = mapped[s + (swapRB ? 0 : 2)]!;
                    pixels[d + 3] = 255; // the canvas is alphaMode:"opaque"
                }
            }
            readback.unmap();
            const canvas = new OffscreenCanvas(width, height);
            const ctx2d = canvas.getContext("2d");
            if (!ctx2d) return null;
            ctx2d.putImageData(new ImageData(pixels, width, height), 0, 0);
            return await canvas.convertToBlob({ type: "image/png" });
        } finally {
            readback.destroy();
        }
    }

    getFormat(): GPUTextureFormat | null {
        return this.format;
    }

    /** True when the device exposes BC (DXT/S3TC) compressed texture formats. */
    supportsBC(): boolean {
        return this.bcSupported;
    }

    /**
     * Check if overlay texture exists
     */
    hasOverlayTexture(): boolean {
        return this.overlayTexture !== null && this.overlayTextureView !== null;
    }

    /**
     * Get debug info for debug panel
     */
    getDebugInfo(): {
        overlayTexture?: {
            width: number;
            height: number;
            format: string;
        };
        deviceInfo: {
            format: string;
            hasDevice: boolean;
            hasQueue: boolean;
            hasContext: boolean;
        };
    } {
        return {
            overlayTexture: this.overlayTexture ? {
                width: this.overlayTexture.width,
                height: this.overlayTexture.height,
                format: this.overlayTexture.format,
            } : undefined,
            deviceInfo: {
                format: this.format || "unknown",
                hasDevice: !!this.device,
                hasQueue: !!this.queue,
                hasContext: !!this.context,
            },
        };
    }

    /**
     * Composite an overlay canvas onto the main canvas.
     * 
     * Note: By default, this method does NOT clear the swapchain (loadOp: "load").
     * This allows compositing UI/overlay on top of existing 3D scene rendered by DDraw backend.
     * 
     * If clearScreen=true, performs explicit clear pass first (for GDI-only mode or full-screen UI).
     * 
     * @param overlay - Canvas to composite on top
     * @param clearScreen - If true, clear swapchain before compositing (default: false)
     */
    composite(overlay: OffscreenCanvas, clearScreen: boolean = false): void {
        if (!this.device || !this.context || !this.queue) return;

        const encoder = this.device.createCommandEncoder();
        const targetView = this.context.getCurrentTexture().createView();

        // If clearScreen is requested (GDI mode), do explicit clear pass
        // Otherwise, renderOverlay will use loadOp: "load" to preserve existing content
        if (clearScreen) {
            const clearPass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: targetView,
                    clearValue: desktopBackground.getClearColor(),
                    loadOp: "clear",
                    storeOp: "store",
                }],
            });
            clearPass.end();
        }

        // Render overlay on top (loadOp: "load" inside renderOverlay preserves 3D scene)
        this.blit(overlay, targetView, encoder);
        
        this.queue.submit([encoder.finish()]);
    }

    /**
     * Composite an overlay canvas into a specific pixel rect on screen.
     * Converts pixel coordinates to NDC and renders a positioned quad.
     */
    compositeRect(
        overlay: OffscreenCanvas,
        dstX: number, dstY: number,
        dstW: number, dstH: number,
        screenW: number, screenH: number,
        clearScreen: boolean = false,
    ): void {
        if (!this.device || !this.context || !this.queue || screenW <= 0 || screenH <= 0) return;

        // Upload overlay to texture
        this.updateOverlayTexture(overlay);
        if (!this.overlayTextureView) return;

        // Ensure pipeline exists
        if (!this.overlayPipeline || this.overlayPipelineFormat !== this.format) {
            this.createOverlayPipeline();
            this.overlayPipelineFormat = this.format;
            this.overlayBindGroup = null;
        }

        // Pixel rect → NDC
        // NDC: x=-1 left, x=+1 right, y=-1 bottom, y=+1 top
        // Pixel origin: top-left (0,0)
        const x0 = (dstX / screenW) * 2 - 1;
        const x1 = ((dstX + dstW) / screenW) * 2 - 1;
        const y1 = 1 - (dstY / screenH) * 2;           // top edge
        const y0 = 1 - ((dstY + dstH) / screenH) * 2;  // bottom edge

        const vertices = new Float32Array([
            x0, y0, 0, 1,   // bottom-left
            x1, y0, 1, 1,   // bottom-right
            x1, y1, 1, 0,   // top-right
            x0, y0, 0, 1,   // bottom-left
            x1, y1, 1, 0,   // top-right
            x0, y1, 0, 0,   // top-left
        ]);

        if (!this.rectVertexBuffer) {
            this.rectVertexBuffer = this.device.createBuffer({
                size: vertices.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
        this.queue.writeBuffer(this.rectVertexBuffer, 0, vertices);

        const encoder = this.device.createCommandEncoder();
        const targetView = this.context.getCurrentTexture().createView();

        if (clearScreen) {
            const clearPass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: targetView,
                    clearValue: desktopBackground.getClearColor(),
                    loadOp: "clear",
                    storeOp: "store",
                }],
            });
            clearPass.end();
        }

        if (!this.overlayBindGroup) {
            this.overlayBindGroup = this.device.createBindGroup({
                layout: this.overlayPipeline!.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.getSampler() },
                    { binding: 1, resource: this.overlayTextureView },
                ],
            });
        }

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetView,
                loadOp: "load",
                storeOp: "store",
            }],
        });

        renderPass.setPipeline(this.overlayPipeline!);
        renderPass.setBindGroup(0, this.overlayBindGroup);
        renderPass.setVertexBuffer(0, this.rectVertexBuffer);
        renderPass.draw(6, 1, 0, 0);
        renderPass.end();

        this.queue.submit([encoder.finish()]);
    }

    /**
     * Composite specific sub-rects of an overlay canvas onto a target, 1:1 in
     * overlay pixel space (src rect == dst rect). Used for live native dialogs
     * over a DDraw flip chain: only the dialog windows' rects are composited so
     * stale GDI overlay content elsewhere never bleeds over the game frame.
     *
     * Appends to an existing encoder (presenter frame path).
     */
    blitRects(
        overlay: OffscreenCanvas,
        target: GPUTextureView,
        encoder: GPUCommandEncoder,
        rects: Array<{ x: number; y: number; w: number; h: number }>,
    ): void {
        if (!this.device || !this.queue || rects.length === 0) return;

        const screenW = overlay.width;
        const screenH = overlay.height;
        if (screenW <= 0 || screenH <= 0) return;

        this.updateOverlayTexture(overlay);
        if (!this.overlayTextureView) return;

        if (!this.overlayPipeline || this.overlayPipelineFormat !== this.format) {
            this.createOverlayPipeline();
            this.overlayPipelineFormat = this.format;
            this.overlayBindGroup = null;
        }

        // Build one quad per rect: position in NDC, UV = same rect in overlay space.
        const verts: number[] = [];
        for (const r of rects) {
            // Clamp to overlay bounds
            const x = Math.max(0, Math.min(r.x, screenW));
            const y = Math.max(0, Math.min(r.y, screenH));
            const x2 = Math.max(x, Math.min(r.x + r.w, screenW));
            const y2 = Math.max(y, Math.min(r.y + r.h, screenH));
            if (x2 - x <= 0 || y2 - y <= 0) continue;

            const nx0 = (x / screenW) * 2 - 1;
            const nx1 = (x2 / screenW) * 2 - 1;
            const ny1 = 1 - (y / screenH) * 2;   // top edge
            const ny0 = 1 - (y2 / screenH) * 2;  // bottom edge
            const u0 = x / screenW;
            const u1 = x2 / screenW;
            const v0 = y / screenH;   // top
            const v1 = y2 / screenH;  // bottom

            verts.push(
                nx0, ny0, u0, v1,
                nx1, ny0, u1, v1,
                nx1, ny1, u1, v0,
                nx0, ny0, u0, v1,
                nx1, ny1, u1, v0,
                nx0, ny1, u0, v0,
            );
        }
        if (verts.length === 0) return;

        const vertices = new Float32Array(verts);
        if (!this.rectsVertexBuffer || this.rectsVertexBufferCapacity < vertices.byteLength) {
            this.rectsVertexBuffer?.destroy();
            this.rectsVertexBufferCapacity = Math.max(vertices.byteLength, 16 * 6 * 4 * 4);
            this.rectsVertexBuffer = this.device.createBuffer({
                size: this.rectsVertexBufferCapacity,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
        this.queue.writeBuffer(this.rectsVertexBuffer, 0, vertices);

        if (!this.overlayBindGroup) {
            this.overlayBindGroup = this.device.createBindGroup({
                layout: this.overlayPipeline!.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.getSampler() },
                    { binding: 1, resource: this.overlayTextureView },
                ],
            });
        }

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: target,
                loadOp: "load",
                storeOp: "store",
            }],
        });
        renderPass.setPipeline(this.overlayPipeline!);
        renderPass.setBindGroup(0, this.overlayBindGroup);
        renderPass.setVertexBuffer(0, this.rectsVertexBuffer);
        renderPass.draw(vertices.length / 4, 1, 0, 0);
        renderPass.end();
    }

    /** blitRects with its own encoder + submit (GDI present loop path). */
    compositeRects(
        overlay: OffscreenCanvas,
        rects: Array<{ x: number; y: number; w: number; h: number }>,
    ): void {
        if (!this.device || !this.context || !this.queue || rects.length === 0) return;
        const encoder = this.device.createCommandEncoder();
        const targetView = this.context.getCurrentTexture().createView();
        this.blitRects(overlay, targetView, encoder, rects);
        this.queue.submit([encoder.finish()]);
    }

    /**
     * Update the overlay texture from an external canvas.
     * WebGPU guarantees command ordering in the queue, so the copy will complete
     * before any subsequent render commands that use this texture.
     */
    updateOverlayTexture(source: OffscreenCanvas): void {
        if (!this.device || !this.queue) return;

        const width = source.width;
        const height = source.height;
        if (width === 0 || height === 0) return;

        // Recreate texture if size changed
        if (!this.overlayTexture ||
            this.overlayTexture.width !== width ||
            this.overlayTexture.height !== height) {
            if (this.overlayTexture) this.overlayTexture.destroy();
            this.overlayTexture = this.device.createTexture({
                size: [width, height],
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.overlayTextureView = this.overlayTexture.createView();
            // Invalidate bind group when texture changes
            this.overlayBindGroup = null;
        }

        // Copy canvas to texture.
        // Canvas 2D uses premultiplied alpha, so we preserve it as-is.
        // Use sRGB color space (default, but explicit for clarity).
        this.queue.copyExternalImageToTexture(
            { source, flipY: false },
            { texture: this.overlayTexture!, premultipliedAlpha: true, colorSpace: "srgb" },
            { width, height }
        );
    }

    /**
     * Render the overlay texture onto a target.
     * Should be called after updateOverlayTexture in the same frame.
     */
    renderOverlay(target: GPUTextureView, encoder: GPUCommandEncoder): void {
        if (!this.device || !this.overlayTextureView) {
            return;
        }

        // Ensure pipeline exists (recreate if format changed)
        if (!this.overlayPipeline || this.overlayPipelineFormat !== this.format) {
            this.createOverlayPipeline();
            this.overlayPipelineFormat = this.format;
            // Invalidate bind group when pipeline changes
            this.overlayBindGroup = null;
        }

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: target,
                loadOp: "load",
                storeOp: "store",
            }],
        });

        renderPass.setPipeline(this.overlayPipeline!);
        // Cache bind group - only recreate when texture or pipeline changes
        if (!this.overlayBindGroup) {
            this.overlayBindGroup = this.device.createBindGroup({
                layout: this.overlayPipeline!.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.getSampler() },
                    { binding: 1, resource: this.overlayTextureView! },
                ],
            });
        }
        renderPass.setBindGroup(0, this.overlayBindGroup);
        renderPass.setVertexBuffer(0, this.getVertexBuffer());
        renderPass.draw(6, 1, 0, 0);
        renderPass.end();
    }

    /**
     * Blit an external canvas onto a target texture view (Combined operation)
     */
    blit(source: OffscreenCanvas, target: GPUTextureView, encoder: GPUCommandEncoder): void {
        this.updateOverlayTexture(source);
        this.renderOverlay(target, encoder);
    }

    /**
     * Draw a GPU texture onto a target view.
     * viewportWidth/Height: set viewport/scissor for 1:1 (avoids 2x stretch on HiDPI).
     * clearColor: optional; when provided, clear target before draw (avoids load garbage).
     */
    drawTexture(
        textureView: GPUTextureView,
        target: GPUTextureView,
        encoder: GPUCommandEncoder,
        opaque: boolean = false,
        viewportWidth?: number,
        viewportHeight?: number,
        clearColor?: GPUColor,
        useNearestFilter?: boolean,
        present?: { srcW?: number; srcH?: number; outW?: number; outH?: number }
    ): void {
        if (!this.device || !this.format) return;
        Logger.verbose(LogCategory.SYSTEM, `WebGPUBackend: drawTexture opaque=${opaque}`);

        const useViewport = viewportWidth != null && viewportHeight != null && viewportWidth > 0 && viewportHeight > 0;

        // Final-frame present (opaque) → unified post-process chain: game gamma + user color
        // grade + FXAA + integer/aspect scaling + post effects. A neutral config collapses to
        // a single passthrough pass, byte-identical to the legacy present. This is the one
        // present path shared by EVERY backend's "blit final frame" (ddraw/d3d8/opengl/glide).
        if (opaque && this.postFx) {
            this.postFx.present(textureView, target, encoder, {
                clearColor,
                nearest: useNearestFilter,
                viewport: useViewport ? { width: viewportWidth!, height: viewportHeight! } : undefined,
                sourceWidth: present?.srcW,
                sourceHeight: present?.srcH,
                outputWidth: present?.outW,
                outputHeight: present?.outH,
            });
            return;
        }

        // Overlay blit (non-opaque alpha-blended composite), or opaque fallback before the
        // post-fx chain exists.
        if (!this.overlayPipeline || this.overlayPipelineFormat !== this.format) {
            this.createOverlayPipeline();
            this.overlayPipelineFormat = this.format;
        }
        const activePipeline = opaque ? this.overlayPipelineOpaque! : this.overlayPipeline!;

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: target,
                ...(clearColor
                    ? { loadOp: "clear" as const, clearValue: clearColor, storeOp: "store" as const }
                    : { loadOp: "load" as const, storeOp: "store" as const }),
            }],
        });

        if (useViewport) {
            // NOTE: Viewport always starts at (0,0). For "picture-in-picture" or sprite positioning,
            // caller should provide x/y offsets or use separate render pass with scissor rect.
            renderPass.setViewport(0, 0, viewportWidth!, viewportHeight!, 0, 1);
            renderPass.setScissorRect(0, 0, viewportWidth!, viewportHeight!);
        }

        const sampler = useNearestFilter ? this.getNearestSampler() : this.getSampler();
        const bgCache = useNearestFilter ? this.nearestBindGroupCache : this.bindGroupCache;

        let bindGroup = bgCache.get(textureView);
        if (!bindGroup) {
            bindGroup = this.device.createBindGroup({
                layout: activePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: textureView },
                ],
            });
            bgCache.set(textureView, bindGroup);
        }

        renderPass.setPipeline(activePipeline);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.setVertexBuffer(0, this.getVertexBuffer());
        renderPass.draw(6, 1, 0, 0);
        renderPass.end();
    }

    /**
     * Update the stats overlay texture from an OffscreenCanvas.
     */
    updateStatsTexture(source: OffscreenCanvas): void {
        if (!this.device || !this.queue) return;
        const width = source.width;
        const height = source.height;
        if (width === 0 || height === 0) return;

        if (!this.statsTexture ||
            this.statsTexture.width !== width ||
            this.statsTexture.height !== height) {
            if (this.statsTexture) this.statsTexture.destroy();
            this.statsTexture = this.device.createTexture({
                size: [width, height],
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.statsTextureView = this.statsTexture.createView();
            this.statsBindGroup = null;
        }

        this.queue.copyExternalImageToTexture(
            { source, flipY: false },
            { texture: this.statsTexture!, premultipliedAlpha: true, colorSpace: "srgb" },
            { width, height }
        );
    }

    /**
     * Render the stats overlay at the top-right corner of the target.
     */
    renderStatsOverlay(
        target: GPUTextureView,
        encoder: GPUCommandEncoder,
        canvasWidth: number,
        canvasHeight: number
    ): void {
        if (!this.device || !this.statsTextureView || !canvasWidth || !canvasHeight) return;

        if (!this.overlayPipeline || this.overlayPipelineFormat !== this.format) {
            this.createOverlayPipeline();
            this.overlayPipelineFormat = this.format;
            this.statsBindGroup = null;
        }

        // Compute NDC coordinates for a 160×90 quad at top-right with 8px margin
        const overlayW = 160;
        const overlayH = 90;
        const marginX = 8;
        const marginY = 8;

        // NDC: x=-1 is left, x=+1 is right, y=-1 is bottom, y=+1 is top
        const x1 = 1 - (marginX / canvasWidth) * 2;             // right edge
        const x0 = 1 - ((marginX + overlayW) / canvasWidth) * 2; // left edge
        const y1 = 1 - (marginY / canvasHeight) * 2;             // top edge
        const y0 = 1 - ((marginY + overlayH) / canvasHeight) * 2; // bottom edge

        // Recreate vertex buffer if canvas size changed (NDC positions depend on it)
        // We always recreate since canvas size may change (fullscreen toggle etc.)
        const vertices = new Float32Array([
            // pos (x,y), uv (u,v)
            x0, y0, 0, 1,   // bottom-left
            x1, y0, 1, 1,   // bottom-right
            x1, y1, 1, 0,   // top-right
            x0, y0, 0, 1,   // bottom-left
            x1, y1, 1, 0,   // top-right
            x0, y1, 0, 0,   // top-left
        ]);

        if (!this.statsVertexBuffer) {
            this.statsVertexBuffer = this.device.createBuffer({
                size: vertices.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
        this.queue!.writeBuffer(this.statsVertexBuffer, 0, vertices);

        if (!this.statsBindGroup) {
            this.statsBindGroup = this.device.createBindGroup({
                layout: this.overlayPipeline!.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.getSampler() },
                    { binding: 1, resource: this.statsTextureView },
                ],
            });
        }

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: target,
                loadOp: "load",
                storeOp: "store",
            }],
        });

        renderPass.setPipeline(this.overlayPipeline!);
        renderPass.setBindGroup(0, this.statsBindGroup);
        renderPass.setVertexBuffer(0, this.statsVertexBuffer);
        renderPass.draw(6, 1, 0, 0);
        renderPass.end();
    }

    private createOverlayPipeline(): void {
        if (!this.device || !this.format) return;

        const shaderCode = `
            struct VertexOutput {
                @builtin(position) position: vec4f,
                @location(0) uv: vec2f,
            }

            @vertex
            fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VertexOutput {
                var out: VertexOutput;
                out.position = vec4f(pos, 0.0, 1.0);
                out.uv = uv;
                return out;
            }

            @group(0) @binding(0) var texSampler: sampler;
            @group(0) @binding(1) var tex: texture_2d<f32>;

            @fragment
            fn fs_main(in: VertexOutput) -> @location(0) vec4f {
                return textureSample(tex, texSampler, in.uv);
            }
        `;

        const shader = this.device.createShaderModule({ code: shaderCode });
        
        const pipelineDesc: GPURenderPipelineDescriptor = {
            layout: "auto",
            vertex: {
                module: shader,
                entryPoint: "vs_main",
                buffers: [{
                    arrayStride: 16,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x2" },
                        { shaderLocation: 1, offset: 8, format: "float32x2" },
                    ],
                }],
            },
            fragment: {
                module: shader,
                entryPoint: "fs_main",
                targets: [{
                    format: this.format,
                    blend: {
                        color: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        },
                        alpha: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        },
                    },
                }],
            },
            primitive: { topology: "triangle-list" },
        };

        this.overlayPipeline = this.device.createRenderPipeline(pipelineDesc);

        // Opaque version
        const targets = pipelineDesc.fragment!.targets as GPUColorTargetState[];
        if (targets[0]) {
            targets[0].blend = undefined;
        }
        this.overlayPipelineOpaque = this.device.createRenderPipeline(pipelineDesc);
    }

    /**
     * Update the gamma LUT texture from normalized float arrays.
     * Called from SetGammaRamp thunk handler.
     */
    updateGammaLUT(red: Float32Array, green: Float32Array, blue: Float32Array, isIdentity: boolean): void {
        if (isIdentity) {
            this.postFx?.updateGammaLut(null);
            return;
        }

        // Faithful RAMDAC-LUT semantics: apply the ramp as authored. The ONLY guard is a
        // fully-collapsed ramp — max value ~0 across all three channels — which a real
        // brightness/gamma curve can never produce (index 255 is the brightest entry). That
        // pattern means the guest handed us an uninitialized brightness (e.g. UE1 reading
        // UViewport.Brightness=0.0 → d3ddrv emits an all-zero ramp). On real hardware that
        // would black the screen; we pass through + warn instead of bricking the frame.
        const maxR = red[255], maxG = green[255], maxB = blue[255];
        if (maxR < 0.01 && maxG < 0.01 && maxB < 0.01) {
            Logger.warn(LogCategory.SYSTEM,
                `[GAMMA] Degenerate all-zero ramp (max r/g/b=${maxR.toFixed(3)}/${maxG.toFixed(3)}/${maxB.toFixed(3)}); ` +
                `suspected uninitialized guest brightness — passing through (faithful HW behavior would be a black screen).`);
            this.postFx?.updateGammaLut(null);
            return;
        }

        // Pack R[256], G[256], B[256] contiguously — matches color-grade's LUT layout
        // (array<vec4f,192>: R=[0..63], G=[64..127], B=[128..191]). Guard NaN/range so a
        // malformed ramp can't poison the shader.
        const data = new Float32Array(768);
        data.set(red, 0);
        data.set(green, 256);
        data.set(blue, 512);
        for (let i = 0; i < 768; i++) {
            const v = data[i];
            if (!(v >= 0)) data[i] = 0;      // NaN or negative → 0
            else if (v > 1) data[i] = 1;
        }
        this.postFx?.updateGammaLut(data);
        Logger.log(LogCategory.SYSTEM,
            `[GAMMA] ramp applied (r255=${maxR.toFixed(3)} g255=${maxG.toFixed(3)} b255=${maxB.toFixed(3)})`);
    }

    private getSampler(): GPUSampler {
        if (!this.overlaySampler) {
            this.overlaySampler = this.device!.createSampler({ magFilter: "linear", minFilter: "linear" });
        }
        return this.overlaySampler;
    }

    private getNearestSampler(): GPUSampler {
        if (!this.overlayNearestSampler) {
            this.overlayNearestSampler = this.device!.createSampler({ magFilter: "nearest", minFilter: "nearest" });
        }
        return this.overlayNearestSampler;
    }

    private getVertexBuffer(): GPUBuffer {
        if (!this.overlayVertexBuffer) {
            const vertices = new Float32Array([
                -1, -1, 0, 1,
                 1, -1, 1, 1,
                 1,  1, 1, 0,
                -1, -1, 0, 1,
                 1,  1, 1, 0,
                -1,  1, 0, 0,
            ]);
            this.overlayVertexBuffer = this.device!.createBuffer({
                size: vertices.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.queue!.writeBuffer(this.overlayVertexBuffer, 0, vertices);
        }
        return this.overlayVertexBuffer;
    }

    /**
     * Create RGB565→RGBA conversion pipeline
     * Converts r16uint texture to rgba8unorm using GPU shader
     */
    private createRGB565Pipeline(): void {
        if (!this.device || !this.format) return;

        const shaderCode = `
            @vertex
            fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
                // Fullscreen triangle (covers entire viewport)
                var pos = array<vec2f, 3>(
                    vec2f(-1.0, -1.0),
                    vec2f(3.0, -1.0),
                    vec2f(-1.0, 3.0)
                );
                return vec4f(pos[idx], 0.0, 1.0);
            }

            @group(0) @binding(0) var tex: texture_2d<u32>;

            @fragment
            fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
                let coords = vec2u(u32(pos.x), u32(pos.y));
                let rgb565 = textureLoad(tex, coords, 0).r;

                // Unpack RGB565: RRRRRGGGGGGBBBBB
                let r5 = (rgb565 >> 11u) & 0x1Fu;
                let g6 = (rgb565 >> 5u) & 0x3Fu;
                let b5 = rgb565 & 0x1Fu;

                // Expand to 8-bit with proper scaling
                // 5-bit: (val << 3) | (val >> 2) - maps 0-31 to 0-255
                // 6-bit: (val << 2) | (val >> 4) - maps 0-63 to 0-255
                let r8 = f32((r5 << 3u) | (r5 >> 2u)) / 255.0;
                let g8 = f32((g6 << 2u) | (g6 >> 4u)) / 255.0;
                let b8 = f32((b5 << 3u) | (b5 >> 2u)) / 255.0;

                return vec4f(r8, g8, b8, 1.0);
            }
        `;

        const shader = this.device.createShaderModule({ code: shaderCode });

        this.rgb565Pipeline = this.device.createRenderPipeline({
            layout: "auto",
            vertex: {
                module: shader,
                entryPoint: "vs_main",
            },
            fragment: {
                module: shader,
                entryPoint: "fs_main",
                targets: [{
                    format: "rgba8unorm", // Always output RGBA (independent of canvas format!)
                }],
            },
            primitive: { topology: "triangle-list" },
        });

        Logger.log(LogCategory.SYSTEM, "RGB565 conversion pipeline created (rgba8unorm output)");
    }

    /**
     * Convert RGB565 texture to RGBA using GPU shader
     * @param rgb565Texture - Source texture in r16uint format
     * @param targetTexture - Target texture in rgba8unorm format
     * @param encoder - Command encoder to record commands
     */
    convertRGB565ToRGBA(
        rgb565Texture: GPUTextureView,
        targetTexture: GPUTextureView,
        encoder: GPUCommandEncoder
    ): void {
        if (!this.device) return;

        // Ensure pipeline exists (only create once, format is always rgba8unorm)
        if (!this.rgb565Pipeline) {
            this.createRGB565Pipeline();
        }

        if (!this.rgb565Pipeline) {
            Logger.error(LogCategory.SYSTEM, "RGB565 pipeline creation failed");
            return;
        }

        // Cache bind group per texture view
        let bindGroup = this.rgb565BindGroupCache.get(rgb565Texture);
        if (!bindGroup) {
            bindGroup = this.device.createBindGroup({
                layout: this.rgb565Pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: rgb565Texture },
                ],
            });
            this.rgb565BindGroupCache.set(rgb565Texture, bindGroup);
        }

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetTexture,
                loadOp: "clear",
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: "store",
            }],
        });

        renderPass.setPipeline(this.rgb565Pipeline);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.draw(3); // Fullscreen triangle
        renderPass.end();

        Logger.verbose(LogCategory.DDRAW, "RGB565→RGBA GPU conversion executed");
    }
}
