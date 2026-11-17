/**
 * Double-buffered HSAMPLE input. A buffer remains owned until the mixer has
 * consumed its decoded frames; copying it into a SAB is not an EOB event.
 */
import type { MSSContext } from "./context";
import { SMP_PLAYING } from "./context";
import type { MSSSample } from "./types";
import { convertToFloat } from "./audio-decode";
import { finishSamplePlayback, setSampleStatus, writeSamplePosition } from "./helpers";
import { invokeEOSCallback } from "./callbacks";
import {
    ensureStreamingRing, appendStreamingRing, armStreamingRing,
    streamingRingBytes, streamingRingFreeBytes,
} from "./playback-engine";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export function loadSampleBuffer(ctx: MSSContext, sample: MSSSample, mem: Uint8Array,
    slot: number, address: number, length: number): number {
    if (slot !== 0 && slot !== 1) return 0;
    updateSampleBufferPlayback(ctx, sample);
    if (length === 0) {
        if (sample.bufferPlayback) sample.bufferPlayback.ending = true;
        return 1;
    }
    if (length < 0 || length > MAX_BUFFER_BYTES || address <= 0 || address + length > mem.length) return 0;
    if (sample.streamBuffers?.[slot]?.inUse) return 0;
    const channels = Math.max(1, sample.channels);
    const decoded = convertToFloat(mem.slice(address, address + length), channels,
        sample.bitsPerSample || 16, sample.formatTag || 1, sample.blockAlign);
    const chunk = decoded.subarray(0, Math.floor(decoded.length / channels) * channels);
    if (!chunk.length) return 0;
    if (!sample.bufferPlayback) {
        // At least two submitted buffers fit. The ring stays bounded; a larger later
        // buffer is held as a pending chunk and fed as the mixer makes room.
        const frameBytes = Math.max(1, sample.channels) * 4;
        ensureStreamingRing(sample, Math.max(64 * 1024, chunk.byteLength * 2 + frameBytes));
        sample.bufferPlayback = { submittedFrames: 0, writtenFrames: 0, pending: [], chunks: [], ending: false };
        sample.fileData = mem.slice(address, address + length);
        sample.decodedData = chunk;
        sample.fileDataAllocated = false;
        sample.fileDataAddress = address;
        sample.position = 0;
        sample.startTime = performance.now();
    }
    const state = sample.bufferPlayback;
    const frames = chunk.length / Math.max(1, sample.channels);
    state.submittedFrames += frames;
    state.pending.push({ data: chunk, at: 0 });
    state.chunks.push({ slot, data: chunk, endFrame: state.submittedFrames });
    sample.streamBuffers ??= [];
    sample.streamBuffers[slot] = { ptr: address, size: length, inUse: true, endFrame: state.submittedFrames };
    sample.totalBytes = (sample.totalBytes ?? 0) + length;
    sample.isPlaying = true;
    sample.isStopped = false;
    sample.pendingStart = false;
    ctx.samplesById.set(sample.id, sample);
    updateSampleBufferPlayback(ctx, sample);
    armStreamingRing(ctx, sample, true);
    return 1;
}

export function updateSampleBufferPlayback(ctx: MSSContext, sample: MSSSample): void {
    const state = sample.bufferPlayback;
    if (!state || !sample.isPlaying || sample.isStopped) return;
    const frameBytes = Math.max(1, sample.channels) * 4;
    const capacity = streamingRingBytes(sample);
    const bufferedFrames = capacity > 0
        ? Math.max(0, capacity - streamingRingFreeBytes(sample) - frameBytes) / frameBytes : 0;
    const played = Math.max(0, state.writtenFrames - bufferedFrames);
    // Retire in submission order, not buffer-number order.
    const completed = (sample.streamBuffers ?? []).filter(b => b.inUse && b.endFrame !== undefined && played >= b.endFrame)
        .sort((a, b) => a.endFrame! - b.endFrame!);
    for (const buffer of completed) {
        buffer.inUse = false;
        if (sample.eobCallback) ctx.pendingEOBCallbacks.push({
            callback: sample.eobCallback, handle: sample.handle, id: sample.id,
        });
    }
    state.chunks = state.chunks.filter(chunk => chunk.endFrame > played);
    sample.position = played * Math.max(1, sample.blockAlign);
    writeSamplePosition(ctx, sample, sample.position);
    while (state.pending.length) {
        const head = state.pending[0]!;
        const written = appendStreamingRing(sample, head.data, head.at);
        head.at += written;
        state.writtenFrames += written / Math.max(1, sample.channels);
        if (head.at < head.data.length) break;
        state.pending.shift();
    }
    if (state.ending && !state.pending.length && played >= state.submittedFrames) {
        finishSamplePlayback(ctx, sample, sample.position);
        invokeEOSCallback(ctx, sample);
        return;
    }
    setSampleStatus(ctx, sample, SMP_PLAYING);
}

/** AIL_start_sample rewinds the CURRENT source buffer; resume does not.
 * Retain only still-owned chunks, never replay data whose EOB already released it. */
export function restartSampleBufferPlayback(ctx: MSSContext, sample: MSSSample): number {
    updateSampleBufferPlayback(ctx, sample);
    const state = sample.bufferPlayback;
    if (!state?.chunks.length) return 0;
    const chunks = state.chunks.slice();
    const capacity = streamingRingBytes(sample);
    ensureStreamingRing(sample, capacity);
    state.pending = [];
    state.chunks = [];
    state.submittedFrames = 0;
    state.writtenFrames = 0;
    for (const chunk of chunks) {
        state.submittedFrames += chunk.data.length / Math.max(1, sample.channels);
        state.chunks.push({ ...chunk, endFrame: state.submittedFrames });
        state.pending.push({ data: chunk.data, at: 0 });
        sample.streamBuffers![chunk.slot]!.endFrame = state.submittedFrames;
    }
    sample.position = 0;
    sample.startTime = performance.now();
    sample.isPlaying = true;
    sample.isStopped = false;
    sample.pendingStart = false;
    updateSampleBufferPlayback(ctx, sample);
    armStreamingRing(ctx, sample, true);
    return 1;
}
