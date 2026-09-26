/**
 * Threaded D3D9 frame hand-off, emulator side (plan/d3d9-threaded/canvas-ownership.md, c1).
 *
 * A frame arrives as an ImageBitmap of the pre-PostFx backbuffer (d3d9-frame-handoff.ts). This
 * layer imports it onto the emulator's device and runs the same canvas composite an in-worker
 * D3D9 present runs — PostFx, video plane, GDI, stats — and it is where the canvas-present edge
 * fires, because this is where the pixels reach the canvas. The guest-present edge stays at
 * the guest's Present.
 */

import type { WebGPUBackend } from "../webgpu-backend";
import type { RenderActive } from "../../../runtime/runtime-services";
import type { VideoPlanePlan } from "../../../video/video-routing-types";
import type { OverlayCompositePlan } from "../../../modules/user32/dialog-overlay";
import { getOverlayCompositePlan } from "../../../modules/user32/dialog-overlay";
import { getVideoPlanePlan, notifyVideoPlaneComposited } from "../../../video/video-plane-policy";
import { System } from "../../../core/system";
import { statsOverlay } from "../../../core/stats-overlay";
import { recordGpuError } from "../../../core/gpu-error-log";
import { Logger, LogCategory } from "../../../core/logger";
import type { D3D9FrameMeta } from "./d3d9-frame-handoff";

export interface D3D9ScreenOverlays {
    videoOverlayCanvas?: OffscreenCanvas | null;
    gdiOverlayCanvas?: OffscreenCanvas | null;
    /** undefined = the whole GDI overlay; a list = only these live-dialog rects ([] = none). */
    gdiOverlayRects?: Array<{ x: number; y: number; w: number; h: number }>;
}

export type D3D9CanvasPresenter = Pick<WebGPUBackend,
    "getContext" | "drawTexture" | "blit" | "blitRects" | "updateStatsTexture" | "renderStatsOverlay">;

/**
 * The ONE route from the physical backbuffer image to the canvas, shared by present and
 * repaint — in-worker and through the hand-off — so no two of them can scale the same frame
 * differently.
 *
 * It goes through PostFxChain (drawTexture opaque + `present:{…}`), which is what gives
 * D3D9 gamma, colour grade, FXAA and — because src and out are genuinely different sizes —
 * aspectMode/integerScale. The overlays follow it onto the CANVAS: they are guest-space
 * planes placed in the published content rect, and blit/blitRects measure that rect
 * against the canvas, not against a supersampled offscreen.
 */
export function presentD3D9FrameToCanvas(
    backend: D3D9CanvasPresenter,
    sourceView: GPUTextureView,
    srcW: number,
    srcH: number,
    encoder: GPUCommandEncoder,
    overlays?: D3D9ScreenOverlays,
): void {
    const context = backend.getContext();
    if (!context) return;
    const currentTexture = context.getCurrentTexture();
    const targetView = currentTexture.createView();
    backend.drawTexture(
        sourceView,
        targetView,
        encoder,
        true,
        undefined,
        undefined,
        { r: 0, g: 0, b: 0, a: 1 },
        undefined,
        {
            srcW, srcH,
            outW: currentTexture.width, outH: currentTexture.height,
            toCanvas: true,
        },
    );

    // Video plane first, then GDI: a live dialog sits above a movie.
    if (overlays?.videoOverlayCanvas) {
        backend.blit(overlays.videoOverlayCanvas, targetView, encoder);
    }
    if (overlays?.gdiOverlayCanvas) {
        const rects = overlays.gdiOverlayRects;
        if (rects) {
            // 3D renderer owns the screen: composite only live-dialog rects (never the
            // whole overlay). An empty list intentionally composites nothing.
            if (rects.length) backend.blitRects(overlays.gdiOverlayCanvas, targetView, encoder, rects);
        } else {
            backend.blit(overlays.gdiOverlayCanvas, targetView, encoder);
        }
    }

    if (statsOverlay.isEnabled()) {
        const statsCanvas = statsOverlay.getCanvas();
        if (statsCanvas) {
            if (statsOverlay.isDirty()) {
                backend.updateStatsTexture(statsCanvas);
                statsOverlay.clearDirty();
            }
            backend.renderStatsOverlay(targetView, encoder);
        }
    }
}

export type D3D9ScreenBackend = D3D9CanvasPresenter & Pick<WebGPUBackend, "getDevice" | "getQueue" | "getFormat">;

/** The GDI overlay plane as the composite reads it (System.gdiContext). */
export interface D3D9GdiPlane {
    hasOverlayContent(): boolean;
    getOverlayCanvas(): OffscreenCanvas | null;
    isOverlayDirty(): boolean;
    clearOverlayDirty(): void;
}

/** The emulator-side state a composite decides from and reports to. */
export interface D3D9ScreenHost {
    videoPlan(): VideoPlanePlan;
    videoComposited(plan: VideoPlanePlan): void;
    gdi(): D3D9GdiPlane | null;
    overlayPlan(owner: RenderActive): OverlayCompositePlan;
    canvasPresented(): void;
}

export const systemD3D9ScreenHost: D3D9ScreenHost = {
    videoPlan: () => getVideoPlanePlan(),
    videoComposited: (plan) => notifyVideoPlaneComposited(plan),
    gdi: () => System.getInstance().gdiContext ?? null,
    overlayPlan: (owner) => getOverlayCompositePlan(owner),
    canvasPresented: () => System.getInstance().services.render.notifyCanvasPresent("d3d9"),
};

export interface D3D9ScreenLayerStats {
    /** Frames handed in. Every one is exactly one of presented / stale / failed. */
    received: number;
    presented: number;
    /** Serial not newer than the last presented one: closed unshown. */
    stale: number;
    /** No device or canvas, an extent that disagrees with its label, or a throw. */
    failed: number;
    repaints: number;
    lastSerial: number;
    lastLatencyMs: number;
    maxLatencyMs: number;
}

export class D3D9ScreenLayer {
    private importTexture: GPUTexture | null = null;
    private importView: GPUTextureView | null = null;
    private importDevice: GPUDevice | null = null;
    private hasFrame = false;
    private lastMeta: D3D9FrameMeta | null = null;
    private readonly stats: D3D9ScreenLayerStats = {
        received: 0, presented: 0, stale: 0, failed: 0, repaints: 0,
        lastSerial: 0, lastLatencyMs: 0, maxLatencyMs: 0,
    };

    /** `owner` is the presenter whose screen this is: the GDI overlay plan keys its
     *  3D-owns-the-screen and exclusive-fullscreen answers off it. */
    constructor(
        private readonly backend: D3D9ScreenBackend,
        readonly owner: RenderActive,
        private readonly host: D3D9ScreenHost = systemD3D9ScreenHost,
    ) {}

    /**
     * THE boundary: one frame from the render side. Takes ownership of `bitmap` and closes it
     * on every path — an unclosed bitmap holds GPU memory until GC.
     */
    presentFrame(bitmap: ImageBitmap, meta: D3D9FrameMeta): void {
        const s = this.stats;
        s.received++;
        let presented = false;
        try {
            if (!(meta.serial > s.lastSerial)) {
                s.stale++;
                return;
            }
            const device = this.backend.getDevice();
            const queue = this.backend.getQueue();
            const format = this.backend.getFormat();
            if (!device || !queue || !format || !this.backend.getContext()) {
                this.fail(`frame ${meta.serial}: no device or canvas to present it on`);
                return;
            }
            const width = bitmap.width, height = bitmap.height;
            if (width !== meta.physicalWidth || height !== meta.physicalHeight || width <= 0 || height <= 0) {
                this.fail(`frame ${meta.serial}: bitmap is ${width}x${height}, labelled ${meta.physicalWidth}x${meta.physicalHeight}`);
                return;
            }
            this.ensureImportTexture(device, format, width, height);
            queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.importTexture! }, { width, height });
            s.lastSerial = meta.serial;
            this.hasFrame = true;
            // Before the video decision below, which reads it: an in-worker present records its
            // draw count before deciding the plane too.
            this.lastMeta = meta;

            // The overlay decision D3D9Device.submitFrame makes for an in-worker present, made
            // here instead: at arrival, against the emulator's own policies.
            const videoPlan = this.host.videoPlan();
            const videoOverlayCanvas = videoPlan.onScreen ? videoPlan.canvas : null;
            const gdi = this.host.gdi();
            const gdiOverlayCanvas = gdi?.hasOverlayContent() ? gdi.getOverlayCanvas() : null;
            let gdiOverlayRects: Array<{ x: number; y: number; w: number; h: number }> | undefined;
            if (gdiOverlayCanvas) {
                const plan = this.host.overlayPlan(this.owner);
                if (plan.mode === "rects") gdiOverlayRects = plan.rects;
                else if (plan.mode === "none") gdiOverlayRects = [];
            }
            const encoder = device.createCommandEncoder();
            presentD3D9FrameToCanvas(this.backend, this.importView!, width, height, encoder,
                { videoOverlayCanvas, gdiOverlayCanvas, gdiOverlayRects });
            queue.submit([encoder.finish()]);
            if (videoOverlayCanvas) this.host.videoComposited(videoPlan);
            if (gdi?.isOverlayDirty()) gdi.clearOverlayDirty();
            presented = true;
        } catch (e) {
            this.fail(`frame ${meta.serial}: ${String(e)}`);
        } finally {
            bitmap.close();
        }
        if (!presented) return;
        s.presented++;
        const latency = performance.timeOrigin + performance.now() - meta.sentAt;
        s.lastLatencyMs = latency;
        if (latency > s.maxLatencyMs) s.maxLatencyMs = latency;
        this.host.canvasPresented();
    }

    /** RenderActive.repaintLastFrame for a handed-off presenter: the last imported frame, no
     *  guest overlays (the GDI loop composites those right after). Not a canvas-present edge. */
    repaintLastFrame(): void {
        if (!this.hasFrame) return;
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        // A replacement device holds none of the old device's textures.
        if (!device || !queue || device !== this.importDevice || !this.importTexture || !this.backend.getContext()) return;
        const encoder = device.createCommandEncoder();
        presentD3D9FrameToCanvas(this.backend, this.importView!, this.importTexture.width, this.importTexture.height, encoder);
        queue.submit([encoder.finish()]);
        this.stats.repaints++;
    }

    /** RenderActive.getLastPresentDrawCount for a handed-off presenter: the latest frame
     *  accepted here. Null before one arrives, which the video policy reads as "unknown". */
    getLastPresentDrawCount(): number | null {
        return this.lastMeta?.drawCount ?? null;
    }

    /** The latest accepted frame's meta (guest/physical extent, serial, draw count). */
    getLastFrameMeta(): Readonly<D3D9FrameMeta> | null {
        return this.lastMeta;
    }

    getStats(): D3D9ScreenLayerStats {
        return { ...this.stats };
    }

    private ensureImportTexture(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
        const t = this.importTexture;
        if (t && this.importDevice === device && t.width === width && t.height === height && t.format === format) return;
        if (t && this.importDevice === device) t.destroy();
        this.importTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format,
            // RENDER_ATTACHMENT + COPY_DST are what copyExternalImageToTexture demands of its
            // destination; TEXTURE_BINDING is the PostFx source.
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.importView = this.importTexture.createView();
        this.importDevice = device;
        this.hasFrame = false;
    }

    private fail(message: string): void {
        this.stats.failed++;
        recordGpuError("throw", "d3d9ScreenLayer.presentFrame", message);
        if (this.stats.failed % 200 === 1) {
            Logger.error(LogCategory.D3D9, `[D3D9 screen] frame not presented (${this.stats.failed} so far): ${message}`);
        }
    }
}
