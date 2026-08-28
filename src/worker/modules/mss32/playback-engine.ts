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
    CTRL_BITS_PER_SAMPLE,
    CTRL_BLOCK_ALIGN,
    STATE_PLAYING,
    STATE_STOPPED,
    CTRL_BLOCK_BYTES,
    CTRL_STOP_REQUESTED,
    CTRL_RESERVED,
    CTRL_WRITE_CURSOR,
    CTRL_FLAGS,
    FLAG_CIRCULAR,
    FLAG_STREAMING,
    setCtrlFloat,
    CTRL_3D_POS_X, CTRL_3D_POS_Y, CTRL_3D_POS_Z,
    CTRL_3D_VEL_X, CTRL_3D_VEL_Y, CTRL_3D_VEL_Z,
    CTRL_3D_MIN_DIST, CTRL_3D_MAX_DIST, CTRL_3D_MODE,
    CTRL_3D_CONE_INNER, CTRL_3D_CONE_OUTER,
    CTRL_3D_CONE_ORI_X, CTRL_3D_CONE_ORI_Y, CTRL_3D_CONE_ORI_Z,
    CTRL_3D_CONE_OUTVOL, CTRL_3D_FLAGS,
} from "../../../audio/audio-ring-buffer";
import { ensureAudioStatsSab } from "../audio-stats-sab";

// Side table for ring buffers — keyed by sample/stream id.
// `writeBytes` is the PRODUCER's cursor and exists only for streaming rings
// (FLAG_STREAMING): the worklet owns CTRL_PLAY_CURSOR, we own CTRL_WRITE_CURSOR.
const ringBuffers = new Map<number, {
    sab: SharedArrayBuffer;
    registered: boolean;
    streaming?: boolean;
    writeBytes?: number;
}>();
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

// ==================== Streaming ring (incremental AIL_open_stream) ====================
//
// A stream that is fed a buffer at a time gets a FIXED circular ring instead of a
// SAB sized to the whole decoded file: we advance CTRL_WRITE_CURSOR as data lands,
// the worklet plays up to it and emits silence (and counts STATS_STARVED_BLOCKS)
// if it ever catches up. `write == play` is the worklet's "nothing available", so
// the producer must always leave one frame of headroom — a completely full ring
// would read as a completely empty one.

/** Float32 frames the worklet plays from; the guest's own block align is unrelated. */
function ringFrameBytes(stream: MSSStream): number {
    return Math.max(1, stream.channels) * 4;
}

/** (Re)create a stream's streaming ring. `ringBytes` is rounded down to whole frames. */
export function ensureStreamingRing(stream: MSSStream, ringBytes: number): SharedArrayBuffer {
    releaseRingBuffer(stream.id);

    const frameBytes = ringFrameBytes(stream);
    const bytes = Math.max(frameBytes * 2, Math.floor(ringBytes / frameBytes) * frameBytes);
    const sab = createAudioRingBuffer(bytes, {
        channels: stream.channels,
        sampleRate: stream.sampleRate,
        bitsPerSample: 32,
    }, true /* circular */);

    setCtrl(sab, CTRL_FLAGS, FLAG_CIRCULAR | FLAG_STREAMING);
    // Streaming uses WRITE_CURSOR as the data boundary; DATA_LENGTH is the ring extent.
    setCtrl(sab, CTRL_DATA_LENGTH, bytes);
    setCtrl(sab, CTRL_PLAY_CURSOR, 0);
    setCtrl(sab, CTRL_WRITE_CURSOR, 0);
    setCtrl(sab, CTRL_RESERVED, 1);

    ensureAudioStatsSab();
    self.postMessage({ type: "audio_register", payload: { id: stream.id, sab } });
    ringBuffers.set(stream.id, { sab, registered: true, streaming: true, writeBytes: 0 });
    return sab;
}

/** Bytes the producer may write right now (one frame of headroom is never offered). */
export function streamingRingFreeBytes(stream: MSSStream): number {
    const entry = ringBuffers.get(stream.id);
    if (!entry?.streaming) return 0;
    const ringBytes = getCtrl(entry.sab, CTRL_DATA_LENGTH);
    if (ringBytes <= 0) return 0;
    const frameBytes = ringFrameBytes(stream);
    const play = getCtrl(entry.sab, CTRL_PLAY_CURSOR) % ringBytes;
    const write = (entry.writeBytes ?? 0) % ringBytes;
    const used = (write - play + ringBytes) % ringBytes;
    return Math.max(0, ringBytes - used - frameBytes);
}

/** Total ring capacity in bytes, or 0 when the stream has no streaming ring. */
export function streamingRingBytes(stream: MSSStream): number {
    const entry = ringBuffers.get(stream.id);
    if (!entry?.streaming) return 0;
    return getCtrl(entry.sab, CTRL_DATA_LENGTH);
}

/**
 * Append decoded frames, wrapping. Writes only what fits; returns the number of
 * FLOATS consumed, so the caller can keep the remainder for the next refill
 * rather than dropping it (a dropped tail is an inaudible click, not an error).
 */
export function appendStreamingRing(stream: MSSStream, floats: Float32Array, fromFloat = 0): number {
    const entry = ringBuffers.get(stream.id);
    if (!entry?.streaming) return 0;
    const ringBytes = getCtrl(entry.sab, CTRL_DATA_LENGTH);
    if (ringBytes <= 0) return 0;

    const frameBytes = ringFrameBytes(stream);
    const offered = (floats.length - fromFloat) * 4;
    const room = Math.floor(streamingRingFreeBytes(stream) / frameBytes) * frameBytes;
    const bytes = Math.min(offered, room);
    if (bytes <= 0) return 0;

    const src = new Uint8Array(floats.buffer, floats.byteOffset + fromFloat * 4, bytes);
    const dst = new Uint8Array(entry.sab, CTRL_BLOCK_BYTES, ringBytes);
    const at = (entry.writeBytes ?? 0) % ringBytes;
    const first = Math.min(bytes, ringBytes - at);
    dst.set(src.subarray(0, first), at);
    if (first < bytes) dst.set(src.subarray(first, bytes), 0);

    entry.writeBytes = ((entry.writeBytes ?? 0) + bytes) % ringBytes;
    setCtrl(entry.sab, CTRL_WRITE_CURSOR, entry.writeBytes);
    return bytes / 4;
}

/** Drop everything buffered and restart the ring at zero (seek / loop restart). */
export function resetStreamingRing(stream: MSSStream): void {
    const entry = ringBuffers.get(stream.id);
    if (!entry?.streaming) return;
    entry.writeBytes = 0;
    setCtrl(entry.sab, CTRL_PLAY_CURSOR, 0);
    setCtrl(entry.sab, CTRL_WRITE_CURSOR, 0);
    setCtrl(entry.sab, CTRL_RESERVED, 1);
}

/** The worklet's play cursor, in ring bytes. -1 when there is no streaming ring. */
export function streamingRingPlayCursor(stream: MSSStream): number {
    const entry = ringBuffers.get(stream.id);
    if (!entry?.streaming) return -1;
    return getCtrl(entry.sab, CTRL_PLAY_CURSOR);
}

/** Hand a streaming ring to the mixer. Volume/pan/rate come from the stream. */
export function startStreamingRing(ctx: MSSContext, stream: MSSStream): void {
    const entry = ringBuffers.get(stream.id);
    if (!entry?.streaming) return;
    const sab = entry.sab;
    setCtrl(sab, CTRL_VOLUME, volumeToCentibels(stream.volume));
    setCtrl(sab, CTRL_PAN, panToCentibels(stream.pan));
    setCtrl(sab, CTRL_FREQUENCY, stream.playbackRateHz || Math.round(stream.sampleRate * stream.playbackRate));
    // A streaming ring never "ends" on its own — the engine decides when the source
    // is exhausted, so loop mode must not make the worklet stop at the ring's end.
    setCtrl(sab, CTRL_LOOP_MODE, -1);
    setCtrl(sab, CTRL_STATE, STATE_PLAYING);

    stream.isPlaying = true;
    stream.isPaused = false;
    stream.pendingStart = false;
    if (!stream.startTime) stream.startTime = performance.now();
    setStreamStatus(ctx, stream, SMP_PLAYING);
}

/**
 * Guest-visible position of an incrementally fed stream, in decoded bytes.
 *
 * Derived from what the WORKLET has consumed — frames handed to the ring minus
 * frames still sitting in it — not from wall clock. A stalled mixer therefore
 * stops the reported position instead of running the guest's clock past audio
 * nobody has heard, which is exactly the divergence a starving stream produces.
 */
export function incrementalStreamPosition(stream: MSSStream): number {
    const src = stream.source;
    if (!src) return stream.position;
    const ringBytes = streamingRingBytes(stream);
    const frameBytes = Math.max(1, stream.channels) * 4;
    const buffered = ringBytes > 0
        ? Math.max(0, ringBytes - streamingRingFreeBytes(stream) - frameBytes) / frameBytes
        : 0;
    const played = Math.max(0, src.framesDecoded - buffered);
    const total = src.totalFrames > 0 ? src.totalFrames : 0;
    const frame = total > 0 ? played % total : played;
    return Math.floor(frame) * Math.max(1, stream.channels) * 2;
}

/** True once the source is spent AND the ring has drained — the stream is DONE. */
export function incrementalStreamFinished(stream: MSSStream): boolean {
    const src = stream.source;
    if (!src || !src.exhausted || src.pending) return false;
    const ringBytes = streamingRingBytes(stream);
    if (ringBytes <= 0) return true;
    const frameBytes = Math.max(1, stream.channels) * 4;
    return streamingRingFreeBytes(stream) >= ringBytes - frameBytes;
}

/** Mark a finished incremental stream DONE (a streaming ring never ends by itself). */
export function finishIncrementalStream(ctx: MSSContext, stream: MSSStream): void {
    stream.isPlaying = false;
    stream.isPaused = false;
    stream.pendingStart = false;
    stream.startTime = undefined;
    setStreamStatus(ctx, stream, SMP_DONE);
    Logger.log(LogCategory.SYSTEM, `MSS32: Stream id=${stream.id} finished (source exhausted, ring drained)`);
}

/** True when this stream is driven by the incremental engine. */
export function hasStreamingRing(stream: MSSStream): boolean {
    return !!ringBuffers.get(stream.id)?.streaming;
}

/**
 * Ring state for diagnostics, including the PEAK amplitude actually resident.
 *
 * The peak is what makes "is it playing?" answerable: a play cursor that advances
 * over a ring of zeros looks identical to music. `used` is the worklet's own
 * available-bytes formula, so a value pinned at 0 IS the starvation the STARVED
 * counter reports, seen from the producer side.
 */
export function describeRing(id: number): Record<string, number | boolean> | null {
    const entry = ringBuffers.get(id);
    if (!entry) return null;
    const sab = entry.sab;
    const ringBytes = getCtrl(sab, CTRL_DATA_LENGTH);
    const play = getCtrl(sab, CTRL_PLAY_CURSOR);
    const write = getCtrl(sab, CTRL_WRITE_CURSOR);
    const bits = getCtrl(sab, CTRL_BITS_PER_SAMPLE) || 32;
    const view = new DataView(sab, CTRL_BLOCK_BYTES);
    const bytesPer = Math.max(1, bits >> 3);
    const step = Math.max(bytesPer, Math.floor(view.byteLength / (4096 * bytesPer)) * bytesPer);
    let peak = 0;
    for (let o = 0; o + bytesPer <= view.byteLength; o += step) {
        const s = bits === 32 ? view.getFloat32(o, true)
            : bits === 8 ? (view.getUint8(o) - 128) / 128
                : view.getInt16(o, true) / 32768;
        const a = Math.abs(s);
        if (a > peak) peak = a;
    }
    return {
        streaming: !!entry.streaming,
        ringBytes,
        playCursor: play,
        writeCursor: write,
        used: ringBytes > 0 ? (write - play + ringBytes) % ringBytes : 0,
        state: getCtrl(sab, CTRL_STATE),
        loopMode: getCtrl(sab, CTRL_LOOP_MODE),
        flags: getCtrl(sab, CTRL_FLAGS),
        frequency: getCtrl(sab, CTRL_FREQUENCY),
        volumeCb: getCtrl(sab, CTRL_VOLUME),
        ringPeak: Math.round(peak * 1000) / 1000,
    };
}

/** Drop a stream's ring entirely (close_stream / discard). */
export function releaseStreamRing(id: number): void {
    releaseRingBuffer(id);
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
                    // Positions come back in the unit we declare — the sample's own rate,
                    // which is the timebase its bytes-per-second conversion assumes.
                    positionRateHz: sample.sampleRate,
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

/**
 * Seek a PCM voice to a guest byte offset. The SAB holds Float32 frames, so the guest
 * offset is converted through the sample's own block align; the worklet applies
 * CTRL_PLAY_CURSOR on the next block once CTRL_RESET_POSITION is raised.
 * Returns false when the voice has no ring buffer (host-decoded formats).
 */
export function seekRingBuffer(sample: MSSSample, positionBytes: number): boolean {
    const entry = ringBuffers.get(sample.id);
    if (!entry) return false;
    const guestAlign = Math.max(1, sample.blockAlign
        || Math.max(1, sample.channels) * Math.max(1, sample.bitsPerSample >> 3));
    const frame = Math.max(0, Math.floor(positionBytes / guestAlign));
    const sabAlign = Math.max(1, getCtrl(entry.sab, CTRL_BLOCK_ALIGN));
    setCtrl(entry.sab, CTRL_PLAY_CURSOR, frame * sabAlign);
    setCtrl(entry.sab, CTRL_RESERVED, 1); // CTRL_RESET_POSITION
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
                    // The host decodes this container itself and reports element time
                    // scaled by whatever rate we declare. Undeclared, it substitutes the
                    // DEVICE rate — a different quantity — and every position we then
                    // convert with the stream's own bytes-per-second is off by
                    // device/source (48000/44100 = +8.8% on a typical machine). The
                    // guest reads that position as elapsed audio, so a cutscene keyed to
                    // it runs ahead of its own soundtrack.
                    positionRateHz: stream.sampleRate,
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
        // A streaming ring's loop mode is the ring's, not the stream's: the engine
        // decides when the SOURCE ends, and a worklet told "play once" would stop
        // dead the first time the write cursor wrapped.
        if (!entry.streaming) {
            setCtrl(entry.sab, CTRL_LOOP_MODE, loopCountToMode(stream.loopCount));
        }
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
        if (!stream.isPlaying || stream.isPaused || !stream.startTime) continue;

        // Incrementally fed stream: the engine owns both the position (derived from
        // what the worklet has consumed) and the end (source spent AND ring drained).
        // A circular ring's play cursor wraps, so the linear math below cannot read it.
        if (stream.source) {
            const pos = incrementalStreamPosition(stream);
            if (pos !== stream.position) {
                stream.position = pos;
                writeStreamPosition(ctx, stream, pos);
            }
            if (incrementalStreamFinished(stream)) {
                finishIncrementalStream(ctx, stream);
            } else {
                setStreamStatus(ctx, stream, SMP_PLAYING);
            }
            continue;
        }

        if (!stream.fileData) continue;

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
