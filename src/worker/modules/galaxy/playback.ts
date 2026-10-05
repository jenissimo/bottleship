import {
    createAudioRingBuffer,
    writeRingData,
    setCtrl,
    CTRL_DATA_LENGTH,
    CTRL_LOOP_MODE,
    CTRL_STATE,
    CTRL_VOLUME,
    STATE_PLAYING,
    STATE_STOPPED,
} from '../../../audio/audio-ring-buffer';
import { ensureAudioStatsSab } from '../audio-stats-sab';
import { Logger, LogCategory } from '../../core/logger';
import type { GuestWaveInfo } from './structs';

const ringBuffers = new Map<number, { sab: SharedArrayBuffer }>();

// A wrong USound struct read can yield a garbage dataSize; a 16-bit 22kHz stereo
// clip is ~5MB/min, so anything past this cap is corruption, not a real sound.
const MAX_WAVE_BYTES = 24 * 1024 * 1024;
// In-game bursts of SFX each want their own ring buffer; cap concurrent SABs so a
// flood (or a leak before audio_ended fires) can't exhaust SharedArrayBuffer memory.
const MAX_RING_BUFFERS = 64;

export function playGuestWave(id: number, wave: GuestWaveInfo, mem: Uint8Array, loop: boolean, volume127 = 127): void {
    releaseRingBuffer(id);

    // Validate the extracted wave before allocating — bad dataSize/pointer must skip
    // the sound, never crash the whole emulator with "Array buffer allocation failed".
    if (!Number.isFinite(wave.dataSize) || wave.dataSize <= 0 || wave.dataSize > MAX_WAVE_BYTES) {
        Logger.warn(LogCategory.SYSTEM, `[Galaxy] skip play id=${id}: bad wave dataSize=${wave.dataSize}`);
        return;
    }
    if (wave.dataPtr <= 0 || wave.dataPtr + wave.dataSize > mem.length) {
        Logger.warn(LogCategory.SYSTEM, `[Galaxy] skip play id=${id}: wave OOB ptr=0x${(wave.dataPtr >>> 0).toString(16)} size=${wave.dataSize}`);
        return;
    }
    if (ringBuffers.size >= MAX_RING_BUFFERS) {
        Logger.warn(LogCategory.SYSTEM, `[Galaxy] skip play id=${id}: ring-buffer cap (${MAX_RING_BUFFERS}) reached`);
        return;
    }

    let sab: SharedArrayBuffer;
    try {
        sab = createAudioRingBuffer(Math.max(wave.dataSize, 4096), {
            channels: wave.channels,
            sampleRate: wave.sampleRate,
            bitsPerSample: wave.bitsPerSample,
        }, false);
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `[Galaxy] ring buffer alloc failed id=${id} (size=${wave.dataSize}): ${e}`);
        return;
    }

    const pcm = mem.subarray(wave.dataPtr, wave.dataPtr + wave.dataSize);
    writeRingData(sab, 0, pcm, wave.dataSize);
    setCtrl(sab, CTRL_DATA_LENGTH, wave.dataSize);
    setCtrl(sab, CTRL_LOOP_MODE, loop ? -1 : 1);
    const centibels = volume127 >= 127 ? 0 : Math.max(-10000, Math.round(2000 * Math.log10(volume127 / 127)));
    setCtrl(sab, CTRL_VOLUME, centibels);

    ensureAudioStatsSab();
    self.postMessage({ type: 'audio_register', payload: { id, sab } });
    setCtrl(sab, CTRL_STATE, STATE_PLAYING);
    ringBuffers.set(id, { sab });
}

export function stopGalaxyAudio(id: number): void {
    const entry = ringBuffers.get(id);
    if (entry) {
        setCtrl(entry.sab, CTRL_STATE, STATE_STOPPED);
        self.postMessage({ type: 'audio_unregister', payload: { id } });
        ringBuffers.delete(id);
    }
}

export function releaseRingBuffer(id: number): void {
    stopGalaxyAudio(id);
}

export function handleAudioEnded(id: number): void {
    if (ringBuffers.has(id)) {
        ringBuffers.delete(id);
    }
}

/** Stop every host ring buffer — required on in-worker game switch. */
export function resetGalaxyPlayback(): void {
    for (const id of [...ringBuffers.keys()]) {
        stopGalaxyAudio(id);
    }
}
