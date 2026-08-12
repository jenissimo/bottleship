import { TimeService } from "./time";
import { Logger, LogCategory } from "../core/logger";
import { harnessBus } from "../harness/event-bus";
import { frameProfiler } from "../core/frame-profiler";

export interface RenderBackend {
    readonly kind: string;
    initialize(canvas: OffscreenCanvas): void | Promise<void>;
    composite(overlay: OffscreenCanvas, clearScreen?: boolean): void;
    compositeRect?(
        overlay: OffscreenCanvas,
        dstX: number, dstY: number,
        dstW: number, dstH: number,
        screenW: number, screenH: number,
        clearScreen?: boolean,
    ): void;
    /** Composite specific overlay sub-rects 1:1 (live dialogs over a flip chain). */
    compositeRects?(
        overlay: OffscreenCanvas,
        rects: Array<{ x: number; y: number; w: number; h: number }>,
    ): void;
    /**
     * Apply a per-channel gamma ramp (256 normalized entries each) as a final
     * RAMDAC-style LUT over the presented frame. Identity ramp = passthrough.
     * Optional: only hardware-accelerated backends implement it.
     */
    updateGammaLUT?(
        red: Float32Array,
        green: Float32Array,
        blue: Float32Array,
        isIdentity: boolean,
    ): void;
    /** The canvas that IS the screen (the one the host transferred). Source of truth for screenshots. */
    getScreenCanvas?(): OffscreenCanvas | null;
    /** Copy the frame just submitted to the canvas into a readable mirror (screenshots).
     *  Return false when the copy did NOT happen (unconfigured canvas, 0x0 texture) —
     *  RenderService only stamps the mirror as current on a real copy. `void` is treated as
     *  "copied" for backends that predate the return value. */
    mirrorPresentedFrame?(): void | boolean;
    /** PNG of that mirror; null until a frame has been mirrored. */
    captureMirroredFrame?(): Promise<Blob | null>;
}

export interface RenderActive {
    /** PNG of the SCREEN — canvas first (overlays composited), presenter source only as fallback. */
    captureFrame(): Promise<Blob>;
    /**
     * PNG of the presenter's OWN frame source — the game layer as it exists before the
     * canvas composite (how far "before" is backend-dependent). Splits "which layer holds
     * the pixels" from "does the composite put it on screen"; never a substitute for
     * captureFrame(). Null/absent when the presenter has no readable source of its own.
     */
    capturePresentedLayer?(): Promise<Blob | null>;
    getCounters(): Record<string, number>;
    /**
     * True for hardware 3D presenters (OpenGL/Glide/D3D) that own the whole screen
     * when active. While such a presenter is active in exclusive fullscreen, the GDI
     * present loop must NOT composite the launcher's GDI overlay over the 3D frame
     * (e.g. HL's per-frame empty WM_PAINT would otherwise flicker black). The video
     * overlay still composites (for in-game GDI video).
     */
    readonly suppressGdiOverlay?: boolean;
    /**
     * Re-present the last rendered frame to the canvas without re-rendering. The GDI
     * present loop calls this every animation frame while a low-fps 3D renderer owns
     * the screen, so the WebGPU canvas keeps showing the last frame at the display
     * refresh rate instead of going black between the renderer's sparse presents.
     */
    repaintLastFrame?(): void;
}

/** `video` is OURS: the compositor that puts a fallback video-overlay frame on the
 *  screen when the guest is inside a playback loop and presenting nothing. Everything
 *  else is a present the GUEST asked for. */
export type PresenterKind = "ddraw" | "glide" | "d3d8" | "d3d9" | "gdi" | "opengl" | "video";

export class RenderService {
    private backend: RenderBackend | null = null;
    private active: RenderActive | null = null;
    private presentSerial = 0;
    /** Presents the GUEST drove. Video routing decides "is the app presenting this movie
     *  itself?" from a rising serial, so our own video composite must not advance it —
     *  otherwise we answer our own question and clear the overlay we just drew. */
    private guestPresentSerial = 0;
    private lastPresenterKind: PresenterKind | null = null;
    private static readonly FLIP_TRACE_MARK = "bottleship.flip";

    // One-shot "first real frame" hook. The host keeps its loading screen up from
    // worker-init through guest boot and only tears it down when the guest actually
    // composites its first frame — otherwise the overlay hides at PE-load and the
    // user stares at a black canvas while the game runs CRT/DirectX/asset init.
    // Fires on the first present of any presenter AFTER armFirstPresent() re-arms it.
    //
    // Ordering invariant: armFirstPresent() is called by the loader exactly when it
    // posts loading_progress "done" (NOT at load start). That guarantees first_present
    // is emitted strictly AFTER the host has switched the overlay to "booting", so the
    // host's one-shot crossfade-out can't be clobbered by a later "done". Default is
    // "fired" (true) so stale presents during the load window — e.g. the GDI loop
    // compositing the previous game's still-dirty overlay before system.reset() — can
    // NOT trigger a premature first_present that would leave the overlay stuck forever.
    private firstPresentFired = true;
    private firstPresentCb: (() => void) | null = null;

    // --- Flip-cadence instrument (inter-present intervals) for frame-variance diagnosis.
    //     Always-on ring buffer; ~1 perf.now() + push per present (≈ display rate) = negligible.
    //     Read via flipCadence() / scope a window with flipCadenceReset() (diagnostics-commands). ---
    // Screenshot mirror: kept up to date from every present, because a screenshot must be
    // available for the frame ALREADY on screen — arming it lazily means the first capture
    // (typically of a frozen screen worth looking at) has nothing to read. Cost is one
    // full-screen texture copy per present, the same snapshot the D3D9 executor already
    // takes for repaintLastFrame.
    private screenMirrorSerial = 0;

    private flipLastMs = 0;
    private flipIntervals: number[] = [];
    private static readonly FLIP_CADENCE_CAP = 1200;

    setBackend(backend: RenderBackend): void {
        this.backend = backend;
    }

    getBackend(): RenderBackend | null {
        return this.backend;
    }

    /**
     * PNG of the SCREEN — the canvas itself, every overlay already composited.
     *
     * A presenter's own captureFrame() reads back the texture it drew FROM, and the
     * video plane / GDI dialog rects / stats overlay are blitted onto the canvas
     * AFTER that texture is recorded — so a presenter capture is blind to exactly the
     * compositing bugs a screenshot is asked to settle. Read the canvas instead.
     *
     * The mirror is the ONLY route. Reading the canvas back looks like it should work and
     * does not: a WebGPU canvas hands its presented image to the compositor, so
     * convertToBlob() throws "Readback of the source image has failed" and
     * createImageBitmap() returns either a 0x0 bitmap or a BLANK one — the current
     * (undrawn) swap texture rather than the frame on screen. It happened to match while a
     * game presented every frame, which is exactly how a wrong screenshot stays believed;
     * on a static screen (a launcher dialog, anything paused) it silently returns empty.
     *
     * Null when there is no backend/canvas at all; THROWS when nothing has ever been
     * presented — different diagnoses, and a caller that collapses them sends the reader
     * elsewhere.
     */
    async captureScreen(): Promise<Blob | null> {
        if (!this.backend?.getScreenCanvas?.()) return null;
        const mirrored = await this.backend?.captureMirroredFrame?.();
        if (mirrored) return mirrored;
        throw new Error("no frame has been presented to the canvas yet — nothing to screenshot");
    }

    /**
     * Copy this present into the readable mirror. True only when the copy ACTUALLY happened —
     * stamping the serial unconditionally is what made `shot()` hand back the previous frame
     * labelled as the latest, which is the exact failure the mirror exists to eliminate.
     */
    private mirrorCurrentFrame(): boolean {
        const backend = this.backend;
        if (!backend?.mirrorPresentedFrame) return false;
        // The backend bails on an unconfigured context or a 0x0 texture; a canvas with no
        // extent is the same condition seen from here.
        const canvas = backend.getScreenCanvas?.();
        if (canvas && (canvas.width <= 0 || canvas.height <= 0)) return false;
        return backend.mirrorPresentedFrame() !== false;
    }

    /** Presents since the mirrored frame — 0 means the mirror IS the current screen,
     *  a positive value means it is that many frames STALE, -1 that nothing was mirrored. */
    screenMirrorAge(): number {
        return this.screenMirrorSerial > 0 ? this.presentSerial - this.screenMirrorSerial : -1;
    }

    /** captureScreen() that degrades to null instead of throwing — for presenters that
     *  have their own fallback source. */
    async tryCaptureScreen(): Promise<Blob | null> {
        try {
            return await this.captureScreen();
        } catch (err) {
            Logger.warn(LogCategory.SYSTEM, `RenderService.captureScreen failed — ${(err as Error).message}`);
            return null;
        }
    }

    setActive(active: RenderActive | null): void {
        const prevActive = this.active;
        this.active = active;
        if (prevActive !== active) {
            Logger.log(LogCategory.SYSTEM, 
                `RenderService.setActive: Changed from ${prevActive?.constructor.name || 'null'} to ${active?.constructor.name || 'null'}`
            );
        }
    }

    getActive(): RenderActive | null {
        return this.active;
    }

    /**
     * Register the one-shot first-present callback (host loading-screen teardown).
     * Registration is idempotent across game loads; call armFirstPresent() to re-arm
     * the flag for a subsequent load.
     */
    onFirstPresent(cb: () => void): void {
        this.firstPresentCb = cb;
    }

    /** Re-arm the first-present hook so the next present fires it again (new game load). */
    armFirstPresent(): void {
        this.firstPresentFired = false;
    }

    notifyPresent(presenterKind: PresenterKind): void {
        this.presentSerial += 1;
        if (presenterKind !== "video") this.guestPresentSerial += 1;
        this.lastPresenterKind = presenterKind;
        // Screenshot mirror: encoded here because EVERY present path funnels through
        // notifyPresent, so no backend can silently miss it and leave a stale image.
        if (this.mirrorCurrentFrame()) this.screenMirrorSerial = this.presentSerial;
        if (!this.firstPresentFired) {
            this.firstPresentFired = true;
            try { this.firstPresentCb?.(); } catch { /* host bridge must never break the present path */ }
        }
        this.recordFlipCadence();
        // Frame-time distribution rides the SAME boundary as the cadence ring and the trace
        // mark below, so the live tail, getFlipCadence and analyze-trace cannot disagree by
        // construction — only because the world disagreed. Zero-cost while disarmed.
        frameProfiler.markPresent();
        this.emitFlipTraceMark();
        // Harness frameRendered event — gated so the perf-critical present path
        // stays zero-cost until a script opts in (watchFrames).
        if (harnessBus.frameEvents) harnessBus.emit("frameRendered", { presenterKind, serial: this.presentSerial });
    }

    private recordFlipCadence(): void {
        const t = performance.now();
        if (this.flipLastMs > 0) {
            const dt = t - this.flipLastMs;
            // Ignore absurd gaps (tab backgrounded, pause, first frame after a stall).
            if (dt > 0 && dt < 2000) {
                this.flipIntervals.push(dt);
                if (this.flipIntervals.length > RenderService.FLIP_CADENCE_CAP) this.flipIntervals.shift();
            }
        }
        this.flipLastMs = t;
    }

    /**
     * Inter-present interval distribution + a vsync-count histogram (interval / refreshMs,
     * rounded). The histogram diagnoses frame variance: a clean {2,3} split = structural
     * sub-refresh pulldown judder; a spread across {2,3,4,5} = CPU jitter; rare huge buckets
     * = micro-stalls/hangs.
     */
    getFlipCadence(refreshMs = 16.67): Record<string, unknown> {
        const a = this.flipIntervals;
        const n = a.length;
        if (n === 0) return { count: 0, note: "no presents recorded yet" };
        const sorted = [...a].sort((x, y) => x - y);
        const sum = a.reduce((s, v) => s + v, 0);
        const avg = sum / n;
        const variance = a.reduce((s, v) => s + (v - avg) * (v - avg), 0) / n;
        const pct = (p: number) => sorted[Math.min(n - 1, Math.floor(n * p))];
        const vsyncHistogram: Record<number, number> = {};
        for (const v of a) {
            const k = Math.max(1, Math.round(v / refreshMs));
            vsyncHistogram[k] = (vsyncHistogram[k] ?? 0) + 1;
        }
        return {
            count: n,
            fps: +(1000 / avg).toFixed(1),
            avgMs: +avg.toFixed(2),
            minMs: +sorted[0].toFixed(2),
            p50Ms: +pct(0.5).toFixed(2),
            p95Ms: +pct(0.95).toFixed(2),
            p99Ms: +pct(0.99).toFixed(2),
            maxMs: +sorted[n - 1].toFixed(2),
            stddevMs: +Math.sqrt(variance).toFixed(2),
            refreshMs,
            lastPresenter: this.lastPresenterKind,
            vsyncHistogram,
        };
    }

    resetFlipCadence(): void {
        this.flipIntervals = [];
        this.flipLastMs = 0;
    }

    private emitFlipTraceMark(): void {
        try {
            performance.mark(RenderService.FLIP_TRACE_MARK);
            if ((this.presentSerial & 0x7f) === 0) {
                performance.clearMarks(RenderService.FLIP_TRACE_MARK);
            }
        } catch {
            // UserTiming marks are diagnostic only; never let tracing affect present.
        }
    }

    getPresentSerial(): number {
        return this.presentSerial;
    }

    /** Presents excluding our own video compositor — see `guestPresentSerial`. */
    getGuestPresentSerial(): number {
        return this.guestPresentSerial;
    }

    getLastPresenterKind(): PresenterKind | null {
        return this.lastPresenterKind;
    }

    reset(): void {
        this.active = null;
        this.presentSerial = 0;
        this.guestPresentSerial = 0;
        this.screenMirrorSerial = 0; // the previous game's mirror is not this game's screen
        this.lastPresenterKind = null;
        this.resetFlipCadence();
        // Keep backend, it can be reused
    }
}

export class StatsService {
    private counters: Map<string, number> = new Map();

    inc(name: string, delta: number = 1): void {
        const next = (this.counters.get(name) ?? 0) + delta;
        this.counters.set(name, next);
    }

    set(name: string, value: number): void {
        this.counters.set(name, value);
    }

    snapshot(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [key, value] of this.counters.entries()) {
            out[key] = value;
        }
        return out;
    }

    reset(): void {
        this.counters.clear();
    }
}

export class RuntimeServices {
    readonly render: RenderService;
    readonly stats: StatsService;
    readonly time: TimeService;

    constructor() {
        this.render = new RenderService();
        this.stats = new StatsService();
        this.time = TimeService.getInstance();
    }

    reset(): void {
        this.render.reset();
        this.stats.reset();
        // TimeService doesn't need reset - it's stateless
    }
}
