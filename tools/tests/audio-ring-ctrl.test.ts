/**
 * Audio ring-buffer control-block contract.
 *
 * The SAB control block is the ONLY channel through which the worker tells the
 * AudioWorklet how to interpret the PCM that follows it. Three consumers read it
 * independently (dsound, winmm, binkw32/smackw32/mss32) and the worklet gates
 * playback on it:
 *
 *     blockAlign = ctrl[CTRL_BLOCK_ALIGN] || channels * (bitsPerSample >> 3);
 *     if (blockAlign === 0 || bufferBytes === 0) continue;   // source SKIPPED
 *
 * so a control block whose format fields read back as 0 is not a cosmetic problem —
 * the mixer silently drops that buffer while its cursors keep moving, which presents
 * as "the game is streaming audio and nothing is audible". These asserts pin the
 * field INDICES (the worklet hard-codes the same integers, it cannot import them)
 * and the fact that the factory populates every field a consumer reads back.
 */

import { test, expect } from "bun:test";
import {
    createAudioRingBuffer,
    getCtrl,
    setCtrl,
    CTRL_PLAY_CURSOR,
    CTRL_WRITE_CURSOR,
    CTRL_BUFFER_BYTES,
    CTRL_CHANNELS,
    CTRL_SAMPLE_RATE,
    CTRL_BITS_PER_SAMPLE,
    CTRL_BLOCK_ALIGN,
    CTRL_STATE,
    CTRL_VOLUME,
    CTRL_FREQUENCY,
    CTRL_FLAGS,
    CTRL_BLOCK_BYTES,
    FLAG_CIRCULAR,
    STATE_STOPPED,
    centibelToLinear,
} from "../../src/audio/audio-ring-buffer";

/** The worklet hard-codes these integers; drifting them silently breaks playback. */
test("control-block field indices are stable", () => {
    expect(CTRL_PLAY_CURSOR).toBe(0);
    expect(CTRL_WRITE_CURSOR).toBe(1);
    expect(CTRL_BUFFER_BYTES).toBe(2);
    expect(CTRL_CHANNELS).toBe(3);
    expect(CTRL_SAMPLE_RATE).toBe(4);
    expect(CTRL_BITS_PER_SAMPLE).toBe(5);
    expect(CTRL_BLOCK_ALIGN).toBe(6);
    expect(CTRL_STATE).toBe(7);
    expect(CTRL_VOLUME).toBe(9);
    expect(CTRL_FREQUENCY).toBe(11);
    expect(CTRL_FLAGS).toBe(14);
    expect(CTRL_BLOCK_BYTES).toBe(128);
});

test("createAudioRingBuffer publishes the format the worklet gates on", () => {
    const bytes = 529200; // a 3s 44.1kHz stereo 16-bit music ring
    const sab = createAudioRingBuffer(bytes, { channels: 2, sampleRate: 44100, bitsPerSample: 16 }, true);

    expect(getCtrl(sab, CTRL_BUFFER_BYTES)).toBe(bytes);
    expect(getCtrl(sab, CTRL_CHANNELS)).toBe(2);
    expect(getCtrl(sab, CTRL_SAMPLE_RATE)).toBe(44100);
    expect(getCtrl(sab, CTRL_BITS_PER_SAMPLE)).toBe(16);
    // Derived, not passed in — 2ch x 16bit. Zero here means the worklet skips the source.
    expect(getCtrl(sab, CTRL_BLOCK_ALIGN)).toBe(4);
    expect(getCtrl(sab, CTRL_FREQUENCY)).toBe(44100);
    expect(getCtrl(sab, CTRL_STATE)).toBe(STATE_STOPPED);
    expect(getCtrl(sab, CTRL_FLAGS) & FLAG_CIRCULAR).toBe(FLAG_CIRCULAR);
    // A fresh buffer is full volume: a non-zero default would attenuate every game.
    expect(getCtrl(sab, CTRL_VOLUME)).toBe(0);
    expect(sab.byteLength).toBe(CTRL_BLOCK_BYTES + bytes);
});

test("the worklet's blockAlign gate accepts a well-formed buffer", () => {
    const sab = createAudioRingBuffer(4096, { channels: 1, sampleRate: 22050, bitsPerSample: 8 }, true);
    const blockAlign = getCtrl(sab, CTRL_BLOCK_ALIGN)
        || getCtrl(sab, CTRL_CHANNELS) * (getCtrl(sab, CTRL_BITS_PER_SAMPLE) >> 3);
    expect(blockAlign).toBe(1);
    expect(blockAlign === 0 || getCtrl(sab, CTRL_BUFFER_BYTES) === 0).toBe(false);
});

/**
 * DSound centibels are a LOG scale: the mixer's output amplitude is
 * ringPeak x centibelToLinear(CTRL_VOLUME). A mid-scale-looking centibel value is
 * already inaudible, which is why "cursors advance but nothing is heard" has to be
 * diagnosed from the gain, not from the cursors.
 */
test("centibel volume maps to the linear gain the mixer applies", () => {
    expect(centibelToLinear(0)).toBe(1);
    expect(centibelToLinear(-10000)).toBe(0);
    // -46.46 dB — a fade-in stranded at ~7% gain is 0.5% amplitude, i.e. silent.
    expect(centibelToLinear(-4646)).toBeCloseTo(0.004753, 5);
    expect(centibelToLinear(-600)).toBeCloseTo(0.5012, 4);
});

test("setCtrl/getCtrl round-trip a negative centibel volume", () => {
    const sab = createAudioRingBuffer(1024, { channels: 2, sampleRate: 44100, bitsPerSample: 16 }, true);
    setCtrl(sab, CTRL_VOLUME, -4646);
    expect(getCtrl(sab, CTRL_VOLUME)).toBe(-4646);
});
