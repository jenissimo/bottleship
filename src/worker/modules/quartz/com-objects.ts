/**
 * FilterGraphObject — COM object implementing IGraphBuilder, IMediaControl, IMediaEvent, etc.
 *
 * Uses sub-object pattern: QI for different IIDs returns separate guest memory pointers
 * with different VTable layouts, all mapping to the same FilterGraphObject handle.
 */

import { BaseComObject } from "../../core/com/base-com-object";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { allocateComObject } from "../../core/com/com-memory";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { TimerKind } from "../../core/scheduler/types";
import { TimeService } from "../../runtime/time";
import { videoEngine } from "../../../video/video-engine";
import { VideoFrameViews } from "../../video/video-routing-types";
import {
    IID_IGraphBuilder,
    IID_IMediaControl,
    IID_IMediaPosition,
    IID_IMediaEvent,
    IID_IMediaEventEx,
    IID_IMediaSeeking,
    IID_IVideoWindow,
    IID_IBasicAudio,
    IID_IBasicVideo,
    IID_IFilterGraph,
    IID_IMediaFilter,
    IID_IPersist,
    TIME_FORMAT_MEDIA_TIME,
    S_OK,
    E_NOINTERFACE,
    EC_COMPLETE,
    FilterState,
} from "./constants";

/** One entry of the graph's event queue (IMediaEvent::GetEvent out-params). */
export type MediaEvent = { code: number; param1: number; param2: number };

export class FilterGraphObject extends BaseComObject {
    private static nextAudioId = 0x51000000;

    state: FilterState = FilterState.STOPPED;

    // Video engine session
    engineHandle: number = 0;
    videoWidth: number = 0;
    videoHeight: number = 0;
    videoFps: number = 0;
    videoFrameCount: number = 0;
    private frameDecodeCount = 0;
    private videoRoutingOpen = false;

    // Encoded audio session (MP3/Ogg/WAV) routed through the host AudioEngine.
    audioId: number = 0;
    audioBytes: Uint8Array | null = null;
    audioMimeType: string = "";
    audioSampleRate: number = 44100;
    audioDuration: number = 0;
    audioCurrentPosition: number = 0;
    audioStopTime: number = 0;
    audioPrerollTime: number = 0;
    audioRate: number = 1;
    audioVolume: number = 0; // DirectShow centibels, 0 = full volume
    audioBalance: number = 0; // DirectShow balance, -10000..10000
    private audioHostActive = false;
    private audioPlaying = false;
    private audioStartMs = 0;
    private audioPendingSeek = false;

    // IMediaSeeking time format. We only honour MEDIA_TIME (100ns) and FRAME; everything
    // is computed internally in seconds and converted on the boundary.
    seekTimeFormat: string = TIME_FORMAT_MEDIA_TIME;

    // Sub-object addresses: IID -> guest memory address
    subObjects: Map<string, number> = new Map();

    // IMediaEventEx::SetNotifyWindow registration
    notifyHwnd: number = 0;
    notifyMsg: number = 0;
    notifyInstanceData: number = 0;

    /** IVideoWindow::put_Owner — HWND the VMR/video renderer reparents into. */
    videoOwnerHwnd: number = 0;
    /** Set once EC_COMPLETE has been posted; reset by RenderFile for graph reuse. */
    completionNotified = false;

    // DirectShow event queue. GetEvent POPS — an event is delivered exactly once and the
    // queue then runs dry (E_ABORT), which is how a drain loop terminates. Re-answering a
    // sticky "graph is completed" state instead spins such a loop forever (GTA III's intro
    // handler drains until GetEvent fails).
    private eventQueue: MediaEvent[] = [];
    /** Guards EC_COMPLETE against being queued twice for one RenderFile. */
    private completionEventRaised = false;

    // Playback timer — TimerWheel id, 0 = none scheduled (TimerWheel ids start at 1).
    private playbackTimer: number = 0;
    private completionResolvers: Array<() => void> = [];

    constructor(vtableAddress: number) {
        super(IID_IGraphBuilder, vtableAddress);
    }

    /**
     * Override QueryInterface to return different guest pointers for different interfaces.
     * Each interface needs its own VTable, so we allocate separate COM objects.
     */
    queryInterface(riid: string, ppvObject: number, memory: Uint8Array): number {
        if (ppvObject === 0 || ppvObject + 4 > memory.length) {
            return 0x80004003; // E_POINTER
        }

        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        const normalizedRiid = riid.replace(/[{}]/g, "").toLowerCase();
        const normalizedIUnknown = "00000000-0000-0000-c000-000000000046";

        // IUnknown or IGraphBuilder or IFilterGraph → return primary address
        if (normalizedRiid === normalizedIUnknown ||
            normalizedRiid === IID_IGraphBuilder ||
            normalizedRiid === IID_IFilterGraph ||
            normalizedRiid === IID_IMediaFilter ||
            normalizedRiid === IID_IPersist) {
            this.addRef();
            const address = SystemResourceProvider.getInstance().getAddressForHandle(this.handle);
            if (address === null) {
                view.setUint32(ppvObject, 0, true);
                return 0x80004005;
            }
            view.setUint32(ppvObject, address >>> 0, true);
            Logger.log(LogCategory.COM, `[Quartz] QI ${riid} -> primary 0x${address.toString(16)}`);
            return S_OK;
        }

        // Check known sub-interfaces
        const supportedIIDs = [
            IID_IMediaControl,
            IID_IMediaPosition,
            IID_IMediaEvent,
            IID_IMediaEventEx,
            IID_IMediaSeeking,
            IID_IVideoWindow,
            IID_IBasicAudio,
            IID_IBasicVideo,
        ];

        if (!supportedIIDs.includes(normalizedRiid)) {
            Logger.warn(LogCategory.COM, `[Quartz] QI ${riid} -> E_NOINTERFACE`);
            view.setUint32(ppvObject, 0, true);
            return E_NOINTERFACE;
        }

        // Check if we already allocated a sub-object for this IID
        let subAddr = this.subObjects.get(normalizedRiid);
        if (subAddr !== undefined) {
            this.addRef();
            view.setUint32(ppvObject, subAddr >>> 0, true);
            Logger.log(LogCategory.COM, `[Quartz] QI ${riid} -> cached sub-object 0x${subAddr.toString(16)}`);
            return S_OK;
        }

        // Allocate a new sub-object with the appropriate VTable
        const quartzModule = System.getInstance().process?.modules.get("quartz") as any;
        if (!quartzModule?.vtables) {
            Logger.error(LogCategory.COM, `[Quartz] QI ${riid}: quartz module not found`);
            view.setUint32(ppvObject, 0, true);
            return E_NOINTERFACE;
        }

        // Map IID to VTable name
        let vtableName: string;
        if (normalizedRiid === IID_IMediaControl) vtableName = "IMediaControl";
        else if (normalizedRiid === IID_IMediaPosition) vtableName = "IMediaPosition";
        // IMediaEventEx is a strict superset of IMediaEvent — always hand out the Ex
        // vtable so SetNotifyWindow (slot 13, +0x34) exists past IMediaEvent's 13 slots.
        else if (normalizedRiid === IID_IMediaEvent || normalizedRiid === IID_IMediaEventEx) vtableName = "IMediaEventEx";
        else if (normalizedRiid === IID_IBasicVideo) vtableName = "IBasicVideo";
        else if (normalizedRiid === IID_IMediaSeeking) vtableName = "IMediaSeeking";
        else if (normalizedRiid === IID_IVideoWindow) vtableName = "IVideoWindow";
        else if (normalizedRiid === IID_IBasicAudio) vtableName = "IBasicAudio";
        else {
            view.setUint32(ppvObject, 0, true);
            return E_NOINTERFACE;
        }

        const vtableInfo = quartzModule.vtables[vtableName];
        if (!vtableInfo) {
            Logger.error(LogCategory.COM, `[Quartz] QI: VTable ${vtableName} not found`);
            view.setUint32(ppvObject, 0, true);
            return E_NOINTERFACE;
        }

        // Allocate a new COM object in guest memory with this VTable
        const process = System.getInstance().process!;
        subAddr = allocateComObject(process.memory, memory, vtableInfo.address);

        // Map the new address to the same handle so thunks find this FilterGraphObject
        SystemResourceProvider.getInstance().mapAddressToHandle(subAddr, this.handle);

        // Cache for future QI calls
        this.subObjects.set(normalizedRiid, subAddr);
        // IMediaEventEx also returns IMediaEvent sub-object
        if (normalizedRiid === IID_IMediaEventEx) {
            this.subObjects.set(IID_IMediaEvent, subAddr);
        }

        this.addRef();
        view.setUint32(ppvObject, subAddr >>> 0, true);
        Logger.verbose(LogCategory.COM, `[Quartz] QI ${riid} -> new sub-object 0x${subAddr.toString(16)} vtable=${vtableName}`);
        return S_OK;
    }

    prepareVideoSession(
        handle: number,
        width: number,
        height: number,
        fps: number,
        frameCount: number,
    ): void {
        this.engineHandle = handle;
        this.videoWidth = width;
        this.videoHeight = height;
        this.videoFps = fps;
        this.videoFrameCount = frameCount;
        this.frameDecodeCount = 0;
        this.openVideoRouting();
    }

    resetForRender(): void {
        this.stopPlayback();
        this.closeVideoRouting();
        if (this.engineHandle > 0) {
            try {
                videoEngine.close(this.engineHandle);
            } catch {}
        }
        this.engineHandle = 0;
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.videoFps = 0;
        this.videoFrameCount = 0;
        this.frameDecodeCount = 0;
        this.stopAudio(true);
        this.audioId = 0;
        this.audioBytes = null;
        this.audioMimeType = "";
        this.audioSampleRate = 44100;
        this.audioDuration = 0;
        this.audioCurrentPosition = 0;
        this.audioStopTime = 0;
        this.audioPrerollTime = 0;
        this.seekTimeFormat = TIME_FORMAT_MEDIA_TIME;
        this.completionNotified = false;
        this.completionEventRaised = false;
        this.eventQueue.length = 0;
        this.videoOwnerHwnd = 0;
        this.state = FilterState.STOPPED;
    }

    /** Post WM_PAINT to the video owner so WaitMessage/GetMessage loops repaint. */
    private notifyVideoPaint(): void {
        const hwnd = this.videoOwnerHwnd || this.notifyHwnd;
        if (!hwnd) return;
        System.getInstance().windowManager.postMessage(hwnd, 0x000F /* WM_PAINT */, 0, 0);
    }

    prepareAudio(bytes: Uint8Array, mimeType: string, sampleRate: number, duration: number): void {
        this.stopAudio(true);
        this.audioId = FilterGraphObject.nextAudioId++;
        this.audioBytes = bytes;
        this.audioMimeType = mimeType;
        this.audioSampleRate = sampleRate > 0 ? sampleRate : 44100;
        this.audioDuration = duration > 0 ? duration : 0;
        this.audioCurrentPosition = 0;
        this.audioStopTime = this.audioDuration;
        this.audioPrerollTime = 0;
        this.audioHostActive = false;
        this.audioPlaying = false;
        this.audioStartMs = 0;
        this.audioPendingSeek = false;
        this.state = FilterState.STOPPED;
    }

    setAudioVolume(volumeCentibels: number): void {
        this.audioVolume = Math.max(-10000, Math.min(0, volumeCentibels | 0));
        this.postAudioUpdate();
    }

    setAudioBalance(balance: number): void {
        this.audioBalance = Math.max(-10000, Math.min(10000, balance | 0));
        this.postAudioUpdate();
    }

    setAudioRate(rate: number): void {
        if (!Number.isFinite(rate) || rate <= 0) rate = 1;
        this.updateAudioPositionFromClock();
        this.audioRate = Math.max(0.01, Math.min(16, rate));
        this.postAudioUpdate();
    }

    seekAudio(seconds: number): void {
        if (!Number.isFinite(seconds)) seconds = 0;
        const clamped = this.clampAudioPosition(seconds);
        this.audioCurrentPosition = clamped;
        this.audioStartMs = performance.now();
        if (this.audioId && this.audioHostActive) {
            (self as any).postMessage({
                type: "audio_seek",
                payload: { id: this.audioId, timeMs: Math.floor(clamped * 1000) },
            });
            this.audioPendingSeek = false;
        } else {
            this.audioPendingSeek = clamped > 0;
        }
    }

    getAudioCurrentPosition(): number {
        return this.updateAudioPositionFromClock();
    }

    /**
     * Total media length in seconds, used by both IMediaPosition (REFTIME) and
     * IMediaSeeking (REFERENCE_TIME). Audio sessions know their duration; video is
     * frameCount/fps.
     */
    getMediaDurationSeconds(): number {
        if (this.audioBytes) return this.audioDuration;
        return this.videoFps > 0 ? this.videoFrameCount / this.videoFps : 0;
    }

    /**
     * Current play position in seconds — the value IMediaPosition::get_CurrentPosition and
     * IMediaSeeking::GetCurrentPosition report. DirectShow drives this off the graph's
     * reference clock, and games commonly play a clip with `Run()` then spin
     * `while (get_CurrentPosition() < get_Duration()) { PumpMessages(); Sleep(); }` to wait
     * for end-of-stream. It therefore MUST advance and REACH the media duration when
     * playback finishes — a video session that always reported 0 (the old behavior) wedges
     * such a loop forever (Max Payne's intro: black-screen hang, never reaches the menu).
     *
     * Audio-only session: the host AudioEngine clock (pinned to duration once COMPLETED).
     * Video session: the clip's own audio track is the reference clock, so ride it clamped
     * to duration; fall back to decoded-frame progress for a silent video; and once the
     * graph reaches COMPLETED, return the full duration so the wait definitively terminates.
     */
    getMediaPositionSeconds(): number {
        if (this.audioBytes) {
            return this.state === FilterState.COMPLETED
                ? this.getMediaDurationSeconds()
                : this.getAudioCurrentPosition();
        }
        if (this.engineHandle > 0) {
            const dur = this.getMediaDurationSeconds();
            if (this.state === FilterState.COMPLETED) return dur;
            const audioClk = videoEngine.getAudioClockSeconds(this.engineHandle);
            if (audioClk >= 0) return dur > 0 ? Math.min(audioClk, dur) : audioClk;
            return this.videoFps > 0 ? this.frameDecodeCount / this.videoFps : 0;
        }
        return this.state === FilterState.COMPLETED ? this.getMediaDurationSeconds() : 0;
    }

    /** Seek to an absolute position in seconds (audio only; video is a no-op). */
    seekMediaSeconds(seconds: number): void {
        if (this.audioBytes) this.seekAudio(seconds);
    }

    handleAudioStarted(id: number): void {
        if (!this.audioId || id !== this.audioId) return;
        this.audioHostActive = true;
        this.audioPlaying = true;
        this.audioStartMs = performance.now();
        this.state = FilterState.RUNNING;
        if (this.audioPendingSeek && this.audioCurrentPosition > 0) {
            (self as any).postMessage({
                type: "audio_seek",
                payload: { id: this.audioId, timeMs: Math.floor(this.audioCurrentPosition * 1000) },
            });
            this.audioPendingSeek = false;
        }
        Logger.log(LogCategory.COM, `[Quartz] audio started id=${id}`);
    }

    handleAudioEnded(id: number): void {
        if (!this.audioId || id !== this.audioId) return;
        this.audioCurrentPosition = this.audioDuration > 0 ? this.audioDuration : this.getAudioCurrentPosition();
        this.audioHostActive = false;
        this.audioPlaying = false;
        this.audioStartMs = 0;
        this.markCompleted();
        Logger.log(LogCategory.COM, `[Quartz] audio ended id=${id}`);
    }

    handleAudioError(id: number, error: string): void {
        if (!this.audioId || id !== this.audioId) return;
        Logger.warn(LogCategory.COM, `[Quartz] audio error id=${id}: ${error}`);
        this.audioHostActive = false;
        this.audioPlaying = false;
        this.audioStartMs = 0;
        this.markCompleted();
    }

    handleAudioPosition(id: number, positionFrames: number): void {
        if (!this.audioId || id !== this.audioId || this.audioSampleRate <= 0) return;
        this.audioCurrentPosition = this.clampAudioPosition(positionFrames / this.audioSampleRate);
        this.audioStartMs = performance.now();
    }

    /**
     * IMediaEventEx::SetNotifyWindow — register or clear the completion notify target.
     * hwnd=NULL clears the window (lMsg/lInstanceData ignored per DirectShow).
     */
    setNotifyWindow(hwnd: number, msg: number, instanceData: number): void {
        const prevHwnd = this.notifyHwnd;
        if (hwnd === 0) {
            this.notifyHwnd = 0;
            this.notifyMsg = 0;
            this.notifyInstanceData = 0;
            if (prevHwnd !== 0) {
                Logger.verbose(LogCategory.COM,
                    `[Quartz] SetNotifyWindow: cleared notify (was hwnd=0x${prevHwnd.toString(16)})`);
            }
            return;
        }

        this.notifyHwnd = hwnd >>> 0;
        this.notifyMsg = msg >>> 0;
        this.notifyInstanceData = instanceData | 0;
        Logger.log(LogCategory.COM,
            `[Quartz] SetNotifyWindow(hwnd=0x${this.notifyHwnd.toString(16)}, ` +
            `msg=0x${this.notifyMsg.toString(16)}, data=0x${(this.notifyInstanceData >>> 0).toString(16)})`);

        // Graph may already be COMPLETED (skipVideo / instant EOF) — deliver pending EC_COMPLETE.
        this.postCompletionNotify();
    }

    /**
     * The graph reached end-of-stream. Idempotent: EC_COMPLETE is queued once per
     * RenderFile, so a drain loop sees it exactly once and then hits an empty queue.
     */
    markCompleted(): void {
        const wasCompleted = this.state === FilterState.COMPLETED;
        this.state = FilterState.COMPLETED;
        if (!wasCompleted) this.resolveWaiters();
        if (!this.completionEventRaised) {
            this.completionEventRaised = true;
            this.eventQueue.push({ code: EC_COMPLETE, param1: 0, param2: 0 });
        }
        this.postCompletionNotify();
    }

    /** IMediaEvent::GetEvent — pop the oldest queued event, or null when the queue is dry. */
    dequeueEvent(): MediaEvent | null {
        return this.eventQueue.shift() ?? null;
    }

    /**
     * Post the EC_COMPLETE notification to the window registered via SetNotifyWindow.
     * Followed by a WM_NULL: game loops commonly check their "video done" flag only
     * after GetMessage returns, and the flag is set while dispatching the notify —
     * without a trailing message the loop re-blocks in GetMessage forever (Blade of
     * Darkness boot hang).
     */
    postCompletionNotify(): void {
        if (this.completionNotified || !this.notifyHwnd || !this.notifyMsg) return;
        if (this.state !== FilterState.COMPLETED) return;
        this.completionNotified = true;
        const system = System.getInstance();
        system.windowManager.postMessage(this.notifyHwnd, this.notifyMsg, 0, this.notifyInstanceData);
        system.windowManager.postMessage(this.notifyHwnd, 0 /* WM_NULL */, 0, 0);
        system.scheduler.wakeMessageWaiters();
        Logger.log(LogCategory.COM,
            `[Quartz] posted EC_COMPLETE notify msg=0x${this.notifyMsg.toString(16)} ` +
            `hwnd=0x${this.notifyHwnd.toString(16)}`);
    }

    /**
     * Start video playback loop.
     */
    startPlayback(): void {
        if (this.audioBytes) {
            this.startAudioPlayback();
            return;
        }

        if (this.state === FilterState.RUNNING) return;
        if (this.state === FilterState.COMPLETED) {
            // Already done (e.g. skipVideo completed RenderFile instantly) — Run() on a
            // completed graph must still surface EC_COMPLETE to both event channels.
            this.markCompleted();
            return;
        }
        this.state = FilterState.RUNNING;
        this.notifyVideoPaint();

        if (this.engineHandle <= 0) {
            // No valid video — mark completed immediately
            this.markCompleted();
            return;
        }

        // videoEngine imported at module level
        const frameInterval = 1000 / (this.videoFps || 30);
        // Drift-correcting schedule: anchor to a fixed deadline grid (nextFrameDeadline +=
        // frameInterval) rather than re-arming "now + frameInterval" after each frame. The
        // naive form lets per-frame decode/route time (I-frame vs P-frame cost, GC pauses,
        // etc.) accumulate as drift on top of the interval instead of being absorbed by a
        // shorter wait before the next frame — same timer-jitter bug class as the frame
        // pacer's own documented history (Re-Volt/HoMM3 lump-sum compensation jitter).
        //
        // Scheduled via the scheduler's TimerWheel, NOT host setTimeout: a busy-spinning
        // guest thread starves host macrotasks (same class as mss32/timer.ts's Miles AIL
        // timer and the HP Galaxy audio livelock), so a raw setTimeout callback can be
        // delayed arbitrarily long behind guest CPU usage. The wheel is polled in-band
        // with guest execution at every thunk boundary, so it fires even under load.
        const timeService = TimeService.getInstance();
        let nextFrameDeadline = timeService.nowMs() + frameInterval;

        const decodeLoop = () => {
            if (this.state !== FilterState.RUNNING) return;

            const ok = videoEngine.doFrame(this.engineHandle);
            if (!ok) {
                this.finishVideoPlayback();
                return;
            }

            this.frameDecodeCount++;
            this.routeDecodedFrame();
            this.notifyVideoPaint();
            videoEngine.nextFrame(this.engineHandle);

            nextFrameDeadline += frameInterval;
            const now = timeService.nowMs();
            const delay = Math.max(0, nextFrameDeadline - now);
            const scheduler = System.getInstance().scheduler;
            if (scheduler) {
                this.playbackTimer = scheduler.timerWheel.add(delay, false, TimerKind.QUARTZ_VIDEO, decodeLoop, now);
            }
        };

        decodeLoop();
    }

    /**
     * Stop playback.
     */
    stopPlayback(): void {
        if (this.audioBytes || this.audioHostActive) {
            this.stopAudio(true);
            this.state = FilterState.STOPPED;
        }

        if (this.playbackTimer !== 0) {
            System.getInstance().scheduler?.timerWheel.cancel(this.playbackTimer);
            this.playbackTimer = 0;
        }
        if (this.engineHandle > 0) {
            this.closeVideoRouting();
        }
        this.state = FilterState.STOPPED;
    }

    pausePlayback(): void {
        if (this.audioHostActive && this.audioPlaying && this.audioId) {
            this.updateAudioPositionFromClock();
            (self as any).postMessage({ type: "audio_pause", payload: { id: this.audioId } });
            this.audioPlaying = false;
            this.state = FilterState.PAUSED;
            return;
        }
        if (this.state === FilterState.RUNNING) {
            this.state = FilterState.PAUSED;
        }
    }

    /**
     * Wait until playback completes.
     */
    waitForCompletion(timeoutMs: number): Promise<void> {
        if (this.state === FilterState.COMPLETED) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            if (timeoutMs > 0 && timeoutMs < 0x7FFFFFFF) {
                const timer = setTimeout(() => {
                    // Timeout — resolve anyway
                    const idx = this.completionResolvers.indexOf(resolve);
                    if (idx >= 0) this.completionResolvers.splice(idx, 1);
                    resolve();
                }, timeoutMs);

                this.completionResolvers.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            } else {
                this.completionResolvers.push(resolve);
            }
        });
    }

    private resolveWaiters(): void {
        const resolvers = this.completionResolvers.splice(0);
        for (const r of resolvers) r();
    }

    private startAudioPlayback(): void {
        if (!this.audioBytes || !this.audioId) {
            this.markCompleted();
            return;
        }

        if (this.audioHostActive) {
            if (!this.audioPlaying) {
                this.audioStartMs = performance.now();
                (self as any).postMessage({ type: "audio_resume", payload: { id: this.audioId } });
                this.audioPlaying = true;
            }
            this.state = FilterState.RUNNING;
            return;
        }

        const payloadData = this.audioBytes.slice();
        this.audioPendingSeek = this.audioCurrentPosition > 0;
        this.audioHostActive = true;
        this.audioPlaying = true;
        this.audioStartMs = performance.now();
        this.state = FilterState.RUNNING;

        (self as any).postMessage({
            type: "audio_play_encoded",
            payload: {
                id: this.audioId,
                data: payloadData,
                mimeType: this.audioMimeType || "application/octet-stream",
                playbackRate: this.audioRate,
                // handleAudioPosition divides by audioSampleRate, so the host must count
                // in that rate; undeclared it counts in the device's instead.
                positionRateHz: this.audioSampleRate > 0 ? this.audioSampleRate : undefined,
                volume: this.centibelToLinear(this.audioVolume),
                pan: this.audioBalance / 10000,
                loopCount: 1,
            },
        } as any, [payloadData.buffer] as any);

        Logger.log(LogCategory.COM,
            `[Quartz] audio play id=${this.audioId} mime=${this.audioMimeType} ` +
            `bytes=${payloadData.byteLength} rate=${this.audioRate}`);
    }

    private stopAudio(resetPosition: boolean): void {
        if (this.audioId && this.audioHostActive) {
            (self as any).postMessage({ type: "audio_stop", payload: { id: this.audioId } });
        }
        this.audioHostActive = false;
        this.audioPlaying = false;
        this.audioStartMs = 0;
        this.audioPendingSeek = false;
        if (resetPosition) {
            this.audioCurrentPosition = 0;
        }
    }

    private postAudioUpdate(): void {
        if (!this.audioId || !this.audioHostActive) return;
        (self as any).postMessage({
            type: "audio_update",
            payload: {
                id: this.audioId,
                volume: this.centibelToLinear(this.audioVolume),
                pan: this.audioBalance / 10000,
                playbackRate: this.audioRate,
            },
        });
    }

    private updateAudioPositionFromClock(): number {
        if (!this.audioPlaying || this.audioStartMs <= 0) {
            return this.clampAudioPosition(this.audioCurrentPosition);
        }
        const now = performance.now();
        const elapsedSeconds = Math.max(0, (now - this.audioStartMs) / 1000) * this.audioRate;
        this.audioCurrentPosition = this.clampAudioPosition(this.audioCurrentPosition + elapsedSeconds);
        this.audioStartMs = now;
        return this.audioCurrentPosition;
    }

    private clampAudioPosition(seconds: number): number {
        if (!Number.isFinite(seconds) || seconds < 0) return 0;
        if (this.audioDuration > 0) return Math.min(seconds, this.audioDuration);
        return seconds;
    }

    private centibelToLinear(centibels: number): number {
        if (centibels <= -10000) return 0;
        if (centibels >= 0) return 1;
        return Math.pow(10, centibels / 2000);
    }

    protected destroy(): void {
        this.stopPlayback();
        this.resolveWaiters();
        this.stopAudio(false);
        this.closeVideoRouting();

        if (this.engineHandle > 0) {
            try {
                videoEngine.close(this.engineHandle);
            } catch {}
            this.engineHandle = 0;
        }

        Logger.log(LogCategory.COM, `[Quartz] FilterGraphObject destroyed`);
    }

    private buildFrameViews(): VideoFrameViews {
        const pal8 = videoEngine.getFramePal8(this.engineHandle);
        return {
            width: this.videoWidth,
            height: this.videoHeight,
            frameIndex: this.frameDecodeCount,
            frameDurationMs: this.videoFps > 0 ? 1000 / this.videoFps : 66,
            decodedAtMs: performance.now(),
            bgra: videoEngine.getFrameBgra(this.engineHandle),
            rgb565: videoEngine.getFrameRgb565(this.engineHandle),
            pal8Indices: pal8?.indices ?? null,
            paletteBgra: pal8?.palette ?? null,
        };
    }

    private routeDecodedFrame(): void {
        const routing = System.getInstance().videoRouting;
        const guestHandle = this.handle;
        const frame = this.buildFrameViews();
        routing.onFrameDecoded({
            codec: "quartz",
            guestHandle,
            frame,
            hasAppManagedSink: false,
            targetHint: null,
            legacyPrimarySink: null,
            explicitDdrawSink: null,
            explicitGlideSink: null,
        });
        routing.onFrameFinalize({
            codec: "quartz",
            guestHandle,
            hasAppManagedSink: false,
            targetHint: null,
            legacyPrimarySink: null,
            explicitDdrawSink: null,
            explicitGlideSink: null,
        });
    }

    private openVideoRouting(): void {
        if (this.videoRoutingOpen) return;
        System.getInstance().videoRouting.openSession({
            codec: "quartz",
            guestHandle: this.handle,
            width: this.videoWidth,
            height: this.videoHeight,
            fps: this.videoFps,
        });
        this.videoRoutingOpen = true;
    }

    private closeVideoRouting(): void {
        if (!this.videoRoutingOpen) return;
        System.getInstance().videoRouting.closeSession("quartz", this.handle);
        this.videoRoutingOpen = false;
    }

    private finishVideoPlayback(): void {
        this.markCompleted();
        this.closeVideoRouting();
        (self as any).postMessage({ type: "video_end" });
        if (this.playbackTimer !== 0) {
            System.getInstance().scheduler?.timerWheel.cancel(this.playbackTimer);
            this.playbackTimer = 0;
        }
    }
}
