/**
 * Unified Audio Ring Buffer — SharedArrayBuffer protocol for PCM audio.
 *
 * Layout: 64-byte control block (Int32Array-aligned for Atomics) + N bytes of raw PCM data.
 * Worker writes PCM samples and control params; AudioWorklet reads samples and advances cursors.
 *
 * This file is imported by both the worker thread and the AudioWorklet scope,
 * so it MUST NOT import any DOM/Node/worker-specific APIs.
 */

// ─── Control block field indices (Int32Array element offsets) ─────────────────

/** Byte offset of current playback position (worklet writes) */
export const CTRL_PLAY_CURSOR = 0;
/** Byte offset of write boundary. Non-streaming: worklet writes (look-ahead). Streaming: producer writes (data boundary). */
export const CTRL_WRITE_CURSOR = 1;
/** Total ring buffer data size in bytes */
export const CTRL_BUFFER_BYTES = 2;
/** Number of channels (1 or 2) */
export const CTRL_CHANNELS = 3;
/** Sample rate in Hz (e.g. 22050, 44100) */
export const CTRL_SAMPLE_RATE = 4;
/** Bits per sample: 8 (Uint8), 16 (Int16LE), or 32 (Float32LE) */
export const CTRL_BITS_PER_SAMPLE = 5;
/** Bytes per sample frame: channels * bitsPerSample / 8 */
export const CTRL_BLOCK_ALIGN = 6;
/** Playback state: 0=stopped, 1=playing, 2=paused */
export const CTRL_STATE = 7;
/** Loop mode: 0=once (play 1x), -1=loop forever, N>1=loop N times */
export const CTRL_LOOP_MODE = 8;
/** Volume in DirectSound centibels: -10000..0 (0=full volume) */
export const CTRL_VOLUME = 9;
/** Pan in DirectSound units: -10000..10000 */
export const CTRL_PAN = 10;
/** Playback frequency in Hz (e.g. 22050 for 1x at 22050Hz source) */
export const CTRL_FREQUENCY = 11;
/** Actual data length in bytes (≤ bufferBytes; used for linear/one-shot) */
export const CTRL_DATA_LENGTH = 12;
/** Worker sets 1 → worklet stops + resets cursor */
export const CTRL_STOP_REQUESTED = 13;
/** Bit 0: FLAG_CIRCULAR (dsound/waveOut/video), Bit 1: FLAG_STREAMING (waveOut/video — worklet silences when caught up) */
export const CTRL_FLAGS = 14;
/** Position seek/reset: producer sets PLAY_CURSOR then stores 1 here → worklet syncs rb.position */
export const CTRL_RESERVED = 15;

// ─── 3D per-buffer control fields (slots 16-31) ─────────────────────────────

/** Source position X (float-as-i32 bit pattern) */
export const CTRL_3D_POS_X = 16;
/** Source position Y (float-as-i32 bit pattern) */
export const CTRL_3D_POS_Y = 17;
/** Source position Z (float-as-i32 bit pattern) */
export const CTRL_3D_POS_Z = 18;
/** Source velocity X (float-as-i32 bit pattern) */
export const CTRL_3D_VEL_X = 19;
/** Source velocity Y (float-as-i32 bit pattern) */
export const CTRL_3D_VEL_Y = 20;
/** Source velocity Z (float-as-i32 bit pattern) */
export const CTRL_3D_VEL_Z = 21;
/** Minimum distance (float-as-i32, default 1.0) */
export const CTRL_3D_MIN_DIST = 22;
/** Maximum distance (float-as-i32, default 1e9) */
export const CTRL_3D_MAX_DIST = 23;
/** 3D mode: 0=NORMAL, 1=HEAD_RELATIVE, 2=DISABLE */
export const CTRL_3D_MODE = 24;
/** Inner cone angle in degrees (default 360) */
export const CTRL_3D_CONE_INNER = 25;
/** Outer cone angle in degrees (default 360) */
export const CTRL_3D_CONE_OUTER = 26;
/** Cone orientation X (float-as-i32) */
export const CTRL_3D_CONE_ORI_X = 27;
/** Cone orientation Y (float-as-i32) */
export const CTRL_3D_CONE_ORI_Y = 28;
/** Cone orientation Z (float-as-i32, default 1.0) */
export const CTRL_3D_CONE_ORI_Z = 29;
/** Cone outside volume in centibels (default 0) */
export const CTRL_3D_CONE_OUTVOL = 30;
/** 3D flags: bit0 = has3D */
export const CTRL_3D_FLAGS = 31;

/** Size of control block in bytes (32 Int32 entries × 4 bytes) */
export const CTRL_BLOCK_BYTES = 128;

/** State constants */
export const STATE_STOPPED = 0;
export const STATE_PLAYING = 1;
export const STATE_PAUSED = 2;

/** Flags */
export const FLAG_CIRCULAR = 1;
/** Streaming flag: worklet outputs silence when caught up to write cursor instead of wrapping */
export const FLAG_STREAMING = 2;

// ─── Listener SAB field indices (Int32Array element offsets) ─────────────────

export const LCTRL_POS_X = 0;
export const LCTRL_POS_Y = 1;
export const LCTRL_POS_Z = 2;
export const LCTRL_VEL_X = 3;
export const LCTRL_VEL_Y = 4;
export const LCTRL_VEL_Z = 5;
export const LCTRL_FRONT_X = 6;
export const LCTRL_FRONT_Y = 7;
export const LCTRL_FRONT_Z = 8;
export const LCTRL_TOP_X = 9;
export const LCTRL_TOP_Y = 10;
export const LCTRL_TOP_Z = 11;
export const LCTRL_DIST_FACTOR = 12;
export const LCTRL_ROLLOFF_FACTOR = 13;
export const LCTRL_DOPPLER_FACTOR = 14;

/** Listener SAB size in bytes (16 Int32 entries × 4 bytes) */
export const LISTENER_SAB_BYTES = 64;

// ─── Worklet signal-stats SAB field indices (Int32Array element offsets) ──────
// Single writer: the AudioWorklet (accumulates per 128-frame block, one
// Atomics.add/store per field per block). The worker only reads, except
// STATS_RESET which it sets to 1 to request a counter wipe.

/** process() invocations */
export const STATS_PROC = 0;
/** Output frames rendered (frames × process calls, not per channel) */
export const STATS_FRAMES = 1;
/** Gauge: ring-buffer sources in STATE_PLAYING during the last block */
export const STATS_ACTIVE_RING = 2;
/** Samples whose pre-limiter mixed |s| > 1.0 (would hard-clip) */
export const STATS_CLIP = 3;
/** Samples whose pre-limiter mixed |s| > limiter threshold (limiter engaged) */
export const STATS_LIMITED = 4;
/** Max pre-limiter |s| seen, stored as round(peak*1000), monotonic */
export const STATS_PEAK_MILLI = 5;
/** Sample-to-sample discontinuities: |s[n]−s[n−1]| > 0.5 (pre-limiter, per channel, cross-block) */
export const STATS_DISC = 6;
/** Max |s[n]−s[n−1]| seen, stored as round(jump*1000), monotonic */
export const STATS_MAX_JUMP_MILLI = 7;
/** Streaming source ran dry MID-block (started outputting, hit write cursor) */
export const STATS_UNDERRUN_MID = 8;
/** Streaming source starved for an entire block while STATE_PLAYING */
export const STATS_STARVED_BLOCKS = 9;
/** Gauge: legacy chunk-based sources active during the last block */
export const STATS_ACTIVE_LEGACY = 10;
/** Ring-buffer id whose contribution had the highest per-block peak (ring stage only) */
export const STATS_TOP_SOURCE_ID = 11;
/** That source's peak for the block, stored as round(peak*1000), monotonic (ring stage only) */
export const STATS_TOP_SOURCE_MILLI = 12;
/** Sum of every active source's per-block peak, round(sum*1000), monotonic (ring stage only) */
export const STATS_SUM_SOURCE_MILLI = 13;
/** Gauge: most sources audible (peak > 0.01) in any one block (ring stage only) */
export const STATS_MAX_CONCURRENT = 14;
/** Worker sets 1 → worklet zeroes all counters and clears the flag */
export const STATS_RESET = 15;

/** Stats SAB size in bytes (16 Int32 entries × 4 bytes) */
export const STATS_SAB_BYTES = 64;

// ─── Float ↔ Int32 bit-pattern helpers ──────────────────────────────────────

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

export function floatToI32(f: number): number {
    _f32[0] = f;
    return _i32[0];
}

export function i32ToFloat(i: number): number {
    _i32[0] = i;
    return _f32[0];
}

export function setCtrlFloat(sab: SharedArrayBuffer, field: number, value: number): void {
    const ctrl = new Int32Array(sab, 0, 32);
    _f32[0] = value;
    Atomics.store(ctrl, field, _i32[0]);
}

// ─── Listener SAB factory ───────────────────────────────────────────────────

export function createListenerSab(): SharedArrayBuffer {
    const sab = new SharedArrayBuffer(LISTENER_SAB_BYTES);
    const ctrl = new Int32Array(sab, 0, 16);
    // Position (0,0,0)
    Atomics.store(ctrl, LCTRL_POS_X, floatToI32(0));
    Atomics.store(ctrl, LCTRL_POS_Y, floatToI32(0));
    Atomics.store(ctrl, LCTRL_POS_Z, floatToI32(0));
    // Velocity (0,0,0)
    Atomics.store(ctrl, LCTRL_VEL_X, floatToI32(0));
    Atomics.store(ctrl, LCTRL_VEL_Y, floatToI32(0));
    Atomics.store(ctrl, LCTRL_VEL_Z, floatToI32(0));
    // Front (0,0,1)
    Atomics.store(ctrl, LCTRL_FRONT_X, floatToI32(0));
    Atomics.store(ctrl, LCTRL_FRONT_Y, floatToI32(0));
    Atomics.store(ctrl, LCTRL_FRONT_Z, floatToI32(1));
    // Top (0,1,0)
    Atomics.store(ctrl, LCTRL_TOP_X, floatToI32(0));
    Atomics.store(ctrl, LCTRL_TOP_Y, floatToI32(1));
    Atomics.store(ctrl, LCTRL_TOP_Z, floatToI32(0));
    // Factors
    Atomics.store(ctrl, LCTRL_DIST_FACTOR, floatToI32(1));
    Atomics.store(ctrl, LCTRL_ROLLOFF_FACTOR, floatToI32(1));
    Atomics.store(ctrl, LCTRL_DOPPLER_FACTOR, floatToI32(1));
    return sab;
}

// ─── Stats SAB factory ──────────────────────────────────────────────────────

export function createStatsSab(): SharedArrayBuffer {
    // All-zero initial state is the correct initial state for every field.
    return new SharedArrayBuffer(STATS_SAB_BYTES);
}

/** The same layout, instantiated a second time for the MASTER stage (post-mix,
 *  where ring + encoded/media audio are actually summed — see the second
 *  processor in bottleship-audio-worklet.ts). Fields that only make sense
 *  per-ring (STATS_ACTIVE_RING, STATS_ACTIVE_LEGACY, STATS_TOP_SOURCE_*,
 *  STATS_UNDERRUN_MID, STATS_STARVED_BLOCKS) stay 0 there — the master
 *  processor has no notion of individual sources, only the final signal. */
export function createMasterStatsSab(): SharedArrayBuffer {
    return createStatsSab();
}

// ─── Audio format descriptor (passed to createAudioRingBuffer) ───────────────

export interface AudioRingFormat {
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
}

// ─── Worker-side helpers ─────────────────────────────────────────────────────

/**
 * Allocate a SharedArrayBuffer and initialize the control block.
 */
export function createAudioRingBuffer(
    bufferBytes: number,
    format: AudioRingFormat,
    circular: boolean,
): SharedArrayBuffer {
    const sab = new SharedArrayBuffer(CTRL_BLOCK_BYTES + bufferBytes);
    const ctrl = new Int32Array(sab, 0, 32);
    const blockAlign = format.channels * (format.bitsPerSample >> 3);

    Atomics.store(ctrl, CTRL_PLAY_CURSOR, 0);
    Atomics.store(ctrl, CTRL_WRITE_CURSOR, 0);
    Atomics.store(ctrl, CTRL_BUFFER_BYTES, bufferBytes);
    Atomics.store(ctrl, CTRL_CHANNELS, format.channels);
    Atomics.store(ctrl, CTRL_SAMPLE_RATE, format.sampleRate);
    Atomics.store(ctrl, CTRL_BITS_PER_SAMPLE, format.bitsPerSample);
    Atomics.store(ctrl, CTRL_BLOCK_ALIGN, blockAlign);
    Atomics.store(ctrl, CTRL_STATE, STATE_STOPPED);
    Atomics.store(ctrl, CTRL_LOOP_MODE, 1); // play once
    Atomics.store(ctrl, CTRL_VOLUME, 0); // full volume (0 dB)
    Atomics.store(ctrl, CTRL_PAN, 0); // center
    Atomics.store(ctrl, CTRL_FREQUENCY, format.sampleRate);
    Atomics.store(ctrl, CTRL_DATA_LENGTH, 0);
    Atomics.store(ctrl, CTRL_STOP_REQUESTED, 0);
    Atomics.store(ctrl, CTRL_FLAGS, circular ? FLAG_CIRCULAR : 0);
    Atomics.store(ctrl, CTRL_RESERVED, 0);

    // 3D defaults (slots 16-31)
    Atomics.store(ctrl, CTRL_3D_POS_X, 0);
    Atomics.store(ctrl, CTRL_3D_POS_Y, 0);
    Atomics.store(ctrl, CTRL_3D_POS_Z, 0);
    Atomics.store(ctrl, CTRL_3D_VEL_X, 0);
    Atomics.store(ctrl, CTRL_3D_VEL_Y, 0);
    Atomics.store(ctrl, CTRL_3D_VEL_Z, 0);
    Atomics.store(ctrl, CTRL_3D_MIN_DIST, floatToI32(1.0));
    Atomics.store(ctrl, CTRL_3D_MAX_DIST, floatToI32(1e9));
    Atomics.store(ctrl, CTRL_3D_MODE, 0); // DS3DMODE_NORMAL
    Atomics.store(ctrl, CTRL_3D_CONE_INNER, 360);
    Atomics.store(ctrl, CTRL_3D_CONE_OUTER, 360);
    Atomics.store(ctrl, CTRL_3D_CONE_ORI_X, 0);
    Atomics.store(ctrl, CTRL_3D_CONE_ORI_Y, 0);
    Atomics.store(ctrl, CTRL_3D_CONE_ORI_Z, floatToI32(1.0));
    Atomics.store(ctrl, CTRL_3D_CONE_OUTVOL, 0);
    Atomics.store(ctrl, CTRL_3D_FLAGS, 0);

    return sab;
}

/**
 * Write raw bytes into the ring buffer data region, handling circular wrap.
 */
export function writeRingData(
    sab: SharedArrayBuffer,
    offset: number,
    src: Uint8Array,
    length: number,
): void {
    const data = new Uint8Array(sab, CTRL_BLOCK_BYTES);
    const bufferBytes = data.length;
    if (bufferBytes === 0 || length === 0) return;

    const normalizedOffset = offset % bufferBytes;
    const firstChunk = Math.min(length, bufferBytes - normalizedOffset);
    data.set(src.subarray(0, firstChunk), normalizedOffset);

    if (firstChunk < length) {
        // Wrap around
        data.set(src.subarray(firstChunk, length), 0);
    }
}

/**
 * Atomics.store a control field.
 */
export function setCtrl(sab: SharedArrayBuffer, field: number, value: number): void {
    const ctrl = new Int32Array(sab, 0, 32);
    Atomics.store(ctrl, field, value);
}

/**
 * Atomics.load a control field.
 */
export function getCtrl(sab: SharedArrayBuffer, field: number): number {
    const ctrl = new Int32Array(sab, 0, 32);
    return Atomics.load(ctrl, field);
}

// ─── Worklet-side helpers ────────────────────────────────────────────────────

/**
 * Read a single sample from the ring buffer data region and return as float [-1, 1].
 * `byteOffset` is relative to the START of the SAB (i.e. includes CTRL_BLOCK_BYTES).
 */
export function readSampleFloat(
    view: DataView,
    byteOffset: number,
    bitsPerSample: number,
): number {
    if (bitsPerSample === 16) {
        return view.getInt16(byteOffset, true) / 32768;
    }
    if (bitsPerSample === 8) {
        return (view.getUint8(byteOffset) - 128) / 128;
    }
    if (bitsPerSample === 32) {
        return view.getFloat32(byteOffset, true);
    }
    return 0;
}

/**
 * Convert DirectSound centibel volume (-10000..0) to linear gain [0..1].
 */
export function centibelToLinear(centibels: number): number {
    if (centibels <= -10000) return 0;
    if (centibels >= 0) return 1;
    return Math.pow(10, centibels / 2000);
}

/**
 * Convert DirectSound pan (-10000..10000) to left/right gain multipliers.
 * Returns [leftGain, rightGain] each in [0..1].
 */
export function panToGains(pan: number): [number, number] {
    if (pan <= -10000) return [1, 0];
    if (pan >= 10000) return [0, 1];
    if (pan < 0) {
        // Left-biased: right channel attenuated
        const rightAtten = Math.pow(10, pan / 2000);
        return [1, rightAtten];
    }
    if (pan > 0) {
        // Right-biased: left channel attenuated
        const leftAtten = Math.pow(10, -pan / 2000);
        return [leftAtten, 1];
    }
    return [1, 1];
}
