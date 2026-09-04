import { Logger, LogCategory } from "../core/logger";
import { VideoFrameViews } from "./video-routing-types";
import { asArrayBufferView } from "../../dom-buffer";

export class VideoOverlayService {
    private canvas: OffscreenCanvas | null = null;
    private ctx: OffscreenCanvasRenderingContext2D | null = null;
    private dirty = false;
    private hasAnyContent = false;
    private ownerSessionKey: string | null = null;
    private lastSubmitAtMs = 0;
    private rgbaScratch: Uint8Array | null = null;
    /**
     * The guest presenter the plane was last composed against. A plane drawn over a DDraw
     * primary is not a plane over a later D3D9 device's back buffer: when the kind changes
     * the pixels belong to a screen that no longer exists, which is one of the ways a plane
     * outlives its content. Null until a guest presenter has been seen.
     */
    private submitPresenterKind: string | null = null;
    private submits = 0;
    private clears = 0;
    private composites = 0;
    private lastClearReason: string | null = null;

    submitFrame(sessionKey: string, frame: VideoFrameViews, presenterKind: string | null): boolean {
        if (frame.width <= 0 || frame.height <= 0) {
            return false;
        }
        if (!this.ensureCanvas(frame.width, frame.height) || !this.ctx) {
            return false;
        }

        const pixelCount = frame.width * frame.height;
        const byteCount = pixelCount * 4;
        const rgba = this.ensureScratch(byteCount);

        if (frame.pal8Indices && frame.paletteBgra && frame.pal8Indices.length >= pixelCount && frame.paletteBgra.length >= 1024) {
            this.convertPal8ToRgba(frame.pal8Indices, frame.paletteBgra, rgba, pixelCount);
        } else if (frame.bgra && frame.bgra.length >= byteCount) {
            this.convertBgraToRgba(frame.bgra, rgba, byteCount);
        } else if (frame.rgb565 && frame.rgb565.length >= pixelCount * 2) {
            this.convertRgb565ToRgba(frame.rgb565, rgba, pixelCount);
        } else {
            return false;
        }

        const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, byteCount);
        this.ctx.putImageData(new ImageData(asArrayBufferView(clamped), frame.width, frame.height), 0, 0);
        this.ownerSessionKey = sessionKey;
        this.hasAnyContent = true;
        this.dirty = true;
        this.lastSubmitAtMs = performance.now();
        if (presenterKind) this.submitPresenterKind = presenterKind;
        this.submits++;
        return true;
    }

    /** `reason` is what `state(["video"]).plane` reports for a plane that went dark. */
    clear(reason: string): void {
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.ownerSessionKey = null;
        this.hasAnyContent = false;
        this.dirty = true;
        this.submitPresenterKind = null;
        this.clears++;
        this.lastClearReason = reason;
    }

    /** The guest presenter the current pixels were composed against, if one was known. */
    getSubmitPresenterKind(): string | null {
        return this.submitPresenterKind;
    }

    noteComposited(): void {
        this.composites++;
    }

    resize(width: number, height: number): void {
        if (!this.canvas || width <= 0 || height <= 0) return;
        if (this.canvas.width === width && this.canvas.height === height) return;
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext("2d", { alpha: true, willReadFrequently: true });
        if (!this.ctx) {
            Logger.warn(LogCategory.SYSTEM, "[VideoOverlay] Failed to re-create 2D context on resize");
            return;
        }
        this.ctx.imageSmoothingEnabled = false;
        this.hasAnyContent = false;
        this.ownerSessionKey = null;
        this.submitPresenterKind = null;
        this.clears++;
        this.lastClearReason = "resize";
        this.dirty = true;
    }

    hasContent(): boolean {
        return this.hasAnyContent;
    }

    consumeDirty(): boolean {
        const wasDirty = this.dirty;
        this.dirty = false;
        return wasDirty;
    }

    isDirty(): boolean {
        return this.dirty;
    }

    getCanvas(): OffscreenCanvas | null {
        return this.canvas;
    }

    getOwnerSessionKey(): string | null {
        return this.ownerSessionKey;
    }

    getDebugInfo(): {
        hasContent: boolean;
        dirty: boolean;
        ownerSessionKey: string | null;
        width: number;
        height: number;
        lastSubmitAtMs: number;
        submitPresenterKind: string | null;
        submits: number;
        clears: number;
        composites: number;
        lastClearReason: string | null;
    } {
        return {
            hasContent: this.hasAnyContent,
            dirty: this.dirty,
            ownerSessionKey: this.ownerSessionKey,
            width: this.canvas?.width ?? 0,
            height: this.canvas?.height ?? 0,
            lastSubmitAtMs: this.lastSubmitAtMs,
            submitPresenterKind: this.submitPresenterKind,
            // submits vs composites separates "the router published frames" from "a present
            // path put them on screen" — a plane that is fed and never shown, and one that is
            // shown long after it stopped being fed, are different bugs with one symptom.
            submits: this.submits,
            clears: this.clears,
            composites: this.composites,
            lastClearReason: this.lastClearReason,
        };
    }

    private ensureCanvas(width: number, height: number): boolean {
        if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas = new OffscreenCanvas(width, height);
            this.ctx = this.canvas.getContext("2d", { alpha: true, willReadFrequently: true });
            if (!this.ctx) {
                Logger.warn(LogCategory.SYSTEM, "[VideoOverlay] Failed to create 2D context");
                this.canvas = null;
                return false;
            }
            this.ctx.imageSmoothingEnabled = false;
        }
        return true;
    }

    private ensureScratch(size: number): Uint8Array {
        if (!this.rgbaScratch || this.rgbaScratch.length < size) {
            this.rgbaScratch = new Uint8Array(size);
        }
        return this.rgbaScratch.subarray(0, size);
    }

    private convertBgraToRgba(src: Uint8Array, dst: Uint8Array, byteCount: number): void {
        for (let i = 0; i < byteCount; i += 4) {
            dst[i] = src[i + 2] ?? 0;
            dst[i + 1] = src[i + 1] ?? 0;
            dst[i + 2] = src[i] ?? 0;
            dst[i + 3] = src[i + 3] ?? 255;
        }
    }

    private convertPal8ToRgba(indices: Uint8Array, paletteBgra: Uint8Array, dst: Uint8Array, pixelCount: number): void {
        for (let i = 0; i < pixelCount; i++) {
            const paletteIndex = indices[i] ?? 0;
            const pi = paletteIndex * 4;
            const di = i * 4;
            dst[di] = paletteBgra[pi + 2] ?? 0;
            dst[di + 1] = paletteBgra[pi + 1] ?? 0;
            dst[di + 2] = paletteBgra[pi] ?? 0;
            dst[di + 3] = paletteBgra[pi + 3] ?? 255;
        }
    }

    private convertRgb565ToRgba(src: Uint8Array, dst: Uint8Array, pixelCount: number): void {
        for (let i = 0; i < pixelCount; i++) {
            const si = i * 2;
            const raw = (src[si] ?? 0) | ((src[si + 1] ?? 0) << 8);
            const r5 = (raw >> 11) & 0x1f;
            const g6 = (raw >> 5) & 0x3f;
            const b5 = raw & 0x1f;
            const di = i * 4;
            dst[di] = ((r5 << 3) | (r5 >> 2)) & 0xff;
            dst[di + 1] = ((g6 << 2) | (g6 >> 4)) & 0xff;
            dst[di + 2] = ((b5 << 3) | (b5 >> 2)) & 0xff;
            dst[di + 3] = 255;
        }
    }
}
