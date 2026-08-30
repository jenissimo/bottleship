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
import { captureGlideFrame } from "./frame-capture";

/**
 * LFB -> RGBA8, written straight into a caller-owned buffer.
 *
 * This runs over every pixel of every presented frame. The obvious shape — a
 * helper per format returning [r,g,b,a] — allocates one array PER PIXEL, which
 * at 640x480 is 307k short-lived arrays a frame; the cost lands in GC, far from
 * the present that caused it. Decode inline, write four bytes, allocate nothing.
 */
function decodeLfb8888Pixel(raw32: number, colorFormat: number, out: Uint8Array, o: number): void {
    switch (colorFormat | 0) {
        case GR_COLORFORMAT_ABGR:
            out[o] = raw32 & 0xff;
            out[o + 1] = (raw32 >>> 8) & 0xff;
            out[o + 2] = (raw32 >>> 16) & 0xff;
            out[o + 3] = (raw32 >>> 24) & 0xff;
            return;
        case GR_COLORFORMAT_RGBA:
            out[o] = (raw32 >>> 24) & 0xff;
            out[o + 1] = (raw32 >>> 16) & 0xff;
            out[o + 2] = (raw32 >>> 8) & 0xff;
            out[o + 3] = raw32 & 0xff;
            return;
        case GR_COLORFORMAT_BGRA:
            out[o] = (raw32 >>> 8) & 0xff;
            out[o + 1] = (raw32 >>> 16) & 0xff;
            out[o + 2] = (raw32 >>> 24) & 0xff;
            out[o + 3] = raw32 & 0xff;
            return;
        case GR_COLORFORMAT_ARGB:
        default:
            out[o] = (raw32 >>> 16) & 0xff;
            out[o + 1] = (raw32 >>> 8) & 0xff;
            out[o + 2] = raw32 & 0xff;
            out[o + 3] = (raw32 >>> 24) & 0xff;
            return;
    }
}

// 5- and 6-bit channel expansion, exact (v * 255 / 31 and v * 255 / 63) via a table
// so the per-pixel loop does one indexed load instead of a multiply and a divide.
const EXPAND_5 = new Uint8Array(32);
for (let i = 0; i < 32; i++) EXPAND_5[i] = Math.round(i * 255 / 31);
const EXPAND_6 = new Uint8Array(64);
for (let i = 0; i < 64; i++) EXPAND_6[i] = Math.round(i * 255 / 63);

type SurfaceRgbaResult = {
    pixels: Uint8Array;
    surface: GlideLfbSurfaceState;
};

function surfaceToRgba(context: GlideContext): SurfaceRgbaResult | null {
    const activeSurface = context.lfbSurfaces.get(context.renderBuffer);
    const backSurface = context.lfbSurfaces.get(GR_BUFFER_BACKBUFFER);
    const frontSurface = context.lfbSurfaces.get(GR_BUFFER_FRONTBUFFER);
    let anyDirtySurface: GlideLfbSurfaceState | null = null;
    let anySurface: GlideLfbSurfaceState | null = null;
    for (const s of context.lfbSurfaces.values()) {
        anySurface ??= s;
        if (s.dirty && !anyDirtySurface) anyDirtySurface = s;
    }
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

    const width = context.width;
    const height = context.height;
    const needed = width * height * 4;
    let rgba = context.lfbRgbaScratch;
    const cacheValid = !!rgba && rgba.length === needed && context.lfbRgbaSource === surface.dataPtr;
    // `dirty` is cleared at every present, so a surface the guest did not write
    // since then holds byte-identical pixels — the conversion would reproduce what
    // the scratch already has. Exact, not a heuristic.
    if (cacheValid && !surface.dirty) {
        return { pixels: rgba!, surface };
    }
    if (!rgba || rgba.length !== needed) {
        rgba = new Uint8Array(needed);
        context.lfbRgbaScratch = rgba;
    }
    context.lfbRgbaSource = surface.dataPtr;

    const fourByte = surface.bytesPerPixel === 4 || bytesPerPixelForLfbWriteMode(surface.writeMode) === 4;
    const mode = surface.writeMode | 0;

    for (let y = 0; y < height; y++) {
        const rowBase = y * surface.pitch;
        let dst = y * width * 4;
        if (fourByte) {
            for (let x = 0; x < width; x++, dst += 4) {
                const s = rowBase + x * 4;
                const raw32 = (
                    (src[s] ?? 0) | ((src[s + 1] ?? 0) << 8) |
                    ((src[s + 2] ?? 0) << 16) | ((src[s + 3] ?? 0) << 24)
                ) >>> 0;
                switch (mode) {
                    case GR_LFBWRITEMODE_565_DEPTH: {
                        const raw = raw32 & 0xffff;
                        rgba[dst] = EXPAND_5[(raw >>> 11) & 0x1f]!;
                        rgba[dst + 1] = EXPAND_6[(raw >>> 5) & 0x3f]!;
                        rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                        rgba[dst + 3] = 255;
                        break;
                    }
                    case GR_LFBWRITEMODE_555_DEPTH: {
                        const raw = raw32 & 0xffff;
                        rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                        rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                        rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                        rgba[dst + 3] = 255;
                        break;
                    }
                    case GR_LFBWRITEMODE_1555_DEPTH: {
                        const raw = raw32 & 0xffff;
                        rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                        rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                        rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                        rgba[dst + 3] = (raw & 0x8000) ? 255 : 0;
                        break;
                    }
                    case GR_LFBWRITEMODE_888:
                        decodeLfb8888Pixel(raw32, lfbColorFormat, rgba, dst);
                        rgba[dst + 3] = 255;
                        break;
                    default:
                        decodeLfb8888Pixel(raw32, lfbColorFormat, rgba, dst);
                        break;
                }
            }
            continue;
        }

        for (let x = 0; x < width; x++, dst += 4) {
            const s = rowBase + x * 2;
            const raw = (src[s] ?? 0) | ((src[s + 1] ?? 0) << 8);
            switch (mode) {
                case GR_LFBWRITEMODE_555:
                    rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                    rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                    rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                    rgba[dst + 3] = 255;
                    break;
                case GR_LFBWRITEMODE_1555:
                    rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                    rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                    rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                    rgba[dst + 3] = (raw & 0x8000) ? 255 : 0;
                    break;
                case GR_LFBWRITEMODE_ZA16:
                    rgba[dst] = 0; rgba[dst + 1] = 0; rgba[dst + 2] = 0; rgba[dst + 3] = 255;
                    break;
                default: // 565 — the Voodoo's natural 16-bit colour buffer
                    rgba[dst] = EXPAND_5[(raw >>> 11) & 0x1f]!;
                    rgba[dst + 1] = EXPAND_6[(raw >>> 5) & 0x3f]!;
                    rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                    rgba[dst + 3] = 255;
                    break;
            }
        }
    }

    return { pixels: rgba, surface };
}

/** The LFB surface the next present would upload, as RGBA — diagnostics only. */
export function debugLfbRgba(context: GlideContext): { width: number; height: number; rgba: Uint8Array } | null {
    const r = surfaceToRgba(context);
    if (!r) return null;
    return { width: context.width, height: context.height, rgba: r.pixels };
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
        const commandCount = this.context.stream.commandCount;
        const hasOnlyClearCommands = this.context.stream.onlyClears();

        if (!lfb && (this.context.frameSnapshot.frameId < 60 || ((this.context.frameSnapshot.frameId & 31) === 0))) {
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
            this.context.lfbWriteMark = -1;
            this.context.lfbReadThisFrame = false;
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

        const frameInput = {
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
            lfbVersion: this.context.lfbContentVersion,
            // A write that landed after the last draw is a post-process over the finished
            // frame, not the background it started from.
            lfbAfterDraws:
                this.context.lfbReadThisFrame &&
                this.context.lfbWriteMark >= 0 &&
                this.context.lfbWriteMark >= this.context.stream.commandCount,
            videoOverlayCanvas,
            gdiOverlayCanvas,
            gdiOverlayRects,
        };
        captureGlideFrame(this.context.frameSnapshot.frameId, frameInput);
        this.context.executor.executeFrame(frameInput);

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
        this.context.lfbWriteMark = -1;
        this.context.lfbReadThisFrame = false;
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
