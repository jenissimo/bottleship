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
    GR_LFBWRITEMODE_888,
    GR_LFBWRITEMODE_555,
    GR_LFBWRITEMODE_555_DEPTH,
    GR_LFBWRITEMODE_ZA16,
} from "./constants";
import { GlideContext, GlideLfbSurfaceState } from "./context";
import { getOverlayCompositePlan } from "../user32/dialog-overlay";
import { getVideoPlanePlan, notifyVideoPlaneComposited } from "../../video/video-plane-policy";
import { captureGlideFrame } from "./frame-capture";

/**
 * One LFB pixel as an RGBA8 little-endian word (r | g<<8 | b<<16 | a<<24) — the
 * memory order a Uint32Array store lays down over the Uint8Array the upload reads.
 * A whole pixel per store is four times fewer memory operations than a byte each,
 * over 307k pixels of every presented frame.
 */
function packRgba32(r: number, g: number, b: number, a: number): number {
    return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

/** 32-bit LFB word -> RGBA8 word, per the lane mapping grLfbWriteColorFormat set. */
function swizzle8888(raw32: number, colorFormat: number): number {
    switch (colorFormat | 0) {
        case GR_COLORFORMAT_ABGR:
            return raw32 >>> 0;
        case GR_COLORFORMAT_RGBA:
            return (
                ((raw32 >>> 24) & 0xff) | (((raw32 >>> 16) & 0xff) << 8) |
                (((raw32 >>> 8) & 0xff) << 16) | ((raw32 & 0xff) << 24)
            ) >>> 0;
        case GR_COLORFORMAT_BGRA:
            return ((raw32 >>> 8) | ((raw32 & 0xff) << 24)) >>> 0;
        case GR_COLORFORMAT_ARGB:
        default:
            return (((raw32 >>> 16) & 0xff) | (raw32 & 0xff00ff00) | ((raw32 & 0xff) << 16)) >>> 0;
    }
}

// 5- and 6-bit channel expansion, exact (v * 255 / 31 and v * 255 / 63) via a table
// so the table build does one indexed load instead of a multiply and a divide.
const EXPAND_5 = new Uint8Array(32);
for (let i = 0; i < 32; i++) EXPAND_5[i] = Math.round(i * 255 / 31);
const EXPAND_6 = new Uint8Array(64);
for (let i = 0; i < 64; i++) EXPAND_6[i] = Math.round(i * 255 / 63);

/**
 * The 16-bit colour modes have only 65536 possible pixels, so the whole conversion
 * collapses to one table lookup — no shifts, no per-pixel branch on the mode. Built
 * once per mode (256 KB each, and a title uses one), amortised over every frame it
 * ever presents.
 */
const lut16ByMode = new Map<number, Uint32Array>();

/** The canonical 16-bit colour mode a raw u16 pixel is read as. The *_DEPTH modes
 *  carry the same colour layout in their low half, and everything else is 565 — the
 *  Voodoo's natural colour buffer. */
export function canonical16BitMode(mode: number): number {
    switch (mode | 0) {
        case GR_LFBWRITEMODE_555:
        case GR_LFBWRITEMODE_555_DEPTH:
            return GR_LFBWRITEMODE_555;
        case GR_LFBWRITEMODE_1555:
        case GR_LFBWRITEMODE_1555_DEPTH:
            return GR_LFBWRITEMODE_1555;
        case GR_LFBWRITEMODE_ZA16:
            return GR_LFBWRITEMODE_ZA16;
        default:
            return GR_LFBWRITEMODE_565;
    }
}

function lut16For(canonicalMode: number): Uint32Array {
    const cached = lut16ByMode.get(canonicalMode);
    if (cached) return cached;
    const table = new Uint32Array(65536);
    for (let raw = 0; raw < 65536; raw++) {
        switch (canonicalMode) {
            case GR_LFBWRITEMODE_555:
                table[raw] = packRgba32(
                    EXPAND_5[(raw >>> 10) & 0x1f]!, EXPAND_5[(raw >>> 5) & 0x1f]!, EXPAND_5[raw & 0x1f]!, 255);
                break;
            case GR_LFBWRITEMODE_1555:
                table[raw] = packRgba32(
                    EXPAND_5[(raw >>> 10) & 0x1f]!, EXPAND_5[(raw >>> 5) & 0x1f]!, EXPAND_5[raw & 0x1f]!,
                    (raw & 0x8000) ? 255 : 0);
                break;
            case GR_LFBWRITEMODE_ZA16:
                table[raw] = packRgba32(0, 0, 0, 255);
                break;
            default:
                table[raw] = packRgba32(
                    EXPAND_5[(raw >>> 11) & 0x1f]!, EXPAND_6[(raw >>> 5) & 0x3f]!, EXPAND_5[raw & 0x1f]!, 255);
                break;
        }
    }
    lut16ByMode.set(canonicalMode, table);
    return table;
}

/**
 * LFB pixels -> RGBA8, written straight into a caller-owned word buffer.
 *
 * `out` must be a Uint32Array of width*height words; a word is one RGBA8 pixel in
 * memory order. Exported so the differential test can hold it against a scalar
 * reference — nothing else about the conversion is observable from outside.
 */
export function convertLfbToRgba(
    src: Uint8Array,
    pitch: number,
    width: number,
    height: number,
    writeMode: number,
    colorFormat: number,
    fourByte: boolean,
    out: Uint32Array,
): void {
    const mode = writeMode | 0;
    const fmt = colorFormat | 0;

    // A typed view over the source needs its element alignment; guest surfaces are
    // allocated aligned, but a caller-supplied span need not be, so fall back to
    // assembling the word from bytes rather than throwing.
    const wordBytes = fourByte ? 4 : 2;
    const aligned = (src.byteOffset % wordBytes) === 0 && (pitch % wordBytes) === 0;

    if (!fourByte) {
        const lut = lut16For(canonical16BitMode(mode));
        const src16 = aligned
            ? new Uint16Array(src.buffer, src.byteOffset, src.byteLength >>> 1)
            : null;
        for (let y = 0; y < height; y++) {
            let dst = y * width;
            if (src16) {
                let s = (y * pitch) >>> 1;
                for (let x = 0; x < width; x++, dst++, s++) out[dst] = lut[src16[s]!]!;
            } else {
                let s = y * pitch;
                for (let x = 0; x < width; x++, dst++, s += 2) {
                    out[dst] = lut[(src[s] ?? 0) | ((src[s + 1] ?? 0) << 8)]!;
                }
            }
        }
        return;
    }

    // 4-byte surfaces: the *_DEPTH modes still carry a 16-bit colour in the low half,
    // everything else is a full 32-bit word in the configured lane order.
    const depthLut =
        (mode === GR_LFBWRITEMODE_565_DEPTH || mode === GR_LFBWRITEMODE_555_DEPTH ||
         mode === GR_LFBWRITEMODE_1555_DEPTH)
            ? lut16For(canonical16BitMode(mode))
            : null;
    const opaque = mode === GR_LFBWRITEMODE_888;
    const src32 = aligned ? new Uint32Array(src.buffer, src.byteOffset, src.byteLength >>> 2) : null;

    for (let y = 0; y < height; y++) {
        let dst = y * width;
        let s = src32 ? (y * pitch) >>> 2 : y * pitch;
        for (let x = 0; x < width; x++, dst++) {
            const raw32 = src32
                ? src32[s]! >>> 0
                : (((src[s] ?? 0) | ((src[s + 1] ?? 0) << 8) |
                    ((src[s + 2] ?? 0) << 16) | ((src[s + 3] ?? 0) << 24)) >>> 0);
            s += src32 ? 1 : 4;
            if (depthLut) {
                out[dst] = depthLut[raw32 & 0xffff]!;
            } else {
                const rgba = swizzle8888(raw32, fmt);
                out[dst] = opaque ? ((rgba & 0x00ffffff) | 0xff000000) >>> 0 : rgba;
            }
        }
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
    convertLfbToRgba(
        src, surface.pitch, width, height, surface.writeMode, lfbColorFormat, fourByte,
        new Uint32Array(rgba.buffer, rgba.byteOffset, needed >>> 2),
    );

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
        const videoPlan = getVideoPlanePlan();
        const videoOverlayCanvas = videoPlan.onScreen ? videoPlan.canvas : null;
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
            notifyVideoPlaneComposited(videoPlan);
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
