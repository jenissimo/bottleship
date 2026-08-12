import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { TimerKind } from "../../core/scheduler/types";
import { TimeService } from "../../runtime/time";
import { MSSContext, createMSSContext, SMP_DONE, SMP_PLAYING } from "./context";
import { finishSamplePlayback, getBytesPerSecond, getPlaybackLengthBytes, setSampleStatus, setStreamStatus, writeSamplePosition, writeStreamPosition, stopHeartbeat } from "./helpers";
import { updateEmulatorState, playSample, appendDecodedChunk, resetMssRingBuffers } from "./playback-engine";
import { invokeEOSCallback } from "./callbacks";
import { convertToFloat } from "./audio-decode";
import { createCoreExports } from "./core";
import { createDigitalDriverExports } from "./digital-driver";
import { createSampleExports } from "./sample";
import { createSampleBufferExports } from "./sample-buffers";
import { createStreamExports } from "./stream";
import { createRedbookExports } from "./redbook";
import { createTimerExports } from "./timer";
import { createWaveOutExports } from "./waveout";
import { createFileIOExports } from "./file-io";
import { createWavInfoExports } from "./wav-info";
import { createSequenceExports } from "./sequence";
import { createMidiDriverExports } from "./midi-driver";

export class MSS32 implements IModule {
    name = "mss32";
    exports: Record<string, ThunkImplementation> = {};

    private ctx!: MSSContext;

    initialize(process: Process): void {
        this.ctx = createMSSContext(process);

        // Start the heartbeat loop to sync emulator memory with playback state (50Hz / 20ms):
        // EOS detection (samples reaching SMP_DONE) + position writeback. Driven by the scheduler
        // virtual-time timer wheel, NOT host setInterval — a busy-spinning guest thread starves
        // host macrotasks, freezing sample completion → MSS32 voice-pool saturation hang (mac).
        const scheduler = System.getInstance().scheduler;
        if (scheduler) {
            this.ctx.updateInterval = scheduler.timerWheel.add(
                20, true, TimerKind.MSS_TIMER,
                () => updateEmulatorState(this.ctx),
                TimeService.getInstance().nowMs(),
            );
        } else {
            Logger.warn(LogCategory.SYSTEM, "MSS32: scheduler unavailable at initialize — playback-state heartbeat disabled");
        }

        // Merge all domain exports
        Object.assign(this.exports, createCoreExports(this.ctx));
        Object.assign(this.exports, createDigitalDriverExports(this.ctx));
        Object.assign(this.exports, createSampleExports(this.ctx));
        Object.assign(this.exports, createSampleBufferExports(this.ctx));
        Object.assign(this.exports, createStreamExports(this.ctx));
        Object.assign(this.exports, createRedbookExports(this.ctx));
        Object.assign(this.exports, createTimerExports(this.ctx));
        Object.assign(this.exports, createWaveOutExports(this.ctx));
        Object.assign(this.exports, createFileIOExports(this.ctx));
        Object.assign(this.exports, createWavInfoExports(this.ctx));
        Object.assign(this.exports, createSequenceExports(this.ctx));
        Object.assign(this.exports, createMidiDriverExports(this.ctx));

        // SmartHeap/MSS compatibility probes used by some games during startup.
        this.exports["_MemSetPatching@4"] = () => 0;
        this.exports["MemPoolInit"] = () => 1;
    }

    // ==================== Public methods (called from emulator.worker.ts) ====================

    handleAudioEnded(id: number): void {
        const ctx = this.ctx;

        // Check if it's a sample
        const sample = ctx.samplesById.get(id);
        if (sample) {
            if (!sample.isPlaying) return; // already handled by heartbeat
            finishSamplePlayback(ctx, sample, getPlaybackLengthBytes(sample));
            invokeEOSCallback(ctx, sample);
            return;
        }

        // Check if it's a stream
        const stream = ctx.streamsById.get(id);
        if (stream) {
            if (!stream.isPlaying) return; // already handled by heartbeat
            stream.isPlaying = false;
            stream.isPaused = false;
            stream.startTime = undefined;
            stream.position = getPlaybackLengthBytes(stream);
            stream.pendingStart = false;
            writeStreamPosition(ctx, stream, stream.position);
            setStreamStatus(ctx, stream, SMP_DONE);
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream playback ended (id=${id})`);
            return;
        }
    }

    handleAudioStarted(id: number): void {
        const ctx = this.ctx;

        const sample = ctx.samplesById.get(id);
        if (sample) {
            if (sample.pendingStart) sample.pendingStart = false;
            if (sample.isStopped) sample.isStopped = false;
            if (!sample.isPlaying) sample.isPlaying = true;
            setSampleStatus(ctx, sample, SMP_PLAYING);
            Logger.log(LogCategory.SYSTEM, `MSS32: Audio playback confirmed started for sample id=${id}`);
            return;
        }

        const stream = ctx.streamsById.get(id);
        if (stream) {
            if (stream.pendingStart) stream.pendingStart = false;
            if (!stream.isPlaying) stream.isPlaying = true;
            stream.isPaused = false;
            setStreamStatus(ctx, stream, SMP_PLAYING);
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream playback confirmed started (id=${id})`);
            return;
        }
    }

    handleAudioError(id: number, error: string): void {
        const ctx = this.ctx;

        const sample = ctx.samplesById.get(id);
        if (sample) {
            Logger.error(LogCategory.SYSTEM, `MSS32: Audio playback error for sample id=${id}: ${error}`);
            finishSamplePlayback(ctx, sample);
            return;
        }

        const stream = ctx.streamsById.get(id);
        if (stream) {
            Logger.error(LogCategory.SYSTEM, `MSS32: Stream playback error (id=${id}): ${error}`);
            stream.isPlaying = false;
            stream.isPaused = false;
            stream.pendingStart = false;
            stream.startTime = undefined;
            setStreamStatus(ctx, stream, SMP_DONE);
            return;
        }
    }

    handleAudioPosition(id: number, positionFrames: number): void {
        if (!Number.isFinite(positionFrames) || positionFrames < 0) return;
        const ctx = this.ctx;

        // Check if it's a sample
        const sample = ctx.samplesById.get(id);
        if (sample && sample.isPlaying) {
            const channels = Math.max(1, sample.channels || 1);
            const bytesPerSample = Math.max(1, (sample.bitsPerSample || 16) >> 3);
            const blockAlign = sample.blockAlign || channels * bytesPerSample;
            const positionBytes = Math.floor(positionFrames * blockAlign);
            const totalLen = getPlaybackLengthBytes(sample);
            const clampedPos = totalLen > 0 ? Math.min(positionBytes, totalLen) : positionBytes;

            if (clampedPos !== sample.position) {
                sample.position = clampedPos;
                writeSamplePosition(ctx, sample, clampedPos);
            }

            const now = performance.now();
            sample.lastAudioPositionTime = now;
            sample.lastAudioPositionBytes = clampedPos;
            setSampleStatus(ctx, sample, SMP_PLAYING);

            const bytesPerSec = getBytesPerSecond(sample);
            const effectiveBytesPerSec = bytesPerSec * (sample.playbackRate || 1.0);
            if (effectiveBytesPerSec > 0) {
                sample.startTime = now - (clampedPos / effectiveBytesPerSec) * 1000.0;
            }
            return;
        }

        // Check if it's a stream
        const stream = ctx.streamsById.get(id);
        if (stream && stream.isPlaying) {
            const channels = Math.max(1, stream.channels || 1);
            const bytesPerSample = Math.max(1, (stream.bitsPerSample || 16) >> 3);
            const blockAlign = stream.blockAlign || channels * bytesPerSample;
            const positionBytes = Math.floor(positionFrames * blockAlign);
            const totalLen = getPlaybackLengthBytes(stream);
            const clampedPos = totalLen > 0 ? Math.min(positionBytes, totalLen) : positionBytes;

            if (clampedPos !== stream.position) {
                stream.position = clampedPos;
                writeStreamPosition(ctx, stream, clampedPos);
            }

            const now = performance.now();
            stream.lastAudioPositionTime = now;
            stream.lastAudioPositionBytes = clampedPos;
            setStreamStatus(ctx, stream, SMP_PLAYING);

            const bytesPerSec = getBytesPerSecond(stream);
            const effectiveBytesPerSec = bytesPerSec * (stream.playbackRate || 1.0);
            if (effectiveBytesPerSec > 0) {
                stream.startTime = now - (clampedPos / effectiveBytesPerSec) * 1000.0;
            }
            return;
        }
    }

    /**
     * Update playback positions for all playing samples (called periodically from heartbeat)
     * DEPRECATED: Use updateEmulatorState() instead which uses absolute time tracking
     */
    updatePlayingSamplesPositions(deltaMs: number): void {
        updateEmulatorState(this.ctx);
    }

    /**
     * Feed raw S16LE PCM from the WASM video decoder directly into an MSS32 sample.
     * Called by SmackW32/BinkW32 when audio is routed through MSS32.
     * On the first call: starts playback via playSample().
     * On subsequent calls: streams via appendDecodedChunk().
     */
    feedPcmToSample(sampleHandle: number, pcm: Int16Array): void {
        const sample = this.ctx.samples.get(sampleHandle);
        if (!sample || pcm.length === 0) return;
        const raw = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const channels    = sample.channels    || 2;
        const bitsPerSample = sample.bitsPerSample || 16;
        const blockAlign  = sample.blockAlign  || channels * (bitsPerSample >> 3);
        const chunk = convertToFloat(raw, channels, bitsPerSample, 1 /* PCM */, blockAlign);
        if (chunk.length === 0) return;
        if (!sample.isPlaying) {
            sample.decodedData = chunk;
            sample.startTime   = performance.now();
            sample.pendingStart = false;
            playSample(this.ctx, sample);
        } else {
            appendDecodedChunk(this.ctx, sample, chunk);
        }
    }

    /**
     * Get playing samples count (for diagnostics)
     */
    getPlayingSamplesCount(): number {
        let count = 0;
        for (const sample of this.ctx.samples.values()) {
            if (sample.isPlaying) count++;
        }
        return count;
    }

    reset(): void {
        const ctx = this.ctx;
        stopHeartbeat(ctx);
        const scheduler = System.getInstance().scheduler;
        for (const timer of ctx.timers.values()) {
            if (timer.timerId) {
                scheduler?.timerWheel.cancel(timer.timerId);
            }
        }
        ctx.timers.clear();
        ctx.pendingTimerCallbacks.length = 0;
        ctx.pendingEOSCallbacks.length = 0;
        ctx.insideAilServe = false;
        resetMssRingBuffers();
        ctx.samples.clear();
        ctx.samplesById.clear();
        ctx.streams.clear();
        ctx.streamsById.clear();
        ctx.waveOuts.clear();
        ctx.fileHandles.clear();
        ctx.sequences.clear();
        // Dropping the handles is the whole of this module's claim on the drive. The drive
        // itself is shared with MCI's `cdaudio`, and resetting it from one of its two front
        // ends is not this module's call: WinmmMci.reset() owns that (stop + eject + TOC
        // invalidate) and runs in the same module sweep, so playback is already stopped.
        ctx.redbookHandles.clear();
        for (const ptr of ctx.memAllocatedByMss) {
            ctx.process.memory.free(ptr);
        }
        ctx.memAllocatedByMss.clear();
        ctx.nextSampleId = 1;
        ctx.nextStreamId = 0x00010001;
        ctx.nextWaveOutId = 1;
        ctx.nextFileHandleId = 0x50000000;
        ctx.nextSequenceId = 1;
        ctx.initialized = false;
        ctx.digitalDriverHandle = 0;
        ctx.driverSampleArray = 0;
        ctx.midiDriverHandle = 0;
        ctx.midiMasterVolume = 127;
        ctx.startupTime = 0;
        ctx.lastErrorPtr = 0;
        ctx.lastErrorStr = "";
        ctx.listener3D = null;
        ctx.listenerSab = null;
        ctx.speakerType3D = 0;
        ctx.roomType3D = 0;
        ctx.wavFormatByDataPtr.clear();
    }
}
