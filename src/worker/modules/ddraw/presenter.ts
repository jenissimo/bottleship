import { RenderActive } from "../../runtime/runtime-services";
import { FrameDebugSnapshot } from "./index";
import { Process } from "../../core/process";
import { System } from "../../core/system";
import { profiler } from "../../core/profiler";
import { DirectDrawSurfaceState, isRenderSurface } from "./com-objects";
import { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import { FrameInterpolator } from "../../backends/webgpu/frame-interpolator";
import { Logger, LogCategory } from "../../core/logger";
import { frameProfiler } from "../../core/frame-profiler";
import { framePacer } from "../../core/frame-pacer";
import {
    uploadToGPUTexture,
    uploadRGB565ToGPU,
    createRGB565Texture,
    createGPUTexture,
    resolvePalette,
} from "./gpu-texture-utils";
import {
    decodeSurfaceFormatToRgba8,
    getSurfaceFormatLayout,
} from "../../backends/webgpu/shared/texture-formats";
import { DDSCAPS_TEXTURE } from "./constants";
import { getOverlayCompositePlan } from "../user32/dialog-overlay";
import { markGpuSyncedFromCpu, surfaceSyncManager } from "./surface-sync";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { onFrameEnd as frameCaptureOnFrameEnd } from "./frame-capture";
import { statsOverlay } from "../../core/stats-overlay";

export class DDrawPresenter implements RenderActive {
    private process: Process;
    private canvas: OffscreenCanvas | null = null;
    /** Last frame handed to the canvas — the source captureFrame() reads back. */
    private lastPresented: { view: GPUTextureView; width: number; height: number } | null = null;
    private ctx: OffscreenCanvasRenderingContext2D | null = null;
    private counters: Record<string, number> = { frames: 0 };
    private lastPresentLog = 0;
    private presentCallCount = 0;
    private presentEarlyReturns = 0;
    private lastPresentTime = 0;
    private pendingSurface: DirectDrawSurfaceState | null = null;
    private pendingMem: Uint8Array | null = null;
    private pendingOptions: { throttle?: boolean } | null = null;
    private pendingResolvers: Array<{ resolve: () => void, reject: (reason?: unknown) => void }> = [];
    private pumpRunning = false;

    // Phase-blend present mode (C). When enabled, guest Flips only SNAPSHOT into the interpolator;
    // a per-rAF callback (blendFrameUnreg) re-presents mix(prev,new,phase) at full refresh so a
    // sub-refresh guest's 2↔3 vsync judder dissolves into a smooth crossfade. Off by default —
    // the entire normal present path below is untouched unless setBlendEnabled(true) is called.
    private interpolator: FrameInterpolator | null = null;
    private blendEnabled = false;
    private blendFrameUnreg: (() => void) | null = null;
    private lastBlendWidth = 0;
    private lastBlendHeight = 0;

    constructor(process: Process) {
        this.process = process;
    }

    /**
     * Toggle phase-blend present (present mode "blend", C). Lazily builds the interpolator and
     * registers a per-rAF re-present; disabling tears both down. Idempotent.
     */
    setBlendEnabled(on: boolean): void {
        if (on === this.blendEnabled) return;
        this.blendEnabled = on;
        if (on) {
            this.blendFrameUnreg = framePacer.registerOnFrame(() => this.presentBlend());
            Logger.log(LogCategory.SYSTEM, `[FrameInterp] blend present ENABLED`);
        } else {
            if (this.blendFrameUnreg) { this.blendFrameUnreg(); this.blendFrameUnreg = null; }
            this.interpolator?.destroy();
            this.interpolator = null;
            Logger.log(LogCategory.SYSTEM, `[FrameInterp] blend present DISABLED`);
        }
    }

    isBlendEnabled(): boolean {
        return this.blendEnabled;
    }

    reset(): void {
        const oldFrames = this.counters.frames;
        Logger.log(
            LogCategory.SYSTEM,
            `DDrawPresenter.reset: called (old frames=${oldFrames}, callCount=${this.presentCallCount}, earlyReturns=${this.presentEarlyReturns})`
        );
        this.canvas = null;
        this.ctx = null;
        this.lastPresented = null;
        this.counters = { frames: 0 };
        // Reset diagnostic counters as well
        this.lastPresentLog = 0;
        this.presentCallCount = 0;
        this.presentEarlyReturns = 0;
        this.lastPresentTime = 0;

        const pendingResolvers = this.pendingResolvers.splice(0);
        for (const resolver of pendingResolvers) {
            resolver.reject(new Error("DDrawPresenter reset during pending present"));
        }
        this.pendingSurface = null;
        this.pendingMem = null;
        this.pendingOptions = null;
        this.pumpRunning = false;

        // Tear down phase-blend (interpolator holds device-bound GPU textures + an rAF callback).
        this.setBlendEnabled(false);
    }

    getCounters(): Record<string, number> {
        const system = System.getInstance();
        const ddraw = system.process?.getModule("ddraw") as any;
        const snapshot = ddraw?.getFrameSnapshot() as FrameDebugSnapshot | undefined;

        return {
            ...this.counters,
            ...(snapshot?.frameCounters ?? {}),
            drawCalls: snapshot?.drawCalls ?? 0,
            presents: snapshot?.presents ?? 0,
        };
    }

    /**
     * True once a DirectDraw frame has actually reached the canvas. An existing primary
     * surface only means DirectDraw *could* display something; until a frame is presented
     * the primary holds nothing, which is what separates a game rendering fullscreen from
     * an app that took exclusive mode for the display mode and draws with GDI.
     */
    hasPresentedFrame(): boolean {
        return (this.counters.frames ?? 0) > 0;
    }

    /**
     * PNG of the screen. The canvas is the only source that includes the overlays
     * compositeFrameOverlays() blits on AFTER lastPresented is recorded (video plane,
     * live GDI dialog rects, stats) — capturing lastPresented shows the game layer
     * with a dialog missing, which reads as a plausible but wrong screenshot.
     *
     * Fallbacks, in order: the presented GPU texture (game layer only, alpha forced
     * opaque — the guest primary is an RGB565/555 mode with no alpha), then the CPU
     * path's 2D scratch canvas, which is blank for any GPU_ONLY (3D DDraw) title.
     */
    async captureFrame(): Promise<Blob> {
        const screen = await System.getInstance().services.render.tryCaptureScreen();
        if (screen) return screen;
        const layer = await this.capturePresentedLayer();
        if (layer) return layer;
        if (!this.canvas) {
            return new Blob();
        }
        return this.canvas.convertToBlob();
    }

    /** The presented guest surface alone — no video plane, no GDI dialog rects, no stats. */
    async capturePresentedLayer(): Promise<Blob | null> {
        return this.lastPresented ? this.captureFromGpu(this.lastPresented) : null;
    }

    private async captureFromGpu(src: { view: GPUTextureView; width: number; height: number }): Promise<Blob | null> {
        const backend = System.getInstance().services?.render?.getBackend?.() as WebGPUBackend | undefined;
        const device = backend?.getDevice?.();
        const queue = backend?.getQueue?.();
        const format = backend?.getFormat?.();
        if (!device || !queue || !format) return null;

        const { width, height } = src;
        if (!width || !height) return null;

        // Blit through the same present path (post-fx included) into a copyable
        // target — the canvas texture itself is not readable after present.
        const target = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const readback = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder();
            backend!.drawTexture(src.view, target.createView(), encoder, true, undefined, undefined, undefined, undefined,
                { srcW: width, srcH: height, outW: width, outH: height });
            encoder.copyTextureToBuffer(
                { texture: target },
                { buffer: readback, bytesPerRow },
                { width, height, depthOrArrayLayers: 1 },
            );
            queue.submit([encoder.finish()]);
            await queue.onSubmittedWorkDone();
            await readback.mapAsync(GPUMapMode.READ);

            const mapped = new Uint8Array(readback.getMappedRange());
            const pixels = new Uint8ClampedArray(width * height * 4);
            const swapRB = format === "bgra8unorm";
            for (let y = 0; y < height; y++) {
                let s = y * bytesPerRow;
                let d = y * width * 4;
                for (let x = 0; x < width; x++, s += 4, d += 4) {
                    pixels[d] = mapped[s + (swapRB ? 2 : 0)]!;
                    pixels[d + 1] = mapped[s + 1]!;
                    pixels[d + 2] = mapped[s + (swapRB ? 0 : 2)]!;
                    pixels[d + 3] = 255;
                }
            }
            readback.unmap();

            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
            return await canvas.convertToBlob({ type: "image/png" });
        } catch (err) {
            Logger.warn(LogCategory.SYSTEM, `DDrawPresenter.captureFrame: GPU readback failed — ${(err as Error).message}`);
            return null;
        } finally {
            readback.destroy();
            target.destroy();
        }
    }

    async present(surface: DirectDrawSurfaceState, mem: Uint8Array, options: { throttle?: boolean; frameAlreadyMarked?: boolean; snapshotTextureView?: GPUTextureView } = {}): Promise<void> {
        this.presentCallCount++;
        return new Promise<void>((resolve, reject) => {
            if (this.pendingSurface || this.pendingResolvers.length > 0) {
                const supersededResolvers = this.pendingResolvers.splice(0);
                for (const resolver of supersededResolvers) {
                    resolver.resolve();
                }
            }

            this.pendingSurface = surface;
            this.pendingMem = mem;
            this.pendingOptions = options;
            this.pendingResolvers.push({ resolve, reject });
            void this.pumpLoop();
        });
    }

    private async pumpLoop(): Promise<void> {
        if (this.pumpRunning) return;
        this.pumpRunning = true;
        try {
            while (true) {
                const frame = this.dequeuePendingFrame();
                if (!frame) break;
                const { surface, mem, options, resolvers } = frame;

                try {
                    await this.drawFrame(surface, mem, options);
                    for (const resolver of resolvers) resolver.resolve();
                } catch (err) {
                    for (const resolver of resolvers) resolver.reject(err);
                    throw err;
                }
            }
        } finally {
            this.pumpRunning = false;
            if (this.pendingSurface) {
                void this.pumpLoop();
            }
        }
    }

    private dequeuePendingFrame() {
        if (!this.pendingSurface || !this.pendingMem) return null;
        const surface = this.pendingSurface;
        const mem = this.pendingMem;
        const options = this.pendingOptions;
        const resolvers = this.pendingResolvers.splice(0);
        this.pendingSurface = null;
        this.pendingMem = null;
        this.pendingOptions = null;
        return { surface, mem, options, resolvers };
    }

    private async drawFrame(surface: DirectDrawSurfaceState, mem: Uint8Array, options?: { throttle?: boolean; frameAlreadyMarked?: boolean; snapshotTextureView?: GPUTextureView } | null): Promise<void> {
        profiler.start("present");
        const presentStart = frameProfiler.startTimer();
        let didPresent = false;
        // PRESENT-DIAG: phase timing to locate present stalls (>50ms).
        const _pdStart = performance.now();
        let _pdFlushAll = 0, _pdFlush = 0, _pdGetTex = 0, _pdDrawSubmit = 0;
        try {
            const now = performance.now();
            const prevPresentTime = this.lastPresentTime;
            this.lastPresentTime = now;

            // Check for early returns (no throttle – we're not presenting)
            if (!surface.surfacePtr || surface.width <= 0 || surface.height <= 0) {
                this.presentEarlyReturns++;
                if (now - this.lastPresentLog >= 1000) {
                    Logger.verbose(
                        LogCategory.SYSTEM,
                        `DDrawPresenter.present: calls=${this.presentCallCount} earlyReturns=${this.presentEarlyReturns} (invalid surface: ptr=${surface.surfacePtr} w=${surface.width} h=${surface.height}) frames=${this.counters.frames}`
                    );
                    this.lastPresentLog = now;
                    this.presentCallCount = 0;
                    this.presentEarlyReturns = 0;
                }
                return;
            }

            const system = System.getInstance();
            const backend = system.services.render.getBackend();
            const videoOverlayService = system.videoRouting.getOverlayService();
            const videoOverlay = videoOverlayService.getCanvas();

            // Exclusive-fullscreen screen ownership (real Windows): in DDSCL_EXCLUSIVE|
            // FULLSCREEN, DirectDraw owns the screen and GDI windows are NOT visible —
            // EXCEPT live native modal dialogs over a primary GDI still paints into
            // (TS "Select Campaign", BOD Setup). Only their rects are composited, never
            // the whole overlay, so stale pre-dialog/menu GDI cannot cover the game.
            // getOverlayCompositePlan owns the decision (see dialogOverlayComposites).
            const plan = getOverlayCompositePlan(this);
            const dialogRects = plan.mode === 'rects' ? plan.rects : null;
            const overlay = plan.mode === 'none' ? null : system.gdiContext.getOverlayCanvas();

            this.ensureCanvas(surface.width, surface.height);
            if (!this.ctx || !this.canvas) {
                this.presentEarlyReturns++;
                if (now - this.lastPresentLog >= 1000) {
                    Logger.log(
                        LogCategory.SYSTEM,
                        `DDrawPresenter.present: calls=${this.presentCallCount} earlyReturns=${this.presentEarlyReturns} (no ctx/canvas: ctx=${!!this.ctx} canvas=${!!this.canvas}) frames=${this.counters.frames}`
                    );
                    this.lastPresentLog = now;
                    this.presentCallCount = 0;
                    this.presentEarlyReturns = 0;
                }
                return;
            }

            let presentTextureView = options?.snapshotTextureView ?? surface.gpuTextureView;
            // [DIAG] Log present attempts for black screen debugging
            if (this.counters.frames < 10 || this.counters.frames % 50 === 0) {
                Logger.log(LogCategory.DDRAW,
                    `DDrawPresenter.drawFrame: frame=${this.counters.frames} surface=0x${surface.surfacePtr.toString(16)} ` +
                    `${surface.width}x${surface.height} bpp=${surface.format.bpp} gpuDirty=${isRenderSurface(surface) ? (surface as any).gpuDirty : '?'} ` +
                    `gpuTex=${!!surface.gpuTexture} gpuTexView=${!!surface.gpuTextureView} backend=${backend?.kind ?? 'none'}`);
            }
            if (backend?.kind === "webgpu") {
                const webgpu = backend as WebGPUBackend;
                const device = webgpu.getDevice();
                const queue = webgpu.getQueue();
                const gpuContext = webgpu.getContext();
                if (!device || !queue || !gpuContext) {
                    Logger.warn(LogCategory.DDRAW,
                        `DDrawPresenter.drawFrame: WebGPU path SKIPPED: device=${!!device} queue=${!!queue} gpuContext=${!!gpuContext}`);
                }
                if (device && queue && gpuContext) {
                    // OPTIMIZATION: GPU-based RGB565→RGBA conversion (Phase 1)
                    // For RGB565 surfaces, use GPU shader instead of CPU conversion (141ms → <1ms!)
                    const isRGB565 = isRenderSurface(surface) &&
                        surface.format.bpp === 16 &&
                        surface.format.rMask === 0xF800 &&
                        surface.format.gMask === 0x07E0 &&
                        surface.format.bMask === 0x001F;

                    // OPTIMIZATION: GPU-based PALETTE8→RGBA conversion (Phase 2)
                    // For 8-bit palettized surfaces, use TextureConverter compute shader (~92ms → <1ms)
                    const isPalette8 = isRenderSurface(surface) &&
                        surface.format.bpp === 8 &&
                        !!(surface.format.flags & 0x20);

                    if (isRGB565) {
                        // Only upload from CPU if GPU needs sync (CPU has newer data).
                        // When Flip copies via GPU blit, GPU already has correct data (gpuDirty=false).
                        // Uploading from CPU would overwrite valid GPU pixels with stale/empty memory.
                        if (surface.gpuDirty) {
                            profiler.start("present:rgb565Upload");
                            this.uploadRGB565SurfaceToGPU(surface, mem, device, queue);
                            profiler.end("present:rgb565Upload");
                        }
                    } else if (isPalette8) {
                        if (surface.gpuDirty) {
                            profiler.start("present:palette8Upload");
                            this.uploadPalette8SurfaceToGPU(surface, mem, device, queue);
                            profiler.end("present:palette8Upload");
                        }
                    }

                    // DEFERRED UPLOAD: Batch upload all dirty surfaces accumulated during frame
                    // This includes primary surface (backbuffer) - avoid duplicate upload below
                    profiler.start("present:deferredUploads");
                    const ddrawModule = system.process?.getModule("ddraw") as any;
                    if (ddrawModule?.context?.deferredUploadManager) {
                        // Mark primary surface as dirty before flush (ensures it's included in batch)
                        const isRenderSurf = isRenderSurface(surface);
                        if (isRenderSurf && surface.gpuDirty && !isRGB565 && !isPalette8) {
                            ddrawModule.context.deferredUploadManager.markDirty(surface);
                        }
                        if (this.counters.frames < 10) Logger.log(LogCategory.DDRAW, `drawFrame: before flushAll frame=${this.counters.frames}`);
                        const _fa = performance.now();
                        await ddrawModule.context.deferredUploadManager.flushAll(queue, mem);
                        _pdFlushAll += performance.now() - _fa;
                        if (this.counters.frames < 10) Logger.log(LogCategory.DDRAW, `drawFrame: after flushAll frame=${this.counters.frames}`);
                    }
                    profiler.end("present:deferredUploads");

                    // OPTIMIZATION: Skip redundant upload - primary surface was already uploaded in batch above
                    // Keeping old code commented for reference:
                    // const needsUpload = surfaceSyncManager.needsGPUSync(surface);
                    // if (needsUpload.needed && !skipForGpuOnly) {
                    //     this.uploadSurfaceToGPU(surface, mem, queue);
                    //     markGpuSyncedFromCpu(surface);
                    // }
                    const _fl = performance.now();
                    if (ddrawModule?.context?.executor?.endFrameForPresent) {
                        ddrawModule.context.executor.endFrameForPresent();
                    } else if (ddrawModule?.context?.executor) {
                        ddrawModule.context.executor.flush();
                    }
                    _pdFlush += performance.now() - _fl;

                    // Refresh texture view: uploadRGB565SurfaceToGPU may have recreated
                    // surface.gpuTexture (bgra8unorm → rgba8unorm format change), making
                    // the view captured before the upload stale/destroyed.
                    presentTextureView = surface.gpuTextureView ?? options?.snapshotTextureView ?? presentTextureView;
                    if (!presentTextureView) {
                        Logger.warn(LogCategory.DDRAW,
                            `DDrawPresenter.drawFrame: NO presentTextureView after uploads! surface=0x${surface.surfacePtr.toString(16)} gpuTex=${!!surface.gpuTexture}`);
                        return;
                    }

                    // Phase-blend present (C): the guest Flip only SNAPSHOTS the finished frame into
                    // the interpolator's history; the actual canvas present is done at full refresh by
                    // presentBlend() (per-rAF). notifyPresent is emitted there, so flipCadence then
                    // measures the real ~60 Hz display cadence rather than the guest's sparse flips.
                    if (this.blendEnabled) {
                        if (!this.interpolator) {
                            const fmt = webgpu.getFormat();
                            if (fmt) this.interpolator = new FrameInterpolator(device, queue, fmt);
                        }
                        if (this.interpolator) {
                            this.interpolator.snapshot(presentTextureView, surface.width, surface.height, now);
                            this.lastBlendWidth = surface.width;
                            this.lastBlendHeight = surface.height;
                            this.counters.frames += 1;
                            return;
                        }
                    }

                    // Error scopes for first 10 frames to catch silent GPU failures
                    const useErrorScopes = this.counters.frames < 10;
                    if (useErrorScopes) {
                        device.pushErrorScope("out-of-memory");
                        device.pushErrorScope("validation");
                    }

                    const encoder = device.createCommandEncoder();
                    const _gt = performance.now();
                    const canvasTex = gpuContext.getCurrentTexture();
                    _pdGetTex += performance.now() - _gt;
                    const targetView = canvasTex.createView();

                    const clearColor = EmulatorConfig.getInstance().screenBackgroundColor;
                    webgpu.drawTexture(
                        presentTextureView,
                        targetView,
                        encoder,
                        true,
                        undefined,
                        undefined,
                        clearColor,
                        undefined,
                        // Source (guest) + output (canvas) dims → post-fx chain does
                        // integer/aspect scaling + FXAA texel sizing.
                        { srcW: surface.width, srcH: surface.height, outW: canvasTex.width, outH: canvasTex.height }
                    );
                    this.lastPresented = { view: presentTextureView, width: surface.width, height: surface.height };

                    // Composite overlays (video plane → GDI → worker FPS). Shared with presentBlend.
                    this.compositeFrameOverlays(webgpu, targetView, encoder, surface.width, surface.height);

                    const submitStart = frameProfiler.startTimer();
                    const _ds = performance.now();
                    queue.submit([encoder.finish()]);
                    _pdDrawSubmit += performance.now() - _ds;
                    frameProfiler.endTimer("gpu", submitStart);

                    // Pop error scopes and log any GPU errors
                    if (useErrorScopes) {
                        const frameNum = this.counters.frames;
                        device.popErrorScope().then(err => {
                            if (err) Logger.error(LogCategory.DDRAW, `[PRESENT] Validation error frame=${frameNum}: ${err.message}`);
                        });
                        device.popErrorScope().then(err => {
                            if (err) Logger.error(LogCategory.DDRAW, `[PRESENT] OOM error frame=${frameNum}: ${err.message}`);
                        });
                    }

                    // Flush pending GPU resource destruction at end of frame
                    // WebGPU queue.submit() only sends commands but doesn't guarantee completion.
                    // We destroy textures here (after frame presentation) to ensure GPU has finished reading them.
                    // This is safer than destroying in executor.flush() which may be called multiple times per frame.
                    if (system.gpuResourceManager) {
                        system.gpuResourceManager.flushPendingDestruction();
                    }

                    if (system.services.render.getActive() !== this) {
                        system.services.render.setActive(this);
                    }
                    this.counters.frames += 1;
                    // [DIAG] Log first few successful presents
                    if (this.counters.frames <= 10) {
                        Logger.log(LogCategory.DDRAW,
                            `DDrawPresenter.drawFrame: GPU SUBMIT OK frame=${this.counters.frames} texView=${!!presentTextureView} ` +
                            `surface=0x${surface.surfacePtr.toString(16)} gpuFmt=${surface.gpuTextureFormat ?? 'unknown'}`);
                    }
                    system.services.render.notifyPresent("ddraw");
                    didPresent = true;

                    // Feed frame time to stats overlay
                    if (prevPresentTime > 0) {
                        statsOverlay.updateMetrics(now - prevPresentTime);
                    }

                    // Frame capture: finalize captured draw calls
                    frameCaptureOnFrameEnd();

                    // Update frame snapshot for debug panel
                    const ddraw = system.process?.getModule("ddraw") as any;
                    if (ddraw?.updateFrameSnapshotOnPresent) {
                        ddraw.updateFrameSnapshotOnPresent(surface);
                    }

                    // Throttled diagnostic logging (1 second)
                    const threadId = system.scheduler?.getCurrentThreadId?.() ?? 0;
                    if (now - this.lastPresentLog >= 1000) {
                        Logger.verbose(
                            LogCategory.SYSTEM,
                            `[TID=${threadId}] DDrawPresenter.present: calls=${this.presentCallCount} earlyReturns=${this.presentEarlyReturns} (GPU path) frames=${this.counters.frames}`
                        );
                        this.lastPresentLog = now;
                        this.presentCallCount = 0;
                        this.presentEarlyReturns = 0;
                    }
                    return; // GPU path complete
                } else {
                    // GPU path requested but not available - fallback to 2D (not an early return, continues below)
                    // Log fallback but don't count as early return since execution continues
                    if (now - this.lastPresentLog >= 1000) {
                        Logger.verbose(
                            LogCategory.SYSTEM,
                            `DDrawPresenter.present: calls=${this.presentCallCount} earlyReturns=${this.presentEarlyReturns} (GPU unavailable, falling back to 2D: device=${!!device} queue=${!!queue} context=${!!gpuContext}) frames=${this.counters.frames}`
                        );
                        this.lastPresentLog = now;
                        this.presentCallCount = 0;
                        this.presentEarlyReturns = 0;
                    }
                    // Continue to 2D path below
                }
            }

            const imageData = this.surfaceToImageData(surface, mem);
            this.ctx.putImageData(imageData, 0, 0);

            if (videoOverlay && videoOverlayService.hasContent()) {
                this.ctx.drawImage(videoOverlay, 0, 0);
                videoOverlayService.consumeDirty();
            }

            if (overlay) {
                if (dialogRects?.length) {
                    // Flip chain owns the screen: composite only live dialog rects.
                    for (const r of dialogRects) {
                        if (r.w > 0 && r.h > 0) {
                            this.ctx.drawImage(overlay, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
                        }
                    }
                } else {
                    this.ctx.drawImage(overlay, 0, 0);
                }
                if (system.gdiContext.isOverlayDirty()) {
                    system.gdiContext.clearOverlayDirty();
                }
            }

            if (backend) {
                backend.composite(this.canvas);
            } else if (this.process.canvas) {
                const screenCtx = this.process.canvas.getContext("2d");
                if (screenCtx) {
                    screenCtx.drawImage(this.canvas, 0, 0);
                }
            }

            if (system.services.render.getActive() !== this) {
                system.services.render.setActive(this);
            }

            this.counters.frames += 1;
            system.services.render.notifyPresent("ddraw");
            didPresent = true;

            // Frame capture: finalize captured draw calls
            frameCaptureOnFrameEnd();

            // Update frame snapshot for debug panel
            const ddraw = system.process?.getModule("ddraw") as any;
            if (ddraw?.updateFrameSnapshotOnPresent) {
                ddraw.updateFrameSnapshotOnPresent(surface);
            }

            // Throttled diagnostic logging (1 second) for 2D path
            if (now - this.lastPresentLog >= 1000) {
                Logger.verbose(
                    LogCategory.SYSTEM,
                    `DDrawPresenter.present: calls=${this.presentCallCount} earlyReturns=${this.presentEarlyReturns} (2D path) frames=${this.counters.frames}`
                );
                this.lastPresentLog = now;
                this.presentCallCount = 0;
                this.presentEarlyReturns = 0;
            }
        } finally {
            const _pdTot = performance.now() - _pdStart;
            if (_pdTot > 50) {
                Logger.log(LogCategory.DDRAW,
                    `PRESENT-DIAG SLOW drawFrame total=${_pdTot.toFixed(1)}ms flushAll=${_pdFlushAll.toFixed(1)} flush/endFrame=${_pdFlush.toFixed(1)} getCurrentTexture=${_pdGetTex.toFixed(1)} submit=${_pdDrawSubmit.toFixed(1)} blend=${this.blendEnabled} present=${didPresent}`);
            }
            profiler.end("present");
            frameProfiler.endTimer("present", presentStart);

            // Mark frame if not already marked by caller (e.g., Flip marks synchronously)
            // This ensures 2D DDraw games that don't use Flip (FlipToGDISurface, ReleaseDC, direct Blt)
            // still get frame profiling
            if (didPresent && !options?.frameAlreadyMarked) {
                frameProfiler.markFrame("ddraw_present");
            }

            // Release frame slot for FramePacer
            framePacer.releaseFrameSlot();
        }
    }

    /**
     * Composite the per-frame overlays (video plane → GDI → worker FPS) onto an already-drawn
     * target view. Recomputes overlay sources/visibility internally so it can be called from both
     * the normal present (drawFrame) and the per-rAF phase-blend present (presentBlend).
     */
    private compositeFrameOverlays(
        webgpu: WebGPUBackend,
        targetView: GPUTextureView,
        encoder: GPUCommandEncoder,
        width: number,
        height: number,
    ): void {
        const system = System.getInstance();
        const videoOverlayService = system.videoRouting.getOverlayService();
        const videoOverlay = videoOverlayService.getCanvas();
        const plan = getOverlayCompositePlan(this);
        const dialogRects = plan.mode === 'rects' ? plan.rects : null;
        const overlay = plan.mode === 'none' ? null : system.gdiContext.getOverlayCanvas();

        // 1. Video overlay plane (fallback sink).
        if (videoOverlay && videoOverlayService.hasContent()) {
            webgpu.blit(videoOverlay, targetView, encoder);
            videoOverlayService.consumeDirty();
        }

        // 2. GDI overlay on top (whole overlay, or only live dialog rects when the flip chain owns screen).
        if (overlay && system.gdiContext.hasOverlayContent()) {
            if (dialogRects?.length) {
                webgpu.blitRects(overlay, targetView, encoder, dialogRects);
            } else {
                webgpu.blit(overlay, targetView, encoder);
            }
            if (system.gdiContext.isOverlayDirty()) {
                system.gdiContext.clearOverlayDirty();
            }
        }

        // 3. Stats overlay (worker-side FPS display).
        if (statsOverlay.isEnabled()) {
            const statsCanvas = statsOverlay.getCanvas();
            if (statsCanvas) {
                if (statsOverlay.isDirty()) {
                    webgpu.updateStatsTexture(statsCanvas);
                    statsOverlay.clearDirty();
                }
                webgpu.renderStatsOverlay(targetView, encoder, width, height);
            }
        }
    }

    /**
     * Per-rAF phase-blend present (present mode "blend", C). Draws the interpolated frame
     * (crossfade of the two newest guest snapshots by sub-frame phase) to the canvas at the
     * display's full refresh, then composites overlays. No-op until a frame has been snapshotted.
     * Registered as a framePacer onFrame callback while blend mode is enabled.
     */
    private presentBlend(): void {
        if (!this.blendEnabled || !this.interpolator || !this.interpolator.hasFrame()) return;
        const system = System.getInstance();
        const backend = system.services.render.getBackend();
        if (backend?.kind !== "webgpu") return;
        const webgpu = backend as WebGPUBackend;
        const device = webgpu.getDevice();
        const queue = webgpu.getQueue();
        const gpuContext = webgpu.getContext();
        if (!device || !queue || !gpuContext) return;

        const now = performance.now();
        const encoder = device.createCommandEncoder();
        let targetView: GPUTextureView;
        try {
            targetView = gpuContext.getCurrentTexture().createView();
        } catch {
            return; // canvas not configured / lost this frame
        }

        const clearColor = EmulatorConfig.getInstance().screenBackgroundColor;
        this.interpolator.present(targetView, encoder, now, clearColor);
        this.compositeFrameOverlays(webgpu, targetView, encoder, this.lastBlendWidth, this.lastBlendHeight);
        queue.submit([encoder.finish()]);

        if (system.gpuResourceManager) {
            system.gpuResourceManager.flushPendingDestruction();
        }
        if (system.services.render.getActive() !== this) {
            system.services.render.setActive(this);
        }
        system.services.render.notifyPresent("ddraw");
    }

    private ensureCanvas(width: number, height: number): void {
        if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas = new OffscreenCanvas(width, height);
            this.ctx = this.canvas.getContext("2d");
        }
    }

    private uploadSurfaceToGPU(surface: DirectDrawSurfaceState, mem: Uint8Array, queue: GPUQueue): void {
        if (!surface.gpuTexture) return;

        const { width, height, pitch, format, surfacePtr } = surface;
        const bytesPerPixel = Math.max(1, format.bpp >> 3);
        // Use stored pitch only if >= computed (allows row padding, rejects invalid)
        const computedPitch = width * bytesPerPixel;
        const effectivePitch = (pitch && pitch >= computedPitch) ? pitch : computedPitch;

        // For bitmap textures loaded from BMP files, rgbaScratch contains fresh RGBA data
        // from parseBMPPixels. Use it directly instead of converting from surface memory
        // (which would lose precision and potentially swap colors incorrectly).
        const isTexture = (surface.caps & DDSCAPS_TEXTURE) !== 0;
        const expectedSize = width * height * 4;
        // For bitmap textures, rgbaScratch contains fresh RGBA data from parseBMPPixels.
        // Use it directly even if authority='cpu' (setAuthorityCpu is called after setting rgbaScratch).
        const hasFreshRGBA = isTexture &&
            surface.rgbaScratch !== undefined &&
            surface.rgbaScratch.length === expectedSize;

        let rgbaData: Uint8Array;
        if (hasFreshRGBA && surface.rgbaScratch) {
            // Use rgbaScratch directly for bitmap textures (already in RGBA format)
            rgbaData = surface.rgbaScratch;
        } else {
            // Convert from surface memory (for surfaces modified by game or without rgbaScratch)
            const palette = resolvePalette(surface);
            rgbaData = decodeSurfaceFormatToRgba8(mem, surfacePtr, width, height, effectivePitch, format, surface.rgbaScratch, surface.srcColorKey, palette);
        }
        surface.rgbaScratch = rgbaData;

        // Format conversion (RGBA/BGRA) is handled at upload time in uploadToGPUTexture

        const unpaddedBPR = width * 4;
        const alignedBPR = (unpaddedBPR + 255) & ~255;
        const needsPadding = alignedBPR !== unpaddedBPR && height > 1;
        let padScratch: Uint8Array | undefined;
        if (needsPadding) {
            const required = alignedBPR * height;
            if (!surface.rgbaPaddedScratch || surface.rgbaPaddedScratch.length !== required) {
                surface.rgbaPaddedScratch = new Uint8Array(required);
            }
            padScratch = surface.rgbaPaddedScratch;
        }
        uploadToGPUTexture(
            queue,
            surface.gpuTexture,
            rgbaData,
            width,
            height,
            padScratch,
            surface.gpuTextureFormat ?? "rgba8unorm"
        );
    }

    private surfaceToImageData(surface: DirectDrawSurfaceState, mem: Uint8Array): ImageData {
        const { width, height, pitch, format, surfacePtr } = surface;
        // Use stored pitch only if >= computed (allows row padding, rejects invalid)
        const computedPitch = getSurfaceFormatLayout(format, width, height).pitch;
        const effectivePitch = (pitch && pitch >= computedPitch) ? pitch : computedPitch;

        const palette = resolvePalette(surface);
        const rgbaData = decodeSurfaceFormatToRgba8(mem, surfacePtr, width, height, effectivePitch, format, surface.rgbaScratch, surface.srcColorKey, palette);
        surface.rgbaScratch = rgbaData;

        return new ImageData(new Uint8ClampedArray(rgbaData), width, height);
    }

    /**
     * GPU-accelerated PALETTE8 upload (Phase 2 optimization)
     * Uses TextureConverter compute shader for palette→RGBA lookup on GPU
     * Performance: ~92ms → <1ms for 800×600 surface
     */
    private uploadPalette8SurfaceToGPU(
        surface: DirectDrawSurfaceState,
        mem: Uint8Array,
        device: GPUDevice,
        queue: GPUQueue
    ): void {
        const { width, height, pitch, surfacePtr, format } = surface;

        // Ensure RGBA target texture exists
        const needsRecreate = !surface.gpuTexture ||
            surface.gpuTexture.width !== width ||
            surface.gpuTexture.height !== height ||
            surface.gpuTextureFormat !== "rgba8unorm";

        // Get executor early (needed for cache invalidation if texture is recreated)
        const system = System.getInstance();
        const ddrawModule = system.process?.getModule("ddraw") as any;
        const executor = ddrawModule?.context?.executor;

        if (needsRecreate) {
            // Invalidate executor caches BEFORE destroying old texture
            // flushBatch inside invalidateSurfaceCache may emit draw commands that reference
            // the old texture — must happen while texture is still valid
            if (executor?.invalidateSurfaceCache) {
                executor.invalidateSurfaceCache(surface);
            }

            if (surface.gpuTexture) {
                // Use deferred destruction to avoid "Destroyed texture used in submit"
                if (system.gpuResourceManager) {
                    system.gpuResourceManager.enqueueForDestruction(surface.gpuTexture);
                } else {
                    surface.gpuTexture.destroy();
                }
            }

            // Keep COPY_SRC: this REPLACES a render target created with it (directdraw.ts
            // CreateSurface), and the rest of the system may still copy out of the surface
            // (present-path readback, GetDIBits, dumpSurface). Dropping a usage flag while
            // swapping the texture silently downgrades the surface.
            const result = createGPUTexture(device, queue, width, height,
                GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
                "rgba8unorm");
            if (!result) {
                Logger.error(LogCategory.DDRAW, "Failed to create RGBA texture for PALETTE8");
                return;
            }

            surface.gpuTexture = result.texture;
            surface.gpuTextureView = result.view;
            surface.gpuTextureFormat = "rgba8unorm";
            Logger.log(LogCategory.DDRAW, `Created RGBA texture for PALETTE8: ${width}×${height}`);
        }
        if (!executor?.getTextureConverter) {
            Logger.error(LogCategory.DDRAW, "PALETTE8 GPU path: no TextureConverter available");
            return;
        }

        const textureConverter = executor.getTextureConverter();
        const palette = resolvePalette(surface);
        if (!palette) {
            Logger.error(LogCategory.DDRAW, "PALETTE8 GPU path: no palette available");
            return;
        }

        const encoder = device.createCommandEncoder();
        textureConverter.convertToTexture(
            encoder,
            mem,
            surfacePtr,
            width,
            height,
            pitch,
            format,
            surface.gpuTexture!,
            surface.srcColorKey,
            "rgba8unorm",
            palette
        );
        queue.submit([encoder.finish()]);

        // Mark as uploaded
        if (isRenderSurface(surface)) {
            surface.gpuDirty = false;
            surface.lastUploadVersion = surface.version;
        }

        Logger.verbose(LogCategory.DDRAW,
            `GPU PALETTE8 upload: ${width}×${height} (${(width * height / 1024).toFixed(1)}KB)`
        );
    }

    /**
     * GPU-accelerated RGB565 upload (Phase 1 optimization)
     * Uploads RGB565 directly as r16uint, converts to RGBA using GPU shader
     * Performance: 141ms → <1ms for 800×600 surface (140× speedup!)
     */
    private uploadRGB565SurfaceToGPU(
        surface: DirectDrawSurfaceState,
        mem: Uint8Array,
        device: GPUDevice,
        queue: GPUQueue
    ): void {
        const { width, height, pitch, surfacePtr } = surface;

        // Get executor early (needed for cache invalidation if texture is recreated)
        const system = System.getInstance();
        const ddrawModule = system.process?.getModule("ddraw") as any;
        const executor = ddrawModule?.context?.executor;

        // Create r16uint source texture (RGB565 format)
        if (!surface.gpuTextureRGB565 ||
            surface.gpuTextureRGB565.width !== width ||
            surface.gpuTextureRGB565.height !== height) {

            if (surface.gpuTextureRGB565) {
                surface.gpuTextureRGB565.destroy();
            }

            const result = createRGB565Texture(device, width, height);
            if (!result) {
                Logger.error(LogCategory.DDRAW, "Failed to create RGB565 texture, falling back to CPU path");
                return;
            }

            surface.gpuTextureRGB565 = result.texture;
            surface.gpuTextureRGB565View = result.view;
            Logger.log(LogCategory.DDRAW, `Created RGB565 texture: ${width}×${height}`);
        }

        // Create RGBA target texture if needed
        // Must be rgba8unorm format (not bgra8unorm!) for RGB565 pipeline
        const needsRecreate = !surface.gpuTexture ||
            surface.gpuTexture.width !== width ||
            surface.gpuTexture.height !== height ||
            surface.gpuTextureFormat !== "rgba8unorm";

        if (needsRecreate) {
            // Invalidate executor caches BEFORE destroying old texture
            // flushBatch inside invalidateSurfaceCache may emit draw commands that reference
            // the old texture — must happen while texture is still valid
            if (executor?.invalidateSurfaceCache) {
                executor.invalidateSurfaceCache(surface);
            }

            if (surface.gpuTexture) {
                Logger.verbose(LogCategory.DDRAW,
                    `Destroying old texture: format=${surface.gpuTextureFormat} (need rgba8unorm for RGB565)`);
                // Use deferred destruction to avoid "Destroyed texture used in submit"
                if (system.gpuResourceManager) {
                    system.gpuResourceManager.enqueueForDestruction(surface.gpuTexture);
                } else {
                    surface.gpuTexture.destroy();
                }
            }

            // Keep COPY_SRC — see the PALETTE8 path above.
            const result = createGPUTexture(device, queue, width, height,
                GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
                "rgba8unorm");
            if (!result) {
                Logger.error(LogCategory.DDRAW, "Failed to create RGBA texture");
                return;
            }

            surface.gpuTexture = result.texture;
            surface.gpuTextureView = result.view;
            surface.gpuTextureFormat = "rgba8unorm";
            Logger.log(LogCategory.DDRAW, `Created RGBA texture: ${width}×${height} format=rgba8unorm`);
        }

        // Upload RGB565 data (no CPU conversion!)
        profiler.start("present:rgb565Upload:writeTexture");
        uploadRGB565ToGPU(queue, surface.gpuTextureRGB565, mem, surfacePtr, width, height, pitch);
        profiler.end("present:rgb565Upload:writeTexture");

        // Convert RGB565→RGBA using GPU shader
        profiler.start("present:rgb565Upload:gpuConvert");
        const backend = system.services.render.getBackend();
        if (backend?.kind === "webgpu") {
            const webgpu = backend as WebGPUBackend;
            const encoder = device.createCommandEncoder();

            if (surface.gpuTextureRGB565View && surface.gpuTextureView) {
                webgpu.convertRGB565ToRGBA(
                    surface.gpuTextureRGB565View,
                    surface.gpuTextureView,
                    encoder
                );
            }

            queue.submit([encoder.finish()]);
        }
        profiler.end("present:rgb565Upload:gpuConvert");

        // Mark as uploaded
        if (isRenderSurface(surface)) {
            surface.gpuDirty = false;
            surface.lastUploadVersion = surface.version;
        }

        Logger.verbose(LogCategory.DDRAW,
            `⚡ GPU RGB565 upload: ${width}×${height} (${(width * height * 2 / 1024).toFixed(1)}KB)`
        );
    }
}
