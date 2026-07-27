import { RenderActive } from "../../runtime/runtime-services";
import { Mem } from "../../core/memory/mem-accessor";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { frameProfiler } from "../../core/frame-profiler";
import { statsOverlay } from "../../core/stats-overlay";
import {
    bytesPerPixelForLfbWriteMode,
    GR_BUFFER_BACKBUFFER,
    GR_BUFFER_FRONTBUFFER,
    GR_COLORFORMAT_ABGR,
    GR_COLORFORMAT_ARGB,
    GR_COLORFORMAT_BGRA,
    GR_COLORFORMAT_RGBA,
    GR_LFBWRITEMODE_1555,
    GR_LFBWRITEMODE_1555_DEPTH,
    GR_LFBWRITEMODE_565,
    GR_LFBWRITEMODE_565_DEPTH,
    GR_LFBWRITEMODE_8888,
    GR_LFBWRITEMODE_888,
    GR_LFBWRITEMODE_555,
    GR_LFBWRITEMODE_555_DEPTH,
    GR_LFBWRITEMODE_ZA16,
} from "./constants";
import { GlideContext, GlideLfbSurfaceState } from "./context";
import { getOverlayCompositePlan } from "../user32/dialog-overlay";

function packRgb565ToRgba(raw: number): [number, number, number, number] {
    const r = ((raw >>> 11) & 0x1f) * 255 / 31;
    const g = ((raw >>> 5) & 0x3f) * 255 / 63;
    const b = (raw & 0x1f) * 255 / 31;
    return [r | 0, g | 0, b | 0, 255];
}

function packRgb555ToRgba(raw: number): [number, number, number, number] {
    const r = ((raw >>> 10) & 0x1f) * 255 / 31;
    const g = ((raw >>> 5) & 0x1f) * 255 / 31;
    const b = (raw & 0x1f) * 255 / 31;
    return [r | 0, g | 0, b | 0, 255];
}

function packArgb1555ToRgba(raw: number): [number, number, number, number] {
    const r = ((raw >>> 10) & 0x1f) * 255 / 31;
    const g = ((raw >>> 5) & 0x1f) * 255 / 31;
    const b = (raw & 0x1f) * 255 / 31;
    const a = (raw & 0x8000) ? 255 : 0;
    return [r | 0, g | 0, b | 0, a];
}

function decodeLfb8888Pixel(raw32: number, colorFormat: number): [number, number, number, number] {
    switch (colorFormat | 0) {
        case GR_COLORFORMAT_ABGR:
            return [
                raw32 & 0xff,
                (raw32 >>> 8) & 0xff,
                (raw32 >>> 16) & 0xff,
                (raw32 >>> 24) & 0xff,
            ];
        case GR_COLORFORMAT_RGBA:
            return [
                (raw32 >>> 24) & 0xff,
                (raw32 >>> 16) & 0xff,
                (raw32 >>> 8) & 0xff,
                raw32 & 0xff,
            ];
        case GR_COLORFORMAT_BGRA:
            return [
                (raw32 >>> 8) & 0xff,
                (raw32 >>> 16) & 0xff,
                (raw32 >>> 24) & 0xff,
                raw32 & 0xff,
            ];
        case GR_COLORFORMAT_ARGB:
        default:
            return [
                (raw32 >>> 16) & 0xff,
                (raw32 >>> 8) & 0xff,
                raw32 & 0xff,
                (raw32 >>> 24) & 0xff,
            ];
    }
}

type SurfaceRgbaResult = {
    pixels: Uint8Array;
    surface: GlideLfbSurfaceState;
};

function surfaceToRgba(context: GlideContext): SurfaceRgbaResult | null {
    const activeSurface = context.lfbSurfaces.get(context.renderBuffer);
    const backSurface = context.lfbSurfaces.get(GR_BUFFER_BACKBUFFER);
    const frontSurface = context.lfbSurfaces.get(GR_BUFFER_FRONTBUFFER);
    const anyDirtySurface = Array.from(context.lfbSurfaces.values()).find((s) => s.dirty) ?? null;
    const anySurface = anyDirtySurface ?? (context.lfbSurfaces.values().next().value ?? null);
    const surface =
        (activeSurface?.dirty ? activeSurface : null) ??
        (backSurface?.dirty ? backSurface : null) ??
        (frontSurface?.dirty ? frontSurface : null) ??
        anyDirtySurface ??
        activeSurface ??
        backSurface ??
        frontSurface ??
        anySurface;
    if (!surface) return null;

    const src = Mem.readBytes(surface.dataPtr, surface.byteSize);
    if (!src) return null;
    const lfbColorFormat = context.lfbWriteColorFormat | 0;

    if (surface.bytesPerPixel === 4 || bytesPerPixelForLfbWriteMode(surface.writeMode) === 4) {
        const rgba = new Uint8Array(context.width * context.height * 4);
        for (let y = 0; y < context.height; y++) {
            const rowBase = y * surface.pitch;
            for (let x = 0; x < context.width; x++) {
                const srcOffset = rowBase + x * 4;
                const raw32 = (
                    (src[srcOffset] ?? 0) |
                    ((src[srcOffset + 1] ?? 0) << 8) |
                    ((src[srcOffset + 2] ?? 0) << 16) |
                    ((src[srcOffset + 3] ?? 0) << 24)
                ) >>> 0;
                let c: [number, number, number, number];
                switch (surface.writeMode | 0) {
                    case GR_LFBWRITEMODE_8888:
                        c = decodeLfb8888Pixel(raw32, lfbColorFormat);
                        break;
                    case GR_LFBWRITEMODE_888:
                        c = decodeLfb8888Pixel(raw32, lfbColorFormat);
                        c[3] = 255;
                        break;
                    case GR_LFBWRITEMODE_565_DEPTH:
                        c = packRgb565ToRgba(raw32 & 0xffff);
                        break;
                    case GR_LFBWRITEMODE_555_DEPTH:
                        c = packRgb555ToRgba(raw32 & 0xffff);
                        break;
                    case GR_LFBWRITEMODE_1555_DEPTH:
                        c = packArgb1555ToRgba(raw32 & 0xffff);
                        break;
                    default:
                        c = decodeLfb8888Pixel(raw32, lfbColorFormat);
                        break;
                }
                const dstOffset = (y * context.width + x) * 4;
                rgba[dstOffset + 0] = c[0];
                rgba[dstOffset + 1] = c[1];
                rgba[dstOffset + 2] = c[2];
                rgba[dstOffset + 3] = c[3];
            }
        }
        return { pixels: rgba, surface };
    }

    const rgba = new Uint8Array(context.width * context.height * 4);
    for (let y = 0; y < context.height; y++) {
        const rowBase = y * surface.pitch;
        for (let x = 0; x < context.width; x++) {
            const srcOffset = rowBase + x * 2;
            const raw = (src[srcOffset] ?? 0) | ((src[srcOffset + 1] ?? 0) << 8);
            let c: [number, number, number, number];
            if (surface.writeMode === GR_LFBWRITEMODE_565) {
                c = packRgb565ToRgba(raw);
            } else if (surface.writeMode === GR_LFBWRITEMODE_555) {
                c = packRgb555ToRgba(raw);
            } else if (surface.writeMode === GR_LFBWRITEMODE_1555) {
                c = packArgb1555ToRgba(raw);
            } else if (surface.writeMode === GR_LFBWRITEMODE_ZA16) {
                c = [0, 0, 0, 255];
            } else {
                c = packRgb565ToRgba(raw);
            }
            const dstOffset = (y * context.width + x) * 4;
            rgba[dstOffset + 0] = c[0];
            rgba[dstOffset + 1] = c[1];
            rgba[dstOffset + 2] = c[2];
            rgba[dstOffset + 3] = c[3];
        }
    }

    return { pixels: rgba, surface };
}

export class GlidePresenter implements RenderActive {
    readonly suppressGdiOverlay = true;
    private readonly counters: Record<string, number> = {
        frames: 0,
        draws: 0,
        presents: 0,
    };

    private prevPresentTime = 0;

    constructor(private readonly context: GlideContext) {}

    getCounters(): Record<string, number> {
        const snapshot = this.context.frameSnapshot;
        return {
            ...this.counters,
            drawCalls: snapshot.drawCalls,
            presents: snapshot.presents,
            textureUploads: snapshot.frameCounters.uploads,
            lfbWrites: snapshot.lfbWrites,
            lfbReads: snapshot.lfbReads,
        };
    }

    /** PNG of the screen. The executor's own capture reads the offscreen texture, which
     *  predates the video/GDI/stats composite done straight onto the canvas — canvas first. */
    async captureFrame(): Promise<Blob> {
        const screen = await System.getInstance().services.render.tryCaptureScreen();
        if (screen) return screen;
        return this.context.executor?.captureFrame() ?? new Blob();
    }

    /** The Glide offscreen render target alone — before the canvas composite. */
    async capturePresentedLayer(): Promise<Blob | null> {
        return (await this.context.executor?.captureFrame()) ?? null;
    }

    presentFrame(swapInterval: number): boolean {
        if (!this.context.winOpen || !this.context.executor) {
            return false;
        }

        const lfb = surfaceToRgba(this.context);
        const lfbPixels = lfb?.pixels;
        const vertexCount = this.context.stream.getVertexCount();
        const commandCount = this.context.stream.commandTypes.length;
        const hasOnlyClearCommands =
            commandCount > 0 && this.context.stream.commandTypes.every((t) => t === 1 /* Legacy3DCommandType.Clear */);

        if (lfb && (this.context.frameSnapshot.frameId < 240 || ((this.context.frameSnapshot.frameId & 63) === 0))) {
            const samplePixels = Math.min(1024, Math.floor(lfb.pixels.length / 4));
            let nonBlack = 0;
            for (let i = 0; i < samplePixels; i++) {
                const p = i * 4;
                if ((lfb.pixels[p] | lfb.pixels[p + 1] | lfb.pixels[p + 2]) !== 0) nonBlack++;
            }
            Logger.log(
                LogCategory.SYSTEM,
                `[Glide] present frame=${this.context.frameSnapshot.frameId} swap=${swapInterval} ` +
                `renderBuf=${this.context.renderBuffer} lfbBuf=${lfb.surface.buffer} ` +
                `mode=${lfb.surface.writeMode} bpp=${lfb.surface.bytesPerPixel} ` +
                `dirty=${lfb.surface.dirty ? 1 : 0} sampleNonBlack=${nonBlack}/${samplePixels} ` +
                `cmds=${commandCount} verts=${vertexCount}`
            );
        } else if (!lfb && (this.context.frameSnapshot.frameId < 60 || ((this.context.frameSnapshot.frameId & 31) === 0))) {
            Logger.warn(
                LogCategory.SYSTEM,
                `[Glide] present frame=${this.context.frameSnapshot.frameId}: no LFB surface selected ` +
                `(cmds=${commandCount} verts=${vertexCount})`
            );
        }

        // Do not overwrite the current output with an empty/black frame when Glide has no actual content.
        // This commonly happens during cutscenes where video is presented by another pipeline.
        if (!lfb && vertexCount === 0 && (commandCount === 0 || hasOnlyClearCommands)) {
            if (this.context.frameSnapshot.frameId < 240 || ((this.context.frameSnapshot.frameId & 63) === 0)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] skip empty present frame=${this.context.frameSnapshot.frameId} ` +
                    `swap=${swapInterval} commands=${commandCount} onlyClear=${hasOnlyClearCommands ? 1 : 0}`
                );
            }

            this.context.stream.reset();
            for (const surface of this.context.lfbSurfaces.values()) {
                surface.dirty = false;
            }

            this.context.frameSnapshot.frameId++;
            this.context.frameSnapshot.presents++;
            this.context.frameSnapshot.lastSwap = {
                swapInterval,
                timestamp: performance.now(),
            };

            this.counters.frames = this.context.frameSnapshot.frameId;
            this.counters.presents = this.context.frameSnapshot.presents;
            this.counters.draws = this.context.frameSnapshot.drawCalls;
            this.markFrameMetrics();
            this.dumpDiagnosticsIfDue();
            return true;
        }

        const system = System.getInstance();
        const videoOverlayService = system.videoRouting.getOverlayService();
        const videoOverlayCanvas = videoOverlayService.hasContent() ? videoOverlayService.getCanvas() : null;
        const gdiOverlayCanvas = system.gdiContext.hasOverlayContent() ? system.gdiContext.getOverlayCanvas() : null;

        // GDI overlay follows the single shared policy (getOverlayCompositePlan). Glide always
        // owns the screen (suppressGdiOverlay), so plan.mode is 'none' (nothing) or 'rects'
        // (only live modal dialogs) — never the whole overlay. rects encoding matches D3D9:
        // undefined = whole overlay ('full'); [] = nothing; [rects] = those dialog rects.
        let gdiOverlayRects: Array<{ x: number; y: number; w: number; h: number }> | undefined;
        if (gdiOverlayCanvas) {
            const plan = getOverlayCompositePlan(this);
            if (plan.mode === 'rects') gdiOverlayRects = plan.rects;
            else if (plan.mode === 'none') gdiOverlayRects = [];
        }

        this.context.executor.executeFrame({
            stream: this.context.stream,
            width: this.context.width,
            height: this.context.height,
            clearColor: this.context.pendingClearColor,
            clearDepth: this.context.pendingClearDepth,
            alphaRef: this.context.runtime.alphaReference,
            constantColor: this.context.runtime.constantColorValue,
            chromaKeyEnabled: this.context.runtime.chromaKeyMode !== 0,
            chromaKey: this.context.runtime.chromaKeyValue,
            fogTable: this.context.runtime.fogTable,
            gammaCorrection: this.context.runtime.gammaValue,
            lfbPixels,
            lfbPitch: this.context.width * 4,
            videoOverlayCanvas,
            gdiOverlayCanvas,
            gdiOverlayRects,
        });

        if (videoOverlayCanvas) {
            videoOverlayService.consumeDirty();
        }
        if (system.gdiContext.isOverlayDirty()) {
            system.gdiContext.clearOverlayDirty();
        }
        system.services.render.notifyPresent("glide");

        const pipelineStats = this.context.executor.getPipelineCacheStats();
        this.context.frameSnapshot.frameCounters.cacheHits = pipelineStats.hits;
        this.context.frameSnapshot.frameCounters.cacheMisses = pipelineStats.misses;

        this.context.stream.reset();
        for (const surface of this.context.lfbSurfaces.values()) {
            surface.dirty = false;
        }

        this.context.frameSnapshot.frameId++;
        this.context.frameSnapshot.presents++;
        this.context.frameSnapshot.lastSwap = {
            swapInterval,
            timestamp: performance.now(),
        };

        this.counters.frames = this.context.frameSnapshot.frameId;
        this.counters.presents = this.context.frameSnapshot.presents;
        this.counters.draws = this.context.frameSnapshot.drawCalls;
        this.markFrameMetrics();
        this.dumpDiagnosticsIfDue();
        return true;
    }

    private dumpDiagnosticsIfDue(): void {
        const fid = this.context.frameSnapshot.frameId;
        if (fid !== 30 && fid !== 120) return;
        const events = this.context.diagnostics.getRecent(128);
        const snap = this.context.frameSnapshot;
        Logger.log(
            LogCategory.SYSTEM,
            `[Glide] diag-dump frame=${fid} surfaces=${this.context.lfbSurfaces.size} ` +
            `lfbLocks=${snap.lfbLocks} lfbUnlocks=${snap.lfbUnlocks} ` +
            `lfbWrites=${snap.lfbWrites} lfbReads=${snap.lfbReads} ` +
            `texDownloads=${snap.texDownloads} draws=${snap.drawCalls} ` +
            `renderBuffer=${this.context.renderBuffer} winOpen=${this.context.winOpen} ` +
            `events=${events.length}`,
        );
        for (const event of events) {
            Logger.log(LogCategory.SYSTEM, `[Glide] diag#${event.id} ${event.type}: ${event.detail ?? ""}`);
        }
    }

    private markFrameMetrics(): void {
        frameProfiler.markFrame("glide");
        const now = performance.now();
        if (this.prevPresentTime > 0) {
            statsOverlay.updateMetrics(now - this.prevPresentTime);
        }
        this.prevPresentTime = now;
    }
}
