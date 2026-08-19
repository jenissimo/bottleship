import { Logger, LogCategory } from "../core/logger";
import { RenderService } from "../runtime/runtime-services";
import { VideoOverlayService } from "./video-overlay-service";
import {
    VideoCodec,
    VideoFrameViews,
    VideoRoutingEvent,
    VideoSessionState,
    VideoSinkAdapter,
    VideoSinkKind,
    VideoTargetHint,
} from "./video-routing-types";

const ROUTER_EVENT_CAPACITY = 256;
const WARN_THROTTLE_FRAMES = 60;
const FALLBACK_AFTER_CONSECUTIVE_MISSES = 3;

export interface VideoSessionOpenOptions {
    codec: VideoCodec;
    guestHandle: number;
    width: number;
    height: number;
    fps: number;
    legacyPrimarySink?: (() => boolean) | null;
}

export interface VideoFrameDecodedOptions {
    codec: VideoCodec;
    guestHandle: number;
    frame: VideoFrameViews;
    hasAppManagedSink: boolean;
    targetHint?: Partial<VideoTargetHint> | null;
    legacyPrimarySink?: (() => boolean) | null;
    explicitDdrawSink?: (() => boolean) | null;
    explicitGlideSink?: (() => boolean) | null;
}

export interface VideoFrameFinalizeOptions {
    codec: VideoCodec;
    guestHandle: number;
    hasAppManagedSink: boolean;
    targetHint?: Partial<VideoTargetHint> | null;
    legacyPrimarySink?: (() => boolean) | null;
    explicitDdrawSink?: (() => boolean) | null;
    explicitGlideSink?: (() => boolean) | null;
}

export class VideoRoutingService {
    private readonly overlay = new VideoOverlayService();
    private readonly sessions = new Map<string, VideoSessionState>();
    private readonly sessionOrder: string[] = [];
    private readonly events: VideoRoutingEvent[] = [];
    private readonly warnFrameByKey = new Map<string, number>();
    private nextEventId = 1;

    constructor(private readonly render: RenderService) {}

    getOverlayService(): VideoOverlayService {
        return this.overlay;
    }

    /**
     * Is the overlay plane showing a movie that is still PLAYING? Structural, not timed:
     * true while the session that owns the overlay is open and still routed to it. A
     * wall-clock window would blank a paused movie or one whose decode stalled, and the
     * overlay's own content flag cannot tell playing from finished on its own.
     */
    isOverlayPlaybackLive(): boolean {
        if (!this.overlay.hasContent()) return false;
        const owner = this.overlay.getOwnerSessionKey();
        if (!owner) return false;
        const session = this.sessions.get(owner);
        return !!session && (session.sinkLockedToOverlay || session.sink === "VIDEO_OVERLAY");
    }

    reset(): void {
        for (const session of this.sessions.values()) {
            if (session.sinkLockedToOverlay) {
                this.pushEvent(session.sessionKey, "fallback_off", "router_reset");
            }
        }
        this.sessions.clear();
        this.sessionOrder.length = 0;
        this.events.length = 0;
        this.warnFrameByKey.clear();
        this.nextEventId = 1;
        this.overlay.clear();
    }

    openSession(options: VideoSessionOpenOptions): void {
        const sessionKey = this.makeSessionKey(options.codec, options.guestHandle);
        const now = performance.now();
        const frameDurationMs = options.fps > 0 ? (1000 / options.fps) : 66;
        const existing = this.sessions.get(sessionKey);
        if (existing) {
            existing.width = options.width;
            existing.height = options.height;
            existing.frameDurationMs = frameDurationMs;
            existing.legacyPrimarySink = options.legacyPrimarySink ?? existing.legacyPrimarySink;
            this.pushEvent(sessionKey, "session_open", "reopen");
            return;
        }

        const initialSerial = this.render.getGuestPresentSerial();
        const state: VideoSessionState = {
            sessionKey,
            codec: options.codec,
            guestHandle: options.guestHandle,
            width: options.width,
            height: options.height,
            frameDurationMs,
            openedAtMs: now,
            lastDecodedAtMs: 0,
            lastFinalizeAtMs: 0,
            presentSerialAtDecode: initialSerial,
            lastObservedPresentSerial: initialSerial,
            lastObservedPresentAtMs: now,
            consecutiveMisses: 0,
            sink: "DROP",
            sinkLockedToOverlay: false,
            targetHint: {
                kind: "none",
                valid: false,
                updatedAtMs: now,
            },
            frameViews: null,
            hasAppManagedSink: false,
            legacyPrimarySink: options.legacyPrimarySink ?? null,
            explicitDdrawSink: null,
            explicitGlideSink: null,
        };
        this.sessions.set(sessionKey, state);
        this.sessionOrder.push(sessionKey);
        this.pushEvent(sessionKey, "session_open", `${options.width}x${options.height}@${options.fps.toFixed(2)}`);
    }

    closeSession(codec: VideoCodec, guestHandle: number): void {
        const sessionKey = this.makeSessionKey(codec, guestHandle);
        const state = this.sessions.get(sessionKey);
        if (!state) return;
        if (state.sinkLockedToOverlay) {
            this.pushEvent(sessionKey, "fallback_off", "close");
        }
        if (this.overlay.getOwnerSessionKey() === sessionKey) {
            this.overlay.clear();
        }
        this.pushEvent(sessionKey, "session_close");
        this.sessions.delete(sessionKey);
        const idx = this.sessionOrder.lastIndexOf(sessionKey);
        if (idx >= 0) this.sessionOrder.splice(idx, 1);
    }

    onFrameDecoded(options: VideoFrameDecodedOptions): VideoSinkKind {
        const session = this.ensureSession(options.codec, options.guestHandle, options.frame.width, options.frame.height, options.frame.frameDurationMs);
        if (!session) return "DROP";

        const now = performance.now();
        session.width = options.frame.width;
        session.height = options.frame.height;
        session.frameDurationMs = options.frame.frameDurationMs > 0 ? options.frame.frameDurationMs : session.frameDurationMs;
        session.frameViews = options.frame;
        session.lastDecodedAtMs = now;
        // NOTE: presentSerialAtDecode is intentionally NOT updated here.
        // It is updated at the END of onFrameFinalize so that any DDraw/Glide present
        // that happens AFTER NextFrame (but before the next DoFrame) is correctly
        // detected in the next frame's finalize as appPresented=true.
        // Updating it here would snapshot the serial before the game's own present,
        // making currentSerial === presentSerialAtDecode in finalize → appPresented always false.
        session.hasAppManagedSink = options.hasAppManagedSink;
        session.legacyPrimarySink = options.legacyPrimarySink ?? session.legacyPrimarySink;
        session.explicitDdrawSink = options.explicitDdrawSink ?? session.explicitDdrawSink;
        session.explicitGlideSink = options.explicitGlideSink ?? session.explicitGlideSink;
        this.applyTargetHint(session, options.targetHint);
        return session.sink;
    }

    onFrameFinalize(options: VideoFrameFinalizeOptions): VideoSinkKind {
        const sessionKey = this.makeSessionKey(options.codec, options.guestHandle);
        const session = this.sessions.get(sessionKey);
        if (!session) return "DROP";

        session.lastFinalizeAtMs = performance.now();
        session.hasAppManagedSink = options.hasAppManagedSink;
        session.legacyPrimarySink = options.legacyPrimarySink ?? session.legacyPrimarySink;
        session.explicitDdrawSink = options.explicitDdrawSink ?? session.explicitDdrawSink;
        session.explicitGlideSink = options.explicitGlideSink ?? session.explicitGlideSink;
        this.applyTargetHint(session, options.targetHint);

        if (!session.frameViews) {
            this.updateSink(session, "DROP", "no_frame");
            return "DROP";
        }

        // GUEST presents only. Our own video compositor also calls notifyPresent (the screen
        // really is being updated), and counting that here would make the app look like it is
        // presenting the movie itself — unlocking and clearing the overlay we just drew.
        const currentSerial = this.render.getGuestPresentSerial();
        const appPresented = currentSerial > session.presentSerialAtDecode;
        if (appPresented) {
            session.lastObservedPresentSerial = currentSerial;
            session.lastObservedPresentAtMs = performance.now();
            session.consecutiveMisses = 0;
        }

        if (session.sinkLockedToOverlay) {
            // Unlock overlay when the app starts presenting the video itself.
            // Without this, stale overlay content keeps being composited on every
            // present — visible as fullscreen video drawn over the game's UI.
            if (appPresented && this.shouldTrustAppPresent(session)) {
                session.sinkLockedToOverlay = false;
                if (this.overlay.getOwnerSessionKey() === session.sessionKey) {
                    this.overlay.clear();
                }
                this.pushEvent(session.sessionKey, "fallback_off", "app_presenting");
                // Fall through to normal sink resolution below
            } else {
                const lockedSink = this.tryOverlaySink(session, "locked");
                session.presentSerialAtDecode = this.render.getGuestPresentSerial();
                return lockedSink;
            }
        }

        const preferredObservedSink = this.getObservedSink(session, appPresented);
        const hasExpectedAppSink = session.hasAppManagedSink || session.targetHint.kind === "ddraw_surface" || session.targetHint.kind === "glide_lfb";

        // Trust app present only when we have a real managed sink (DDraw/Glide/texture),
        // not bare D3D8 Present while video still lives in a CPU buffer (Morrowind Bink).
        if (appPresented && this.shouldTrustAppPresent(session)) {
            this.updateSink(session, preferredObservedSink, "app_present_observed");
            session.presentSerialAtDecode = this.render.getGuestPresentSerial();
            return session.sink;
        }

        if (hasExpectedAppSink) {
            session.consecutiveMisses += 1;
            const noPresentBudgetMs = Math.max(500, session.frameDurationMs * 2);
            const noPresentDeltaMs = performance.now() - session.lastObservedPresentAtMs;
            if (session.consecutiveMisses < FALLBACK_AFTER_CONSECUTIVE_MISSES && noPresentDeltaMs <= noPresentBudgetMs) {
                this.updateSink(session, preferredObservedSink, `await_present miss=${session.consecutiveMisses}`);
                session.presentSerialAtDecode = this.render.getGuestPresentSerial();
                return session.sink;
            }
        } else {
            session.consecutiveMisses = 0;
        }

        // Fallback chain: CODEC_LEGACY_PRIMARY -> VIDEO_OVERLAY -> DROP
        const adapters = this.buildFallbackAdapters(session);
        for (const adapter of adapters) {
            if (!adapter.canHandle(session)) continue;
            const ok = adapter.submit(session);
            this.pushEvent(session.sessionKey, ok ? "sink_submit_ok" : "sink_submit_fail", adapter.name);
            if (ok) {
                this.updateSink(session, adapter.kind, adapter.name);
                if (adapter.kind === "VIDEO_OVERLAY" && !session.sinkLockedToOverlay) {
                    session.sinkLockedToOverlay = true;
                    this.pushEvent(session.sessionKey, "fallback_on", "video_overlay_lock");
                }
                session.presentSerialAtDecode = this.render.getGuestPresentSerial();
                return session.sink;
            }
        }

        this.warnThrottled(session, "drop", `[VideoRouting] sink=DROP session=${session.sessionKey} presenter=${this.render.getLastPresenterKind() ?? "none"}`);
        this.updateSink(session, "DROP", "no_sink");
        session.presentSerialAtDecode = this.render.getGuestPresentSerial();
        return "DROP";
    }

    getDebugInfo(): {
        activeSessionKey: string | null;
        lastPresenterKind: string | null;
        presentSerial: number;
        sessions: Array<{
            sessionKey: string;
            codec: VideoCodec;
            guestHandle: number;
            sink: VideoSinkKind;
            sinkLockedToOverlay: boolean;
            misses: number;
            presentSerialDelta: number;
            targetHint: VideoTargetHint;
            lastDecodedAtMs: number;
            lastFinalizeAtMs: number;
        }>;
        ring: VideoRoutingEvent[];
        overlay: ReturnType<VideoOverlayService["getDebugInfo"]>;
    } {
        const presentSerial = this.render.getGuestPresentSerial();
        const sessions = Array.from(this.sessions.values()).map((s) => ({
            sessionKey: s.sessionKey,
            codec: s.codec,
            guestHandle: s.guestHandle,
            sink: s.sink,
            sinkLockedToOverlay: s.sinkLockedToOverlay,
            misses: s.consecutiveMisses,
            presentSerialDelta: presentSerial - s.presentSerialAtDecode,
            targetHint: { ...s.targetHint },
            lastDecodedAtMs: s.lastDecodedAtMs,
            lastFinalizeAtMs: s.lastFinalizeAtMs,
        }));

        return {
            activeSessionKey: this.sessionOrder.length > 0 ? this.sessionOrder[this.sessionOrder.length - 1] : null,
            lastPresenterKind: this.render.getLastPresenterKind(),
            presentSerial,
            sessions,
            ring: this.events.slice(-64),
            overlay: this.overlay.getDebugInfo(),
        };
    }

    private ensureSession(codec: VideoCodec, guestHandle: number, width: number, height: number, frameDurationMs: number): VideoSessionState | null {
        const key = this.makeSessionKey(codec, guestHandle);
        let session: VideoSessionState | undefined = this.sessions.get(key);
        if (session) return session;
        this.openSession({
            codec,
            guestHandle,
            width,
            height,
            fps: frameDurationMs > 0 ? 1000 / frameDurationMs : 15,
        });
        session = this.sessions.get(key);
        return session ?? null;
    }

    private shouldTrustAppPresent(session: VideoSessionState): boolean {
        if (session.hasAppManagedSink) return true;
        if (session.targetHint.kind === "ddraw_surface" && session.targetHint.valid) return true;
        if (session.targetHint.kind === "glide_lfb" && session.targetHint.valid) return true;
        // A VALID app_buffer is one the guest itself uploads (a D3D9 LockRect staging
        // buffer, a GPU-backed bitmap texture). The invalid case — a bare CPU buffer under
        // a GPU presenter — is the Morrowind-Bink shape this deliberately keeps distrusting.
        if (session.targetHint.kind === "app_buffer" && session.targetHint.valid) return true;
        return false;
    }

    private getObservedSink(session: VideoSessionState, _appPresented: boolean): VideoSinkKind {
        if (session.targetHint.kind === "ddraw_surface" && session.targetHint.valid) {
            return "EXPLICIT_DDRAW_SURFACE";
        }
        if (session.targetHint.kind === "glide_lfb" && session.targetHint.valid) {
            return "EXPLICIT_GLIDE_LFB";
        }
        if (this.shouldTrustAppPresent(session)) {
            return "APP_PRESENT_OBSERVED";
        }
        return "DROP";
    }

    private buildFallbackAdapters(session: VideoSessionState): VideoSinkAdapter[] {
        const adapters: VideoSinkAdapter[] = [];

        adapters.push({
            name: "legacy_primary",
            kind: "CODEC_LEGACY_PRIMARY",
            priority: 70,
            canHandle: (s) => typeof s.legacyPrimarySink === "function",
            submit: (s) => {
                try {
                    return s.legacyPrimarySink ? !!s.legacyPrimarySink() : false;
                } catch (error) {
                    this.warnThrottled(s, "legacy_submit", `[VideoRouting] legacy sink failed: ${error}`);
                    return false;
                }
            },
        });

        adapters.push({
            name: "video_overlay",
            kind: "VIDEO_OVERLAY",
            priority: 60,
            canHandle: (s) => !!s.frameViews && !!this.render.getBackend(),
            submit: (s) => this.tryOverlaySubmit(s),
        });

        // Explicit sink callbacks are optional. They are tried before fallback only when hint matches.
        if (session.targetHint.kind === "ddraw_surface") {
            adapters.unshift({
                name: "explicit_ddraw_surface",
                kind: "EXPLICIT_DDRAW_SURFACE",
                priority: 100,
                canHandle: (s) => typeof s.explicitDdrawSink === "function",
                submit: (s) => {
                    try {
                        return s.explicitDdrawSink ? !!s.explicitDdrawSink() : false;
                    } catch (error) {
                        this.warnThrottled(s, "explicit_ddraw_submit", `[VideoRouting] explicit ddraw sink failed: ${error}`);
                        return false;
                    }
                },
            });
        }

        if (session.targetHint.kind === "glide_lfb") {
            adapters.unshift({
                name: "explicit_glide_lfb",
                kind: "EXPLICIT_GLIDE_LFB",
                priority: 90,
                canHandle: (s) => typeof s.explicitGlideSink === "function",
                submit: (s) => {
                    try {
                        return s.explicitGlideSink ? !!s.explicitGlideSink() : false;
                    } catch (error) {
                        this.warnThrottled(s, "explicit_glide_submit", `[VideoRouting] explicit glide sink failed: ${error}`);
                        return false;
                    }
                },
            });
        }

        adapters.sort((a, b) => b.priority - a.priority);
        return adapters;
    }

    private tryOverlaySink(session: VideoSessionState, reason: string): VideoSinkKind {
        const ok = this.tryOverlaySubmit(session);
        this.pushEvent(session.sessionKey, ok ? "sink_submit_ok" : "sink_submit_fail", `video_overlay:${reason}`);
        if (ok) {
            this.updateSink(session, "VIDEO_OVERLAY", `locked:${reason}`);
            return "VIDEO_OVERLAY";
        }
        this.updateSink(session, "DROP", `locked_drop:${reason}`);
        return "DROP";
    }

    private tryOverlaySubmit(session: VideoSessionState): boolean {
        const frame = session.frameViews;
        if (!frame) return false;
        if (!this.render.getBackend()) {
            this.warnThrottled(session, "overlay_no_backend", `[VideoRouting] no backend, sink=DROP session=${session.sessionKey}`);
            return false;
        }
        return this.overlay.submitFrame(session.sessionKey, frame);
    }

    private applyTargetHint(session: VideoSessionState, hint?: Partial<VideoTargetHint> | null): void {
        if (!hint) return;
        const nextKind = hint.kind ?? session.targetHint.kind;
        const next: VideoTargetHint = {
            kind: nextKind,
            valid: hint.valid ?? session.targetHint.valid,
            updatedAtMs: performance.now(),
            surfacePtr: hint.surfacePtr ?? session.targetHint.surfacePtr,
            pitch: hint.pitch ?? session.targetHint.pitch,
            width: hint.width ?? session.targetHint.width,
            height: hint.height ?? session.targetHint.height,
            note: hint.note ?? session.targetHint.note,
        };
        const changed =
            next.kind !== session.targetHint.kind ||
            next.valid !== session.targetHint.valid ||
            next.surfacePtr !== session.targetHint.surfacePtr ||
            next.pitch !== session.targetHint.pitch ||
            next.width !== session.targetHint.width ||
            next.height !== session.targetHint.height;
        session.targetHint = next;
        if (changed) {
            const detail = `${next.kind}:${next.valid ? "1" : "0"}${next.surfacePtr ? ` ptr=0x${next.surfacePtr.toString(16)}` : ""}`;
            this.pushEvent(session.sessionKey, "target_hint", detail);
        }
    }

    private makeSessionKey(codec: VideoCodec, guestHandle: number): string {
        return `${codec}:${guestHandle >>> 0}`;
    }

    private pushEvent(sessionKey: string, type: VideoRoutingEvent["type"], detail?: string): void {
        this.events.push({
            id: this.nextEventId++,
            timestampMs: performance.now(),
            sessionKey,
            type,
            detail,
        });
        if (this.events.length > ROUTER_EVENT_CAPACITY) {
            this.events.splice(0, this.events.length - ROUTER_EVENT_CAPACITY);
        }
    }

    private updateSink(session: VideoSessionState, sink: VideoSinkKind, detail: string): void {
        if (session.sink === sink) return;
        const prevSink = session.sink;
        session.sink = sink;
        // Clear overlay when transitioning away from VIDEO_OVERLAY to prevent
        // stale video content being composited over the game's own rendering.
        if (prevSink === "VIDEO_OVERLAY" && sink !== "VIDEO_OVERLAY") {
            if (this.overlay.getOwnerSessionKey() === session.sessionKey) {
                this.overlay.clear();
            }
        }
        this.pushEvent(session.sessionKey, "sink_selected", `${sink}:${detail}`);
    }

    private warnThrottled(session: VideoSessionState, key: string, message: string): void {
        const frameIndex = session.frameViews?.frameIndex ?? 0;
        const throttleKey = `${session.sessionKey}:${key}`;
        const lastFrame = this.warnFrameByKey.get(throttleKey);
        if (lastFrame !== undefined && frameIndex - lastFrame < WARN_THROTTLE_FRAMES) {
            return;
        }
        this.warnFrameByKey.set(throttleKey, frameIndex);
        Logger.warn(LogCategory.SYSTEM, message);
    }
}
