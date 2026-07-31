import { Logger, LogCategory, LogLevel } from "../../core/logger";
import { MSSContext, SMP_DONE, SMP_PLAYING } from "./context";
import { MSSSample, MSSStream } from "./types";
import {
    getBytesPerSecond, getPlaybackLengthBytes,
    finishSamplePlayback, setSampleStatus, writeSamplePosition,
    setStreamStatus, writeStreamPosition,
    isEncodedFormat, encodedMimeType,
} from "./helpers";
import { invokeEOSCallback } from "./callbacks";
import {
    createAudioRingBuffer,
    writeRingData,
    setCtrl,
    getCtrl,
    CTRL_PLAY_CURSOR,
    CTRL_STATE,
    CTRL_LOOP_MODE,
    CTRL_VOLUME,
    CTRL_PAN,
    CTRL_FREQUENCY,
    CTRL_DATA_LENGTH,
    CTRL_BLOCK_ALIGN,
    STATE_PLAYING,
    STATE_STOPPED,
    CTRL_BLOCK_BYTES,
    CTRL_STOP_REQUESTED,
    CTRL_RESERVED,
    setCtrlFloat,
    CTRL_3D_POS_X, CTRL_3D_POS_Y, CTRL_3D_POS_Z,
    CTRL_3D_VEL_X, CTRL_3D_VEL_Y, CTRL_3D_VEL_Z,
    CTRL_3D_MIN_DIST, CTRL_3D_MAX_DIST, CTRL_3D_MODE,
    CTRL_3D_CONE_INNER, CTRL_3D_CONE_OUTER,
    CTRL_3D_CONE_ORI_X, CTRL_3D_CONE_ORI_Y, CTRL_3D_CONE_ORI_Z,
    CTRL_3D_CONE_OUTVOL, CTRL_3D_FLAGS,
} from "../../../audio/audio-ring-buffer";
import { ensureAudioStatsSab } from "../audio-stats-sab";

// Side table for ring buffers — keyed by sample/stream id
const ringBuffers = new Map<number, { sab: SharedArrayBuffer; registered: boolean }>();
const RING_CURSOR_STALE_MS = 250;

function ensureRingBuffer(id: number, channels: number, sampleRate: number, bitsPerSample: number, dataBytes: number): SharedArrayBuffer {
    const entry = ringBuffers.get(id);
    if (entry) {
        // Reuse if big enough, otherwise release and reallocate
        if (entry.sab.byteLength >= CTRL_BLOCK_BYTES + dataBytes) {
            return entry.sab;
        }
        releaseRingBuffer(id);
    }

    const sab = createAudioRingBuffer(dataBytes, {
        channels,
        sampleRate,
        bitsPerSample,
    }, false /* linear */);

    ensureAudioStatsSab();
    self.postMessage({ type: "audio_register", payload: { id, sab } });
    ringBuffers.set(id, { sab, registered: true });
    return sab;
}

function releaseRingBuffer(id: number): void {
    const entry = ringBuffers.get(id);
    if (entry) {
        if (entry.registered) {
            self.postMessage({ type: "audio_unregister", payload: { id } });
        }
        ringBuffers.delete(id);
    }
}

/** Unregister every Miles ring buffer — required on in-worker game switch. */
export function resetMssRingBuffers(): void {
    for (const id of [...ringBuffers.keys()]) {
        releaseRingBuffer(id);
    }
}

/** Convert Miles 0-127 volume to DirectSound centibels (-10000..0) */
function volumeToCentibels(vol127: number): number {
    const linear = vol127 / 127.0;
    if (linear <= 0) return -10000;
    if (linear >= 1) return 0;
    return Math.max(-10000, Math.round(2000 * Math.log10(linear)));
}

/** Convert loopCount to ring buffer loop mode: -1=forever, 1+=play N times */
function loopCountToMode(loopCount: number | undefined): number {
    if (loopCount === 0 || loopCount === -1) return -1; // loop forever
    return Math.max(1, loopCount ?? 1); // default to play once
}

/** Convert Miles 0-127 pan (64=center) to DirectSound pan (-10000..10000) */
function panToCentibels(pan127: number): number {
    // 0=full left, 64=center, 127=full right
    const normalized = (pan127 - 64) / 63; // -1.0..1.0
    return Math.max(-10000, Math.min(10000, Math.round(normalized * 10000)));
}

/**
 * Push a 3D sample's spatial state into its ring buffer's CTRL_3D_* fields.
 * The audio worklet reads these per block and applies distance attenuation,
 * azimuth panning, doppler and cone gain against the global listener SAB.
 * No-op if the sample has no ring buffer yet (fields are re-applied on start).
 */
export function applySample3D(sample: MSSSample): void {
    const entry = ringBuffers.get(sample.id);
    if (!entry || !sample.is3D) return;
    const sab = entry.sab;
    const p = sample.pos3D ?? { x: 0, y: 0, z: 0 };
    const v = sample.vel3D ?? { x: 0, y: 0, z: 0 };
    setCtrlFloat(sab, CTRL_3D_POS_X, p.x);
    setCtrlFloat(sab, CTRL_3D_POS_Y, p.y);
    setCtrlFloat(sab, CTRL_3D_POS_Z, p.z);
    setCtrlFloat(sab, CTRL_3D_VEL_X, v.x);
    setCtrlFloat(sab, CTRL_3D_VEL_Y, v.y);
    setCtrlFloat(sab, CTRL_3D_VEL_Z, v.z);
    setCtrlFloat(sab, CTRL_3D_MIN_DIST, sample.minDist3D ?? 1);
    setCtrlFloat(sab, CTRL_3D_MAX_DIST, sample.maxDist3D ?? 1e9);
    setCtrl(sab, CTRL_3D_MODE, sample.mode3D ?? 0);
    const cone = sample.cone3D;
    setCtrl(sab, CTRL_3D_CONE_INNER, cone ? cone.inner : 360);
    setCtrl(sab, CTRL_3D_CONE_OUTER, cone ? cone.outer : 360);
    setCtrlFloat(sab, CTRL_3D_CONE_ORI_X, cone ? cone.oriX : 0);
    setCtrlFloat(sab, CTRL_3D_CONE_ORI_Y, cone ? cone.oriY : 0);
    setCtrlFloat(sab, CTRL_3D_CONE_ORI_Z, cone ? cone.oriZ : 1);
    setCtrl(sab, CTRL_3D_CONE_OUTVOL, cone ? cone.outVolCb : 0);
    setCtrl(sab, CTRL_3D_FLAGS, 1); // enable 3D mixing for this source
}

// ==================== Sample Playback ====================

export function playSample(ctx: MSSContext, sample: MSSSample): void {
    sample.lastRingCursorBytes = undefined;
    sample.lastRingCursorTime = undefined;

    if (!sample.decodedData || sample.decodedData.length === 0) {
        if (sample.fileData && isEncodedFormat(sample.fileFormat)) {
            const volume = sample.volume / 127.0;
            const pan = (sample.pan - 64) / 63;
            const payloadData = sample.fileData.slice();

            self.postMessage({
                type: "audio_play_encoded",
                payload: {
                    id: sample.id,
                    data: payloadData,
                    mimeType: encodedMimeType(sample.fileFormat),
                    playbackRate: sample.playbackRate,
                    volume: volume,
                    pan: pan,
                    loopCount: sample.loopCount
                }
            } as any, [payloadData.buffer] as any);

            sample.isPlaying = true;
            sample.isStopped = false;
            sample.position = 1024;
            if (!sample.startTime) {
                sample.startTime = performance.now();
            }
            sample.pendingStart = false;
            ctx.samplesById.set(sample.id, sample);
            writeSamplePosition(ctx, sample, sample.position);
            setSampleStatus(ctx, sample, SMP_PLAYING);
            Logger.log(LogCategory.SYSTEM, `MSS32: playSample ${sample.fileFormat} started: id=${sample.id}, handle=0x${sample.handle.toString(16)}, pos=${sample.position}, len=${sample.fileData.length}, startTime=${sample.startTime}`);
            return;
        }

        Logger.warn(LogCategory.SYSTEM, `MSS32: playSample: No data for sample id=${sample.id}`);
        sample.pendingStart = false;
        sample.isPlaying = false;
        setSampleStatus(ctx, sample, SMP_DONE);
        return;
    }

    // Stop any previous playback
    const prevEntry = ringBuffers.get(sample.id);
    if (prevEntry) {
        setCtrl(prevEntry.sab, CTRL_STATE, STATE_STOPPED);
    }

    // PCM path: use SAB ring buffer
    const dataBytes = sample.decodedData.byteLength;
    const sab = ensureRingBuffer(sample.id, sample.channels, sample.sampleRate, 32 /* Float32 */, dataBytes);

    // Copy decoded Float32 data into SAB data region
    const dst = new Uint8Array(sab, CTRL_BLOCK_BYTES, dataBytes);
    dst.set(new Uint8Array(sample.decodedData.buffer, sample.decodedData.byteOffset, dataBytes));

    // Set control fields
    setCtrl(sab, CTRL_DATA_LENGTH, dataBytes);
    setCtrl(sab, CTRL_VOLUME, volumeToCentibels(sample.volume));
    setCtrl(sab, CTRL_PAN, panToCentibels(sample.pan));
    const freqHz = sample.playbackRateHz || Math.round(sample.sampleRate * sample.playbackRate);
    setCtrl(sab, CTRL_FREQUENCY, freqHz);
    setCtrl(sab, CTRL_LOOP_MODE, loopCountToMode(sample.loopCount));
    setCtrl(sab, CTRL_RESERVED, 1); // signal worklet to reset position & loopsCompleted
    if (sample.is3D) applySample3D(sample); // write CTRL_3D_* before the worklet starts mixing
    setCtrl(sab, CTRL_STATE, STATE_PLAYING);

    sample.isPlaying = true;
    sample.isStopped = false;
    sample.position = 1024;
    if (!sample.startTime) {
        sample.startTime = performance.now();
    }
    sample.pendingStart = false;
    ctx.samplesById.set(sample.id, sample);
    writeSamplePosition(ctx, sample, sample.position);
    setSampleStatus(ctx, sample, SMP_PLAYING);
}

export function updateSamplePlayback(ctx: MSSContext, sample: MSSSample): void {
    const entry = ringBuffers.get(sample.id);
    if (entry) {
        // Update via Atomics — zero latency
        setCtrl(entry.sab, CTRL_VOLUME, volumeToCentibels(sample.volume));
        setCtrl(entry.sab, CTRL_PAN, panToCentibels(sample.pan));
        const freqHz = (sample.playbackRateHz && !isEncodedFormat(sample.fileFormat))
            ? sample.playbackRateHz
            : Math.round(sample.sampleRate * sample.playbackRate);
        setCtrl(entry.sab, CTRL_FREQUENCY, freqHz);
        setCtrl(entry.sab, CTRL_LOOP_MODE, loopCountToMode(sample.loopCount));
        return;
    }

    // Fallback: legacy postMessage path (encoded or no ring buffer)
    const volume = sample.volume / 127.0;
    const pan = (sample.pan - 64) / 63;
    const payload: {
        id: number;
        volume: number;
        pan: number;
        playbackRate: number;
        loopCount: number;
        playbackRateHz?: number;
    } = {
        id: sample.id,
        volume: volume,
        pan: pan,
        playbackRate: sample.playbackRate,
        loopCount: sample.loopCount
    };
    if (sample.playbackRateHz && !isEncodedFormat(sample.fileFormat)) {
        payload.playbackRateHz = sample.playbackRateHz;
    }
    self.postMessage({
        type: "audio_update",
        payload
    });
}

export function appendDecodedChunk(ctx: MSSContext, sample: MSSSample, chunk: Float32Array): void {
    if (chunk.length === 0) return;

    const entry = ringBuffers.get(sample.id);
    if (entry) {
        // Append to SAB ring buffer
        const currentLen = getCtrl(entry.sab, CTRL_DATA_LENGTH);
        const chunkBytes = chunk.byteLength;
        const dst = new Uint8Array(entry.sab, CTRL_BLOCK_BYTES + currentLen, chunkBytes);
        dst.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunkBytes));
        setCtrl(entry.sab, CTRL_DATA_LENGTH, currentLen + chunkBytes);
    } else {
        // Fallback: legacy postMessage path
        self.postMessage({
            type: "audio_append",
            payload: {
                id: sample.id,
                data: chunk
            }
        } as any, [chunk.buffer] as any);
    }

    const bytesThis = chunk.length * (sample.bitsPerSample >> 3 || 2);
    sample.totalBytes = (sample.totalBytes ?? 0) + bytesThis;
    setSampleStatus(ctx, sample, SMP_PLAYING);
}

// ==================== Stop / Resume (shared by samples and streams) ====================

/** Stop playback via ring buffer Atomics. Returns true if handled. */
export function stopRingBuffer(id: number): boolean {
    const entry = ringBuffers.get(id);
    if (!entry) return false;
    setCtrl(entry.sab, CTRL_STOP_REQUESTED, 1);
    return true;
}

/** Resume playback via ring buffer Atomics. Returns true if handled. */
export function resumeRingBuffer(id: number): boolean {
    const entry = ringBuffers.get(id);
    if (!entry) return false;
    setCtrl(entry.sab, CTRL_STATE, STATE_PLAYING);
    return true;
}

function estimateWallClockPosition(item: MSSSample | MSSStream, now: number): { position: number; totalLen: number; finished: boolean } {
    const elapsed = (now - (item.startTime ?? now)) / 1000.0;
    const bytesPerSec = getBytesPerSecond(item);
    const effectiveBytesPerSec = bytesPerSec * (item.playbackRate || 1.0);
    const absolutePos = Math.max(0, Math.floor(elapsed * effectiveBytesPerSec));
    const totalLen = getPlaybackLengthBytes(item);

    if (totalLen <= 0) {
        return { position: 0, totalLen: 0, finished: false };
    }

    if (item.loopCount === 0 || item.loopCount === -1) {
        return { position: absolutePos % totalLen, totalLen, finished: false };
    }

    const playCount = Math.max(1, item.loopCount || 1);
    const endPos = totalLen * playCount;

    // For host-decoded encoded formats (MP3/OGG) the wall-clock is a *fallback*, not the
    // authoritative clock: the host posts `audio_ended` at the true end. Our duration is a
    // best-effort estimate (CBR bitrate for MP3 — can run short for VBR/padded streams), so
    // finishing exactly at endPos would race the host and truncate a healthy tail. Give the
    // host priority with a margin; wall-clock then only fires when the host stays silent
    // (the frozen-AudioContext case this whole path exists for). OGG granule duration is
    // sample-accurate, so the margin is just slack there.
    const margin = isEncodedFormat(item.fileFormat)
        ? Math.max(totalLen * 0.05, bytesPerSec * 0.5)  // 5% of length or 0.5s, whichever larger
        : 0;
    if (absolutePos >= endPos + margin) {
        return { position: totalLen, totalLen, finished: true };
    }

    return { position: absolutePos % totalLen, totalLen, finished: false };
}

function canUseWallClockCompletion(item: MSSSample | MSSStream): boolean {
    if (!isEncodedFormat(item.fileFormat)) {
        return true;
    }
    return (item.encodedDurationMs !== undefined && item.encodedDurationMs > 0) ||
        (item.pcmBytes !== undefined && item.pcmBytes > 0);
}

/** Guest-visible position sync — less strict than completion (uses file size as last resort). */
function canEstimateWallClockPosition(item: MSSSample | MSSStream): boolean {
    if (!isEncodedFormat(item.fileFormat)) {
        return true;
    }
    return getPlaybackLengthBytes(item) > 0;
}

function shouldFinishStaleOneShotPcm(sample: MSSSample, now: number): boolean {
    if (sample.formatTag !== 1 || sample.loopCount === 0 || sample.loopCount === -1) {
        return false;
    }
    const totalLen = getPlaybackLengthBytes(sample);
    const effectiveBytesPerSec = getBytesPerSecond(sample) * (sample.playbackRate || 1.0);
    if (totalLen <= 0 || effectiveBytesPerSec <= 0 || sample.startTime === undefined) {
        return false;
    }

    const cursorLastMoved = sample.lastRingCursorTime ?? now;
    if (now - cursorLastMoved < RING_CURSOR_STALE_MS) {
        return false;
    }

    const playCount = Math.max(1, sample.loopCount || 1);
    const expectedMs = (totalLen * playCount / effectiveBytesPerSec) * 1000.0;
    const graceMs = Math.max(250, Math.min(1000, expectedMs * 0.05));
    return now - sample.startTime >= expectedMs + graceMs;
}

/** Resolve a deferred start_sample once file data is ready. */
function tryKickPendingSampleStart(ctx: MSSContext, sample: MSSSample): void {
    if (!sample.pendingStart || !sample.fileData) return;
    if (sample.decodedData?.length || isEncodedFormat(sample.fileFormat)) {
        if (!sample.startTime) {
            sample.startTime = performance.now();
        }
        playSample(ctx, sample);
    }
}

// ==================== Stream Playback ====================

export function playStream(ctx: MSSContext, stream: MSSStream): void {
    if (!stream.decodedData || stream.decodedData.length === 0) {
        if (stream.fileData && isEncodedFormat(stream.fileFormat)) {
            const volume = stream.volume / 127.0;
            const pan = (stream.pan - 64) / 63;
            const payloadData = stream.fileData.slice();

            self.postMessage({
                type: "audio_play_encoded",
                payload: {
                    id: stream.id,
                    data: payloadData,
                    mimeType: encodedMimeType(stream.fileFormat),
                    playbackRate: stream.playbackRate,
                    volume: volume,
                    pan: pan,
                    loopCount: stream.loopCount
                }
            } as any, [payloadData.buffer] as any);

            stream.isPlaying = true;
            stream.isPaused = false;
            stream.position = 1024;
            if (!stream.startTime) {
                stream.startTime = performance.now();
            }
            stream.pendingStart = false;
            writeStreamPosition(ctx, stream, stream.position);
            setStreamStatus(ctx, stream, SMP_PLAYING);
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream ${stream.fileFormat} playback started (id=${stream.id}, handle=0x${stream.handle.toString(16)})`);
            return;
        }

        Logger.warn(LogCategory.SYSTEM, `MSS32: playStream: No data for stream id=${stream.id}`);
        return;
    }

    // Stop any previous playback
    const prevEntry = ringBuffers.get(stream.id);
    if (prevEntry) {
        setCtrl(prevEntry.sab, CTRL_STATE, STATE_STOPPED);
    }

    // PCM path: use SAB ring buffer
    const dataBytes = stream.decodedData.byteLength;
    const sab = ensureRingBuffer(stream.id, stream.channels, stream.sampleRate, 32 /* Float32 */, dataBytes);

    // Copy decoded Float32 data into SAB data region
    const dst = new Uint8Array(sab, CTRL_BLOCK_BYTES, dataBytes);
    dst.set(new Uint8Array(stream.decodedData.buffer, stream.decodedData.byteOffset, dataBytes));

    // Set control fields
    setCtrl(sab, CTRL_DATA_LENGTH, dataBytes);
    setCtrl(sab, CTRL_VOLUME, volumeToCentibels(stream.volume));
    setCtrl(sab, CTRL_PAN, panToCentibels(stream.pan));
    const freqHz = stream.playbackRateHz || Math.round(stream.sampleRate * stream.playbackRate);
    setCtrl(sab, CTRL_FREQUENCY, freqHz);
    setCtrl(sab, CTRL_LOOP_MODE, loopCountToMode(stream.loopCount));
    setCtrl(sab, CTRL_RESERVED, 1); // signal worklet to reset position & loopsCompleted
    setCtrl(sab, CTRL_STATE, STATE_PLAYING);

    stream.isPlaying = true;
    stream.isPaused = false;
    stream.position = 1024;
    if (!stream.startTime) {
        stream.startTime = performance.now();
    }
    stream.pendingStart = false;
    writeStreamPosition(ctx, stream, stream.position);
    setStreamStatus(ctx, stream, SMP_PLAYING);
    Logger.log(LogCategory.SYSTEM, `MSS32: Stream playback started (id=${stream.id})`);
}

export function updateStreamPlayback(ctx: MSSContext, stream: MSSStream): void {
    const entry = ringBuffers.get(stream.id);
    if (entry) {
        setCtrl(entry.sab, CTRL_VOLUME, volumeToCentibels(stream.volume));
        setCtrl(entry.sab, CTRL_PAN, panToCentibels(stream.pan));
        const freqHz = (stream.playbackRateHz && !isEncodedFormat(stream.fileFormat))
            ? stream.playbackRateHz
            : Math.round(stream.sampleRate * stream.playbackRate);
        setCtrl(entry.sab, CTRL_FREQUENCY, freqHz);
        setCtrl(entry.sab, CTRL_LOOP_MODE, loopCountToMode(stream.loopCount));
        return;
    }

    // Fallback: legacy postMessage path (encoded or no ring buffer)
    const volume = stream.volume / 127.0;
    const pan = (stream.pan - 64) / 63;

    const payload: {
        id: number;
        volume: number;
        pan: number;
        playbackRate: number;
        loopCount: number;
        playbackRateHz?: number;
    } = {
        id: stream.id,
        volume: volume,
        pan: pan,
        playbackRate: stream.playbackRate,
        loopCount: stream.loopCount
    };

    if (stream.playbackRateHz && !isEncodedFormat(stream.fileFormat)) {
        payload.playbackRateHz = stream.playbackRateHz;
    }

    self.postMessage({
        type: "audio_update",
        payload: payload
    });
}

// ==================== Position Tracking (Heartbeat) ====================

/**
 * Update emulator memory state to reflect current playback positions.
 * Called periodically (20Hz) to keep guest memory synchronized.
 */
export function updateEmulatorState(ctx: MSSContext): void {
    const now = performance.now();

    for (const sample of ctx.samples.values()) {
        if (!sample.fileData) continue;

        tryKickPendingSampleStart(ctx, sample);

        if (!sample.isPlaying || !sample.startTime) continue;

        // Try reading position from ring buffer first
        const rbEntry = ringBuffers.get(sample.id);
        if (rbEntry && !isEncodedFormat(sample.fileFormat)) {
            const playCursor = getCtrl(rbEntry.sab, CTRL_PLAY_CURSOR);
            const blockAlign = getCtrl(rbEntry.sab, CTRL_BLOCK_ALIGN);
            const newPos = blockAlign > 0 ? Math.floor(playCursor / blockAlign) * (sample.bitsPerSample >> 3 || 2) * sample.channels : playCursor;

            if (sample.lastRingCursorBytes !== playCursor || sample.lastRingCursorTime === undefined) {
                sample.lastRingCursorBytes = playCursor;
                sample.lastRingCursorTime = now;
            }

            if (newPos !== sample.position) {
                sample.position = newPos;
                writeSamplePosition(ctx, sample, newPos);
            }

            // Check if playback ended (worklet sets state to stopped)
            const state = getCtrl(rbEntry.sab, CTRL_STATE);
            if (state === STATE_STOPPED && sample.isPlaying) {
                finishSamplePlayback(ctx, sample, getPlaybackLengthBytes(sample));
                invokeEOSCallback(ctx, sample);
                Logger.log(LogCategory.SYSTEM, `MSS32: Sample id=${sample.id} finished playing (ring buffer ended)`);
                continue;
            }

            // One-shot PCM: if the worklet missed STOPPED and the cursor stopped moving, finish anyway.
            const totalLen = getPlaybackLengthBytes(sample);
            if (shouldFinishStaleOneShotPcm(sample, now)) {
                finishSamplePlayback(ctx, sample, totalLen);
                invokeEOSCallback(ctx, sample);
                Logger.log(LogCategory.SYSTEM, `MSS32: Sample id=${sample.id} finished playing (stale ring cursor after PCM duration)`);
                continue;
            }

            setSampleStatus(ctx, sample, SMP_PLAYING);
            continue;
        }

        // Host audio_position recently updated guest memory via handleAudioPosition.
        const hasFreshAudioPos = sample.lastAudioPositionTime !== undefined && (now - sample.lastAudioPositionTime) < 250;
        if (hasFreshAudioPos) {
            setSampleStatus(ctx, sample, SMP_PLAYING);
            continue;
        }

        const isEncoded = isEncodedFormat(sample.fileFormat);
        if (!canEstimateWallClockPosition(sample)) {
            setSampleStatus(ctx, sample, SMP_PLAYING);
            continue;
        }
        const { position: newPos, totalLen, finished } = estimateWallClockPosition(sample, now);

        if (newPos !== sample.position) {
            const oldPos = sample.position;
            sample.position = newPos;
            writeSamplePosition(ctx, sample, newPos);
            setSampleStatus(ctx, sample, SMP_PLAYING);

            if (Math.abs(newPos - oldPos) > 1000 &&
                Logger.isEnabled(LogCategory.SYSTEM, LogLevel.VERBOSE)) {
                Logger.verbose(
                    LogCategory.SYSTEM,
                    `MSS32: Sample id=${sample.id} pos: ${oldPos} -> ${newPos} ${totalLen > 0 ? "(" + ((newPos / totalLen) * 100).toFixed(1) + "%)" : ""}`
                );
            }
        } else {
            setSampleStatus(ctx, sample, SMP_PLAYING);
        }

        // Wall-clock completion is authoritative ONLY for decoded (WAV/PCM) voices, where our
        // length is exact. Encoded voices (MP3/OGG) are played by the host HTMLAudioElement,
        // which IS the real clock and fires `audio_ended` at the true end — a guessed duration
        // here (or, worse, an `audio_stop`) cuts healthy playback short. Observed: Re-Volt level
        // music (Chrome, AudioContext running) dying mid-track because wall-clock fired first.
        // For encoded we therefore only track position and defer completion entirely to the host.
        if (finished && !isEncoded && canUseWallClockCompletion(sample)) {
            finishSamplePlayback(ctx, sample, newPos);
            invokeEOSCallback(ctx, sample);
            Logger.log(LogCategory.SYSTEM, `MSS32: Sample id=${sample.id} finished playing (wall-clock duration reached)`);
            continue;
        }

        if (isEncoded) {
            const lastLog = sample.lastDebugLogTime ?? 0;
            if (now - lastLog >= 1000) {
                const lastPos = sample.lastDebugPos ?? sample.position;
                const delta = sample.position - lastPos;
                Logger.log(
                    LogCategory.SYSTEM,
                    `MSS32: MP3 debug id=${sample.id} pos=${sample.position} (+${delta}) rate=${sample.playbackRate.toFixed(3)} loop=${sample.loopCount} pending=${sample.pendingStart ? 1 : 0}`
                );
                sample.lastDebugLogTime = now;
                sample.lastDebugPos = sample.position;
            }
        }
    }

    // Update streams position tracking
    for (const stream of ctx.streams.values()) {
        if (!stream.isPlaying || stream.isPaused || !stream.startTime || !stream.fileData) continue;

        // Try reading position from ring buffer
        const rbEntry = ringBuffers.get(stream.id);
        if (rbEntry && !isEncodedFormat(stream.fileFormat)) {
            const playCursor = getCtrl(rbEntry.sab, CTRL_PLAY_CURSOR);
            const blockAlign = getCtrl(rbEntry.sab, CTRL_BLOCK_ALIGN);
            const newPos = blockAlign > 0 ? Math.floor(playCursor / blockAlign) * (stream.bitsPerSample >> 3 || 2) * stream.channels : playCursor;

            if (newPos !== stream.position) {
                stream.position = newPos;
                writeStreamPosition(ctx, stream, newPos);
            }

            const state = getCtrl(rbEntry.sab, CTRL_STATE);
            if (state === STATE_STOPPED && stream.isPlaying) {
                stream.isPlaying = false;
                stream.isPaused = false;
                stream.startTime = undefined;
                setStreamStatus(ctx, stream, SMP_DONE);
                Logger.log(LogCategory.SYSTEM, `MSS32: Stream id=${stream.id} finished playing (ring buffer ended)`);
                continue;
            }

            setStreamStatus(ctx, stream, SMP_PLAYING);
            continue;
        }

        const hasFreshAudioPos = stream.lastAudioPositionTime !== undefined && (now - stream.lastAudioPositionTime) < 250;
        if (hasFreshAudioPos) {
            setStreamStatus(ctx, stream, SMP_PLAYING);
            continue;
        }

        const isEncoded = isEncodedFormat(stream.fileFormat);
        if (!canEstimateWallClockPosition(stream)) {
            setStreamStatus(ctx, stream, SMP_PLAYING);
            continue;
        }
        const { position: newPos, finished } = estimateWallClockPosition(stream, now);

        if (newPos !== stream.position) {
            stream.position = newPos;
            writeStreamPosition(ctx, stream, newPos);
            setStreamStatus(ctx, stream, SMP_PLAYING);
        } else {
            setStreamStatus(ctx, stream, SMP_PLAYING);
        }

        // Same rule as samples: encoded streams (MP3 music) are clocked by the host element and
        // its `audio_ended`; only decoded streams may complete on our wall-clock estimate.
        if (finished && !isEncoded && canUseWallClockCompletion(stream)) {
            stream.isPlaying = false;
            stream.isPaused = false;
            stream.pendingStart = false;
            stream.startTime = undefined;
            setStreamStatus(ctx, stream, SMP_DONE);
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream id=${stream.id} finished playing (wall-clock duration reached)`);
        }
    }
}
